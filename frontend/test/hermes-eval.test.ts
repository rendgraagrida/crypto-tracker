import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completedRejectionRate, latencySummary, selectionMetrics, timeoutConfiguration } from '../scripts/hermes-eval.ts';

test('micro F1 has its own denominator when predictions or labels are empty', () => {
  assert.deepEqual(selectionMetrics(0, 0, 8), { precision: null, recall: 0, f1: 0 });
  assert.deepEqual(selectionMetrics(0, 3, 0), { precision: 0, recall: null, f1: 0 });
  assert.deepEqual(selectionMetrics(0, 0, 0), { precision: null, recall: null, f1: null });
  assert.equal(selectionMetrics(2, 1, 3).f1, 0.5);
});

test('completed-response rejection rate excludes noncompleted attempts', () => {
  // One accepted, one rejected, and a timeout: the timeout is not a completed response.
  assert.equal(completedRejectionRate(1, 1), 0.5);
  assert.equal(completedRejectionRate(0, 0), null);
  assert.equal(completedRejectionRate(0, 2), 1);
});

test('configured timeout and effective client deadline are distinguished', () => {
  assert.deepEqual(timeoutConfiguration('12000'), { configuredTimeoutMs: 12000, effectiveDeadlineMs: 8000 });
  assert.deepEqual(timeoutConfiguration('99'), { configuredTimeoutMs: 99, effectiveDeadlineMs: 5000 });
  assert.deepEqual(timeoutConfiguration('100'), { configuredTimeoutMs: 100, effectiveDeadlineMs: 100 });
  assert.deepEqual(timeoutConfiguration('invalid'), { configuredTimeoutMs: null, effectiveDeadlineMs: 5000 });
  assert.deepEqual(timeoutConfiguration(undefined), { configuredTimeoutMs: null, effectiveDeadlineMs: 5000 });
});

test('latency summary uses request order without assuming model residency', () => {
  assert.deepEqual(latencySummary([15, 30, 10]), { first: { samples: 1, latencyMs: 15 }, subsequent: { samples: 2, p50: 10, p95: 30, max: 30 } });
  assert.deepEqual(latencySummary([]), { first: { samples: 0, latencyMs: null }, subsequent: { samples: 0, p50: null, p95: null, max: null } });
});
