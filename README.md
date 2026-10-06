# Presensi Karyawan

Aplikasi absensi internal:

- **HP karyawan** (`/`): PWA yang dipasang lewat "Tambahkan ke Layar Utama", tanpa Play Store atau App Store. Karyawan absen masuk/pulang dengan GPS dan selfie. Absen di luar radius kantor wajib diberi keterangan dan disetujui atasan.
- **Dashboard HRD** (`/admin`): ringkasan hari ini, peta titik absen, persetujuan luar kantor, rekap dan export Excel, kelola karyawan (import Excel, registrasi mandiri, reset PIN/HP), divisi dan jadwal kerja, lokasi kantor, serta libur nasional.

Server ditulis dengan Node.js tanpa dependency: hanya `http` dan `node:sqlite` bawaan, jadi tidak perlu `npm install`. Database dan foto disimpan di folder `data/`.

## Menjalankan di laptop

Butuh **Node.js 22.13 atau lebih baru**.

```bash
npm start
```

Atau klik dua kali `run.bat` di Windows.

- Karyawan: http://localhost:3000/
- Dashboard: http://localhost:3000/admin

Saat pertama kali jalan, password admin dibuat acak. Password itu dicetak di terminal dan disimpan di `data/ADMIN_PASSWORD.txt`. Ganti lewat menu **Pengaturan**; setelah diganti, file tersebut otomatis dihapus. Kalau ingin menentukan password awal sendiri, isi env `ADMIN_PASSWORD`.

| Env | Default | Keterangan |
| --- | --- | --- |
| `PORT` | `3000` | Port server |
| `DATA_DIR` | `./data` | Lokasi database + foto |
| `ADMIN_PASSWORD` | acak | Password admin pertama (hanya dipakai saat database baru) |

## Langkah awal di dashboard

1. **Pengaturan → Lokasi kantor:** tambahkan Kantor dan Workshop. Tempel koordinat dari Google Maps (klik kanan titik → klik angka koordinat), lalu atur radiusnya.
2. **Pengaturan → Divisi:** atur jam masuk/pulang, hari kerja, dan atasan tiap divisi.
3. **Karyawan → Import Excel:** unduh template, isi, lalu unggah. PIN 4 angka dibuat otomatis; kirim ke tiap orang lewat tombol **Kirim via WA**, atau unduh daftar PIN dalam bentuk Excel.
4. **Pengaturan → Link untuk karyawan:** bagikan link atau QR code ke grup WhatsApp. Karyawan baru bisa mendaftar sendiri pakai **kode perusahaan**, lalu HRD menyetujuinya di tab Karyawan.

## Aturan

- Waktu dan tanggal selalu diambil dari jam server, bukan jam HP.
- Telat = jam masuk lewat dari jam masuk divisi, tanpa toleransi.
- Di luar radius semua lokasi kantor → wajib isi keterangan dan berstatus *menunggu*. Atasan divisi menyetujui dari HP; HRD bisa menyetujui dari dashboard. Kalau ditolak, hari itu dihitung tidak hadir.
- Sabtu/Minggu (sesuai hari kerja divisi) dan libur nasional tetap bisa absen, tapi ditandai "Masuk hari libur". Fitur lembur belum ada (rencana v2).
- Salah PIN 5 kali → akun terkunci sampai dibuka HRD. Satu akun hanya bisa dipakai di satu HP; kalau ganti HP, HRD klik **Reset HP**.

## Deploy ke VPS

Kamera, GPS, dan pemasangan PWA **wajib HTTPS**. Contoh di Ubuntu dengan Caddy, yang mengurus sertifikat HTTPS gratis secara otomatis:

```bash
# 1. Node.js 22 + Caddy
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs caddy git

# 2. Kode aplikasi
sudo useradd -r -m -d /opt/presensi presensi
sudo -u presensi git clone https://github.com/rezaismailh/presensikaryawan.git /opt/presensi/app

# 3. Service (lihat deploy/presensi.service)
sudo cp /opt/presensi/app/deploy/presensi.service /etc/systemd/system/
sudo systemctl enable --now presensi
sudo journalctl -u presensi | grep "Password admin"   # password admin awal

# 4. HTTPS (lihat deploy/Caddyfile, ganti domainnya)
sudo cp /opt/presensi/app/deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

**Domain belum ada?** Untuk uji coba bisa memakai `<IP-VPS>.sslip.io` di Caddyfile (contoh `103.10.20.30.sslip.io`). Alamat ini gratis dan tetap dapat HTTPS. Pasang domain resmi **sebelum** dibagikan ke semua karyawan, karena ikon di HP terikat ke alamat; kalau alamat berganti, semua orang harus memasang ulang ikonnya.

**Update aplikasi:**

```bash
cd /opt/presensi/app && sudo -u presensi git pull && sudo systemctl restart presensi
```

**Backup harian:** cukup salin folder `/opt/presensi/app/data` (berisi `absensi.db` dan `photos/`), misalnya lewat snapshot VPS atau cron `rsync`.

## Uji coba di HP tanpa VPS

Pakai [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/) gratis untuk mendapat alamat HTTPS sementara ke laptop:

```bash
npm start
cloudflared tunnel --url http://localhost:3000
```

Buka alamat `https://….trycloudflare.com` yang muncul di HP. Alamat ini berubah setiap kali dijalankan, jadi hanya untuk tes.

## Struktur

```
server.js              server + API + database (SQLite)
public/index.html      aplikasi HP (PWA)
public/app.js
public/admin.html      dashboard HRD
public/admin.js
public/style.css       gaya bersama (light/dark)
public/sw.js           service worker
public/manifest.webmanifest
public/icons/          ikon (PNG dibuat dengan `npm run icons`)
deploy/                contoh systemd service + Caddyfile
data/                  database + foto (tidak masuk git)
```

Library yang dimuat dari CDN hanya di dashboard, dan hanya saat dibutuhkan: Leaflet (peta), SheetJS (Excel), dan qrcodejs (QR).
