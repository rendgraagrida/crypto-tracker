import { createClient } from '@supabase/supabase-js';
import { boundedFetch } from './bounded-fetch.ts';
import type { CoinAnalysis } from './coin-analyzer.ts';
import type { TradeActor, TradeFence } from './trade-types.ts';

export type PaperHorizon = '1h' | '6h' | '24h';
export const PAPER_HORIZONS: Record<PaperHorizon, number> = { '1h': 3600000, '6h': 21600000, '24h': 86400000 };
export type PaperOpen = {
  signalId: string; actor: TradeActor; chain: string; token: string; entryAt: string;
  entryPriceUsd: string; notionalUsd: string; entryFeeUsd: string; exitFeeUsd: string;
  entrySlippageBps: number; exitSlippageBps: number;
  analysis: CoinAnalysis; hermes: { status: string; findingIds: string[] };
};
export type PaperObservation = { observedAt: string; priceUsd: string | null; liquidityUsd: string | null; source: string };
export type PaperMark = { horizon: PaperHorizon; targetAt: string; status: 'marked' | 'zero_liquidity_loss' | 'delayed' | 'unavailable'; observation: PaperObservation | null; netReturn: number | null };
export type PaperTrade = PaperOpen & { filteredEligible: boolean; filterReason: string; marks: Partial<Record<PaperHorizon, PaperMark>> };
export interface PaperStore {
  create(fence: TradeFence, trade: PaperTrade): Promise<PaperTrade>;
  due(now: string, limit: number): Promise<PaperTrade[]>;
  settle(fence: TradeFence, signalId: string, mark: PaperMark): Promise<void>;
  list(actor: TradeActor, limit: number): Promise<PaperTrade[]>;
}
export type PaperCollector = (trade: PaperTrade, horizon: PaperHorizon, targetAt: string) => Promise<PaperObservation | null>;
export type PaperCohortSummary = { eligible: number; evaluated: number; missing: number; delayed: number; unavailable: number; netReturn: number | null; winRate: number | null; maxDrawdown: number | null };
export type PaperSummary = { horizon: PaperHorizon; baseline: PaperCohortSummary; filtered: PaperCohortSummary; definition: string };

