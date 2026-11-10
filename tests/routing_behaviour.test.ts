import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runAgent } from '../src/agents/index.ts';
import { BudgetManager } from '../src/budget.ts';
import { buildContext } from '../src/context/manager.ts';
import { createTask, runTask } from '../src/orchestrator.ts';
import { ProviderError } from '../src/providers/types.ts';
import type { VerificationPlan, VerificationResult } from '../src/types.ts';
import { FakeProvider, finishCall, registryWith, tmpProject, tmpStore } from './helpers.ts';

// Behavioural proofs for provider-aware orchestration: what AdamOS refuses, what it
// falls back to, and how it stops when nothing feasible exists.

const okVerify = async (plan: VerificationPlan): Promise<VerificationResult> => ({ id: plan.id, kind: plan.kind, label: plan.label, command: plan.command, passed: true, exitCode: 0, durationMs: 1, outputTail: '' });
const budget = (over: Partial<ConstructorParameters<typeof BudgetManager>[0]> = {}) => new BudgetManager({ maxCostUsd: 5, maxAgentCalls: 50, maxRetries: 1, maxToolCalls: 100, maxWallClockMs: 60_000, ...over });
const read = (i: number, path = `src/f${i}.ts`) => ({ toolCalls: [{ id: `r${i}`, name: 'read_file', args: { path } }] });

function agentInput(project = tmpProject(), role: 'coding' | 'research' = 'coding', charBudget?: number) {
  const context = buildContext({ project, task: 'inspect greet', role, tier: 'light', priorSteps: [], failures: [], charBudget });
  return { role, goal: 'do the thing', taskDescription: 'inspect', project, tier: 'light' as const, context, budget: budget(), rebuildContext: (cb: number) => buildContext({ project, task: 'inspect greet', role, tier: 'light', priorSteps: [], failures: [], charBudget: cb }) };
}

test('refuses an infeasible model before the step starts: a tiny-window model never sees a prompt it cannot take', async () => {
  const tiny = new FakeProvider([finishCall({})], 'a-tiny', { tier: 'light', promptCharBudget: 2_000 });
  const roomy = new FakeProvider([finishCall({ summary: 'roomy did it' })], 'b-roomy', { tier: 'light', promptCharBudget: 400_000 });
  const out = await runAgent({ ...agentInput(), registry: registryWith(tiny, roomy) });
  assert.equal(out.provider, 'b-roomy');
  assert.equal(tiny.requests.length, 0, 'the tiny model was never called');
  const decisions = (out.routing as { decisions: Array<{ eliminated: Array<{ model: string; reason: string }> }> }).decisions;
  assert.equal(decisions[0].eliminated.find((e) => e.model === 'a-tiny/fake-model')?.reason, 'context_too_small');
});

test('does not fall back to an incompatible model: after a 503 the fallback must fit the CURRENT history, and the history is shrunk for it', async () => {
  const project = tmpProject();
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  for (let i = 0; i < 3; i++) writeFileSync(join(project.repository, 'src', `f${i}.ts`), `// file ${i}\n` + 'z'.repeat(9_000));
  // big: reads three 9k files (history ≈ 30k+), then dies. small: 16k window — can only take the history once it is pruned.
  const big = new FakeProvider([read(0), read(1), read(2), new ProviderError('high demand', 503, true)], 'a-big', { tier: 'light', promptCharBudget: 400_000 });
  const small = new FakeProvider([finishCall({ summary: 'small finished' })], 'b-small', { tier: 'light', promptCharBudget: 16_000 });
  const registry = registryWith(big, small);
  const events: Array<Record<string, unknown>> = [];
  const out = await runAgent({ ...agentInput(project), registry, onEvent: (type, p) => events.push({ type, ...p }) });
  assert.equal(out.status, 'done');
  assert.equal(out.provider, 'b-small');
  const sent = small.requests[0].messages.reduce((a, m) => a + m.content.length, 0);
  assert.ok(sent <= 16_000, `history handed to the fallback (${sent} chars) must fit its window`);
  assert.ok(small.requests[0].messages.some((m) => m.role === 'tool' && m.content.startsWith('[elided')), 'older tool outputs were elided, not dropped silently');
  const fb = events.find((e) => e.type === 'routing.decision' && e.phase === 'fallback')!;
  assert.ok(fb, 'the fallback decision was logged with its eliminations');
});

test('stops gracefully when no feasible model exists for the fallback: the step errors, nothing incompatible is called', async () => {
  const project = tmpProject();
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  writeFileSync(join(project.repository, 'src', 'f0.ts'), 'z'.repeat(9_000));
  const big = new FakeProvider([read(0), new ProviderError('overloaded', 503, true)], 'a-big', { tier: 'light', promptCharBudget: 400_000 });
  const minuscule = new FakeProvider([finishCall({})], 'b-minuscule', { tier: 'light', promptCharBudget: 1_000 });
  const out = await runAgent({ ...agentInput(project), registry: registryWith(big, minuscule) });
  assert.equal(out.status, 'error');
  assert.equal(minuscule.requests.length, 0);
  assert.match(out.error!, /provider error/);
});

