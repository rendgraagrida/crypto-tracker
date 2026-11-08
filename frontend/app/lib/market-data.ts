import { normalizeAddress, normalizeChain } from './auth.ts';
import { readBoundedJson } from './bounded-json.ts';

export interface DexPair {
  chainId?: string;
  baseToken?: { address?: string; name?: string; symbol?: string };
  quoteToken?: { address?: string; name?: string; symbol?: string };
  priceUsd?: string;
  priceNative?: string;
  priceChange?: { h24?: number; h6?: number; h1?: number };
  volume?: { h24?: number; [key: string]: number | undefined };
  liquidity?: { usd?: number; base?: number; quote?: number };
  marketCap?: number;
  fdv?: number;
  pairAddress?: string;
  pairCreatedAt?: number;
  url?: string;
  info?: { imageUrl?: string };
  txns?: { h24?: { buys?: number; sells?: number } };
  [key: string]: unknown;
}

const cache = new Map<string, { expires: number; pair: DexPair | null }>();
const pending = new Map<string, Promise<DexPair | null>>();
const MAX_CACHE = 3000;
let active = 0;
const queue: Array<() => void> = [];
async function acquire() {
  if (active >= 2) {
    const { promise, resolve } = Promise.withResolvers<void>();
    queue.push(resolve);
    await promise;
  } else active++;
}
function release() {
  const next = queue.shift();
  if (next) next(); else active--;
}
function put(key: string, pair: DexPair | null) {
  cache.delete(key);
  cache.set(key, { expires: Date.now() + (pair ? 60_000 : 5_000), pair });
  while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!);
}

export async function fetchMarketPairs(chain: string, addresses: string[]): Promise<Map<string, DexPair>> {
  const network = normalizeChain(chain);
  const normalized = [...new Set(addresses.map(address => normalizeAddress(network, address)))];
  const result = new Map<string, DexPair>();
  const waits: Array<Promise<void>> = [];
  const missing: string[] = [];
  for (const address of normalized) {
    const key = `${network}:${address}`;
    const entry = cache.get(key);
    if (entry && entry.expires > Date.now()) {
      cache.delete(key); cache.set(key, entry);
      if (entry.pair) result.set(address, entry.pair);
    } else if (pending.has(key)) {
      waits.push(pending.get(key)!.then(pair => { if (pair) result.set(address, pair); }));
    } else missing.push(address);
  }
  for (let i = 0; i < missing.length; i += 30) {
    const { promise: batch, resolve: resolveBatch } = Promise.withResolvers<Map<string, DexPair> | null>();
    const chunk = missing.slice(i, i + Math.min(30, Math.max(0, MAX_CACHE - pending.size)));
    if (!chunk.length) break;
    for (const address of chunk) {
      const key = `${network}:${address}`;
      const promise = batch.then(pairs => pairs?.get(address) ?? null);
      pending.set(key, promise);
      waits.push(promise.then(pair => { if (pair) result.set(address, pair); }));
    }
    void (async () => {
      let pairs: Map<string, DexPair> | null = null;
      await acquire();
      try {
        const response = await fetch(`https://api.dexscreener.com/tokens/v1/${encodeURIComponent(network)}/${chunk.join(',')}`, { signal: AbortSignal.timeout(8000) });
        if (response.ok) {
          const data = await readBoundedJson(response.body, 2_000_000, 8000);
          if (Array.isArray(data)) {
            pairs = new Map();
            const requested = new Set(chunk);
            for (const pair of data as DexPair[]) {
              if (!pair.baseToken?.address || pair.chainId !== network) continue;
              let address: string;
              try { address = normalizeAddress(network, pair.baseToken.address); } catch { continue; }
              if (!requested.has(address)) continue;
              const current = pairs.get(address);
              if (!current || (pair.liquidity?.usd ?? 0) > (current.liquidity?.usd ?? 0)) pairs.set(address, pair);
            }
            for (const address of chunk) put(`${network}:${address}`, pairs.get(address) ?? null);
          }
        }
      } catch { /* Provider failure is not a zero price. */ }
      finally {
        release();
        for (const address of chunk) pending.delete(`${network}:${address}`);
        resolveBatch(pairs);
      }
    })();
  }
  await Promise.all(waits);
  return result;
}

const nativePriceCache = new Map<string, { expires: number; price: number | null }>();
const pendingNativePrice = new Map<string, Promise<number | null>>();

/** Cached + single-flight native coin USD price lookup to avoid CoinGecko 429 rate limits. */
export async function fetchNativeCoinPrice(coinGeckoId: string): Promise<number | null> {
  const id = coinGeckoId.trim().toLowerCase();
  if (!id) return null;
  const cached = nativePriceCache.get(id);
  if (cached && cached.expires > Date.now()) return cached.price;
  const inflight = pendingNativePrice.get(id);
  if (inflight) return inflight;
  const task = (async () => {
    let price: number | null = null;
    try {
      const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const data = await readBoundedJson(res.body, 100_000, 8000) as Record<string, { usd?: number }>;
        const val = data?.[id]?.usd;
        if (typeof val === 'number' && Number.isFinite(val) && val > 0) price = val;
      }
    } catch { /* Leave native price unknown on failure. */ }
    nativePriceCache.delete(id);
    nativePriceCache.set(id, { expires: Date.now() + (price !== null ? 60_000 : 5_000), price });
    while (nativePriceCache.size > 100) nativePriceCache.delete(nativePriceCache.keys().next().value!);
    return price;
  })().finally(() => pendingNativePrice.delete(id));
  pendingNativePrice.set(id, task);
  return task;
}
