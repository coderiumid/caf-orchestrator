# Verify Report: CAF-SDD-04h (dashboard and Agent Floor follow the SDD changes)

Status: SUCCESS

## What changed
- DB: nullable `pipeline_runs.waiting_for` (`clarify` | `spec-approval`) and `ac_summary` (JSON counts); both cleared on a new attempt.
- Use case: `recordWaitingFor` in the Clarify and spec-gate stops; `recordAcSummary` when the validator gate has a summary.
- API: `/api/pipelines*` return `waitingFor` and `acSummary`.
- Agent Floor: `spec` step, planner to Manager handoff, `run_finished.waitingFor`/`acSummary`; QA relabelled Validator (internal id `qa` kept); Criteria row; demo scenarios Clarify, spec gate, Q-1.
- Dashboard: "Awaiting clarification" / "Awaiting spec approval" pill, Spec rail stage, "Waiting on you" stat and filter, Criteria in the inspector.
- Docs: `docs/dashboard.md`, `CLAUDE.md`.

## Verified
- `pnpm typecheck`, `pnpm lint`, `pnpm test`: 65 files, 788 tests pass (new: `tests/unit/dashboard-sdd04h.test.ts`).

## Not verified
- Visual check in a browser (Chrome extension was not connected). Layout of the 5-stat row, the 4-stage rail and the Spec step needs a look.
- Live run against a real parked ticket (same blocker as the other SDD smoke tests).
- Legacy `caf-qa` repos show "Validator" on the floor; the event carries no agent name to tell them apart.
