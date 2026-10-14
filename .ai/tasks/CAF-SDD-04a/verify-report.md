# Verify Report

Status: SUCCESS

Ticket: CAF-SDD-04a · Branch: `ai-agent/CAF-SDD-04a` (commit lokal saja, belum di-push) · 14 Okt 2026

Catatan penulisan: sesuai format Layer 3, kata lulus verify-report disebut "kata lulus" di bawah; ia hanya muncul lagi di nama test AC-3 yang dikutip apa adanya. Pembaca baru (AC-3) menilai berkas ini dari baris `Status:` di atas.

## Checklist
- [x] lint — `pnpm lint`: bersih
- [x] typecheck — `pnpm typecheck`: bersih
- [x] test — `pnpm test`: 560 lulus / 47 file (sebelum tiket: 506 / 42)
- [ ] build — tidak dijalankan (`pnpm build` bukan bagian AC-8; tidak ada aset non-TS baru, jadi `Dockerfile` tidak perlu `COPY` baru)

## Acceptance Criteria
- AC-1: automated-test — `tests/unit/run-agent-pipeline.validator-gate.test.ts`::"runs caf-validator and reads validate-report.md when caf-validator.md exists" dan ::"runs caf-qa and reads qa-report.md, as before, when caf-validator.md does not exist" (juga ::"falls back to qa-report.md when caf-validator wrote no validate-report.md", ::"uses a per-project model override for caf-validator"); adapter: `tests/unit/workspace-agent-catalog.test.ts`::"returns true when .claude/agents/<name>.md exists", ::"returns false when it does not"
- AC-2: automated-test — `tests/unit/report-reader.sdd04a.test.ts`, describe "AC-2: gate report Status line, for qa-report.md and validate-report.md" untuk kedua berkas::"anchored Status: PASS passes", ::"Status: FAIL fails", ::"Status: NEEDS_HUMAN fails", ::"no Status: line fails, even with PASS in the table"; aturan retry/Draft PR: `run-agent-pipeline.validator-gate.test.ts`::"retries implementation once on validate-report FAIL, then opens a Draft PR"
- AC-3: automated-test — `tests/unit/report-reader.sdd04a.test.ts`, describe "AC-3: verify-report.md Status line"::"Status: SUCCESS passes", ::"Status: NEEDS_HUMAN does not pass even when SUCCESS appears elsewhere in the file", ::"no Status: line falls back to the old rule — SUCCESS anywhere passes", ::"no Status: line and no SUCCESS word does not pass (old rule)" (plus heading lama, emphasis, placeholder, "Lint Status:")
- AC-4: automated-test — `tests/unit/report-reader.sdd04a.test.ts`::"parses Notes: exactly like Catatan:"
- AC-5: automated-test — `tests/unit/run-agent-pipeline.validator-gate.test.ts`::"skips the docs step without error or failure comment when caf-documentation.md does not exist" dan ::"runs caf-documentation as before when caf-documentation.md exists"
- AC-6: automated-test — `tests/unit/run-agent-pipeline.validator-gate.test.ts`::"validator gate exhausted: Draft PR body, ticket comment and gate_exhausted event name caf-validator / validate-report.md", ::"validator success: PR body and final comment name validate-report.md, never qa-report.md", ::"caf-qa gate exhausted: names stay caf-qa / qa-report.md", ::"validator skipped by Planner directive: warning and skip notification name the validator"; dashboard: `tests/unit/validator-dashboard.sdd04a.test.ts`::"is recorded in the verify PIV phase, like caf-qa", ::"Agent Floor shows caf-validator as the QA desk and hands off validate-report.md", ::"Agent Floor maps a caf-validator retry and gate_exhausted to the qa gate with validate-report.md", ::"is a known agent for agents.modelOverrides"
- AC-7: automated-test — `tests/unit/run-agent-pipeline.validator-gate.test.ts`::"re-reads validate-report.md when the repo uses caf-validator" dan ::"re-reads qa-report.md when the repo has no caf-validator"
- AC-9: automated-test — `tests/unit/task-router.sdd04a.test.ts`::"<kasus>: routing, docs and skip directives match the same tasks.md without Coverage" (6 kasus, `strictEmptyCheck` on dan off) dan ::"a Coverage section alone routes to nothing and has no docs tasks"
- AC-8: command — `pnpm typecheck && pnpm lint && pnpm test` | exit 0; vitest: "Test Files 47 passed (47)", "Tests 560 passed (560)". Test lama yang berubah: satu, lihat Notes.

