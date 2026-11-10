import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listAgents } from './agents/index.ts';
import { computeAnalytics } from './analytics.ts';
import { loadConfig, ROOT } from './config.ts';
import { createTask, isTerminal, runTask } from './orchestrator.ts';
import { loadProjects, getProject } from './projects.ts';
import { ProviderRegistry } from './providers/index.ts';
import { route } from './router.ts';
import { Store } from './store.ts';
import type { Budget, TaskRecord, Tier } from './types.ts';
import { WORKFLOWS } from './workflows.ts';

const HELP = `orchestrate — personal AI engineering orchestrator

  orchestrate brief [--no-tests] [--all] [--json]    morning brief: top 3 tasks across all projects

  orchestrate "<task>" [--project <slug>] [--budget <usd>] [--max-calls <n>] [--max-retries <n>]
                       [--tier light|standard|strong] [--outcome "<desired outcome>"] [--dry-run] [--detach]
  orchestrate route "<task>" [--project <slug>]     show the routing decision only
  orchestrate status                                 active tasks
  orchestrate history [--limit n]                    finished tasks
  orchestrate show <id|prefix>                       full task record
  orchestrate events <id|prefix>                     structured event log for a task
  orchestrate pause|resume|stop|replan <id|prefix>   control a running task
  orchestrate analytics                              aggregate metrics
  orchestrate doctor                                 provider health + per-model feasibility (forces re-probe)
  orchestrate simulate --tier <t> --chars <n> [--calls n] [--no-tools] [--json-out] [--budget usd] [--scenario file.json]
                                                     deterministic routing decision, no model calls
  orchestrate routing <id|prefix>                    every routing decision a task made, with eliminations
  orchestrate projects | agents | workflows          registries
  orchestrate dashboard [--port 4646] [--open]       daily dashboard: brief, today list, launch + watch tasks (localhost only)
`;

interface Parsed { cmd: string; positional: string[]; flags: Record<string, string | boolean> }

function parse(argv: string[]): Parsed {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=', 2);
      if (inline !== undefined) flags[k] = inline;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
      else flags[k] = true;
    } else positional.push(a);
  }
  const known = ['brief', 'route', 'status', 'history', 'show', 'events', 'pause', 'resume', 'stop', 'replan', 'analytics', 'doctor', 'projects', 'agents', 'workflows', 'dashboard', 'run', 'help', 'simulate', 'routing'];
  const cmd = positional.length && known.includes(positional[0]) ? positional.shift()! : 'run';
  return { cmd, positional, flags };
}

const money = (n: number | null | undefined, basis?: string) => (n === null || n === undefined ? 'n/a' : `$${n.toFixed(4)}${basis ? ` (${basis})` : ''}`);
const mins = (ms?: number) => (ms === undefined ? '-' : `${(ms / 60000).toFixed(1)}m`);

function summarize(t: TaskRecord): string {
  const cost = t.usage.providerReportedCostUsd ?? t.usage.estimatedCostUsd;
  return [
    t.id.padEnd(20), t.project.padEnd(16), t.status.padEnd(17), (t.outcome ?? '-').padEnd(16),
    `${t.attempt}/${t.budget.maxRetries + 1}`.padEnd(5), `${t.usage.modelCalls} calls`.padEnd(9),
    money(cost, t.usage.costBasis).padEnd(22), mins(t.durationMs).padEnd(6),
    t.evalScore !== undefined ? `eval ${(t.evalScore * 100).toFixed(0)}%${t.evalFilteredScore !== undefined ? ` (re-run ${(t.evalFilteredScore * 100).toFixed(0)}%)` : ''}` : '',
    t.description.slice(0, 50),
  ].join(' ');
}

