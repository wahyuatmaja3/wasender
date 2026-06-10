import {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
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
//  Kirim pesan teks
// ──────────────────────────────────────────
export async function sendTextMessage(number, text) {
    if (connectionStatus !== 'connected') throw new Error('WhatsApp belum terhubung');
    const jid = normalizeJid(number);
    await sock.sendMessage(jid, { text });
    console.log(`[WA] ✉️  Teks terkirim ke ${jid}`);
    return { jid, type: 'text' };
}

// ──────────────────────────────────────────
//  Kirim file dari path lokal
// ──────────────────────────────────────────
export async function sendFileMessage(number, filePath, caption) {
    if (connectionStatus !== 'connected') throw new Error('WhatsApp belum terhubung');

    const jid = normalizeJid(number);

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

    if (mimeType.startsWith('image/')) {
        await sock.sendMessage(jid, { image: { url: resolvedPath }, caption: caption || '', mimetype: mimeType });
        console.log(`[WA] 🖼️  Gambar terkirim ke ${jid}: ${filename}`);
    } else if (mimeType.startsWith('video/')) {
        await sock.sendMessage(jid, { video: { url: resolvedPath }, caption: caption || '', mimetype: mimeType });
        console.log(`[WA] 🎥  Video terkirim ke ${jid}: ${filename}`);
    } else if (mimeType.startsWith('audio/')) {
        await sock.sendMessage(jid, { audio: { url: resolvedPath }, mimetype: mimeType, ptt: false });
        console.log(`[WA] 🎵  Audio terkirim ke ${jid}: ${filename}`);
    } else {
        const msg = {
            document: { url: resolvedPath },
            mimetype: mimeType,
            fileName: filename,
        };
        if (caption) msg.caption = caption;

        await sock.sendMessage(jid, msg);
        console.log(`[WA] 📄  Dokumen terkirim ke ${jid}: ${filename}`);
    }

    return { jid, type: 'file', filename, mimeType };
}

// ──────────────────────────────────────────
//  Getter state
// ──────────────────────────────────────────
export const getStatus = () => connectionStatus;
export const getQR = () => qrCodeData;
export const getConnectedNumber = () => connectedNumber;
