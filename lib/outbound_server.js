const http = require('http');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const groupManager = require('./group_manager');

const PORT = 5680;
const HOST = '0.0.0.0';

let serverInstance = null;
let currentSock = null;

function normalizeJid(phone) {
    if (!phone) return "";
    let str = String(phone).trim();
    if (str.endsWith('@s.whatsapp.net') || str.endsWith('@g.us')
        || str.endsWith('@lid') || str.endsWith('@broadcast') || str.endsWith('@newsletter')) {
        return str;
    }
    const digits = str.replace(/[^0-9]/g, "");
    if (!digits) return "";
    return (digits.startsWith("0") ? `62${digits.slice(1)}` : digits) + "@s.whatsapp.net";
}




function lidDigitsFrom(value) {
    if (!value) return "";
    const s = String(value);
    const head = s.split('@')[0];
    const bare = head.split(':')[0];
    return bare.replace(/[^0-9]/g, "");
}

function lidFromSessionFile(pnDigits) {
    try {
        const fs = require('fs');
        const path = require('path');
        const file = path.join(__dirname, '..', 'session', `lid-mapping-${pnDigits}.json`);
        if (!fs.existsSync(file)) return "";
        const raw = fs.readFileSync(file, 'utf8').trim();
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch (_) { parsed = raw.replace(/"/g, ''); }
        if (typeof parsed === 'string') return lidDigitsFrom(parsed);
        if (parsed && typeof parsed === 'object') return lidDigitsFrom(parsed.lid || parsed.id || parsed.jid);
        return "";
    } catch (_) {
        return "";
    }
}

async function resolveTargetJid(sock, input) {
    const raw = String(input || '').trim();
    if (!raw) return "";
    if (raw.endsWith('@g.us') || raw.endsWith('@lid') || raw.endsWith('@broadcast') || raw.endsWith('@newsletter')) {
        return raw;
    }

    const pn = normalizeJid(raw);
    if (!pn) return "";
    const pnDigits = pn.split('@')[0];

    try {
        const lid = await sock?.signalRepository?.lidMapping?.getLIDForPN?.(pn);
        const digits = lidDigitsFrom(lid);
        if (digits) return `${digits}@lid`;
    } catch (_) {}

    const fromFile = lidFromSessionFile(pnDigits);
    if (fromFile) return `${fromFile}@lid`;

    return pn;
}

// Kirim ke LID dulu (alamat chat yang benar), fallback ke JID nomor kalau gagal.
async function sendMessageSmart(sock, input, content) {
    const primary = await resolveTargetJid(sock, input);
    const pn = normalizeJid(String(input || '').trim());
    try {
        const sent = await sock.sendMessage(primary, content);
        return { sent, jid: primary, usedLid: primary.endsWith('@lid') };
    } catch (err) {
        if (pn && pn !== primary) {
            const sent = await sock.sendMessage(pn, content);
            return { sent, jid: pn, usedLid: false, fallbackFrom: primary, error: err.message };
        }
        throw err;
    }
}

function cleanWhatsAppMarkdown(text) {
    if (!text || typeof text !== 'string') return '';
    let s = text.trim();
    s = s.replace(/^#{1,6}\s*(.+)$/gm, '*$1*');
    while (s.includes('**')) {
        const prev = s;
        s = s.replace(/\*\*(.*?)\*\*/g, '*$1*');
        if (s === prev) {
            s = s.replace(/\*\*/g, '*');
            break;
        }
    }
    s = s.replace(/^(halo+(\s+(mas|kak|pak|bu|bang|om|dek|teman|semuanya))?(\s+stenly)?[\s!,.-]*)+/i, '');
    s = s.trim();
    if (s.length > 0 && !s.startsWith('*') && !s.startsWith('-') && !s.startsWith('>')) {
        s = s.charAt(0).toUpperCase() + s.slice(1);
    }
    return s;
}

// ---------------------------------------------------------------------------
// Media bridge: image / video / audio / document / sticker
// ---------------------------------------------------------------------------

const MAX_MEDIA_BYTES = {
    image: 16 * 1024 * 1024,
    video: 16 * 1024 * 1024,
    audio: 16 * 1024 * 1024,
    sticker: 2 * 1024 * 1024,
    document: 100 * 1024 * 1024
};

const EXT_MIME = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
    '.gif': 'image/gif', '.bmp': 'image/bmp', '.heic': 'image/heic',
    '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
    '.webm': 'video/webm', '.avi': 'video/x-msvideo', '.3gp': 'video/3gpp',
    '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg; codecs=opus', '.opus': 'audio/ogg; codecs=opus',
    '.wav': 'audio/wav', '.aac': 'audio/aac', '.flac': 'audio/flac',
    '.pdf': 'application/pdf', '.zip': 'application/zip', '.txt': 'text/plain', '.md': 'text/markdown',
    '.js': 'text/javascript', '.json': 'application/json', '.csv': 'text/csv', '.html': 'text/html',
    '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.log': 'text/plain', '.yaml': 'text/yaml', '.yml': 'text/yaml', '.sh': 'text/x-shellscript'
};

const BLOCKED_MEDIA_PARTS = ['/session/', '/session_backup_', '/.pm2/', '/control/noppo.env', '/control/control_token'];

function inferKind(mimetype, ext) {
    const mt = String(mimetype || '').toLowerCase();
    if (mt.startsWith('image/')) return mt.includes('webp') ? 'image' : 'image';
    if (mt.startsWith('video/')) return 'video';
    if (mt.startsWith('audio/')) return 'audio';
    if (mt === 'image/webp' && ext === '.webp') return 'sticker';
    return 'document';
}

function guessMime(filePath, provided) {
    if (provided) return String(provided);
    return EXT_MIME[String(path.extname(filePath || '')).toLowerCase()] || 'application/octet-stream';
}

function assertReadableMediaPath(filePath) {
    const resolved = path.resolve(filePath);
    if (BLOCKED_MEDIA_PARTS.some(part => resolved.includes(part))) {
        throw new Error('Path kredensial/session diblokir untuk pengiriman media.');
    }
    if (!fs.existsSync(resolved)) throw new Error(`File tidak ditemukan: ${resolved}`);
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) throw new Error('Path bukan file.');
    if (stat.size === 0) throw new Error('File kosong.');
    return { resolved, size: stat.size };
}

async function loadMediaBuffer(data) {
    const filePath = data.filePath || data.path || data.file;
    if (filePath) {
        const { resolved, size } = assertReadableMediaPath(filePath);
        return { buffer: fs.readFileSync(resolved), size, source: 'file', filePath: resolved };
    }
    const url = data.url || data.mediaUrl;
    if (url) {
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            maxContentLength: MAX_MEDIA_BYTES.document,
            maxBodyLength: MAX_MEDIA_BYTES.document,
            timeout: 30000
        });
        const buffer = Buffer.from(response.data);
        return { buffer, size: buffer.length, source: 'url', filePath: path.basename(new URL(url).pathname) || 'download' };
    }
    const b64 = data.base64 || data.data || data.buffer;
    if (b64) {
        const raw = String(b64).replace(/^data:[^;]+;base64,/, '');
        const buffer = Buffer.from(raw, 'base64');
        if (!buffer.length) throw new Error('Base64 media tidak valid.');
        return { buffer, size: buffer.length, source: 'base64', filePath: data.fileName || 'upload' };
    }
    throw new Error('Sumber media wajib salah satu: filePath, url, atau base64.');
}

