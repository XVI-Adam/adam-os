# AdamOS — architecture

Personal AI engineering orchestrator. Accepts a high-level task, decides which
project it belongs to, how hard it is, which agents and model tier to use, what
context those agents get, how the result is verified, and when to stop.

Optimises **successful outcomes per unit of model usage**, not raw usage.

## System diagram

```
            orchestrate "<task>" --project X --budget 2.00          dashboard (http)
                              │                                            │
                              ▼                                            ▼
                        ┌───────────┐   projects/*.yaml            ┌──────────────┐
                        │  Router   │◄──────────────────────────── │ Project      │
                        │ (code)    │                              │ Registry     │
                        └─────┬─────┘                              └──────────────┘
      category, complexity,   │  workflow, tier, verification plan
      capabilities            ▼
                        ┌───────────┐  step loop  ┌────────────┐  per-step   ┌──────────────┐
                        │Orchestr-  │────────────►│ Context    │────────────►│ Agent        │
                        │ator (FSM) │             │ Manager    │  context    │ (tool loop)  │
                        └─┬───┬───┬─┘             └────────────┘  pack       └──────┬───────┘
                          │   │   │                                                 │
          ┌───────────────┘   │   └───────────────┐                        ┌────────┴────────┐
          ▼                   ▼                   ▼                        ▼                 ▼
   ┌────────────┐      ┌────────────┐      ┌────────────┐          ┌────────────┐    ┌────────────┐
   │ Budget     │      │ Verifier   │      │ Store/Log  │          │ Providers  │    │ Tools      │
   │ Manager    │      │ (commands, │      │ tasks/*.json│         │ groq       │    │ read/search│
   │ hard stops │      │ eval JSON) │      │ events.jsonl│         │ gemini     │    │ edit/write │
   └────────────┘      └────────────┘      └────────────┘          │ claude-cli │    │ run_command│
                                                                   └────────────┘    └────────────┘
```

## Directory structure

```
AdamOS/
  adamos.yaml              config: env file sources, default budget
  projects/<slug>.yaml     project metadata (stack, dirs, commands, blockers, instructions)
  bin/orchestrate          CLI entry
  src/
    cli.ts                 orchestrate / status / history / show / route / doctor / analytics / dashboard
    types.ts               data model (below)
    config.ts              env + yaml loading; keys never logged
    projects.ts            registry loader + project inference from task text
    router.ts              deterministic router
    workflows.ts           reusable step sequences per workflow
    budget.ts              hard limits, usage accounting
    pricing.ts             list-price table (estimates only; null = unavailable)
    orchestrator.ts        state machine + retry/escalation
    verify.ts              command + eval-harness verifiers
    store.ts               task records, control flags, event log
    analytics.ts           aggregate metrics
    context/manager.ts     progressive context selection
    agents/                registry, tool loop, tools, prompts
    providers/             groq, gemini, claude-cli adapters + resolver
    dashboard/             local http server (server.ts), today list (focus.ts), static page (public/)
  tests/                   node:test suites
  data/                    (gitignored) tasks/<id>.json, events.jsonl, briefs/, quota/, focus.json
```

## Data model

```ts
TaskRecord {
  id, createdAt, project, description, desiredOutcome?
  route: RouteDecision            // category, complexity{score,tier}, capabilities,
                                  // workflow, tier, verification[], rationale[]
  budget: Budget                  // maxCostUsd, maxAgentCalls, maxRetries, maxToolCalls, maxWallClockMs
  usage: Usage                    // modelCalls, toolCalls, retries, tokens{in,out,reasoning},
                                  // estimatedCostUsd, providerReportedCostUsd|null,
                                  // costBasis: 'estimated'|'provider_reported'|'unavailable'
  status: TaskStatus
  attempt: number
  steps: StepRecord[]             // one per agent execution or verification
  verifications: VerificationResult[]
  evalScore?: number              // pass rate when an eval harness ran
  outcome?: 'success'|'failed'|'budget_exhausted'|'stopped'
  failureReason?: string
  finalSummary?: string
}
StepRecord { id, attempt, kind:'agent'|'verify', role, provider, model, status,
             startedAt, endedAt, usage, context{files,chars,estTokens,repoChars},
             toolCalls[], summary, error? }
Event { ts, taskId, project, type, ...payload }   // events.jsonl, append-only
```

