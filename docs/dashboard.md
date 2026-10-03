# Pipeline Monitoring Dashboard

CAF-DASHBOARD-01: a small operator dashboard for watching agent pipeline runs
live and browsing their history — pipeline-semantic state (PIV phase, retry
counts, cost, artifacts), not just raw job-queue state.

## Accessing it

1. Make sure the feature is turned on. In `caf.config.yaml`:

   ```yaml
   dashboard:
     enabled: true
     basicAuthUser: admin
   ```

   And in `.env`:

   ```
   DASHBOARD_BASIC_AUTH_PASSWORD=<a real password>
   ```

   If `dashboard.enabled` is `false` (the default), the dashboard page and
   its API/SSE endpoints don't exist at all — visiting them 404s.

2. Start the web server (`pnpm dev` or `pnpm start` — the dashboard is
   served by the same Fastify app that receives Linear/GitHub webhooks; you
   do **not** need the worker process running just to view the dashboard,
   only to actually run pipelines).

3. Open `http://<host>:<port>/dashboard` in a browser (e.g.
   `http://localhost:3030/dashboard` for local dev — check `server.port` in
   `caf.config.yaml` for the real port).

4. The browser will show its native HTTP Basic Auth prompt. Use the
   `dashboard.basicAuthUser` / `DASHBOARD_BASIC_AUTH_PASSWORD` values from
   step 1. Once entered, the browser remembers them for the rest of the
   session; you won't be asked again for API/SSE calls the page makes in
   the background.

If you're behind a reverse proxy, make sure `/dashboard`, `/api/pipelines*`,
and `/api/events/stream` are all proxied and served over HTTPS — Basic Auth
credentials are sent in plaintext-equivalent (base64) over the connection.

## Reading the table

Each row is one pipeline run (one ticket, one attempt-in-progress-or-finished).

