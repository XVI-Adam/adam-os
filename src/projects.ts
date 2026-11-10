import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ROOT } from './config.ts';

export interface ProjectEval {
  command: string;
  filterFlag?: string;
  resultsDir: string;
  baseline?: string;
  expectedFailures?: string;
  dailyTokenCap?: number;
  estimatedFullRunTokens?: number;
  /** Prints the harness's own token estimate for a run (parsed for "Whole run N tokens"). */
  costCommand?: string;
}

export interface Project {
  name: string;
  slug: string;
  aliases: string[];
  repository: string;
  stack: string[];
  objective: string;
  importantDirectories: string[];
  keyFiles: string[];
  docs: string[];
  commands: Partial<Record<'test' | 'typecheck' | 'lint' | 'build' | 'deploy', string>>;
  eval?: ProjectEval;
  allowedCommands: string[];
  knownBlockers: string[];
  architectureNotes: string;
  agentInstructions: string;
}

const PROJECTS_DIR = resolve(ROOT, 'projects');

function toProject(raw: Record<string, unknown>): Project {
  const ev = raw.eval as Record<string, unknown> | undefined;
  return {
    name: String(raw.name),
    slug: String(raw.slug),
    aliases: (raw.aliases as string[] | undefined) ?? [],
    repository: String(raw.repository),
    stack: (raw.stack as string[] | undefined) ?? [],
    objective: String(raw.objective ?? '').trim(),
    importantDirectories: (raw.important_directories as string[] | undefined) ?? ['.'],
    keyFiles: (raw.key_files as string[] | undefined) ?? [],
    docs: (raw.docs as string[] | undefined) ?? [],
    commands: (raw.commands as Project['commands'] | undefined) ?? {},
    eval: ev
      ? {
          command: String(ev.command),
          filterFlag: ev.filter_flag as string | undefined,
          resultsDir: String(ev.results_dir ?? 'evals/results'),
          baseline: ev.baseline as string | undefined,
          expectedFailures: ev.expected_failures as string | undefined,
          dailyTokenCap: ev.daily_token_cap as number | undefined,
          estimatedFullRunTokens: ev.estimated_full_run_tokens as number | undefined,
          costCommand: ev.cost_command as string | undefined,
        }
      : undefined,
    allowedCommands: (raw.allowed_commands as string[] | undefined) ?? [],
    knownBlockers: (raw.known_blockers as string[] | undefined) ?? [],
    architectureNotes: String(raw.architecture_notes ?? '').trim(),
    agentInstructions: String(raw.agent_instructions ?? '').trim(),
  };
}

export function loadProjects(dir: string = PROJECTS_DIR): Project[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .map((f) => toProject(parseYaml(readFileSync(resolve(dir, f), 'utf8')) as Record<string, unknown>))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

export function getProject(slug: string, projects: Project[] = loadProjects()): Project | undefined {
  const s = slug.toLowerCase();
  return projects.find((p) => p.slug === s || p.aliases.some((a) => a.toLowerCase() === s));
}

/** Infer the project from task text by alias match. Longest alias wins; ties → undefined (ambiguous). */
export function inferProject(text: string, projects: Project[] = loadProjects()): { project?: Project; candidates: string[] } {
  const t = text.toLowerCase();
  const hits: Array<{ p: Project; len: number }> = [];
  for (const p of projects) {
    const names = [p.slug, p.name, ...p.aliases].map((n) => n.toLowerCase());
    const best = names.filter((n) => n.length >= 3 && t.includes(n)).sort((a, b) => b.length - a.length)[0];
    if (best) hits.push({ p, len: best.length });
  }
  hits.sort((a, b) => b.len - a.len);
  const candidates = hits.map((h) => h.p.slug);
  if (hits.length === 0) return { candidates };
  if (hits.length > 1 && hits[0].len === hits[1].len) return { candidates };
  return { project: hits[0].p, candidates };
}

/** Compact project block for prompts. Deliberately short: this goes in every agent call. */
export function projectBrief(p: Project): string {
  const lines = [
    `Project: ${p.name} (${p.slug})`,
    `Repository root: ${p.repository}`,
    `Stack: ${p.stack.join(', ')}`,
    `Objective: ${p.objective}`,
    `Important directories: ${p.importantDirectories.join(', ')}`,
  ];
  if (p.keyFiles.length) lines.push(`Key files: ${p.keyFiles.join(', ')}`);
  const cmds = Object.entries(p.commands).map(([k, v]) => `${k}: ${v}`);
  if (cmds.length) lines.push(`Commands: ${cmds.join(' | ')}`);
  if (p.eval) lines.push(`Eval harness: ${p.eval.command}`);
  if (p.knownBlockers.length) lines.push(`Known blockers:\n- ${p.knownBlockers.join('\n- ')}`);
  if (p.architectureNotes) lines.push(`Architecture notes: ${p.architectureNotes}`);
  if (p.agentInstructions) lines.push(`Agent instructions (MUST follow): ${p.agentInstructions}`);
  return lines.join('\n');
}
