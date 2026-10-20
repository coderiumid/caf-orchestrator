# Terminal UI (`pnpm tui`)

A terminal control panel for local/ops use: start and stop the web server and the worker, and watch pipeline runs live. It shows the same data as `/dashboard` but needs no browser, no basic auth and no running web server.

```bash
pnpm tui          # tsx, no build needed
pnpm build && pnpm start:tui   # compiled
```

Needs an interactive terminal, `.env`, `caf.config.yaml` and a reachable Redis (`REDIS_URL`). Redis is **not** managed by the TUI, only shown as up/down. If config is invalid the TUI still opens, lists the problems in a modal, and refuses to start the processes.

## Layout

The look is flat with one accent: no borders. Panels are separated by three greys (screen, panel, raised) and generous air: a 2-column margin, 2-column gaps between panels, and 2 columns / 1 row of padding inside each. Colour is reserved for status (green ok, yellow waiting, red failed, blue info) plus one accent (orange) for "what you are on" (the selected run, the active step, the active tab). All colours live in `presentation/theme.ts`.

```
  CAF Orchestrator v0.1.1                                                  ▱▱▱▱▱▱  Tue 20 Oct  21:16:54

  ● server ↑11s   ● worker ↑11s   ● tunnel ↑11s │ ● redis  ● db  ● http          0 waiting · 0 active · 4 failed

   ACTIVE          COMPLETED         WAITING ON YOU     NEEDS ATTENTION      SPEND
   ◉ 0             ✔ 3               ◷ 0                ▲ 4                  ◈ $4.31 ▄▆▆▄▃█▅
   all quiet       43% success rate  nothing parked     4 human · 0 error    avg $0.62 / run

    Runs  7/7                    Agent floor   ● Success   live                 Controls
    ▌  ●  GAN-41  SUCCESS  3m    GAN-41  [RBAC] Re-enable permission guards…     processes
                                 ganjardbc/umkm-pos · ai-agent/GAN-41  ◴ 3m      s   ▶  start server
       ●  GAN-55  NEEDS HUMAN    ✔ plan ─ ✔ impl ─ ✔ validate ─ ✔ review ─ ○ PR   w   ▶  start worker
                                 ━━━━━━━━━━━━━━━━━━━━  80%
                                  Planner      Frontend     Backend             tunnel
                                  ○ Idle       · Off duty   ○ Idle              https://local.example.com
                                  $0.12  47s   –            $0.25  1m 18s       → http://localhost:3030
    Logs  all  server  worker  tunnel  ≥info   ` to expand
```

- **Header** (two lines, spaced): brand, version, a heartbeat that scans while runs are active, and the clock; then one dot per process (SERVER, WORKER, TUNNEL: green running with uptime, yellow while changing state, red with the exit code when crashed, grey off) and the REDIS / DB / HTTP health dots, with the queue (waiting · active · delayed · failed), the trigger kill-switch, mode and port on the right. On a narrow terminal the right side drops the flags first, then the queue.
- **Summary cards**: Active, Completed (with success rate), Waiting on you, Needs attention, Spend (with a cost sparkline and the average). A card has a coloured hairline along its top and a coloured number only when it is non-zero. On a terminal shorter than 42 rows they become a one-line strip.
- **Runs** (left): every run, running ones pinned on top, a blank line between runs. The selected row has an accent bar and a raised background; each row is ticket, status, elapsed, cost, retries and the ticket title when there is room. Columns tighten on a narrow list.
- **Agent Floor** (right): a text twin of the Agent Floor view for the selected run. The ticket block (title, repo · branch, elapsed, cost), the step line (`plan ─ spec ─ impl ─ validate ─ review ─ PR`) with a thin progress bar and AC counts, then **one card per agent** (Planner, Frontend, Backend, Validator, Reviewer, plus the Manager): name, state (spinner while working, `↻` retry, `⊘` blocked, `✖` error, `★` done), cost and duration, check results. An agent with something going on (working, retrying, blocked, failed, done) gets a coloured hairline; idle and off-duty agents are dimmed. The Manager's sentence wraps over its card. Cards sit six in a row from 84 columns, two rows of three from 54 columns (if tall enough), and fall back to one text row per agent in a small panel. Below: the last handoff and the last three events (`+mm:ss`; the feed still scrolls). The floor follows the newest running run; moving the selection pins it to that run, `F` follows live again. Finished runs replay their final state.
- **Logs** (bottom drawer): six lines until expanded with `` ` ``, which gives it 45% of the height. Live server, worker and tunnel output; the `all` tab hides cloudflared's info-level chatter (connection registrations, curve preferences) and only shows its warnings and errors, the `tunnel` tab has the full stream.
- **Controls** (right sidebar): see below. It is dropped below 110 columns, and the log drawer below 24 content rows; every action stays on its key and in the palette.

