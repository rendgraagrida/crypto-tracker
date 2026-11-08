export const dynamic = 'force-dynamic';
import { POST as solanaPost } from '../solana/route.ts';
import { fetchMarketPairs, fetchNativeCoinPrice } from '../../lib/market-data.ts';
import { normalizeAddress, normalizeChain } from '../../lib/auth.ts';
import { readBoundedJson } from '../../lib/bounded-json.ts';
import { boundedFetch } from '../../lib/bounded-fetch.ts';
import { formatTokenBalance } from '../../lib/token-balance.ts';
const NextResponse = Response;
import { createClient } from '@supabase/supabase-js';

function getSupabase() {
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key, { global: { fetch: boundedFetch } });
}

const getAlchemyRpcUrl = (network: string) => {
  const vars: Record<string, string> = { ethereum: 'ALCHEMY_ETH_URL', base: 'ALCHEMY_BASE_URL', bsc: 'ALCHEMY_BSC_URL', robinhood: 'ALCHEMY_ROBINHOOD_URL', polygon: 'ALCHEMY_POLYGON_URL', arbitrum: 'ALCHEMY_ARBITRUM_URL', optimism: 'ALCHEMY_OPTIMISM_URL', avalanche: 'ALCHEMY_AVALANCHE_URL' };
  return process.env[vars[network]] || '';
};
const getNativeCoinInfo = (network: string) => {
  const info: Record<string, { id: string; symbol: string; name: string }> = {
    ethereum: { id: 'ethereum', symbol: 'ETH', name: 'Ethereum' }, base: { id: 'ethereum', symbol: 'ETH', name: 'Ethereum' },
    arbitrum: { id: 'ethereum', symbol: 'ETH', name: 'Ethereum' }, optimism: { id: 'ethereum', symbol: 'ETH', name: 'Ethereum' },
    robinhood: { id: 'ethereum', symbol: 'ETH', name: 'Ethereum (Robinhood)' }, bsc: { id: 'binancecoin', symbol: 'BNB', name: 'BNB' },
    polygon: { id: 'matic-network', symbol: 'POL', name: 'Polygon' }, avalanche: { id: 'avalanche-2', symbol: 'AVAX', name: 'Avalanche' },
  };
  return info[network];
};
type TokenMeta = { name?: string; symbol?: string; decimals?: number | string; logo?: string };
const tokenMetadataCache = new Map<string, { expires: number; value: TokenMeta }>();

// Helper untuk batch RPC calls
async function rpcCall(url: string, method: string, params: any[]) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error(`RPC Error: ${res.status}`);
  const json = await readBoundedJson(res.body, 2_000_000, 8000) as { error?: { message: string }; result?: unknown };
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

