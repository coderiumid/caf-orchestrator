# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

CAF Orchestrator: Linear + GitHub webhook receiver that triggers an automated multi-agent Claude Code pipeline against a target repo. When a ticket becomes "Ready for AI" (a Linear ticket transitioning into the configured state, or a GitHub Issue getting the `github.readyLabel` label), this service clones the target repo, runs a chain of headless `claude --agent <name>` processes (`caf-planner` → `caf-frontend`/`caf-backend` → `caf-qa` → `caf-reviewer` → `caf-documentation`), pushes a branch, opens a GitHub PR, and posts results back to the ticket. A second job type, `pr-review`, runs `caf-reviewer` against an existing PR in response to PR comments.

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
pnpm db:migrate     # create/upgrade the SQLite run-history db at db.path
```

Single test file: `pnpm vitest run tests/unit/task-router.test.ts`
Single test by name: `pnpm vitest run -t "test name"`

Two processes make up the app: the Fastify **web server** (receives Linear/GitHub webhooks, enqueues jobs, serves the dashboard) and the BullMQ **worker** (dequeues jobs and dispatches by job name in `src/worker.ts`: `agent-pipeline` → `RunAgentPipelineUseCase`, `pr-review` → `RunPrReviewUseCase`). They share Redis as the queue backend and must both be running for the pipeline to actually execute — `pnpm dev` alone only accepts webhooks, it does not process them.

Deployment is Docker: `docker-compose.yml` runs `redis`, `api` and `worker` from one image (`Dockerfile`), `deploy.sh` resets to `origin/main`, rebuilds and restarts, and `.github/workflows/deploy.yml` runs typecheck/lint/test/build on every push and PR, then runs `deploy.sh` on the VPS over SSH for pushes to `main`. `tsc` does not copy non-TypeScript files, so any new runtime asset read via `__dirname` (like `schema.sql` or the `ui/` static files) needs its own `COPY` line in the `Dockerfile`.

## Architecture

Clean/hexagonal layering under `src/`:
- `domain/interfaces/` — ports (IGitService, IAgentRunner, ILinearClient, IVcsClient, INotifier, IQueue). No implementation details here.
- `application/use-cases/` — orchestration logic, depends only on domain interfaces. `RunAgentPipelineUseCase` is the entire ticket pipeline; `RunPrReviewUseCase` is the PR-comment-driven review job.
- `infrastructure/` — concrete adapters: `git/` (shell-out git service, workspace manager, in-memory workspace lock), `queue/` (BullMQ client/worker, plus `dashboard-events.ts` for worker→web Redis pub/sub), `linear/` (GraphQL client, delivery dedupe, ticket-prefix parsing), `vcs/` (GitHub REST client, webhook signature checks, collaborator-permission check), `agent/` (`spawn-agent.service.ts` which shells out to the `claude` CLI, `task-router.ts`, cost parsing, API-error classification), `reports/` (`report-reader.ts` which parses markdown report files, `orchestration-state.ts`), `db/` (better-sqlite3 run history for the dashboard), `watch/` (chokidar watcher on `orchestration-state.json`), `notifications/` (Telegram notifier — fires automatically on pipeline start/complete/failed when `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` are set, fire-and-forget, never fails the pipeline).
- `presentation/web/` — Fastify app: `routes/webhooks.ts` (Linear + GitHub webhook intake), `routes/health.ts`, and the dashboard (`routes/dashboard-ui.ts`, `routes/agent-floor-ui.ts`, `routes/pipelines.ts`, `routes/events.ts`, static files under `ui/`).
- `config/` — zod-validated schema (`schema.ts`) over `.env` + `caf.config.yaml` (`yaml-config.ts`), single `config` export plus `projectRegistry` (`index.ts`). All config access should go through this, not `process.env` directly.

### Pipeline flow (`run-agent-pipeline.use-case.ts`)

1. Create the workspace under the project's `workspaceDir` (see "Workspace modes"), clone the target repo (or fetch + reset an existing persistent checkout), create branch `ai-agent/<TICKET-KEY>`.
2. Run `caf-planner` agent → must produce `.caf/tasks/<TICKET-KEY>/tasks.md`.
3. `task-router.ts` parses `tasks.md` for `## Frontend Tasks` / `## Backend Tasks` headers to decide which implementation agent(s) run (order: `caf-frontend`, then `caf-backend`).
4. Run implementation agent(s) against their section of `tasks.md`.
5. Read `.caf/tasks/<TICKET-KEY>/verify-report.md` — if status is `NEEDS_HUMAN`, push + open (or update) a **Draft PR** and stop-and-comment on the ticket (CAF-RETRYPIPELINE-01).
6. Run `caf-qa` agent → produces `qa-report.md`. On `FAIL`, retry implementation up to `agents.qa.maxRetries` times (default 1), then push + open/update a Draft PR and stop-and-comment if still failing.
7. Run `caf-reviewer` agent → produces `review-notes.md` with a `Verdict:` line (`APPROVE` / `CHANGES_REQUESTED` / `DEFER`). On `CHANGES_REQUESTED`, retry implementation up to `agents.reviewer.maxRetries` times (default 1), then push + open/update a Draft PR and stop-and-comment if still requested.
8. If `## Docs Tasks` section has real content (see `hasDocsTasks`), run `caf-documentation` agent. **Docs failures never fail the job** — caught and reduced to a note, since a docs error would otherwise trigger a full BullMQ job retry of the whole pipeline.
9. Commit all, push branch, **create a GitHub PR** via `IVcsClient.createPullRequest`, then post the final comment (PR URL + QA + reviewer report bodies) to wherever the ticket lives — the Linear ticket, or the GitHub Issue when `job.ticketSource === 'github'` (`postTicketComment`).

