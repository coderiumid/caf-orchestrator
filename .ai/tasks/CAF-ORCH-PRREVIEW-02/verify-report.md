# Verify Report — CAF-ORCH-PRREVIEW-02

Status: **STOPPED after Task 1 — investigation only, no code changed.**

Ticket ini menggantikan `CAF-ORCH-PRREVIEW-01` sepenuhnya (dibatalkan, tidak
pernah masuk implementasi — investigasi menemukan `caf-pr-review`/refactor
`caf-reviewer` tidak perlu dibangun karena `RunPrReviewUseCase`
(`CAF-PRREVIEW-01`) sudah ada). `CAF-ORCH-PRREVIEW-02` sendiri kemudian juga
dihentikan di Task 1 setelah investigasi menemukan premisnya sendiri tidak
akurat — lihat detail di bawah. **Tidak ada implementasi untuk kedua
ticket.**

## Task 1 — Investigasi Interface & Titik Integrasi (SELESAI, blocking finding)

### Temuan yang sesuai asumsi ticket

- `IVcsClient` (`src/domain/interfaces/vcs-client.interface.ts`) punya 3
  method (`createPullRequest`, `replyToReviewComment`, `postIssueComment`) —
  tidak ada method PR Review object. Menambah method baru
  (`createPullRequestReview`) adalah pendekatan yang konsisten dengan pola
  yang ada, bukan extend method lama.
- `GithubService` (`src/infrastructure/vcs/github.service.ts`) — semua
  method pakai pola fetch + `Bearer GITHUB_TOKEN` yang sama. **Tidak ada
  kompleksitas auth/permission tak terduga** — token yang sama dipakai
  untuk create PR/comment sudah cukup scope-nya untuk
  `POST pulls/{number}/reviews` (endpoint standar GitHub API, scope `repo`
  sama).
- Titik integrasi tunggal yang dilaporkan ticket (`RunPrReviewUseCase`
  `execute()`, panggilan `vcsClient.postIssueComment(...)` di akhir,
  `src/application/use-cases/run-pr-review.use-case.ts:197-202`) memang
  betul satu-satunya titik posting akhir untuk semua mode.

### Temuan yang MEMBATALKAN premis ticket — alasan STOP

Ticket berasumsi (`requirements.md` "Latar Belakang") bahwa
`RunPrReviewUseCase` mode `initial` sudah "share assessment logic dengan
`caf-reviewer` (manggil agent yang sama persis)" dan gap-nya HANYA di titik
posting (issue comment vs PR Review object). Setelah membaca kontrak asli
`/caf-review` di `caf-initiator/src/templates/review-command.js` (repo
terpisah, awalnya tidak ada di checkout ini — diberikan path-nya oleh user
setelah checkpoint Task 1), ditemukan gap yang lebih dalam:

**1. Kontrak subagent berbeda, bukan cuma kontrak posting.**

| | `/caf-review` (interaktif, `review-command.js`) | Webhook mode `initial` (`RunPrReviewUseCase`) |
|---|---|---|
| Prompt ke `caf-reviewer` | Mode INITIAL eksplisit — full review dari nol | `buildReviewerPrompt()` selalu pakai template fix-review (comment-response), untuk mode `initial` cuma commentContext dikosongkan |
| File output subagent | `review-notes.md` (Verdict, Security Audit, Qualitative Review, Verdict Rationale — format `caf-reviewer.md`) | `fix-review-log.md` (`### Comment ... Status: FIXED\|SKIPPED\|NOT_APPLICABLE` per komentar) |
| Ada `Verdict`? | Ya — dipakai map ke GitHub `event` | **Tidak ada** — tidak ada field Verdict sama sekali di jalur ini |
| Posting ke GitHub | `POST pulls/{number}/reviews`, `event` dari mapping Verdict (`APPROVE`→APPROVE, `CHANGES REQUESTED`→REQUEST_CHANGES, `DEFER`→COMMENT) + `body` ringkasan | `postIssueComment` — summary dari entries fix-review-log |

Akibatnya: webhook `initial` TIDAK menjalankan `caf-reviewer` dalam mode
INITIAL yang sesungguhnya (full-review, Verdict-producing) — ia menjalankan
mode fix-review dengan daftar komentar kosong, menghasilkan laporan berbasis
status per-komentar (FIXED/SKIPPED/NOT_APPLICABLE) yang secara struktural
tidak punya Verdict untuk dipetakan ke `event` PR Review. "Share assessment
logic" TIDAK selengkap yang dilaporkan investigasi sebelumnya untuk mode
ini secara spesifik.

