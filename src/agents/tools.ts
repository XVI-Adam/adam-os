import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parseEnvFile } from '../config.ts';
import type { Project } from '../projects.ts';
import type { ToolDef } from '../providers/types.ts';

// Tools available to chat-mode agents. Every tool is sandboxed to the project
// root, writes are denied on secrets and vendored dirs, and run_command only
// accepts commands whose prefix the project allowlists.

export const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', 'coverage', '.dart_tool', 'ios/Pods', 'Pods', '.vercel', 'results', '__pycache__']);
const DENY_WRITE = [/(^|\/)\.env(\..*)?$/, /(^|\/)node_modules\//, /(^|\/)\.git\//, /(^|\/)package-lock\.json$/, /(^|\/)baseline\.json$/];
const MAX_READ_CHARS = 24_000;
const MAX_CMD_OUTPUT = 8_000;
const MAX_SEARCH_RESULTS = 60;

export interface ToolContext {
  project: Project;
  allowWrite: boolean;
  commandTimeoutMs?: number;
}

export interface ToolResult { ok: boolean; output: string }

function safePath(root: string, p: string): string {
  const abs = resolve(root, p);
  const realRoot = realpathSync(root);
  const check = existsSync(abs) ? realpathSync(abs) : resolve(realpathSync(dirname(existsSync(dirname(abs)) ? dirname(abs) : root)), abs.split(sep).pop() ?? '');
  if (check !== realRoot && !check.startsWith(realRoot + sep)) throw new Error(`path escapes project root: ${p}`);
  return abs;
}

export function isTextFile(p: string): boolean {
  return !/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|woff2?|ttf|otf|mp[34]|mov|lock|jar|so|dylib|bin|wasm|glb|hdr|jsonl)$/i.test(p);
}

export function walk(root: string, dir: string, out: string[], maxFiles = 4000): void {
  if (out.length >= maxFiles) return;
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e) || e.startsWith('.')) continue;
    const full = join(dir, e);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(root, full, out, maxFiles);
    else if (st.isFile() && isTextFile(full) && st.size < 400_000) out.push(relative(root, full));
    if (out.length >= maxFiles) return;
  }
}

export function listFiles(ctx: ToolContext, args: Record<string, unknown>): ToolResult {
  const root = ctx.project.repository;
  const dir = typeof args.dir === 'string' ? args.dir : '.';
  const abs = safePath(root, dir);
  if (!existsSync(abs)) return { ok: false, output: `no such directory: ${dir}` };
  const out: string[] = [];
  walk(root, abs, out, 500);
  const pattern = typeof args.pattern === 'string' ? args.pattern : undefined;
  const filtered = pattern ? out.filter((f) => f.includes(pattern)) : out;
  return { ok: true, output: filtered.slice(0, 300).join('\n') + (filtered.length > 300 ? `\n... ${filtered.length - 300} more` : '') };
}

export function readFile(ctx: ToolContext, args: Record<string, unknown>): ToolResult {
  const p = String(args.path ?? '');
  if (!p) return { ok: false, output: 'path is required' };
  const abs = safePath(ctx.project.repository, p);
  if (!existsSync(abs) || !statSync(abs).isFile()) return { ok: false, output: `no such file: ${p}` };
  const lines = readFileSync(abs, 'utf8').split('\n');
  const start = Math.max(1, Number(args.start_line ?? 1));
  const end = Math.min(lines.length, Number(args.end_line ?? lines.length));
  let body = lines.slice(start - 1, end).map((l, i) => `${start + i}: ${l}`).join('\n');
  let note = '';
  if (body.length > MAX_READ_CHARS) { body = body.slice(0, MAX_READ_CHARS); note = `\n... truncated at ${MAX_READ_CHARS} chars; request a narrower line range`; }
  return { ok: true, output: `${p} (${lines.length} lines)\n${body}${note}` };
}

