# Crypto Tracker

Telegram bot native untuk watchlist wallet/koin, portfolio, alert dan analisis risiko koin. Analisis angka deterministik; model Nous Hermes pada MacBook opsional. Paper ledger, kuotasi dan executor signing terisolasi tersedia di kode lokal. **Live OFF secara default**, tanpa transaksi riil, setup host atau deployment otomatis.

> **Delivery CORE lolos gate lokal pada putaran7/7 yang diratifikasi pengguna.** Probe IPv4 dan lock proses telah diuji; review agregat final `correct`. Checkpoint Plan A dan batas operasi: [EXECUTION_PLAN.md §16](./EXECUTION_PLAN.md#16-eksekusi-plan-a--checkpoint-dan-integrasi-git). CI GitHub, staging dan produksi belum aktif/terverifikasi; hasil lokal bukan izin publikasi atau rilis.

Standar pribadi profil Mac: `/Users/rendgra/DEVELOPMENT/general/WORKFLOW_7_LEVELS.md`, dimuat lewat instruksi global pada mesin pengembang, bukan dependency aplikasi/clone/CI. [BOT_WORKFLOW.md](./BOT_WORKFLOW.md) memiliki SOP proyek. [HERMES_BOT_ARCHITECTURE.md](./HERMES_BOT_ARCHITECTURE.md) memuat arsitektur, kontrak analisis, setup Mac/tunnel, database dan gate rollout. [EXECUTION_PLAN.md](./EXECUTION_PLAN.md) memiliki urutan task, operasi dan bukti eksekusi terkini. [BOT_ARCHITECTURE_AND_PLAN.md](./BOT_ARCHITECTURE_AND_PLAN.md) adalah catatan awal historis, bukan janji implementasi atau performa.

## Runtime dan struktur

- Node.js **24+** dengan modul bawaan `node:sqlite`, npm dan root `package-lock.json`.
- `frontend/scripts/bot.ts`: worker native, polling/webhook, loopback HTTP3005. Tidak memuat Next/React untuk bot.
- `frontend/scripts/trader.ts`: proses executor terpisah; konfigurasi/key bukan milik bot atau Mac. `--reconcile-only` membaca status signed transaction tanpa signing/broadcast.
- `frontend/scripts/paper-replay.ts`: CLI replay sintetis offline, split waktu/token dan horizon 1h/6h/24h.
- `frontend/app/lib`: collector, cache/batch, scanner, auth, durable queue dan command Telegram.
- `frontend/app/api`: handler bersama native HTTP dan dashboard; semua API harus melalui auth.
- `frontend/app/page.tsx`: dashboard Next.js opsional, dipertahankan selama gate paritas belum lengkap.
- `supabase/migrations`: migrasi tambahan yang harus ditinjau/aplikasikan secara sengaja, bukan startup otomatis.
- `scripts/hermes`: Modelfile dan launcher/tunnel Mac session-only; tidak install atau mengubah host otomatis.
- `scripts/crypto-bot.service`: contoh service terisolasi untuk review operator, belum dipasang.

Backend seed statis beserta manifest/lockfile dan konfigurasi terkait dihapus setelah smoke watchlist dinamis lulus. Supabase penyimpanan existing dipertahankan; tidak membuat seed watchlist saat startup.

## Setup lokal

1. `npm ci` dari root.
2. Jika belum ada, salin `frontend/.env.example` ke `frontend/.env.local` dan isi sendiri tanpa commit secret. Jangan overwrite file yang sudah ada; verifikasi target database dan bot uji sebelum menjalankannya.
3. Pilih database uji terisolasi. Tinjau **tujuh** migrasi dan compatibility tabel existing; urutan/preflight serta generator bundle ada di [EXECUTION_PLAN.md](./EXECUTION_PLAN.md). Jangan menjalankan migrasi production tanpa izin.
4. Isi owner user ID **dan** chat allowlist. `TELEGRAM_CHAT_ID` ialah tujuan alert, bukan bukti identitas pemilik. `BOT_API_TOKEN` minimal32 karakter untuk akses API/dashboard.
5. Jalankan:

```sh
npm run local
```

Windows juga dapat memakai `local-tracker.bat`. Tidak menyalakan Docker/browser atau install dependency otomatis. HTTP native bind127.0.0.1:3005. `/health` mengecek kesiapan penyimpanan; API lain memerlukan token. Default polling menolak berjalan bila Telegram masih mempunyai webhook aktif, tidak mengubahnya otomatis.

Pada macOS/Linux, `./local` dan `npm run local` memakai satu controller native milik proyek. Launcher menemukan root dari lokasinya sendiri, bukan cwd pemanggil. Pilihan eksplisit: `./local --env-file /path/ke/env-uji --port 3005`. Argumen/port tidak valid dan listener asing ditolak; Ctrl+C/SIGTERM menghentikan child miliknya. Tidak memulai dashboard atau trader, mengubah konfigurasi, maupun mengaplikasikan migrasi. `bot:start` tetap tersedia sebagai entrypoint native langsung untuk operator yang mengelola lifetime sendiri.

Dashboard opsional: `npm run dev:frontend`, buka localhost3000 dan gunakan Basic Auth username `owner`, password `BOT_API_TOKEN`; origin harus terdaftar di `BOT_ALLOWED_ORIGINS`. Jangan expose HTTPBasic tanpa TLS. Compose tetap opsional untuk dashboard saja, loopback3000; bukan proses worker bot.

## Command

Gunakan `/help` atau `/menu`. Contoh:

```text
/analyze solana <mint>
/analyze base <contract>
/watchlist
/addwallet solana <wallet> Label Target
/renamewallet solana <wallet> Label Baru
/pinwallet solana <wallet> on
/delwallet solana <wallet>
/coins
/addcoin solana <mint> Nama Koin
/portfolio solana <wallet> 1
/holders solana <mint>
/history solana <wallet> <mint>
/trades solana <mint>
/indicators solana <mint>
/whitelist
/allow solana <mint> Label
/blacklist
/block solana <mint> Label
/settings
/set ENABLE_COIN_SCANNER true
/scan
```

Baca `/help` untuk pasangan rename/pin/delete coin, unblock/unallow dan pagination. Penghapusan memakai tombol konfirmasi terikat actor/chat dan masa berlaku. Alamat EVM harus menyebut chain; Solana tidak di-lowercase. Paste alamat mentah meminta pilihan wallet/token bila ambigu.

## Analisis dan batas

- Harga, likuiditas, supply, holder per sumber, konflik sumber, otoritas dan sample konsentrasi non-pool dihitung kode. Data hilang berarti UNKNOWN, bukan nol atau aman.
- RugCheck network bukan bukti pemilik insider dan **bukan data Bubblemaps aktual**. Laporan menyertakan tautan peta dengan batas tersebut.
- Constant-product impact hanya ilustrasi pool kompatibel; bukan quote transaksi atau prediksi.
- Jupiter/Helius/Covalent/RPC dapat memerlukan key dan memiliki kuota. Tidak mengasumsikan gratis/tanpa batas.
- Hermes hanya memprioritaskan evidence allowlist. Tidak mengirim secrets/riwayat chat ke model. Tidak ada auto-cloud fallback.
- Whale swap scanner saat ini Solana; wallet EVM yang tidak tercakup diberi warning. Indikator memakai candle1h selesai dan baseline, tidak menganggap transfer sebagai BUY/SELL.
- Outbox memberikan retry terbatas dan statusfailed; crash setelah Telegram menerima pesan masih dapat menyebabkan duplikasi. Tidak menjanjikan exactly-once.

## Paper, quote dan executor

`/paper open <chain> <token> <notionalUSD>` membuat posisi virtual. Isi biaya entry/exit dan slippage paper secara eksplisit. `/paper [1h|6h|24h]` membandingkan baseline dengan filter evidence Hermes; harga terlambat/hilang tidak masuk return. Ini bukan evaluasi profit model live atau rekomendasi beli.

`/quote <chain> <input|native> <output|native> <amountRaw> <maxUSD> <slippageBps>` memakai Jupiter V2 atau 0x V2. Jumlah adalah **unit raw integer**, bukan token UI. Quote immutable 30 detik; tombol konfirmasi terikat actor/chat/order/update. Konfirmasi bukan bukti eksekusi. `/trade`, `/trade kill`, `/trade reset` menampilkan order dan mengelola switch; reset tidak menghapus budget/reservasi.

```sh
npm run paper:replay -- test/fixtures/paper-replay.json
npm run trade:worker -- --once
```

Tanpa `frontend/.env.trader.local`, executor keluar dengan pesan OFF, tidak membuka key/DB. Contoh konfigurasi terpisah: `frontend/.env.trader.example`. Aktivasi dana memerlukan keputusan pemilik dan review rollout tersendiri. Batas uang sengaja kosong, bukan memakai angka contoh MD. Budget konservatif mereservasi seluruh notional+biaya sebagai potensi kerugian; bukan PnL aktual dan tidak direfund otomatis.

Money path membatasi native/token, legacy SPL Solana dengan ABI Jupiter yang ditinjau, serta EVM L1 yang fee-nya tercakup. Base/Optimism/Arbitrum tetap mendukung quote tetapi signing diblokir karena komponen L1/operator fee belum mempunyai hard bound yang disetujui. Tidak ada strategi entry/exit AI otonom yang ditebak dari ranking. Model tidak memegang key, menetapkan size atau mengubah policy.

Hermes `readonly_agent` ialah loop custom terbatas, **bukan** framework resmi NousResearch/hermes-agent. Framework resmi model-agnostic; tidak wajib memakai Nous Hermes. Prosedur Mac/tunnel dan batas migrasi framework ada di MD.

## Maintenance dan backup

Maintenance harian UTC dibatasi10batch, memakai lease dan `terminal_at`. Hanya job periodik aman yang dihapus; update/alert/pekerjaan berefek samping dipadatkan menjadi tombstone `pruned` tanpa payload agar dedupe tetap berlaku. Ledger dan cursor tidak dihapus. Tombstone/ledger tetap dapat tumbuh; tidak ada jaminan kuota selalu cukup.

```sh
npm run db:bundle -- /secure-work/crypto-staging-new.sql
npm run db:backup -- /secure-backups/crypto-YYYYMMDD.dump
```

Bundle tidak membuka koneksi DB. Backup opt-in membaca konfigurasi libpq (`PGSERVICE`/`PGPASSFILE` atau PG*) dan mempertahankan ACL; output baru di luar checkout. Archive **belum terenkripsi**: amankan sebelum disimpan/off-host. Tidak ada jadwal backup yang dipasang. Restore harus terisolasi dan melewati `supabase/operations/verify.sql`. Snapshot kapasitas: `supabase/operations/monitor.sql`. Detail prosedur dan batas bukti ada di runbook.

## Checks

```sh
npm run check
npm run test:all
npm run build:frontend
```

Typecheck menjalankan `next typegen` agar tipe route dashboard tersedia. Suite integrasi meluncurkan entrypoint bot asli sebagai subprocess dengan data sintetis dan fixture HTTP lokal, tanpa Telegram/DB production. Fixture bukan pengujian PostgreSQL locking/migrasi riil atau benchmark Mac/VPS. Hasil yang dijalankan dicatat pada laporan task, bukan dianggap bukti kesiapan production.

`test:all` menjalankan suite frontend dan kontrak script root masing-masing sekali; jangan menambah `test:frontend` untuk scope/revisi yang sama. Satu workflow delivery memakai gate yang sama. Kontrak branch, artefak/revisi, profil deployment, prasyarat aktivasi serta bukti task terkini: [EXECUTION_PLAN.md](./EXECUTION_PLAN.md). File workflow lokal bukan bukti CI/staging sudah aktif.

## Operasi terpisah

Tidak ada auto-commit/push/PR/merge/deploy. Rotasi credential terekspos, instalasi Ollama/SSH/Tailscale, registrasi webhook, perubahan Caddy/firewall, penerapan SQL remote dan aktivasi service memerlukan operasi yang disetujui. Jangan menempatkan key/signers game Gomoku dalam environment bot.

Lisensi: ISC.
