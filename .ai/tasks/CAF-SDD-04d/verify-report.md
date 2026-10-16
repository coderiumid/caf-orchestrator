# CAF-SDD-04d — Verify Report

Status: SUCCESS

Branch `ai-agent/CAF-SDD-04d` (from main 998561e), local commits only:
- f3a10b6 fix: AC summary only for caf-validator, Clarify on DRAFT with open BLOCKING, untouched dashboard row on rejected resume, mark resumed PR Ready
- 60913eb test: cover CAF-SDD-04d
- 99322b3 docs: describe CAF-SDD-04d behavior in CLAUDE.md and README.md

`pnpm typecheck` exit 0, `pnpm lint` exit 0, `pnpm test` 713 passed (59 files; 681 before this ticket, 32 new).

| AC | Status | Metode | Bukti |
|----|--------|--------|-------|
| AC-1 | PASS | automated test | `run-agent-pipeline.ac-summary.sdd04b.test.ts` "AC-1: caf-qa + AC-n…" (success: PR body/comment without summary, no gate failure) and "AC-1: a caf-qa gate Draft PR…". Both fail on the pre-change use case. Placed in the 04b file, as the AC asks; not a new file. |
| AC-2 | PASS | automated test | Existing 04b validator cases (Q-1 all-UNVERIFIED stop, summary on top) pass with no assertion changed. |
| AC-3 | PASS | automated test | `run-agent-pipeline.ac-summary.sdd04b.test.ts` "AC-3: reviewer CHANGES_REQUESTED…" (summary at top of Draft PR body, before reviewer artifact, `recordGateFailure` gate `reviewer`). Closes F-6. |
| AC-4 | PASS | automated test | Existing 04b skip / no-report cases pass unchanged. |
| AC-5 | PASS | automated test | `run-agent-pipeline.spec-gate.sdd04c.test.ts` "AC-5: unlabelled DRAFT + open BLOCKING…" (state `clarify`, comment starts with marker, push, `NEEDS_HUMAN`, only `caf-planner` ran). Fails on old code. |
| AC-6 | PASS | automated test | Same file "AC-6: labelled DRAFT + open BLOCKING…" (Clarify, no PR create/update). Fails on old code. |
| AC-7 | PASS | automated test | Existing 04c gated/ungated DRAFT cases pass unchanged; plus new "AC-7" case (answered BLOCKING: ungated continues, gated waits for approval) and "D-6" (APPROVED + open BLOCKING continues). |
| AC-8 | PASS | automated test | `run-agent-pipeline.sdd04d.test.ts`: retry and approveSpec both call `markPullRequestReadyForReview({owner:'ganjardbc',repo:'umkm-pos',prNumber:9})` after `updatePullRequest`; comment says "now marked Ready for review". Already-ready (method → false) adds no sentence. |
| AC-9 | PASS | automated test | Same file: first run → `createPullRequest` once, `markPullRequestReadyForReview` not called. |
| AC-10 | PASS | automated test | Same file: mock rejects → `finalizePipelineRun(..., 'SUCCESS')`, never `ERROR`, no throw, `notifyPipelineFailed` not called, comment contains "stays a Draft" and the error text. |
| AC-11 | PASS | automated test | `github-service.sdd04d.test.ts`: GET `draft:false` → one fetch, no GraphQL, resolves `false`. |
| AC-12 | PASS | automated test | Same file: Draft → second fetch to `https://api.github.com/graphql`, body has the `markPullRequestReadyForReview` mutation and `variables.id = node_id`; GraphQL `errors` (HTTP 200), non-2xx GraphQL and failing GET all throw `GithubApiError`. |
| AC-13 | PASS | automated test | `run-agent-pipeline.sdd04d.test.ts` it.each over 5 rejections (no state, clarify-waiting, no Status line, NEEDS_CLARIFICATION, unanswered BLOCKING): `recordPipelineStarted` and `finalizePipelineRun` not called, no agent ran, `/caf-approve-spec` comment posted. All fail on old code. |
| AC-14 | PASS | automated test | Same file, one case each: branch gone, workspace residue, waiting for spec-approval, no state, retry budget spent — instrumentation untouched, no agent ran, comment posted. All fail on old code. |
| AC-15 | PASS | automated test | Same file: gate resume, approved spec and Clarify resume call `recordPipelineStarted` once, before the first `agentRunner.run`, and finalize at the end. Existing 04c cases pass unchanged. |
| AC-16 | PASS | automated test | Same file: first job calls `recordPipelineStarted('ganjardbc/umkm-pos', key, title)` once before the first agent. Existing cases pass unchanged. |
| AC-17 | UNVERIFIED (manual) | manual check | Docs written (see Notes); the manual read-through by Ganjar is still pending. Each of the six statements lives in CLAUDE.md (Clarify/spec gate section, AC summary section) and README.md (Clarify and the spec gate, Requirements). |
| AC-18 | PASS | command | `pnpm typecheck && pnpm lint && pnpm test` → exit 0, 713/713 (see flake note). |

### Notes

**Step 0.** `requirements.md` and `tasks.md` both lacked a trailing newline (hashes b019c27a… / 1962a537…). I appended one newline to each; the hashes then matched exactly (52c94019… / b8364bdd…). Spec content not edited.