Konsekuensi: mengganti HANYA `postIssueComment` → `createPullRequestReview`
di titik yang disebut ticket (satu baris/satu panggilan) akan memposting PR
Review dengan `event` yang harus di-fabrikasi/default (mis. selalu
`COMMENT`), bukan hasil pemetaan Verdict asli seperti kontrak
`/caf-review`. Itu bukan "menyelaraskan kontrak", itu kontrak baru yang
kebetulan pakai endpoint yang sama.

**2. Idempotency cross-detection akan tetap gagal walau endpoint disamakan
byte-for-byte** — dilaporkan lebih awal dari Task 3 karena ini directly
relevan ke keputusan berhenti:

`review-command.js` step 0.7 (`existingReviewSection()`) mem-filter
`GET pulls/{number}/reviews` dengan `user.login == {username}`, di mana
`{username}` = login user yang SEDANG menjalankan `/caf-review` (`gh api
user`). Webhook memposting via `GITHUB_TOKEN` milik orchestrator (identitas
bot/app), bukan identitas manusia manapun. Jadi meskipun endpoint & bentuk
artifact disamakan, cek idempotency `/caf-review` mencocokkan **login
aktor**, bukan "apakah PR ini sudah punya review apapun" — review dari
webhook tidak akan pernah match `{username}` seorang manusia. Ini gap
independen dari gap kontrak artifact yang disebut ticket, tidak akan
otomatis tertutup oleh Task 2's perubahan.

## Keputusan

Diinformasikan ke user (checkpoint wajib pasca-Task 1). User memilih:
**stop, tulis verify-report saja** — tidak lanjut implementasi Task 2-5.
Scope ticket sebagaimana ditulis (`requirements.md`/`tasks.md`) tidak
akurat untuk kondisi kode sebenarnya; melanjutkan sesuai instruksi literal
("murni mengubah 1 titik output") berisiko memposting PR Review dengan
`event` yang tidak mencerminkan penilaian nyata, atau diam-diam membangun
ulang assessment logic (`buildReviewerPrompt`/report contract) yang oleh
ticket ini eksplisit dilarang dibangun ulang tanpa sepengetahuan user.

## Status Acceptance Criteria (semua NOT DONE — implementasi tidak dijalankan)

- [ ] `IVcsClient` method baru — tidak dibuat
- [ ] Mode `initial` pakai PR Review object — tidak dibuat
- [ ] Regression test mode `scoped`/`global` tidak berubah — N/A, tidak ada
      perubahan kode sama sekali di area ini
- [ ] Idempotency cross-detection — dianalisis secara kontrak (lihat di
      atas), TIDAK dijalankan sebagai test aktual. Kesimpulan analitis:
      **kemungkinan besar masih gap** (actor-login mismatch), independen
      dari gap artifact-contract yang disebut ticket.
- [ ] Update komentar `review-command.js` baris 322-332 (bukan 326-330 persis
      — nomor baris bergeser dari yang ditulis ticket; blok "Constraints"
      relevan ada di baris 322-332 pada versi saat ini) — tidak diupdate,
      karena isinya (gap artifact-contract) masih akurat dan gap
      idempotency actor-login BELUM terdokumentasi di sana sama sekali
      (temuan baru dari sesi ini, bukan revisi dari yang sudah ada).

## Rekomendasi Lanjutan

Sebelum ticket lanjutan dibuat, dua hal perlu diputuskan oleh pemilik
produk/ticket, bukan diasumsikan oleh implementasi:

1. Apakah webhook mode `initial` HARUS menghasilkan Verdict (butuh ubah
   prompt subagent + report contract ke `review-notes.md`, effort lebih
   besar dari "1 titik output"), atau cukup selalu post `event: COMMENT`
   tanpa Verdict (effort kecil, tapi bukan "menyamakan kontrak" — hanya
   menyamakan endpoint)?
2. Kalau idempotency cross-detection tetap jadi tujuan, matching perlu
   diubah dari "login aktor" ke "ada review apapun dari `RunPrReviewUseCase`
   ini pada state manapun" (mis. token/App identity check di
   `review-command.js`, atau marker lain) — ini perubahan di
   `caf-initiator`, di luar scope `caf-orchestrator`.

## Tidak Disentuh (dikonfirmasi tetap utuh)

- `caf-reviewer`, `caf-initiator` — tidak ada perubahan
- Mode `scoped`/`global` `RunPrReviewUseCase` — tidak ada perubahan
- Tidak ada agent/use case baru dibuat
- Test suite existing — tidak dijalankan modifikasi apapun (tidak perlu,
  tidak ada perubahan kode)
