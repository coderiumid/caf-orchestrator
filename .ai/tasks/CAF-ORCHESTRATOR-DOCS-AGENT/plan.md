# Plan: Docs Agent in automated pipeline

## Current state (verified)
- `task-router.ts`: `routeTasks()` regex-matches only `Frontend Tasks` / `Backend Tasks` headers → `TaskAgent[]`. `Docs Tasks` section is never parsed; if planner writes DOC-N items they're silently dropped.
- `run-agent-pipeline.use-case.ts`: Planner → loop over `agentsToRun` (frontend/backend) → `readVerifyReport` → if `NEEDS_HUMAN` postComment+return → else `commitAll`+`push`+postComment+notify.
- Retry model: **no per-agent retry inside the use-case.** BullMQ job itself has `attempts: 3` + exponential backoff (client.ts:18-23) — on any throw, the *whole job* (clone→planner→impl→verify) re-runs. There is no step-resume.
- Consequence: docs step must never `throw` on failure/NEEDS_HUMAN, or a non-blocking doc gap would trigger full pipeline retries (wasted planner/impl runs) and could eventually mark the job FAILED for something explicitly declared non-blocking.

## Changes

### 1. `task-router.ts`
Add pure function, no behavior change to `routeTasks`:
```ts
const DOCS_SECTION = /^#{1,6}\s*Docs Tasks\s*$/im;

export function hasDocsTasks(tasksMarkdown: string): boolean {
  const match = DOCS_SECTION.exec(tasksMarkdown);
  if (!match) return false;
  const rest = tasksMarkdown.slice(match.index + match[0].length);
  const nextHeader = /^#{1,6}\s/m.exec(rest);
  const body = (nextHeader ? rest.slice(0, nextHeader.index) : rest).trim();
  return body.length > 0 && !/^\(none\)$/i.test(body);
}
```

### 2. `run-agent-pipeline.use-case.ts`
Insert **after** the `verifyReport.status === 'NEEDS_HUMAN'` early-return, **before** `commitAll`/`push` (so doc edits land in same commit/branch):

```ts
let docsNote = 'No Docs Tasks in tasks.md — nothing to update.';

if (hasDocsTasks(tasksMarkdown)) {
  const docsPrompt = `Implement the Docs Tasks section of .ai/tasks/${job.ticketKey}/tasks.md for ticket ${job.ticketKey}.`;
  try {
    const docsResult = await agentRunner.run('documentation', repoPath, docsPrompt);
    logger.info('documentation agent run result', undefined, {
      jobId: job.jobId, ticketKey: job.ticketKey, agentName: 'documentation',
      exitCode: docsResult.exitCode, signal: docsResult.signal,
      timedOut: docsResult.timedOut, stdout: docsResult.stdout, stderr: docsResult.stderr,
    });
    if (docsResult.signal || docsResult.exitCode !== 0) {
      logger.error('documentation agent run failed', undefined, { ...same fields... });
      docsNote = 'Documentation agent failed — docs need manual update.';
    } else {
      docsNote = 'Documentation agent updated docs (see diff in branch).';
    }
  } catch (docsErr) {
    // swallow — docs is non-blocking per CAF Layer 2. Do not rethrow.
    logger.error('documentation agent threw', docsErr instanceof Error ? docsErr : new Error(String(docsErr)),
      { jobId: job.jobId, ticketKey: job.ticketKey });
    docsNote = 'Documentation agent errored — docs need manual update.';
  }
}
```

Then append `docsNote` into the existing `postComment` success message:
```ts
await linearClient.postComment(
  job.ticketId,
  `Agent pipeline complete. Branch pushed: \`${branch}\`\n\n${docsNote}\n\n${verifyReport.raw}`,
);
```

### 3. Sequencing decision
Sequential, after Frontend/Backend SUCCESS — not parallel. CAF doc says "parallel, non-blocking" but v1 automation keeps it simple: one extra sequential step reusing the exact same run/log/error pattern already proven for frontend/backend. Parallelism is a later optimization, not needed for correctness.

### 4. Failure isolation (key requirement)
- Docs step wrapped in try/catch, **never throws out of `execute()`**.
- Whatever happens (success, non-zero exit, signal, thrown error), pipeline continues to `commitAll`/`push`/postComment with status derived from `verifyReport` only (unaffected by docs outcome).
- Overall job only fails (triggering BullMQ's `attempts: 3`) for planner/frontend/backend/git failures, same as today.

### 5. Linear comment contract
- Docs ran + succeeded → name-check: comment states docs were updated (full detail lives in branch diff + docsResult.stdout already logged).
- Docs section empty/absent → comment explicitly states no docs work was needed.
- Docs ran + failed/threw → comment explicitly states "documentation needs manual update" — never silent, closing the GAN-37 gap.

### 6. Tests to add (tests/unit/run-agent-pipeline.use-case.test.ts)
- tasks.md with non-empty Docs Tasks + documentation agent success → docs note in comment, branch still pushed.
- tasks.md with Docs Tasks == `(none)` or absent → docs agent never invoked (assert agentRunner.run not called with 'documentation').
- documentation agent returns non-zero exit → pipeline still SUCCESS/pushed, comment says manual update needed, no throw.
- documentation agent runner throws → same as above, caught.
- unit test for `hasDocsTasks()` directly (present+content, present+"(none)", absent, present+whitespace-only).

## Explicitly out of scope for v1
- True parallel execution of documentation agent alongside frontend/backend.
- Per-step retry (only whole-job BullMQ retry exists today; not changing that model here).
