# AdamOS — personal AI engineering orchestrator

Takes a high-level task ("Fix the Ask Adam model migration"), decides which
project it belongs to, how complex it is, which workflow and agents to use, what
context those agents see, how the result is verified, and when to stop. It
optimises **successful outcomes per unit of model usage**, not raw usage.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design.

## Quick start

```bash
npm install
node src/cli.ts brief                        # morning: top 3 tasks across all projects (docs/DAILY_BRIEF.md)
node src/cli.ts doctor                       # which providers are usable right now
node src/cli.ts route "Prepare BodyCraft for App Store release"
node src/cli.ts --project ask-adam --budget 2.00 "Improve JD Fit Rater accuracy"
node src/cli.ts status | history | show <id> | events <id> | analytics
npm run dashboard                            # daily dashboard → http://localhost:4646 (opens your browser)
node src/cli.ts simulate --tier strong --chars 60000   # which model would be chosen right now, and why
node src/cli.ts routing <id>                 # every routing decision a task made
npm test
```

`bin/orchestrate` is the same CLI; `npm link` puts `orchestrate` on your PATH.

## Daily dashboard

`npm run dashboard` (or `orchestrate dashboard [--port 4646] [--open]`) serves one
page to work out of for the day:

- **Start here** — the daily brief's top three tasks, with the rest one click away.
  Loads in about a second from git state plus any test result already cached for
  the current tree; **Run tests** does the full `orchestrate brief` in the background.
- **Today** — a short checklist. Pin brief items or type your own; unfinished items
  carry over, finished ones drop off the next day (`data/focus.json`).
- **Hand a task to the orchestrator** — describe it, **Preview route** to see the
  project, workflow, tier, verification and which model would take it right now
  (no model calls), then **Run task**.
- **Running now** — live step pipeline, cost / calls / wall-clock against their hard
  stops, pause / resume / replan / stop, and the run log.
- **Projects** — branch, uncommitted paths, stale and merged branches, TODOs, test
  status and known blockers for every project in `projects/`.
- **Model capacity today** — which model each tier resolves to, per-model daily
  request counts, Groq's shared token budget, and 7-day reliability.
- **Scorecard and history** — outcomes, cost per verified success, failure modes,
  and per-task steps and verification results.

### Start at login (macOS)

```bash
node src/cli.ts autostart install     # writes ~/Library/LaunchAgents/com.adamos.dashboard.plist and starts it
node src/cli.ts autostart status      # installed? running? where is the log?
node src/cli.ts autostart uninstall   # stop it and remove the agent
```

The agent runs the dashboard in the background from login on, restarts it if it
exits with an error, and logs to `data/logs/dashboard.log`. It does not open a
browser window; bookmark http://localhost:4646, or run `npm run dashboard`, which
opens the copy that is already running. The node binary and `PATH` are captured
when you install, so run `autostart install` again after switching node versions
or moving this folder (it is also how you restart the server after pulling code).
While the page is open, provider health is re-probed once it is more than four
hours old.

The server binds to 127.0.0.1 and refuses cross-origin or non-JSON writes: it can
start agents that edit your repositories, so only pages it served itself may ask.
The page is plain HTML/CSS/JS in `src/dashboard/public/` with no build step.

## Providers and keys

Keys are read from `AdamOS/.env` first, then from the project `.env` files listed
in `adamos.yaml`. Nothing ever prints a key.

| provider | how | status on this machine |
|---|---|---|
| groq | REST, `GROQ_API_KEY` | works; free tier (8k TPM, 200k tokens/day). Prompts are capped at 14k chars (anything larger is a 413), calls are spaced 25s apart, and agents stop using it at ~190k tokens/day so the Ask Adam eval harness keeps the rest |
| gemini | REST, `GEMINI_API_KEY` | works for `gemini-2.5-flash`, `gemini-3-flash-preview`, `gemini-3.1-flash-lite`; pro models are not available on this key. **Free tier: 20 requests/day/model**, tracked in `data/quota/` and shown by `doctor` |
| claude-cli | spawns `claude -p --output-format json` | installed, Pro subscription, but the stored OAuth token expired 2026-03-31. Run `claude auth login` in a terminal and `orchestrate doctor` will pick it up |

## Cost honesty

Every task carries `usage.costBasis`:

- `estimated` — tokens are provider-reported, dollars come from `src/pricing.ts` list prices
- `provider_reported` — the provider returned a dollar figure (claude-cli only)
- `unavailable` — a model with no known price was used; tokens are still recorded, dollars are `null`, never `$0`
- `mixed` — some calls had no usage block at all

Free tiers and the Claude subscription bill $0 marginal; the estimate exists so
tasks can be compared, not to claim a bill.

## Budgets and hard stops

`adamos.yaml` sets defaults; the CLI overrides them (`--budget`, `--max-calls`,
`--max-retries`, `--max-minutes`). Enforced in code before every model and tool
call: max cost, max agent calls, max tool calls, max retries, max wall clock,
and max loop steps per agent. A task ends in `budget_exhausted`, never in a
silent success.

## Projects

`projects/<slug>.yaml` holds repository, stack, important directories, commands
(test/typecheck/lint/build), eval harness, allowlisted commands for agents,
known blockers and agent instructions. Add a project by adding a file.

## Data

`data/tasks/<id>.json` (full record), `data/events.jsonl` (structured log),
`data/logs/<id>.log` (detached runs), `data/provider-health.json` (1h cache).
