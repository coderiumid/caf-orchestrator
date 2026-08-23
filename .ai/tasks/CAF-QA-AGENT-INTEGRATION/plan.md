# QA Agent Integration Plan — run-agent-pipeline.use-case.ts

## Current state (read 2026-07-04)

`RunAgentPipelineUseCase.execute()` flow, file `src/application/use-cases/run-agent-pipeline.use-case.ts`:

1. clone + branch
2. planner agent → `tasks.md`
3. `routeTasks(tasksMarkdown)` → `['frontend'?, 'backend'?]`, run each sequentially (loop L91-121)
4. `readVerifyReport` → if `NEEDS_HUMAN` → postComment, stop
5. if has Docs Tasks → run `documentation` agent (non-blocking, try/catch)
6. commit, push, postComment SUCCESS

No QA step exists yet. `verify-report.md` (from `report-reader.ts`) is currently what gates NEEDS_HUMAN — this is a *different* artifact from the new `qa-report.md` (QA Agent's own report, per umkm-pos `qa.md`/`backend.md`/`frontend.md` update). Need to confirm: does QA Agent replace/supersede verify-report step, or run alongside it? Assumption for this plan: QA Agent's `qa-report.md` becomes the new gate right after the frontend/backend loop, replacing today's `readVerifyReport` check (steps 3→4 above). Flag this assumption for approval before implementing.

## Target flow

```
frontend/backend agents (loop, L91-121, unchanged)
  ↓ all exit 0
spawn QA agent → read qa-report.md
  PASS → Documentation agent → commit/push/postComment SUCCESS
  FAIL →
    qaRetryCount == 0:
      qaRetryCount = 1
      re-run same frontend/backend agents (loop again; qa-report.md already
        sits in .ai/tasks/<ticketKey>/ so it's auto-visible to the agent as Input)
      spawn QA agent again → read qa-report.md
        PASS → Documentation agent → commit/push/postComment SUCCESS
        FAIL → NEEDS_HUMAN: postComment to Linear, stop (no commit/push)
```

## Code changes

### 1. `src/infrastructure/reports/report-reader.ts`

Add reader for QA report, parallel to `readVerifyReport`:

```ts
export type QaStatus = 'PASS' | 'FAIL';

export interface QaReport {
  status: QaStatus;
  raw: string;
}

export async function readQaReport(workspacePath: string, ticketKey: string): Promise<QaReport | undefined> {
  const raw = await readIfExists(join(taskDir(workspacePath, ticketKey), 'qa-report.md'));
  if (raw === undefined) return undefined;

  const status: QaStatus = /\bPASS\b/.test(raw) ? 'PASS' : 'FAIL';
  return { status, raw };
}
```

(Mirrors `readVerifyReport`'s SUCCESS/NEEDS_HUMAN regex approach — first-match-wins on `PASS`.)

### 2. `src/application/use-cases/run-agent-pipeline.use-case.ts`

- Extract the existing frontend/backend loop (L91-121) into a private method, e.g. `runImplementationAgents(agentsToRun, repoPath, implementationPrompt, job)`, so it can be invoked twice (initial + 1 retry) without duplicating log/error handling.
- Add a QA step method, e.g. `runQaAgent(repoPath, job): Promise<QaReport>` — spawns `agentRunner.run('qa', repoPath, qaPrompt)`, then `readQaReport`; throws if `qa-report.md` missing (same pattern as `verifyReport` today).
- Replace the current block:
  ```
  const verifyReport = await readVerifyReport(...)
  if (!verifyReport) throw ...
  if (verifyReport.status === 'NEEDS_HUMAN') { postComment; return; }
  ```
  with retry-aware QA gate:
  ```ts
  let qaRetryCount = 0;
  let qaReport = await this.runQaGate(repoPath, job);

  while (qaReport.status === 'FAIL' && qaRetryCount < 1) {
    qaRetryCount += 1;
    logger.info('QA failed — retrying implementation agents', undefined, {
      jobId: job.jobId, ticketKey: job.ticketKey, qaRetryCount,
    });
    await this.runImplementationAgents(agentsToRun, repoPath, implementationPrompt, job);
    qaReport = await this.runQaGate(repoPath, job);
  }

  if (qaReport.status === 'FAIL') {
    await linearClient.postComment(
      job.ticketId,
      `Agent pipeline needs human review (QA failed after retry):\n\n${qaReport.raw}`,
    );
    logger.info('Pipeline stopped: QA report FAILED after retry', undefined, {
      jobId: job.jobId, ticketKey: job.ticketKey, qaRetryCount,
    });
    return;
  }
  ```
- `qaRetryCount` is a plain local variable in `execute()` — explicit, not derived from filesystem state (per correction from earlier wrong assumption).
- Docs Tasks step, commit, push, postComment SUCCESS — unchanged, still gated on falling through the while-loop with `qaReport.status === 'PASS'`.
- Decide fate of old `readVerifyReport`/`NEEDS_HUMAN` block: either delete (QA supersedes it) or keep as an earlier separate gate before QA runs. **Needs your call** — plan assumes delete + supersede.

### 3. Agent name `'qa'`

`agentRunner.run(agentName, cwd, prompt)` (`spawn-agent.service.ts`) takes any string, passed as `--agent <agentName>` to Claude CLI — same mechanism as `'documentation'`. Requires a `qa` agent definition to exist in the target repo (umkm-pos, already updated per your description) — no orchestrator-side registration needed.

### 4. Tests

`run-agent-pipeline.use-case.test.ts` (or wherever current pipeline tests live) needs new cases:
- QA PASS first try → docs → success path.
- QA FAIL once → retry agents → QA PASS → success path (assert frontend/backend agentRunner.run called twice, qa.run called twice).
- QA FAIL twice → NEEDS_HUMAN comment posted, no commit/push, no docs agent run.
- Missing `qa-report.md` → throws (mirrors missing `verify-report.md` today).

## Open questions before implementing

1. Confirm QA gate replaces `verifyReport`/NEEDS_HUMAN entirely, vs. running both.
2. QA prompt content — reuse `implementationPrompt` pattern (`Implement...`) or a QA-specific instruction referencing `.ai/tasks/<ticketKey>/qa-report.md` output path?
3. On retry, do frontend+backend both re-run, or only the one(s) QA report blames? Plan assumes re-run both listed in `agentsToRun` (simplest, matches "spawn ulang Frontend/Backend Agent" wording).

No code written yet — awaiting approval.
