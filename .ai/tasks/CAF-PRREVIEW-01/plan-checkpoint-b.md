# Plan: CAF-PRREVIEW-01 — Checkpoint B (caf-orchestrator, investigasi, belum implementasi)

Status: INVESTIGASI SELESAI, menunggu approval. Jangan lanjut ke tasks.md sebelum disetujui.

Rujukan wajib dibaca duluan (sudah dibaca): `caf-initiator/.ai/tasks/CAF-PRREVIEW-01/plan.md`
(Checkpoint A) dan `open-items.md` (warisan poin 0 ke sini).

---

## 0. PRASYARAT GATED — validasi `in_reply_to_id` di payload webhook asli — **RESOLVED**

Setup nyata dijalankan (bukan asumsi):
- Repo test baru `ganjardbc/caf-webhook-capture-test` (public, throwaway — dihapus setelah
  checkpoint ini di-approve, lihat catatan Cleanup di akhir dokumen).
- PR #1 di repo itu, webhook repo-level ke webhook.site (secret `testsecret123`, events:
  `pull_request_review_comment`, `issue_comment`, `pull_request_review`).
- 1 inline review comment dibuat (`POST /pulls/1/comments`, id `3809805822`), 1 reply ke situ
  (`POST /pulls/1/comments/3809805822/replies`, id `3809806234`).
- 5 delivery ter-capture: `ping`, 2x `pull_request_review` (auto-generated tiap kali komentar
  inline dibuat — GitHub bungkus jadi review), 2x `pull_request_review_comment` (satu untuk
  comment awal, satu untuk reply).

**Temuan:**
- Delivery reply (`comment.id = 3809806234`): payload webhook punya
  `"in_reply_to_id": 3809805822` — persis field yang sama seperti REST resource, terkonfirmasi
  ADA di payload webhook asli, bukan cuma di `GET /pulls/comments`.
- Delivery comment awal (`comment.id = 3809805822`): key `in_reply_to_id` **TIDAK ADA SAMA
  SEKALI** di objek `comment` — beda dari REST resource yang eksplisit set `null`. **Nuance
  wajib dicatat untuk implementasi**: kode parsing HARUS treat "key absent" dan "key null"
  sebagai signal yang sama (comment awal, bukan reply) — pola pengecekan yang benar adalah
  `!payload.comment.in_reply_to_id` (falsy check), BUKAN `payload.comment.in_reply_to_id ===
  null` (strict null check akan salah untuk kasus absent).
- Header terkonfirmasi ada di payload webhook GitHub asli (relevan untuk poin 1 & 2 di bawah):
  `X-GitHub-Event`, `X-GitHub-Delivery`, `X-Hub-Signature-256` (format `sha256=<hex>`),
  `X-Hub-Signature` (format `sha1=<hex>`, legacy — tidak dipakai), `X-GitHub-Hook-ID`,
  `X-GitHub-Hook-Installation-Target-Type`/`-Id`.

**Kesimpulan:** desain scoped-fix (event `pull_request_review_comment`, discriminate
scoped/global by `in_reply_to_id`) di plan.md §1 **VALID, tidak perlu redesign**. Update status
di `open-items.md` caf-initiator jadi RESOLVED (dilakukan terpisah, lihat catatan di akhir).

---

## 1. Signature verification GitHub — KESIMPULAN

Dibaca: `src/infrastructure/vcs/security.ts` (`verifyLinearSignature`, HMAC-SHA256 raw body,
hex polos, `timingSafeEqual`).

Dikonfirmasi via docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
(bukan ingatan) **dan** via payload capture nyata di poin 0: header `X-Hub-Signature-256`,
format `sha256=<hex digest>` — HMAC-SHA256 atas raw request body, secret = yang diset saat
create webhook. Prefix `sha256=` WAJIB di-strip sebelum hex-decode, beda dari Linear yang hex
polos tanpa prefix.

