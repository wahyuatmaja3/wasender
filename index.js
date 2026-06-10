import { connectToWhatsApp } from './lib/whatsapp.js';
import { startServer } from './lib/server.js';

const PORT = process.env.PORT || 3780;

async function main() {
    console.log('====================================');
    console.log('  WhatsApp API Server - Baileys');
    console.log('====================================');

    await connectToWhatsApp();
    startServer(PORT);
}

main().catch(err => {
    console.error('Error fatal:', err);
    process.exit(1);
});
