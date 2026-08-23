# PIV Workflow — umkm-pos / caf-orchestrator

> Turunan dari `CAF.md` § "Pola Kerja: PIV" → "Retry Bertingkat".
> Dokumen ini SOP konkret, bukan template — kalau angka/nama variabel di sini beda dari kode
> aktual, kode yang benar, laporkan supaya dokumen ini diupdate (dokumen hidup, bukan sekali-tempel).

## Level 1 — Retry Internal Agent (PIV loop)

Terjadi **di dalam** satu invocation `claude --agent <name>` (Frontend Agent, Backend Agent, dst),
di luar scope `caf-orchestrator`. Siklus: implement → verify (lint/typecheck/test) → kalau gagal,
perbaiki dan ulangi.

- **Limit:** max 3x
- **State:** hidup di proses/sesi agent itu sendiri, tidak persist ke file/variable orchestrator
- **Kalau gagal terus setelah 3x:** agent menulis `verify-report.md` dengan `Status: NEEDS_HUMAN`,
  orchestrator baca status ini dan stop pipeline (lihat Level 2)

## Level 2 — Retry Lintas-Gate (QA gate & Reviewer gate)

Terjadi di `run-agent-pipeline.use-case.ts`, **setelah** Frontend/Backend Agent mengaku selesai
(verify-report `SUCCESS`), saat QA Agent atau Reviewer Agent menemukan masalah.

| Gate | Counter | Limit | Trigger retry |
|---|---|---|---|
| QA | `qaRetryCount` | `MAX_QA_RETRIES = 1` | `qaReport.status === 'FAIL'` |
| Reviewer | `reviewerRetryCount` | `MAX_REVIEWER_RETRIES = 1` | `reviewerReport.verdict === 'CHANGES_REQUESTED'` |

**Sifat counter (terverifikasi dari kode):**
- **Independen** — dua variabel `let` terpisah, dua constant limit terpisah, tidak saling
  memotong budget.
- **Fresh tiap job run** — dideklarasikan lokal tepat sebelum loop gate masing-masing, jadi
  otomatis mulai dari 0 tiap kali `execute()` dipanggil. Tidak ada logic reset eksplisit karena
  memang tidak perlu — scoping-nya sendiri yang menjamin ini.
- **Tidak terhubung ke Level 1** — retry internal PIV di Frontend Agent sudah selesai (proses
  terpisah) sebelum Level 2 bahkan mulai; tidak ada shared budget antar level.

**Retry Reviewer tidak me-re-run QA** — kalau Reviewer minta perubahan, Frontend Agent revisi
kode, tapi pipeline langsung lanjut ke Reviewer lagi, bukan balik ke QA gate.

**Kalau retry gate sudah habis (1x terpakai) dan masih gagal:**
- Post comment ke Linear (ringkasan kegagalan)
- `return` — **bukan** `throw`
- Pipeline berhenti bersih, tidak lanjut ke gate berikutnya, tidak commit/push/PR

## Level 3 — Retry Job/Queue (BullMQ)

`attempts: 3` di level job BullMQ. **Hanya untuk kegagalan infra** (exception/crash beneran yang
membuat `execute()` throw — network timeout, proses Claude Code crash, dll), ditangkap oleh
try/catch di `execute()`.

**Tidak ikut ke-trigger saat gate exhausted** — karena Level 2 exit dengan `return`, bukan `throw`,
BullMQ tidak melihat ini sebagai job failure. Ini keputusan desain sengaja: kegagalan kualitas
(gate habis) punya jalur eskalasi sendiri (comment + stop), tidak boleh memicu restart seluruh
pipeline dari awal.

## Ringkasan Alur Kegagalan

```
Frontend Agent gagal verify 3x internal
  → verify-report.md: NEEDS_HUMAN
  → orchestrator baca status, stop (comment ke Linear)

QA gate FAIL, retry 1x ke Frontend, masih FAIL
  → comment ke Linear, return (clean stop)
  → job dianggap selesai (bukan failed) — BullMQ TIDAK retry

Reviewer gate CHANGES_REQUESTED, retry 1x ke Frontend, masih CHANGES_REQUESTED
  → comment ke Linear, return (clean stop)
  → job dianggap selesai (bukan failed) — BullMQ TIDAK retry

Exception/crash beneran (network, proses crash, dll) di execute()
  → throw, caught, job marked failed
  → BullMQ retry otomatis, max 3 attempts
```

## Catatan untuk Project Lain (website-cms-v2 / caf-orchestrator-cms)

Kalau mengadaptasi pola ini ke Jira+GitLab, pastikan **prinsip yang sama** dipertahankan meski
implementasi tracker beda:
- Counter retry per-gate tetap independen dan lokal, jangan share budget
- Gate-exhausted tetap `return` bersih + notifikasi (Telegram, di kasus website-cms-v2), bukan
  `throw` yang memicu BullMQ retry
- Kalau ada gate tambahan di masa depan (mis. Security Gate), ikuti pola yang sama: constant
  limit sendiri, counter lokal sendiri, exit path sendiri
  