**Desain fungsi `verifyGitHubSignature()`** (sibling di `security.ts`, sama file — bukan modul
baru, sama seperti direkomendasikan plan.md §3):
```ts
export function verifyGitHubSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const hex = signatureHeader.slice('sha256='.length);
  // hex-decode, HMAC, timingSafeEqual — identik verifyLinearSignature dari titik ini
}
```
Legacy `X-Hub-Signature` (`sha1=`) diabaikan — GitHub selalu kirim keduanya kalau webhook
dikonfigurasi dengan secret, sha256 yang dipakai (sha1 cuma backward-compat, HMAC-SHA1 lebih
lemah, tidak ada alasan pakai itu untuk webhook baru).

---

## 2. Delivery dedupe — KESIMPULAN

Dibaca: `src/infrastructure/linear/delivery-dedupe.ts`.

**Temuan: TIDAK generic seperti diasumsikan plan.md §3.** `claimDelivery()` hardcode:
- prefix key Redis `linear:delivery:` (namespace Linear literal di const module-level).
- `config.linear.deliveryDedupeTtlSeconds` (field TTL ada di bawah namespace `linear` di
  `caf.config.yaml`/schema.ts, bukan field generic).

Signature-nya (`claimDelivery(deliveryId: string): Promise<boolean>`) sendiri generic terhadap
BENTUK ID (cuma string), tapi implementasinya TERIKAT ke config Linear. Reuse langsung TIDAK
bisa tanpa modifikasi kecil. Dua opsi:
- (a) Generalize `claimDelivery(source: 'linear' | 'github', deliveryId: string, ttlSeconds:
  number)` — satu fungsi, prefix dan TTL jadi parameter.
- (b) Fungsi sibling `claimGithubDeliveryId()` di modul baru sejenis (mis.
  `infrastructure/vcs/delivery-dedupe.ts`), copy pola yang sama, TTL dari config namespace baru
  (mis. `github.deliveryDedupeTtlSeconds` atau reuse `config.linear.deliveryDedupeTtlSeconds`
  kalau nilai defaultnya cocok — perlu keputusan di tasks.md, bukan besar tapi bukan
  zero-decision).

Rekomendasi: (a), generalize fungsi yang sudah ada — lebih sedikit duplikasi, tetap 1 fungsi 1
sumber kebenaran untuk pola dedupe. Sumber ID: header `X-GitHub-Delivery`, dikonfirmasi ada di
capture poin 0 (semua 5 delivery punya header ini, UUID v1-looking format).

---

## 3. Route handler — KESIMPULAN

Dibaca: `src/presentation/web/routes/webhooks.ts` (satu-satunya route existing, `/linear`).

**Struktur route: 1 route baru (`POST /webhooks/github`), branching internal by `X-GitHub-Event`
header** — bukan 3 route terpisah, bukan juga 1 handler generic tanpa branching. Alasan sama
seperti plan.md §1: signature verification + dedupe logic identik untuk ketiga event
(`issue_comment`, `pull_request_review_comment`, `pull_request_review`), cuma payload shape dan
logic pembeda intent yang beda — jadi urutan handler:

1. Verify `verifyGitHubSignature()` (poin 1) — sekali, sebelum parse apapun.
2. Claim delivery via `X-GitHub-Delivery` (poin 2) — sekali, sebelum parse apapun.
3. Baca `X-GitHub-Event` header, branch:
   - `ping` → 200 langsung (GitHub kirim ini saat webhook dibuat, dikonfirmasi di capture poin
     0 — WAJIB di-handle, bukan reject, atau webhook config akan gagal validasi hijau di UI
     GitHub).
   - `issue_comment` (action `created`) → parse `comment.body`, `issue.pull_request` (harus ADA
     — issue_comment juga fire untuk issue biasa, bukan cuma PR; kalau field ini absent, PR
     yang bukan tujuannya, ignore) → intent parsing teks (trigger awal vs global fix, plan.md
     §1 poin a/c) → enqueue.
   - `pull_request_review_comment` (action `created`) → parse `comment.in_reply_to_id` (poin 0
     nuance: falsy check, bukan strict null) → scoped fix kalau terisi, ignore kalau kosong
     (comment awal inline TANPA reply bukan trigger — hanya reply yang trigger scoped fix,
     sesuai pemetaan plan.md §1 poin b).
   - Event lain (`edited`, `deleted`, event type tak dikenal, termasuk `pull_request_review` —
     DESCOPED, lihat catatan di bawah) → 200 ignore, log internal.
