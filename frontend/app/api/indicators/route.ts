const NextResponse = Response;
import { RSI, MACD } from 'technicalindicators';
import { normalizeAddress, normalizeChain } from '../../lib/auth.ts';
import { readBoundedJson } from '../../lib/bounded-json.ts';
import { getNetworkSlug } from '../../lib/utils.ts';

// In-memory cache for indicators (TTL: 5 minutes) to protect against 429 rate limits
const cache = new Map<string, { data: any; timestamp: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;
function cacheResult(key: string, data: unknown) {
  cache.delete(key);
  cache.set(key, { data, timestamp: Date.now() });
  while (cache.size > 1000) cache.delete(cache.keys().next().value!);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const contract_address = searchParams.get('contract_address');
  const chain_network = searchParams.get('chain_network');

  if (!contract_address || !chain_network) {
    return NextResponse.json({ error: 'Missing parameters' }, { status: 400 });
  }

  let canonical: string;
  let addr: string;
  try { canonical = normalizeChain(chain_network); addr = normalizeAddress(canonical, contract_address); }
  catch { return NextResponse.json({ error: 'Invalid chain or address' }, { status: 400 }); }
  const networkSlug = getNetworkSlug(canonical);

  const cacheKey = `${networkSlug}:${addr}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return NextResponse.json(cached.data);
  }

  try {
    // 1. Fetch Top Pool for the Token
    const poolRes = await fetch(`https://api.geckoterminal.com/api/v2/networks/${networkSlug}/tokens/${addr}/pools?page=1`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000)
    });

    if (!poolRes.ok) {
      const fallbackResult = { rsi: null, macd: null, error: 'Pool query failed or rate limited' };
      return NextResponse.json(fallbackResult, { status: 200 });
    }
    
    const poolJson = await readBoundedJson(poolRes.body, 1_000_000, 8000) as { data?: Array<{ attributes: { address: string } }> };
    const pools = poolJson.data;

    if (!pools || pools.length === 0) {
      const fallbackResult = { rsi: null, macd: null, error: 'No pools found for this token on DEX' };
      cacheResult(cacheKey, fallbackResult);
      return NextResponse.json(fallbackResult, { status: 200 });
    }

    const topPoolAddress = pools[0].attributes.address;

    // Use only hourly candles; do not silently mix timeframes.
    let ohlcvList: number[][] = [];
    const timeframes = ['hour'];

    for (const tf of timeframes) {
      try {
        const ohlcvRes = await fetch(`https://api.geckoterminal.com/api/v2/networks/${networkSlug}/pools/${topPoolAddress}/ohlcv/${tf}?limit=100`, {
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(8000)
        });

        if (ohlcvRes.ok) {
          const ohlcvJson = await readBoundedJson(ohlcvRes.body, 1_000_000, 8000) as { data?: { attributes?: { ohlcv_list?: unknown } } };
          const list = ohlcvJson.data?.attributes?.ohlcv_list;
          if (Array.isArray(list) && list.length >= 14) {
            ohlcvList = list;
            break;
          } else if (Array.isArray(list) && list.length > ohlcvList.length) {
            ohlcvList = list;
          }
        }
      } catch {
        // continue to next timeframe
      }
    }

    if (!ohlcvList || ohlcvList.length === 0) {
      const fallbackResult = { rsi: null, macd: null, pool: topPoolAddress, error: 'Insufficient candle data' };
      cacheResult(cacheKey, fallbackResult);
      return NextResponse.json(fallbackResult, { status: 200 });
    }

    // GeckoTerminal OHLCV is returned newest to oldest. We need oldest to newest.
    const reversedList = [...ohlcvList].reverse();
    const closes = reversedList.map((candle: number[]) => candle[4]);

    // 3. Calculate Technical Indicators
    let latestRSI: number | null = null;
    if (closes.length >= 14) {
      const rsiInput = { values: closes, period: 14 };
      const rsiResult = RSI.calculate(rsiInput);
      latestRSI = rsiResult.length > 0 ? rsiResult[rsiResult.length - 1] : null;
    }

    let latestMACD: any = null;
    if (closes.length >= 26) {
      const macdInput = {
        values: closes,
        fastPeriod: 12,
        slowPeriod: 26,
        signalPeriod: 9,
        SimpleMAOscillator: false,
        SimpleMASignal: false
      };
      const macdResult = MACD.calculate(macdInput);
      latestMACD = macdResult.length > 0 ? macdResult[macdResult.length - 1] : null;
    }

    const result = {
      rsi: latestRSI,
      macd: latestMACD,
      pool: topPoolAddress,
      timeframe: 'hour'
    };

    cacheResult(cacheKey, result);
    return NextResponse.json(result);

  } catch (error: any) {
    console.error('Error fetching indicators:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

