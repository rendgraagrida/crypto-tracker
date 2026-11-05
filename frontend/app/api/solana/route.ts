export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { createClient } from '@supabase/supabase-js';

const METAPLEX_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

function getSupabase() {
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key);
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
    const { wallet_address, page = 1 } = await request.json();

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
        const [whitelistRes, blacklistRes] = await Promise.all([
          supabase.from('tracked_coins').select('contract_address'),
          supabase.from('blacklist_tokens').select('contract_address'),
        ]);
        if (whitelistRes.data && Array.isArray(whitelistRes.data)) {
          VIP_TOKENS = whitelistRes.data.map((item: any) => item.contract_address?.toLowerCase() || "");
        }
        if (blacklistRes.data && Array.isArray(blacklistRes.data)) {
          BLACKLISTED_TOKENS = blacklistRes.data.map((item: any) => item.contract_address?.toLowerCase() || "");
        }
      }
    } catch (err) {}

    const rpcUrl = process.env.ALCHEMY_SOL_URL || 'https://api.mainnet-beta.solana.com';
    const connection = new Connection(rpcUrl, 'confirmed');

    // 2. Ambil saldo Native SOL & Akun Token SPL (Standard + Token-2022) secara PARALEL
    const [lamports, cgData, standardTokensRes, token2022Res] = await Promise.all([
      connection.getBalance(pubKey),
      fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', {
        headers: { 'Accept': 'application/json' }
      }).then(r => r.json()).catch(() => ({})),
      connection.getParsedTokenAccountsByOwner(pubKey, { programId: TOKEN_PROGRAM_ID }),
      connection.getParsedTokenAccountsByOwner(pubKey, { programId: TOKEN_2022_PROGRAM_ID })
    ]);

    const solBalanceNum = lamports / LAMPORTS_PER_SOL;
    const solPriceUsd = cgData?.solana?.usd || 0;

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

    // 4. DEKODE METADATA ON-CHAIN METAPLEX (Nama Asli & Ticker Simbol)
    const onChainMetaMap: Record<string, { name: string; symbol: string; uri: string }> = {};
    if (mintAddresses.length > 0) {
      try {
        const pdas = mintAddresses.map((mint: string) => getMetadataPDA(mint));
        const validPdas = pdas.filter((p): p is PublicKey => p !== null);
        const accountInfos = await connection.getMultipleAccountsInfo(validPdas);
        
        let validIdx = 0;
        mintAddresses.forEach((mint: string, idx: number) => {
          if (pdas[idx] !== null) {
            const acc = accountInfos[validIdx++];
            if (acc && acc.data) {
              const decoded = decodeMetaplex(acc.data);
              if (decoded && (decoded.name || decoded.symbol)) {
                onChainMetaMap[mint] = decoded;
              }
            }
          }
        });
      } catch (err) {
        console.error("Metaplex On-Chain Decoder error:", err);
      }
    }

    // 5. TOKENS KHUSUS DENGAN HARGA PASTI (Mencegah DexScreener mengembalikan 30 pair WSOL dan mengabaikan token lain)
    const KNOWN_SOL_TOKENS: Record<string, { name: string; symbol: string; getPrice: (sp: number) => number; logo: string | null }> = {
      'So11111111111111111111111111111111111111112': {
        name: 'Wrapped SOL',
        symbol: 'WSOL',
        getPrice: (sp: number) => sp,
        logo: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png'
      },
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': {
        name: 'USD Coin',
        symbol: 'USDC',
        getPrice: () => 1.00,
        logo: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png'
      },
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': {
        name: 'Tether USD',
        symbol: 'USDT',
        getPrice: () => 1.00,
        logo: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB/logo.png'
      }
    };
    const KNOWN_MINTS_SET = new Set(Object.keys(KNOWN_SOL_TOKENS).map(k => k.toLowerCase()));

    // 6. AMBIL HARGA LIVE USD & LOGO DARI DEXSCREENER (Chunking up to 180 tokens)
    const dexMetaMap: Record<string, { name: string; symbol: string; price_usd: number; logo: string | null }> = {};
    
    // Jangan kirim WSOL/USDC/USDT atau Blacklisted token ke DexScreener multi-token query
    const validMintsForPricing = mintAddresses.filter(mint => {
      const lower = mint.toLowerCase();
      return !BLACKLISTED_TOKENS.includes(lower) && !KNOWN_MINTS_SET.has(lower);
    });
    
    if (validMintsForPricing.length > 0) {
      try {
        const chunkSize = 30;
        const chunks = [];
        for (let i = 0; i < validMintsForPricing.length; i += chunkSize) {
          chunks.push(validMintsForPricing.slice(i, i + chunkSize));
        }

        // Limit to max 6 chunks (180 tokens) to prevent rate limit
        const limitedChunks = chunks.slice(0, 6);

        await Promise.all(limitedChunks.map(async (chunk) => {
          const dexRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${chunk.join(",")}`, {
            headers: { 'Accept': 'application/json' }
          }).then(r => r.json()).catch(() => null);

          if (dexRes?.pairs && Array.isArray(dexRes.pairs)) {
            dexRes.pairs.forEach((p: any) => {
              const addr = p.baseToken?.address;
              if (addr && !dexMetaMap[addr]) {
                dexMetaMap[addr] = {
                  name: p.baseToken.name || "",
                  symbol: p.baseToken.symbol || "",
                  price_usd: parseFloat(p.priceUsd || "0") || 0,
                  logo: p.info?.imageUrl || null
                };
              }
            });
          }
        }));
      } catch (e) {
        console.error("DexScreener API error:", e);
      }
    }

    // 7. GABUNGKAN & STANDARISASI SELURUH DATA SPL TOKEN
    const formattedSplTokens = rawSplTokens.map((t: any) => {
      const onChain = onChainMetaMap[t.mint] || {};
      const dex = dexMetaMap[t.mint] || { price_usd: 0, logo: null };
      const known = KNOWN_SOL_TOKENS[t.mint];
      const mintLower = t.mint.toLowerCase();
      const isVip = VIP_TOKENS.includes(mintLower);
      const isBlacklisted = BLACKLISTED_TOKENS.includes(mintLower);

      // Prioritas Metadata: Known Config -> DexScreener -> On-chain Metaplex -> Fallback
      let tokenName = known?.name || dex.name || onChain.name || `SPL Token`;
      let tokenSymbol = known?.symbol || dex.symbol || onChain.symbol || `${t.mint.slice(0, 4)}...${t.mint.slice(-4)}`;
      let tokenLogo = known?.logo || dex.logo || null;
      let price = known ? known.getPrice(solPriceUsd) : (dex.price_usd || 0);
      let totalValue = t.amount * price;

      // Hardcoded metadata untuk koin populer Solana jika belum terindex DEX
      if (t.mint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') {
        tokenName = "USD Coin";
        tokenSymbol = "USDC";
        price = price || 1.00;
        totalValue = t.amount * price;
      } else if (t.mint === 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB') {
        tokenName = "Tether USD";
        tokenSymbol = "USDT";
        price = price || 1.00;
        totalValue = t.amount * price;
      }

      // 🚫 SPAM / QUARANTINE FILTER:
      // 1. Blacklist -> Paksa spam (alasan: blacklist)
      // 2. VIP -> Selalu lolos
      // 3. Scam keywords -> Spam (alasan: keyword)
      // 4. Unknown price / 0 USD value -> Karantina Zero Value (alasan: zero_value)
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
        } else if (!price || price <= 0 || !totalValue || totalValue <= 0) {
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
        total_value_usd: solBalanceNum * solPriceUsd,
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
