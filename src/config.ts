import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { Budget } from './types.ts';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface AdamOSConfig {
  envFiles: string[];
  dataDir: string;
  defaultBudget: Budget;
}

let cached: AdamOSConfig | null = null;

export function loadConfig(): AdamOSConfig {
  if (cached) return cached;
  const path = resolve(ROOT, 'adamos.yaml');
  const raw = existsSync(path) ? (parseYaml(readFileSync(path, 'utf8')) as Record<string, unknown>) : {};
  const db = (raw.default_budget ?? {}) as Record<string, number>;
  cached = {
    envFiles: ((raw.env_files as string[] | undefined) ?? []).map((p) => resolve(ROOT, p)),
    dataDir: resolve(ROOT, (raw.data_dir as string | undefined) ?? 'data'),
    defaultBudget: {
      // max_estimated_cost / max_model_calls are accepted as aliases of the original names.
      maxCostUsd: db.max_estimated_cost ?? db.max_cost_usd ?? 2,
      maxAgentCalls: db.max_model_calls ?? db.max_agent_calls ?? 8,
      maxRetries: db.max_retries ?? 2,
      maxToolCalls: db.max_tool_calls ?? 120,
      maxWallClockMs: (db.max_wall_clock_minutes ?? 45) * 60_000,
    },
  };
  return cached;
}

/** Parse a dotenv file into a map. Values are never logged by anything in this module. */
export function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const secretCache = new Map<string, string | undefined>();

/** Resolve a secret: process.env, then AdamOS/.env, then configured env_files. */
export function getSecret(name: string): string | undefined {
  if (secretCache.has(name)) return secretCache.get(name);
  let value: string | undefined = process.env[name];
  if (!value) {
    const files = [resolve(ROOT, '.env'), ...loadConfig().envFiles];
    for (const f of files) {
      const v = parseEnvFile(f)[name];
      if (v && !/your_token_here|changeme|^\s*$/i.test(v)) { value = v; break; }
    }
  }
  secretCache.set(name, value);
  return value;
}

export function hasSecret(name: string): boolean {
  return Boolean(getSecret(name));
}
