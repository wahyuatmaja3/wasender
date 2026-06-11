import express from 'express';
import path from 'path';
import cors from 'cors';
import { fileURLToPath } from 'url';
import {
    getStatus,
    getQR,
    getConnectedNumber,
} from './whatsapp.js';
import {
    enqueue,
    getQueueLength,
    getQueueList,
    getQueueHistory,
    isProcessing,
} from './queue.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors()); // Allow all origins

// Tambahkan body parser agar bisa menerima POST request (JSON atau Form)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// ─────────────────────────────────────────────
//  GET /
//  Endpoint utama kirim pesan via query string
//
//  ?Penerima=6281234@c.us  ← wajib
//  ?Pesan=Halo             ← teks / caption
//  ?File=D:\file.pdf       ← path file lokal (opsional)
//
//  Pesan masuk ke ANTRIAN dan dikirim dengan delay
//  random 15–60 detik antar pesan (anti-ban).
//
//  Response langsung (tidak menunggu pesan dikirim):
//   { success, status:"queued", id, position, estimatedWaitSec }
//
//  PENTING: route ini SEBELUM express.static
// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
app.all('/', async (req, res) => {
    // Parsing manual URL mentah untuk meng-handle Delphi 5 (tidak ada URL encode spasi & unik)
    // yang kadang digagalkan/dihancurkan oleh req.query bawaan Express
    let urlRaw = req.originalUrl || req.url;
    let queryIndex = urlRaw.indexOf('?');

    let Penerima = req.body.Penerima;
    let Pesan = req.body.Pesan;
    let File = req.body.File;
    let PesanGrup = req.body.PesanGrup;
    let Files = []; // Array untuk multiple files

    // Jika ada Query String, parsing secara manual:
    if (queryIndex !== -1 && req.method === 'GET') {
        let queryString = urlRaw.substring(queryIndex + 1);
        let pairs = queryString.split('&');
        for (let pair of pairs) {
            let eqIndex = pair.indexOf('=');
            if (eqIndex === -1) continue;
            let key = pair.substring(0, eqIndex);
            let val = pair.substring(eqIndex + 1);

            // Decode value (menghindari persen, dan mempertahankan spasi mentah)
            try { val = decodeURIComponent(val); } catch (e) { }

            if (key === 'Penerima') Penerima = val;
            if (key === 'Pesan') Pesan = val;
            if (key === 'File') {
                if (!File) File = val; // Backward compatibility: first File becomes main File
                Files.push(val); // Add all Files to array
            }
            if (key === 'PesanGrup') PesanGrup = val;
        }
    } else if (req.method === 'GET') {
        // fallback
        Penerima = Penerima || req.query.Penerima;
        Pesan = Pesan || req.query.Pesan;
        File = File || req.query.File;
        // Handle multiple files in query
        if (req.query.File) {
            Files = Array.isArray(req.query.File) ? req.query.File : [req.query.File];
        }
    } else if (req.method === 'POST') {
        // Handle POST body - support both single and array
        if (req.body.File) {
            Files = Array.isArray(req.body.File) ? req.body.File : [req.body.File];
        }
    }

    // Replace literal '\n' string to actual newline character for Delphi compatibility
    if (Pesan && typeof Pesan === 'string') {
        Pesan = Pesan.replace(/\\n/g, '\n');
    }

    // Tidak ada parameter → tampilkan dashboard HTML (hanya jika GET)
    if (!Penerima && !Pesan && !File && Files.length === 0 && req.method === 'GET') {
        return res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
    }

    if (!Penerima) {
        return res.status(400).json({ success: false, error: 'Parameter "Penerima" wajib diisi.' });
    }
    if (!Pesan && !File && Files.length === 0) {
        return res.status(400).json({ success: false, error: 'Parameter "Pesan" atau "File" wajib diisi.' });
    }
    if (getStatus() !== 'connected') {
        return res.status(503).json({ success: false, error: 'WhatsApp belum terhubung.' });
    }

    // Normalkan path file (hindari double backslash dari URL encoding)
    // File dan Files sudah di-decode di parsing manual, jadi tidak perlu decode lagi
    const cleanFile = File ? File.replace(/\\{2,}/g, '\\') : '';
    
    // Normalkan multiple files
    const cleanFiles = Files.length > 0 
        ? Files.map(f => f.replace(/\\{2,}/g, '\\'))
        : (cleanFile ? [cleanFile] : []);

    // Masukkan ke antrian – response langsung tanpa menunggu dikirim
    const { id, position, estimatedWaitSec } = enqueue(Penerima, Pesan || '', cleanFile, cleanFiles);

    return res.json({
        success: true,
        status: 'queued',
        message: position === 1
            ? 'Pesan sedang dikirim…'
            : `Pesan masuk antrian posisi #${position}`,
        id,
        position,
        estimatedWaitSec,
        queueLength: getQueueLength(),
    });
});

// GET /status  – status koneksi WA
app.get('/status', (_req, res) => {
    res.json({
        status: getStatus(),
        number: getConnectedNumber(),
        hasQR: !!getQR(),
        queueLength: getQueueLength(),
        processing: isProcessing(),
    });
});

// GET /qr  – QR code (data URL)
app.get('/qr', (_req, res) => {
    const qr = getQR();
    if (!qr) return res.status(404).json({ success: false, error: 'QR code tidak tersedia.' });
    res.json({ success: true, qr });
});

// GET /queue  – daftar antrian + history
app.get('/queue', (_req, res) => {
    res.json({
        processing: isProcessing(),
        pending: getQueueList(),
        history: getQueueHistory(),
    });
});

// Serve static assets (SETELAH semua route)
app.use(express.static(path.join(__dirname, '..', 'public')));

export function startServer(port) {
    app.listen(port, '0.0.0.0', () => {
        console.log(`[API] ✅ Server berjalan di http://0.0.0.0:${port}`);
        console.log(`[API] 🌐 Dashboard  : http://localhost:${port}`);
        console.log(`[API] ✉️  Kirim teks : http://localhost:${port}/?Penerima=...&Pesan=...`);
        console.log(`[API] 📎  Kirim file : http://localhost:${port}/?Penerima=...&Pesan=caption&File=D:\\file.pdf`);
        console.log(`[API] 📋  Antrian   : http://localhost:${port}/queue`);
    });
}
