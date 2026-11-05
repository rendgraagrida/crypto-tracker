import { NextResponse } from 'next/server';
import { RSI, MACD } from 'technicalindicators';

const NETWORK_MAP: Record<string, string> = {
  'ethereum': 'eth',
  'eth': 'eth',
  'bsc': 'bsc',
  'bnb': 'bsc',
  'binance': 'bsc',
  'base chain': 'base',
  'base': 'base',
  'robinhood': 'robinhood',
  'rh': 'robinhood',
  'solana': 'solana',
  'sol': 'solana',
  'arbitrum': 'arbitrum',
  'arbitrum_one': 'arbitrum',
  'polygon': 'polygon_pos',
  'polygon_pos': 'polygon_pos',
  'matic': 'polygon_pos',
  'avalanche': 'avax',
  'avax': 'avax',
  'optimism': 'optimism',
};

// In-memory cache for indicators (TTL: 5 minutes) to protect against 429 rate limits
const cache = new Map<string, { data: any; timestamp: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const contract_address = searchParams.get('contract_address');
  const chain_network = searchParams.get('chain_network');

  if (!contract_address || !chain_network) {
    return NextResponse.json({ error: 'Missing parameters' }, { status: 400 });
  }

  const cleanChain = chain_network.trim().toLowerCase();
  const networkSlug = NETWORK_MAP[cleanChain] || (cleanChain.includes('sol') ? 'solana' : cleanChain.includes('bsc') ? 'bsc' : cleanChain.includes('robin') || cleanChain.includes('rh') ? 'robinhood' : cleanChain.includes('base') ? 'base' : 'eth');
  const cleanAddress = contract_address.trim().toLowerCase(); 
  const addr = networkSlug === 'solana' ? contract_address.trim() : cleanAddress;

  const cacheKey = `${networkSlug}:${addr}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return NextResponse.json(cached.data);
  }

  try {
    // 1. Fetch Top Pool for the Token
    const poolRes = await fetch(`https://api.geckoterminal.com/api/v2/networks/${networkSlug}/tokens/${addr}/pools?page=1`, {
      headers: { 'Accept': 'application/json' },
      next: { revalidate: 300 }
    });

    if (!poolRes.ok) {
      const fallbackResult = { rsi: null, macd: null, error: 'Pool query failed or rate limited' };
      return NextResponse.json(fallbackResult, { status: 200 });
    }
    
    const poolJson = await poolRes.json();
    const pools = poolJson.data;

    if (!pools || pools.length === 0) {
      const fallbackResult = { rsi: null, macd: null, error: 'No pools found for this token on DEX' };
      cache.set(cacheKey, { data: fallbackResult, timestamp: Date.now() });
      return NextResponse.json(fallbackResult, { status: 200 });
    }

    const topPoolAddress = pools[0].attributes.address;

    // 2. Fetch OHLCV data with fallback timeframes (hour -> minute -> day)
    let ohlcvList: number[][] = [];
    const timeframes = ['hour', 'minute', 'day'];

    for (const tf of timeframes) {
      try {
        const ohlcvRes = await fetch(`https://api.geckoterminal.com/api/v2/networks/${networkSlug}/pools/${topPoolAddress}/ohlcv/${tf}?limit=100`, {
          headers: { 'Accept': 'application/json' },
          next: { revalidate: 300 }
        });

        if (ohlcvRes.ok) {
          const ohlcvJson = await ohlcvRes.json();
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
      cache.set(cacheKey, { data: fallbackResult, timestamp: Date.now() });
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
      pool: topPoolAddress
    };

    cache.set(cacheKey, { data: result, timestamp: Date.now() });
    return NextResponse.json(result);

  } catch (error: any) {
    console.error('Error fetching indicators:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

