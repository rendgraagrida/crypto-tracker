import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { normalizeChain } from '../app/lib/auth.ts';
import { openPaperTrade, settleDuePaperTrades, summarizePaperTrades, PAPER_HORIZONS } from '../app/lib/paper-trading.ts';
import type { PaperOpen, PaperObservation, PaperStore, PaperTrade, PaperHorizon } from '../app/lib/paper-trading.ts';

export type ReplayDataset = { version: 1; synthetic: true; holdoutStart: string; asOf: string; toleranceMs: number; entries: { split: 'train' | 'holdout'; open: PaperOpen; observations: Partial<Record<PaperHorizon, PaperObservation | null>> }[] };
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const time = (v: unknown): number => { if (typeof v !== 'string' || !Number.isFinite(Date.parse(v))) throw new Error('Invalid replay timestamp'); return Date.parse(v); };
export async function replayPaperDataset(raw: unknown) {
  if (!object(raw) || raw.version !== 1 || raw.synthetic !== true || !Array.isArray(raw.entries) || typeof raw.toleranceMs !== 'number' || !Number.isInteger(raw.toleranceMs) || raw.toleranceMs < 0 || raw.toleranceMs > 300000) throw new Error('Invalid versioned synthetic replay dataset');
  const cutoff = time(raw.holdoutStart), asOf = time(raw.asOf);
  if (asOf < cutoff) throw new Error('Replay as-of precedes holdout');
  const entries: ReplayDataset['entries'] = []; const tokens = { train: new Set<string>(), holdout: new Set<string>() }; const signals = new Set<string>();
  for (const value of raw.entries) {
    if (!object(value) || (value.split !== 'train' && value.split !== 'holdout') || !object(value.open) || !object(value.observations)) throw new Error('Invalid replay entry');
    const open = value.open; const entryTime = time(open.entryAt);
    if (entryTime > asOf || (value.split === 'train' ? entryTime >= cutoff : entryTime < cutoff)) throw new Error('Replay temporal holdout contamination');
    if (typeof open.chain !== 'string' || typeof open.token !== 'string' || typeof open.signalId !== 'string' || signals.has(open.signalId)) throw new Error('Invalid or duplicate replay identity');
    signals.add(open.signalId);
    const chain = normalizeChain(open.chain);
    const token = `${chain}:${chain === 'solana' ? open.token : open.token.toLowerCase()}`;
    tokens[value.split].add(token);
    for (const [horizon, observation] of Object.entries(value.observations)) {
      if (!Object.hasOwn(PAPER_HORIZONS, horizon)) throw new Error('Invalid replay horizon');
      if (observation !== null) {
        if (!object(observation) || time(observation.observedAt) > asOf) throw new Error('Replay observation after as-of');
        if (value.split === 'train' && time(observation.observedAt) >= cutoff) throw new Error('Replay temporal holdout contamination');
        if (typeof observation.source !== 'string' || !observation.source || !(observation.priceUsd === null || typeof observation.priceUsd === 'string') || !(observation.liquidityUsd === null || typeof observation.liquidityUsd === 'string')) throw new Error('Invalid replay observation');
      }
    }
    entries.push(value as unknown as ReplayDataset['entries'][number]);
  }
  for (const token of tokens.train) if (tokens.holdout.has(token)) throw new Error('Replay token holdout contamination');
  const rows = new Map<string, PaperTrade>();
  const store: PaperStore = {
    async create(_fence, trade) { const old = rows.get(trade.signalId); if (old) return old; rows.set(trade.signalId, structuredClone(trade)); return trade; },
    async due(now, limit) { return [...rows.values()].filter(t => (Object.keys(PAPER_HORIZONS) as PaperHorizon[]).some(h => !t.marks[h] && time(t.entryAt) + PAPER_HORIZONS[h] <= time(now))).slice(0, limit); },
    async settle(_fence, signalId, mark) { const row = rows.get(signalId); if (!row) throw new Error('Replay trade missing'); row.marks[mark.horizon] ??= mark; },
    async list(actor, limit) { return [...rows.values()].filter(t => t.actor.userId === actor.userId && t.actor.chatId === actor.chatId).slice(0, limit); },
  };
  const fence = { jobId: 'offline-replay', attempt: 1 };
  for (const entry of entries) await openPaperTrade(store, fence, entry.open);
  const byId = new Map(entries.map(e => [e.open.signalId, e]));
  const now = new Date(asOf).toISOString();
  while (await settleDuePaperTrades(store, fence, async (trade, horizon) => byId.get(trade.signalId)?.observations[horizon] ?? null, now, raw.toleranceMs, 500)) { /* bounded batches */ }
  const holdout = [...rows.values()].filter(t => byId.get(t.signalId)?.split === 'holdout');
  return { version: 1, asOf: now, holdoutStart: new Date(cutoff).toISOString(), holdout: Object.fromEntries((Object.keys(PAPER_HORIZONS) as PaperHorizon[]).map(h => [h, summarizePaperTrades(holdout, h)])) };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const path = process.argv[2];
  if (!path || process.argv.length !== 3) throw new Error('Usage: node --experimental-strip-types frontend/scripts/paper-replay.ts <synthetic-v1.json>');
  const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
  console.log(JSON.stringify(await replayPaperDataset(raw), null, 2));
}
