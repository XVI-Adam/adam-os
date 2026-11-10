import { spawn } from 'node:child_process';
import { openSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeAnalytics } from '../analytics.ts';
import { runBrief } from '../brief/index.ts';
import type { Candidate } from '../brief/rank.ts';
import type { ProjectScan } from '../brief/scan.ts';
import { loadConfig, ROOT } from '../config.ts';
import { createTask, isTerminal } from '../orchestrator.ts';
import { loadProjects, type Project } from '../projects.ts';
import { GROQ_DAILY_TOKEN_RESERVE, ProviderRegistry } from '../providers/index.ts';
import { groqTokensToday } from '../quota.ts';
import { Store, type ControlAction } from '../store.ts';
import { TIERS, type Budget, type TaskRecord, type Tier } from '../types.ts';
import { getWorkflow } from '../workflows.ts';
import { FocusStore } from './focus.ts';

// The daily dashboard: one local page to start the day from (brief + focus
// list), hand work to the orchestrator, and watch it run. Everything here is
// a thin read/write layer over the same store, registry and brief code the
// CLI uses; no logic lives in the page that the CLI could not reproduce.

const PUBLIC_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), 'public');
const STATIC: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
};

const BRIEF_TTL_MS = 5 * 60_000;
const CAPACITY_TTL_MS = 10_000;
const GROQ_DAILY_TOKEN_CAP = 200_000;
const MAX_BODY_BYTES = 64 * 1024;

export interface DashboardDeps {
  store?: Store;
  projects?: Project[];
  dataDir?: string;
  /** Builds a registry over the current health/quota/ledger files. Called fresh so detached runs are reflected. */
  makeRegistry?: () => ProviderRegistry;
  /** Starts a saved task in the background. Default: detached `cli.ts run --resume-id <id>`. */
  launch?: (task: TaskRecord, store: Store) => void;
  /** Probe stale provider health when the server starts (default true). */
  probeOnStart?: boolean;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson<T>(req: IncomingMessage): Promise<T> {
  return new Promise((done, fail) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (d: Buffer) => {
      size += d.length;
      if (size > MAX_BODY_BYTES) { fail(new HttpError(413, 'request body too large')); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return done({} as T);
      try { done(JSON.parse(text) as T); } catch { fail(new HttpError(400, 'body is not valid JSON')); }
    });
    req.on('error', fail);
  });
}

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const hostnameOf = (host: string) => host.replace(/:\d+$/, '').toLowerCase();

/**
 * The server can start agents that edit repositories, so it only answers the
 * machine it runs on: a local Host header (blocks DNS rebinding), and for
 * anything that writes, a same-origin request with a JSON body (blocks a web
 * page in another tab from posting to it).
 */
export function checkRequest(req: IncomingMessage): string | undefined {
  const host = req.headers.host ?? '';
  if (!LOCAL_HOSTNAMES.has(hostnameOf(host))) return 'dashboard only answers on localhost';
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const origin = req.headers.origin;
  if (origin) {
    let originHost = '';
    try { originHost = new URL(origin).host; } catch { /* malformed origin: rejected below */ }
    if (originHost !== host) return 'cross-origin request refused';
  }
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return 'content-type must be application/json';
  return undefined;
}

const clip = (s: string | undefined, n: number) => (s === undefined ? undefined : s.length > n ? `${s.slice(0, n)}…` : s);

function pipeline(t: TaskRecord): Array<{ id: string; label: string; state: string }> {
  return getWorkflow(t.route.workflow).steps.map((s) => {
    const recs = t.steps.filter((r) => r.stepId === s.id);
    const last = recs[recs.length - 1];
    return { id: s.id, label: s.kind === 'verify' ? `verify ${s.verify}` : String(s.role), state: last ? last.status : 'pending' };
  });
}

