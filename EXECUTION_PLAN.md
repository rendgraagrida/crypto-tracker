# Runbook eksekusi: database, retensi dan smoke bot

Status: **implementasi dan verifikasi lokal selesai; operasi remote belum dijalankan**. F0 tidak dijalankan karena tidak ada perintah commit. F1–F2 sudah diuji; F3–F7 mempunyai artefak/prosedur siap pakai dengan batas bukti di bawah. Tidak ada commit, push, PR, merge, migrasi Supabase remote, instalasi Mac/VPS atau transaksi dana riil.

Pemilik arsitektur: [HERMES_BOT_ARCHITECTURE.md](./HERMES_BOT_ARCHITECTURE.md). SOP: [BOT_WORKFLOW.md](./BOT_WORKFLOW.md). Dokumen ini adalah pemilik urutan operasi, bukan SOP baru.

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
| F2 checks + smoke | Lulus lokal |136/136 test; typecheck aplikasi/test; production build; PostgreSQL17.11 riil dan reapply tujuh migrasi. |
| F3 Supabase uji | Artefak siap, belum remote | Generator bundle, preflight dan gate privilege diuji lokal. Project/organisasi/region dan izin migrasi belum ditetapkan; tidak ada `.env.local` atau `.env.trader.local` saat pemeriksaan prasyarat. |
| F4 bot Telegram | Proses lokal sintetis lulus; Telegram nyata belum | Native process membuktikan maintenance error→retry→done, restart/dedupe dan command. Bot uji, owner/chat dan DB uji terscope belum disediakan. |
| F5 backup/restore | Drill sintetis lulus; produk belum | CLI backup riil + pg_restore: isi12tabel dan privilege cocok. Lokasi/enkripsi/retensi backup produk dan scheduler belum dipilih. |
| F6 observasi7hari | SQL siap; snapshot sintetis tersedia | Tidak ada observasi production tujuh hari. Monitor perlu dijalankan setelah rollout uji. |
| F7 Mac Hermes/VPS | Prosedur tersedia; host belum diakses | Mesin saat ini Windows. Identitas/akses Mac/VPS, kapasitas dan izin host belum tersedia. Tidak ada klaim inference/tunnel lulus. |

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

Ikuti bagian5–6 dan10 [HERMES_BOT_ARCHITECTURE.md](./HERMES_BOT_ARCHITECTURE.md). Script Mac sudah ada; syntax dapat diuji di Windows dengan Git Bash, tetapi itu bukan smoke inference, SSH atau macOS. Framework resmi NousResearch/hermes-agent belum dipasang; loop saat ini custom read-only.

Sebelum instalasi: pemilik menetapkan host/akun, RAM/disk/CPU aktual, headroom Gomoku, akses terbatas, model dan endpoint yang disetujui. Ukur memory pressure/latency cold-warm di Mac dan beban bot pada VPS; tidak memakai angka chat sebagai benchmark. Tidak ada Ollama, Docker, Tailscale, service systemd, firewall atau SSH config yang di-install oleh task lokal ini.

## 9. Bukti dan prasyarat operasi berikutnya

| Pemeriksaan pada task ini | Hasil diamati |
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
