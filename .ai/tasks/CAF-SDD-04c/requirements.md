# CAF-SDD-04c — Orchestrator: Clarify via ticket, gerbang approval spec berlabel, `/caf-approve-spec`
Status: APPROVED (keputusan desain dari jawaban Ganjar atas pertanyaan 04b nomor 2 sampai 5, 14 Okt 2026; Q-1 dan Q-2 diputuskan konsultan, Ganjar boleh membatalkan)
Source: chat (daftar masukan SDD-04 di CAF-SDD-PROGRESS.md; jawaban Ganjar 14 Okt 2026)
Repo target: `caf-orchestrator`
Bergantung pada: 04a dan 04b ter-merge.

## 1. Outcome
Pipeline berhenti dan bertanya di ticket ketika planner menandai spec `NEEDS_CLARIFICATION`, dan menunggu persetujuan manusia atas spec bila ticket berlabel gerbang spec. Manusia menjawab di ticket lalu memicu ulang, atau menyetujui spec dengan komentar `/caf-approve-spec` di Draft PR berisi spec saja. Agent implementasi tidak pernah berjalan di atas spec yang belum jelas atau, untuk ticket berlabel, belum disetujui. Ticket tanpa label dan repo tanpa spec berperilaku seperti sebelum tiket.

## 2. Scope
In:
- Deteksi hasil planner dari baris `Status:` dan pertanyaan BLOCKING di `requirements.md` workspace.
- Clarify: komentar pertanyaan di ticket (Linear dan GitHub Issues), commit dan push draf spec ke branch ticket, berhenti; pemicu ulang memakai pemicu yang sudah ada, planner dijalankan ulang di branch itu dengan jawaban dari komentar ticket.
- Gerbang spec: label gerbang yang bisa dikonfigurasi; Draft PR berisi folder spec saja; komentar ticket; berhenti.
- `/caf-approve-spec`: komentar PR baru (webhook GitHub), memeriksa permission, mengubah hanya baris `Status:` menjadi `APPROVED`, lalu resume dari implementasi.
- Konfigurasi, test unit, README/CLAUDE.md orchestrator.

Out:
- Perubahan di `caf-initiator`, planner, agent lain, nama command webhook yang sudah ada.
- Jira, ticket tanpa tracker.
- Pembatasan siapa yang boleh menjawab Clarify di ticket (mengikuti hak akses tracker).
- Mengubah jatah retry, kunci config `agents.*`, atau gate validasi dan reviewer.

## 3. Constraints and Assumptions
- Finding (ringkasan orchestrator): pipeline normal membuat workspace, clone, branch `ai-agent/<KEY>`, menjalankan planner yang wajib menghasilkan `tasks.md`, lalu agent implementasi; resume (`/caf-retry-pipeline` atau Linear kembali "Ready for AI") mensyaratkan branch masih ada di remote, melewati planner, dan memanggil `checkAndConsumeRetryBudget()`.
- Finding (ringkasan orchestrator): semua trigger GitHub memeriksa permission pelaku (`write`, `maintain`, `admin`, fail-closed), mengabaikan komentar akun `Bot`, dan membalas 200 `ignored` untuk penolakan; kill switch `ENABLE_PIPELINE_TRIGGER` dicek setelah validasi; webhook di-dedupe lewat header delivery.
- Finding (planner, 02d): status akhir planner `DRAFT | NEEDS_CLARIFICATION | APPROVED | NEEDS_HUMAN`; planner tidak pernah mengedit spec berstatus `APPROVED`; pertanyaan terbuka ditulis `- Q-n [BLOCKING] ... — Answer:` dan jawaban ditambahkan setelah `— Answer:`.
- Finding (03d): agent implementasi sendiri berhenti `NEEDS_HUMAN` pada `NEEDS_CLARIFICATION` atau pertanyaan BLOCKING tanpa `Answer:`; `DRAFT` dan `APPROVED` berjalan terus.
- Constraint: repo target tanpa `requirements.md` atau tanpa baris `Status:` ter-anchor di dalamnya berperilaku persis seperti sebelum tiket (tidak ada Clarify, tidak ada gerbang).
- Constraint: use case hanya bergantung pada port; tidak ada auto-merge; orchestrator tidak mengubah isi spec selain satu baris `Status:` pada `/caf-approve-spec`.
- Constraint: jawaban Clarify dan persetujuan spec tidak memakai `checkAndConsumeRetryBudget()` (bukan kegagalan).
- Constraint: perilaku `/caf-retry-pipeline`, `/caf-review`, `/caf-fix-review`, dan reply inline tidak berubah.
- Assumption A1 (T1): payload `issues labeled` GitHub memuat label issue, dan payload Linear `Issue update` memuat label atau label bisa diambil lewat port Linear; dasar: gerbang label adalah fitur payload yang sudah dipakai untuk `readyLabel`. Bila tidak, T1 mencatat port yang perlu diperluas.
- Assumption A2 (T1): port tracker dan VCS yang ada bisa membaca komentar sebuah ticket; bila tidak, T1 mencatat metode port baru yang minimal.
- Assumption A3 (T1): pipeline normal pada branch `ai-agent/<KEY>` yang sudah ada di remote bisa melanjutkan (checkout, bukan buat ulang); bila hari ini gagal atau menimpa, T1 mencatat bentuk perubahan yang perlu.
- Assumption A4 (T1): `orchestration-state.json` bisa diperluas dengan penanda keadaan menunggu (`clarify` atau `spec-approval`) tanpa merusak pembacaan state lama.

