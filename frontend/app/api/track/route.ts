export const dynamic = 'force-dynamic';
import { normalizeAddress, normalizeChain } from '../../lib/auth.ts';
import { fetchMarketPairs } from '../../lib/market-data.ts';
import { deleteChainIdentities, resolveStoredIdentity } from '../../lib/identity.ts';
import { readBoundedJson } from '../../lib/bounded-json.ts';
import { boundedFetch } from '../../lib/bounded-fetch.ts';
import type { DexPair } from '../../lib/market-data.ts';
const NextResponse = Response;
import { createClient } from '@supabase/supabase-js';

function getSupabase() {
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key, { global: { fetch: boundedFetch } });
}

interface TrackedCoin {
  id?: number;
  contract_address: string;
  chain_network: string;
  label?: string;
  created_at?: string;
  is_primary?: boolean;
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

    const markets = new Map<string, Map<string, DexPair>>();
    for (const coin of data as TrackedCoin[]) {
      try {
        const chain = normalizeChain(coin.chain_network);
        if (!markets.has(chain)) {
          const addresses = (data as TrackedCoin[]).filter(c => {
            try { return normalizeChain(c.chain_network) === chain && !!normalizeAddress(chain, c.contract_address); } catch { return false; }
          }).map(c => c.contract_address);
          markets.set(chain, await fetchMarketPairs(chain, addresses));
        }
      } catch { /* Legacy unknown chain or address stays unenriched. */ }
    }
    const enriched = (data as TrackedCoin[]).map((coin) => {
        let dex;
        try { const chain = normalizeChain(coin.chain_network); dex = markets.get(chain)?.get(normalizeAddress(chain, coin.contract_address)); } catch {}

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
          total_holders: null,
          is_primary: coin.is_primary ?? false,
        };
      });

    return NextResponse.json(enriched);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const supabase = getSupabase();
    if (!supabase) return NextResponse.json({ error: 'Supabase belum terkonfigurasi' }, { status: 500 });

    const body = await readBoundedJson(request.body, 16384, 5000) as { contract_address: string; chain_network: string; label?: string };
    const { contract_address, chain_network, label } = body;
    if (!contract_address || !chain_network) return NextResponse.json({ error: 'contract_address dan chain_network wajib diisi' }, { status: 400 });
    let cleanAddress: string;
    let chain: string;
    try { chain = normalizeChain(chain_network); cleanAddress = normalizeAddress(chain, contract_address); }
    catch { return NextResponse.json({ error: 'Alamat atau jaringan tidak valid' }, { status: 400 }); }
    if (await resolveStoredIdentity(supabase, 'tracked_coins', 'contract_address', chain, cleanAddress)) return NextResponse.json({ error: 'Token sudah ditambahkan ke Track Coin' }, { status: 409 });
    const dex = (await fetchMarketPairs(chain, [cleanAddress])).get(cleanAddress);

    const { data, error } = await supabase.from('tracked_coins').insert([{
      contract_address: cleanAddress,
      chain_network: chain,
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
        name: dex.baseToken?.name,
        symbol: dex.baseToken?.symbol,
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

    const { contract_address, chain_network, deleteAll } = await readBoundedJson(request.body, 16384, 5000) as { contract_address: string; chain_network: string; deleteAll?: boolean };
    
    if (deleteAll !== undefined && typeof deleteAll !== 'boolean') return NextResponse.json({ error: 'deleteAll harus boolean' }, { status: 400 });
    if (deleteAll === true) {
      if (typeof chain_network !== 'string') return NextResponse.json({ error: 'Pilih jaringan' }, { status: 400 });
      try { normalizeChain(chain_network); } catch { return NextResponse.json({ error: 'Pilih jaringan yang valid' }, { status: 400 }); }
      const result = await deleteChainIdentities(supabase, 'tracked_coins', 'contract_address', chain_network);
      if (result.error) return NextResponse.json({ error: result.error, deleted: result.deleted }, { status: 409 });
      if (!result.deleted) return NextResponse.json({ error: 'Tidak ada token pada jaringan terpilih' }, { status: 404 });
      return NextResponse.json({ success: true, deleted: result.deleted });
    }
    if (!contract_address || !chain_network) return NextResponse.json({ error: 'Pilih alamat dan jaringan' }, { status: 400 });
    const stored = await resolveStoredIdentity(supabase, 'tracked_coins', 'contract_address', chain_network, contract_address);
    if (!stored) return NextResponse.json({ error: 'Token tidak ditemukan' }, { status: 404 });
    const { data, error } = await supabase.from('tracked_coins').delete().eq('contract_address', stored.address).eq('chain_network', stored.chain).select('contract_address');

    if (error) throw error;
    if (data?.length !== 1) return NextResponse.json({ error: 'Token berubah atau ambigu' }, { status: 409 });
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

    const { contract_address, chain_network, is_primary, label } = await readBoundedJson(request.body, 16384, 5000) as { contract_address: string; chain_network: string; is_primary?: boolean; label?: string };
    if (!contract_address || !chain_network || (is_primary === undefined && typeof label !== 'string')) return NextResponse.json({ error: 'Pilih alamat, jaringan dan perubahan' }, { status: 400 });
    const stored = await resolveStoredIdentity(supabase, 'tracked_coins', 'contract_address', chain_network, contract_address);
    if (!stored) return NextResponse.json({ error: 'Token tidak ditemukan' }, { status: 404 });
    const cleanAddress = stored.address;

    // Enforce max 5 primary coins
    if (is_primary === true) {
      const { data: existing } = await supabase
        .from('tracked_coins')
        .select('contract_address, chain_network')
        .eq('is_primary', true);

      const currentPrimary = (existing || []).filter(
        (c: { contract_address: string; chain_network: string }) => c.contract_address !== cleanAddress || c.chain_network !== stored.chain
      );

      if (currentPrimary.length >= 5) {
        return NextResponse.json({
          error: 'Maksimal 5 coin utama. Lepas pin dari coin lain terlebih dahulu.',
          limitReached: true
        }, { status: 400 });
      }
    }

    const { data, error } = await supabase
      .from('tracked_coins')
      .update({ ...(is_primary !== undefined ? { is_primary: is_primary === true } : {}), ...(typeof label === 'string' ? { label: label.trim() } : {}) })
      .eq('contract_address', cleanAddress)
      .eq('chain_network', stored.chain).select('contract_address');

    if (error) throw error;
    if (data?.length !== 1) return NextResponse.json({ error: 'Token berubah atau ambigu' }, { status: 409 });
    return NextResponse.json({ success: true, is_primary: is_primary === true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
