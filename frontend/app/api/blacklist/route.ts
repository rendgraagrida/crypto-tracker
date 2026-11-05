export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

function getSupabase() {
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key);
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
    const body = await request.json();
    const { contract_address, label, chain_network } = body;

    if (!contract_address) {
      return NextResponse.json({ error: 'Contract address wajib diisi' }, { status: 400 });
    }

    const supabase = getSupabase();
    if (!supabase) return NextResponse.json({ error: 'Supabase tidak terkonfigurasi' }, { status: 500 });

    const { error } = await supabase.from('blacklist_tokens').insert([{
      contract_address: contract_address.toString().trim(),
      label: label || null,
      chain_network: chain_network || 'Unknown',
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
    const { contract_address, deleteAll } = await request.json();
    
    const supabase = getSupabase();
    if (!supabase) return NextResponse.json({ error: 'Supabase tidak terkonfigurasi' }, { status: 500 });

    if (deleteAll) {
      const { error } = await supabase.from('blacklist_tokens').delete().neq('contract_address', '');
      if (error) throw error;
      return NextResponse.json({ message: 'Semua token berhasil dihapus dari blacklist' }, { status: 200 });
    }

    if (!contract_address) {
      return NextResponse.json({ error: 'Contract address wajib diisi' }, { status: 400 });
    }
    if (!supabase) return NextResponse.json({ error: 'Supabase tidak terkonfigurasi' }, { status: 500 });

    const { error } = await supabase
      .from('blacklist_tokens')
      .delete()
      .eq('contract_address', contract_address.toString().trim());

    if (error) throw error;
    return NextResponse.json({ message: 'Token berhasil dihapus dari blacklist' }, { status: 200 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
