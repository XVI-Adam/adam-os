import { estimateCostUsd } from './pricing.ts';
import { addUsage, BudgetExceededError, deriveCostBasis, emptyUsage, type Budget, type TokenUsage, type Usage } from './types.ts';

/**
 * Hard limits enforced in code before every model call and tool call.
 * Nothing here is advisory: exceeding a limit throws and the orchestrator
 * moves the task to budget_exhausted.
 */
export class BudgetManager {
  budget: Budget;
  usage: Usage;
  startedAt: number;

  constructor(budget: Budget, usage: Usage = emptyUsage(), startedAt: number = Date.now()) {
    this.budget = budget;
    this.usage = usage;
    this.startedAt = startedAt;
  }

  elapsedMs(): number { return Date.now() - this.startedAt; }

  /** Returns a reason string if any limit is already exceeded, else null. */
  exceeded(): string | null {
    const b = this.budget; const u = this.usage;
    if (u.modelCalls >= b.maxAgentCalls) return `max_agent_calls (${u.modelCalls}/${b.maxAgentCalls})`;
    if (u.estimatedCostUsd !== null && u.estimatedCostUsd >= b.maxCostUsd) return `max_cost_usd (est $${u.estimatedCostUsd.toFixed(4)} >= $${b.maxCostUsd})`;
    if (u.providerReportedCostUsd !== null && u.providerReportedCostUsd >= b.maxCostUsd) return `max_cost_usd (reported $${u.providerReportedCostUsd.toFixed(4)} >= $${b.maxCostUsd})`;
    if (u.toolCalls >= b.maxToolCalls) return `max_tool_calls (${u.toolCalls}/${b.maxToolCalls})`;
    if (this.elapsedMs() >= b.maxWallClockMs) return `max_wall_clock (${Math.round(this.elapsedMs() / 60000)}min)`;
    return null;
  }

  assertCanCall(kind: 'model' | 'tool'): void {
    const reason = this.exceeded();
    if (reason) throw new BudgetExceededError(reason);
    if (kind === 'tool' && this.usage.toolCalls + 1 > this.budget.maxToolCalls) throw new BudgetExceededError('max_tool_calls');
  }

  canRetry(attempt: number): boolean {
    // attempt is 1-based: attempt 1 is the first try; retries allowed = maxRetries.
    return attempt <= this.budget.maxRetries;
  }

  recordModelCall(model: string, tokens: TokenUsage | null, providerCostUsd: number | null = null): Usage {
    const delta = emptyUsage();
    delta.modelCalls = 1;
    if (tokens) {
      delta.tokens = { ...tokens };
      const est = estimateCostUsd(model, tokens.input + tokens.cacheRead, tokens.output + tokens.reasoning);
      delta.estimatedCostUsd = est;
      if (est === null && providerCostUsd === null) delta.callsWithoutUsage = 0; // tokens known, price unknown
    } else {
      delta.callsWithoutUsage = 1;
    }
    delta.providerReportedCostUsd = providerCostUsd;
    delta.costBasis = deriveCostBasis(delta);
    addUsage(this.usage, delta);
    return delta;
  }

  recordToolCall(): void { this.usage.toolCalls += 1; }
  recordRetry(): void { this.usage.retries += 1; }
  recordContext(chars: number): void { this.usage.contextChars += chars; }

  /** Remaining budget. costUsd is always a number: with no priced spend yet it equals the cap, and spendKnown says so. */
  remaining(): { calls: number; costUsd: number; spendKnown: boolean; ms: number } {
    const spent = this.usage.providerReportedCostUsd ?? this.usage.estimatedCostUsd;
    return {
      calls: Math.max(0, this.budget.maxAgentCalls - this.usage.modelCalls),
      costUsd: Math.max(0, this.budget.maxCostUsd - (spent ?? 0)),
      spendKnown: spent !== null || this.usage.modelCalls === 0,
      ms: Math.max(0, this.budget.maxWallClockMs - this.elapsedMs()),
    };
  }
}
