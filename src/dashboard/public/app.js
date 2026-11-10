// AdamOS dashboard client. No build step, no dependencies. Every string that
// came from a task, a repo or a log is placed with textContent (via h()), so
// nothing an agent wrote can inject markup into this page.

const $ = (sel) => document.querySelector(sel);

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (typeof v === 'boolean') el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

/** Text with `backticked` spans rendered as <code>. */
function rich(text) {
  return String(text ?? '').split('`').map((part, i) => (i % 2 ? h('code', null, part) : part));
}

async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: {} };
  if (init.method !== 'GET') { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(opts.body ?? {}); }
  const res = await fetch(path, init);
  const isJson = (res.headers.get('content-type') || '').includes('json');
  const data = isJson ? await res.json() : await res.text();
  if (!res.ok) throw new Error((isJson && data.error) || `request failed (${res.status})`);
  return data;
}

// ---------- formatting ----------
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
function ago(ms, now = Date.now()) {
  if (!ms) return 'never';
  const d = Math.max(0, now - ms);
  if (d < MIN) return 'just now';
  if (d < HOUR) return `${Math.floor(d / MIN)}m ago`;
  if (d < DAY) return `${Math.floor(d / HOUR)}h ago`;
  const days = Math.floor(d / DAY);
  if (days < 14) return `${days}d ago`;
  if (days < 60) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${(days / 365).toFixed(1)}y ago`;
}
function dur(ms) {
  if (ms == null) return '–';
  if (ms < MIN) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < HOUR) return `${(ms / MIN).toFixed(1)}m`;
  return `${Math.floor(ms / HOUR)}h ${Math.round((ms % HOUR) / MIN)}m`;
}
// A missing price is "n/a", never $0: free tiers and unknown models are not the same thing as costing nothing.
const money = (n) => (n == null ? 'n/a' : n !== 0 && Math.abs(n) < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const pct = (x) => `${Math.round(x * 100)}%`;
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const BASIS = { estimated: 'estimated', provider_reported: 'reported', mixed: 'mixed', unavailable: '' };
function taskCost(usage) {
  const value = usage.providerReportedCostUsd ?? usage.estimatedCostUsd;
  return { value, text: value == null ? 'n/a' : `${money(value)}${BASIS[usage.costBasis] ? ` ${BASIS[usage.costBasis]}` : ''}` };
}

const OUTCOME = {
  success: ['good', 'Success'], partial: ['warning', 'Partial'], failed: ['critical', 'Failed'],
  budget_exhausted: ['serious', 'Budget hit'], stopped: ['neutral', 'Stopped'],
};
const status = (cls, label, title) => h('span', { class: `status ${cls}`, title }, label);

// ---------- state ----------
const S = {
  state: null, brief: null, briefRunning: false, briefRunningSince: null, briefError: null, focus: [],
  lastSync: 0, offline: false,
  openLogs: new Set(), logText: new Map(), openRows: new Set(), details: new Map(),
  rendered: new Map(),
};

/** Re-render a region only when its data actually changed, so open panels and scroll positions survive polling. */
function paint(key, data, fn) {
  const sig = JSON.stringify(data);
  if (S.rendered.get(key) === sig) return;
  S.rendered.set(key, sig);
  fn();
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

async function copy(text, what) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' }, text);
    document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  toast(`Copied ${what}`);
}

const projectBySlug = (slug) => S.state?.projects.find((p) => p.slug === slug);

// ---------- header ----------
function renderHeader() {
  const cap = S.state.capacity;
  paint('providers', [cap.providers, S.state.probing], () => {
    const chips = Object.entries(cap.providers).map(([id, p]) => h('span', { class: 'chip', title: `${p.detail} · checked ${ago(Date.parse(p.checkedAt))}` },
      status(p.ok ? 'good' : 'critical', id), h('span', { class: 'muted' }, p.ok ? 'ok' : 'down')));
    $('#providers').replaceChildren(...(chips.length ? chips : [h('span', { class: 'chip muted' }, 'providers not checked yet')]));
    const btn = $('#recheck');
    btn.disabled = S.state.probing;
    btn.textContent = S.state.probing ? 'Checking…' : 'Re-check';
  });
}

function tickSync() {
  const el = $('#sync');
  if (S.offline) el.textContent = 'server unreachable';
  else if (S.lastSync) el.textContent = `synced ${ago(S.lastSync).replace('just now', 'now')}`;
}

// ---------- brief ----------
const AGENT_KINDS = new Set(['failing_tests', 'tests_cannot_run', 'fixme', 'todo']);
const KIND = {
  failing_tests: 'tests failing', tests_cannot_run: 'tests broken', in_flight_branch: 'open branch', uncommitted: 'uncommitted work',
  stale_branches: 'stale branches', fixme: 'FIXME', todo: 'TODO', merged_branches: 'merged branches',
};
const sourceOf = (c) => `${c.slug}:${c.kind}`;
const pinned = (c) => S.focus.some((f) => !f.done && f.source === sourceOf(c));

function briefButtons(c, small) {
  const out = [];
  const onList = pinned(c);
  out.push(h('button', { class: 'btn small', type: 'button', disabled: onList, onclick: () => pin(c) }, onList ? 'On today’s list' : '+ Today'));
  if (small) return out;
  if (AGENT_KINDS.has(c.kind)) {
    out.push(h('button', { class: 'btn small ghost', type: 'button', onclick: () => prefill({ description: `${c.action.replaceAll('`', '')}. ${c.reason.replaceAll('`', '')}`, project: c.slug }) }, 'Hand to an agent'));
  }
  const repo = projectBySlug(c.slug)?.repository;
  if (repo) out.push(h('button', { class: 'btn small ghost', type: 'button', onclick: () => copy(`cd "${repo}"`, 'cd command') }, 'Copy cd'));
  return out;
}

function renderBrief() {
  const b = S.brief;
  const meta = $('#brief-meta');
  const runBtn = $('#brief-tests');
  runBtn.disabled = S.briefRunning;
  runBtn.textContent = S.briefRunning ? 'Running tests…' : 'Run tests';
  $('#brief-rescan').disabled = S.briefRunning;
  if (!b) {
    meta.textContent = S.briefError ? `Scan failed: ${S.briefError}` : 'Scanning projects…';
    return;
  }
  const suites = b.scans.filter((s) => s.tests);
  const passing = suites.filter((s) => s.tests.status === 'pass').length;
  const testsNote = S.briefRunning ? `running test commands (${dur(Date.now() - (S.briefRunningSince || Date.now()))})`
    : suites.length ? `${passing} of ${plural(suites.length, 'test suite')} passing${b.tests === 'cached' ? ' (cached for the current tree)' : ''}`
    : 'tests not run for the current trees';
  meta.textContent = `${plural(b.scans.length, 'project')} scanned ${ago(b.generatedAt)} · ${testsNote}${S.briefError ? ` · last run failed: ${S.briefError}` : ''}`;

  paint('brief', [b.top, b.all, S.focus.map((f) => [f.source, f.done]), S.state?.projects.length], () => {
    const top = b.top.map((c, i) => h('li', { class: 'brief-item' },
      h('div', { class: 'rank', 'aria-hidden': 'true' }, i + 1),
      h('div', null,
        h('div', { class: 'brief-line' }, h('strong', null, c.name), h('span', { class: 'tag' }, KIND[c.kind] || c.kind),
          h('span', { class: 'muted small' }, `last touched ${ago(c.lastActivityMs)}`)),
        h('div', { class: 'brief-action' }, rich(c.action)),
        h('div', { class: 'brief-why' }, rich(c.reason)),
        h('div', { class: 'brief-buttons' }, briefButtons(c, false)))));
    $('#brief-top').replaceChildren(...(top.length ? top : [h('li', { class: 'empty boxed' }, 'Nothing to flag: tests green, no stray branches, no TODOs. Pick something new.')]));

    const rest = b.all.filter((c) => !b.top.some((t) => t.slug === c.slug && t.kind === c.kind));
    $('#brief-rest-wrap').hidden = rest.length === 0;
    $('#brief-rest-label').textContent = `${plural(rest.length, 'more thing')} found across projects`;
    $('#brief-rest').replaceChildren(...rest.map((c) => h('li', null,
      h('div', null, h('strong', null, c.name), ' — ', rich(c.action)),
      h('div', { class: 'why' }, rich(c.reason)),
      briefButtons(c, true))));
  });
}

async function loadBrief(force) {
  try {
    const r = await api(`/api/brief${force ? '?refresh=1' : ''}`);
    applyBrief(r);
  } catch (e) { S.briefError = e.message; }
  renderBrief();
  renderProjects();
}
function applyBrief(r) {
  S.brief = r.brief; S.briefRunning = r.running; S.briefRunningSince = r.runningSince ?? null; S.briefError = r.error ?? null;
  clearTimeout(applyBrief.timer);
  if (r.running) applyBrief.timer = setTimeout(() => loadBrief(false), 2500);
}

// ---------- focus ----------
function renderFocus() {
  const open = S.focus.filter((f) => !f.done).length;
  const done = S.focus.length - open;
  $('#focus-meta').textContent = S.focus.length ? `${open} open${done ? ` · ${done} done today` : ''}` : 'Your list for the day. Unfinished items carry over.';
  paint('focus', S.focus, () => {
    const items = S.focus.map((f) => h('li', { class: f.done ? 'done' : '' },
      h('input', { type: 'checkbox', class: 'check', checked: f.done, 'aria-label': f.done ? 'Mark not done' : 'Mark done', onchange: (e) => focusCall(`/api/focus/${encodeURIComponent(f.id)}`, 'POST', { done: e.target.checked }) }),
      h('div', null,
        h('div', { class: 'text' }, rich(f.text)),
        h('div', { class: 'meta' }, f.done ? 'done' : `added ${ago(Date.parse(f.createdAt))}`, f.source ? ' · from the brief' : '')),
      h('button', { class: 'icon-btn', type: 'button', title: 'Remove', 'aria-label': 'Remove from list', onclick: () => focusCall(`/api/focus/${encodeURIComponent(f.id)}`, 'DELETE') }, '×')));
    $('#focus-list').replaceChildren(...(items.length ? items : [h('li', { class: 'empty' }, 'Nothing picked yet. Use “+ Today” on a brief item, or type below.')]));
  });
  renderBrief();
}
async function focusCall(path, method, body) {
  try { S.focus = (await api(path, { method, body })).items; }
  catch (e) { toast(e.message); }
  renderFocus();
}
const pin = (c) => focusCall('/api/focus', 'POST', { text: `${c.name}: ${c.action}`, project: c.slug, source: sourceOf(c) });

// ---------- composer ----------
function composerBody() {
  return {
    description: $('#task-desc').value, project: $('#task-project').value, tier: $('#task-tier').value,
    budget: $('#task-budget').value, maxCalls: $('#task-calls').value,
  };
}
function formMsg(text, isError) {
  const el = $('#task-msg');
  el.hidden = !text;
  el.textContent = text || '';
  el.className = `form-msg${isError ? ' error' : ''}`;
}
function prefill({ description, project }) {
  $('#task-desc').value = description;
  $('#task-project').value = project || '';
  $('#route-preview').hidden = true;
  formMsg('');
  $('#task-desc').scrollIntoView({ behavior: 'smooth', block: 'center' });
  $('#task-desc').focus();
}
const fact = (k, v) => h('div', { class: 'fact' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v));
const steps = (list) => h('div', { class: 'steps' }, list.map((s) => h('span', { class: `step ${s.state}`, title: s.state },
  h('span', { class: 'dot' }, { done: '✓', failed: '×', skipped: '–' }[s.state] || ''), s.label)));

async function previewRoute() {
  formMsg('');
  try {
    const r = await api('/api/route', { method: 'POST', body: composerBody() });
    const el = $('#route-preview');
    el.hidden = false;
    el.replaceChildren(
      h('div', { class: 'route-facts' },
        fact('Project', r.project.name), fact('Category', r.route.category.replace('_', ' ')),
        fact('Complexity', `${r.route.complexity.score}/5 · ${r.route.complexity.tier}`), fact('Tier', r.route.tier),
        fact('Would run on', r.modelNow ? h('span', { class: 'mono' }, r.modelNow) : status('critical', 'no model available right now')),
        fact('Estimate', `~${r.route.estimatedAgentCalls} agent calls · ~${r.route.estimatedWallClockMinutes} min`),
        fact('Hard stops', `${money(r.budget.maxCostUsd)} · ${r.budget.maxAgentCalls} calls · ${Math.round(r.budget.maxWallClockMs / MIN)} min`)),
      h('div', null, h('div', { class: 'muted small' }, r.workflow.description), steps(r.workflow.steps.map((label) => ({ label, state: 'pending' })))),
      h('div', { class: 'small' }, h('strong', null, 'Verified by: '),
        r.route.verification.length ? r.route.verification.map((v, i) => [i ? ' · ' : '', v.label, ' (', h('code', null, v.command), v.required ? ', required)' : ', optional)']) : 'nothing — this project has no command for this kind of task'),
      h('ul', null, r.route.rationale.map((line) => h('li', null, line))));
  } catch (e) { $('#route-preview').hidden = true; formMsg(e.message, true); }
}

async function runTask(ev) {
  ev.preventDefault();
  const btn = $('#task-run');
  btn.disabled = true;
  try {
    const r = await api('/api/tasks', { method: 'POST', body: composerBody() });
    $('#task-desc').value = '';
    $('#route-preview').hidden = true;
    formMsg(`Started ${r.id} on ${r.project} (${r.route.workflow.replaceAll('_', ' ')}, ${r.route.tier} tier). It appears under “Running now”.`);
    await loadState();
  } catch (e) { formMsg(e.message, true); }
  btn.disabled = false;
}

// ---------- running tasks ----------
function meterRow(label, valueText, frac) {
  const has = frac != null && Number.isFinite(frac);
  const fill = h('span', { style: `width:${has ? Math.min(100, Math.max(0, frac * 100)).toFixed(1) : 0}%${has && frac >= 1 ? ';background:var(--critical)' : ''}` });
  return h('div', { class: 'meter-row' }, h('span', { class: 'label' }, label), h('span', { class: 'value' }, valueText),
    h('div', { class: `meter${has ? '' : ' none'}`, role: 'img', 'aria-label': `${label}: ${valueText}` }, fill));
}

function activeCard(t) {
  const cost = taskCost(t.usage);
  const paused = t.status === 'paused';
  const ctl = (action, label, cls = 'ghost') => h('button', { class: `btn small ${cls}`, type: 'button', onclick: () => control(t.id, action) }, label);
  return h('article', { class: 'card' },
    h('div', { class: 'task-head' },
      h('div', null,
        h('div', { class: 'task-title' }, t.description),
        h('div', { class: 'task-sub' },
          h('span', { class: 'tag' }, projectBySlug(t.project)?.name || t.project),
          h('span', null, t.route.workflow.replaceAll('_', ' ')), h('span', null, `${t.route.tier} tier`),
          t.model ? h('span', { class: 'mono' }, t.model) : null,
          h('span', null, `attempt ${t.attempt} of ${t.budget.maxRetries + 1}`),
          h('span', { class: 'muted mono' }, t.id))),
      t.orphaned ? status('critical', 'process gone') : status(paused ? 'warning' : 'running', t.status.replaceAll('_', ' '))),
    h('div', { class: 'task-body' },
      h('div', null,
        steps(t.pipeline),
        t.latest ? h('div', { class: 'latest' }, t.latest.error ? h('div', { class: 'err' }, t.latest.error) : null, t.latest.summary || '') : h('div', { class: 'latest muted' }, 'No step has reported yet.'),
        t.orphaned ? h('div', { class: 'banner' }, 'The process that was running this task has exited without finishing it. Stop closes the record.') : null),
      h('div', { class: 'meters' },
        meterRow('Cost', `${cost.text} of ${money(t.budget.maxCostUsd)}`, cost.value == null ? null : cost.value / t.budget.maxCostUsd),
        meterRow('Agent calls', `${t.usage.modelCalls} of ${t.budget.maxAgentCalls}`, t.usage.modelCalls / t.budget.maxAgentCalls),
        meterRow('Wall clock', `${dur(t.durationMs ?? 0)} of ${dur(t.budget.maxWallClockMs)}`, (t.durationMs ?? 0) / t.budget.maxWallClockMs))),
    h('div', { class: 'task-controls' },
      t.orphaned ? null : paused ? ctl('resume', 'Resume', '') : ctl('pause', 'Pause'),
      t.orphaned ? null : ctl('replan', 'Replan'),
      ctl('stop', 'Stop', 'ghost danger'),
      h('button', { class: 'btn small ghost', type: 'button', onclick: () => toggleLog(t.id) }, S.openLogs.has(t.id) ? 'Hide log' : 'Show log')),
    S.openLogs.has(t.id) ? h('pre', { class: 'log', id: `log-${t.id}` }, S.logText.get(t.id) ?? 'Loading…') : null);
}

function renderActive() {
  const list = S.state.active;
  $('#active-count').textContent = list.length ? plural(list.length, 'task') : '';
  paint('active', [list, [...S.openLogs]], () => {
    $('#active').replaceChildren(...(list.length ? list.map(activeCard) : [h('div', { class: 'empty boxed' }, 'Nothing is running. Hand a task over above, or start one with ', h('code', null, 'orchestrate "<task>"'), '.')]));
    for (const id of S.openLogs) refreshLog(id);
  });
}
async function control(id, action) {
  try { await api(`/api/tasks/${encodeURIComponent(id)}/control`, { method: 'POST', body: { action } }); toast(`${action} requested — honoured at the next step boundary`); }
  catch (e) { toast(e.message); }
  loadState();
}
function toggleLog(id) {
  if (S.openLogs.has(id)) S.openLogs.delete(id); else S.openLogs.add(id);
  S.rendered.delete('active'); S.rendered.delete('history');
  renderActive(); renderHistory();
}
async function refreshLog(id) {
  try {
    const text = (await api(`/api/tasks/${encodeURIComponent(id)}/log`)) || 'No log: this task was run in the foreground from the CLI.';
    S.logText.set(id, text);
    const el = document.getElementById(`log-${id}`);
    if (el && el.textContent !== text) { el.textContent = text; el.scrollTop = el.scrollHeight; }
  } catch { /* next poll retries */ }
}

// ---------- projects ----------
const TESTS = { pass: ['good', 'tests passing'], fail: ['critical', 'tests failing'], cannot_run: ['serious', 'tests cannot run'], timeout: ['serious', 'tests timed out'] };

function projectCard(p, scan) {
  const facts = [];
  if (scan?.error) facts.push(status('critical', scan.error));
  else if (scan) {
    if (scan.dirtyCount) facts.push(h('span', { class: 'tag' }, plural(scan.dirtyCount, 'uncommitted path')));
    if (scan.unmergedBranches) facts.push(h('span', { class: 'tag' }, plural(scan.unmergedBranches, 'unmerged branch', 'unmerged branches')));
    if (scan.mergedBranches) facts.push(h('span', { class: 'tag' }, `${scan.mergedBranches} merged to prune`));
    if (scan.todoCount) facts.push(h('span', { class: 'tag' }, plural(scan.todoCount, 'TODO')));
  }
  if (p.hasEval) facts.push(h('span', { class: 'tag' }, 'eval harness'));
  const t = scan?.tests;
  const tests = t ? status(TESTS[t.status][0], TESTS[t.status][1], `${t.command}: ${t.summary}`)
    : p.commands.includes('test') ? h('span', { class: 'muted small' }, 'tests not run for this tree') : h('span', { class: 'muted small' }, 'no test command');
  return h('article', { class: 'card project' },
    h('div', { class: 'project-head' }, h('h3', null, p.name), h('span', { class: 'muted small' }, scan && !scan.error ? ago(scan.lastActivityMs) : '')),
    h('div', { class: 'project-objective', title: p.objective }, p.objective),
    scan && !scan.error ? h('div', { class: 'branch' }, `on ${scan.currentBranch}`) : null,
    h('div', { class: 'project-facts' }, facts),
    h('div', { class: 'small' }, tests, p.tasks ? h('span', { class: 'muted' }, ` · ${plural(p.tasks, 'agent task')}${p.lastOutcome ? `, last ${p.lastOutcome.replace('_', ' ')}` : ''}`) : null),
    p.knownBlockers.length ? h('details', { class: 'more' }, h('summary', null, plural(p.knownBlockers.length, 'known blocker')), h('ul', null, p.knownBlockers.map((b) => h('li', null, b)))) : null,
    h('div', { class: 'project-foot' },
      h('button', { class: 'btn small', type: 'button', onclick: () => prefill({ description: '', project: p.slug }) }, 'New task'),
      h('button', { class: 'btn small ghost', type: 'button', onclick: () => copy(`cd "${p.repository}"`, 'cd command') }, 'Copy cd')));
}

function renderProjects() {
  if (!S.state) return;
  const scans = new Map((S.brief?.scans ?? []).map((s) => [s.slug, s]));
  paint('projects', [S.state.projects, S.brief?.scans], () => {
    const sorted = [...S.state.projects].sort((a, b) => (scans.get(b.slug)?.lastActivityMs ?? 0) - (scans.get(a.slug)?.lastActivityMs ?? 0) || a.name.localeCompare(b.name));
    $('#projects').replaceChildren(...sorted.map((p) => projectCard(p, scans.get(p.slug))));
    const sel = $('#task-project');
    const keep = sel.value;
    sel.replaceChildren(h('option', { value: '' }, 'Infer from text'), ...sorted.map((p) => h('option', { value: p.slug }, p.name)));
    sel.value = keep;
  });
}

// ---------- capacity ----------
function renderCapacity() {
  const cap = S.state.capacity;
  paint('capacity', cap, () => {
    const usable = cap.models.filter((m) => m.ok).length;
    $('#capacity-meta').textContent = `${usable} of ${plural(cap.models.length, 'model')} usable right now. Daily counts reset at 00:00 UTC.`;
    $('#tiers').replaceChildren(...Object.entries(cap.tiers).map(([tier, model]) => h('div', { class: 'tier' },
      h('div', { class: 'k' }, `${tier} tier goes to`),
      h('div', { class: 'v' }, model ? h('span', { class: 'mono' }, model) : status('critical', 'nothing available')))));
    $('#models').replaceChildren(...cap.models.map((m) => {
      const runs = m.successes + m.failures;
      return h('div', { class: 'model' },
        h('div', null,
          h('div', { class: 'model-name' }, m.key),
          h('div', { class: 'model-note' }, `${m.tier} · `, runs ? `${m.successes} ok, ${m.failures} failed in 7 days` : 'no runs in 7 days', m.ok ? '' : ` · ${m.reason}`)),
        h('div', null,
          m.requestCap != null
            ? meterRow(m.ok ? 'Requests today' : 'Unavailable · requests today', `${m.requestsToday} of ${m.requestCap}`, m.requestsToday / m.requestCap)
            : h('div', { class: 'small' }, status(m.ok ? 'good' : 'critical', m.ok ? 'Available' : 'Unavailable'), h('span', { class: 'muted' }, ' · no daily cap'))));
    }));
    $('#groq').replaceChildren(...(cap.groq ? [
      meterRow('Groq tokens today (shared by both Groq models)', `${cap.groq.tokensToday.toLocaleString()} of ${cap.groq.cap.toLocaleString()}`, cap.groq.tokensToday / cap.groq.cap),
      h('p', { class: 'muted small', style: 'margin-top:6px' }, `Measured from agent calls (${cap.groq.fromAgents.toLocaleString()}) and today’s eval reports (${cap.groq.fromEvalReports.toLocaleString()}). Agents stop at ${cap.groq.agentReserve.toLocaleString()} so an eval run keeps the rest.`),
    ] : []));
  });
}

// ---------- scorecard ----------
const tile = (k, v, s) => h('div', { class: 'tile' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v), s ? h('div', { class: 's' }, s) : null);
const SEGMENTS = [
  ['successful', 'Success', 'var(--good)'], ['partial', 'Partial', 'var(--warning)'], ['failed', 'Failed', 'var(--critical)'],
  ['budgetExhausted', 'Budget hit', 'var(--serious)'], ['stopped', 'Stopped', 'var(--neutral)'],
];

function renderScorecard() {
  const a = S.state.analytics;
  paint('scorecard', a, () => {
    const finished = a.totalTasks - a.active;
    const sum = (key) => Object.values(a.costBy.provider).reduce((acc, b) => (b[key] == null ? acc : (acc ?? 0) + b[key]), null);
    const reported = sum('providerReportedCostUsd'), estimated = sum('estimatedCostUsd');
    const spend = reported == null && estimated == null ? null : (reported ?? 0) + (estimated ?? 0);
    const perSuccess = a.costPerSuccessfulOutcome.providerReportedUsd ?? a.costPerSuccessfulOutcome.estimatedUsd;
    $('#tiles').replaceChildren(
      tile('Tasks run', a.totalTasks, a.active ? `${a.active} running now` : 'none running'),
      tile('Succeeded', `${a.successful} of ${finished}`, a.partial ? `${a.partial} more partial` : finished ? 'fully verified' : 'nothing finished yet'),
      tile('Cost per success', money(perSuccess), a.successful ? 'spend ÷ verified successes' : 'no verified success yet'),
      tile('Spend recorded', money(spend), [reported != null ? `${money(reported)} reported` : null, estimated != null ? `${money(estimated)} estimated` : null].filter(Boolean).join(' · ') || 'no priced calls'),
      tile('Avg attempts', a.avgAttempts == null ? 'n/a' : a.avgAttempts.toFixed(1), `${a.totalModelCalls} model calls · ${a.totalToolCalls} tool calls`),
      tile('Context sent', a.contextReduction?.ratio != null ? pct(a.contextReduction.ratio) : 'n/a', a.contextReduction ? `${Math.round(a.contextReduction.avgIncludedChars / 1000)}k of ${Math.round(a.contextReduction.avgCandidateChars / 1000)}k chars per step` : 'no agent steps yet'));

    const segs = SEGMENTS.map(([key, label, color]) => ({ label, color, n: a[key] })).filter((s) => s.n > 0);
    $('#outcomes').replaceChildren(...(segs.length ? [
      h('div', { class: 'segbar', role: 'img', 'aria-label': `Outcomes: ${segs.map((s) => `${s.n} ${s.label}`).join(', ')}` }, segs.map((s) => h('span', { style: `flex:${s.n};background:${s.color}`, title: `${s.label}: ${s.n}` }))),
      h('div', { class: 'legend' }, segs.map((s) => h('span', null, h('span', { class: 'sw', style: `background:${s.color}` }), `${s.label} ${s.n}`))),
    ] : []));
    $('#failure-modes').replaceChildren(...(a.failureModes.length ? [
      h('div', { class: 'subhead' }, 'Why tasks fell short'),
      h('ul', { class: 'modes' }, a.failureModes.map((f) => h('li', null, h('span', null, f.mode), h('span', { class: 'num muted' }, f.count)))),
    ] : []));
  });
}

// ---------- history ----------
function detailRow(t) {
  const full = S.details.get(t.id);
  let body;
  if (!full) body = h('div', { class: 'muted' }, 'Loading…');
  else {
    const stepItems = full.steps.map((s) => h('li', null,
      h('span', { 'aria-hidden': 'true' }, { done: '✓', failed: '×', running: '●', skipped: '–' }[s.status] || '·'),
      h('span', null, h('strong', null, s.kind === 'verify' ? `verify (${s.stepId})` : `${s.role} (${s.stepId})`), s.model ? h('span', { class: 'mono muted' }, ` ${s.provider}/${s.model}`) : null,
        s.attempt > 1 ? h('span', { class: 'muted' }, ` · attempt ${s.attempt}`) : null,
        s.error ? h('div', { class: 'muted' }, s.error.slice(0, 220)) : null),
      h('span', { class: 'num muted' }, `${dur(s.durationMs)}${s.kind === 'agent' ? ` · ${taskCost(s.usage).text}` : ''}`)));
    const checks = full.verifications.map((v) => h('li', null, status(v.skipped ? 'neutral' : v.passed ? 'good' : 'critical', `${v.label}: ${v.skipped ? 'deferred' : v.passed ? 'passed' : 'failed'}`),
      v.evalSummary ? h('span', { class: 'muted' }, ` · ${v.evalSummary.passed}/${v.evalSummary.total} cases (${v.evalSummary.scope})`) : null));
    body = h('div', { class: 'detail-grid' },
      h('div', null,
        full.failureReason ? [h('h3', null, full.outcome === 'partial' ? 'Why it is only partial' : 'Why it stopped'), h('div', { class: 'block' }, full.failureReason)] : null,
        full.finalSummary ? [h('h3', { style: full.failureReason ? 'margin-top:14px' : '' }, 'Final summary'), h('div', { class: 'block' }, full.finalSummary)] : null,
        !full.failureReason && !full.finalSummary ? h('div', { class: 'muted' }, 'No summary was recorded.') : null,
        h('div', { class: 'task-controls' },
          h('button', { class: 'btn small', type: 'button', onclick: () => prefill({ description: full.description, project: full.project }) }, 'Run again'),
          h('button', { class: 'btn small ghost', type: 'button', onclick: () => toggleLog(t.id) }, S.openLogs.has(t.id) ? 'Hide log' : 'Show log'),
          h('button', { class: 'btn small ghost', type: 'button', onclick: () => copy(`node src/cli.ts routing ${t.id}`, 'routing command') }, 'Copy routing command')),
        S.openLogs.has(t.id) ? h('pre', { class: 'log', id: `log-${t.id}` }, S.logText.get(t.id) ?? 'Loading…') : null),
      h('div', null,
        h('h3', null, `Steps (${full.steps.length})`), h('ul', { class: 'steplist' }, stepItems.length ? stepItems : h('li', { class: 'muted' }, 'No step ran.')),
        checks.length ? [h('h3', { style: 'margin-top:14px' }, 'Verification'), h('ul', null, checks)] : null));
  }
  return h('tr', { class: 'detail' }, h('td', { colspan: 8 }, body));
}

function renderHistory() {
  const list = S.state.history;
  $('#history-meta').textContent = list.length ? `${plural(list.length, 'finished task')}, newest first. Click a row for steps and verification.` : '';
  paint('history', [list, [...S.openRows], [...S.openLogs], [...S.details.keys()]], () => {
    if (!list.length) { $('#history').replaceChildren(h('div', { class: 'empty boxed' }, 'No finished tasks yet.')); return; }
    const rows = list.flatMap((t) => {
      const [cls, label] = OUTCOME[t.outcome] || ['neutral', t.outcome || t.status];
      const open = S.openRows.has(t.id);
      const row = h('tr', { class: 'row', tabindex: '0', 'aria-expanded': String(open), onclick: () => toggleRow(t.id), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleRow(t.id); } } },
        h('td', { class: 'nowrap muted', title: new Date(t.createdAt).toLocaleString() }, ago(Date.parse(t.createdAt))),
        h('td', { class: 'desc' }, t.description.length > 140 ? `${t.description.slice(0, 140)}…` : t.description),
        h('td', { class: 'nowrap' }, projectBySlug(t.project)?.name || t.project),
        h('td', null, status(cls, label, t.failureReason)),
        h('td', { class: 'nowrap' }, t.route.workflow.replaceAll('_', ' ')),
        h('td', { class: 'r' }, t.usage.modelCalls),
        h('td', { class: 'r' }, taskCost(t.usage).text),
        h('td', { class: 'r' }, `${dur(t.durationMs)}${t.evalScore != null ? ` · eval ${pct(t.evalScore)}` : ''}`));
      return open ? [row, detailRow(t)] : [row];
    });
    $('#history').replaceChildren(h('table', null,
      h('thead', null, h('tr', null, ['When', 'Task', 'Project', 'Outcome', 'Workflow'].map((c) => h('th', null, c)), ['Calls', 'Cost', 'Time · eval'].map((c) => h('th', { class: 'r' }, c)))),
      h('tbody', null, rows)));
    for (const id of S.openLogs) refreshLog(id);
  });
}
async function toggleRow(id) {
  if (S.openRows.has(id)) { S.openRows.delete(id); renderHistory(); return; }
  S.openRows.add(id);
  renderHistory();
  if (!S.details.has(id)) {
    try { S.details.set(id, await api(`/api/tasks/${encodeURIComponent(id)}`)); }
    catch (e) { toast(e.message); S.openRows.delete(id); }
    renderHistory();
  }
}

// ---------- polling ----------
let stateTimer;
async function loadState() {
  clearTimeout(stateTimer);
  try {
    S.state = await api('/api/state');
    S.lastSync = Date.now(); S.offline = false;
    if (!loadState.defaulted) {
      loadState.defaulted = true;
      $('#task-budget').placeholder = String(S.state.defaults.budget.maxCostUsd);
      $('#task-calls').placeholder = String(S.state.defaults.budget.maxAgentCalls);
    }
    renderHeader(); renderActive(); renderProjects(); renderCapacity(); renderScorecard(); renderHistory(); renderBrief();
  } catch { S.offline = true; }
  tickSync();
  if (!document.hidden) stateTimer = setTimeout(loadState, S.state?.active.length || S.state?.probing ? 4000 : 20_000);
}
async function loadFocus() {
  try { S.focus = (await api('/api/focus')).items; } catch { /* keep what is on screen */ }
  renderFocus();
}

function init() {
  $('#today-date').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  $('#task-form').addEventListener('submit', runTask);
  $('#task-preview').addEventListener('click', previewRoute);
  $('#task-desc').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('#task-form').requestSubmit(); });
  $('#focus-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#focus-text');
    if (!input.value.trim()) return;
    focusCall('/api/focus', 'POST', { text: input.value });
    input.value = '';
  });
  $('#brief-rescan').addEventListener('click', async () => { $('#brief-meta').textContent = 'Scanning projects…'; await loadBrief(true); });
  $('#brief-tests').addEventListener('click', async () => {
    try { applyBrief(await api('/api/brief/run', { method: 'POST' })); } catch (e) { toast(e.message); }
    renderBrief();
  });
  $('#recheck').addEventListener('click', async () => {
    const btn = $('#recheck');
    btn.disabled = true; btn.textContent = 'Checking…';
    try { await api('/api/providers/check', { method: 'POST' }); } catch (e) { toast(e.message); }
    S.rendered.delete('providers');
    loadState();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'n' && !e.metaKey && !e.ctrlKey && !e.altKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) { e.preventDefault(); $('#task-desc').focus(); }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { loadState(); loadFocus(); loadBrief(false); } });
  setInterval(() => { tickSync(); if (S.brief) renderBrief(); }, 15_000);
  setInterval(() => { if (!document.hidden) loadBrief(false); }, 5 * MIN);
  loadState(); loadFocus(); loadBrief(false);
}
init();
