import assert from 'node:assert/strict';
import { test } from 'node:test';
import { limit, unknown, type ModelCapabilities } from '../src/providers/capabilities.ts';
import type { LedgerEvent } from '../src/providers/ledger.ts';
import { SIM_NOW, simulate } from '../src/routing/simulate.ts';

// Behavioural: "given this task shape, quota state and budget, which model would AdamOS pick, and why?"
// Uses the real capability table and the real preflight — no network, no clock.

const allHealthy = { groq: true, gemini: true, 'claude-cli': true };
const noClaude = { groq: true, gemini: true, 'claude-cli': false };
const iso = (msAgo: number) => new Date(SIM_NOW - msAgo).toISOString();

test('large context: Groq (14k-char window) is eliminated for context; a Gemini model is chosen', () => {
  const d = simulate({ requirements: { tier: 'strong', promptChars: 60_000 }, health: noClaude });
  for (const k of ['groq/openai/gpt-oss-20b', 'groq/openai/gpt-oss-120b']) {
    const c = d.eliminated.find((c) => c.key === k)!;
    assert.equal(c.eliminated!.reason, 'context_too_small', `${k} must be refused for a 60k-char prompt`);
  }
  assert.ok(d.selected && d.selected.key.startsWith('gemini/'), d.explanation);
});

test('small context: everything healthy is feasible; the strong-tier request prefers claude-cli when it is available', () => {
  const d = simulate({ requirements: { tier: 'strong', promptChars: 5_000 }, health: allHealthy });
  assert.equal(d.eliminated.length, 0);
  assert.equal(d.selected?.key, 'claude-cli/opus');
  const light = simulate({ requirements: { tier: 'light', promptChars: 5_000 }, health: noClaude });
  assert.ok(light.remaining.some((c) => c.key === 'groq/openai/gpt-oss-20b'), 'groq is feasible for a small prompt');
});

test('tool-required task refuses a model without tool calling, and json output refuses one without structured output', () => {
  const noTools: ModelCapabilities = { provider: 'gemini', model: 'no-tools', key: 'gemini/no-tools', tier: 'strong', mode: 'chat', contextTokens: limit(1_000_000, 'documented'), maxOutputTokens: unknown(), toolCalling: false, structuredOutput: false, pricing: null, rpm: unknown(), tpm: unknown(), rpd: unknown(), tpd: unknown(), promptCharBudget: limit(500_000, 'documented'), minIntervalMs: 0 };
  const d = simulate({ requirements: { tier: 'strong', promptChars: 5_000, needsTools: true }, health: noClaude, capabilities: [noTools] });
  assert.equal(d.eliminated.find((c) => c.key === 'gemini/no-tools')?.eliminated?.reason, 'no_tool_calling');
  const j = simulate({ requirements: { tier: 'strong', promptChars: 5_000, needsTools: false, needsJson: true }, health: allHealthy });
  assert.ok(j.eliminated.filter((c) => c.key.startsWith('claude-cli/')).every((c) => c.eliminated!.reason === 'no_structured_output'));
});

test('high-reasoning (strong) task ranks a strong-tier model above light ones even when both are feasible', () => {
  const d = simulate({ requirements: { tier: 'strong', promptChars: 5_000 }, health: noClaude });
  assert.equal(d.selected?.key, 'gemini/gemini-3-flash-preview');
  const flashLite = d.remaining.find((c) => c.key === 'gemini/gemini-3.1-flash-lite')!;
  assert.ok(flashLite.tierFit < 1 && flashLite.score < d.selected!.score);
});

test('nearly exhausted daily quota: a model with fewer than 2 requests left is eliminated; the loop is told to finish', () => {
  const d = simulate({ requirements: { tier: 'standard', promptChars: 5_000 }, health: noClaude, requestsToday: { 'gemini/gemini-2.5-flash': 19, 'gemini/gemini-3-flash-preview': 20 } });
  assert.equal(d.eliminated.find((c) => c.key === 'gemini/gemini-2.5-flash')?.eliminated?.reason, 'rpd_exhausted');
  assert.equal(d.eliminated.find((c) => c.key === 'gemini/gemini-3-flash-preview')?.eliminated?.reason, 'rpd_exhausted');
  assert.ok(d.remaining.some((c) => c.key === 'gemini/gemini-3.1-flash-lite'), 'the uncapped model stays feasible');
  assert.ok(['gemini/gemini-3.1-flash-lite', 'groq/openai/gpt-oss-120b'].includes(d.selected!.key), 'selection is among the uncapped models');
});

