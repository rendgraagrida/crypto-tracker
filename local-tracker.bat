@echo off
setlocal
cd /d "%~dp0"
if not exist "frontend\.env.local" (
  echo Buat frontend\.env.local dari frontend\.env.example dan konfigurasi database uji terlebih dahulu.
  exit /b 1
)
if not exist "node_modules" (
  echo Dependensi belum tersedia. Jalankan npm ci setelah meninjau konfigurasi.
  exit /b 1
)
echo Menjalankan bot native. Tidak menyalakan backend seed statis, browser, atau Docker.
call npm run bot:start
exit /b %errorlevel%
