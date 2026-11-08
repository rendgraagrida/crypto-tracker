import { normalizeAddress, normalizeChain } from '../../lib/auth.ts';
import { fetchRugcheckReport } from '../../lib/coin-analyzer.ts';
import { readBoundedJson } from '../../lib/bounded-json.ts';
const NextResponse = Response;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const contract_address = searchParams.get('contract_address');
  const chain_network = searchParams.get('chain_network'); 
  const priceParam = searchParams.get('price_usd');
  const price_usd = priceParam === null ? null : Number(priceParam);

  if (!contract_address || !chain_network) {
    return NextResponse.json({ error: 'Missing parameters' }, { status: 400 });
  }

  let chain: string;
  try { chain = normalizeChain(chain_network); normalizeAddress(chain, contract_address); }
  catch { return NextResponse.json({ error: 'Invalid chain or address' }, { status: 400 }); }

  try {
    if (chain === 'solana') {
      const report = await fetchRugcheckReport(contract_address);
      if (!report.data || typeof report.data !== 'object') return NextResponse.json({ error: 'Rugcheck unavailable', source: 'Rugcheck' }, { status: 502 });
      const data = report.data as { topHolders?: unknown; reportGeneratedAt?: unknown };
      const entries = Array.isArray(data.topHolders) ? data.topHolders : [];
      const holders = entries.slice(0, 10).map((holder: { owner?: unknown; uiAmount?: unknown; pct?: unknown }) => {
        const balance = typeof holder.uiAmount === 'number' && Number.isFinite(holder.uiAmount) && holder.uiAmount >= 0 ? holder.uiAmount : null;
        const share = typeof holder.pct === 'number' && Number.isFinite(holder.pct) && holder.pct >= 0 && holder.pct <= 100 ? holder.pct : null;
        return { address: typeof holder.owner === 'string' ? holder.owner : null, balance, share, value_usd: balance !== null && price_usd !== null && Number.isFinite(price_usd) ? balance * price_usd : null };
      });
      return NextResponse.json({ holders, source: 'Rugcheck topHolders', source_time: typeof data.reportGeneratedAt === 'string' ? data.reportGeneratedAt : null, coverage: 'Provider-reported top token accounts; may not include all accounts for each owner or represent unique top owners.' });
    }
    // 2. EVM LOGIC (Covalent API)
    else {
      let chainId = 1; // Default to Ethereum
      if (chain === 'bsc' || chain === 'binance') chainId = 56;
      else if (chain === 'base chain' || chain === 'base') chainId = 8453;
      else if (chain === 'robinhood' || chain.includes('robinhood') || chain === 'rh') chainId = 4663;
      else if (chain === 'polygon' || chain === 'matic') chainId = 137;
      else if (chain === 'arbitrum') chainId = 42161;
      else if (chain === 'optimism') chainId = 10;
      else if (chain === 'avalanche') chainId = 43114;
      
      const covalentKey = process.env.COVALENT_API_KEY;
      if (!covalentKey) {
        return NextResponse.json({ error: 'Missing COVALENT_API_KEY env variable' }, { status: 500 });
      }

      // Use V2 endpoint without page-size to avoid timeouts on popular BSC tokens
      const covalentUrl = `https://api.covalenthq.com/v1/${chainId}/tokens/${contract_address}/token_holders_v2/?key=${covalentKey}`;
      
      const response = await fetch(covalentUrl, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) return NextResponse.json({ error: `Covalent HTTP ${response.status}` }, { status: 502 });
      const json = await readBoundedJson(response.body, 2_000_000, 8000) as { data?: { items?: unknown[] } };
      const items = (json.data?.items || []).slice(0, 10);

      const holders = items.map((item: any) => {
        // Covalent returns raw balance string
        const decimals = item.contract_decimals;
        let balanceFormatted: number | null = null;
        let shareCalculated: number | null = null;
        if (typeof decimals === 'number' && Number.isInteger(decimals) && decimals >= 0 && decimals <= 255 && typeof item.balance === 'string' && /^\d{1,78}$/.test(item.balance)) {
          const raw = BigInt(item.balance);
          const padded = item.balance.padStart(decimals + 1, '0');
          const normalized = decimals ? `${padded.slice(0, -decimals)}.${padded.slice(-decimals)}` : padded;
          const amount = Number(normalized);
          if (Number.isFinite(amount)) balanceFormatted = amount;
          if (typeof item.total_supply === 'string' && /^\d{1,78}$/.test(item.total_supply)) {
            const supply = BigInt(item.total_supply);
            if (supply > BigInt(0) && raw <= supply) shareCalculated = Number((raw * BigInt(10000) + supply / BigInt(2)) / supply) / 100;
          }
        }

        return {
          address: item.address,
          balance: balanceFormatted,
          value_usd: balanceFormatted !== null && price_usd !== null && Number.isFinite(price_usd) ? balanceFormatted * price_usd : null,
          share: shareCalculated === null ? null : Number(shareCalculated.toFixed(2))
        };
      });

      return NextResponse.json({ holders });
    }

  } catch (error: any) {
    console.error('Error fetching holders:', error.response?.data || error.message);
    return NextResponse.json({ error: error.response?.data?.error_message || error.message || 'Internal server error' }, { status: 500 });
  }
}

