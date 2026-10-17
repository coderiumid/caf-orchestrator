# CAF Orchestrator

Webhook receiver + Claude Code agent pipeline orchestrator.

When a ticket becomes "Ready for AI" — a Linear ticket entering the configured workflow state, or a GitHub Issue getting the configured label — this service clones the target repo, runs a chain of headless `claude --agent <name>` processes (`caf-planner` → `caf-frontend`/`caf-backend` → `caf-qa` or `caf-validator` → `caf-reviewer` → `caf-documentation`, when the repo has it), pushes an `ai-agent/<TICKET-KEY>` branch, opens a GitHub PR, and reports results back on the ticket.

It also runs AI review on existing PRs, driven by PR comments.

## What triggers it

| Trigger | Where | Result |
|---|---|---|
| Linear ticket moves into the `linear.readyStateId` state | `POST /webhooks/linear` | Full agent pipeline |
| GitHub Issue gets the `github.readyLabel` label (default `ready-for-ai`) | `POST /webhooks/github` | Full agent pipeline |
| `/caf-retry-pipeline` comment on a Draft PR, or a Linear ticket re-entering "Ready for AI" while its branch still exists | either webhook | Resume a pipeline that stopped at a gate |
| `/caf-approve-spec` comment on a spec Draft PR | `POST /webhooks/github` | Approve the spec and continue with implementation (see below) |
| `/caf-review` comment on a PR | `POST /webhooks/github` | Full review, posted as a GitHub PR review |
| `/caf-fix-review` comment on a PR | `POST /webhooks/github` | Reviewer addresses every review comment on the PR |
| Reply inside an inline review thread | `POST /webhooks/github` | Reviewer addresses that one thread |

GitHub-side triggers require the commenter/labeler to have `write`, `maintain` or `admin` permission on the repo. The PR-comment triggers only work on PRs this pipeline produced (head branch `ai-agent/<TICKET-KEY>`). `ENABLE_PIPELINE_TRIGGER=false` is a kill switch for all of them.

When a pipeline gate (implementation verify, QA, reviewer) is exhausted, the work is not left stranded: the branch is pushed and a **Draft PR** is opened with the failing report as its body, so a human can either fix it by hand or comment `/caf-retry-pipeline`.

### Clarify and the spec gate

When the target repo keeps a spec at `.caf/tasks/<TICKET-KEY>/requirements.md` (an anchored `Status:` line, written by the planner), the pipeline reads it right after the planner and does not run implementation agents on a spec that is unclear or not yet approved:

- **Clarify** — `Status: NEEDS_CLARIFICATION`, or `Status: DRAFT` with a `[BLOCKING]` question that has no answer yet, always stops the pipeline, with or without the gate label. The draft spec is committed and pushed to `ai-agent/<TICKET-KEY>` (no PR), and a comment on the ticket lists every `- Q-n [BLOCKING] ...` question that has no `— Answer:` yet. Answer in a comment on the ticket, then move a Linear ticket back to "Ready for AI" / remove and re-apply the `github.readyLabel` label on a GitHub Issue. The planner continues the saved draft with the comments written after the last clarification request (comments from bot accounts are skipped). The clarification comment starts with `❓ CAF-CLARIFY`; only comments after the last one carrying that marker are read as answers, so deleting that comment makes every human comment on the ticket count as an answer.
- **Spec gate** — a ticket carrying the gate label (`spec-approval` by default) stops after the planner with `Status: DRAFT` (and no open BLOCKING question — that is a Clarify): the spec folder is pushed and a Draft PR holding only the spec is opened. Review it (edit on the branch if needed), then comment `/caf-approve-spec` on the PR. The orchestrator changes only the `Status:` line to `APPROVED`, commits and pushes that, and resumes from implementation, skipping the planner. It refuses (and says why on the PR) if the PR is not waiting for approval, the spec is `NEEDS_CLARIFICATION`, or a BLOCKING question is unanswered. Tickets without the label run straight through after the planner. When a resumed run (retry or approved spec) finally succeeds, the orchestrator updates that PR and marks it Ready for review; if GitHub refuses, the PR stays a Draft and the ticket comment says why.
- Neither a Clarify answer nor a spec approval uses up `orchestration.maxOrchestrationRetries`: waiting for a person is not a failure.
- A repo without `requirements.md`, or whose file has no `Status:` line, is unaffected: no Clarify and no gate.
- A ticket whose `ai-agent/<TICKET-KEY>` branch already exists but has no `orchestration-state.json` gets a "nothing to resume" comment when re-triggered; delete the branch to restart it.

The gate label is configured with `linear.specGateLabel` and `github.specGateLabel` in `caf.config.yaml` (both default `spec-approval`); a project can override either under `projects.<name>.linear` / `projects.<name>.github`. It is read from the labels on the ticket at the moment the ready trigger arrives.

## Architecture

Two processes, sharing Redis as the queue backend:

