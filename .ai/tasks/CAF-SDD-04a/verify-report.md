# Verify Report

Status: NEEDS_HUMAN

(Draft setelah T1. Diperbarui di T7.)

## T1 — Audit baca-saja

### Pembacaan laporan di `src/infrastructure/reports/report-reader.ts`
- `verify-report.md`: `readVerifyReport()` (baris 31-37), `/\bSUCCESS\b/` di seluruh isi berkas.
- `qa-report.md`: `readQaReport()` (baris 54-64), regex `QA_STATUS_LINE = /^.*Status:\s*(.+)$/m` (baris `Status:` pertama), nilai di-trim harus tepat `PASS`.
- `review-notes.md`: `readReviewerReport()` / `readInitialReviewReport()`, regex `VERDICT_LINE`.
- `fix-review-log.md`: `readFixReviewLog()`; `NOTE_LINE = /^Catatan:\s*(.*)$/i` (baris 181) — satu-satunya parser `Catatan:`. Template baru caf-initiator (`fix-review-command.js:204`) menulis `Notes:`, jadi catatan dari repo baru saat ini terbuang (string kosong).
- Pembaca tampilan saja: `verify-report-details.ts` (`readVerifyDetails`, bukan gerbang).

### Pemakaian nama `caf-qa`, `qa-report.md`, `caf-documentation`
- Use case `run-agent-pipeline.use-case.ts`: `buildPrBody` (baris 79, `- QA: …/qa-report.md`), `GATE_ARTIFACT_FILE.qa` (94, dipakai body Draft PR gate habis dan konteks resume), `buildQualityGateWarning` (131, label `caf-QA Agent`), lewati QA (599-605), retry QA (`recordAgentEvent … 'caf-qa' … 'retry'`, 619), `recordGateExhaustion` (`gateAgent.qa = 'caf-qa'`, `artifactLink` dari `GATE_ARTIFACT_FILE`, 829-841), `readGateArtifactRaw` (932-933, resume), `runQaGate` (1128-1177: notifikasi, `recordAgentEvent/End`, prompt, `agentRunner.run('caf-qa')`, `modelOverrides['caf-qa']`, `readQaReport`, `throw 'No qa-report.md produced'`), langkah dokumentasi (700-762, `agentRunner.run('caf-documentation')`, dibungkus try/catch, gagal hanya catatan).
- Komentar ticket: prefix `Agent pipeline needs human review (QA failed after retry):` + `qaReport.raw`; komentar sukses berisi `docsNote` + `qaReport.raw` + `reviewerReport.raw`. Tidak ada nama agent/berkas eksplisit di komentar; nama berkas muncul di body PR.
- task-router: `SkippableAgent` memakai `qa`/`documentation` (bukan nama agent), `SKIP_LINE` mengenal `QA`/`Documentation`.
- Config: `KNOWN_AGENT_NAMES` (`config/schema.ts:24`) — daftar agent yang boleh punya `agents.modelOverrides`; `caf-validator` belum ada.
- Instrumentation: `pipeline-instrumentation.ts:39-45` `AGENT_PIV_PHASE` (`caf-qa → verify`; `caf-documentation` sengaja tidak di-instrument).
- Dashboard / Agent Floor: `event-normalizer.ts` `AGENT_BY_NAME` (137), `GATE_BY_AGENT_NAME` (159), `OUTPUT_FILE.qa` / `GATE_ARTIFACT.qa` (`qa-report.md`, 168/175) dan literal `qa-report.md` di handoff (480-481). Event `gate_exhausted` memakai `row.artifactLink` bila ada. UI statis `ui/agent-floor/render.js` (`file:'caf-qa'`, `out:'qa-report.md'`) dan `demo.js` hanya tampilan/demo.
- Watcher (`watch/`): hanya mengawasi `orchestration-state.json`, tidak menyebut nama agent. Notifikasi Telegram: menerima `agentName` dari use case, tidak punya literal sendiri.

### Cara use case mengecek isi workspace saat ini
- `existsSync(\`${repoPath}/.git\`)` langsung dari `node:fs` (baris 292, 393) untuk mode persistent.
- Semua laporan dibaca lewat fungsi modul `report-reader.ts` / `orchestration-state.ts` (bukan port). Tidak ada port untuk "apakah berkas agent ada". Sesuai constraint, pengecekan agent akan lewat port kecil baru.

