import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../config.ts';
import { groqTokensToday, modelRequestsToday } from '../quota.ts';
import { preflight, type RoutingDecision, type RoutingState, type StepRequirements } from '../routing/preflight.ts';
import { TIERS, type Tier } from '../types.ts';
import { CAPABILITIES, type ModelCapabilities } from './capabilities.ts';
import { ClaudeCliProvider } from './claude-cli.ts';
import { GeminiProvider } from './gemini.ts';
import { GroqProvider } from './groq.ts';
import { ProviderLedger } from './ledger.ts';
import type { ModelInfo, Provider, ProviderHealth } from './types.ts';

export interface ResolvedModel { provider: Provider; model: ModelInfo }

/**
 * Tiebreak order within equal preflight scores. Not a routing rule any more:
 * feasibility and the reliability × fit × cost score decide first.
 */
export const PREFERENCE: string[] = [
  'claude-cli/sonnet', 'claude-cli/opus', 'gemini/gemini-3-flash-preview', 'gemini/gemini-2.5-flash',
  'gemini/gemini-3.1-flash-lite', 'claude-cli/haiku', 'groq/openai/gpt-oss-120b', 'groq/openai/gpt-oss-20b',
];

const HEALTH_TTL_MS = 60 * 60 * 1000;
/** Agents stop using Groq once today's measured spend nears the 200k/day cap; the rest is reserved for eval runs. */
export const GROQ_DAILY_TOKEN_RESERVE = 190_000;

export interface RouteResult extends RoutingDecision { resolved?: ResolvedModel }

export class ProviderRegistry {
  providers: Map<string, Provider>;
  healthCache: Record<string, ProviderHealth>;
  ledger: ProviderLedger;
  private healthPath: string;
  /** Compatibility view of models marked unavailable this process (also recorded in the ledger). */
  unavailable = new Map<string, string>();

  constructor(providers?: Provider[], dataDir: string = loadConfig().dataDir, ledger?: ProviderLedger) {
    this.providers = new Map((providers ?? [new GroqProvider(), new GeminiProvider(), new ClaudeCliProvider()]).map((p) => [p.id, p]));
    this.healthPath = resolve(dataDir, 'provider-health.json');
    this.healthCache = existsSync(this.healthPath) ? (JSON.parse(readFileSync(this.healthPath, 'utf8')) as Record<string, ProviderHealth>) : {};
    this.ledger = ledger ?? new ProviderLedger(resolve(dataDir, 'provider-ledger.jsonl'));
  }

  async checkHealth(force = false): Promise<Record<string, ProviderHealth>> {
    const now = Date.now();
    await Promise.all([...this.providers.values()].map(async (p) => {
      const cached = this.healthCache[p.id];
      if (!force && cached && now - Date.parse(cached.checkedAt) < HEALTH_TTL_MS) return;
      this.healthCache[p.id] = await p.health();
    }));
    try { writeFileSync(this.healthPath, JSON.stringify(this.healthCache, null, 2)); } catch { /* read-only in tests */ }
    return this.healthCache;
  }

  isHealthy(id: string): boolean { return Boolean(this.healthCache[id]?.ok); }
  healthyIds(): string[] { return [...this.providers.keys()].filter((id) => this.isHealthy(id)); }

  /** Record a provider failure; the ledger turns it into a temporary cooldown / observed limit / reliability hit. */
  markUnavailable(providerId: string, modelId: string, reason: string, err?: { status?: number; message: string; retryAfterMs?: number; promptChars?: number }, taskId?: string): void {
    const key = `${providerId}/${modelId}`;
    this.unavailable.set(key, reason);
    this.ledger.recordFailure(key, err ?? { message: reason }, { promptChars: err?.promptChars, taskId });
  }

  recordSuccess(providerId: string, modelId: string, taskId?: string): void {
    this.ledger.recordSuccess(`${providerId}/${modelId}`, { taskId });
    this.unavailable.delete(`${providerId}/${modelId}`);
  }

