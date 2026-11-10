import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ProviderError } from './types.ts';

// Failure-aware routing state. Every provider failure and every completed step
// is appended to a JSONL ledger; cooldowns, observed limits and reliability are
// derived from it at read time. Nothing is ever permanently blacklisted: a
// cooldown expires, and reliability recovers with successes.

export type FailureCategory =
  | 'rate_limit' | 'daily_quota' | 'context_overflow' | 'timeout' | 'server_error' | 'unavailable'
  | 'tool_call_failure' | 'malformed_response' | 'auth' | 'unknown';

export interface LedgerEvent {
  ts: string;
  key: string;                       // provider/model
  kind: 'failure' | 'success';
  category?: FailureCategory;
  status?: number;
  detail?: string;
  /** Prompt size that triggered a context_overflow, so an observed limit can be derived. */
  promptChars?: number;
  retryAfterMs?: number;
  taskId?: string;
}

export interface Cooldown { until: number; category: FailureCategory; reason: string }

export interface ModelHistory {
  successes: number;
  failures: number;
  byCategory: Partial<Record<FailureCategory, number>>;
  /** Laplace-smoothed success rate in [0,1]; 0.5 with no history. */
  reliability: number;
  lastFailureAt?: string;
}

export const COOLDOWN_POLICY_MS: Record<FailureCategory, { base: number; cap: number }> = {
  rate_limit: { base: 60_000, cap: 15 * 60_000 },
  daily_quota: { base: 0, cap: 0 },               // computed: until next UTC midnight
  context_overflow: { base: 0, cap: 0 },          // not a cooldown: shrinks the observed prompt budget instead
  timeout: { base: 120_000, cap: 10 * 60_000 },
  server_error: { base: 120_000, cap: 10 * 60_000 },
  unavailable: { base: 120_000, cap: 10 * 60_000 },
  tool_call_failure: { base: 30_000, cap: 5 * 60_000 },
  malformed_response: { base: 30_000, cap: 5 * 60_000 },
  auth: { base: 30 * 60_000, cap: 60 * 60_000 },
  unknown: { base: 60_000, cap: 10 * 60_000 },
};

const RELIABILITY_WINDOW_MS = 7 * 24 * 60 * 60_000;
const RELIABILITY_MAX_EVENTS = 30;

export function categorize(err: { status?: number; message: string }): FailureCategory {
  const s = err.status; const m = err.message;
  if (s === 429) return /per.?day|daily|PerDay|RPD|TPD|tokens per day/i.test(m) ? 'daily_quota' : 'rate_limit';
  if (s === 413 || /request too large|context length|too many tokens|prompt is too long/i.test(m)) return 'context_overflow';
  if (s === 408 || s === 0 || /timed out|timeout/i.test(m)) return 'timeout';
  if (s === 503 || /high demand|overloaded|UNAVAILABLE/i.test(m)) return 'unavailable';
  if (s !== undefined && s >= 500) return 'server_error';
  if (s === 401 || s === 403 || /oauth|authentication|api key/i.test(m)) return 'auth';
  if (/tool_use_failed|tool call validation/i.test(m)) return 'tool_call_failure';
  if (/output_parse_failed|could not be parsed|empty response|malformed/i.test(m)) return 'malformed_response';
  return 'unknown';
}

export function categorizeProviderError(e: ProviderError): FailureCategory {
  return categorize({ status: e.status, message: e.message });
}

function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

export class ProviderLedger {
  private events: LedgerEvent[] = [];
  private path: string | undefined;

