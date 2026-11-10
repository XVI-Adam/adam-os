import type { Tier } from '../types.ts';

// Normalized provider/model capability schema. Every limit carries its source
// so a documented number is never confused with one we measured (or guessed).
// null = unknown. Nothing here is a claim we could not back.

export type LimitSource = 'documented' | 'observed' | 'unknown';

export interface Limit { value: number | null; source: LimitSource; note?: string }

export const limit = (value: number | null, source: LimitSource, note?: string): Limit => ({ value, source, note });
export const unknown = (): Limit => ({ value: null, source: 'unknown' });

export interface ModelCapabilities {
  provider: string;
  model: string;
  /** provider/model — the key used everywhere else. */
  key: string;
  tier: Tier;
  /** Whether the provider runs our tool loop ('chat') or its own agentic loop ('delegated'). */
  mode: 'chat' | 'delegated';
  contextTokens: Limit;
  maxOutputTokens: Limit;
  toolCalling: boolean;
  structuredOutput: boolean;
  /** USD per 1M tokens; null when unknown (cost basis becomes 'unavailable'). */
  pricing: { input: number; output: number; source: LimitSource } | null;
  rpm: Limit;
  tpm: Limit;
  rpd: Limit;
  /** Tokens per day, shared across the provider's models where noted. */
  tpd: Limit;
  /** Effective prompt size per call in characters, after rate limits. The number resolve() enforces. */
  promptCharBudget: Limit;
  /** Spacing between calls so a tool loop stays under the per-minute caps. */
  minIntervalMs: number;
}

const chars = (tokens: number) => tokens * 4; // planning ratio; measured ~3.6 chars/token on Groq, 4 on Gemini prose

