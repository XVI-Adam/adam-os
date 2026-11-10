// Core data model. Plain code owns budgets, state, and bookkeeping; LLMs only reason.

export type TaskCategory =
  | 'research' | 'debugging' | 'implementation' | 'refactoring' | 'testing' | 'evaluation'
  | 'documentation' | 'ux_design' | 'architecture' | 'deployment' | 'data_acquisition';

export const TASK_CATEGORIES: TaskCategory[] = [
  'research', 'debugging', 'implementation', 'refactoring', 'testing', 'evaluation',
  'documentation', 'ux_design', 'architecture', 'deployment', 'data_acquisition',
];

export type Tier = 'light' | 'standard' | 'strong';
export const TIERS: Tier[] = ['light', 'standard', 'strong'];

export type ComplexityTier = 'simple' | 'medium' | 'complex';

export type Capability =
  | 'repo_read' | 'repo_write' | 'run_commands' | 'run_tests' | 'run_eval'
  | 'web_research' | 'design_review' | 'deploy_check';

export type WorkflowId =
  | 'quick_fix' | 'bug_fix' | 'feature' | 'ai_agent_improvement' | 'production_readiness'
  | 'research' | 'documentation' | 'refactor' | 'testing';

export type AgentRole = 'planner' | 'research' | 'coding' | 'debugging' | 'evaluation' | 'reviewer' | 'product';

export type VerifyScope = 'all' | 'tests' | 'typecheck' | 'build' | 'eval' | 'baseline';

export interface WorkflowStep {
  id: string;
  kind: 'agent' | 'verify';
  role?: AgentRole;
  verify?: VerifyScope;
  /** Step-specific instruction appended to the agent's task prompt. */
  goal?: string;
  /** Skip silently when the project cannot support it (e.g. no eval harness). */
  optional?: boolean;
  /** Force a minimum tier for this step regardless of the route tier. */
  minTier?: Tier;
}

export interface Workflow {
  id: WorkflowId;
  description: string;
  steps: WorkflowStep[];
  /** Step id to restart from after a failed verification + replan. */
  retryFrom: string;
}

export interface VerificationPlan {
  id: string;
  kind: 'command' | 'eval';
  label: string;
  command: string;
  required: boolean;
  /** Which verify scopes include this check. */
  scopes: VerifyScope[];
}

export interface RouteDecision {
  project: string;
  category: TaskCategory;
  complexity: { score: number; tier: ComplexityTier };
  capabilities: Capability[];
  workflow: WorkflowId;
  tier: Tier;
  verification: VerificationPlan[];
  estimatedAgentCalls: number;
  estimatedWallClockMinutes: number;
  rationale: string[];
}

export interface Budget {
  maxCostUsd: number;
  maxAgentCalls: number;
  maxRetries: number;
  maxToolCalls: number;
  maxWallClockMs: number;
}

export type CostBasis = 'estimated' | 'provider_reported' | 'unavailable' | 'mixed';

export interface TokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
}

export interface Usage {
  modelCalls: number;
  toolCalls: number;
  retries: number;
  tokens: TokenUsage;
  /** List-price estimate from pricing.ts. null when no priced call happened. */
  estimatedCostUsd: number | null;
  /** Only when the provider itself reports a dollar figure (claude-cli). */
  providerReportedCostUsd: number | null;
  costBasis: CostBasis;
  /** Model calls that returned no usage block at all. */
  callsWithoutUsage: number;
  /** Total characters of context sent to agents (sum over steps). */
  contextChars: number;
}

export type TaskStatus =
  | 'queued' | 'routing' | 'planning' | 'researching' | 'implementing' | 'debugging' | 'verifying'
  | 'reviewing' | 'evaluating' | 'analyzing_failure' | 'replanning' | 'paused'
  | 'completed' | 'failed' | 'budget_exhausted' | 'stopped';

export const TERMINAL_STATUSES: TaskStatus[] = ['completed', 'failed', 'budget_exhausted', 'stopped'];

export type TaskOutcome = 'success' | 'partial' | 'failed' | 'budget_exhausted' | 'stopped';

export interface ToolCallRecord {
  name: string;
  args: string;
  ok: boolean;
  durationMs: number;
  outputChars: number;
}

export interface ContextStats {
  files: string[];
  chars: number;
  estTokens: number;
  /** Size of everything the selector considered, for the reduction ratio. */
  candidateChars: number;
  candidateFiles: number;
}