## Orchestration state machine

```
QUEUED → ROUTING → [workflow steps...] → COMPLETED
                         │
   step kinds:  agent(role)  |  verify
                         │
   verify FAIL ─► ANALYZE_FAILURE (debugging agent, verbatim failure output)
              ─► REPLAN: attempt++, tier escalates (light→standard→strong)
              ─► if attempt > maxRetries: FAILED
              ─► else re-run from the workflow's `retry_from` step
   any step: budget check before every model call → BUDGET_EXHAUSTED
   control flags (dashboard/CLI): PAUSED (waits), STOPPED (exit), REPLAN (forces replan at next checkpoint)
```

Hard termination conditions: max agent calls, max cost, max retries, max tool
calls per step, max wall clock, max steps per agent loop. All enforced in code.

## Agent interface

```ts
interface AgentSpec { role; description; capabilities; systemPrompt; tools: ToolName[]; maxSteps; outputSchema? }
runAgent(spec, ctx) → { summary, structured?, usage, toolCalls, context }
```
Agents are adapters around a provider chat call with a small tool loop
(list_files, read_file, search, edit_file, write_file, run_command, finish).
Tools are sandboxed to the project root; run_command is allowlisted per project.
The claude-cli provider is "delegated": it runs its own loop, and we only pass
prompt, cwd, allowed tools, and budget.

## Model tiers and escalation

| tier | use | provider order |
|---|---|---|
| light | routing refinement, summaries, small reviews | groq gpt-oss-20b → gemini flash-lite |
| standard | most implementation and research | gemini-2.5-flash → gemini-3-flash-preview |
| strong | complex or escalated work, final reviews | claude-cli (sonnet/opus, when authed) → gemini-2.5-pro |

Resolver picks the first *healthy* provider for the tier (health = key present +
probe succeeded). Groq is reserved for light steps because of its 8k TPM cap
and because the Ask Adam eval harness needs Groq's 200k tokens/day.

## Budget and usage model

- Tokens are **provider-reported** (Groq `usage`, Gemini `usageMetadata`,
  claude-cli `usage`) → recorded as actual.
- Dollars are **estimated** from `pricing.ts` list prices. A null price ⇒ cost
  basis `unavailable`, never zero. claude-cli's `total_cost_usd` is stored
  separately as provider-reported.
- Every record carries `costBasis` so the dashboard/CLI can label it honestly.

## Verification model

Verification signals come from `projects/<slug>.yaml`:
`commands.test`, `commands.typecheck`, `commands.lint`, `commands.build`, and
optional `eval` (Ask Adam: `npm run eval -- --deterministic-only --json`, parsed
into pass/fail per case, expected-failure aware). The router picks which signals
a category needs. An agent saying "done" is never a pass; only these are.

## Smallest viable implementation

CLI → router → workflow → context → agent tool loop (gemini/groq) → verify →
retry/escalate → JSON records → dashboard read-only view + run/pause/stop.

## Lessons from dogfooding (2026-09-18) and what changed

| observed | mechanism added |
|---|---|
| A question that named eval files was routed to the eval workflow (a full harness run) | `readOnlyIntent()` in the router: question-shaped tasks with no mutation verb stay `research` |
| Gemini preview model returned 429/503 mid-step; the orchestrator escalated tier and discarded ten tool calls of work | In-loop fallback: on a retryable provider error the agent marks the model unavailable, resolves the next one at the same tier, and continues the same conversation |
| Analysis agent re-read a 24k-char JSON eval report three times | Eval verifications produce a per-case failure digest (verbatim grader findings); the raw `--json` stdout is never shown to agents |
| Agent spent all 14 turns reading and never called finish (900k input tokens, 810 output) | Final turn offers only `finish`; history pruning elides old tool outputs past 110k chars; tool outputs capped at 12k chars; turn budget stated in the prompt |
| A second cold eval run would exceed Groq's 200k tokens/day and die in the harness's retry loop | `quota.ts` measures today's Groq spend (uncached outcomes in today's reports + agent calls); the verifier prices a run with `npm run eval:cost` and **defers** when it cannot finish. A deferred required check makes the task `partial`, not `failed`, and never triggers a retry |
| Retry waits were too short for a per-minute quota window | `withRetry` grows 4s→60s with jitter and honours `Retry-After` / Gemini `retryDelay` |
| Gemini free tier on this key allows **20 requests/day/model**; a tool loop spent a model's whole day on one step, then 429-stormed | `ModelInfo.dailyRequestCap` + `data/quota/requests-<day>.json`; `resolve()` skips capped models; the loop forces `finish` when one request is left; `orchestrate doctor` shows per-model counts. Health probes use `GET /models` (no generate quota) |
| Fallback reached Groq with a 17k-token prompt; Groq's 8k TPM rejects it outright (413) | `resolve()` filters by `promptCharBudget`; the orchestrator resolves the model **before** building context and sizes the pack to that model; history and tool-output caps follow the model; 413 triggers fallback, not retry |
| gpt-oss on Groq emits malformed tool calls (`commentary` channel leak, `output_parse_failed`) | those 400s are classified retryable (`isRetryableGroqError`), bounded by `withRetry`; 25s spacing keeps a loop under 8k TPM |
| A filtered re-run's pass rate showed up as the task's eval score (2/12 = 17%) next to full-suite scores | `evalScore` is set only from full-suite runs; filtered runs go to `evalFilteredScore` |

