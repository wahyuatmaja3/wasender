# WhatsApp API Server

Aplikasi REST API untuk mengirim pesan WhatsApp menggunakan [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys).

## Prasyarat

- **Node.js** v18 atau lebih baru → [Download](https://nodejs.org)
- Koneksi internet aktif
- Akun WhatsApp aktif di HP

## Instalasi

```powershell
cd D:\project\Baileys
npm install
```

## Menjalankan Server

```powershell
npm start
```

Server berjalan di port **3780**. Buka browser ke `http://localhost:3780` untuk login dan melihat dashboard.

## Login WhatsApp

1. Jalankan `npm start`
2. Buka `http://localhost:3780` di browser
3. Scan QR code dengan WhatsApp di HP:  
   **Menu (⋮) → Perangkat Tertaut → Tautkan Perangkat**
4. Setelah terhubung, API siap digunakan

> Session tersimpan otomatis di folder `auth_info_baileys/`. Tidak perlu scan ulang setelah restart.

---

## Penggunaan API

### Kirim Pesan Teks

```
GET http://HOST:3780/?Penerima=628123456789@c.us&Pesan=Halo+World
```

### Kirim File / Gambar / Dokumen

```
GET http://HOST:3780/?Penerima=628123456789@c.us&Pesan=Caption&File=D:\dokumen.pdf
```

### Parameter

| Parameter | Wajib | Keterangan |
|-----------|-------|------------|
| `Penerima` | ✅ | Nomor WA tujuan, format: `628123456789@c.us` |
| `Pesan` | ✅* | Teks pesan (atau caption jika File diisi) |
| `File` | ❌ | Path absolut file di server. Jika kosong → kirim pesan teks |

> *Minimal salah satu dari `Pesan` atau `File` harus diisi.

### Contoh Response Sukses

```json
{
  "success": true,
  "message": "Pesan berhasil dikirim",
  "detail": {
    "jid": "628123456789@c.us",
    "type": "text"
  }
}
```

### Contoh Response Error

```json
{
  "success": false,
  "error": "WhatsApp belum terhubung"
}
```

---

## Endpoint Lain

| Endpoint | Keterangan |
|----------|------------|
| `GET /status` | Status koneksi WhatsApp (JSON) |
| `GET /qr` | QR code saat ini (data URL) |

## Format Nomor

Nomor bisa ditulis dalam berbagai format:
- `628123456789@c.us` ← format lengkap (direkomendasikan)
- `628123456789` ← tanpa suffix, ditambahkan otomatis
- `085730120813` ← dikonversi angka saja

## Menjalankan di Background (Windows)

Install PM2 untuk menjalankan server secara permanen:

```powershell
npm install -g pm2
pm2 start index.js --name whatsapp-api
pm2 save
pm2 startup
```