## 4. Decisions Already Made
- Gerbang approval spec hanya untuk ticket berlabel; MR tetap selalu direview manusia; tidak ada auto-merge (SDD-summary, 12 Okt).
- Agent tidak pernah mengedit spec `APPROVED`; hanya manusia atau `/caf-approve-spec` yang membuatnya `APPROVED` (SDD-summary).
- Clarify via ticket: pipeline berhenti dan bertanya di komentar ticket, tanpa memotong jatah retry (SDD-summary; Ganjar 14 Okt 2026).
- Label gerbang: satu label yang bisa dikonfigurasi per project, `github.specGateLabel` dan `linear.specGateLabel`, default `spec-approval`.
- Spec direview di Draft PR berisi folder spec saja; persetujuan lewat komentar `/caf-approve-spec`; orchestrator memeriksa permission pengomentar seperti trigger lain, lalu melakukan satu commit yang hanya mengubah baris `Status:` menjadi `APPROVED`, dan resume dari implementasi. Manusia juga boleh mengedit baris itu sendiri lalu berkomentar.
- Clarify dilanjutkan dengan pemicu yang sudah ada (Linear kembali ke "Ready for AI", label GitHub dipasang ulang); planner dijalankan ulang dengan jawaban dari komentar ticket disuntik sebagai konteks.
- `NEEDS_CLARIFICATION` selalu menghentikan pipeline dan bertanya, apa pun labelnya; gerbang label hanya mengatur persetujuan spec.
- Q-1 (keputusan konsultan): saat Clarify berhenti, draf spec di-commit dan di-push ke branch `ai-agent/<KEY>` (tanpa PR), supaya planner melanjutkan draf itu dan mengisi `— Answer:` alih-alih mengulang dari nol (workspace ephemeral dihapus setelah job).
- Q-2 (keputusan konsultan): persetujuan spec tidak memakai jatah retry, sejalan dengan Clarify.

## 5. Open Questions
- Q-1 [NON-BLOCKING] Draf spec saat Clarify berhenti: (a) di-push ke branch ticket supaya planner melanjutkan draf (rekomendasi), atau (b) dibuang dan planner mengulang dari nol? — Answer: (a) (keputusan konsultan; Ganjar boleh membatalkan).
- Q-2 [NON-BLOCKING] Persetujuan spec dan jawaban Clarify memakai jatah `maxOrchestrationRetries`: (a) tidak (rekomendasi, bukan kegagalan), atau (b) ya? — Answer: (a) (keputusan konsultan; Ganjar boleh membatalkan).

