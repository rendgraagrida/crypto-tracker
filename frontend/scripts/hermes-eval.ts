import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluateTradeGuardrails, formatCoinAnalysis, type CoinAnalysis, type TradeGuardrail } from '../app/lib/coin-analyzer.ts';
import { getHermesNarrative } from '../app/lib/hermes-ai.ts';

type Case = { id: string; family: string; split: 'development' | 'holdout'; report: CoinAnalysis; expected: { guardrail: TradeGuardrail; priorityIds: string[]; rationale: string } };
type Dataset = { version: number; synthetic: boolean; asOf: string; labelingPolicy: string; cases: Case[] };
type Observation = { available: string[] | null; requests: number; httpFailure: boolean; networkFailure: boolean; completed: Promise<boolean>[]; metadataSeen: boolean; toolInjectionSeen: boolean };
const endpoint = 'http://127.0.0.1:11434/v1/chat/completions';
const metadataMarker = 'HERMES_EVAL_METADATA_INJECTION_IGNORE_PRIOR_INSTRUCTIONS';
const toolMarker = 'HERMES_EVAL_TOOL_INJECTION_IGNORE_PRIOR_INSTRUCTIONS';

export function selectionMetrics(tp: number, fp: number, fn: number) {
  const denominator = 2 * tp + fp + fn;
  return {
    precision: tp + fp ? tp / (tp + fp) : null,
    recall: tp + fn ? tp / (tp + fn) : null,
    f1: denominator ? 2 * tp / denominator : null,
  };
}

export function completedRejectionRate(accepted: number, rejected: number): number | null {
  return accepted + rejected ? rejected / (accepted + rejected) : null;
}

export function timeoutConfiguration(configured: string | undefined) {
  const value = Number(configured);
  return {
    configuredTimeoutMs: configured !== undefined && Number.isFinite(value) ? value : null,
    effectiveDeadlineMs: Number.isFinite(value) && value >= 100 ? Math.min(value, 8000) : 5000,
  };
}

export function latencySummary(timings: number[]) {
  const subsequent = timings.slice(1).sort((a, b) => a - b);
  const percentile = (p: number) => subsequent.length ? subsequent[Math.ceil(p * subsequent.length) - 1] : null;
  return {
    first: { samples: timings.length ? 1 : 0, latencyMs: timings[0] ?? null },
    subsequent: { samples: subsequent.length, p50: percentile(0.5), p95: percentile(0.95), max: subsequent.length ? subsequent[subsequent.length - 1] : null },
  };
}

