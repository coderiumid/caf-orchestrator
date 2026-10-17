Status: SUCCESS

# CAF-SDD-04f — Verify report

| id | status | metode | bukti |
|---|---|---|---|
| AC-1 | PASS | automated test | `tests/unit/spawn-agent.validator.test.ts` "AC-1 arguments": argumen persis `--agent caf-validator --print --output-format json --permission-mode dontAsk --setting-sources project --allowedTools Bash(…)×9 Edit(.caf/tasks/**)` (daftar default), daftar kustom, daftar kosong; tanpa `bypassPermissions`/`--dangerously-skip-permissions` |
| AC-2 | PASS | automated test | `spawn-agent.validator.test.ts` "AC-2": 6 agent lain → argumen `bypassPermissions` dan env `toEqual({...process.env, CAF_HEADLESS:'1'})`, semua secret ada; `config.agents.validator` tidak dibaca; `spawn-agent.service.test.ts` lulus tanpa diubah |
| AC-3 | PASS | automated test | `spawn-agent.validator.test.ts` "AC-3": `restrictBash:false` → argumen bypass dan env penuh (termasuk `GITHUB_TOKEN`) |
| AC-4 | PASS | automated test | `spawn-agent.validator.test.ts` "AC-4": 8 kunci D-7 tidak ada; `PATH`, `CAF_HEADLESS=1`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` (useOpenai) dan override model ada; `process.env` utuh sesudahnya |
| AC-5 | PASS | automated test | `tests/unit/spawn-agent.env-classification.test.ts`: tiap kunci `envSchema` (14) tepat satu kelas; kunci di luar `envSchema` ditolak |
| AC-6 | PASS | automated test | `tests/unit/config-agents-validator.test.ts`: default (`restrictBash` true + daftar D-4), daftar kosong diterima, entri kosong / spasi / `*` / `Bash(...)` / `Bash` / bukan list / elemen bukan string ditolak dengan pesan berisi `agents.validator.allowedCommands` |
| AC-7 | PASS | command: `pnpm typecheck && pnpm lint && pnpm test` | exit 0; 63 file, 761 test lulus; `git diff 4d88185 -- tests` hanya menambah 3 berkas baru, tidak ada test lama diubah |
| AC-8 | PASS | manual | `caf.config.example.yaml` (blok `agents.validator`), `CLAUDE.md` (bagian "Restricted validator", baris "Neither is configurable", kalimat env anak) dan `README.md` memuat: kunci + daftar default + alasan tanpa `npx`/`pnpm dlx`/`pnpm exec`; `dontAsk` + `--setting-sources project` + alasan; tulis hanya `.caf/tasks/` lewat `Edit(...)`; kunci env yang dihapus; hanya `caf-validator`; rollback `restrictBash:false`; risiko sisa token di `.git/config` |
| AC-9 | PASS | manual (spike nyata) | lihat Notes |

### Notes

**Spike T1 (revisi 2)** — Claude Code 2.1.302, direktori sementara dengan `.caf/tasks/TEST/` dan agent `caf-validator` (`tools: Read, Write, Bash`). Flag persis AC-1: `--agent caf-validator --print --output-format json --permission-mode dontAsk --setting-sources project --allowedTools "Bash(pnpm run *)" "Edit(<path>)"`. Bentuk `Edit(...)` yang dipilih: **`Edit(.caf/tasks/**)`** (kandidat pertama lolos; `Edit(**/.caf/tasks/**)` memberi hasil sama; kandidat absolut juga sama meski saya mengetik `//` + path absolut sehingga muncul `///`, tidak bermakna).
- (a) `pnpm run --version` berjalan, tanpa denial.
- (b) `curl --version` ditolak tanpa prompt (`permission_denials`: Bash `curl --version`).
- (c) tool Write ke `outside.txt` ditolak; tool Write ke `.caf/tasks/TEST/validate-report.md` berhasil (berkas ada); `pnpm run x > outside.txt` ditolak sebagai Bash; `outside.txt` tidak pernah terbentuk.
- Spike versi 1 (sebelum revisi): `Write(...)` dalam enam bentuk tidak pernah mengizinkan penulisan, dan settings pengguna (hook RTK menulis ulang perintah, aturan allow meloloskan `curl`) mengubah hasil tanpa `--setting-sources project`. Keduanya sudah tercermin di revisi 2.
- Perilaku A-2: pada penolakan model berhenti dan melaporkan "Denied", tanpa loop. Dicatat dari agent spike generik, bukan template validator asli; timeout 30 menit tetap batas.

**Deviasi / catatan**
- Verifikasi F-1..F-8, A-3: F-1/F-2/F-6 dibaca langsung di kode dan cocok. Pemakai env secret di jalur validator tidak diaudit dengan `grep` penuh atas template validator caf-initiator (tidak disentuh sesuai Out); orchestrator tetap yang push dan memanggil API, jadi A-3 tidak bertentangan dengan apa pun yang terlihat. Disarankan satu pengecekan manual template validator sebelum deploy.
- Urutan argumen: `--setting-sources project` sebelum `--allowedTools` karena `--allowedTools` variadik dan harus terakhir.
- Prosedur sebelum deploy: jalankan satu tiket pada repo yang punya `caf-validator.md` dan pastikan `validate-report.md` terbentuk serta `permission_denials` di output JSON hanya berisi perintah yang memang di luar daftar (repo yang memakai `npx`/`make` di `Verify: command:` akan menghasilkan AC `UNVERIFIED` sampai `allowedCommands` ditambah).
- Risiko sisa: token GitHub di `.git/config` (F-3); settings proyek repo target tetap dimuat (D-8).

Proposed Spec Changes: none