| Column | Meaning |
|---|---|
| **Repo** | `owner/repo` the ticket belongs to. |
| **Ticket** | Ticket key + title. |
| **Phase** | The PIV phase (`plan` / `implement` / `verify`) of the *most recent* agent event recorded for this run. This is "last known phase," not a guarantee the agent is still actively working in it right now — if the whole pipeline crashed mid-phase, this is where it stopped. |
| **Retries** | Retry count **per gate**, shown as `<agent>: <count>` — e.g. `qa: 1` means the QA gate failed once and the implementation agent(s) were re-run. Only QA and Reviewer produce retries (see "How retries are counted" below); implementation-agent retries don't apply the same way, so `Implementation` never appears here. An em dash (`—`) means no retries yet. |
| **Cost** | Total cost in USD, summed across every agent that has finished so far in this run. See "About the cost figure" below — **this is a real number reported by the `claude` CLI itself, not an estimate.** Shows `belum tersedia` ("not available yet") when no agent has finished yet, not `$0.0000` — a genuinely-free run and a "no data yet" run are deliberately never shown the same way. |
| **Status** | `RUNNING` while the pipeline hasn't concluded (no `finalStatus` recorded yet), otherwise the actual outcome: `SUCCESS`, `NEEDS_HUMAN` (stopped at a gate or a resume-budget rejection — same status, check the timeline for which), or `ERROR` (an unexpected crash — note the underlying job may still be retried by BullMQ, in which case this row resets to `RUNNING` on the next attempt). |
| **Artifact** | Path (inside the target repo's workspace, not a clickable URL — see note below) of the most recent report artifact the pipeline produced — typically `verify-report.md`, `qa-report.md`, or `review-notes.md`, whichever gate most recently ran or failed. An em dash means no artifact recorded yet. |

Click any row to open the detail panel on the right: the full chronological
event timeline for that run (every agent start/end, retry, and gate
exhaustion, each with its own phase/cost/artifact/timestamp).

### About the cost figure

The `claude --print --output-format json` CLI call this orchestrator already
makes for every agent spawn returns a `total_cost_usd` field directly in its
JSON result — a real, API-reported dollar figure, not a token-count×rate
estimate this codebase computes itself. **This is worth calling out
explicitly because the original plan for this feature assumed cost data
might not be available at all and would need to be estimated (see
`.ai/tasks/CAF-DASHBOARD-01/tasks.md` Task 2) — that assumption turned out
to be wrong.** If the `claude` CLI's output format or fields ever change in
a future version, `src/infrastructure/agent/agent-cost-parser.ts`'s
`parseAgentUsage()` is the one place that would need updating — it already
degrades safely to "no cost data" (not a crash, not a wrong number) if the
expected field is missing.

The "Cost" column sums this figure across every agent event that has one —
it does **not** currently distinguish "input tokens were cache-read" vs.
"fresh," or break the total down per-agent in the table (that breakdown is
visible per-event in the click-through detail panel).

### How retries are counted

A retry event's `retryCount` is the retry loop's own running counter (1, 2,
...) at the moment it re-ran the implementation agent(s) — not a count of
how many `retry` rows exist. The table shows whatever the highest count seen
so far is per agent. The maximum retries per gate is
`agents.qa.maxRetries` / `agents.reviewer.maxRetries` in `caf.config.yaml`
(default 1 each) — so `qa: 1` with a `NEEDS_HUMAN` status usually means the
QA gate failed, was retried once (the configured max), failed again, and the
pipeline stopped for human review.

## Live updates

The table updates itself via Server-Sent Events (`/api/events/stream`) — no
manual refresh needed. The connection-status dot in the top-right corner
shows `live` (green) when connected, or `disconnected — retrying…` (red) if
the connection drops; the browser's built-in `EventSource` reconnects
automatically, no page reload required.

Under the hood, each event is a lightweight "something changed for this
repo/ticket" signal (not a full state payload) — the page reacts by
re-fetching `/api/pipelines` (and the open detail panel, if any), so what
you see is always a fresh read from the database, never a client-side
patch that could drift from the truth.

## Agent Floor

CAF-DASHBOARD-02: a second, separate page that shows the same pipeline data
from the agents' side — each CAF agent is a pixel-art character in an office,
moving and reacting as its run progresses. It is **read-only**: there is no
approve, retry, or stop control anywhere on it.

### Accessing it

`http://<host>:<port>/dashboard/agent-floor`, or the **Agent Floor** link in
the dashboard header. Same on/off switch (`dashboard.enabled`) and same Basic
Auth credentials as the dashboard.

Behind a reverse proxy nothing new needs routing as long as `/dashboard` and
`/api/pipelines` are proxied **by prefix**: the page lives under `/dashboard/`
and its data endpoint under `/api/pipelines/`. If your proxy rules match those
paths exactly instead, add `/dashboard/agent-floor*`.

The page loads its two fonts from Google Fonts (as the approved prototype
did). Without internet access it falls back to system fonts; nothing else
depends on an external host.

### The three modes

| Mode | How to get it | Data |
|---|---|---|
| **Live** | Open the page. With no manual choice it follows whichever run is `RUNNING` in the selected repo; with none running, everyone waits in the pantry. | Real, as it happens. |
| **Replay** | Click a finished run in the **Run** list. | Real, read back from the database and played from the start. Costs nothing and triggers nothing. |
| **Demo** | `/dashboard/agent-floor?demo=1`, or the **Demo** button. | Scripted mock scenarios. Makes no data request at all; marked "Data contoh". |

**Jeda** and **1× / 2× / 4×** control animation and replay speed. Replay
compresses real time 30× (a gap between two events plays as 0.35 to 3.5
seconds), so a ten-minute run replays in well under a minute. Pausing does not
hold back live data: new events still arrive and are shown, characters simply
appear at their destination instead of walking there.

The **Repo** selector switches between configured repos that have at least one
recorded run. Runs from different repos are never shown together; the choice
is kept in the URL (`?repo=`).

### Reading the office

| What you see | What it means |
|---|---|
| Everyone in the pantry | No run active in this repo. |
| Typing at a desk | That agent's process is running (plan, implement, QA, or review). |
| Scratching head (and, for QA, a bug in the QA lab) | A QA or Reviewer gate rejected the work and the implementation agents are re-run. The bubble shows the gate's own counter and limit (`retry 1/1`), from `agents.qa.maxRetries` / `agents.reviewer.maxRetries`. |
| Flying document | A report handed from one agent to the next (see "Handoffs" below). |
| Raised hand, red screen, red lamp on Ganjar's desk | `NEEDS_HUMAN`. |
| Small flame | The agent's process failed (`FAILED`, `KILLED`, or `TIMEOUT`); the run is `ERROR` and BullMQ may retry the job. |
| Green lamp on Ganjar's desk | `SUCCESS`; a PR is waiting for human review. |
| Docs asleep, greyed out | Always. See below. |

**Docs (`caf-documentation`) is always off duty, on purpose.** The pipeline
does not record events for that agent (it has no PIV phase), so the page has
nothing to show for it. This is a decision, not a bug — do not "fix" it by
instrumenting the agent.

**Verify bars (lint / typecheck / test) only animate in demo mode.** In a real
run an implementation agent's verify loop happens inside the agent process,
where the orchestrator cannot see it. What is shown instead is read from the
agent's `verify-report.md` *after* it finishes: the log line
"verify percobaan 2/3, lint lolos, ..." and the "Percobaan verify" field. Those
come from a tolerant, display-only parser
(`src/infrastructure/reports/verify-report-details.ts`); anything the report
does not state is left blank rather than guessed. Agents rarely write an
attempt number in practice, so that field is often empty.

**Token counts show "tidak dicatat".** Cost and duration are real; tokens are
not stored yet.

### How it gets its data

```
worker writes agent_events ──► Redis ──► web server ──► SSE "something changed"
                                                              │
page ◄── GET /api/pipelines/:repoId/:ticketId/floor-events?after=<cursor>
```

- The SSE stream (`/api/events/stream`) is still only a nudge — it carries no
  state.
- On each nudge the page asks the endpoint above for whatever is new, passing
  the `cursor` of the last event it handled. A dropped and re-established
  connection therefore cannot deliver an event twice or skip one.
- Replay calls the same endpoint without `after`.
- `repoId` is `owner/repo`, percent-encoded in the path, as for the detail
  endpoint.

Response: `{ run, events, nextCursor }`. Every event has `cursor`, `runId`,
`attempt`, and a server-side `timestamp`.

| Event `type` | Fields | Shown as |
|---|---|---|
| `run_started` | `ticket`, `ticketTitle`, `repo`, `branch`, `startedAt` | Office resets, "Run saat ini" panel filled. One per attempt. |
| `agent_state` | `agent`, `state`, and optionally `gate`, `retry: {count, max}`, `verify`, `outcome` | Character pose, screen, and speech bubble. |
| `handoff` | `from`, `to` (an agent, `human`, or `outbox`), `file` | Flying document. |
| `step` | `step` (`plan`/`impl`/`qa`/`review`/`pr`), `status` (`active`/`pass`/`fail`), `note`, and `prNumber` on the `pr` step | Step list. |
| `usage` | `agent`, `costUsd`, `tokens` (always `null` for now), `durationMs` | "Detail agent" panel. |
| `run_finished` | `finalStatus`, `gate`, `superseded` | Status pill and Ganjar's lamp. |

Agent states: `idle`, `planning`, `implementing`, `verifying`, `retrying`,
`reviewing`, `celebrating`, `blocked`, `error`, `offduty`.

Three things worth knowing when reading that feed:

- **The PR number is on the `pr` step, not on `run_finished`.** The pipeline
  records the PR after it has finalized the run, so `run_finished` is emitted
  before the number exists.
- **Handoffs are derived, not recorded.** The pipeline does not log them; they
  are inferred from the order agents ran in (planner → implementation →
  QA → reviewer, and back on a gate retry).
- **Attempts.** A BullMQ retry or a `/caf-retry-pipeline` resume reuses the
  same run row and starts a new *attempt*; each attempt gets its own
  `run_started` / `run_finished`. Only the latest attempt's final status is
  stored. An earlier attempt is reported `NEEDS_HUMAN` when it ended at a
  gate, and otherwise with `finalStatus: null` and `superseded: true` — the
  page then says the status was not recorded instead of inventing one. Runs
  recorded before attempts existed count as a single attempt.

### What the pipeline records for this

Additive, nullable columns (added to an existing database automatically on
startup; no manual migration):

| Column | Meaning |
|---|---|
| `pipeline_runs.attempt` | 1 on the first start, +1 on every later start of the same run. |
| `pipeline_runs.pr_number` | The final PR, or the Draft PR opened when a gate stopped the run. |
| `agent_events.attempt` | The run's attempt when the row was written. |
| `agent_events.exit_code`, `agent_events.outcome` | How the agent process ended (`OK` / `FAILED` / `KILLED` / `TIMEOUT`), on `end` rows. |
| `agent_events.verify_details` | JSON from the verify-report parser described above, on implementation agents' `end` rows. |

No new `event_type` or `piv_phase` values were introduced.

**None of this touches the pipeline's own gates.** The status parsers in
`report-reader.ts` are unchanged — `Status: SUCCESS` for `verify-report.md`,
`Status: PASS` for `qa-report.md`, the `Verdict:` line for `review-notes.md` —
and so are the retry loops (`qaRetryCount`, `reviewerRetryCount`) and BullMQ's
`queue.jobAttempts`. The verify-details parser is a separate file that only
feeds this page; a report it cannot understand changes nothing about how the
run proceeds.

### Adding a new agent state

1. `src/presentation/web/agent-floor/event-normalizer.ts`: add the state to
   `FloorAgentState` and emit it from `normalizeRun()`. Keep the function pure
   and append-only (a later row must never change an event already emitted) —
   `tests/unit/agent-floor-event-normalizer.test.ts` checks both.
2. `src/presentation/web/ui/agent-floor/translate.js`: map the state to calls
   on the page's public API (bubble text, tone, log line).
3. `src/presentation/web/ui/agent-floor/render.js`: add its label to
   `STATE_LABEL`, and, if it needs its own look, its screen in `screenMode()`
   and its pose in `drawChar()`.

The page's files are split by responsibility, and that split is what keeps the
three modes behaving the same: `render.js` draws and never fetches;
`translate.js` is a pure event-to-calls mapping; `adapter.js` is the only file
that talks to the server (GET only); `demo.js` drives the same public API
(`window.AgentFloor`) from scripted scenarios. They are plain static files —
no build step — served by `routes/agent-floor-ui.ts`.

### If the page shows "Terputus"

The connection badge reads **Terhubung** or **Terputus, mencoba lagi**; the
browser reconnects on its own. The SSE stream is authenticated by a one-hour
cookie that the page sets and that each successful (re)connect renews. If the
cookie has lapsed anyway — a laptop asleep for longer than that — the page
reloads itself once to go back through Basic Auth.

## End-to-end verification

The dashboard has been run against real tickets on real target repos: the
maintainer confirmed on 2026-10-04 that CAF-DASHBOARD-01's real-repo
end-to-end test passed, with runs recorded on `umkm-pos` and
`coderium-web-v2` in September 2026 (see the update note at the top of
`.ai/tasks/CAF-DASHBOARD-01/verify-report.md`).

One combination is not on record: two *different* repos running at the same
moment. Multi-repo separation is covered by automated tests and by real runs
on both repos, but not by a recorded concurrent run.
