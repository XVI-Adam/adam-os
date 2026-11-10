import type { TaskRecord } from './types.ts';

export interface Analytics {
  totalTasks: number;
  successful: number;
  partial: number;
  failed: number;
  budgetExhausted: number;
  stopped: number;
  active: number;
  avgEstimatedCostUsd: number | null;
  avgAttempts: number | null;
  costPerSuccessfulTaskUsd: number | null;
  totalModelCalls: number;
  totalToolCalls: number;
  tasksWithUnavailableCost: number;
  mostExpensiveWorkflows: Array<{ workflow: string; tasks: number; avgCostUsd: number | null; avgCalls: number }>;
  failureModes: Array<{ mode: string; count: number }>;
  contextReduction: { avgIncludedChars: number; avgCandidateChars: number; ratio: number | null } | null;
  /** Cost split three ways, each keeping estimated / provider-reported / unavailable apart. */
  costBy: { workflow: Record<string, CostBucket>; role: Record<string, CostBucket>; provider: Record<string, CostBucket> };
  costPerSuccessfulOutcome: { estimatedUsd: number | null; providerReportedUsd: number | null; successes: number };
  /** Steps that ended by the progress policy rather than by finishing their work. */
  forcedFinishes: number;
}

export interface CostBucket {
  steps: number;
  modelCalls: number;
  estimatedCostUsd: number | null;
  providerReportedCostUsd: number | null;
  callsWithoutUsage: number;
  successfulSteps: number;
}

function bucket(): CostBucket { return { steps: 0, modelCalls: 0, estimatedCostUsd: null, providerReportedCostUsd: null, callsWithoutUsage: 0, successfulSteps: 0 }; }
function addTo(b: CostBucket, s: { usage: { modelCalls: number; estimatedCostUsd: number | null; providerReportedCostUsd: number | null; callsWithoutUsage: number }; status: string }): void {
  b.steps++; b.modelCalls += s.usage.modelCalls; b.callsWithoutUsage += s.usage.callsWithoutUsage;
  if (s.usage.estimatedCostUsd !== null) b.estimatedCostUsd = (b.estimatedCostUsd ?? 0) + s.usage.estimatedCostUsd;
  if (s.usage.providerReportedCostUsd !== null) b.providerReportedCostUsd = (b.providerReportedCostUsd ?? 0) + s.usage.providerReportedCostUsd;
  if (s.status === 'done') b.successfulSteps++;
}

function failureMode(t: TaskRecord): string | undefined {
  if (t.outcome === 'success') return undefined;
  if (t.outcome === 'budget_exhausted') return `budget: ${(t.failureReason ?? '').split(' ')[0]}`;
  const r = t.failureReason ?? '';
  if (/verification still failing/.test(r)) return 'verification failed after retries';
  if (/agent .* blocked/.test(r)) return 'agent blocked';
  if (/provider error/.test(r)) return 'provider error';
  if (/no healthy provider/.test(r)) return 'no healthy provider';
  if (/needed escalation/.test(r)) return 'escalation exhausted';
  if (/max steps/.test(r)) return 'agent exhausted its step budget';
  if (/no feasible model/.test(r)) return 'no feasible model (quota/cooldown/context)';
  if (/agent .* failed and no retries/.test(r)) return 'agent failed repeatedly';
  if (/filtered re-run/.test(r)) return 'partial: filtered eval only';
  if (/rejected/.test(r)) return 'partial: reviewer/product rejected';
  if (t.outcome === 'stopped') return 'stopped by user';
  return t.outcome === 'partial' ? 'partial: other' : 'other';
}

export function computeAnalytics(tasks: TaskRecord[]): Analytics {
  const done = tasks.filter((t) => t.outcome);
  const successful = done.filter((t) => t.outcome === 'success');
  const withCost = done.filter((t) => t.usage.estimatedCostUsd !== null);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const byWf = new Map<string, TaskRecord[]>();
  for (const t of done) byWf.set(t.route.workflow, [...(byWf.get(t.route.workflow) ?? []), t]);
  const modes = new Map<string, number>();
  for (const t of done) { const m = failureMode(t); if (m) modes.set(m, (modes.get(m) ?? 0) + 1); }
  const costBy = { workflow: {} as Record<string, CostBucket>, role: {} as Record<string, CostBucket>, provider: {} as Record<string, CostBucket> };
  let forcedFinishes = 0;
  for (const t of tasks) for (const s of t.steps) {
    if (s.kind !== 'agent') continue;
    addTo((costBy.workflow[t.route.workflow] ??= bucket()), s);
    addTo((costBy.role[s.role ?? 'unknown'] ??= bucket()), s);
    addTo((costBy.provider[s.provider ?? 'none'] ??= bucket()), s);
    if (s.progress && (s.progress as { last?: string }).last === 'force_finish') forcedFinishes++;
  }
  const succEst = successful.filter((t) => t.usage.estimatedCostUsd !== null);
  const succProv = successful.filter((t) => t.usage.providerReportedCostUsd !== null);
  const ctxSteps = tasks.flatMap((t) => t.steps.filter((s) => s.context));
  const inc = avg(ctxSteps.map((s) => s.context!.chars));
  const cand = avg(ctxSteps.map((s) => s.context!.candidateChars));
  return {
    totalTasks: tasks.length,
    successful: successful.length,
    partial: done.filter((t) => t.outcome === 'partial').length,
    failed: done.filter((t) => t.outcome === 'failed').length,
    budgetExhausted: done.filter((t) => t.outcome === 'budget_exhausted').length,
    stopped: done.filter((t) => t.outcome === 'stopped').length,
    active: tasks.length - done.length,
    avgEstimatedCostUsd: avg(withCost.map((t) => t.usage.estimatedCostUsd!)),
    avgAttempts: avg(done.map((t) => t.attempt)),
    costPerSuccessfulTaskUsd: successful.length && withCost.length ? withCost.reduce((a, t) => a + t.usage.estimatedCostUsd!, 0) / successful.length : null,
    totalModelCalls: tasks.reduce((a, t) => a + t.usage.modelCalls, 0),
    totalToolCalls: tasks.reduce((a, t) => a + t.usage.toolCalls, 0),
    tasksWithUnavailableCost: done.length - withCost.length,
    mostExpensiveWorkflows: [...byWf.entries()].map(([workflow, ts]) => ({
      workflow, tasks: ts.length,
      avgCostUsd: avg(ts.filter((t) => t.usage.estimatedCostUsd !== null).map((t) => t.usage.estimatedCostUsd!)),
      avgCalls: avg(ts.map((t) => t.usage.modelCalls)) ?? 0,
    })).sort((a, b) => (b.avgCostUsd ?? -1) - (a.avgCostUsd ?? -1) || b.avgCalls - a.avgCalls),
    failureModes: [...modes.entries()].map(([mode, count]) => ({ mode, count })).sort((a, b) => b.count - a.count),
    contextReduction: inc !== null && cand !== null ? { avgIncludedChars: Math.round(inc), avgCandidateChars: Math.round(cand), ratio: cand ? inc / cand : null } : null,
    costBy,
    costPerSuccessfulOutcome: {
      estimatedUsd: successful.length && succEst.length ? succEst.reduce((a, t) => a + t.usage.estimatedCostUsd!, 0) / successful.length : null,
      providerReportedUsd: successful.length && succProv.length ? succProv.reduce((a, t) => a + t.usage.providerReportedCostUsd!, 0) / successful.length : null,
      successes: successful.length,
    },
    forcedFinishes,
  };
}
