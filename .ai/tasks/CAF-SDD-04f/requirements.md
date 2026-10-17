# CAF-SDD-04f — Validator berjalan dengan allowlist perintah dan env tanpa secret

Status: APPROVED
Repo: caf-orchestrator (main 8b2c892 atau lebih baru; tidak bersinggungan berkas dengan 04e)

## Outcomes
- Agent `caf-validator` yang dijalankan orchestrator hanya bisa menjalankan perintah Bash yang cocok dengan sebuah daftar izin yang ditentukan orchestrator; perintah lain ditolak otomatis tanpa prompt.
- Proses `claude` milik validator tidak mewarisi secret orchestrator yang tidak ia butuhkan (token GitHub dan Linear, secret webhook, Telegram, password dashboard, URL Redis).
- Agent lain (planner, frontend, backend, qa, reviewer, documentation) dan jalur review PR tidak berubah sama sekali.

## Scope
In:
- `SpawnAgentService.run` (`src/infrastructure/agent/spawn-agent.service.ts`): argumen CLI dan env, hanya bila `agentName === 'caf-validator'`.
- Kunci konfigurasi baru `agents.validator` di `caf.config.yaml` dan `schema.ts`; ekspor daftar kunci env yang diklasifikasi.
- Test baru, `caf.config.example.yaml`, `CLAUDE.md`, `README.md`.

Out:
- Teks agent validator dan aturan `Verify: command:` (caf-initiator, tidak berubah).
- Token GitHub yang tertanam di URL `origin` pada `.git/config` workspace (lihat F-3). Dikerjakan di tiket terpisah.
- Agent selain `caf-validator`, termasuk `caf-qa`. Job review PR.
- Override per project untuk allowlist (hanya global; ditambah bila dibutuhkan).
- Sandbox jaringan atau isolasi container.

## Findings (dari kode, main 8b2c892)
- F-1: Semua agent dijalankan lewat satu titik, `SpawnAgentService.run(agentName, cwd, prompt, modelOverride)`, dengan argumen tetap `--agent <nama> --print --output-format json --permission-mode bypassPermissions`. Nama agent tersedia di titik ini.
- F-2: Env proses anak dibangun di atas `process.env` (atau `openaiEnv`, yang juga di atas `process.env`) ditambah override model dan `CAF_HEADLESS=1`. `CLAUDE.md` melarang membangun env dari nol karena CLI butuh `PATH` dan variabel lain.
- F-3: `GitService.clone` memakai URL `https://x-access-token:<GITHUB_TOKEN>@github.com/...`, dan `push` memakai remote `origin` yang sama. Dengan perilaku `git clone`, URL itu tersimpan di `.git/config` workspace sehingga token terbaca oleh proses mana pun di workspace itu, terlepas dari env. Pembersihan env di tiket ini mengurangi permukaan, tidak menutupnya.
- F-4: `caf-validator` ada di `KNOWN_AGENT_NAMES` dan dipilih sebagai gate bila repo punya `.claude/agents/caf-validator.md`; repo tanpa berkas itu memakai `caf-qa`.
- F-5: Template agent validator di caf-initiator memberi `tools: Read, Write, Bash`. Validator menulis hanya `validate-report.md` di `.caf/tasks/<KEY>/` dan menjalankan perintah verifikasi (checklist dan `Verify: command:`).
- F-6: Kunci `agents` di `schema.ts` kini `qa.maxRetries`, `reviewer.maxRetries`, `modelOverrides`. `envSchema` adalah konstanta yang tidak diekspor. Kunci env: `REDIS_URL`, `LINEAR_WEBHOOK_SECRET`, `LINEAR_API_KEY`, `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `OPENAI_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `DASHBOARD_BASIC_AUTH_PASSWORD`, `ENABLE_PIPELINE_TRIGGER`, `AGENT_SKIP_ENABLED`, `NODE_ENV`, `LOG_LEVEL` (T1 membuat daftar pasti dari `schema.ts`).
- F-7: `tests/unit/spawn-agent.service.test.ts` memock `config` hanya dengan `claude`, `OPENAI_API_KEY`, `openai`, `agents.modelOverrides`. Kode baru tidak boleh membaca `config.agents.validator` untuk agent selain `caf-validator`, supaya test lama lulus tanpa diubah.
- F-8: Mode `dontAsk` pada Claude Code menolak otomatis setiap panggilan yang akan memicu prompt, kecuali yang diizinkan aturan allow atau read-only bawaan; urutan evaluasi aturan: deny, ask, allow. Aturan Bash mencocokkan tiap subperintah rantai `&&`, `||`, `;`, `|`. `npx`, `pnpm dlx`, `pnpm exec` dan runner serupa tidak dilucuti sebagai wrapper, jadi aturan seperti `Bash(pnpm *)` akan mengizinkan perintah bebas lewat mereka. Hook di frontmatter agent proyek dilewati pada sesi `-p` (dasar dokumentasi Claude Code; T1 memverifikasi lewat spike).

