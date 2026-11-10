import assert from 'node:assert/strict';
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { LABEL, cleanPath, renderPlist } from '../src/dashboard/autostart.ts';
import { FocusStore } from '../src/dashboard/focus.ts';
import { checkRequest, createDashboardServer } from '../src/dashboard/server.ts';
import type { TaskRecord } from '../src/types.ts';
import { FakeProvider, registryWith, tmpGitProject, tmpStore } from './helpers.ts';

const DAY = 86_400_000;

async function withServer(fn: (ctx: { base: string; launched: TaskRecord[]; store: ReturnType<typeof tmpStore> }) => Promise<void>): Promise<void> {
  const store = tmpStore();
  const project = tmpGitProject();
  const launched: TaskRecord[] = [];
  const server: Server = createDashboardServer({
    store, dataDir: store.dir, projects: [project], autoProbe: false,
    makeRegistry: () => registryWith(new FakeProvider([], 'fake', 'light')),
    launch: (task) => { launched.push(task); },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try { await fn({ base, launched, store }); } finally { await new Promise((r) => server.close(r)); }
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('dashboard serves the page and a state snapshot', async () => {
  await withServer(async ({ base }) => {
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>AdamOS<\/title>/);
    for (const asset of ['/app.js', '/styles.css']) assert.equal((await fetch(base + asset)).status, 200);

    const state = await (await fetch(`${base}/api/state`)).json() as Record<string, any>;
    assert.deepEqual(state.active, []);
    assert.equal(state.projects[0].slug, 'fixture');
    assert.equal(state.capacity.models[0].key, 'fake/fake-model');
    assert.equal(state.capacity.tiers.light, 'fake/fake-model');
    assert.equal(state.analytics.totalTasks, 0);
  });
});

test('dashboard refuses cross-origin writes, non-JSON writes and foreign hosts', async () => {
  await withServer(async ({ base, launched }) => {
    const body = { description: 'fix the greeting in the fixture project' };
    assert.equal((await post(`${base}/api/tasks`, body, { origin: 'http://evil.example' })).status, 403);
    assert.equal((await fetch(`${base}/api/tasks`, { method: 'POST', body: JSON.stringify(body) })).status, 403);
    assert.equal(launched.length, 0);
  });
  // fetch() will not send a forged Host header, so the guard is checked directly for the DNS-rebinding case.
  const req = (method: string, headers: Record<string, string>) => ({ method, headers }) as unknown as IncomingMessage;
  assert.match(checkRequest(req('GET', { host: 'evil.example:4646' })) ?? '', /localhost/);
  assert.equal(checkRequest(req('GET', { host: 'localhost:4646' })), undefined);
  assert.equal(checkRequest(req('POST', { host: '127.0.0.1:4646', origin: 'http://127.0.0.1:4646', 'content-type': 'application/json' })), undefined);
  assert.match(checkRequest(req('POST', { host: 'localhost:4646', origin: 'http://localhost:9999', 'content-type': 'application/json' })) ?? '', /cross-origin/);
});

test('route preview decides without saving; run saves the task and launches it once', async () => {
  await withServer(async ({ base, launched, store }) => {
    const body = { description: 'fix the greeting in the fixture project', budget: 1.5, maxCalls: 5 };
    const preview = await (await post(`${base}/api/route`, body)).json() as Record<string, any>;
    assert.equal(preview.project.slug, 'fixture');
    assert.equal(preview.budget.maxCostUsd, 1.5);
    assert.ok(preview.workflow.steps.length > 0);
    assert.equal(store.listTasks().length, 0);

    const run = await post(`${base}/api/tasks`, body);
    assert.equal(run.status, 201);
    const { id } = await run.json() as { id: string };
    assert.equal(launched.length, 1);
    assert.equal(launched[0].id, id);
    assert.equal(store.loadTask(id)?.budget.maxAgentCalls, 5);

    const state = await (await fetch(`${base}/api/state`)).json() as Record<string, any>;
    assert.equal(state.active.length, 1);
    assert.equal(state.active[0].steps, undefined, 'summaries leave the step records out');
    assert.ok(state.active[0].pipeline.every((s: { state: string }) => s.state === 'pending'));

    assert.equal((await post(`${base}/api/tasks/${id}/control`, { action: 'pause' })).status, 200);
    assert.equal(store.readControl(id), 'pause');
    assert.equal((await post(`${base}/api/tasks/${id}/control`, { action: 'explode' })).status, 400);
  });
});

test('bad task input is a 400 with a reason, and nothing is launched', async () => {
  await withServer(async ({ base, launched }) => {
    const empty = await post(`${base}/api/tasks`, { description: '   ' });
    assert.equal(empty.status, 400);
    const unknown = await post(`${base}/api/tasks`, { description: 'do something', project: 'nope' });
    assert.equal(unknown.status, 400);
    assert.match(((await unknown.json()) as { error: string }).error, /unknown project/);
    assert.equal((await post(`${base}/api/tasks`, { description: 'fix the fixture project', budget: -1 })).status, 400);
    assert.equal(launched.length, 0);
  });
});

test('stopping a task whose process is gone closes the record', async () => {
  await withServer(async ({ base, store }) => {
    const { id } = await (await post(`${base}/api/tasks`, { description: 'fix the greeting in the fixture project' })).json() as { id: string };
    const task = store.loadTask(id)!;
    task.pid = 2 ** 22 + 12345; // beyond the default pid range: no such process
    task.status = 'implementing';
    store.saveTask(task);

    const state = await (await fetch(`${base}/api/state`)).json() as Record<string, any>;
    assert.equal(state.active[0].orphaned, true);
    assert.equal((await post(`${base}/api/tasks/${id}/control`, { action: 'stop' })).status, 200);
    assert.equal(store.loadTask(id)?.outcome, 'stopped');
    assert.equal((await post(`${base}/api/tasks/${id}/control`, { action: 'stop' })).status, 409);
  });
});

test('brief endpoint scans without running tests; the test run happens in the background', async () => {
  await withServer(async ({ base }) => {
    const first = await (await fetch(`${base}/api/brief`)).json() as Record<string, any>;
    assert.equal(first.running, false);
    assert.equal(first.brief.tests, 'cached');
    assert.equal(first.brief.scans[0].slug, 'fixture');
    assert.equal(first.brief.scans[0].tests, undefined, 'nothing cached yet, and a fast scan never executes the test command');

    assert.equal((await post(`${base}/api/brief/run`, {})).status, 202);
    let r = first;
    for (let i = 0; i < 100 && (r.running || r.brief.tests !== 'run'); i++) {
      await new Promise((done) => setTimeout(done, 50));
      r = await (await fetch(`${base}/api/brief`)).json() as Record<string, any>;
    }
    assert.equal(r.brief.tests, 'run');
    assert.equal(r.brief.scans[0].tests.status, 'pass');

    const cached = await (await fetch(`${base}/api/brief?refresh=1`)).json() as Record<string, any>;
    assert.equal(cached.brief.tests, 'cached');
    assert.equal(cached.brief.scans[0].tests.status, 'pass', 'the fast scan reuses the result cached for the unchanged tree');
    assert.equal(cached.brief.scans[0].tests.cached, true);
  });
});

test('focus list: pinning is idempotent, done items drop off the next day, open items carry over', () => {
  const store = tmpStore();
  const focus = new FocusStore(store.dir);
  const now = new Date(2026, 10, 10, 9).getTime();
  const a = focus.add({ text: 'Ask Adam: fix tests', project: 'ask-adam', source: 'ask-adam:failing_tests' }, now);
  assert.equal(focus.add({ text: 'again', source: 'ask-adam:failing_tests' }, now).id, a.id);
  const b = focus.add({ text: 'write the README' }, now);
  assert.throws(() => focus.add({ text: '   ' }, now));

  focus.update(b.id, { done: true }, now + 3_600_000);
  assert.deepEqual(focus.list(now + 2 * 3_600_000).map((i) => [i.text, i.done]), [['Ask Adam: fix tests', false], ['write the README', true]]);
  assert.deepEqual(focus.list(now + DAY).map((i) => i.text), ['Ask Adam: fix tests']);

  // Once the pinned item is done, the same brief candidate can be pinned again.
  focus.update(a.id, { done: true }, now + DAY);
  assert.notEqual(focus.add({ text: 'Ask Adam: fix tests', source: 'ask-adam:failing_tests' }, now + DAY).id, a.id);
  assert.equal(focus.remove('missing'), false);
});

test('focus endpoints add, complete and remove items', async () => {
  await withServer(async ({ base }) => {
    const added = await (await post(`${base}/api/focus`, { text: 'ship the dashboard' })).json() as { items: Array<{ id: string; done: boolean }> };
    assert.equal(added.items.length, 1);
    const { id } = added.items[0];
    const done = await (await post(`${base}/api/focus/${id}`, { done: true })).json() as { items: Array<{ done: boolean }> };
    assert.equal(done.items[0].done, true);
    const removed = await fetch(`${base}/api/focus/${id}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.deepEqual(((await removed.json()) as { items: unknown[] }).items, []);
    assert.equal((await post(`${base}/api/focus`, { text: '' })).status, 400);
  });
});

test('autostart plist runs the dashboard command with the captured node and PATH, escaped for XML', () => {
  const plist = renderPlist({ port: 4700, node: '/opt/node/bin/node', root: '/Users/me/R&D/AdamOS', path: '/opt/node/bin:/usr/bin', logPath: '/Users/me/R&D/AdamOS/data/logs/dashboard.log' });
  assert.ok(plist.includes(`<string>${LABEL}</string>`));
  const args = [...plist.split('<key>ProgramArguments</key>')[1].split('</array>')[0].matchAll(/<string>(.*?)<\/string>/g)].map((m) => m[1]);
  assert.deepEqual(args, ['/opt/node/bin/node', '/Users/me/R&amp;D/AdamOS/src/cli.ts', 'dashboard', '--port', '4700']);
  assert.ok(plist.includes('<key>WorkingDirectory</key>\n  <string>/Users/me/R&amp;D/AdamOS</string>'));
  assert.ok(plist.includes('<key>PATH</key>\n    <string>/opt/node/bin:/usr/bin</string>'));
  assert.ok(plist.includes('<key>RunAtLoad</key>\n  <true/>'));
  assert.ok(!plist.includes('--open'), 'logging in should not pop a browser window');
});

test('cleanPath keeps existing directories once, in order', () => {
  const exists = (d: string) => d !== '/gone';
  assert.equal(cleanPath('/a:/b:/a::/gone:/c', exists), '/a:/b:/c');
});
