import type { Tier, TokenUsage } from '../types.ts';

export interface ToolCall { id: string; name: string; args: Record<string, unknown>; rawArgs?: string }

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  /** Provider-specific parts to echo back verbatim (Gemini thought signatures). */
  rawParts?: unknown[];
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
}

export interface ChatResponse {
  text: string;
  toolCalls: ToolCall[];
  usage: TokenUsage | null;
  /** Dollar figure only when the provider itself reports one. */
  providerCostUsd: number | null;
  finishReason: string;
  rawParts?: unknown[];
}

export interface ModelInfo {
  id: string;
  provider: string;
  tier: Tier;
  /** Hard cap on prompt characters per call; resolve() skips models that cannot take the prompt. */
  promptCharBudget: number;
  supportsTools: boolean;
  /** Minimum spacing between calls to this model (free-tier requests-per-minute caps). */
  minIntervalMs?: number;
  /** Requests per UTC day this key may make to the model; resolve() skips models at the cap. */
  dailyRequestCap?: number;
}

const lastCallAt = new Map<string, number>();
/** Space calls per model so a tool loop does not trip a requests-per-minute cap. */
export async function throttle(modelKey: string, minIntervalMs: number | undefined): Promise<number> {
  if (!minIntervalMs) return 0;
  const now = Date.now();
  const wait = Math.max(0, (lastCallAt.get(modelKey) ?? 0) + minIntervalMs - now);
  lastCallAt.set(modelKey, now + wait);
  if (wait > 0) await sleep(wait);
  return wait;
}

export interface ProviderHealth { ok: boolean; detail: string; checkedAt: string }

export interface Provider {
  id: string;
  /** 'chat' providers run our tool loop; 'delegated' providers run their own agentic loop. */
  mode: 'chat' | 'delegated';
  models(): ModelInfo[];
  health(): Promise<ProviderHealth>;
  chat(req: ChatRequest): Promise<ChatResponse>;
  /** Optional capability rows; when absent the registry uses the static table for this provider id. */
  capabilities?(): import('./capabilities.ts').ModelCapabilities[];
  /** Present on 'delegated' providers, which run their own agentic loop. */
  runDelegated?(run: DelegatedRun): Promise<DelegatedResult>;
}

/** For delegated providers (claude-cli) that execute a whole agent turn themselves. */
export interface DelegatedRun {
  prompt: string;
  systemPrompt: string;
  cwd: string;
  model: string;
  allowWrite: boolean;
  maxBudgetUsd: number;
  timeoutMs: number;
}
export interface DelegatedResult {
  text: string;
  usage: TokenUsage | null;
  providerCostUsd: number | null;
  numTurns: number;
  isError: boolean;
  error?: string;
  /**
   * The run was cut short by a spend/usage ceiling rather than failing. Its
   * output may still be complete work — the caller decides, by looking at
   * whether the workspace actually changed.
   */
  budgetStopped?: boolean;
  /** Raw envelope subtype, for the log. */
  subtype?: string;
}

export class ProviderError extends Error {
  status: number | undefined;
  retryable: boolean;
  /** Server-suggested wait (ms), from Retry-After or a Gemini RetryInfo detail. */
  retryAfterMs: number | undefined;
  constructor(message: string, status?: number, retryable = false, retryAfterMs?: number) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Pull a retry hint out of an error body or header. Returns ms, clamped to 90s. */
export function parseRetryAfter(header: string | null, body: string): number | undefined {
  let secs: number | undefined;
  if (header) { const n = Number(header); if (Number.isFinite(n)) secs = n; }
  if (secs === undefined) { const m = /"retryDelay":\s*"(\d+(?:\.\d+)?)s"/.exec(body); if (m) secs = Number(m[1]); }
  if (secs === undefined) { const m = /retry in (\d+(?:\.\d+)?)s/i.exec(body); if (m) secs = Number(m[1]); }
  return secs === undefined ? undefined : Math.min(90_000, Math.ceil(secs * 1000));
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Bounded retry with jitter for 429/5xx only. Waits grow 4s→8s→16s→32s (capped
 * at 60s, or the server's retry hint if larger), so a per-minute quota window
 * can pass; the whole thing is still bounded by `attempts`.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: { attempts?: number; baseMs?: number; maxMs?: number; onRetry?: (err: ProviderError, wait: number) => void } = {}): Promise<T> {
  const attempts = opts.attempts ?? 5;
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (err) {
      last = err;
      if (!(err instanceof ProviderError) || !err.retryable || i === attempts - 1) throw err;
      const cap = Math.min(opts.maxMs ?? 60_000, (opts.baseMs ?? 4000) * 2 ** i);
      const jittered = Math.round(cap / 2 + Math.random() * (cap / 2));
      const wait = err.retryAfterMs ? Math.max(err.retryAfterMs, jittered) : jittered;
      opts.onRetry?.(err, wait);
      await sleep(wait);
    }
  }
  throw last;
}

export function parseArgs(raw: unknown): { args: Record<string, unknown>; error?: string } {
  if (raw && typeof raw === 'object') return { args: raw as Record<string, unknown> };
  if (typeof raw !== 'string') return { args: {}, error: 'tool arguments missing' };
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object') return { args: v as Record<string, unknown> };
    return { args: {}, error: 'tool arguments were not an object' };
  } catch {
    return { args: {}, error: `tool arguments were not valid JSON: ${raw.slice(0, 120)}` };
  }
}

/** fetch() that turns timeouts and network failures into retryable ProviderErrors. */
export async function fetchOrThrow(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    const name = (e as Error).name;
    const msg = name === 'TimeoutError' || name === 'AbortError' ? 'request timed out' : `network error: ${(e as Error).message}`;
    throw new ProviderError(msg, 0, true);
  }
}
