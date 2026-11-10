import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_PROGRESS_POLICY, ProgressTracker, READ_ONLY_PROGRESS_POLICY } from '../src/agents/progress.ts';
import { ProviderLedger, categorize } from '../src/providers/ledger.ts';

const T0 = Date.UTC(2026, 8, 18, 12, 0, 0);

test('failures are categorised by status and message', () => {
  assert.equal(categorize({ status: 429, message: 'rate' }), 'rate_limit');
  assert.equal(categorize({ status: 429, message: 'GenerateRequestsPerDayPerProjectPerModel' }), 'daily_quota');
  assert.equal(categorize({ status: 413, message: 'Request too large' }), 'context_overflow');
  assert.equal(categorize({ status: 0, message: 'request timed out' }), 'timeout');
  assert.equal(categorize({ status: 408, message: 'x' }), 'timeout');
  assert.equal(categorize({ status: 500, message: 'x' }), 'server_error');
  assert.equal(categorize({ status: 503, message: 'high demand' }), 'unavailable');
  assert.equal(categorize({ status: 400, message: 'tool_use_failed' }), 'tool_call_failure');
  assert.equal(categorize({ status: 400, message: 'output_parse_failed' }), 'malformed_response');
  assert.equal(categorize({ status: 401, message: 'OAuth access token is invalid' }), 'auth');
  assert.equal(categorize({ message: 'weird' }), 'unknown');
});

test('cooldowns are temporary, escalate with repeats, honour retry hints, and clear on success', () => {
  const l = new ProviderLedger();
  l.recordFailure('p/m', { status: 429, message: 'rate' }, { now: T0 });
  const c1 = l.cooldown('p/m', T0 + 1000)!;
  assert.equal(c1.category, 'rate_limit');
  assert.ok(c1.until - T0 === 60_000, 'first 429: 60s');
  assert.equal(l.cooldown('p/m', T0 + 61_000), undefined, 'expired');
  l.recordFailure('p/m', { status: 429, message: 'rate' }, { now: T0 + 61_000 });
  assert.ok(l.cooldown('p/m', T0 + 62_000)!.until - (T0 + 61_000) === 120_000, 'second consecutive 429 doubles');
  l.recordFailure('p/m', { status: 429, message: 'rate', retryAfterMs: 300_000 }, { now: T0 + 200_000 });
  assert.ok(l.cooldown('p/m', T0 + 201_000)!.until - (T0 + 200_000) === 300_000, 'server retry hint wins when larger');
  l.recordSuccess('p/m', { now: T0 + 202_000 });
  assert.equal(l.cooldown('p/m', T0 + 203_000), undefined, 'a success clears the cooldown');
  l.recordFailure('p/m', { status: 429, message: 'rate' }, { now: T0 + 300_000 });
  assert.ok(l.cooldown('p/m', T0 + 301_000)!.until - (T0 + 300_000) === 60_000, 'streak reset by the success');
});

test('context overflow shrinks the observed prompt budget instead of cooling down; reliability is Laplace-smoothed', () => {
  const l = new ProviderLedger();
  l.recordFailure('p/m', { status: 413, message: 'too large' }, { promptChars: 40_000, now: T0 });
  assert.equal(l.cooldown('p/m', T0 + 1), undefined);
  assert.equal(l.observedPromptCharLimit('p/m', T0 + 1), 36_000);
  assert.equal(l.history('p/m', T0 + 1).reliability, (0 + 2) / (0 + 1 + 4));
  for (let i = 0; i < 8; i++) l.recordSuccess('p/m', { now: T0 + 2 + i });
  assert.ok(l.history('p/m', T0 + 100).reliability > 0.75);
  assert.equal(l.history('never/seen').reliability, 0.5);
});

test('daily quota cools down until the next UTC day', () => {
  const l = new ProviderLedger();
  l.recordFailure('p/m', { status: 429, message: 'GenerateRequestsPerDay' }, { now: T0 });
  const c = l.cooldown('p/m', T0 + 60 * 60_000)!;
  assert.equal(new Date(c.until).toISOString(), '2026-09-19T00:00:00.000Z');
  assert.equal(l.cooldown('p/m', Date.UTC(2026, 8, 19, 0, 0, 1)), undefined);
});

test('progress policy: reads are not progress; a checkpoint is demanded, then finish is forced; edits reset the clock', () => {
  const t = new ProgressTracker(DEFAULT_PROGRESS_POLICY);
  const read = (p: string) => ({ toolCalls: [{ name: 'read_file', args: { path: p }, ok: true }], text: '' });
  assert.equal(t.record(read('a')), 'stall');
  assert.equal(t.record(read('b')), 'stall');
  assert.equal(t.record(read('c')), 'stall');
  assert.equal(t.record(read('d')), 'checkpoint_due');
  assert.equal(t.checkpoints, 1);
  // A real checkpoint answer buys one more window.
  assert.equal(t.record({ toolCalls: [], text: 'x'.repeat(120), answeringCheckpoint: true }), 'progress');
  assert.equal(t.record(read('e')), 'stall');
  assert.equal(t.record(read('a')), 'stall', 'repeated read counts double');
  assert.equal(t.record(read('f')), 'force_finish');
  assert.equal(t.repeatedReads, 1);
  const t2 = new ProgressTracker(DEFAULT_PROGRESS_POLICY);
  t2.record(read('a')); t2.record(read('b')); t2.record(read('c'));
  assert.equal(t2.record({ toolCalls: [{ name: 'edit_file', args: { path: 'a' }, ok: true }], text: '' }), 'progress');
  assert.equal(t2.turnsSinceProgress, 0);
  assert.equal(new ProgressTracker(READ_ONLY_PROGRESS_POLICY).policy.maxCheckpoints, 2);
});
