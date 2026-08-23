# TASKS — CAF-PRREVIEW-01, Checkpoint B (caf-orchestrator)
(jalankan di caf-orchestrator; baca plan-checkpoint-b.md final sebagai sumber kebenaran)

Breakdown task dari plan-checkpoint-b.md, urutan WAJIB seperti di bawah — jangan diacak,
terutama Task A yang menjadi prasyarat keras sebelum job apapun bisa di-enqueue dengan aman.

## Task A — worker.ts branching by job.name (PALING AWAL, prasyarat keras)

Sesuai Ringkasan keputusan poin 6 plan-checkpoint-b.md. Tambah branching di worker.ts:
job.name === 'agent-pipeline' → RunAgentPipelineUseCase (existing, tidak berubah behaviornya)
job.name === 'pr-review' → RunPrReviewUseCase (BELUM ADA — Task D di bawah bikin use-case-nya,
  tapi branching-nya harus SUDAH ADA sebelum Task D selesai, boleh reference forward/stub dulu
  asal tidak crash kalau job pr-review kebetulan masuk sebelum use-case-nya lengkap — mis.
  throw error eksplisit "not implemented yet" alih-alih silently misrouting ke
  RunAgentPipelineUseCase).

STOP condition: task ini HARUS di-commit dan (kalau ada mekanisme deploy/restart worker di
dev environment) ter-deploy SEBELUM Task E (route handler) mulai bisa enqueue job pr-review
apapun, termasuk untuk testing lokal. Jangan lanjut ke Task E sebelum ini beres.

**Verify:** unit-level check (tidak ada test suite — verifikasi manual: baca kode, pastikan
job.name benar-benar di-switch, tidak ada default silent-fallthrough ke use-case yang salah).

## Task B — verifyGitHubSignature() di security.ts

Sesuai poin 1 plan-checkpoint-b.md — fungsi sibling verifyLinearSignature(), parsing prefix
sha256=, HMAC-SHA256 + timingSafeEqual identik pola existing.

**Verify:** test manual dengan payload dummy + secret dummy — hitung HMAC manual (mis. via
node -e atau openssl), bandingkan hasil signature match/mismatch terdeteksi benar.

## Task C — generalize claimDelivery()

Sesuai poin 2 plan-checkpoint-b.md, opsi (a) — ubah signature jadi
claimDelivery(source: 'linear' | 'github', deliveryId: string, ttlSeconds: number).
WAJIB update SEMUA caller existing (grep dulu semua pemanggil claimDelivery() di codebase,
termasuk di route /linear yang sudah ada — jangan cuma tambah parameter baru tanpa update
caller lama, itu akan break /linear yang sudah production).

**Verify:** grep ulang setelah perubahan, pastikan tidak ada caller yang masih pakai
signature lama (compile error kalau TypeScript strict, tapi tetap grep manual untuk yakin).

## Task D — run-pr-review.use-case.ts baru

Sesuai poin 4 plan-checkpoint-b.md. Termasuk: PrReviewJobPayload union baru di
queue.interface.ts (dengan repoFullName sejak awal), alur clone→build prompt→spawn
reviewer→baca fix-review-log.md→reply (reply logic sendiri di Task F, di sini cukup
panggil fungsinya). Prompt shape yang dikirim ke agentRunner.run() WAJIB dicek ulang
terhadap buildInputSection('reviewer', ...) di caf-initiator (baca file itu langsung,
jangan dari ingatan plan.md) sebelum dianggap selesai — pastikan label INLINE/GENERAL dan
mode scoped/global/initial persis match yang diharapkan agent.

**Verify:** baca ulang caf-reviewer.md hasil generate (dari umkm-pos atau scratch) sambil
bandingkan ke prompt yang dibangun use-case ini secara manual/dry-read — pastikan shape-nya
kompatibel.

## Task E — route handler POST /webhooks/github

Sesuai poin 3 plan-checkpoint-b.md (2 event descoped-final: issue_comment,
pull_request_review_comment, plus ping). HARUS setelah Task A selesai (constraint di atas).
Urutan handler: verify signature (Task B) → claim delivery (Task C) → branch by
X-GitHub-Event → permission check (Task F) sebelum enqueue → enqueue job 'pr-review'.

Ingat nuance in_reply_to_id: falsy check (!comment.in_reply_to_id), BUKAN strict null check
(poin 0 plan-checkpoint-b.md) — ini detail kecil yang gampang salah tulis, cek eksplisit
saat implementasi.

**Verify:** kalau ada cara replay payload capture yang masih ada catatannya di
plan-checkpoint-b.md (payload contoh sudah didokumentasikan di poin 0 — pakai itu sebagai
fixture test lokal, generate ulang secara manual kalau perlu berdasarkan struktur yang
sudah dicatat), jalankan lewat route ini secara lokal, konfirmasi branching benar tanpa
perlu setup webhook GitHub nyata dulu.

## Task F — checkReviewPermission() + method reply baru di GithubService

Sesuai poin 5 & 6 plan-checkpoint-b.md. checkReviewPermission() di vcs/github-permission.ts
(kode sudah didesain di plan, tinggal implementasi persis). Method
replyToReviewComment()/postIssueComment() ditambah ke GithubService existing (bukan file
baru terpisah, sesuai keputusan poin 5).

**Verify:** baca ulang komentar kode yang wajib merujuk plan.md §5 caf-initiator sebagai
sumber tunggal threshold (sama pola yang sudah dilakukan di fix-review-command.js Checkpoint
A) — pastikan komentar itu ADA, bukan cuma di plan-checkpoint-b.md.

## Task G — readFixReviewLog() parser

Sesuai poin 5 plan-checkpoint-b.md. Sebelum implementasi, BACA ULANG format
fix-review-log.md yang final dari Checkpoint A (Task B tasks.md caf-initiator) — jangan
dari ingatan, baca file spec/hasil generate langsung, karena parser regex-loose ini rawan
mismatch kalau formatnya sedikit beda dari yang diasumsikan.

**Verify:** buat 1 file fix-review-log.md contoh manual (ikut format yang dibaca di atas,
termasuk kasus FIXED/SKIPPED/NOT_APPLICABLE), jalankan parser terhadap file itu, pastikan
semua block ter-parse benar.

## Task H — rencana verifikasi Checkpoint B (bukan eksekusi end-to-end, itu poin 7 plan
terpisah setelah A+B selesai)

- Tidak ada test suite — verifikasi manual tiap task seperti disebut di atas.
- Task terakhir: baca ulang SEMUA komentar kode yang merujuk ke caf-initiator plan.md
  (threshold permission, kontrak prompt reviewer) — pastikan referensinya akurat (path file,
  nomor section) supaya kalau nanti dokumen itu di-restructure, orang yang baca referensi
  ini tidak nyasar.
- CATATAN WAJIB (jangan dihapus dari tasks.md ini): Checkpoint B selesai bukan berarti
  CAF-PRREVIEW-01 closed — poin 7 plan-checkpoint-b.md (verifikasi end-to-end lintas
  checkpoint, butuh setup repo test baru) masih harus dijalankan setelah ini. Jangan tandai
  ticket sebagai closed di akhir Checkpoint B.