  /** Capability rows for providers this registry actually has. */
  capabilities(): ModelCapabilities[] {
    const out: ModelCapabilities[] = [];
    for (const p of this.providers.values()) {
      const own = p.capabilities?.();
      if (own) out.push(...own);
      else out.push(...CAPABILITIES.filter((c) => c.provider === p.id && p.models().some((m) => m.id === c.model)));
    }
    return out;
  }

  /** Live routing state from health cache, quota files and the ledger. */
  state(now: number = Date.now()): RoutingState {
    const requestsToday: Record<string, number> = {};
    for (const c of this.capabilities()) requestsToday[c.key] = modelRequestsToday(c.key);
    const groq = groqTokensToday();
    return {
      health: Object.fromEntries([...this.providers.keys()].map((id) => [id, this.isHealthy(id)])),
      requestsToday,
      // Reserve headroom under Groq's real cap so eval runs keep the remainder.
      tokensToday: { groq: groq.total + (200_000 - GROQ_DAILY_TOKEN_RESERVE) },
      ledger: this.ledger,
      now,
      preference: PREFERENCE,
    };
  }

  /** Requests left today for a model; Infinity when it has no daily cap. */
  remainingRequests(providerId: string, model: ModelInfo): number {
    if (model.dailyRequestCap === undefined) return Infinity;
    return Math.max(0, model.dailyRequestCap - modelRequestsToday(`${providerId}/${model.id}`));
  }

  /** Preflight: eliminate infeasible models, rank the rest, hand back the winner as a live provider+model. */
  route(req: StepRequirements, now: number = Date.now()): RouteResult {
    const decision = preflight(this.capabilities(), req, this.state(now));
    let resolved: ResolvedModel | undefined;
    if (decision.selected) {
      const [pid] = decision.selected.key.split('/');
      const mid = decision.selected.key.slice(pid.length + 1);
      const p = this.providers.get(pid);
      const m = p?.models().find((x) => x.id === mid);
      if (p && m) resolved = { provider: p, model: m };
    }
    return { ...decision, resolved };
  }

  /** Convenience for callers that only know a tier (doctor, tests). Same preflight underneath. */
  resolve(tier: Tier, opts: { needsTools?: boolean; promptChars?: number; expectedCalls?: number } = {}): ResolvedModel | undefined {
    return this.route({
      tier, promptChars: opts.promptChars ?? 6_000, expectedCalls: opts.expectedCalls ?? 4, outputTokens: 4096,
      needsTools: opts.needsTools ?? true, needsJson: false, budget: { remainingCostUsd: null, remainingCalls: 1, maxCostUsd: 2 },
    }).resolved;
  }

  /** Per-model availability with reasons, for `orchestrate doctor`. */
  modelStatus(now: number = Date.now()): Array<{ model: string; tier: Tier; ok: boolean; reason: string }> {
    const d = preflight(this.capabilities(), { tier: 'light', promptChars: 6_000, expectedCalls: 2, outputTokens: 1024, needsTools: false, needsJson: false, budget: { remainingCostUsd: null, remainingCalls: 1, maxCostUsd: 2 } }, this.state(now));
    return d.candidates.map((c) => {
      const cap = this.capabilities().find((x) => x.key === c.key)!;
      const extra = cap.rpd.value !== null ? ` (${this.state(now).requestsToday[c.key] ?? 0}/${cap.rpd.value} requests today)` : '';
      const h = this.ledger.history(c.key, now);
      const rel = ` reliability ${h.reliability.toFixed(2)} (${h.successes}✓/${h.failures}✗ in 7d)`;
      return { model: c.key, tier: c.tier, ok: c.feasible, reason: c.feasible ? `available${extra};${rel}` : `${c.eliminated!.reason}: ${c.eliminated!.detail};${rel}` };
    });
  }
}

export function escalate(tier: Tier): Tier {
  const i = TIERS.indexOf(tier);
  return TIERS[Math.min(TIERS.length - 1, i + 1)];
}

export function maxTier(a: Tier, b: Tier): Tier {
  return TIERS.indexOf(a) >= TIERS.indexOf(b) ? a : b;
}
