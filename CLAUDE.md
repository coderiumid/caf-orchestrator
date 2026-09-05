# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

CAF Orchestrator: Linear webhook receiver that triggers an automated multi-agent Claude Code pipeline against a target repo. When a Linear ticket transitions into the "Ready for AI" state, this service clones the target repo, runs a chain of headless `claude --agent <name>` processes (planner → frontend/backend → QA → reviewer → docs), and pushes a branch + posts results back to Linear.

## Commands

```bash
pnpm dev            # run web server (tsx, no build)
pnpm dev:worker     # run BullMQ worker (tsx, no build)
pnpm build          # tsc compile to dist/
pnpm start          # run compiled web server
pnpm start:worker   # run compiled worker
pnpm lint           # eslint src
pnpm typecheck      # tsc --noEmit
pnpm test           # vitest run (single run)
pnpm test:watch     # vitest watch mode
pnpm test:coverage  # vitest with v8 coverage
```

Single test file: `pnpm vitest run tests/unit/task-router.test.ts`
Single test by name: `pnpm vitest run -t "test name"`

Two processes make up the app: the Fastify **web server** (receives Linear webhooks, enqueues jobs) and the BullMQ **worker** (dequeues jobs, runs the agent pipeline). They share Redis as the queue backend and must both be running for the pipeline to actually execute — `pnpm dev` alone only accepts webhooks, it does not process them.

## Architecture

Clean/hexagonal layering under `src/`:
- `domain/interfaces/` — ports (IGitService, IAgentRunner, ILinearClient, IVcsClient, INotifier, IQueue). No implementation details here.
- `application/use-cases/` — orchestration logic, depends only on domain interfaces. `RunAgentPipelineUseCase` is the entire pipeline; everything else is plumbing around it.
- `infrastructure/` — concrete adapters (git via simple-git style shell calls, BullMQ queue, Linear GraphQL client, Telegram notifier — fires automatically on pipeline start/complete/failed when `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` are set, fire-and-forget, never fails the pipeline, `spawn-agent.service.ts` which shells out to the `claude` CLI, `report-reader.ts` which parses markdown report files).
- `presentation/web/` — Fastify app: `routes/webhooks.ts` (Linear webhook intake), `routes/health.ts`.
- `config/` — zod-validated env schema (`schema.ts`), single `config` export (`index.ts`). All env access should go through this, not `process.env` directly.

### Pipeline flow (`run-agent-pipeline.use-case.ts`)

1. Create disposable workspace dir, clone target repo, create branch `ai-agent/<TICKET-KEY>`.
2. Run `planner` agent → must produce `.ai/tasks/<TICKET-KEY>/tasks.md`.
3. `task-router.ts` parses `tasks.md` for `## Frontend Tasks` / `## Backend Tasks` headers to decide which implementation agent(s) run (order: frontend, then backend).
4. Run implementation agent(s) against their section of `tasks.md`.
5. Read `.ai/tasks/<TICKET-KEY>/verify-report.md` — if status is `NEEDS_HUMAN`, push + open (or update) a **Draft PR** and stop-and-comment on the ticket (CAF-RETRYPIPELINE-01).
6. Run `qa` agent → produces `qa-report.md`. On `FAIL`, retry implementation once (`MAX_QA_RETRIES = 1`), then push + open/update a Draft PR and stop-and-comment if still failing.
7. Run `reviewer` agent → produces `review-notes.md` with a `Verdict:` line (`APPROVE` / `CHANGES_REQUESTED` / `DEFER`). On `CHANGES_REQUESTED`, retry implementation once (`MAX_REVIEWER_RETRIES = 1`), then push + open/update a Draft PR and stop-and-comment if still requested.
8. If `## Docs Tasks` section has real content (see `hasDocsTasks`), run `documentation` agent. **Docs failures never fail the job** — caught and reduced to a note, since a docs error would otherwise trigger a full BullMQ job retry of the whole pipeline.
9. Commit all, push branch, **create a GitHub PR** via `IVcsClient.createPullRequest`, then post final comment to Linear ticket with the PR URL + QA + reviewer report bodies.

Every stage's stop conditions are gates that **return early** (not throw) to end the job cleanly with a human-review comment; unexpected agent crashes/timeouts throw and let BullMQ's retry policy handle it.

### Gate-exhaustion Draft PR (CAF-RETRYPIPELINE-01)

Steps 5-7's `NEEDS_HUMAN` gates never leave work stranded in the workspace only: before posting the human-facing comment, `pushAndOpenGatePr()` commits + pushes the branch, then opens a **Draft PR** (`createPullRequest({ draft: true })`) or, if one is already open on this branch (`findOpenPullRequestByHead`), updates its description instead (`updatePullRequest`) rather than creating a duplicate. The PR body reformats whichever artifact the failing gate already produced (`verify-report.md`/`qa-report.md`/`review-notes.md`) — no new text generated, same report-contract convention as everywhere else. This push+PR step deliberately never throws: a GitHub/git failure here is logged and noted in the comment ("Could not push/open a Draft PR automatically: ..."), but the gate's `return` contract is preserved — a push failure must not turn into a BullMQ retry.

