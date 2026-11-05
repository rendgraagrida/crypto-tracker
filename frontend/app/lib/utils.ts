/**
 * Shared utility functions for Pelacak Portfolio Tracker
 */

/**
 * Formats a numeric value into USD currency string (e.g. $1,234.56)
 */
export function formatCurrency(val: number | undefined | null): string {
  if (val === undefined || val === null || isNaN(val)) return '$0.00';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(val);
}

/**
 * Formats token price with high-precision for micro-caps
 */
export function formatTokenPrice(val: number | undefined | null): string {
  if (!val || val <= 0) return 'Unknown Price';
  if (val < 0.01) {
    return `@ $${val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
  }
  return `@ ${formatCurrency(val)}`;
}

/**
 * Formats a number or numeric string (e.g. 2942300 or "2942.3K") into compact format with K, M, B, T.
 * Translates overflow units (e.g. 2942.3K -> 2.9M) and supports ceiling/rounding.
 */
export function formatCompactNumber(
  val: number | string | undefined | null,
  options?: {
    decimals?: number;
    prefix?: string;
    roundCeil?: boolean;
  }
): string {
  if (val === undefined || val === null || val === '') return '-';

  let num = 0;
  if (typeof val === 'string') {
    const clean = val.trim().toUpperCase();
    if (clean === '-' || clean === 'N/A' || clean === '—') return '-';
    
    // Parse strings with potential suffix or currency symbol (e.g. "$2942.3K", "2942.3K", "1.5M")
    const stripped = clean.replace(/[^0-9.-KMBT]/g, '');
    if (stripped.endsWith('T')) {
      num = parseFloat(stripped.slice(0, -1)) * 1e12;
    } else if (stripped.endsWith('B')) {
      num = parseFloat(stripped.slice(0, -1)) * 1e9;
    } else if (stripped.endsWith('M')) {
      num = parseFloat(stripped.slice(0, -1)) * 1e6;
    } else if (stripped.endsWith('K')) {
      num = parseFloat(stripped.slice(0, -1)) * 1e3;
    } else {
      num = parseFloat(stripped);
    }
  } else {
    num = Number(val);
  }

  if (isNaN(num) || num <= 0) return options?.prefix ? `${options.prefix}0` : '0';

  const prefix = options?.prefix || '';
  const decimals = options?.decimals ?? 1;

  if (num >= 1e12) {
    const formatted = (num / 1e12).toFixed(decimals).replace(/\.0+$/, '');
    return `${prefix}${formatted}T`;
  }
  if (num >= 1e9) {
    const formatted = (num / 1e9).toFixed(decimals).replace(/\.0+$/, '');
    return `${prefix}${formatted}B`;
  }
  if (num >= 1e6) {
    const formatted = (num / 1e6).toFixed(decimals).replace(/\.0+$/, '');
    return `${prefix}${formatted}M`;
  }
  if (num >= 1e3) {
    const formatted = (num / 1e3).toFixed(decimals).replace(/\.0+$/, '');
    return `${prefix}${formatted}K`;
  }

  if (options?.roundCeil) {
    return `${prefix}${Math.ceil(num).toLocaleString('en-US')}`;
  }

  if (num >= 1) {
    const formatted = Math.ceil(num).toLocaleString('en-US');
    return `${prefix}${formatted}`;
  }

  return `${prefix}${num.toFixed(2)}`;
}

/**
 * Formats a currency value compactly with USD prefix ($2.9M, $500K, $45)
 */
export function formatCompactUSD(val: number | string | undefined | null): string {
  if (val === undefined || val === null || val === '') return '-';
  const res = formatCompactNumber(val, { prefix: '$', decimals: 1 });
  return res === '$0' ? '-' : res;
}

/**
 * Formats seconds into human readable countdown format (e.g. 5m 30s, 1h 15m)
 */
export function formatCountdown(seconds: number): string {
  if (seconds <= 0) return '0s';
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins < 60) return `${mins}m ${secs > 0 ? `${secs}s` : ''}`.trim();
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h ${remMins > 0 ? `${remMins}m` : ''}`.trim();
}

/**
 * Truncates blockchain addresses cleanly (e.g. 0xd8dA...6045)
 */
export function truncateAddress(address: string, start: number = 6, end: number = 4): string {
  if (!address) return '';
  if (address.length <= start + end) return address;
  return `${address.slice(0, start)}...${address.slice(-end)}`;
}

/**
 * Splits an array into chunks of a given maximum size (used for batching DexScreener 30-token limit)
 */
export function chunkArray<T>(array: T[], size: number = 30): T[][] {
  if (!array || array.length === 0) return [];
  if (size <= 0) return [array];
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

/**
 * Converts Solana Lamports (integer) to SOL (float)
 */
export function lamportsToSol(lamports: number | bigint): number {
  if (!lamports || Number(lamports) <= 0) return 0;
  return Number(lamports) / 1_000_000_000;
}

/**
 * Mapping of network names to explorer base URLs
 */
export function getExplorerUrl(network: string, tokenAddress: string, walletAddress: string): string {
  const net = (network || '').toUpperCase();
  if (net === 'SOLANA') {
    return `https://solscan.io/account/${walletAddress}`;
  }
  if (net === 'BASE' || net === 'BASE CHAIN') {
    return `https://basescan.org/address/${walletAddress}`;
  }
  if (net === 'BSC' || net === 'BINANCE') {
    return `https://bscscan.com/address/${walletAddress}`;
  }
  if (net === 'ROBINHOOD' || net === 'ROBINHOOD CHAIN') {
    return `https://explorer.robinhood.com/address/${walletAddress}`;
  }
  return `https://etherscan.io/address/${walletAddress}`;
}

/**
 * Network slug mapping for GeckoTerminal & Indexers
 */
export const NETWORK_MAP: Record<string, string> = {
  'ethereum': 'eth',
  'eth': 'eth',
  'bsc': 'bsc',
  'binance': 'bsc',
  'base chain': 'base',
  'base': 'base',
  'robinhood': 'robinhood',
  'rh': 'robinhood',
  'solana': 'solana',
  'sol': 'solana',
  'arbitrum': 'arbitrum',
  'polygon': 'polygon_pos'
};

export function getNetworkSlug(chainNetwork: string): string {
  if (!chainNetwork) return 'eth';
  return NETWORK_MAP[chainNetwork.toLowerCase().trim()] || 'eth';
}

/**
 * Checks if a token address is in the blacklist or is spam
 */
export function isTokenSpam(
  tokenAddress: string,
  blacklistedAddresses: string[] = [],
  isNative: boolean = false,
  priceUsd?: number | null,
  totalValueUsd?: number | null
): boolean {
  if (isNative) return false;
  if (!tokenAddress) return true;
  const cleanTarget = tokenAddress.toLowerCase().trim();
  if (blacklistedAddresses.some((addr) => addr.toLowerCase().trim() === cleanTarget)) {
    return true;
  }
  if (priceUsd !== undefined && totalValueUsd !== undefined) {
    if (!priceUsd || priceUsd <= 0 || !totalValueUsd || totalValueUsd <= 0) {
      return true;
    }
  }
  return false;
}

/**
 * Calculates Simple Moving Average (SMA)
 */
export function calculateSMA(values: number[], period: number): number[] {
  if (!values || values.length < period || period <= 0) return [];
  const results: number[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period - 1) {
      if (i >= period) {
        sum -= values[i - period];
      }
      results.push(sum / period);
    }
  }
  return results;
}

/**
 * Daily Summary Aggregator for Transaction History
 * Groups transactions on the same calendar day into 1 summary item
 */
export interface TransactionRecord {
  timestamp: string; // ISO string or YYYY-MM-DD
  type?: 'BUY' | 'SELL' | 'TRANSFER' | string;
  amount: number;
  valueUsd?: number;
  hash?: string;
  symbol?: string;
}

export interface DailySummary {
  date: string; // YYYY-MM-DD
  totalTransactions: number;
  netAmount: number;
  totalVolumeUsd: number;
  types: Record<string, number>;
}

export function groupTransactionsByDay(transactions: TransactionRecord[]): DailySummary[] {
  if (!transactions || transactions.length === 0) return [];

  const map = new Map<string, DailySummary>();

  for (const tx of transactions) {
    const dateKey = tx.timestamp ? tx.timestamp.split('T')[0] : 'Unknown Date';
    let summary = map.get(dateKey);
    if (!summary) {
      summary = {
        date: dateKey,
        totalTransactions: 0,
        netAmount: 0,
        totalVolumeUsd: 0,
        types: {},
      };
      map.set(dateKey, summary);
    }

    summary.totalTransactions += 1;
    summary.netAmount += (tx.type === 'SELL' ? -Math.abs(tx.amount) : Math.abs(tx.amount));
    summary.totalVolumeUsd += Math.abs(tx.valueUsd || 0);

    const txType = tx.type || 'TRANSFER';
    summary.types[txType] = (summary.types[txType] || 0) + 1;
  }

  return Array.from(map.values()).sort((a, b) => b.date.localeCompare(a.date));
}
