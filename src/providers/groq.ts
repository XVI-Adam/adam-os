import { getSecret } from '../config.ts';
import { capabilitiesOf, toModelInfo } from './capabilities.ts';
import type { TokenUsage } from '../types.ts';
import { ProviderError, fetchOrThrow, parseArgs, parseRetryAfter, throttle, withRetry, type ChatRequest, type ChatResponse, type ModelInfo, type Provider, type ProviderHealth } from './types.ts';

const URL = 'https://api.groq.com/openai/v1/chat/completions';

// Groq free tier: 8k tokens/minute on gpt-oss-20b, 1000 req/day, 200k tokens/day
// shared across models. Only light-tier work belongs here; the Ask Adam eval
// harness needs the daily budget.
const MODELS: ModelInfo[] = capabilitiesOf('groq').map(toModelInfo);

/** 429/5xx retry; so do gpt-oss's malformed tool-call 400s (sampling noise). 413 (prompt over the TPM cap) and other 4xx do not. */
export function isRetryableGroqError(status: number, body: string): boolean {
  if (status === 429 || status >= 500) return true;
  if (status === 400 && /tool_use_failed|output_parse_failed/.test(body)) return true;
  return false;
}

export class GroqProvider implements Provider {
  id = 'groq';
  mode = 'chat' as const;
  models(): ModelInfo[] { return MODELS; }

  async health(): Promise<ProviderHealth> {
    const key = getSecret('GROQ_API_KEY');
    const checkedAt = new Date().toISOString();
    if (!key) return { ok: false, detail: 'GROQ_API_KEY not found', checkedAt };
    try {
      const r = await fetch('https://api.groq.com/openai/v1/models', { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
      if (!r.ok) return { ok: false, detail: `models endpoint returned ${r.status}`, checkedAt };
      const ids = new Set(((await r.json()) as { data: Array<{ id: string }> }).data.map((m) => m.id));
      const missing = MODELS.filter((m) => !ids.has(m.id)).map((m) => m.id);
      return { ok: true, detail: missing.length ? `ok; missing models: ${missing.join(', ')}` : 'ok', checkedAt };
    } catch (e) {
      return { ok: false, detail: `unreachable: ${(e as Error).message}`, checkedAt };
    }
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const key = getSecret('GROQ_API_KEY');
    if (!key) throw new ProviderError('GROQ_API_KEY not found');
    const messages = req.messages.map((m) => {
      if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
      if (m.role === 'assistant' && m.toolCalls?.length) {
        return { role: 'assistant', content: m.content || null, tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.rawArgs ?? JSON.stringify(c.args) } })) };
      }
      return { role: m.role, content: m.content };
    });
    const body: Record<string, unknown> = {
      model: req.model,
      messages,
      max_tokens: req.maxTokens ?? 2048,
      temperature: req.temperature ?? 0.2,
      stream: false,
    };
    if (req.model.startsWith('openai/gpt-oss')) { body.reasoning_format = 'hidden'; body.reasoning_effort = 'low'; }
    if (req.tools?.length) body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    if (req.jsonMode) body.response_format = { type: 'json_object' };

    const info = MODELS.find((m) => m.id === req.model);
    return withRetry(async () => {
      await throttle(`groq/${req.model}`, info?.minIntervalMs);
      const r = await fetchOrThrow(URL, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
      if (!r.ok) {
        const text = await r.text();
        // 413 = the prompt itself exceeds the per-minute token cap; retrying cannot help.
        // gpt-oss on Groq sometimes emits a malformed tool call ("commentary" channel leak) or unparseable
        // output; that is sampling noise, so those 400s are retried like a 5xx rather than failing the step.
        throw new ProviderError(`groq ${r.status}: ${text.replace(/\s+/g, " ").slice(0, 700)}`, r.status, isRetryableGroqError(r.status, text), parseRetryAfter(r.headers.get("retry-after"), text));
      }
      const data = (await r.json()) as {
        choices: Array<{ message: { content: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }; finish_reason: string }>;
        usage?: { prompt_tokens: number; completion_tokens: number; completion_tokens_details?: { reasoning_tokens?: number } };
      };
      const choice = data.choices?.[0];
      if (!choice) throw new ProviderError('groq returned no choices');
      const toolCalls = (choice.message.tool_calls ?? []).map((c) => {
        const parsed = parseArgs(c.function.arguments);
        return { id: c.id, name: c.function.name, args: parsed.error ? { __error: parsed.error } : parsed.args, rawArgs: c.function.arguments };
      });
      const usage: TokenUsage | null = data.usage
        ? { input: data.usage.prompt_tokens, output: data.usage.completion_tokens, reasoning: data.usage.completion_tokens_details?.reasoning_tokens ?? 0, cacheRead: 0 }
        : null;
      return { text: choice.message.content ?? '', toolCalls, usage, providerCostUsd: null, finishReason: choice.finish_reason };
    });
  }
}
