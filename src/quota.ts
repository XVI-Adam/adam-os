import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from './config.ts';
import { loadProjects, type Project } from './projects.ts';

// Groq's free tier has a 200k tokens/day cap that appears in no header. We
// account for it ourselves: tokens the harness spent today (uncached outcomes
// in today's eval reports) plus tokens the orchestrator's own Groq agent calls
// spent (recorded here). Dates are UTC; the true reset boundary is not
// documented, so this is a conservative estimate, labelled as such.

function todayKey(): string { return new Date().toISOString().slice(0, 10); }

function quotaPath(): string {
  const dir = resolve(loadConfig().dataDir, 'quota');
  mkdirSync(dir, { recursive: true });
  return resolve(dir, `groq-${todayKey()}.json`);
}

export function recordAgentGroqTokens(n: number): void {
  const p = quotaPath();
  const cur = existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as { agentTokens: number }) : { agentTokens: 0 };
  cur.agentTokens += n;
  writeFileSync(p, JSON.stringify(cur));
}

function requestsPath(): string {
  const dir = resolve(loadConfig().dataDir, 'quota');
  mkdirSync(dir, { recursive: true });
  return resolve(dir, `requests-${todayKey()}.json`);
}

/** Count one generate request against a model's daily cap. */
export function recordModelRequest(modelKey: string): number {
  const p = requestsPath();
  const cur = existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Record<string, number>) : {};
  cur[modelKey] = (cur[modelKey] ?? 0) + 1;
  writeFileSync(p, JSON.stringify(cur));
  return cur[modelKey];
}

export function modelRequestsToday(modelKey: string): number {
  const p = requestsPath();
  if (!existsSync(p)) return 0;
  return (JSON.parse(readFileSync(p, 'utf8')) as Record<string, number>)[modelKey] ?? 0;
}

/**
 * Groq tokens spent today: agent calls recorded here plus uncached outcomes in today's eval reports.
 * With no project given, every registered project with an eval harness is scanned — the cap is per key, not per project.
 */
export function groqTokensToday(project?: Project): { fromEvalReports: number; fromAgents: number; total: number; basis: 'estimated' } {
  const p = quotaPath();
  const fromAgents = existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as { agentTokens: number }).agentTokens : 0;
  let fromEvalReports = 0;
  const projects = project ? [project] : safeLoadProjects();
  for (const proj of projects) {
    if (!proj.eval) continue;
    const dir = resolve(proj.repository, proj.eval.resultsDir);
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.json') || f.includes('.progress') || !f.startsWith(todayKey())) continue;
        try {
          const rep = JSON.parse(readFileSync(resolve(dir, f), 'utf8')) as { outcomes?: Array<{ tokens?: number; cached?: boolean }> };
          for (const o of rep.outcomes ?? []) if (!o.cached) fromEvalReports += o.tokens ?? 0;
        } catch { /* skip unreadable report */ }
      }
    }
  }
  return { fromEvalReports, fromAgents, total: fromEvalReports + fromAgents, basis: 'estimated' };
}

function safeLoadProjects(): Project[] {
  try { return loadProjects(); } catch { return []; }
}