## Controls and the command palette

The sidebar lists only what you act on, one clickable row each, with the key on the left: the three processes and `all`, `restart` / `kill` (with the process they act on; click the `acts on` row or press `Tab` to change it), `failed jobs` (with the count), `help`, and the tunnel route with its reachability. Rows are state-aware: `▶ start server` becomes `■ stop server`, then `» force server` if the stop hangs; likewise for the worker and the tunnel; `kill` is greyed out when its target isn't running. Hovering a row explains it in the footer.

- **Processes**: `server` / `worker` / `tunnel` / `all`. `all` starts server, worker **and the tunnel when `TUNNEL_URL` is set**, and stops whatever is running.
- **tunnel**: the public URL, the local origin it exposes and whether `<public url>/health` answers through it.

`ctrl+p` opens the **command palette**: every action above plus the rest, which is not in the sidebar: the run mode (`dev` | `dist`, also `m`), the restart/kill target, copying the Linear / GitHub / health webhook URL from `TUNNEL_URL` to the clipboard (pbcopy / clip / wl-copy / xclip / xsel), search, filters, follow, log controls, help and quit. Type to filter, `↑↓` to move, `Enter` to run, `Esc` to close. The mode is locked while the server or worker runs. Process changes pop a toast bottom-right (`Esc` dismisses it), and every confirmation has `y` / `n` (or click yes / cancel).

The footer shows the key reference, cut to the terminal width with the most useful keys first.

## Cloudflare tunnel

`n` (or the tunnel row in the sidebar) runs `cloudflared tunnel run --url <target> <name>` as a third managed process, so webhooks from Linear/GitHub reach this machine. The sidebar shows its state, the public URL → local origin, and, once running, whether `<public url>/health` answers through the tunnel (checked every 10 s); the header carries its dot. Its output appears in the logs with the `tnl` tag (shown on the `tunnel` log tab; `l` cycles to it); cloudflared's own `INF`/`WRN`/`ERR` levels are honoured.

Settings come from `.env` (see `.env.example`), none of them secrets:

| Variable | Default | Meaning |
|---|---|---|
| `TUNNEL_NAME` | `ai-code-review` | tunnel to run |
| `TUNNEL_URL` | unset | public `https://` hostname routed to the tunnel; used only to print/probe webhook URLs |
| `TUNNEL_TARGET_URL` | `http://localhost:<server.port>` | local origin to expose |
| `CLOUDFLARED_BIN` | `cloudflared` | binary path |

The same tunnel runs without the TUI: `pnpm tunnel` (alias `pnpm tunnle`; `pnpm start:tunnel` after a build). It prints the Linear and GitHub webhook URLs derived from `TUNNEL_URL`, then runs in the foreground and forwards Ctrl-C. Flags override the env: `pnpm tunnel --name other-tunnel --url https://other.example.com --target http://localhost:4000`. Invalid values (non-https public URL, a name with odd characters) are rejected before anything runs; a missing `cloudflared` gets an install hint. The command is spawned with an argv array, never through a shell.

## Keys

