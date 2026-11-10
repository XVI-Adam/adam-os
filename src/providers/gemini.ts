import { getSecret } from '../config.ts';
import { capabilitiesOf, toModelInfo } from './capabilities.ts';
import type { TokenUsage } from '../types.ts';
import { ProviderError, fetchOrThrow, parseRetryAfter, throttle, withRetry, type ChatMessage, type ChatRequest, type ChatResponse, type ModelInfo, type Provider, type ProviderHealth } from './types.ts';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const MODELS: ModelInfo[] = capabilitiesOf('gemini').map(toModelInfo);

type Part = Record<string, unknown>;

function toContents(messages: ChatMessage[]): { system?: string; contents: Array<{ role: string; parts: Part[] }> } {
  let system: string | undefined;
  const contents: Array<{ role: string; parts: Part[] }> = [];
  for (const m of messages) {
    if (m.role === 'system') { system = (system ? system + '\n\n' : '') + m.content; continue; }
    if (m.role === 'tool') {
      const part = { functionResponse: { name: m.toolName ?? 'tool', response: { result: m.content } } };
      const last = contents[contents.length - 1];
      if (last && last.role === 'user' && 'functionResponse' in (last.parts[0] ?? {})) last.parts.push(part);
      else contents.push({ role: 'user', parts: [part] });
      continue;
    }
    if (m.role === 'assistant') {
      if (m.rawParts?.length) { contents.push({ role: 'model', parts: m.rawParts as Part[] }); continue; }
      const parts: Part[] = [];
      if (m.content) parts.push({ text: m.content });
      for (const c of m.toolCalls ?? []) parts.push({ functionCall: { name: c.name, args: c.args } });
      contents.push({ role: 'model', parts: parts.length ? parts : [{ text: '' }] });
      continue;
    }
    contents.push({ role: 'user', parts: [{ text: m.content }] });
  }
  return { system, contents };
}

export class GeminiProvider implements Provider {
  id = 'gemini';
  mode = 'chat' as const;
  models(): ModelInfo[] { return MODELS; }

  async health(): Promise<ProviderHealth> {
    const key = getSecret('GEMINI_API_KEY');
    const checkedAt = new Date().toISOString();
    if (!key) return { ok: false, detail: 'GEMINI_API_KEY not found', checkedAt };
    try {
      // GET /models validates the key without spending a generate request (the daily cap is only 20 per model).
      const r = await fetch(`${BASE}?pageSize=1`, { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(20_000) });
      if (!r.ok) return { ok: false, detail: `models endpoint returned ${r.status}: ${(await r.text()).slice(0, 120)}`, checkedAt };
      return { ok: true, detail: 'ok (key valid; per-model daily caps tracked in data/quota)', checkedAt };
    } catch (e) {
      return { ok: false, detail: `unreachable: ${(e as Error).message}`, checkedAt };
    }
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const key = getSecret('GEMINI_API_KEY');
    if (!key) throw new ProviderError('GEMINI_API_KEY not found');
    const { system, contents } = toContents(req.messages);
    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        maxOutputTokens: req.maxTokens ?? 4096,
        temperature: req.temperature ?? 0.2,
        ...(req.jsonMode ? { responseMimeType: 'application/json' } : {}),
      },
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (req.tools?.length) {
      body.tools = [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
      body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
    }
    const info = MODELS.find((m) => m.id === req.model);
    return withRetry(async () => {
      await throttle(`gemini/${req.model}`, info?.minIntervalMs);
      const r = await fetchOrThrow(`${BASE}/${req.model}:generateContent`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body), signal: AbortSignal.timeout(180_000),
      });
      if (!r.ok) {
        const text = await r.text();
        throw new ProviderError(`gemini ${r.status}: ${text.replace(/\s+/g, " ").slice(0, 700)}`, r.status, r.status === 429 || r.status >= 500, parseRetryAfter(r.headers.get("retry-after"), text));
      }
      const data = (await r.json()) as {
        candidates?: Array<{ content?: { parts?: Part[] }; finishReason?: string }>;
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; cachedContentTokenCount?: number };
        promptFeedback?: { blockReason?: string };
      };
      const cand = data.candidates?.[0];
      if (!cand) throw new ProviderError(`gemini returned no candidates${data.promptFeedback?.blockReason ? ` (blocked: ${data.promptFeedback.blockReason})` : ''}`);
      const parts = cand.content?.parts ?? [];
      let text = '';
      const toolCalls = [] as ChatResponse['toolCalls'];
      let n = 0;
      for (const p of parts) {
        if (typeof p.text === 'string' && !p.thought) text += p.text;
        const fc = p.functionCall as { name: string; args?: Record<string, unknown> } | undefined;
        if (fc) toolCalls.push({ id: `call_${Date.now().toString(36)}_${n++}`, name: fc.name, args: fc.args ?? {} });
      }
      const u = data.usageMetadata;
      const usage: TokenUsage | null = u
        ? { input: u.promptTokenCount ?? 0, output: u.candidatesTokenCount ?? 0, reasoning: u.thoughtsTokenCount ?? 0, cacheRead: u.cachedContentTokenCount ?? 0 }
        : null;
      return { text, toolCalls, usage, providerCostUsd: null, finishReason: cand.finishReason ?? 'unknown', rawParts: parts };
    });
  }
}
