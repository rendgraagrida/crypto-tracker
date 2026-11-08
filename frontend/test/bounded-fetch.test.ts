import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundedFetch } from '../app/lib/bounded-fetch.ts';

test('bounded transport preserves response bytes, status and provider headers', async () => {
  const original = globalThis.fetch;
  const payload = '{"supply":123456789012345678901}';
  globalThis.fetch = async () => new Response(payload, { status: 201, headers: { 'content-type': 'application/json', 'x-provider': 'example' } });
  try {
    const response = await boundedFetch('https://example.invalid');
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('x-provider'), 'example');
    assert.equal(await response.text(), payload);
  } finally { globalThis.fetch = original; }
});

test('bounded transport rejects oversized streamed provider bodies', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(new Uint8Array(2_000_001));
  try {
    await assert.rejects(boundedFetch('https://example.invalid'), /too large/);
  } finally { globalThis.fetch = original; }
});
