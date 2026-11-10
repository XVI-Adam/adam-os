import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HISTORY_CHAR_BUDGET, pruneHistory, runAgent } from '../src/agents/index.ts';
import { BudgetManager } from '../src/budget.ts';
import { buildContext } from '../src/context/manager.ts';
import { ProviderError, type ChatMessage } from '../src/providers/types.ts';
import { ProviderRegistry } from '../src/providers/index.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeProvider, registryWith, tmpProject } from './helpers.ts';

const budget = () => new BudgetManager({ maxCostUsd: 5, maxAgentCalls: 50, maxRetries: 1, maxToolCalls: 100, maxWallClockMs: 60_000 });

function input(project = tmpProject()) {
  return { role: 'research' as const, goal: 'look around', taskDescription: 'inspect', project, tier: 'light' as const, context: buildContext({ project, task: 'inspect greet', role: 'research', tier: 'light', priorSteps: [], failures: [] }), budget: budget() };
}

test('pruneHistory elides older tool outputs once the history exceeds the budget, keeping recent ones', () => {
  const big = 'x'.repeat(30_000);
  const messages: ChatMessage[] = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }];
  for (let i = 0; i < 6; i++) { messages.push({ role: 'assistant', content: '', toolCalls: [{ id: `c${i}`, name: 'read_file', args: {} }] }); messages.push({ role: 'tool', content: `file ${i}\n${big}`, toolCallId: `c${i}`, toolName: 'read_file' }); }
  const before = messages.reduce((a, m) => a + m.content.length, 0);
  assert.ok(before > HISTORY_CHAR_BUDGET);
  const pruned = pruneHistory(messages);
  assert.ok(pruned >= 1);
  const after = messages.reduce((a, m) => a + m.content.length, 0);
  assert.ok(after < before);
  const tools = messages.filter((m) => m.role === 'tool');
  assert.ok(tools[0].content.startsWith('[elided'), 'oldest is elided');
  assert.ok(tools[tools.length - 1].content.startsWith('file 5'), 'most recent kept verbatim');
  assert.equal(pruneHistory([{ role: 'user', content: 'small' }]), 0);
});

test('final turn offers only finish; a text-only final reply is accepted as the summary', async () => {
  // research maxSteps = 8: seven tool turns, then a forced finish turn.
  const script = Array.from({ length: 7 }, (_, i) => ({ toolCalls: [{ id: `c${i}`, name: 'list_files', args: { dir: '.' } }] }));
  script.push({ text: 'Here is what I found.', toolCalls: [] } as never);
  const fake = new FakeProvider(script);
  const out = await runAgent({ ...input(), registry: registryWith(fake) });
  assert.equal(out.status, 'done');
  assert.equal(out.summary, 'Here is what I found.');
  const last = fake.requests[fake.requests.length - 1];
  assert.deepEqual(last.tools?.map((t) => t.name), ['finish']);
  // The request holds the live message array, so look for the nudge anywhere rather than at the tail.
  assert.ok(last.messages.some((m) => m.role === 'user' && /final turn/.test(m.content)));
});

test('retryable provider failure mid-step switches model in place and keeps the conversation', async () => {
  const flaky = new FakeProvider([{ toolCalls: [{ id: 'a', name: 'list_files', args: { dir: '.' } }] }, new ProviderError('overloaded', 503, true)], 'a-flaky', 'light');
  const steady = new FakeProvider([{ toolCalls: [{ id: 'f', name: 'finish', args: { status: 'done', summary: 'recovered' } }] }], 'b-steady', 'light');
  const registry = registryWith(flaky, steady);
  const out = await runAgent({ ...input(), registry });
  assert.equal(out.status, 'done');
  assert.equal(out.summary, 'recovered');
  assert.equal(out.provider, 'b-steady');
  assert.deepEqual(out.fallbacks, ['a-flaky/fake-model']);
  void ProviderRegistry; void mkdtempSync; void tmpdir; void join;
  // The steady provider saw the earlier tool exchange, not a fresh conversation.
  assert.ok(steady.requests[0].messages.some((m) => m.role === 'tool'));
  assert.equal(out.toolCalls.length, 1);
});

test('tool outputs are capped before entering the history', async () => {
  const project = tmpProject();
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(project.repository, 'src', 'huge.ts'), 'y\n'.repeat(20_000));
  const fake = new FakeProvider([{ toolCalls: [{ id: 'r', name: 'read_file', args: { path: 'src/huge.ts' } }] }, { toolCalls: [{ id: 'f', name: 'finish', args: { status: 'done', summary: 'ok' } }] }]);
  await runAgent({ ...input(project), registry: registryWith(fake) });
  const toolMsg = fake.requests[1].messages.find((m) => m.role === 'tool')!;
  assert.ok(toolMsg.content.length <= 12_200);
  assert.match(toolMsg.content, /more chars; narrow the request/);
});
