# CAF-SDD-04b — Verify Report (in progress)
Status: IN_PROGRESS

## T1 Audit (read-only, before any `src/` change)

Verdict: no AC contradicted, A1-A4 hold. No STOP.

- **A1 (requirements.md location)**: confirmed. `.caf/tasks/<KEY>/requirements.md` — `readRequirements()` in `report-reader.ts` and the planner/validator prompts in `run-agent-pipeline.use-case.ts` (`buildPrBody`, `runQaGate`) all use it.
- **A2 (per-AC table shape)**: no real validator output exists in this repo. The only example is the fixture written for 04a in `tests/unit/report-reader.sdd04a.test.ts` (`| AC | Status | Evidence kind | Evidence |` / `| AC-1 | PASS | automated-test | foo.test.ts::bar |`), which matches the shape in the requirements (id col 1, status col 2, evidence col 4). New fixtures in this ticket are written to that shape plus backtick/bold/lowercase variants.
- **A3**: suffix ids supported by the parser regex (`AC-7b`).
- **A4**: confirmed. One function, `buildFixReviewPrompt()` in `run-pr-review.use-case.ts`, serves both `scoped` and `global`; `fix-review-log.md` is written by `caf-reviewer` (prompt: "tulis `fix-review-log.md` saja"); read by `readFixReviewLog()`.
- **`lastFailedGate` / gate `qa` usages**: type `OrchestrationGate` + `recordGateFailure`/`readOrchestrationState` (`orchestration-state.ts`); `recordGateExhaustion`, `readGateArtifact`, `pushAndOpenGatePr`, `GATE_ARTIFACT_FILE`, `buildGateExhaustionPrBody`, resume `gate` in `run-agent-pipeline.use-case.ts`. Dashboard `FloorGate`/event-normalizer derive `gate: 'qa'` from agent events (agent-name based, 04a), not from `orchestration-state.json`; SQLite stores `agent_name`/event types only — no gate column. So the dashboard and DB need no change. Notifier takes free-text reasons only. The skip directive `- QA:` (`SkippableAgent 'qa'`) and config `agents.qa.*` are out of scope and unchanged.
- **PR body builders**: `buildPrBody` (normal PR) and `buildGateExhaustionPrBody` (Draft PR, via `pushAndOpenGatePr`) in `run-agent-pipeline.use-case.ts`.
- **Tests locking things**: `run-agent-pipeline.use-case.test.ts` (mocks `report-reader.js` with a fixed factory — no `readRequirements` — and `orchestration-state.js`; asserts `recordGateFailure(..., 'qa', ...)` at ~L684), `run-agent-pipeline.validator-gate.test.ts` (`lastFailedGate: 'qa'` resume), `orchestration-state.test.ts` (reads stored `'qa'`), `run-pr-review.use-case.test.ts` (prompt text incl. `tulis \`...fix-review-log.md\` saja`).

### Design decisions from T1
- The new AC logic lives in a new pure module (`infrastructure/reports/ac-summary.ts`) that is **not** in the mocked `report-reader.js`, and requirements.md is read there with plain `fs`. Reason: the existing use-case tests mock `report-reader.js` with a closed factory; importing a new export from it would throw there. A missing requirements.md (every existing test's fake repo path) yields no summary, which is exactly AC-5.
- Legacy `qa` stays a valid *stored* value (read as `validate`); the reader of `orchestration-state.json` is unchanged so `orchestration-state.test.ts` stays untouched.
