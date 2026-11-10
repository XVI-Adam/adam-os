import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { exec, projectEnv } from './agents/tools.ts';
import type { Project } from './projects.ts';
import { groqTokensToday } from './quota.ts';
import type { EvalSummary, VerificationPlan, VerificationResult, VerifyScope } from './types.ts';

// Objective verification. Exit codes and parsed eval reports decide; an
// agent's own claim of success never does.

const OUTPUT_TAIL = 6_000;
const COMMAND_TIMEOUT_MS = 10 * 60_000;
const EVAL_TIMEOUT_MS = 60 * 60_000;

export interface EvalRunOptions {
  /** Case ids to re-run instead of the full suite (cheap regression signal). */
  filterIds?: string[];
  /** Prior eval in this task; used for the regression-vs-baseline comparison. */
  taskBaseline?: EvalSummary;
}

interface AskAdamReport {
  timestamp: string; model: string; deterministicOnly?: boolean; filter?: string;
  outcomes: Array<{ id: string; passed: boolean; category?: string; expect?: string; question?: string; hypothesis?: string; response?: string; graders?: Array<{ grader: string; passed: boolean; findings?: Array<{ grader: string; detail: string; evidence?: string }> }> }>;
  errors: Array<{ id: string; message: string }>;
  expectedFailures: Record<string, string>;
}

export function parseEvalReport(path: string, taskBaseline?: EvalSummary): EvalSummary {
  const rep = JSON.parse(readFileSync(path, 'utf8')) as AskAdamReport;
  const byId = new Map<string, boolean>();
  for (const o of rep.outcomes) byId.set(o.id, (byId.get(o.id) ?? true) && o.passed);
  const failedIds = [...byId.entries()].filter(([, p]) => !p).map(([id]) => id).sort();
  const expected = new Set(Object.keys(rep.expectedFailures ?? {}));
  const unexpected = failedIds.filter((id) => !expected.has(id));
  const total = byId.size;
  const passed = total - failedIds.length;
  const summary: EvalSummary = {
    total, passed, failed: failedIds.length, errored: rep.errors?.length ?? 0,
    expectedFailures: failedIds.filter((id) => expected.has(id)).length,
    unexpectedFailures: unexpected, failedIds,
    passRate: total ? passed / total : 0,
    reportPath: path,
    scope: rep.filter ? 'filtered' : 'full',
    filter: rep.filter,
    deterministicOnly: Boolean(rep.deterministicOnly),
    model: rep.model,
  };
  if (taskBaseline) {
    const baselineFailed = new Set(taskBaseline.failedIds);
    summary.regressionsVsTaskBaseline = failedIds.filter((id) => !baselineFailed.has(id));
  }
  summary.digest = buildDigest(rep, unexpected, expected);
  return summary;
}

/** One block per failing case: what was asked, what tripped, a short response excerpt. Unexpected failures first. */
export function buildDigest(rep: AskAdamReport, unexpected: string[], expected: Set<string>, maxCases = 20): string {
  const seen = new Set<string>();
  const blocks: string[] = [];
  const order = [...rep.outcomes].sort((a, b) => Number(expected.has(a.id)) - Number(expected.has(b.id)));
  for (const o of order) {
    if (o.passed || seen.has(o.id)) continue;
    seen.add(o.id);
    if (blocks.length >= maxCases) break;
    const tripped = (o.graders ?? []).filter((g) => !g.passed).flatMap((g) => (g.findings ?? []).map((f) => `    - ${f.grader}: ${f.detail.slice(0, 220)}${f.evidence ? ` | evidence: "${f.evidence.slice(0, 120)}"` : ''}`));
    blocks.push([
      `[${o.id}] ${o.category ?? '?'} · expect=${o.expect ?? '?'} · ${expected.has(o.id) ? 'EXPECTED failure (tracked)' : 'UNEXPECTED failure'}`,
      `  Q: ${(o.question ?? '').replace(/\s+/g, ' ').slice(0, 240)}`,
      `  Response excerpt: ${(o.response ?? '').replace(/\s+/g, ' ').slice(0, 320)}`,
      tripped.length ? `  Tripped:\n${tripped.join('\n')}` : '  Tripped: (no grader findings recorded)',
      o.hypothesis ? `  Case hypothesis: ${o.hypothesis.replace(/\s+/g, ' ').slice(0, 200)}` : '',
    ].filter(Boolean).join('\n'));
  }
  const rest = [...rep.outcomes].filter((o) => !o.passed).map((o) => o.id).filter((id, i, a) => a.indexOf(id) === i && !seen.has(id));
  return blocks.join('\n\n') + (rest.length ? `\n\n(+${rest.length} more failing cases not shown: ${rest.join(', ')})` : '');
}

function newestReport(dir: string, since: number): string | undefined {
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.progress.json'))
    .map((f) => ({ f, m: statSync(resolve(dir, f)).mtimeMs })).filter((x) => x.m >= since - 1000).sort((a, b) => b.m - a.m);
  return files[0] ? resolve(dir, files[0].f) : undefined;
}

