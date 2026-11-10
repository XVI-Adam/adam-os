import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inferProject, loadProjects } from '../src/projects.ts';
import { classifyCategory, route, scoreComplexity } from '../src/router.ts';
import { tmpProject } from './helpers.ts';

const projects = loadProjects();

test('infers Ask Adam from task text and routes eval tasks to ai_agent_improvement', () => {
  const inf = inferProject("Fix Ask Adam's deprecated Groq model migration and run the eval harness");
  assert.equal(inf.project?.slug, 'ask-adam');
  const r = route('Investigate the deprecated Groq model migration, run the 52-case evaluation harness, analyze failures, iterate until the regression suite passes', inf.project!);
  assert.equal(r.category, 'evaluation');
  assert.equal(r.workflow, 'ai_agent_improvement');
  assert.ok(r.verification.some((v) => v.kind === 'eval'));
  assert.ok(r.verification.some((v) => v.id === 'test'));
  assert.equal(r.complexity.tier, 'complex');
  assert.equal(r.tier, 'strong');
});

test('routes BodyCraft App Store prep to production_readiness', () => {
  const inf = inferProject('Prepare BodyCraft for App Store release');
  assert.equal(inf.project?.slug, 'bodycraft');
  const r = route('Prepare BodyCraft for App Store release', inf.project!);
  assert.equal(r.category, 'deployment');
  assert.equal(r.workflow, 'production_readiness');
});

test('simple bug → quick_fix at light tier; medium bug → bug_fix', () => {
  const p = tmpProject();
  const simple = route('Fix typo in the greeting string', p);
  assert.equal(simple.category, 'debugging');
  assert.equal(simple.workflow, 'quick_fix');
  assert.equal(simple.tier, 'light');
  const medium = route('Fix the crash when the user submits an empty form and the error is not surfaced in the UI, then add a regression test', p);
  assert.equal(medium.workflow, 'bug_fix');
});

test('unknown wording defaults to research (cheapest, read-only)', () => {
  const c = classifyCategory('zzz qqq', tmpProject());
  assert.equal(c.category, 'research');
  const r = route('zzz qqq', tmpProject());
  assert.equal(r.workflow, 'research');
  assert.equal(r.capabilities.includes('repo_write'), false);
});

test('ambiguous project inference returns candidates instead of guessing', () => {
  const inf = inferProject('compare portfolio and bodycraft build times', projects);
  assert.equal(inf.project, undefined); // equal-length aliases tie → ambiguous, never a guess
  assert.deepEqual(inf.candidates.sort(), ['bodycraft', 'portfolio']);
  const none = inferProject('do something', projects);
  assert.equal(none.project, undefined);
  assert.deepEqual(none.candidates, []);
});

test('complexity score is bounded 1..5', () => {
  const p = tmpProject();
  assert.ok(scoreComplexity('typo', 'documentation', p).score >= 1);
  assert.ok(scoreComplexity('prepare production release across the entire pipeline and audit security and performance and migrate everything until it is done', 'deployment', p).score <= 5);
});

test('verification plan omits tests for read-only categories', () => {
  const p = tmpProject();
  const r = route('Document how the greeting module works', p);
  assert.equal(r.category, 'documentation');
  assert.ok(!r.verification.some((v) => v.id === 'test'));
});

test('a question that names eval files keeps read-only research routing (no harness run)', () => {
  const askAdam = projects.find((p) => p.slug === 'ask-adam')!;
  const r = route('Research which Groq model api/chat.ts uses, whether evals/src/groq.ts matches, and what evals/baseline.json records', askAdam);
  assert.equal(r.category, 'research');
  assert.equal(r.workflow, 'research');
  assert.ok(!r.verification.some((v) => v.kind === 'eval'));
  const r2 = route('Investigate the deprecated Groq model migration, implement the required changes, run the evaluation harness, analyze failures, and iterate until it passes', askAdam);
  assert.equal(r2.workflow, 'ai_agent_improvement');
});