| Key | Action |
|---|---|
| `ctrl+p` | command palette (every action, type to filter) |
| `s` / `w` / `n` / `a` | start/stop server / worker / tunnel / all (tunnel included when `TUNNEL_URL` is set); the sidebar rows are clickable too |
| `Tab` | choose the restart / kill target |
| `r` | restart the last-used process |
| `x` | force kill (SIGKILL) after confirmation |
| `m` | switch `dev` (tsx) / `dist` (node dist/) — only while both are stopped |
| `↑↓` `Enter` | select a run / open the inspector |
| `o` | open the selected run's PR in the browser |
| `F` | follow the newest running run on the Agent Floor |
| `/` `t` `f` `p` `c` | search, cycle type / status / repo filter, clear filters |
| `` ` `` | expand/collapse the log drawer (six lines when collapsed) |
| `l` `L` `space` `PgUp/PgDn` | log tab (all/server/worker/tunnel), min level, pause, scroll |
| `u` | failed jobs; `1-9` retries one (asks first) |
| `?` `q` | help, quit (stops both processes first) |

## Code layout

`src/tui/` follows the same layering as the rest of the app. Imports only point inward, and `tests/unit/tui-architecture.test.ts` fails the build if they don't.

```
src/tui/
  index.ts                  composition root: the only place that wires concrete infrastructure to the UI
  domain/                   no dependencies on other layers
    models/                 process (names, states, status), log-line, settings, toast
    interfaces/             ITuiDataSource (+ DTOs), IProcessController
  application/              pure logic, no I/O and no blessed
    view-models/            run-list (filters, status buckets, stats), stat-tiles, floor (events -> desks/steps/feed),
                            actions (action states), inspector
    process-plans.ts        what an action/key does and whether to ask first (toggle, all, restart, kill, quit)
    process-toasts.ts       which status changes deserve a toast
    services/tunnel-monitor.ts   throttled reachability check of the public URL
  infrastructure/           adapters; implements the domain interfaces
    process/                ProcessManager (spawns server/worker/cloudflared), log-parser (pino + cloudflared lines)
    data/                   TuiDataSource (read-only SQLite, BullMQ queue, Redis pub/sub, health probes)
    config/                 tui-config (env + YAML merge that returns errors instead of throwing)
    system/                 clipboard, open-url
  presentation/             blessed UI; depends on application + domain, never on infrastructure
    app.ts                  controller: state, key bindings, refresh loop, quit
    theme.ts                palette (greys, accent, status colours) and tag helpers
    layout.ts               integer grid helpers
    formatters/             pure markup builders (header, stat-strip/stat cards, run-row, floor desk cards/rows/steps, log line, footer hints, inspector, toast, escapeTags)
    widgets/                panel (borderless surface + title), card (borderless tile with a coloured top hairline), header-bar, stat-tiles, runs-list, floor-widget, sidebar, log-pane, footer, dialogs (overlay, confirm, prompt, palette, toast)
    types/neo-blessed.d.ts
  shared/format.ts          pure value formatters (elapsed, cost, duration, truncate, pad)
```

`presentation/app.ts` receives everything concrete through `AppDeps` (`processes`, `data`, `copyToClipboard`, `openUrl`), which is also what makes it possible to drive the UI with fakes.

## How it works

- **Processes**: `infrastructure/process/process-manager.ts` spawns `tsx src/...` (or `node dist/...`) directly, not through pnpm, so SIGTERM reaches the real process. `NODE_ENV=production` makes pino emit JSON, which the log pane parses. Stop = SIGTERM, then SIGKILL after a grace period (server 15s; worker `claude.agentTimeoutMs` + 60s, because the worker waits for its running job; tunnel 10s). The TUI kills its children on exit.
- **Data**: `infrastructure/data/tui-data-source.ts` opens the SQLite run history **read-only** (WAL allows concurrent readers), subscribes to the Redis channel `caf:dashboard:events` for refresh nudges (plus a 2s poll), and reads BullMQ counts/failed jobs through its own `Queue` handle. Run summaries use `infrastructure/db/pipeline-run-shape.ts`, shared with `routes/pipelines.ts`.
- **Config**: `infrastructure/config/tui-config.ts` does the same env + YAML merge as `config/index.ts` but returns errors instead of throwing. Nothing under `src/tui/` may import `config/index.ts`.
- The TUI's own `GET /health` polls are filtered out of the server log pane.

## Limits

- Retrying a failed job re-runs the whole pipeline from the planner (BullMQ semantics), hence the confirmation.
- Stopping the worker mid-job waits for the job; `x` (or pressing the key again while stopping) kills it and BullMQ retries it.
- The `dist` mode requires `pnpm build` first.
