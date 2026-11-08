import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { boundedFetch } from './bounded-fetch.ts';
import { parseSwapQuote } from './swap-quotes.ts';
import type { SwapQuote, TradeActor, TradeFence, TradeOrder } from './trade-types.ts';

export type ExecutionOrder = TradeOrder & { executionToken: string; quoteHash: string; riskReservedUsd: string };
export type RiskState = { killed: boolean; reason: string | null; usedUsd: string };
export type RiskLimits = { maxTradeUsd: string; maxDailyLossUsd: string; maxExposureUsd: string };
export interface TradeStore {
  create(order: TradeOrder, fence: TradeFence): Promise<void>;
  get(id: string, actor: TradeActor): Promise<TradeOrder | null>;
  list(actor: TradeActor): Promise<TradeOrder[]>;
  confirm(id: string, actor: TradeActor, updateId: number, fence: TradeFence): Promise<boolean>;
  setKill(killed: boolean, reason: string, fence: TradeFence): Promise<void>;
  risk(): Promise<RiskState>;
  claim(signedOnly?: boolean): Promise<ExecutionOrder | null>;
  reserve(order: ExecutionOrder, costUsd: string, limits: RiskLimits): Promise<boolean>;
  writeSigned(order: ExecutionOrder, payload: string, hash: string): Promise<void>;
  transition(order: ExecutionOrder, status: TradeOrder['status'], error: string | null): Promise<void>;
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(Reflect.get(value, key))}`).join(',')}}`;
}
export function quoteDigest(quote: SwapQuote): string { return createHash('sha256').update(canonical(quote)).digest('hex'); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid trade storage response');
  return value as Record<string, unknown>;
}
function text(value: unknown): string { if (typeof value !== 'string' || !value) throw new Error('Invalid trade storage field'); return value; }
function money(value: unknown): string {
  const s = typeof value === 'number' && Number.isFinite(value) ? String(value) : text(value);
  if (!/^\d+(?:\.\d{1,6})?$/.test(s)) throw new Error('Invalid stored money'); return s;
}
function nullableText(value: unknown): string | null { return value === null ? null : text(value); }
function orderFrom(value: unknown): TradeOrder {
  const row = record(value), quote = parseSwapQuote(row.quote);
  if (text(row.quote_hash) !== quoteDigest(quote)) throw new Error('Stored quote changed');
  const status = text(row.status);
  if (!['quoted','confirmed','executing','signed','submitted','confirmed_onchain','failed','expired','unknown'].includes(status)) throw new Error('Invalid order status');
  if (row.mode !== 'manual' && row.mode !== 'auto') throw new Error('Invalid order mode');
  if (row.confirmed_update_id !== null && (typeof row.confirmed_update_id !== 'number' || !Number.isSafeInteger(row.confirmed_update_id) || row.confirmed_update_id < 0)) throw new Error('Invalid confirmation update');
  const signedPayload = nullableText(row.signed_payload), txHash = nullableText(row.tx_hash);
  if ((signedPayload === null) !== (txHash === null)) throw new Error('Incomplete write-ahead transaction');
  return { id: text(row.id), actor: { userId: text(row.user_id), chatId: text(row.chat_id) }, quote, notionalUsd: money(row.notional_usd), mode: row.mode,
    status: status as TradeOrder['status'], confirmedUpdateId: row.confirmed_update_id, txHash, signedPayload, error: nullableText(row.last_error) };
}
export function createTradeStore(): TradeStore {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_KEY;
  if (!url || !key) throw new Error('Trading storage is not configured');
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: boundedFetch } });
  async function rpc(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const { data, error } = await db.rpc(name, args);
    if (error) throw new Error('Trading storage rejected operation; check migration and permissions');
    return data;
  }
  const fenceArgs = (fence: TradeFence) => ({ p_job: fence.jobId, p_attempt: fence.attempt });
  return {
    async create(order, fence) {
      const quote = parseSwapQuote(order.quote);
      await rpc('trade_create', { p_id: order.id, p_user: order.actor.userId, p_chat: order.actor.chatId, p_quote: quote, p_hash: quoteDigest(quote), p_notional: order.notionalUsd, p_mode: order.mode, ...fenceArgs(fence) });
    },
    async get(id, actor) {
      const { data, error } = await db.from('trade_orders').select('*').eq('id', id).eq('user_id', actor.userId).eq('chat_id', actor.chatId).maybeSingle();
      if (error) throw new Error('Order is unavailable'); return data === null ? null : orderFrom(data);
    },
    async list(actor) {
      const { data, error } = await db.from('trade_orders').select('*').eq('user_id', actor.userId).eq('chat_id', actor.chatId).order('created_at', { ascending: false }).limit(20);
      if (error) throw new Error('Orders unavailable'); return (data ?? []).map(orderFrom);
    },
    async confirm(id, actor, updateId, fence) {
      return await rpc('trade_confirm', { p_id: id, p_user: actor.userId, p_chat: actor.chatId, p_update: updateId, ...fenceArgs(fence) }) === true;
    },
    async setKill(killed, reason, fence) { await rpc('trade_set_kill', { p_killed: killed, p_reason: reason, ...fenceArgs(fence) }); },
    async risk() {
      const { data, error } = await db.from('trade_risk').select('killed,reason,used_usd').eq('id', true).single();
      if (error || !data || typeof data.killed !== 'boolean') throw new Error('Risk state unavailable; execution blocked');
      return { killed: data.killed, reason: data.reason === null ? null : text(data.reason), usedUsd: money(data.used_usd) };
    },
    async claim(signedOnly = false) {
      const rows = await rpc('trade_claim', { p_signed_only: signedOnly }); if (!Array.isArray(rows)) throw new Error('Invalid trade claim');
      if (!rows.length) return null;
      const row = record(rows[0]);
      return { ...orderFrom(row), executionToken: text(row.execution_token), quoteHash: text(row.quote_hash), riskReservedUsd: money(row.risk_reserved_usd) };
    },
    async reserve(order, costUsd, limits) {
      return await rpc('trade_reserve', { p_id: order.id, p_token: order.executionToken, p_cost: costUsd, p_max_trade: limits.maxTradeUsd, p_max_daily_loss: limits.maxDailyLossUsd, p_max_exposure: limits.maxExposureUsd }) === true;
    },
    async writeSigned(order, payload, hash) { await rpc('trade_write_signed', { p_id: order.id, p_token: order.executionToken, p_payload: payload, p_hash: hash }); },
    async transition(order, status, error) { await rpc('trade_transition', { p_id: order.id, p_token: order.executionToken, p_status: status, p_error: error }); },
  };
}