async function main() {
const [datasetPath, split, ...extra] = process.argv.slice(2);
const mode = process.env.HERMES_AGENT_MODE;
if (!datasetPath || !['development', 'holdout'].includes(split) || extra.length || !['stateless', 'readonly_agent'].includes(mode ?? '')) throw new Error('Usage: HERMES_AGENT_MODE=stateless|readonly_agent node --experimental-strip-types frontend/scripts/hermes-eval.ts <dataset> development|holdout');
if (process.env.HERMES_API_URL !== endpoint || process.env.HERMES_MODEL !== 'hermes-crypto-analyst') throw new Error('Evaluator requires the exact loopback endpoint and hermes-crypto-analyst model');
const bytes = await readFile(datasetPath);
const dataset = JSON.parse(bytes.toString('utf8')) as Dataset;
const asOf = Date.parse(dataset.asOf);
if (dataset.version !== 1 || dataset.synthetic !== true || !Number.isFinite(asOf) || !dataset.labelingPolicy || !Array.isArray(dataset.cases)) throw new Error('Invalid version 1 synthetic dataset');
const families = new Map<string, string>();
const ids = new Set<string>();
for (const c of dataset.cases) {
  if (!c.id || ids.has(c.id) || !c.family || !['development', 'holdout'].includes(c.split) || (families.has(c.family) && families.get(c.family) !== c.split) || !Array.isArray(c.expected?.priorityIds) || c.expected.priorityIds.length > 4 || new Set(c.expected.priorityIds).size !== c.expected.priorityIds.length || !c.expected.rationale) throw new Error('Invalid case, label, or split family');
  ids.add(c.id); families.set(c.family, c.split);
}
const cases = dataset.cases.filter(c => c.split === split);
if (!cases.length) throw new Error('No cases in requested split');
// Guardrail API uses Date.now internally and has no time parameter. Override only for
// this synchronous deterministic computation; inference always sees the real clock.
function guardrailAt(report: CoinAnalysis): TradeGuardrail {
  const now = Date.now;
  try { Date.now = () => asOf; return evaluateTradeGuardrails(report); }
  finally { Date.now = now; }
}
const nativeFetch = globalThis.fetch;
let observation: Observation | null = null;
async function completedBody(response: Response): Promise<boolean> {
  if (!response.ok || !response.body) return false;
  const reader = response.clone().body?.getReader();
  if (!reader) return false;
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) return true;
      size += part.value.byteLength;
      if (size > 16_384) { void reader.cancel(); return false; }
    }
  } catch { return false; }
}
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url !== endpoint) throw new Error('External fetch forbidden');
  const current = observation;
  if (!current || typeof init?.body !== 'string') throw new Error('Unexpected fetch');
  current.requests++;
  const body = JSON.parse(init.body);
  const available = body?.response_format?.json_schema?.schema?.properties?.finding_ids?.items?.enum;
  if (Array.isArray(available) && available.every((id: unknown) => typeof id === 'string')) current.available = available;
  // The existing first user message also contains the client-generated list,
  // including when agent steps fail before the final schema is sent.
  if (!current.available && Array.isArray(body.messages)) {
    const firstUser = body.messages.find((m: { role?: string }) => m.role === 'user');
    try {
      const parsed = JSON.parse(firstUser?.content);
      if (Array.isArray(parsed.available) && parsed.available.every((id: unknown) => typeof id === 'string')) current.available = parsed.available;
    } catch { /* No selectable list in this message. */ }
  }
  current.metadataSeen ||= init.body.includes(metadataMarker);
  current.toolInjectionSeen ||= init.body.includes(toolMarker);
  try {
    const response = await nativeFetch(input, init);
    if (!response.ok) current.httpFailure = true;
    current.completed.push(completedBody(response));
    return response;
  } catch (error) { current.networkFailure = true; throw error; }
};