function timestamp(value: string): number { const n = Date.parse(value); if (!Number.isFinite(n)) throw new Error('Invalid paper timestamp'); return n; }
function decimal(value: string, positive = false): number {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) throw new Error('Invalid paper decimal');
  const n = Number(value); if (!Number.isFinite(n) || (positive ? n <= 0 : n < 0)) throw new Error('Invalid paper decimal'); return n;
}
function bps(value: number): void { if (!Number.isInteger(value) || value < 0 || value >= 10000) throw new Error('Invalid paper slippage'); }
function validateOpen(input: PaperOpen): void {
  if (typeof input.signalId !== 'string' || !input.signalId || typeof input.actor?.userId !== 'string' || !input.actor.userId || typeof input.actor.chatId !== 'string' || !input.actor.chatId || typeof input.chain !== 'string' || !input.chain || typeof input.token !== 'string' || !input.token) throw new Error('Missing paper identity');
  if (!input.analysis || !input.analysis.sources || !input.analysis.market || !Array.isArray(input.analysis.findings) || !input.analysis.tradeGuardrail) throw new Error('Missing paper evidence');
  const entry = timestamp(input.entryAt); if (timestamp(input.analysis.fetchedAt) > entry) throw new Error('Analysis is newer than entry');
  for (const source of Object.values(input.analysis.sources)) if (source.updatedAt !== null && timestamp(source.updatedAt) > entry) throw new Error('Source is newer than entry');
  if (input.analysis.chain !== input.chain || input.analysis.address !== input.token) throw new Error('Analysis token mismatch');
  decimal(input.entryPriceUsd, true); const notional = decimal(input.notionalUsd, true);
  if (decimal(input.entryFeeUsd) >= notional) throw new Error('Entry fee exceeds notional');
  decimal(input.exitFeeUsd); bps(input.entrySlippageBps); bps(input.exitSlippageBps);
  if (!input.hermes || typeof input.hermes.status !== 'string' || !Array.isArray(input.hermes.findingIds) || input.hermes.findingIds.some(id => typeof id !== 'string')) throw new Error('Invalid Hermes evidence');
}
function eligibility(input: PaperOpen): { filteredEligible: boolean; filterReason: string } {
  if (input.hermes.status !== 'ok') return { filteredEligible: false, filterReason: 'hermes_unavailable' };
  const ids = new Set(input.hermes.findingIds); const a = input.analysis;
  const adverse = (ids.has('liquidity_ratio') && a.market.liquidityToMarketCap !== null && a.market.liquidityToMarketCap < 0.05)
    || (ids.has('honeypot_detected') && a.findings.includes('GoPlus reports honeypot'))
    || (ids.has('freeze_authority') && a.findings.includes('Freeze authority present'));
  return { filteredEligible: !adverse, filterReason: adverse ? 'selected_adverse_evidence' : 'no_selected_adverse_evidence_not_a_buy_recommendation' };
}
export async function openPaperTrade(store: PaperStore, fence: TradeFence, input: PaperOpen): Promise<PaperTrade> {
  validateOpen(input);
  return store.create(fence, { ...input, ...eligibility(input), marks: {} });
}
function returnFor(trade: PaperTrade, mark: PaperObservation, zero: boolean): number {
  const notional = decimal(trade.notionalUsd, true);
  const quantity = (notional - decimal(trade.entryFeeUsd)) / (decimal(trade.entryPriceUsd, true) * (1 + trade.entrySlippageBps / 10000));
  const gross = zero ? 0 : quantity * decimal(mark.priceUsd!, true) * (1 - trade.exitSlippageBps / 10000);
  const result = (gross - decimal(trade.exitFeeUsd) - notional) / notional;
  if (!Number.isFinite(result)) throw new Error('Paper return outside numeric range');
  return result;
}
// The optional clock is sampled after collection; omit it for a fixed replay as-of.
export async function settleDuePaperTrades(store: PaperStore, fence: TradeFence, collector: PaperCollector, now: string, toleranceMs: number, limit: number, observationClock?: () => string): Promise<number> {
  const nowMs = timestamp(now);
  if (!Number.isInteger(toleranceMs) || toleranceMs < 0 || toleranceMs > 300000 || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid paper batch or tolerance');
  const trades = await store.due(now, limit); let count = 0;
  for (const trade of trades) for (const horizon of Object.keys(PAPER_HORIZONS) as PaperHorizon[]) {
    const target = timestamp(trade.entryAt) + PAPER_HORIZONS[horizon];
    if (trade.marks[horizon] || target > nowMs) continue;
    const targetAt = new Date(target).toISOString();
    const observation = await collector(trade, horizon, targetAt);
    let status: PaperMark['status'] = 'unavailable'; let netReturn: number | null = null;
    if (observation) {
      const observed = timestamp(observation.observedAt);
      const cutoff = observationClock ? timestamp(observationClock()) : nowMs;
      if (cutoff < nowMs || observed > cutoff) throw new Error('Paper observation is from the future');
      if (typeof observation.source !== 'string' || !observation.source) throw new Error('Missing observation source');
      const liquidity = observation.liquidityUsd === null ? null : decimal(observation.liquidityUsd);
      if (observation.priceUsd !== null) decimal(observation.priceUsd, true);
      if (observed < target || observed > target + toleranceMs) status = 'delayed';
      else if (liquidity === 0) { status = 'zero_liquidity_loss'; netReturn = returnFor(trade, observation, true); }
      else if (observation.priceUsd !== null) { status = 'marked'; netReturn = returnFor(trade, observation, false); }
    }
    await store.settle(fence, trade.signalId, { horizon, targetAt, status, observation, netReturn }); count++;
  }
  return count;
}
export function summarizePaperTrades(trades: PaperTrade[], horizon: PaperHorizon): PaperSummary {
  function cohort(rows: PaperTrade[]): PaperCohortSummary {
    const sorted = [...rows].sort((a, b) => timestamp(a.entryAt) - timestamp(b.entryAt) || a.signalId.localeCompare(b.signalId));
    let sum = 0, peak = 0, drawdown = 0, wins = 0, evaluated = 0, delayed = 0, unavailable = 0;
    for (const row of sorted) {
      const mark = row.marks[horizon];
      if (mark?.status === 'delayed') delayed++; else if (mark?.status === 'unavailable') unavailable++;
      if (mark?.netReturn === null || mark?.netReturn === undefined) continue;
      evaluated++; sum += mark.netReturn; if (mark.netReturn > 0) wins++; peak = Math.max(peak, sum); drawdown = Math.max(drawdown, peak - sum);
    }
    return { eligible: rows.length, evaluated, missing: rows.length - evaluated, delayed, unavailable, netReturn: evaluated ? sum / evaluated : null, winRate: evaluated ? wins / evaluated : null, maxDrawdown: evaluated ? drawdown : null };
  }
  return { horizon, baseline: cohort(trades), filtered: cohort(trades.filter(t => t.filteredEligible)), definition: 'Equal-notional sequential arithmetic returns ordered by entry time; netReturn is mean per trade, drawdown is maximum decline in cumulative return units, not portfolio equity. Missing marks excluded from metrics; no buy recommendation.' };
}
export function createPaperStore(): PaperStore {
  const url = process.env.SUPABASE_URL; const key = process.env.SUPABASE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and service-role SUPABASE_KEY required');
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: boundedFetch } });
  function check(error: unknown): void { if (error) throw new Error('Paper storage failed; check migration and service role'); }
  return {
    async create(fence, trade) {
      const { data, error } = await db.rpc('paper_open', { p_id: fence.jobId, p_attempt: fence.attempt, p_trade: trade }); check(error);
      if (!data || typeof data !== 'object') throw new Error('Invalid paper storage response'); return data as PaperTrade;
    },
    async due(now, limit) {
      const { data, error } = await db.rpc('paper_due', { p_now: now, p_limit: limit }); check(error); return (data ?? []) as PaperTrade[];
    },
    async settle(fence, signalId, mark) {
      const { error } = await db.rpc('paper_settle', { p_id: fence.jobId, p_attempt: fence.attempt, p_signal_id: signalId, p_mark: mark }); check(error);
    },
    async list(actor, limit) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error('Invalid paper list limit');
      const { data, error } = await db.from('paper_trades').select('trade').eq('user_id', actor.userId).eq('chat_id', actor.chatId).order('entry_at', { ascending: false }).limit(limit); check(error);
      return (data ?? []).map(row => row.trade as PaperTrade);
    },
  };
}