4. Permission check (poin 6) SEBELUM enqueue — commenter/reviewer harus write/maintain/admin.
5. Enqueue job `pr-review` name ke queue `agent-pipeline` yang sama (lihat poin 4 di bawah).

**DESCOPED: event `pull_request_review`.** Alasan: 2 delivery `pull_request_review` ter-capture
di poin 0 (auto-generated dari inline comment biasa, bukan submit review formal) belum sempat
diperiksa isi `review.body`/`review.state`-nya sebelum repo test capture terhapus. Tanpa
verifikasi itu, filter "review.body non-kosong" berisiko salah — inline comment biasa bisa
ke-treat sebagai trigger review baru, nyebabin double-trigger tiap kali reviewer bikin 1 comment
biasa. Detail lengkap + syarat re-aktivasi: lihat entry baru di `caf-initiator/.ai/tasks/
CAF-PRREVIEW-01/open-items.md`. Event yang di-subscribe/di-handle SEKARANG cuma: `issue_comment`,
`pull_request_review_comment`, `ping`.

**GitHub webhook subscription config (manual, untuk instruksi setup user nanti):** repo
settings → Webhooks → centang **Issue comments**, **Pull request review comments** di "Let me
select individual events". **JANGAN centang "Pull request reviews"** (descoped, lihat di atas).
Payload URL = endpoint `/webhooks/github` baru ini, Content type = `application/json`, Secret = nilai baru
(env var, lihat poin 1).

---

## 4. Use-case `run-pr-review.use-case.ts` — KESIMPULAN

Dibaca: `src/domain/interfaces/git.interface.ts`, `src/infrastructure/git/git.service.ts`,
`src/domain/interfaces/queue.interface.ts`, `src/infrastructure/queue/client.ts`,
`src/infrastructure/queue/worker.ts`, `src/worker.ts`, `src/domain/interfaces/agent-runner
.interface.ts`, `src/infrastructure/reports/report-reader.ts`, `caf-initiator/src/templates/
agent-md.js` (`buildInputSection('reviewer', ...)`, sudah diperluas di Checkpoint A).

**Checkout branch PR existing — TIDAK butuh method IGitService baru.** `GitService.clone()`
sudah menerima `branch` sebagai parameter arbitrary (`git clone --branch <branch>
--single-branch`), bukan hardcode base branch. Untuk PR review, tinggal panggil
`gitService.clone(repoUrl, prHeadBranchName, targetDir)` dengan nama branch head PR (dari
payload webhook: `pull_request.head.ref` / `issue.pull_request` perlu fetch detail PR dulu via
`GET /pulls/{number}` untuk dapat `head.ref` kalau event-nya `issue_comment` yang cuma punya
`issue.number`). **Tidak perlu `createBranch()`** (itu untuk pipeline PIV yang bikin branch
baru) — use-case ini murni checkout existing, tidak commit/push balik ke branch PR (reviewer
cuma menulis laporan, tidak mengubah kode — lihat poin 5, beda dari `run-agent-pipeline` yang
commit+push).

**Ordering implicit wajib:** branching `job.name` di `worker.ts` (poin ini) HARUS selesai dan
ter-deploy SEBELUM route handler `/webhooks/github` (poin 3) mulai enqueue job `pr-review` apapun —
termasuk untuk testing. Lihat Ringkasan keputusan poin 6 untuk alasan lengkap.

**Job routing — gap nyata ditemukan:** `src/worker.ts` saat ini **mengabaikan `job.name` sama
sekali** — callback `QueueWorker` selalu memanggil `useCase.execute(job.data)` tanpa branch.
`IQueue.addJob(name, data)` sudah punya parameter `name`, tapi sisi worker belum consume itu.
**Wajib diubah** di `worker.ts`: branch by `job.name` (`'agent-pipeline'` →
`RunAgentPipelineUseCase`, `'pr-review'` → `RunPrReviewUseCase` baru), keduanya construct
sekali di module scope seperti sekarang, worker callback pilih salah satu.

