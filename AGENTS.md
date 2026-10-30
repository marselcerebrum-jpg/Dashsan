# AGENTS.md — Dashsan

## Tujuan proyek

Dashsan adalah dashboard internal sales Cerebrum Group. Proyek ini membantu tim sales/CS membaca penjualan lintas platform, menemukan peluang follow-up, dan menentukan tindakan berdasarkan data transaksi Markaz.

Dua menu utama:

- **Dashboard**: KPI, perbandingan periode, tren, performa platform/produk/pembayaran/promo, jam ramai, customer, follow-up WhatsApp, dan ekspor CSV.
- **Agent Tele**: pengaturan grup Telegram, laporan per platform dan gabungan All, template pesan, target bulanan, jadwal, pratinjau, pengiriman, serta riwayat.

Prioritas: akurasi closing harian, follow-up yang tepat, laporan yang dapat ditindaklanjuti, tampilan nyaman di HP, biaya operasional rendah, dan keamanan data customer.

## Arsitektur yang berlaku

Repository ini memakai **Node.js 24.x dan JavaScript ES modules**, sesuai `package.json`.

- Backend: HTTP server bawaan Node.js, native `fetch()`, dan modul JavaScript di root.
- Frontend: HTML, CSS, JavaScript murni; tidak ada proses build frontend.
- Grafik: Chart.js lokal di `web/vendor/chart.umd.js`.
- Hosting: Vercel; `server.js` menyediakan default export sebagai request handler dan dapat dijalankan lokal.
- Penyimpanan Agent Tele: Vercel Blob privat; fallback lokal di `.data/`.
- Telegram: Bot API sebagai jalur operasional utama; GramJS/MTProto untuk akun khusus sebagai opsi.
- AI: SDK Anthropic tersedia sebagai opsi. Pilihan pengguna saat ini adalah **template otomatis gratis**.

Pertahankan arsitektur sederhana ini. Migrasi framework, database baru, bundler, atau layanan berbayar harus memiliki kebutuhan jelas dan persetujuan pengguna. Instruksi Laravel/SiMarsel V2 dari panduan lama tidak berlaku untuk Dashsan.

## Peta file

| File | Tanggung jawab |
|---|---|
| `server.js` | Konfigurasi/env, Basic Auth, file statis, proxy Markaz, normalisasi tanggal closing, pemecahan rentang, cache, dan data demo |
| `downloader.js` | Validasi rentang downloader, request harian per platform, cache, batas concurrency, dan agregasi data parsial |
| `agent.js` | API Agent Tele, autentikasi menu/cron, state, grup bot, fakta per platform, template, pengiriman, dan riwayat |
| `all-insight.js` | Fakta/laporan All, agregat bulanan/tahunan, target default, dan variabel All |
| `tg-account.js` | Enkripsi kredensial/sesi, login QR, komunitas, dan pengiriman melalui akun khusus |
| `web/index.html` | Struktur Dashboard dan Agent Tele |
| `web/app.js` | Filter, analisis dashboard, Chart.js, follow-up, template WhatsApp, dan CSV |
| `web/downloaders.js` | Panel downloader dashboard, pembanding, grafik, penanda data parsial, dan CSV |
| `web/downloader-data.js` | Pengambilan downloader dalam potongan pendek dan agregasi per platform lintas tanggal |
| `web/platform-performance.js` | Mode performa platform, pembagi konversi, pemuatan seluruh periode, dan pembatalan request lama |
| `web/conversion.js` | Rasio pembeli unik terhadap downloader pada cakupan yang sama dan kartu KPI konversi |
| `web/agent-ui.js` | Kunci menu, pengaturan grup/jadwal/template/target, pratinjau, SSE, dan accordion |
| `web/styles.css` | Tema, token warna, responsivitas, dan komponen tampilan |
| `web/vendor/chart.umd.js` | Library grafik lokal; jangan diedit untuk perubahan aplikasi |
| `vercel.json` | Konfigurasi fungsi dan jadwal cron UTC |
| `.env.example` | Contoh konfigurasi tanpa nilai rahasia |
| `README.md` | Panduan menjalankan dan mengoperasikan aplikasi |

