# Verify Report: CAF-DASHBOARD-01 (Task 1 + Task 2 only)

Status: SUCCESS

## Scope

Session was scoped to **Task 1 (DB schema & migration)** and **Task 2 (cost
tracking investigation)** only, per execution prompt. Task 3 onward not started.

## Attempt Log

1. Checked `package.json` — no DB/ORM dependency present. Added `better-sqlite3`
   (13.0.3) + `@types/better-sqlite3` — sync API, matches the ticket's storage
   choice (SQLite, no new infra) and the write-per-event usage pattern.
2. Added `db.path` to structural config (`caf.config.yaml` / `src/config/schema.ts`),
   default `./data/caf-dashboard.sqlite`. Named it `db.*`, not `dashboard.*` — that
   key is already taken by the existing Bull Board gate at `/admin/queues`.
3. Wrote migration (`src/infrastructure/db/schema.sql`) for `pipeline_runs` and
   `agent_events` exactly as specified in `tasks.md`, plus two indexes
   (`(repo_id, ticket_id)` unique on `pipeline_runs`, `pipeline_run_id` on
   `agent_events`) needed to make the required queries efficient.
4. `src/infrastructure/db/connection.ts` — idempotent `migrate()` (schema.sql is
   all `CREATE TABLE/INDEX IF NOT EXISTS`), `openDb(path)` (also used by tests via
   `:memory:`), and a lazy `getDb()` singleton for runtime use in Task 3.
5. `src/infrastructure/db/pipeline-run.repository.ts` — `PipelineRunRepository`
   with `upsertPipelineRun`, `insertEvent`, `getPipelineRuns(repoId?, pagination?)`,
   `getPipelineDetail(repoId, ticketId)`, matching the execution prompt's required
   function names plus `upsertPipelineRun` (needed since `agent_events` has an FK
   to `pipeline_runs.id`).
6. Added `pnpm db:migrate` script (`tsx src/infrastructure/db/migrate.ts`) — ran
   it twice against a clean `./data/` to confirm both first-run creation and
   idempotent re-run.
7. Task 2 investigation: `spawn-agent.service.ts` already spawns
   `claude --print --output-format json`. Ran a real `claude -p "..."
   --output-format json` locally and confirmed the result JSON carries
   `total_cost_usd` and a `usage` object (`input_tokens`/`output_tokens`)
   directly at the top level — no estimation needed, so this was a straight
   parse, not the "STOP, no cost data" gap path.
8. Wrote `src/infrastructure/agent/agent-cost-parser.ts` (`parseAgentUsage`) —
   parses `AgentRunResult.stdout`, returns `{ costUsd, inputTokens, outputTokens }`
   or `undefined` on malformed/non-JSON input (never throws). **Not wired into
   the pipeline** — the ticket's Task 2 "capture point at each spawn" and Task 3
   "event writer" overlap; wiring is left for Task 3, which is the explicit
   integration point (`run-agent-pipeline.use-case.ts`) and out of this
   session's scope.
9. Unit tests: `tests/unit/pipeline-run.repository.test.ts` (in-memory DB, 8
   cases: create/update-on-conflict, insertEvent shape, repoId filtering,
   ordering + pagination, detail lookup + not-found) and
   `tests/unit/agent-cost-parser.test.ts` (5 cases, including a fixture from
   the real CLI run above).
10. Ran full suite: `pnpm typecheck`, `pnpm lint`, `pnpm test` (all pre-existing
    tests too, to check for regressions).

## Acceptance Criteria (Task 1–2 relevant subset)

- [x] Histori pipeline run bisa disimpan di DB dan di-query lewat repository layer
      (REST endpoint itself is Task 5 — not in scope here)
- [x] DB write API surface designed so failures can be caught by the caller
      without throwing (repository methods throw on genuine DB errors; Task 3's
      writer is responsible for the try/catch-log-warn wrapper the AC requires —
      not yet wired, since Task 3 is out of scope)
- [ ] Cost tracking end-to-end (Task 2's "capture point per spawn" + Task 3 wiring) —
      parser done, wiring deferred to Task 3 by design (see Catatan)
- Not applicable this session: SSE, REST endpoints, frontend, real-repo e2e
  (Tasks 4–7)

## Quality Gate

- `pnpm typecheck` — PASS
- `pnpm lint` — PASS (pre-existing eslint.config.js module-type warning only,
  unrelated to this change)
- `pnpm test` — PASS, 28 files / 325 tests (13 new: 8 repository + 5 parser)
- `pnpm db:migrate` — PASS against a clean `./data/` dir, run twice (idempotency
  confirmed)

## Catatan

- **No STOP checkpoint hit for Task 2.** Confirmed by direct experiment (not
  just reading docs) that `claude --print --output-format json` already
  returns `total_cost_usd` — the ticket's two-options fork (manual token×rate
  estimate vs. no-cost-yet placeholder) doesn't apply; real cost data is
  directly available.
- Deliberately did **not** modify `run-agent-pipeline.use-case.ts` or
  `spawn-agent.service.ts` in this session — wiring `parseAgentUsage` +
  `insertEvent`/`upsertPipelineRun` into the actual pipeline call sites is
  Task 3's job (event writer at existing state-update points), and mixing it
  into this session would blur the Task 1/2 boundary the execution prompt set.
- `db.path` config default (`./data/caf-dashboard.sqlite`) is relative to
  process CWD — same convention as `workspace.dir`'s relative-ability in this
  codebase, but worth confirming intended absolute path for the actual VPS
  deploy target before Task 3 wiring goes live.
- No ambiguity found in existing folder/naming conventions — `src/infrastructure/db/`
  follows the same flat-adapter pattern as `git/`, `linear/`, `vcs/`, etc.

**Ready for review. Awaiting go-ahead before starting Task 3.**
