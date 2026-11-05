import { NextResponse } from 'next/server';
import { getNetworkSlug } from '@/app/lib/utils';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const contract_address = searchParams.get('contract_address');
  const chain_network = searchParams.get('chain_network');

  if (!contract_address || !chain_network) {
    return NextResponse.json({ error: 'Missing contract_address or chain_network parameters' }, { status: 400 });
  }

  const networkSlug = getNetworkSlug(chain_network);
  const cleanAddress = chain_network.toLowerCase() === 'solana' 
    ? contract_address.trim() 
    : contract_address.trim().toLowerCase();

  try {
    // 1. Fetch the Top Pool for this Token on GeckoTerminal
    const poolUrl = `https://api.geckoterminal.com/api/v2/networks/${networkSlug}/tokens/${cleanAddress}/pools?page=1`;
    const poolRes = await fetch(poolUrl, {
      headers: { 'Accept': 'application/json' },
      next: { revalidate: 30 } // Cache 30s
    });

    if (!poolRes.ok) {
      return NextResponse.json({ 
        trades: [], 
        pool: null, 
        stats: null,
        error: 'Pool tidak ditemukan di GeckoTerminal.' 
      }, { status: 200 });
    }

    const poolJson = await poolRes.json();
    const pools = poolJson.data;

    if (!pools || pools.length === 0) {
      return NextResponse.json({ 
        trades: [], 
        pool: null, 
        stats: null,
        error: 'Belum ada pool likuiditas terdaftar untuk token ini.' 
      }, { status: 200 });
    }

    const topPool = pools[0];
    const poolAddress = topPool.attributes.address;
    const poolName = topPool.attributes.name || 'Pool';

    // 2. Fetch the Latest Trades for this Pool
    const tradesUrl = `https://api.geckoterminal.com/api/v2/networks/${networkSlug}/pools/${poolAddress}/trades`;
    const tradesRes = await fetch(tradesUrl, {
      headers: { 'Accept': 'application/json' },
      next: { revalidate: 15 } // Cache 15s
    });

    if (!tradesRes.ok) {
      return NextResponse.json({ 
        trades: [], 
        pool: { address: poolAddress, name: poolName },
        stats: null,
        error: 'Gagal mengambil riwayat transaksi dari pool.' 
      }, { status: 200 });
    }

    const tradesJson = await tradesRes.json();
    const rawTrades = tradesJson.data || [];

    let totalBuyVolumeUsd = 0;
    let totalSellVolumeUsd = 0;
    let buyCount = 0;
    let sellCount = 0;

    const formattedTrades = rawTrades.map((t: any) => {
      const attr = t.attributes || {};
      const isBuy = attr.kind === 'buy';
      const volumeUsd = parseFloat(attr.volume_in_usd || '0') || 0;
      
      // Token Amount
      const tokenAmount = isBuy 
        ? parseFloat(attr.to_token_amount || '0') || 0 
        : parseFloat(attr.from_token_amount || '0') || 0;

      // Price USD
      const priceUsd = isBuy
        ? parseFloat(attr.price_to_in_usd || '0') || 0
        : parseFloat(attr.price_from_in_usd || '0') || 0;

      if (isBuy) {
        totalBuyVolumeUsd += volumeUsd;
        buyCount++;
      } else {
        totalSellVolumeUsd += volumeUsd;
        sellCount++;
      }

      return {
        id: t.id,
        type: isBuy ? 'buy' : 'sell',
        priceUsd: priceUsd,
        tokenAmount: tokenAmount,
        volumeUsd: volumeUsd,
        timestamp: attr.block_timestamp || new Date().toISOString(),
        txHash: attr.tx_hash || '',
        maker: attr.tx_from_address || attr.to_maker || attr.from_maker || 'Unknown'
      };
    });

    return NextResponse.json({
      success: true,
      pool: {
        address: poolAddress,
        name: poolName,
        network: networkSlug,
        fdv_usd: topPool.attributes.fdv_usd,
        market_cap_usd: topPool.attributes.market_cap_usd
      },
      stats: {
        totalTrades: formattedTrades.length,
        buyCount,
        sellCount,
        totalBuyVolumeUsd,
        totalSellVolumeUsd,
        netFlowUsd: totalBuyVolumeUsd - totalSellVolumeUsd
      },
      trades: formattedTrades
    });

  } catch (error: any) {
    console.error('API /api/trades error:', error);
    return NextResponse.json({ 
      trades: [], 
      error: error.message || 'Gagal memproses transaksi GeckoTerminal' 
    }, { status: 500 });
  }
}
