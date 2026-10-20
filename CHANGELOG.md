# Changelog

All notable changes to caf-orchestrator are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/) (pre-1.0: minor and patch releases may still change behavior).

## [0.2.0] - 2026-10-20

### Added
- Terminal UI, `pnpm tui` (`pnpm start:tui` after a build): a control panel that
  starts and stops the web server, worker and Cloudflare tunnel, shows queue and
  Redis / DB / HTTP health, summary cards, the run list, a text version of the
  Agent Floor, live logs, a command palette and a failed-job list with retry.
  It needs no browser, login or running web server. See `docs/tui.md`.
- Cloudflare tunnel runner, `pnpm tunnel` (`pnpm start:tunnel` after a build),
  so Linear and GitHub webhooks can reach a local machine. Settings:
  `TUNNEL_NAME`, `TUNNEL_URL`, `TUNNEL_TARGET_URL`, `CLOUDFLARED_BIN` in `.env`.
  Also controllable from the TUI.
- Dashboard login page at `/dashboard/login` with a signed, HttpOnly session
  cookie (12 hours) and a **Log out** button.
- `DASHBOARD_DEFAULT_VIEW` (`dashboard` | `agent-floor`) in `.env` chooses what
  `/dashboard` shows.
- Agent Floor header shows total cost and average cost per run for the runs in
  the selected repo (runs without a recorded cost are left out of the average).

### Changed
- The dashboard no longer uses browser Basic Auth. `dashboard.basicAuthUser` and
  `DASHBOARD_BASIC_AUTH_PASSWORD` are still the credentials, but they are now
  entered on the login page. Changing either invalidates every session. Behind a
  reverse proxy, also proxy `/dashboard/login`, `/dashboard/logout` and
  `/dashboard/floor/*`, and send `X-Forwarded-Proto: https` so the cookie gets
  the `Secure` flag.
- The Agent Floor is no longer served at `/dashboard/agent-floor`. `GET /dashboard`
  serves either view; its files are under `/dashboard/floor/*`.
- Docker image copies the login page's static files.
- README documents the TUI and the tunnel.

## [0.1.1] - 2026-10-20

### Added
- Dashboard and Agent Floor show a ticket run that is parked on a person as
  waiting, not failed (CAF-SDD-04h):
  - Dashboard: "Awaiting clarification" and "Awaiting spec approval" pills, a
    Spec stage on the run rail, a "Waiting on you" stat and status filter, and
    the next step in the run inspector. "Needs attention" now counts only gate
    stops and errors.
  - Agent Floor: a Spec step, the Planner's `requirements.md` handed to the
    Manager, and a status line saying what the person has to do.
  - Validator acceptance-criteria counts (pass / fail / unverified) in the run
    inspector and on the Floor. A validator `PASS` with every criterion
    unverified is marked "none proven" (Q-1).
  - Three Agent Floor demo scenarios: Spec needs answers, Spec awaits approval,
    Nothing proven (Q-1).
- `pipeline_runs.waiting_for` and `pipeline_runs.ac_summary`: nullable columns
  added to existing databases automatically on startup; cleared when a new
  attempt starts. `/api/pipelines*` return them as `waitingFor` and `acSummary`.
- `.github/workflows/release.yml`: a `v*` tag creates a GitHub Release with
  generated notes, after checking the tag matches the `package.json` version.
- `CHANGELOG.md`.

### Changed
- The QA desk is now labelled **Validator** on the Agent Floor (step "Validate",
  report `validate-report.md`). The internal agent id `qa`, the API values and
  the `agents.qa.*` config keys are unchanged. A repo still on `caf-qa` also
  shows "Validator" on the floor.
- `docs/dashboard.md` and `CLAUDE.md` describe the waiting states, the criteria
  counts and the Validator naming.

### Fixed
- Docs no longer claim the git token can end up in `.git/config` (closed by
  CAF-SDD-04g in 0.1.0).

### Notes
- The new columns are display-only. Gates, retry loops and webhook behavior are
  unchanged.
- Not yet verified against a live ticket parked on Clarify or the spec gate; the
  VPS smoke tests are still pending.

## [0.1.0] - 2026-10-19

First tagged release. Includes the spec-driven-development integration
(CAF-SDD-04a to 04g).

### Added
- Webhook receiver (Fastify) and BullMQ worker that run the CAF agent chain
  (`caf-planner`, `caf-frontend` / `caf-backend`, validation gate, `caf-reviewer`,
  optional `caf-documentation`) against a target repo and open a Pull Request.
  Linear and GitHub Issues triggers; PR-comment commands `/caf-retry-pipeline`,
  `/caf-review`, `/caf-fix-review`.
- `caf-validator` as a first-class gate, chosen when the checkout has
  `.claude/agents/caf-validator.md`; `caf-qa` repos keep working (04a).
- Per-AC summary in PR bodies and the rule that a `PASS` with every acceptance
  criterion UNVERIFIED stops the run as needs-human (04b).
- Clarify via the ticket (`NEEDS_CLARIFICATION` or unanswered BLOCKING
  questions), the spec-approval gate for tickets with the `spec-approval` label,
  and `/caf-approve-spec` (04c, 04d).
- Restricted validator run: `dontAsk` permission mode, Bash allowlist
  (`agents.validator.allowedCommands`, `restrictBash`) and an env without
  orchestrator secrets (04f).
- Git authentication through a per-process env header, so `GITHUB_TOKEN` is
  never written to the workspace or `.git/config`; needs git >= 2.31 (04g).
- Pipeline dashboard and Agent Floor (read-only), SSE live updates, SQLite run
  history, Telegram notifications.

### Fixed
- `fix-review-log.md` parsing no longer cuts a comment block at a `## ` line
  inside a code fence (04e).
