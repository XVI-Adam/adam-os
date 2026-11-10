import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProviderError, parseArgs, parseRetryAfter, withRetry } from '../src/providers/types.ts';

test('parseRetryAfter reads headers and Gemini RetryInfo bodies, clamped to 90s', () => {
  assert.equal(parseRetryAfter('7', ''), 7000);
  assert.equal(parseRetryAfter(null, '{"error":{"details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"23s"}]}}'), 23000);
  assert.equal(parseRetryAfter(null, 'Please retry in 500s'), 90000);
  assert.equal(parseRetryAfter(null, 'nothing here'), undefined);
});

test('withRetry retries only retryable errors, bounded, and honours retryAfterMs', async () => {
  let calls = 0;
  const waits: number[] = [];
  const v = await withRetry(async () => { calls++; if (calls < 3) throw new ProviderError('429', 429, true, 10); return 'ok'; }, { baseMs: 1, maxMs: 2, onRetry: (_e, w) => waits.push(w) });
  assert.equal(v, 'ok'); assert.equal(calls, 3);
  assert.ok(waits.every((w) => w >= 10));
  calls = 0;
  await assert.rejects(withRetry(async () => { calls++; throw new ProviderError('bad request', 400, false); }, { baseMs: 1 }), /bad request/);
  assert.equal(calls, 1, 'non-retryable errors are not retried');
  calls = 0;
  await assert.rejects(withRetry(async () => { calls++; throw new ProviderError('down', 503, true); }, { attempts: 3, baseMs: 1, maxMs: 2 }), /down/);
  assert.equal(calls, 3, 'retries are bounded by attempts');
});

test('parseArgs tolerates malformed tool arguments without throwing', () => {
  assert.deepEqual(parseArgs('{"a":1}').args, { a: 1 });
  assert.match(parseArgs('{oops').error!, /not valid JSON/);
  assert.match(parseArgs(42).error!, /missing/);
  assert.match(parseArgs('"str"').error!, /not an object/);
});

test('resolve skips models whose prompt budget is too small and models at their daily request cap (hermetic)', async () => {
  const { FakeProvider, registryWith } = await import('./helpers.ts');
  const { loadConfig } = await import('../src/config.ts');
  const { recordModelRequest } = await import('../src/quota.ts');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  loadConfig().dataDir = mkdtempSync(join(tmpdir(), 'adamos-quota-'));
  const small = new FakeProvider([], 'a-small', { tier: 'light', promptCharBudget: 14_000 });
  const roomy = new FakeProvider([], 'b-roomy', { tier: 'light', promptCharBudget: 400_000, rpd: 3 });
  const r = registryWith(small, roomy);
  assert.equal(r.resolve('light', { needsTools: true, promptChars: 5_000 })?.provider.id, 'a-small', 'a small prompt goes to the first feasible model');
  assert.equal(r.resolve('light', { needsTools: true, promptChars: 50_000 })?.provider.id, 'b-roomy', 'a 50k prompt skips the 14k window');
  assert.equal(r.resolve('light', { needsTools: true, promptChars: 1_000_000 }), undefined, 'nothing takes a 1M-char prompt');
  for (let i = 0; i < 3; i++) recordModelRequest('b-roomy/fake-model');
  assert.equal(r.resolve('light', { needsTools: true, promptChars: 50_000 }), undefined, 'the roomy model is at its daily cap');
  const status = r.modelStatus();
  assert.match(status.find((s) => s.model === 'b-roomy/fake-model')!.reason, /rpd_exhausted/);
});

test('Groq error classification: 429/5xx and gpt-oss malformed tool calls retry; 413 and plain 400 do not', async () => {
  const { isRetryableGroqError } = await import('../src/providers/groq.ts');
  assert.equal(isRetryableGroqError(429, ''), true);
  assert.equal(isRetryableGroqError(503, ''), true);
  assert.equal(isRetryableGroqError(400, '{"error":{"code":"tool_use_failed"}}'), true);
  assert.equal(isRetryableGroqError(400, '{"error":{"code":"output_parse_failed"}}'), true);
  assert.equal(isRetryableGroqError(413, 'Request too large'), false);
  assert.equal(isRetryableGroqError(400, '{"error":{"code":"invalid_request_error"}}'), false);
  assert.equal(isRetryableGroqError(401, ''), false);
});
