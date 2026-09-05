## Ticket: CAF-RETRYPIPELINE-01
## Status: SUCCESS (Task 1 + Task 2)

## Scope
Task 1 + Task 2. No push/PR logic at gate exhaustion (Task 3), no `/caf-retry-pipeline`
command or webhook handlers (Task 4-5), no resume/manual-change-detection logic (Task 6).
Not started/committed further than these two tasks per instructions.

---

# Task 1 — Extend config schema (`caf-config.yaml`)

## Pre-implementation audit (required before touching code)
Read the existing repo registry (`src/config/project-config.schema.ts`,
`src/config/project-registry.ts`) before assuming its shape from `requirements.md`.
Findings:
- `ProjectConfig` (per-repo entry) = `{ ticketPrefix, repoCloneUrl, baseBranch,
  workspaceDir, agents: { modelOverrides } }`, validated by `projectConfigSchema`.
- `projectsSchema = z.record(name, projectConfigSchema).superRefine(crossProjectChecks)`
  — keyed by project name in YAML, re-keyed by `ticketPrefix` in `ProjectRegistry`.
- Loaded via `ProjectRegistry.load(filePath)` from `caf.config.yaml`'s `projects:`
  section, independent of the global `config` object (`config/index.ts` builds both
  from the same file but as two separate parses).
- **No gap found** vs. `requirements.md`'s assumption — structure matches (flat
  per-repo entry, no unexpected nesting/naming difference). No STOP condition
  triggered; proceeded to add the field.

## Attempt Log
- Attempt 1: PASS — schema changes, global default, docs, and tests all green on
  first pass; no rework needed.

## Acceptance Criteria (Task 1 scope only)
- [x] `orchestration.maxOrchestrationRetries` (number) added to per-repo entry
      schema — `src/config/project-config.schema.ts`. Left `.optional()` (undefined
      when unset) rather than defaulting to a number at this layer, so a caller can
      distinguish "repo didn't set it" from "repo explicitly set the same number as
      the global default" and fall back correctly.
- [x] Global default (`2`) added as fallback — `src/config/schema.ts`, new top-level
      `orchestration.maxOrchestrationRetries` field, following the exact
      `agents.qa`/`agents.reviewer` nested-object-with-`.default()` pattern already
      in the file (no new default-handling convention introduced).
- [x] Fallback resolution helper added — `resolveMaxOrchestrationRetries(project,
      globalDefault)` in `src/config/project-registry.ts` (`project.orchestration.
      maxOrchestrationRetries ?? globalDefault`). Not wired into the pipeline
      use-case (out of scope, Task 3/6) — provided now so Task 1's "default global as
      fallback" requirement is actually testable, not just declared.
- [x] Docs updated — `caf.config.example.yaml`: global `orchestration:` block with
      explanatory comment, plus a commented-out per-repo `orchestration:` example
      under `projects.your-project`.
- [x] Test: config without the field stays valid, resolves to the default —
      `tests/unit/project-config.schema.test.ts` ("leaving maxOrchestrationRetries
      undefined"), `tests/unit/schema.test.ts` ("applying structural defaults" ->
      `orchestration.maxOrchestrationRetries` = 2), `tests/unit/project-registry.test.ts`
      ("falls back to the global default").
