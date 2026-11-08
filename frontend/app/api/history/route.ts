import { normalizeAddress, normalizeChain } from '../../lib/auth.ts';
import { fetchMarketPairs } from '../../lib/market-data.ts';
import { readBoundedJson } from '../../lib/bounded-json.ts';
const NextResponse = Response;

async function enrichHistory(history: any[], contract_address: string, chain: string) {
  if (history.length === 0) return history;
  try {
    const pair = (await fetchMarketPairs(chain, [contract_address])).get(normalizeAddress(chain, contract_address));
    if (!pair) return history;
    const currentPriceUsd = parseFloat(pair.priceUsd || '0');
    const currentPriceNative = parseFloat(pair.priceNative || '0');
    const currentMcap = pair.fdv || pair.marketCap || 0;

    return history.map(tx => {
      let historicalPriceUsd = null;
      let historicalMc = null;

      if (tx.amount > 0) {
        if (tx.value_usd > 0) {
          historicalPriceUsd = tx.value_usd / tx.amount;
        } else if (tx.value_native > 0 && currentPriceUsd > 0 && currentPriceNative > 0) {
          const historicalPriceNative = tx.value_native / tx.amount;
          if (currentMcap > 0) {
            historicalMc = (historicalPriceNative / currentPriceNative) * currentMcap;
            historicalPriceUsd = historicalPriceNative * (currentPriceUsd / currentPriceNative); 
          }
        }

        if (historicalPriceUsd !== null && historicalPriceUsd > 0 && currentPriceUsd > 0 && currentMcap > 0 && !historicalMc) {
          historicalMc = (historicalPriceUsd / currentPriceUsd) * currentMcap;
        }
      }

      return {
        ...tx,
        historical_price_usd: historicalPriceUsd,
        historical_mc: historicalMc,
        valuation_basis: 'Estimated using current market data where historical pricing is unavailable'
      };
    });
  } catch (e) {
    return history;
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const wallet_address = searchParams.get('wallet_address');
  const contract_address = searchParams.get('contract_address');
  const chain_network = searchParams.get('chain_network');

  if (!wallet_address || !contract_address || !chain_network) {
    return NextResponse.json({ error: 'Missing parameters' }, { status: 400 });
  }
  let chain: string;
  try { chain = normalizeChain(chain_network); normalizeAddress(chain, contract_address); normalizeAddress(chain, wallet_address); }
  catch { return NextResponse.json({ error: 'Invalid chain or address' }, { status: 400 }); }


  try {
    if (chain === 'solana') {
      const heliusKey = process.env.HELIUS_API_KEY;
      if (!heliusKey) return NextResponse.json({ error: 'Missing HELIUS_API_KEY' }, { status: 500 });

      // Removed &type=TRANSFER so we also get swaps and other transactions that move tokens
      const url = `https://api.helius.xyz/v0/addresses/${wallet_address}/transactions?api-key=${heliusKey}&limit=50`;
      const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) {
        return NextResponse.json({ error: `Helius API error: ${res.status}` }, { status: 502 });
      }

      const txList = await readBoundedJson(res.body, 2_000_000, 8000) as any[];
      const history: any[] = [];

      for (const tx of txList) {
        const transfers: any[] = tx.tokenTransfers || [];

        for (const t of transfers) {
          if (t.mint !== contract_address) continue;
          const isBuy = t.toUserAccount === wallet_address;
          if (!isBuy && t.fromUserAccount !== wallet_address) continue;
          
          const value_native = null;

          history.push({
            type: isBuy ? 'IN' : 'OUT',
            amount: t.tokenAmount || 0,
            symbol: null,
            value_usd: null,
            value_native,
            timestamp: tx.timestamp ? new Date(tx.timestamp * 1000).toISOString() : null,
            tx_hash: tx.signature,
            explorer_url: `https://solscan.io/tx/${tx.signature}`,
            from: t.fromUserAccount || null,
            to: t.toUserAccount || null,
          });
        }
      }

      const finalHistory = await enrichHistory(history.slice(0, 25), contract_address, chain);
      return NextResponse.json({ history: finalHistory });
    }

    // EVM via Alchemy (Fast) or Covalent (Fallback)
    let chainId = 1;
    if (chain === 'bsc' || chain === 'binance') chainId = 56;
    else if (chain === 'base chain' || chain === 'base') chainId = 8453;
    else if (chain === 'robinhood' || chain.includes('robinhood') || chain === 'rh') chainId = 4663;
    else if (chain === 'polygon' || chain === 'matic') chainId = 137;
    else if (chain === 'arbitrum') chainId = 42161;
    else if (chain === 'optimism') chainId = 10;
    else if (chain === 'avalanche') chainId = 43114;

    const explorerMap: Record<number, string> = {
      1: 'https://etherscan.io/tx',
      56: 'https://bscscan.com/tx',
      8453: 'https://basescan.org/tx',
      4663: 'https://explorer.robinhood.com/tx',
      137: 'https://polygonscan.com/tx',
      42161: 'https://arbiscan.io/tx',
      10: 'https://optimistic.etherscan.io/tx',
      43114: 'https://snowtrace.io/tx',
    };
    const explorerBase = explorerMap[chainId] || 'https://etherscan.io/tx';

    // Build Alchemy URL
    const rpcVariables: Record<number, string> = {
      1: 'ALCHEMY_ETH_URL', 56: 'ALCHEMY_BSC_URL', 8453: 'ALCHEMY_BASE_URL',
      4663: 'ALCHEMY_ROBINHOOD_URL', 137: 'ALCHEMY_POLYGON_URL', 42161: 'ALCHEMY_ARBITRUM_URL', 10: 'ALCHEMY_OPTIMISM_URL', 43114: 'ALCHEMY_AVALANCHE_URL',
    };
    const alchemyUrl = process.env[rpcVariables[chainId]] || '';

    if (alchemyUrl) {
      // Use Alchemy
      const fetchAlchemyTransfers = async (isOut: boolean) => {
        const params: any = {
          fromBlock: "0x0",
          toBlock: "latest",
          contractAddresses: [contract_address],
          category: ["erc20"],
          withMetadata: true,
          maxCount: "0x64" // max 100 tx
        };
        if (isOut) params.fromAddress = wallet_address;
        else params.toAddress = wallet_address;

        const req = await fetch(alchemyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'alchemy_getAssetTransfers',
            params: [params]
          }),
          signal: AbortSignal.timeout(8000)
        });
        if (!req.ok) return [];
        const res = await readBoundedJson(req.body, 2_000_000, 8000) as { result?: { transfers?: unknown[] } };
        return res.result?.transfers || [];
      };

      const [inTransfers, outTransfers] = await Promise.all([
        fetchAlchemyTransfers(false),
        fetchAlchemyTransfers(true)
      ]);

      const history: any[] = [];
      const formatTx = (t: any, type: string) => ({
        type,
        amount: t.value || 0,
        symbol: t.asset || '?',
        value_usd: null,
        timestamp: t.metadata?.blockTimestamp || null,
        tx_hash: t.hash,
        explorer_url: `${explorerBase}/${t.hash}`,
        from: t.from || null,
        to: t.to || null,
      });

      for (const t of inTransfers) history.push(formatTx(t, 'IN'));
      for (const t of outTransfers) history.push(formatTx(t, 'OUT'));

      // Sort DESC by timestamp
      history.sort((a, b) => {
        const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
        return tb - ta;
      });

      const finalHistory = await enrichHistory(history.slice(0, 25), contract_address, chain);
      return NextResponse.json({ history: finalHistory });
    }

    // Fallback to Covalent if chain not supported by Alchemy
    const covalentKey = process.env.COVALENT_API_KEY;
    if (!covalentKey) return NextResponse.json({ error: 'Missing COVALENT_API_KEY' }, { status: 500 });

    const url = `https://api.covalenthq.com/v1/${chainId}/address/${wallet_address}/transfers_v2/?contract-address=${contract_address}&page-size=25&key=${covalentKey}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    
    if (!res.ok) {
      return NextResponse.json({ error: `Covalent API error: HTTP ${res.status}` }, { status: 502 });
    }

    const json = await readBoundedJson(res.body, 2_000_000, 8000) as { data?: { items?: any[] } };
    const items: any[] = json.data?.items || [];
    const history: any[] = [];

    for (const item of items) {
      const transfers: any[] = item.transfers || [];
      for (const t of transfers) {
        const decimals = t.contract_decimals || 18;
        const rawAmount = BigInt(t.delta || '0');
        const amount = Number(rawAmount) / 10 ** decimals;
        history.push({
          type: t.transfer_type === 'IN' ? 'IN' : 'OUT',
          amount,
          symbol: t.contract_ticker_symbol || '?',
          value_usd: t.delta_quote || 0,
          timestamp: t.block_signed_at || item.block_signed_at,
          tx_hash: item.tx_hash,
          explorer_url: `${explorerBase}/${item.tx_hash}`,
          from: item.from_address || null,
          to: item.to_address || null,
        });
      }
    }

    const finalHistory = await enrichHistory(history.slice(0, 25), contract_address, chain);
    return NextResponse.json({ history: finalHistory });

  } catch (error: any) {
    console.error('Error fetching history:', error.message);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
