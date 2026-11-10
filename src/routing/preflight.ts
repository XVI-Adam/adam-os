import type { ModelCapabilities } from '../providers/capabilities.ts';
import type { ProviderLedger } from '../providers/ledger.ts';
import { TIERS, type Tier } from '../types.ts';

// Preflight routing: for one agent step, decide BEFORE any model call which
// model gets it. Hard requirements eliminate; the survivors are ranked by
// reliability × tier fit × cost efficiency. Pure and deterministic: all live
// state comes in through RoutingState, so the same function powers the
// simulation and the real orchestrator.

export interface StepRequirements {
  tier: Tier;
  role?: string;
  /** Estimated characters in the first prompt (system + task + context). */
  promptChars: number;
  /** Upper bound on model calls this step may make. */
  expectedCalls: number;
  /** Max output tokens requested per call. */
  outputTokens: number;
  needsTools: boolean;
  needsJson: boolean;
  /** What the task budget still allows. remainingCostUsd null = cost so far unknown. */
  budget: { remainingCostUsd: number | null; remainingCalls: number; maxCostUsd: number };
}

export interface RoutingState {
  /** provider id → healthy */
  health: Record<string, boolean>;
  /** provider/model → generate requests already made today */
  requestsToday: Record<string, number>;
  /** provider id → tokens already spent today (where a daily token cap exists) */
  tokensToday: Record<string, number>;
  ledger: ProviderLedger;
  now: number;
  /** Optional preference order (provider/model keys) used as a tiebreaker within equal scores. */
  preference?: string[];
}

export type EliminationReason =
  | 'provider_unhealthy' | 'cooldown' | 'no_tool_calling' | 'no_structured_output' | 'context_too_small'
  | 'prompt_over_tpm' | 'rpd_exhausted' | 'tpd_exhausted' | 'budget_calls' | 'budget_cost';

export interface CandidateEvaluation {
  key: string;
  tier: Tier;
  feasible: boolean;
  eliminated?: { reason: EliminationReason; detail: string };
  estimatedTokens: { input: number; output: number };
  /** null when the model has no known price. */
  estimatedCostUsd: number | null;
  reliability: number;
  tierFit: number;
  costFactor: number;
  score: number;
  /** Effective prompt budget after observed limits. */
  promptCharBudget: number | null;
  cooldownUntil?: number;
}

export interface RoutingDecision {
  requirements: StepRequirements;
  candidates: CandidateEvaluation[];
  eliminated: CandidateEvaluation[];
  remaining: CandidateEvaluation[];
  selected?: CandidateEvaluation;
  /** Human-readable one-liner: why this model, or why none. */
  explanation: string;
  /** Earliest moment an eliminated-for-cooldown model becomes available again. */
  nextCooldownEndsAt?: number;
}

const CHARS_PER_TOKEN = 4;

/** Effective per-call prompt budget: the smaller of the table's budget and anything we observed overflowing. */
export function effectivePromptCharBudget(c: ModelCapabilities, ledger: ProviderLedger, now: number): number | null {
  const observed = ledger.observedPromptCharLimit(c.key, now);
  const table = c.promptCharBudget.value;
  if (table === null && observed === undefined) return c.contextTokens.value === null ? null : Math.floor(c.contextTokens.value * CHARS_PER_TOKEN * 0.6);
  if (table === null) return observed ?? null;
  return observed === undefined ? table : Math.min(table, observed);
}

export function tierFit(required: Tier, offered: Tier): number {
  const d = TIERS.indexOf(offered) - TIERS.indexOf(required);
  if (d === 0) return 1;
  if (d > 0) return 0.9;        // stronger than needed: fine, slightly wasteful
  return d === -1 ? 0.6 : 0.35;  // weaker than needed: allowed as a last resort, ranked low
}

export function estimateStepTokens(req: StepRequirements): { input: number; output: number } {
  // Histories grow with tool outputs; assume each call re-sends the prompt plus ~40% accumulated context on average.
  const perCallInput = Math.ceil(req.promptChars / CHARS_PER_TOKEN);
  const input = Math.ceil(perCallInput * req.expectedCalls * 1.4);
  const output = Math.ceil(Math.min(req.outputTokens, 600) * req.expectedCalls);
  return { input, output };
}

