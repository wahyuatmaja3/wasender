import {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    downloadMediaMessage,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode';
import path from 'path';
import fs from 'fs';
import mime from 'mime-types';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ──────────────────────────────────────────
//  State global
// ──────────────────────────────────────────
let sock = null;
let qrCodeData = null;
let connectionStatus = 'disconnected'; // 'disconnected'|'connecting'|'qr'|'connected'
let connectedNumber = null;

// ──────────────────────────────────────────
//  Koneksi ke WhatsApp
// ──────────────────────────────────────────
export async function connectToWhatsApp() {
    const { version } = await fetchLatestBaileysVersion();
    const authDir = path.join(__dirname, '..', 'auth_info_baileys');
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const logger = pino({ level: 'silent' });

    sock = makeWASocket({
        version,
        logger,
        auth: state,
        printQRInTerminal: true,
        generateHighQualityLinkPreview: false,
        browser: ['WhatsApp API', 'Chrome', '120.0'],
        // Tambahan untuk memastikan enkripsi lebih stabil
        getMessage: async (key) => {
            // Return undefined agar tidak ada masalah dengan history
            return undefined;
        },
        // Tingkatkan timeout untuk upload file
        defaultQueryTimeoutMs: 60000, // 60 detik
        // Opsi tambahan untuk stabilitas
        syncFullHistory: false,
        markOnlineOnConnect: true,
    });

    // ── Simpan credentials ──
    sock.ev.on('creds.update', saveCreds);

    // ── Update koneksi ──
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            connectionStatus = 'qr';
            qrCodeData = await qrcode.toDataURL(qr);
            console.log('[WA] QR diperbarui – buka http://localhost:3780 untuk scan');
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`[WA] Koneksi terputus (kode: ${statusCode}). Reconnect: ${shouldReconnect}`);
            connectionStatus = 'disconnected';
            connectedNumber = null;

            if (shouldReconnect) {
                console.log('[WA] Reconnect dalam 3 detik…');
                setTimeout(() => connectToWhatsApp(), 3000);
            } else {
                console.log('[WA] Logged out. Menghapus sesi lama…');
                try { fs.rmSync(authDir, { recursive: true, force: true }); } catch (_) { }
                setTimeout(() => connectToWhatsApp(), 2000);
            }
        }

        if (connection === 'open') {
            connectionStatus = 'connected';
            qrCodeData = null;
            connectedNumber = sock.user?.id ?? null;
            console.log(`[WA] ✅ Terhubung sebagai: ${connectedNumber}`);
        }

        if (connection === 'connecting') {
            connectionStatus = 'connecting';
            console.log('[WA] Connecting…');
        }
    });

    // ── Pesan masuk (opsional) ──
    sock.ev.on('messages.upsert', ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            if (!msg.key.fromMe) {
                const from = msg.key.remoteJid;
                const body = msg.message?.conversation
                    || msg.message?.extendedTextMessage?.text
                    || '';
                if (body) console.log(`[WA] ↩  Pesan dari ${from}: ${body}`);
            }
        }
    });
}

// ──────────────────────────────────────────
//  Normalisasi nomor jadi JID
// ──────────────────────────────────────────
function normalizeJid(number) {
    if (!number) throw new Error('Nomor penerima tidak boleh kosong');
    let jid = number.trim();
    if (!jid.includes('@')) jid = jid.replace(/\D/g, '') + '@c.us';
    return jid;
}

// ──────────────────────────────────────────
//  Helper: Cek apakah ada session dengan nomor
// ──────────────────────────────────────────
async function ensureSession(jid) {
    try {
        // Coba ambil info user untuk memastikan session aktif
        const exists = await sock.onWhatsApp(jid);
        if (!exists || exists.length === 0) {
            throw new Error(`Nomor ${jid} tidak terdaftar di WhatsApp`);
        }
        return true;
    } catch (error) {
        console.log(`[WA] ⚠️  Session check warning: ${error.message}`);
        // Lanjutkan saja, biarkan Baileys handle
        return true;
    }
}

