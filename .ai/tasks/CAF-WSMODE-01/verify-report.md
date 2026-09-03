## Ticket: CAF-WSMODE-01
## Status: SUCCESS

## Attempt Log

### Attempt 1 (previous session)
Task 0–3 done and tested (config schema, in-memory `WorkspaceLock`, real-repo
`GitService.preflightCleanup()`). Task 4 STOP'd before any coding — full
persistent-mode wiring required touching `run-agent-pipeline.use-case.ts` and
(by singleton-sharing effect) `run-pr-review.use-case.ts`, both explicitly
out-of-scope at the time. Reported `NEEDS_HUMAN`. User resolved the scope gap
out-of-band (see requirements.md "Update Pasca-Attempt 1"): added an explicit
`workspacePurpose: 'ticket-pipeline' | 'pr-review'` parameter and a narrowly
scoped, itemized allow-list for edits to those 2 files.

### Attempt 2 (this session)
- Verified attempt-1 code intact on `ai-agent/CAF-WSMODE-01` (commits
  `de674eb`, `4293438`) before touching anything — did not redo Task 0–3.
- **Task 4a** — added `WorkspacePurpose` type
  (`src/domain/interfaces/git.interface.ts`); `WorkspaceManager.createWorkspace`/
  `cleanupWorkspace` gained optional `workspacePurpose`/`repoIdentifier` params
  and persistent-reuse/lock-release branching, gated on
  `workspacePurpose === 'ticket-pipeline' && config.workspace.mode ===
  'persistent'`. New gap found before touching 4b: the pipeline's unconditional
  `gitService.clone()` call had no way to skip re-cloning on a reused
  persistent workspace, and that call site wasn't in Task 4b's original
  3-point allow-list. Asked the user; they approved a 4th allowed edit (a
  plain `existsSync` check in the pipeline, not a hidden mode branch inside
  `GitService`). `pnpm typecheck`/`lint`/`test` pass (236/236, +5).
- **Task 4b** — `run-agent-pipeline.use-case.ts`: (1) pass
  `workspacePurpose: 'ticket-pipeline'` + `repoIdentifier` to `createWorkspace`,
  (2) wrap that call in try/catch for `WorkspaceLockError` → post "workspace
  busy" comment + `return` (not throw), (3) conditional clone vs.
  `preflightCleanup` via `existsSync` (the approved 4th point), (4) pass
  `workspacePurpose` to `cleanupWorkspace` in `finally`. Full diff reviewed
  and confirmed scoped to exactly these 4 points — no retry logic
  (`qaRetryCount`/`reviewerRetryCount`) touched. User confirmed after
  reviewing the full diff. `pnpm typecheck`/`lint`/`test` pass (236/236).
- **Task 4c** — `run-pr-review.use-case.ts`: pass `workspacePurpose:
  'pr-review'` at both `createWorkspace`/`cleanupWorkspace` call sites (the 1
  allowed point). No review logic touched. User confirmed after reviewing
  the full diff. `pnpm typecheck`/`lint`/`test` pass (236/236, existing test
  updated for the new call signature).
- **Task 4d** — new `tests/unit/workspace-mode-integration.test.ts`: real
  bare-git fixture repo, real `WorkspaceManager`/`GitService` (only `clone`'s
  target URL redirected via spy, since real github.com isn't reachable in
  tests). Verifies, end to end: first ticket-pipeline job clones fresh into
  `persistent-<repo>`; second reuses the same dir via `preflightCleanup`
  (clone not called again); a PR-review job for the same repo under the same
  global `persistent` config still gets a fresh ephemeral dir and is cleaned
  up (persistent dir untouched); a lock-busy second job gets a real
  `linearClient.postComment(...)` call containing "busy", not just a
  `WorkspaceLock`-unit-level check. `pnpm typecheck`/`lint`/`test` pass
  (240/240, +4).
- **Task 5** — regression: full suite pass covers untouched existing tests;
  added one more real-repo case (`workspace.mode: ephemeral`, 2 sequential
  ticket-pipeline runs) confirming both clone into distinct `job-<uuid>`
  dirs, both fully removed after, no `persistent-*` dir ever created, lock
  never engaged — byte-for-byte pre-CAF-WSMODE-01 behavior. Persistent
  real-repo 2-job-no-leak case already covered by Task 4d.
  `pnpm typecheck`/`lint`/`test` pass (241/241, +1).
