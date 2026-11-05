import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateSMA,
  groupTransactionsByDay,
  type TransactionRecord,
} from '../app/lib/utils.ts';

describe('Indicators & History Aggregation', () => {
  describe('calculateSMA', () => {
    test('should calculate 3-period SMA correctly', () => {
      const prices = [10, 20, 30, 40, 50];
      const sma = calculateSMA(prices, 3);
      // Expected SMA values:
      // (10+20+30)/3 = 20
      // (20+30+40)/3 = 30
      // (30+40+50)/3 = 40
      assert.equal(sma.length, 3);
      assert.equal(sma[0], 20);
      assert.equal(sma[1], 30);
      assert.equal(sma[2], 40);
    });

    test('should return empty array if prices length < period', () => {
      const prices = [10, 20];
      const sma = calculateSMA(prices, 5);
      assert.deepEqual(sma, []);
    });
  });

  describe('groupTransactionsByDay (Daily Summary Aggregator)', () => {
    test('should aggregate multiple transactions on the same day into 1 summary', () => {
      const sampleTxs: TransactionRecord[] = [
        {
          timestamp: '2026-08-25T10:00:00Z',
          type: 'BUY',
          amount: 100,
          valueUsd: 250,
          symbol: 'TOKEN_A',
        },
        {
          timestamp: '2026-08-25T14:30:00Z',
          type: 'SELL',
          amount: 40,
          valueUsd: 110,
          symbol: 'TOKEN_A',
        },
        {
          timestamp: '2026-08-26T08:00:00Z',
          type: 'BUY',
          amount: 200,
          valueUsd: 500,
          symbol: 'TOKEN_A',
        },
      ];

      const summaries = groupTransactionsByDay(sampleTxs);

      // Should produce 2 days (sorted descending)
      assert.equal(summaries.length, 2);
      assert.equal(summaries[0].date, '2026-08-26');
      assert.equal(summaries[0].totalTransactions, 1);
      assert.equal(summaries[0].totalVolumeUsd, 500);
      assert.equal(summaries[0].netAmount, 200);

      assert.equal(summaries[1].date, '2026-08-25');
      assert.equal(summaries[1].totalTransactions, 2);
      assert.equal(summaries[1].totalVolumeUsd, 360); // 250 + 110
      assert.equal(summaries[1].netAmount, 60); // 100 - 40
      assert.equal(summaries[1].types['BUY'], 1);
      assert.equal(summaries[1].types['SELL'], 1);
    });

    test('should return empty array for empty inputs', () => {
      assert.deepEqual(groupTransactionsByDay([]), []);
    });
  });
});