async function buildMediaContent(data) {
    const loaded = await loadMediaBuffer(data);
    const requestedKind = String(data.type || data.kind || '').toLowerCase().trim();
    const mimetype = guessMime(loaded.filePath, data.mimetype);
    let kind = requestedKind || inferKind(mimetype, path.extname(loaded.filePath || '').toLowerCase());
    if (!MAX_MEDIA_BYTES[kind]) throw new Error(`Tipe media tidak dikenal: ${kind}. Pilihan: image, video, audio, document, sticker.`);

    const cap = MAX_MEDIA_BYTES[kind];
    if (loaded.size > cap) {
        throw new Error(`Ukuran ${(loaded.size / 1024 / 1024).toFixed(1)} MB melebihi batas ${kind} (${(cap / 1024 / 1024).toFixed(0)} MB).`);
    }
    if (kind === 'sticker' && !String(mimetype).includes('webp')) {
        throw new Error('Sticker WhatsApp wajib WebP. Convert dulu (sharp/ffmpeg), lalu kirim ulang.');
    }

    const caption = data.caption ? cleanWhatsAppMarkdown(String(data.caption)) : undefined;
    const fileName = data.fileName || path.basename(loaded.filePath || 'file');

    let content;
    if (kind === 'image') content = { image: loaded.buffer, mimetype, caption };
    else if (kind === 'video') content = { video: loaded.buffer, mimetype, caption };
    else if (kind === 'audio') content = { audio: loaded.buffer, mimetype, ptt: data.ptt === true };
    else if (kind === 'sticker') content = { sticker: loaded.buffer };
    else content = { document: loaded.buffer, mimetype, fileName, caption };

    if (content.caption === undefined) delete content.caption;

    return { content, kind, mimetype, size: loaded.size, fileName, source: loaded.source };
}