## Proposed Spec Changes
- Constraint §3 "perilaku untuk repo target lama tidak berubah satu pun" bertentangan dengan keputusan Q-3 untuk repo lama: dulu `caf-qa` tanpa `qa-report.md` melempar error (retry BullMQ seluruh job), kini menjadi gagal gate biasa (retry implementasi lalu Draft PR). Usul: tulis eksplisit di §4 bahwa Q-3 berlaku untuk `caf-qa` juga dan merupakan pengecualian dari constraint itu. Implementasi mengikuti Q-3.
- AC-3 tidak menyebut bentuk heading lama `## Status: …` (template `CAF.md` Layer 3 lama). Usul: tambahkan bahwa baris `Status:` boleh diawali penanda markdown (`#`, `>`, `-`, emphasis) dan dinilai sama; itu yang diimplementasikan.

## Notes

### Ringkasan perubahan
- `report-reader.ts`: `readVerifyReport` membaca baris `Status:` ter-anchor (prefiks markdown opsional, emphasis dibuang, nilai harus tepat kata lulus); tanpa baris `Status:` → aturan lama. `readValidateReport` baru (aturan sama dengan `readQaReport`). `NOTE_LINE` menerima `Notes:` dan `Catatan:`.
- Port baru `IAgentCatalog` (`domain/interfaces/agent-catalog.interface.ts`) + adapter `WorkspaceAgentCatalog` (`stat` pada `.claude/agents/<name>.md`, nama agent divalidasi sehingga tidak bisa keluar dari folder itu), di-wire di `worker.ts`. Dependency opsional di use case: tanpa itu semua repo diperlakukan sebagai repo lama (caf-qa, dokumentasi ada) — test lama tetap berjalan tanpa diubah.
- `run-agent-pipeline.use-case.ts`: `ValidationGate` (`caf-qa`/`qa-report.md` vs `caf-validator`/`validate-report.md`) dipilih sekali per run dan diteruskan ke prompt, `agentRunner.run`, model override, notifikasi, `recordAgentEvent`/`End` (start, retry, gate_exhausted + `artifactLink`), komentar ticket, body PR, Draft PR gate habis, peringatan quality gate, dan resume (`readGateArtifact`). Jalur `caf-qa` mempertahankan teks lama byte demi byte. Laporan gate tidak ada sama sekali → FAIL biasa (Q-3). Langkah dokumentasi dilewati dengan catatan bila `caf-documentation.md` tidak ada.
- `schema.ts`: `caf-validator` masuk `KNOWN_AGENT_NAMES` (boleh punya `agents.modelOverrides`). `pipeline-instrumentation.ts`: `caf-validator → verify`. `event-normalizer.ts`: `caf-validator` dipetakan ke meja/gate `qa`, dan nama berkas QA per attempt menjadi `validate-report.md` begitu ada baris `caf-validator`.
- README dan CLAUDE.md diperbarui (bagian baru "Old and new target repos", kontrak laporan, langkah 5/6/8 pipeline).