### `/caf-retry-pipeline` resume (CAF-RETRYPIPELINE-01)

A comment starting with `/caf-retry-pipeline` on one of these Draft PRs (`routes/webhooks.ts`'s `handleRetryPipelineCommand`) re-enqueues the ticket pipeline with `isRetry: true` and a `retryContext` (owner/repo/prNumber, and the resolved `maxOrchestrationRetries` — per-repo override in `projects.<name>.orchestration.maxOrchestrationRetries` falling back to the global `orchestration.maxOrchestrationRetries`, see `config/schema.ts`). On the worker side, `execute()` branches on `job.isRetry`: it syncs the workspace onto the **existing** `ai-agent/<TICKET-KEY>` branch (`preflightCleanup`/`clone` against that branch, never `createBranch`) instead of branching fresh off `baseBranch`, then `checkAndConsumeRetryBudget()` reads `orchestration-state.json` — rejects with an explicit comment (no agents run) if no state exists or `orchestrationRetryCount` has already reached the limit, otherwise increments the shared counter and refreshes `ticketTitle`/`ticketDescription` from the stored state (a resume trigger carries no fresh ticket content of its own). Every status comment for a retry run — including the eventual success comment — goes to the triggering PR (`retryContext`), not back to the original Linear ticket/GitHub issue, since that PR thread is what the human is actually watching. **This is a restart, not a gate-aware resume**: the whole pipeline re-runs from `caf-planner` onward on top of the existing branch; it does not skip to the failed gate, diff manual changes since the last run, or detect unexpected uncommitted residue in a `persistent`-mode workspace — that gate-aware behavior is still-unimplemented future work (see `.ai/tasks/CAF-RETRYPIPELINE-01/tasks.md` Task 6). A Linear ticket flipping back to "Ready for AI" on a branch that already exists is meant to reuse this exact same path (`isRetry`/`retryContext`/`checkAndConsumeRetryBudget`) rather than a separate implementation — not yet wired into the Linear webhook handler.

### Dynamic agent skip (`AGENT_SKIP_ENABLED`)

Off by default (`.env`, boolean) — with it false, every stage above runs unconditionally, byte-for-byte the pre-existing behavior. When true, Planner can mark `frontend`/`backend`/`qa`/`reviewer`/`documentation` as not relevant for a ticket via an explicit `## Skip Agents` section in `tasks.md` (`- QA: reason`), parsed by `parseSkipDirectives()` in `task-router.ts`. A skip is only honored when the signal is unambiguous — an absent section, a malformed line, or an unrecognized agent name all parse to "not skipped," never to a skip. `routeTasks()` also gets a stricter empty-section check (`strictEmptyCheck`, only active behind this same flag) so a `## Backend Tasks` header with an empty/`(none)` body no longer spawns Backend Agent for nothing.

- Frontend/backend/documentation skips: not spawned, noted in `verify-report.md` (`appendSkipNote`) and via Telegram. Never leaves zero implementation agents running — if a skip directive would cover every section Planner routed to, it's ignored for safety and everything routes normally.
- QA/reviewer skips: same Telegram notification, **plus** an explicit `⚠️ Quality gate dilewati` warning block injected into the PR body (`buildQualityGateWarning`), since skipping these removes the pipeline's only correctness/quality checks before human review.

### Fail-fast on non-retryable agent errors

If an agent run fails with a `429` (API quota exhausted) or `404` (model not found/inaccessible), the pipeline stops cleanly — posts a Linear comment and returns — instead of letting BullMQ retry the whole job. Retrying a quota/config error immediately just repeats the same failure. Any other exit code/status falls through to the normal `throw` → BullMQ retry path. See `stopIfNonRetryable` in `run-agent-pipeline.use-case.ts`.

### Agent execution model (`spawn-agent.service.ts`)

Each agent is `spawn('claude', ['--agent', name, '--print', '--permission-mode', 'bypassPermissions'])` in the cloned workspace, prompt piped via stdin. Key details:
- `bypassPermissions` is deliberate: headless runs can't answer interactive tool-approval prompts, and each run is in a fresh disposable clone, so it's safe here — do not remove this without understanding the tradeoff.
- Timeout (`CLAUDE_AGENT_TIMEOUT_MS`, default 30 min) is enforced in this service via `setTimeout`/SIGTERM→SIGKILL, not via BullMQ. BullMQ's `lockDuration` (35 min, see `worker.ts`) is intentionally set above this so BullMQ doesn't flag the job stalled mid-escalation.
- Process kill-by-signal is distinguished from non-zero exit in `AgentRunResult`; both currently cause a full pipeline retry (no step-resume state is persisted).

The actual agent definitions (`planner`, `frontend`, `backend`, `qa`, `reviewer`, `documentation`) live in the **target repo** being operated on (its own `.claude/agents/`), not in this repo — this repo only knows their names and invokes them.

### Report contract

Agents communicate pipeline state by writing markdown files to `.ai/tasks/<TICKET-KEY>/` in the target repo's workspace, parsed by `infrastructure/reports/report-reader.ts` via simple regex (`\bSUCCESS\b`, `\bPASS\b`, a `Verdict:` line). Any new gate/report type should follow this same loose-regex-over-markdown convention rather than requiring agents to emit structured JSON.

### Webhook intake (`routes/webhooks.ts`)

Validates HMAC signature (`verifyLinearSignature`) and timestamp freshness before anything else, then dedupes by `Linear-Delivery` header via Redis (`delivery-dedupe.ts`) to survive Linear's at-least-once delivery. Only triggers the pipeline on an `Issue` `update` event where `updatedFrom` contains `stateId` (i.e. an actual state transition, not just any field edit) and the new `stateId` matches `LINEAR_READY_STATE_ID`. `ENABLE_PIPELINE_TRIGGER` is a kill switch checked after all validation.

### Queue dashboard (`routes/dashboard.ts`)

Bull Board UI for the `agent-pipeline` BullMQ queue, mounted at `/admin/queues` (not root), basic-auth gated. Off by default (`dashboard.enabled: false` in `caf.config.yaml`) — must be explicitly enabled, and `dashboard.basicAuthUser` (YAML) + `DASHBOARD_BASIC_AUTH_PASSWORD` (`.env`, secret) are both required once enabled (enforced via `superRefine`, same pairing pattern as the Telegram vars). Password comparison is timing-safe. If deployed behind a reverse proxy, ensure `/admin/queues` is proxied and served over HTTPS only — basic-auth credentials are plaintext over HTTP.

### v1 scope constraints (intentional, not gaps)

- Worker concurrency defaults to 1 (`queue.workerConcurrency` in `caf.config.yaml`) — concurrent Claude Code agent processes are expensive.
- No step-resume: any pipeline failure retries the whole job from planner onward.

### Per-project registry (`config/project-registry.ts`)

Multi-repo/multi-team routing is live, not global config: `caf.config.yaml`'s `projects:` map (validated by `project-config.schema.ts`) holds one entry per project — `ticketPrefix`, `repoCloneUrl`, `baseBranch`, `workspaceDir`, `agents.modelOverrides` — keyed by an arbitrary project name but re-keyed by `ticketPrefix` in the loaded `ProjectRegistry`. The webhook handler looks up the target project by the incoming ticket's key prefix (e.g. `ABC-123` → `ABC`) and carries the matched config through the job payload as `projectConfig`. `ProjectRegistry.load()` fails startup fast if `projects:` is missing or empty — at least one project must be configured, or no ticket could ever match and the pipeline would silently never trigger.

## Config

Config is split two ways, both validated through `src/config/schema.ts` (zod):
- **Structural** (non-secret) fields — server port, Linear/GitHub API URLs, workspace dir, queue settings, `agents.qa.maxRetries`/`agents.reviewer.maxRetries`, `agents.modelOverrides`, `openai.*`, and the per-project `projects:` map — live in `caf.config.yaml` (copy from `caf.config.example.yaml`).
- **Secrets** and operational toggles — `REDIS_URL`, `LINEAR_WEBHOOK_SECRET`, `LINEAR_API_KEY`, `GITHUB_TOKEN`, `ENABLE_PIPELINE_TRIGGER`, `AGENT_SKIP_ENABLED`, Telegram vars, `OPENAI_API_KEY` — stay in `.env`. See `.env.example`/`caf.config.example.yaml` for full lists.

`linear.readyStateId` (in `caf.config.yaml`, must be a UUID) is required — startup fails fast if missing. Telegram vars (`TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`) are optional but must be set together (enforced via `superRefine`).

### Claude Code CLI auth

`openai.useOpenai: true` (with `OPENAI_API_KEY` set) is currently **required** — it is the only auth path this codebase wires up for the spawned `claude` CLI (`spawn-agent.service.ts` maps `OPENAI_API_KEY` to `ANTHROPIC_API_KEY`). Setting `openai.useOpenai: false` requires `CLAUDE_CODE_OAUTH_TOKEN` to be set in `.env` instead (passed through unchanged via `process.env` to the child process — native Claude Code CLI auth, not something this codebase reads or transforms). `superRefine` in `schema.ts` fails startup fast if neither path is configured, rather than letting the first agent spawn fail silently mid-pipeline.

### Per-agent model routing

`agents.modelOverrides` in `caf.config.yaml` maps an agent name (`planner`/`frontend`/`backend`/`qa`/`reviewer`/`documentation`) to a model id, applied on top of `openai.defaultModel` when both are set. Every model id used — `openai.defaultModel` and every `modelOverrides` value — must appear byte-for-byte in `openai.allowedModels`; **fail-closed**: empty allowlist means no model is ever sent. This exists because a plausible-looking model id can still 404 at call time if it doesn't actually exist on the endpoint (`openai.baseUrl`) — the allowlist only catches typos/unlisted ids, not nonexistent ones, so each entry must be personally verified to work before being added.
