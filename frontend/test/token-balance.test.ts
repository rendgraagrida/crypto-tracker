import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTokenBalance } from '../app/lib/token-balance.ts';

test('small positive ERC-20 units remain positive without display rounding', () => {
  const result = formatTokenBalance('0x1', 18);
  assert.equal(result.balance, '0.000000000000000001');
  assert.equal(result.numericBalance, 1e-18);
  assert.ok(result.numericBalance! * 2 > 0);
});

test('missing and invalid decimals do not invent a balance', () => {
  assert.deepEqual(formatTokenBalance('0x1', null), { balance: null, numericBalance: null });
  assert.deepEqual(formatTokenBalance('0x1', '18junk'), { balance: null, numericBalance: null });
  assert.deepEqual(formatTokenBalance('0x1', 0), { balance: '1', numericBalance: 1 });
});
