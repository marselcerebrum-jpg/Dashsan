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
| **KPI** (omzet, transaksi sukses, Konversi, AOV, customer unik, potensi omzet hilang, downloader) | Pembeli unik dibanding downloader pada cakupan yang sama; KPI mengikuti pilihan periode pembanding |
| **Insight & Rekomendasi** | Ringkasan otomatis: penyebab naik/turun (traffic vs conversion), hari & jam puncak, produk andalan, produk ber-conversion rendah, metode bayar yang sering gagal, efek promo, tingkat repeat order |
| **Tren harian** | Omzet, transaksi sukses, dan total checkout per hari |
| **Status transaksi** | Berapa yang sukses vs pending/expired/batal/gagal |
| **Metode pembayaran** | Omzet & tingkat sukses per metode |
| **Performa produk** | Checkout, sukses, conversion, omzet, kontribusi |
| **Performa per Platform** | Filter Pembeli (Checkout → Sukses) atau Konversi (Download → Sukses), omzet, pertumbuhan, dan kontribusi |
| **Jam ramai** | Heatmap hari × jam — untuk jadwal broadcast/iklan & jam jaga CS |
| **Tipe produk** | Perdana vs perpanjangan/upgrade |
| **Kode promo** | Pemakaian, conversion, omzet, total diskon |
| **Customer teratas** | Customer dengan belanja terbesar |
| **Daftar follow-up** | Customer yang checkout tapi belum bayar/gagal (dan belum beli produk itu), lengkap dengan tombol WhatsApp berisi template pesan + export CSV |
| **Semua transaksi** | Pencarian, filter status, export CSV |

## Catatan teknis

### Downloader harian

Tabel **Performa per Platform** (pilihan Semua platform) memiliki filter **Berdasarkan**: **Pembeli (Checkout → Sukses)** memakai transaksi sukses ÷ checkout; **Konversi (Download → Sukses)** memakai transaksi sukses ÷ downloader tiap platform. Kolom Checkout berubah menjadi Download. Keduanya memakai seluruh rentang tanggal sales yang diterapkan; pilihan Harian pada kartu downloader tidak mengubah cakupan tabel ini. Jumlah Sukses tetap berupa transaksi, berbeda dari pembeli unik pada KPI Konversi. Omzet, pertumbuhan, dan kontribusi tetap tersedia. Data downloader dimuat saat mode Konversi dipilih, dapat dimuat ulang, dan pilihan mode disimpan di browser. Platform dengan downloader tidak lengkap atau nol tidak diberi persentase semu; kegagalan suatu platform tidak menghilangkan konversi platform lain yang datanya lengkap.

**Downloader Harian** tampil sebagai satu kartu KPI bersama omzet, transaksi sukses, dan metrik lainnya dalam kotak **Ringkasan Sales**. Kartu berisi angka utama, perubahan terhadap pembanding, dan tanggal/rentang yang dihitung. Tampilan awal **Harian** mengambil tanggal akhir filter dan tanggal akhir periode pembanding yang sesuai. Buka **Detail downloader** untuk memilih **Seluruh periode sales**, melihat grafik/tabel, atau mengekspor CSV. Data downloader dimuat terpisah sehingga kegagalannya tidak menghalangi data sales. Fitur ini tidak mengubah laporan Agent Tele.

Kartu **Konversi** memakai rumus **pembeli unik sukses ÷ downloader × 100%**. Angka utama menunjukkan konversi sekarang; keterangan di bawah membandingkannya dengan konversi tahun lalu atau N hari sebelumnya sesuai filter (misalnya `▲ 25% vs tahun lalu (4%)` ketika konversi sekarang 5%). Pembeli mengikuti identitas customer yang dipakai dashboard, bukan jumlah transaksi. Platform serta tanggal/rentang mengikuti kartu downloader, termasuk saat memilih mode Harian. Kartu menampilkan pembilang, penyebut, tanggal, dan pembanding yang sesuai. Data yang belum lengkap atau downloader nol menghasilkan `—`, bukan persentase semu. Ini rasio volume periode, bukan konversi cohort pengguna yang sama; nilainya tidak dibatasi secara artifisial ke 100%. Conversion pada tabel produk/pembayaran dan laporan Telegram tetap berarti sukses dibagi checkout.

