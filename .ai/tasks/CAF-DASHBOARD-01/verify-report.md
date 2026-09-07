# Verify Report: CAF-DASHBOARD-01 (Task 1 + Task 2 + Task 3)

Status: SUCCESS

## Scope

Session 1 covered **Task 1 (DB schema & migration)** and **Task 2 (cost
tracking investigation)**. This update adds **Task 3 (event writer at
existing orchestration points)**. Task 4 onward not started.

---

## Task 1 — DB schema & migration

### Attempt Log

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
   `:memory:`), and a lazy `getDb()` singleton for runtime use.
5. `src/infrastructure/db/pipeline-run.repository.ts` — `PipelineRunRepository`
   with `upsertPipelineRun`, `insertEvent`, `getPipelineRuns(repoId?, pagination?)`,
   `getPipelineDetail(repoId, ticketId)`, matching the execution prompt's required
   function names plus `upsertPipelineRun` (needed since `agent_events` has an FK
   to `pipeline_runs.id`). Task 3 later added `finalizePipelineRun`.
6. Added `pnpm db:migrate` script (`tsx src/infrastructure/db/migrate.ts`) — ran
   it twice against a clean `./data/` to confirm both first-run creation and
   idempotent re-run.
7. Unit tests: `tests/unit/pipeline-run.repository.test.ts` (in-memory DB, 8
   cases: create/update-on-conflict, insertEvent shape, repoId filtering,
   ordering + pagination, detail lookup + not-found).

### Acceptance Criteria (Task 1 subset)

- [x] Histori pipeline run bisa disimpan di DB dan di-query lewat repository layer
      (REST endpoint itself is Task 5 — not in scope here)
- [x] Migration jalan bersih di environment kosong, query layer punya unit test dasar

---

## Task 2 — Instrumentasi cost tracking

### Attempt Log

1. **No STOP checkpoint hit.** `spawn-agent.service.ts` already spawns
   `claude --print --output-format json`. Ran a real `claude -p "..."
   --output-format json` locally and confirmed the result JSON carries
   `total_cost_usd` and a `usage` object (`input_tokens`/`output_tokens`)
   directly at the top level — no estimation needed, so this was a straight
   parse, not the "STOP, no cost data" gap path from `tasks.md`.
2. Wrote `src/infrastructure/agent/agent-cost-parser.ts` (`parseAgentUsage`) —
   parses `AgentRunResult.stdout`, returns `{ costUsd, inputTokens, outputTokens }`
   or `undefined` on malformed/non-JSON input (never throws).
3. Unit tests: `tests/unit/agent-cost-parser.test.ts` (5 cases, including a
   fixture from the real CLI run above).
4. Wiring into the actual pipeline spawn points was deferred to Task 3 (this
   update) — see below.

### Acceptance Criteria (Task 2 subset)

- [x] Cost tracked from a real agent run's stdout (`total_cost_usd`), now
      wired into every planner/frontend/backend/qa/reviewer spawn (Task 3)

---

## Task 3 — Event writer di titik existing

### Attempt Log

1. Read through `run-agent-pipeline.use-case.ts` end to end to find every
   point that already updates `orchestration-state.json` or spawns an agent:
   `execute()` top (pipeline start), the `caf-planner` spawn, the shared
   `runImplementationAgents()` loop (frontend/backend), `runQaGate()`,
   `runReviewerGate()`, the QA/reviewer retry `while` loops,
   `recordGateExhaustion()` (the existing gate-exhaustion write point), the
   success path next to `resetOrchestrationState()`, the top-level `catch`,
   and the two early-reject branches in `checkAndConsumeRetryBudget()` plus
   the retry-sync "uncommitted changes" abort — the latter three don't touch
   `orchestration-state.json` themselves but are pipeline-terminal points that
   would otherwise leave `pipeline_runs` stuck showing "running" forever.
2. Added `src/infrastructure/db/pipeline-instrumentation.ts` — the only module
   `run-agent-pipeline.use-case.ts` now imports from `infrastructure/db/*`.
   Every exported function (`recordPipelineStarted`, `finalizePipelineRun`,
   `recordAgentEvent`, `recordAgentEnd`) wraps its DB call in try/catch and
   logs via `logger.warn(...)` on failure — **never throws**, satisfying the
   AC directly (no changes needed in the use-case's own control flow to
   guard these calls).