/** Ask the harness what a run would cost; null when the project has no cost command or it cannot be parsed. */
export async function estimateEvalTokens(project: Project, filterIds?: string[]): Promise<number | null> {
  const ev = project.eval;
  if (!ev?.costCommand) return null;
  const cmd = filterIds?.length && ev.filterFlag ? `${ev.costCommand} -- ${ev.filterFlag}${filterIds.join(',')}` : ev.costCommand;
  const r = await exec('sh', ['-c', cmd], project.repository, 120_000, projectEnv(project));
  const out = `${r.stdout}\n${r.stderr}`;
  // A deterministic-only run never calls the judge, so count only the model-under-test estimate for it.
  const m = /--deterministic-only/.test(ev.command)
    ? /Model under test[\s\S]*?est\. tokens:\s+([\d,]+)/.exec(out) ?? /Whole run\s+([\d,]+) tokens/.exec(out)
    : /Whole run\s+([\d,]+) tokens/.exec(out);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

export async function runVerification(plan: VerificationPlan, project: Project, opts: EvalRunOptions = {}): Promise<VerificationResult> {
  const started = Date.now();
  let command = plan.command;
  if (plan.kind === 'eval' && opts.filterIds?.length && project.eval?.filterFlag) command = `${command} ${project.eval.filterFlag}${opts.filterIds.join(',')}`;
  if (plan.kind === 'eval' && project.eval?.dailyTokenCap) {
    // Deferral beats a run that dies on the daily cap: an incomplete run certifies nothing and burns hours in retries.
    const est = await estimateEvalTokens(project, opts.filterIds);
    const used = groqTokensToday(project);
    if (est !== null && used.total + est > project.eval.dailyTokenCap) {
      return {
        id: plan.id, kind: plan.kind, label: plan.label, command, passed: false, skipped: true, exitCode: null, durationMs: Date.now() - started,
        outputTail: `estimated run cost ${est.toLocaleString()} tokens; used today ~${used.total.toLocaleString()} (harness ${used.fromEvalReports.toLocaleString()} + agents ${used.fromAgents.toLocaleString()}); cap ${project.eval.dailyTokenCap.toLocaleString()}`,
        error: `deferred: eval would exceed the Groq daily token cap (est ${est.toLocaleString()} + used ${used.total.toLocaleString()} > ${project.eval.dailyTokenCap.toLocaleString()}); re-run after the quota resets`,
      };
    }
  }
  const r = await exec('sh', ['-c', command], project.repository, plan.kind === 'eval' ? EVAL_TIMEOUT_MS : COMMAND_TIMEOUT_MS, projectEnv(project));
  const combined = `${r.stdout}\n${r.stderr}`.trim();
  const base: VerificationResult = {
    id: plan.id, kind: plan.kind, label: plan.label, command,
    passed: r.code === 0 && !r.timedOut, exitCode: r.timedOut ? null : r.code,
    durationMs: Date.now() - started, outputTail: combined.slice(-OUTPUT_TAIL),
  };
  // A --json eval prints the whole report to stdout; its tail is useless to an agent. Keep stderr (progress, errors) instead.
  if (plan.kind === 'eval') base.outputTail = r.stderr.trim().slice(-OUTPUT_TAIL);
  if (r.timedOut) base.error = 'timed out';
  if (plan.kind !== 'eval' || !project.eval) return base;

  const reportPath = newestReport(resolve(project.repository, project.eval.resultsDir), started);
  if (!reportPath) { base.passed = false; base.error = (base.error ? base.error + '; ' : '') + 'no eval report was written'; return base; }
  try {
    const summary = parseEvalReport(reportPath, opts.taskBaseline);
    // Write the digest beside the report (results/*.md is gitignored in Ask Adam) so agents can read it in ranges.
    if (summary.digest) {
      const digestAbs = reportPath.replace(/\.json$/, '.digest.md');
      writeFileSync(digestAbs, `# Eval failure digest (${summary.passed}/${summary.total} passed)\n\n${summary.digest}\n`);
      summary.digestPath = relative(project.repository, digestAbs);
    }
    base.evalSummary = summary;
    // Pass = complete run, no unexpected failures, no regressions against this task's own baseline.
    const regress = summary.regressionsVsTaskBaseline ?? [];
    base.passed = summary.errored === 0 && summary.unexpectedFailures.length === 0 && regress.length === 0;
    if (!base.passed) {
      const why: string[] = [];
      if (summary.errored) why.push(`${summary.errored} errored case(s) (incomplete run)`);
      if (summary.unexpectedFailures.length) why.push(`unexpected failures: ${summary.unexpectedFailures.join(', ')}`);
      if (regress.length) why.push(`regressions vs task baseline: ${regress.join(', ')}`);
      base.error = why.join('; ');
    }
  } catch (e) {
    base.passed = false; base.error = `could not parse eval report: ${(e as Error).message}`;
  }
  return base;
}

export function plansForScope(plans: VerificationPlan[], scope: VerifyScope): VerificationPlan[] {
  return plans.filter((p) => p.scopes.includes(scope));
}
