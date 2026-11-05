export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

function getSupabase() {
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key);
}

interface TrackedCoin {
  id?: number;
  contract_address: string;
  chain_network: string;
  label?: string;
  created_at?: string;
  is_primary?: boolean;
}

interface DexPair {
  chainId: string;
  baseToken: { address: string; name: string; symbol: string };
  priceUsd?: string;
  priceChange?: { h24?: number; h6?: number; h1?: number };
  volume?: { h24?: number };
  liquidity?: { usd?: number };
  marketCap?: number;
  fdv?: number;
  pairAddress?: string;
  url?: string;
  info?: { imageUrl?: string };
}

async function fetchDexData(address: string): Promise<DexPair | null> {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const json = await res.json();
    const pairs: DexPair[] = json.pairs || [];
    if (pairs.length === 0) return null;
    return pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
  } catch {
    return null;
  }
}

async function fetchHoldersCount(address: string, chainNetwork?: string, chainId?: string): Promise<number | null> {
  const chain = (chainNetwork || chainId || '').toLowerCase();
  
  if (chain.includes('sol')) {
    try {
      const res = await fetch(`https://api.rugcheck.xyz/v1/tokens/${address}/report`, {
        headers: { 'Accept': 'application/json' },
      });
      if (res.ok) {
        const json = await res.json();
        if (typeof json.totalHolders === 'number') {
          return json.totalHolders;
        }
      }
    } catch {}
    return null;
  }

  // EVM chains via Covalent
  const covalentKey = process.env.COVALENT_API_KEY;
  if (!covalentKey) return null;

  let cId = 1;
  if (chain.includes('bsc') || chain.includes('bnb')) cId = 56;
  else if (chain.includes('base')) cId = 8453;
  else if (chain.includes('robinhood') || chain.includes('rh')) cId = 4663;
  else if (chain.includes('poly') || chain.includes('matic')) cId = 137;
  else if (chain.includes('arb')) cId = 42161;
  else if (chain.includes('opt')) cId = 10;

  try {
    const url = `https://api.covalenthq.com/v1/${cId}/tokens/${address}/token_holders_v2/?key=${covalentKey}`;
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
    });
    if (res.ok) {
      const json = await res.json();
      const count = json.data?.pagination?.total_count;
      if (typeof count === 'number') return count;
    }
  } catch {}

  return null;
}

export async function GET() {
  try {
    const supabase = getSupabase();
    if (!supabase) return NextResponse.json([]);

    const { data, error } = await supabase
      .from('tracked_coins')
      .select('*')
      .order('is_primary', { ascending: false })
      .order('created_at', { ascending: false });

    if (error || !data) return NextResponse.json([]);

    const enriched = await Promise.all(
      (data as TrackedCoin[]).map(async (coin) => {
        const dex = await fetchDexData(coin.contract_address);
        const totalHolders = await fetchHoldersCount(coin.contract_address, dex?.chainId || coin.chain_network);

        return {
          id: coin.id,
          contract_address: coin.contract_address,
          chain_network: coin.chain_network,
          label: coin.label,
          created_at: coin.created_at,
          name: dex?.baseToken?.name || coin.label || 'Unknown',
          symbol: dex?.baseToken?.symbol || '???',
          price_usd: dex?.priceUsd ? parseFloat(dex.priceUsd) : null,
          price_change_h24: dex?.priceChange?.h24 ?? null,
          price_change_h6: dex?.priceChange?.h6 ?? null,
          price_change_h1: dex?.priceChange?.h1 ?? null,
          volume_h24: dex?.volume?.h24 ?? null,
          liquidity_usd: dex?.liquidity?.usd ?? null,
          market_cap: dex?.marketCap ?? null,
          fdv: dex?.fdv ?? null,
          chain_id: dex?.chainId ?? coin.chain_network,
          dex_url: dex?.url ?? `https://dexscreener.com/search?q=${coin.contract_address}`,
          logo: dex?.info?.imageUrl ?? null,
          total_holders: totalHolders,
          is_primary: coin.is_primary ?? false,
        };
      })
    );

    return NextResponse.json(enriched);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const supabase = getSupabase();
    if (!supabase) return NextResponse.json({ error: 'Supabase belum terkonfigurasi' }, { status: 500 });

    const body = await request.json();
    const { contract_address, chain_network, label } = body;
    if (!contract_address) return NextResponse.json({ error: 'contract_address wajib diisi' }, { status: 400 });

    const cleanAddress = contract_address.toString().trim();
    const dex = await fetchDexData(cleanAddress);

    const { data, error } = await supabase.from('tracked_coins').insert([{
      contract_address: cleanAddress,
      chain_network: chain_network || dex?.chainId || 'Unknown',
      label: label || dex?.baseToken?.name || cleanAddress.slice(0, 8),
    }]).select().single();

    if (error) {
      if (error.code === '23505') {
        return NextResponse.json({ error: 'Token sudah ditambahkan ke Track Coin' }, { status: 200 });
      }
      throw error;
    }

    return NextResponse.json({
      success: true,
      data,
      preview: dex ? {
        name: dex.baseToken.name,
        symbol: dex.baseToken.symbol,
        price_usd: dex.priceUsd ? parseFloat(dex.priceUsd) : null,
        chain_id: dex.chainId,
      } : null,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 200 });
  }
}

export async function DELETE(request: Request) {
  try {
    const supabase = getSupabase();
    if (!supabase) return NextResponse.json({ error: 'Supabase belum terkonfigurasi' }, { status: 500 });

    const { contract_address, deleteAll } = await request.json();
    
    if (deleteAll) {
      const { error } = await supabase.from('tracked_coins').delete().neq('contract_address', '');
      if (error) throw error;
      return NextResponse.json({ success: true });
    }

    const { error } = await supabase
      .from('tracked_coins')
      .delete()
      .eq('contract_address', contract_address.toString().trim());

    if (error) throw error;
    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 200 });
  }
}

/**
 * PATCH: Toggle is_primary flag for a tracked coin (max 3 primary at once)
 */
export async function PATCH(request: Request) {
  try {
    const supabase = getSupabase();
    if (!supabase) return NextResponse.json({ error: 'Supabase belum terkonfigurasi' }, { status: 500 });

    const { contract_address, is_primary } = await request.json();
    if (!contract_address) return NextResponse.json({ error: 'contract_address wajib diisi' }, { status: 400 });

    const cleanAddress = contract_address.toString().trim();

    // Enforce max 5 primary coins
    if (is_primary === true) {
      const { data: existing } = await supabase
        .from('tracked_coins')
        .select('contract_address')
        .eq('is_primary', true);

      const currentPrimary = (existing || []).filter(
        (c: any) => c.contract_address.toLowerCase() !== cleanAddress.toLowerCase()
      );

      if (currentPrimary.length >= 5) {
        return NextResponse.json({
          error: 'Maksimal 5 coin utama. Lepas pin dari coin lain terlebih dahulu.',
          limitReached: true
        }, { status: 400 });
      }
    }

    const { error } = await supabase
      .from('tracked_coins')
      .update({ is_primary: is_primary === true })
      .eq('contract_address', cleanAddress);

    if (error) throw error;
    return NextResponse.json({ success: true, is_primary: is_primary === true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
