export const dynamic = 'force-dynamic';
import { normalizeAddress, normalizeChain } from '../../lib/auth.ts';
import { deleteChainIdentities, resolveStoredIdentity } from '../../lib/identity.ts';
import { readBoundedJson } from '../../lib/bounded-json.ts';
import { boundedFetch } from '../../lib/bounded-fetch.ts';
const NextResponse = Response;
import { createClient } from '@supabase/supabase-js';

function getSupabase() {
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key, { global: { fetch: boundedFetch } });
}

// GET — Ambil seluruh daftar blacklist
export async function GET() {
  try {
    const supabase = getSupabase();
    if (!supabase) return NextResponse.json({ error: 'Supabase tidak terkonfigurasi' }, { status: 500 });

    const { data, error } = await supabase
      .from('blacklist_tokens')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return NextResponse.json(data || [], { status: 200 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// POST — Tambahkan token baru ke blacklist
export async function POST(request: Request) {
  try {
    const body = await readBoundedJson(request.body, 16384, 5000) as { contract_address: string; chain_network: string; label?: string };
    const { contract_address, label, chain_network } = body;

    if (!contract_address || !chain_network) {
      return NextResponse.json({ error: 'Contract address dan jaringan wajib diisi' }, { status: 400 });
    }
    let address: string;
    try { address = normalizeAddress(normalizeChain(chain_network), contract_address); } catch { return NextResponse.json({ error: 'Alamat atau jaringan tidak valid' }, { status: 400 }); }

    const supabase = getSupabase();
    if (!supabase) return NextResponse.json({ error: 'Supabase tidak terkonfigurasi' }, { status: 500 });
    if (await resolveStoredIdentity(supabase, 'blacklist_tokens', 'contract_address', chain_network, address)) return NextResponse.json({ error: 'Token sudah ada di blacklist' }, { status: 409 });

    const { error } = await supabase.from('blacklist_tokens').insert([{
      contract_address: address,
      label: label || null,
      chain_network: normalizeChain(chain_network),
    }]);

    if (error) {
      if (error.code === '23505') {
        return NextResponse.json({ error: 'Token sudah ada di blacklist' }, { status: 409 });
      }
      throw error;
    }

    return NextResponse.json({ message: 'Token berhasil ditambahkan ke blacklist' }, { status: 201 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// DELETE — Hapus token dari blacklist
export async function DELETE(request: Request) {
  try {
    const { contract_address, chain_network, deleteAll } = await readBoundedJson(request.body, 16384, 5000) as { contract_address: string; chain_network: string; deleteAll?: boolean };
    
    const supabase = getSupabase();
    if (!supabase) return NextResponse.json({ error: 'Supabase tidak terkonfigurasi' }, { status: 500 });

    if (deleteAll !== undefined && typeof deleteAll !== 'boolean') return NextResponse.json({ error: 'deleteAll harus boolean' }, { status: 400 });
    if (deleteAll === true) {
      if (typeof chain_network !== 'string') return NextResponse.json({ error: 'Pilih jaringan' }, { status: 400 });
      try { normalizeChain(chain_network); } catch { return NextResponse.json({ error: 'Pilih jaringan yang valid' }, { status: 400 }); }
      const result = await deleteChainIdentities(supabase, 'blacklist_tokens', 'contract_address', chain_network);
      if (result.error) return NextResponse.json({ error: result.error, deleted: result.deleted }, { status: 409 });
      if (!result.deleted) return NextResponse.json({ error: 'Tidak ada token pada jaringan terpilih' }, { status: 404 });
      return NextResponse.json({ message: 'Token pada jaringan terpilih berhasil dihapus dari blacklist', deleted: result.deleted }, { status: 200 });
    }

    if (!contract_address || !chain_network) {
      return NextResponse.json({ error: 'Pilih alamat dan jaringan' }, { status: 400 });
    }
    const stored = await resolveStoredIdentity(supabase, 'blacklist_tokens', 'contract_address', chain_network, contract_address);
    if (!stored) return NextResponse.json({ error: 'Token tidak ditemukan' }, { status: 404 });
    const { data, error } = await supabase.from('blacklist_tokens').delete().eq('contract_address', stored.address).eq('chain_network', stored.chain).select('contract_address');

    if (error) throw error;
    if (data?.length !== 1) return NextResponse.json({ error: 'Token berubah atau ambigu' }, { status: 409 });
    return NextResponse.json({ message: 'Token berhasil dihapus dari blacklist' }, { status: 200 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
