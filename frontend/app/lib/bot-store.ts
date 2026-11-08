import { createClient } from '@supabase/supabase-js';
import { randomBytes } from 'node:crypto';
import { boundedFetch } from './bounded-fetch.ts';
import type { TradeFence } from './trade-types.ts';

export type BotJob = { id: string; kind: 'update' | 'scan' | 'send' | 'enrich' | 'paper' | 'maintenance'; payload: Record<string, unknown>; attempts: number };
export type CleanupResult = { deletedJobs: number; compactedJobs: number; deletedConfirmations: number };
export interface BotStore {
  enqueue(id: string, kind: BotJob['kind'], payload: Record<string, unknown>): Promise<void>;
  claim(): Promise<BotJob | null>;
  ensureLease(): Promise<void>;
  cleanup(batch?: number): Promise<CleanupResult>;
  fence(): TradeFence;
  renew(job: BotJob): Promise<void>;
  finish(job: BotJob): Promise<void>;
  retry(job: BotJob, delaySeconds?: number): Promise<void>;
  getState<T>(key: string): Promise<T | null>;
  setState(key: string, value: unknown): Promise<void>;
  confirm(command: string, userId: string, chatId: string): Promise<string>;
  consumeConfirmation(token: string, userId: string, chatId: string, updateId: number): Promise<string | null>;
  ready(): Promise<boolean>;
}

export function createBotStore(): BotStore {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL dan service-role SUPABASE_KEY diperlukan.');
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: boundedFetch } });
  function check(error: unknown) { if (error) throw new Error('Penyimpanan bot gagal; periksa migrasi dan role database.'); }
  let active: BotJob | null = null;
  return {
    async enqueue(id, kind, payload) {
      const { error } = await db.from('bot_jobs').upsert({ id, kind, payload }, { onConflict: 'id', ignoreDuplicates: true });
      check(error);
    },
    async claim() {
      const { data, error } = await db.rpc('bot_claim_job');
      check(error);
      active = data?.[0] || null;
      return active;
    },
    async ensureLease() {
      if (!active) throw new Error('Pekerjaan tidak memiliki lease.');
      const { data, error } = await db.rpc('bot_has_lease', { p_id: active.id, p_attempt: active.attempts });
      check(error);
      if (data !== true) throw new Error('Lease pekerjaan sudah berakhir.');
    },
    fence() {
      if (!active) throw new Error('Pekerjaan tidak memiliki lease.');
      return { jobId: active.id, attempt: active.attempts };
    },
    async cleanup(batch = 5000) {
      if (!active || active.kind !== 'maintenance') throw new Error('Cleanup memerlukan lease maintenance.');
      await this.ensureLease();
      const { data, error } = await db.rpc('bot_cleanup_retention', { p_id: active.id, p_attempt: active.attempts, p_batch: batch });
      check(error);
      if (!data || typeof data !== 'object' || Array.isArray(data) ||
          !['deletedJobs', 'compactedJobs', 'deletedConfirmations'].every(key =>
            Number.isSafeInteger(data[key]) && data[key] >= 0)) {
        throw new Error('Respons cleanup tidak valid.');
      }
      return { deletedJobs: data.deletedJobs, compactedJobs: data.compactedJobs, deletedConfirmations: data.deletedConfirmations };
    },
    async renew(job) {
      const { data, error } = await db.rpc('bot_renew_job', { p_id: job.id, p_attempt: job.attempts });
      check(error);
      if (data !== true) throw new Error('Lease pekerjaan sudah berakhir.');
    },
    async finish(job) {
      const { error } = await db.from('bot_jobs').update({ status: 'done', lease_until: null }).eq('id', job.id).eq('attempts', job.attempts);
      check(error);
    },
    async retry(job, delaySeconds = job.kind === 'enrich' ? 65 : Math.min(60, 2 ** job.attempts)) {
      const { error } = await db.from('bot_jobs').update({ status: job.attempts >= 4 ? 'failed' : 'pending', run_after: new Date(Date.now() + Math.max(1, Math.min(delaySeconds, 3600)) * 1000).toISOString(), lease_until: null }).eq('id', job.id).eq('attempts', job.attempts);
      check(error);
    },
    async getState<T>(key: string) {
      const { data, error } = await db.from('bot_state').select('value').eq('key', key).maybeSingle();
      check(error);
      return (data?.value as T) ?? null;
    },
    async setState(key, value) {
      const { error } = await db.rpc('bot_write_state', { p_key: key, p_value: value, p_id: active?.id || '', p_attempt: active?.attempts || 0 });
      check(error);
    },
    async confirm(command, userId, chatId) {
      const token = randomBytes(16).toString('hex');
      const { error } = await db.from('bot_confirmations').insert({ token, command, user_id: userId, chat_id: chatId, expires_at: new Date(Date.now() + 120000).toISOString() });
      check(error);
      return token;
    },
    async consumeConfirmation(token, userId, chatId, updateId) {
      if (!/^[a-f0-9]{32}$/.test(token)) return null;
      const { data, error } = await db.rpc('bot_take_confirmation', { p_token: token, p_user: userId, p_chat: chatId, p_update: updateId });
      check(error);
      return data?.[0]?.command || null;
    },
    async ready() {
      const { error } = await db.from('bot_jobs').select('id').limit(0);
      return !error;
    },
  };
}
