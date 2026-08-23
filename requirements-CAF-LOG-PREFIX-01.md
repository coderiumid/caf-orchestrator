## Ticket: CAF-LOG-PREFIX-01 (internal, pra-tracker)
## Status: CLOSED — NO-OP (root cause udah ke-fix di commit cf1b6e0 sebelum ticket ini
## dikerjakan; diverifikasi via real-run, log "X agent run result" konsisten caf-* buat
## semua role yang jalan. Bonus finding — cabang reviewer di buildQualityGateWarning()
## kelewat prefix — di-fix satu baris, verifikasi manual OK.)

## Latar Belakang

Ditemukan saat dry-run `GAN-60` (Checkpoint 5): log `caf-orchestrator` nampilin
`"qa agent run result"` / `"reviewer agent run result"` / `"documentation agent run
result"` — TANPA prefix `caf-`, beda dari `"caf-frontend agent run result"` /
`"caf-backend agent run result"` yang eksplisit pakai prefix. Diverifikasi hampir pasti
cuma kosmetik (kalau nama yang dikirim ke `--agent` beneran salah, itu bakal crash persis
kayak insiden Planner sebelumnya — pipeline `GAN-60` jalan sampai selesai tanpa error buat
3 agent ini, itu bukti tidak langsung kuat).

## Scope

**In scope:** cari titik yang generate string log `"X agent run result"`, pastikan
konsisten pakai nama yang sama kayak yang dikirim ke `--agent` (harusnya `caf-qa`,
`caf-reviewer`, `caf-documentation`).

**Eksplisit di luar scope:** JANGAN sentuh logic spawn (`agentName` yang dikirim ke
`--agent`) — itu udah benar dan udah divalidasi via fake-binary test di hotfix
sebelumnya. Ini murni soal string buat log, bukan soal fungsi.

## Acceptance Criteria

### AC1 — Investigasi dulu
- [ ] Temukan titik kode persis yang generate string `"X agent run result"` — konfirmasi
      apakah ada variabel/label terpisah dari `agentName` yang dipakai buat spawn, atau
      ternyata sumbernya sama tapi ke-strip prefix di tempat lain
- [ ] Konfirmasi: apakah masalah ini cuma di 3 titik (qa/reviewer/documentation) atau ada
      titik lain yang belum kelihatan dari 1 log yang kita punya (misal auditor/pm/
      ux-designer kalau nanti mereka jalan — gak akan ketauan dari log `GAN-60` karena
      role itu gak pernah dipanggil di pipeline itu)

### AC2 — Fix
- [ ] String log konsisten pakai nama `caf-<nama>` yang sama persis kayak yang dikirim
      ke `--agent`, buat SEMUA role (bukan cuma yang kelihatan salah di 1 log kemarin)

### AC3 — Verifikasi
- [ ] Test fungsional: trigger 1x run (bisa scratch/simulasi, gak perlu ticket nyata lagi)
      yang nyentuh minimal `qa`/`reviewer`/`documentation`, konfirmasi log sekarang
      konsisten `caf-*` semua

## Non-negotiable constraints
- JANGAN ubah `agentName` yang dikirim ke `--agent` — itu di luar scope, udah benar
- Verifikasi harus liat log real output, bukan cuma baca kode dan bilang "kelihatannya benar"