**Prompt ke agent reviewer — kontrak yang harus di-match persis:** dibaca `buildInputSection
('reviewer', ...)` di `caf-initiator/src/templates/agent-md.js` (Checkpoint A Task C, sudah
committed) — kontraknya: comment context disisipkan **langsung di prompt spawn**, BUKAN file
artifact di `.caf/tasks/{TICKET-ID}/`. Bentuk yang diharapkan: teks comment + label
`INLINE path:line` atau `GENERAL` + mode `scoped`/`global`. `run-pr-review.use-case.ts` HARUS
build prompt string dengan shape sama, dipanggil via `agentRunner.run('reviewer', repoPath,
prompt)` — interface `IAgentRunner.run(agentName, cwd, prompt)` sudah generic, reusable
langsung, tidak perlu perubahan.

**Struktur `PrReviewJobPayload` (union baru di `queue.interface.ts`, forward-compat poin 6
plan.md):**
```ts
export interface PrReviewJobPayload {
  jobId: string;
  repoFullName: string;       // dari payload.repository.full_name, sejak awal (plan.md §6)
  cloneUrl: string;
  prNumber: number;
  prHeadBranch: string;
  mode: 'initial' | 'scoped' | 'global';
  commentContext: {
    label: 'INLINE' | 'GENERAL';
    body: string;
    path?: string;             // hanya utk INLINE
    line?: number;              // hanya utk INLINE
  }[];
}
export type JobPayload = ExistingJobPayload | PrReviewJobPayload; // union
```
`JobRunner` type (`(job: { name; data: JobPayload; id }) => Promise<void>`) perlu narrowing by
`job.name` di `worker.ts` sebelum cast ke payload spesifik.

**Alur use-case (garis besar, bukan kode final):**
1. Create disposable workspace (`IWorkspaceManager`, reusable).
2. `gitService.clone(cloneUrl, prHeadBranch, targetDir)`.
3. Build prompt (comment context, shape di atas) → `agentRunner.run('reviewer', targetDir,
   prompt)`.
4. Baca `fix-review-log.md` (poin 5) → reply ke GitHub.
5. TIDAK ada commit/push/PR baru — beda struktural dari `run-agent-pipeline.use-case.ts`.
6. TIDAK ada QA/implementation gate — satu agent call saja, sesuai plan.md §3.

---

## 5. Kontrak output `fix-review-log.md` — KESIMPULAN

Dibaca: `src/infrastructure/reports/report-reader.ts` (pola `readReviewerReport`,
`readVerifyReport`, dll — semua regex-loose di atas markdown, `readIfExists` + regex).

**Parser baru dibutuhkan**, ikut pola persis yang sudah ada (bukan JSON terstruktur, sesuai
CLAUDE.md "Report contract"): `readFixReviewLog(workspacePath, ticketKey)` di
`report-reader.ts`, baca `.caf/tasks/{TICKET-ID}/fix-review-log.md` (path sama pola
`taskDir()` yang sudah ada), regex per-comment block untuk status `FIXED` / `SKIPPED` /
`NOT_APPLICABLE` (format block-nya didesain di Checkpoint A Task B — perlu dibaca ulang bentuk
persisnya dari `caf-initiator` sebelum tasks.md, TIDAK diverifikasi ulang di sini karena sudah
committed dan disebut final oleh Checkpoint A).

**Setelah baca, use-case harus reply ke GitHub** — fungsi baru setara `replySection()` (dipakai
`fix-review-command.js` jalur interactive) tapi versi TypeScript/Octokit-shape (sebenarnya raw
`fetch`, lihat poin 6 catatan "Octokit tidak ada di dependency"):
- Per comment `FIXED`/`SKIPPED`/`NOT_APPLICABLE` yang berasal dari INLINE comment → reply ke
  thread itu: `POST /repos/{owner}/{repo}/pulls/{pr}/comments/{comment_id}/replies`
  (endpoint yang sudah dipakai manual di poin 0 untuk bikin reply test — dikonfirmasi bekerja).
