export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

function getSupabase() {
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key);
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
    const { contract_address, label } = await request.json();
    const { data, error } = await supabase.from('whitelist_tokens').insert([{ contract_address: contract_address.toLowerCase().trim(), label: label.trim() }]);
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
    const { contract_address } = await request.json();
    const { error } = await supabase.from('whitelist_tokens').delete().eq('contract_address', contract_address.toLowerCase().trim());
    if (error) throw error;
    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 200 }); 
  }
}