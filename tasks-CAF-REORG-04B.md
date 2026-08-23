## Ticket: CAF-REORG-04B
## Pola Kerja: PIV, retry max 3x per task verify

---

### PLAN

1. **Grep menyeluruh** untuk `frontend`/`backend` (case-sensitive dan tidak) di seluruh
   codebase `caf-orchestrator` — termasuk file config (`caf.config.yaml` contoh/default kalau
   ada di repo ini), bukan cuma `.ts`/`.js`. Kelompokkan hasil: (a) nama agent/role asli yang
   perlu diupdate, (b) kata umum/domain ("frontend module", dst) yang tidak perlu disentuh.

2. **Konfirmasi lokasi titik 1 (spawn convention)** — baca `agents.js` (atau file lain hasil
   Langkah 1) secara penuh, pastikan persis baris mana yang hardcode nama role.

3. **Temukan lokasi titik 2 (skip-directive parsing)** — belum diketahui filenya. Cari logic
   yang membaca `tasks.md` dan mem-parsing token skip. Kemungkinan di area yang sama dengan
   retry/gate logic (`run-agent-pipeline.use-case.ts` disebut di konteks lain sebagai tempat
   logic retry gate — cek di sana dulu, tapi jangan asumsikan tanpa verifikasi).

4. **Cek `caf.config.yaml`** (contoh/default di repo `caf-orchestrator`, ATAU cek langsung
   dari deskripsi kalau ada referensi ke `umkm-pos/caf.config.yaml` yang bisa diakses) —
   apakah ada `agents.modelOverrides` dengan key `frontend`/`backend`.

5. **STOP, laporkan hasil audit lengkap** sebelum implement apapun. Termasuk: apakah ada
   titik ketiga/keempat yang belum diketahui, dan apakah ada ambiguitas desain (misal:
   apakah spawn logic harus dual-support nama lama+baru untuk backward compat, atau langsung
   full-cutover).

---

### IMPLEMENT (setelah PLAN dikonfirmasi)

6. Update titik 1 (spawn) sesuai keputusan yang dikonfirmasi
7. Update titik 2 (skip-directive parsing) sesuai keputusan yang dikonfirmasi
8. Update titik lain hasil audit (kalau ada)
9. Kalau `caf.config.yaml` di `umkm-pos` perlu diupdate — JANGAN edit dari sesi ini, cukup
   catat sebagai temuan untuk addendum 04A terpisah

---

### VERIFY

10. Test spawn fungsional — invoke logic spawn dengan `caf-frontend`/`caf-backend`, pastikan
    proses child benar-benar terpanggil dengan argumen yang benar (bukan cuma baca kode dan
    bilang "kelihatannya benar")
11. Test skip-directive fungsional — `tasks.md` dummy dengan token baru, pastikan parsing
    benar-benar meng-skip agent yang dimaksud
12. Regression check — pastikan role lain (planner, architect, qa, dst — yang TIDAK
    hardcoded, dibaca dinamis) tidak ikut kena dampak perubahan ini

Retry max 3x per item verify gagal. Kalau spawn test gagal setelah 3x → STOP, NEEDS_HUMAN,
ini bug yang bisa langsung mematikan pipeline produksi kalau ter-deploy.

---

### Eksplisit TIDAK termasuk checkpoint ini
- `caf-orchestrator-cms`
- Perubahan langsung ke `umkm-pos` (termasuk `caf.config.yaml`-nya)
- Dry-run ticket nyata end-to-end