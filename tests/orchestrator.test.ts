import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTask, runTask } from '../src/orchestrator.ts';
import type { VerificationPlan, VerificationResult } from '../src/types.ts';
import { FakeProvider, finishCall, registryWith, tmpProject, tmpStore } from './helpers.ts';

const okVerify = async (plan: VerificationPlan): Promise<VerificationResult> => ({ id: plan.id, kind: plan.kind, label: plan.label, command: plan.command, passed: true, exitCode: 0, durationMs: 1, outputTail: '' });
const failVerify = async (plan: VerificationPlan): Promise<VerificationResult> => ({ id: plan.id, kind: plan.kind, label: plan.label, command: plan.command, passed: false, exitCode: 1, durationMs: 1, outputTail: 'FAIL src/index.test.ts > greet\nexpected "hi bob" got "hello bob"' });

function make(description: string, budget = {}) {
  const project = tmpProject();
  const { task } = createTask({ description, project: 'fixture', budget: { maxCostUsd: 5, maxAgentCalls: 20, maxRetries: 1, maxToolCalls: 50, maxWallClockMs: 60_000, ...budget } }, [project]);
  return { task, project };
}

test('happy path: quick_fix runs coding → verify → review and completes with success', async () => {
  const { task, project } = make('Fix typo in greeting');
  const fake = new FakeProvider([finishCall({ changed_files: ['src/index.ts'] }), finishCall({ verdict: 'approve' })]);
  const store = tmpStore();
  const result = await runTask(task, { store, registry: registryWith(fake), runVerification: okVerify }, [project]);
  assert.equal(result.status, 'completed');
  assert.equal(result.outcome, 'success');
  assert.deepEqual(result.steps.map((s) => `${s.stepId}:${s.status}`), ['implement:done', 'verify:done', 'review:done']);
  assert.equal(result.usage.modelCalls, 2);
  assert.equal(result.usage.costBasis, 'unavailable'); // fake-model has no price → never $0
  const events = store.readEvents(result.id).map((e) => e.type);
  assert.ok(events.includes('task.start') && events.includes('task.end') && events.includes('verify.end'));
});

test('verification failure triggers failure analysis, replan with escalation, retry; then fails when retries run out', async () => {
  const { task, project } = make('Fix typo in greeting');
  const fake = new FakeProvider([
    finishCall({}),                       // implement (attempt 1)
    finishCall({ root_cause: 'wrong string' }), // failure analysis
    finishCall({}),                       // implement (attempt 2)
  ]);
  const store = tmpStore();
  const result = await runTask(task, { store, registry: registryWith(fake), runVerification: failVerify }, [project]);
  assert.equal(result.status, 'failed');
  assert.equal(result.outcome, 'failed');
  assert.equal(result.attempt, 2);
  assert.match(result.failureReason!, /verification still failing/);
  const ids = result.steps.map((s) => s.stepId);
  assert.deepEqual(ids, ['implement', 'verify', 'analyze_failure_1', 'implement', 'verify']);
  // The analysis step received the verbatim failure output in its context.
  const analysisReq = fake.requests[1];
  assert.match(analysisReq.messages[1].content, /expected "hi bob" got "hello bob"/);
  const replans = store.readEvents(result.id).filter((e) => e.type === 'replan');
  assert.equal(replans.length, 1);
  assert.equal(replans[0].tier, 'standard'); // escalated from light
});

test('budget: max_agent_calls stops the task as budget_exhausted, not as success', async () => {
  const { task, project } = make('Fix typo in greeting', { maxAgentCalls: 1 });
  const fake = new FakeProvider([finishCall({}), finishCall({ verdict: 'approve' })]);
  const result = await runTask(task, { store: tmpStore(), registry: registryWith(fake), runVerification: okVerify }, [project]);
  assert.equal(result.status, 'budget_exhausted');
  assert.match(result.failureReason!, /max_agent_calls/);
});

