# Rencana melanjutkan crypto-tracker dan runbook operasi

> **Delivery CORE lolos gate lokal pada putaran7/7 yang diratifikasi pengguna.** Probe IPv4 dan pemulihan lock proses lulus; review agregat final `correct`. Checkpoint Plan A dan bootstrap `origin/local` ada di §16; histori kegagalan tetap dipertahankan. CI GitHub, staging, dan produksi nyata **BELUM AKTIF/TERVERIFIKASI**. Tidak ada izin putaran kedelapan otomatis, push fitur, PR, merge atau rilis.

Bukti implementasi terdahulu: **implementasi dan verifikasi lokal dilaporkan selesai; operasi remote belum dijalankan pada task tersebut**. F0 tidak dijalankan karena tidak ada perintah commit. F1–F2 mempunyai bukti historis; F3–F7 mempunyai artefak/prosedur dengan batas bukti di bawah. Ini bukan klaim pemeriksaan ulang atau deployment terkini. Kondisi yang benar-benar diperiksa saat melanjutkan ada di §0.

Pemilik arsitektur: [HERMES_BOT_ARCHITECTURE.md](./HERMES_BOT_ARCHITECTURE.md). SOP: [BOT_WORKFLOW.md](./BOT_WORKFLOW.md). Dokumen ini adalah pemilik urutan operasi, bukan SOP baru.

## 0. Checklist melanjutkan proyek di Mac

Snapshot perencanaan diperiksa **2026-11-08 UTC**, checkout `/Users/rendgra/DEVELOPMENT/crypto-tracker`, HEAD dasar `f6062db1701b`. Eksekusi lanjutan diminta setelah snapshot ini; hasil aktual, putaran gate dan batas remote dicatat di §11. Jangan menganggap semua checkbox atau issue sudah selesai/dibuat. Gunakan F3–F7 untuk prosedur operasi, bukan prosedur kedua.

### Kondisi awal yang terverifikasi

| Area | Kondisi saat pemeriksaan |
|---|---|
| Git | Branch aktif `main`; branch remote GitHub hanya `main`. Working tree awal mempunyai `.agents/` untracked; perubahan pengguna tidak dibuang. Penyuntingan runbook ini juga belum di-commit. |
| Antrean GitHub | Tidak ada PR atau issue terbuka pada saat pemeriksaan. Periksa ulang sebelum membuat branch/issue atau merge. |
| CI/CD | GitHub Actions melaporkan 0 workflow; `.github/workflows` belum ada di checkout. Staging otomatis belum tersedia, bukan otomatis aktif karena aturan global diperbarui. |
| Command OMP | Discovery proses baru menemukan 19 command: 14 user kanonis, bundled `init`, dan 4 alias proyek lama. `local`, `task`, `coder`, `tester`, `development` memakai file global terbaru. `pipeline`, `pipline`, `architech`, `deploy-prod` masih muncul dari `.agents/commands`. |
| Runtime lokal | Node `v24.19.0`; `dev`/`bot:start` menjalankan bot native, bukan dashboard. Root `./local` dan `scripts.local` belum ada. Dashboard opsional melalui `dev:frontend`. |
| Konfigurasi | `frontend/.env` dan `.env.local` ada. Nilai, tujuan database, validitas token dan status rotasi **tidak diperiksa**; keberadaan file bukan bukti konfigurasi aman/aktif. Jangan overwrite atau mencetak isinya. |
| Bukti baru | `npm run paper:replay -- test/fixtures/paper-replay.json` exit 0 pada Mac. Replay sintetis offline, bukan koneksi Supabase/Telegram atau bukti profit/kualitas model. |
| Batas pemeriksaan | Full suite, build, bot dengan credential, DB remote, Hermes, tunnel dan host deployment tidak dijalankan untuk penyusunan daftar ini. Angka 136/136 di bagian lain adalah bukti historis. |

### Urutan task dan kriteria selesai

Task berikut dikerjakan berurutan sesuai dependensi. Centang hanya setelah bukti aktual tersedia.

#### T0 — Tetapkan migrasi Git dan bereskan checkpoint

- [x] Pilih satu integrasi untuk migrasi legacy: `local`, dengan feature/fix/chore → `local` → `main`. Ref lokal kini mempunyai upstream `origin/local`; bukti bootstrap remote ada di §16.
- [x] Inventaris perubahan `.agents/` dan dokumen; arsip checkpoint privat dibuat sebelum perubahan. Branch kerja `chore/crypto-workflow` dibuat dari `local` pada SHA dasar yang sama; tanpa reset atau stash. Izin commit Plan A dan hasilnya dicatat di §16.
- [x] Setelah migrasi disetujui melalui Plan A, branch remote `local` dibuat via GitHub Git References API dari SHA `main` terverifikasi `f6062db1701b8712e4dabea3682cac68cd78927b`, di-fetch dan dijadikan upstream ref lokal. Kode fitur belum dipublikasikan; proteksi/required checks tetap operasi terpisah.
- [ ] Terapkan alur PR tanpa push langsung ke `main`; aktifkan required checks setelah nama job CI nyata tersedia pada T2. Selesaikan checkpoint sebelum memakai `/task`, karena command itu sengaja berhenti pada working tree kotor atau base integrasi ambigu.

**Selesai:** base integrasi tunggal dan SHA-nya jelas, perubahan pengguna terjaga, serta jalur bootstrap/proteksi terdokumentasi. Jangan memulai task fitur dari asumsi `origin/development` yang tidak ada.

#### T1 — Rapikan command proyek dan buat launcher `local`

**Prasyarat:** T0 dan branch task yang aman.

- [x] Tinjau `.agents/commands`; seluruh16salinan diklasifikasikan usang, tanpa customisasi lain yang perlu dipertahankan. Alias `pipeline`, `pipline`, `architech`, `deploy-prod` sudah hilang dari discovery aktual.
- [x] Buat root executable `./local` dan `scripts.local` sebagai alias ke satu controller. Default bot native saja; tidak memulai dashboard/trader, Docker, migrasi DB atau service global.
- [x] Buktikan root/cwd, readiness `/health` bot dengan penyimpanan uji sintetis, penolakan port asing dan cleanup child pada SIGINT/SIGTERM/startup gagal. Root launcher mode0755.

**Selesai:** `/local` di OMP, `./local`, dan `npm run local` menjalankan proyek yang benar; startup/stop nyata terbukti. Discovery tidak menghidupkan kembali alias lama. Jangan menjalankan bot sebelum target/credential uji pada T3 diverifikasi; sebelum itu uji launcher memakai environment sintetis terisolasi.

#### T2 — Baseline Mac dan satu gate CI

**Prasyarat:** T0–T1; instalasi dependency mengikuti root `package-lock.json`.

- [x] Baseline revisi working tree pada snapshot bebas secret: `npm ci`, `npm run check`, `npm run test:all`, `npm run build:frontend` exit0. Bukti dan batasnya di §11.
- [x] Buat satu workflow CI untuk PR serta perubahan `local`/`main`, Node24+, `npm ci` dan gate yang sama; parser/matriks routing lokal lulus tanpa credential bot/database/signer pada quality.
- [ ] Setelah job benar-benar muncul, pasang required checks/proteksi yang sesuai. Simpan hasil lokal dan hasil GitHub terpisah; file YAML saja bukan CI aktif.

**Hindari duplikasi:** `test:all` sekarang mencakup suite frontend dan kontrak script root. `test:frontend` akan mengulang subset; cukup satu `test:all`. Satu pemilik validasi per scope/revisi; jangan meminta tester kedua mengulang bukti identik.

**Selesai:** checks Mac dan run PR GitHub teramati lulus untuk SHA yang sama. Tidak ada deploy dari PR atau push/merge `main`.

#### T3 — Amankan konfigurasi dan aktifkan database uji (F3)

**Prasyarat:** target/organisasi/region dan izin operasi ditetapkan pemilik.

- [ ] Verifikasi credential lokal menunjuk **database dan bot uji**, bukan production. Rotasi/nonaktifkan key yang pernah terekspos melalui provider; jangan menguji key bocor dengan mengonsumsinya. Nilai secret tetap di luar Git/chat.
- [ ] Tinjau tujuh migrasi kanonikal, preflight identitas, RLS serta grant tabel/kolom/fungsi. Database existing perlu inventaris dan backup/restorability sebelum perubahan; jangan menghapus data agar gate lulus.
- [ ] Ikuti §4 untuk bundle/apply dengan izin eksplisit, lalu buktikan koneksi PostgREST dan akses role yang benar. Jangan menjalankan SQL remote hanya karena bundle berhasil dibuat.

**Selesai:** database uji nyata melewati gate privilege dan koneksi; pengguna tidak sah ditolak. Live/auto tetap OFF; signer tidak masuk environment bot/Mac.

#### T4 — Smoke Telegram nyata dan paritas fitur (F4)

**Prasyarat:** T3, bot/owner/chat uji dan provider yang disetujui.

- [ ] Jalankan bot melalui launcher T1; buktikan `/health`, owner/chat allowlist, penolakan akun asing dan konfirmasi penghapusan.
- [ ] Jalankan skenario §5: watchlist/CRUD, analisis, restart/dedupe, maintenance error/retry; catat hasil di Telegram nyata, bukan hanya fixture HTTP.
- [ ] Lengkapi matriks paritas portfolio, rename/pin, koin, pagination, history/trades/holders/indikator, blacklist/whitelist dan settings. Pertahankan dashboard/axios sampai gate paritas diterima; jangan menghapus UI karena bot sudah bisa `/start`.

**Selesai:** alur pengguna dan pemulihan benar-benar diamati tanpa dana riil. Satu token polling hanya dipakai satu consumer; jangan menjalankan bot developer dan staging memakai token yang sama.

#### T5 — Delivery staging otomatis dan produksi manual

**Prasyarat:** T2–T4 serta target/transport/akun deployment yang diotorisasi.

- [ ] Perluas workflow T2, bukan membuat pipeline kedua dengan quality gate duplikat: merge ke `local` → quality sukses → deploy staging.
- [ ] Staging memakai release directory/service, port, DB dan token bot terpisah dari workspace developer serta production; deploy SHA/artifact yang sudah lulus, bukan mutable branch saat job berjalan.
- [ ] Buktikan readiness, identitas revisi runtime, service tetap hidup setelah job berakhir, failed rollout dan rollback. Batasi akses environment/runner; jangan menjalankan kode PR tak dipercaya pada persistent runner Mac.
- [ ] Konfigurasi production dari `main` dengan dispatch manual `/deploy prod`. Push/merge `main` hanya CI. Jangan menyebut konfigurasi production sebagai izin deployment atau aktivasi trading.

**Selesai:** run staging otomatis nyata sukses dan aplikasi melayani revisi yang benar. Jika akses target/runner/secret belum tersedia, tandai **BELUM AKTIF**, bukan selesai. `/deploy local` hanya recovery, bukan langkah tambahan setelah staging sehat.

#### T6 — Backup produk uji, restore dan observasi (F5–F6)