- [x] Test: 2 repo entries with different values don't leak into each other —
      `tests/unit/project-config.schema.test.ts` ("without cross-project leakage"),
      `tests/unit/project-registry.test.ts` ("uses each repo's own override without
      leaking into the other").
- [x] Typecheck/lint/test all green, no regressions to existing config behavior.

## Quality Gate
- Typecheck (`pnpm typecheck`): PASS, no errors.
- Lint (`pnpm lint`): PASS, no errors (pre-existing unrelated ESM/CJS warning from
  `eslint.config.js` missing `"type": "module"`, not touched by this task).
- Test (`pnpm test`): 268/268 tests pass (25 files), including 8 new cases across
  3 files. Zero regressions to any existing config/project-registry test.

## Files changed
- `src/config/project-config.schema.ts` — added `orchestration.maxOrchestrationRetries`
  (`z.coerce.number().int().nonnegative().optional()`) to `projectConfigSchema`.
- `src/config/schema.ts` — added global `orchestration.maxOrchestrationRetries`
  (`z.coerce.number().int().nonnegative().default(2)`) to `yamlSchema`.
- `src/config/project-registry.ts` — added `resolveMaxOrchestrationRetries(project,
  globalDefault)` helper.
- `caf.config.example.yaml` — added global `orchestration:` section + commented
  per-repo override example.
- `tests/unit/project-config.schema.test.ts` — 3 new cases (undefined fallback,
  2-repo isolation, negative-value rejection).
- `tests/unit/project-registry.test.ts` — 2 new cases (`resolveMaxOrchestrationRetries`
  fallback + per-repo isolation).
- `tests/unit/schema.test.ts` — 1 new case (global default override) + 1 assertion
  added to the existing "applying structural defaults" test.

## Catatan
- Local (untracked/gitignored) `caf.config.yaml` at repo root — used by
  `project-registry.test.ts`'s real-file regression test — was left untouched.
  It doesn't set `orchestration:` anywhere, so both its `umkm-pos` (GAN) and
  `coderium-web-v2` (CDR) entries now resolve to the global default of `2` via
  the new schema default; no edit was needed for tests to stay green.
- Did not touch `qaRetryCount`/`reviewerRetryCount` or any pipeline use-case code —
  confirmed via `git diff --stat` that changes are scoped to `src/config/*`,
  `caf.config.example.yaml`, and test files only.
- `resolveMaxOrchestrationRetries` is not yet called from anywhere outside its own
  test — intentional, since wiring it into the actual gate-exhaustion/resume flow is
  Task 3/6's job, not Task 1's. Ready for whoever picks up Task 3 (max-retry check
  itself is Task 4) to import it from `src/config/project-registry.ts`.

---

# Task 2 — `orchestration-state.json` per ticket

## Pre-implementation STOP raised and resolved
requirements.md said the file lives at `.ai/tasks/{TICKET-ID}/orchestration-state.json`.
Audit of the actual codebase (`report-reader.ts`'s `taskDir()`, and every existing
pipeline artifact — `verify-report.md`, `qa-report.md`, `review-notes.md`) showed pipeline
artifacts actually live at `.caf/tasks/{ticketKey}/` **inside the cloned target repo**
(`repoPath`), not `.ai/tasks/` — that path is this orchestrator repo's own dev-ticket-doc
namespace, unrelated to runtime pipeline state. Writing to `.ai/tasks/` would put the state
file outside the repo entirely: lost on ephemeral workspace cleanup, invisible to
`git fetch`/`reset --hard` in persistent mode (Task 6), and never pushed/committed with the
branch or PR (Task 3), breaking `lastKnownCommitSha`-based manual-change detection before
Task 6 could even use it.

Raised via `AskUserQuestion` before writing code; user confirmed: use `.caf/tasks/{ticketKey}/`
in `repoPath`, matching the existing `taskDir()` convention. User then corrected
`requirements.md`/`tasks.md` directly to reflect this (visible in `git diff`, not made by
this session).

## Attempt Log
- Attempt 1: PASS — implementation, wiring, and tests all green on first pass; no rework
  needed.

## Design decisions
- **Reset vs. delete on success** (left TBD in `tasks.md`): chose **delete the file**.
  Absence of `orchestration-state.json` is the "clean" signal the future resume handler
  (Task 6) and `/caf-retry-pipeline` (Task 4) can check for, cheaper than reading a
  file and checking a reset-to-zero sentinel.
- **`orchestrationRetryCount` is preserved, not reset, on every gate failure.** This
  counter is only ever supposed to move via the retry trigger (`/caf-retry-pipeline` /
  Linear resume — Task 4-5), never by a gate failing again within the same attempt. So
  `recordGateFailure()` reads the existing file first (if any) and carries its
  `orchestrationRetryCount` forward untouched — only `lastFailedGate`/`lastFailedAt`/
  `lastKnownCommitSha` get overwritten.
- **New `IGitService.getHeadCommit(targetDir)` method added.** Required to fill
  `lastKnownCommitSha` "dari HEAD branch saat itu" per the task spec — no existing method
  exposed current HEAD outside of `preflightCleanup`'s specific reset-audit codepath.
  Implemented in `GitService` as `git rev-parse HEAD` (same pattern as
  `preflightCleanup`'s existing `headCommitBeforeReset`).
- **Only the 3 named gates write state** — `implementation` (verify-report NEEDS_HUMAN),
  `qa` (FAIL after retry), `reviewer` (CHANGES_REQUESTED after retry). The `429`/`404`
  non-retryable-API-error stop path (`stopIfNonRetryable`) and unexpected-crash path
  (generic `throw` → BullMQ retry) are deliberately **not** wired to this state file —
  neither maps to the `implementation | qa | reviewer | null` gate enum, and per
  `tasks.md` Task 2 only covers "Selesai sukses penuh" and "Berhenti di NEEDS_HUMAN".
- **Write/reset failures are caught and logged, never allowed to crash the pipeline
  or block the human-facing comment.** A failed `recordGateFailure`/`resetOrchestrationState`
  call (e.g. a filesystem error) must not prevent the NEEDS_HUMAN comment or the
  success path from completing — this state file is bookkeeping for future retries,
  not a correctness gate itself.
- **No push/commit of the state file at gate-exhaustion time** — that's explicitly Task 3
  (commit+push+PR at gate exhaustion doesn't exist yet). Right now a gate failure writes
  `orchestration-state.json` into the working tree only; it isn't persisted anywhere until
  Task 3 lands. Documented here so Task 3's implementer isn't surprised the file "isn't in
  the PR yet" — that's expected until Task 3 adds the commit.

## Acceptance Criteria (Task 2 scope)
- [x] File structure defined — `OrchestrationState` type in
      `src/infrastructure/reports/orchestration-state.ts`: `orchestrationRetryCount`,
      `lastFailedGate: 'implementation' | 'qa' | 'reviewer' | null`, `lastFailedAt`,
      `lastKnownCommitSha`.
- [x] Written on full success → deleted (`resetOrchestrationState`), called in
      `run-agent-pipeline.use-case.ts` right before `commitAll`/`push`.
- [x] Written on `NEEDS_HUMAN` at all 3 gates (`recordGateFailure` via the new
      `recordGateExhaustion` private helper) — implementation, QA, reviewer — each
      stamped with the correct gate name, current HEAD sha, and an ISO timestamp.
- [x] Test: file appears with correct content on each gate-failure scenario —
      `tests/unit/orchestration-state.test.ts` (`recordGateFailure` cases) +
      `tests/unit/run-agent-pipeline.use-case.test.ts` (3 gate tests asserting
      `recordGateFailureMock` called with the right gate/sha per gate).
- [x] Test: file absent/reset on success scenario —
      `tests/unit/run-agent-pipeline.use-case.test.ts` (success test asserts
      `resetOrchestrationStateMock` called, `recordGateFailureMock` not called) +
      `tests/unit/orchestration-state.test.ts` (`resetOrchestrationState` deletes an
      existing file / no-ops when absent).
- [x] Test: `orchestrationRetryCount` isolation across 2 different tickets in the same
      workspace, and preserved (not reset) across repeated gate failures for the same
      ticket — `tests/unit/orchestration-state.test.ts`.

## Quality Gate
- Typecheck (`pnpm typecheck`): PASS, no errors.
- Lint (`pnpm lint`): PASS, no errors (same pre-existing unrelated ESM/CJS warning as
  Task 1, not touched by this task).
- Test (`pnpm test`): 275/275 tests pass (26 files) — 7 new cases in the new
  `orchestration-state.test.ts`, plus 5 new assertions added to 4 existing
  `run-agent-pipeline.use-case.test.ts` cases. Zero regressions.

## Files changed
- `src/infrastructure/reports/orchestration-state.ts` (new) — `OrchestrationState`,
  `OrchestrationGate` types; `readOrchestrationState`, `recordGateFailure`,
  `resetOrchestrationState`.
- `src/infrastructure/reports/report-reader.ts` — exported `taskDir()` (was
  module-private) so `orchestration-state.ts` reuses the same
  `.caf/tasks/{ticketKey}/` path helper instead of duplicating it.
- `src/domain/interfaces/git.interface.ts` — added `getHeadCommit(targetDir):
  Promise<string>` to `IGitService`.
- `src/infrastructure/git/git.service.ts` — implemented `getHeadCommit` (`git
  rev-parse HEAD`).
- `src/application/use-cases/run-agent-pipeline.use-case.ts` — added private
  `recordGateExhaustion()` helper; called at all 3 NEEDS_HUMAN gate returns; added
  try/caught `resetOrchestrationState()` call before the success-path `commitAll`.
- `tests/unit/orchestration-state.test.ts` (new) — 7 cases covering
  `readOrchestrationState` (missing/present), `recordGateFailure` (fresh write,
  retry-count preservation, cross-ticket isolation), `resetOrchestrationState`
  (deletes / no-ops).
- `tests/unit/run-agent-pipeline.use-case.test.ts` — added `orchestration-state.js`
  mock, `taskDir` export to the existing `report-reader.js` mock, `getHeadCommit` to
  the fake `gitService`; added assertions to the success test and all 3 NEEDS_HUMAN
  gate tests.
- `.ai/tasks/CAF-RETRYPIPELINE-01/requirements.md`, `tasks.md` — path corrected by
  user directly in IDE after the `AskUserQuestion` resolution (not edited by this
  session).