## 6. Acceptance Criteria
- AC-1: When konfigurasi project tidak menyebut label gerbang, then label gerbang spec bernilai `spec-approval` untuk GitHub dan Linear; when disebut, then nilai itu dipakai. Verify: automated test (schema config).
- AC-2: When planner selesai dan `requirements.md` berstatus `NEEDS_CLARIFICATION`, then pipeline tidak menjalankan agent implementasi, tidak membuka Draft PR, dan berhenti dengan run tercatat `NEEDS_HUMAN`. Verify: automated test (use case dengan port palsu).
- AC-3: When pipeline berhenti karena `NEEDS_CLARIFICATION`, then draf spec di-commit dan di-push ke branch ticket tanpa membuka PR (Q-1). Verify: automated test.
- AC-4: When pipeline berhenti karena `NEEDS_CLARIFICATION`, then komentar di ticket memuat setiap pertanyaan BLOCKING yang belum punya `— Answer:` dan cara memicu ulang, dan tidak memuat pertanyaan yang sudah berjawab. Verify: automated test.
- AC-5: When pipeline berhenti karena `NEEDS_CLARIFICATION`, then jatah retry orkestrasi tidak berkurang. Verify: automated test.
- AC-6: When pemicu normal datang untuk ticket yang branch-nya sudah ada di remote dengan `requirements.md` berstatus `NEEDS_CLARIFICATION`, then pipeline melanjutkan di branch itu (bukan membuat ulang) dan menjalankan planner dengan komentar ticket setelah komentar Clarify terakhir orchestrator disuntik sebagai konteks. Verify: automated test.
- AC-7: When konteks jawaban dikumpulkan, then komentar dari akun bot tidak ikut dan hanya komentar setelah komentar Clarify terakhir yang ikut. Verify: automated test.
- AC-8: When planner selesai dengan status `DRAFT` dan ticket tidak berlabel gerbang, then pipeline berlanjut ke agent implementasi seperti sebelum tiket. Verify: automated test.
- AC-9: When planner selesai dengan status `DRAFT` dan ticket berlabel gerbang, then folder spec di-commit dan di-push, Draft PR berisi folder spec saja dibuka, komentar ticket memuat tautan PR, pipeline berhenti dengan run `NEEDS_HUMAN`, dan agent implementasi tidak berjalan. Verify: automated test.
- AC-10: When pipeline berhenti di gerbang spec, then jatah retry orkestrasi tidak berkurang (Q-2). Verify: automated test.
- AC-11: When komentar `/caf-approve-spec` datang di PR spec yang menunggu persetujuan dari pengguna ber-permission `write`, `maintain`, atau `admin`, then orchestrator mengubah hanya baris `Status:` di `requirements.md` menjadi `APPROVED`, commit, push, dan resume dari implementasi dengan planner dilewati dan `tasks.md` dibaca dari branch. Verify: automated test.
- AC-12: When `/caf-approve-spec` datang dari pengguna tanpa permission cukup atau dari akun bot, then diabaikan dengan respons 200 `ignored` dan tidak ada perubahan. Verify: automated test (route dan use case).
- AC-13: When `/caf-approve-spec` datang di PR atau branch yang tidak menunggu persetujuan spec, then orchestrator membalas dengan komentar penjelasan dan tidak menjalankan apa pun. Verify: automated test.
- AC-14: When `/caf-approve-spec` datang sementara `requirements.md` berstatus `NEEDS_CLARIFICATION` atau punya pertanyaan BLOCKING tanpa `— Answer:`, then ditolak dengan komentar dan tidak ada commit. Verify: automated test.
- AC-15: When `/caf-approve-spec` datang sementara baris `Status:` sudah `APPROVED` (diedit manusia), then tidak ada commit tambahan dan pipeline tetap resume dari implementasi. Verify: automated test.
- AC-16: When pipeline lanjut dari persetujuan sampai selesai atau gate habis, then PR yang sudah terbuka di branch itu dipakai ulang atau diperbarui dan tidak ada PR kedua untuk branch yang sama. Verify: automated test.
- AC-17: When `/caf-approve-spec` diterima webhook, then lewat dedupe delivery, pemeriksaan permission, dan kill switch yang sama dengan command komentar PR lain. Verify: automated test (route).
- AC-18: When repo target tidak punya `requirements.md` atau tidak punya baris `Status:` ter-anchor, then tidak ada Clarify dan tidak ada gerbang (perilaku sebelum tiket). Verify: automated test.
- AC-19: When README dan CLAUDE.md orchestrator dibaca, then tertulis Clarify via ticket, label gerbang dan konfigurasinya, `/caf-approve-spec`, bahwa keduanya tidak memakai jatah retry, dan perilaku untuk repo tanpa spec. Verify: manual: baca bagian terkait.
- AC-20: When `pnpm typecheck && pnpm lint && pnpm test` dijalankan, then semua lulus dan test existing tidak berubah selain yang dicatat di verify-report. Verify: command: `pnpm typecheck && pnpm lint && pnpm test` | expect: exit 0.
