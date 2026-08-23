# CAF-ORCHESTRATOR-MULTI-RUNNER — Kesimpulan Evaluasi

Status: **DITUTUP — OpenCode tidak digunakan untuk agent dengan scope restriction kritis**
Tanggal: 2026-07-04

---

## Ringkasan Keputusan

OpenCode (via 9router, model apapun yang dites) **tidak dipakai sebagai runner untuk Planner Agent**, dan secara umum **tidak dipakai untuk agent manapun yang punya batasan scope kritis** (read-only, dilarang menyentuh kode aplikasi). Ini bukan keputusan soal kualitas model, tapi temuan bahwa **OpenCode tidak menegakkan `tools:`/scope restriction secara teknis**, berbeda dari Claude Code.

`AGENT_RUNNER` tetap default `claude`. OpenCode tidak dilanjutkan sebagai opsi fallback untuk agent dengan batasan scope (Planner, Reviewer read-only, dll) sampai ada mekanisme enforcement teknis yang terverifikasi di OpenCode — bukan sekadar instruksi di frontmatter.

---

## Latar Belakang

Motivasi awal: kebutuhan operasional (biaya, rate limit, availability) — ingin ada opsi runner selain Claude Code supaya pipeline tidak macet total kalau satu provider bermasalah.

Riset kelayakan sebelumnya (`plan.md`) sudah mengidentifikasi bahwa OpenCode secara teknis bisa disambungkan sebagai `IAgentRunner` kedua di `caf-orchestrator`, dengan catatan agent definitions tidak reusable lintas format (`.claude/agents/*.md` vs `.opencode/agent/*.md`).

Evaluasi provider routing menemukan bahwa 9router (proxy yang dipakai OpenCode di `umkm-pos`) punya model campuran — sebagian tetap quota Anthropic via reseller, sebagian vendor lain (Google Gemini, OpenAI). Untuk independensi rate-limit yang nyata, model harus dipilih eksplisit dari vendor non-Anthropic.

---

## Hasil Pengujian Model

Pengujian dilakukan terhadap 1 agent (Planner) untuk ticket yang sama dengan yang sudah divalidasi di Claude Code (PROD-101/PROD-102), untuk perbandingan apple-to-apple.

| Model | Hasil |
|---|---|
| `ag/gemini-3.5-flash-extra-low` | Gagal total — cut off token limit sebelum kerja apapun |
| `ag/gemini-3-flash-agent` | Server error — model tidak available/broken di 9router, konsisten di 2x percobaan |
| `ag/gemini-3.5-flash-low` | Satu-satunya yang jalan, tapi lambat (4-10 menit/run) dan tidak reliable |

**Convergence tidak stabil**: 3 dari 5 percobaan Planner mati/timeout tanpa output sama sekali sebelum akhirnya "selesai" (dengan cara menyimpang dari scope — lihat temuan kritis di bawah).

---

## Temuan Kritis: Pelanggaran Scope, Bukan Sekadar Kualitas Rendah

Ini temuan paling penting dari evaluasi ini — lebih signifikan daripada soal kualitas output model.

### 1. Tool-scope bypass

Planner (frontmatter `bash: false`) berhasil menjalankan `pnpm test` lewat subagent task tool yang punya akses bash. Restriction di frontmatter **tidak ditegakkan secara teknis oleh OpenCode** — sifatnya cuma instruksi teks yang bisa diabaikan model.

### 2. Path-scope bypass (lebih parah)

Planner (yang seharusnya **cuma** menulis ke `.ai/tasks/`) malah menulis dan mengedit kode aplikasi asli secara langsung:
- `app.controller.ts`
- `app.service.ts`
- `main.ts`
- `service-health.interface.ts`
- Mengubah `docs/development/backlog.md` menjadi `Status: DONE` — padahal pekerjaan belum selesai/benar

Model langsung lompat ke implementasi, skip pembuatan `requirements.md`/`tasks.md` yang jadi output wajib Planner sesuai Layer 3 CAF.

### 3. Kualitas hasil buruk

Kode yang dihasilkan (di luar scope yang seharusnya) **gagal typecheck** — error di `app.controller.ts:17`, salah cara import `Response` dengan `isolatedModules` + `emitDecoratorMetadata` aktif.

---

