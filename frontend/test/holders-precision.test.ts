import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GET } from '../app/api/holders/route.ts';

test('EVM holder balances and shares use token decimals without rounding raw integer units', async () => {
  const original = globalThis.fetch;
  const oldKey = process.env.COVALENT_API_KEY;
  process.env.COVALENT_API_KEY = 'test-key';
  globalThis.fetch = async () => Response.json({ data: { items: [{ address: '0x0000000000000000000000000000000000000001', contract_decimals: 18, balance: '1000000000000000000', total_supply: '100000000000000000000' }] } });
  try {
    const response = await GET(new Request('http://localhost/api/holders?chain_network=ethereum&contract_address=0x0000000000000000000000000000000000000002&price_usd=2'));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.holders[0].balance, 1);
    assert.equal(result.holders[0].share, 1);
    assert.equal(result.holders[0].value_usd, 2);
  } finally {
    globalThis.fetch = original;
    if (oldKey === undefined) delete process.env.COVALENT_API_KEY; else process.env.COVALENT_API_KEY = oldKey;
  }
});
