import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchMarketPairs, fetchNativeCoinPrice } from '../app/lib/market-data.ts';
import { fetchWalletBalancesLive } from '../app/lib/balances.ts';

const mint = 'So11111111111111111111111111111111111111112';
const other = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

test('market batching deduplicates concurrent requests and never prices a quote token as base', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json([
      { chainId: 'solana', baseToken: { address: other }, quoteToken: { address: mint }, priceUsd: '1000', liquidity: { usd: 10000 } },
      { chainId: 'solana', baseToken: { address: mint }, priceUsd: '2', liquidity: { usd: 20 } },
      { chainId: 'solana', baseToken: { address: mint }, priceUsd: '3', liquidity: { usd: 30 } },
    ]);
  };
  try {
    const [a, b] = await Promise.all([fetchMarketPairs('solana', [mint]), fetchMarketPairs('solana', [mint])]);
    assert.equal(a.get(mint)?.priceUsd, '3');
    assert.equal(b.get(mint)?.priceUsd, '3');
    assert.equal(calls, 1);
    assert.equal((await fetchMarketPairs('solana', [mint])).get(mint)?.priceUsd, '3');
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test('wallet RPC batch matches response IDs and preserves unavailable balances', async () => {
  const original = globalThis.fetch;
  const oldUrl = process.env.ALCHEMY_ETH_URL;
  process.env.ALCHEMY_ETH_URL = 'http://127.0.0.1:1';
  globalThis.fetch = async (_url, init) => {
    const batch = JSON.parse(String(init?.body));
    assert.equal(batch.length, 2);
    return Response.json([{ id: 1, error: { code: -1 } }, { id: 0, result: '0xde0b6b3a7640000' }]);
  };
  try {
    const wallets = await fetchWalletBalancesLive([
      { chain_network: 'ethereum', wallet_address: '0x0000000000000000000000000000000000000001' },
      { chain_network: 'ethereum', wallet_address: '0x0000000000000000000000000000000000000002' },
    ]);
    assert.equal(wallets[0].nativeBalance, 1);
    assert.equal(wallets[1].nativeBalance, null);
    assert.equal(wallets[1].balanceDisplay, 'N/A');
  } finally {
    globalThis.fetch = original;
    if (oldUrl === undefined) delete process.env.ALCHEMY_ETH_URL; else process.env.ALCHEMY_ETH_URL = oldUrl;
  }
});

test('native coin price lookup deduplicates concurrent calls and caches valid USD prices', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ solana: { usd: 185.5 } });
  };
  try {
    const [p1, p2] = await Promise.all([fetchNativeCoinPrice('solana'), fetchNativeCoinPrice('solana')]);
    assert.equal(p1, 185.5);
    assert.equal(p2, 185.5);
    assert.equal(calls, 1);
    assert.equal(await fetchNativeCoinPrice('solana'), 185.5);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});