Every stage's stop conditions are gates that **return early** (not throw) to end the job cleanly with a human-review comment; unexpected agent crashes/timeouts throw and let BullMQ's retry policy handle it.

### Gate-exhaustion Draft PR (CAF-RETRYPIPELINE-01)

Steps 5-7's `NEEDS_HUMAN` gates never leave work stranded in the workspace only: before posting the human-facing comment, `pushAndOpenGatePr()` commits + pushes the branch, then opens a **Draft PR** (`createPullRequest({ draft: true })`) or, if one is already open on this branch (`findOpenPullRequestByHead`), updates its description instead (`updatePullRequest`) rather than creating a duplicate. The PR body reformats whichever artifact the failing gate already produced (`verify-report.md`/`qa-report.md`/`review-notes.md`) — no new text generated, same report-contract convention as everywhere else. This push+PR step deliberately never throws: a GitHub/git failure here is logged and noted in the comment ("Could not push/open a Draft PR automatically: ..."), but the gate's `return` contract is preserved — a push failure must not turn into a BullMQ retry.

### `/caf-retry-pipeline` resume (CAF-RETRYPIPELINE-01)

Two trigger paths converge on the exact same resume mechanism — neither implements its own counter or resume logic:

1. A comment starting with `/caf-retry-pipeline` on one of these Draft PRs (`routes/webhooks.ts`'s `handleRetryPipelineCommand`).
2. A Linear ticket flipping back to "Ready for AI" on a branch that already exists (`/webhooks/linear`'s handler: before treating it as a new ticket, `githubService.branchExists(owner, repo, "ai-agent/<TICKET-KEY>")` checks first; if true, it resolves the open PR via `findOpenPullRequestByHead` — which may be `undefined` if the branch exists but no PR was ever opened — and takes the resume branch instead of the new-ticket branch).

Both paths resolve `maxOrchestrationRetries` at trigger time (per-repo override in `projects.<name>.orchestration.maxOrchestrationRetries` falling back to the global `orchestration.maxOrchestrationRetries`, via `resolveMaxOrchestrationRetries()`, `config/schema.ts`) and enqueue an identically-shaped `agent-pipeline` job: `isRetry: true`, `maxOrchestrationRetries`, and `retryContext` (owner/repo/prNumber) when a PR is known — `undefined` otherwise, in which case comments fall back to normal `ticketSource`-based routing (the Linear path only, since `/caf-retry-pipeline` always has a PR by construction).

On the worker side, `execute()` branches on `job.isRetry`. It first confirms `ai-agent/<TICKET-KEY>` still exists on the remote (`gitService.remoteBranchExists`, CAF-RESUMEBRANCH-01) — a retry triggered after the PR already merged and GitHub auto-deleted the branch stops with an explicit comment instead of failing on a raw `git reset`/`git clone`, and never falls back to a fresh checkout off `baseBranch`. Then, for an **existing persistent-mode checkout** (`existsSync(repoPath/.git)`), it first runs `gitService.getWorkspaceStatus()` — a read-only `git status --short`, no fetch/reset — **before** touching anything: unexpected uncommitted residue there (e.g. a PIV run interrupted mid-write) stops the pipeline immediately with an explicit comment (including the raw `git status` output) and does **not** run `preflightCleanup`'s destructive reset, unlike the normal (non-retry) sync path, which logs-and-discards. Only once the workspace is confirmed clean (or is a fresh ephemeral clone, which has no prior state to check) does it sync onto the **existing** `ai-agent/<TICKET-KEY>` branch (`preflightCleanup`/`clone` against that branch, never `createBranch`).

`checkAndConsumeRetryBudget()` then reads `orchestration-state.json` — rejects with an explicit comment (no agents run) if no state exists or `orchestrationRetryCount` has already reached the limit, otherwise increments the shared counter, refreshes `ticketTitle`/`ticketDescription` from the stored state (a resume trigger carries no fresh ticket content of its own), and returns the state itself for the two gate-aware steps that follow:

- **Manual-change diff**: the just-synced HEAD is compared to the state's `lastKnownCommitSha` (the commit at the moment the gate failed). If they differ — a human committed to the branch in between — `gitService.diffStat()` computes a `--stat` diff, which is injected as context for the resumed agent (never a stop condition; only *uncommitted* residue, checked above, stops the pipeline).
- **Gate-aware resume**: the planner is skipped entirely. `state.lastFailedGate` (`implementation`/`qa`/`reviewer`) selects which artifact to read back (`verify-report.md`/`qa-report.md`/`review-notes.md` via the same readers `report-reader.ts` already exposes) and inject as context, and `tasks.md` is read directly from the already-synced branch instead of being freshly generated. Every `lastFailedGate` value converges on the exact same action — re-run the implementation agent(s) with that gate's artifact as context, then continue through the normal tail (verify-report check → QA gate+retry loop → reviewer gate+retry loop → docs → commit/push/PR) — because that tail is shared code (`runPipelineFromImplementation()`) between the normal path and every resume path, not a duplicated copy per gate.

When `retryContext` is set, every status comment for the run — including the eventual success comment — goes to that PR instead of back to the original Linear ticket/GitHub issue, since that's what the human is actually watching.

### Dynamic agent skip (`AGENT_SKIP_ENABLED`)

Off by default (`.env`, boolean) — with it false, every stage above runs unconditionally, byte-for-byte the pre-existing behavior. When true, Planner can mark the frontend/backend/QA/reviewer/documentation agents as not relevant for a ticket via an explicit `## Skip Agents` section in `tasks.md` (`- QA: reason`), parsed by `parseSkipDirectives()` in `task-router.ts`. A skip is only honored when the signal is unambiguous — an absent section, a malformed line, or an unrecognized agent name all parse to "not skipped," never to a skip. `routeTasks()` also gets a stricter empty-section check (`strictEmptyCheck`, only active behind this same flag) so a `## Backend Tasks` header with an empty/`(none)` body no longer spawns Backend Agent for nothing.

- Frontend/backend/documentation skips: not spawned, noted in `verify-report.md` (`appendSkipNote`) and via Telegram. Never leaves zero implementation agents running — if a skip directive would cover every section Planner routed to, it's ignored for safety and everything routes normally.
- QA/reviewer skips: same Telegram notification, **plus** an explicit `⚠️ Quality gate dilewati` warning block injected into the PR body (`buildQualityGateWarning`), since skipping these removes the pipeline's only correctness/quality checks before human review.

### Fail-fast on non-retryable agent errors

If an agent run fails with a `429` (API quota exhausted) or `404` (model not found/inaccessible), the pipeline stops cleanly — posts a Linear comment and returns — instead of letting BullMQ retry the whole job. Retrying a quota/config error immediately just repeats the same failure. Any other exit code/status falls through to the normal `throw` → BullMQ retry path. See `stopIfNonRetryable` in `run-agent-pipeline.use-case.ts`.

### Agent execution model (`spawn-agent.service.ts`)

Each agent is `spawn(config.claude.command, ['--agent', name, '--print', '--output-format', 'json', '--permission-mode', 'bypassPermissions'])` in the cloned workspace, prompt piped via stdin. Key details:
- `bypassPermissions` is deliberate: headless runs can't answer interactive tool-approval prompts, and each run happens inside the orchestrator's own scratch workspace, so it's safe here — do not remove this without understanding the tradeoff.
- Every spawn gets `CAF_HEADLESS=1` in its env **and** a `[SYSTEM CONTEXT: Environment = headless ...]` line prepended to the prompt (agents without a Bash tool can't read env). Neither is configurable.
- `--output-format json` is what `agent-cost-parser.ts` reads the run's cost from, for the dashboard.
- Timeout (`claude.agentTimeoutMs` in `caf.config.yaml`, default 30 min) is enforced in this service via `setTimeout`/SIGTERM→SIGKILL, not via BullMQ. BullMQ's `lockDuration` (35 min, see `infrastructure/queue/worker.ts`) is intentionally set above this so BullMQ doesn't flag the job stalled mid-escalation.
- Process kill-by-signal is distinguished from non-zero exit in `AgentRunResult`; both currently cause a full pipeline retry (no step-resume state is persisted for crashes).

The actual agent definitions (`caf-planner`, `caf-frontend`, `caf-backend`, `caf-qa`, `caf-reviewer`, `caf-documentation` — `KNOWN_AGENT_NAMES` in `config/schema.ts`) live in the **target repo** being operated on (its own `.claude/agents/`), not in this repo — this repo only knows their names and invokes them.

### Report contract

Agents communicate pipeline state by writing markdown files to `.caf/tasks/<TICKET-KEY>/` in the target repo's workspace (`taskDir()`), parsed by `infrastructure/reports/report-reader.ts` via simple regex: `\bSUCCESS\b` anywhere in `verify-report.md`, and line-anchored `Status:` (`qa-report.md`, exact `PASS`) and `Verdict:` (`review-notes.md`) lines — line-anchored because a free `\bPASS\b` match also hit unfilled template placeholders (CAF-QAREPORT-01). Any new gate/report type should follow this same loose-regex-over-markdown convention rather than requiring agents to emit structured JSON.

The one non-markdown file there is `orchestration-state.json` (`reports/orchestration-state.ts`), written by this orchestrator, not by agents: it carries the resume state (`orchestrationRetryCount`, `lastFailedGate`, `lastKnownCommitSha`, ticket title/description) and is what the dashboard's filesystem watcher keys on.

### Webhook intake (`routes/webhooks.ts`)

**`POST /webhooks/linear`** validates HMAC signature (`verifyLinearSignature`) and timestamp freshness before anything else, then dedupes by `Linear-Delivery` header via Redis (`delivery-dedupe.ts`) to survive Linear's at-least-once delivery. Only triggers the pipeline on an `Issue` `update` event where `updatedFrom` contains `stateId` (i.e. an actual state transition, not just any field edit) and the new `stateId` matches `linear.readyStateId`. `ENABLE_PIPELINE_TRIGGER` is a kill switch checked after all validation.

**`POST /webhooks/github`** validates `X-Hub-Signature-256` against `GITHUB_WEBHOOK_SECRET` (`verifyGitHubSignature`), dedupes by `X-GitHub-Delivery` (same `claimDelivery`, separate `github` namespace/TTL), acks `ping`, then routes on `X-GitHub-Event`:

- `issues` (action `labeled`, label = `github.readyLabel`) → `agent-pipeline` job with `ticketSource: 'github'`. GitHub Issues carry no ticket prefix, so the project is matched by repo (`findProjectByGithubRepo`, comparing each project's `repoCloneUrl`) and the ticket key is synthesized as `<ticketPrefix>-<issue number>`.
- `issue_comment` (action `created`, on a PR, not from a `Bot` account — the anti-self-trigger guard, since this service posts its own comments with the same token): `/caf-retry-pipeline` → resume (see above); `/caf-review` → `pr-review` job, mode `initial`; `/caf-fix-review` → `pr-review` job, mode `global`. Any other comment is ignored — no free-text intent parsing.
- `pull_request_review_comment` (action `created`, with `in_reply_to_id`, i.e. a reply in an inline thread) → `pr-review` job, mode `scoped`.
- Anything else (including `pull_request_review`, deliberately descoped) is ignored with a 200.

Every GitHub trigger checks `checkReviewPermission` (`vcs/github-permission.ts`: collaborator permission `write`/`maintain`/`admin`, fail-closed) before the kill switch. Rejections return 200 `ignored`, not 4xx, so GitHub doesn't mark the webhook as failing.

### PR review jobs (`run-pr-review.use-case.ts`)

Only works on PRs whose head branch is `ai-agent/<TICKET-KEY>` (the ticket key is derived from the branch; anything else throws). Always clones the PR head into a fresh ephemeral workspace, runs `caf-reviewer` once, and cleans up — never reuses or locks a persistent workspace. What happens with the output depends on mode:

- `initial` (`/caf-review`): the agent only writes `review-notes.md`; its verdict is posted as a real GitHub PR review (`createPullRequestReview`). If GitHub rejects it as a self-review (422, `SelfReviewRejectedError`), it is re-posted as a `COMMENT` review with the real verdict stated in the body.
- `scoped` / `global`: the agent fixes code and writes `fix-review-log.md` (one `### Comment <id> [INLINE path:line | GENERAL]` block per comment with `Status: FIXED|SKIPPED|NOT_APPLICABLE`, parsed by `readFixReviewLog`); this use case then replies to each GitHub comment and posts a summary comment.

Unlike the ticket pipeline, a failure here always throws (BullMQ retry) — there are no gates.

### Pipeline monitoring dashboard (`routes/dashboard-ui.ts`, `routes/events.ts`, `routes/pipelines.ts`)

Vanilla-JS SPA at `/dashboard`, backed by `/api/pipelines*` and an SSE stream at `/api/events/stream`, basic-auth gated. Off by default (`dashboard.enabled: false` in `caf.config.yaml`) — must be explicitly enabled, and `dashboard.basicAuthUser` (YAML) + `DASHBOARD_BASIC_AUTH_PASSWORD` (`.env`, secret) are both required once enabled (enforced via `superRefine`, same pairing pattern as the Telegram vars). Password comparison is timing-safe. If deployed behind a reverse proxy, ensure `/dashboard`, `/api/pipelines*`, and `/api/events/stream` are all proxied and served over HTTPS only — basic-auth credentials are plaintext over HTTP. See `docs/dashboard.md` for the full operator guide. (The previous Bull Board queue viewer at `/admin/queues` was removed — its client-side polling was adding load on top of an already resource-constrained VPS; this SSE-pushed dashboard is the queue-visibility surface now.)

PR review jobs are on both pages too (CAF-DASHBOARD-03). `RunPrReviewUseCase` — the `pr-review` job enqueued by a `/caf-review` PR comment (mode `initial`), a `/caf-fix-review` PR comment (`global`), or a reply in an inline review thread (`scoped`) — records its own `pipeline_runs` row (`kind = 'pr-review'`, id `pr-review:<jobId>`, plus `review_mode`/`review_result`) and `caf-reviewer` start/end events through `recordPrReview*`/`finalizePrReviewRun` in `pipeline-instrumentation.ts`. It never writes to the ticket's pipeline run row: that row stays unique per `(repo_id, ticket_id)` via a partial index, while a ticket can have any number of review rows. `/api/pipelines/:repoId/:ticketId` therefore always means the pipeline run; a review run is only reachable through `/api/pipelines/by-run/:runId`. A review run's `final_status` describes the job (`SUCCESS` = review posted, whatever the verdict); the verdict or FIXED/SKIPPED/NOT_APPLICABLE counts live in `review_result`. Any test that executes `RunPrReviewUseCase` must mock either `config` or `pipeline-instrumentation.js`, or it writes to the real `db.path`.

Both pages (`/dashboard` and `/dashboard/agent-floor`) share one retro design system: `ui/shared/design-system.css`, served at `/dashboard/ds.css` and linked before each page's own stylesheet. Tokens and reusable components (`.btn`, `.pill`, `.panel`, `.field`, `.stat`, `.log`, ...) go there; `dashboard.css`/`agent-floor.css` hold page-specific layout only. New UI uses the tokens, never raw colors — see "Design system" in `docs/dashboard.md`.

### v1 scope constraints (intentional, not gaps)

- Worker concurrency defaults to 1 (`queue.workerConcurrency` in `caf.config.yaml`) — concurrent Claude Code agent processes are expensive.
- No step-resume for crashes: any unexpected pipeline failure (thrown error, agent killed/timed out) retries the whole job from planner onward, up to `queue.jobAttempts`. The only mid-pipeline resume is the explicit, human-triggered gate resume described under "`/caf-retry-pipeline` resume".

### Workspace modes (`workspace.mode`, CAF-WSMODE-01)

`ephemeral` (default): every job clones into a fresh `job-<uuid>` dir under the project's `workspaceDir` and removes it afterwards. `persistent`: a ticket-pipeline job reuses `persistent-<repoName>` across runs — `preflightCleanup` does `fetch` + `checkout` + `reset --hard` + clean instead of a clone, logging an audit trail first if it is about to discard uncommitted changes. Things that follow from that:

- The persistent workspace is guarded by `workspace-lock.ts`, an **in-memory** lock: a second job for the same repo is rejected with a "workspace is busy" comment (clean return, not queued, not a BullMQ retry). In-memory is only correct because there is a single worker process — moving to multiple worker instances needs a Redis-backed lock.
- Persistent mode applies to the ticket pipeline only (`WorkspacePurpose` `'ticket-pipeline'`); PR-review jobs pass `'pr-review'` and are always ephemeral regardless of the setting.
- All git operations assert the target path is inside the workspace root (`assertInsideWorkspace`) — the destructive reset must never be able to run outside the orchestrator's own scratch dir.

### Per-project registry (`config/project-registry.ts`)

Multi-repo/multi-team routing is live, not global config: `caf.config.yaml`'s `projects:` map (validated by `project-config.schema.ts`) holds one entry per project — `ticketPrefix`, `repoCloneUrl`, `baseBranch`, `workspaceDir`, `agents.modelOverrides` — keyed by an arbitrary project name but re-keyed by `ticketPrefix` in the loaded `ProjectRegistry`. The webhook handler looks up the target project by the incoming ticket's key prefix (e.g. `ABC-123` → `ABC`; GitHub Issues are matched by repo instead) and carries the matched config through the job payload as `projectConfig` (a `JobProjectContext` subset, mapped by `project-context-mapper.ts`). `ticketPrefix` must be uppercase A-Z and unique; `workspaceDir` must be absolute and may not equal or nest inside another project's (cross-project `superRefine` in `project-config.schema.ts`) — the dashboard's per-project filesystem watchers rely on that. `ProjectRegistry.load()` fails startup fast if `projects:` is missing or empty — at least one project must be configured, or no ticket could ever match and the pipeline would silently never trigger.

## Config

Config is split two ways, both validated through `src/config/schema.ts` (zod):
- **Structural** (non-secret) fields — server port, Linear/GitHub API URLs, `github.readyLabel`, `claude.command`/`claude.agentTimeoutMs`, `workspace.dir`/`workspace.mode`, queue settings, `orchestration.maxOrchestrationRetries`, `agents.qa.maxRetries`/`agents.reviewer.maxRetries`, `agents.modelOverrides`, `openai.*`, `dashboard.*`, `db.path`, and the per-project `projects:` map — live in `caf.config.yaml` (copy from `caf.config.example.yaml`; the real file is gitignored and baked into the Docker image at build time).
- **Secrets** and operational toggles — `REDIS_URL`, `LINEAR_WEBHOOK_SECRET`, `LINEAR_API_KEY`, `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `ENABLE_PIPELINE_TRIGGER`, `AGENT_SKIP_ENABLED`, Telegram vars, `OPENAI_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `DASHBOARD_BASIC_AUTH_PASSWORD` — stay in `.env`. See `.env.example`/`caf.config.example.yaml` for full lists.

`linear.readyStateId` (in `caf.config.yaml`, must be a UUID) is required — startup fails fast if missing. Telegram vars (`TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`) are optional but must be set together (enforced via `superRefine`).

### Claude Code CLI auth

Exactly one of two auth paths must be configured for the spawned `claude` CLI:

- `openai.useOpenai: true` + `OPENAI_API_KEY` — routes agents through an Anthropic-compatible endpoint (`openai.baseUrl`, OpenRouter by default): `spawn-agent.service.ts` sets `ANTHROPIC_BASE_URL` and maps `OPENAI_API_KEY` to `ANTHROPIC_API_KEY`. Opt-in by flag, never inferred from the key being present.
- `openai.useOpenai: false` (the default) + `CLAUDE_CODE_OAUTH_TOKEN` in `.env` — native Claude Code CLI auth, passed through unchanged via `process.env` to the child process, not something this codebase reads or transforms.

`superRefine` in `schema.ts` fails startup fast if neither path is configured, rather than letting the first agent spawn fail silently mid-pipeline. The child env is always built on top of `process.env` (the CLI needs `PATH` etc.) — never rebuilt from scratch.

### Per-agent model routing

`agents.modelOverrides` in `caf.config.yaml` maps an agent name (`caf-planner`/`caf-frontend`/`caf-backend`/`caf-qa`/`caf-reviewer`/`caf-documentation`) to a model id, applied on top of `openai.defaultModel` when both are set; a project's own `projects.<name>.agents.modelOverrides` wins over the global map. The chosen model is passed as `ANTHROPIC_DEFAULT_SONNET_MODEL` + `ANTHROPIC_DEFAULT_HAIKU_MODEL` (both, so an agent definition that asks for a haiku alias doesn't 404 on a custom endpoint), independent of `openai.useOpenai`. Per-project overrides are only shape-validated at startup, so `spawn-agent.service.ts` re-checks them against the allowlist at spawn time and drops (with an error log) any that aren't listed. Every model id used — `openai.defaultModel` and every `modelOverrides` value — must appear byte-for-byte in `openai.allowedModels`; **fail-closed**: empty allowlist means no model is ever sent. This exists because a plausible-looking model id can still 404 at call time if it doesn't actually exist on the endpoint (`openai.baseUrl`) — the allowlist only catches typos/unlisted ids, not nonexistent ones, so each entry must be personally verified to work before being added.