export const CAPABILITIES: ModelCapabilities[] = [
  // ---- Groq (free tier on Adam's key) ----------------------------------------------------------
  {
    provider: 'groq', model: 'openai/gpt-oss-20b', key: 'groq/openai/gpt-oss-20b', tier: 'light', mode: 'chat',
    contextTokens: limit(131_072, 'documented'), maxOutputTokens: limit(32_768, 'documented'),
    toolCalling: true, structuredOutput: true,
    pricing: { input: 0.10, output: 0.50, source: 'documented' },
    rpm: unknown(), tpm: limit(8_000, 'observed', 'x-ratelimit-limit-tokens header, 2026-09-18'),
    rpd: limit(1_000, 'observed', 'x-ratelimit-limit-requests header'), tpd: limit(200_000, 'observed', 'appears only in 429 bodies; shared across models'),
    promptCharBudget: limit(14_000, 'observed', 'a 16.8k-token prompt got 413 against the 8k TPM; 14k chars ≈ 3.5k tokens leaves room for two calls a minute'),
    minIntervalMs: 25_000,
  },
  {
    provider: 'groq', model: 'openai/gpt-oss-120b', key: 'groq/openai/gpt-oss-120b', tier: 'standard', mode: 'chat',
    contextTokens: limit(131_072, 'documented'), maxOutputTokens: limit(32_768, 'documented'),
    toolCalling: true, structuredOutput: true,
    pricing: { input: 0.15, output: 0.75, source: 'documented' },
    rpm: unknown(), tpm: limit(8_000, 'observed'), rpd: limit(1_000, 'observed'), tpd: limit(200_000, 'observed', 'shared with gpt-oss-20b'),
    promptCharBudget: limit(14_000, 'observed'),
    minIntervalMs: 25_000,
  },
  // ---- Gemini (free tier on Adam's key; pro models return 404 / quota 0) ----------------------
  {
    provider: 'gemini', model: 'gemini-3.1-flash-lite', key: 'gemini/gemini-3.1-flash-lite', tier: 'light', mode: 'chat',
    contextTokens: limit(1_048_576, 'documented'), maxOutputTokens: limit(65_536, 'documented'),
    toolCalling: true, structuredOutput: true,
    pricing: null,
    rpm: unknown(), tpm: unknown(), rpd: limit(20, 'observed', 'GenerateRequestsPerDayPerProjectPerModel-FreeTier in 429 body, 2026-09-18'), tpd: unknown(),
    promptCharBudget: limit(60_000, 'observed', 'conservative; free-tier per-minute token caps are undocumented for this key'),
    minIntervalMs: 5_000,
  },
  {
    provider: 'gemini', model: 'gemini-2.5-flash', key: 'gemini/gemini-2.5-flash', tier: 'standard', mode: 'chat',
    contextTokens: limit(1_048_576, 'documented'), maxOutputTokens: limit(65_536, 'documented'),
    toolCalling: true, structuredOutput: true,
    pricing: { input: 0.30, output: 2.50, source: 'documented' },
    rpm: unknown(), tpm: unknown(), rpd: limit(20, 'observed'), tpd: unknown(),
    promptCharBudget: limit(160_000, 'observed', 'largest prompt sent without error was ~70k chars; 160k is a planning cap, not a measured max'),
    minIntervalMs: 7_000,
  },
  {
    provider: 'gemini', model: 'gemini-3-flash-preview', key: 'gemini/gemini-3-flash-preview', tier: 'strong', mode: 'chat',
    contextTokens: limit(1_048_576, 'documented'), maxOutputTokens: limit(65_536, 'documented'),
    toolCalling: true, structuredOutput: true,
    pricing: null,
    rpm: unknown(), tpm: unknown(), rpd: limit(20, 'observed'), tpd: unknown(),
    promptCharBudget: limit(240_000, 'observed', 'planning cap'),
    minIntervalMs: 7_000,
  },
  // ---- Claude Code CLI (Pro subscription; usage and cost are reported by the CLI itself) -------
  {
    provider: 'claude-cli', model: 'haiku', key: 'claude-cli/haiku', tier: 'light', mode: 'delegated',
    contextTokens: limit(200_000, 'documented'), maxOutputTokens: unknown(),
    toolCalling: true, structuredOutput: false,
    pricing: null, rpm: unknown(), tpm: unknown(), rpd: unknown(), tpd: unknown(),
    promptCharBudget: limit(chars(50_000), 'documented', 'the CLI manages its own context; this bounds what we hand it'),
    minIntervalMs: 0,
  },
  {
    provider: 'claude-cli', model: 'sonnet', key: 'claude-cli/sonnet', tier: 'standard', mode: 'delegated',
    contextTokens: limit(200_000, 'documented'), maxOutputTokens: unknown(),
    toolCalling: true, structuredOutput: false,
    pricing: null, rpm: unknown(), tpm: unknown(), rpd: unknown(), tpd: unknown(),
    promptCharBudget: limit(chars(100_000), 'documented'),
    minIntervalMs: 0,
  },
  {
    provider: 'claude-cli', model: 'opus', key: 'claude-cli/opus', tier: 'strong', mode: 'delegated',
    contextTokens: limit(200_000, 'documented'), maxOutputTokens: unknown(),
    toolCalling: true, structuredOutput: false,
    pricing: null, rpm: unknown(), tpm: unknown(), rpd: unknown(), tpd: unknown(),
    promptCharBudget: limit(chars(100_000), 'documented'),
    minIntervalMs: 0,
  },
];

export function capabilitiesFor(key: string): ModelCapabilities | undefined {
  return CAPABILITIES.find((c) => c.key === key);
}

export function capabilitiesOf(provider: string): ModelCapabilities[] {
  return CAPABILITIES.filter((c) => c.provider === provider);
}

/** The runtime view adapters expose; derived from the capability row so there is one source of truth. */
export function toModelInfo(c: ModelCapabilities): { id: string; provider: string; tier: Tier; promptCharBudget: number; supportsTools: boolean; minIntervalMs?: number; dailyRequestCap?: number } {
  return {
    id: c.model, provider: c.provider, tier: c.tier,
    promptCharBudget: c.promptCharBudget.value ?? Math.floor((c.contextTokens.value ?? 32_000) * 4 * 0.6),
    supportsTools: c.toolCalling,
    minIntervalMs: c.minIntervalMs || undefined,
    dailyRequestCap: c.rpd.value ?? undefined,
  };
}
