import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatCurrency,
  formatTokenPrice,
  formatCountdown,
  truncateAddress,
  getExplorerUrl,
  formatCompactNumber,
  formatCompactUSD
} from '../app/lib/utils.ts';

describe('Formatters & UI Utility Helpers', () => {
  describe('formatCompactNumber & formatCompactUSD', () => {
    test('should translate overflow values like 2942.3K into 2.9M', () => {
      assert.equal(formatCompactNumber('2942.3K'), '2.9M');
      assert.equal(formatCompactUSD('2942.3K'), '$2.9M');
      assert.equal(formatCompactUSD(2942300), '$2.9M');
    });

    test('should format numbers with K, M, B, T properly', () => {
      assert.equal(formatCompactNumber(1500), '1.5K');
      assert.equal(formatCompactUSD(1500), '$1.5K');
      assert.equal(formatCompactUSD(1500000), '$1.5M');
      assert.equal(formatCompactUSD(2500000000), '$2.5B');
      assert.equal(formatCompactUSD(1000000000000), '$1T');
    });

    test('should round integers cleanly or ceil when required', () => {
      assert.equal(formatCompactNumber(45.2, { roundCeil: true }), '46');
      assert.equal(formatCompactUSD(45.2), '$46');
      assert.equal(formatCompactUSD(0), '-');
      assert.equal(formatCompactUSD(null), '-');
    });
  });

  describe('formatCurrency', () => {
    test('should format positive numbers to standard USD format', () => {
      assert.equal(formatCurrency(1234.56), '$1,234.56');
      assert.equal(formatCurrency(1000000), '$1,000,000.00');
    });

    test('should handle 0, null, undefined, and NaN gracefully', () => {
      assert.equal(formatCurrency(0), '$0.00');
      assert.equal(formatCurrency(null), '$0.00');
      assert.equal(formatCurrency(undefined), '$0.00');
      assert.equal(formatCurrency(NaN), '$0.00');
    });

    test('should format fractional cent amounts accurately', () => {
      assert.equal(formatCurrency(0.004), '$0.00');
      assert.equal(formatCurrency(0.999), '$1.00');
    });
  });

  describe('formatTokenPrice', () => {
    test('should format standard prices using formatCurrency', () => {
      assert.equal(formatTokenPrice(150.5), '@ $150.50');
    });

    test('should format micro-cap tokens with up to 6 decimal precision', () => {
      assert.equal(formatTokenPrice(0.000123), '@ $0.000123');
      assert.equal(formatTokenPrice(0.0045), '@ $0.0045');
    });

    test('should return "Unknown Price" for invalid or zero prices', () => {
      assert.equal(formatTokenPrice(0), 'Unknown Price');
      assert.equal(formatTokenPrice(-5), 'Unknown Price');
      assert.equal(formatTokenPrice(null), 'Unknown Price');
    });
  });

  describe('formatCountdown', () => {
    test('should format seconds properly', () => {
      assert.equal(formatCountdown(0), '0s');
      assert.equal(formatCountdown(45), '45s');
    });

    test('should format minutes and seconds', () => {
      assert.equal(formatCountdown(60), '1m');
      assert.equal(formatCountdown(150), '2m 30s');
    });

    test('should format hours and minutes', () => {
      assert.equal(formatCountdown(3600), '1h');
      assert.equal(formatCountdown(7320), '2h 2m');
    });
  });

  describe('truncateAddress', () => {
    test('should truncate long addresses correctly', () => {
      const ethAddr = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
      assert.equal(truncateAddress(ethAddr, 6, 4), '0xd8dA...6045');
    });

    test('should return full address if length is smaller than start+end', () => {
      assert.equal(truncateAddress('0x1234', 6, 4), '0x1234');
      assert.equal(truncateAddress('', 6, 4), '');
    });
  });

  describe('getExplorerUrl', () => {
    test('should return appropriate explorer URL per chain', () => {
      const addr = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
      assert.equal(getExplorerUrl('Ethereum', '', addr), `https://etherscan.io/address/${addr}`);
      assert.equal(getExplorerUrl('BSC', '', addr), `https://bscscan.com/address/${addr}`);
      assert.equal(getExplorerUrl('Base Chain', '', addr), `https://basescan.org/address/${addr}`);
      assert.equal(getExplorerUrl('Robinhood', '', addr), `https://explorer.robinhood.com/address/${addr}`);

      const solAddr = 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH';
      assert.equal(getExplorerUrl('Solana', '', solAddr), `https://solscan.io/account/${solAddr}`);
    });
  });
});