- Proxy internal: `GET /api/downloaders?platform=jadiasn&start_date=2026-10-01&end_date=2026-10-07` (atau `date=2026-10-01` untuk satu hari).
- Respons proxy menyertakan `per_platform` berisi total dan status kelengkapan masing-masing platform untuk tabel performa. Pengambilan rentang browser dibagi bersama melalui `web/downloader-data.js`.
- Upstream: `GET /api/user-daily?platform=jadiasn&date=2026-10-01`, menggunakan API key server yang sama dengan transaksi.
- Hasil pemeriksaan API: **parameter `platform` juga diperlukan**, meskipun belum disebut pada dokumentasi awal. Tanpa platform atau dengan `platform=all`, API mengembalikan HTTP 500 pada pengujian 29 Oktober 2026.
- Pilihan Semua platform menjumlahkan total masing-masing platform yang terdaftar, bukan menghitung pengguna unik lintas aplikasi. Downloader juga berbeda dari customer yang membeli.
- Karena upstream hanya mendokumentasikan satu tanggal per request, rentang diambil per hari/platform dengan maksimum tiga request bersamaan per instance dan cache per hari. Browser memecah rentang Semua platform per satu hari, atau satu platform per tujuh hari, agar satu fungsi Vercel tidak menunggu seluruh rentang panjang. Status menampilkan progres pengambilan. Rentang panjang tetap memerlukan lebih banyak waktu. Batas waktu pengambilan menghasilkan penanda tidak lengkap, bukan total nol.
- Kegagalan atau respons tidak valid tidak di-cache sebagai nol. Data parsial menampilkan peringatan, tanggal/platform yang belum dimuat, serta angka yang sudah tercatat. Total periode dan persentase hanya tersedia jika cakupan terkait lengkap.
- Cache data terbaru sekitar dua menit dan data lampau 30 menit. Muat ulang tetap menggunakan cache yang masih valid. Mode demo menyediakan angka contoh tanpa memanggil Markaz.

Pengujian downloader (fixture sintetis, tanpa request produksi):

```powershell
npm test
```

### Transaksi

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
   - `PLATFORMS` — opsional, daftar platform untuk dropdown (`slug:Nama,slug:Nama`). API tidak punya
     endpoint daftar platform, jadi platform baru perlu ditambahkan di sini.
3. Deploy. Saat membuka link, browser meminta username & password.

Vercel menjalankan `server.js` sebagai satu fungsi untuk semua request, sehingga halaman dan data
sama-sama terlindungi password. Setelah mengubah Environment Variables, lakukan **Redeploy** agar berlaku.

## Menu Agent Tele

Mengirim insight & rekomendasi sales per platform ke grup Telegram CS, ditulis oleh Claude dari data Dashsan.

- **Grup**: bot dimasukkan ke grup → "Deteksi grup baru" → pilih platform per grup (atau *Semua platform*) → Aktif → Simpan.
- **Isi pesan**: data hari ini (00.00 WIB s/d sekarang) vs kemarin & minggu lalu di jam yang sama, rata-rata 7 hari,
  produk/metode bayar/promo teratas, dan calon pembeli yang belum bayar. Instruksi tambahan untuk AI bisa diisi di menu.
- **Jadwal**: tiap 3 jam (pilih jam WIB yang aktif). `vercel.json` berisi 8 cron harian (tiap jadwal sekali sehari
  sehingga kompatibel dengan paket Hobby; waktu eksekusi Hobby bisa meleset ±1 jam).
- **Pengaturan** disimpan di Vercel Blob privat (`agent/state.json`); lokal di `.data/`.

| Env | Keterangan |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Token bot dari @BotFather |
| `ANTHROPIC_API_KEY` | API key Claude; tanpa ini memakai template |
| `ANTHROPIC_MODEL` | Opsional, default `claude-opus-5-5` |
| `BLOB_READ_WRITE_TOKEN` | Otomatis saat Blob store dihubungkan ke project |
| `CRON_SECRET` | Pengaman endpoint `/api/agent/cron` (dikirim otomatis oleh Vercel Cron) |

### Akun Telegram (scan QR) & komunitas

- Agent Tele dikunci password terpisah (`AGENT_PASSWORD`); token buka-kunci berlaku 12 jam per tab.
- Akun Telegram **khusus** dihubungkan lewat scan QR (Settings → Devices → Link Desktop Device). Butuh `api_id` &
  `api_hash` dari my.telegram.org (diisi di menu, disimpan terenkripsi) atau env `TELEGRAM_API_ID` / `TELEGRAM_API_HASH`.
- Sesi login disimpan terenkripsi AES-256-GCM dengan `TG_SESSION_KEY` (jangan diganti — sesi tersimpan jadi tidak terbaca).
- "Buat komunitas & grup": satu supergroup per platform (jeda ±8 detik antar grup) + folder bersama dengan satu link
  undangan (`t.me/addlist/...`). Grup buatan akun dikirimi pesan lewat akun; grup bot tetap lewat bot.
