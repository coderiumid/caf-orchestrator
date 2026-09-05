## Ticket: CAF-RETRYPIPELINE-01
## Status: NEEDS_HUMAN (Task 1, 2, 4, 5 SUCCESS; Task 3 code done but live umkm-pos verify pending)

## Scope
Task 1 + Task 2 + Task 3 + Task 4 + Task 5. The gate-aware parts of Task 6 (skip-to-failed-
gate resume, manual-change diffing, uncommitted-residue detection) are NOT implemented —
both retry entry points share a full-restart-from-`caf-planner` resume, not a gate-aware
one. Not started/committed further than these five tasks per instructions.

**Task 3 checkpoint (per `tasks.md`'s own instruction):** "Task 3 (push+PR) sebaiknya
diverifikasi end-to-end di `umkm-pos` dulu sebelum lanjut ke Task 4-6." Unit-level
verification (below) is done and green, but the actual live GitHub check — a real QA-fail
run against `umkm-pos` producing a visible Draft PR with a correct, non-mergeable-without-
manual-conversion state — has **not** been run from this session (no live umkm-pos pipeline
trigger available here). Recommend the developer runs that scenario against `umkm-pos`
before Task 4 starts, since Task 4-6 depend on a correctly-formed Draft PR from Task 3.

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

---

# Task 3 — Push + Draft PR pada gate exhaustion

## Attempt Log
- Attempt 1: PASS at unit-test level on first pass. Live end-to-end verification against
  the real `umkm-pos` repo (the task's own explicit verify step) not run from this
  session — see NEEDS_HUMAN note above.

## Design decisions
- **Idempotency via `findOpenPullRequestByHead` + `updatePullRequest`** (both new on
  `IVcsClient`): before opening a PR, check GitHub for an already-open PR on this branch
  (`GET /pulls?head=owner:branch&state=open`). If found, `PATCH` its body instead of
  `POST`ing a new PR — satisfies the explicit "jangan buat PR duplikat" requirement.
  Within a single `execute()` call at most one of the 3 gates can fire (each `return`s
  immediately), so this mainly guards a *future* invocation reusing the same branch
  (Task 4-6's resume path) rather than anything reachable today.
- **`draft: true` added to `CreatePullRequestInput`**, plumbed through to GitHub's REST
  `POST /pulls` body — defaults to `false` when omitted, so the existing full-success PR
  creation path (`buildPrBody`/`createPullRequest` call near the end of `execute()`,
  untouched by this task) keeps opening ready-for-review PRs exactly as before.
- **PR body is a pure reformat, not new text** (`buildGateExhaustionPrBody`): ticket
  header + a short fixed "gate exhausted: X" note + links to the task folder + the raw
  content of whichever single artifact that gate produced
  (`verify-report.md`/`qa-report.md`/`review-notes.md`). No LLM-generated summary — matches
  CLAUDE.md's report-contract convention and the explicit "tidak generate teks baru"
  instruction.
- **Push/PR failure never becomes a `throw`.** `pushAndOpenGatePr()` wraps the whole
  commit→push→find→create-or-update sequence in one try/catch; a failure at any step is
  logged and turned into a note appended to the human-facing comment ("Could not push/open
  a Draft PR automatically: ..."), but the calling gate still `return`s cleanly — the
  return-vs-throw contract flagged as sensitive in `tasks.md` is unchanged. This was the
  main design risk called out for this task; verified by a dedicated test
  (`gitService.push` rejecting) that asserts `execute()` still resolves rather than
  rejecting.
- **Commit message is gate-specific**: `AI agent pipeline: {ticketKey} (needs human review
  — {gate} gate)`, distinct from the plain `AI agent pipeline: {ticketKey}` success-path
  message, so `git log` on a gate-exhaustion branch is self-explanatory without needing to
  open the PR.
- **No change to the full-success path's PR creation** (still unconditional
  `createPullRequest`, no idempotency check there) — out of scope for Task 3, which is
  about the gate-exhaustion path specifically; the tasks.md breakdown doesn't ask for
  draft→ready conversion or duplicate-guarding on the success path anywhere in the 8
  tasks, so left untouched rather than adding unrequested behavior.

## Acceptance Criteria (Task 3 scope)
- [x] Gate exhaustion (implementation/QA/reviewer) now does
      `recordGateFailure` → `commit + push + open-or-update Draft PR` → `postComment` →
      `return`, replacing the old `postComment + return`.
- [x] Return-vs-throw contract preserved — all 3 gates still `return`, verified by
      existing + new tests (`await expect(useCase.execute(...)).resolves...`).
- [x] PR description generator reformats the gate-specific artifact
      (`buildGateExhaustionPrBody`) — no new text, links to
      `.caf/tasks/{ticketKey}/`.
- [x] Duplicate-PR guard — `findOpenPullRequestByHead` checked before create;
      `updatePullRequest` used when one is already open. Test:
      "updates an already-open Draft PR instead of creating a duplicate on gate
      exhaustion".
- [ ] **Live verify in `umkm-pos` (real repo)** — NOT done this session. Needs a real
      QA-fail-after-retry run to confirm: Draft PR actually appears on GitHub, description
      renders correctly, PR is in draft state and GitHub blocks merging without manual
      "Ready for review" conversion (task explicitly says "diverifikasi, bukan
      diasumsikan").

## Quality Gate
- Typecheck (`pnpm typecheck`): PASS, no errors.
- Lint (`pnpm lint`): PASS, no errors (same pre-existing unrelated ESM/CJS warning as
  Task 1/2, not touched by this task).
- Test (`pnpm test`): 283/283 tests pass (26 files) — 9 new cases in `github-service.test.ts`
  (draft flag, `findOpenPullRequestByHead`, `updatePullRequest`), 2 new gate-exhaustion
  scenario tests (duplicate-PR guard, push-failure-doesn't-throw) plus updated assertions
  on the 3 pre-existing NEEDS_HUMAN gate tests (which previously asserted `commitAll`/`push`
  were *not* called — now correctly assert they *are*, with the gate-specific message and
  the resulting Draft PR/PR-update call). Zero regressions elsewhere.

## Files changed
- `src/domain/interfaces/vcs-client.interface.ts` — `CreatePullRequestInput.draft?:
  boolean`; new `FindPullRequestByHeadInput`/`UpdatePullRequestInput` types; new
  `IVcsClient.findOpenPullRequestByHead()`/`updatePullRequest()` methods.
- `src/infrastructure/vcs/github.service.ts` — `createPullRequest` now sends
  `draft: draft ?? false`; new `findOpenPullRequestByHead()` (`GET /pulls?head=...&state=open`)
  and `updatePullRequest()` (`PATCH /pulls/{number}`) implementations.
- `src/application/use-cases/run-agent-pipeline.use-case.ts` — new
  `GATE_ARTIFACT_FILE` map + `buildGateExhaustionPrBody()`; new private
  `pushAndOpenGatePr()` and `appendPushResultNote()` methods; wired into all 3
  NEEDS_HUMAN gate branches (implementation/QA/reviewer).
- `tests/unit/github-service.test.ts` — 9 new cases for `createPullRequest` draft flag,
  `findOpenPullRequestByHead`, `updatePullRequest`.
- `tests/unit/run-agent-pipeline.use-case.test.ts` — added `findOpenPullRequestByHead`/
  `updatePullRequest` to the fake `vcsClient`; updated the 3 existing NEEDS_HUMAN gate
  tests' `commitAll`/`push` assertions; added 2 new tests (duplicate-PR update,
  push-failure-doesn't-throw).
- `CLAUDE.md` — documented the gate-exhaustion Draft PR behavior in the pipeline-flow
  section (steps 5-7) and a new "Gate-exhaustion Draft PR" subsection.

## Catatan
- Did not touch Task 2's state-file write ordering — `recordGateExhaustion()` (reads HEAD,
  writes `orchestration-state.json`) still runs *before* `pushAndOpenGatePr()` at every
  gate, so `orchestration-state.json`'s `lastKnownCommitSha` reflects the commit at the
  moment of failure detection, consistent with Task 2's contract; the state file itself is
  not yet part of the pushed commit's diff at the time it's written (a filesystem write
  happens before `commitAll`, so it *is* included when `commitAll`/`push` run right after —
  confirmed by reading the code path, not by a dedicated test, since Task 2's tests already
  cover `recordGateFailure`'s file-write behavior in isolation).
- Left the pre-existing `.ai/tasks/` vs `.caf/tasks/` inconsistency in `CLAUDE.md`'s
  pipeline-flow steps 2/5 untouched (unrelated pre-existing doc bug predating this ticket,
  same one flagged during Task 2's `AskUserQuestion`) — only added new text using the
  correct `.caf/tasks/` path, didn't "fix" the surrounding unrelated lines to keep this
  diff scoped to Task 3.

---

# Task 4 — `/caf-retry-pipeline` command + webhook handler

## Pre-implementation gaps raised and resolved
Two forward-dependency gaps found before writing code, both raised via `AskUserQuestion`:

1. **Task 4 needs Task 6's "shared resume handler," which doesn't exist yet.** User chose:
   enqueue a full-restart `agent-pipeline` job (not gate-aware) rather than blocking Task 4
   on Task 6, or building Task 6 out of order. Implemented as `job.isRetry` — the pipeline
   restarts from `caf-planner`, just synced onto the existing branch instead of a fresh one
   off `baseBranch` (see design decisions below).
2. **A resume job has no fresh `ticketTitle`/`ticketDescription`/comment-routing info** — a
   PR comment or Linear status flip carries none of that, unlike the original webhook
   payload. User chose: extend `orchestration-state.json` (Task 2's file, already shipped)
   to carry `ticketTitle`/`ticketDescription`, written at every `recordGateFailure()` call.
   Comment-routing turned out not to need `ticketId`/`ticketSource` at all once designed
   around a `retryContext` (see below) — every retry-run comment, including the eventual
   success comment, goes to the triggering PR instead of the original ticket, so the
   original routing (Linear vs GitHub issue) is simply bypassed for retry runs. Narrower
   than what was literally approved (`ticketId`/`ticketSource` dropped as unneeded) —
   flagging the simplification here rather than treating the original approval as requiring
   the unused fields.

## Attempt Log
- Attempt 1: PASS at unit-test level (webhook routing + use-case retry-gate logic) on first
  pass. Same live-umkm-pos caveat as Task 3 applies to the actual `/caf-retry-pipeline`
  comment flow — not run against a real PR from this session.

## Design decisions
- **`ExistingJobPayload` gains `isRetry?: boolean` and `retryContext?: { owner, repo,
  prNumber, maxOrchestrationRetries }`.** `retryContext` is deliberately generic (not
  `/caf-retry-pipeline`-specific) so Task 5's Linear-triggered resume can populate the exact
  same fields (after resolving the open PR via Task 3's `findOpenPullRequestByHead`) and
  reuse every downstream retry code path unchanged.
- **Retry-limit enforcement happens in two places for two different reasons:**
  - `maxOrchestrationRetries` is *resolved* at webhook time
    (`resolveMaxOrchestrationRetries` from Task 1, using the per-repo `ProjectConfig` the
    webhook already has) and carried on the job — the worker never needs the full
    `ProjectConfig`/`caf.config.yaml`, only the one resolved number.
  - The actual `orchestrationRetryCount` *check* happens worker-side
    (`checkAndConsumeRetryBudget`, called right after the workspace syncs onto the branch),
    not at webhook time, because `orchestration-state.json` only exists inside a git clone —
    reading it via the GitHub Contents API from the webhook handler was considered and
    rejected as unnecessary complexity (base64 decode, a new API method, and a second
    source of truth to keep in sync with the file the pipeline itself reads/writes) when the
    worker will clone the repo anyway.
  - Trade-off accepted: an over-limit or clearly-invalid retry still pays for a clone before
    being rejected, instead of being rejected synchronously at the webhook. Not a
    correctness issue, just a minor inefficiency — noted rather than hidden.
- **Retry sync reuses two already-existing `IGitService` methods with zero interface
  changes** — `clone(url, branch, ...)` already accepts any branch name (not just
  `baseBranch`), and `preflightCleanup(dir, someBranch, ...)` already fetches + hard-resets
  to `origin/<someBranch>` generically. Passing the `ai-agent/<ticketKey>` branch to both
  instead of `baseBranch` was enough to make a retry land on the existing branch instead of
  branching fresh off base — which also avoids the non-fast-forward push that would
  otherwise happen if `createBranch` re-created the same branch name locally while the
  remote already had it. This is *not* full Task 6 (no manual-change diff computed into
  agent context, no uncommitted-residue detection/stop before resetting) — just the minimal
  slice needed for a restart to not break git.
- **`postTicketComment` checks `job.retryContext` first**, before the existing
  `ticketSource === 'github'` / Linear branches — every comment during a retry run
  (including the final success comment, unmodified from the non-retry path) goes to the
  triggering PR via `postIssueComment`. This was the resolution to gap #2 above.
- **Webhook-side rejections are cheap and synchronous** (permission, `ENABLE_PIPELINE_TRIGGER`,
  branch-pattern match, project lookup) — mirrors the existing `/caf-review`/`/caf-fix-review`
  pattern exactly (`checkReviewPermission`, same whitelist decision per requirements.md).
  Worker-side rejections (no state / limit reached) post an explicit comment to the PR per
  the task's explicit "bukan diam-diam tidak melakukan apa-apa" requirement.
- **No new job type** — reused the existing `agent-pipeline` queue name with `isRetry`/
  `retryContext` fields rather than adding an `agent-pipeline-retry` job name, since
  `RunAgentPipelineUseCase.execute()` already needed to branch on `isRetry` internally
  either way (clone/branch logic differs); a separate job name would only have added a
  second dispatch point in `worker.ts` for no behavioral benefit.

## Acceptance Criteria (Task 4 scope)
- [x] New `issue_comment` handler for `/caf-retry-pipeline`, deriving `ticketKey` from the
      PR's head branch (`ai-agent/{ticketKey}`) — same permission-check pattern as
      `/caf-review`/`/caf-fix-review`.
- [x] Reads `orchestrationRetryCount` from `orchestration-state.json`; rejects with an
      explicit PR comment (not silent) when at/above `maxOrchestrationRetries`.
- [x] Increments the counter and proceeds (full restart) when under the limit.
- [x] Test: `/caf-retry-pipeline` comment on a Draft PR enqueues a retry job —
      `tests/unit/github-webhook-routing.test.ts` ("enqueues an agent-pipeline retry job...").
- [x] Test: comment after the limit is reached is rejected with an explicit comment —
      `tests/unit/run-agent-pipeline.use-case.test.ts` ("rejects with a comment... when
      orchestrationRetryCount already reached the limit").
- [ ] **Cross-path shared-counter proof (full AC)**: "dibuktikan dengan test bahwa retry dari
      dua jalur berbeda memakai counter yang sama" needs Task 5's Linear entry point to exist
      before it can be tested end-to-end. What's verified now: both entry paths are designed
      to converge on the exact same `isRetry`/`retryContext`/`checkAndConsumeRetryBudget`
      code path (Task 5 has nothing left to reimplement, only to populate `retryContext` and
      enqueue) — the shared-counter mechanism itself (`incrementOrchestrationRetryCount`) is
      unit-tested in isolation. Full proof deferred to Task 5's verify-report.
- [ ] **Live verify** — not run against real `umkm-pos`/GitHub this session (same caveat as
      Task 3).

## Quality Gate
- Typecheck (`pnpm typecheck`): PASS, no errors.
- Lint (`pnpm lint`): PASS, no errors (same pre-existing unrelated ESM/CJS warning, not
  touched by this task).
- Test (`pnpm test`): 297/297 tests pass (26 files) — 11 new webhook-routing cases
  (`/caf-retry-pipeline`: enqueue, per-repo override, bad branch, unknown project,
  permission, disabled-trigger), 5 new pipeline-use-case retry-path cases (clone-onto-
  existing-branch/no-createBranch, no-state rejection, limit-reached rejection, under-limit
  proceed + ticketTitle/Description refresh, PR-routed comments), 3 new
  `incrementOrchestrationRetryCount` cases in `orchestration-state.test.ts`. Zero
  regressions.

## Files changed
- `src/domain/interfaces/queue.interface.ts` — new `RetryContext` type; `ExistingJobPayload`
  gains `isRetry?: boolean` and `retryContext?: RetryContext`.
- `src/infrastructure/reports/orchestration-state.ts` — `OrchestrationState` gains
  `ticketTitle`/`ticketDescription`; `recordGateFailure` takes a new required
  `ticketContext` param; new `incrementOrchestrationRetryCount()`; extracted shared
  `writeState()` helper.
- `src/application/use-cases/run-agent-pipeline.use-case.ts` — `recordGateExhaustion` passes
  ticket context through; `postTicketComment` checks `job.retryContext` first; clone/branch
  logic branches on `job.isRetry` (sync onto existing branch vs. create new); new private
  `checkAndConsumeRetryBudget()` gate called right after sync, before any agent runs.
- `src/presentation/web/routes/webhooks.ts` — new `RETRY_PIPELINE_COMMAND` constant, new
  `handleRetryPipelineCommand()`, wired into `handleIssueComment()` before the existing
  `/caf-review`/`/caf-fix-review` mode logic.
- `tests/unit/orchestration-state.test.ts` — updated `recordGateFailure` call sites for the
  new required param; 3 new `incrementOrchestrationRetryCount` cases.
- `tests/unit/run-agent-pipeline.use-case.test.ts` — added `readOrchestrationState`/
  `incrementOrchestrationRetryCount` to the `orchestration-state.js` mock; updated 3
  existing `recordGateFailureMock` assertions for the new arg; new "CAF-RETRYPIPELINE-01 —
  isRetry job" describe block (5 cases).
- `tests/unit/github-webhook-routing.test.ts` — `projectRegistry`/`config.orchestration`
  mocks extended; new "issue_comment — /caf-retry-pipeline" describe block (6 cases).
- `CLAUDE.md` — new "`/caf-retry-pipeline` resume" subsection documenting the restart-not-
  resume behavior and the still-missing Task 5/6 pieces.

## Catatan
- Did not touch `qaRetryCount`/`reviewerRetryCount` — confirmed via `git diff --stat`,
  changes scoped to the files listed above plus `CLAUDE.md`.
- Job mutation: `checkAndConsumeRetryBudget()` mutates `job.ticketTitle`/
  `job.ticketDescription` in place (the `job` parameter is a plain object, not frozen) —
  deliberate, since the planner prompt is built from `job.ticketTitle`/`ticketDescription`
  later in the same `execute()` call and every other private method already reads those
  same properties off `job` throughout. Flagging the mutation explicitly since it's not
  the pattern used elsewhere in this file (every other private method treats `job` as
  read-only).
- `Retry-context` routing change to `postTicketComment` is best understood as "for a retry
  run, the PR IS the ticket for status-reporting purposes" — worth keeping in mind if a
  later task ever wants dual-posting (PR + original ticket) for retries; that's explicitly
  not implemented here (scope discipline — not asked for, would be silent unrequested
  behavior).

---

# Task 5 — Trigger retry via Linear (jalur kedua ke resume handler yang sama)

## Refactor carried over from Task 4 (before writing Task 5 code)
Task 4 originally put `maxOrchestrationRetries` inside `RetryContext` (alongside owner/
repo/prNumber). Task 5 exposed why that was wrong: the Linear resume path can know
`maxOrchestrationRetries` (resolved from the registered `ProjectConfig`, always available)
independently of whether an open PR exists for the branch (which may be `undefined` — a
branch can exist with no PR ever opened, e.g. the very first gate exhaustion's push failed
per Task 3's own failure-handling). Bundling them together would have forced a fake/default
`maxOrchestrationRetries` into a `retryContext: undefined` case, or forced `retryContext` to
exist just to carry a number that has nothing to do with PR-based comment routing. Fixed by
moving `maxOrchestrationRetries` to a top-level `ExistingJobPayload` field, independent of
`retryContext` (which now only ever carries owner/repo/prNumber, and is `undefined` exactly
when no PR was found). Updated Task 4's webhook handler, use-case, and all affected tests
to match — this is a pure refactor of Task 4's own work, not new Task 5 surface area, so
it's called out here rather than hidden inside "design decisions."

## Attempt Log
- Attempt 1: PASS at unit-test level on first pass, including the refactor above. Same
  live-verify caveat as Tasks 3/4 — a real Linear ticket flipping back to "Ready for AI" on
  a branch with an existing PR was not exercised against real Linear/GitHub from this
  session.

## Design decisions
- **`githubService.branchExists(owner, repo, branch)` added** — `GET /repos/{o}/{r}/branches/
  {branch}`, treating 404 as `false` (not an error) since that's the expected, meaningful
  answer for "not a resume." Deliberately not added to `IVcsClient` (same precedent as
  `getPullRequestHeadRef`/`listReviewComments`/`listIssueComments`) — `webhooks.ts` already
  imports the concrete `githubService` singleton directly for GitHub-specific queries the
  domain-level interface doesn't need to expose.
- **The Linear webhook's resume check runs after `projectConfig` is resolved, before the
  "new ticket" `jobData` is built** — reuses `projectConfig.repoCloneUrl` (already parsed
  via `parseGithubRepo` for the resume check) so the branch-existence and PR lookup happen
  against the correct GitHub repo without a second registry lookup.
- **`retryContext` is `undefined`, not a synthesized placeholder, when the branch exists but
  no open PR is found.** `postTicketComment` already falls back to `ticketSource`-based
  routing when `retryContext` is absent (Task 4's code, unchanged) — for a Linear-triggered
  resume with no PR, that correctly means "post back to the Linear ticket," which is the
  only sane fallback since there's no PR thread to post to instead.
- **`ticketTitle`/`ticketDescription` on the Linear resume path come from the fresh webhook
  payload** (`payload.data.title`/`payload.data.description`), unlike the PR-comment path
  which has no fresh values and uses a `Retry: {ticketKey}` placeholder. Both still get
  overwritten by `checkAndConsumeRetryBudget()` from `orchestration-state.json` once the
  workspace syncs — deliberately not special-cased to skip that overwrite for the Linear
  path, so both trigger paths behave identically once inside `execute()` (the whole point of
  a shared resume handler).
- **Cross-path shared-counter proof**: added a dedicated test
  (`run-agent-pipeline.use-case.test.ts`, "a /caf-retry-pipeline-shaped job and a
  Linear-resume-shaped job hit the exact same counter code path") that runs `execute()`
  twice with the two entry points' respective job shapes and asserts
  `incrementOrchestrationRetryCount` was called with identical arguments both times — this
  is the acceptance criterion Task 4's report left as `[ ]` pending Task 5's existence.

## Acceptance Criteria (Task 5 scope)
- [x] Linear webhook checks whether `ai-agent/{TICKET-ID}` already exists before treating a
      "Ready for AI" transition as a new ticket.
- [x] If it exists, routes to the same shared resume path as Task 4 (`isRetry`,
      `maxOrchestrationRetries`, `retryContext`, `checkAndConsumeRetryBudget`) — no
      duplicate/parallel implementation.
- [x] Ticket whose branch already exists does not create a new branch — verified: the
      resume path never calls `gitService.createBranch` (same assertion already covering
      Task 4's isRetry tests, reused unchanged since both paths hit identical `execute()`
      code).
- [x] `orchestrationRetryCount` updated by both trigger paths uses the same counter, proven
      by the dedicated cross-path test above (Task 4's corresponding AC, closed here).
- [x] Test: resume job enqueued with retryContext when an open PR exists —
      `tests/unit/webhook-routing.test.ts` ("enqueues a resume job (isRetry + retryContext
      with the open PR)...").
- [x] Test: resume job enqueued with `retryContext: undefined` when the branch exists but no
      PR is open — `tests/unit/webhook-routing.test.ts` ("...when the branch exists but no
      open PR is found").
- [x] Test: per-repo `maxOrchestrationRetries` override respected on the Linear resume path
      too — `tests/unit/webhook-routing.test.ts` ("uses the per-repo maxOrchestrationRetries
      override when resuming").
- [x] Regression: normal new-ticket flow (branch doesn't exist) unaffected —
      `tests/unit/webhook-routing.test.ts` ("does not create a new branch/job shape when no
      ai-agent branch exists").
- [ ] **Live verify** — not run against real Linear/GitHub this session (same caveat as
      Tasks 3/4).

## Quality Gate
- Typecheck (`pnpm typecheck`): PASS, no errors.
- Lint (`pnpm lint`): PASS, no errors (same pre-existing unrelated ESM/CJS warning, not
  touched by this task).
- Test (`pnpm test`): 302/302 tests pass (26 files) — 4 new Linear-webhook resume cases
  (`webhook-routing.test.ts`), 1 new cross-path shared-counter proof
  (`run-agent-pipeline.use-case.test.ts`), plus 2 assertions fixed in
  `github-webhook-routing.test.ts` for the `RetryContext`/`maxOrchestrationRetries`
  refactor. Zero regressions.

## Files changed
- `src/domain/interfaces/queue.interface.ts` — `RetryContext` narrowed to
  `{owner, repo, prNumber}`; `ExistingJobPayload` gains a top-level
  `maxOrchestrationRetries?: number` (moved out of `RetryContext`).
- `src/infrastructure/vcs/github.service.ts` — new `branchExists(owner, repo, branch)`.
- `src/application/use-cases/run-agent-pipeline.use-case.ts` — `checkAndConsumeRetryBudget`
  reads `job.maxOrchestrationRetries` (top-level) instead of
  `job.retryContext?.maxOrchestrationRetries`.
- `src/presentation/web/routes/webhooks.ts` — Linear webhook's `/linear` handler gains the
  branch-exists resume check (before the existing "new ticket" `jobData` construction);
  Task 4's `handleRetryPipelineCommand` updated for the `RetryContext` refactor.
- `tests/unit/webhook-routing.test.ts` — new `githubService` mock (`branchExists`,
  `findOpenPullRequestByHead`, real `parseGithubRepo` via `importOriginal`); 4 new resume
  cases.
- `tests/unit/github-webhook-routing.test.ts` — 2 assertions updated for the
  `RetryContext`/`maxOrchestrationRetries` refactor.
- `tests/unit/run-agent-pipeline.use-case.test.ts` — `makeRetryJob` helper updated for the
  refactor; 1 new cross-path shared-counter test.
- `CLAUDE.md` — rewrote the "`/caf-retry-pipeline` resume" subsection to describe both
  trigger paths converging on the same mechanism, instead of describing Task 4 alone with a
  "not yet wired" note for Task 5.

## Catatan
- With Task 4 + Task 5 both done, the full CAF-RETRYPIPELINE-01 acceptance criterion "retry
  dari dua jalur berbeda memakai counter yang sama, bukan counter terpisah" is now backed by
  a direct test, not just an architectural claim.
- Remaining explicit gaps for whoever picks up Task 6: (1) resume is a full restart, not
  gate-aware — no skip-to-failed-gate logic reads `lastFailedGate` to decide which agent to
  re-run; (2) no manual-change diffing (`git diff {lastKnownCommitSha}..HEAD --stat` /
  `manualChangesSinceLastRun`) is computed or injected into agent context; (3) no
  uncommitted-residue detection/stop before the `preflightCleanup`-based sync — the retry
  sync added in Task 4 already does `fetch` + `reset --hard` unconditionally, same
  destructive-but-audited behavior as the existing CAF-WSMODE-01 preflight cleanup, just
  pointed at the ticket branch instead of `baseBranch`.
- Did not touch `qaRetryCount`/`reviewerRetryCount`, `caf-pr-review` (`/caf-review`,
  `/caf-fix-review`), or any whitelist/permission logic beyond reusing
  `checkReviewPermission` as-is — confirmed via `git diff --stat`.
