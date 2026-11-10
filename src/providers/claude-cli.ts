import { spawn } from 'node:child_process';
import { capabilitiesOf, toModelInfo } from './capabilities.ts';
import type { TokenUsage } from '../types.ts';
import { ProviderError, type ChatRequest, type ChatResponse, type DelegatedResult, type DelegatedRun, type ModelInfo, type Provider, type ProviderHealth } from './types.ts';

// Delegated provider: `claude -p` runs its own agentic loop with its own tools.
// We pass the prompt, cwd, permissions and a dollar cap, and read back the
// JSON envelope, which carries provider-reported usage and total_cost_usd.
// The CLI cannot be launched inside another Claude Code session unless
// CLAUDECODE is unset, and it needs a valid OAuth token (claude auth login).

const MODELS: ModelInfo[] = capabilitiesOf('claude-cli').map(toModelInfo);

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
}

function runCli(args: string[], cwd: string, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolvePromise) => {
    const child = spawn('claude', args, { cwd, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let timedOut = false;
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolvePromise({ code, stdout, stderr, timedOut }); });
    child.on('error', (err) => { clearTimeout(timer); resolvePromise({ code: null, stdout, stderr: stderr + err.message, timedOut }); });
  });
}

export class ClaudeCliProvider implements Provider {
  id = 'claude-cli';
  mode = 'delegated' as const;
  models(): ModelInfo[] { return MODELS; }

  async health(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    const r = await runCli(['-p', 'Reply with exactly OK', '--model', 'haiku', '--output-format', 'json', '--tools', '', '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'], process.cwd(), 30_000);
    if (r.timedOut) return { ok: false, detail: 'probe timed out after 30s — the CLI is retrying an invalid OAuth token; run `claude auth login` in a terminal', checkedAt };
    if (r.stderr.includes('cannot be launched inside another')) return { ok: false, detail: 'nested session guard tripped', checkedAt };
    if (r.code !== 0) return { ok: false, detail: `exit ${r.code}: ${(r.stderr || r.stdout).slice(0, 160)}`, checkedAt };
    try {
      const j = JSON.parse(r.stdout) as { is_error?: boolean; result?: string };
      return j.is_error ? { ok: false, detail: `cli error: ${String(j.result).slice(0, 160)}`, checkedAt } : { ok: true, detail: 'ok', checkedAt };
    } catch {
      return { ok: false, detail: 'unparseable CLI output', checkedAt };
    }
  }

  async chat(_req: ChatRequest): Promise<ChatResponse> {
    throw new ProviderError('claude-cli is a delegated provider; use runDelegated()');
  }

  async runDelegated(run: DelegatedRun): Promise<DelegatedResult> {
    const args = [
      '-p', run.prompt,
      '--model', run.model,
      '--output-format', 'json',
      '--append-system-prompt', run.systemPrompt,
      '--no-session-persistence',
      '--setting-sources', '',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--max-budget-usd', String(run.maxBudgetUsd),
      '--permission-mode', run.allowWrite ? 'acceptEdits' : 'plan',
      '--tools', run.allowWrite ? 'Read,Edit,Write,Bash,Grep,Glob' : 'Read,Grep,Glob,Bash',
    ];
    const r = await runCli(args, run.cwd, run.timeoutMs);
    if (r.timedOut) return { text: '', usage: null, providerCostUsd: null, numTurns: 0, isError: true, error: 'claude-cli timed out' };
    try {
      const j = JSON.parse(r.stdout) as {
        result?: string; is_error?: boolean; num_turns?: number; total_cost_usd?: number; subtype?: string;
        usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
      };
      const usage: TokenUsage | null = j.usage
        ? { input: (j.usage.input_tokens ?? 0) + (j.usage.cache_creation_input_tokens ?? 0), output: j.usage.output_tokens ?? 0, reasoning: 0, cacheRead: j.usage.cache_read_input_tokens ?? 0 }
        : null;
      const cost = typeof j.total_cost_usd === 'number' ? j.total_cost_usd : null;
      const text = j.result ?? '';
      // Two independent signals, because the envelope's wording is not contractual:
      // an explicit budget/limit subtype, or a spend that reached the cap we set.
      const budgetStopped =
        /budget|max_?cost|usage_?limit|limit_reached/i.test(j.subtype ?? '') ||
        /budget|spend limit|usage limit/i.test(text) ||
        (cost !== null && cost >= run.maxBudgetUsd);
      // An error envelope with an empty result used to surface as the literal
      // string "undefined" in the logs. Always produce something actionable.
      const error = j.is_error
        ? (text.trim() || `claude-cli reported an error with no message (subtype ${j.subtype ?? 'unknown'}, exit ${r.code})`)
        : undefined;
      return { text, usage, providerCostUsd: cost, numTurns: j.num_turns ?? 0, isError: Boolean(j.is_error), error, budgetStopped, subtype: j.subtype };
    } catch {
      return { text: '', usage: null, providerCostUsd: null, numTurns: 0, isError: true, error: `unparseable CLI output (exit ${r.code}): ${(r.stderr || r.stdout).slice(0, 300)}` };
    }
  }
}