export async function search(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const pattern = String(args.pattern ?? '');
  if (!pattern) return { ok: false, output: 'pattern is required' };
  const root = ctx.project.repository;
  const dir = typeof args.dir === 'string' ? args.dir : '.';
  safePath(root, dir);
  const excludes = [...SKIP_DIRS].flatMap((d) => ['--exclude-dir', d]);
  const r = await exec('grep', ['-rnI', '--max-count=20', ...excludes, '-e', pattern, dir], root, 30_000);
  const lines = r.stdout.split('\n').filter(Boolean);
  if (!lines.length) return { ok: true, output: r.code === 2 ? `grep error: ${r.stderr.slice(0, 200)}` : 'no matches' };
  return { ok: true, output: lines.slice(0, MAX_SEARCH_RESULTS).map((l) => l.slice(0, 300)).join('\n') + (lines.length > MAX_SEARCH_RESULTS ? `\n... ${lines.length - MAX_SEARCH_RESULTS} more matches` : '') };
}

function assertWritable(ctx: ToolContext, p: string): void {
  if (!ctx.allowWrite) throw new Error('this agent is read-only');
  if (DENY_WRITE.some((re) => re.test(p))) throw new Error(`writes to ${p} are denied by policy`);
}

export function writeFile(ctx: ToolContext, args: Record<string, unknown>): ToolResult {
  const p = String(args.path ?? '');
  const content = args.content;
  if (!p || typeof content !== 'string') return { ok: false, output: 'path and content are required' };
  assertWritable(ctx, p);
  const abs = safePath(ctx.project.repository, p);
  writeFileSync(abs, content);
  return { ok: true, output: `wrote ${p} (${content.length} chars)` };
}

export function editFile(ctx: ToolContext, args: Record<string, unknown>): ToolResult {
  const p = String(args.path ?? '');
  const oldText = args.old_text; const newText = args.new_text;
  if (!p || typeof oldText !== 'string' || typeof newText !== 'string') return { ok: false, output: 'path, old_text and new_text are required' };
  assertWritable(ctx, p);
  const abs = safePath(ctx.project.repository, p);
  if (!existsSync(abs)) return { ok: false, output: `no such file: ${p}` };
  const src = readFileSync(abs, 'utf8');
  const count = src.split(oldText).length - 1;
  if (count === 0) return { ok: false, output: 'old_text not found in file (match must be exact, including whitespace)' };
  if (count > 1) return { ok: false, output: `old_text matched ${count} times; include more surrounding context to make it unique` };
  writeFileSync(abs, src.replace(oldText, () => newText));
  return { ok: true, output: `edited ${p}` };
}

export function commandAllowed(project: Project, cmd: string): boolean {
  const c = cmd.trim();
  return project.allowedCommands.some((prefix) => c === prefix || c.startsWith(prefix + ' '));
}

export function projectEnv(project: Project): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  for (const f of ['.env', '.env.local']) {
    const parsed = parseEnvFile(resolve(project.repository, f));
    for (const [k, v] of Object.entries(parsed)) if (!env[k]) env[k] = v;
  }
  return env;
}

export function exec(cmd: string, args: string[], cwd: string, timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { cwd, env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let timedOut = false;
    child.stdout.on('data', (d) => { stdout += d; if (stdout.length > 2_000_000) stdout = stdout.slice(-1_000_000); });
    child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 2_000_000) stderr = stderr.slice(-1_000_000); });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolvePromise({ code, stdout, stderr, timedOut }); });
    child.on('error', (err) => { clearTimeout(timer); resolvePromise({ code: null, stdout, stderr: stderr + err.message, timedOut }); });
  });
}

