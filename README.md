# CAF Orchestrator

Webhook receiver + Claude Code agent pipeline orchestrator.

When a ticket becomes "Ready for AI" — a Linear ticket entering the configured workflow state, or a GitHub Issue getting the configured label — this service clones the target repo, runs a chain of headless `claude --agent <name>` processes (`caf-planner` → `caf-frontend`/`caf-backend` → `caf-qa` → `caf-reviewer` → `caf-documentation`), pushes an `ai-agent/<TICKET-KEY>` branch, opens a GitHub PR, and reports results back on the ticket.

It also runs AI review on existing PRs, driven by PR comments.

## What triggers it

| Trigger | Where | Result |
|---|---|---|
| Linear ticket moves into the `linear.readyStateId` state | `POST /webhooks/linear` | Full agent pipeline |
| GitHub Issue gets the `github.readyLabel` label (default `ready-for-ai`) | `POST /webhooks/github` | Full agent pipeline |
| `/caf-retry-pipeline` comment on a Draft PR, or a Linear ticket re-entering "Ready for AI" while its branch still exists | either webhook | Resume a pipeline that stopped at a gate |
| `/caf-review` comment on a PR | `POST /webhooks/github` | Full review, posted as a GitHub PR review |
| `/caf-fix-review` comment on a PR | `POST /webhooks/github` | Reviewer addresses every review comment on the PR |
| Reply inside an inline review thread | `POST /webhooks/github` | Reviewer addresses that one thread |

GitHub-side triggers require the commenter/labeler to have `write`, `maintain` or `admin` permission on the repo. The PR-comment triggers only work on PRs this pipeline produced (head branch `ai-agent/<TICKET-KEY>`). `ENABLE_PIPELINE_TRIGGER=false` is a kill switch for all of them.

When a pipeline gate (implementation verify, QA, reviewer) is exhausted, the work is not left stranded: the branch is pushed and a **Draft PR** is opened with the failing report as its body, so a human can either fix it by hand or comment `/caf-retry-pipeline`.

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
- `claude` CLI available on PATH, with agent definitions (`caf-planner`, `caf-frontend`, `caf-backend`, `caf-qa`, `caf-reviewer`, `caf-documentation`) present in the **target repo's** `.claude/agents/` — this repo only knows their names and invokes them

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

- `workspace.mode` — `ephemeral` (default, fresh clone per job) or `persistent` (reuse one checkout per repo; for large repos only).
- `agents.qa.maxRetries` / `agents.reviewer.maxRetries` — gate retries within one run (default 1 each).
- `orchestration.maxOrchestrationRetries` — how many times a gate-exhausted ticket can be resumed (default 2; overridable per project).
- `queue.jobAttempts`, `queue.workerConcurrency`, `claude.agentTimeoutMs`.
- `openai.*` and `agents.modelOverrides` — model routing. Every model id must be listed exactly in `openai.allowedModels`; the list is empty (nothing allowed) by default.
- `dashboard.enabled` / `dashboard.basicAuthUser`, `db.path`.

## Scope constraints

- Worker concurrency defaults to 1 — concurrent Claude Code agent processes are expensive.
- An unexpected failure (agent crash, timeout) retries the whole job from the planner onward. Only a pipeline that stopped cleanly at a gate can be resumed mid-way, and only on request.
- Persistent workspaces are locked in-process, so that mode assumes a single worker instance.
