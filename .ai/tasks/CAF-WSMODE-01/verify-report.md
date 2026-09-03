## Ticket: CAF-WSMODE-01
## Status: SUCCESS

## Attempt Log

### Attempt 1 (previous session)
Task 0–3 done and tested (config schema, in-memory `WorkspaceLock`, real-repo
`GitService.preflightCleanup()`). Task 4 STOP'd before any coding — full
persistent-mode wiring required touching `run-agent-pipeline.use-case.ts` and
(by singleton-sharing effect) `run-pr-review.use-case.ts`, both explicitly
out-of-scope at the time. Reported `NEEDS_HUMAN`.

### Attempt 2 (implementation session)
Task 4a–4d, 5, 6 implemented after user resolved the attempt-1 scope gap
(`workspacePurpose` parameter + itemized allow-list for the 2 previously
forbidden files). Full details in commits `df4fca5`, `7a27015`, `9555c51`,
`a7f0dc0` on `ai-agent/CAF-WSMODE-01`. One deviation flagged and approved
mid-session: a 4th allowed edit to `run-agent-pipeline.use-case.ts` (clone
vs. `preflightCleanup` conditional) beyond the original 3-point list, because
persistent reuse cannot work end-to-end without it.

### Attempt 3 (this session — read-only final verification)
No code changes made. Re-ran quality gate, re-diffed against `main`, and
re-executed the acceptance-criteria tests fresh (not from memory) to confirm
attempt 2's claims hold.

## 1. Quality Gate (raw output)

```
$ pnpm typecheck
> caf-orchestrator@0.1.0 typecheck /Users/ganjarhadiatna/Projects/CAF/caf-orchestrator
> tsc --noEmit
(no output — exit 0)
```

```
$ pnpm lint
> caf-orchestrator@0.1.0 lint /Users/ganjarhadiatna/Projects/CAF/caf-orchestrator
> eslint src --ext .ts
(node:27930) [MODULE_TYPELESS_PACKAGE_JSON] Warning: ... (pre-existing, unrelated to this ticket)
(no lint errors — exit 0)
```

```
$ pnpm test
...
 Test Files  25 passed (25)
      Tests  241 passed (241)
   Start at  14:49:00
   Duration  1.51s
```

Result: **PASS / PASS / PASS (241/241)**.

## 2. Diff Scope Check — Forbidden Files

```
$ git log --oneline main..HEAD
a7f0dc0 feat: enhance workspace mode documentation...
9555c51 feat: add integration tests for workspace modes...
7a27015 feat: implement workspace purpose handling...
df4fca5 feat: update requirements, tasks, and verification report...
4293438 feat: add unit tests for GitService.preflightCleanup and WorkspaceLock...
49726a1 feat: update workspace mode description...
de674eb feat: implement persistent workspace mode and locking mechanism...
fdf27a0 feat: add design, requirements, tasks, and verification report...

$ git status --short
(clean — nothing uncommitted)
```

```
$ git diff --stat main...HEAD
.ai/tasks/CAF-WSMODE-01/design.md                  |  93 ++++++++
.ai/tasks/CAF-WSMODE-01/requirements.md            | 137 +++++++++++
.ai/tasks/CAF-WSMODE-01/tasks.md                   | 135 +++++++++++
.ai/tasks/CAF-WSMODE-01/verify-report.md           | 195 ++++++++++++++++
caf.config.example.yaml                            |  18 ++
.../use-cases/run-agent-pipeline.use-case.ts       |  42 +++-
.../use-cases/run-pr-review.use-case.ts            |   6 +-
src/config/schema.ts                               |   7 +-
src/domain/errors/app-errors.ts                    |   7 +
src/domain/interfaces/git.interface.ts             |  70 +++++-
src/infrastructure/git/git.service.ts              |  35 ++-
src/infrastructure/git/workspace-lock.ts           |  29 +++
src/infrastructure/git/workspace.manager.ts        |  30 ++-
tests/unit/git-preflight-cleanup.test.ts           |  83 +++++++
tests/unit/run-pr-review.use-case.test.ts          |   6 +-
tests/unit/workspace-lock.test.ts                  |  40 ++++
tests/unit/workspace-mode-integration.test.ts      | 257 +++++++++++++++++++++
tests/unit/workspace.manager.test.ts               |  71 +++++-
18 files changed, 1245 insertions(+), 16 deletions(-)
```