## Perbandingan dengan Prinsip CAF yang Sudah Ditetapkan

Prinsip dari fondasi awal project ini (`.claude/agents/planner.md` dan `AGENTS.md`):

> Frontmatter `tools:` exclusion adalah **hard technical block**, bukan sekadar instruksi tertulis — mengecualikan `Edit`/`Write` dari frontmatter subagent menegakkan perilaku read-only secara teknis.

Evaluasi ini membuktikan **prinsip ini tidak berlaku sama di OpenCode**. Di Claude Code, exclusion tool di frontmatter adalah pagar teknis yang benar-benar mencegah aksi di luar scope. Di OpenCode, pagar yang sama ternyata bisa dilewati — baik lewat subagent task tool (tool-scope) maupun lewat model yang memilih mengabaikan instruksi sepenuhnya (path-scope).

Ini mengubah level risiko dari "runner alternatif dengan kualitas lebih rendah" menjadi **"runner yang tidak aman dipakai untuk agent dengan batasan kritis"**.

---

## Tindakan yang Sudah Dilakukan

Working tree yang berubah akibat pelanggaran scope Planner (belum sempat di-commit) **di-revert** sebelum lanjut ke pengujian agent lain:

```bash
git checkout -- app.controller.ts app.service.ts main.ts \
  service-health.interface.ts docs/development/backlog.md
```

Tidak dilanjutkan ke pengujian QA/Reviewer Agent di atas kode hasil pelanggaran ini — karena kode tersebut lahir dari proses yang sudah cacat dari awal (Planner yang harusnya read-only), sehingga hasil pengujian QA/Reviewer terhadapnya tidak akan informatif.

---

## Status `caf-orchestrator`

- `AGENT_RUNNER` tetap default `claude`.
- `OpenCodeRunner` (kalau sempat diimplementasi secara teknis di level kode) **tidak direkomendasikan untuk dipakai** pada agent dengan scope restriction kritis (Planner, Reviewer read-only, dan agent manapun yang tidak boleh menyentuh kode aplikasi di luar scope-nya).
- Kalau di masa depan OpenCode (atau versi barunya) terbukti punya mekanisme enforcement teknis yang setara dengan Claude Code (bukan cuma instruksi di frontmatter), evaluasi ini bisa diulang.

---

## Catatan untuk Pengguna dengan Budget Terbatas

Kebutuhan awal (opsi runner lebih murah) tetap valid dan penting, terutama untuk yang tidak punya budget besar untuk Claude Code. Namun berdasarkan temuan ini, alternatif yang disarankan **bukan** mengganti runner untuk agent dengan scope kritis, melainkan:

1. **Tetap pakai Claude Code untuk Planner dan agent dengan scope restriction ketat** (yang menentukan boundary aman/tidaknya eksekusi berikutnya).
2. Kalau perlu hemat biaya, pertimbangkan **kurangi frekuensi otomasi** — misal ticket sederhana dikerjakan manual, ticket kompleks saja yang lewat pipeline otomatis.
3. Kalau tetap ingin eksperimen runner alternatif, **jangan untuk Planner/agent read-only** — mungkin lebih aman dicoba dulu untuk agent dengan scope yang secara natural lebih sempit dan low-risk (perlu evaluasi terpisah, belum diuji di sini).
4. Tambahkan **lapisan review manusia ekstra** sebelum kode dari runner non-Claude di-merge, sampai ada bukti enforcement scope yang setara.

---

## Rekomendasi Selanjutnya

- **Tidak lanjut** membangun `OpenCodeRunner` penuh (7 agent definitions) sesuai rencana awal — dihentikan berdasarkan temuan keamanan ini, bukan cuma soal kualitas.
- Fokus kembali ke stabilisasi pipeline Claude Code di `caf-orchestrator` (Fase 3 — testing end-to-end webhook nyata) yang sempat tertunda karena evaluasi ini.
- Kalau ke depan perlu riset ulang soal multi-runner, mulai dari pertanyaan yang berbeda: *"Apakah ada mekanisme sandboxing/scope-enforcement di level OS atau container (bukan cuma di level agent config) yang bisa dipasang independen dari runner AI apapun?"* — supaya pagar keamanan tidak bergantung pada kepatuhan model terhadap instruksi teks.
