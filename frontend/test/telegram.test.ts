import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatWhaleAlert,
  formatRsiAlert,
  formatVolumeAlert,
  formatSummaryMessage,
  sendTelegramMessage
} from '../app/lib/telegram.ts';

describe('Telegram Bot & Real-Time Alert Engine', () => {
  describe('formatWhaleAlert', () => {
    test('should format incoming whale transfer alert with explorer link', () => {
      const alert = formatWhaleAlert({
        targetLabel: 'XPL 1',
        walletAddress: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
        chain: 'Ethereum',
        action: 'TRANSFER_IN',
        amountFormatted: '50.00 ETH',
        valueUsd: 135000
      });

      assert.match(alert, /WHALE RADAR ALERT/);
      assert.match(alert, /XPL 1/);
      assert.match(alert, /0xd8dA\.\.\.6045/);
      assert.match(alert, /Ethereum/);
      assert.match(alert, /50\.00 ETH/);
      assert.match(alert, /\$135,000\.00/);
      assert.match(alert, /etherscan\.io/);
    });

    test('should format outgoing sell alert with correct action icon', () => {
      const alert = formatWhaleAlert({
        targetLabel: 'SOL Whale #2',
        walletAddress: 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH',
        chain: 'Solana',
        action: 'SELL',
        amountFormatted: '1,500 SOL',
        valueUsd: 225000
      });

      assert.match(alert, /🔴/);
      assert.match(alert, /Token Sell \/ Swap/);
      assert.match(alert, /solscan\.io/);
    });
  });

  describe('formatRsiAlert', () => {
    test('should format oversold RSI alert with green rebound signal', () => {
      const alert = formatRsiAlert({
        symbol: 'BTC',
        name: 'Bitcoin',
        chain: 'Ethereum',
        rsi: 24.5,
        priceUsd: 63500,
        change24h: -5.2,
        contractAddress: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599'
      });

      assert.match(alert, /TECHNICAL INDICATOR SIGNAL/);
      assert.match(alert, /Bitcoin \(BTC\)/);
      assert.match(alert, /24\.5/);
      assert.match(alert, /OVERSOLD/);
      assert.match(alert, /🟢/);
      assert.match(alert, /dexscreener\.com/);
    });

    test('should format overbought RSI alert with red pullback signal', () => {
      const alert = formatRsiAlert({
        symbol: 'PEPE',
        name: 'Pepe',
        chain: 'Ethereum',
        rsi: 78.2,
        priceUsd: 0.000012,
        change24h: 32.5,
        contractAddress: '0x6982508145454ce325ddbe47a25d4ec3d2311933'
      });

      assert.match(alert, /78\.2/);
      assert.match(alert, /OVERBOUGHT/);
      assert.match(alert, /🔴/);
    });
  });

  describe('formatVolumeAlert', () => {
    test('should format 24h volume surge alert with USD formatting', () => {
      const alert = formatVolumeAlert({
        symbol: 'SOL',
        name: 'Solana',
        chain: 'Solana',
        volumeUsd: 5400000,
        priceUsd: 145.2,
        contractAddress: 'So11111111111111111111111111111111111111112'
      });

      assert.match(alert, /UNUSUAL VOLUME SURGE DETECTED/);
      assert.match(alert, /\$5,400,000\.00/);
    });
  });

  describe('formatSummaryMessage', () => {
    test('should format portfolio overview summary with target wallet and coin lists', () => {
      const summary = formatSummaryMessage({
        walletCount: 5,
        coinCount: 3,
        totalNetWorth: 250000,
        topWallets: [
          { label: 'XPL 1', balance: '12.5 ETH', network: 'Ethereum' },
          { label: 'SOL 1', balance: '500 SOL', network: 'Solana' }
        ],
        topCoins: [
          { symbol: 'BTC', priceUsd: 65000, rsi: 48.5 },
          { symbol: 'ETH', priceUsd: 3400, rsi: 55.2 }
        ]
      });

      assert.match(summary, /PELACAK PORTFOLIO RADAR SUMMARY/);
      assert.match(summary, /5 targets/);
      assert.match(summary, /3 assets/);
      assert.match(summary, /\$250,000\.00/);
      assert.match(summary, /XPL 1/);
      assert.match(summary, /BTC/);
    });
  });

  describe('sendTelegramMessage configuration validation', () => {
    test('should fail gracefully if bot token or chat ID is missing', async () => {
      const result = await sendTelegramMessage('Test', {
        botToken: '',
        chatId: ''
      });

      assert.equal(result.success, false);
      assert.match(result.error || '', /missing/i);
    });
  });
});
