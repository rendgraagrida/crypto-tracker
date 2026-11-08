export const dynamic = 'force-dynamic';

import { fetchWalletBalancesLive } from '../../lib/balances.ts';
import { normalizeAddress, normalizeChain } from '../../lib/auth.ts';
import { deleteChainIdentities, resolveStoredIdentity } from '../../lib/identity.ts';
import { readBoundedJson } from '../../lib/bounded-json.ts';
import { boundedFetch } from '../../lib/bounded-fetch.ts';
const NextResponse = Response;
import { createClient } from '@supabase/supabase-js';


// Lazy initialization Supabase agar aman dari crash saat Docker build time
function getSupabase() {
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key, { global: { fetch: boundedFetch } });
}


export async function GET() {
  try {
    const supabase = getSupabase();
    if (!supabase) return NextResponse.json([], { status: 200 });

    const { data, error } = await supabase.from('watchlist').select('*').order('created_at', { ascending: false });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    
    const walletsWithLiveBalance = await fetchWalletBalancesLive(data || []);

    return NextResponse.json(walletsWithLiveBalance);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const supabase = getSupabase();
    if (!supabase) {
      return NextResponse.json({ error: "Database belum terkonfigurasi" }, { status: 500 });
    }

    const { wallet_address, chain_network, label } = await readBoundedJson(request.body, 16384, 5000) as { wallet_address: string; chain_network: string; label?: string };
    if (!wallet_address || !chain_network) {
      return NextResponse.json({ error: "Data dompet tidak lengkap" }, { status: 400 });
    }

    let networksToInsert: string[];
    let safeAddress: string;
    try {
      networksToInsert = /^EVM\s*\(/i.test(chain_network) ? ['ethereum', 'bsc', 'base'] : [normalizeChain(chain_network)];
      safeAddress = normalizeAddress(networksToInsert[0], wallet_address);
    } catch { return NextResponse.json({ error: 'Alamat atau jaringan tidak valid' }, { status: 400 }); }
    for (const chain of networksToInsert) {
      if (await resolveStoredIdentity(supabase, 'watchlist', 'wallet_address', chain, safeAddress)) return NextResponse.json({ error: 'Target ini sudah ada di dalam Watchlist!' }, { status: 409 });
    }
    const insertData = networksToInsert.map(network => ({ wallet_address: safeAddress, chain_network: network, label: label || 'Unknown Target' }));

    const { data, error } = await supabase.from('watchlist').insert(insertData);

    if (error) {
      if (error.code === '23505') {
        return NextResponse.json({ error: "Target ini sudah ada di dalam Watchlist!" }, { status: 400 });
      }
      throw error;
    }

    return NextResponse.json({ success: true, data });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const supabase = getSupabase();
    if (!supabase) {
      return NextResponse.json({ error: "Database belum terkonfigurasi" }, { status: 500 });
    }

    const { wallet_address, chain_network, deleteAll } = await readBoundedJson(request.body, 16384, 5000) as { wallet_address: string; chain_network: string; deleteAll?: boolean };
    
    if (deleteAll !== undefined && typeof deleteAll !== 'boolean') return NextResponse.json({ error: 'deleteAll harus boolean' }, { status: 400 });
    if (deleteAll === true) {
      if (typeof chain_network !== 'string') return NextResponse.json({ error: 'Pilih jaringan' }, { status: 400 });
      try { normalizeChain(chain_network); } catch { return NextResponse.json({ error: 'Pilih jaringan yang valid' }, { status: 400 }); }
      const result = await deleteChainIdentities(supabase, 'watchlist', 'wallet_address', chain_network);
      if (result.error) return NextResponse.json({ error: result.error, deleted: result.deleted }, { status: 409 });
      if (!result.deleted) return NextResponse.json({ error: 'Tidak ada wallet pada jaringan terpilih' }, { status: 404 });
      return NextResponse.json({ success: true, deleted: result.deleted });
    }

    if (!wallet_address || !chain_network) return NextResponse.json({ error: 'Pilih alamat dan jaringan' }, { status: 400 });
    const stored = await resolveStoredIdentity(supabase, 'watchlist', 'wallet_address', chain_network, wallet_address);
    if (!stored) return NextResponse.json({ error: 'Wallet tidak ditemukan' }, { status: 404 });
    const { data, error } = await supabase.from('watchlist').delete().eq('wallet_address', stored.address).eq('chain_network', stored.chain).select('wallet_address');

    if (error) throw error;
    if (data?.length !== 1) return NextResponse.json({ error: 'Wallet berubah atau ambigu' }, { status: 409 });
    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const supabase = getSupabase();
    if (!supabase) {
      return NextResponse.json({ error: "Database belum terkonfigurasi" }, { status: 500 });
    }

    const body = await readBoundedJson(request.body, 16384, 5000) as { wallet_address: string; chain_network: string; label?: string; is_primary?: boolean };
    const { wallet_address, chain_network, label, is_primary } = body;
    if (!wallet_address || !chain_network) {
      return NextResponse.json({ error: "Data dompet tidak lengkap" }, { status: 400 });
    }

    const stored = await resolveStoredIdentity(supabase, 'watchlist', 'wallet_address', chain_network, wallet_address);
    if (!stored) return NextResponse.json({ error: 'Wallet tidak ditemukan' }, { status: 404 });
    const safeAddress = stored.address;

    // Handle is_primary toggle separately
    if (is_primary !== undefined) {
      // Enforce max 5 primary wallets
      if (is_primary === true) {
        const { data: existing } = await supabase
          .from('watchlist')
          .select('wallet_address, chain_network')
          .eq('is_primary', true);

        const currentPrimary = (existing || []).filter(
          (w: { wallet_address: string; chain_network: string }) => w.wallet_address !== safeAddress || w.chain_network !== stored.chain
        );

        if (currentPrimary.length >= 5) {
          return NextResponse.json({
            error: 'Maksimal 5 wallet utama. Lepas pin dari wallet lain terlebih dahulu.',
            limitReached: true
          }, { status: 400 });
        }
      }

      // Pin only the selected chain and address.
      const { data, error } = await supabase
        .from('watchlist')
        .update({ is_primary: is_primary === true })
        .eq('wallet_address', safeAddress)
        .eq('chain_network', stored.chain).select('wallet_address');

      if (error) throw error;
      if (data?.length !== 1) return NextResponse.json({ error: 'Wallet berubah atau ambigu' }, { status: 409 });
      return NextResponse.json({ success: true, is_primary: is_primary === true });
    }

    // Handle label update
    const newLabel = (label || "Unknown Target").trim();
    const { data, error } = await supabase
      .from('watchlist')
      .update({ label: newLabel })
      .match({ 
        wallet_address: safeAddress, 
        chain_network: stored.chain
      }).select('wallet_address');

    if (error) throw error;
    if (data?.length !== 1) return NextResponse.json({ error: 'Wallet berubah atau ambigu' }, { status: 409 });
    return NextResponse.json({ success: true, data });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}