test('respects quotas: a model at its daily request cap is never selected; with one request left the loop finishes immediately', async () => {
  const capped = new FakeProvider([finishCall({ summary: 'should not run' })], 'a-capped', { tier: 'light', rpd: 5 });
  const free = new FakeProvider([finishCall({ summary: 'free ran' })], 'b-free', { tier: 'light' });
  const registry = registryWith(capped, free);
  const { recordModelRequest } = await import('../src/quota.ts');
  // Quota counters are per UTC day and live in the data dir; simulate 5 used requests for 'a-capped'.
  const { loadConfig } = await import('../src/config.ts');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  loadConfig().dataDir = mkdtempSync(join(tmpdir(), 'adamos-quota-'));
  for (let i = 0; i < 5; i++) recordModelRequest('a-capped/fake-model');
  const out = await runAgent({ ...agentInput(), registry });
  assert.equal(out.provider, 'b-free');
  assert.equal(capped.requests.length, 0);
  // Now 'a-capped' with exactly one request left: it may be chosen, but only for a finish-only turn.
  loadConfig().dataDir = mkdtempSync(join(tmpdir(), 'adamos-quota-'));
  for (let i = 0; i < 3; i++) recordModelRequest('a-capped/fake-model');
  const capped2 = new FakeProvider([read(0), finishCall({ summary: 'wrapped up' })], 'a-capped', { tier: 'light', rpd: 5 });
  const only = registryWith(capped2);
  const out2 = await runAgent({ ...agentInput(), registry: only });
  assert.equal(out2.status, 'done');
  assert.ok(capped2.requests.length <= 2);
  assert.deepEqual(capped2.requests[capped2.requests.length - 1].tools?.map((t) => t.name), ['finish'], 'the last allowed request is a forced finish');
});

test('respects budgets: a step whose estimate exceeds the remaining cost is refused before any call', async () => {
  const pricey = new FakeProvider([finishCall({})], 'a-pricey', { tier: 'light', pricing: { input: 100, output: 100 } });
  const cheap = new FakeProvider([finishCall({ summary: 'cheap did it' })], 'b-cheap', { tier: 'light', pricing: { input: 0.01, output: 0.01 } });
  const out = await runAgent({ ...agentInput(), registry: registryWith(pricey, cheap), budget: budget({ maxCostUsd: 0.02 }) });
  assert.equal(out.provider, 'b-cheap');
  assert.equal(pricey.requests.length, 0);
  const decisions = (out.routing as { decisions: Array<{ eliminated: Array<{ model: string; reason: string }> }> }).decisions;
  assert.equal(decisions[0].eliminated.find((e) => e.model === 'a-pricey/fake-model')?.reason, 'budget_cost');
});

test('detects runaway agents: reads without progress trigger a checkpoint, then a forced finish, well under the step limit', async () => {
  const project = tmpProject();
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  for (let i = 0; i < 12; i++) writeFileSync(join(project.repository, 'src', `f${i}.ts`), `// ${i}\n`);
  const script = Array.from({ length: 12 }, (_, i) => read(i));
  script.push(finishCall({ summary: 'forced summary' }) as never);
  const fake = new FakeProvider(script, 'a-fake', { tier: 'light' });
  const events: Array<Record<string, unknown>> = [];
  const out = await runAgent({ ...agentInput(project, 'coding'), registry: registryWith(fake), onEvent: (t, p) => events.push({ type: t, ...p }) });
  assert.equal(out.status, 'done');
  assert.equal(out.forcedFinish, true);
  assert.ok(fake.requests.length < 12, `finished after ${fake.requests.length} turns, not the full 14-step budget`);
  assert.ok(events.some((e) => e.type === 'agent.checkpoint'));
  assert.ok(events.some((e) => e.type === 'agent.force_finish'));
  assert.ok(fake.requests.some((r) => r.messages.some((m) => m.role === 'user' && /Progress check/.test(m.content))), 'a checkpoint summary was demanded');
  assert.deepEqual(fake.requests[fake.requests.length - 1].tools?.map((t) => t.name), ['finish']);
});

test('handles a provider outage at task level: with no feasible model the task ends failed, spends no calls, and names every reason', async () => {
  const project = tmpProject();
  const { task } = createTask({ description: 'Fix typo in greeting', project: 'fixture', budget: { maxRetries: 2 } }, [project]);
  const down = new FakeProvider([finishCall({})], 'down', { tier: 'light' });
  const registry = registryWith(down);
  registry.healthCache.down = { ok: false, detail: 'unreachable', checkedAt: new Date().toISOString() };
  const store = tmpStore();
  const result = await runTask(task, { store, registry, runVerification: okVerify }, [project]);
  assert.equal(result.outcome, 'failed');
  assert.equal(result.usage.modelCalls, 0);
  assert.equal(result.attempt, 1, 'no retries were burned on a hopeless step');
  assert.match(result.failureReason!, /no feasible model/);
  assert.match(result.failureReason!, /provider_unhealthy/);
  const decision = store.readEvents(result.id).find((e) => e.type === 'routing.decision')!;
  assert.ok(decision && Array.isArray(decision.eliminated));
});

test('recalculates context for the model actually chosen: a small-window model gets a smaller pack, not a truncated big one', async () => {
  const project = tmpProject();
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  for (let i = 0; i < 6; i++) writeFileSync(join(project.repository, 'src', `greet${i}.ts`), `export const greet${i} = 1;\n` + '// greet\n'.repeat(400));
  const { task } = createTask({ description: 'Fix typo in greet', project: 'fixture', budget: { maxRetries: 0 } }, [project]);
  const small = new FakeProvider([finishCall({}), finishCall({ verdict: 'approve' })], 'small', { tier: 'light', promptCharBudget: 12_000 });
  const result = await runTask(task, { store: tmpStore(), registry: registryWith(small), runVerification: okVerify }, [project]);
  assert.equal(result.outcome, 'success');
  const step = result.steps[0];
  assert.ok(step.context!.chars <= 12_000, `context (${step.context!.chars}) sized to the 12k window`);
  assert.ok((step.routing as { idealChars: number }).idealChars > step.context!.chars, 'the ideal pack was larger than what was built');
  const sent = small.requests[0].messages.reduce((a, m) => a + m.content.length, 0);
  assert.ok(sent <= 12_000, `first prompt (${sent}) fits the window`);
});