function startOutboundServer(sock) {
    currentSock = sock;
    if (serverInstance) return;

    serverInstance = http.createServer((req, res) => {
        const url = req.url.split('?')[0];

        // CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            return res.end();
        }

        if (req.method === 'GET' && (url === '/' || url === '/health' || url === '/status')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                status: 'online',
                service: 'Stenly WhatsApp Outbound Bridge',
                botConnected: Boolean(currentSock?.user?.id),
                endpoints: ['/send', '/send-voice', '/send-media', '/group/status', '/group/control'],
                mediaTypes: ['image', 'video', 'audio', 'document', 'sticker'],
                timestamp: new Date().toISOString()
            }));
        }

        if (req.method === 'GET' && url === '/group/status') {
            const queryParams = new URL(req.url, `http://${req.headers.host}`).searchParams;
            const chat = queryParams.get('chat') || queryParams.get('groupId');
            if (!chat || !chat.endsWith('@g.us')) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: false, error: 'Query param "chat" with @g.us is required' }));
            }
            if (!currentSock) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: false, error: 'WhatsApp socket is not connected' }));
            }
            groupManager.getGroupStatus(currentSock, chat).then(st => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, ...st }));
            }).catch(e => {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            });
            return;
        }

        if (req.method === 'POST' && url === '/group/control') {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', async () => {
                try {
                    const data = JSON.parse(body || '{}');
                    const chat = data.chat || data.groupId || data.target;
                    const action = (data.action || '').toLowerCase().trim();
                    const adminName = data.adminName || data.requestedBy || 'Admin';

                    if (!currentSock) {
                        res.writeHead(503, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({ success: false, error: 'WhatsApp socket is not connected yet' }));
                    }

                    if (!chat || !chat.endsWith('@g.us')) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({ success: false, error: 'Field "chat" harus berupa JID grup WhatsApp yang valid (@g.us)' }));
                    }

                    const opts = {
                        adminName: data.adminName || data.requestedBy || data.senderName || 'Admin',
                        reason: data.reason,
                        sender: data.sender,
                        isOwner: Boolean(data.isOwner)
                    };

                    let result;
                    if (action === 'close' || action === 'tutup') {
                        result = await groupManager.closeGroup(currentSock, chat, opts);
                    } else if (action === 'open' || action === 'buka') {
                        result = await groupManager.openGroup(currentSock, chat, opts);
                    } else if (action === 'temp_close' || action === 'tutup_sementara') {
                        const duration = data.durationMinutes || data.duration || 60;
                        result = await groupManager.tempCloseGroup(currentSock, chat, duration, opts);
                    } else if (action === 'schedule' || action === 'jadwal') {
                        result = await groupManager.setDailySchedule(currentSock, chat, data.closeTime, data.openTime, opts);
                    } else if (action === 'disable_schedule') {
                        result = await groupManager.disableDailySchedule(currentSock, chat, opts);
                    } else if (action === 'status') {
                        result = await groupManager.getGroupStatus(currentSock, chat);
                        result.success = true;
                    } else {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({ success: false, error: 'Aksi tidak dikenal. Pilihan valid: open, close, temp_close, schedule, disable_schedule, status' }));
                    }

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify(result));
                } catch (err) {
                    console.error('[OUTBOUND GROUP CONTROL ERROR]', err.message);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, error: err.message }));
                }
            });
            return;
        }

        if (req.method === 'POST' && (url === '/send' || url === '/api/send')) {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', async () => {
                try {
                    const data = JSON.parse(body || '{}');
                    const target = data.to || data.target || data.phone || data.number || global.owner?.[0];
                    const rawText = data.text || data.message || data.content;

                    if (!rawText) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({ success: false, error: 'Field "text" or "message" is required' }));
                    }

                    if (!currentSock) {
                        res.writeHead(503, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({ success: false, error: 'WhatsApp socket is not connected yet' }));
                    }

                    const targetJid = await resolveTargetJid(currentSock, target);
                    if (!targetJid) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({ success: false, error: 'Invalid destination phone number' }));
                    }

                    const textToSend = cleanWhatsAppMarkdown(rawText);

                    const { sent: sentMsg, jid: usedJid } = await sendMessageSmart(currentSock, target, { text: textToSend });
                    console.log(`[OUTBOUND WHATSAPP] Pesan terkirim ke ${usedJid}: "${textToSend.slice(0, 60)}..."`);

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({
                        success: true,
                        messageId: sentMsg?.key?.id || null,
                        to: targetJid,
                        length: textToSend.length
                    }));
                } catch (err) {
                    console.error('[OUTBOUND SERVER ERROR]', err.message);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, error: err.message }));
                }
            });
            return;
        }

        if (req.method === 'POST' && (url === '/send-voice' || url === '/api/send-voice')) {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', async () => {
                try {
                    const data = JSON.parse(body || '{}');
                    const target = data.to || data.target || data.phone || data.number || global.owner?.[0];
                    const filePath = data.filePath || data.path;

                    if (!filePath || !require('fs').existsSync(filePath)) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({ success: false, error: 'Field "filePath" valid file is required' }));
                    }

                    if (!currentSock) {
                        res.writeHead(503, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({ success: false, error: 'WhatsApp socket is not connected yet' }));
                    }

                    const targetJid = await resolveTargetJid(currentSock, target);
                    const audioBuf = require('fs').readFileSync(filePath);
                    const { sent: sentMsg, jid: usedJid } = await sendMessageSmart(currentSock, target, {
                        audio: audioBuf,
                        mimetype: 'audio/ogg; codecs=opus',
                        ptt: true
                    });

                    console.log(`[OUTBOUND WHATSAPP] Voice Note terkirim ke ${targetJid} (${audioBuf.length} bytes)`);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({
                        success: true,
                        messageId: sentMsg?.key?.id || null,
                        to: targetJid
                    }));
                } catch (err) {
                    console.error('[OUTBOUND VOICE ERROR]', err.message);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, error: err.message }));
                }
            });
            return;
        }

        if (req.method === 'POST' && (url === '/send-media' || url === '/api/send-media' || url === '/send-file' || url === '/api/send-file')) {
            let body = '';
            req.on('data', chunk => {
                body += chunk;
                if (body.length > 140 * 1024 * 1024) req.destroy();
            });
            req.on('end', async () => {
                try {
                    const data = JSON.parse(body || '{}');
                    const target = data.to || data.target || data.phone || data.number || data.chat
                        || global.owner?.[0] || currentSock?.user?.id;

                    if (!currentSock) {
                        res.writeHead(503, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({ success: false, error: 'WhatsApp socket is not connected yet' }));
                    }

                    const targetJid = await resolveTargetJid(currentSock, target);
                    if (!targetJid) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({ success: false, error: 'Invalid destination phone number' }));
                    }

                    const built = await buildMediaContent(data);
                    const { sent: sentMsg, jid: usedJid, usedLid, fallbackFrom } = await sendMessageSmart(currentSock, target, built.content);

                    console.log(`[OUTBOUND WHATSAPP] ${built.kind} terkirim ke ${usedJid} (${built.size} bytes, ${built.mimetype}, lid=${Boolean(usedLid)}${fallbackFrom ? `, fallbackDari=${fallbackFrom}` : ''})`);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({
                        success: true,
                        messageId: sentMsg?.key?.id || null,
                        to: usedJid,
                        addressing: usedLid ? 'lid' : 'pn',
                        keyRemoteJid: sentMsg?.key?.remoteJid || null,
                        kind: built.kind,
                        mimetype: built.mimetype,
                        bytes: built.size,
                        fileName: built.fileName,
                        source: built.source
                    }));
                } catch (err) {
                    console.error('[OUTBOUND MEDIA ERROR]', err.message);
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, error: err.message }));
                }
            });
            return;
        }

        if (req.method === 'GET' && (url === '/whoami' || url === '/api/whoami')) {
            (async () => {
                const ownerPn = global.owner?.[0] ? normalizeJid(global.owner[0]) : null;
                const ownerJid = ownerPn ? await resolveTargetJid(currentSock, ownerPn) : null;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    botId: currentSock?.user?.id || null,
                    botLid: currentSock?.user?.lid || null,
                    ownerPn,
                    ownerJid,
                    addressing: ownerJid?.endsWith('@lid') ? 'lid' : 'pn'
                }));
            })().catch(err => {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            });
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Endpoint not found' }));
    });

    serverInstance.listen(PORT, HOST, () => {
        console.log(`[OUTBOUND SERVER] WhatsApp Outbound Bridge listening on http://${HOST}:${PORT}`);
    });

    serverInstance.on('error', (err) => {
        console.error('[OUTBOUND SERVER LISTEN ERROR]', err.message);
    });
}

function stopOutboundServer() {
    if (serverInstance) {
        serverInstance.close();
        serverInstance = null;
    }
    currentSock = null;
}

module.exports = {
    startOutboundServer,
    stopOutboundServer,
    buildMediaContent,
    normalizeJid,
    resolveTargetJid,
    sendMessageSmart
};