test('rate-limited provider: a recent 429 puts the model in a temporary cooldown; it is skipped, then usable again later', () => {
  const events: LedgerEvent[] = [{ ts: iso(10_000), key: 'gemini/gemini-2.5-flash', kind: 'failure', category: 'rate_limit', status: 429 }];
  const d = simulate({ requirements: { tier: 'standard', promptChars: 5_000 }, health: noClaude, ledgerEvents: events });
  const c = d.eliminated.find((c) => c.key === 'gemini/gemini-2.5-flash')!;
  assert.equal(c.eliminated!.reason, 'cooldown');
  assert.ok(d.nextCooldownEndsAt && d.nextCooldownEndsAt > SIM_NOW);
  const later = simulate({ requirements: { tier: 'standard', promptChars: 5_000 }, health: noClaude, ledgerEvents: events, now: SIM_NOW + 20 * 60_000 });
  assert.ok(later.remaining.some((c) => c.key === 'gemini/gemini-2.5-flash'), 'cooldown expired: not a blacklist');
  const daily: LedgerEvent[] = [{ ts: iso(10_000), key: 'gemini/gemini-2.5-flash', kind: 'failure', category: 'daily_quota', status: 429 }];
  const dq = simulate({ requirements: { tier: 'standard', promptChars: 5_000 }, health: noClaude, ledgerEvents: daily, now: SIM_NOW + 5 * 60 * 60_000 });
  assert.equal(dq.eliminated.find((c) => c.key === 'gemini/gemini-2.5-flash')?.eliminated?.reason, 'cooldown', 'daily quota cools down until the day rolls over');
});

test('unavailable provider: every model of an unhealthy provider is eliminated with provider_unhealthy', () => {
  const d = simulate({ requirements: { tier: 'strong', promptChars: 5_000 }, health: { groq: true, gemini: false, 'claude-cli': false } });
  assert.ok(d.eliminated.filter((c) => c.key.startsWith('gemini/')).every((c) => c.eliminated!.reason === 'provider_unhealthy'));
  assert.ok(d.selected?.key.startsWith('groq/'), 'the only healthy provider is chosen even though it is a weaker tier');
});

test('expensive but reliable beats cheap but unreliable: history changes the ranking', () => {
  const cheap: ModelCapabilities = { provider: 'gemini', model: 'cheap', key: 'gemini/cheap', tier: 'standard', mode: 'chat', contextTokens: limit(1_000_000, 'documented'), maxOutputTokens: unknown(), toolCalling: true, structuredOutput: true, pricing: { input: 0.05, output: 0.10, source: 'documented' }, rpm: unknown(), tpm: unknown(), rpd: unknown(), tpd: unknown(), promptCharBudget: limit(500_000, 'documented'), minIntervalMs: 0 };
  const pricey: ModelCapabilities = { ...cheap, model: 'pricey', key: 'gemini/pricey', pricing: { input: 3, output: 15, source: 'documented' } };
  const health = { gemini: true, groq: false, 'claude-cli': false };
  const req = { tier: 'standard' as const, promptChars: 20_000, expectedCalls: 6 };
  const fresh = simulate({ requirements: req, health, capabilities: [cheap, pricey], requestsToday: { 'gemini/gemini-2.5-flash': 20, 'gemini/gemini-3-flash-preview': 20, 'gemini/gemini-3.1-flash-lite': 20 } });
  assert.equal(fresh.selected?.key, 'gemini/cheap', 'with no history, cheaper wins');
  const events: LedgerEvent[] = [];
  for (let i = 0; i < 6; i++) events.push({ ts: iso(60_000 * (i + 30)), key: 'gemini/cheap', kind: 'failure', category: 'malformed_response' });
  for (let i = 0; i < 4; i++) events.push({ ts: iso(60_000 * (i + 30)), key: 'gemini/pricey', kind: 'success' });
  events.push({ ts: iso(60_000 * 20), key: 'gemini/cheap', kind: 'success' }); // clears cooldown but not the record
  const seasoned = simulate({ requirements: req, health, capabilities: [cheap, pricey], ledgerEvents: events, requestsToday: { 'gemini/gemini-2.5-flash': 20, 'gemini/gemini-3-flash-preview': 20, 'gemini/gemini-3.1-flash-lite': 20 } });
  assert.equal(seasoned.selected?.key, 'gemini/pricey', 'a cheap model that keeps failing is not cheaper in practice');
  const c = seasoned.remaining.find((c) => c.key === 'gemini/cheap')!;
  assert.ok(c.reliability < 0.4 && c.estimatedCostUsd! < seasoned.selected!.estimatedCostUsd!);
});