`README.md` dan komentar lama dapat tertinggal dari implementasi. Cocokkan dengan kode, `package.json`, dan keputusan produk di panduan ini. Jangan menyalin klaim lama seperti “tanpa dependency” atau Node.js 18+ sebagai kondisi saat ini.

## Aturan data penjualan

### API dan platform

- Sumber default: `https://markaz.cerehub.id`, endpoint upstream `GET /api/transaction`.
- Autentikasi default upstream: `Authorization: <API_KEY>` tanpa awalan `Bearer`. Override `API_KEY_HEADER`/`API_KEY_QUERY` sudah tersedia; jangan menebak format ulang tanpa bukti.
- Browser memakai proxy internal `GET /api/transactions`, bukan API Markaz langsung.
- `GET /api/config` menyediakan daftar platform, default, tanggal hari ini, dan status demo; jangan mengirim secret melalui endpoint ini.
- Daftar platform berasal dari `PLATFORMS` di `server.js`, atau override env berformat `slug:Nama,slug:Nama`.
- Default saat ini: `jadiasn`, `jadibumn`, `cerebrum`, `jadipolisi`, `jadiprajurit`, `jadisekdin`, `jadiojk`, `jadipppk`, `jadibeasiswa`, `jadipcpm`, `jagotpa`, `psikoteskerja`, `toeflacademy`, dan `jadippg`.
- `all` adalah pilihan agregasi, bukan platform Markaz tersendiri. Hindari daftar platform yang berbeda antara dashboard, grup, dan target.

### Downloader harian

- Downloader ditampilkan di dashboard saja; jangan mengubah laporan Telegram untuk fitur ini tanpa permintaan baru.
- Performa per Platform memiliki pilihan **Pembeli (Checkout → Sukses)** dan **Konversi (Download → Sukses)**. Default Pembeli; pilihan disimpan di browser. Jumlah Sukses tetap transaksi sukses. Mode Konversi memakai downloader tiap platform untuk seluruh rentang sales, tidak mengikuti mode Harian pada KPI. Muat downloader hanya saat diperlukan; pertahankan omzet/pembanding/kontribusi, pembatalan filter lama, dan opsi muat ulang. Respons proxy `per_platform` menyediakan total/kelengkapan per platform; platform parsial atau downloader nol tidak menghasilkan persen, tanpa menyembunyikan konversi platform lain yang lengkap.
- Downloader memakai satu kartu KPI di kotak Ringkasan Sales bersama KPI transaksi, dengan angka utama, delta pembanding, dan tanggal/rentang. Grafik, tabel, dan kontrol berada pada Detail downloader yang tertutup secara default; jangan membuat tiga kartu ringkasan downloader terpisah.
- Nama kartu tetap **Konversi**: pembeli unik sukses dibagi downloader. Angka utama adalah konversi sekarang; delta dan konversi pembanding mengikuti filter tahun lalu atau N hari sebelumnya, termasuk saat mode Harian. Gunakan identitas customer dashboard serta platform dan tanggal yang sama dengan kartu downloader, bukan jumlah transaksi atau seluruh bulan dibagi downloader satu hari. Tampilkan pembilang/penyebut dan cakupan tanggal; data tidak lengkap atau downloader nol tidak menghasilkan persen. Rasio ini bukan funnel cohort; jangan membatasinya ke 100% atau mengubah definisi conversion checkout di tabel/Telegram.
- Endpoint upstream `GET /api/user-daily` membutuhkan `date` dan, berdasarkan pengujian, `platform`. Proxy browser adalah `GET /api/downloaders` dengan filter platform dan rentang tanggal.
- Pilihan `all` dijumlahkan oleh aplikasi dari masing-masing platform; jangan mengirim `platform=all` ke endpoint upstream downloader. Jumlah ini bukan pengguna unik lintas aplikasi atau pembeli sukses.
- Gunakan API key server dan autentikasi dashboard yang sama. Ambil per tanggal tanpa lookback closing transaksi, maksimal tiga request downloader bersamaan lintas periode/pembanding, dengan cache dan batas waktu.
- Kegagalan hari/platform menjadi nilai `null` dengan informasi cakupan, bukan nol. Total periode, rata-rata, hari tertinggi, dan persentase tidak boleh mengklaim cakupan lengkap jika ada data hilang.
- Tampilan awal panel adalah Harian: tanggal akhir filter dibanding tanggal akhir periode pembanding, dengan kedua tanggal jelas. Seluruh periode sales tersedia sebagai opsi; ambil dalam potongan satu hari untuk All atau tujuh hari untuk satu platform agar fungsi Vercel tidak menunggu rentang panjang sekaligus.
- Panel mengikuti platform dashboard, dimuat terpisah dari transaksi, dan mengabaikan respons dari filter yang sudah diganti. Ekspor mempertahankan tanggal pembanding, status kelengkapan, dan label demo/live.
- Tes fitur tersedia melalui `npm test` (service, panel, dan autentikasi endpoint); gunakan fake request agar tidak memanggil API produksi.

