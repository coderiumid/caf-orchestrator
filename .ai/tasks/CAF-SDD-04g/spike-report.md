Status: D-1 WORKS (local HTTP sandbox); real GitHub NOT TESTED

# CAF-SDD-04g — Spike T1

## Setup
- `git --version`: `git version 2.54.0 (Apple Git-157)` (>= 2.31, `GIT_CONFIG_COUNT` supported).
- Sandbox: Python HTTP server wrapping `git http-backend` (serves a bare repo over real HTTP, logs the `Authorization`
  header of each request). A `file://` remote would not exercise HTTP headers, so this was used instead.
- Auth env (D-1) keyed to the sandbox host: `GIT_CONFIG_COUNT=1`,
  `GIT_CONFIG_KEY_0=http.http://127.0.0.1:8765/.extraheader`,
  `GIT_CONFIG_VALUE_0=AUTHORIZATION: basic <base64("x-access-token:SECRETTOK")>`. Passed only via env (no `-c`, no file).
- Clone used the plain URL `http://127.0.0.1:8765/r.git` (no userinfo).

## Results
| Claim | Result |
|---|---|
| (a) env read by `ls-remote` | OK, server saw `Authorization: <base64>` |
| (a) env read by `clone` | OK |
| (a) env read by `push` (`receive-pack`) | OK |
| (a) env read by `fetch` | OK |
| (b) `.git/config` after clone has no token / `x-access-token` / base64 | OK — `remote.origin.url` is the plain URL; grep for `SECRETTOK`, `x-access`, base64 prefixes: 0 hits |
| (b) no `http.*.extraheader` persisted after clone/push/fetch | OK — `git config --get-all` returns 0 entries |
| Server log | 4x `GET info/refs`, 1x `POST git-receive-pack`, 1x `POST git-upload-pack`, all with the expected header |

## Not tested
- (c) Real GitHub: **tidak teruji terhadap GitHub nyata.** No `GITHUB_TOKEN`/`GH_TOKEN` in the session env; the token in the
  repo `.env` was not read (access blocked by the permission check). The `http.https://github.com/.extraheader` key and
  `basic x-access-token:<token>` form are the documented GitHub HTTPS scheme but unverified here. Ganjar should run one
  `ls-remote` with the header against a private repo before deploying.
- Behavior on git < 2.31 (AC-7) is covered by a stubbed-version unit test in T6, not here.

## Decision
D-1 works. Proceeding to T2.
