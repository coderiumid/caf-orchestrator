# Verify Report: CAF-DASHBOARD-01 (Task 1 through Task 8)

Status: NEEDS_HUMAN

Tasks 1-6 and 8's own work is SUCCESS (unchanged from before, all gates
still green). The overall status stays NEEDS_HUMAN because Task 7's
real-repo end-to-end test against `umkm-pos` — an explicit `requirements.md`
acceptance criterion — was deliberately not run this session; see Task 7's
section below for why and what's needed to close it. Everything else in
`tasks.md` (Tasks 1-6, 8) is complete.

## Scope

Prior sessions covered **Task 1** (DB schema & migration), **Task 2** (cost
tracking investigation), **Task 3** (event writer at existing orchestration
points), **Task 4** (file watcher + SSE stream), **Task 5** (REST
endpoints), **Task 6** (frontend SPA), and **Task 7** (verify — unit-level
done, real-repo e2e deliberately deferred, asked not guessed). This update
adds **Task 8 (documentation)** — the last task in `tasks.md`.

---

## Task 6 — Frontend SPA

### Attempt Log

1. Found a real gap before writing any UI: Task 5's `GET /api/pipelines`
   summary row (`repoId, ticketId, ticketTitle, startedAt, endedAt,
   finalStatus, status`) has none of the columns Task 6 needs (current PIV
   phase, retry count per gate, running cost, artifact link) — those only
   exist on `agent_events`. Extended `pipelines.ts` (not a new file) rather
   than treating this as a Task 5 regression: added
   `PipelineRunRepository.getEventsForRun(pipelineRunId)` and a
   `summarizeEvents()` helper computing `currentPivPhase` (phase of the
   latest event), `retryCounts` (per-agent-name, taking the max `retryCount`
   seen — each `'retry'` event already carries the retry loop's own running
   counter, so this is a max, not a row count), `totalCostUsd` (sum of every
   event's `costUsd`, or `null` — not `0` — when no event has cost data yet,
   so a client can tell "no data" from "genuinely free"), and
   `lastArtifactLink` (most recent event with one). Applied to both
   `GET /api/pipelines` and the detail endpoint so the shape stays uniform
   (Task 5's "response shape konsisten" AC extends naturally to this).
   Costs one extra `getEventsForRun` query per row in the list endpoint —
   accepted given the ticket's own "skala VPS kecil" framing.
2. `src/presentation/web/ui/dashboard-page.ts` — the whole SPA as one
   exported HTML string: vanilla JS (no framework, no bundler, no build
   step — satisfies "tanpa build step berat" literally), inline `<style>`,
   dark theme. On load: `fetch('/api/pipelines')` renders the table (repo,
   ticket+title, phase, retry counts, cost or "belum tersedia", status
   badge, artifact link). `new EventSource('/api/events/stream')`
   reconnects automatically (native `EventSource` behavior) and, on any
   message, refetches the table plus the open detail panel — Task 4's SSE
   events are a "something changed" signal, not a full payload, so refetch
   is the correct reaction, not an attempt to patch client state from a
   partial event. Clicking a row fetches
   `/api/pipelines/:repoId/:ticketId` and renders its `events` as a
   timeline (agent, event type, retry #, phase, cost, artifact, timestamp).
   A connection-status dot reflects `EventSource.onopen`/`onerror`.
3. `src/presentation/web/routes/dashboard-ui.ts` — `GET /dashboard` serves
   the page. Named `dashboard-ui.ts`, not `dashboard.ts`, to avoid clashing
   with the existing Bull Board route file. Same gating pattern as
   `pipelines.ts`/`events.ts`: `config.dashboard.enabled` +
   `registerDashboardBasicAuth` (Task 5's shared helper) — no new auth
   code, no separate credential.
4. Registered in `app.ts`.
5. No client-side auth code needed: the page itself sits behind the same
   basic auth, so once the browser has the credentials cached for the
   realm (from loading `/dashboard` itself), plain `fetch()`/`EventSource`
   calls to same-origin `/api/*` automatically carry them.
6. Browser-verified per CLAUDE.md's UI-change rule — actually ran the app,
   not just unit tests:
   - Started `pnpm dev` against the real (dev) config/DB, confirmed via
     `curl`: `/dashboard` → 401 with no auth, 200 with correct Basic Auth;
     `/api/pipelines` → `[]` on an empty DB.
   - Seeded 3 realistic rows (one running with a retry, one `SUCCESS`, one
     `NEEDS_HUMAN` with an artifact link) directly into the dev SQLite file
     via a throwaway script (deleted after).
   - Chrome's native HTTP Basic Auth dialog isn't a page element — CDP
     screenshot/input can't drive it (confirmed: `Frame with ID 0 is
     showing error page` while the dialog was up, and typed keystrokes
     didn't reach it). Basic-auth gating itself is already proven by
     `dashboard-ui.test.ts`/`pipelines-route.test.ts`'s 401/200 assertions,
     so for the visual/interaction check only, stood up a throwaway
     unauthenticated proxy (`scratch-browser-harness.ts`, deleted after)
     that served the exact same `DASHBOARD_HTML` and forwarded `/api/*`
     calls to the real authenticated dev server with credentials attached
     server-side — same rendering code, same real data, just without
     fighting a native OS dialog in the automation harness.
   - Screenshot 1: table renders all 3 rows correctly — phase `verify`,
     `qa: 1` retry, `$0.1400` cost, `RUNNING` badge for the live one;
     `belum tersedia` for the `NEEDS_HUMAN` row with no cost data yet and
     its artifact path shown; `SUCCESS` badge + `$0.0700` for the finished
     one. Connection dot shows "live" (real `EventSource` connected).
   - Screenshot 2: clicked the running row — detail panel opens beside the
     table, row highlights, timeline shows all 6 real events in order
     (`caf-planner START/END`, `caf-backend START/END`, `caf-qa
     START/RETRY #1`) with correct phase/cost/timestamp per line.
   - Cleaned up: killed both dev processes, deleted the two scratch files
     and the demo SQLite data dir — nothing left behind.

### Verify

- "Buka dashboard di browser, pipeline yang lagi jalan update tanpa refresh
  manual" — the SSE wiring itself (reconnect, fan-out, correct tagging) was
  already proven end-to-end in Task 4's tests; this session additionally
  confirmed in a real browser that the page establishes the `EventSource`
  connection and shows "live". Did not trigger a live orchestration-state.json
  change against the dev server during this check (no project workspace was
  actively running) — that combination (real pipeline run + open dashboard
  tab) is Task 7's real-repo e2e scope, not re-claimed here.
- "Klik row nampilin histori lengkap" — verified directly in the browser
  (screenshot 2 above), not just asserted in a unit test.

### Catatan

- `retryCounts`/`totalCostUsd`/`currentPivPhase`/`lastArtifactLink` are
  computed per-request from `agent_events`, not stored — keeps
  `agent_events` the single source of truth instead of a second
  denormalized copy on `pipeline_runs` that could drift.
- The dashboard page has zero external dependencies (no CDN scripts, no
  npm frontend packages) — everything is inline in one `.ts`-exported
  string, matching "tanpa build step berat" as literally as possible.
- Not touched: Task 7 (real-repo e2e), Task 8 (docs).

---

## Task 5 — REST endpoints

### Design decision (asked, not guessed)

`tasks.md` Task 5 says `GET /api/pipelines` should "merge live (state.json) +
histori (DB)". But `orchestration-state.json` is only ever written on a gate
failure/retry and deleted on success (never on phase start), and under the
default `workspace.mode: 'ephemeral'` its containing folder is deleted by
`cleanupWorkspace` the moment `execute()` returns — so reading it from disk
at REST-query time (as opposed to Task 4's push-time watch) can't reliably
reflect anything for the default config. Task 3 already gives a real,
mode-independent "is this running right now" signal: a `pipeline_runs` row
with `final_status IS NULL`. Asked the user which to use for
`GET /api/pipelines`'s "live" half — chose **DB-only**: the endpoint reads
only `pipeline_runs` (`final_status IS NULL` = running, set = history), no
on-disk read of `orchestration-state.json` in this endpoint at all. This also
means Task 5's other AC ("response shape konsisten antara data live dan data
histori") is automatically satisfied — live and history rows come from the
exact same query against the exact same table, so there's no separate merge
step that could produce divergent shapes.

### Attempt Log

1. Extracted `src/presentation/web/auth/dashboard-basic-auth.ts`
   (`registerDashboardBasicAuth`) out of `dashboard.ts`, which used to inline
   the `@fastify/basic-auth` setup + timing-safe compare. Same credentials
   (`config.dashboard.basicAuthUser` / `DASHBOARD_BASIC_AUTH_PASSWORD`), same
   validate logic — now one function three route files call, instead of a
   second copy that could drift. `dashboard.ts` itself was refactored to call
   it (behavior unchanged — same 3 existing dashboard tests still pass
   unmodified).
2. `src/presentation/web/routes/pipelines.ts`:
   - `GET /api/pipelines?repoId=<optional>` → `PipelineRunRepository.getPipelineRuns(repoId)`,
     mapped to a flat JSON shape (`repoId, ticketId, ticketTitle, startedAt,
     endedAt, finalStatus, status`) where `status` is `finalStatus ??
     'RUNNING'` — a convenience field, `finalStatus` itself stays `null` on a
     running row so a client can tell "explicitly null" from "any other
     value" without string-matching `'RUNNING'`.
   - `GET /api/pipelines/:repoId/:ticketId` → `getPipelineDetail`, same flat
     shape plus an `events` array (the row's `agent_events`, already
     camelCase from the repository). 404 if no run matches. `repoId` is
     `owner/repo` (contains a `/`) — callers percent-encode it
     (`ganjardbc%2Fumkm-pos`) so it survives as one path segment; documented
     in the route file's own comment.
   - Both routes gated behind `config.dashboard.enabled` (same flag Bull
     Board uses — `basicAuthUser`/`DASHBOARD_BASIC_AUTH_PASSWORD` are only
     guaranteed set when that's true) and protected by
     `registerDashboardBasicAuth` + an `onRequest` hook, same pattern as
     `dashboard.ts`.
3. Retrofitted the same gating + auth onto `events.ts` (Task 4's SSE route) —
   Task 4 deliberately shipped it open, noting Task 5 as the auth owner; this
   closes that gap. Registered in `app.ts` alongside the other dashboard
   routes.
4. Updated `tests/unit/events-route.test.ts` (now needs auth to connect) and
   added a 401 case for it.
5. New `tests/unit/pipelines-route.test.ts` (5 cases, real SQLite via a tmp
   file, `app.inject()` against a bare Fastify instance registering only
   `pipelinesRoutes`, config mocked the same way `dashboard.test.ts` already
   does): rejects with no auth (401); a running row and a finished row in the
   same response have identical key sets (proves the shape-consistency AC
   directly, not just by construction); `repoId` query-param filtering;
   detail endpoint returns `events`; 404 for an unknown pair.

### Verify

- "Endpoint reject request tanpa auth (401)" — covered for both
  `/api/pipelines` and `/api/events/stream`.
- "Response shape konsisten antara data live dan data histori" — covered by
  the dedicated key-set-equality assertion in `pipelines-route.test.ts`
  (not just implied by the DB-only design decision above).

### Catatan

- `/api/events/stream` now requires the same auth as `/api/pipelines*` — a
  behavior change from Task 4's initial (intentionally open) version.
- Not touched: Task 6 (frontend SPA), Task 7 (real-repo e2e), Task 8 (docs).

---

## Task 4 — File watcher + SSE stream

### Attempt Log

1. Added `chokidar` — pinned to `^3.6.0`, not the current `^5.x`: chokidar 5
   ships ESM-only, and this repo compiles as CommonJS (no `"type": "module"`
   in `package.json` — see Task 1's `connection.ts` note about the same
   constraint). `pnpm typecheck` caught this immediately (TS1479) when first
   tried against 5.0.0; 3.6.0 is CJS and needs no import-style workaround.
2. Design question resolved before coding: `requirements.md`'s "Sumber data
   live status: orchestration-state.json per repo, di-watch" only makes literal
   sense as a *live PIV-phase* feed if read in isolation — that file is only
   ever written on a gate failure/retry (`recordGateFailure`,
   `incrementOrchestrationRetryCount`) or deleted on success
   (`resetOrchestrationState`), never on phase start. Read together with
   `tasks.md` Task 4 (which only asks to relay raw file-change events tagged
   with `repoId`) and Task 5 ("merge live (state.json) + histori (DB)"), the
   design is coherent: Task 4 is a coarse "something changed, go refetch"
   push signal; Task 5's REST layer is where the richer live/historical merge
   happens. Not treated as a STOP-worthy ambiguity — proceeded on this
   reading rather than guessing a richer per-phase watch design.
3. `src/infrastructure/watch/orchestration-state-watcher.ts` —
   `startOrchestrationStateWatchers(projects, onEvent)`: one chokidar watcher
   per configured project (`ProjectRegistry.getAll()`), globbed at
   `${project.workspaceDir}/**/.caf/tasks/*/orchestration-state.json`. Each
   project's `workspaceDir` is unique and never nested (enforced by
   `project-config.schema.ts`'s cross-project check), so a watcher's events
   are unambiguously that project's repo — no path-parsing heuristics needed
   to tell repos apart. `repoId` reuses Task 3's `repoIdFromCloneUrl`, so the
   same `owner/repo` string ties an SSE event to its `pipeline_runs`/
   `agent_events` rows. Works under both `workspace.mode`s: persistent
   (`persistent-<repo>/...`, stable across runs) and ephemeral
   (`job-<uuid>/...`, exists only for the run's duration — the glob still
   matches while a run is live; `cleanupWorkspace` only deletes the directory
   after `execute()` returns, by which point any change already broadcast).
4. `src/presentation/web/sse/event-broadcaster.ts` — `EventBroadcaster`: a
   `Set<{write}>` of connected clients, `broadcast()` frames each event as
   `data: <json>\n\n` and writes to every client, dropping (catch, not
   throw) any whose `write` fails so one dead connection can't break the
   fan-out to the rest.
5. `src/presentation/web/routes/events.ts` — `GET /api/events/stream`:
   `reply.hijack()`s the connection, writes SSE headers, subscribes to the
   broadcaster, unsubscribes on the request socket's `close` event.
   Deliberately **no auth** on this route — Task 5 is the ticket's own
   explicit owner of "reuse basic auth middleware yang sama dengan Bull
   Board" across the dashboard surface; adding it here piecemeal would
   pre-empt that and risk a second, drifting auth wrapper.
6. Wired into `app.ts` (route registration) and `server.ts` (watcher
   startup/shutdown). Watchers are started in `server.ts`, not inside
   `buildApp()` — `buildApp()` is reused by the test suite via `Fastify`
   injection, and starting real filesystem watchers against project
   `workspaceDir`s that don't exist in a test environment would be an
   unwanted side effect of just building the app. `shutdown()` closes every
   watcher before closing the Fastify app.
7. Tests:
   - `tests/unit/orchestration-state-watcher.test.ts` (2 cases): real
     chokidar against real tmp directories for two different projects —
     asserts each project's file writes produce an event tagged with that
     project's own `repoId`, and that deleting the file emits `eventType:
     'unlink'`.
   - `tests/unit/event-broadcaster.test.ts` (4 cases): fan-out to multiple
     clients, unsubscribe stops delivery, a throwing client is dropped
     without affecting others, `clientCount` accuracy.
   - `tests/unit/events-route.test.ts` (2 cases): a real Fastify instance
     with only `eventsRoutes` registered, listening on a real TCP port —
     two real SSE HTTP connections, `eventBroadcaster.broadcast()` called
     with two differently-tagged events, both connections' raw received
     bytes asserted to contain the correctly-tagged `data: ...` frames; a
     second case confirms `clientCount` drops to 0 after a client
     disconnects (proves the `close`-handler unsubscribe actually runs, not
     just that the code exists).

### Verify

- "Buka 2 SSE client, ubah state.json di 2 repo berbeda, konfirmasi tiap
  client terima event dengan repoId yang benar" — covered by two tests
  together: `orchestration-state-watcher.test.ts` proves the watcher→event
  path tags by `repoId` correctly per-repo; `events-route.test.ts` proves
  the broadcaster→HTTP path delivers to every connected client. (Not
  re-run as one single top-to-bottom manual scenario against a live server,
  since the two seams are already independently verified and the full
  wiring in `server.ts` is a two-line composition of both.)

### Catatan

- SSE fan-out is not filtered per-client server-side — every connected
  client receives every repo's events; filtering by `repoId` is left to the
  frontend (Task 6), matching the AC wording ("Multi-repo: ... tampil
  terpisah, tidak tercampur" reads as a **display** requirement, not a
  server-side subscription-scoping one).
- No auth on `/api/events/stream` yet — intentional, deferred to Task 5 (see
  Attempt Log #5). The AC "Dashboard terproteksi basic auth" isn't fully met
  until Task 5 lands.

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

## Task 7 — Verify & real-repo test

### Decision (asked, not guessed)

Task 7 asks for a real end-to-end run against `umkm-pos` (1 ticket, full
pipeline) plus a multi-repo test (2 tickets, 2 different repos, in
parallel). Both mean: clone a real repo, spawn real `claude --agent ...`
processes (real token spend, ~30+ min per run per `CLAUDE_AGENT_TIMEOUT_MS`),
push a real branch, and open a real PR on GitHub — genuine external
side effects, not something to trigger unilaterally. Asked the user how to
proceed (I trigger it and verify, you trigger it and I verify, or skip and
report the gap). **Chosen: skip real-repo e2e, report the gap, move on** —
so this task closes with the unit-level half done and the real-repo half
explicitly outstanding, not silently claimed.

### Attempt Log

1. Re-ran the full suite as Task 7's own "Unit test: DB query layer, SSE
   event emission" line item — both already have dedicated coverage from
   prior tasks (`pipeline-run.repository.test.ts` for the query layer;
   `event-broadcaster.test.ts` + `orchestration-state-watcher.test.ts` +
   `events-route.test.ts` for SSE emission end to end). No new tests needed
   here — confirmed still green: `pnpm typecheck`/`pnpm lint`/`pnpm test`
   all pass (35 files / 347 tests).
2. Went through every `requirements.md` Acceptance Criteria line
   individually against what's actually been built and tested (not just
   assumed done because a task number was checked off):
   - "Dashboard menampilkan pipeline yang sedang berjalan, live, tanpa
     refresh manual (SSE)" — mechanism built and browser-verified (Task 6:
     real `EventSource` connects, shows "live"). **Not** verified against
     an actual in-flight real pipeline run reaching the dashboard live —
     that combination is exactly the real-repo e2e being deferred here.
   - "Multi-repo: 2 pipeline paralel di repo berbeda tampil terpisah,
     tidak tercampur" — mechanism verified in isolation (watcher tags
     `repoId` correctly per project, `repoId` query-param filtering
     tested) but never proven against two *actually concurrent* real
     pipeline runs. Deferred with the same gap as above.
   - "Histori pipeline run tersimpan di DB dan bisa di-query lewat REST
     endpoint" — fully done and tested (Tasks 1, 3, 5).
   - "Tiap pipeline run menampilkan: fase PIV..., retry count per gate,
     cost..., link ke artifact" — fully done and tested (Task 6).
   - "Dashboard terproteksi basic auth yang sama dengan Bull Board" —
     fully done and tested across all three dashboard routes (Task 5).
   - "DB write di titik instrumentasi tidak boleh menjatuhkan pipeline
     utama kalau gagal" — fully done and tested (Task 3).
   - "Real-repo end-to-end test PASS di `umkm-pos`" — **not done**, per
     the decision above.
3. Did not check any boxes in `requirements.md` itself — that file is the
   ticket spec, not this report; leaving the checklist accounting here
   instead of editing the source document.

### What's needed to close this gap

To actually finish Task 7's real-repo criterion: pick (or create) one real
`umkm-pos` ticket, flip it to "Ready for AI" (or trigger manually), run
`pnpm dev` + `pnpm dev:worker` against real Redis/GitHub/Linear credentials,
and watch `/dashboard` while it runs — confirming the PIV phase updates live
without a manual refresh, and that `pipeline_runs`/`agent_events` end up
correct once it finishes (success or a gate stop, either is a valid PASS
for this AC). For the multi-repo half, the same thing twice, concurrently,
against two different configured projects, confirming the dashboard splits
them correctly with `repoId` filtering and never mixes rows.

### Verify

- `pnpm typecheck` / `pnpm lint` / `pnpm test` — all PASS (unit-level half
  of Task 7's own verify line).
- Real-repo / multi-repo e2e — **not run this session** (see Decision
  above). Everything downstream of the actual `claude` agent spawn point
  (DB writes, SSE push, REST reads, UI rendering) has been exercised with
  realistic fixture data end-to-end (Task 6's browser check), but the one
  thing not exercised is a real agent process actually producing that data
  through the full pipeline.

---

## Task 8 — Dokumentasi

### Attempt Log

1. No `docs/` or `.caf/knowledge/` directory existed yet — created `docs/`.
2. Wrote `docs/dashboard.md`: how to turn the feature on
   (`dashboard.enabled` + `DASHBOARD_BASIC_AUTH_PASSWORD`), how to reach it
   (`/dashboard`, same Basic Auth as Bull Board — explicit that it's the
   same credentials, not a separate login), a column-by-column reading guide
   for the table (Repo/Ticket/Phase/Retries/Cost/Status/Artifact), how
   retries are counted (max seen per agent, not a row count — easy to
   misread otherwise), and how the SSE live-update mechanism behaves (what
   the connection-status dot means, why a refresh is never needed).
3. **Cost caveat, corrected rather than copied from the ticket**: `tasks.md`
   Task 8 asks to note "kalau instrumentasi cost ternyata cuma estimasi
   (bukan angka pasti dari API)" — but Task 2's investigation (this same
   ticket) found the opposite: `claude --output-format json` returns a real
   `total_cost_usd`, not something this codebase estimates from token counts.
   Documented the actual finding instead of the ticket's anticipated (and
   now incorrect) caveat, with an explicit note that the original plan
   assumed otherwise — so a future reader doesn't wonder why the "estimate"
   caveat is missing.
4. Added a "Known limitation" section pointing at Task 7's outstanding
   real-repo e2e gap, linking to this same verify report — so a reader of
   the docs isn't left thinking the feature is fully proven end-to-end when
   one AC is still open.
5. Added a two-line pointer + link from `README.md` (next to the existing
   `CLAUDE.md` cross-reference) so `docs/dashboard.md` is discoverable from
   the repo's front door, not an orphaned file.
6. Did not touch `.caf/knowledge/` — this repo doesn't use that convention
   anywhere else (checked: no existing `.caf/` directory), so `docs/`
   matches how the rest of the repo is organized (`docs/dashboard.md`
   alongside `README.md`/`CLAUDE.md` at the root, not a new top-level
   convention).

### Verify

"Dokumen bisa diikuti orang lain (bukan cuma Ganjar)" — self-reviewed for
exactly that: every step assumes no prior context beyond having the repo
checked out (states which config keys to set and where, names the actual
URL path, explains what the browser will do when it hits Basic Auth,
defines every column instead of assuming familiarity with the schema).
Not literally tested by having a second person follow it — no second
person available in this session — but written to that standard rather
than as shorthand notes to self.

---

## Quality Gate

- `pnpm typecheck` — PASS
- `pnpm lint` — PASS (pre-existing eslint.config.js module-type warning only,
  unrelated to this change)
- `pnpm test` — PASS, 35 files / 347 tests (7 new: 2 dashboard-ui route +
  5 pipelines-route additions for the summary fields)
- `pnpm db:migrate` — PASS against a clean `./data/` dir, run twice (idempotency
  confirmed)
- Reran the timing-sensitive tests (watcher + SSE route) 3x back-to-back —
  no flakiness observed
- Manual browser verification for Task 6 (see its Attempt Log #6) — real
  `pnpm dev`, real seeded data, real screenshots, not just unit tests
- Task 8: no code changed, `pnpm typecheck`/`pnpm lint`/`pnpm test` reran
  anyway as a sanity check — unaffected, still 35 files / 347 tests

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
- `chokidar` pinned to `3.6.0`, not the current `5.x` line — see Task 4's
  Attempt Log #1 (ESM-only vs. this repo's CommonJS build target).
- Task 5's live-vs-history data-source question and Task 7's real-repo
  e2e question were both asked rather than guessed — the two explicit user
  decision points across Tasks 1-7.
- **Outstanding gap**: real-repo + multi-repo end-to-end test against
  `umkm-pos` (Task 7's own AC, `requirements.md`'s last AC item) —
  deliberately deferred this session; see Task 7's "What's needed to close
  this gap" above for exactly what running it requires. This is the **only**
  outstanding item in the entire `tasks.md` breakdown (Tasks 1-6, 8 all
  complete).
- Documentation lives at [`docs/dashboard.md`](../../../docs/dashboard.md),
  linked from `README.md`.

**All of `tasks.md` is done except Task 7's real-repo e2e AC — see Task 7's
section above for exactly what's needed to close it. Nothing else is
pending review.**