// ──────────────────────────────────────────
//  Helper: Retry mechanism untuk pengiriman
// ──────────────────────────────────────────
async function sendWithRetry(jid, content, maxRetries = 3, delayMs = 2000, isFile = false) {
    let lastError;
    
    // Untuk file besar, gunakan retry lebih banyak dan delay lebih lama
    if (isFile) {
        maxRetries = 5;
        delayMs = 3000;
    }
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            // Cek apakah masih terhubung
            if (connectionStatus !== 'connected') {
                throw new Error('WhatsApp terputus saat mengirim pesan');
            }
            
            // Kirim pesan
            const result = await sock.sendMessage(jid, content);
            
            if (isFile) {
                console.log(`[WA] ✅  File berhasil dikirim pada percobaan ke-${attempt}`);
            }
            
            return result;
        } catch (error) {
            lastError = error;
            console.log(`[WA] ⚠️  Percobaan ${attempt}/${maxRetries} gagal: ${error.message}`);
            
            // Jika bukan percobaan terakhir, tunggu sebelum retry
            if (attempt < maxRetries) {
                const waitTime = isFile ? delayMs * attempt : delayMs; // Exponential backoff untuk file
                console.log(`[WA] 🔄  Retry dalam ${waitTime}ms...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }
        }
    }
    
    // Jika semua percobaan gagal
    throw new Error(`Gagal mengirim pesan setelah ${maxRetries} percobaan: ${lastError.message}`);
}

// ──────────────────────────────────────────
//  Kirim pesan teks
// ──────────────────────────────────────────
export async function sendTextMessage(number, text) {
    if (connectionStatus !== 'connected') throw new Error('WhatsApp belum terhubung');
    const jid = normalizeJid(number);
    
    // Pastikan session ada
    await ensureSession(jid);
    
    await sendWithRetry(jid, { text });
    console.log(`[WA] ✉️  Teks terkirim ke ${jid}`);
    return { jid, type: 'text' };
}

// ──────────────────────────────────────────
//  Kirim file dari path lokal
// ──────────────────────────────────────────
export async function sendFileMessage(number, filePath, caption) {
    if (connectionStatus !== 'connected') throw new Error('WhatsApp belum terhubung');

    const jid = normalizeJid(number);

    // Pastikan session ada
    await ensureSession(jid);

    // Jika filePath bukan path absolut, atur relatif terhadap root folder
    let finalPath = filePath;
    if (!path.isAbsolute(filePath)) {
        if (filePath.toLowerCase().startsWith('pdf/') || filePath.toLowerCase().startsWith('pdf\\')) {
            finalPath = path.join(__dirname, '..', filePath);
        } else {
            finalPath = path.join(__dirname, '..', 'PDF', filePath);
        }
    }

    const resolvedPath = path.resolve(finalPath);

    if (!fs.existsSync(resolvedPath)) {
        throw new Error(`File tidak ditemukan: ${resolvedPath}`);
    }

    const mimeType = mime.lookup(resolvedPath) || 'application/octet-stream';
    const filename = path.basename(resolvedPath);
    const fileStats = fs.statSync(resolvedPath);
    const fileSizeMB = (fileStats.size / (1024 * 1024)).toFixed(2);
    
    console.log(`[WA] 📦  Memproses file: ${filename} (${fileSizeMB} MB)`);

    // Baca file sebagai buffer untuk file besar
    const fileBuffer = fs.readFileSync(resolvedPath);

    if (mimeType.startsWith('image/')) {
        await sendWithRetry(jid, { 
            image: fileBuffer, 
            caption: caption || '', 
            mimetype: mimeType 
        }, 5, 3000, true);
        console.log(`[WA] 🖼️  Gambar terkirim ke ${jid}: ${filename}`);
    } else if (mimeType.startsWith('video/')) {
        await sendWithRetry(jid, { 
            video: fileBuffer, 
            caption: caption || '', 
            mimetype: mimeType 
        }, 5, 3000, true);
        console.log(`[WA] 🎥  Video terkirim ke ${jid}: ${filename}`);
    } else if (mimeType.startsWith('audio/')) {
        await sendWithRetry(jid, { 
            audio: fileBuffer, 
            mimetype: mimeType, 
            ptt: false 
        }, 5, 3000, true);
        console.log(`[WA] 🎵  Audio terkirim ke ${jid}: ${filename}`);
    } else {
        // Untuk dokumen (PDF, dll)
        const msg = {
            document: fileBuffer,
            mimetype: mimeType,
            fileName: filename,
        };
        if (caption) msg.caption = caption;

        await sendWithRetry(jid, msg, 5, 3000, true);
        console.log(`[WA] 📄  Dokumen terkirim ke ${jid}: ${filename}`);
    }

    return { jid, type: 'file', filename, mimeType, sizeMB: fileSizeMB };
}

// ──────────────────────────────────────────
//  Getter state
// ──────────────────────────────────────────
export const getStatus = () => connectionStatus;
export const getQR = () => qrCodeData;
export const getConnectedNumber = () => connectedNumber;
