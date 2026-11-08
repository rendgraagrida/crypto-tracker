export const dynamic = 'force-dynamic';
import { fetchMarketPairs, fetchNativeCoinPrice } from '../../lib/market-data.ts';
import { normalizeChain } from '../../lib/auth.ts';
import { readBoundedJson } from '../../lib/bounded-json.ts';
import { boundedFetch } from '../../lib/bounded-fetch.ts';
const NextResponse = Response;
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import type { ConnectionConfig } from '@solana/web3.js';
import { createClient } from '@supabase/supabase-js';

const METAPLEX_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const metadataCache = new Map<string, { expires: number; value: { name: string; symbol: string; uri: string } | null }>();

function getSupabase() {
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key, { global: { fetch: boundedFetch } });
}

// 🟢 Menghitung alamat PDA Metaplex Metadata on-chain
function getMetadataPDA(mintAddress: string): PublicKey | null {
  try {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("metadata"), METAPLEX_PROGRAM_ID.toBuffer(), new PublicKey(mintAddress).toBuffer()],
      METAPLEX_PROGRAM_ID
    );
    return pda;
  } catch {
    return null;
  }
}

// 🟢 Dekoder biner untuk format Metaplex Token Metadata Standard
function decodeMetaplex(buf: Buffer | Uint8Array | null): { name: string; symbol: string; uri: string } | null {
  if (!buf || buf.length < 70) return null;
  try {
    const nodeBuf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    let offset = 1 + 32 + 32; // Lewati key (1 byte), update authority (32 byte), mint (32 byte)
    
    const nameLen = nodeBuf.readUInt32LE(offset);
    offset += 4;
    const name = nodeBuf.slice(offset, offset + nameLen).toString("utf8").replace(/\0/g, "").trim();
    offset += nameLen;

    const symbolLen = nodeBuf.readUInt32LE(offset);
    offset += 4;
    const symbol = nodeBuf.slice(offset, offset + symbolLen).toString("utf8").replace(/\0/g, "").trim();
    offset += symbolLen;

    const uriLen = nodeBuf.readUInt32LE(offset);
    offset += 4;
    const uri = nodeBuf.slice(offset, offset + uriLen).toString("utf8").replace(/\0/g, "").trim();

    return { name, symbol, uri };
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  try {
    const { wallet_address, page = 1 } = await readBoundedJson(request.body, 16384, 5000) as { wallet_address: string; page?: number };

    if (!wallet_address) {
      return NextResponse.json({ error: "Wallet address Solana wajib diisi" }, { status: 400 });
    }

    let pubKey: PublicKey;
    try {
      pubKey = new PublicKey(wallet_address.toString().trim());
    } catch {
      return NextResponse.json({ error: "Format alamat Solana tidak valid" }, { status: 400 });
    }

    // 1. Ambil Whitelist & Blacklist Token dari Supabase secara paralel
    let VIP_TOKENS: string[] = [];
    let BLACKLISTED_TOKENS: string[] = [];
    try {
      const supabase = getSupabase();
      if (supabase) {
        const [trackedRes, whitelistRes, blacklistRes] = await Promise.all([
          supabase.from('tracked_coins').select('contract_address, chain_network'),
          supabase.from('whitelist_tokens').select('contract_address, chain_network'),
          supabase.from('blacklist_tokens').select('contract_address, chain_network'),
        ]);
        const matching = (rows: { contract_address: string; chain_network: string }[] | null) => (rows || []).flatMap(item => {
          try { return normalizeChain(item.chain_network) === 'solana' ? [item.contract_address] : []; } catch { return []; }
        });
        VIP_TOKENS = [...new Set([...matching(trackedRes.data), ...matching(whitelistRes.data)])];
        BLACKLISTED_TOKENS = matching(blacklistRes.data);
      }
    } catch (err) {}

    const rpcUrl = process.env.ALCHEMY_SOL_URL || 'https://api.mainnet-beta.solana.com';
    // Web3 passes URL strings and JSON request options to its fetch hook.
    const connection = new Connection(rpcUrl, { commitment: 'confirmed', disableRetryOnRateLimit: true, fetch: boundedFetch as unknown as NonNullable<ConnectionConfig['fetch']> });

    // 2. Ambil saldo Native SOL & Akun Token SPL (Standard + Token-2022) secara PARALEL
    const [lamports, solPriceUsd, standardTokensRes, token2022Res] = await Promise.all([
      connection.getBalance(pubKey),
      fetchNativeCoinPrice('solana'),
      connection.getParsedTokenAccountsByOwner(pubKey, { programId: TOKEN_PROGRAM_ID }),
      connection.getParsedTokenAccountsByOwner(pubKey, { programId: TOKEN_2022_PROGRAM_ID })
    ]);

    const solBalanceNum = lamports / LAMPORTS_PER_SOL;

    // 3. Gabungkan seluruh akun token SPL (Standard + Token-2022)
    const allParsedAccounts = [...(standardTokensRes.value || []), ...(token2022Res.value || [])];

    const rawSplTokens = allParsedAccounts.map((ta: any) => {
      const info = ta.account?.data?.parsed?.info;
      if (!info) return null;
      const amount = info.tokenAmount?.uiAmount || 0;
      const amountString = info.tokenAmount?.uiAmountString || "0";
      const decimals = info.tokenAmount?.decimals || 0;
      return {
        mint: info.mint,
        amount,
        amountString,
        decimals
      };
    }).filter((t: any) => t !== null && t.amount > 0);

    const mintAddresses = rawSplTokens.map((t: any) => t.mint);


    // 5. TOKENS KHUSUS DENGAN HARGA PASTI (Mencegah DexScreener mengembalikan 30 pair WSOL dan mengabaikan token lain)
    const KNOWN_SOL_TOKENS: Record<string, { name: string; symbol: string; getPrice: (sp: number | null) => number | null; logo: string | null }> = {
      'So11111111111111111111111111111111111111112': {
        name: 'Wrapped SOL',
        symbol: 'WSOL',
        getPrice: (sp: number | null) => sp,
        logo: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png'
      },
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': {
        name: 'USD Coin',
        symbol: 'USDC',
        getPrice: () => null,
        logo: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png'
      },
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': {
        name: 'Tether USD',
        symbol: 'USDT',
        getPrice: () => null,
        logo: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB/logo.png'
      }
    };
    const validMints = mintAddresses.filter((mint: string) => !BLACKLISTED_TOKENS.includes(mint));
    const pairs = await fetchMarketPairs('solana', validMints);
    const onChainMetaMap: Record<string, { name: string; symbol: string; uri: string }> = {};
    const missing = [...new Set<string>(validMints)].filter(mint => {
      const pair = pairs.get(mint);
      if (KNOWN_SOL_TOKENS[mint] || (pair?.baseToken?.name && pair?.baseToken?.symbol)) return false;
      const cached = metadataCache.get(mint);
      if (cached && cached.expires > Date.now()) {
        if (cached.value) onChainMetaMap[mint] = cached.value;
        return false;
      }
      return true;
    });
    for (let i = 0; i < missing.length; i += 100) {
      const items = missing.slice(i, i + 100).map(mint => ({ mint, pda: getMetadataPDA(mint) })).filter((item): item is { mint: string; pda: PublicKey } => item.pda !== null);
      if (!items.length) continue;
      try {
        const accounts = await connection.getMultipleAccountsInfo(items.map(item => item.pda));
        items.forEach((item, index) => {
          const decoded = decodeMetaplex(accounts[index]?.data ?? null);
          metadataCache.delete(item.mint);
          metadataCache.set(item.mint, { expires: Date.now() + 300_000, value: decoded });
          if (decoded) onChainMetaMap[item.mint] = decoded;
        });
        while (metadataCache.size > 3000) metadataCache.delete(metadataCache.keys().next().value!);
      } catch { /* Metadata unavailable; leave unknown. */ }
    }

    // 7. GABUNGKAN & STANDARISASI SELURUH DATA SPL TOKEN
    const formattedSplTokens = rawSplTokens.map((t: any) => {
      const onChain = onChainMetaMap[t.mint] || {};
      const pair = pairs.get(t.mint);
      const parsedPrice = pair?.priceUsd === undefined ? null : Number(pair.priceUsd);
      const known = KNOWN_SOL_TOKENS[t.mint];
      const isVip = VIP_TOKENS.includes(t.mint);
      const isBlacklisted = BLACKLISTED_TOKENS.includes(t.mint);
      const tokenName = known?.name || pair?.baseToken?.name || onChain.name || 'SPL Token';
      const tokenSymbol = known?.symbol || pair?.baseToken?.symbol || onChain.symbol || `${t.mint.slice(0, 4)}...${t.mint.slice(-4)}`;
      const tokenLogo = known?.logo || pair?.info?.imageUrl || null;
      const price = known?.symbol === 'WSOL' ? known.getPrice(solPriceUsd) : parsedPrice !== null && Number.isFinite(parsedPrice) && parsedPrice >= 0 ? parsedPrice : null;
      const totalValue = price === null ? null : t.amount * price;


      // 🚫 SPAM / QUARANTINE FILTER:
      // 1. Blacklist -> Paksa spam (alasan: blacklist)
      // 2. VIP -> Selalu lolos
      // 3. Scam keywords -> Spam (alasan: keyword)
      // 4. A known zero value may be quarantined; unavailable price is not evidence of spam.
      let isSpam = false;
      let spamReason: 'blacklist' | 'keyword' | 'zero_value' | null = null;
      if (isBlacklisted) {
        isSpam = true;
        spamReason = 'blacklist';
      } else if (!isVip) {
        const lowerName = tokenName.toLowerCase();
        const lowerUri = (onChain.uri || "").toLowerCase();
        const hasKeyword = 
          lowerName.includes("giftbox") || 
          lowerName.includes("claim") || 
          lowerName.includes("reward") || 
          lowerName.includes("voucher") ||
          lowerUri.includes("giftbox") ||
          lowerUri.includes("voucher");

        if (hasKeyword) {
          isSpam = true;
          spamReason = 'keyword';
        } else if (price !== null && totalValue !== null && (price <= 0 || totalValue <= 0)) {
          isSpam = true;
          spamReason = 'zero_value';
        }
      }

      return {
        contract_address: t.mint,
        name: tokenName,
        symbol: tokenSymbol,
        logo: tokenLogo,
        balance: t.amountString,
        price_usd: price,
        total_value_usd: totalValue,
        is_spam: isSpam,
        spam_reason: spamReason
      };
    });

    const allTokens = [...formattedSplTokens];

    // Tambahkan Native SOL jika ada saldo
    if (solBalanceNum > 0 && page === 1) {
      allTokens.unshift({
        contract_address: 'NATIVE_COIN',
        name: 'Solana',
        symbol: 'SOL',
        logo: null,
        balance: solBalanceNum.toFixed(4),
        price_usd: solPriceUsd,
        total_value_usd: solPriceUsd === null ? null : solBalanceNum * solPriceUsd,
        is_spam: false,
        spam_reason: null
      });
    }

    // Sort: Koin Asli & Bernilai di atas, Spam di bawah
    allTokens.sort((a: any, b: any) => {
      if (a.is_spam && !b.is_spam) return 1;
      if (!a.is_spam && b.is_spam) return -1;
      return (b.total_value_usd || 0) - (a.total_value_usd || 0);
    });

    const limit = 30;
    const startIndex = (page - 1) * limit;
    const paginatedTokens = allTokens.slice(startIndex, startIndex + limit);

    return NextResponse.json({
      tokens: paginatedTokens,
      hasNextPage: startIndex + limit < allTokens.length,
      currentPage: page
    }, { status: 200 });

  } catch (error: any) {
    console.error("Gagal mengambil data Solana:", error);
    return NextResponse.json({
      tokens: [],
      error: error.message || "Gagal mengambil data Solana"
    }, { status: 200 });
  }
}
