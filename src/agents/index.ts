import type { BudgetManager } from '../budget.ts';
import type { ContextPack } from '../context/manager.ts';
import type { Project } from '../projects.ts';
import type { ProviderRegistry, ResolvedModel, RouteResult } from '../providers/index.ts';
import { ProviderError, type ChatMessage, type ToolDef } from '../providers/types.ts';
import { recordAgentGroqTokens, recordModelRequest } from '../quota.ts';
import type { StepRequirements } from '../routing/preflight.ts';
import { summarizeDecision } from '../routing/preflight.ts';
import { emptyUsage, type AgentRole, type Tier, type ToolCallRecord, type Usage } from '../types.ts';
import { DEFAULT_PROGRESS_POLICY, ProgressTracker, READ_ONLY_PROGRESS_POLICY } from './progress.ts';
import { AGENT_PROMPTS } from './prompts.ts';
import { TOOL_DEFS, executeTool, workspaceFingerprint } from './tools.ts';

// Agents are thin adapters: a role prompt, a tool subset, and a bounded loop
// around provider.chat(). The orchestrator owns state; the budget manager owns
// limits; this file only runs one step.
//
// Discipline inside the loop:
//  - the model is chosen by preflight against the ACTUAL prompt size, tools and quota
//  - tool outputs are capped before they enter the history; old ones are elided later
//  - a progress policy demands a checkpoint, then forces finish, when turns produce nothing
//  - the final turn offers only `finish`, so a step always ends with a usable result
//  - a provider failure re-runs preflight on the CURRENT history and shrinks it to fit the fallback

export interface AgentRunInput {
  role: AgentRole;
  goal: string;
  taskDescription: string;
  desiredOutcome?: string;
  project: Project;
  tier: Tier;
  context: ContextPack;
  budget: BudgetManager;
  registry: ProviderRegistry;
  onEvent?: (type: string, payload: Record<string, unknown>) => void;
  /** Pre-routed model (the orchestrator sized the context for it). Re-validated against the real prompt. */
  resolved?: ResolvedModel;
  /** Rebuild the context pack within a smaller budget when a fallback model cannot take the original. */
  rebuildContext?: (charBudget: number) => ContextPack;
  taskId?: string;
}

export type AgentStatus = 'done' | 'blocked' | 'needs_escalation' | 'max_steps' | 'error';

export interface AgentRunOutput {
  status: AgentStatus;
  summary: string;
  structured?: Record<string, unknown>;
  usage: Usage;
  toolCalls: ToolCallRecord[];
  provider: string;
  model: string;
  error?: string;
  /** HTTP status of a provider failure. */
  providerStatus?: number;
  /** Models switched away from mid-step because of provider failures. */
  fallbacks?: string[];
  routing?: Record<string, unknown>;
  progress?: Record<string, unknown>;
  /** True when the step ended because progress stalled (not because the work was done). */
  forcedFinish?: boolean;
  /** A delegated run was cut off by the provider's spend cap but had already changed files. */
  truncated?: boolean;
}

export class AgentError extends Error {
  routing?: Record<string, unknown>;
  constructor(message: string, routing?: Record<string, unknown>) { super(message); this.name = 'AgentError'; this.routing = routing; }
}

export const HISTORY_TOOL_OUTPUT_CAP = 12_000;
export const HISTORY_CHAR_BUDGET = 110_000;
export const HISTORY_KEEP_RECENT_TOOL_OUTPUTS = 3;
/** Fixed overhead of the system prompt, rules block and finish instructions, in chars. */
export const PROMPT_OVERHEAD_CHARS = 2_500;

export function listAgents(): Array<{ role: AgentRole; description: string; capabilities: string[]; write: boolean; maxSteps: number }> {
  return (Object.keys(AGENT_PROMPTS) as AgentRole[]).map((role) => ({ role, ...AGENT_PROMPTS[role] }));
}

