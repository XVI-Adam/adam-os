import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { candidatesFor, rank } from '../src/brief/rank.ts';
import { parseTodoGrep, scanProject, type ProjectScan } from '../src/brief/scan.ts';
import { tmpProject } from './helpers.ts';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 22, 12);

function scan(overrides: Partial<ProjectScan>): ProjectScan {
  return {
    slug: 'p', name: 'P', repository: '/x', defaultBranch: 'main', currentBranch: 'main', lastActivityMs: NOW - DAY,
    branches: [{ name: 'main', lastCommitMs: NOW - DAY, ahead: 0 }], dirty: { count: 0, oldestMtimeMs: null }, todos: [],
    ...overrides,
  };
}

test('parseTodoGrep keeps tags in comments and drops tags in strings and prose', () => {
  const hits = parseTodoGrep([
    'src/a.ts:3:  // TODO: wire this up',
    'src/b.py:9:x = 1  # FIXME off by one',
    "tests/c.ts:5:  report({ a: 'known, TODO: fix the prompt' })",
    'lib/d.ts:10:// Production wiring (TODO):',
    'src/e.ts:2:const TODO_LIST = []',
  ].join('\n'));
  assert.deepEqual(hits.map((h) => `${h.file}:${h.tag}`), ['src/a.ts:TODO', 'src/b.py:FIXME', 'lib/d.ts:TODO']);
});

test('failing tests outrank everything in an equally active project', () => {
  const s = scan({
    tests: { command: 'npm test', status: 'fail', exitCode: 1, durationMs: 1, summary: '2 failed', cached: false },
    dirty: { count: 3, oldestMtimeMs: NOW - 30 * DAY },
    todos: [{ file: 'a.ts', line: 1, tag: 'FIXME', text: '// FIXME' }],
  });
  const c = candidatesFor(s, NOW);
  assert.equal(c.sort((a, b) => b.score - a.score)[0].kind, 'failing_tests');
});

test('activity discounts dormant projects', () => {
  const active = scan({ slug: 'active', dirty: { count: 1, oldestMtimeMs: NOW - DAY } });
  const dormant = scan({
    slug: 'dormant', lastActivityMs: NOW - 400 * DAY,
    tests: { command: 'npm test', status: 'fail', exitCode: 1, durationMs: 1, summary: 'x', cached: false },
  });
  const { top } = rank([dormant, active], NOW);
  assert.equal(top[0].slug, 'active');   // 45 × 1.0 beats 100 × 0.4
});

test('top 3 takes one per project before backfilling', () => {
  const noisy = scan({
    slug: 'noisy',
    tests: { command: 't', status: 'fail', exitCode: 1, durationMs: 1, summary: 'x', cached: false },
    dirty: { count: 5, oldestMtimeMs: NOW - DAY },
    todos: [{ file: 'a', line: 1, tag: 'HACK', text: '// HACK' }],
  });
  const quiet = scan({ slug: 'quiet', todos: [{ file: 'b', line: 2, tag: 'TODO', text: '// TODO' }] });
  const { top } = rank([noisy, quiet], NOW);
  assert.deepEqual(top.map((c) => c.slug), ['noisy', 'noisy', 'quiet']);   // without the per-project pass: noisy ×3
});

test('in-flight vs stale vs merged branches', () => {
  const s = scan({
    currentBranch: 'feat/now',
    branches: [
      { name: 'main', lastCommitMs: NOW - DAY, ahead: 0 },
      { name: 'feat/now', lastCommitMs: NOW - 2 * DAY, ahead: 3 },
      { name: 'feat/old', lastCommitMs: NOW - 90 * DAY, ahead: 1 },
      { name: 'done', lastCommitMs: NOW - 90 * DAY, ahead: 0 },
    ],
  });
  const kinds = Object.fromEntries(candidatesFor(s, NOW).map((c) => [c.kind, c]));
  assert.match(kinds.in_flight_branch.action, /feat\/now/);
  assert.match(kinds.stale_branches.reason, /feat\/old/);
  assert.match(kinds.merged_branches.reason, /done/);
});

test('scanProject reads a real repo: failing test, stale branch, FIXME, dirty tree; caches the test run', async () => {
  const p = tmpProject({ commands: { test: 'echo "1 failed" && exit 1' } });
  const g = (...args: string[]) => execFileSync('git', args, { cwd: p.repository, env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' } });
  g('init', '-q', '-b', 'main');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  g('checkout', '-qb', 'old-idea');
  writeFileSync(join(p.repository, 'src', 'idea.ts'), '// FIXME: this is wrong\n');
  g('add', '-A');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'idea');
  g('checkout', '-q', 'main');
  writeFileSync(join(p.repository, 'src', 'index.ts'), '// TODO: greet better\n');

  const cacheDir = mkdtempSync(join(tmpdir(), 'adamos-brief-'));
  const s = await scanProject(p, { runTests: true, cacheDir });
  assert.equal(s.defaultBranch, 'main');
  assert.equal(s.tests?.status, 'fail');
  assert.equal(s.tests?.summary, '1 failed');
  assert.deepEqual(s.branches.find((b) => b.name === 'old-idea')?.ahead, 1);
  assert.equal(s.dirty.count, 1);
  assert.deepEqual(s.todos.map((t) => t.tag), ['TODO']);   // FIXME lives on the other branch

  const kinds = candidatesFor(s, NOW).map((c) => c.kind);
  assert.ok(kinds.includes('failing_tests') && kinds.includes('stale_branches') && kinds.includes('todo'));

  const again = await scanProject(p, { runTests: true, cacheDir });
  assert.equal(again.tests?.cached, true);
});

test('scanProject reports a missing repository instead of throwing', async () => {
  const s = await scanProject(tmpProject({ repository: '/nonexistent/adamos' }), { runTests: false, cacheDir: tmpdir() });
  assert.match(s.error ?? '', /does not exist/);
  assert.deepEqual(candidatesFor(s, NOW), []);
});
