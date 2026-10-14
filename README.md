# Dashboard Sales

Dashboard penjualan untuk tim sales, membaca data dari endpoint `GET /api/transaction`.
Tanpa dependency — cukup Node.js 18+.

## Cara menjalankan

```bash
cp .env.example .env      # lalu isi API_KEY
npm start                 # buka http://localhost:3000
```

Sumber data default: `https://markaz.cerehub.id/api/transaction`.
Tanpa `API_KEY`, dashboard berjalan dalam **mode demo** (data contoh) — berguna untuk melihat tampilan.

API key hanya disimpan di server (`.env`, sudah di-`.gitignore`) dan tidak pernah dikirim ke browser.
API key dikirim di header `Authorization: <key>` (tanpa `Bearer`). Jika dashboard menampilkan
`API Key expired`, minta key baru ke tim backend lalu ganti `API_KEY` di `.env`.

## Isi dashboard

| Bagian | Kegunaan untuk strategi |
|---|---|
| **KPI** (omzet, transaksi sukses, conversion, AOV, customer unik, potensi omzet hilang) | Dibandingkan otomatis dengan periode sebelumnya yang sama panjang |
| **Insight & Rekomendasi** | Ringkasan otomatis: penyebab naik/turun (traffic vs conversion), hari & jam puncak, produk andalan, produk ber-conversion rendah, metode bayar yang sering gagal, efek promo, tingkat repeat order |
| **Tren harian** | Omzet, transaksi sukses, dan total checkout per hari |
| **Status transaksi** | Berapa yang sukses vs pending/expired/batal/gagal |
| **Metode pembayaran** | Omzet & tingkat sukses per metode |
| **Performa produk** | Checkout, sukses, conversion, omzet, kontribusi |
| **Jam ramai** | Heatmap hari × jam — untuk jadwal broadcast/iklan & jam jaga CS |
| **Tipe produk** | Perdana vs perpanjangan/upgrade |
| **Kode promo** | Pemakaian, conversion, omzet, total diskon |
| **Customer teratas** | Customer dengan belanja terbesar |
| **Daftar follow-up** | Customer yang checkout tapi belum bayar/gagal (dan belum beli produk itu), lengkap dengan tombol WhatsApp berisi template pesan + export CSV |
| **Semua transaksi** | Pencarian, filter status, export CSV |

## Catatan teknis

- Rentang tanggal panjang dipecah per 31 hari ke API (maks 3 request paralel) dan di-cache di memori
  (2 menit untuk data hari ini, 30 menit untuk data lampau).
- Rentang maksimal 400 hari per permintaan.
- Chart.js 4.4.1 disertakan di `web/vendor` (lisensi MIT) agar tetap jalan meski CDN diblokir.

## Deploy ke Vercel

1. Import repo ini di Vercel (Add New → Project). Framework Preset: **Other**, tanpa build command.
2. Di **Settings → Environment Variables** isi:
   - `API_KEY` — API key Markaz
   - `DASHBOARD_PASSWORD` — password untuk tim sales (wajib; tanpa ini dashboard menolak semua akses)
   - `DASHBOARD_USER` — opsional, default `sales`
3. Deploy. Saat membuka link, browser meminta username & password.

Semua request diarahkan ke satu fungsi (`api/index.js`, lihat `vercel.json`) sehingga halaman dan data
sama-sama terlindungi password. Setelah mengubah Environment Variables, lakukan **Redeploy** agar berlaku.