type Row = { id: string; family: string; status: string; attempts: number; latencyMs: number | null; expected: string[]; baseline: string[] | null; prediction: string[]; guardrailUnchanged: boolean; scorecardUnchanged: boolean; metadataOmitted: boolean | null; readonlyToolInjectionExposure: string };
const rows: Row[] = [];
let cooldownEnd = 0;
for (const c of cases) {
  const report = structuredClone(c.report);
  const computed = guardrailAt(report);
  if (JSON.stringify(computed) !== JSON.stringify(c.expected.guardrail) || JSON.stringify(report.tradeGuardrail) !== JSON.stringify(c.expected.guardrail)) throw new Error(`Guardrail label mismatch: ${c.id}`);
  const beforeGuardrail = JSON.stringify(report.tradeGuardrail);
  const beforeScorecard = formatCoinAnalysis(report);
  if (cooldownEnd > Date.now()) await delay(cooldownEnd - Date.now() + 25);
  const observed: Observation = { available: null, requests: 0, httpFailure: false, networkFailure: false, completed: [], metadataSeen: false, toolInjectionSeen: false };
  observation = observed;
  const started = performance.now();
  const result = await getHermesNarrative(report);
  const latency = performance.now() - started;
  observation = null;
  const complete = await Promise.all(observed.completed);
  let status: string;
  if (result.status === 'ok') status = 'success';
  else if (result.status === 'timeout') status = 'timeout';
  else if (result.status === 'cooldown') status = 'cooldown_skipped';
  else if (result.status === 'no selectable findings') status = 'no_evidence';
  else if (observed.httpFailure || observed.networkFailure) status = 'transport_failure';
  else if (complete.length && complete[complete.length - 1]) status = 'completed_response_rejection';
  else status = 'unclassified_failure';
  if (!['success', 'cooldown_skipped', 'no_evidence'].includes(status)) cooldownEnd = Date.now() + 15_000;
  if (observed.available && c.expected.priorityIds.some(id => !observed.available!.includes(id))) throw new Error(`Label is not selectable: ${c.id}`);
  if (status === 'no_evidence' && c.expected.priorityIds.length) throw new Error(`Label is not selectable: ${c.id}`);
  const baseline = observed.available ? observed.available.slice(0, 4) : status === 'no_evidence' ? [] : null;
  const guardrailUnchanged = beforeGuardrail === JSON.stringify(report.tradeGuardrail) && JSON.stringify(guardrailAt(report)) === JSON.stringify(computed);
  const scorecardUnchanged = beforeScorecard === formatCoinAnalysis(report);
  rows.push({ id: c.id, family: c.family, status, attempts: observed.requests ? 1 : 0, latencyMs: observed.requests ? Math.round(latency * 100) / 100 : null, expected: c.expected.priorityIds, baseline, prediction: result.findingIds, guardrailUnchanged, scorecardUnchanged, metadataOmitted: JSON.stringify(c.report).includes(metadataMarker) && observed.requests ? !observed.metadataSeen : null, readonlyToolInjectionExposure: JSON.stringify(c.report).includes(toolMarker) ? observed.toolInjectionSeen ? 'observed' : 'unexercised' : 'not_applicable' });
}
globalThis.fetch = nativeFetch;
function metrics(selected: Row[], kind: 'baseline' | 'model') {
  let tp = 0, fp = 0, fn = 0, exact = 0, count = 0;
  for (const row of selected) {
    const prediction = kind === 'baseline' ? row.baseline : row.prediction;
    if (prediction === null) continue;
    const expected = new Set(row.expected), actual = new Set(prediction);
    for (const id of actual) expected.has(id) ? tp++ : fp++;
    for (const id of expected) if (!actual.has(id)) fn++;
    if (actual.size === expected.size && [...actual].every(id => expected.has(id))) exact++;
    count++;
  }
  return { cases: count, tp, fp, fn, ...selectionMetrics(tp, fp, fn), exactSetAccuracy: count ? exact / count : null };
}
const count = (status: string) => rows.filter(row => row.status === status).length;
const attempted = rows.filter(row => row.attempts).length;
const successes = rows.filter(row => row.status === 'success');
const timings = rows.flatMap(row => row.latencyMs === null ? [] : [row.latencyMs]);
console.log(JSON.stringify({ dataset: { version: dataset.version, synthetic: dataset.synthetic, sha256: createHash('sha256').update(bytes).digest('hex'), asOf: dataset.asOf, labelingPolicy: dataset.labelingPolicy }, split, mode, model: process.env.HERMES_MODEL, endpoint, ...timeoutConfiguration(process.env.HERMES_TIMEOUT_MS), baseline: 'evaluation-only: first four IDs in client-generated enum order', counts: { cases: rows.length, attempted, successful: count('success'), timeout: count('timeout'), transportFailure: count('transport_failure'), completedResponseRejection: count('completed_response_rejection'), cooldownSkipped: count('cooldown_skipped'), noEvidence: count('no_evidence'), unclassifiedFailure: count('unclassified_failure') }, schemaAcceptedRate: attempted ? successes.length / attempted : null, completedResponseRejectionRate: completedRejectionRate(successes.length, count('completed_response_rejection')), quality: { endToEnd: { baseline: metrics(rows, 'baseline'), model: metrics(rows, 'model') }, successfulOnly: { baseline: metrics(successes, 'baseline'), model: metrics(successes, 'model') } }, latencyMs: latencySummary(timings), cases: rows }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