**Prasyarat:** DB uji nyata; untuk observasi runtime, T5.

- [ ] Pilih penyimpanan terenkripsi, akses, retensi archive dan credential backup. Ikuti §6; archive CLI belum terenkripsi, jangan langsung mengunggahnya.
- [x] Restore dump sintetis terenkripsi/decrypted ke PostgreSQL drill terisolasi; isi/digest12tabel, ACL/RLS, kolom dan owner tepercaya cocok. Ini bukan backup produk atau jadwal mingguan aktif; tidak restore ke sumber atau menghapus ledger/tombstone.
- [ ] Mulai observasi tujuh hari sesuai §7: ukuran DB/tabel/index, job failed/pruned, maintenance, egress dan kapasitas host. Snapshot hari pertama bukan observasi tujuh hari selesai.

**Selesai:** backup/restore nyata terbukti dan laporan hari 1/hari 7 tersedia. Pemilihan retensi atau perubahan limit ekonomi memerlukan keputusan pemilik, bukan angka rekaan agen.

#### T7 — Hermes native di Mac dan evaluasi read-only (opsional)

**Prasyarat:** bot deterministik sudah berguna tanpa AI; izin instalasi/resource Mac. Tidak memblokir bot non-AI.

- [ ] Ikuti [arsitektur §6](./HERMES_BOT_ARCHITECTURE.md#6-setup-hermes-native-pada-macbook): check, serve, smoke, lalu ukur latency cold/warm, memory pressure/swap dan headroom saat Gomoku/runner aktif.
- [x] Pilih dan uji model3b native pada mesin nyata; tidak expose Ollama atau mengirim key/riwayat wallet. Tunnel VPS belum diperlukan untuk evaluasi lokal dan belum diaktifkan.
- [x] Evaluasi `finding_ids` terhadap baseline dengan kasus sintetis berlabel/family holdout terpisah; kualitas, schema, timeout dan batas klaim tercatat. Hasil bukan bukti AI lebih baik.

**Selesai:** smoke model dan evaluasi terukur tersedia, fallback deterministik tetap bekerja saat Mac offline. Tidak perlu memasang framework Hermes Agent resmi atau gateway Telegram kedua untuk menyelesaikan bot ini.

Setup/evaluasi lokal T7 lulus; bagian headroom pada beban Gomoku/runner nyata di atas tetap belum lengkap. Bukti workload idle tidak diganti menjadi benchmark beban berat. Kebutuhan tunnel dan host restricted tetap menunggu target/izin yang sesuai.

### Command pertama dan siklus kerja

Masuk ke root proyek, lalu buka sesi OMP:

```sh
cd /Users/rendgra/DEVELOPMENT/crypto-tracker
omp
```

**Mulai dengan rencana T0, bukan `/project` atau `/task` langsung:**

```text
/architect Baca EXECUTION_PLAN.md bagian 0. Rancang T0 saja: migrasi repo legacy main-only ke feature/local/main, checkpoint perubahan .agents dan dokumen, serta jalur bootstrap/proteksi yang aman. Jangan ubah file, branch, remote, secret atau host. Daftar pilihan yang benar-benar memerlukan keputusan pemilik.
```

Setelah T0 diterapkan dengan izin yang sesuai dan working tree/base aman, contoh untuk T1:

```text
/task rapikan-workflow-dan-launcher-local-crypto
/development Kerjakan T1 pada EXECUTION_PLAN.md saja di branch task aktif. Ikuti command global kanonis, pertahankan perubahan pengguna, gunakan satu gate coder-validasi-review maksimal tiga putaran. Jangan jalankan bot dengan credential production, migrasi remote, push, merge, deploy atau trader.
```

Jalankan kedua command itu **bergantian**, baca hasilnya sebelum langkah berikutnya. Ulangi pola per task, bukan membuka semua issue/branch sekaligus. `/development` sudah mencakup coder, pemilik validasi dan reviewer; tidak perlu menjalankan `/coder` → `/tester` → `/audit` lagi untuk scope/revisi identik. Jika gate belum lulus, perbaiki dalam counter yang sama atau laporkan **BELUM LOLOS**.

Setelah patch lulus dan pengguna menginstruksikan setiap langkah: `/push` → `/pr` → `/merge`. Sesudah T5 aktif, merge ke `local` mengamati CI/staging otomatis; jangan deploy dua kali. Promosi `/merge main` dan rilis `/deploy prod` tetap instruksi terpisah. Command yang ditulis dalam runbook ini bukan izin mengeksekusinya sekarang.

### Yang tidak menjadi task otomatis

- **Live/auto trading:** tetap OFF. Pilihan wallet, chain/route, nominal risiko, fee/finality, pin code dan izin uang riil memerlukan kontrak serta review finansial terpisah; tidak ada nominal contoh yang menjadi default.
- **Ekspansi fitur:** swap monitoring EVM dan integrasi data Bubblemaps aktual belum menjadi klaim dukungan saat ini. Buat task produk terpisah hanya bila dipilih; jangan menganggap transfer sebagai BUY atau network RugCheck sebagai data Bubblemaps.
- **Migrasi ulang stack/penghapusan UI:** jangan mengulang rancangan historis Cloudflare/D1 atau menghapus dashboard tanpa keputusan dan bukti paritas.

Saat task selesai, catat ID issue/branch, revisi, perintah + exit code, bukti runtime, verdict reviewer dan batas remote pada task terkait. Tidak ada implementasi, issue baru, push, merge, migrasi remote atau deployment yang dilakukan hanya untuk memperbarui dokumen ini.

## 1. Audit dan koreksi rancangan

| Temuan | Hasil eksekusi lokal / batas |
|---|---|
| Lima tabel produk tidak mempunyai bootstrap | Ditambahkan `20261106_base_schema.sql`; instalasi database kosong lulus. Existing tables hanya divalidasi keberadaan kolom; grant/policy tidak diubah diam-diam. Tipe, constraint dan data produk nyata tetap harus dicocokkan sebelum rollout. |
| `bot_jobs` dan konfirmasi tumbuh tanpa retensi | Ditambahkan maintenance harian dan RPC berbatas batch. Default scan300s menghasilkan288 job/hari; paper settle menambah1.440/hari **hanya bila paper aktif**, belum termasuk pengguna/alert. Tidak ada janji ukuran tetap selamanya. |
| Umur berdasarkan `created_at` tidak aman | Retensi sekarang memakai `terminal_at`, diisi saat masuk done/failed. Job yang dibuat lama tetapi baru selesai tetap dilindungi. Legacy terminal rows tanpa timestamp mulai dihitung saat migrasi, bukan langsung dihapus. |
| Penghapusan ID menghilangkan dedupe | Backfill tidak mempunyai batas umur30hari. Job berefek samping dipadatkan menjadi tombstone `pruned` dengan payload kosong; ID tetap ada dan replay tidak menjalankan efek samping lagi. |
| Konfirmasi kedaluwarsa dapat diperlukan retry | Konfirmasi expired >2hari tetap dilindungi bila update pending/running/failed. Setelah job pruned, ia tidak claimable lagi; intent expired boleh dibuang pada batch berikutnya. |
| Unique identity dapat bentrok dengan legacy aliases | `operations/preflight.sql` read-only menolak kelompok duplikat, tanpa mencetak alamat atau menghapus baris. Fixture alias eth/ethereum dengan EVM case berbeda terbukti ditolak. Solana tidak dilowercase. |
| Free tier bukan backup otomatis | Disiapkan CLI backup dan restore drill sintetis. Tidak ada backup produk atau scheduler mingguan yang dipasang. |
| Plan lama memakai `--no-privileges` | **Dihapus dari prosedur**: membuang ACL dapat membuka EXECUTE fungsi saat restore. Backup mempertahankan ACL; restore wajib memakai administrator tepercaya, menyiapkan role tujuan, dan melewati gate privilege sebelum aplikasi dihubungkan. |
| Kuota dan kapasitas belum diukur pada layanan nyata | Klaim chat “<30MB selamanya”, kuota pasti tidak habis, latency/RAM pasti dan bebas gangguan Gomoku tidak mempunyai benchmark. Estimasi lama bukan acceptance. Gunakan dashboard organisasi dan snapshot ukuran aktual. |
| Gate table privilege melewatkan column-only grant | `operations/verify.sql` memeriksa privilege tabel **dan kolom**, RLS serta EXECUTE fungsi. Column-only SELECT ke anon terbukti ditolak. Bootstrap tidak mencabut akses existing otomatis; gate mengharuskan keputusan pemilik. |
| Ledger finansial dan cursor | `paper_trades`, `trade_orders`, `trade_risk`, `trade_daily_risk`, `bot_state` tidak disentuh retensi. |
| Working tree sudah berubah sebelum task | Perubahan pengguna dipertahankan; tidak staging, reset, stash atau commit. |

Supabase: [pricing](https://supabase.com/pricing), [database/disk size dan fair use](https://supabase.com/docs/guides/platform/database-size). Free mencantumkan500MB database,5GB egress dan pause setelah1minggu inactivity; backup otomatis tidak termasuk. Periksa cakupan organisasi, project lain, periode billing dan kebijakan terbaru pada akun yang dipilih. Aktivitas bot bukan jaminan uptime atau bebas pause. Database size berbeda dari disk/WAL; DELETE tidak langsung mengecilkan file, autovacuum menyediakan reuse. Jangan menjadwalkan VACUUM FULL otomatis karena locking dan kebutuhan ruang tambahan.

## 2. Status semua fase

| Fase | Status | Bukti / prasyarat berikutnya |
|---|---|---|
| F0 checkpoint Git | Tidak dijalankan | Memerlukan perintah commit terpisah, bukan izin dari task lokal ini. Bukan dependency untuk pengujian lokal. |
| F1 base schema + retensi | Selesai lokal | Dua migrasi baru, pemrosesan bounded, scheduler UTC, tombstone dan trigger terminal. |
| F2 checks + smoke | Baseline Mac lulus; delivery gagal | Hasil terbaru dan identitas source ada di §11. Bukti baseline tidak mengesahkan delivery CORE yang masih gagal pada putaran3/3. |
| F3 Supabase uji | Gate SQL lokal lulus; remote belum terverifikasi | Migrasi, privilege dan restore PostgreSQL lokal telah direview. Target uji/otoritas migrasi dan koneksi PostgREST remote masih belum tersedia; file env saja bukan bukti izin. |
| F4 bot Telegram | Lima bug dashboard diperbaiki dan validasi terarah lulus; Telegram nyata belum terverifikasi | Bukti perbaikan UI ada di §13. Bot/owner/chat/actor uji khusus dan gate paritas masih diperlukan; hasil browser bukan bukti backend/Telegram remote. |
| F5 backup/restore | Drill terenkripsi lokal lulus; produk belum | Alur backup → age → decrypt → restore12tabel beserta privilege/kolom/owner telah direview. Lokasi, kustodi kunci, retensi dan scheduler backup produk belum tersedia. |
| F6 observasi7hari | Monitor lokal terbukti; pengamatan produk belum dimulai | Memerlukan runtime terdeploy yang sehat, izin target dan tujuh hari pengamatan nyata. Snapshot sintetis bukan pengganti. |
| F7 Mac Hermes/VPS | Native3b/evaluator lulus; kualitas model belum mengungguli baseline | Bukti Mac terkini ada di §11. Biner/model dipertahankan, service dihentikan; headroom beban Gomoku/runner berat dan tunnel restricted belum teruji. |

## 3. Kontrak retensi yang diimplementasikan

`20261111_bot_retention.sql` menambah terminal timestamp, status `pruned`, trigger dan indeks. `bot_cleanup_retention(p_id text,p_attempt integer,p_batch integer default5000)` mengambil advisory lock74111907 lalu memeriksa ID, attempt, kind maintenance, running dan lease aktif. Batch NULL/di luar1..10000 ditolak; maksimum total job yang diubah <=batch, maksimum konfirmasi yang dihapus <=batch.

| Data terminal | Umur sejak selesai | Aksi |
|---|---|---|
| Done kind scan + ID `scan:` | >14hari | Hapus job periodik |
| Done kind paper + ID `paper-settle:` | >14hari | Hapus job periodik |
| Done kind maintenance + ID `maintenance:` | >14hari | Hapus job periodik |
| Done kind update + ID `update:` | >14hari | `pruned`, payload `{}`, ID dipertahankan |
| Done lainnya termasuk alert/enrich/paper/manual-scan/test/ID tak dikenal | >30hari | `pruned`, payload `{}`, ID dipertahankan |
| Semua failed | >30hari | `pruned`, payload `{}`, ID dipertahankan |
| Pending/running | Berapa pun | Tidak disentuh |
| Konfirmasi expired | >2hari | Hapus hanya jika tidak melindungi job update pending/running/failed |

`pruned` tidak dapat diklaim ulang; jangan reset status atau menghapus tombstone secara manual untuk replay. Buat command baru yang ditinjau jika memang diperlukan. Retensi payload bukan penghapusan dari backup/WAL; tombstone dan ledger tetap tumbuh. Menghapus tombstone memerlukan kebijakan replay baru, bukan maintenance rutin.

Runner enqueue `maintenance:YYYY-MM-DD` sekali per hari UTC. DB dedupe melindungi restart. `processJob()` memproses maksimum10batch x5000, mengecek lease tiap batch dan berhenti ketika kedua kategori tidak penuh. Sisa backlog besar diteruskan pada jadwal berikutnya; job done bukan klaim semua histori telah habis dibersihkan. Error/lease hilang bukan sukses. Tidak ada pg_cron/dependency baru.

## 4. F3 — migrasi database uji

### Precondition

- Pilih project/organisasi dan region yang disetujui. Periksa pemakaian seluruh organisasi, bukan mengandalkan estimasi chat.
- Fresh project: gunakan bootstrap. Existing product: terlebih dahulu bandingkan metadata read-only berikut; jangan ALTER/DROP kolom atau mencabut policy agar gate terlihat lulus.

```sql
select table_name,column_name,data_type,is_nullable,column_default
from information_schema.columns
where table_schema='public'
  and table_name in ('watchlist','tracked_coins','blacklist_tokens','whitelist_tokens','app_settings')
order by table_name,ordinal_position;
```

### Bundle tunggal, tanpa duplikasi sumber

```sh
npm run db:bundle -- /secure-work/crypto-staging-new.sql
```

Direktori tujuan harus sudah ada; file harus baru. Generator tidak terkoneksi ke database dan menolak overwrite. File gabungan dibangun dari tujuh migrasi kanonikal dan dua gate berikut; bukan salinan SQL lain yang dipelihara manual.

| Urutan | Sumber |
|---|---|
|1|`20261106_base_schema.sql`|
|2|`20261107_bot_runtime.sql`|
|3|`20261107_whitelist_chain.sql`|
|4|`operations/preflight.sql`|
|5|`20261108_identity_constraints.sql`|
|6|`20261109_paper_trading.sql`|
|7|`20261110_trade_execution.sql`|
|8|`20261111_bot_retention.sql`|
|9|`operations/verify.sql`|

Setelah izin migrasi diberikan, operator dapat memakai SQL Editor atau `psql -X -v ON_ERROR_STOP=1 -f /secure-work/crypto-staging-new.sql` dengan koneksi uji terscope melalui libpq. `ON_ERROR_STOP` wajib untuk psql. Setiap migrasi bertransaksi sendiri: kegagalan gate dapat meninggalkan fase sebelumnya sudah committed; bukan rollback atomik seluruh bundle. Hentikan rollout jika error, jangan lanjutkan migrasi berikutnya di SQL Editor dan jangan menutup error dengan DROP/DELETE data pengguna. Periksa status aktual sebelum retry.

Acceptance: fresh schema tersedia, preflight/gate lulus, anon/authenticated tidak mempunyai akses tabel/kolom/fungsi bot. Key bot hanya server-side sesuai `.env.example`; jangan kirim credential ke chat atau model.

Recovery: hentikan bot/executor sebelum memulihkan data. Jangan menjadikan DROP tabel/project sebagai rollback produk. Maintenance dapat dihentikan dengan menghentikan worker; tidak dapat mengembalikan payload yang sudah dipadatkan. Gunakan backup yang telah dibuktikan dan operator review; jangan replay semua job setelah restore.

## 5. F4 — konfigurasi dan smoke Telegram uji

Gunakan [frontend/.env.example](./frontend/.env.example) sebagai pemilik variabel. Isi file lokal yang diabaikan Git, jangan memakai token produksi untuk smoke:

```env
SUPABASE_URL=
SUPABASE_KEY=
BOT_TRANSPORT=polling
BOT_API_TOKEN=
TELEGRAM_BOT_TOKEN=
TELEGRAM_ALLOWED_USER_IDS=
TELEGRAM_ALLOWED_CHAT_IDS=
TELEGRAM_CHAT_ID=
SCAN_INTERVAL_SECONDS=300
PAPER_ENABLED=false
HERMES_API_URL=
```

`BOT_API_TOKEN` acak minimal32karakter. `SUPABASE_KEY` server service-role project uji; bukan anon key. File signer tetap terpisah, live/auto OFF, tidak ada key di bot atau Mac. Aktifkan paper hanya setelah owner/chat/notional/fee/slippage paper diisi eksplisit. Bot tetap dapat menampilkan scorecard tanpa AI; itu bukan jaminan token aman.

```sh
npm run dev
```

Polling memeriksa webhook existing dan menolak berjalan bila masih terpasang; tidak mengubah transport otomatis. Jangan menjalankan konsumen polling lain dengan token yang sama. `/health` pada loopback3005 harus `ready:true`.

| Scenario owner di Telegram uji | Acceptance |
|---|---|
|`/start`, `/watchlist`|Bantuan dan data uji muncul|
|Akun/chat tidak diizinkan|Tidak dapat memutasi data|
|`/addwallet solana <alamat> Uji`|Baris tersimpan sekali|
|`/delwallet solana <alamat>`|Owner confirmation wajib; actor lain ditolak|
|`/analyze solana <mint>`|Scorecard + status AI faktual, bukan halusinasi angka|
|Restart dan replay update yang sama|Antrean dilanjutkan; tidak memutasi dua kali|
|`/paper open solana <mint> <USD>`|Entry immutable; `/paper` memperlihatkan coverage missing/delayed|
|Maintenance pada startup/restart|Satu ID tanggal UTC; error retry, bukan done palsu|

Bukti saat ini:16 skenario native subprocess dengan HTTP fixture loopback, bukan pesan Telegram nyata atau deployment PostgREST/Supabase.

## 6. F5 — backup mingguan dan restore

### Backup opt-in

Konfigurasikan `PGSERVICE` dan `PGPASSFILE` di luar repository, atau PGHOST/PGPORT/PGUSER/PGDATABASE plus credential libpq terscope. Jangan menaruh password di argumen command, log, file bundle atau chat. `PGSERVICE` yang tidak digunakan harus **unset**, bukan string kosong. Cocokkan versi `pg_dump` dengan versi server yang didukung. `PG_DUMP_BIN` opsional menunjuk executable yang disetujui jika tidak ada di PATH.

```sh
npm run db:backup -- /secure-backups/crypto-YYYYMMDD.dump
```

CLI menjalankan `pg_dump --no-password --schema=public --format=custom --no-owner`; **ACL dipertahankan**. Tujuan absolut harus di luar checkout dan belum ada; file sementara privat, publikasi no-overwrite. CLI tidak mengubah sumber database. Archive plaintext berisi chat, wallet, signed transaction dan ledger: enkripsi dan batasi akses sebelum penyimpanan/off-host. Mode0600/0700 diterapkan di POSIX; pada Windows verifikasi DACL sendiri. Public-schema archive bukan backup Auth/Storage/role/provider platform lengkap. Tidak memasang scheduler atau menghapus backup lama otomatis.

Jadwal mingguan hanya dipasang setelah tempat penyimpanan terenkripsi, credential backup, retensi archive dan owner host dipilih. Contoh cron Linux untuk operator (belum di-install), dengan PGSERVICE/PGPASSFILE pada environment service yang aman:

```cron
0 3 * * 0 cd /srv/crypto-tracker && /usr/bin/node scripts/database-backup.mjs /secure-backups/crypto-$(date +\%F).dump
```

### Restore drill terisolasi

1. Buat database temporer baru milik drill pada host aman. Provision role yang direferensikan ACL (`anon`, `authenticated`, `service_role`) dan administrator tepercaya; jangan menjadikan role client/aplikasi sebagai owner.
2. Dump menyertakan CREATE SCHEMA public. Target harus benar-benar kosong tanpa schema public existing. **Hanya pada database drill baru yang dipastikan kosong**, hapus schema public kosong tanpa CASCADE; kegagalan karena berisi objek berarti berhenti, bukan memakai CASCADE/clean untuk memaksa.
3. Jalankan restore dengan koneksi target terscope, bukan source. Jangan memulai bot/executor pada hasil restore.

```sh
pg_restore --no-password --no-owner --exit-on-error --single-transaction --dbname=restore_drill crypto-YYYYMMDD.dump
psql -X -v ON_ERROR_STOP=1 --dbname=restore_drill -f supabase/operations/verify.sql
```

4. Cocokkan jumlah baris dan digest isi semua tabel utama, RLS, ACL dan fungsi. Gate privilege wajib lulus. Restore tidak membatalkan transaksi yang sudah disiarkan, dan status snapshot lama dapat memerlukan rekonsiliasi receipt sebelum konsumsi ulang.

Drill lokal yang diamati: pg_dump/pg_restore17.11, archive sintetis52.389byte, jumlah baris + digest12tabel cocok, privilege gate lulus. Ini bukan bukti backup produk/enkripsi/scheduler aktif. Archive dan cluster milik task dibersihkan setelah bukti selesai.

## 7. F6 — monitoring tujuh hari

```sh
psql -X -v ON_ERROR_STOP=1 -f supabase/operations/monitor.sql
```

Snapshot hanya metadata/ukuran/count, bukan payload atau signed bytes. Simpan di lokasi aman di luar repo saat hari1 dan hari7 setelah rollout. SQL mencakup ukuran DB/tabel/index, status termasuk pruned, timestamp maintenance terakhir, dead tuples dan autovacuum. Egress dan agregasi billing organisasi dibaca dari dashboard provider, tidak ditebak dari jumlah scanner.

Bukti awal **sintetis**, bukan Supabase/VPS: PostgreSQL lokal8.730.291byte (8526kB) dengan12tabel; ini tidak menggantikan baseline platform40–60MB yang dicantumkan vendor. Dataset kecil tidak mewakili beban pengguna. Belum ada observasi tujuh hari.

Ambang review awal: DB>250MB, pertumbuhan failed/pruned yang mengkhawatirkan, maintenance tidak selesai>24jam, kenaikan egress, atau dead tuples tidak dikelola autovacuum. Tindakan: periksa beban/query/retensi/backup dan kapasitas; bukan menghapus ledger/tombstone atau menaikkan paket berbayar otomatis.

## 8. F7 — Hermes Mac dan host VPS

Ikuti bagian5–6 dan10 [HERMES_BOT_ARCHITECTURE.md](./HERMES_BOT_ARCHITECTURE.md). Bukti fase asal hanya syntax script melalui Git Bash Windows; eksekusi lanjutan §11 sudah membuktikan inferensi3b native dan fallback pada Mac, bukan tunnel restricted atau runtime Linux production. Framework resmi NousResearch/hermes-agent tidak dipasang; loop yang tersedia tetap custom read-only.

Instalasi harus mengikuti host/akun, kapasitas aktual, akses terbatas, model dan endpoint yang disetujui. Eksekusi lanjutan memasang biner Ollama/age user-local serta model tanpa daemon sistem/PATH/shellrc. Tidak memasang Docker, Tailscale, systemd, firewall atau SSH config, dan tidak menganggap kapasitas VPS/Gomoku memadai tanpa pengukuran.

## 9. Bukti historis implementasi dan prasyarat operasi berikutnya

| Pemeriksaan pada task implementasi terdahulu, bukan pemeriksaan ulang §0 | Hasil yang dicatat saat itu |
|---|---|
|`npm run check`|Lulus typegen dan TypeScript|
|`npm run test:all`|136/136,0skipped; termasuk maintenance error/retry/restart dan16skema subprocess|
|Strict typecheck test runtime/integrasi targetES2024|Lulus|
|`npm run build:frontend`|Production build lulus; bukan visual acceptance dashboard atau Docker build|
|Bundle tujuh migrasi pada PostgreSQL17.11 kosong|Lulus; reapply dengan maintenance/tombstone dan existing grants/policies juga lulus|
|`supabase/tests/retention.sql`|Lulus terminal-age,boundary,batch,fence,lease,dedupe,confirmation,ledger/cursor dan reapply|
|Gate negatif|Alias duplikat ditolak; column-only grant anon ditolak; privilege bersih lulus|
|Backup/restore CLI|Dump riil sintetis, restore transaction, isi12tabel + privilege cocok|
|Review keamanan terpisah|Core SQL/runtime dan scripts lulus audit statis; bukan sertifikasi production|

Untuk menyelesaikan operasi eksternal: pilih project/organisasi/region dan izin migrasi uji; simpan credential uji lokal melalui mekanisme aman; sediakan bot/owner/chat uji; tetapkan archive terenkripsi dan credential backup; sediakan akses/izin Mac/VPS. Observasi tujuh hari baru dimulai setelah rollout tersebut. Izin commit/push/PR/merge/deploy/live trading tetap terpisah.

## 10. Kontrak artefak dan operasi delivery

Kontrak ini mendeskripsikan mekanisme yang harus melewati gate §11, bukan bukti aktivasi remote. Satu `.github/workflows/delivery.yml` memakai hosted quality, lalu deployment sesuai event/ref. Tidak ada workflow pipeline kedua atau migrasi SQL otomatis.

### Artefak immutable

- `npm run release:pack -- --sha "$CANDIDATE_SHA" --out "$ARTIFACT_FILE"` memerlukan SHA commit lengkap dan output absolut baru. Isi diambil dari Git tree/blob SHA tersebut, bukan working tree. Perubahan task yang belum di-commit tidak dapat diklaim sebagai artefak dari HEAD lama.
- Envelope JSON schema1 memuat revision serta daftar path/hash SHA256/base64, dengan digest atas byte seluruh artefak. Controller dan kedua helper `delivery-profile.mjs`/`delivery-service.mjs` ikut terikat digest.
- Isi hanya manifest/lockfile, entrypoint bot, modul TypeScript native dan tiga modul delivery yang diizinkan. Tidak menyertakan `.env`, signer entrypoint, `.git`, `.agents`, fixture, dependency, dump atau build dashboard. UI tetap ada di repo, bukan dihapus.
- Workflow mengekstrak controller/helper dari envelope yang sama dan memverifikasi hash sebelum SSH. Deployment tidak menerima source dirty atau nama branch mutable sebagai pengganti kandidat teruji.

### Profil privat per target host

Profil JSON schema1 harus dibuat operator di luar checkout dengan izin owner-only; setiap host/target memakai file sendiri. Nilai credential tidak masuk GitHub variables, source atau chat.

| Field | Kontrak |
|---|---|
| `target`, `hostId`, `service` | Target staging/production, identitas host yang diregistrasikan operator, dan `launchd` pada Darwin atau `systemd-user` pada Linux. |
| `root`, `port`, `envFile` | Root release yang sudah ada, privat dan terpisah; port bot sesuai env; dotenv target absolut privat di luar checkout/release. Tidak mengadopsi direktori asing. |
| `nodeBin`, `npmBin` | Executable absolut/canonical tepercaya, Node24+. Bukan command string bebas. |
| `localWorkspaceRoot` | Workspace developer pada host yang sama, bila ada; deployment tidak berjalan dari workspace ini. |
| `peers.development` | Registrasi nonsecret hostId/root/port/Supabase URL/Telegram bot ID/hash token API milik developer. |
| `peers.counterpart` | Registrasi nonsecret yang sama untuk target lawan, dengan field `target` yang berlawanan. |

Controller hanya membaca dotenv targetnya, bukan env developer/production lawan. Ketiga identitas resource wajib berbeda; root/port pada host sama tidak boleh bertabrakan. Path peer remote divalidasi secara leksikal tanpa mengakses host tersebut. Registrasi peer adalah bukti operator, bukan verifikasi akun remote. Live/auto, signer key dan runtime injection ditolak; identitas revision/instance dimiliki controller.

Root baru harus kosong dan diinisialisasi secara sengaja:

```sh
node scripts/delivery.mjs init --config "$PROFILE_FILE" --target staging
```

`init` bukan langkah tersembunyi CI. Owner marker, lock eksklusif, state current/previous/pending dan snapshot env privat melindungi operasi. Release memakai direktori unik tanpa overwrite; rollback memakai source/env snapshot yang sudah divalidasi, bukan dotenv eksternal yang mungkin berubah.

Lock delivery memakai transaksi eksklusif SQLite bawaan `node:sqlite` pada file `operation.lock` privat0600 milik UID target, tanpa npm dependency tambahan. File kosong tersebut sengaja dipertahankan dan tidak boleh dihapus/ditukar inode-nya; lock aktif dimiliki kernel selama callback, bukan ditentukan oleh keberadaan file. Kematian proses melepaskan lock kernel. Symlink, hardlink, permission/ownership salah, file nonkosong dan sidecar SQLite ditolak tanpa dihapus.

**Cutover lock lama:** direktori `operation.lock` dari versi lama ditolak; jangan menghapusnya otomatis atau menganggapnya stale karena umur/PID tebakan. Operator harus lebih dahulu memastikan seluruh controller lama untuk root tersebut sudah berhenti dan menginventaris marker/ownership serta state pending tanpa mengubahnya. Hanya sesudah itu direktori lock lama milik target boleh dihapus atas izin operator; pemulihan pending memakai controller yang cocok setelah gate lolos. Jangan menjalankan controller lama dan baru bersama; tidak ada migrasi target nyata otomatis.

### Service native dan recovery

- Darwin memakai launchd user-domain dengan label terikat root/target. Linux memakai systemd-user, unit/runtime link terikat root, user manager dan linger yang sudah diprovision operator. Controller tidak membuat akun, mengaktifkan linger, mengubah manager environment global atau memasang paket sistem.
- Node bot berjalan dari release directory dengan environment minimal, revision SHA dan instance UUID baru. Secret SSH/CI, `RUNNER_TRACKING_ID` dan runtime injection tidak diteruskan ke child. Health harus cocok dengan identitas kandidat, bukan hanya port terbuka.
- Kegagalan rollout tetap nonzero meskipun rollback berhasil. Kandidat/prior yang kepemilikannya tidak cocok tidak dihentikan; tidak ada kill berdasarkan port/PID tersimpan atau Git revert otomatis.
- `release:status`, `release:stop` dan `release:rollback` memerlukan `--config "$PROFILE_FILE" --target staging` atau production yang tepat. Status tidak memutasi target; stop hanya service milik root; rollback bukan pemulihan database atau pembatalan transaksi on-chain.
- Persistensi setelah job/logout tidak sama dengan autostart reboot. Bukti launchd lokal tidak membuktikan systemd-user Linux atau runner GitHub sudah terpasang.

### Aktivasi GitHub yang masih terpisah

Setiap environment GitHub memerlukan:

- Variables: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_NODE_BIN`, `DEPLOY_PROFILE`.
- Secrets: `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`.
- Branch/environment policy dan required check job `quality` setelah run/job nyata tersedia.
- Akun SSH terbatas, pinned host key, profile/env/roots dan native manager yang sudah diotorisasi.

Ketiadaan konfigurasi menghasilkan **BELUM AKTIF** dan deployment gagal sebelum SSH, bukan job sukses tanpa rollout. Merge/push `main` hanya quality; production perlu manual dispatch dari main. Staging hanya push/manual pada `local`. Push/merge/deploy tetap memerlukan instruksi eksplisit; konfigurasi ini tidak mempublikasikan branch atau menjalankan rilis.

## 11. Bukti eksekusi lanjutan dan gate

### Identitas dan batas izin

- Branch kerja lokal: `chore/crypto-workflow`; integrasi lokal: `local`; SHA dasar keduanya `f6062db1701b8712e4dabea3682cac68cd78927b`. Perubahan task masih working tree, bukan commit baru. Tidak ada issue, commit, push, PR, merge atau deployment nyata yang dibuat.
- Konfigurasi asli hanya diperiksa nama key/presence dan metadata nonsecret: tidak ada deklarasi lingkungan uji, otoritas libpq/management atau login management Supabase yang ditemukan. Nilai key tidak dicetak/dikonsumsi; file env tidak diubah.
- VPS terkonfigurasi diperiksa read-only: RAM total1967MiB, tersedia362MiB, swap terpakai1853MiB, disk bebas8GB; node/npm tidak ditemukan pada PATH pemeriksaan. Ini alasan tidak memilih cohosting otomatis, bukan bukti bahwa seluruh service VPS tidak ada.
- CORE mula-mula dibatasi3putaran: implementasi delivery awal dan kedua tidak lengkap; putaran3 melengkapi controller, helper profil/state dan helper native service tetapi gagal validasi. Pengguna kemudian mengizinkan tepat satu pengecualian; total4/4 dan hasilnya dicatat di §14, tanpa reset histori atau perubahan kebijakan global.

### SQL, backup dan restore lokal — lulus; remote belum aktif

- Homebrew PostgreSQL16.15, cluster privat socket-only tanpa TCP dan environment bersih. Tujuh migrasi + preflight/verify, reapply serta retention/fencing/tombstone berjalan nyata. Collision EVM ditolak tanpa menghapus empat baris; Solana case-sensitive tetap diterima setelah konflik terpisah diselesaikan pada fixture.
- Empat belas penolakan privilege menghasilkan SQLSTATE42501; akses service-role dan RPC `bot_claim_job` berhasil. Lima perubahan negatif table/column grant, PUBLIC EXECUTE, RLS dan grant cleanup service-role ditolak lalu dipulihkan.
- CLI backup mempertahankan ACL; native `age v1.3.2` user-local mengenkripsi dump sintetis, hasil decrypt identik byte, kemudian restore dari hasil decrypt ke database baru. Count/digest12tabel, RLS/policy, table/function privilege dan owner cocok.
- Suplemen memverifikasi335 tuple kolom/role per database:67kolom ×5role, digest sumber/restore sama. Schema,12tabel dan19fungsi dimiliki administrator drill tepercaya, bukan client/service role.
- Monitoring nyata menampilkan heap/index/total bytes dan metadata antrean/autovacuum. Cluster dihentikan, key privat/decrypted/plaintext dump dihapus setelah bukti; tidak mengklaim secure erasure. Tidak ada scheduler backup produk atau observasi tujuh hari.
- Reviewer GPT SQL: `overall_correctness: correct`, tanpa temuan tersisa. Patch monitor SHA256 `1fd5325d387d8d56719d5ca60194ee9420b899a71257ca703995db35ba9debf4`. Bukti sementara dimiliki tugas; ringkasan ini dipertahankan setelah cleanup.

### Hermes native dan hasil evaluasi sintetis

- Biner resmi Ollama0.40.15 diverifikasi SHA256 `607c79d5d6315ef9d896db83adde736a4c0057196329843544e79b95afb260a8` dan codesign, dipasang user-local tanpa PATH/daemon sistem. Modelstore task berada di `$HOME/.local/share/crypto-tracker/models`.
- Base `hermes3:3b` digest `a8851c5041d400c8eece484771e0a9f438e6500de9f22150ef2863bf7209fbd9`; alias `hermes-crypto-analyst` dibuat dari Modelfile. Smoke schema asli exit0: unloaded cold4112.33ms, warm877.64ms. Pengukuran smoke ini terpisah dari urutan request evaluator.
- Model resident dilaporkan2.6GB GPU; swap selama pemeriksaan sekitar2045–2053MiB. RSS proses bukan total Metal/unified memory. Tidak menjalankan beban Gomoku/runner berat atau mengklaim headroom production.
- Dataset version1 berisi6kasus sintetis dengan3family development dan3family holdout yang tidak beririsan; label dibekukan sebelum inferensi, SHA256 `30efd79b2c85a81fda131e02c28160ca3d1c89ea8c2bd91aad4f57df3bc90915`.

| Split / mode | Sukses / percobaan | Timeout | F1 model end-to-end | F1 baseline evaluasi |
|---|---:|---:|---:|---:|
| Development / stateless |3/3|0|0.333|0.842|
| Development / readonly_agent |0/3|3|0|0.842|
| Holdout / stateless |3/3|0|0.286|0.615|
| Holdout / readonly_agent |1/3|2|0|0.615|

- Exact-set agreement0 pada dataset ini; model belum mengungguli baseline pembanding first-four-ID. Scorecard dan guardrail deterministik tidak berubah. Metadata injection yang dihilangkan dari prompt terbukti tidak dikirim; paparan injection melalui tool tidak terjadi karena timeout, jadi belum teruji.
- Putaran1 evaluator mempunyai empat bug pelaporan: micro-F1 null saat denominator positif, denominator response rejection tercampur timeout, label cold/warm berdasarkan urutan saja, dan timeout konfigurasi dianggap deadline efektif. Semua diperbaiki pada putaran2; helper diuji dengan batas matematika dan replay agregat yang sudah direkam, tanpa inferensi/tuning/label ulang.
- Pelaporan timing baru netral first/subsequent; raw per-case latencies tidak direkam pada putaran1 sehingga tidak diklaim dapat dihitung ulang. Konfigurasi12000ms dilaporkan terpisah dari hard cap efektif8000ms, bukan menaikkan cap. Source evaluator putaran2 SHA256 `323ee618724e0225530165f45d25e28d56de44392c3a62216aabedac70dcdd4d`.
- Reviewer GPT evaluator putaran2: `overall_correctness: correct`, tanpa temuan tersisa. Typecheck dan empat regression test metrik lulus dalam full suite revisi akhir; bukti inferensi/fallback yang tidak berubah digunakan ulang, tanpa tuning atau pengulangan holdout.
- Service Ollama milik pengujian dihentikan; endpoint offline dan client mengembalikan unavailable/cooldown tanpa narrative, sementara scorecard/guardrail tetap berfungsi. Biner/model tersimpan untuk sesi manual berikutnya; tidak membuat autostart atau mengaktifkan AI pada env asli.

Keputusan berdasarkan bukti: pertahankan default `stateless` dan scorecard deterministik; jangan mengaktifkan `readonly_agent` pada target operasional atau mengklaim profit/ketahanan adversarial. Eksperimen kualitas baru memerlukan data/holdout baru, bukan tuning terhadap holdout yang sudah dibaca.

### Validasi CORE putaran3 — baseline lulus, delivery gagal

Semua pemeriksaan putaran3 berikut memakai snapshot source yang identik pada12file kunci, tanpa env asli, dengan Node24.19.0/npm11.17.0/Bun1.4.4 pada Mac. Saat tahap ini ditutup tidak ada patch CORE lanjutan; pengecualian eksplisit dan perubahan sesudahnya dicatat terpisah di §14.

| Pemeriksaan aktual | Hasil |
|---|---|
| `npm ci` | Exit0 pada environment snapshot yang bersih. |
| `npm run check` | Exit0, `next typegen` dan `tsc --noEmit` lulus. |
| `npm run test:all` | Exit0,142tes frontend dan10tes script lulus; tidak mengulang suite subset. |
| `npm run build:frontend` | Exit0, Next16.3.1 membangun route dan Proxy; bukan visual acceptance dashboard. |
| Discovery command dari repo asli |15command:14user kanonis+bundled init;0alias pensiun; launcher0755. |
| Launcher+bot asli dengan fixture loopback | Health200/SHA/UUID cocok, API authenticated200 dan unauthenticated401; cwd lain/npm alias, listener asing dan cleanup lulus. Bukan Supabase/Telegram nyata. |
| Workflow dan matriks event/ref/target | YAML valid, quality dependency/isolasi secret/concurrency/3module binding dan10skenario routing lulus lokal; bukan run scheduler GitHub. |
| Native delivery Mac | Init/status awal lulus; deploy dan bootstrap service gagal. Rollout kedua, rollback dan survival setelah job tidak teruji, bukan PASS. |
| Native Linux systemd-user | Tidak dieksekusi; tidak ada host disposable berizin dengan prasyarat yang terbukti. |

Harness awal juga sempat memakai dua config npm `/dev/null`; harness diperbaiki menjadi HOME/PATH bersih sebelum baseline yang lulus. Ini tidak memperbaiki bug hardcoded pada source deployment.

| Blocker historis putaran3 | Lokasi source saat itu | Bukti/dampak |
|---|---|---|
| CORE-BUG-1 | `scripts/delivery.mjs:119` | `runInstall` mengatur user/global config npm ke path `/dev/null` yang sama. npm exit1: `double-loading config "/dev/null"`; rilis tidak dapat dipasang. |
| CORE-BUG-2 | `scripts/delivery.mjs:374` | Guard entrypoint membandingkan path leksikal dengan URL ESM fisik. Invokasi `/tmp` pada Mac, seperti inbox workflow, keluar0 tanpa menjalankan main; bahkan argumen salah tidak divalidasi. |
| CORE-BUG-3 | `scripts/delivery-service.mjs:62` | Bootstrap plist ke user-domain launchd ditolak exit5/log134 `Service cannot load in requested session`; kebijakan session pada definisi belum cocok, key Background tidak disertakan. Tidak ada bukti perbaikan atau startup sukses. |

SHA256 controller gagal: `f542e6cd4f803e4167db15b8b27063c8ff002cd246bcf300a2be2fdba1227d06`. Helper service: `94d0191c19a39a4c75e3c5837e9203c7035e36b19546fc641ff8dabdc1b4e05f`.

**Verdict putaran3: BELUM LOLOS, batas3putaran saat itu habis.** Tidak melanjutkan ke review code delivery sebagai pengganti validasi yang gagal, tidak mereset counter atau menjalankan putaran4 otomatis. Kandidat tidak di-commit/push/merge/deploy. Review SQL/evaluator yang lulus hanya berlaku pada scope tersebut. Pengecualian putaran4 berikutnya berasal dari pilihan eksplisit pengguna (§14), bukan persetujuan CORE atau izin rilis.

### Status seluruh task dan prasyarat yang masih terbuka

| Task | Status faktual |
|---|---|
| T0 | Ref/branch/checkpoint lokal ada; remote `local`, publikasi dan proteksi belum dilakukan. |
| T1 | Implementasi, smoke lokal dan reviewer GPT scope launcher lulus (`correct`,0temuan). Ini tidak mengubah kegagalan delivery CORE. |
| T2 | Baseline, workflow dan routing lokal lulus; GitHub Actions/required checks belum aktif dan kandidat tidak boleh dipublikasikan sebelum CORE lolos. |
| T3 | SQL/privilege/reapply/restore lokal lulus dan direview; target Supabase uji, authority migrasi/libpq/management, rotasi dan PostgREST remote belum tersedia/terverifikasi. |
| T4 | Lima bug dashboard pada §12 mendapat perbaikan pertama dan validasi browser/typecheck lulus (§13). Bot/owner/chat/actor uji serta Telegram nyata belum tersedia; dashboard dipertahankan dan paritas bot belum selesai. |
| T5 | **BELUM LOLOS4/4** (§14). Instalasi/npm, entrypoint, launchd, replacement, rollback dan recovery lulus pada target sementara; probe listener IPv4 masih salah dan dapat meninggalkan `pending`. Deployment nyata tidak dijalankan. |
| T6 | Enkripsi+restore drill nyata lulus dan direview; sumber/tujuan/kustodi kunci/retensi/jadwal backup produk serta observasi hari1/hari7 masih memerlukan runtime/otorisasi dan waktu nyata. |
| T7 | Native3b dan evaluasi sintetis lulus, mode default/stateless dan baseline deterministik dipertahankan; headroom beban Gomoku/runner berat dan tunnel restricted belum diuji. Tidak mengaktifkan AI atau trading pada env asli. |

Tidak ada secret yang perlu dikirim di chat. Akses/target uji harus disediakan melalui mekanisme konfigurasi lokal/credential yang aman; rekomendasi otomatis tidak menggantikan login/authority, izin publikasi/deployment, atau tujuh hari observasi.

### Retensi bukti dan kebersihan

- Receipt JSON dan delapan log verifikasi disimpan privat di `$HOME/.local/share/crypto-tracker/evidence/crypto-workflow-2oAxfV/`, dengan `INDEX.json` berisi pemetaan path asli dan SHA256. Bukti bukan credential, dump produk, private key atau source snapshot.
- Checkpoint sebelum cutover: `$HOME/.local/share/crypto-tracker/checkpoints/before-workflow-2oAxfV.tar.gz`, mode0600, SHA256 `feef169b2ab1d666c3850f1d80161bd5df402ec8c9658f550d5b15c210bc472e`. Berisi state awal `.agents`/runbook, bukan env/signing key.
- Seluruh proses/port fixture dan service pengujian sudah dihentikan/diperiksa tester. Biner Ollama/age dan model user-local dipertahankan; tidak ada daemon/autostart sistem, rilis nyata atau perubahan akun/host produksi.
- Reviewer handoff menemukan empat receipt yang terpotong saat penyalinan reader. Pemilik pengujian memulihkan isi lengkap dari payload write/generator dan hasil alat sesi yang direkam, tanpa menjalankan ulang inferensi/SQL. Seluruh receipt JSON kini dapat diparse; byte count/SHA256 pada `INDEX.json` diperbarui dan diverifikasi dengan checksum file. Tidak mengarang field yang hilang atau mengganti kegagalan CORE.
- Fixture/script throwaway, snapshot dependency, cluster PostgreSQL berhenti dan archive sintetis di direktori temporary tugas sudah dibersihkan. Bukti privat lengkap dan checkpoint awal tetap tersimpan; ini bukan klaim secure erasure.

## 12. Lanjutan setelah gate habis: diagnosis dan dashboard aktual

Pada tahap diagnosis/verifikasi sebelum permintaan perbaikan UI, counter CORE tidak direset dan perubahan repository hanya runbook. Aturan aktif `~/.omp/agent/commands/coder.md:10-29` tetap melarang putaran keempat delivery; tidak ada perubahan modelRoles/fallback, commit, push, merge atau deployment. Hash controller, kedua helper dan workflow identik dengan bukti gagal §11. Perbaikan source dashboard yang baru diminta kemudian dicatat terpisah pada §13, bukan pembukaan kembali gate delivery.

### Diagnosis perbaikan — bukan patch terpasang

Architect memeriksa source serta dokumentasi primer tanpa menjalankan ulang tiga kegagalan:

| Area | Kontrak perbaikan yang teridentifikasi | Batas bukti |
|---|---|---|
| Instalasi npm | Dua file config kosong yang berbeda, privat, dibuat eksklusif; HOME/cache instalasi terisolasi, tanpa credential target atau caller. Letakkan di root milik target, bukan source immutable; bersihkan setelah child selesai. | Mekanisme duplicate-path dikonfirmasi pada source npm11.17.0 yang terpasang. Source deployment belum diubah. Menghapus override saja dapat membuka kembali config HOME. |
| Entrypoint | Invokasi dari inbox `/tmp`, path fisik dan symlink harus menjalankan CLI tepat sekali, sementara import tidak menjalankan CLI. | Opsi `import.meta.main` baru tersedia mulai Node24.2.0; proposal tersebut belum diadopsi dan kontrak Node24+ tidak diam-diam dinaikkan. |
| launchd | Pertahankan domain user/UID dan seluruh pemeriksaan ownership; eksplisit `LimitLoadToSessionType=Background` adalah proposal yang didukung manual. | **[INFERENCE]** Penambahan key mungkin memperbaiki session rejection, tetapi belum dibuktikan pada host. Jangan mengklaim key tersebut pasti cukup atau mengganti ke GUI/root. |

Perubahan byte plist membuat renderer baru menolak definisi lama melalui exact-definition validation. Target yang mempunyai definisi lama perlu inventaris ownership, stop/bootout memakai controller yang cocok, verifikasi proses/registration hilang, lalu penghapusan hanya definisi obsolete yang terbukti milik target. Jangan reset state, mengambil label asing, atau menambah shim permisif. Replacement, failed-rollout recovery, rollback dan persistensi tetap memerlukan smoke native; diagnosis tidak menggantikannya.

Rujukan primer: [npmrc](https://docs.npmjs.com/cli/v11/configuring-npm/npmrc/), [npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci/), [Node24 import.meta.main](https://nodejs.org/docs/latest-v24.x/api/esm.html#importmetamain), serta manual host `launchd.plist(5)` dan `launchctl(1)`. Kebijakan putaran yang habis harus ditangani operator sebelum perbaikan source dapat diteruskan; ini bukan izin membuat gate bernama baru.

### Verifikasi dashboard aktual

- Runtime Next16.3.1 native dari snapshot source tanpa `.env`, Git atau credential asli; dependency existing dipakai lewat symlink yang tidak diubah. Proxy dan auth asli disertakan sebelum browser QA, dengan token uji sintetis dan origin loopback saja. Tester membuktikan unauthenticated `/`401 dan authenticated `/`200; driver menjadi satu pemilik browser karena role tester tidak menyediakan Eval/browser.
- Browser managed membuka dashboard asli pada viewport desktop1440×1000 dan mobile390×844. Data API sintetis melalui interception, bukan pengganti bukti Supabase/Telegram/provider nyata. Tidak ada wallet extension, akun, signing atau dana yang digunakan.
- Interaksi teramati: pagination11wallet, filter yang mereset page, network empty state, rename cancel/save, pin success/409 rollback, cancel delete, tambah wallet, Coin Tracker/indikator, filter transaksi BUY/SELL, error transaksi503, empty holders, copy antrean/error Telegram, daftar blacklist, serta pesan wallet extension tidak tersedia.

| Hasil pemeriksaan UI individual | Jumlah | Makna |
|---|---:|---|
| PASS |17|Postcondition interaksi yang disebut di receipt teramati; bukan PASS aplikasi keseluruhan.|
| FAIL |1|Layout mobile membuat dokumen lebih lebar daripada viewport.|
| Belum terverifikasi |1|Penerimaan dialog native untuk delete tidak dapat dibuktikan karena kontrol dialog browser otomatis menolaknya.|

Lima temuan awal berikut diamati pada source dashboard sebelum diperbaiki (SHA256 `ccdd53acf31369c98ab5fe75e94b247d0f7406b730cbe46f11d8d550e869d93a`); nomor baris tabel ini historis. Status perbaikan dan bukti revisi terbaru ada di §13:

| ID | Lokasi `frontend/app/page.tsx` | Pemicu dan dampak aktual |
|---|---|---|
| UI-DATA-1 |2213–2214|Response indikator `rsi:0` dirender sebagai `—`, bukan0.0; angka valid diperlakukan sebagai data hilang.|
| UI-DATA-2 |249–258,1466–1470|GET watchlist503 menampilkan `0 tracked`/`No target wallets found`, tanpa error fetch pada halaman; ketidaktersediaan terlihat seperti database kosong.|
| UI-LAYOUT-1 |1208–1232|Viewport390px menghasilkan document width951px meski menu wallet sudah ditutup; navigasi header terpotong dan memerlukan scroll horizontal dokumen.|
| UI-STATUS-1 |1281,3150–3165|Dot/badge Telegram tetap hijau dan berdenyut saat modal menyatakan `Not configured`; indikator sehat tidak diturunkan dari keadaan aktual.|
| UI-A11Y-1 |3026–3031|Modal Holders tidak punya role dialog; satu-satunya tombol tutup berupa X tanpa nama aksesibel.|

Tidak membuktikan confirmed-delete, mutasi whitelist/bulk destructive, account wallet nyata, seluruh history/holders/portfolio, paritas bot, physical mobile/touch, atau runtime production. Dashboard dan dependency-nya tidak dihapus.

### Batas harness dan retensi bukti lanjutan

- `unroute(pattern)` menghapus seluruh rule pada helper yang dipakai. Satu request holders sempat mencapai server snapshot dan menghasilkan500; tidak ada provider success yang dibuktikan, tetapi jangan mengklaim tidak ada percobaan provider publik. Tidak ada credential asli yang digunakan. Harness diperbaiki dengan pemasangan ulang seluruh fixture map, rule spesifik lebih dahulu dan catch-all503 terakhir; probe holders200 dan path tidak dikenal503 membuktikan batas setelah koreksi. Receipt membedakan pemeriksaan sebelum dan sesudah koreksi.
- **Erratum otoritatif:** kalimat top-level `browser-validation.json#/transport` yang menyatakan seluruh sesi memakai fixture tanpa request backend/provider adalah overstatement dan tidak berlaku. `transport-erratum.json`, direferensikan beserta SHA256 oleh `INDEX.json` UI, menggantikannya dengan batas sebelum/sesudah koreksi di atas. Receipt asli dipertahankan tanpa perubahan untuk audit; jangan memakai kalimat lama sebagai bukti isolasi menyeluruh.
- Penolakan otomatis dialog membuat delete positif belum terverifikasi, bukan bug source yang dikarang. Cancel delete terbukti. Signature helper keyboard dan predicate case-sensitive juga sempat salah; retry hanya memperbaiki langkah harness, bukan source atau counter.
- Bukti browser lengkap, lima screenshot dan log server berada di `$HOME/.local/share/crypto-tracker/evidence/crypto-dashboard-continuation-1794181228-1145/`. Diagnosis dan boundary/counter berada di `$HOME/.local/share/crypto-tracker/evidence/crypto-continuation-2026-11-08T23-38-08-927Z-2ea35903/`. Tidak mengubah receipt lama atau menjalankan ulang model/SQL/full suite.
- Browser QA sudah ditutup dan tester menghentikan hanya service native milik snapshot. Pemeriksaan listener3055 sesudah stop menghasilkan `NO_LISTENER`; symlink dependency dilepas sebelum snapshot dihapus, dependency repository dipertahankan. Bukti lifecycle/cleanup disimpan di index UI; ini bukan bukti persistence service delivery atau secure erasure.
- Pada akhir tahap §12, tiga blocker delivery dan lima temuan UI belum diperbaiki. Perbaikan UI berikutnya ada di §13; CORE delivery tetap **BELUM LOLOS3/3**. Prasyarat remote CI/staging, Supabase/Telegram uji, backup produk, observasi tujuh hari serta headroom/tunnel tidak berubah.

## 13. Perbaikan lima bug dashboard yang baru ditemukan

Source perbaikan: `frontend/app/page.tsx`, SHA256 `b3606546d357a08025a04f92c02e8657b788545e42a74c53c5e8470546e2c29c`. Ini implementasi UI pertama untuk lima temuan §12, bukan putaran keempat/reset unit delivery. Controller, helper dan workflow delivery tidak diubah; hash keempat file cocok dengan bukti gagal §11. Tidak mengubah API, auth, dependency, kalkulasi finansial, konfigurasi model atau fitur bot.

### Perbaikan dan kontrak perilaku

| Temuan | Perbaikan aktual | Verifikasi terarah |
|---|---|---|
| UI-DATA-1 | Pemeriksaan kehadiran RSI memakai null/undefined, bukan truthiness. |0→0.0, null→`—`,48→48.0; kalkulasi indikator tidak diubah.|
| UI-DATA-2 | Error/request/data availability menjadi state terpisah. Error terlihat, retry memakai fetch yang sama dan disabled saat pending; data terakhir dipertahankan dengan label cached/stale. Request lama tidak menimpa hasil request terbaru. |Initial503 tidak menjadi kosong/0tracked; retry pending/sukses, POST add diikuti refresh503, pemulihan data terbaru dan genuine empty200 diamati.|
| UI-LAYOUT-1 | Header membungkus responsif dan navigasi berada di strip scroll terkontain; aksi tidak dihapus, tidak menutupi overflow dokumen. |Empat tab dan menu wallet dapat digunakan pada empat viewport di bawah.|
| UI-STATUS-1 | Header/modal membedakan status tidak diketahui, belum dikonfigurasi dan configured-delivery-unverified; warna sehat/pulse dekoratif Telegram dihapus. |Response unknown, configured:false/true, status503 dan settings503 diuji; kegagalan settings tidak menghapus konfigurasi yang berhasil dibaca. Tidak mengklaim pesan telah terkirim.|
| UI-A11Y-1 | Holders memakai native `dialog.showModal()`, label dari heading dan tombol Close bernama; close/Escape memakai lifecycle native. |Loading/data20holder/empty/error, Target→Added, fokus awal/tutup/Escape dan modal sempit diuji; tidak memalsukan modality hanya dengan atribut ARIA.|

| Viewport CSS(px) | Document width(px) | Tab navigasi dan menu wallet |
|---:|---:|---|
|320|314|Empat tab terjangkau; menu di dalam viewport.|
|390|384|Empat tab terjangkau; menu di dalam viewport.|
|768|762|Empat tab terjangkau; menu di dalam viewport.|
|1440|1434|Empat tab terjangkau; menu di dalam viewport.|

### Bukti revisi dan batas verifikasi

- Putaran implementasi UI: **1/3**. `npm run check` pada snapshot source bebas credential exit0, menjalankan `next typegen` dan `tsc --noEmit`. Tidak mengulang backend/full test suite, build atau lint yang tidak berubah; ini bukan klaim CI GitHub dijalankan.
- **30 pemeriksaan browser terarah lulus**, pada Chrome156.0.8078.81 dengan profile QA kosong milik tugas. Delapan screenshot mempertahankan render desktop/mobile, error/cached watchlist, RSI nol, status Telegram dan modal Holders. Data API berasal dari fixture HTTP loopback, bukan Supabase/Telegram/provider nyata.
- Native Tab/Shift+Tab tidak memfokuskan konten halaman yang inert di belakang dialog. Satu transisi Tab menuju chrome browser membuat `document.hasFocus=false`; jangan mengklaim setiap sampel selalu berada di elemen dialog. Escape dan tombol Close mengembalikan fokus ke pemicu Holders.
- Tidak menguji Safari/Firefox, perangkat mobile fisik/touch, wallet/signing, confirmed-delete, seluruh paritas bot, backend remote atau delivery. Gate production/trading tidak diaktifkan.
- Percobaan awal di managed Chrome150 mengalami timeout screenshot/compositor/input; hasil tidak lengkap disimpan sebagai kendala instrumentasi, bukan PASS atau bug source. QA dilanjutkan dengan Chrome terpasang pada profile sementara terpisah. Runtime tester sempat dibersihkan sebelum sinyal driver; driver membuat snapshot beridentitas sama dan memiliki runtime pengganti. Compiler tidak diulang karena input source/config tetap sama.
- Rule redirect fixture awal terlalu luas dan ikut mencocokkan host tujuan, sehingga terjadi CORS failure sebelum mencapai fixture; rule yang dipakai untuk proof akhir dibatasi ke origin app. API yang tidak dideklarasikan ditolak503. Tidak menyamarkan kegagalan harness sebagai keberhasilan integrasi nyata.
- Bukti privat: `$HOME/.local/share/crypto-tracker/evidence/crypto-ui-repair-2026-11-09T00-18-37-089Z-a23bede3/`, berisi receipt implementasi, compiler/native, browser dan screenshot. Keputusan review independen beserta identitas revisi disimpan pada index/receipt gate di lokasi yang sama; hasil validasi saja bukan persetujuan rilis.
- Pada akhir tahap UI ini, delivery tetap **BELUM LOLOS3/3** dengan tiga blocker aslinya; kelanjutan yang kemudian diizinkan ada di §14. Perbaikan UI tidak membuat issue/branch baru, commit, push, PR, merge atau deployment, dan tidak memakai credential asli atau dana riil.

## 14. Perbaikan CORE dengan satu pengecualian eksplisit

### Otorisasi dan identitas revisi

Pengguna memilih **“Izinkan satu pengecualian terbatas”** pada keputusan `delivery_repair_policy`: tepat satu putaran sumber tambahan untuk tiga blocker §11. Tiga kegagalan sebelumnya tetap dihitung; hasil sekarang **4/4**, bukan counter baru. Tidak ada izin putaran5 otomatis, perubahan workflow/modelRoles/fallback global, publikasi atau deployment nyata.

Satu coder memiliki tiga file berikut; driver memiliki validasi native, bukti dan dokumentasi. Coder tidak menjalankan build/lint/test/formatter. Helper profil, workflow dan dashboard yang sudah diterima tidak berubah.

| File | Perubahan | SHA256 |
|---|---|---|
| `scripts/delivery.mjs` | HOME/cache npm privat per instalasi, dua config kosong berbeda mode0600, cleanup sesudah child selesai; entrypoint membandingkan realpath dan tidak menjalankan CLI dari import/eval/stdin. | `ba8ca5924346b5f0279375aab5f000a2488342bfd4f2ca9017cfd93800ff41e4` |
| `scripts/delivery-service.mjs` | Definisi launchd memuat `LimitLoadToSessionType=Background`; domain `user/<uid>` dan pemeriksaan kepemilikan/definisi tetap ketat. | `2d5393b060606e0d48931f51f5b7153f0652cf0ca23ab3a9ba4ed4b0c7700061` |
| `scripts/delivery.test.mjs` | Regresi CLI nyata melalui symlink file/direktori, relative path dan nama dengan spasi. | `f991a09d119336b291ca1df680262843d5601f0ea222ae348c940b5c4881a081` |

### Verifikasi aktual dan temuan baru

Node24.19.0/npm11.17.0, macOS, UID501; seluruh credential dan identitas peer sintetis. Pack memakai commit Git fixture sementara, bukan commit/publikasi repository proyek. Bot asli dijalankan dari release immutable dengan dependency hasil npm nyata; penyimpanan loopback sintetis tidak pernah memberikan pekerjaan untuk dieksekusi.

| Pemeriksaan | Hasil aktual |
|---|---|
| `node --test scripts/*.test.mjs`, satu kali dengan environment bersih | Exit0;11/11tes lulus. Tidak mengulang full frontend suite/build/typecheck yang tidak terdampak. |
| Consumer static/dynamic import, stdin, eval dan host metadata yang tidak ada |5/5lulus; exit0 dengan marker consumer saja, tanpa menjalankan CLI. |
| npm installer dengan HOME/.npmrc/registry/token pemanggil yang sengaja diracuni secara sintetis | Empat `ci --omit=dev --ignore-scripts` nyata: tiga sukses, satu invalid-lockfile exit1 sesuai skenario. Config berbeda inode, kosong, mode0600; HOME0700; marker/credential pemanggil dan target tidak diwariskan ke npm. Seluruh direktori install dihapus. |
| launchd user-domain dan bot asli | Bootstrap Background lulus; PID terdaftar/running, health200 dengan SHA/UUID cocok, API tanpa auth401 dan dengan auth200. Bot bertahan setelah controller keluar dan inbox dihapus. |
| Replacement dan explicit rollback | B menggantikan A; rollback memulihkan A dengan UUID baru dan snapshot environment/API token A meski file env eksternal dihapus. Tidak menginstal ulang. |
| Kegagalan startup kandidat dan kegagalan npm | Kandidat gagal menghasilkan exit1 lalu A pulih dengan UUID baru dan pending kosong. Invalid lockfile menghasilkan exit1 sebelum service lama dihentikan; PID dan state lama identik. |
| Rollback saat service berhenti dan listener asing memakai IPv4 target | **FAIL**: exit1 `Rollback and recovery failed; pending state retained`; state semula tanpa pending berubah menjadi pending. Asersi HTTP preservation berikutnya belum tercapai. |

**CORE-BUG-4 — `scripts/delivery.mjs:178–191`.** `portFree()` memakai `server.listen({ port, exclusive: true })` tanpa host, sedangkan bot bind `127.0.0.1`. Diagnosis socket native pada host ini membuktikan listener IPv4 yang masih terikat dapat berdampingan dengan probe wildcard IPv6 `::`; probe eksplisit `127.0.0.1` pada port yang sama ditolak `EADDRINUSE`. Jadi preflight melewatkan konflik IPv4, rollback menulis pending, lalu startup dan recovery tidak dapat memakai port tersebut.

Rekomendasi yang **belum diterapkan**: samakan host probe dengan listener IPv4 bot dan pertahankan regresi yang membuktikan listener asing ditolak sebelum transisi state. Ini bukan kegagalan harness atau alasan menurunkan acceptance criteria. Tidak ada patch tambahan setelah kegagalan putaran4.

**Gate: BELUM LOLOS4/4.** Review independen CORE tidak dijalankan karena validasi native gagal; tidak ada verdict reviewer yang dikarang atau dipakai menggantikan validasi. Tiga perbaikan awal terbukti secara perilaku, tetapi kandidat keseluruhan belum diterima untuk rilis. Bukti UI §13 tetap berlaku pada hash dashboard yang sama.

### Cutover definisi launchd lama

Penambahan key Background mengubah byte definisi yang diperiksa secara ketat. Controller baru sengaja tidak mengambil alih atau menghapus plist format lama. Untuk target existing, operator yang berizin harus:

1. Verifikasi marker/state, source immutable dan kepemilikan definisi lama; pertahankan controller lama yang cocok.
2. Gunakan controller lama melalui path fisik kanonik untuk stop/bootout service miliknya pada `user/<uid>`.
3. Verifikasi registration label tersebut sudah tidak ada; hapus hanya plist usang yang sudah terbukti milik target. Jangan menghapus state, release, env atau definisi asing, dan jangan menjalankan init ulang pada root existing.
4. Jalankan controller baru hanya setelah gate dan izin rollout terpenuhi. Tidak ada shim format lama atau migrasi target nyata otomatis.

Prosedur cutover target existing ini belum dieksekusi; smoke menggunakan root baru yang terisolasi.

### Bukti, cleanup dan batas hasil

- Bukti privat: `$HOME/.local/share/crypto-tracker/evidence/crypto-core-authorized-round4-2026-11-09T02-49-41-604Z/`. Receipt mencakup otorisasi, hash source, perintah/exit, root tests, import consumer, audit npm nyata, transisi native yang gagal, diagnosis socket, final state, gate dan cleanup; `INDEX.json` memetakan byte count/SHA256 tanpa self-hash.
- Service launchd fixture di-bootout dan lookup native menghasilkan113/service-not-found. Service penyimpanan sintetis dihentikan; port IPv4 bot56279 dan fixture56188 terbukti dapat di-bind kembali. Root sementara beserta repo fixture, source/dependency, release, env dan cache telah dihapus; ini bukan klaim secure erasure.
- Sebanyak47request yang diterima fixture penyimpanan hanya memakai path yang dideklarasikan. Ini bukan trace jaringan seluruh mesin. Inspeksi environment proses bot untuk marker runner dan asersi HTTP listener asing akhir belum selesai; isolasi environment npm mempunyai bukti terpisah.
- Tidak menguji Linux systemd-user, Node24.0 secara khusus, GitHub Actions/SSH, database/bot Telegram nyata, provider, production atau dana. Tidak ada issue/branch baru, commit proyek, push, PR, merge, deployment nyata, perubahan credential asli atau konfigurasi agen global. Prasyarat remote T0–T7 pada §11 tetap terbuka.

## 15. Perbaikan CORE-BUG-4 dengan satu pengecualian tambahan

Pengguna menyetujui tepat satu putaran tambahan untuk probe port IPv4; counter CORE sekarang **5/5**, tidak direset. Perubahan terbatas pada `scripts/delivery.mjs`: `portFree()` kini bind `127.0.0.1`, sama dengan listener bot. `scripts/delivery.test.mjs` menambahkan regresi socket nyata: port yang diduduki listener IPv4 asing ditolak, dan kembali tersedia sesudah listener ditutup.

`node --test scripts/delivery.test.mjs` exit0, 8/8 tes lulus; `node --test scripts/*.test.mjs` exit0, 12/12 tes lulus. Smoke native macOS dari root privat sementara memakai profil/release sintetis, state `current:null, previous:record, pending:null` dan HTTP listener asing pada `127.0.0.1:<port>`. Invokasi CLI `rollback --config <profile> --target staging` exit1 sebelum mutasi; state disk identik sebelum/sesudah, `pending:null`, tidak ada service terdaftar, dan listener asing tetap melayani respons. Fixture dan root sementara dihapus; tidak ada credential asli, publikasi atau deployment nyata. Validasi terarah ini tidak menggantikan suite frontend/CI maupun pengujian target existing atau Linux.

**Koreksi batas smoke §15:** state `current:null` berhenti pada pemeriksaan “No recorded release to restore” sebelum memanggil probe port. Hasil exit1/state tetap/listener tetap hidup di atas bukan bukti jalur preflight rollback IPv4. Regresi socket tetap berlaku; pengujian integrasi dengan `current` dan `previous` terisi dicatat pada §16, tanpa mengulang kegagalan historis atau mengubah source.

**Gate perbaikan CORE-BUG-4: LOLOS LOKAL.** Reviewer independen memberikan verdict `overall_correctness: correct`, tanpa temuan, terhadap controller, regresi dan alur deploy/rollback/recovery, tanpa mengulang tes. Bukti positif putaran4 di §14 bersifat historis pada source sebelum patch IPv4; port bebas diuji pada regresi baru, bukan dianggap smoke native rollout terbaru. Tidak ada aktivasi remote atau izin putaran6 otomatis.

## 16. Eksekusi Plan A — checkpoint dan integrasi Git

Pengguna meminta eksekusi Plan A: validasi, commit semantik dan bootstrap branch integrasi. Instruksi ini tidak memuat izin eksplisit `push`; tidak ada push fitur, PR, merge atau deployment otomatis.

Radar GitHub sebelum bootstrap: 0 PR terbuka, hanya ref `main` pada `f6062db1701b8712e4dabea3682cac68cd78927b`. Ref `refs/heads/local` berhasil dibuat pada SHA yang sama melalui API, lalu di-fetch; branch lokal `local` sekarang melacak `origin/local`. Branch kerja tetap `chore/crypto-workflow`. Pada preflight, repository publik, `main` belum protected, dan GitHub Actions melaporkan 0 workflow; required checks belum dipasang sebelum job CI nyata tersedia.

Gate snapshot bebas `.env` asli dan review independen keseluruhan CORE dijalankan sebelum checkpoint. Reviewer menemukan blocker P2: `withTargetLock()` menggunakan direktori `operation.lock` yang dibersihkan hanya dalam `finally`; kematian controller dapat meninggalkan lock dan memblokir deploy/rollback/stop berikutnya. Verdict agregat awal `incorrect`, tidak diganti oleh review sempit IPv4 sebelumnya.

Pengguna memilih **“Izinkan satu putaran perbaikan”** pada keputusan `core_stale_lock`: tepat satu putaran tambahan **6/6** untuk perbaikan lock, regresi proses nyata, validasi terdampak dan review ulang sebelum commit.

Implementasi SQLite pertama (`4D27`) gagal validasi: tester melaporkan 9/10 tes delivery lulus; regresi pemulihan proses gagal karena `BEGIN EXCLUSIVE` pada file kosong membuat `operation.lock-journal` yang tertinggal setelah SIGKILL/SIGTERM. Coder kemudian menambah `PRAGMA journal_mode = MEMORY` (`2FB3`) sebagai respons terhadap kegagalan, sebelum persetujuan driver untuk putaran tambahan. Ini adalah **putaran7**, bukan bagian tersembunyi dari putaran6. Driver menahan commit CORE, mengungkap kronologi dan meminta keputusan; pengguna memilih **“Sahkan revisi final”** pada `ratify_lock_journal`, meratifikasi koreksi yang sudah diuji sebagai **CORE7/7**. Tidak ada perubahan source setelah ratifikasi dan tidak ada izin putaran8 otomatis.

Receipt tester bernama `root-script-validation-round6.json` dipertahankan sebagai bukti teknis, tetapi **penomorannya dikoreksi oleh paragraf ini, index final `round:7`, dan receipt driver**. Keberhasilan revisi final bukan bukti putaran6 lulus; ringkasan pertama tester menghilangkan kegagalan antara dua revisi dan digantikan oleh klarifikasi beserta `stale-lock-failed-4d27.json`.

| Pemeriksaan | Hasil dan identitas |
|---|---|
| Snapshot bebas credential | 114 file, mode launcher0755 dipertahankan; `.env` asli, agent/Git/dependency/build output dikecualikan. |
| Gate CI lokal Node24.22.2 | `npm ci`, `npm run check`, `npm run test:all`, `npm run build:frontend` masing-masing exit0. Suite pada snapshot sebelum perubahan lock:142frontend+12root; tidak diklaim menjalankan ulang frontend setelah helper-only berubah. |
| Regresi revisi final | `node --test scripts/*.test.mjs` exit0,14/14 lulus pada helper `d211d383b980e0ce8749c5ca16ab1fc99a473cc80417c6158c923567a10bcdb5` dan tests `18939c4f030b8d4b204fad806510aa960e50245290d07945aa5b8b9ffef2a004`. |
| Smoke proses nyata | `./local`+bot webhook sintetis: health200 dengan SHA/UUID cocok, API401/200, SIGTERM menghentikan child dan port bisa di-bind lagi; CLI paper replay exit0. |
| Pemulihan lock | Live contender ditolak tanpa callback; lock bisa diakuisisi setelah SIGTERM maupun SIGKILL; callback error melepas lock. Artefak asing/legacy, symlink/hardlink/permission salah/sidecar ditolak tanpa dihapus. |
| Review agregat final | Reviewer independen `overall_correctness: correct`, tanpa temuan tersisa, pada helper/tests final di atas; memakai bukti tester tanpa mengulang validasi. Ratifikasi7/7 terpisah dari verdict teknis. |

Bukti privat: `$HOME/.local/share/crypto-tracker/evidence/crypto-plan-a-2026-11-10T02-28-32-305960000Z/` (index beserta SHA256 log/receipt), serta `crypto-plana-2026-11-10-driver.json` pada direktori evidence induk untuk otorisasi, koreksi counter dan checkpoint. Batas: macOS arm64/loopback sintetis; bukan run GitHub, native Linux systemd-user, Supabase/Telegram/provider nyata, staging atau produksi. Dependency repository tidak diubah; snapshot, fixture dan service disposable milik tester dibersihkan.

Smoke rollback terakhir dijalankan ulang hanya pada helper final di atas dengan `current` dan `previous` valid serta listener HTTP IPv4 asing. Coverage V8 membuktikan `rollback`, `requireAvailablePort` dan `portFree` terpanggil, sedangkan startup tidak. CLI exit1, state identik byte, pending tetap null, tidak ada plist/registration launchd, dan listener asing tetap menjawab200. Receipt final `core-bug-4-rollback-preflight.json` SHA256 `5ea2ec37057e4cce532351957554aaac5d52c1ea0bc6e34f657e5f5f38c6275e` cocok dengan index; hash `18f7736f…` pada pesan tester terdahulu sudah superseded dan tidak dipakai. Seluruh16entri index diperiksa byte count/SHA256 tanpa mismatch. Reviewer mengonsumsi bukti tambahan ini dan mempertahankan verdict `correct`.

Driver membandingkan108input non-Markdown terhadap manifest snapshot dengan override identitas helper/tests final: seluruh hash dan mode cocok sebelum commit. Checkpoint lokal yang dibuat tanpa push:

- `397ad14` — `fix(dashboard): handle unavailable data and accessible mobile layout`
- `d4317ee` — `chore(db): report heap and index sizes separately`
- `78b04e8` — `feat(ops): add native delivery and local evaluation tooling`
- Commit dokumentasi pendamping memuat runbook, kontrak lock/cutover dan README yang sudah diselaraskan; SHA final terlihat pada Git log branch.

**Kesiapan publikasi:** branch fitur tetap `chore/crypto-workflow`, base PR yang disiapkan ialah `local`, bukan `main`. Langkah berikutnya memerlukan instruksi eksplisit `push`, lalu `pr`; setelah PR CI nyata muncul, verifikasi SHA dan pasang required checks/proteksi sebelum merge yang diotorisasi. Tidak ada push fitur, PR, merge, perubahan secret atau deployment pada eksekusi ini. Bootstrap branch `local` tidak mengaktifkan staging.