- **Web server** — Fastify app that receives and validates Linear/GitHub webhooks, enqueues jobs, and serves the monitoring dashboard.
- **Worker** — BullMQ worker that dequeues jobs and runs them: `agent-pipeline` (ticket → PR) and `pr-review` (PR comment → review).

Both must be running for anything to actually be processed — the web server alone only accepts webhooks.

```
src/
├── domain/          interfaces (IGitService, IAgentRunner, ILinearClient, IVcsClient, ...) and errors
├── application/     use cases — RunAgentPipelineUseCase (the pipeline), RunPrReviewUseCase
├── infrastructure/  adapters — git, queue, Linear, GitHub, agent spawning, reports,
│                    SQLite run history, filesystem watcher, Telegram
├── presentation/    Fastify app, routes, DTOs, dashboard UI
└── config/          zod-validated config (.env + caf.config.yaml), project registry
```

See [CLAUDE.md](./CLAUDE.md) for a detailed walkthrough of the pipeline stages, gates, resume mechanics, agent execution model, and report contract.

### Dashboard

A live pipeline-monitoring dashboard (PIV phase, retry counts, cost, artifact links, PR review runs, real-time via SSE) is available at `/dashboard`, with an animated "Agent Floor" view at `/dashboard/agent-floor`. It is off by default and basic-auth gated. See [docs/dashboard.md](./docs/dashboard.md) for access and how to read it.

Run history is stored in a SQLite file (`db.path`, default `./data/caf-dashboard.sqlite`), written by the worker and read by the web server.

## Requirements

- Node.js >= 22
- pnpm
- Redis
- `git`, with push access to the target repo(s)
- `claude` CLI available on PATH, with agent definitions (`caf-planner`, `caf-frontend`, `caf-backend`, `caf-qa` or `caf-validator`, `caf-reviewer`, optionally `caf-documentation`) present in the **target repo's** `.claude/agents/` — this repo only knows their names and invokes them

Both generations of target repo work without any config change. The pipeline looks at the checkout: with `.claude/agents/caf-validator.md` it runs `caf-validator` and reads `validate-report.md` (falling back to `qa-report.md`), otherwise `caf-qa` and `qa-report.md`; without `.claude/agents/caf-documentation.md` the docs step is skipped instead of failing. Reports are read the same way for both: an anchored `Status:` line (`PASS` for the gate report, `SUCCESS` for `verify-report.md`, which falls back to "`SUCCESS` anywhere" only when it has no `Status:` line), and fix-review notes as either `Notes:` or `Catatan:`.

**Acceptance criteria and `UNVERIFIED` (CAF-SDD-04b).** In a repo that ships `caf-validator` (the only gate agent that writes a per-AC table; a `caf-qa` repo gets no summary and no `UNVERIFIED` rule), when the ticket's `requirements.md` has `- AC-n:` lines, the orchestrator counts each AC against the per-AC table of the gate report (`validate-report.md` / `qa-report.md`) and puts a deterministic summary (PASS / FAIL / UNVERIFIED counts, the UNVERIFIED list with reasons, and any `Proposed Spec Changes:` line from the report's `### Notes`) at the top of the PR body — normal and Draft PRs alike, with the artifact text below it unchanged. An AC missing from the report counts as `UNVERIFIED` ("tidak dilaporkan"). The gate passes when there is no `FAIL`; the one exception is a report that says `Status: PASS` while *every* AC is `UNVERIFIED` — nothing was proven, so it is treated as `NEEDS_HUMAN` (Draft PR and comment, no retry). Without any `AC-n` line in `requirements.md` none of this applies.

The resume state names the validation gate `validate` (`orchestration-state.json`, `lastFailedGate`); a stored `qa` from older runs is still read, as the same gate. Comments and PR bodies keep saying "qa". `/caf-fix-review` jobs never edit `requirements.md` or `tasks.md`: a comment asking for a spec change is logged under `## Proposed Spec Changes` in `fix-review-log.md` and marked `Status: SKIPPED`.

A target repo that is a single app (not split front/back) is set up with `--role frontend|backend` — the orchestrator does not route `caf-implementer`.

## Setup

```bash
pnpm install
cp .env.example .env                           # secrets and operational toggles
cp caf.config.example.yaml caf.config.yaml     # structural config
```

