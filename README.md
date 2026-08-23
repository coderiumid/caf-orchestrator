# CAF Orchestrator

Linear webhook receiver + Claude Code agent pipeline orchestrator.

When a Linear ticket transitions into the "Ready for AI" workflow state, this service clones the target repo, runs a chain of headless `claude --agent <name>` processes (planner → frontend/backend → QA → reviewer → docs), pushes a branch, and reports results back on the Linear ticket.

## Architecture

Two processes, sharing Redis as the queue backend:

- **Web server** — Fastify app that receives and validates Linear webhooks, enqueues pipeline jobs.
- **Worker** — BullMQ worker that dequeues jobs and runs the agent pipeline.

Both must be running for tickets to actually be processed — the web server alone only accepts webhooks.

```
src/
├── domain/          interfaces (IGitService, IAgentRunner, ILinearClient, ...)
├── application/      use cases — RunAgentPipelineUseCase is the pipeline
├── infrastructure/   adapters — git, queue, Linear client, agent spawning, notifications
├── presentation/     Fastify app, routes, DTOs
└── config/           zod-validated env schema
```

See [CLAUDE.md](./CLAUDE.md) for a detailed walkthrough of the pipeline stages, agent execution model, and report contract.

## Requirements

- Node.js >= 22
- pnpm
- Redis
- `claude` CLI available on PATH, with agent definitions (`planner`, `frontend`, `backend`, `qa`, `reviewer`, `documentation`) configured in the **target repo's** `.claude/agents/`

## Setup

```bash
pnpm install
cp .env.example .env
# fill in REDIS_URL, LINEAR_WEBHOOK_SECRET, LINEAR_API_KEY, LINEAR_READY_STATE_ID, REPO_CLONE_URL
```

## Running

```bash
pnpm dev            # web server
pnpm dev:worker     # worker (separate process)
```

Production:

```bash
pnpm build
pnpm start
pnpm start:worker
```

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

## Configuration

All environment variables are validated through `src/config/schema.ts`. See `.env.example` for the full list and defaults. Required, no default:

- `REDIS_URL`
- `LINEAR_WEBHOOK_SECRET`, `LINEAR_API_KEY`, `LINEAR_READY_STATE_ID` (UUID of the "Ready for AI" workflow state)
- `REPO_CLONE_URL`

`TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` are optional (pipeline completion/failure notifications) but must be set together.

One of the following must be set, or startup fails fast: `caf.config.yaml`'s `openai.useOpenai: true` + `.env`'s `OPENAI_API_KEY` (currently the only wired-up path), or `.env`'s `CLAUDE_CODE_OAUTH_TOKEN` (native Claude Code CLI auth, passed through unchanged). See CLAUDE.md's "Claude Code CLI auth" section.

## v1 scope

- Single target repo (no per-ticket/team routing).
- Worker concurrency defaults to 1 — concurrent Claude Code agent processes are expensive.
- No step-resume: any pipeline failure retries the whole job from the planner onward.
