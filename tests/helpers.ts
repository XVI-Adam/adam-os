import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Project } from '../src/projects.ts';
import { limit, unknown, type ModelCapabilities } from '../src/providers/capabilities.ts';
import { ProviderRegistry } from '../src/providers/index.ts';
import { ProviderLedger } from '../src/providers/ledger.ts';
import type { ChatRequest, ChatResponse, DelegatedResult, DelegatedRun, ModelInfo, Provider, ProviderHealth } from '../src/providers/types.ts';
import { Store } from '../src/store.ts';
import type { Tier } from '../src/types.ts';

export function tmpProject(overrides: Partial<Project> = {}): Project {
  const dir = mkdtempSync(join(tmpdir(), 'adamos-proj-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'index.ts'), 'export function greet(name: string) { return `hi ${name}`; }\n');
  writeFileSync(join(dir, 'README.md'), '# Test project\nA tiny fixture for the orchestrator tests.\n');
  writeFileSync(join(dir, '.env'), 'SECRET=nope\n');
  return {
    name: 'Fixture', slug: 'fixture', aliases: ['fixture project'], repository: dir, stack: ['ts'], objective: 'test',
    importantDirectories: ['src'], keyFiles: ['src/index.ts'], docs: ['README.md'],
    commands: { test: 'true', typecheck: 'true' },
    allowedCommands: ['true', 'false', 'echo', 'git status'], knownBlockers: [], architectureNotes: '', agentInstructions: 'none',
    ...overrides,
  };
}

export function tmpStore(): Store {
  return new Store(mkdtempSync(join(tmpdir(), 'adamos-data-')));
}

export interface FakeOptions {
  tier?: Tier;
  promptCharBudget?: number;
  pricing?: { input: number; output: number } | null;
  rpd?: number | null;
  toolCalling?: boolean;
}

/** Scripted provider: returns responses in order; records requests; declares its own capability row. */
export class FakeProvider implements Provider {
  id: string;
  mode = 'chat' as const;
  script: Array<ChatResponse | Error>;
  requests: ChatRequest[] = [];
  opts: Required<FakeOptions>;
  constructor(script: Array<Partial<ChatResponse> | Error>, id = 'fake', tierOrOpts: Tier | FakeOptions = 'standard') {
    this.id = id;
    const o = typeof tierOrOpts === 'string' ? { tier: tierOrOpts } : tierOrOpts;
    this.opts = { tier: o.tier ?? 'standard', promptCharBudget: o.promptCharBudget ?? 400_000, pricing: o.pricing === undefined ? null : o.pricing, rpd: o.rpd === undefined ? null : o.rpd, toolCalling: o.toolCalling ?? true };
    this.script = script.map((s) => (s instanceof Error ? s : { text: '', toolCalls: [], usage: { input: 100, output: 20, reasoning: 0, cacheRead: 0 }, providerCostUsd: null, finishReason: 'stop', ...s }));
  }
  models(): ModelInfo[] { return [{ id: 'fake-model', provider: this.id, tier: this.opts.tier, promptCharBudget: this.opts.promptCharBudget, supportsTools: this.opts.toolCalling, dailyRequestCap: this.opts.rpd ?? undefined }]; }
  capabilities(): ModelCapabilities[] {
    return [{
      provider: this.id, model: 'fake-model', key: `${this.id}/fake-model`, tier: this.opts.tier, mode: 'chat',
      contextTokens: limit(1_000_000, 'documented'), maxOutputTokens: limit(8_192, 'documented'),
      toolCalling: this.opts.toolCalling, structuredOutput: true,
      pricing: this.opts.pricing ? { ...this.opts.pricing, source: 'documented' } : null,
      rpm: unknown(), tpm: unknown(), rpd: limit(this.opts.rpd, this.opts.rpd === null ? 'unknown' : 'observed'), tpd: unknown(),
      promptCharBudget: limit(this.opts.promptCharBudget, 'observed'), minIntervalMs: 0,
    }];
  }
  async health(): Promise<ProviderHealth> { return { ok: true, detail: 'ok', checkedAt: new Date().toISOString() }; }
  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.requests.push({ ...req, messages: req.messages.map((m) => ({ ...m })) });
    const next = this.script.shift();
    if (!next) return { text: 'out of script', toolCalls: [], usage: null, providerCostUsd: null, finishReason: 'stop' };
    if (next instanceof Error) throw next;
    return next;
  }
}

/** A registry over fake providers with an in-memory ledger; real preflight runs against their declared capabilities. */
export function registryWith(...providers: Provider[]): ProviderRegistry {
  const r = new ProviderRegistry(providers, mkdtempSync(join(tmpdir(), 'adamos-health-')), new ProviderLedger());
  for (const p of providers) r.healthCache[p.id] = { ok: true, detail: 'ok', checkedAt: new Date().toISOString() };
  return r;
}

export const finishCall = (args: Record<string, unknown>) => ({ toolCalls: [{ id: 'c1', name: 'finish', args: { status: 'done', summary: 'ok', ...args } }] });

/** A fixture project that is a real git repo, so workspaceFingerprint() can see changes. */
export function tmpGitProject(overrides: Partial<Project> = {}): Project {
  const p = tmpProject(overrides);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: p.repository, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'fixture@example.test');
  git('config', 'user.name', 'Fixture');
  git('add', '-A');
  git('commit', '-qm', 'init');
  return p;
}

/** A delegated provider (the claude-cli shape) whose results and side effects are scripted. */
export class FakeDelegatedProvider implements Provider {
  id: string;
  mode = 'delegated' as const;
  script: DelegatedResult[];
  runs: DelegatedRun[] = [];
  /** Side effect to simulate the agent editing the workspace before it stopped. */
  onRun?: (run: DelegatedRun, index: number) => void;
  constructor(script: Array<Partial<DelegatedResult>>, id = 'fake-cli', onRun?: (run: DelegatedRun, index: number) => void) {
    this.id = id;
    this.onRun = onRun;
    this.script = script.map((r) => ({ text: '', usage: { input: 1000, output: 200, reasoning: 0, cacheRead: 0 }, providerCostUsd: 0.5, numTurns: 3, isError: false, ...r }));
  }
  models(): ModelInfo[] { return [{ id: 'fake-cli-model', provider: this.id, tier: 'light', promptCharBudget: 400_000, supportsTools: true }]; }
  capabilities(): ModelCapabilities[] {
    return [{
      provider: this.id, model: 'fake-cli-model', key: `${this.id}/fake-cli-model`, tier: 'light', mode: 'delegated',
      contextTokens: limit(200_000, 'documented'), maxOutputTokens: unknown(), toolCalling: true, structuredOutput: false,
      pricing: null, rpm: unknown(), tpm: unknown(), rpd: unknown(), tpd: unknown(),
      promptCharBudget: limit(400_000, 'documented'), minIntervalMs: 0,
    }];
  }
  async health(): Promise<ProviderHealth> { return { ok: true, detail: 'ok', checkedAt: new Date().toISOString() }; }
  async chat(_req: ChatRequest): Promise<ChatResponse> { throw new Error('delegated provider: use runDelegated'); }
  async runDelegated(run: DelegatedRun): Promise<DelegatedResult> {
    const i = this.runs.length;
    this.runs.push(run);
    this.onRun?.(run, i);
    return this.script.shift() ?? { text: 'out of script', usage: null, providerCostUsd: null, numTurns: 0, isError: false };
  }
}
