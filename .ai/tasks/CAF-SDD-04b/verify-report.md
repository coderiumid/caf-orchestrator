# CAF-SDD-04b — Verify Report
Ticket: CAF-SDD-04b
Agent: implementation (local commits only; nothing pushed, no PR)
Status: SUCCESS

## Summary
AC parser/counter (`infrastructure/reports/ac-summary.ts`), UNVERIFIED policy (Q-1) at the validation gate, deterministic AC summary at the top of normal and Draft PR bodies, `validate` gate name in new state (legacy `qa` still read), fix-review prompt rule for spec-change comments, README/CLAUDE.md. `pnpm typecheck && pnpm lint && pnpm test`: exit 0, 50 files / 602 tests.

## Acceptance Criteria
| AC | Status | Evidence kind | Evidence |
|----|--------|---------------|----------|
| AC-1 | PASS | automated-test | tests/unit/ac-summary.sdd04b.test.ts::AC-1: parseRequirementAcs |
| AC-2 | PASS | automated-test | tests/unit/ac-summary.sdd04b.test.ts::AC-2: parseReportAcTable (status + Evidence, backtick/bold/lowercase/suffix/escaped pipe; `|` inside a backtick pair stays in the cell, unpaired backtick keeps old split) |
| AC-3 | PASS | automated-test | tests/unit/ac-summary.sdd04b.test.ts::summarizeAcs > AC-3: an AC absent from the report counts UNVERIFIED... |
| AC-4 | PASS | automated-test | tests/unit/ac-summary.sdd04b.test.ts::summarizeAcs > AC-4: an AC in the report but not in requirements.md is not counted |
| AC-5 | PASS | automated-test | ac-summary.sdd04b.test.ts::AC-5 (unit); run-agent-pipeline.ac-summary.sdd04b.test.ts::AC-5: no requirements.md / no AC lines (both cases); all pre-existing tests pass unchanged except the one noted below |
| AC-6 | PASS | automated-test | run-agent-pipeline.ac-summary.sdd04b.test.ts::AC-6 (stops without retry/reviewer; stop after a retry; not applied when gate skipped) |
| AC-7 | PASS | automated-test | run-agent-pipeline.ac-summary.sdd04b.test.ts::AC-7: passes even though some ACs are UNVERIFIED |
| AC-8 | PASS | automated-test | run-agent-pipeline.ac-summary.sdd04b.test.ts::AC-8 / AC-10 > starts with counts and the UNVERIFIED list with reasons; keeps the artifact text below the summary unchanged |
| AC-9 | PASS | automated-test | run-agent-pipeline.ac-summary.sdd04b.test.ts::AC-9 > puts the same summary on top and leaves the artifact part identical; also updates an existing Draft PR |
| AC-10 | PASS | automated-test | ac-summary.sdd04b.test.ts::AC-10 (x2); run-agent-pipeline.ac-summary.sdd04b.test.ts::AC-8 / AC-10 > shows the Proposed Spec Changes line from ### Notes |
| AC-11 | PASS | automated-test | ac-summary.sdd04b.test.ts::renderAcSummary > AC-11; run-agent-pipeline.ac-summary.sdd04b.test.ts::AC-11: runs exactly the same agents with and without an AC summary |
| AC-12 | PASS | automated-test | run-agent-pipeline.ac-summary.sdd04b.test.ts::AC-12 / AC-13 > stores `validate` (caf-validator and caf-qa repos); run-agent-pipeline.use-case.test.ts::stops with NEEDS_HUMAN comment when QA fails twice |
| AC-13 | PASS | automated-test | run-agent-pipeline.ac-summary.sdd04b.test.ts::AC-12 / AC-13 > resumes a stored "qa" / "validate" gate from validate-report.md and from qa-report.md; existing validator-gate.test.ts::AC-7 unchanged |
| AC-14 | PASS | automated-test | run-pr-review.use-case.test.ts::mode global / mode scoped: prompt forbids editing requirements.md / tasks.md...; report-reader.sdd04b.test.ts::AC-14 support |
| AC-15 | PASS | manual | README.md (paragraphs after "Both generations of target repo work...": UNVERIFIED policy, PR summary, `validate` + legacy `qa`, `--role frontend\|backend`); CLAUDE.md "AC summary and the UNVERIFIED policy (CAF-SDD-04b)" |
| AC-16 | PASS | command | `pnpm typecheck && pnpm lint && pnpm test` | expect: exit 0 | observed: exit 0, 50 files, 602 tests |

