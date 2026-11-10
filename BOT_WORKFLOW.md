# Penerapan standar AI pada crypto-tracker

Runtime bot native, analisis deterministik, loop Hermes read-only custom, paper ledger, quote dan executor terpisah tersedia; live/auto default OFF. Bukti SQL/restore dan 136 tes pada bagian verifikasi adalah historis. Eksekusi lanjutan Mac, launcher, CI/delivery, model dan batas operasi remote dicatat per revisi pada [EXECUTION_PLAN.md](./EXECUTION_PLAN.md); jangan menganggap artefak lokal sebagai aktivasi GitHub, Telegram atau database produk. Arsitektur: [HERMES_BOT_ARCHITECTURE.md](./HERMES_BOT_ARCHITECTURE.md).

## Pemilik standar

Standar lintas proyek pada profil Mac ini berada di `/Users/rendgra/DEVELOPMENT/general/WORKFLOW_7_LEVELS.md` dan dimuat oleh instruksi global OMP. Dokumen ini hanya adapter dan acceptance plan khusus bot, bukan salinan SOP umum.

Lokasi general adalah konfigurasi pribadi lokal, bukan dependency runtime bot dan bukan file yang otomatis tersedia di GitHub/CI. Clone di mesin lain memerlukan instruksi yang disetujui pemilik pada environment tersebut. Jangan membuat import ke path lokal ini sebagai prasyarat build/deploy aplikasi.

Migrasi legacy yang dipilih adalah feature/fix/chore → `local` → `main`. Bootstrap awal memakai ref lokal tanpa upstream, mempertahankan perubahan pengguna dan tidak mempublikasikan atau commit otomatis. Status branch remote/proteksi/required checks harus dilihat pada bukti task; jangan mengasumsikan `origin/local` atau `origin/development` sudah tersedia. Command kanonis berasal dari konfigurasi global, bukan salinan prompt `.agents/commands` proyek.

[Rancangan arsitektur awal](./BOT_ARCHITECTURE_AND_PLAN.md) dipertahankan sebagai catatan historis. Jika bertentangan, keputusan evaluasi ulang di dokumen ini menggantikan klaim awal yang belum terbukti. SOP umum mengatur izin operasi; dokumen ini tidak mengizinkan push, merge, deploy, rotasi secret di provider atau transaksi uang riil.

## 1. Koreksi klaim dan batas bukti

- Scanner, pemanggil DexScreener, RugCheck dan notifier merupakan service deterministik, bukan otomatis empat agen AI. Alert berkala bukan bukti self-healing Level 6.
- Tidak ada benchmark untuk akurasi 85%/90%, penghematan kredit 99%, respons di bawah 50 ms, atau jumlah pasti paket yang akan hilang. Jangan memakai angka tersebut sebagai janji.
- Kode insert tracked_coins yang dibaca tidak mengisi RSI/volume. Scanner membutuhkan sumber nilai tersebut; skema DB production dan penulis eksternal belum diperiksa, sehingga klaim scanner pasti 100% mati tidak terbukti.
- Latensi query bertingkat adalah risiko nyata, tetapi batas lebih dari lima wallet pasti timeout belum diukur.
- Vercel tidak selalu memiliki timeout 10 detik. Dokumentasi Fluid compute yang ditinjau mencantumkan Hobby 300 detik; konfigurasi deployment aktual belum diperiksa.
- Public RPC memiliki limit dan belum tentu lebih cepat/andal dari provider ber-key. Memisahkan fee payer atau memakai AI tidak menghilangkan biaya jaringan.
- Data transaksi publik bukan dataset eksklusif. Kurasi/feedback dapat bernilai, tetapi model tidak dijanjikan akurat atau menguntungkan.

## 2. Prioritas fungsi dan security sebelum AI produk

