@echo off
setlocal
title Crypto Tracker (Frontend + Backend)
cd /d "D:\DEVELOPMENT\crypto-tracker"

echo ======================================================================
echo           🚀 CRYPTO TRACKER LAUNCHER (LOCAL MONOREPO)
echo ======================================================================
echo.
echo [1/3] Memeriksa file konfigurasi environment...
if not exist "backend\.env" (
    echo   - backend\.env belum ada, menyalin dari .env.example...
    copy "backend\.env.example" "backend\.env" >nul
)
if not exist "frontend\.env.local" (
    echo   - frontend\.env.local belum ada, menyalin dari .env.example...
    copy "frontend\.env.example" "frontend\.env.local" >nul
)

echo [2/3] Memeriksa dependensi node_modules...
if not exist "node_modules" (
    echo   - node_modules belum ditemukan, menginstall dependensi...
    call npm install
)

echo [3/3] Menjalankan Frontend (Next.js) & Backend Worker...
echo.
echo Dashboard Web: http://localhost:3000
echo.
echo Tips: Tekan Ctrl+C untuk menghentikan semua service.
echo ======================================================================
echo.

:: Membuka browser otomatis setelah 4 detik di latar belakang
start "" powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds 4; Start-Process 'http://localhost:3000'"

:: Menjalankan frontend & backend secara bersamaan
call npm run dev

pause
