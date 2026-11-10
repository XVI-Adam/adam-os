import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Project } from '../projects.ts';
import { ago, rank, type Candidate } from './rank.ts';
import { scanAll, type ProjectScan } from './scan.ts';

const SHORT: Record<Candidate['kind'], string> = {
  failing_tests: 'tests failing', tests_cannot_run: 'tests broken', in_flight_branch: 'open branch', uncommitted: 'uncommitted',
  stale_branches: 'stale branches', fixme: 'FIXMEs', todo: 'TODOs', merged_branches: 'merged branches',
};

export interface BriefOptions {
  runTests: boolean;
  showAll: boolean;
  dataDir: string;
  now?: number;
  /** Reuse cached test results without running anything (dashboard fast scan). */
  cachedTestsOnly?: boolean;
  /** Write data/briefs/<date>.md (default true). */
  save?: boolean;
}
export interface Brief { date: string; text: string; top: Candidate[]; all: Candidate[]; scans: ProjectScan[]; savedTo: string }

function testsLine(scans: ProjectScan[]): string {
  const parts = scans.filter((s) => s.tests).map((s) => {
    const t = s.tests!;
    const mark = t.status === 'pass' ? '✓' : t.status === 'fail' ? '✗' : '?';
    return `${s.slug} ${mark}${t.cached ? ' (cached)' : ` ${Math.round(t.durationMs / 1000)}s`}`;
  });
  return parts.length ? `Tests: ${parts.join(' · ')}` : 'Tests: skipped (--no-tests)';
}

export function renderBrief(top: Candidate[], all: Candidate[], scans: ProjectScan[], now: number, showAll: boolean): string {
  const day = new Date(now).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
  const lines = [`AdamOS daily brief — ${day}`, ''];
  if (!top.length) lines.push('Nothing to flag: tests green, no stray branches, no TODOs. Pick something new.');
  top.forEach((c, i) => {
    lines.push(`${i + 1}. ${c.name} — ${c.action}`);
    lines.push(`   why: ${c.reason}`);
  });

  const rest = all.filter((c) => !top.includes(c));
  if (rest.length) {
    lines.push('');
    if (showAll) {
      lines.push('Everything else:');
      for (const c of rest) lines.push(`  ${String(c.score).padStart(3)}  ${c.slug.padEnd(18)} ${c.action} — ${c.reason}`);
    } else {
      const bySlug = new Map<string, string[]>();
      for (const c of rest) bySlug.set(c.slug, [...(bySlug.get(c.slug) ?? []), SHORT[c.kind]]);
      lines.push(`Also found (--all for detail): ${[...bySlug].map(([slug, ks]) => `${slug} (${ks.join(', ')})`).join(' · ')}`);
    }
  }

  lines.push('', testsLine(scans));
  const quiet = scans.filter((s) => !s.error).map((s) => `${s.slug} ${ago(s.lastActivityMs, now)}`);
  lines.push(`Last activity: ${quiet.join(' · ')}`);
  for (const s of scans.filter((x) => x.error)) lines.push(`! ${s.slug}: ${s.error} (${s.repository})`);
  return lines.join('\n');
}

export async function runBrief(projects: Project[], opts: BriefOptions): Promise<Brief> {
  const now = opts.now ?? Date.now();
  const scans = await scanAll(projects, { runTests: opts.runTests, cachedTestsOnly: opts.cachedTestsOnly, cacheDir: join(opts.dataDir, 'briefs', 'test-cache') });
  const { top, all } = rank(scans, now);
  const text = renderBrief(top, all, scans, now, opts.showAll);
  const d = new Date(now);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const dir = join(opts.dataDir, 'briefs');
  const savedTo = join(dir, `${date}.md`);
  if (opts.save !== false) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(savedTo, '```\n' + renderBrief(top, all, scans, now, true) + '\n```\n');
  }
  return { date, text, top, all, scans, savedTo };
}