1. Rotasi/nonaktifkan kredensial yang pernah terekspos. Menghapus string tidak membatalkan key atau membersihkan sejarah Git; validitas key tidak diuji dengan mengonsumsinya.
2. Otorisasi pemilik memakai `message.from.id` atau `callback_query.from.id` serta konteks chat yang diizinkan. ID chat grup bukan identitas pengguna. Pisahkan user allowlist dari chat tujuan notifikasi.
3. Validasi webhook secret, payload/ukuran, update_id, callback ownership/expiry dan konfirmasi tindakan destruktif. Escape HTML pada label/nama token dan validasi URL.
4. Migrasikan kemampuan UI sebelum dihapus: portfolio/holdings, wallet CRUD/rename/pin, koin CRUD/pin/search, history/trades/holders, indikator, blacklist/whitelist dan settings. Buat matriks parity sesuai kode aktual; perubahan/perampingan fitur memerlukan keputusan eksplisit, bukan asumsi tidak dipakai.
5. Hilangkan seed wallet statis setelah watchlist dinamis terbukti. Jangan diam-diam menambahkan target hardcoded ke DB pengguna saat startup.
6. Gunakan identitas chain + tx hash/signature + event index + wallet + jenis alert sesuai semantik. Hash transaksi saja dapat menelan beberapa event sah; unique constraint/claim harus atomik.
7. Catat event secara durable sebelum mengakui penerimaan webhook; enrichment dan send memakai outbox persisten, timeout, retry terbatas dan penanganan 429. Jangan menghitung send sebagai berhasil bila Telegram menolak.
8. Transfer masuk/keluar tidak selalu BUY/SELL; bisa airdrop atau internal transfer. Gunakan bukti swap/perubahan saldo dan tampilkan UNKNOWN bila tidak cukup bukti.
9. Harga hilang berarti unknown, bukan nol. Saldo native USD bukan nilai seluruh portfolio. Estimasi historis dari harga saat ini harus dilabel estimasi.
10. Scanner RSI/volume menggunakan sumber live, timeframe eksplisit, baseline surge, cooldown/threshold crossing. Nilai volume harian besar saja bukan lonjakan.
11. Solana Base58 case-sensitive: jangan lowercase address. EVM address di chain berbeda tetap aset/identitas berbeda.
12. Samakan perintah bantuan dengan fitur yang benar-benar tersedia; bedakan wallet address dan token contract, minta pilihan saat ambigu. Jangan menjanjikan hasil RugCheck/GoPlus sebagai jaminan token aman.

## 3. Pilihan teknologi yang belum mengikat

Default migrasi pertama: pertahankan penyimpanan yang ada dan pindahkan kemampuan ke bot bertahap. Pilih hosting berdasarkan kebutuhan terukur, bukan kewajiban standar umum.

- Worker cocok untuk HTTPS webhook; pekerjaan penting yang tahan restart memerlukan penyimpanan durable/antrean. `ctx.waitUntil()` HTTP hanya melanjutkan sampai 30 detik setelah respons/disconnect, bukan daemon tak terbatas.
- Queues menyediakan at-least-once delivery; deduplikasi tetap wajib. Crash setelah Telegram menerima send tetapi sebelum pencatatan sukses masih berpotensi duplikat. Jangan menjanjikan exactly-once end-to-end.
- KV eventually consistent; bukan sumber kebenaran lock/deduplikasi atomik atau perubahan otorisasi yang harus langsung berlaku.
- Cron berbasis menit tidak memenuhi polling setiap 20 detik. Untuk sub-menit/daemon, pertimbangkan Node.js/Bun service yang sesuai dependency setelah kebutuhan nyata dipastikan.
- D1 bukan prasyarat migrasi hosting. Skema, indeks, ekspor/impor, integrity check dan rollback wajib dibuktikan sebelum DB diganti.
- Helius webhook harus dicek pada paket/akun aktual. Ukur latency, missing event, kredit dan rekonsiliasi; tidak diasumsikan gratis atau hemat 99%.
- Mengganti Moralis dengan eth_getBalance hanya menggantikan pembacaan saldo native, bukan histori/holdings/enrichment. Menghapus Metaplex fallback bisa mengurangi cakupan token tanpa pool; ukur coverage sebelum diganti DexScreener/DAS.
- Coding agent yang memerlukan shell/Git berjalan terpisah pada sandbox/runner; tidak dipaksa menjadi Worker HTTP dan tidak menerima secret bot production.

