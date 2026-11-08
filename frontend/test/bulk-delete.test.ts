import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DELETE as deleteTracked } from '../app/api/track/route.ts';
import { DELETE as deleteWallet } from '../app/api/watchlist/route.ts';
import { DELETE as deleteBlacklist } from '../app/api/blacklist/route.ts';

test('non-boolean deleteAll never reaches a database delete', async () => {
  const oldUrl = process.env.SUPABASE_URL, oldKey = process.env.SUPABASE_KEY;
  const original = globalThis.fetch;
  process.env.SUPABASE_URL = 'https://example.invalid';
  process.env.SUPABASE_KEY = 'test-key';
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json([]); };
  try {
    for (const handler of [deleteTracked, deleteWallet, deleteBlacklist]) {
      for (const flag of ['false', 1, null]) {
        const request = new Request('http://localhost/api/test', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chain_network: 'solana', deleteAll: flag }) });
        const response = await handler(request);
        assert.equal(response.status, 400);
      }
    }
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
    if (oldUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = oldUrl;
    if (oldKey === undefined) delete process.env.SUPABASE_KEY; else process.env.SUPABASE_KEY = oldKey;
  }
});
