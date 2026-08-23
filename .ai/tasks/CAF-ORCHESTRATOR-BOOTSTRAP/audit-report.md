# Audit Report — caf-orchestrator Bootstrap (3 Bagian Kritis)

Read-only audit. No code changed. Tanggal: 2026-07-04.

Catatan penting: task brief nyebut `linear.service.ts` sebagai lokasi
signature/timestamp/dedup logic. Faktanya logic itu ADA, tapi bukan di
`linear.service.ts` (itu cuma GraphQL client buat postComment/updateStatus).
Logic asli ada di:
- `src/presentation/web/routes/webhooks.ts` (orkestrasi/urutan validasi)
- `src/infrastructure/vcs/security.ts` (verifyLinearSignature, isLinearTimestampFresh)
- `src/infrastructure/linear/delivery-dedupe.ts` (claimDelivery)
- `src/presentation/dto/webhook.dto.ts` (schema payload)

Audit di bawah ngikutin lokasi asli, bukan nama file di brief.

---

## 1. Webhook Security (signature, timestamp, dedup)

**Status: OK**

Detail temuan:
- Signature: `verifyLinearSignature` (security.ts:7-33) pakai HMAC-SHA256
  atas `request.rawBody` (Buffer mentah, di-capture di app.ts:40-52 lewat
  custom content-type parser SEBELUM JSON.parse) — bukan re-stringify.
  Cocok pola GitHub tapi TANPA strip prefix, sesuai spek Linear (dikonfirmasi
  via docs resmi Linear: `Linear-Signature` = hex HMAC-SHA256 raw body, no
  prefix).
- Timing-safe compare: pakai `timingSafeEqual` (security.ts:32), dengan
  length-check dulu sebelum compare (line 28) — benar, cegah timing attack
  dan cegah exception dari length mismatch di timingSafeEqual.
- Timestamp freshness: `isLinearTimestampFresh` (security.ts:39-54) baca
  header `linear-timestamp`, compare `Math.abs(now - timestamp)` terhadap
  tolerance, default 60_000 ms (schema.ts:28, .env.example). Dikonfirmasi
  ke docs resmi Linear: `Linear-Timestamp` header emang ada, unitnya unix
  ms — SESUAI dengan kode. Body juga punya field `webhookTimestamp` (ms),
  konsisten (lihat fixture tests/fixtures/linear-issue-update-ready-for-ai.json:24).
  Unit ms vs ms — tidak ada mismatch.
- Dedup: `claimDelivery` (delivery-dedupe.ts:11-16) pakai Redis `SET NX EX`
  atomik dengan key `linear:delivery:<uuid>` dari header `linear-delivery`,
  TTL dari `LINEAR_DELIVERY_DEDUPE_TTL_SECONDS` (default 86400s = 24h).
  `Linear-Delivery` header dikonfirmasi resmi ada (UUID v4 idempotency id).
  Reject terjadi SEBELUM masuk queue (webhooks.ts:38-41, return sebelum
  `pipelineQueue.addJob`).
- Urutan validasi (webhooks.ts:13-48): signature (13) → timestamp (21) →
  delivery header presence + dedup claim (29-41) → baru `safeParse` payload
  (43). Urutan benar — tidak ada parsing/proses payload sebelum signature
  tervalidasi.

Rekomendasi: tidak ada gap. Minor nice-to-have (bukan bug): body juga bawa
`webhookTimestamp` (dto:18) yang tidak dipakai — redundant tapi harmless,
tidak perlu diubah.

---

## 2. spawn-agent.service.ts — Timeout & Process Handling

**Status: OK, dengan 1 GAP kecil (retry count)**

Detail temuan:
- Timeout eksplisit sendiri: ADA. `setTimeout` (spawn-agent.service.ts:34-45)
  pakai `config.CLAUDE_AGENT_TIMEOUT_MS`, kirim SIGTERM dulu, escalate ke
  SIGKILL 10s kemudian kalau belum mati. Tidak cuma andalkan BullMQ.
- BullMQ lockDuration: worker.ts:12 `LOCK_DURATION_MS = 30*60_000` (30 menit),
  jauh di atas default BullMQ (~30s). `lockRenewTime` 5 menit (line 13).
  Cukup besar, sejalan dgn `CLAUDE_AGENT_TIMEOUT_MS` default 30 menit
  (schema.ts:32) — TAPI perhatikan: lockDuration dan agent timeout SAMA
  persis (30 menit). Kalau agent butuh waktu sampai mendekati timeout,
  BullMQ bisa anggap job stalled tepat saat proses masih dalam graceful
  SIGTERM/SIGKILL escalation (butuh ~10 detik ekstra). Margin tipis.