## Assumptions
- A-1: `--allowedTools` pada CLI memberi efek yang sama dengan aturan allow, dan `--permission-mode dontAsk` dapat dipakai bersama `--agent` dan `--print`. Dasar: dokumentasi Claude Code. T1 memverifikasi dengan spike nyata (satu panggilan kecil per kasus).
- A-2: Agent validator mematuhi penolakan tool: perintah yang ditolak berakhir sebagai AC `UNVERIFIED` sesuai aturan teks 03e, bukan loop tanpa akhir. Dasar: teks agent validator. T1 mencatat perilaku yang terlihat di spike; timeout 30 menit tetap berlaku sebagai batas.
- A-3: Tidak ada kode yang membaca env `GITHUB_TOKEN`, `LINEAR_*`, atau `TELEGRAM_*` dari proses anak validator. Dasar: validator hanya membaca dan menulis berkas serta menjalankan perintah verifikasi; orchestrator sendiri yang push dan memanggil API. T1 memeriksa dengan `grep` template validator di caf-initiator dan alur gate di use case.
- A-4: Aturan tulis `Write(.caf/tasks/**)` mengizinkan penulisan `.caf/tasks/<KEY>/validate-report.md` pada working directory workspace. Dasar: sintaks aturan path dokumentasi Claude Code. Bentuk persisnya ditetapkan di spike T1.