test('budget: a step whose estimate exceeds the remaining task budget is refused; unknown-price models are not silently free', () => {
  const d = simulate({ requirements: { tier: 'standard', promptChars: 100_000, expectedCalls: 16, budget: { remainingCostUsd: 0.01, remainingCalls: 5, maxCostUsd: 2 } }, health: noClaude });
  assert.equal(d.eliminated.find((c) => c.key === 'gemini/gemini-2.5-flash')?.eliminated?.reason, 'budget_cost');
  const unknownPrice = d.remaining.find((c) => c.key === 'gemini/gemini-3-flash-preview');
  assert.ok(unknownPrice && unknownPrice.estimatedCostUsd === null && unknownPrice.costFactor < 1, 'unknown price is allowed but ranked as uncertain, never as $0');
  const noCalls = simulate({ requirements: { tier: 'standard', promptChars: 5_000, budget: { remainingCostUsd: 2, remainingCalls: 0, maxCostUsd: 2 } }, health: noClaude });
  assert.equal(noCalls.selected, undefined);
  assert.ok(noCalls.eliminated.filter((c) => c.key.startsWith('gemini/')).every((c) => c.eliminated!.reason === 'budget_calls'), 'healthy, fitting models are refused for lack of calls');
});

test('no feasible provider: everything capped or unhealthy yields no selection and an explanation naming each reason', () => {
  const d = simulate({
    requirements: { tier: 'strong', promptChars: 40_000 },
    health: { groq: true, gemini: true, 'claude-cli': false },
    requestsToday: { 'gemini/gemini-2.5-flash': 20, 'gemini/gemini-3-flash-preview': 20, 'gemini/gemini-3.1-flash-lite': 20 },
    tokensToday: { groq: 199_000 },
  });
  assert.equal(d.selected, undefined);
  assert.match(d.explanation, /no feasible model/);
  assert.match(d.explanation, /groq\/openai\/gpt-oss-20b \(context_too_small\)/);
  assert.match(d.explanation, /gemini-2.5-flash \(rpd_exhausted\)/);
  assert.match(d.explanation, /claude-cli\/sonnet \(provider_unhealthy\)/);
});

test('the exact first-dogfood failure: 17k-token history after a Gemini 429 must NOT fall back to Groq', () => {
  // Reconstruct the 2026-09-18 state: Gemini 2.5-flash and 3-flash-preview just 429'd on their DAILY cap, history ≈ 68k chars.
  const events: LedgerEvent[] = [
    { ts: iso(5_000), key: 'gemini/gemini-3-flash-preview', kind: 'failure', category: 'daily_quota', status: 429 },
    { ts: iso(2_000), key: 'gemini/gemini-2.5-flash', kind: 'failure', category: 'daily_quota', status: 429 },
  ];
  const d = simulate({ requirements: { tier: 'strong', promptChars: 68_000, expectedCalls: 6 }, health: noClaude, ledgerEvents: events, requestsToday: { 'gemini/gemini-3.1-flash-lite': 20 } });
  assert.equal(d.selected, undefined, 'before: groq got a 413; after: nothing is selected and the caller shrinks the history instead');
  assert.equal(d.eliminated.find((c) => c.key === 'groq/openai/gpt-oss-120b')?.eliminated?.reason, 'context_too_small');
  // Once the history is shrunk to what Groq can take, it becomes a legitimate fallback.
  const shrunk = simulate({ requirements: { tier: 'strong', promptChars: 12_000, expectedCalls: 6 }, health: noClaude, ledgerEvents: events, requestsToday: { 'gemini/gemini-3.1-flash-lite': 20 } });
  assert.ok(shrunk.selected?.key.startsWith('groq/'));
});
