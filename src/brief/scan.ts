import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Project } from '../projects.ts';

const exec = promisify(execFile);

export interface BranchInfo { name: string; lastCommitMs: number; ahead: number }
export interface TodoHit { file: string; line: number; tag: 'TODO' | 'FIXME' | 'HACK' | 'XXX'; text: string }
export interface TestResult {
  command: string;
  status: 'pass' | 'fail' | 'cannot_run' | 'timeout';
  exitCode: number | null;
  durationMs: number;
  summary: string;
  cached: boolean;
}

export interface ProjectScan {
  slug: string;
  name: string;
  repository: string;
  error?: string;
  defaultBranch: string;
  currentBranch: string;
  lastActivityMs: number;
  branches: BranchInfo[];
  dirty: { count: number; oldestMtimeMs: number | null };
  todos: TodoHit[];
  tests?: TestResult;
}

export interface ScanOptions {
  runTests: boolean;
  cacheDir: string;
  testTimeoutMs?: number;
  /** With runTests false: still report a test result when one is cached for the exact current tree. Never executes anything. */
  cachedTestsOnly?: boolean;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

async function gitOk(cwd: string, args: string[]): Promise<string | null> {
  try { return await git(cwd, args); } catch { return null; }
}

async function defaultBranch(cwd: string, local: string[], current: string): Promise<string> {
  const remote = (await gitOk(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']))?.trim();
  const fromRemote = remote?.replace(/^origin\//, '');
  if (fromRemote && local.includes(fromRemote)) return fromRemote;
  return ['main', 'master', 'trunk'].find((b) => local.includes(b)) ?? current;
}

// Generated or vendored trees whose TODOs are not the project's own (Flutter platform scaffolding etc.).
const TODO_EXCLUDES = ['*.md', '*.json', '*.lock', '*.min.js', '*.svg', 'android', 'ios', 'linux', 'macos', 'windows', 'vendor', 'dist', 'build'];
const COMMENT_MARKER = /(\/\/|#|\/\*|^\s*\*|<!--|--)/;

/** TODO-style tags that sit inside a comment. A tag in a string literal or prose is not counted. */
export function parseTodoGrep(out: string): TodoHit[] {
  const hits: TodoHit[] = [];
  for (const raw of out.split('\n')) {
    const m = /^(.+?):(\d+):(.*)$/.exec(raw);
    if (!m) continue;
    const text = m[3];
    const tag = /\b(TODO|FIXME|HACK|XXX)\b/.exec(text);
    if (!tag || !COMMENT_MARKER.test(text.slice(0, tag.index))) continue;
    hits.push({ file: m[1], line: Number(m[2]), tag: tag[1] as TodoHit['tag'], text: text.trim().slice(0, 120) });
  }
  return hits;
}

function summarizeTestOutput(out: string): string {
  const lines = out.split('\n').map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim()).filter(Boolean);
  const counted = [...lines].reverse().find((l) => /\b\d+\s+(failed|failing|failures?)\b/i.test(l) || /^#\s*fail\s+[1-9]/i.test(l));
  if (counted) return counted.slice(0, 140);
  const flutter = lines.find((l) => /Some tests failed/i.test(l));
  return (flutter ?? lines.at(-1) ?? 'no output').slice(0, 140);
}

function runCommand(command: string, cwd: string, timeoutMs: number): Promise<Omit<TestResult, 'cached'>> {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(command, { cwd, shell: true, env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const keep = (b: Buffer) => { tail = (tail + b.toString()).slice(-8000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - started;
      if (timedOut) return done({ command, status: 'timeout', exitCode: null, durationMs, summary: `timed out after ${Math.round(timeoutMs / 1000)}s` });
      const status = code === 0 ? 'pass' : code === 127 ? 'cannot_run' : 'fail';
      done({ command, status, exitCode: code, durationMs, summary: code === 0 ? 'passed' : summarizeTestOutput(tail) });
    });
  });
}

/** Cache key: the test command plus the exact code it would run against (HEAD + working-tree diff + untracked paths). */
async function testCacheKey(cwd: string, command: string, porcelain: string): Promise<string> {
  const head = (await gitOk(cwd, ['rev-parse', 'HEAD'])) ?? '';
  const diff = (await gitOk(cwd, ['diff', 'HEAD'])) ?? '';
  return createHash('sha256').update(command).update(head).update(diff).update(porcelain).digest('hex');
}

async function runTests(p: Project, porcelain: string, opts: ScanOptions): Promise<TestResult | undefined> {
  const command = p.commands.test;
  if (!command) return undefined;
  mkdirSync(opts.cacheDir, { recursive: true });
  const file = join(opts.cacheDir, `${p.slug}.json`);
  const key = await testCacheKey(p.repository, command, porcelain);
  if (existsSync(file)) {
    try {
      const c = JSON.parse(readFileSync(file, 'utf8')) as { key: string; result: TestResult };
      if (c.key === key) return { ...c.result, cached: true };
    } catch { /* stale or corrupt cache: re-run */ }
  }
  if (!opts.runTests) return undefined;
  const result = { ...(await runCommand(command, p.repository, opts.testTimeoutMs ?? 180_000)), cached: false };
  // Timeouts are not cached: a slow machine this morning should not stick.
  if (result.status !== 'timeout') writeFileSync(file, JSON.stringify({ key, result }, null, 2));
  return result;
}

export async function scanProject(p: Project, opts: ScanOptions): Promise<ProjectScan> {
  const cwd = p.repository;
  const empty: ProjectScan = {
    slug: p.slug, name: p.name, repository: cwd, defaultBranch: '', currentBranch: '', lastActivityMs: 0,
    branches: [], dirty: { count: 0, oldestMtimeMs: null }, todos: [],
  };
  if (!existsSync(cwd)) return { ...empty, error: 'repository path does not exist' };
  if ((await gitOk(cwd, ['rev-parse', '--git-dir'])) === null) return { ...empty, error: 'not a git repository' };

  const current = (await gitOk(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim() ?? '';
  const refs = (await git(cwd, ['for-each-ref', '--format=%(refname:short)%09%(committerdate:unix)', 'refs/heads']))
    .split('\n').filter(Boolean).map((l) => { const [name, ts] = l.split('\t'); return { name, lastCommitMs: Number(ts) * 1000 }; });
  const def = await defaultBranch(cwd, refs.map((r) => r.name), current);
  const branches: BranchInfo[] = await Promise.all(refs.map(async (r) => ({
    ...r,
    ahead: r.name === def ? 0 : Number((await gitOk(cwd, ['rev-list', '--count', `${def}..${r.name}`]))?.trim() ?? 0),
  })));

  const porcelain = (await gitOk(cwd, ['status', '--porcelain'])) ?? '';
  const dirtyPaths = porcelain.split('\n').filter(Boolean).map((l) => l.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, ''));
  let oldest: number | null = null;
  for (const rel of dirtyPaths) {
    try { const m = statSync(resolve(cwd, rel)).mtimeMs; oldest = oldest === null ? m : Math.min(oldest, m); } catch { /* deleted file */ }
  }

  // git grep exits 1 when nothing matches; that is an empty result, not an error.
  const grep = (await gitOk(cwd, ['grep', '-nIwE', 'TODO|FIXME|HACK|XXX', '--', '.', ...TODO_EXCLUDES.map((x) => `:(exclude)${x}`)])) ?? '';

  return {
    ...empty,
    defaultBranch: def,
    currentBranch: current,
    lastActivityMs: Math.max(0, ...branches.map((b) => b.lastCommitMs)),
    branches,
    dirty: { count: dirtyPaths.length, oldestMtimeMs: oldest },
    todos: parseTodoGrep(grep),
    tests: opts.runTests || opts.cachedTestsOnly ? await runTests(p, porcelain, opts) : undefined,
  };
}

export function scanAll(projects: Project[], opts: ScanOptions): Promise<ProjectScan[]> {
  return Promise.all(projects.map((p) => scanProject(p, opts)));
}