## 4. Contoh tujuh level pada bot

| Level | Contoh | Bukti penerimaan |
| --- | --- | --- |
| 1 | Konsultasi parsing/kontrak API | Sumber dan asumsi jelas |
| 2 | Kontrak DB/event, task, scope dan aturan pemilik | Agen menemukan cara run/check tanpa menebak |
| 3 | Command kelola wallet/koin end-to-end | Pemilik berhasil CRUD; nonpemilik ditolak; state bertahan restart |
| 4 | Implementasi + review keamanan oleh agen terpisah | Handoff eksplisit, integrasi dan smoke oleh owner |
| 5 | Replay dan optimasi filter alert | Precision DAN recall dibanding baseline pada holdout |
| 6 | Insiden provider memicu diagnosis dan patch | Fixture reproduksi, patch, checks/staging, persetujuan remote terpisah dan rollback drill |
| 7 | Feedback alert dan dataset berversi memperbaiki aturan/prompt | Kandidat mengalahkan baseline; jika tidak, baseline dipertahankan |

Bukan semua event harus melalui LLM. Bot tetap berfungsi ketika model AI mati. Saldo, autentikasi, deduplikasi dan invariant tetap deterministik.

Untuk eksperimen finansial: gunakan replay/paper evaluation, bukan uang riil. Pisahkan data berdasarkan waktu serta kelompok token/wallet; cegah leakage dan bias token yang masih hidup. Catat harga hilang/token mati, fee/slippage bila membahas profit. PnL 24 jam bukan label keamanan. Tidak mengirim riwayat wallet/chat pribadi ke training secara default.

## 5. Roadmap dan gate

| Tahap | Deliverable | Gate |
| --- | --- | --- |
| A | Inventaris fitur, kontrak, SOP dan baseline bot | Entry point/smoke nyata, secret tidak bocor, aturan akses jelas |
| B | Bot-first security dan feature parity | Seluruh fitur dipertahankan atau penghapusannya disetujui; baru hapus UI/API obsolete |
| C | Runtime tahan gagal | Replay duplikat, restart, 429, provider timeout dan concurrency tidak merusak state |
| D | Workflow agen + CI sesuai kebutuhan | Patch lokal/PR sesuai izin, review terpisah dan bukti runtime |
| E | Eksperimen dan incident remediation | Holdout, budget, staging dan rollback drill; tanpa auto-merge/deploy |
| F | Pembelajaran dari data yang diizinkan | Label dan provenance, versioning, evaluasi independen dan rollback |

Metrik yang dikumpulkan secukupnya: p95 command/alert latency, loss/duplicate rate pada replay berlabel, provider error/API usage, biaya per tugas/alert, precision/recall dan change failure rate. Target baru ditetapkan setelah baseline.

## 6. Status verifikasi

Dokumentasi bukan bukti deployment, audit DB production, benchmark atau training. Task retensi menjalankan136/136 test, typecheck dan production build; subprocess bot menguji maintenance retry/restart. PostgreSQL17 temporer nyata menerapkan tujuh migrasi dan reapply, retensi/fencing/confirmation/dedupe, preservasi ledger/cursor dan gate privilege. Backup/restore sintetis mencocokkan isi12tabel dan ACL; bukan recovery database produk. Hasil SQL/concurrency task trading sebelumnya bersifat historis, bukan pengujian ulang task ini. Telegram/provider live, kapasitas VPS, Mac model/tunnel, kualitas AI, backup produk dan monitoring7hari tetap memerlukan bukti terpisah. Setup host dan operasi remote tetap memerlukan izin tersendiri.

## 7. Rujukan teknis

- [Vercel Functions limits](https://vercel.com/docs/functions/limitations)
- [Cloudflare waitUntil](https://developers.cloudflare.com/workers/runtime-apis/context/)
- [Queues delivery](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
- [KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/)
- [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Telegram webhook](https://core.telegram.org/bots/api/methods/setWebhook)