### Status, waktu, dan closing

- Status API: `0 Pending`, `1 Success`, `2 Expired`, `3 Canceled`, `4 Failed`.
- Semua batas hari, tanggal laporan, dan jadwal bisnis memakai **WIB (Asia/Jakarta, UTC+7)**. Jangan bergantung pada zona waktu mesin/Vercel/browser.
- Transaksi sukses memakai `paid_date` yang valid untuk tanggal dan jam closing. Transaksi lain memakai `date`; sukses dengan tanggal bayar tidak valid mengikuti fallback kode yang ada.
- `closing_date` diturunkan di server. Gunakan makna yang konsisten untuk KPI, tren, heatmap, dan laporan Telegram.
- Jangan menyebutnya `updated_at`: API yang dipakai saat ini tidak menyediakan filter tanggal diperbarui yang terkonfirmasi.
- API memfilter tanggal dibuat. Server mengambil lookback **2 hari** sebelum awal periode, kemudian menyaring berdasarkan closing. Ini asumsi dari data historis, bukan jaminan pembayaran selalu selesai dalam dua hari.
- Perubahan lookback atau logika tanggal harus diuji untuk checkout sebelum tengah malam yang dibayar esok hari, batas bulan/tahun, dan data tanpa `paid_date`.
- Tabel dan ekspor harus tetap dapat membedakan tanggal dibuat dengan tanggal dibayar.

### Rentang, cache, dan data parsial

- Permintaan upstream dibagi menjadi potongan maksimal 31 hari. Pertahankan batching terbatas yang ada; jangan menjalankan semua platform/bulan sekaligus tanpa batas.
- Endpoint dashboard membatasi rentang sesuai `MAX_RANGE_DAYS` (saat ini 400). Agregasi tahunan mengambil data per bulan.
- Cache transaksi saat ini sekitar 2 menit untuk rentang terbaru dan 30 menit untuk data lampau. Cache memori hanya berlaku per proses/instance.
- Rentang dengan error upstream 5xx dapat dipecah sampai per hari; hari yang tetap gagal dilewati dengan peringatan. Jangan menelan error autentikasi sebagai hari kosong.
- Data gagal dimuat berbeda dari omzet nol. Pertahankan atau tingkatkan penyampaian `warnings` dan penanda data parsial pada fitur yang diubah.
- TOEFL Academy pernah bermasalah pada 16 Agustus dan 25 September 2026. Itu catatan historis, bukan alasan memblokir tanggal secara permanen.
- Demo harus jelas diberi label data contoh. Jangan melaporkan hasil demo sebagai angka penjualan atau bukti koneksi live.

### Omzet dan diskon

- Omzet saat ini = jumlah `nominal` transaksi **Success**: setelah diskon, masih termasuk biaya admin pembayaran customer.
- Jangan mengganti seluruh dashboard/laporan menjadi omzet tanpa admin tanpa keputusan pengguna yang jelas.
- Omzet bukan laba bersih. API tidak mencakup semua biaya perusahaan, refund, komisi, pajak, atau iklan.
- Estimasi diskon memperhitungkan biaya admin: harga produk + estimasi admin - nominal pembayaran. Gunakan aturan dan fallback yang sudah ada di `web/app.js`.
- Biaya admin dapat berbeda menurut platform dan metode bayar, termasuk tarif persentase. Jangan menganggap semua transaksi memiliki biaya Rp2.500.
- Normalisasi promo yang berupa JSON/string, kosong, spasi, dan variasi kapitalisasi sebelum agregasi.
- Jangan menyajikan estimasi biaya sebagai angka akuntansi yang pasti. Hindari perubahan definisi metrik secara diam-diam.