export async function runCommand(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const cmd = String(args.command ?? '').trim();
  if (!cmd) return { ok: false, output: 'command is required' };
  if (!commandAllowed(ctx.project, cmd)) return { ok: false, output: `command not allowed. Allowed prefixes: ${ctx.project.allowedCommands.join(' | ')}` };
  const r = await exec('sh', ['-c', cmd], ctx.project.repository, ctx.commandTimeoutMs ?? 180_000, projectEnv(ctx.project));
  const combined = `${r.stdout}\n${r.stderr}`.trim();
  const tail = combined.length > MAX_CMD_OUTPUT ? `... (${combined.length - MAX_CMD_OUTPUT} chars omitted)\n` + combined.slice(-MAX_CMD_OUTPUT) : combined;
  return { ok: r.code === 0 && !r.timedOut, output: `exit=${r.timedOut ? 'timeout' : r.code}\n${tail}` };
}

/**
 * Content fingerprint of the project's working tree: porcelain status (which
 * paths are added, removed or untracked) plus the full tracked diff. Two calls
 * returning the same string mean nothing changed in between.
 *
 * This exists so a delegated provider that dies mid-run can be asked the only
 * question that matters: did it actually do anything before it stopped?
 * Returns null when the project is not a git repo — "cannot tell", not "no".
 */
export async function workspaceFingerprint(project: Project): Promise<string | null> {
  const env = projectEnv(project);
  const status = await exec('git', ['status', '--porcelain'], project.repository, 30_000, env);
  if (status.code !== 0) return null;
  const diff = await exec('git', ['diff', 'HEAD'], project.repository, 60_000, env);
  if (diff.code !== 0) return null;
  return createHash('sha1').update(status.stdout).update('\u0000').update(diff.stdout).digest('hex');
}

export const TOOL_DEFS: Record<string, ToolDef> = {
  list_files: { name: 'list_files', description: 'List files under a directory of the project (recursive, skips vendored dirs). Optional substring pattern filter.', parameters: { type: 'object', properties: { dir: { type: 'string' }, pattern: { type: 'string' } } } },
  read_file: { name: 'read_file', description: 'Read a file with line numbers. Use start_line/end_line for large files.', parameters: { type: 'object', properties: { path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } }, required: ['path'] } },
  search: { name: 'search', description: 'Regex search (grep -rn) across the project or a subdirectory.', parameters: { type: 'object', properties: { pattern: { type: 'string' }, dir: { type: 'string' } }, required: ['pattern'] } },
  edit_file: { name: 'edit_file', description: 'Replace one exact, unique occurrence of old_text with new_text in a file.', parameters: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'] } },
  write_file: { name: 'write_file', description: 'Create or overwrite a whole file.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  run_command: { name: 'run_command', description: 'Run an allowlisted shell command in the project root (tests, typecheck, git status/diff). Returns exit code and output tail.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  finish: { name: 'finish', description: 'Call exactly once when done. summary: what you found or did. status: done | blocked | needs_escalation. Include any extra structured fields the step asked for (changed_files, root_cause, verdict, findings, plan, satisfied, gaps).', parameters: { type: 'object', properties: { summary: { type: 'string' }, status: { type: 'string', enum: ['done', 'blocked', 'needs_escalation'] }, changed_files: { type: 'array', items: { type: 'string' } }, root_cause: { type: 'string' }, verdict: { type: 'string' }, findings: { type: 'array', items: { type: 'string' } }, plan: { type: 'array', items: { type: 'string' } }, proposed_change: { type: 'string' }, satisfied: { type: 'boolean' }, gaps: { type: 'array', items: { type: 'string' } } }, required: ['summary', 'status'] } },
};

export async function executeTool(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    if (args.__error) return { ok: false, output: String(args.__error) };
    switch (name) {
      case 'list_files': return listFiles(ctx, args);
      case 'read_file': return readFile(ctx, args);
      case 'search': return await search(ctx, args);
      case 'edit_file': return editFile(ctx, args);
      case 'write_file': return writeFile(ctx, args);
      case 'run_command': return await runCommand(ctx, args);
      default: return { ok: false, output: `unknown tool: ${name}` };
    }
  } catch (e) {
    return { ok: false, output: `tool error: ${(e as Error).message}` };
  }
}
