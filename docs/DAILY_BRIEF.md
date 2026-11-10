# Daily brief — spec

`orchestrate brief` is the first command of the day. It scans every project in
`projects/*.yaml`, and prints **three tasks, ranked, one line of reasoning each**.
The brief is a pointer, not a report. Each line should be something you can start
in the next five minutes.

## Constraints

- **No model calls.** The brief is deterministic code. It runs in about 30s, costs
  nothing, and works when Groq/Gemini quotas are spent or the Claude CLI token has
  expired. The same repo state always gives the same ranking.
- **Read-only.** It runs each project's own `commands.test` and git plumbing. It
  never fetches, checks out, commits, or deletes anything.
- **Bounded.** Tests run in parallel with a 3-minute timeout per project. Results are
  cached per (HEAD sha + working-tree diff), so a second run that morning is instant.

## Signals (per project)

| signal | how it is found | base score |
|---|---|---|
| failing tests | `commands.test` exits non-zero (`CI=1`) | 100 |
| test command can't run | exit 127, or timeout | 55 |
| in-flight branch | a checked-out non-default branch with commits ahead of default, last commit ≤ 14d ago | 70 |
| uncommitted work | `git status --porcelain` non-empty. Age = oldest modified file's mtime | 45 (+10 if older than 14d) |
| stale unmerged branches | local branches ahead of default, last commit > 14d ago | 35 + 2 per branch (cap +10) |
| FIXME / HACK in code | `git grep -w`, only in comments, excluding docs/json/platform scaffolding | 40 + 1 per hit (cap +10) |
| TODO in code | same filter | 25 + 1 per hit (cap +10) |
| merged branches to prune | local branches already merged into default | 15 |

**Activity multiplier** (from the last commit on any branch): ≤14d ×1.0, ≤60d ×0.8,
≤180d ×0.6, older ×0.4. A failing test in a project you touched yesterday
outranks one in a project you haven't touched since spring.

## Ranking

1. Score every candidate (`base × activity`).
2. Take the highest-scoring candidate per project, then pick the top 3 of those.
   This keeps one noisy repo from filling the whole brief.
3. If fewer than 3 projects have candidates, fill from the remaining candidates.
4. Ties are broken by most recent project activity, then by slug.

Each line has the form `<project> — <action>` and then `why: <reason>`. The reason
names the evidence: the failing command, the branch name and age, the file:line.

## Output

- Terminal: the 3 tasks, then a one-line-per-project footer of everything else found
  (`--all` prints every candidate).
- `data/briefs/YYYY-MM-DD.md`: the same text, so yesterday's brief can be diffed.
- `--json`: the full candidate list for the dashboard or scripts.
- `--no-tests`: skip test runs (git + TODO only, ~1s).

## Out of scope for v0 (next steps)

- LLM-written reasons or cross-project judgement (add later as an optional `--explain`).
- Remote state: CI status, open PRs, issues (needs the GitHub connector authorised).
- Learning from what you actually picked (record the choice, then tune the weights).
- A scheduled 8am run. (The dashboard's "Start here" card shows the brief: a fast
  scan with cached test results on load, the full run behind **Run tests**.)