## Dashboard dan follow-up WhatsApp

- Default platform adalah **Semua platform**; default pembanding adalah **periode sama tahun lalu**.
- Opsi lain adalah N hari tepat sebelum periode terpilih. Pertahankan durasi inklusif dan penanganan 29 Februari saat menggeser tahun.
- KPI, insight, tabel platform, dan grafik pembanding harus memakai rentang yang sama dan label yang jelas.
- Jangan menyimpulkan pembanding yang gagal dimuat sebagai pertumbuhan nyata dari omzet nol.
- Follow-up ditujukan untuk orang yang checkout tetapi belum berhasil membeli pada platform terkait.
- Target perilaku: satu baris per orang **per platform**, cocok melalui HP yang dinormalisasi ATAU email yang dinormalisasi; gabungkan percobaan berulang dan semua produk yang dicoba.
- Periksa transaksi sukses dalam periode terpilih dan sesudahnya sampai hari ini. Customer yang gagal pada tanggal 10 lalu membeli tanggal 18 harus dikeluarkan meskipun filter berhenti tanggal 14.
- Pembelian di JadiBUMN tidak otomatis menghapus follow-up JadiASN. Sebaliknya, keberhasilan membeli produk lain pada platform yang sama tetap relevan untuk pengecualian.
- Implementasi saat ini memeriksa pembelian dalam periode dan sesudahnya, bukan seluruh riwayat sebelum awal filter. Data transaksi juga bukan sumber status langganan premium aktif. Jangan menjanjikan verifikasi premium penuh tanpa sumber tambahan.
- Prioritaskan pending dan tampilkan jumlah percobaan, produk, serta cakupan pemeriksaan pembelian.
- Jika pemeriksaan lanjutan tidak lengkap, jangan mengklaim daftar sudah sepenuhnya terverifikasi.
- Template WhatsApp mendukung variabel customer/transaksi, contoh pesan, pembuatan massal, link WhatsApp, dan ekspor CSV. Pertahankan kesamaan isi pesan pada tabel, link, dan CSV.
- Variabel salah ketik harus tetap terlihat dan diberi peringatan. Escape HTML, URL-encode pesan, dan tangani koma, kutip, serta baris baru di CSV.
- Template WhatsApp disimpan per browser; jangan menganggapnya sebagai template bersama seluruh tim.

## Agent Tele

### Grup dan jalur pengiriman

- Kelompokkan grup berdasarkan satu/beberapa platform, atau pilihan `all` untuk gabungan.
- Nama default grup mengikuti platform **tanpa awalan CS**. Nama yang diedit pengguna harus dihormati.
- Bot tidak dapat membuat grup atau folder Telegram sendiri. Tombol `startgroup` membantu pengguna memilih/membuat grup; penyiapan berikutnya dapat dilakukan otomatis jika izin bot cukup.
- Tangani perubahan ID saat grup bermigrasi menjadi supergroup.
- Login QR memakai akun Telegram **khusus**, bukan akun pribadi. Pertahankan enkripsi, dukungan putuskan akun, dan batasan Telegram/flood-wait.
- Jangan menganggap grup/sesi sudah aktif hanya karena fiturnya tersedia. Verifikasi state bila status aktual dibutuhkan.

### Template gratis dan pemisahan All

- Template otomatis gratis adalah pilihan produk saat ini. Jangan menambahkan ketergantungan AI berbayar atau mengaktifkan Anthropic tanpa permintaan pengguna.
- Tanpa `ANTHROPIC_API_KEY`, template gratis adalah keadaan normal, bukan error konfigurasi.
- `messageTemplate` mengatur grup per platform; `messageTemplateAll` mengatur grup dengan pilihan `all`. Keduanya harus memiliki draf, mode auto/custom, variabel, pratinjau, dan simpan yang terpisah.
- Grup beberapa platform tertentu tetap memakai jalur per platform; jangan otomatis mengubahnya menjadi All.
- Gunakan katalog variabel yang diekspor modul terkait; jangan memelihara daftar variabel terpisah di frontend.
- Pratinjau tidak mengirim pesan. Template yang disimpan berlaku untuk pengiriman manual maupun terjadwal berikutnya.
- Jika AI diaktifkan secara eksplisit, angka wajib berasal dari fakta yang dihitung aplikasi. Jangan mengarang angka atau menyatakan dugaan penyebab sebagai fakta.
- Laporan per platform mencakup omzet, sukses/checkout/conversion, pembanding kemarin dan minggu lalu pada jam sama, pace rata-rata tujuh hari, kendala pembayaran, follow-up, jam ramai, serta produk/promo.
- Rekomendasi harus membantu CS menentukan tindakan; jangan menyimpulkan gangguan payment gateway hanya dari sampel kecil tanpa penjelasan.
- Pesan dibaca di HP: baris pendek sekitar 40 karakter bila memungkinkan, jarak antarbagian, nama produk ringkas, dan maksimal beberapa prioritas. Laporan All boleh lebih panjang dengan pembagian pesan yang aman.
- Pertahankan escape/allowlist format Telegram dan pemecahan pesan agar tag tidak rusak atau teks terpotong.