async function main(): Promise<void> {
  const { cmd, positional, flags } = parse(process.argv.slice(2));
  const store = new Store();
  const projects = loadProjects();

  if (cmd === 'help' || flags.help) { console.log(HELP); return; }

  if (cmd === 'brief') {
    const { runBrief } = await import('./brief/index.ts');
    const brief = await runBrief(projects, { runTests: !flags['no-tests'], showAll: Boolean(flags.all), dataDir: loadConfig().dataDir });
    if (flags.json) { console.log(JSON.stringify({ date: brief.date, top: brief.top, all: brief.all, scans: brief.scans }, null, 2)); return; }
    console.log(brief.text);
    console.error(`\nsaved ${brief.savedTo}`);
    return;
  }

  if (cmd === 'projects') { for (const p of projects) console.log(`${p.slug.padEnd(18)} ${p.name.padEnd(36)} ${p.repository}`); return; }
  if (cmd === 'agents') { for (const a of listAgents()) console.log(`${a.role.padEnd(11)} write=${a.write ? 'y' : 'n'} maxSteps=${a.maxSteps}  ${a.description}`); return; }
  if (cmd === 'workflows') { for (const w of Object.values(WORKFLOWS)) console.log(`${w.id.padEnd(22)} ${w.steps.map((s) => s.kind === 'verify' ? `verify(${s.verify})` : s.role).join(' → ')}`); return; }

  if (cmd === 'doctor') {
    const registry = new ProviderRegistry();
    const health = await registry.checkHealth(true);
    for (const [id, h] of Object.entries(health)) console.log(`${h.ok ? '✓' : '✗'} ${id.padEnd(11)} ${h.detail}`);
    const cfg = loadConfig();
    console.log(`\nsecrets searched in: AdamOS/.env, ${cfg.envFiles.join(', ')}`);
    console.log(`data dir: ${cfg.dataDir}`);
    console.log('');
    for (const m of registry.modelStatus()) console.log(`${m.ok ? '✓' : '✗'} ${m.model.padEnd(32)} ${m.tier.padEnd(9)} ${m.reason}`);
    console.log('');
    for (const tier of ['light', 'standard', 'strong'] as Tier[]) {
      const r = registry.resolve(tier, { needsTools: true });
      console.log(`tier ${tier.padEnd(8)} → ${r ? `${r.provider.id}/${r.model.id} (prompt budget ${r.model.promptCharBudget.toLocaleString()} chars)` : 'NO AVAILABLE MODEL'}`);
    }
    return;
  }

  if (cmd === 'simulate') {
    const { simulate } = await import('./routing/simulate.ts');
    const { renderDecision } = await import('./routing/preflight.ts');
    const { readFileSync } = await import('node:fs');
    const scenario = flags.scenario ? (JSON.parse(readFileSync(String(flags.scenario), 'utf8')) as Record<string, unknown>) : {};
    const d = simulate({
      ...scenario,
      requirements: {
        tier: (flags.tier as Tier | undefined) ?? 'standard', promptChars: Number(flags.chars ?? 20_000), expectedCalls: Number(flags.calls ?? 6),
        needsTools: !flags['no-tools'], needsJson: Boolean(flags['json-out']),
        budget: { remainingCostUsd: Number(flags.budget ?? 2), remainingCalls: Number(flags['max-calls'] ?? 40), maxCostUsd: Number(flags.budget ?? 2) },
        ...((scenario.requirements as object | undefined) ?? {}),
      },
      // Without --scenario, use the LIVE quota/ledger state so the answer matches what a real run would do now.
      ...(flags.scenario ? {} : liveScenarioState()),
    } as Parameters<typeof simulate>[0]);
    console.log(renderDecision(d));
    return;
  }

  if (cmd === 'routing') {
    const id = store.resolveTaskId(positional[0] ?? '');
    if (!id) throw new Error(`no task matches '${positional[0]}'`);
    const { renderDecision } = await import('./routing/preflight.ts');
    for (const ev of store.readEvents(id).filter((e) => e.type === 'routing.decision')) {
      console.log(`\n[${String(ev.ts).slice(11, 19)}] step ${ev.step} phase ${ev.phase}${ev.trigger ? ` (after: ${String(ev.trigger).slice(0, 100)})` : ''}`);
      const el = (ev.eliminated as Array<{ model: string; reason: string; detail: string }>) ?? [];
      const rem = (ev.remaining as Array<{ model: string; score: number; reliability: number; estimatedCostUsd: number | null; estimatedTokens: number }>) ?? [];
      for (const c of el) console.log(`  ✗ ${c.model.padEnd(30)} ${c.reason.padEnd(20)} ${c.detail}`);
      for (const c of rem) console.log(`  ${c.model === ev.selected ? '★' : '✓'} ${c.model.padEnd(30)} score ${c.score} rel ${c.reliability} est ${c.estimatedCostUsd === null ? 'n/a' : '$' + c.estimatedCostUsd.toFixed(4)} ~${c.estimatedTokens} tok`);
      console.log(`  → ${ev.explanation}`);
      void renderDecision;
    }
    return;
  }

  if (cmd === 'route') {
    const text = positional.join(' ');
    if (!text) throw new Error('route needs a task description');
    const { task } = createTask({ description: text, project: flags.project as string | undefined, desiredOutcome: flags.outcome as string | undefined }, projects);
    console.log(JSON.stringify({ ...task.route, budget: task.budget }, null, 2));
    return;
  }

  if (cmd === 'status') {
    const active = store.listTasks().filter((t) => !isTerminal(t));
    if (!active.length) { console.log('no active tasks'); return; }
    for (const t of active) console.log(summarize(t) + (t.currentStep ? `  @${t.currentStep}` : ''));
    return;
  }

  if (cmd === 'history') {
    const limit = Number(flags.limit ?? 30);
    const done = store.listTasks().filter(isTerminal).slice(0, limit);
    if (!done.length) { console.log('no finished tasks'); return; }
    console.log(['id'.padEnd(20), 'project'.padEnd(16), 'status'.padEnd(17), 'outcome'.padEnd(16), 'att'.padEnd(5), 'calls'.padEnd(9), 'cost'.padEnd(22), 'dur'.padEnd(6), 'eval / task'].join(' '));
    for (const t of done) console.log(summarize(t));
    return;
  }

  if (cmd === 'show' || cmd === 'events' || ['pause', 'resume', 'stop', 'replan'].includes(cmd)) {
    const id = store.resolveTaskId(positional[0] ?? '');
    if (!id) throw new Error(`no task matches '${positional[0]}'`);
    if (cmd === 'show') { console.log(JSON.stringify(store.loadTask(id), null, 2)); return; }
    if (cmd === 'events') { for (const e of store.readEvents(id)) console.log(JSON.stringify(e)); return; }
    const t = store.loadTask(id)!;
    if (isTerminal(t)) throw new Error(`task ${id} already finished (${t.status})`);
    store.setControl(id, cmd as 'pause' | 'resume' | 'stop' | 'replan');
    console.log(`${cmd} requested for ${id}; honoured at the next step boundary`);
    return;
  }

  if (cmd === 'analytics') { console.log(JSON.stringify(computeAnalytics(store.listTasks()), null, 2)); return; }

  if (cmd === 'dashboard') {
    const { startDashboard } = await import('./dashboard/server.ts');
    startDashboard(Number(flags.port ?? 4646), { open: Boolean(flags.open) });
    return;
  }

  // run
  const text = positional.join(' ').trim();
  if (!text) { console.log(HELP); process.exit(1); }
  const budget: Partial<Budget> = {};
  if (flags.budget) budget.maxCostUsd = Number(flags.budget);
  if (flags['max-calls']) budget.maxAgentCalls = Number(flags['max-calls']);
  if (flags['max-retries']) budget.maxRetries = Number(flags['max-retries']);
  if (flags['max-minutes']) budget.maxWallClockMs = Number(flags['max-minutes']) * 60_000;
  const { task, project } = createTask({ description: text, project: flags.project as string | undefined, desiredOutcome: flags.outcome as string | undefined, budget, tier: flags.tier as Tier | undefined }, projects);
  store.saveTask(task);
  console.error(`task ${task.id} → ${project.slug} | ${task.route.category} | complexity ${task.route.complexity.score}/5 | workflow ${task.route.workflow} | tier ${task.route.tier}`);
  for (const r of task.route.rationale) console.error(`  - ${r}`);
  if (flags['dry-run']) { console.log(JSON.stringify(task, null, 2)); return; }

  if (flags.detach) {
    const log = openSync(store.logPath(task.id), 'a');
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'run', '--resume-id', task.id], { detached: true, stdio: ['ignore', log, log], cwd: ROOT, env: process.env });
    child.unref();
    console.log(task.id);
    return;
  }
  await execute(task.id, store);
}

