import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  lamportsToSol,
  chunkArray,
  getNetworkSlug,
} from '../app/lib/utils.ts';

describe('Blockchain & Batch Processing Helpers', () => {
  describe('lamportsToSol', () => {
    test('should convert lamports to SOL float correctly', () => {
      assert.equal(lamportsToSol(1_000_000_000), 1.0);
      assert.equal(lamportsToSol(500_000_000), 0.5);
      assert.equal(lamportsToSol(8_000_000), 0.008);
      assert.equal(lamportsToSol(BigInt(2_500_000_000)), 2.5);
    });

    test('should return 0 for zero, negative, or invalid input', () => {
      assert.equal(lamportsToSol(0), 0);
      assert.equal(lamportsToSol(-100), 0);
    });
  });

  describe('chunkArray (DexScreener batching)', () => {
    test('should split an array of 65 tokens into chunks of 30 (30, 30, 5)', () => {
      const tokens = Array.from({ length: 65 }, (_, i) => `token_${i + 1}`);
      const chunks = chunkArray(tokens, 30);

      assert.equal(chunks.length, 3);
      assert.equal(chunks[0].length, 30);
      assert.equal(chunks[1].length, 30);
      assert.equal(chunks[2].length, 5);
      assert.equal(chunks[0][0], 'token_1');
      assert.equal(chunks[2][4], 'token_65');
    });

    test('should handle arrays smaller than the chunk size', () => {
      const tokens = ['token_a', 'token_b'];
      const chunks = chunkArray(tokens, 30);

      assert.equal(chunks.length, 1);
      assert.equal(chunks[0].length, 2);
    });

    test('should return empty array for empty inputs', () => {
      assert.deepEqual(chunkArray([], 30), []);
    });
  });

  describe('getNetworkSlug', () => {
    test('should return correct GeckoTerminal slug', () => {
      assert.equal(getNetworkSlug('Ethereum'), 'eth');
      assert.equal(getNetworkSlug('BSC'), 'bsc');
      assert.equal(getNetworkSlug('Base Chain'), 'base');
      assert.equal(getNetworkSlug('Robinhood'), 'robinhood');
      assert.equal(getNetworkSlug('Solana'), 'solana');
      assert.equal(getNetworkSlug('Arbitrum'), 'arbitrum');
      assert.equal(getNetworkSlug('Polygon'), 'polygon_pos');
    });

    test('should fallback to eth for unknown chains', () => {
      assert.equal(getNetworkSlug('UnknownChain'), 'eth');
      assert.equal(getNetworkSlug(''), 'eth');
    });
  });
});
