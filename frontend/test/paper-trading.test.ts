import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { openPaperTrade, settleDuePaperTrades, summarizePaperTrades } from '../app/lib/paper-trading.ts';
import type { PaperStore, PaperTrade, PaperHorizon } from '../app/lib/paper-trading.ts';
import { replayPaperDataset } from '../scripts/paper-replay.ts';
import type { ReplayDataset } from '../scripts/paper-replay.ts';

const fixture = async (): Promise<ReplayDataset> => JSON.parse(await readFile(new URL('./fixtures/paper-replay.json', import.meta.url), 'utf8')) as ReplayDataset;
const fence = { jobId: 'job', attempt: 1 };
function memory(): PaperStore {
  const rows = new Map<string, PaperTrade>();
  return {
    async create(_fence, trade) { const existing = rows.get(trade.signalId); if (existing) return existing; const copy = structuredClone(trade); rows.set(copy.signalId, copy); return copy; },
    async due(_now, limit) { return [...rows.values()].slice(0, limit); },
    async settle(_fence, id, mark) { const row = rows.get(id); if (!row) throw new Error('missing'); row.marks[mark.horizon] ??= mark; },
    async list(_actor, limit) { return [...rows.values()].slice(0, limit); },
  };
}
test('paper signal replay deduplicates and costs apply to both sides', async () => {
  const input = (await fixture()).entries[1].open; const store = memory();
  await openPaperTrade(store, fence, input); await openPaperTrade(store, fence, input);
  const count = await settleDuePaperTrades(store, fence, async () => ({ observedAt: '2026-01-02T01:00:00Z', priceUsd: '2', liquidityUsd: '1000', source: 'fixture' }), '2026-01-02T01:00:00Z', 0, 10);
  const trades = await store.list(input.actor, 10); assert.equal(trades.length, 1); assert.equal(count, 1);
  const expected = (((100 - 1) / 1.01) * 2 * 0.99 - 1 - 100) / 100;
  assert.ok(Math.abs(trades[0].marks['1h']!.netReturn! - expected) < 1e-12);
  assert.equal(await settleDuePaperTrades(store, fence, async () => { throw new Error('must not recollect'); }, '2026-01-02T01:00:00Z', 0, 10), 0);
});
test('marks retain unavailable and delayed coverage without using future observations', async () => {
  const input = (await fixture()).entries[1].open; const store = memory(); await openPaperTrade(store, fence, input);
  const observations = { '1h': { observedAt: '2026-01-02T01:05:00Z', priceUsd: '8', liquidityUsd: '10', source: 'fixture' }, '6h': null, '24h': { observedAt: '2026-01-03T00:00:00Z', priceUsd: null, liquidityUsd: '0', source: 'fixture' } };
  await settleDuePaperTrades(store, fence, async (_t, horizon) => observations[horizon], '2026-01-03T00:00:00Z', 60000, 10);
  const trades = await store.list(input.actor, 10); assert.equal(trades[0].marks['1h']?.status, 'delayed'); assert.equal(trades[0].marks['6h']?.status, 'unavailable');
  assert.equal(trades[0].marks['24h']?.status, 'zero_liquidity_loss'); assert.equal(trades[0].marks['24h']?.netReturn, -1.01);
  const summary = summarizePaperTrades(trades, '1h'); assert.equal(summary.baseline.missing, 1); assert.equal(summary.baseline.delayed, 1); assert.equal(summary.baseline.netReturn, null);
  const other = memory(); await openPaperTrade(other, fence, input);
  await assert.rejects(settleDuePaperTrades(other, fence, async () => ({ observedAt: '2026-01-03T00:00:00Z', priceUsd: '1', liquidityUsd: '1', source: 'future' }), '2026-01-02T01:00:00Z', 0, 10), /future/);
});
test('live observation clock is sampled after collector I/O', async () => {
  const input = (await fixture()).entries[1].open; const store = memory();
  await openPaperTrade(store, fence, input);
  let clock = '2026-01-02T01:00:00Z';
  await settleDuePaperTrades(store, fence, async () => {
    clock = '2026-01-02T01:00:02Z';
    return { observedAt: clock, priceUsd: '2', liquidityUsd: '1000', source: 'fixture' };
  }, clock, 5000, 10, () => clock);
  assert.equal((await store.list(input.actor, 10))[0].marks['1h']?.status, 'marked');
});
test('cohort membership uses entry evidence, not selected rank alone', async () => {
  const input = (await fixture()).entries[1].open; const store = memory();
  const neutral = await openPaperTrade(store, fence, input); assert.equal(neutral.filteredEligible, true);
  const risky = structuredClone(input); risky.signalId = 'risk'; risky.analysis.market.liquidityToMarketCap = 0.01;
  assert.equal((await openPaperTrade(store, fence, risky)).filteredEligible, false);
  const offline = structuredClone(input); offline.signalId = 'offline'; offline.hermes.status = 'timeout';
  assert.equal((await openPaperTrade(store, fence, offline)).filteredEligible, false);
  const summary = summarizePaperTrades(await store.list(input.actor, 10), '1h' as PaperHorizon);
  assert.equal(summary.baseline.eligible, 3); assert.equal(summary.filtered.eligible, 1); assert.equal(summary.filtered.netReturn, null);
});
test('replay enforces token and temporal holdout and observation as-of', async () => {
  const data = await fixture(); const result = await replayPaperDataset(data);
  assert.equal(result.holdout['1h'].baseline.evaluated, 1); assert.equal(result.holdout['6h'].baseline.missing, 1); assert.equal(result.holdout['24h'].baseline.delayed, 1);
  const overlap = structuredClone(data); overlap.entries[1].open.token = overlap.entries[0].open.token;
  await assert.rejects(replayPaperDataset(overlap), /token holdout/);
  const alias = structuredClone(overlap);
  alias.entries[0].open.chain = 'sol'; alias.entries[0].open.analysis.chain = 'sol';
  alias.entries[1].open.analysis.address = alias.entries[1].open.token;
  await assert.rejects(replayPaperDataset(alias), Error);
  const temporal = structuredClone(data); temporal.entries[0].open.entryAt = temporal.holdoutStart;
  await assert.rejects(replayPaperDataset(temporal), /temporal holdout/);
  const future = structuredClone(data); future.entries[1].observations['1h']!.observedAt = '2026-01-05T00:00:00Z';
  await assert.rejects(replayPaperDataset(future), /after as-of/);
});
