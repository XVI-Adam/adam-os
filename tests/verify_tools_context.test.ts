import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { executeTool } from '../src/agents/tools.ts';
import { buildContext, keywords } from '../src/context/manager.ts';
import { parseEvalReport, runVerification } from '../src/verify.ts';
import { tmpProject } from './helpers.ts';

test('parseEvalReport: expected failures are not unexpected; regressions vs task baseline are detected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adamos-eval-'));
  const p = join(dir, 'r.json');
  writeFileSync(p, JSON.stringify({ timestamp: 't', model: 'm', deterministicOnly: true, outcomes: [
    { id: 'a', passed: true }, { id: 'b', passed: false }, { id: 'c', passed: false }, { id: 'a', passed: true },
  ], errors: [], expectedFailures: { b: 'known' } }));
  const s = parseEvalReport(p);
  assert.equal(s.total, 3); assert.equal(s.passed, 1);
  assert.deepEqual(s.unexpectedFailures, ['c']);
  assert.equal(s.scope, 'full');
  const s2 = parseEvalReport(p, { ...s, failedIds: ['b'] });
  assert.deepEqual(s2.regressionsVsTaskBaseline, ['c']);
});

test('runVerification: command exit code decides; eval without a report fails', async () => {
  const project = tmpProject();
  const ok = await runVerification({ id: 'test', kind: 'command', label: 't', command: 'true', required: true, scopes: ['all'] }, project);
  assert.equal(ok.passed, true);
  const bad = await runVerification({ id: 'test', kind: 'command', label: 't', command: 'echo nope; false', required: true, scopes: ['all'] }, project);
  assert.equal(bad.passed, false); assert.match(bad.outputTail, /nope/);
  const ev = await runVerification({ id: 'eval', kind: 'eval', label: 'e', command: 'true', required: true, scopes: ['eval'] }, { ...project, eval: { command: 'true', resultsDir: 'nowhere' } });
  assert.equal(ev.passed, false); assert.match(ev.error!, /no eval report/);
});

test('tools: sandbox denies path escape, secret writes, read-only agents, and non-allowlisted commands', async () => {
  const project = tmpProject();
  const ro = { project, allowWrite: false };
  const rw = { project, allowWrite: true };
  assert.match((await executeTool(ro, 'read_file', { path: '../../etc/passwd' })).output, /escapes project root/);
  assert.match((await executeTool(rw, 'write_file', { path: '.env', content: 'x' })).output, /denied by policy/);
  assert.match((await executeTool(ro, 'edit_file', { path: 'src/index.ts', old_text: 'hi', new_text: 'yo' })).output, /read-only/);
  assert.match((await executeTool(rw, 'run_command', { command: 'rm -rf /' })).output, /not allowed/);
  const echo = await executeTool(rw, 'run_command', { command: 'echo hello' });
  assert.equal(echo.ok, true); assert.match(echo.output, /hello/);
  const edit = await executeTool(rw, 'edit_file', { path: 'src/index.ts', old_text: 'hi ${name}', new_text: 'hello ${name}' });
  assert.equal(edit.ok, true);
  assert.match((await executeTool(rw, 'read_file', { path: 'src/index.ts' })).output, /hello \$\{name\}/);
  assert.match((await executeTool(rw, 'edit_file', { path: 'src/index.ts', old_text: 'zzz', new_text: 'y' })).output, /not found/);
});

test('context manager: selects relevant files within budget, keeps failure output verbatim, reports reduction', () => {
  const project = tmpProject();
  writeFileSync(join(project.repository, 'src', 'other.ts'), 'export const unrelated = 1;\n');
  writeFileSync(join(project.repository, 'src', 'big.ts'), 'x\n'.repeat(6000) + 'function greet() {}\n');
  const pack = buildContext({ project, task: 'Fix the greet function output', role: 'coding', tier: 'light', priorSteps: [], failures: [
    { id: 'test', kind: 'command', label: 'Unit tests', command: 'npm test', passed: false, exitCode: 1, durationMs: 1, outputTail: 'AssertionError: expected hi got hello' },
  ] });
  assert.ok(pack.stats.files.includes('src/index.ts'));
  assert.ok(!pack.stats.files.includes('src/other.ts'), 'unrelated file excluded');
  assert.ok(pack.text.includes('AssertionError: expected hi got hello'));
  assert.ok(pack.stats.chars <= 9_000 + 500);
  assert.ok(pack.stats.candidateChars > pack.stats.chars);
  assert.ok(keywords('Fix the greetFunction in api/chat.ts').includes('greetfunction'));
});

test('eval verification is deferred, not run, when the harness estimate would exceed the daily Groq cap', async () => {
  const project = tmpProject({ eval: { command: 'echo RAN > ran.txt', resultsDir: 'results', dailyTokenCap: 200_000, costCommand: 'echo "Whole run          264,218 tokens   vs 200,000 TPD"' } });
  const r = await runVerification({ id: 'eval', kind: 'eval', label: 'Eval', command: project.eval!.command, required: true, scopes: ['eval'] }, project);
  assert.equal(r.skipped, true); assert.equal(r.passed, false);
  assert.match(r.error!, /deferred/);
  assert.ok(!existsSync(join(project.repository, 'ran.txt')), 'the eval command must not have run');
});