Unverified: 0

## Fix: pipe inside backticks in the AC table (AC-2)
`splitRow` in `ac-summary.ts` split on every unescaped `|`, so Evidence like `pnpm test | grep ok` was truncated. A `|` between a backtick pair now stays in the cell (`\|` inside the pair is also unescaped); an unpaired backtick keeps the old behaviour (split on the following pipes). Three new tests in `ac-summary.sdd04b.test.ts` under `AC-2: parseReportAcTable`: pipe inside backticks, backtick pair plus `\|` outside, unpaired backtick. `pnpm typecheck && pnpm lint && pnpm test`: exit 0, 50 files / 602 tests. requirements.md and tasks.md untouched.

## Changes to existing tests
- `tests/unit/run-agent-pipeline.use-case.test.ts` (~L684, "stops with NEEDS_HUMAN comment when QA fails twice"): `recordGateFailure` now expected with gate `'validate'` instead of `'qa'`. Reason: AC-12 / Q-4. This was the only existing test changed; every other assertion that locks the `qa` wording (commit message "qa gate", resume text "stopped at the qa gate", ticket comments) is untouched because user-visible wording is deliberately unchanged (`gateLabel()`).
- Searched all test files for `qa` gate / `lastFailedGate` / prompt text: `orchestration-state.test.ts` (reads stored `qa`), `validator-dashboard.sdd04a.test.ts` / `agent-floor-*` (Agent Floor derives its `qa` gate from agent events) need no change.

## Unexpected / decisions
- Existing use-case tests mock `report-reader.js` with a closed factory, so the AC code and `readRequirementsText` live in a new `ac-summary.ts` instead of `report-reader.ts`; otherwise ~every existing test would have thrown on the missing mock export.
- Small addition outside the AC list: `readFixReviewLog` now ends the comment blocks at a `## ` heading, so a `## Proposed Spec Changes` section written right after the last `Notes:` line is not swallowed into that note (test in `report-reader.sdd04b.test.ts`).
- Interpretations (spec silent): (1) the Q-1 stop also applies at the reviewer-gate Draft PR summary, which carries the same summary; (2) a gate skipped by Planner directive yields no summary and no Q-1 rule (no report exists); (3) `Proposed Spec Changes:` values `none`, `n/a`, `-`, `tidak ada` or empty are not shown; (4) for an AC listed twice in the table the worst status wins; (5) the Q-1 stop is also checked after a retry that comes back PASS-all-UNVERIFIED; (6) the reviewer-gate and Q-1 Draft PRs get the summary, the implementation-gate Draft PR does not (no gate report yet).
- A2: no real validator output exists in this repo; parser tested against fixtures in the 03b1 shape (columns AC, Status, Evidence kind, Evidence). If real reports differ, the failure mode is conservative: unparsed rows count as "tidak dilaporkan"; and if *all* rows fail to parse, a `Status: PASS` report would trip the Q-1 stop (human review) rather than pass silently.

## Proposed Spec Changes
- Consider adding an AC for the reviewer-gate Draft PR carrying the summary (implemented as interpretation 1 above, not covered by an AC; covered by no dedicated test).
- Consider stating in requirements.md that the Q-1 stop does not apply to a Planner-skipped gate (interpretation 2; tested in `AC-6 > does not apply when the Planner skipped the gate`).

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