export function evaluateCandidate(c: ModelCapabilities, req: StepRequirements, state: RoutingState): CandidateEvaluation {
  const tokens = estimateStepTokens(req);
  const cost = c.pricing ? (tokens.input * c.pricing.input + tokens.output * c.pricing.output) / 1_000_000 : null;
  const history = state.ledger.history(c.key, state.now);
  const budgetChars = effectivePromptCharBudget(c, state.ledger, state.now);
  const fit = tierFit(req.tier, c.tier);
  // Cost efficiency relative to the task budget: spending 10% of the budget on one step scores ~0.5.
  const costFactor = cost === null ? 0.7 : 1 / (1 + (cost / Math.max(0.01, req.budget.maxCostUsd)) * 10);
  const base: CandidateEvaluation = {
    key: c.key, tier: c.tier, feasible: true, estimatedTokens: tokens, estimatedCostUsd: cost,
    reliability: history.reliability, tierFit: fit, costFactor, score: 0, promptCharBudget: budgetChars,
  };
  const eliminate = (reason: EliminationReason, detail: string): CandidateEvaluation => ({ ...base, feasible: false, eliminated: { reason, detail } });

  if (!state.health[c.provider]) return eliminate('provider_unhealthy', `provider ${c.provider} failed its health check`);
  const cd = state.ledger.cooldown(c.key, state.now);
  if (cd) return { ...eliminate('cooldown', cd.reason), cooldownUntil: cd.until };
  if (req.needsTools && !c.toolCalling) return eliminate('no_tool_calling', 'model does not support tool calling');
  if (req.needsJson && !c.structuredOutput) return eliminate('no_structured_output', 'model does not support structured (JSON) output');
  const promptTokens = Math.ceil(req.promptChars / CHARS_PER_TOKEN);
  if (c.contextTokens.value !== null && promptTokens + req.outputTokens > c.contextTokens.value) {
    return eliminate('context_too_small', `needs ~${(promptTokens + req.outputTokens).toLocaleString()} tokens; context is ${c.contextTokens.value.toLocaleString()} (${c.contextTokens.source})`);
  }
  if (budgetChars !== null && req.promptChars > budgetChars) {
    return eliminate('context_too_small', `prompt is ${req.promptChars.toLocaleString()} chars; effective per-call budget is ${budgetChars.toLocaleString()} (${c.promptCharBudget.source}${state.ledger.observedPromptCharLimit(c.key, state.now) !== undefined ? ', tightened by an observed overflow' : ''})`);
  }
  if (c.tpm.value !== null && promptTokens + req.outputTokens > c.tpm.value) {
    return eliminate('prompt_over_tpm', `a single call of ~${(promptTokens + req.outputTokens).toLocaleString()} tokens exceeds the ${c.tpm.value.toLocaleString()} tokens/minute cap (${c.tpm.source})`);
  }
  if (c.rpd.value !== null) {
    const used = state.requestsToday[c.key] ?? 0;
    const left = c.rpd.value - used;
    const need = Math.min(2, req.expectedCalls);
    if (left < need) return eliminate('rpd_exhausted', `${used}/${c.rpd.value} requests used today (${c.rpd.source}); need at least ${need}`);
  }
  if (c.tpd.value !== null) {
    const used = state.tokensToday[c.provider] ?? 0;
    const need = tokens.input + tokens.output;
    if (used + need > c.tpd.value) return eliminate('tpd_exhausted', `~${used.toLocaleString()} of ${c.tpd.value.toLocaleString()} tokens/day used (${c.tpd.source}); step needs ~${need.toLocaleString()}`);
  }
  if (req.budget.remainingCalls < 1) return eliminate('budget_calls', 'task has no model calls left');
  if (cost !== null && req.budget.remainingCostUsd !== null && cost > req.budget.remainingCostUsd) {
    return eliminate('budget_cost', `estimated $${cost.toFixed(4)} for this step exceeds the remaining $${req.budget.remainingCostUsd.toFixed(4)}`);
  }
  // successful outcome × reliability × cost efficiency
  base.score = history.reliability * fit * (0.5 + 0.5 * costFactor);
  return base;
}

