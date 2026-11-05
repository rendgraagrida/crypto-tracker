export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

function getSupabase() {
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key);
}

const getAlchemyRpcUrl = (network: string) => {
  const net = network.toUpperCase();
  if (net === 'ROBINHOOD' || net.includes('ROBINHOOD') || net === 'RH') return process.env.ALCHEMY_ROBINHOOD_URL || '';
  if (net === 'ETHEREUM' || net.includes('ETH')) return process.env.ALCHEMY_ETH_URL || '';
  if (net === 'BASE CHAIN' || net.includes('BASE')) return process.env.ALCHEMY_BASE_URL || '';
  if (net === 'BSC' || net.includes('BNB')) return process.env.ALCHEMY_BSC_URL || '';
  return '';
};

const getNativeCoinInfo = (network: string) => {
  const net = network.toUpperCase();
  if (net === 'BSC' || net.includes('BNB')) return { id: 'binancecoin', symbol: 'BNB', name: 'BNB' };
  if (net === 'ROBINHOOD' || net.includes('ROBINHOOD') || net === 'RH') return { id: 'ethereum', symbol: 'ETH', name: 'Ethereum (Robinhood)' };
  return { id: 'ethereum', symbol: 'ETH', name: 'Ethereum' };
};

// Helper untuk batch RPC calls
async function rpcCall(url: string, method: string, params: any[]) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  if (!res.ok) throw new Error(`RPC Error: ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

export async function POST(request: Request) {
  try {
    const { wallet_address, chain_network, page = 1 } = await request.json();
    if (!wallet_address || !chain_network) {
      return NextResponse.json({ error: "Data dompet tidak lengkap" }, { status: 400 });
    }

    const safeAddress = wallet_address.toString().trim();
    const safeNet = chain_network.toUpperCase();

    // 🔴 Jika jaringan adalah SOLANA, forward ke handler Solana
    if (safeNet === 'SOLANA') {
      const solUrl = new URL('/api/solana', request.url);
      const solRes = await fetch(solUrl.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet_address: safeAddress, page })
      });
      const solData = await solRes.json();
      return NextResponse.json(solData, { status: solRes.status });
    }

    const rpcUrl = getAlchemyRpcUrl(chain_network);
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
        const [trackedRes, blacklistRes] = await Promise.all([
          supabase.from('tracked_coins').select('contract_address, chain_network'),
          supabase.from('blacklist_tokens').select('contract_address'),
        ]);
        if (trackedRes.data && Array.isArray(trackedRes.data)) {
          // Normalisasi chain_network agar bisa dicocokkan: 'bsc', 'BSC', 'Binance', 'Robinhood' match ke RPC masing-masing
          const chainNorm = safeNet; // e.g. 'BSC', 'ETHEREUM', 'BASE CHAIN', 'ROBINHOOD'
          VIP_TOKENS = trackedRes.data
            .filter((item: any) => {
              const itemChain = (item.chain_network || '').toUpperCase();
              if (chainNorm.includes('BSC') || chainNorm.includes('BNB')) return itemChain.includes('BSC') || itemChain.includes('BNB');
              if (chainNorm.includes('ROBINHOOD') || chainNorm.includes('RH')) return itemChain.includes('ROBINHOOD') || itemChain.includes('RH');
              if (chainNorm.includes('ETH')) return itemChain.includes('ETH') && !itemChain.includes('BSC') && !itemChain.includes('ROBINHOOD');
              if (chainNorm.includes('BASE')) return itemChain.includes('BASE');
              return false;
            })
            .map((item: any) => item.contract_address?.toLowerCase() || "");
        }
        if (blacklistRes.data && Array.isArray(blacklistRes.data)) {
          BLACKLISTED_TOKENS = blacklistRes.data.map((item: any) => item.contract_address?.toLowerCase() || "");
        }
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
    
    // 3. Ambil metadata untuk tiap token (Batching up to limits, or Promise.all if not too many)
    const tokenMetadataMap: Record<string, any> = {};
    const contractAddresses = activeTokens.map((t: any) => t.contractAddress);
    
    // For small number of tokens, we can use Promise.all. If huge, we might need chunks, but Alchemy limit is high.
    // Let's do it in chunks of 50 just to be safe.
    for (let i = 0; i < contractAddresses.length; i += 50) {
      const chunk = contractAddresses.slice(i, i + 50);
      await Promise.all(chunk.map(async (address: string) => {
        try {
          const metadata = await rpcCall(rpcUrl, 'alchemy_getTokenMetadata', [address]);
          tokenMetadataMap[address.toLowerCase()] = metadata;
        } catch (e) {
          // ignore individual token metadata failures
        }
      }));
    }

    // 4. Ambil Harga Live USD dari DexScreener (Batch up to 30)
    const KNOWN_EVM_STABLES: Record<string, { price_usd: number; logo: string | null }> = {
      '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { price_usd: 1.0, logo: 'https://static.alchemyapi.io/images/assets/3408.png' }, // USDC ETH
      '0xdac17f958d2ee523a2206206994597c13d831ec7': { price_usd: 1.0, logo: 'https://static.alchemyapi.io/images/assets/825.png' },  // USDT ETH
      '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': { price_usd: 1.0, logo: 'https://static.alchemyapi.io/images/assets/3408.png' }, // USDC BSC
      '0x55d398326f99059ff775485246999027b3197955': { price_usd: 1.0, logo: 'https://static.alchemyapi.io/images/assets/825.png' },  // USDT BSC
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { price_usd: 1.0, logo: 'https://static.alchemyapi.io/images/assets/3408.png' }, // USDC BASE
    };
    const KNOWN_EVM_SET = new Set(Object.keys(KNOWN_EVM_STABLES).map(k => k.toLowerCase()));

    const dexMetaMap: Record<string, { price_usd: number, logo: string | null }> = {};
    const validContractsForPricing = contractAddresses.filter(c => !KNOWN_EVM_SET.has(c.toLowerCase()));
    
    if (validContractsForPricing.length > 0) {
      try {
        for (let i = 0; i < validContractsForPricing.length; i += 30) {
          const chunk = validContractsForPricing.slice(i, i + 30);
          const dexRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${chunk.join(",")}`, {
            headers: { 'Accept': 'application/json' }
          }).then(r => r.json()).catch(() => null);

          if (dexRes?.pairs && Array.isArray(dexRes.pairs)) {
            dexRes.pairs.forEach((p: any) => {
              const addr = p.baseToken?.address?.toLowerCase();
              if (addr && !dexMetaMap[addr]) {
                dexMetaMap[addr] = {
                  price_usd: parseFloat(p.priceUsd || "0") || 0,
                  logo: p.info?.imageUrl || null
                };
              }
            });
          }
        }
      } catch (e) {
        console.error("DexScreener API error:", e);
      }
    }

    // 5. Gabungkan dan format data (Format & Map Token dengan Bendera Karantina Spam + Blacklist)
    const formattedTokens = activeTokens.map((t: any) => {
      const contract = t.contractAddress?.toLowerCase() || "";
      const rawBalanceHex = t.tokenBalance;
      
      const meta = tokenMetadataMap[contract] || {};
      const dexInfo = dexMetaMap[contract] || { price_usd: 0, logo: null };
      const knownStable = KNOWN_EVM_STABLES[contract];
      
      const decimals = meta.decimals !== null && meta.decimals !== undefined ? parseInt(meta.decimals) : 18;
      
      let balanceFormatted = "0";
      try {
        const balanceBigInt = BigInt(rawBalanceHex);
        const balanceNum = Number(balanceBigInt) / (10 ** decimals);
        balanceFormatted = balanceNum.toFixed(6);
      } catch(e) {
        balanceFormatted = "0";
      }
      
      const numBalance = parseFloat(balanceFormatted);
      const priceUsd = knownStable ? knownStable.price_usd : dexInfo.price_usd;
      const totalValueUsd = numBalance * priceUsd;
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
        } else if (!priceUsd || priceUsd <= 0 || !totalValueUsd || totalValueUsd <= 0) {
          isSpam = true;
          spamReason = 'zero_value';
        } else if (!validLogo && totalValueUsd < 0.01) {
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
        price_usd: priceUsd,
        total_value_usd: totalValueUsd,
        is_spam: isSpam,
        spam_reason: spamReason
      };
    });

    // 6. Ambil Saldo Native Coin (ETH / BNB)
    let nativeBalanceNum = 0;
    try {
      const nativeBalanceHex = await rpcCall(rpcUrl, 'eth_getBalance', [safeAddress, 'latest']);
      nativeBalanceNum = Number(BigInt(nativeBalanceHex)) / 1e18;
    } catch (err) {}

    let nativePriceUsd = 0;
    const nativeMeta = getNativeCoinInfo(chain_network);
    try {
      const cgRes = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${nativeMeta.id}&vs_currencies=usd`).catch(() => null);
      if (cgRes && cgRes.ok) {
        const cgData = await cgRes.json();
        nativePriceUsd = cgData[nativeMeta.id]?.usd || 0;
      }
    } catch (err) {}

    if (nativeBalanceNum > 0 && page === 1) {
      formattedTokens.push({
        contract_address: 'NATIVE_COIN',
        name: nativeMeta.name,
        symbol: nativeMeta.symbol,
        logo: null,
        balance: nativeBalanceNum.toFixed(4),
        price_usd: nativePriceUsd,
        total_value_usd: nativeBalanceNum * nativePriceUsd,
        is_spam: false,
        spam_reason: null
      });
    }

    // Sort: Koin Asli & Bernilai di atas, Spam di bawah
    formattedTokens.sort((a: any, b: any) => {
      if (a.is_spam && !b.is_spam) return 1;
      if (!a.is_spam && b.is_spam) return -1;
      return b.total_value_usd - a.total_value_usd;
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