STATUS: SUCCESS

## Scope
Correction of prior implementation: verify-report.md restored as gate ONE, QA as gate TWO (additive, not a replacement).

## Changes
- `src/infrastructure/reports/report-reader.ts`: restored `readVerifyReport`/`VerifyReport`
  (reads `verify-report.md`, `SUCCESS`/`NEEDS_HUMAN`), now alongside `readQaReport`/`QaReport`
  (reads `qa-report.md`, `PASS`/`FAIL`) — both present, neither replaces the other.
- `src/application/use-cases/run-agent-pipeline.use-case.ts`: corrected order —
  1. `runImplementationAgents()` (initial run, unchanged helper from prior task).
  2. `readVerifyReport()` — `NEEDS_HUMAN` → `postComment`, stop. Same behavior as
     original pre-QA pipeline. QA is never spawned in this branch.
  3. `SUCCESS` → `runQaGate()` (unchanged retry logic: initial + 1 retry via
     `qaRetryCount`/`MAX_QA_RETRIES`) → still `FAIL` after retry → `postComment`
     NEEDS_HUMAN, stop → `PASS` → Docs Agent → commit/push/postComment SUCCESS.
- Tests (`tests/unit/run-agent-pipeline.use-case.test.ts`):
  - Restored `readVerifyReportMock`, default `SUCCESS` in `beforeEach` alongside
    existing `readQaReportMock` default `PASS`.
  - Added: verify-report `NEEDS_HUMAN` → asserts `qa` agent never spawned,
    `readQaReport` never called, no commit/push, `notifyPipelineComplete` not
    called, comment contains "needs human review".
  - Existing QA retry/fail-twice/missing-qa-report cases unchanged, still pass.

## Verification
- `npx tsc --noEmit` — clean, no errors.
- `npx vitest run` — 30 tests, all PASS.
- `npx eslint` on changed files — clean, no issues.
