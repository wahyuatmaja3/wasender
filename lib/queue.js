/**
 * lib/queue.js
 * Antrian pesan dengan random delay 15–60 detik antar pesan
 * agar terhindar dari ban WhatsApp.
 */

import { sendTextMessage, sendFileMessage } from './whatsapp.js';

// ── Antrian ──────────────────────────────────
const queue = [];   // [ { id, penerima, pesan, file, resolve, reject } ]
let processing = false;
let queueIdCounter = 1;

// Log antrian (50 item terakhir)
const history = [];

// ── Helper ───────────────────────────────────
function randomDelay(minSec = 15, maxSec = 60) {
    const ms = (Math.random() * (maxSec - minSec) + minSec) * 1000;
    return Math.round(ms);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function addHistory(item) {
    history.unshift(item);
    if (history.length > 50) history.pop();
}

// ── Proses antrian satu per satu ─────────────
async function processQueue() {
    if (processing) return;
    processing = true;

    try {
        while (queue.length > 0) {
            const job = queue.shift();
            // Update posisi semua item tersisa
            queue.forEach((j, i) => { j.position = i + 1; });

            console.log(`[QUEUE] 🚀 Memproses job #${job.id} → ${job.penerima}`);

            try {
                let result;
                if (job.file && job.file.trim() !== '') {
                    result = await sendFileMessage(job.penerima, job.file.trim(), job.pesan || '');
                } else {
                    result = await sendTextMessage(job.penerima, job.pesan);
                }

                addHistory({
                    id: job.id,
                    penerima: job.penerima,
                    pesan: (job.pesan || '').substring(0, 60),
                    file: job.file || null,
                    status: 'sent',
                    sentAt: new Date().toISOString(),
                });

                job.resolve({ success: true, message: 'Pesan berhasil dikirim', detail: result });
            } catch (err) {
                console.error(`[QUEUE] ❌ Job #${job.id} gagal:`, err.message);
                addHistory({
                    id: job.id,
                    penerima: job.penerima,
                    pesan: (job.pesan || '').substring(0, 60),
                    file: job.file || null,
                    status: 'failed',
                    error: err.message,
                    sentAt: new Date().toISOString(),
                });
                job.reject(err);
            }

            // Delay random sebelum pesan berikutnya (kecuali antrian sudah kosong)
            if (queue.length > 0) {
                const delayMs = randomDelay(15, 60);
                console.log(`[QUEUE] ⏳ Delay ${Math.round(delayMs / 1000)}s sebelum pesan berikutnya (sisa: ${queue.length})`);
                await sleep(delayMs);
            }
        }
    } finally {
        processing = false;
    }
}

// ── Tambahkan pesan ke antrian ────────────────
export function enqueue(penerima, pesan, file) {
    const id = queueIdCounter++;
    const position = queue.length + 1;

    // Estimasi waktu tunggu: setiap giliran ~37.5 detik rata-rata (15+60)/2
    const estimatedWaitSec = queue.length > 0
        ? Math.round(queue.length * ((15 + 60) / 2))
        : 0;

    const promise = new Promise((resolve, reject) => {
        queue.push({ id, penerima, pesan, file, position, resolve, reject });
    });

    console.log(`[QUEUE] ➕ Job #${id} ditambahkan. Posisi: ${position}. Estimasi tunggu: ${estimatedWaitSec}s`);

    // Tangkap rejection agar tidak crash (unhandled promise rejection)
    promise.catch(() => {});

    // Mulai proses (jika belum berjalan)
    processQueue();

    return { id, position, estimatedWaitSec, promise };
}

// ── Getter state ─────────────────────────────
export const getQueueLength = () => queue.length;
export const getQueueHistory = () => history;
export const isProcessing = () => processing;
export const getQueueList = () => queue.map(j => ({
    id: j.id,
    penerima: j.penerima,
    pesan: (j.pesan || '').substring(0, 60),
    file: j.file || null,
    position: j.position,
}));