function toolsFor(role: AgentRole, readOnlyGoal: boolean): ToolDef[] {
  const spec = AGENT_PROMPTS[role];
  const names = ['list_files', 'read_file', 'search', 'finish'];
  if (spec.capabilities.includes('run_commands') || spec.capabilities.includes('run_tests') || spec.capabilities.includes('run_eval')) names.push('run_command');
  if (spec.write && !readOnlyGoal) names.push('edit_file', 'write_file');
  return names.map((n) => TOOL_DEFS[n]);
}

function userPrompt(input: AgentRunInput, context: ContextPack, maxSteps: number): string {
  const files = context.stats.files;
  return [
    `# Task\n${input.taskDescription}`,
    input.desiredOutcome ? `# Desired outcome\n${input.desiredOutcome}` : '',
    `# This step\n${input.goal}`,
    `# Working rules\n- You have at most ${maxSteps} model turns in this step; budget them. Each tool call costs a turn.\n- The context pack below already contains these files (in full or as excerpts): ${files.join(', ') || 'none'}. Do not re-read a file that is shown in full; read only the parts you still need.\n- Prefer search over reading whole files. Never read the same file range twice.\n- Reading is not progress. When you have enough to answer, stop reading and call finish.`,
    `# Context pack (selected; pull more with tools)\n${context.text}`,
  ].filter(Boolean).join('\n\n');
}

/** Requirements for preflight, computed from what will actually be sent. */
export function requirementsFor(input: AgentRunInput, context: ContextPack, opts: { expectedCalls: number; historyChars?: number }): StepRequirements {
  const spec = AGENT_PROMPTS[input.role];
  const promptChars = opts.historyChars ?? (context.stats.chars + input.goal.length + input.taskDescription.length + (input.desiredOutcome?.length ?? 0) + spec.prompt.length + PROMPT_OVERHEAD_CHARS);
  const rem = input.budget.remaining();
  return {
    tier: input.tier, role: input.role, promptChars, expectedCalls: opts.expectedCalls, outputTokens: 4096,
    needsTools: true, needsJson: false,
    budget: { remainingCostUsd: rem.costUsd, remainingCalls: rem.calls, maxCostUsd: input.budget.budget.maxCostUsd },
  };
}

/** Elide older tool outputs once the history is large; the model can re-read anything it still needs. */
export function pruneHistory(messages: ChatMessage[], budget: number = HISTORY_CHAR_BUDGET, keepRecent: number = HISTORY_KEEP_RECENT_TOOL_OUTPUTS): number {
  let total = messages.reduce((a, m) => a + m.content.length, 0);
  if (total <= budget) return 0;
  const toolIdx = messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0);
  const prunable = toolIdx.slice(0, Math.max(0, toolIdx.length - keepRecent));
  let pruned = 0;
  for (const i of prunable) {
    const m = messages[i];
    if (m.content.startsWith('[elided')) continue;
    const firstLine = m.content.split('\n')[0].slice(0, 120);
    total -= m.content.length;
    m.content = `[elided earlier ${m.toolName ?? 'tool'} output (${m.content.length} chars) to save context; first line was: ${firstLine}. Re-run the tool if you need it.]`;
    total += m.content.length;
    pruned++;
    if (total <= budget * 0.7) break;
  }
  return pruned;
}

export const historyChars = (messages: ChatMessage[]) => messages.reduce((a, m) => a + m.content.length, 0);

/** Make a history fit a smaller window: elide older outputs (keeping 3, then 1, then 0), then truncate what remains. */
export function shrinkHistory(messages: ChatMessage[], target: number): void {
  for (const keep of [3, 1, 0]) { if (historyChars(messages) <= target) return; pruneHistory(messages, target, keep); }
  if (historyChars(messages) <= target) return;
  const tools = messages.filter((m) => m.role === 'tool' && !m.content.startsWith('[elided'));
  const perOutput = Math.max(500, Math.floor((target - (messages[0]?.content.length ?? 0) - (messages[1]?.content.length ?? 0)) / Math.max(1, tools.length) * 0.6));
  for (const m of tools) if (m.content.length > perOutput) m.content = m.content.slice(0, perOutput) + '\n... (truncated to fit the fallback model; re-run the tool for more)';
}