### Definisi laporan All dan target

| Bagian | Pembanding |
|---|---|
| Omzet, pending, gagal, dan sales harian | Kemarin sampai jam yang sama |
| Total kemarin | Satu hari penuh kemarin |
| Overview bulan berjalan | Total bulan lalu penuh |
| Overview tahun berjalan | Total tahun lalu penuh |
| Progres target per platform | Bulan lalu sampai tanggal dan jam yang sama |
| User hari/bulan | Pembeli unik sukses pada cakupan tersebut; pembanding harian pada jam sama |

- Tampilkan overview, sales per platform, pending/expired per platform, dan progres target. Angka dalam kurung harus jelas artinya.
- Target awal di `DEFAULT_TARGETS` berjumlah **Rp796.000.000/bulan**, dapat diubah dari UI dan berlaku tiap bulan sampai diubah. State pengguna mengoverride default.
- Jangan mengganti target pengguna saat menambah platform atau memperbarui kode.
- Kebutuhan per hari = kekurangan target dibagi sisa hari bulan ini, **termasuk hari ini**; kekurangan tidak boleh negatif.
- Jika bulan pembanding lebih pendek, ikuti fallback total bulan lalu yang ada dan uji batasnya.
- `monthAgg` menyimpan agregat bulan lampau per `slug|YYYY-MM`, termasuk total per hari dan penanda parsial. Pengisian dilakukan bertahap dengan batas waktu.
- Jangan mengisi data historis yang belum siap dengan nol atau menyebut cache parsial lengkap. Perubahan rumus agregasi memerlukan strategi penghitungan ulang cache terkait.

### Jadwal dan penyimpanan

- Slot bisnis: **00.00, 03.00, 06.00, 09.00, 12.00, 15.00, 18.00, 21.00 WIB**.
- `vercel.json` menyimpan jadwal UTC; perhatikan pergantian tanggal saat mengonversi WIB.
- Hormati `schedule.enabled`, slot terpilih, grup aktif, dan grup yang sudah dihapus/dikeluarkan.
- Pertahankan pemeriksaan `lastSlot` agar pemanggilan berulang tidak mudah mengirim ulang. Mekanisme saat ini bukan jaminan lock atomik lintas instance; perubahan retry/concurrency harus mempertimbangkan duplikasi dan kegagalan sebagian.
- Riwayat harus merekam sukses/gagal dan pemicu manual/jadwal. Jangan menganggap pencatatan slot sebagai bukti semua grup menerima pesan.
- Jangan memakai `force=1`, `run-now`, atau endpoint cron sebagai tes baca saja: tindakan itu dapat benar-benar mengirim pesan.
- Ketepatan eksekusi bergantung pada hosting. Jangan menjanjikan waktu tepat atau biaya/kuota tertentu tanpa memeriksa ketentuan layanan saat dibutuhkan.
- State produksi berada pada Blob **privat** `agent/state.json`; lokal pada `.data/agent-state.json`.
- Jangan menghapus/mereset state, menimpa pengaturan produksi dengan fixture, atau menjalankan eksperimen dengan token produksi untuk tes lokal.
- File lokal dan cache memori bukan penyimpanan persisten yang dapat diandalkan di Vercel.

## Keamanan dan kontrak API

