export const dynamic = 'force-dynamic';
import { normalizeAddress, normalizeChain } from '../../lib/auth.ts';
import { resolveStoredIdentity } from '../../lib/identity.ts';
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

export async function GET() {
  const supabase = getSupabase();
  if (!supabase) return NextResponse.json([]);
  const { data, error } = await supabase.from('whitelist_tokens').select('*');
  if (error) return NextResponse.json([]); 
  return NextResponse.json(data || []);
}

export async function POST(request: Request) {
  try {
    const supabase = getSupabase();
    if (!supabase) return NextResponse.json({ error: "Supabase belum terkonfigurasi" }, { status: 500 });
    const { contract_address, chain_network, label } = await readBoundedJson(request.body, 16384, 5000) as { contract_address: string; chain_network: string; label?: string };
    if (!contract_address || !chain_network) return NextResponse.json({ error: 'Pilih alamat dan jaringan' }, { status: 400 });
    let address: string;
    try { address = normalizeAddress(normalizeChain(chain_network), contract_address); } catch { return NextResponse.json({ error: 'Alamat atau jaringan tidak valid' }, { status: 400 }); }
    if (await resolveStoredIdentity(supabase, 'whitelist_tokens', 'contract_address', chain_network, address)) return NextResponse.json({ error: 'Token sudah ada di whitelist' }, { status: 409 });
    const { data, error } = await supabase.from('whitelist_tokens').insert([{ contract_address: address, chain_network: normalizeChain(chain_network), label: typeof label === 'string' ? label.trim() : '' }]);
    if (error) throw error;
    return NextResponse.json({ success: true, data });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 200 }); 
  }
}

export async function DELETE(request: Request) {
  try {
    const supabase = getSupabase();
    if (!supabase) return NextResponse.json({ error: "Supabase belum terkonfigurasi" }, { status: 500 });
    const { contract_address, chain_network } = await readBoundedJson(request.body, 16384, 5000) as { contract_address: string; chain_network: string };
    if (!contract_address || !chain_network) return NextResponse.json({ error: 'Pilih alamat dan jaringan' }, { status: 400 });
    const stored = await resolveStoredIdentity(supabase, 'whitelist_tokens', 'contract_address', chain_network, contract_address);
    if (!stored) return NextResponse.json({ error: 'Token tidak ditemukan' }, { status: 404 });
    const { data, error } = await supabase.from('whitelist_tokens').delete().eq('contract_address', stored.address).eq('chain_network', stored.chain).select('contract_address');
    if (error) throw error;
    if (data?.length !== 1) return NextResponse.json({ error: 'Token berubah atau ambigu' }, { status: 409 });
    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 200 }); 
  }
}