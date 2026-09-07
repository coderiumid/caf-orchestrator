# Pipeline Monitoring Dashboard

CAF-DASHBOARD-01: a small operator dashboard for watching agent pipeline runs
live and browsing their history — separate from the Bull Board queue view at
`/admin/queues`, which only shows job-queue state, not pipeline-semantic
state (PIV phase, retry counts, cost, artifacts).

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
   its API/SSE endpoints don't exist at all — visiting them 404s, same as
   Bull Board does when disabled.

2. Start the web server (`pnpm dev` or `pnpm start` — the dashboard is
   served by the same Fastify app that receives Linear/GitHub webhooks; you
   do **not** need the worker process running just to view the dashboard,
   only to actually run pipelines).

3. Open `http://<host>:<port>/dashboard` in a browser (e.g.
   `http://localhost:3030/dashboard` for local dev — check `server.port` in
   `caf.config.yaml` for the real port).

4. The browser will show its native HTTP Basic Auth prompt. Use the
   `dashboard.basicAuthUser` / `DASHBOARD_BASIC_AUTH_PASSWORD` values from
   step 1 — **the same credentials as Bull Board** (`/admin/queues`), not a
   separate login. Once entered, the browser remembers them for the rest of
   the session; you won't be asked again for API/SSE calls the page makes
   in the background.

If you're behind a reverse proxy, make sure `/dashboard`, `/api/pipelines*`,
and `/api/events/stream` are all proxied and served over HTTPS — Basic Auth
credentials are sent in plaintext-equivalent (base64) over the connection,
same caveat as Bull Board.

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

## Known limitation (as of Task 7)

The dashboard's live-update and multi-repo-isolation mechanisms are fully
built and covered by automated tests (see
`.ai/tasks/CAF-DASHBOARD-01/verify-report.md`, Task 4/6/7), and were
manually verified in a browser against realistic seeded data. What has
**not** yet been verified is watching an actual real ticket run end-to-end
against a real target repo (`umkm-pos`) with the dashboard open — that's an
explicit outstanding item, not a silent gap; see the verify report's Task 7
section for exactly what running that check involves.
