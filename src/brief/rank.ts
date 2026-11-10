import type { ProjectScan } from './scan.ts';

export type CandidateKind = 'failing_tests' | 'tests_cannot_run' | 'in_flight_branch' | 'uncommitted' | 'stale_branches' | 'fixme' | 'todo' | 'merged_branches';

export interface Candidate {
  slug: string;
  name: string;
  kind: CandidateKind;
  action: string;
  reason: string;
  base: number;
  activity: number;
  score: number;
  lastActivityMs: number;
}

const DAY = 86_400_000;
const STALE_MS = 14 * DAY;

export function ago(ms: number, now: number): string {
  const d = Math.max(0, Math.floor((now - ms) / DAY));
  if (d === 0) return 'today';
  if (d < 14) return `${d}d ago`;
  if (d < 60) return `${Math.floor(d / 7)}w ago`;
  if (d < 365) return `${Math.floor(d / 30)}mo ago`;
  return `${(d / 365).toFixed(1)}y ago`;
}

export function activityMultiplier(lastActivityMs: number, now: number): number {
  const age = now - lastActivityMs;
  if (age <= 14 * DAY) return 1;
  if (age <= 60 * DAY) return 0.8;
  if (age <= 180 * DAY) return 0.6;
  return 0.4;
}

const plural = (n: number, w: string, pl = `${w}s`) => `${n} ${n === 1 ? w : pl}`;
const listNames = (bs: Array<{ name: string }>, n = 2) => bs.slice(0, n).map((b) => `\`${b.name}\``).join(', ') + (bs.length > n ? ` +${bs.length - n} more` : '');

export function candidatesFor(s: ProjectScan, now: number): Candidate[] {
  if (s.error) return [];
  const out: Array<Omit<Candidate, 'slug' | 'name' | 'activity' | 'score' | 'lastActivityMs'>> = [];

  if (s.tests?.status === 'fail') {
    out.push({ kind: 'failing_tests', base: 100, action: `Fix failing tests (\`${s.tests.command}\`)`, reason: `exit ${s.tests.exitCode} on \`${s.currentBranch}\`: ${s.tests.summary}` });
  } else if (s.tests && (s.tests.status === 'cannot_run' || s.tests.status === 'timeout')) {
    out.push({ kind: 'tests_cannot_run', base: 55, action: `Get \`${s.tests.command}\` running again`, reason: s.tests.status === 'timeout' ? s.tests.summary : `exit ${s.tests.exitCode}: ${s.tests.summary}` });
  }

  const unmerged = s.branches.filter((b) => b.name !== s.defaultBranch && b.ahead > 0);
  const current = unmerged.find((b) => b.name === s.currentBranch && now - b.lastCommitMs <= STALE_MS);
  if (current) {
    out.push({ kind: 'in_flight_branch', base: 70, action: `Finish and merge \`${current.name}\``, reason: `you're on it: ${plural(current.ahead, 'commit')} ahead of ${s.defaultBranch}, last commit ${ago(current.lastCommitMs, now)}` });
  }

  if (s.dirty.count > 0) {
    const old = s.dirty.oldestMtimeMs !== null && now - s.dirty.oldestMtimeMs > STALE_MS;
    out.push({
      kind: 'uncommitted', base: 45 + (old ? 10 : 0),
      action: 'Commit, stash or discard uncommitted work',
      reason: `${plural(s.dirty.count, 'uncommitted path')} on \`${s.currentBranch}\`${s.dirty.oldestMtimeMs !== null ? `, oldest edit ${ago(s.dirty.oldestMtimeMs, now)}` : ''}`,
    });
  }

  const stale = unmerged.filter((b) => now - b.lastCommitMs > STALE_MS).sort((a, b) => b.lastCommitMs - a.lastCommitMs);
  if (stale.length) {
    out.push({ kind: 'stale_branches', base: 35 + Math.min(10, 2 * stale.length), action: `Merge or delete ${plural(stale.length, 'stale branch', 'stale branches')}`, reason: `unmerged into ${s.defaultBranch}, untouched 2w+: ${listNames(stale)}` });
  }

  const hard = s.todos.filter((t) => t.tag !== 'TODO');
  const soft = s.todos.filter((t) => t.tag === 'TODO');
  if (hard.length) out.push({ kind: 'fixme', base: 40 + Math.min(10, hard.length), action: `Resolve ${plural(hard.length, 'FIXME/HACK', 'FIXMEs/HACKs')}`, reason: `${hard[0].file}:${hard[0].line} — ${hard[0].text}` });
  if (soft.length) out.push({ kind: 'todo', base: 25 + Math.min(10, soft.length), action: `Clear ${plural(soft.length, 'TODO')}`, reason: `${soft[0].file}:${soft[0].line} — ${soft[0].text}` });

  const merged = s.branches.filter((b) => b.name !== s.defaultBranch && b.ahead === 0 && b.name !== s.currentBranch);
  if (merged.length) out.push({ kind: 'merged_branches', base: 15, action: `Prune ${plural(merged.length, 'merged branch', 'merged branches')}`, reason: `already in ${s.defaultBranch}: ${listNames(merged)}` });

  const activity = activityMultiplier(s.lastActivityMs, now);
  return out.map((c) => ({ ...c, slug: s.slug, name: s.name, activity, score: Math.round(c.base * activity), lastActivityMs: s.lastActivityMs }));
}

const byScore = (a: Candidate, b: Candidate) => b.score - a.score || b.lastActivityMs - a.lastActivityMs || a.slug.localeCompare(b.slug);

/** Best candidate per project first (so one noisy repo can't fill the brief), then backfill. */
export function rank(scans: ProjectScan[], now: number, count = 3): { top: Candidate[]; all: Candidate[] } {
  const all = scans.flatMap((s) => candidatesFor(s, now)).sort(byScore);
  const seen = new Set<string>();
  const top: Candidate[] = [];
  for (const c of all) if (top.length < count && !seen.has(c.slug)) { top.push(c); seen.add(c.slug); }
  for (const c of all) if (top.length < count && !top.includes(c)) top.push(c);
  return { top: top.sort(byScore), all };
}
