import { formatUnits, parseUnits } from 'ethers';
import { normalizeChain } from './auth.ts';
import type { RiskLimits } from './trade-store.ts';

export type TradePolicy = RiskLimits & {
  live: boolean; auto: boolean; allowedChains: string[]; maxSlippageBps: number; maxDeviationBps: number;
  maxFeeNativeRaw: bigint; maxRentLamports: bigint; tipLamports: bigint; jitoTipAccount: string;
  finalityBlocks: number; settlerCodeHashes: Record<string, string>; solanaProgramDataHash: string;
  solanaGenesisHash?: string;
  assetReviews?: Record<string, { codeHash: string; reviewedAt: string; expiresAt: string }>;
};
function required(name: string): string { const v = process.env[name]?.trim(); if (!v) throw new Error(`Missing ${name}; live trading remains blocked`); return v; }
export function usdUnits(value: string): bigint {
  if (!/^(?:0|[1-9]\d{0,20})(?:\.\d{1,6})?$/.test(value)) throw new Error('USD amount requires positive decimal notation with at most 6 decimals');
  return parseUnits(value, 6);
}
export function positiveUsd(value: string): string { if (usdUnits(value) <= 0n) throw new Error('USD amount must be positive'); return value; }
function uintEnv(name: string): bigint { const s = required(name); if (!/^(0|[1-9]\d{0,25})$/.test(s)) throw new Error(`Invalid ${name}`); return BigInt(s); }
function integerEnv(name: string, min: number, max: number): number { const s = required(name); const n = Number(s); if (!/^\d+$/.test(s) || !Number.isSafeInteger(n) || n < min || n > max) throw new Error(`Invalid ${name}`); return n; }
export function readTradePolicy(options: { reconcileOnly?: boolean } = {}): TradePolicy {
  if (process.env.TRADE_LIVE_ENABLED !== 'true' && !options.reconcileOnly) throw new Error('Live trading is disabled; no key is loaded');
  if (process.env.TRADE_RISK_MODEL !== 'conservative-capital-at-risk') throw new Error('Explicit conservative risk model approval required');
  const allowedChains = [...new Set(required('TRADE_ALLOWED_CHAINS').split(',').map(normalizeChain))];
  const rawHashes: unknown = JSON.parse(process.env.TRADE_EVM_CODE_HASHES || '{}');
  if (!rawHashes || typeof rawHashes !== 'object' || Array.isArray(rawHashes)) throw new Error('Invalid trusted contract hashes');
  const settlerCodeHashes: Record<string,string> = {};
  for (const [address, hash] of Object.entries(rawHashes)) {
    if (!/^0x[0-9a-f]{40}$/i.test(address) || typeof hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(hash)) throw new Error('Invalid trusted contract pin');
    settlerCodeHashes[address.toLowerCase()] = hash.toLowerCase();
  }
  const rawReviews: unknown = JSON.parse(process.env.TRADE_EVM_ASSET_REVIEWS || '{}');
  if (!rawReviews || typeof rawReviews !== 'object' || Array.isArray(rawReviews)) throw new Error('Invalid independent asset reviews');
  const assetReviews: NonNullable<TradePolicy['assetReviews']> = {};
  for (const [key, value] of Object.entries(rawReviews)) {
    if (!/^[a-z]+:0x[0-9a-f]{40}$/.test(key) || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid reviewed asset');
    const v = value as Record<string, unknown>;
    if (typeof v.codeHash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(v.codeHash) || typeof v.reviewedAt !== 'string' || typeof v.expiresAt !== 'string') throw new Error('Invalid review pin');
    const reviewed = Date.parse(v.reviewedAt), expires = Date.parse(v.expiresAt);
    if (!Number.isFinite(reviewed) || !Number.isFinite(expires) || reviewed > Date.now() || expires <= reviewed || expires - reviewed > 86400000) throw new Error('Asset review must have an explicit validity of at most 24 hours');
    assetReviews[key] = { codeHash: v.codeHash.toLowerCase(), reviewedAt: v.reviewedAt, expiresAt: v.expiresAt };
  }
  const policy: TradePolicy = {
    live: process.env.TRADE_LIVE_ENABLED === 'true' && !options.reconcileOnly, auto: process.env.TRADE_AUTO_ENABLED === 'true', allowedChains,
    maxTradeUsd: positiveUsd(required('MAX_TRADE_USD')), maxDailyLossUsd: positiveUsd(required('MAX_DAILY_LOSS_USD')), maxExposureUsd: positiveUsd(required('MAX_EXPOSURE_USD')),
    maxSlippageBps: integerEnv('MAX_SLIPPAGE_BPS', 0, 150), maxDeviationBps: integerEnv('MAX_SPOT_DEVIATION_BPS', 0, 1000),
    maxFeeNativeRaw: uintEnv('MAX_FEE_NATIVE_RAW'), maxRentLamports: BigInt(process.env.MAX_SOLANA_RENT_LAMPORTS || '0'),
    tipLamports: BigInt(process.env.JITO_TIP_LAMPORTS || '0'), jitoTipAccount: process.env.JITO_TIP_ACCOUNT || '',
    finalityBlocks: integerEnv('TRADE_EVM_FINALITY_BLOCKS', 1, 256), settlerCodeHashes, assetReviews,
    solanaProgramDataHash: process.env.TRADE_SOLANA_PROGRAM_DATA_SHA256 || '',
    solanaGenesisHash: process.env.TRADE_SOLANA_GENESIS_HASH || '',
  };
  if (usdUnits(policy.maxTradeUsd) > usdUnits(policy.maxDailyLossUsd) || usdUnits(policy.maxTradeUsd) > usdUnits(policy.maxExposureUsd) || policy.maxFeeNativeRaw <= 0n || policy.tipLamports < 0n || policy.maxRentLamports < 0n) throw new Error('Inconsistent risk limits');
  return policy;
}
/** Conservative USD ceiling. Raw chain units never pass through Number. */
export function valueUsd(raw: string | bigint, decimals: number, price: number): string {
  if (!Number.isFinite(price) || price <= 0 || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error('Unknown valuation');
  const amount = BigInt(raw); if (amount < 0n) throw new Error('Invalid raw amount');
  // Price is provider decimal precision, not a claim of exact USD valuation. Tiny prices fail closed.
  const fixed = price.toFixed(18); const priceUnits = parseUnits(fixed, 18);
  if (priceUnits <= 0n) throw new Error('Price below supported valuation precision');
  const divisor = 10n ** BigInt(decimals + 12);
  return formatUnits((amount * priceUnits + divisor - 1n) / divisor, 6);
}
export function checkSpotDeviation(inputUsd: string, outputUsd: string, maxBps: number): void {
  const input = usdUnits(inputUsd), output = usdUnits(outputUsd);
  if (input <= 0n || output * 10000n < input * BigInt(10000 - maxBps)) throw new Error('Minimum received fails conservative spot valuation limit');
}
