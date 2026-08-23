# CAF-REGISTRY-2 — Verify Report

Status: **SUCCESS**

## Decisions confirmed before implementation
1. Regex anchored with trailing `$` (`^([A-Z]+)-\d+$`) — a malformed suffix like `GAN-43-extra` fails closed instead of loosely matching `GAN`.
2. `JobPayload` does not import `ProjectConfig` from `config/` into the domain layer. Instead:
   - `domain/interfaces/queue.interface.ts` defines a new domain-owned `JobProjectContext` type (`repoCloneUrl`, `baseBranch`, `workspaceDir`, `agents.modelOverrides` — the subset actually needed downstream).
   - `infrastructure/linear/project-context-mapper.ts` (`toJobProjectContext`) maps `ProjectConfig` (config layer) → `JobProjectContext` (domain layer) at the point the job payload is built, in the webhook handler.
3. No Telegram notification wired for the fail-closed case this checkpoint — `logger.error(...)` only, per your explicit call to defer notifier wiring to a separate item.

## Changes

- `src/infrastructure/linear/ticket-prefix.ts` (new) — `extractTicketPrefix(identifier)`, anchored regex, returns `undefined` on any non-match.
- `src/domain/interfaces/queue.interface.ts` — added `JobProjectContext`; `JobPayload.projectConfig: JobProjectContext` (required).
- `src/infrastructure/linear/project-context-mapper.ts` (new) — `toJobProjectContext(ProjectConfig): JobProjectContext`.
- `src/config/index.ts` — added `export const projectRegistry: ProjectRegistry = ProjectRegistry.load(YAML_CONFIG_PATH)`, loaded eagerly at module init (same fail-fast pattern as `config`).
- `src/presentation/web/routes/webhooks.ts` — new gate inserted after the existing `ENABLE_PIPELINE_TRIGGER` check, before building `jobData`:
  - extract prefix from `payload.data.identifier`
  - `projectRegistry.getByPrefix(prefix)`
  - if not found: `logger.error(...)` with raw identifier + prefix, return HTTP 200 `{ status: 'ignored', reason: 'No project registered for ticket prefix' }`, **no enqueue**
  - if found: `jobData.projectConfig = toJobProjectContext(projectConfig)`, proceeds to enqueue as before
  - No other line in the handler changed; signature verification, timestamp check, delivery dedupe, DTO parse, and the ready-for-AI/kill-switch checks are untouched and still run first, in the same order.

## Verify checklist

- [x] `pnpm typecheck` — clean
- [x] `pnpm lint` — clean
- [x] Test: `GAN-99` (registered) → 202 enqueued, `addJob` called once, payload's `projectConfig` matches `umkm-pos` mapping exactly
- [x] Test: `XYZ-1` (well-formed, unregistered) → 200, `addJob` never called
- [x] Test: malformed identifiers (`12345`, `gan-1`, `GAN`, `GAN-43-extra`, empty string) → all fail closed at 200, no crash, no enqueue
- [x] Regression: invalid signature → 401, rejected before `projectRegistry.getByPrefix` is ever called (asserted directly via mock call count)
- [x] Regression: duplicate delivery → 200, ignored before routing logic runs
- [x] Regression: non-transition update (no `stateId` in `updatedFrom`) → 200, ignored before routing logic runs
- [x] Full existing suite: `pnpm test` — 159/161 passing; the 2 failures (`tests/unit/spawn-agent.service.test.ts`, asserting `ANTHROPIC_BASE_URL` is unset) are **pre-existing on `main`**, confirmed by `git stash` + re-run before this change — caused by the sandbox environment having `ANTHROPIC_BASE_URL` set, unrelated to this checkpoint's diff.

## New test files
- `tests/unit/ticket-prefix.test.ts` — 6 cases for `extractTicketPrefix`.
- `tests/unit/project-context-mapper.test.ts` — 1 case confirming the field mapping (and that `ticketPrefix` is dropped, as intended — it's config-layer-only).
- `tests/unit/webhook-routing.test.ts` — 8 cases covering the full route via `app.inject()`, with `config`/`projectRegistry` mocked (`vi.mock`, same pattern as `tests/unit/dashboard.test.ts`), `pipelineQueue`/`rawPipelineQueue` mocked, and `claimDelivery` mocked (no real Redis/BullMQ connection touched). Signatures are computed for real over the raw JSON body with the mocked secret, so the signature gate is exercised legitimately, not bypassed.

## Explicitly out of scope (per plan, unchanged)
- `run-agent-pipeline.use-case.ts` does not read `projectConfig` yet (Checkpoint 3).
- `ProjectRegistry` / `ProjectConfig` schema themselves untouched.
- Queue name/structure unchanged — still one queue, payload gained one field.
- `caf.config.yaml` unchanged — still just `umkm-pos` / `GAN`.

## Notes for Checkpoint 3 / follow-ups
- Telegram notification on fail-closed routing was investigated and intentionally deferred — see plan doc `tasks.md` section 5 for why (notifier currently only wired into the worker process, not the web server).