function mergeUsage(usage: Usage, delta: Usage): void {
  usage.modelCalls += delta.modelCalls;
  usage.tokens.input += delta.tokens.input; usage.tokens.output += delta.tokens.output; usage.tokens.reasoning += delta.tokens.reasoning; usage.tokens.cacheRead += delta.tokens.cacheRead;
  usage.callsWithoutUsage += delta.callsWithoutUsage;
  if (delta.estimatedCostUsd !== null) usage.estimatedCostUsd = (usage.estimatedCostUsd ?? 0) + delta.estimatedCostUsd;
  if (delta.providerReportedCostUsd !== null) usage.providerReportedCostUsd = (usage.providerReportedCostUsd ?? 0) + delta.providerReportedCostUsd;
}

export async function runAgent(input: AgentRunInput): Promise<AgentRunOutput> {
  const spec = AGENT_PROMPTS[input.role];
  const readOnlyGoal = /do not (change|modify|edit) files/i.test(input.goal);
  const allowWrite = spec.write && !readOnlyGoal;
  let context = input.context;

  // Preflight against the real prompt. The orchestrator's pre-routed model is kept only if it still fits.
  let route: RouteResult = input.registry.route(requirementsFor(input, context, { expectedCalls: spec.maxSteps }));
  const preRouted = input.resolved && route.remaining.some((c) => c.key === `${input.resolved!.provider.id}/${input.resolved!.model.id}`) ? input.resolved : undefined;
  let resolved = preRouted ?? route.resolved;
  const routingLog: Array<Record<string, unknown>> = [{ phase: 'initial', ...summarizeDecision(route), kept_prerouted: Boolean(preRouted) }];
  input.onEvent?.('routing.decision', { phase: 'initial', ...summarizeDecision(route) });
  if (!resolved) throw new AgentError(`no feasible model for ${input.role} (${route.explanation})`, summarizeDecision(route));
  let { provider, model } = resolved;

  const usage = emptyUsage();
  const toolCalls: ToolCallRecord[] = [];
  const fallbacks: string[] = [];
  const emit = (type: string, payload: Record<string, unknown> = {}) => input.onEvent?.(type, { role: input.role, provider: provider.id, model: model.id, ...payload });
  input.budget.recordContext(context.stats.chars);
  usage.contextChars = context.stats.chars;
  const progress = new ProgressTracker(allowWrite ? DEFAULT_PROGRESS_POLICY : READ_ONLY_PROGRESS_POLICY);
  const done = (status: AgentStatus, summary: string, extra: Partial<AgentRunOutput> = {}): AgentRunOutput => {
    usage.costBasis = input.budget.usage.costBasis;
    if (status === 'done') input.registry.recordSuccess(provider.id, model.id, input.taskId);
    return { status, summary: summary.slice(0, 4000), usage, toolCalls, provider: provider.id, model: model.id, fallbacks: fallbacks.length ? fallbacks : undefined, routing: { decisions: routingLog }, progress: progress.summary(), ...extra };
  };

  // Delegated provider (claude-cli): it runs its own loop; we cap dollars and time.
  if (provider.mode === 'delegated' && typeof provider.runDelegated === 'function') {
    input.budget.assertCanCall('model');
    const remaining = input.budget.remaining();
    const cap = Math.max(0.05, Math.min(1.5, remaining.costUsd));
    emit('agent.call', { mode: 'delegated', maxBudgetUsd: cap });
    // Fingerprint the tree so a run that dies at its spend cap can be told apart
    // from one that died having already done the work.
    const before = await workspaceFingerprint(input.project);
    const r = await provider.runDelegated({
      prompt: userPrompt(input, context, spec.maxSteps) + '\n\nWhen finished, end your reply with a JSON object on its own line: {"finish": {"summary": "...", "status": "done|blocked|needs_escalation", "changed_files": [], "verdict": "", "findings": []}}',
      systemPrompt: spec.prompt + `\n\nProject instructions: ${input.project.agentInstructions}`,
      cwd: input.project.repository, model: model.id, allowWrite, maxBudgetUsd: cap,
      timeoutMs: Math.min(20 * 60_000, Math.max(60_000, remaining.ms)),
    });
    const after = await workspaceFingerprint(input.project);
    const filesChanged = before !== null && after !== null && before !== after;
    mergeUsage(usage, input.budget.recordModelCall(model.id, r.usage, r.providerCostUsd));

    // A spend cap that trips AFTER the agent has edited files is not a failed
    // model — it is an interrupted one. Throwing the result away loses work that
    // is already on disk, and blaming the model's reliability for our own cap is
    // simply wrong. Keep the summary and let verification judge what landed.
    const truncated = Boolean(r.isError && r.budgetStopped && filesChanged);
    if (r.isError && !truncated) {
      const message = r.error ?? 'delegated run failed with no message';
      input.registry.markUnavailable(provider.id, model.id, 'delegated run failed', { message }, input.taskId);
      return done('error', '', { error: message });
    }

    const m = /\{"finish":\s*(\{[\s\S]*\})\s*\}\s*$/.exec(r.text.trim());
    let structured: Record<string, unknown> | undefined;
    if (m) { try { structured = JSON.parse(m[1]) as Record<string, unknown>; } catch { /* keep text */ } }
    const status = (structured?.status as AgentStatus | undefined) ?? 'done';
    let summary = String(structured?.summary ?? r.text);
    if (truncated) {
      const spent = r.providerCostUsd === null ? 'an unreported amount' : `${r.providerCostUsd.toFixed(4)}`;
      emit('agent.truncated', { subtype: r.subtype, spentUsd: r.providerCostUsd, capUsd: cap });
      summary += `\n\n[TRUNCATED: the provider stopped this run at its spend cap (${spent} against a ${cap.toFixed(2)} cap) after it had already changed files. Treat the work as incomplete; verification decides whether what landed is correct.]`;
      structured = { ...(structured ?? {}), truncated: true, truncated_reason: r.subtype ?? 'provider spend cap', spent_usd: r.providerCostUsd };
    }
    return done(['done', 'blocked', 'needs_escalation'].includes(status) ? status : 'done', summary, { structured, truncated });
  }

  const allTools = toolsFor(input.role, readOnlyGoal);
  const finishOnly = allTools.filter((t) => t.name === 'finish');
  const messages: ChatMessage[] = [
    { role: 'system', content: spec.prompt },
    { role: 'user', content: userPrompt(input, context, spec.maxSteps) },
  ];
  const ctx = { project: input.project, allowWrite };
  let emptyResponses = 0;
  let textOnlyTurns = 0;
  let providerFailures = 0;
  let forceFinish = false;
  let checkpointPending = false;

  /**
   * Fallback correctness: recompute requirements from the CURRENT history, run preflight, and make the
   * history fit the chosen model (elide tool outputs; rebuild the context pack smaller if needed).
   */
  const fallbackTo = (e: ProviderError | Error, status: number | undefined): boolean => {
    const stepsLeft = Math.max(1, spec.maxSteps - progress.turns);
    for (let attempt = 0; attempt < 3; attempt++) {
      const req = requirementsFor(input, context, { expectedCalls: stepsLeft, historyChars: historyChars(messages) });
      const next = input.registry.route(req);
      routingLog.push({ phase: 'fallback', trigger: (e as Error).message.slice(0, 200), ...summarizeDecision(next) });
      input.onEvent?.('routing.decision', { phase: 'fallback', trigger: (e as Error).message.slice(0, 200), ...summarizeDecision(next) });
      if (!next.resolved) {
        // Nothing takes the history as-is. Shrink it and try once more; if the base prompt is the problem, rebuild the pack.
        const smallest = Math.min(...next.eliminated.filter((c) => c.eliminated!.reason === 'context_too_small' && c.promptCharBudget).map((c) => c.promptCharBudget!));
        if (!Number.isFinite(smallest) || smallest < 6_000) return false;
        const target = Math.floor(smallest * 0.9);
        shrinkHistory(messages, target);
        if (historyChars(messages) > target && input.rebuildContext) {
          context = input.rebuildContext(Math.max(3_000, target - PROMPT_OVERHEAD_CHARS - input.goal.length - input.taskDescription.length - spec.prompt.length - 2_000));
          messages[1] = { role: 'user', content: userPrompt(input, context, spec.maxSteps) };
          emit('agent.context_rebuilt', { chars: context.stats.chars, target });
          pruneHistory(messages, target);
        }
        if (historyChars(messages) > target) shrinkHistory(messages, target);
        if (historyChars(messages) > target) return false;
        continue;
      }
      if (next.resolved.provider.mode !== 'chat') return false;
      const key = `${next.resolved.provider.id}/${next.resolved.model.id}`;
      if (key === `${provider.id}/${model.id}`) return false;
      fallbacks.push(`${provider.id}/${model.id}`);
      emit('agent.fallback', { from: `${provider.id}/${model.id}`, to: key, status, error: (e as Error).message.slice(0, 400) });
      provider = next.resolved.provider; model = next.resolved.model;
      for (const m of messages) delete m.rawParts;
      pruneHistory(messages, Math.min(HISTORY_CHAR_BUDGET, model.promptCharBudget));
      return true;
    }
    return false;
  };

  for (let step = 0; step < spec.maxSteps; step++) {
    input.budget.assertCanCall('model');
    const quotaLeft = input.registry.remainingRequests(provider.id, model);
    const lastStep = step === spec.maxSteps - 1 || quotaLeft <= 1 || forceFinish;
    if (lastStep) {
      const why = forceFinish ? ' (no progress after a checkpoint)' : quotaLeft <= 1 ? ' (model daily quota nearly exhausted)' : '';
      messages.push({ role: 'user', content: `This is your final turn in this step${why}. Call finish now with your best summary and status; you cannot use other tools.` });
    } else if (checkpointPending) {
      messages.push({ role: 'user', content: progress.checkpointPrompt() });
    }
    const pruned = pruneHistory(messages, Math.min(HISTORY_CHAR_BUDGET, model.promptCharBudget));
    if (pruned) emit('agent.prune', { elided: pruned });
    emit('agent.call', { step, lastStep });
    let resp;
    try {
      resp = await provider.chat({ model: model.id, messages, tools: lastStep ? finishOnly : allTools, temperature: 0.2, maxTokens: 4096 });
    } catch (e) {
      input.budget.recordModelCall(model.id, null);
      if (model.dailyRequestCap !== undefined) recordModelRequest(`${provider.id}/${model.id}`);
      usage.modelCalls += 1; usage.callsWithoutUsage += 1;
      const status = e instanceof ProviderError ? e.status : undefined;
      input.registry.markUnavailable(provider.id, model.id, `${status ?? 'network'} mid-step`, { status, message: (e as Error).message, retryAfterMs: e instanceof ProviderError ? e.retryAfterMs : undefined, promptChars: status === 413 ? historyChars(messages) : undefined }, input.taskId);
      providerFailures++;
      if (providerFailures <= 3 && fallbackTo(e as Error, status)) { step--; continue; }
      return done('error', '', { error: `provider error: ${(e as Error).message}`, providerStatus: status });
    }
    const delta = input.budget.recordModelCall(model.id, resp.usage, resp.providerCostUsd);
    if (model.dailyRequestCap !== undefined) recordModelRequest(`${provider.id}/${model.id}`);
    if (provider.id === 'groq' && resp.usage) recordAgentGroqTokens(resp.usage.input + resp.usage.output + resp.usage.reasoning);
    mergeUsage(usage, delta);

    if (!resp.text && resp.toolCalls.length === 0) {
      emptyResponses++;
      if (emptyResponses >= 2) {
        input.registry.markUnavailable(provider.id, model.id, 'empty responses', { message: 'empty response twice (malformed)' }, input.taskId);
        return done('error', '', { error: 'model returned empty responses twice' });
      }
      messages.push({ role: 'user', content: 'Your last response was empty. Continue with a tool call, or call finish.' });
      continue;
    }
    messages.push({ role: 'assistant', content: resp.text, toolCalls: resp.toolCalls, rawParts: resp.rawParts });

    if (resp.toolCalls.length === 0) {
      const answeringCheckpoint = checkpointPending;
      checkpointPending = false;
      textOnlyTurns++;
      const verdict = progress.record({ toolCalls: [], text: resp.text, answeringCheckpoint });
      if (verdict === 'force_finish') forceFinish = true;
      if (verdict === 'checkpoint_due') checkpointPending = true;
      // A bare text reply is not a finish. Nudge once (or accept it on the final turn / after a checkpoint answer).
      if (textOnlyTurns >= 2 || lastStep) return done('done', resp.text, { forcedFinish: forceFinish || lastStep && step < spec.maxSteps - 1 });
      if (!answeringCheckpoint && !checkpointPending) messages.push({ role: 'user', content: 'If you are done, call the finish tool with summary and status. Otherwise continue using tools.' });
      continue;
    }
    textOnlyTurns = 0;
    checkpointPending = false;

    const executed: Array<{ name: string; args: Record<string, unknown>; ok: boolean }> = [];
    for (const call of resp.toolCalls) {
      if (call.name === 'finish') {
        const a = call.args;
        const status = String(a.status ?? 'done') as AgentStatus;
        const summary = typeof a.summary === 'string' ? a.summary : resp.text;
        emit('agent.finish', { status, forced: forceFinish });
        return done(['done', 'blocked', 'needs_escalation'].includes(status) ? status : 'done', summary || '(no summary)', { structured: a, forcedFinish: forceFinish });
      }
      if (lastStep) {
        emit('agent.finish', { status: 'done', forced: true, ignored_instruction: true });
        return done('done', resp.text || 'Step ended by the progress/quota policy; the agent produced no summary.', { forcedFinish: true, structured: { agent_status: 'done', forced_finish: true, no_summary: !resp.text } });
      }
      input.budget.assertCanCall('tool');
      const t0 = Date.now();
      const result = await executeTool(ctx, call.name, call.args);
      input.budget.recordToolCall();
      usage.toolCalls += 1;
      const rec: ToolCallRecord = { name: call.name, args: JSON.stringify(call.args).slice(0, 300), ok: result.ok, durationMs: Date.now() - t0, outputChars: result.output.length };
      toolCalls.push(rec);
      executed.push({ name: call.name, args: call.args, ok: result.ok });
      emit('agent.tool', { tool: call.name, ok: result.ok, ms: rec.durationMs, args: rec.args.slice(0, 120) });
      const cap = Math.min(HISTORY_TOOL_OUTPUT_CAP, Math.floor(model.promptCharBudget / 3));
      const capped = result.output.length > cap
        ? result.output.slice(0, cap) + `\n... (${result.output.length - cap} more chars; narrow the request to see them)`
        : result.output;
      messages.push({ role: 'tool', content: capped, toolCallId: call.id, toolName: call.name });
    }
    const verdict = progress.record({ toolCalls: executed, text: resp.text });
    if (verdict === 'checkpoint_due') { checkpointPending = true; emit('agent.checkpoint', progress.summary()); }
    if (verdict === 'force_finish') { forceFinish = true; emit('agent.force_finish', progress.summary()); }
  }
  input.registry.markUnavailable(provider.id, model.id, 'max steps without finish', { message: 'agent hit max steps without calling finish (malformed/incomplete)' }, input.taskId);
  return done('max_steps', '', { error: `agent hit max steps (${spec.maxSteps}) without calling finish` });
}