- Signal handling: ADA. `proc.on('close', (code, signal))` (line 50) capture
  signal, log sbg error kalau signal ada (line 61-66), full-retry policy
  (dikonfirmasi lewat BullMQ `attempts` di client.ts, bukan resume-from-step)
  — sesuai keputusan v1.
- stdout/stderr capture: ADA, di-buffer per chunk (line 47-48), digabung
  dan dimasukkan ke `AgentRunResult` (line 56-57) buat consumer log/debug.
  Tapi stdout/stderr TIDAK di-log langsung di sini (cuma dikembalikan via
  result) — kalau caller (job runner) gak nge-log ini saat gagal, jejak
  debug bisa hilang. Perlu cek job runner (`src/infrastructure/queue/worker.ts`
  cuma nge-log `err.message` dari BullMQ, bukan stdout/stderr agent) →
  **berpotensi GAP**: stdout/stderr agent gagal tidak tampak di log worker.
- Retry limit: `client.ts:22` `attempts: 2` — brief minta "retry max 3x
  sesuai pola PIV". **GAP**: cuma 2 attempts (1 retry), bukan 3x.

Rekomendasi fix:
1. (GAP - retry count) Naikkan `attempts` di client.ts:22 dari `2` ke `3`
   kalau memang mau ikut pola PIV max-3x. Atau, kalau 2 emang keputusan
   sadar (karena tiap retry mahal — re-clone + re-spawn), dokumentasikan
   eksplisit di komentar bahwa ini deviasi disengaja dari pola PIV.
2. (GAP - observability) Pastikan caller job runner (yg manggil
   `spawnAgentService.run()`, kemungkinan di `job-runner`/usecase layer —
   belum ditemukan di src yang dibaca) benar-benar nge-log
   `result.stdout`/`result.stderr` saat `exitCode !== 0` atau `signal`
   ada, bukan cuma error BullMQ generik. Kalau belum, tambahkan logging
   di titik itu.
3. (Minor) Pertimbangkan lockDuration sedikit lebih besar dari
   CLAUDE_AGENT_TIMEOUT_MS + escalation buffer (mis. 35 menit) biar gak
   mepet dgn proses SIGTERM→SIGKILL 10 detik.

---

## 3. config/schema.ts — Validasi Env Vars

**Status: OK**

Detail temuan:
- `LINEAR_READY_STATE_ID`, `LINEAR_WEBHOOK_SECRET`, `LINEAR_API_KEY` semua
  required (pakai `z.string({error: '...'})` tanpa `.default()`/`.optional()`),
  akan throw saat startup kalau kosong. `LINEAR_READY_STATE_ID` juga
  divalidasi format UUID (schema.ts:22-24).
- Hardcoded secret: grep tidak nemu string token/secret/UUID sensitif
  di-hardcode di source. Satu-satunya UUID contoh ada di `.env.example`
  (placeholder `00000000-...`), bukan di kode. Aman.
- `WORKER_CONCURRENCY`: TIDAK ada di Zod schema — dibaca langsung dari
  `process.env['WORKER_CONCURRENCY']` di `worker.ts:17` dengan default `1`
  kalau env kosong/unset. Ini **konsisten** dengan pola ai-code-review yang
  disebutkan di brief (dibaca langsung dari process.env, bukan bagian
  skema Zod) — bukan gap, memang sengaja dipisah dari validated config
  karena worker adalah proses terpisah dari HTTP server.

Rekomendasi: tidak ada gap. Kalau mau lebih strict, bisa tambah komentar
di worker.ts kenapa WORKER_CONCURRENCY sengaja di luar Zod schema (biar
gak ke-flag lagi di audit berikutnya), tapi ini opsional/kosmetik.

---

## Ringkasan Prioritas

| # | Item | Severity | Status |
|---|------|----------|--------|
| 1 | Webhook signature/timestamp/dedup/urutan | - | OK, no gap |
| 2 | BullMQ retry attempts = 2, bukan 3x sesuai pola PIV | Low-Medium | GAP |
| 3 | stdout/stderr agent mungkin gak ke-log di caller saat gagal | Medium | GAP (perlu verifikasi caller, belum ditemukan di file yg dibaca) |
| 4 | lockDuration == CLAUDE_AGENT_TIMEOUT_MS, margin tipis | Low | Minor, no action forced |
| 5 | Env var validation (Zod) | - | OK, no gap |
| 6 | Hardcoded secrets | - | none found |

Belum ada perubahan kode dilakukan — semua rekomendasi di atas nunggu
approval sebelum implementasi.