function processAlive(pid: number | undefined): boolean | undefined {
  if (!pid) return undefined;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** What the page needs per task, without the step-by-step record (tool calls, routing traces). */
export function summarizeTask(t: TaskRecord, now: number = Date.now()): Record<string, unknown> {
  const terminal = isTerminal(t);
  const latest = [...t.steps].reverse().find((s) => s.summary || s.error);
  const running = [...t.steps].reverse().find((s) => s.status === 'running');
  return {
    id: t.id, createdAt: t.createdAt, updatedAt: t.updatedAt, startedAt: t.startedAt, endedAt: t.endedAt,
    project: t.project, description: t.description, desiredOutcome: t.desiredOutcome,
    status: t.status, outcome: t.outcome, attempt: t.attempt, currentStep: t.currentStep,
    route: { category: t.route.category, workflow: t.route.workflow, tier: t.route.tier, complexity: t.route.complexity },
    budget: t.budget,
    usage: {
      modelCalls: t.usage.modelCalls, toolCalls: t.usage.toolCalls, retries: t.usage.retries, tokens: t.usage.tokens,
      estimatedCostUsd: t.usage.estimatedCostUsd, providerReportedCostUsd: t.usage.providerReportedCostUsd, costBasis: t.usage.costBasis,
    },
    durationMs: t.durationMs ?? (!terminal && t.startedAt ? now - Date.parse(t.startedAt) : undefined),
    evalScore: t.evalScore, evalFilteredScore: t.evalFilteredScore, evalBaselineScore: t.evalBaselineScore,
    failureReason: clip(t.failureReason, 400),
    finalSummary: clip(t.finalSummary, 600),
    pipeline: pipeline(t),
    model: running?.model ? `${running.provider}/${running.model}` : undefined,
    latest: latest ? { step: latest.stepId, summary: clip(latest.summary, 1200), error: clip(latest.error, 600) } : undefined,
    // A non-terminal task whose process is gone will never finish on its own.
    orphaned: !terminal && processAlive(t.pid) === false,
  };
}

function slimScan(s: ProjectScan): Record<string, unknown> {
  const others = s.branches.filter((b) => b.name !== s.defaultBranch);
  return {
    slug: s.slug, error: s.error, defaultBranch: s.defaultBranch, currentBranch: s.currentBranch,
    lastActivityMs: s.lastActivityMs, dirtyCount: s.dirty.count,
    unmergedBranches: others.filter((b) => b.ahead > 0).length,
    mergedBranches: others.filter((b) => b.ahead === 0 && b.name !== s.currentBranch).length,
    todoCount: s.todos.length, tests: s.tests,
  };
}

interface BriefSnapshot {
  date: string;
  generatedAt: number;
  /** 'run' = test commands were executed for this snapshot; 'cached' = only results cached for the current tree. */
  tests: 'run' | 'cached';
  top: Candidate[];
  all: Candidate[];
  scans: Array<Record<string, unknown>>;
}

/** Keeps the latest brief in memory; fast scans are awaited, test runs happen in the background. */
class BriefService {
  private projects: Project[];
  private dataDir: string;
  private current: BriefSnapshot | undefined;
  private fast: Promise<BriefSnapshot> | undefined;
  private full: Promise<void> | undefined;
  private fullStartedAt: number | undefined;
  private lastError: string | undefined;

  constructor(projects: Project[], dataDir: string) { this.projects = projects; this.dataDir = dataDir; }

  private async scan(runTests: boolean): Promise<BriefSnapshot> {
    const b = await runBrief(this.projects, { runTests, cachedTestsOnly: !runTests, showAll: false, dataDir: this.dataDir, save: runTests });
    const snap: BriefSnapshot = { date: b.date, generatedAt: Date.now(), tests: runTests ? 'run' : 'cached', top: b.top, all: b.all, scans: b.scans.map(slimScan) };
    this.current = snap;
    this.lastError = undefined;
    return snap;
  }

  private refreshFast(): Promise<BriefSnapshot> {
    this.fast ??= this.scan(false).finally(() => { this.fast = undefined; });
    return this.fast;
  }

  startFull(): void {
    if (this.full) return;
    this.fullStartedAt = Date.now();
    this.full = this.scan(true).then(() => undefined, (e: Error) => { this.lastError = e.message; }).finally(() => { this.full = undefined; this.fullStartedAt = undefined; });
  }

  async get(force: boolean): Promise<Record<string, unknown>> {
    const stale = !this.current || Date.now() - this.current.generatedAt > BRIEF_TTL_MS;
    // While test commands are running the previous snapshot stays up; a fast scan now would only race it.
    if ((force || stale) && !this.full) {
      try { await this.refreshFast(); } catch (e) { this.lastError = (e as Error).message; }
    }
    return { brief: this.current ?? null, running: Boolean(this.full), runningSince: this.fullStartedAt, error: this.lastError };
  }
}

function defaultLaunch(task: TaskRecord, store: Store): void {
  const log = openSync(store.logPath(task.id), 'a');
  const child = spawn(process.execPath, [resolve(ROOT, 'src/cli.ts'), 'run', '--resume-id', task.id], { detached: true, stdio: ['ignore', log, log], cwd: ROOT, env: process.env });
  child.unref();
}

function parseBudget(body: { budget?: unknown; maxCalls?: unknown; maxMinutes?: unknown }): Partial<Budget> {
  const num = (v: unknown, name: string, max: number): number | undefined => {
    if (v === undefined || v === null || v === '') return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0 || n > max) throw new HttpError(400, `${name} must be a number between 0 and ${max}`);
    return n;
  };
  const cost = num(body.budget, 'budget', 100);
  const calls = num(body.maxCalls, 'max calls', 200);
  const minutes = num(body.maxMinutes, 'max minutes', 600);
  return {
    ...(cost !== undefined ? { maxCostUsd: cost } : {}),
    ...(calls !== undefined ? { maxAgentCalls: Math.floor(calls) } : {}),
    ...(minutes !== undefined ? { maxWallClockMs: minutes * 60_000 } : {}),
  };
}

