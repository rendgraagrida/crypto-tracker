import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';

describe('🚀 Integration Testing: API Routes, Database & Blockchain', () => {

  describe('1. Watchlist API Endpoints (/api/watchlist)', () => {
    const testWallet = '0x1111111111111111111111111111111111111111';
    const testNetwork = 'Ethereum';
    const testLabel = 'Test_Integration_Wallet';

    test('GET /api/watchlist - should return HTTP 200 and list of targets', async () => {
      const res = await fetch(`${BASE_URL}/api/watchlist`);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.ok(Array.isArray(json), 'Expected response to be an array');
    });

    test('POST /api/watchlist - should add a new target wallet to Supabase', async () => {
      const res = await fetch(`${BASE_URL}/api/watchlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet_address: testWallet,
          chain_network: testNetwork,
          label: testLabel,
        }),
      });

      // Status 200 (created) or 400 (already exists from previous run)
      assert.ok([200, 400].includes(res.status), `Unexpected status: ${res.status}`);
      const json = await res.json();
      if (res.status === 200) {
        assert.equal(json.success, true);
      }
    });

    test('DELETE /api/watchlist - should delete a target wallet', async () => {
      const res = await fetch(`${BASE_URL}/api/watchlist`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet_address: testWallet,
          chain_network: testNetwork,
        }),
      });

      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.success, true);
    });
  });

  describe('2. Tracked Coins API (/api/track)', () => {
    const testContract = '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984'; // UNI Token
    const testChain = 'Ethereum';
    const testLabel = 'Uniswap_Integration_Test';

    test('GET /api/track - should return HTTP 200 and tracked coins with market metrics', async () => {
      const res = await fetch(`${BASE_URL}/api/track`);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.ok(Array.isArray(json), 'Expected response to be an array');
    });

    test('POST /api/track - should register a new token contract', async () => {
      const res = await fetch(`${BASE_URL}/api/track`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contract_address: testContract,
          chain_network: testChain,
          label: testLabel,
        }),
      });

      assert.ok([200, 400].includes(res.status));
    });

    test('DELETE /api/track - should remove the test token', async () => {
      const res = await fetch(`${BASE_URL}/api/track`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contract_address: testContract,
        }),
      });

      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.success, true);
    });
  });

  describe('3. Blacklist Tokens API (/api/blacklist)', () => {
    const testSpamContract = '0x9999999999999999999999999999999999999999';
    const testSpamLabel = 'Test_Spam_Token';

    test('GET /api/blacklist - should return blacklisted tokens', async () => {
      const res = await fetch(`${BASE_URL}/api/blacklist`);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.ok(Array.isArray(json));
    });

    test('POST /api/blacklist - should add token to blacklist', async () => {
      const res = await fetch(`${BASE_URL}/api/blacklist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contract_address: testSpamContract,
          label: testSpamLabel,
        }),
      });

      assert.ok([200, 201, 400].includes(res.status));
    });

    test('DELETE /api/blacklist - should remove token from blacklist', async () => {
      const res = await fetch(`${BASE_URL}/api/blacklist`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contract_address: testSpamContract,
        }),
      });

      assert.equal(res.status, 200);
    });
  });

  describe('4. Solana RPC & DexScreener Integration (/api/solana)', () => {
    test('POST /api/solana - should fetch SOL balance, token balances, and DexScreener pricing', async () => {
      const solAddress = 'E1Sy8xWybtMuvCxB3YyywUvVk58xNcY7fvyrEQmhAfUi';
      const res = await fetch(`${BASE_URL}/api/solana`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet_address: solAddress,
          page: 1,
        }),
      });

      assert.equal(res.status, 200);
      const json = await res.json();

      assert.ok(Array.isArray(json.tokens), 'Tokens should be an array');
      assert.ok(json.tokens.length > 0, 'Tokens list should not be empty');
      const hasSol = json.tokens.some((t: any) => t.symbol === 'SOL');
      assert.ok(hasSol, 'Expected SOL native token to be present in tokens list');
    });
  });

  describe('5. EVM Multi-Chain Tokens API (/api/tokens)', () => {
    test('POST /api/tokens - should query Ethereum token balances via Alchemy', async () => {
      const vitalikEth = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
      const res = await fetch(`${BASE_URL}/api/tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet_address: vitalikEth,
          chain_network: 'Ethereum',
          page: 1,
        }),
      });

      assert.equal(res.status, 200);
      const json = await res.json();
      assert.ok(Array.isArray(json.tokens), 'Expected tokens array');
      assert.ok(json.tokens.length > 0, 'Expected at least one token returned');
      const hasEth = json.tokens.some((t: any) => t.symbol === 'ETH');
      assert.ok(hasEth, 'Expected ETH native token to be present in tokens list');
    });
  });

  describe('6. Technical Indicators API (/api/indicators)', () => {
    test('GET /api/indicators - should calculate RSI & MACD from GeckoTerminal OHLCV', async () => {
      const uniToken = '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984';
      const res = await fetch(`${BASE_URL}/api/indicators?contract_address=${uniToken}&chain_network=ethereum`);

      assert.equal(res.status, 200);
      const json = await res.json();

      assert.ok('rsi' in json);
      assert.ok('macd' in json);
    });
  });

  describe('7. Transaction History API (/api/history)', () => {
    test('GET /api/history - should return transfer history for a wallet and token', async () => {
      const vitalikEth = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
      const usdcEth = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
      const res = await fetch(
        `${BASE_URL}/api/history?wallet_address=${vitalikEth}&contract_address=${usdcEth}&chain_network=ethereum`
      );

      assert.equal(res.status, 200);
      const json = await res.json();
      assert.ok(Array.isArray(json.history), 'Expected history array');
    });
  });

});
