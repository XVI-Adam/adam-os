import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { walk } from '../agents/tools.ts';
import { projectBrief, type Project } from '../projects.ts';
import type { AgentRole, ContextStats, StepRecord, Tier, VerificationResult } from '../types.ts';

// Progressive context selection. Every agent gets a compact project brief and
// a small, ranked slice of the repository; it pulls more through tools. Failure
// output stays verbatim (tails), everything else is summarised or excerpted.

export interface ContextBlock { kind: 'project' | 'prior' | 'failure' | 'file' | 'doc'; title: string; content: string; verbatim: boolean }
export interface ContextPack { blocks: ContextBlock[]; stats: ContextStats; text: string }

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'then', 'until', 'them', 'they', 'have', 'has', 'are', 'was', 'were', 'will', 'should', 'would', 'could', 'make', 'sure', 'run', 'runs', 'use', 'using', 'when', 'what', 'which', 'where', 'how', 'all', 'any', 'each', 'its', 'our', 'your', 'also', 'more', 'than', 'not', 'but', 'can', 'one', 'two', 'new', 'get', 'set', 'add', 'fix', 'the', 'task', 'project', 'code', 'file', 'files', 'change', 'changes', 'implement', 'required', 'investigate', 'analyze', 'iterate', 'exhausted', 'budget', 'passes', 'suite']);

export function keywords(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z0-9_./-]{3,}/g) ?? [];
  const uniq = new Set<string>();
  for (const w of words) { const t = w.replace(/^[./-]+|[./-]+$/g, ''); if (t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t)) uniq.add(t); }
  // camelCase / identifiers in the original text carry a lot of signal
  for (const id of text.match(/\b[a-z]+[A-Z][A-Za-z0-9]+\b/g) ?? []) uniq.add(id.toLowerCase());
  return [...uniq];
}

const ROLE_PATH_BOOST: Partial<Record<AgentRole, RegExp>> = {
  evaluation: /(^|\/)(evals?|tests?|__tests__|spec)(\/|$)/,
  debugging: /(^|\/)(api|src|lib|app|evals)(\/|$)/,
  reviewer: /(^|\/)(api|src|lib|app)(\/|$)/,
};

interface Candidate { path: string; size: number; score: number; hits: number[] }

export function charBudgetFor(tier: Tier): number {
  return tier === 'light' ? 9_000 : tier === 'standard' ? 36_000 : 60_000;
}

function excerpt(lines: string[], hits: number[], radius = 8, maxWindows = 5): string {
  const windows: Array<[number, number]> = [];
  for (const h of hits.slice(0, maxWindows)) {
    const s = Math.max(0, h - radius); const e = Math.min(lines.length, h + radius + 1);
    const last = windows[windows.length - 1];
    if (last && s <= last[1]) last[1] = e; else windows.push([s, e]);
  }
  return windows.map(([s, e]) => lines.slice(s, e).map((l, i) => `${s + i + 1}: ${l}`).join('\n')).join('\n...\n');
}