- **Task 6** — `caf.config.example.yaml`'s `workspace.mode` comment expanded:
  when to use `persistent` vs `ephemeral`, explicit "applies ONLY to the
  ticket pipeline, PR-review always ephemeral" note, and explicit
  confirmation that the destructive reset/clean only ever runs inside the
  orchestrator's own scratch dir, never a human's working directory.

## Acceptance Criteria
(dari `requirements.md`)

- [x] `workspace.mode` bisa diset `ephemeral`/`persistent` di `caf.config.yaml`,
      divalidasi via zod — `src/config/schema.ts:142`
      (`mode: z.enum(['ephemeral', 'persistent']).default('ephemeral')`)
- [x] `workspace.mode` di-omit → behavior identik dengan sebelum perubahan —
      `caf.config.yaml` (project ini) tidak punya field `mode`; regression
      test real-repo di `tests/unit/workspace-mode-integration.test.ts`
      ("workspace.mode: ephemeral — every ticket-pipeline run clones fresh...")
- [x] Mode `persistent`: job kedua untuk repo yang sama tidak bisa mulai
      selama lock dipegang job pertama — `src/infrastructure/git/workspace-lock.ts`
      (`WorkspaceLock`, reject-immediately), wired in
      `src/infrastructure/git/workspace.manager.ts:createWorkspace` (acquire)
      and `cleanupWorkspace` (release); end-to-end proof in
      `workspace-mode-integration.test.ts` ("rejects a ticket-pipeline job...")
- [x] Mode `persistent`: pre-flight cleanup hasilnya di-log eksplisit —
      `src/infrastructure/git/git.service.ts:preflightCleanup()` (`logger.warn`
      before the destructive reset, `logger.info` on completion), called from
      `run-agent-pipeline.use-case.ts` when the persistent dir already has a
      clone (`existsSync` check); tested in `git-preflight-cleanup.test.ts`
      and end-to-end in `workspace-mode-integration.test.ts`
      ("second ticket-pipeline job... reuses the dir via preflightCleanup")
