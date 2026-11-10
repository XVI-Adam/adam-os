import { CAPABILITIES, type ModelCapabilities } from '../providers/capabilities.ts';
import { ProviderLedger, type LedgerEvent } from '../providers/ledger.ts';
import { preflight, type RoutingDecision, type RoutingState, type StepRequirements } from './preflight.ts';

// Deterministic routing simulation: no I/O, no clock, no network. Answers
// "given this task shape, quota state and budget, which model would AdamOS
// pick, and why?" using exactly the code the orchestrator runs.

export interface Scenario {
  name?: string;
  requirements: Partial<StepRequirements> & { promptChars: number; tier: StepRequirements['tier'] };
  health?: Record<string, boolean>;
  requestsToday?: Record<string, number>;
  tokensToday?: Record<string, number>;
  ledgerEvents?: LedgerEvent[];
  /** Override or add capability rows (matched by key). */
  capabilities?: ModelCapabilities[];
  now?: number;
  preference?: string[];
}

export const SIM_NOW = Date.UTC(2026, 8, 18, 12, 0, 0); // fixed clock: 2026-09-18T12:00:00Z

export function simulate(s: Scenario): RoutingDecision {
  const req: StepRequirements = {
    tier: s.requirements.tier,
    role: s.requirements.role,
    promptChars: s.requirements.promptChars,
    expectedCalls: s.requirements.expectedCalls ?? 6,
    outputTokens: s.requirements.outputTokens ?? 4096,
    needsTools: s.requirements.needsTools ?? true,
    needsJson: s.requirements.needsJson ?? false,
    budget: s.requirements.budget ?? { remainingCostUsd: 2, remainingCalls: 40, maxCostUsd: 2 },
  };
  const caps = s.capabilities
    ? [...CAPABILITIES.filter((c) => !s.capabilities!.some((o) => o.key === c.key)), ...s.capabilities]
    : CAPABILITIES;
  const health = s.health ?? Object.fromEntries([...new Set(caps.map((c) => c.provider))].map((p) => [p, true]));
  const state: RoutingState = {
    health, requestsToday: s.requestsToday ?? {}, tokensToday: s.tokensToday ?? {},
    ledger: ProviderLedger.fromEvents(s.ledgerEvents ?? []), now: s.now ?? SIM_NOW, preference: s.preference,
  };
  return preflight(caps, req, state);
}