## Decisions already made
- D-1: Penegakan di runner dengan `dontAsk` plus `--allowedTools`, bukan hook di frontmatter agent (keputusan Ganjar, 17 Okt, mengikuti rekomendasi konsultan; hook proyek dilewati di `-p`).
- D-2: Hanya `caf-validator` yang berubah. `caf-qa` dan agent lain tetap `bypassPermissions` tanpa pembatasan (keputusan tiket ini; umkm-pos masih memakai gate `caf-qa`).
- D-3: `agents.validator.restrictBash` (default `true`); `false` mengembalikan argumen dan env validator persis seperti sebelum tiket ini (jalur mundur).
- D-4: `agents.validator.allowedCommands`: daftar pola Bash (tanpa pembungkus `Bash(...)`), global saja. Default sempit: `pnpm run *`, `pnpm test`, `pnpm test *`, `pnpm --filter * run *`, `pnpm --filter * test`, `pnpm --filter * test *`, `npm run *`, `npm test`, `npm test *`. Sengaja tanpa `npx`, `pnpm dlx`, `pnpm exec`, `yarn`, `bun`, `make`; ditambah lewat konfigurasi (keputusan konsultan; Ganjar boleh mengubah daftar default).
- D-5: Daftar kosong sah dan fail-closed: validator hanya bisa menjalankan perintah read-only bawaan dan tulis laporan.
- D-6: Tulis dibatasi ke `.caf/tasks/` di workspace (`Write(.caf/tasks/**)`); tidak ada `Edit`.
- D-7: Env validator dibersihkan dengan menghapus kunci bernama (bukan membangun dari nol, sesuai F-2): `REDIS_URL`, `LINEAR_WEBHOOK_SECRET`, `LINEAR_API_KEY`, `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `DASHBOARD_BASIC_AUTH_PASSWORD`. Dipertahankan: `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` (auth CLI), dan semua variabel lain (`PATH`, `HOME`, dst).

## Constraints
- Perubahan di `SpawnAgentService.run` hanya cabang `agentName === 'caf-validator' && config.agents.validator.restrictBash`. Untuk semua kasus lain argumen dan env byte-identik dengan sebelumnya.
- Argumen validator terbatas: `--permission-mode dontAsk`, dan `--allowedTools` berisi aturan `Bash(<pola>)` untuk tiap entri `allowedCommands` serta `Write(.caf/tasks/**)`. Tidak ada `--dangerously-skip-permissions` dan tidak ada `bypassPermissions` untuk validator.
- Pola dalam `allowedCommands` yang kosong, atau yang hanya `*`, atau yang berbentuk `Bash`/`Bash(...)` ditolak saat startup (fail-closed, seperti validasi konfigurasi lain).
- Kunci env yang dihapus berasal dari satu konstanta yang diekspor. Test memastikan setiap kunci di `envSchema` terklasifikasi (dihapus untuk validator atau dipertahankan secara eksplisit); kunci baru tanpa klasifikasi membuat test gagal.
- `config.agents.validator` hanya dibaca untuk `caf-validator`. Test lama tidak diubah.
- Tidak ada dependency baru, tidak ada panggilan model di test otomatis.
- Perubahan ini tidak menutup F-3; dokumentasi menyatakannya sebagai risiko sisa.

## Open questions
Tidak ada.

## Acceptance criteria
- AC-1: When `caf-validator` is spawned with `restrictBash` true, then the CLI arguments are `--agent caf-validator --print --output-format json --permission-mode dontAsk` followed by `--allowedTools` listing `Bash(<pattern>)` for each configured pattern and `Write(.caf/tasks/**)`, and `bypassPermissions` is absent.
  Verify: automated test — `tests/unit/spawn-agent.validator.test.ts` (mock `node:child_process`, periksa argumen persis untuk daftar default dan daftar kustom).
- AC-2: When any other agent (`caf-planner`, `caf-frontend`, `caf-backend`, `caf-qa`, `caf-reviewer`, `caf-documentation`) is spawned, then the arguments and the env are identical to before this ticket.
  Verify: automated test — `tests/unit/spawn-agent.validator.test.ts` (tiap agent; env tetap memuat semua kunci secret) dan `tests/unit/spawn-agent.service.test.ts` lulus tanpa perubahan.
- AC-3: When `restrictBash` is false, then the validator's arguments and env are identical to before this ticket.
  Verify: automated test — `tests/unit/spawn-agent.validator.test.ts`.
- AC-4: When `caf-validator` is spawned with `restrictBash` true, then its env has none of the keys of D-7, still has `PATH`, `CAF_HEADLESS=1`, the auth variable in use (`CLAUDE_CODE_OAUTH_TOKEN`, or `ANTHROPIC_API_KEY` with `openai.useOpenai`) and the model overrides, and `process.env` of the orchestrator itself is not modified.
  Verify: automated test — `tests/unit/spawn-agent.validator.test.ts` (isi `process.env` dengan nilai uji untuk semua kunci; asersi pada env yang diteruskan ke `spawn` dan pada `process.env` sesudahnya).
- AC-5: When a key is added to `envSchema`, then a test fails until the key is classified as stripped or kept.
  Verify: automated test — `tests/unit/spawn-agent.env-classification.test.ts` (iterasi kunci `envSchema` yang diekspor terhadap dua konstanta; tiap kunci tepat satu kelas).
- AC-6: When `caf.config.yaml` has no `agents.validator`, then `restrictBash` is true and `allowedCommands` is the default list of D-4; when it has an empty `allowedCommands` then startup accepts it; when an entry is empty, only `*`, or `Bash`/`Bash(...)`, or the value is not a list of strings, then startup fails with a message naming the key.
  Verify: automated test — `tests/unit/config-agents-validator.test.ts` (parse `configSchema`/`yamlSchema` untuk lima bentuk).
- AC-7: When the verification gate runs, then `pnpm typecheck && pnpm lint && pnpm test` passes and no existing test file was modified.
  Verify: command: `pnpm typecheck && pnpm lint && pnpm test` | expect: exit 0
- AC-8: When `caf.config.example.yaml`, `CLAUDE.md` and `README.md` are read, then they describe: `agents.validator.restrictBash` and `allowedCommands` with the default list and why `npx`, `pnpm dlx`, `pnpm exec` are not in it; that the validator runs under `dontAsk` and writes only under `.caf/tasks/`; the env keys removed for the validator; that only `caf-validator` is affected (`caf-qa` and others are not); the rollback (`restrictBash: false`); and the residual risk that the GitHub token stays in the workspace `.git/config` (F-3). The sentence in `CLAUDE.md` that the child env is built on `process.env` and "neither is configurable" is made consistent with the validator exception.
  Verify: manual — baca ketiga berkas; tiap butir ada.
- AC-9: When the spike of T1 is read in `verify-report.md`, then it records the Claude Code version and, for a small real run with the exact flags of AC-1, whether (a) an allowed command ran, (b) a command outside the list was denied without a prompt, and (c) a write outside `.caf/tasks/` was denied while `.caf/tasks/<KEY>/validate-report.md` could be written; or it states why the spike could not run and lists the manual procedure to run before deploy.
  Verify: manual — baca bagian spike di `verify-report.md`.