- Jangan menulis API key, password, token bot, API hash, secret cron, atau sesi ke source, dokumentasi, log, output tes, maupun commit. Gunakan placeholder di contoh.
- Jangan mengambil ulang kredensial dari riwayat chat untuk dimasukkan ke kode.
- `.env`, `.data/`, `node_modules/`, dan log tetap diabaikan Git. `.env.example` hanya berisi contoh tanpa secret.
- Akses halaman/aset dashboard dan API data dilindungi HTTP Basic Auth; produksi wajib memiliki `DASHBOARD_PASSWORD`.
- API pengaturan Agent Tele memakai lapisan tambahan `AGENT_PASSWORD` dan header `X-Agent-Token`. Token UI berlaku 12 jam dan disimpan per tab di `sessionStorage`.
- Request POST Agent Tele wajib memakai `Content-Type: application/json` dan `X-Dashsan: 1`; pertahankan pengaman ini bersama autentikasi. Jangan menambahkan CORS permisif yang melemahkannya.
- Endpoint `/api/agent/cron` melewati Basic Auth tetapi memiliki autentikasi sendiri: `Authorization: Bearer <CRON_SECRET>`. Jangan memperluas pengecualian itu ke endpoint lain.
- Hash/sesi akun Telegram disimpan terenkripsi; `TG_SESSION_KEY` harus stabil. Jangan menggantinya tanpa rencana pemulihan dan login ulang.
- Respons publik state tidak boleh memuat sesi, API hash, atau access hash grup. File statis hanya boleh dilayani dari `web/`.
- Validasi input di server, termasuk slug, rentang tanggal, status, target, template, chat ID, dan ukuran body. UI boleh memberi validasi tambahan untuk kenyamanan.
- Escape data customer dan teks eksternal sebelum dimasukkan ke HTML. Jangan merender input mentah lewat `innerHTML`.
- Kegagalan harus memiliki status HTTP dan pesan yang sesuai. Jangan menampilkan stack trace, secret, respons internal mentah, atau mengubah kegagalan sistem menjadi keberhasilan kosong.
- Perlakukan perubahan `.env`, pengaturan hosting, pengiriman pesan, ganti nama grup, dan state remote sesuai lingkup izin pengguna. Membaca atau memperbaiki kode tidak otomatis memberi izin mengirim pesan ke tim.

## Standar UI dan implementasi

- Bahasa UI dan laporan: Indonesia yang jelas, ringkas, dan membantu tindakan. Nama simbol kode baru memakai English; pertahankan key tersimpan/variabel publik yang sudah dipakai.
- Gunakan JavaScript/CSS yang ada; jangan memperkenalkan React, Vue, Alpine, Tailwind, atau bundler hanya untuk perubahan tampilan rutin.
- Grafik memakai Chart.js lokal agar tidak bergantung pada CDN. Warna kategori harus stabil di semua filter dan periode.
- Pertahankan tema terang krem hangat, tema gelap arang, warna yang nyaman, teks terbaca, dan label/ikon agar makna tidak hanya bergantung pada warna.
- Agent Tele memakai accordion dengan ringkasan saat tertutup, navigasi cepat, tombol buka/tutup semua, dan preferensi buka/tutup per browser.
- Di HP, navigasi dapat digeser horizontal dan tidak menutupi isi. Pertahankan akses keyboard, fokus terlihat, serta status expand/collapse yang benar.
- Pertahankan draf template saat pindah tab dan tampilkan status belum disimpan. Pisahkan preferensi browser dari pengaturan bersama di server.
- Gunakan helper request yang ada. Tampilkan loading, validasi, error, dan status berhasil; jangan meninggalkan tombol terkunci setelah request gagal.
- Pisahkan akuisisi data, perhitungan fakta, penyusunan pesan, dan render UI. Tambahkan modul kecil bila dibutuhkan tanpa memecah proyek menjadi lapisan berlebihan.

## Setup dan konfigurasi

Gunakan Node.js **24.x** dan lockfile NPM yang ada:

```powershell
npm ci
Copy-Item .env.example .env
# Isi konfigurasi yang diperlukan pada .env.
npm start
```

Buka `http://localhost:3000`. Jangan menimpa `.env` yang sudah ada. Tanpa API key aplikasi masuk mode demo.

Untuk demo eksplisit di PowerShell:

```powershell
$env:DEMO = '1'
npm start
# Setelah server dihentikan:
Remove-Item Env:DEMO
```