export function buildContext(opts: {
  project: Project;
  task: string;
  role: AgentRole;
  tier: Tier;
  priorSteps: StepRecord[];
  failures: VerificationResult[];
  charBudget?: number;
}): ContextPack {
  const { project, task, role, priorSteps, failures } = opts;
  const budget = opts.charBudget ?? charBudgetFor(opts.tier);
  const blocks: ContextBlock[] = [];
  let used = 0;
  const push = (b: ContextBlock) => { blocks.push(b); used += b.content.length; };

  push({ kind: 'project', title: 'Project brief', content: projectBrief(project), verbatim: true });

  // Verbatim failure output is the most valuable context a fix step can get.
  for (const f of failures.slice(-2)) {
    const tail = f.outputTail.slice(-Math.min(5_000, Math.floor(budget * 0.35)));
    const es = f.evalSummary;
    const evalPart = es ? `\nEval summary: ${es.passed}/${es.total} passed, errored ${es.errored}, unexpected failures: ${es.unexpectedFailures.join(', ') || 'none'}; expected (tracked) failures: ${es.expectedFailures}; report: ${es.reportPath}` : '';
    const digestCap = Math.min(14_000, Math.floor(budget * 0.45));
    const digestNote = es?.digestPath && (es.digest?.length ?? 0) > digestCap ? `\n(digest truncated here; the full per-case digest is at ${es.digestPath} — read_file it in line ranges, ~40 lines per case)` : '';
    const body = es?.digest
      ? `exit=${f.exitCode}${evalPart}\n--- failure digest (per case, verbatim grader findings) ---\n${es.digest.slice(0, digestCap)}${digestNote}`
      : `exit=${f.exitCode}${evalPart}\n--- output tail ---\n${tail}`;
    push({ kind: 'failure', title: `Verification FAILED: ${f.label} (${f.command})`, content: body, verbatim: true });
  }

  // Prior step results, summarised (structured finish payload kept when short).
  for (const s of priorSteps.slice(-4)) {
    const summary = (s.summary ?? '').slice(0, 1_400);
    const structured = s.structured ? JSON.stringify(s.structured).slice(0, 800) : '';
    const verif = s.verification?.map((v) => `${v.label}: ${v.passed ? 'PASS' : 'FAIL'}${v.evalSummary ? ` (${v.evalSummary.passed}/${v.evalSummary.total})` : ''}`).join('; ');
    push({ kind: 'prior', title: `Prior step ${s.stepId} [${s.kind}${s.role ? ':' + s.role : ''}] → ${s.status}`, content: [summary, structured, verif].filter(Boolean).join('\n'), verbatim: false });
  }

  // Rank repository files by keyword relevance; include top ones within budget.
  const kws = keywords(task);
  const root = project.repository;
  const paths: string[] = [];
  for (const d of project.importantDirectories) {
    const abs = resolve(root, d);
    if (!existsSync(abs)) continue;
    if (statSync(abs).isFile()) paths.push(d); else walk(root, abs, paths, 1500);
  }
  for (const k of project.keyFiles) if (existsSync(resolve(root, k)) && !paths.includes(k)) paths.push(k);
  const uniquePaths = [...new Set(paths)];
  const candidates: Candidate[] = [];
  let candidateChars = 0;
  for (const p of uniquePaths) {
    let text: string;
    try { text = readFileSync(resolve(root, p), 'utf8'); } catch { continue; }
    candidateChars += text.length;
    const lower = text.toLowerCase();
    const pl = p.toLowerCase();
    let score = 0;
    const hits: number[] = [];
    for (const k of kws) {
      if (pl.includes(k)) score += 4;
      let idx = lower.indexOf(k); let n = 0;
      while (idx !== -1 && n < 6) { n++; hits.push(lower.slice(0, idx).split('\n').length - 1); idx = lower.indexOf(k, idx + k.length); }
      score += Math.min(n, 6);
    }
    if (project.keyFiles.includes(p)) score += 6;
    if (ROLE_PATH_BOOST[role]?.test(p)) score += 3;
    if (/\.(md|txt)$/i.test(p) && role !== 'research' && role !== 'planner') score -= 2;
    if (score > 0) candidates.push({ path: p, size: text.length, score, hits: [...new Set(hits)].sort((a, b) => a - b) });
  }
  candidates.sort((a, b) => b.score - a.score || a.size - b.size);

  const files: string[] = [];
  for (const c of candidates) {
    const remaining = budget - used;
    if (remaining < 1_500) break;
    const text = readFileSync(resolve(root, c.path), 'utf8');
    let content: string; let verbatim: boolean;
    if (text.length <= Math.min(7_000, remaining)) { content = text; verbatim = true; }
    else {
      const lines = text.split('\n');
      const head = lines.slice(0, 30).map((l, i) => `${i + 1}: ${l}`).join('\n');
      content = `${head}\n...\n${excerpt(lines, c.hits)}`;
      if (content.length > remaining) content = content.slice(0, remaining - 200) + '\n... (truncated)';
      verbatim = false;
    }
    push({ kind: /\.(md|txt)$/i.test(c.path) ? 'doc' : 'file', title: `${c.path}${verbatim ? '' : ' (excerpt; use read_file for more)'}`, content, verbatim });
    files.push(c.path);
    if (files.length >= 12) break;
  }

  const text = blocks.map((b) => `### ${b.title}\n${b.content}`).join('\n\n');
  return {
    blocks,
    text,
    stats: { files, chars: text.length, estTokens: Math.ceil(text.length / 4), candidateChars, candidateFiles: uniquePaths.length },
  };
}
