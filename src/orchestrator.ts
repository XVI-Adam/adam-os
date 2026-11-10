import { BudgetManager } from './budget.ts';
import { loadConfig } from './config.ts';
import { buildContext, charBudgetFor } from './context/manager.ts';
import { getProject, inferProject, loadProjects, type Project } from './projects.ts';
import { ProviderRegistry, escalate, maxTier } from './providers/index.ts';
import { route } from './router.ts';
import { Store, newTaskId } from './store.ts';
import { AgentError, PROMPT_OVERHEAD_CHARS, runAgent as defaultRunAgent, type AgentRunInput, type AgentRunOutput } from './agents/index.ts';
import { AGENT_PROMPTS } from './agents/prompts.ts';
import { summarizeDecision } from './routing/preflight.ts';
import { BudgetExceededError, TERMINAL_STATUSES, addUsage, emptyUsage, type AgentRole, type Budget, type StepRecord, type TaskRecord, type TaskStatus, type Tier, type VerificationResult, type WorkflowStep } from './types.ts';
import { plansForScope, runVerification as defaultRunVerification } from './verify.ts';
import { getWorkflow } from './workflows.ts';

// The state machine. Everything that decides flow — retries, escalation,
// budget stops, pass/fail — is ordinary code here. Agents only produce
// content; verification produces truth.

export interface OrchestratorDeps {
  store: Store;
  registry: ProviderRegistry;
  runAgent?: (input: AgentRunInput) => Promise<AgentRunOutput>;
  runVerification?: typeof defaultRunVerification;
  log?: (line: string) => void;
  pollMs?: number;
  now?: () => number;
  /** Longest cooldown the orchestrator will wait out instead of failing the task (default 3 min). */
  maxCooldownWaitMs?: number;
}

export interface CreateTaskInput {
  description: string;
  project?: string;
  desiredOutcome?: string;
  budget?: Partial<Budget>;
  tier?: Tier;
}

export function createTask(input: CreateTaskInput, projects: Project[] = loadProjects()): { task: TaskRecord; project: Project } {
  let project: Project | undefined;
  if (input.project) {
    project = getProject(input.project, projects);
    if (!project) throw new Error(`unknown project '${input.project}'. Known: ${projects.map((p) => p.slug).join(', ')}`);
  } else {
    const inferred = inferProject(`${input.description} ${input.desiredOutcome ?? ''}`, projects);
    if (!inferred.project) {
      throw new Error(inferred.candidates.length
        ? `ambiguous project (${inferred.candidates.join(', ')}); pass --project`
        : `could not infer the project; pass --project <slug>. Known: ${projects.map((p) => p.slug).join(', ')}`);
    }
    project = inferred.project;
  }
  const decision = route(input.description, project, input.desiredOutcome);
  if (input.tier) decision.tier = input.tier;
  const cfg = loadConfig();
  const budget: Budget = { ...cfg.defaultBudget, ...input.budget };
  // Wall clock must at least fit the estimated eval time or the run is doomed by construction.
  const minWall = decision.estimatedWallClockMinutes * 60_000;
  if (budget.maxWallClockMs < minWall) { budget.maxWallClockMs = minWall; decision.rationale.push(`wall clock raised to ${decision.estimatedWallClockMinutes}min to fit verification`); }
  if (budget.maxAgentCalls < decision.estimatedAgentCalls) decision.rationale.push(`warning: budget allows ${budget.maxAgentCalls} agent calls but the workflow estimates ${decision.estimatedAgentCalls}`);
  const now = new Date().toISOString();
  const task: TaskRecord = {
    id: newTaskId(), createdAt: now, updatedAt: now, project: project.slug,
    description: input.description, desiredOutcome: input.desiredOutcome,
    route: decision, budget, usage: emptyUsage(), status: 'queued', attempt: 1, steps: [], verifications: [],
  };
  return { task, project };
}