  /** path undefined = in-memory only (simulation, tests). */
  constructor(path?: string) {
    this.path = path;
    if (path && existsSync(path)) {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { this.events.push(JSON.parse(line) as LedgerEvent); } catch { /* skip */ }
      }
    }
  }

  static fromEvents(events: LedgerEvent[]): ProviderLedger {
    const l = new ProviderLedger();
    l.events = [...events];
    return l;
  }

  all(): readonly LedgerEvent[] { return this.events; }

  private append(ev: LedgerEvent): void {
    this.events.push(ev);
    if (this.path) {
      try { mkdirSync(dirname(this.path), { recursive: true }); appendFileSync(this.path, JSON.stringify(ev) + '\n'); } catch { /* read-only data dir */ }
    }
  }

  recordFailure(key: string, err: { status?: number; message: string; retryAfterMs?: number }, extra: { promptChars?: number; taskId?: string; now?: number } = {}): LedgerEvent {
    const ev: LedgerEvent = {
      ts: new Date(extra.now ?? Date.now()).toISOString(), key, kind: 'failure', category: categorize(err), status: err.status,
      detail: err.message.replace(/\s+/g, ' ').slice(0, 300), promptChars: extra.promptChars, retryAfterMs: err.retryAfterMs, taskId: extra.taskId,
    };
    this.append(ev);
    return ev;
  }

  recordSuccess(key: string, extra: { taskId?: string; now?: number } = {}): void {
    this.append({ ts: new Date(extra.now ?? Date.now()).toISOString(), key, kind: 'success', taskId: extra.taskId });
  }

  /** Consecutive failures of one category since the last success (drives exponential cooldown). */
  private streak(key: string, category: FailureCategory): number {
    let n = 0;
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      if (e.key !== key) continue;
      if (e.kind === 'success') break;
      if (e.category === category) n++;
    }
    return n;
  }

  /** Active cooldown for a model, if any. Temporary by construction. */
  cooldown(key: string, now: number = Date.now()): Cooldown | undefined {
    let best: Cooldown | undefined;
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      if (e.key !== key) continue;
      if (e.kind === 'success') break; // a success after a failure clears it
      if (!e.category || e.category === 'context_overflow') continue;
      const at = Date.parse(e.ts);
      let until: number;
      if (e.category === 'daily_quota') until = nextUtcMidnight(at);
      else {
        const p = COOLDOWN_POLICY_MS[e.category];
        const streak = this.streak(key, e.category);
        until = at + Math.min(p.cap, Math.max(e.retryAfterMs ?? 0, p.base * 2 ** Math.max(0, streak - 1)));
      }
      if (until > now && (!best || until > best.until)) best = { until, category: e.category, reason: `${e.category}${e.status ? ` (${e.status})` : ''} at ${e.ts.slice(11, 19)}Z, cooling down until ${new Date(until).toISOString().slice(11, 19)}Z` };
    }
    return best;
  }

  /** Smallest prompt size that overflowed recently → observed cap at 90% of it; undefined when never seen. */
  observedPromptCharLimit(key: string, now: number = Date.now()): number | undefined {
    let min: number | undefined;
    for (const e of this.events) {
      if (e.key !== key || e.category !== 'context_overflow' || !e.promptChars) continue;
      if (now - Date.parse(e.ts) > RELIABILITY_WINDOW_MS) continue;
      min = min === undefined ? e.promptChars : Math.min(min, e.promptChars);
    }
    return min === undefined ? undefined : Math.floor(min * 0.9);
  }

  history(key: string, now: number = Date.now()): ModelHistory {
    const recent = this.events.filter((e) => e.key === key && now - Date.parse(e.ts) <= RELIABILITY_WINDOW_MS).slice(-RELIABILITY_MAX_EVENTS);
    const h: ModelHistory = { successes: 0, failures: 0, byCategory: {}, reliability: 0.5 };
    for (const e of recent) {
      if (e.kind === 'success') h.successes++;
      else { h.failures++; if (e.category) h.byCategory[e.category] = (h.byCategory[e.category] ?? 0) + 1; h.lastFailureAt = e.ts; }
    }
    // Laplace prior of 2/2 so a single failure does not zero a model and a single success does not crown it.
    h.reliability = (h.successes + 2) / (h.successes + h.failures + 4);
    return h;
  }
}