`npm run demo` yang ada memakai sintaks env shell POSIX; contoh PowerShell di atas tidak bergantung pada sintaks tersebut. Saat menguji, gunakan port yang tersedia dan hentikan hanya proses server yang Anda mulai.

| Konfigurasi | Fungsi |
|---|---|
| `API_BASE_URL`, `API_KEY` | URL dan kredensial Markaz, server saja |
| `API_KEY_HEADER`, `API_KEY_QUERY` | Override autentikasi upstream bila diperlukan |
| `PLATFORMS`, `DEFAULT_PLATFORM` | Daftar dan pilihan platform awal |
| `PORT`, `DEMO` | Port lokal dan mode data contoh |
| `DASHBOARD_USER`, `DASHBOARD_PASSWORD` | Basic Auth dashboard |
| `AGENT_PASSWORD` | Pengaman tambahan Agent Tele |
| `TELEGRAM_BOT_TOKEN` | Pengiriman dan pengelolaan melalui bot |
| `CRON_SECRET` | Autentikasi jadwal |
| `BLOB_READ_WRITE_TOKEN` | Penyimpanan Blob privat |
| `TG_SESSION_KEY` | Kunci enkripsi sesi/kredensial akun Telegram |
| `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` | Opsional untuk jalur akun; juga tersedia pengaturan terenkripsi melalui UI |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Opsional dan berbayar; bukan syarat mode template gratis |

Hosting saat ini memakai Vercel tanpa build frontend, default handler `server.js`, dan `maxDuration` sesuai `vercel.json`. Perubahan env hosting memerlukan deployment ulang. Jangan deploy atau push hanya karena pengujian lokal lulus; ikuti permintaan pengguna dan ingat push ke branch produksi dapat memicu deploy otomatis.

## Alur kerja agent dan verifikasi

1. Baca file yang terkait tugas, periksa `git status`, dan cari implementasi serupa sebelum mengubah kode.
2. Bedakan kebutuhan produk, perilaku kode saat ini, dan status layanan live. Riwayat percakapan/screenshot bukan bukti kondisi produksi sekarang.
3. Buat perubahan terkecil yang menyelesaikan tugas; pertahankan key state, kontrak endpoint, dan kompatibilitas template yang tersimpan.
4. Untuk perubahan perilaku, tambahkan pengujian terarah memakai `node:test`/`node:assert` atau harness terisolasi dengan fake dependency. Jangan memanggil Markaz, Telegram, Anthropic, atau Blob produksi secara tidak sengaja.
5. Periksa sintaks file JavaScript yang berubah dengan `node --check <file>`.
6. Jalankan tes relevan dan smoke test demo bila perilaku runtime berubah. Perubahan dokumentasi saja cukup diperiksa isi, referensi, dan diff.
7. Untuk UI, periksa desktop dan HP, interaksi keyboard, tema terang/gelap yang terpengaruh, serta error request.
8. Laporkan perubahan, verifikasi yang benar-benar dijalankan, dan keterbatasan yang masih ada. Jangan menyatakan deploy/pengiriman berhasil tanpa bukti.

`npm test` menjalankan pengujian dengan `node --test`; di PowerShell dengan kebijakan script terbatas gunakan `npm.cmd test`. Belum ada script build atau lint di `package.json`. Jangan melaporkan perintah yang tidak tersedia atau tidak dijalankan sebagai lulus. Tes tertentu dapat dijalankan dengan `node --test tests/<file>.test.js`.

Contoh pemeriksaan sintaks:

```powershell
node --check server.js
node --check agent.js
node --check all-insight.js
node --check tg-account.js
node --check web/app.js
node --check web/agent-ui.js
```

Pilih kasus uji sesuai perubahan: closing lintas hari/bulan, tahun kabisat, transaksi duplikat, orang membeli setelah periode filter, identitas lintas platform, pembanding gagal dimuat, diskon plus biaya admin, template All/per platform yang terpisah, target nol/tercapai, data historis parsial, autentikasi, atau cron berulang. Gunakan fixture sintetis, bukan data pribadi customer.

Gunakan commit yang jelas jika diminta. Jangan mengubah file lain, dependency, konfigurasi global, secret, atau data produksi di luar kebutuhan tugas.
