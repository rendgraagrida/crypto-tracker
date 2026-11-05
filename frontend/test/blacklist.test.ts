import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isTokenSpam } from '../app/lib/utils.ts';

describe('Security & Blacklist Spam Detection', () => {
  const sampleBlacklist = [
    '0x000000000000000000000000000000000000dead',
    '0xSpamTokenContract1234567890abcdef12345678',
    'So11111111111111111111111111111111111111112' // example mint
  ];

  test('should detect blacklisted token address regardless of casing', () => {
    const isSpam = isTokenSpam(
      '0xspamtokencontract1234567890abcdef12345678',
      sampleBlacklist
    );
    assert.equal(isSpam, true);
  });

  test('should allow legitimate tokens not in the blacklist', () => {
    const isSpam = isTokenSpam(
      '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
      sampleBlacklist
    );
    assert.equal(isSpam, false);
  });

  test('should never mark native coin (SOL/ETH/BNB) as spam', () => {
    const isSpam = isTokenSpam(
      '0x000000000000000000000000000000000000dead',
      sampleBlacklist,
      true // isNative = true
    );
    assert.equal(isSpam, false);
  });

  test('should treat empty or undefined token address as spam', () => {
    assert.equal(isTokenSpam('', sampleBlacklist), true);
  });

  test('should quarantine token with unknown price or 0 total value as spam', () => {
    const isSpamUnknown = isTokenSpam(
      '0x1111111111111111111111111111111111111111',
      sampleBlacklist,
      false,
      0, // price = 0 (Unknown)
      0  // totalValue = 0
    );
    assert.equal(isSpamUnknown, true);
  });

  test('should allow non-blacklisted token with valid positive price and value', () => {
    const isSpam = isTokenSpam(
      '0x2222222222222222222222222222222222222222',
      sampleBlacklist,
      false,
      1.50, // price > 0
      150.0 // totalValue > 0
    );
    assert.equal(isSpam, false);
  });
});
