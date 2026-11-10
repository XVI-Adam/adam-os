import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BudgetManager } from '../src/budget.ts';
import { BudgetExceededError, emptyUsage } from '../src/types.ts';

const budget = { maxCostUsd: 1, maxAgentCalls: 3, maxRetries: 2, maxToolCalls: 5, maxWallClockMs: 60_000 };

test('blocks model calls once max_agent_calls is reached', () => {
  const b = new BudgetManager(budget);
  b.recordModelCall('gemini-2.5-flash', { input: 10, output: 10, reasoning: 0, cacheRead: 0 });
  b.recordModelCall('gemini-2.5-flash', { input: 10, output: 10, reasoning: 0, cacheRead: 0 });
  b.recordModelCall('gemini-2.5-flash', { input: 10, output: 10, reasoning: 0, cacheRead: 0 });
  assert.throws(() => b.assertCanCall('model'), BudgetExceededError);
  assert.match(b.exceeded()!, /max_agent_calls/);
});

test('blocks on estimated cost and reports basis honestly', () => {
  const b = new BudgetManager({ ...budget, maxAgentCalls: 100 });
  b.recordModelCall('gemini-2.5-pro', { input: 1_000_000, output: 0, reasoning: 0, cacheRead: 0 }); // $1.25 est
  assert.equal(b.usage.costBasis, 'estimated');
  assert.throws(() => b.assertCanCall('model'), /max_cost_usd/);
});

test('unknown pricing yields unavailable basis, never $0', () => {
  const b = new BudgetManager({ ...budget, maxAgentCalls: 100 });
  b.recordModelCall('qwen/qwen3.8-27b', { input: 5000, output: 500, reasoning: 0, cacheRead: 0 });
  assert.equal(b.usage.estimatedCostUsd, null);
  assert.equal(b.usage.costBasis, 'unavailable');
  assert.equal(b.usage.tokens.input, 5000);
});

test('calls without usage are counted and flip basis to mixed', () => {
  const b = new BudgetManager({ ...budget, maxAgentCalls: 100 });
  b.recordModelCall('gemini-2.5-flash', { input: 10, output: 10, reasoning: 0, cacheRead: 0 });
  b.recordModelCall('gemini-2.5-flash', null);
  assert.equal(b.usage.callsWithoutUsage, 1);
  assert.equal(b.usage.costBasis, 'mixed');
});

test('provider-reported cost is kept separately from the estimate', () => {
  const b = new BudgetManager({ ...budget, maxAgentCalls: 100 });
  b.recordModelCall('sonnet', { input: 100, output: 100, reasoning: 0, cacheRead: 0 }, 0.42);
  assert.equal(b.usage.providerReportedCostUsd, 0.42);
  assert.equal(b.usage.estimatedCostUsd, null);
  assert.equal(b.usage.costBasis, 'provider_reported');
});

test('tool calls and wall clock are hard limits', () => {
  const b = new BudgetManager({ ...budget, maxToolCalls: 1 });
  b.recordToolCall();
  assert.throws(() => b.assertCanCall('tool'), /max_tool_calls/);
  const old = new BudgetManager({ ...budget, maxWallClockMs: 1 }, emptyUsage(), Date.now() - 1000);
  assert.match(old.exceeded()!, /max_wall_clock/);
});

test('retry budget: attempt N may retry only while N <= maxRetries', () => {
  const b = new BudgetManager(budget);
  assert.equal(b.canRetry(1), true);
  assert.equal(b.canRetry(2), true);
  assert.equal(b.canRetry(3), false);
});