- Satu comment ringkasan penutup di percakapan umum PR → `POST /repos/{owner}/{repo}/issues/
  {pr}/comments` (general comment endpoint, sama seperti dibaca di plan.md §4).
- Modul baru direkomendasikan: `infrastructure/vcs/github-pr-reply.service.ts` (atau tambah
  method di `GithubService` yang sudah ada — `GithubService` sekarang cuma implement
  `createPullRequest`, method baru `replyToReviewComment()`/`postIssueComment()` bisa masuk
  situ langsung, tidak perlu file baru kalau `IVcsClient` interface diperluas).

---

## 6. Permission check versi SDK — KESIMPULAN

Dibaca: `src/infrastructure/vcs/github.service.ts` (`GithubService.createPullRequest`).

**Temuan: tidak ada Octokit di dependency (`package.json` tidak punya paket octokit).** Semua
panggilan GitHub API di codebase ini pakai raw `fetch` + `config.GITHUB_TOKEN` bearer +
`config.github.apiUrl` base — bukan Octokit SDK seperti diasumsikan "Octokit/fetch" di
plan.md §5/§3. **Koreksi:** `checkReviewPermission()` HARUS pakai `fetch`, sama pola persis
`createPullRequest()`, bukan Octokit (tidak ada alasan nambah dependency baru untuk satu GET
call).