3. Wired calls at each point above:
   - `execute()` top: `recordPipelineStarted` (creates/resets the
     `pipeline_runs` row — resets `ended_at`/`final_status` to null on every
     attempt, including a BullMQ retry or a `/caf-retry-pipeline` resume,
     since a new attempt hasn't concluded yet; `started_at` is preserved
     across resets by `upsertPipelineRun`'s `ON CONFLICT` clause).
   - Each real agent spawn (planner/frontend/backend/qa/reviewer):
     `recordAgentEvent(..., 'start')` before, `recordAgentEnd(...)` after
     (parses `total_cost_usd` from stdout via Task 2's `parseAgentUsage`).
     `caf-documentation` deliberately **not** instrumented — same exclusion
     as Task 2's capture-point list (`planner, frontend, backend, qa,
     reviewer` only), and there's no PIV phase for it under the schema's
     `CHECK (piv_phase IN ('plan','implement','verify'))` constraint anyway.
   - QA/reviewer retry loops: one `'retry'` event per retry iteration,
     `retryCount` = the loop's own counter, agent = the gate that failed
     (`caf-qa`/`caf-reviewer`).
   - `recordGateExhaustion()`: extended (already the sole existing
     `orchestration-state.json` gate-failure write point) to also write a
     `'gate_exhausted'` event with `artifactLink` pointing at the gate's
     report file, and to `finalizePipelineRun(..., 'NEEDS_HUMAN')`.
   - Success path: `finalizePipelineRun(..., 'SUCCESS')` right next to
     `resetOrchestrationState()`.
   - Top-level `catch`: `NonRetryableApiError` → `finalizePipelineRun(...,
     'NEEDS_HUMAN')` (already reported as a human-facing stop elsewhere);
     any other thrown error → `finalizePipelineRun(..., 'ERROR')` (BullMQ
     will still retry the whole job — this just reflects the last known state
     until the next attempt's `recordPipelineStarted` resets it).
   - The three early-terminal branches identified in step 1 (retry-budget
     rejected twice, uncommitted-changes abort) → `finalizePipelineRun(...,
     'NEEDS_HUMAN')`, since `recordPipelineStarted` already ran at the top of
     `execute()` and would otherwise leave the row looking permanently "in
     progress".
4. Repository layer: added `finalizePipelineRun(id, endedAt, finalStatus)` to
   `PipelineRunRepository` (plain `UPDATE`, no-op if the row doesn't exist).
5. Tests — two new integration-style files driving the real (unmocked)
   `pipeline-instrumentation.ts` + a real on-disk SQLite file through the full
   `RunAgentPipelineUseCase.execute()` (only the git/agent-runner/vcs/linear/
   notifier ports and the task-router/report-reader/orchestration-state
   modules are mocked, same pattern as the existing pipeline test suite):
   - `tests/unit/pipeline-instrumentation-integration.test.ts` (3 cases):
     success path asserts the exact `agent_events` order (planner→backend→
     qa→reviewer, each start+end) and that cost parsed from a real
     `--output-format json`-shaped stdout fixture lands on the `end` row;
     one QA-fail-then-pass run asserts a single `'retry'` row
     (`retryCount: 1`); one QA-always-fails run asserts a `'gate_exhausted'`
     row and `pipeline_runs.final_status = 'NEEDS_HUMAN'`.
   - `tests/unit/pipeline-instrumentation-db-unavailable.test.ts` (1 case):
     `db.path` points at a path that can never be opened (a plain file used
     as a directory segment, so every `mkdirSync` throws `ENOTDIR`) —
     asserts the pipeline still completes normally (PR created, `git push`
     called, `notifyPipelineComplete` fired) and that every DB failure logs
     via `logger.warn` (never `logger.error`, never thrown).
6. Existing `run-agent-pipeline.use-case.test.ts` still passes unmodified —
   its `configMock` has no `db` key, so `pipeline-instrumentation.ts` there
   hits `config.db.path === undefined` and every write fails-safe into a
   swallowed warning, same as the dedicated DB-unavailable test above
   (unintentional but consistent extra coverage of the same fail-safe path).

### Verify

- Ran a real pipeline through the use case (via the integration test) and
  confirmed `agent_events` fills in actual event order — done via test
  rather than a live `umkm-pos` run, since that's Task 7's real-repo e2e,
  out of scope here.
- Simulated DB unavailable (dedicated test) — pipeline completed normally,
  no throw, only `logger.warn`.

### Acceptance Criteria (Task 3 subset)

- [x] DB write di titik instrumentasi tidak boleh menjatuhkan pipeline utama
      kalau gagal (log warning, bukan throw) — verified by dedicated test

---

## Quality Gate

- `pnpm typecheck` — PASS
- `pnpm lint` — PASS (pre-existing eslint.config.js module-type warning only,
  unrelated to this change)
- `pnpm test` — PASS, 30 files / 329 tests
- `pnpm db:migrate` — PASS against a clean `./data/` dir, run twice (idempotency
  confirmed)

## Catatan

- `db.path` config default (`./data/caf-dashboard.sqlite`) is relative to
  process CWD — same convention as `workspace.dir`'s relative-ability in this
  codebase, but worth confirming intended absolute path for the actual VPS
  deploy target before real-repo (Task 7) traffic hits it.
- `pipeline_runs` id is deterministic (`repoId:ticketId`, both from data
  already in `job`/`job.projectConfig`) so a BullMQ retry or a
  `/caf-retry-pipeline` resume reuses the same row instead of creating a
  duplicate — no new field needed on `ExistingJobPayload` for this.
- No ambiguity found in existing folder/naming conventions — `src/infrastructure/db/`
  follows the same flat-adapter pattern as `git/`, `linear/`, `vcs/`, etc.
- Not touched: Task 4 (SSE/chokidar), Task 5 (REST endpoints), Task 6
  (frontend), Task 7 (real-repo e2e — the AC item "Real-repo end-to-end test
  PASS di `umkm-pos`" in `requirements.md` is explicitly that task, not
  claimed here) or Task 8 (docs).

**Ready for review. Awaiting go-ahead before starting Task 4.**