export function preflight(capabilities: ModelCapabilities[], req: StepRequirements, state: RoutingState): RoutingDecision {
  const candidates = capabilities.map((c) => evaluateCandidate(c, req, state));
  const eliminated = candidates.filter((c) => !c.feasible);
  const remaining = candidates.filter((c) => c.feasible);
  const pref = state.preference ?? [];
  remaining.sort((a, b) => b.score - a.score || (pref.indexOf(a.key) === -1 ? 1e9 : pref.indexOf(a.key)) - (pref.indexOf(b.key) === -1 ? 1e9 : pref.indexOf(b.key)) || a.key.localeCompare(b.key));
  const selected = remaining[0];
  const cds = eliminated.filter((c) => c.cooldownUntil).map((c) => c.cooldownUntil!);
  const nextCooldownEndsAt = cds.length ? Math.min(...cds) : undefined;
  const explanation = selected
    ? `${selected.key}: reliability ${selected.reliability.toFixed(2)} × tier fit ${selected.tierFit} × cost factor ${selected.costFactor.toFixed(2)} = ${selected.score.toFixed(3)}; est ${selected.estimatedCostUsd === null ? 'cost unknown' : `$${selected.estimatedCostUsd.toFixed(4)}`}, ~${(selected.estimatedTokens.input + selected.estimatedTokens.output).toLocaleString()} tokens; ${eliminated.length} eliminated, ${remaining.length - 1} other feasible`
    : `no feasible model: ${eliminated.map((c) => `${c.key} (${c.eliminated!.reason})`).join(', ') || 'no candidates'}`;
  return { requirements: req, candidates, eliminated, remaining, selected, explanation, nextCooldownEndsAt };
}

/** Compact form for step records and events. */
export function summarizeDecision(d: RoutingDecision): Record<string, unknown> {
  return {
    requirements: { tier: d.requirements.tier, role: d.requirements.role, promptChars: d.requirements.promptChars, expectedCalls: d.requirements.expectedCalls, needsTools: d.requirements.needsTools, needsJson: d.requirements.needsJson, budget: d.requirements.budget },
    candidates: d.candidates.map((c) => c.key),
    eliminated: d.eliminated.map((c) => ({ model: c.key, reason: c.eliminated!.reason, detail: c.eliminated!.detail })),
    remaining: d.remaining.map((c) => ({ model: c.key, score: Number(c.score.toFixed(3)), reliability: Number(c.reliability.toFixed(2)), estimatedCostUsd: c.estimatedCostUsd, estimatedTokens: c.estimatedTokens.input + c.estimatedTokens.output })),
    selected: d.selected?.key,
    estimatedUsage: d.selected ? { tokens: d.selected.estimatedTokens, costUsd: d.selected.estimatedCostUsd, costBasis: d.selected.estimatedCostUsd === null ? 'unavailable' : 'estimated' } : undefined,
    budgetRemaining: d.requirements.budget,
    explanation: d.explanation,
  };
}

export function renderDecision(d: RoutingDecision): string {
  const lines: string[] = [];
  const r = d.requirements;
  lines.push(`requirements: tier=${r.tier}${r.role ? ` role=${r.role}` : ''} prompt=${r.promptChars.toLocaleString()} chars calls≤${r.expectedCalls} out=${r.outputTokens} tools=${r.needsTools} json=${r.needsJson} budget: ${r.budget.remainingCalls} calls, ${r.budget.remainingCostUsd === null ? 'cost n/a' : `$${r.budget.remainingCostUsd.toFixed(2)}`} of $${r.budget.maxCostUsd}`);
  lines.push(`candidates (${d.candidates.length}): ${d.candidates.map((c) => c.key).join(', ')}`);
  for (const c of d.eliminated) lines.push(`  ✗ ${c.key.padEnd(30)} ${c.eliminated!.reason.padEnd(20)} ${c.eliminated!.detail}`);
  for (const c of d.remaining) lines.push(`  ${c === d.selected ? '★' : '✓'} ${c.key.padEnd(30)} score ${c.score.toFixed(3)} (rel ${c.reliability.toFixed(2)} × fit ${c.tierFit} × cost ${c.costFactor.toFixed(2)}) est ${c.estimatedCostUsd === null ? 'n/a' : '$' + c.estimatedCostUsd.toFixed(4)} ~${(c.estimatedTokens.input + c.estimatedTokens.output).toLocaleString()} tok`);
  lines.push(`selected: ${d.selected?.key ?? 'NONE'} — ${d.explanation}`);
  return lines.join('\n');
}