export async function POST(request: Request) {
  try {
    const { wallet_address, chain_network, page = 1 } = await readBoundedJson(request.body, 16384, 5000) as { wallet_address: string; chain_network: string; page?: number };
    if (!wallet_address || !chain_network) {
      return NextResponse.json({ error: "Data dompet tidak lengkap" }, { status: 400 });
    }

    let chain: string;
    let safeAddress: string;
    try { chain = normalizeChain(chain_network); safeAddress = normalizeAddress(chain, wallet_address); }
    catch { return NextResponse.json({ error: 'Alamat atau jaringan tidak valid' }, { status: 400 }); }

    // 🔴 Jika jaringan adalah SOLANA, forward ke handler Solana
    if (chain === 'solana') {
      return solanaPost(new Request(request.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ wallet_address: safeAddress, page }) }));
    }

    const rpcUrl = getAlchemyRpcUrl(chain);
    if (!rpcUrl) {
      return NextResponse.json({ error: `Jaringan EVM tidak didukung atau RPC URL belum disetel` }, { status: 400 });
    }

    // 1. Ambil data tracked_coins & blacklist dari Supabase
    // tracked_coins berfungsi sebagai VIP list — token ini WAJIB selalu tampil, tidak boleh disembunyikan
    let VIP_TOKENS: string[] = [];
    let BLACKLISTED_TOKENS: string[] = [];
    try {
      const supabase = getSupabase();
      if (supabase) {
        // Ambil tracked_coins DENGAN chain_network agar bisa filter per-chain
        const [trackedRes, whitelistRes, blacklistRes] = await Promise.all([
          supabase.from('tracked_coins').select('contract_address, chain_network'),
          supabase.from('whitelist_tokens').select('contract_address, chain_network'),
          supabase.from('blacklist_tokens').select('contract_address, chain_network'),
        ]);
        const matching = (rows: { contract_address: string; chain_network: string }[] | null) => (rows || []).flatMap(item => {
          try { return normalizeChain(item.chain_network) === chain ? [normalizeAddress(chain, item.contract_address)] : []; } catch { return []; }
        });
        VIP_TOKENS = [...new Set([...matching(trackedRes.data), ...matching(whitelistRes.data)])];
        BLACKLISTED_TOKENS = matching(blacklistRes.data);
      }
    } catch (err) {}

    // 2. Ambil token balances dari Alchemy dengan Pagination (Max 1000 tokens = 10 pages)
    let rawTokenBalances: any[] = [];
    let pageKey = null;
    let pageCount = 0;
    
    do {
      const options: any = {};
      if (pageKey) options.pageKey = pageKey;
      
      const balancesData: any = await rpcCall(rpcUrl, 'alchemy_getTokenBalances', [safeAddress, 'erc20', options]);
      const chunk = balancesData.tokenBalances || [];
      rawTokenBalances = [...rawTokenBalances, ...chunk];
      
      pageKey = balancesData.pageKey;
      pageCount++;
    } while (pageKey && pageCount < 4);
    
    // Explicitly fetch VIP_TOKENS (sudah difilter per chain) agar tidak pernah terlewat pagination
    if (VIP_TOKENS.length > 0) {
      try {
        const vipBalancesData: any = await rpcCall(rpcUrl, 'alchemy_getTokenBalances', [safeAddress, VIP_TOKENS]);
        const vipChunk = (vipBalancesData.tokenBalances || []).filter(
          (t: any) => t.tokenBalance && t.tokenBalance !== '0x0000000000000000000000000000000000000000000000000000000000000000'
        );
        rawTokenBalances = [...rawTokenBalances, ...vipChunk];
        console.log(`[VIP] Targeted fetch for ${VIP_TOKENS.length} VIP token(s), got ${vipChunk.length} with balance`);
      } catch (err) {
        console.error('[VIP] Targeted fetch error:', err);
      }
    }
    
    // Filter out zero balances and deduplicate
    const uniqueTokensMap = new Map();
    rawTokenBalances.forEach((t: any) => {
      if (t.tokenBalance && t.tokenBalance !== '0x0' && t.tokenBalance !== '0') {
        uniqueTokensMap.set(t.contractAddress.toLowerCase(), t);
      }
    });
    const activeTokens = Array.from(uniqueTokensMap.values());
    
    // 3. Ambil metadata untuk tiap token (Cache + JSON-RPC Batch per 25 kontrak untuk menghindari N+1 HTTP POST)
    const tokenMetadataMap: Record<string, TokenMeta> = {};
    const contractAddresses = activeTokens.map((t: { contractAddress: string }) => t.contractAddress);
    const uncachedAddresses: string[] = [];
    for (const address of contractAddresses.slice(0, 1000)) {
      const lower = address.toLowerCase();
      const cached = tokenMetadataCache.get(`${chain}:${lower}`);
      if (cached && cached.expires > Date.now()) {
        tokenMetadataMap[lower] = cached.value;
      } else {
        uncachedAddresses.push(address);
      }
    }
    for (let i = 0; i < uncachedAddresses.length; i += 25) {
      const chunk = uncachedAddresses.slice(i, i + 25);
      const batchBody = chunk.map((address, id) => ({ jsonrpc: '2.0', id, method: 'alchemy_getTokenMetadata', params: [address] }));
      try {
        const res = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(batchBody),
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) {
          const batchJson = await readBoundedJson(res.body, 2_000_000, 8000);
          if (Array.isArray(batchJson)) {
            for (const item of batchJson as Array<{ id?: number; result?: TokenMeta; error?: unknown }>) {
              if (typeof item?.id === 'number' && chunk[item.id] && item.result && typeof item.result === 'object' && !item.error) {
                const lower = chunk[item.id].toLowerCase();
                const key = `${chain}:${lower}`;
                tokenMetadataMap[lower] = item.result;
                tokenMetadataCache.delete(key);
                tokenMetadataCache.set(key, { expires: Date.now() + 300_000, value: item.result });
                while (tokenMetadataCache.size > 3000) tokenMetadataCache.delete(tokenMetadataCache.keys().next().value!);
              }
            }
          }
        }
      } catch { /* Metadata remains unknown. */ }
    }

    // 4. Ambil Harga Live USD dari DexScreener (Batch up to 30)

    const dexMetaMap: Record<string, { price_usd: number | null, logo: string | null }> = {};
    const validContractsForPricing = contractAddresses;
    const pairs = await fetchMarketPairs(normalizeChain(chain_network), validContractsForPricing);
    for (const [address, pair] of pairs) {
      const price = pair.priceUsd === undefined ? null : Number(pair.priceUsd);
      dexMetaMap[address] = { price_usd: price !== null && Number.isFinite(price) && price >= 0 ? price : null, logo: pair.info?.imageUrl || null };
    }

    // 5. Gabungkan dan format data (Format & Map Token dengan Bendera Karantina Spam + Blacklist)
    const formattedTokens = activeTokens.map((t: any) => {
      const contract = t.contractAddress?.toLowerCase() || "";
      const rawBalanceHex = t.tokenBalance;
      
      const meta = tokenMetadataMap[contract] || {};
      const dexInfo = dexMetaMap[contract] || { price_usd: null, logo: null };
      
      const { balance: balanceFormatted, numericBalance } = formatTokenBalance(rawBalanceHex, meta.decimals);
      const priceUsd = dexInfo.price_usd;
      const computedValue = priceUsd !== null && numericBalance !== null ? numericBalance * priceUsd : null;
      const totalValueUsd = computedValue !== null && Number.isFinite(computedValue) && (computedValue !== 0 || priceUsd === 0 || numericBalance === 0) ? computedValue : null;
      const validLogo = (typeof dexInfo.logo === 'string' && dexInfo.logo.length > 5) || (typeof meta.logo === 'string' && meta.logo.length > 5);

      // 🚫 SPAM / QUARANTINE FILTER:
      // 1. Blacklist -> Paksa spam (alasan: blacklist)
      // 2. VIP -> Selalu lolos
      // 3. Scam keywords -> Spam (alasan: keyword)
      // 4. Unknown price / 0 USD value -> Karantina Zero Value (alasan: zero_value)
      let isSpam = false;
      let spamReason: 'blacklist' | 'keyword' | 'zero_value' | null = null;
      if (BLACKLISTED_TOKENS.includes(contract)) {
        isSpam = true;
        spamReason = 'blacklist';
      } else if (VIP_TOKENS.includes(contract)) {
        isSpam = false;
      } else {
        const lowerName = (meta.name || "").toLowerCase();
        const hasKeyword = 
          lowerName.includes("giftbox") || 
          lowerName.includes("claim") || 
          lowerName.includes("reward") || 
          lowerName.includes("voucher");

        if (hasKeyword) {
          isSpam = true;
          spamReason = 'keyword';
        } else if (priceUsd !== null && totalValueUsd !== null && (priceUsd <= 0 || totalValueUsd <= 0)) {
          isSpam = true;
          spamReason = 'zero_value';
        } else if (!validLogo && totalValueUsd !== null && totalValueUsd < 0.01) {
          isSpam = true;
          spamReason = 'zero_value';
        }
      }

      return {
        contract_address: t.contractAddress,
        name: meta.name || "Unknown",
        symbol: meta.symbol || "???",
        logo: dexInfo.logo || meta.logo || null,
        balance: balanceFormatted,
        raw_balance: rawBalanceHex,
        price_usd: priceUsd,
        total_value_usd: totalValueUsd,
        is_spam: isSpam,
        spam_reason: spamReason
      };
    });

    // 6. Ambil Saldo Native Coin (ETH / BNB)
    let nativeBalanceNum = 0;
    let nativeRawBalance: string | null = null;
    try {
      const nativeBalanceHex = await rpcCall(rpcUrl, 'eth_getBalance', [safeAddress, 'latest']);
      if (typeof nativeBalanceHex === 'string' && /^0x[0-9a-f]+$/i.test(nativeBalanceHex)) {
        nativeBalanceNum = Number(BigInt(nativeBalanceHex)) / 1e18;
        nativeRawBalance = nativeBalanceHex;
      }
    } catch (err) {}

    const nativeMeta = getNativeCoinInfo(chain);
    const nativePriceUsd = nativeMeta ? await fetchNativeCoinPrice(nativeMeta.id) : null;

    if (nativeBalanceNum > 0 && page === 1) {
      formattedTokens.push({
        contract_address: 'NATIVE_COIN',
        name: nativeMeta.name,
        symbol: nativeMeta.symbol,
        logo: null,
        balance: nativeBalanceNum.toFixed(4),
        raw_balance: nativeRawBalance,
        price_usd: nativePriceUsd,
        total_value_usd: nativePriceUsd === null ? null : nativeBalanceNum * nativePriceUsd,
        is_spam: false,
        spam_reason: null
      });
    }

    // Sort: Koin Asli & Bernilai di atas, Spam di bawah
    formattedTokens.sort((a: any, b: any) => {
      if (a.is_spam && !b.is_spam) return 1;
      if (!a.is_spam && b.is_spam) return -1;
      return (b.total_value_usd ?? 0) - (a.total_value_usd ?? 0);
    });

    return NextResponse.json({
      tokens: formattedTokens,
      hasNextPage: false // Alchemy RPC gives all non-zero tokens at once typically, or we can handle pagination later
    });

  } catch (error: any) {
    console.error("Tokens API Error:", error);
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}