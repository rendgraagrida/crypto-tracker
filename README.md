# 🚀 Crypto Tracker (Monorepo)

Monorepo terpadu yang menggabungkan pelacak dompet multichain (*backend*) dan dashboard analitik berbasis Next.js dengan Telegram Bot alerts (*frontend*).

Proyek ini menggabungkan dua repositori:
- **Backend:** `trade-apps-backend` (Node.js, Multichain EVM & Solana balance tracker, Supabase sync)
- **Frontend:** `frontend-pelacak-app` (Next.js 16, React 19, Tailwind CSS, Telegram alerts radar & coin sniper)

---

## 📁 Struktur Direktori

```text
crypto-tracker/
├── backend/                  # Layanan backend & crawler saldo dompet
│   ├── index.js              # Script utama pelacakan multichain (ETH, BSC, Base, RH, SOL)
│   ├── package.json
│   ├── Dockerfile            # Container backend
│   └── .env.example          # Panduan environment backend
├── frontend/                 # Aplikasi web dashboard & Telegram Bot
│   ├── app/                  # Next.js App Router (Halaman & API Routes)
│   ├── test/                 # Test suite unit & integrasi
│   ├── package.json
│   ├── Dockerfile            # Container frontend
│   └── .env.example          # Panduan environment frontend
├── docker-compose.yml        # Orkestrasi Docker untuk frontend & backend
├── package.json              # NPM Workspaces root runner
└── README.md
```

---

## ⚙️ Persyaratan Sistem

- **Node.js**: v20+ atau v22+
- **Docker & Docker Compose** (opsional untuk deployment container)
- **Supabase**: Proyek Supabase aktif dengan tabel `watchlist` dan `tracked_coins`

---

## 🚀 Panduan Memulai Cepat

### 1. Setup Environment

Salin file `.env.example` di masing-masing folder:

```bash
# Frontend
cp frontend/.env.example frontend/.env.local

# Backend
cp backend/.env.example backend/.env
```

Isi konfigurasi kunci RPC (Alchemy, Helius, Covalent, Moralis) dan Supabase URL + Key.

### 2. Instalasi Dependensi

Dari root direktori monorepo:

```bash
# Instal dependensi frontend
npm --prefix frontend install

# Instal dependensi backend
npm --prefix backend install
```

### 3. Menjalankan Mode Pengembangan (Local)

Jalankan perintah berikut dari direktori utama (*root*):

```bash
# Menjalankan frontend Next.js (http://localhost:3000)
npm run dev:frontend

# Menjalankan backend tracker worker
npm run dev:backend
```

---

## 🐳 Menjalankan dengan Docker Compose

Untuk menjalankan frontend dan backend secara bersamaan dalam container Docker:

```bash
# Build dan jalankan di background
npm run docker:up

# Mematikan service
npm run docker:down
```

Aplikasi frontend akan tersedia di `http://localhost:3000`.

---

## 🧪 Testing

Jalankan pengujian frontend:

```bash
npm run test:frontend
```

Atau jalankan seluruh test suite:

```bash
npm run test:all
```

---

## 📜 Lisensi
ISC License.