interface TaskBody { description?: string; project?: string; outcome?: string; tier?: string; budget?: unknown; maxCalls?: unknown; maxMinutes?: unknown }

export function createDashboardServer(deps: DashboardDeps = {}): Server {
  const dataDir = deps.dataDir ?? loadConfig().dataDir;
  const store = deps.store ?? new Store(dataDir);
  const projects = deps.projects ?? loadProjects();
  const makeRegistry = deps.makeRegistry ?? (() => new ProviderRegistry(undefined, dataDir));
  const launch = deps.launch ?? defaultLaunch;
  const focus = new FocusStore(dataDir);
  const brief = new BriefService(projects, dataDir);
  let probing: Promise<unknown> | undefined;
  let capacityCache: { at: number; value: Record<string, unknown> } | undefined;

  const probe = (force: boolean): Promise<unknown> => {
    probing ??= makeRegistry().checkHealth(force).catch(() => undefined).finally(() => { probing = undefined; capacityCache = undefined; });
    return probing;
  };

  const capacity = (): Record<string, unknown> => {
    const now = Date.now();
    if (capacityCache && now - capacityCache.at < CAPACITY_TTL_MS) return capacityCache.value;
    const registry = makeRegistry();
    const caps = registry.capabilities();
    const state = registry.state(now);
    const models = registry.modelStatus(now).map((m) => {
      const cap = caps.find((c) => c.key === m.model);
      const h = registry.ledger.history(m.model, now);
      return {
        key: m.model, provider: cap?.provider ?? m.model.split('/')[0], tier: m.tier, mode: cap?.mode,
        ok: m.ok, reason: m.ok ? 'available' : m.reason.split(';')[0],
        requestsToday: state.requestsToday[m.model] ?? 0, requestCap: cap?.rpd.value ?? null,
        reliability: h.reliability, successes: h.successes, failures: h.failures,
        cooldownUntil: registry.ledger.cooldown(m.model, now)?.until,
      };
    });
    const pick = (tier: Tier) => { const r = registry.resolve(tier, { needsTools: true }); return r ? `${r.provider.id}/${r.model.id}` : null; };
    const groq = groqTokensToday();
    const value = {
      providers: registry.healthCache,
      models,
      tiers: Object.fromEntries(TIERS.map((t) => [t, pick(t)])),
      groq: registry.providers.has('groq') ? { tokensToday: groq.total, fromEvalReports: groq.fromEvalReports, fromAgents: groq.fromAgents, cap: GROQ_DAILY_TOKEN_CAP, agentReserve: GROQ_DAILY_TOKEN_RESERVE } : null,
    };
    capacityCache = { at: now, value };
    return value;
  };

  const preview = (body: TaskBody): { task: TaskRecord; project: Project } => {
    const description = String(body.description ?? '').trim();
    if (!description) throw new HttpError(400, 'describe the task first');
    if (description.length > 8000) throw new HttpError(400, 'task description is too long (8000 characters max)');
    if (body.tier && !TIERS.includes(body.tier as Tier)) throw new HttpError(400, `tier must be one of ${TIERS.join(', ')}`);
    try {
      return createTask({
        description, project: body.project || undefined, desiredOutcome: body.outcome?.trim() || undefined,
        tier: (body.tier as Tier | undefined) || undefined, budget: parseBudget(body),
      }, projects);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, (e as Error).message);
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    const asset = STATIC[path];
    if (method === 'GET' && asset) {
      // Read per request so page edits show up on reload without restarting the server.
      res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store' });
      res.end(readFileSync(resolve(PUBLIC_DIR, asset.file)));
      return;
    }

    if (method === 'GET' && path === '/api/state') {
      const tasks = store.listTasks();
      const now = Date.now();
      const perProject = new Map<string, { tasks: number; active: number; lastOutcome?: string }>();
      for (const t of [...tasks].reverse()) {
        const p = perProject.get(t.project) ?? { tasks: 0, active: 0 };
        p.tasks++;
        if (!isTerminal(t)) p.active++;
        if (t.outcome) p.lastOutcome = t.outcome;
        perProject.set(t.project, p);
      }
      return send(res, 200, {
        now,
        active: tasks.filter((t) => !isTerminal(t)).map((t) => summarizeTask(t, now)),
        history: tasks.filter(isTerminal).slice(0, 60).map((t) => summarizeTask(t, now)),
        analytics: computeAnalytics(tasks),
        capacity: capacity(),
        probing: Boolean(probing),
        projects: projects.map((p) => ({
          slug: p.slug, name: p.name, repository: p.repository, stack: p.stack, objective: p.objective,
          commands: Object.keys(p.commands), hasEval: Boolean(p.eval), knownBlockers: p.knownBlockers,
          ...(perProject.get(p.slug) ?? { tasks: 0, active: 0 }),
        })),
        defaults: { budget: loadConfig().defaultBudget },
      });
    }

    if (method === 'GET' && path === '/api/brief') return send(res, 200, await brief.get(url.searchParams.get('refresh') === '1'));
    if (method === 'POST' && path === '/api/brief/run') {
      await readJson(req);
      brief.startFull();
      return send(res, 202, await brief.get(false));
    }

    if (method === 'POST' && path === '/api/providers/check') {
      await readJson(req);
      await probe(true);
      return send(res, 200, capacity());
    }

    if (path === '/api/focus') {
      if (method === 'GET') return send(res, 200, { items: focus.list() });
      if (method === 'POST') {
        const body = await readJson<{ text?: string; project?: string; source?: string }>(req);
        if (!String(body.text ?? '').trim()) throw new HttpError(400, 'focus item needs text');
        focus.add({ text: String(body.text), project: body.project, source: body.source });
        return send(res, 201, { items: focus.list() });
      }
    }
    const fm = /^\/api\/focus\/([^/]+)$/.exec(path);
    if (fm && (method === 'POST' || method === 'DELETE')) {
      const id = decodeURIComponent(fm[1]);
      const body = await readJson<{ done?: boolean; text?: string }>(req);
      const ok = method === 'DELETE' ? focus.remove(id) : Boolean(focus.update(id, body));
      if (!ok) throw new HttpError(404, 'no such focus item');
      return send(res, 200, { items: focus.list() });
    }

    if (method === 'POST' && path === '/api/route') {
      const { task, project } = preview(await readJson<TaskBody>(req));
      const wf = getWorkflow(task.route.workflow);
      const registry = makeRegistry();
      const model = registry.resolve(task.route.tier, { needsTools: true });
      return send(res, 200, {
        project: { slug: project.slug, name: project.name },
        route: task.route,
        budget: task.budget,
        workflow: { id: wf.id, description: wf.description, steps: wf.steps.map((s) => (s.kind === 'verify' ? `verify ${s.verify}` : String(s.role))) },
        modelNow: model ? `${model.provider.id}/${model.model.id}` : null,
      });
    }

    if (method === 'POST' && path === '/api/tasks') {
      const { task } = preview(await readJson<TaskBody>(req));
      store.saveTask(task);
      launch(task, store);
      return send(res, 201, { id: task.id, project: task.project, route: task.route });
    }

    const tm = /^\/api\/tasks\/([^/]+)(?:\/(control|events|log))?$/.exec(path);
    if (tm) {
      const id = store.resolveTaskId(decodeURIComponent(tm[1]));
      if (!id) throw new HttpError(404, 'no such task');
      const task = store.loadTask(id)!;
      if (method === 'GET' && !tm[2]) return send(res, 200, task);
      if (method === 'GET' && tm[2] === 'events') return send(res, 200, store.readEvents(id));
      if (method === 'GET' && tm[2] === 'log') {
        let text = '';
        try { text = readFileSync(store.logPath(id), 'utf8').slice(-20_000); } catch { /* task was run in the foreground: no log file */ }
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end(text);
        return;
      }
      if (method === 'POST' && tm[2] === 'control') {
        const { action } = await readJson<{ action?: string }>(req);
        if (!['pause', 'resume', 'stop', 'replan'].includes(String(action))) throw new HttpError(400, 'action must be pause, resume, stop or replan');
        if (isTerminal(task)) throw new HttpError(409, `task already finished (${task.status})`);
        if (action === 'stop' && processAlive(task.pid) === false) {
          // Nothing is left to honour the flag, so close the record here instead of leaving it "running" forever.
          task.status = 'stopped'; task.outcome = 'stopped'; task.failureReason = 'stopped from the dashboard after its process had exited';
          task.endedAt = new Date().toISOString();
          store.saveTask(task);
          store.appendEvent({ taskId: task.id, project: task.project, type: 'task.end', outcome: 'stopped', reason: task.failureReason });
        } else {
          store.setControl(id, action as ControlAction);
        }
        return send(res, 200, { ok: true });
      }
    }

    throw new HttpError(404, 'not found');
  };

  const server = createServer((req, res) => {
    const refused = checkRequest(req);
    if (refused) return send(res, 403, { error: refused });
    handle(req, res).catch((e: Error) => {
      if (res.headersSent) { res.end(); return; }
      send(res, e instanceof HttpError ? e.status : 500, { error: e.message });
    });
  });

  if (deps.probeOnStart !== false) void probe(false);
  return server;
}

export function startDashboard(port = 4646, opts: { open?: boolean } = {}): Server {
  const server = createDashboardServer();
  const url = `http://localhost:${port}`;
  server.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE') console.error(`port ${port} is already in use — the dashboard may already be running at ${url} (or pass --port)`);
    else console.error(`dashboard error: ${e.message}`);
    process.exit(1);
  });
  // Loopback only: this server starts agents and is not meant to be reachable from the network.
  server.listen(port, '127.0.0.1', () => {
    console.log(`AdamOS dashboard → ${url}`);
    if (opts.open) {
      const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
      spawn(cmd, [url], { stdio: 'ignore', detached: true }).on('error', () => { /* no opener available: the URL is printed above */ }).unref();
    }
  });
  return server;
}