```ts
// Threshold & endpoint: satu sumber rujukan caf-initiator/.ai/tasks/CAF-PRREVIEW-01/plan.md §5.
// Jaga identik dengan versi CLI (fix-review-command.js, `gh api .../permission --jq .permission`).
const ALLOWED_PERMISSIONS = ['write', 'maintain', 'admin'] as const;

export async function checkReviewPermission(owner: string, repo: string, username: string): Promise<boolean> {
  const res = await fetch(`${config.github.apiUrl}/repos/${owner}/${repo}/collaborators/${username}/permission`, {
    headers: { Authorization: `Bearer ${config.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) return false; // fail-closed: 404 (bukan collaborator) atau error apapun → ditolak diam-diam
  const json = (await res.json()) as { permission: string };
  return ALLOWED_PERMISSIONS.includes(json.permission as typeof ALLOWED_PERMISSIONS[number]);
}
```

Ditaruh di modul infra baru `vcs/github-permission.ts` (sejenis `vcs/security.ts`), dipanggil
dari route handler (poin 3, step 4) **sebelum** `pipelineQueue.addJob` — gagal check =
`return reply.status(200).send(...)` diam-diam, TIDAK enqueue, TIDAK reply ke PR (sama pola
fail-silent seperti Linear webhook `stateId` mismatch). Log internal (`logger.info`, bukan
`error` — bukan kondisi error, cuma bukan-collaborator-berwenang) untuk observability tanpa
membocorkan hasil ke pihak yang tidak berwenang.

---

## 7. Verifikasi end-to-end lintas checkpoint — RENCANA (belum dijalankan)

Setelah Checkpoint A dan B keduanya diimplementasi (tasks.md masing-masing selesai), sebelum
CAF-PRREVIEW-01 diklaim closed:

1. Siapkan PR test baru (repo test terpisah dari yang dipakai poin 0, atau reuse
   `caf-webhook-capture-test` kalau belum dihapus — lihat catatan Cleanup).
2. Buat 1 inline comment identik di PR itu dua kali dengan cara berbeda:
   - **Jalur interactive:** jalankan `/caf-fix-review` di Claude Code lokal, pilih comment
     tsb sebagai scoped fix.
   - **Jalur webhook:** reply ke comment yang SAMA (thread sama, `in_reply_to_id` sama) di PR
     test TERPISAH dengan isi diff yang identik, biarkan webhook caf-orchestrator trigger
     otomatis.
3. Bandingkan (a) isi `fix-review-log.md` yang dihasilkan kedua jalur — struktur block
   FIXED/SKIPPED/NOT_APPLICABLE harus setara (bukan byte-identik, karena diff kode yang di-fix
   bisa beda konteks run, tapi shape/format block harus sama); (b) bentuk reply GitHub yang
   diposting kedua jalur — reply per-inline-comment + 1 comment ringkasan penutup, di kedua
   jalur, format label yang sama.
4. Kalau ada divergensi struktural (bukan cuma isi) → itu bug drift antara dua implementasi
   command interactive vs use-case webhook, BUKAN masalah desain — perbaiki union code path
   kalau memungkinkan (mis. ekstrak fungsi format reply yang sama dipakai command JS via child
   process call ke helper TS, atau sebaliknya) alih-alih biarkan drift.

Ini WAJIB dicatat sebagai bagian verifikasi sebelum ticket diklaim closed — dicatat di sini
sesuai instruksi, dijalankan nanti setelah kedua tasks.md checkpoint selesai diimplementasi.

---

## Cleanup — resource GitHub yang dibuat untuk poin 0

Repo `caf-webhook-capture-test` SUDAH DIHAPUS (user action, di luar sesi investigasi ini).
Konsekuensi untuk poin 7 (verifikasi end-to-end): butuh setup repo test BARU dari nol saat poin 7
dijalankan nanti — tidak ada resource yang bisa di-reuse dari poin 0. Konsekuensi untuk item 1
di atas (`pull_request_review` descoped): verifikasi ulang event ini di masa depan (kalau mau
diaktifkan) juga butuh capture baru dari nol.

---

## Ringkasan keputusan yang perlu approval sebelum tasks.md

1. Poin 0 RESOLVED — `in_reply_to_id` valid di payload webhook, dengan nuance "absent, bukan
   null" untuk comment non-reply — kode parsing pakai falsy check.
2. `verifyGitHubSignature()` sibling di `security.ts`, parsing prefix `sha256=`.
3. `claimDelivery()` DIGENERALIZE (bukan reuse mentah) — prefix+TTL jadi parameter, bukan
   hardcode namespace Linear.
4. 1 route baru `POST /webhooks/github`, branching internal by `X-GitHub-Event`, event yang di-subscribe
   2 event (`issue_comment`, `pull_request_review_comment`) + `ping` — `pull_request_review`
   DESCOPED, lihat open-items.md.
5. `run-pr-review.use-case.ts` baru: reuse `GitService.clone()` langsung (tidak perlu method
   baru), TIDAK commit/push, satu agent call reviewer dengan prompt shape yang match kontrak
   `buildInputSection('reviewer',...)` Checkpoint A.
6. **Gap ditemukan**: `worker.ts` saat ini abai `job.name` — wajib ditambah branching by
   job name untuk routing ke use-case yang benar. **WAJIB URUTAN**: branching ini HARUS selesai
   dan ter-deploy SEBELUM route handler `/webhooks/github` mulai enqueue job `pr-review` apapun — termasuk
   untuk testing. Kalau kebalik, job `pr-review` pertama yang masuk queue akan disalah-proses
   sebagai `RunAgentPipelineUseCase` (checkout branch baru, spawn planner, dst) oleh worker yang
   belum tahu cara routing — bukan cuma gagal, berpotensi mengubah state repo yang salah.
   `tasks.md` WAJIB urutkan task `worker.ts` branching sebagai task PALING AWAL di antara
   task-task implementasi (setelah investigasi yang sudah selesai di sini), sebelum task route
   handler apapun yang bisa enqueue job baru.
7. `checkReviewPermission()` pakai raw `fetch` (bukan Octokit — tidak ada di dependency),
   dipanggil di route sebelum enqueue, fail-closed diam-diam.
8. Parser baru `readFixReviewLog()` di `report-reader.ts` (pola sama existing), plus method
   reply baru di `GithubService` (`replyToReviewComment`/`postIssueComment`) — bukan modul
   Octokit terpisah.
9. `PrReviewJobPayload` sebagai union baru di `queue.interface.ts`, punya `repoFullName` sejak
   awal (plan.md §6).
10. Rencana verifikasi lintas checkpoint (poin 7) dicatat, dijalankan setelah kedua tasks.md
    checkpoint selesai.
11. Repo test `caf-webhook-capture-test` SUDAH DIHAPUS — poin 7 butuh setup repo test baru dari
    nol.

STOP di sini. Menunggu approval sebelum lanjut `tasks.md`.
