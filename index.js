require('./control/settings');
const {
default: makeWASocket,
prepareWAMessageMedia,
useMultiFileAuthState,
DisconnectReason,
fetchLatestBaileysVersion,
makeInMemoryStore,
jidDecode,
downloadContentFromMessage,
makeCacheableSignalKeyStore
} = require("@itsliaaa/baileys");
const pino = require('pino');
const readline = require("readline");
const fs = require('fs');
const chalk = require("chalk");
const { smsg, getBuffer, getSizeMedia } = require('./lib/myfunc');

process.on('unhandledRejection', (reason) => {
    console.error('[UNHANDLED REJECTION]', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT EXCEPTION]', err?.message || err);
});

const usePairingCode = true;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise(resolve => rl.question(text, resolve));

const store = makeInMemoryStore({ logger: pino({ level: 'silent' }) });

async function connectToWhatsApp() {
const { state, saveCreds } = await useMultiFileAuthState("./session");
const { version } = await fetchLatestBaileysVersion();

const sock = makeWASocket({
version,
printQRInTerminal: !usePairingCode,
browser: ["Ubuntu", "Chrome", "20.0.04"],
logger: pino({ level: 'silent' }),



getMessage: async (key) => {
    if (!key?.remoteJid || !key?.id) return undefined;
    try {
        const msg = await store.loadMessage(key.remoteJid, key.id);
        return msg?.message || undefined;
    } catch (e) {
        return undefined;
    }
},
auth: {
creds: state.creds,
keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
}
});

const client = sock
const conn = client

sock.decodeJid = (jid) => {
if (!jid) return jid
if (/:\d+@/gi.test(jid)) {
const decode = jidDecode(jid) || {}
return decode.user && decode.server ? decode.user + '@' + decode.server : jid
}
return jid
}

const groupMetadataCache = new Map();
const GROUP_CACHE_TTL = 5 * 60 * 1000;
const rawGroupMetadata = sock.groupMetadata.bind(sock);

sock.groupMetadata = async (jid) => {
    if (!jid || typeof jid !== 'string' || !jid.endsWith('@g.us')) return null;
    const now = Date.now();
    const cached = groupMetadataCache.get(jid);
    if (cached && (now - cached.timestamp < GROUP_CACHE_TTL)) {
        return cached.data;
    }

    try {
        const metadata = await rawGroupMetadata(jid);
        if (metadata) {
            groupMetadataCache.set(jid, {
                data: metadata,
                timestamp: now
            });
            if (groupMetadataCache.size > 250) {
                const oldest = groupMetadataCache.keys().next().value;
                groupMetadataCache.delete(oldest);
            }
        }
        return metadata;
    } catch (err) {
        if (cached && cached.data) {
            return cached.data;
        }
        return null;
    }
};

store.bind(sock.ev);

globalThis.__waStore = store;

if (usePairingCode && !sock.authState.creds.registered) {
    let pairingRequested = false;
    const requestCode = async () => {
        if (pairingRequested || sock.authState.creds.registered) return;
        try {
            const rawNumber = process.env.PAIRING_NUMBER || process.argv[2] || global.botNumber || '6283167054726';
            const phoneNumber = String(rawNumber).replace(/[^0-9]/g, '');
            if (!phoneNumber) {
                console.log(chalk.red("Nomor WhatsApp tidak ditemukan untuk pairing code!"));
                return;
            }
            console.log(chalk.yellow(`Meminta pairing code untuk nomor: ${phoneNumber}...`));
            let code;
            try {
                code = await sock.requestPairingCode(phoneNumber, "STENLYCL");
            } catch (e) {
                console.log(chalk.yellow(`Custom STENLYCL gagal (${e?.message || e}), coba kode otomatis...`));
                code = await sock.requestPairingCode(phoneNumber);
            }
            pairingRequested = true;
            console.log(chalk.bold.green("\n================================="));
            console.log(chalk.bold.blue("PAIRING CODE: ") + chalk.bold.white.bgBlue(` ${code} `));
            console.log(chalk.bold.green("=================================\n"));
            console.log(chalk.yellow("Buka WhatsApp > Perangkat Tertaut > Tautkan Perangkat > masukkan kode di atas."));
        } catch (err) {
            console.error(chalk.red("Gagal meminta pairing code:"), err?.message || err);
            setTimeout(requestCode, 10000);
        }
    };
    // Minta kode saat socket sudah connecting/open, bukan buta 4 detik.
    // Retry otomatis sampai berhasil / sampai terdaftar.
    sock.ev.on('connection.update', ({ connection }) => {
        if ((connection === 'connecting' || connection === 'open') && !pairingRequested) {
            setTimeout(requestCode, 2000);
        }
    });
    setTimeout(requestCode, 8000);
}

sock.ev.on('messages.upsert', async ({ messages }) => {
try {
    if (!Array.isArray(messages)) return;
    for (const mek of messages) {
        if (!mek.message) continue;
        if (mek.key?.fromMe) continue;
        if (mek.key.remoteJid === 'status@broadcast') continue;

        try {
            const { isBotBanned } = require('./lib/banned_bot');
            const rawSender = mek.key.participant || mek.key.remoteJid || '';
            const rawNum = String(rawSender).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
            if (rawSender && isBotBanned(rawSender, rawNum)) continue;
        } catch (_) {}

        let m;
        try { m = smsg(sock, mek, store); }
        catch (error) {
            console.error('[WA MESSAGE NORMALIZE ERROR]', error?.stack || error);
            continue;
        }
        if (!m) continue;

        // TOTAL BAN lapis 2: cek ulang setelah smsg (sender ter-resolve LID/PN).
        try {
            const { isBotBanned } = require('./lib/banned_bot');
            const candidates = [m.sender, m.key?.participant].filter(Boolean);
            let isBanned = false;
            for (const c of candidates) {
                const cNum = String(c).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
                if (isBotBanned(c, cNum)) { isBanned = true; break; }
            }
            if (isBanned) continue;
        } catch (_) {}

        const ownerNumbers = (global.owner || []).map(value => String(value).replace(/\D/g, '')).filter(Boolean);
        const senderJids = [m.sender, mek.key?.participant, mek.key?.remoteJid].filter(Boolean).map(value => String(value).replace(/:\d+(?=@)/, ''));
        let resolvedSender = m.sender;
        for (const candidate of senderJids) {
            if (!candidate.endsWith('@lid') || !sock?.signalRepository?.lidMapping?.getPNForLID) continue;
            try {
                const phoneJid = await sock.signalRepository.lidMapping.getPNForLID(candidate);
                if (phoneJid) { resolvedSender = String(phoneJid).replace(/:\d+(?=@)/, ''); break; }
            } catch (error) {
                console.warn('[OWNER AUTH] LID-to-PN resolution failed:', error?.message || error);
            }
        }
        const senderNumber = resolvedSender.split('@')[0].replace(/\D/g, '');
        const isCreator = senderJids.includes(String(sock?.user?.id || '').replace(/:\d+(?=@)/, '')) || ownerNumbers.some(number =>
            (resolvedSender.endsWith('@s.whatsapp.net') && senderNumber === number) ||
            (m.senderNumber && String(m.senderNumber).replace(/\D/g, '') === number)
        );
        const isOwner = (() => {
            try {
                const owners = JSON.parse(fs.readFileSync('./lib/database/owner.json', 'utf8'));
                return Array.isArray(owners) && owners.some(value => {
                    const jid = String(value || '').replace(/:\d+(?=@)/, '');
                    if (jid === m.sender) return true;
                    const number = jid.split('@')[0].replace(/\D/g, '');
                    return Boolean(number && m.senderNumber && number === String(m.senderNumber).replace(/\D/g, ''));
                });
            } catch (_) { return false; }
        })();

        // Jika mode self aktif:
        // Di Private Chat (PC): abaikan pesan non-creator.
        // Di Grup (@g.us): tetap lanjutkan ke stenly.js agar hook moderasi (antiforward, antilink) tetap berjalan!
        const isGroupChat = String(m.chat || mek.key.remoteJid || '').endsWith('@g.us');
        if (!sock.public && !mek.key.fromMe && !isCreator && !isGroupChat) continue;

        const incomingText = String(m.text || m.message?.conversation || m.message?.extendedTextMessage?.text || '').trim();
        if (incomingText.startsWith(global.prefix || '/')) {
            console.log(`[WA COMMAND IN] chat=${m.chat} sender=${m.sender} owner=${isCreator || isOwner} text=${JSON.stringify(incomingText.slice(0, 100))}`);
        }

        if (mek.key.id.startsWith('BAE5') && mek.key.id.length === 16) continue;
        if (mek.key.id.startsWith('Stenly')) continue;

        try {

            await require("./stenly")(sock, m, null, store, { isCreator, isOwner });
        } catch (error) {
            console.error('[WA MESSAGE DISPATCH ERROR]', error?.stack || error);
        }
    }
} catch (e) {
    console.error('[WA UPSERT ERROR]', e?.stack || e);
}
});

sock.public = true

sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
if (qr) console.log(chalk.yellow("[WA] QR diterima (scan untuk pairing ulang)."));
if (connection === 'connecting') console.log(chalk.cyan("[WA] Menghubungkan ke WhatsApp..."));
if (connection === 'open') {
console.log(chalk.green("==> BOT BERHASIL TERHUBUNG KE WHATSAPP! <=="));

try {
    const { startOutboundServer } = require('./lib/outbound_server');
    startOutboundServer(sock);
} catch (e) {
    console.error("Gagal start Outbound server:", e.message);
}
try {
    const { startScheduleWatcher } = require('./lib/group_manager');
    startScheduleWatcher(sock);
} catch (e) {
    console.error("Gagal start Schedule Watcher:", e.message);
}
}
if (connection === 'close') {

try {
    const { stopOutboundServer } = require('./lib/outbound_server');
    stopOutboundServer();
} catch (_) {}
try {
    const { stopScheduleWatcher } = require('./lib/group_manager');
    stopScheduleWatcher();
} catch (_) {}
console.log(chalk.yellow("Koneksi terputus:"), lastDisconnect?.error?.message || lastDisconnect?.error);
const statusCode = lastDisconnect?.error?.output?.statusCode;
const errMsg = String(lastDisconnect?.error?.message || '');
const isConflict = errMsg.toLowerCase().includes('conflict');
const isConnFailure = errMsg.toLowerCase().includes('connection');
const isRealLogout = statusCode === DisconnectReason.loggedOut && !isConflict && !isConnFailure;

if (!isRealLogout) {
    console.log(chalk.cyan(`[WA] Mencoba menyambung kembali dalam 5 detik (status: ${statusCode || 'none'})...`));
    setTimeout(() => {
        connectToWhatsApp();
    }, 5000);
} else {
    console.log(chalk.red("[WA] Sesi telah logout permanen. Silakan pairing ulang."));
}
}
});

sock.ev.on('creds.update', saveCreds);
}

connectToWhatsApp();