### Test yang mengunci hal di atas
- `tests/unit/run-agent-pipeline.use-case.test.ts`: me-mock modul `report-reader.js` (hanya `readTasks/readVerifyReport/readQaReport/readReviewerReport/appendSkipNote/taskDir`) dan `task-router.js`; banyak assertion `agentRunner.run('caf-qa' …)`, `'caf-documentation'`; baris 691 `throws when qa-report.md is not produced` (`rejects.toThrow(/No qa-report.md produced/)`).
- `tests/unit/report-reader.test.ts`: `readQaReport` (7 kasus), `readFixReviewLog` dengan `Catatan:`. Tidak ada test untuk `readVerifyReport`.
- `agent-floor-event-normalizer.test.ts`, `agent-floor-translate.test.ts`, `pipelines-route.test.ts`, `pipeline-instrumentation-integration.test.ts`, `pipeline-run.repository.test.ts`, `schema.test.ts`: memakai literal `caf-qa`/`qa-report.md` sebagai data fixture.

### Bentuk resume `lastFailedGate`
- `orchestration-state.ts`: `OrchestrationGate = 'implementation' | 'qa' | 'reviewer'`. Resume (`execute`, baris 362-368) memanggil `readGateArtifactRaw(gate)` → untuk `qa` selalu `readQaReport` (`qa-report.md`) dan label konteks `Previous ${GATE_ARTIFACT_FILE[gate]}`.

### `## Coverage` di task-router
- Semua regex header (`Frontend Tasks`, `Backend Tasks`, `Docs Tasks`, `Skip Agents`) ter-anchor `^#{1,6}\s*<nama>\s*$`, dan `sectionBody()` berhenti di heading berikutnya. Jadi `## Coverage` di akhir tidak ikut menjadi isi bagian mana pun dan isinya (`- AC-1 → T2`) tidak cocok dengan header mana pun. Dugaan: AC-9 sudah terpenuhi oleh kode sekarang; T4b cukup mengunci dengan test (tanpa perubahan `src/` bila test langsung hijau).

### A2 (bentuk `validate-report.md`)
- Tidak ada contoh di folder tugas. Dicek dari sumber caf-initiator (`src/templates/agent-md.js`, `buildValidateReportFormat`, CAF-SDD-03b1): skeleton memakai baris polos `Status: PASS | FAIL | NEEDS_HUMAN` di atas tabel, sengaja berbentuk sama dengan `qa-report.md` agar `readQaReport()` bisa dipakai. A2 terkonfirmasi.

### Bentuk `Status:` di `verify-report.md`
- Template baru (`agent-handoff-md.js`): baris polos `Status: SUCCESS | NEEDS_HUMAN`.
- Template lama (`caf-initiator/CAF.md` Layer 3): heading `## Status: SUCCESS / NEEDS_HUMAN`.
- Keputusan pembacaan "baris `Status:` ter-anchor" untuk verify-report: baris yang diawali `Status:` dengan prefiks markdown opsional (`#`, `>`, `-`, `*`, `_`, spasi), nilai dibersihkan dari emphasis lalu dibandingkan tepat `SUCCESS`. Laporan lama berbentuk `## Status: SUCCESS` tetap lulus. Laporan lama `## Status: NEEDS_HUMAN` yang kebetulan memuat kata `SUCCESS` di tempat lain kini tidak lulus — itu persis yang diminta AC-3.

### Hal yang perlu dicatat (bukan konflik dengan AC)
- Keputusan Q-3 (laporan gate tidak ada sama sekali = gagal gate biasa) mengubah perilaku sekarang (`throw 'No qa-report.md produced'` → retry BullMQ), juga untuk repo lama, dan bertentangan dengan test lama baris 691. Ini bertentangan dengan constraint "perilaku repo lama tidak berubah satu pun", bukan dengan AC mana pun; AC-8 membolehkan test lama berubah asal dicatat. Diikuti keputusan Q-3 (lebih spesifik dan eksplisit disetujui); test 691 diperbarui dan dicatat.
- Kesimpulan T1: tidak ada temuan yang bertentangan dengan AC. Lanjut ke T2.