/** Quota + ledger state as the simulation expects it, read from the same files the orchestrator uses. */
function liveScenarioState(): Record<string, unknown> {
  const registry = new ProviderRegistry();
  const st = registry.state();
  return { health: st.health, requestsToday: st.requestsToday, tokensToday: st.tokensToday, ledgerEvents: [...registry.ledger.all()], now: Date.now() };
}

export async function execute(taskId: string, store: Store): Promise<TaskRecord> {
  const task = store.loadTask(taskId)!;
  const registry = new ProviderRegistry();
  await registry.checkHealth(false);
  if (!registry.healthyIds().length) {
    task.status = 'failed'; task.outcome = 'failed'; task.failureReason = 'no healthy provider (run `orchestrate doctor`)'; store.saveTask(task);
    console.error(task.failureReason); return task;
  }
  const result = await runTask(task, { store, registry, log: (l) => console.error(l) });
  console.error(`\n${result.id}: ${result.status} (${result.outcome})${result.failureReason ? ` — ${result.failureReason}` : ''}`);
  console.error(`calls ${result.usage.modelCalls}, tools ${result.usage.toolCalls}, tokens in/out ${result.usage.tokens.input}/${result.usage.tokens.output}, cost ${money(result.usage.estimatedCostUsd, 'estimated')}${result.usage.providerReportedCostUsd !== null ? `, provider-reported ${money(result.usage.providerReportedCostUsd)}` : ''}, basis ${result.usage.costBasis}, ${mins(result.durationMs)}`);
  if (result.finalSummary) console.log(`\n${result.finalSummary}`);
  return result;
}

// `run --resume-id <id>` is the detached child entrypoint.
const argv = process.argv.slice(2);
const resumeIdx = argv.indexOf('--resume-id');
if (resumeIdx !== -1) {
  execute(argv[resumeIdx + 1], new Store()).then((t) => process.exit(t.outcome === 'success' ? 0 : 1)).catch((e) => { console.error(e); process.exit(2); });
} else {
  main().catch((e) => { console.error(`error: ${(e as Error).message}`); process.exit(1); });
}
export { getProject, resolve };