- **`caf-initiator`**: not in the file list. Working directory this whole
  session is `caf-orchestrator` only — confirmed.
- **`report-reader.ts`**: not in the file list. Clean.
- **Retry logic in `run-agent-pipeline.use-case.ts`**:
  `grep -n "qaRetryCount\|reviewerRetryCount\|MAX_QA_RETRIES\|MAX_REVIEWER_RETRIES"`
  against `git diff main...HEAD -- .../run-agent-pipeline.use-case.ts` →
  **0 matches**. File changed (as expected — see §3) but none of the retry
  mechanism's lines are touched.

## 3. Diff Scope Check — Allowed-But-Limited Files (full diff)

### `run-agent-pipeline.use-case.ts`

```diff
@@ -1,4 +1,6 @@
-import type { IGitService, IWorkspaceManager } from '../../domain/interfaces/git.interface.js';
+import { existsSync } from 'node:fs';
+import type { IGitService, IWorkspaceManager, WorkspacePurpose } from '../../domain/interfaces/git.interface.js';
+import { WorkspaceLockError } from '../../domain/errors/app-errors.js';
 import type { IAgentRunner } from '../../domain/interfaces/agent-runner.interface.js';
 import type { ILinearClient } from '../../domain/interfaces/linear-client.interface.js';
 import type { INotifier } from '../../domain/interfaces/notifier.interface.js';
@@ -146,7 +148,31 @@ export class RunAgentPipelineUseCase {
-    const workspacePath = await workspaceManager.createWorkspace(workspaceRoot);
+    const workspacePurpose: WorkspacePurpose = 'ticket-pipeline';
+    const { repo: repoIdentifier } = parseGithubRepo(job.projectConfig.repoCloneUrl);
+
+    let workspacePath: string;
+    try {
+      workspacePath = await workspaceManager.createWorkspace(workspaceRoot, workspacePurpose, repoIdentifier);
+    } catch (err) {
+      if (err instanceof WorkspaceLockError) {
+        logger.info('Workspace busy, stopping pipeline for human retry', undefined, { ... });
+        await this.postTicketComment(job, `Agent pipeline could not start: this repo's persistent workspace is busy with another job. Please retry once that job finishes.`);
+        return;
+      }
+      throw err;
+    }
+
     const repoPath = `${workspacePath}/repo`;
     const branch = `ai-agent/${job.ticketKey}`;
