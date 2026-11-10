// List prices in USD per 1M tokens. These produce ESTIMATES only.
// null means "price unknown here" and must surface as cost basis 'unavailable',
// never as $0. Free tiers (Groq free, Gemini free, Claude Pro subscription) bill
// $0 marginal but still consume quota; the estimate shows what the usage would
// cost at list price so tasks can be compared.
export interface Price { input: number; output: number; note?: string }

export const PRICING: Record<string, Price | null> = {
  // Groq (published pay-as-you-go rates)
  'openai/gpt-oss-20b': { input: 0.10, output: 0.50 },
  'openai/gpt-oss-120b': { input: 0.15, output: 0.75 },
  'qwen/qwen3.8-27b': null,
  'groq/compound': null,
  'groq/compound-mini': null,
  // Gemini (paid-tier list prices; the key in use may be on the free tier)
  'gemini-2.5-flash': { input: 0.30, output: 2.50 },
  'gemini-2.5-flash-lite': { input: 0.10, output: 0.40 },
  'gemini-2.5-pro': { input: 1.25, output: 10.0, note: 'prompts <= 200k tokens' },
  'gemini-3-flash-preview': null,
  'gemini-3.1-pro-preview': null,
  'gemini-3.1-flash-lite': null,
  // Claude via CLI: the CLI reports total_cost_usd itself, recorded as provider_reported.
  'claude-haiku-4-5-20251001': { input: 1.0, output: 5.0 },
  'claude-sonnet-5': null,
  'claude-opus-5': null,
};

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const p = PRICING[model];
  if (!p) return null;
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}
