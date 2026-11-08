const NextResponse = Response;
import { createClient } from '@supabase/supabase-js';
import { readBoundedJson } from '../../lib/bounded-json.ts';
import { boundedFetch } from '../../lib/bounded-fetch.ts';

export const dynamic = 'force-dynamic';

function getSupabase() {
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key, { global: { fetch: boundedFetch } });
}

export async function GET() {
  const supabase = getSupabase();
  if (!supabase) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

  try {
    const { data, error } = await supabase.from('app_settings').select('*');
    if (error) throw error;
    
    const settings = data.reduce((acc, row) => {
      acc[row.key] = row.value;
      return acc;
    }, {} as Record<string, string>);

    return NextResponse.json(settings);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const supabase = getSupabase();
  if (!supabase) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

  try {
    const body: unknown = await readBoundedJson(request.body, 16384, 5000);
    if (!body || typeof body !== 'object' || !('key' in body) || !('value' in body)) return NextResponse.json({ error: 'Invalid settings' }, { status: 400 });
    const { key, value } = body;
    if (key !== 'ENABLE_COIN_SCANNER' || (value !== 'true' && value !== 'false')) {
      return NextResponse.json({ error: 'Only ENABLE_COIN_SCANNER true|false is mutable here; trading policy belongs to isolated signer configuration' }, { status: 400 });
    }

    const { error } = await supabase
      .from('app_settings')
      .upsert({ key, value, updated_at: new Date().toISOString() });
      
    if (error) throw error;

    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