test('failed agent (provider throws): the model enters cooldown, the retry finds nothing feasible, and the task stops without hammering', async () => {
  const { task, project } = make('Fix typo in greeting', { maxRetries: 1 });
  const fake = new FakeProvider([new Error('boom 500'), new Error('boom again')]);
  const result = await runTask(task, { store: tmpStore(), registry: registryWith(fake), runVerification: okVerify, maxCooldownWaitMs: 0 }, [project]);
  assert.equal(result.outcome, 'failed');
  assert.match(result.failureReason!, /no feasible model.*cooldown/);
  assert.equal(result.usage.modelCalls, 1, 'one failing call; the retry did not call a model in cooldown');
  assert.equal(result.attempt, 2);
});

test('malformed model responses: empty replies twice → step error → retry path; bad tool args are fed back', async () => {
  const { task, project } = make('Fix typo in greeting', { maxRetries: 0 });
  const fake = new FakeProvider([
    { text: '', toolCalls: [] }, { text: '', toolCalls: [] }, // two empties → error
  ]);
  const result = await runTask(task, { store: tmpStore(), registry: registryWith(fake), runVerification: okVerify }, [project]);
  assert.equal(result.outcome, 'failed');
  assert.match(result.steps[0].error!, /empty responses/);

  const { task: t2, project: p2 } = make('Fix typo in greeting', { maxRetries: 0 });
  const fake2 = new FakeProvider([
    { toolCalls: [{ id: 'x', name: 'read_file', args: { __error: 'tool arguments were not valid JSON: {oops' } }] },
    { toolCalls: [{ id: 'y', name: 'no_such_tool', args: {} }] },
    finishCall({}), finishCall({ verdict: 'approve' }),
  ]);
  const r2 = await runTask(t2, { store: tmpStore(), registry: registryWith(fake2), runVerification: okVerify }, [p2]);
  assert.equal(r2.outcome, 'success');
  const toolMsgs = fake2.requests[2].messages.filter((m) => m.role === 'tool').map((m) => m.content);
  assert.match(toolMsgs[0], /not valid JSON/);
  assert.match(toolMsgs[1], /unknown tool/);
});

test('agent blocked → task fails fast with the reason; needs_escalation → retried at a higher tier', async () => {
  const { task, project } = make('Fix typo in greeting');
  const fake = new FakeProvider([finishCall({ status: 'blocked', summary: 'needs credentials' })]);
  const result = await runTask(task, { store: tmpStore(), registry: registryWith(fake), runVerification: okVerify }, [project]);
  assert.equal(result.outcome, 'failed');
  assert.match(result.failureReason!, /blocked: needs credentials/);

  const { task: t2, project: p2 } = make('Fix typo in greeting');
  const fake2 = new FakeProvider([finishCall({ status: 'needs_escalation', summary: 'too hard' }), finishCall({}), finishCall({ verdict: 'approve' })]);
  const store = tmpStore();
  const r2 = await runTask(t2, { store, registry: registryWith(fake2), runVerification: okVerify }, [p2]);
  assert.equal(r2.outcome, 'success');
  assert.equal(r2.attempt, 2);
});

test('reviewer request_changes loops back once, then completes as partial when retries are gone', async () => {
  const { task, project } = make('Fix typo in greeting', { maxRetries: 1 });
  const fake = new FakeProvider([finishCall({}), finishCall({ verdict: 'request_changes', summary: 'missing test' }), finishCall({}), finishCall({ verdict: 'request_changes', summary: 'still missing' })]);
  const result = await runTask(task, { store: tmpStore(), registry: registryWith(fake), runVerification: okVerify }, [project]);
  assert.equal(result.status, 'completed');
  assert.equal(result.outcome, 'partial');
  assert.match(result.failureReason!, /reviewer rejected/);
});