@@ -157,7 +183,15 @@ export class RunAgentPipelineUseCase {
-      await gitService.clone(job.projectConfig.repoCloneUrl, job.projectConfig.baseBranch, repoPath, workspaceRoot);
+      if (existsSync(`${repoPath}/.git`)) {
+        await gitService.preflightCleanup(repoPath, job.projectConfig.baseBranch, workspaceRoot);
+      } else {
+        await gitService.clone(job.projectConfig.repoCloneUrl, job.projectConfig.baseBranch, repoPath, workspaceRoot);
+      }
       await gitService.createBranch(repoPath, branch, workspaceRoot);
@@ -512,7 +546,7 @@ export class RunAgentPipelineUseCase {
-      await workspaceManager.cleanupWorkspace(workspacePath, workspaceRoot);
+      await workspaceManager.cleanupWorkspace(workspacePath, workspaceRoot, workspacePurpose);
```

Line-by-line match against `requirements.md`'s "Scope Resmi Diperluas" (4
points, the 4th user-approved mid-session):
1. ✅ `workspacePurpose: 'ticket-pipeline'` passed to `createWorkspace()`
2. ✅ try/catch `WorkspaceLockError` → `postTicketComment` + `return` (not `throw`)
3. ✅ clone call made conditional (skip + `preflightCleanup()` on reuse)
4. ✅ `cleanupWorkspace()` in `finally` now passes `workspacePurpose`

**No lines changed outside these 4 points.** No retry-logic, no other
control-flow, no step reordering.

### `run-pr-review.use-case.ts`

```diff
@@ -112,7 +112,9 @@ export class RunPrReviewUseCase {
-    const workspacePath = await workspaceManager.createWorkspace();
+    const workspacePath = await workspaceManager.createWorkspace(undefined, 'pr-review');
     const repoPath = `${workspacePath}/repo`;
@@ -224,7 +226,7 @@ export class RunPrReviewUseCase {
-      await workspaceManager.cleanupWorkspace(workspacePath);
+      await workspaceManager.cleanupWorkspace(workspacePath, undefined, 'pr-review');
```

Matches the 1 allowed point exactly (`workspacePurpose: 'pr-review'` at both
call sites). **No review logic touched.**

## 4. Acceptance Criteria — Re-Verified With Evidence

| # | Criteria | Evidence (file:line) | Test | Result |
|---|---|---|---|---|
| 1 | `workspace.mode` settable, zod-validated | `src/config/schema.ts:142` — `mode: z.enum(['ephemeral','persistent']).default('ephemeral')` | (schema, exercised by all tests below) | ✅ |
| 2 | Omitted → identical to pre-change behavior | `caf.config.yaml` (this repo) has no `mode` field | `workspace-mode-integration.test.ts` → "workspace.mode: ephemeral — every ticket-pipeline run clones fresh..." | ✅ PASS (re-run, see §5) |
| 3 | Persistent: 2nd job for same repo can't start while 1st holds lock | `workspace.manager.ts:27-33` (`workspaceLock.acquire` in `createWorkspace`), `:49-51` (`release` in `cleanupWorkspace`) | `workspace-mode-integration.test.ts` → "rejects a ticket-pipeline job with a real \"workspace busy\" comment..." (end-to-end, see below) | ✅ PASS |
| 4 | Persistent: pre-flight cleanup result logged explicitly | `git.service.ts:137` (`logger.warn`, dirty case), `:149` (`logger.info`, always) | `git-preflight-cleanup.test.ts` (real repo) + `workspace-mode-integration.test.ts` → "second ticket-pipeline job... reuses the dir via preflightCleanup" | ✅ PASS |
| 5 | NEEDS_HUMAN job w/ uncommitted changes → audit trail, not silent | `git.service.ts:128-143` (branch/HEAD/status captured before `logger.warn`, only when `hadUncommittedChanges`) | `git-preflight-cleanup.test.ts` → "discards uncommitted changes, resets to origin/main, and logs an audit trail before the reset" | ✅ PASS |
| 6 | `caf-initiator` untouched | n/a | `git diff --stat main...HEAD` (§2) — not listed | ✅ |
| 7 | Docs: `caf.config.example.yaml` updated | `caf.config.example.yaml:28-45` | manual read | ✅ |
| 8 **[BARU]** | `workspace.mode: persistent` global does NOT affect `RunPrReviewUseCase` | `run-pr-review.use-case.ts:114-116,227` (`workspacePurpose: 'pr-review'` always) + `workspace.manager.ts:13-15` (`isPersistentTicketPipeline` gates strictly on `'ticket-pipeline'`) | unit: `workspace.manager.test.ts` → "ephemeral job-<uuid> dir when workspace.mode is persistent but workspacePurpose is pr-review"; **end-to-end**: `workspace-mode-integration.test.ts` → "a PR-review job for the same repo (same global persistent config) still clones fresh into an ephemeral dir and cleans up" | ✅ PASS (both levels) |
| 9 **[BARU]** | Lock rejected → real Linear comment sent, job returns cleanly | `run-agent-pipeline.use-case.ts:157-172` (catch block) | **end-to-end**: `workspace-mode-integration.test.ts` → "rejects a ticket-pipeline job with a real \"workspace busy\" comment posted to Linear..." — asserts an actual `linearClient.postComment(ticketId, body)` call, `body` matches `/busy/i`, not just `WorkspaceLockError` being thrown | ✅ PASS |
| 10 **[BARU]** | Changes to the 2 files limited to the itemized scope | See §3 full diffs | manual line-by-line diff review | ✅ CONFIRMED |

**On the 3 criteria requiring end-to-end proof (§4 of the verification
prompt):** all three (#8, #9, and the clone-skip/`preflightCleanup` behavior
under #4) are backed by `workspace-mode-integration.test.ts`, which uses a
**real bare git repo** and the **real, unmocked `WorkspaceManager` +
`GitService`** — only `GitService.clone`'s target URL is redirected via
`vi.spyOn` (since real github.com isn't reachable in tests); `preflightCleanup`,
`createBranch`, `commitAll`, and `push` all run for real against the fixture.
This is not a component-level unit test standing in for end-to-end — it is
the actual `RunAgentPipelineUseCase.execute()` / `RunPrReviewUseCase.execute()`
call graph running against real git operations and mock `linearClient`/
`vcsClient` (the only things that would otherwise hit the network).

## 5. Task 4d — Confirmed Actually Executed (not just planned)

Re-ran the integration test file directly, fresh, in this verification
session (raw output):

```
$ ./node_modules/.bin/vitest run tests/unit/workspace-mode-integration.test.ts --reporter=verbose

 RUN  v4.1.9 /Users/ganjarhadiatna/Projects/CAF/caf-orchestrator

 ✓ tests/unit/workspace-mode-integration.test.ts > CAF-WSMODE-01 Task 4d — cross-purpose persistent/ephemeral integration > first ticket-pipeline job clones fresh into persistent-<repo> and leaves it in place 107ms
 ✓ tests/unit/workspace-mode-integration.test.ts > CAF-WSMODE-01 Task 4d — cross-purpose persistent/ephemeral integration > second ticket-pipeline job for the same repo reuses the dir via preflightCleanup instead of re-cloning 179ms
 ✓ tests/unit/workspace-mode-integration.test.ts > CAF-WSMODE-01 Task 4d — cross-purpose persistent/ephemeral integration > a PR-review job for the same repo (same global persistent config) still clones fresh into an ephemeral dir and cleans up 53ms
 ✓ tests/unit/workspace-mode-integration.test.ts > CAF-WSMODE-01 Task 4d — cross-purpose persistent/ephemeral integration > rejects a ticket-pipeline job with a real "workspace busy" comment posted to Linear when the lock is already held 1ms
 ✓ tests/unit/workspace-mode-integration.test.ts > CAF-WSMODE-01 Task 4d — cross-purpose persistent/ephemeral integration > workspace.mode: ephemeral — every ticket-pipeline run clones fresh into a new dir and fully removes it after, real repo 341ms

 Test Files  1 passed (1)
      Tests  5 passed (5)
   Start at  14:49:30
   Duration  1.10s
```

Test 1 → 2 sequencing (same `describe` block, shared `gitService`/
`workspaceManager` instances, `beforeAll`-seeded fixture repo) is exactly
the "1 ticket-pipeline job then 1 more for the same repo" scenario required
by Task 4d — asserted via `gitService.clone` call-count staying at 1 after
job 2 (no re-clone) and `gitService.preflightCleanup` being called with the
reused `repo` path. Test 3 (PR-review, same repo, same persistent config)
runs immediately after in the same suite and asserts a fresh clone target
outside `persistent-testrepo` plus post-job removal. This was executed,
not merely described.

## Quality Gate
- Lint: PASS
- Typecheck: PASS
- Test: PASS (241/241)

## Catatan

### Known follow-up, out of this ticket's scope (carried over from attempt 2)
`createBranch` (`git checkout -b <branch> --`) will fail if a persistent
workspace still has a local branch of the same name left over from a prior
run of the **same ticket** (e.g. a retry). `preflightCleanup` resets to
`baseBranch` but does not delete other local branches. Not covered by this
ticket's acceptance criteria (which cover different-ticket sequential reuse
and lock rejection, not same-ticket retry-after-partial-failure under
persistent mode). Flagging again here since this is the final report —
recommend a follow-up ticket.

### Deviation from literal task wording (carried over from attempt 2, re-confirmed correct)
`GitService.clone` did not receive a `workspacePurpose` parameter as
Task 4a's text originally specified — the reuse-vs-clone decision lives in
the pipeline's own `existsSync` check instead (the user-approved 4th point
in §3). Re-verified in this session: `git.service.ts`'s `clone()` signature
is unchanged from before this ticket (`grep -n "async clone"` shows no
`workspacePurpose` param), consistent with attempt 2's stated design.

No other gaps found. All 4 verification steps (quality gate, forbidden-file
diff, limited-scope diff, acceptance-criteria re-verification) came back
clean on independent re-check.