const ROLE_STATUS: Record<AgentRole, TaskStatus> = {
  planner: 'planning', research: 'researching', coding: 'implementing', debugging: 'debugging',
  evaluation: 'evaluating', reviewer: 'reviewing', product: 'reviewing',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runTask(task: TaskRecord, deps: OrchestratorDeps, projects: Project[] = loadProjects()): Promise<TaskRecord> {
  const { store, registry } = deps;
  const runAgent = deps.runAgent ?? defaultRunAgent;
  const runVerification = deps.runVerification ?? defaultRunVerification;
  const log = deps.log ?? (() => {});
  const maybeProject = getProject(task.project, projects);
  if (!maybeProject) throw new Error(`unknown project ${task.project}`);
  const project: Project = maybeProject;
  const workflow = getWorkflow(task.route.workflow);
  const steps = workflow.steps;
  const retryIndex = Math.max(0, steps.findIndex((s) => s.id === workflow.retryFrom));
  const budget = new BudgetManager(task.budget, task.usage, task.startedAt ? Date.parse(task.startedAt) : Date.now());

  task.startedAt = task.startedAt ?? new Date().toISOString();
  task.pid = process.pid;
  task.providersAvailable = registry.healthyIds();
  const event = (type: string, payload: Record<string, unknown> = {}) => store.appendEvent({ taskId: task.id, project: task.project, type, ...payload });
  const setStatus = (s: TaskStatus) => { task.status = s; store.saveTask(task); event('status', { status: s }); log(`[${task.id}] ${s}`); };
  const finish = (status: TaskStatus, outcome: TaskRecord['outcome'], reason?: string) => {
    task.outcome = outcome; task.failureReason = reason; task.endedAt = new Date().toISOString();
    task.durationMs = Date.parse(task.endedAt) - Date.parse(task.startedAt!);
    task.currentStep = undefined;
    setStatus(status);
    event('task.end', { outcome, reason, usage: task.usage, durationMs: task.durationMs });
    store.clearControl(task.id);
    return task;
  };

  let tier: Tier = task.route.tier;
  let i = 0;
  let failures: VerificationResult[] = [];
  let taskBaselineEval = task.verifications.find((v) => v.kind === 'eval' && v.evalSummary)?.evalSummary;
  let partial = false;
  const partialReasons: string[] = [];

  event('task.start', { route: task.route, budget: task.budget });
  setStatus('routing');

  const replan = async (reason: string, opts: { analyze: boolean; escalateTier: boolean; restartAt?: number }): Promise<boolean> => {
    // Returns false when no retries remain (caller must fail the task).
    if (!budget.canRetry(task.attempt + 1 - 1) || task.attempt > task.budget.maxRetries) return false;
    if (opts.analyze && failures.length) {
      setStatus('analyzing_failure');
      const analysis = await runStep({ id: `analyze_failure_${task.attempt}`, kind: 'agent', role: 'debugging', goal: 'Analyze the verbatim verification failure below. Identify the root cause and state the smallest change that would make verification pass. Do not change files. Call finish with root_cause and proposed_change.' }, maxTier(tier, 'standard'));
      if (analysis.status === 'failed') log(`[${task.id}] failure analysis itself failed: ${analysis.error}`);
    }
    setStatus('replanning');
    task.attempt += 1;
    budget.recordRetry();
    if (opts.escalateTier) tier = escalate(tier);
    i = opts.restartAt ?? retryIndex;
    event('replan', { reason, attempt: task.attempt, tier, restartAt: steps[i]?.id });
    log(`[${task.id}] replan (${reason}) → attempt ${task.attempt}, tier ${tier}, from ${steps[i]?.id}`);
    store.saveTask(task);
    return true;
  };

  async function runStep(step: WorkflowStep, stepTier: Tier): Promise<StepRecord> {
    const rec: StepRecord = { id: `${step.id}#${task.attempt}`, stepId: step.id, attempt: task.attempt, kind: 'agent', role: step.role, status: 'running', startedAt: new Date().toISOString(), usage: emptyUsage(), toolCalls: [], summary: '' };
    task.steps.push(rec); task.currentStep = step.id; store.saveTask(task);
    const priorSteps = task.steps.filter((s) => s !== rec && s.status !== 'running');
    const taskText = task.description + (task.desiredOutcome ? `\n${task.desiredOutcome}` : '');
    const spec = AGENT_PROMPTS[step.role!];
    const fixedChars = PROMPT_OVERHEAD_CHARS + (step.goal?.length ?? 0) + taskText.length + spec.prompt.length;
    const rem = budget.remaining();
    // Preflight BEFORE building context: the tier's ideal pack is only built if a model can take it.
    const ideal = charBudgetFor(stepTier);
    const probe = registry.route({ tier: stepTier, role: step.role, promptChars: ideal + fixedChars, expectedCalls: spec.maxSteps, outputTokens: 4096, needsTools: true, needsJson: false, budget: { remainingCostUsd: rem.costUsd, remainingCalls: rem.calls, maxCostUsd: task.budget.maxCostUsd } });
    // If nothing takes the ideal size, size to the largest feasible-but-for-context candidate.
    const fits = probe.remaining.length ? ideal : Math.max(...probe.eliminated.filter((c) => c.eliminated!.reason === 'context_too_small' && c.promptCharBudget).map((c) => c.promptCharBudget! - fixedChars - 1_000), 0);
    const charBudget = Math.max(3_000, Math.min(ideal, fits));
    const context = buildContext({ project, task: taskText, role: step.role!, tier: stepTier, priorSteps, failures, charBudget });
    rec.context = context.stats;
    const routed = registry.route({ ...probe.requirements, promptChars: context.stats.chars + fixedChars });
    rec.routing = { preflight: summarizeDecision(routed), idealChars: ideal, contextChars: context.stats.chars };
    rec.provider = routed.resolved?.provider.id; rec.model = routed.resolved?.model.id;
    event('step.start', { step: step.id, role: step.role, tier: stepTier, context: context.stats });
    event('routing.decision', { step: step.id, phase: 'preflight', ...summarizeDecision(routed) });
    if (!routed.resolved) {
      rec.status = 'failed'; rec.error = `no feasible model: ${routed.explanation}`;
      rec.structured = { agent_status: 'error', no_feasible_model: true, next_cooldown_ends_at: routed.nextCooldownEndsAt ? new Date(routed.nextCooldownEndsAt).toISOString() : undefined };
      finalizeStep(rec);
      return rec;
    }
    try {
      const out = await runAgent({
        role: step.role!, goal: step.goal ?? '', taskDescription: task.description, desiredOutcome: task.desiredOutcome,
        project, tier: stepTier, context, budget, registry, resolved: routed.resolved, taskId: task.id,
        rebuildContext: (cb) => buildContext({ project, task: taskText, role: step.role!, tier: stepTier, priorSteps, failures, charBudget: cb }),
        onEvent: (type, payload) => event(type, { step: step.id, ...payload }),
      });
      rec.provider = out.provider; rec.model = out.model; rec.usage = out.usage; rec.toolCalls = out.toolCalls;
      rec.summary = out.summary; rec.structured = out.structured; rec.error = out.error;
      rec.routing = { ...rec.routing, ...(out.routing ?? {}) }; rec.progress = out.progress;
      rec.status = out.status === 'done' ? 'done' : 'failed';
      if (out.status === 'blocked' || out.status === 'needs_escalation') rec.status = 'done';
      rec.structured = { ...(out.structured ?? {}), agent_status: out.status };
      // A delegated run cut off at its spend cap still counts as work done, but the
      // task must never report it as a clean success. Verification judges the code;
      // this only makes the truncation visible in the outcome.
      if (out.truncated) {
        partial = true;
        partialReasons.push(`step ${step.id} was truncated by the provider spend cap; its work is incomplete`);
        event('step.truncated', { step: step.id, provider: out.provider, model: out.model });
        log(`[${task.id}] step ${step.id} TRUNCATED at the provider spend cap — keeping its work for verification`);
      }
    } catch (e) {
      if (e instanceof BudgetExceededError) { rec.status = 'failed'; rec.error = e.message; finalizeStep(rec); throw e; }
      rec.status = 'failed'; rec.error = (e as Error).message;
      if (e instanceof AgentError && e.routing) { rec.routing = { ...rec.routing, failed: e.routing }; rec.structured = { agent_status: 'error', no_feasible_model: true }; }
    }
    finalizeStep(rec);
    return rec;
  }

  function finalizeStep(rec: StepRecord): void {
    rec.endedAt = new Date().toISOString();
    rec.durationMs = Date.parse(rec.endedAt) - Date.parse(rec.startedAt);
    store.saveTask(task);
    event('step.end', { step: rec.stepId, status: rec.status, usage: rec.usage, error: rec.error, durationMs: rec.durationMs, tools: rec.toolCalls.length });
    log(`[${task.id}] step ${rec.stepId} → ${rec.status}${rec.model ? ` (${rec.provider}/${rec.model})` : ''}${rec.error ? `: ${rec.error.slice(0, 160)}` : ''}`);
  }

  try {
    while (i < steps.length) {
      // Control flags from the dashboard/CLI are honoured between steps.
      let control = store.readControl(task.id);
      if (control === 'stop') return finish('stopped', 'stopped', 'stopped by user');
      if (control === 'pause') {
        setStatus('paused');
        while (control === 'pause') {
          if (budget.elapsedMs() > task.budget.maxWallClockMs) return finish('budget_exhausted', 'budget_exhausted', 'wall clock expired while paused');
          await sleep(deps.pollMs ?? 2000);
          control = store.readControl(task.id);
        }
        if (control === 'stop') return finish('stopped', 'stopped', 'stopped by user');
        store.clearControl(task.id);
      }
      if (control === 'replan') {
        store.clearControl(task.id);
        if (!(await replan('user requested replan', { analyze: false, escalateTier: true }))) return finish('failed', 'failed', 'replan requested but no retries remain');
        continue;
      }
      const over = budget.exceeded();
      if (over) return finish('budget_exhausted', 'budget_exhausted', over);

      const step = steps[i];
      if (step.kind === 'verify') {
        const plans = plansForScope(task.route.verification, step.verify!);
        const rec: StepRecord = { id: `${step.id}#${task.attempt}`, stepId: step.id, attempt: task.attempt, kind: 'verify', status: 'running', startedAt: new Date().toISOString(), usage: emptyUsage(), toolCalls: [], summary: '', verification: [] };
        task.steps.push(rec); task.currentStep = step.id;
        if (!plans.length) { rec.status = 'skipped'; rec.summary = 'no verification signals available for this project/scope'; finalizeStep(rec); i++; continue; }
        setStatus(step.verify === 'baseline' ? 'evaluating' : 'verifying');
        const results: VerificationResult[] = [];
        for (const plan of plans) {
          const isEval = plan.kind === 'eval';
          // After a change, re-run only the cases that unexpectedly failed at baseline: cheap, targeted signal.
          // Expected failures do not gate, and regressions on passing cases need the full run (certified separately).
          const filterIds = isEval && step.verify !== 'baseline' && taskBaselineEval ? taskBaselineEval.unexpectedFailures : undefined;
          log(`[${task.id}] verify ${plan.id}: ${plan.command}${filterIds?.length ? ` (filtered to ${filterIds.length} previously failing cases)` : ''}`);
          event('verify.start', { step: step.id, check: plan.id, command: plan.command, filtered: filterIds?.length ?? 0 });
          const r = await runVerification(plan, project, { filterIds: filterIds?.length ? filterIds : undefined, taskBaseline: step.verify === 'baseline' ? undefined : taskBaselineEval });
          results.push(r); task.verifications.push(r); rec.verification!.push(r);
          event('verify.end', { step: step.id, check: plan.id, passed: r.passed, exitCode: r.exitCode, durationMs: r.durationMs, eval: r.evalSummary ? { passed: r.evalSummary.passed, total: r.evalSummary.total, scope: r.evalSummary.scope, errored: r.evalSummary.errored } : undefined, error: r.error });
          log(`[${task.id}] verify ${plan.id} → ${r.passed ? 'PASS' : 'FAIL'}${r.evalSummary ? ` (${r.evalSummary.passed}/${r.evalSummary.total}, ${r.evalSummary.scope})` : ''}${r.error ? `: ${r.error.slice(0, 200)}` : ''}`);
          if (r.evalSummary) {
            if (r.evalSummary.scope === 'full') task.evalScore = r.evalSummary.passRate;
            else task.evalFilteredScore = r.evalSummary.passRate;
            if (step.verify === 'baseline' && !taskBaselineEval) { taskBaselineEval = r.evalSummary; task.evalBaselineScore = r.evalSummary.passRate; }
            if (r.evalSummary.scope === 'filtered' && step.verify !== 'baseline') { partial = true; partialReasons.push('final eval was a filtered re-run, not a full suite (daily token cap)'); }
          }
          store.saveTask(task);
        }
        const deferred = results.filter((r) => r.skipped);
        for (const d of deferred) { partial = true; partialReasons.push(`${d.id} ${d.error ?? 'deferred'}`); }
        const failed = results.filter((r) => !r.passed && !r.skipped);
        const requiredFailed = failed.filter((r) => plans.find((p) => p.id === r.id)?.required);
        rec.summary = results.map((r) => `${r.label}: ${r.passed ? 'PASS' : 'FAIL'}`).join('; ');
        if (step.verify === 'baseline') {
          // Baseline is informational: it seeds the analysis step with verbatim failures.
          rec.status = 'done'; failures = failed; finalizeStep(rec); i++; continue;
        }
        if (requiredFailed.length === 0) {
          if (failed.length) { partial = true; partialReasons.push(`optional checks failed: ${failed.map((f) => f.id).join(', ')}`); }
          rec.status = 'done'; failures = []; finalizeStep(rec); i++; continue;
        }
        rec.status = 'failed'; rec.error = requiredFailed.map((f) => `${f.id}: ${f.error ?? `exit ${f.exitCode}`}`).join('; ');
        finalizeStep(rec);
        failures = requiredFailed;
        if (!(await replan(`verification failed (${requiredFailed.map((f) => f.id).join(', ')})`, { analyze: true, escalateTier: true }))) {
          return finish('failed', 'failed', `verification still failing after ${task.attempt} attempt(s): ${rec.error}`);
        }
        continue;
      }

      // Agent step
      const stepTier = maxTier(tier, step.minTier ?? 'light');
      setStatus(ROLE_STATUS[step.role!]);
      const rec = await runStep(step, stepTier);
      const agentStatus = rec.structured?.agent_status as string | undefined;
      if (rec.status === 'failed' && rec.structured?.no_feasible_model) {
        const until = rec.structured.next_cooldown_ends_at ? Date.parse(String(rec.structured.next_cooldown_ends_at)) : NaN;
        const waitMs = Number.isFinite(until) ? until - Date.now() : NaN;
        if (Number.isFinite(waitMs) && waitMs > 0 && waitMs <= (deps.maxCooldownWaitMs ?? 3 * 60_000) && budget.remaining().ms > waitMs + 60_000) {
          log(`[${task.id}] no feasible model right now; waiting ${Math.ceil(waitMs / 1000)}s for a cooldown to end`);
          event('routing.wait', { step: step.id, waitMs });
          await sleep(waitMs + 500);
          continue; // re-run the same step index without spending a retry
        }
        return finish('failed', 'failed', `step ${step.id}: ${rec.error}`);
      }
      if (rec.status === 'failed') {
        const fallback = /falling back/.test(rec.error ?? '');
        if (!(await replan(`agent ${step.role} failed: ${rec.error?.slice(0, 100)}`, { analyze: false, escalateTier: !fallback, restartAt: i }))) {
          return finish('failed', 'failed', `agent ${step.role} failed and no retries remain: ${rec.error}`);
        }
        continue;
      }
      if (agentStatus === 'needs_escalation') {
        if (!(await replan(`agent ${step.role} requested escalation`, { analyze: false, escalateTier: true, restartAt: i }))) {
          return finish('failed', 'failed', `agent ${step.role} needed escalation but no retries remain: ${rec.summary.slice(0, 200)}`);
        }
        continue;
      }
      if (agentStatus === 'blocked') {
        return finish('failed', 'failed', `agent ${step.role} blocked: ${rec.summary.slice(0, 300)}`);
      }
      const verdict = String(rec.structured?.verdict ?? '').toLowerCase();
      const satisfied = rec.structured?.satisfied;
      if ((step.role === 'reviewer' && verdict.includes('request')) || (step.role === 'product' && satisfied === false)) {
        const ok = await replan(`${step.role} rejected the result`, { analyze: false, escalateTier: false });
        if (!ok) { partial = true; partialReasons.push(`${step.role} rejected the final result: ${rec.summary.slice(0, 200)}`); i++; continue; }
        continue;
      }
      i++;
    }

    const lastAgent = [...task.steps].reverse().find((s) => s.kind === 'agent' && s.status === 'done');
    task.finalSummary = lastAgent?.summary;
    if (partial) task.failureReason = partialReasons.join('; ');
    return finish('completed', partial ? 'partial' : 'success', partial ? partialReasons.join('; ') : undefined);
  } catch (e) {
    if (e instanceof BudgetExceededError) return finish('budget_exhausted', 'budget_exhausted', e.reason);
    return finish('failed', 'failed', `orchestrator error: ${(e as Error).message}`);
  }
}

export function isTerminal(task: TaskRecord): boolean {
  return TERMINAL_STATUSES.includes(task.status);
}

export { addUsage };