test('stop control flag ends the task at the next step boundary', async () => {
  const { task, project } = make('Fix typo in greeting');
  const store = tmpStore();
  const fake = new FakeProvider([finishCall({})]);
  store.setControl(task.id, 'stop');
  const result = await runTask(task, { store, registry: registryWith(fake), runVerification: okVerify }, [project]);
  assert.equal(result.status, 'stopped');
  assert.equal(result.usage.modelCalls, 0);
});

test('state transitions are recorded in order', async () => {
  const { task, project } = make('Fix typo in greeting');
  const store = tmpStore();
  const fake = new FakeProvider([finishCall({}), finishCall({ verdict: 'approve' })]);
  await runTask(task, { store, registry: registryWith(fake), runVerification: okVerify }, [project]);
  const statuses = store.readEvents(task.id).filter((e) => e.type === 'status').map((e) => e.status);
  assert.deepEqual(statuses, ['routing', 'implementing', 'verifying', 'reviewing', 'completed']);
});

test('no verification signals → verify step is skipped, not passed silently', async () => {
  const project = tmpProject({ commands: {} });
  const { task } = createTask({ description: 'Fix typo in greeting', project: 'fixture', budget: { maxRetries: 0 } }, [project]);
  const fake = new FakeProvider([finishCall({}), finishCall({ verdict: 'approve' })]);
  const result = await runTask(task, { store: tmpStore(), registry: registryWith(fake) }, [project]);
  assert.equal(result.steps[1].status, 'skipped');
  assert.equal(result.outcome, 'success');
});

test('rate-limited provider is marked unavailable and the step falls back to another provider at the same tier', async () => {
  const { ProviderError } = await import('../src/providers/types.ts');
  const { task, project } = make('Fix typo in greeting', { maxRetries: 1 });
  // 'limited' wins the tiebreak by name until it fails; the ledger cooldown then routes to 'healthy'.
  const limited = new FakeProvider([new ProviderError('quota', 429, true)], 'a-limited', 'light');
  const healthy = new FakeProvider([finishCall({}), finishCall({ verdict: 'approve' })], 'b-healthy', 'light');
  const registry = registryWith(limited, healthy);
  const store = tmpStore();
  const result = await runTask(task, { store, registry, runVerification: okVerify }, [project]);
  assert.equal(result.outcome, 'success');
  assert.ok(registry.unavailable.has('a-limited/fake-model'));
  assert.ok(registry.ledger.cooldown('a-limited/fake-model'), 'a temporary cooldown, not a blacklist');
  // The switch happens inside the step, so no replan, no lost work, no tier escalation.
  assert.equal(store.readEvents(result.id).filter((e) => e.type === 'replan').length, 0);
  assert.equal(result.attempt, 1);
  const implement = result.steps.filter((s) => s.stepId === 'implement');
  assert.equal(implement.length, 1);
  assert.equal(implement[0].provider, 'b-healthy');
  assert.ok(store.readEvents(result.id).some((e) => e.type === 'agent.fallback' && e.from === 'a-limited/fake-model'));
});

test('a deferred required verification yields a partial outcome without replanning', async () => {
  const { task, project } = make('Fix typo in greeting', { maxRetries: 2 });
  const fake = new FakeProvider([finishCall({}), finishCall({ verdict: 'approve' })]);
  const deferVerify = async (plan: VerificationPlan): Promise<VerificationResult> => ({ id: plan.id, kind: plan.kind, label: plan.label, command: plan.command, passed: false, skipped: true, exitCode: null, durationMs: 1, outputTail: '', error: 'deferred: quota' });
  const store = tmpStore();
  const result = await runTask(task, { store, registry: registryWith(fake), runVerification: deferVerify }, [project]);
  assert.equal(result.status, 'completed');
  assert.equal(result.outcome, 'partial');
  assert.match(result.failureReason!, /deferred: quota/);
  assert.equal(store.readEvents(result.id).filter((e) => e.type === 'replan').length, 0);
  assert.equal(result.attempt, 1);
});
