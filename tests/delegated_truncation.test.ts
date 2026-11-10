import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createTask, runTask } from '../src/orchestrator.ts';
import type { VerificationPlan, VerificationResult } from '../src/types.ts';
import { FakeDelegatedProvider, registryWith, tmpGitProject, tmpStore } from './helpers.ts';

// The first dogfood lost a completed fix because the CLI stopped at its spend cap
// and the loop treated the whole run as a failure. These pin the corrected behaviour.

const okVerify = async (p: VerificationPlan): Promise<VerificationResult> => ({ id: p.id, kind: p.kind, label: p.label, command: p.command, passed: true, exitCode: 0, durationMs: 1, outputTail: '' });
const failVerify = async (p: VerificationPlan): Promise<VerificationResult> => ({ id: p.id, kind: p.kind, label: p.label, command: p.command, passed: false, exitCode: 1, durationMs: 1, outputTail: 'FAIL: greet returned the wrong string' });

function make(project = tmpGitProject(), budget = {}) {
  const { task } = createTask({ description: 'Fix typo in greeting', project: 'fixture', budget: { maxCostUsd: 5, maxAgentCalls: 20, maxRetries: 0, maxToolCalls: 50, maxWallClockMs: 60_000, ...budget } }, [project]);
  return { task, project };
}

const budgetStopped = (text: string) => ({ text, isError: true, budgetStopped: true, subtype: 'error_max_budget', providerCostUsd: 1.13 });

test('a spend-capped delegated run that changed files keeps its work, is judged by verification, and does not lose reliability', async () => {
  const project = tmpGitProject();
  const fake = new FakeDelegatedProvider(
    [budgetStopped('Folded unicode punctuation before matching; edited three graders.'), { text: 'Diff is minimal and correct.' }],
    'fake-cli',
    (run, i) => { if (i === 0) writeFileSync(join(run.cwd, 'src', 'index.ts'), 'export function greet(n: string) { return `hello ${n}`; }\n'); },
  );
  const registry = registryWith(fake);
  const store = tmpStore();
  const { task } = make(project);
  const result = await runTask(task, { store, registry, runVerification: okVerify }, [project]);

  const implement = result.steps.find((s) => s.stepId === 'implement')!;
  assert.equal(implement.status, 'done', 'the step is not a failure');
  assert.match(implement.summary, /Folded unicode punctuation/, 'the summary survived');
  assert.match(implement.summary, /TRUNCATED/, 'and is labelled as incomplete');
  assert.equal(implement.structured?.truncated, true);

  assert.ok(result.steps.some((s) => s.kind === 'verify' && s.status === 'done'), 'verification ran on the kept work');
  assert.ok(result.steps.some((s) => s.stepId === 'review'), 'the workflow continued to review');
  assert.equal(result.status, 'completed');
  assert.equal(result.outcome, 'partial', 'completed, but never reported as a clean success');
  assert.match(result.failureReason!, /truncated by the provider spend cap/);

  const h = registry.ledger.history('fake-cli/fake-cli-model');
  assert.equal(h.failures, 0, 'our own cap is not the model’s fault');
  assert.ok(h.successes >= 1);
  assert.ok(store.readEvents(result.id).some((e) => e.type === 'agent.truncated'));
  assert.ok(store.readEvents(result.id).some((e) => e.type === 'step.truncated'));
});

test('verification still governs: the same truncated run fails the task when the work does not pass', async () => {
  const project = tmpGitProject();
  const fake = new FakeDelegatedProvider(
    [budgetStopped('Edited the greeter.'), { text: 'analysis' }, { text: 'second attempt' }],
    'fake-cli',
    (run, i) => { if (i === 0) writeFileSync(join(run.cwd, 'src', 'index.ts'), 'export function greet() { return 0; }\n'); },
  );
  const { task } = make(project);
  const result = await runTask(task, { store: tmpStore(), registry: registryWith(fake), runVerification: failVerify }, [project]);
  assert.equal(result.outcome, 'failed', 'kept work is not trusted work');
  assert.match(result.failureReason!, /verification still failing/);
});

test('a spend-capped run that changed nothing is still a failure, and the model is penalised', async () => {
  const project = tmpGitProject();
  const fake = new FakeDelegatedProvider([budgetStopped('I was still reading files when I ran out.')], 'fake-cli');
  const registry = registryWith(fake);
  const { task } = make(project);
  const result = await runTask(task, { store: tmpStore(), registry, runVerification: okVerify }, [project]);
  const implement = result.steps.find((s) => s.stepId === 'implement')!;
  assert.equal(implement.status, 'failed');
  assert.equal(result.outcome, 'failed');
  assert.ok(registry.ledger.history('fake-cli/fake-cli-model').failures >= 1);
});

test('an error envelope with no message no longer surfaces as the string "undefined"', async () => {
  const project = tmpGitProject();
  const fake = new FakeDelegatedProvider([{ text: '', isError: true, error: undefined }], 'fake-cli');
  const { task } = make(project);
  const result = await runTask(task, { store: tmpStore(), registry: registryWith(fake), runVerification: okVerify }, [project]);
  const implement = result.steps.find((s) => s.stepId === 'implement')!;
  assert.equal(implement.status, 'failed');
  assert.ok(implement.error && !/undefined/.test(implement.error), `error was: ${implement.error}`);
  assert.match(implement.error!, /no message/);
});

test('a clean delegated run is unaffected: no truncation flag, outcome stays success', async () => {
  const project = tmpGitProject();
  const fake = new FakeDelegatedProvider([{ text: 'Done.' }, { text: 'Looks right.' }], 'fake-cli');
  const { task } = make(project);
  const result = await runTask(task, { store: tmpStore(), registry: registryWith(fake), runVerification: okVerify }, [project]);
  assert.equal(result.outcome, 'success');
  assert.equal(result.steps.find((s) => s.stepId === 'implement')!.structured?.truncated, undefined);
});