Then fill in both files (see [Configuration](#configuration)) and point the webhooks at the service:

- Linear: webhook to `POST /webhooks/linear`, secret = `LINEAR_WEBHOOK_SECRET`.
- GitHub (per target repo): webhook to `POST /webhooks/github`, secret = `GITHUB_WEBHOOK_SECRET`, events `Issues`, `Issue comments`, `Pull request review comments`.

## Running

```bash
pnpm dev            # web server
pnpm dev:worker     # worker (separate process)
```

Production (bare):

```bash
pnpm build
pnpm start
pnpm start:worker
```

Production (Docker): `docker-compose.yml` runs `redis`, `api` and `worker` from one image. `./deploy.sh` pulls `origin/main`, rebuilds the image and restarts the services; the GitHub Actions workflow (`.github/workflows/deploy.yml`) runs typecheck, lint, test and build on every push/PR, then calls `deploy.sh` on the VPS over SSH for pushes to `main`.

`GET /health` reports Redis and workspace-disk status (200 healthy, 503 otherwise).

## Scripts

| Script | Purpose |
|---|---|
| `pnpm dev` | run web server (tsx, no build) |
| `pnpm dev:worker` | run worker (tsx, no build) |
| `pnpm build` | compile TypeScript to `dist/` |
| `pnpm start` / `pnpm start:worker` | run compiled output |
| `pnpm lint` | eslint over `src` |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | vitest, single run |
| `pnpm test:watch` | vitest watch mode |
| `pnpm test:coverage` | vitest with v8 coverage |
| `pnpm db:migrate` | create/upgrade the SQLite run-history database at `db.path` |

## Configuration

Config is split across two files, both validated at startup through `src/config/schema.ts` — an invalid or incomplete config fails fast.

### `.env` — secrets and operational toggles

Required:

- `REDIS_URL`
- `LINEAR_WEBHOOK_SECRET`, `LINEAR_API_KEY`
- `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET`
- Claude Code CLI auth, one of:
  - `CLAUDE_CODE_OAUTH_TOKEN` (native Claude Code CLI auth, passed through unchanged), or
  - `OPENAI_API_KEY` together with `openai.useOpenai: true` in `caf.config.yaml` (routes agents through an Anthropic-compatible endpoint such as OpenRouter)

Optional:

- `ENABLE_PIPELINE_TRIGGER` (default `true`) — kill switch.
- `AGENT_SKIP_ENABLED` (default `false`) — lets the planner skip agents that are not relevant for a ticket.
- `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` — pipeline notifications; must be set together.
- `DASHBOARD_BASIC_AUTH_PASSWORD` — required once `dashboard.enabled: true`.
- `NODE_ENV`, `LOG_LEVEL`.

### `caf.config.yaml` — structural config

See `caf.config.example.yaml` for every field and its default. The parts you must set:

- `linear.readyStateId` — UUID of the "Ready for AI" workflow state.
- `projects:` — at least one entry. Each project has a `ticketPrefix` (e.g. `ABC` for `ABC-123`), `repoCloneUrl`, `baseBranch` and an absolute `workspaceDir`. Linear tickets are routed to a project by ticket prefix, GitHub Issues by repository. Prefixes must be unique and workspace dirs must not overlap.

Commonly tuned:

- `linear.specGateLabel` / `github.specGateLabel` — label that puts a ticket behind spec approval (default `spec-approval`; overridable per project).
- `workspace.mode` — `ephemeral` (default, fresh clone per job) or `persistent` (reuse one checkout per repo; for large repos only).
- `agents.qa.maxRetries` / `agents.reviewer.maxRetries` — gate retries within one run (default 1 each).
- `agents.validator.restrictBash` / `agents.validator.allowedCommands` — `caf-validator` only (`caf-qa` and all other agents are unaffected). With `restrictBash: true` (default) the validator runs under `--permission-mode dontAsk --setting-sources project`: Bash is limited to `allowedCommands` (default: `pnpm run *`, `pnpm test [*]`, `pnpm --filter * run *|test [*]`, `npm run *`, `npm test [*]`; no `npx`, `pnpm dlx` or `pnpm exec`, which would allow arbitrary commands through the runner), writes are limited to `.caf/tasks/` (an `Edit(...)` rule; a `Write(...)` rule is never consulted), user-level Claude settings are ignored, and `REDIS_URL`, `LINEAR_*`, `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `TELEGRAM_*` and `DASHBOARD_BASIC_AUTH_PASSWORD` are removed from its environment. `restrictBash: false` restores the previous behavior. Residual risk: the GitHub token stays in the workspace `.git/config` (origin URL), readable by the validator.
- `orchestration.maxOrchestrationRetries` — how many times a gate-exhausted ticket can be resumed (default 2; overridable per project).
- `queue.jobAttempts`, `queue.workerConcurrency`, `claude.agentTimeoutMs`.
- `openai.*` and `agents.modelOverrides` — model routing. Every model id must be listed exactly in `openai.allowedModels`; the list is empty (nothing allowed) by default.
- `dashboard.enabled` / `dashboard.basicAuthUser`, `db.path`.

## Scope constraints

- Worker concurrency defaults to 1 — concurrent Claude Code agent processes are expensive.
- An unexpected failure (agent crash, timeout) retries the whole job from the planner onward. Only a pipeline that stopped cleanly at a gate can be resumed mid-way, and only on request.
- Persistent workspaces are locked in-process, so that mode assumes a single worker instance.