**T1 results.** No finding contradicts an AC; implementation went ahead.
- F-1 confirmed: `acSummary` built whenever `qaReportFile !== undefined`.
- F-2 confirmed: `resolveValidationGate()` picks `VALIDATOR_GATE` iff `.claude/agents/caf-validator.md` exists; the same `acSummaryText` feeds the success PR, the validate-gate Draft PR and the reviewer-gate Draft PR.
- F-3 confirmed: `stopForSpecIfNeeded` stopped for `DRAFT` only when `isSpecGated`.
- F-4 confirmed. Paths in `execute()` for `isRetry`/`approveSpec` that stop with no agent run (the AC-14 set): (1) remote branch missing; (2) persistent workspace uncommitted residue; (3) `waitingFor: 'spec-approval'` on a plain retry trigger; (4) `checkAndConsumeRetryBudget` with no state; (5) `checkAndConsumeRetryBudget` with budget spent; (6) every `reject()` in `approveSpecAndReadTasks` (not waiting, no Status line, NEEDS_CLARIFICATION, unanswered BLOCKING — the "not waiting" reject also covers `waitingFor: 'clarify'`). All six lost their `finalizePipelineRun`. A Clarify resume that stops again, and a thrown error, still finalize (agents ran).
- F-5 confirmed: `updatePullRequest` PATCHes `body` only; no draft-state method existed.
- F-6 confirmed: no test covered the reviewer-gate Draft PR body.
- A-1: `config.github.apiUrl` defaults to `https://api.github.com`. Implemented `graphqlUrl()`: host `api.github.com` → `<origin>/graphql`; any other host → `<apiUrl without trailing slash>/graphql`. GHES (`<host>/api/v3` REST, `<host>/api/graphql`) is NOT handled by that fallback (it would give `<host>/api/v3/graphql`); not guessed, per spec. Shape-only deviation, no AC impact.
- A-2: GET PR shape used as fixture: `{ number, draft: boolean, node_id }`. Mutation: `mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { number isDraft } } }`, `variables: { id: node_id }`. Not tried against live GitHub. Scope note (from GitHub docs, unverified here): a fine-grained token needs "Pull requests: write" and a classic token needs `repo`; the existing PR create/update already needs those, but I could not confirm the GraphQL mutation accepts the same token. AC-10 covers the failure path.
- A-3 confirmed (mocks are plain objects).
- A-4 confirmed: nothing before the first agent needs the row.

**Deviations (shape only).**
- `markPullRequestReadyForReview` returns `Promise<boolean>` (true = switched, false = already non-draft) instead of void, so the success comment only claims "marked Ready" when something changed. AC-11 says "returns without error": it does.
- `recordPipelineStarted` for a resumed job is a local `startRun()` closure in `execute()`, called at three points (Clarify resume before the planner, gate resume after the budget is consumed, approveSpec after approval checks pass). `repoId` params removed from the private `checkAndConsumeRetryBudget` and `approveSpecAndReadTasks` since they only existed for the removed finalize calls.
- A resumed job that THROWS before `startRun()` (e.g. clone failure) still hits the generic catch and calls `finalizePipelineRun(..., 'ERROR')` on the untouched row. Not in AC-13/14, so behavior kept as before; BullMQ retries it anyway.
- The success comment is byte-identical when no Ready sentence applies (first run, or PR already non-draft). Otherwise one sentence follows the PR URL line.
- `stopForSpecIfNeeded` now computes `findUnansweredBlockingQuestions` once and uses it for both NEEDS_CLARIFICATION and DRAFT.

**Changes to existing tests.** No existing assertion or golden/snapshot was changed or regenerated; 681 pre-existing tests passed untouched after the source change. Only mechanical edit: added `markPullRequestReadyForReview: vi.fn().mockResolvedValue(true)` to the `vcsClient` mock literal in 6 files (`pipeline-instrumentation-db-unavailable`, `pipeline-instrumentation-integration`, `run-agent-pipeline.ac-summary.sdd04b`, `.spec-gate.sdd04c`, `.use-case`, `.validator-gate`), per A-3 and so the mock satisfies the extended port. New cases were appended to the 04b and 04c-spec-gate files. New files: `tests/unit/run-agent-pipeline.sdd04d.test.ts`, `tests/unit/github-service.sdd04d.test.ts`. I confirmed the new AC-1/5/6 and AC-8/10/13/14 cases fail against the pre-change source.

**Flaky test, unresolved.** One `pnpm test` run (right after the docs commit) reported "1 failed | 712 passed" but I did not capture which test; 19 further full runs were all 713/713. Previously noticed noise: `orchestration-state.test.ts` logs "Unexpected end of JSON input" on a deliberately corrupt file (expected). The one-off failure is unexplained; worth a re-run on your side.

**`.ai/` is not ignored here.** `git status` shows `.ai/tasks/CAF-SDD-04d/` as untracked and `git check-ignore` finds no rule, contrary to the task text. I did not add or commit it; the spec newline edits and this report sit untracked.

**Docs (AC-17), for your manual check.** CLAUDE.md: Clarify/spec-gate section (DRAFT + BLOCKING → Clarify, marker and "delete marker ⇒ all human comments count", label read at trigger arrival, dashboard-row rule, branch-without-state "nothing to resume" + delete branch, Ready-for-review on resumed success replacing the old "stays a Draft" sentence) and AC summary section (validator only). README.md: "Clarify and the spec gate" and "Requirements" paragraphs, same points. The "Ready on success never throws" and "caf-qa unchanged" constraints are stated too.

Proposed Spec Changes: none