- [x] Mode `persistent`: `NEEDS_HUMAN` job dengan uncommitted/unpushed changes
      → audit trail sebelum reset, bukan silent — `git.service.ts:136-143`
      (`logger.warn('Preflight cleanup: discarding uncommitted changes before
      reset', ...)` with branch/HEAD-commit/status, only when there's
      actually something to lose); tested in `git-preflight-cleanup.test.ts`
      ("discards uncommitted changes, resets to origin/main, and logs an
      audit trail before the reset")
- [x] `caf-initiator` — TIDAK ADA perubahan — `git status --short` this
      session touches no file outside `caf-orchestrator`
- [x] Dokumentasi: `caf.config.example.yaml` diupdate — `workspace:` block,
      expanded comment (when to use each mode, ticket-pipeline-only scope,
      destructive-cleanup-confinement note)
- [x] **[BARU]** `workspace.mode: persistent` global TIDAK mengubah behavior
      `RunPrReviewUseCase` — `run-pr-review.use-case.ts` passes
      `workspacePurpose: 'pr-review'` explicitly at both `createWorkspace`/
      `cleanupWorkspace` call sites; `WorkspaceManager`'s persistent branch is
      gated on `workspacePurpose === 'ticket-pipeline'`, so `'pr-review'`
      always falls through to the ephemeral path regardless of
      `config.workspace.mode`; proven with `config.workspace.mode:
      'persistent'` set in both a unit test (`workspace.manager.test.ts`,
      "ephemeral job-<uuid> dir when workspace.mode is persistent but
      workspacePurpose is pr-review") and the real-repo integration test
      (`workspace-mode-integration.test.ts`, "a PR-review job for the same
      repo (same global persistent config) still clones fresh...")
- [x] **[BARU]** Lock ditolak (`WorkspaceLockError`) untuk ticket-pipeline job
      → comment benar-benar terkirim ke Linear, job berhenti bersih (`return`)
      — `run-agent-pipeline.use-case.ts` try/catch around `createWorkspace`;
      proven end-to-end (real `linearClient.postComment` call, not just the
      `WorkspaceLock` unit) in `workspace-mode-integration.test.ts`
      ("rejects a ticket-pipeline job with a real \"workspace busy\" comment
      posted to Linear...")
- [x] **[BARU]** Perubahan di `run-agent-pipeline.use-case.ts` dan
      `run-pr-review.use-case.ts` terbatas persis sesuai "Scope Resmi
      Diperluas" (+ 1 user-approved extra point for the clone-skip
      conditional) — full diffs shown and confirmed by user at the Task 4b
      and 4c checkpoints; see "Deviations" below for the exact extra point

## Quality Gate
- Lint: PASS
- Typecheck: PASS
- Test: PASS (241/241 — up from 231/231 at the end of attempt 1; +10 new
  across `workspace.manager.test.ts`, `run-pr-review.use-case.test.ts`, and
  the new `workspace-mode-integration.test.ts`)

## Catatan

### Deviations from the literal Task 4a/4b/4c wording (flagged live, not silent)

1. **`GitService.clone` did NOT get a `workspacePurpose` parameter**, despite
   Task 4a listing `clone` alongside `createWorkspace`/`cleanupWorkspace`.
   The clone-vs-reuse decision instead lives entirely in the pipeline's own
   `existsSync(`${repoPath}/.git`)` check (Task 4b's 4th, user-approved
   point) — `GitService` itself stays purpose-agnostic. Rationale: the
   alternative (threading `workspacePurpose` into `clone()`) would have
   required editing the pipeline's `clone()` call site anyway, which wasn't
   in Task 4b's original allow-list, and design.md's own principle ("explicit
   per-call, not hidden behavior") rules out having `clone()` silently
   auto-detect reuse from filesystem state.
2. **`createWorkspace`/`cleanupWorkspace` kept their original return types**
   (`Promise<string>` / `Promise<void>`) rather than switching to a
   `{path, reused}` shape — less invasive, no call-site destructuring churn.
   "Reused" is instead determined by the caller via a plain `existsSync`
   check, consistent with point 1's design principle.
3. **Lock key = the resolved persistent workspace path itself**, not a
   separate `repoIdentifier` string — `cleanupWorkspace` only needs `dirPath`
   (already has it) to release the same lock `createWorkspace` acquired, no
   extra parameter threading required.
4. **4th allowed edit added to Task 4b** (user-approved, see Attempt Log):
   the clone call at the original line ~160 is now a 2-branch conditional
   (`existsSync` → `preflightCleanup` else `clone`), instead of an
   unconditional `clone`. This was necessary for persistent reuse to work at
   all end-to-end — without it, `WorkspaceManager` could return an
   already-populated persistent dir but the pipeline would still try to
   `git clone` into it and fail.

### Known follow-up not in this ticket's scope
`createBranch` (`git checkout -b <branch> --`) will fail if a persistent
workspace still has a local branch of the same name left over from a prior
run of the **same ticket** (e.g. a retry). `preflightCleanup` resets to
`baseBranch` but does not delete other local branches. Not exercised by this
ticket's acceptance criteria (which cover different-ticket sequential reuse
and lock rejection, not same-ticket retry-after-partial-failure under
persistent mode) and not one of the itemized allowed edits — flagging for a
future ticket rather than fixing silently.

### Files confirmed untouched this session
- `caf-initiator` (separate repo — never opened)
- `report-reader.ts`
- Retry logic (`qaRetryCount`/`reviewerRetryCount`,
  `MAX_QA_RETRIES`/`MAX_REVIEWER_RETRIES`) in `run-agent-pipeline.use-case.ts`

Final `git status --short` (this session, on top of attempt-1's commits):
```
 M .ai/tasks/CAF-WSMODE-01/requirements.md
 M .ai/tasks/CAF-WSMODE-01/tasks.md
 M .ai/tasks/CAF-WSMODE-01/verify-report.md
 M caf.config.example.yaml
 M src/application/use-cases/run-agent-pipeline.use-case.ts
 M src/application/use-cases/run-pr-review.use-case.ts
 M src/domain/interfaces/git.interface.ts
 M src/infrastructure/git/workspace.manager.ts
 M tests/unit/run-pr-review.use-case.test.ts
 M tests/unit/workspace.manager.test.ts
?? tests/unit/workspace-mode-integration.test.ts
```