export interface StepRecord {
  id: string;
  stepId: string;
  attempt: number;
  kind: 'agent' | 'verify';
  role?: AgentRole;
  provider?: string;
  model?: string;
  status: 'running' | 'done' | 'failed' | 'skipped';
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  usage: Usage;
  context?: ContextStats;
  toolCalls: ToolCallRecord[];
  summary: string;
  /** Preflight routing decision for this step: candidates, eliminations with reasons, selection, estimate. */
  routing?: Record<string, unknown>;
  /** Progress-policy summary (turns, checkpoints, repeated reads). */
  progress?: Record<string, unknown>;
  /** Structured result an agent returned through finish(). */
  structured?: Record<string, unknown>;
  error?: string;
  verification?: VerificationResult[];
}

export interface EvalSummary {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  expectedFailures: number;
  unexpectedFailures: string[];
  failedIds: string[];
  /** Compact, verbatim-where-it-matters digest of each failure for agents. */
  digest?: string;
  /** Project-relative path of the full digest file (written next to the report) so agents can read it in ranges. */
  digestPath?: string;
  passRate: number;
  reportPath: string;
  scope: 'full' | 'filtered';
  filter?: string;
  deterministicOnly: boolean;
  model?: string;
  regressionsVsTaskBaseline?: string[];
}

export interface VerificationResult {
  id: string;
  kind: 'command' | 'eval';
  label: string;
  command: string;
  passed: boolean;
  exitCode: number | null;
  durationMs: number;
  outputTail: string;
  evalSummary?: EvalSummary;
  error?: string;
  skipped?: boolean;
}

export interface TaskRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  project: string;
  description: string;
  desiredOutcome?: string;
  route: RouteDecision;
  budget: Budget;
  usage: Usage;
  status: TaskStatus;
  attempt: number;
  currentStep?: string;
  steps: StepRecord[];
  verifications: VerificationResult[];
  /** Pass rate of the most recent FULL-suite eval run (comparable across tasks). */
  evalScore?: number;
  /** Pass rate of the most recent filtered re-run (only previously failing cases; not comparable to evalScore). */
  evalFilteredScore?: number;
  evalBaselineScore?: number;
  outcome?: TaskOutcome;
  failureReason?: string;
  finalSummary?: string;
  durationMs?: number;
  startedAt?: string;
  endedAt?: string;
  /** Provider health snapshot when the task started, for reproducibility. */
  providersAvailable?: string[];
  pid?: number;
}

export interface Event {
  ts: string;
  taskId: string;
  project: string;
  type: string;
  [key: string]: unknown;
}

export function emptyUsage(): Usage {
  return {
    modelCalls: 0, toolCalls: 0, retries: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0 },
    estimatedCostUsd: null, providerReportedCostUsd: null, costBasis: 'unavailable',
    callsWithoutUsage: 0, contextChars: 0,
  };
}

/** Merge b into a (mutates a) with honest cost-basis arithmetic. */
export function addUsage(a: Usage, b: Usage): Usage {
  a.modelCalls += b.modelCalls;
  a.toolCalls += b.toolCalls;
  a.retries += b.retries;
  a.tokens.input += b.tokens.input;
  a.tokens.output += b.tokens.output;
  a.tokens.reasoning += b.tokens.reasoning;
  a.tokens.cacheRead += b.tokens.cacheRead;
  a.callsWithoutUsage += b.callsWithoutUsage;
  a.contextChars += b.contextChars;
  if (b.estimatedCostUsd !== null) a.estimatedCostUsd = (a.estimatedCostUsd ?? 0) + b.estimatedCostUsd;
  if (b.providerReportedCostUsd !== null) a.providerReportedCostUsd = (a.providerReportedCostUsd ?? 0) + b.providerReportedCostUsd;
  a.costBasis = deriveCostBasis(a);
  return a;
}

export function deriveCostBasis(u: Usage): CostBasis {
  const hasEst = u.estimatedCostUsd !== null;
  const hasProv = u.providerReportedCostUsd !== null;
  const gaps = u.callsWithoutUsage > 0;
  if (!hasEst && !hasProv) return 'unavailable';
  if (gaps || (hasEst && hasProv)) return 'mixed';
  return hasProv ? 'provider_reported' : 'estimated';
}

export class BudgetExceededError extends Error {
  reason: string;
  constructor(reason: string) {
    super(`Budget exceeded: ${reason}`);
    this.name = 'BudgetExceededError';
    this.reason = reason;
  }
}