## Capacity reality (2026-09-18)

With the Claude CLI unauthenticated, the whole system runs on two free tiers:
Groq (200k tokens/day, 8k TPM) and Gemini (20 requests/day/model). One dogfood
task consumed the day. The architecture is provider-agnostic; the capacity is
not. `claude auth login` (Pro subscription, `claude -p` with provider-reported
usage) is the single change that makes the strong tier real.

## Provider-aware routing (hardening pass, 2026-09-18)

"Provider available" is not "provider feasible". Every agent step now goes through **preflight** before any call:

```
requirements (prompt chars, expected calls, output tokens, tools?, json?, budget left)
   │
   ▼
for each capability row (src/providers/capabilities.ts — documented vs observed limits)
   ├─ provider healthy?            → provider_unhealthy
   ├─ in cooldown? (ledger)        → cooldown (temporary; expires or clears on success)
   ├─ tool calling / json?         → no_tool_calling / no_structured_output
   ├─ fits context + per-call cap? → context_too_small (observed 413s tighten the cap)
   ├─ single call under TPM?       → prompt_over_tpm
   ├─ requests left today (RPD)?   → rpd_exhausted
   ├─ tokens left today (TPD)?     → tpd_exhausted
   └─ within task budget?          → budget_calls / budget_cost
   ▼
score = reliability (ledger, Laplace-smoothed, 7-day window) × tier fit × (0.5 + 0.5 × cost factor)
   ▼
selected model  → context pack is sized to ITS window (orchestrator resolves before building context)
```

- **Ledger** (`data/provider-ledger.jsonl`, `src/providers/ledger.ts`): failures by category (429 → rate_limit / daily_quota, 413 → context_overflow, 408/timeout, 500, 503, tool_call_failure, malformed_response, auth) and step successes. Cooldowns escalate per consecutive failure and honour `Retry-After`; daily quota cools down until the next UTC day; a success clears the streak. Never permanent.
- **Fallback** (`runAgent.fallbackTo`): recompute requirements from the *current* history → preflight → if nothing fits, shrink the history (elide, then truncate, then rebuild a smaller context pack) → preflight again → continue the same conversation on the new model. A model that cannot take the history is never called.
- **Progress policy** (`src/agents/progress.ts`): reads are not progress. After `stallWindow` turns without an edit, a command run, or a finish, a written checkpoint is demanded; after `maxCheckpoints`, the next turn offers only `finish`. A model that ignores that turn ends the step anyway.
- **Observability**: every decision is an event `routing.decision` (candidates → eliminated+reason → remaining+score → selected → estimated usage → budget remaining) and is stored on the step record. `orchestrate routing <id>` prints them; `orchestrate simulate` answers hypotheticals with live or scripted state; `orchestrate doctor` shows per-model feasibility and reliability.
- **Cost accounting**: `orchestrate analytics` splits estimated vs provider-reported vs unavailable per workflow, role and provider, and reports cost per successful outcome.

What the simulation says about the first dogfood: with the same state (both Gemini models on their daily cap, 68k-char history), preflight selects nothing for the raw history and the loop shrinks it to ~12k chars, at which point Groq becomes a legitimate fallback. The 413 storm cannot recur.