### Hasil T1
Audit lengkap ada di riwayat commit `docs: record CAF-SDD-04a T1 audit findings`. Pokoknya:
- Pembacaan laporan: `readVerifyReport` (pola kata lulus di mana saja), `readQaReport` (`^.*Status:` baris pertama, tepat `PASS`), `readReviewerReport`/`readInitialReviewReport` (`Verdict:`), `readFixReviewLog` (`Catatan:` saja).
- Literal `caf-qa`/`qa-report.md`/`caf-documentation` ada di use case (body PR, `GATE_ARTIFACT_FILE`, peringatan skip, `recordGateExhaustion`, resume, `runQaGate`, langkah docs), `config/schema.ts` (`KNOWN_AGENT_NAMES`), `pipeline-instrumentation.ts` (`AGENT_PIV_PHASE`), `event-normalizer.ts` (peta agent/gate/berkas), UI statis Agent Floor (`render.js`, `demo.js` — hanya tampilan, tidak diubah). Watcher dan notifier Telegram tidak punya literal sendiri.
- Use case mengecek workspace dengan `existsSync` langsung (hanya untuk `.git`) dan membaca laporan lewat modul `report-reader`; belum ada port untuk keberadaan agent → port kecil baru.
- Resume: `lastFailedGate` ∈ `implementation|qa|reviewer`; untuk `qa` dulu selalu `qa-report.md`.
- `## Coverage`: header router ter-anchor `^#{1,6}\s*<nama>\s*$` dan `sectionBody` berhenti di heading berikutnya, jadi Coverage sudah diabaikan. T4b selesai dengan test saja, tanpa perubahan `src/` (test AC-9 langsung hijau di tahap merah T2).
- A2 terkonfirmasi dari sumber caf-initiator (`buildValidateReportFormat`, CAF-SDD-03b1): `validate-report.md` memakai baris polos `Status: PASS | FAIL | NEEDS_HUMAN`, bentuk sama dengan `qa-report.md`.
- Tidak ada temuan yang bertentangan dengan AC, jadi tidak STOP.

### Test lama yang diubah
- `tests/unit/run-agent-pipeline.use-case.test.ts`: "throws when qa-report.md is not produced" → "treats a missing qa-report.md as a failed QA gate, not a thrown error". Alasan: keputusan Q-3 mengubah perilakunya (gagal gate biasa, Draft PR + `notifyPipelineNeedsHuman`, tidak ada throw/`notifyPipelineFailed`). Ini satu-satunya test lama yang diubah; semua test lama lain lulus tanpa disentuh. Test baru ditaruh di file baru (`*.sdd04a.test.ts`, `run-agent-pipeline.validator-gate.test.ts`, `workspace-agent-catalog.test.ts`) agar file test lama tidak berubah.

### Hal tak terduga
- Template `verify-report.md` lama di caf-initiator (`CAF.md`) memakai heading `## Status: …`, bukan baris polos. Ditangani dengan prefiks markdown opsional (lihat Proposed Spec Changes). Akibatnya laporan lama berbentuk `## Status: NEEDS_HUMAN` yang kebetulan memuat kata lulus di bagian lain kini tidak lulus — persis yang diminta AC-3, tetapi berbeda dari perilaku sebelumnya untuk laporan lama seperti itu.
- `readQaReport` mengambil baris `Status:` pertama di mana pun posisinya dalam baris (`^.*Status:`); untuk verify-report dipakai anchor yang lebih ketat (hanya prefiks markdown) supaya baris seperti "Lint Status: FAIL" tidak dianggap status laporan. `readQaReport` sendiri tidak diubah (AC-2: aturan tetap).
- Bila validator tidak menulis `validate-report.md` tetapi ada `qa-report.md`, berkas itu dipakai dan namanya yang dilaporkan (sesuai scope "baca validate-report.md bila ada, selain itu qa-report.md").
- caf-initiator juga punya agent `caf-implementer` untuk repo tunggal yang "belum di-route oleh caf-orchestrator" (`src/index.js:77`). Di luar scope tiket ini; repo baru yang hanya punya `caf-implementer` masih akan gagal di task-router ("No Frontend Tasks or Backend Tasks section"). Perlu tiket sendiri sebelum rilis bila repo seperti itu dipakai lewat orchestrator.
- Tidak ada uji end-to-end nyata terhadap repo target (lama maupun baru); semua bukti adalah test unit dengan port palsu dan berkas sementara.
- `pnpm test` tidak menulis ke DB dashboard lokal (`git status` bersih setelah run); test use case baru me-mock `pipeline-instrumentation.js`.
