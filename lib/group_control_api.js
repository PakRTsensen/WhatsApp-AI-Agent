
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VERSION = '1.8.1';
const PORT = Number(process.env.WA_CONTROL_PORT || 5685);
const HOST = '127.0.0.1';
const TOKEN_FILE = path.join(__dirname, '../control/control_token');

function readToken() {
    try {
        if (process.env.WA_CONTROL_TOKEN) return process.env.WA_CONTROL_TOKEN.trim();
        if (fs.existsSync(TOKEN_FILE)) {
            const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
            if (t) return t;
        }
        const fresh = crypto.randomBytes(24).toString('hex');
        fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
        fs.writeFileSync(TOKEN_FILE, fresh + '\n', { mode: 0o600 });
        console.log('[CONTROL API] Token baru dibuat di', TOKEN_FILE);
        return fresh;
    } catch (e) {
        console.error('[CONTROL API] Gagal baca/buat token:', e.message);
        return '';
    }
}

const TOKEN = readToken();

/* ------------------------------ helpers ------------------------------ */

function digits(input) {
    if (!input) return '';
    return String(input)
        .replace(/:\d+(?=@)/, '')
        .split('@')[0]
        .replace(/[^0-9]/g, '');
}

function toJid(input) {
    if (!input) return null;
    const s = String(input).trim();
    if (s.endsWith('@g.us') || s.endsWith('@lid') || s.endsWith('@s.whatsapp.net') || s.endsWith('@broadcast')) {
        return s;
    }
    let d = digits(s);
    if (!d) return null;
    if (d.startsWith('0')) d = '62' + d.slice(1);
    return `${d}@s.whatsapp.net`;
}

function botIds(sock) {
    return [sock?.user?.id, sock?.user?.lid]
        .filter(Boolean)
        .map(v => String(v).replace(/:\d+(?=@)/, ''));
}

function isBotAdminIn(metadata, sock) {
    if (!metadata || !Array.isArray(metadata.participants)) return false;
    const ids = botIds(sock);
    const nums = ids.map(digits).filter(Boolean);
    return metadata.participants.some(p => {
        if (!p.admin) return false;
        const pids = [p.id, p.lid, p.phoneNumber].filter(Boolean).map(v => String(v).replace(/:\d+(?=@)/, ''));
        if (pids.some(v => ids.includes(v))) return true;
        const pnums = [p.id, p.phoneNumber].filter(Boolean).map(digits).filter(Boolean);
        return pnums.some(n => nums.includes(n));
    });
}

function participantView(p) {
    return {
        jid: p.id,
        number: digits(p.id) || digits(p.phoneNumber) || null,
        phoneNumber: p.phoneNumber || null,
        lid: p.lid || null,
        admin: p.admin || null,
        isAdmin: Boolean(p.admin),
        isSuperAdmin: p.admin === 'superadmin'
    };
}

function findParticipant(metadata, input) {
    if (!metadata || !Array.isArray(metadata.participants)) return null;
    const raw = String(input || '').trim().replace(/:\d+(?=@)/, '');
    const exact = metadata.participants.find(p =>
        [p.id, p.lid, p.phoneNumber].filter(Boolean)
            .some(v => String(v).replace(/:\d+(?=@)/, '') === raw)
    );
    if (exact) return exact;
    const d = digits(raw);
    if (!d) return null;
    const d62 = d.startsWith('0') ? '62' + d.slice(1) : d;
    return metadata.participants.find(p =>
        [p.id, p.lid, p.phoneNumber].filter(Boolean)
            .map(digits)
            .some(n => n && (n === d || n === d62))
    ) || null;
}

async function metadataOf(sock, chat) {
    if (!chat || !String(chat).endsWith('@g.us')) {
        const err = new Error('Field "chat" harus JID grup (@g.us)');
        err.code = 'NOT_A_GROUP';
        throw err;
    }
    const meta = await sock.groupMetadata(chat);
    if (!meta) {
        const err = new Error('Metadata grup tidak tersedia');
        err.code = 'NO_METADATA';
        throw err;
    }
    return meta;
}

async function freshMetadata(sock, chat) {
    try {
        if (typeof sock.groupFetchAllParticipating === 'function') {
            const all = await sock.groupFetchAllParticipating();
            if (all && all[chat]) return all[chat];
        }
    } catch (e) {
        console.warn('[CONTROL API] freshMetadata gagal:', e.message);
    }
    return metadataOf(sock, chat);
}

async function requireBotAdmin(sock, chat) {
    const meta = await metadataOf(sock, chat);
    if (!isBotAdminIn(meta, sock)) {
        const err = new Error('Bot bukan admin di grup ini');
        err.code = 'BOT_NOT_ADMIN';
        throw err;
    }
    return meta;
}


async function listGroups(sock) {
    const all = await sock.groupFetchAllParticipating();
    return Object.values(all || {}).map(g => ({
        chat: g.id,
        name: g.subject,
        members: Array.isArray(g.participants) ? g.participants.length : 0,
        closed: Boolean(g.announce),
        botIsAdmin: isBotAdminIn(g, sock)
    })).sort((a, b) => b.members - a.members);
}

async function groupInfo(sock, chat, opts = {}) {
    const meta = opts.fresh ? await freshMetadata(sock, chat) : await metadataOf(sock, chat);
    const parts = (meta.participants || []).map(participantView);
    return {
        chat: meta.id || chat,
        name: meta.subject,
        description: meta.desc || null,
        closed: Boolean(meta.announce),
        locked: Boolean(meta.restrict),
        members: parts.length,
        admins: parts.filter(p => p.isAdmin).length,
        botIsAdmin: isBotAdminIn(meta, sock),
        owner: meta.owner || null,
        ephemeralSeconds: meta.ephemeralDuration || null,
        createdAt: meta.creation || null
    };
}

async function groupMembers(sock, chat, opts = {}) {
    const meta = await metadataOf(sock, chat);
    let parts = (meta.participants || []).map(participantView);
    const filter = String(opts.filter || 'all').toLowerCase();
    if (filter === 'admin') parts = parts.filter(p => p.isAdmin);
    if (filter === 'member') parts = parts.filter(p => !p.isAdmin);
    const total = parts.length;
    const limit = Math.max(1, Math.min(Number(opts.limit) || 50, 1000));
    const offset = Math.max(0, Number(opts.offset) || 0);
    return { chat, total, returned: Math.min(limit, Math.max(0, total - offset)), members: parts.slice(offset, offset + limit) };
}

async function groupSetting(sock, chat, mode, opts = {}) {
    await requireBotAdmin(sock, chat);
    const m = String(mode || '').toLowerCase();
    if (m === 'close' || m === 'tutup') {
        await sock.groupSettingUpdate(chat, 'announcement');
    } else if (m === 'open' || m === 'buka') {
        await sock.groupSettingUpdate(chat, 'not_announcement');
    } else if (m === 'locked' || m === 'kunci') {
        await sock.groupSettingUpdate(chat, 'locked');
    } else if (m === 'unlocked') {
        await sock.groupSettingUpdate(chat, 'unlocked');
    } else if (m === 'temp_close') {
        const minutes = Number(opts.durationMinutes || opts.duration || 60);
        if (!Number.isFinite(minutes) || minutes <= 0) {
            const err = new Error('durationMinutes harus angka positif');
            err.code = 'INVALID_DURATION';
            throw err;
        }
        await sock.groupSettingUpdate(chat, 'announcement');
        const { tempCloseGroup } = require('./group_manager');
        await tempCloseGroup(sock, chat, minutes, { isOwner: true, adminName: opts.adminName || 'MCP' });
    } else {
        const err = new Error('mode tidak dikenal: pakai open | close | temp_close | locked | unlocked');
        err.code = 'INVALID_MODE';
        throw err;
    }
    await new Promise(r => setTimeout(r, 1200));
    const meta = await freshMetadata(sock, chat);
    const expectClosed = (m === 'close' || m === 'tutup' || m === 'temp_close') ? true
        : (m === 'open' || m === 'buka') ? false : null;
    return {
        chat,
        mode: m,
        closed: Boolean(meta.announce),
        locked: Boolean(meta.restrict),
        verified: expectClosed === null ? null : Boolean(meta.announce) === expectClosed
    };
}

async function groupMembersAction(sock, chat, action, numbers) {
    const meta = await requireBotAdmin(sock, chat);
    const act = String(action || '').toLowerCase();
    const map = { kick: 'remove', remove: 'remove', add: 'add', promote: 'promote', demote: 'demote' };
    const baileysAction = map[act];
    if (!baileysAction) {
        const err = new Error('action tidak dikenal: pakai kick | add | promote | demote');
        err.code = 'INVALID_ACTION';
        throw err;
    }
    const list = Array.isArray(numbers) ? numbers : [numbers];
    if (!list.length) {
        const err = new Error('numbers wajib diisi');
        err.code = 'NO_TARGET';
        throw err;
    }

    const resolved = [];
    const unresolved = [];
    for (const raw of list) {
        const found = findParticipant(meta, raw);
        if (found) {
            resolved.push(found.id);
        } else if (baileysAction === 'add') {
            const jid = toJid(raw);
            if (jid) resolved.push(jid); else unresolved.push(String(raw));
        } else {
            unresolved.push(String(raw));
        }
    }
    if (!resolved.length) {
        return { chat, action: act, success: false, code: 'NO_PARTICIPANT_MATCH', unresolved, message: 'Tidak ada target yang cocok dengan anggota grup.' };
    }

    const results = await sock.groupParticipantsUpdate(chat, resolved, baileysAction);
    const mapped = (results || []).map(r => ({
        jid: r.jid,
        status: String(r.status),
        ok: String(r.status) === '200'
    }));
    return {
        chat,
        action: act,
        success: mapped.some(r => r.ok),
        requested: resolved.length,
        results: mapped,
        unresolved
    };
}

async function groupInvite(sock, chat, revoke) {
    await requireBotAdmin(sock, chat);
    const code = revoke ? await sock.groupRevokeInvite(chat) : await sock.groupInviteCode(chat);
    return {
        chat,
        revoked: Boolean(revoke),
        code: code || null,
        link: code ? `https://chat.whatsapp.com/${code}` : null
    };
}

async function groupRename(sock, chat, subject) {
    await requireBotAdmin(sock, chat);
    if (!subject || !String(subject).trim()) {
        const err = new Error('subject wajib diisi');
        err.code = 'NO_SUBJECT';
        throw err;
    }
    const before = await metadataOf(sock, chat);
    await sock.groupUpdateSubject(chat, String(subject).trim());
    return { chat, before: before.subject, after: String(subject).trim() };
}



const MAX_DOC_BYTES = 100 * 1024 * 1024;

const EXT_MIME = {
    '.pdf': 'application/pdf', '.zip': 'application/zip', '.tar': 'application/x-tar',
    '.gz': 'application/gzip', '.tgz': 'application/gzip', '.7z': 'application/x-7z-compressed',
    '.json': 'application/json', '.txt': 'text/plain', '.log': 'text/plain',
    '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript',
    '.ts': 'text/plain', '.py': 'text/x-python', '.md': 'text/markdown',
    '.html': 'text/html', '.css': 'text/css', '.csv': 'text/csv', '.sql': 'text/plain',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
    '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg'
};

const BLOCKED_PATHS = ['/session/', '/session_backup_', '/.pm2/', '/control/control_token', 'state.db', 'auth.json'];

async function resolveSendJid(sock, to) {
    const jid = toJid(to);
    if (!jid) return null;
    if (!jid.endsWith('@s.whatsapp.net')) return jid;
    try {
        const lid = await sock?.signalRepository?.lidMapping?.getLIDForPN?.(jid);
        if (lid) return lid;
    } catch (_) {}
    return jid;
}

async function sendDocument(sock, to, filePath, opts = {}) {
    if (!to) { const e = new Error('to wajib diisi'); e.code = 'NO_TARGET'; throw e; }
    if (!filePath) { const e = new Error('filePath wajib diisi'); e.code = 'NO_FILE'; throw e; }

    const abs = path.resolve(String(filePath));
    const norm = abs.replace(/\\/g, '/');
    if (BLOCKED_PATHS.some(b => norm.includes(b))) {
        const e = new Error('Path diblokir: file kredensial/sesi tidak boleh dikirim');
        e.code = 'BLOCKED_PATH';
        throw e;
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        const e = new Error(`File tidak ditemukan: ${abs}`); e.code = 'NO_FILE'; throw e;
    }
    const size = fs.statSync(abs).size;
    if (size > MAX_DOC_BYTES) {
        const e = new Error(`File ${size} byte melebihi batas ${MAX_DOC_BYTES}`); e.code = 'TOO_LARGE'; throw e;
    }

    const jid = await resolveSendJid(sock, to);
    if (!jid) { const e = new Error(`Target tidak valid: ${to}`); e.code = 'INVALID_TARGET'; throw e; }

    const fileName = opts.fileName || path.basename(abs);
    const mimetype = opts.mimetype || EXT_MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
    const caption = opts.caption ? String(opts.caption).replace(/\*\*(.+?)\*\*/g, '*$1*') : undefined;

    const sent = await sock.sendMessage(jid, { document: fs.readFileSync(abs), fileName, mimetype, caption });
    return {
        success: true,
        to: jid,
        addressing: jid.endsWith('@lid') ? 'lid' : 'pn',
        keyRemoteJid: sent?.key?.remoteJid || null,
        messageId: sent?.key?.id || null,
        fileName, mimetype, bytes: size
    };
}

function parseClock(value, field) {
    const text = String(value === undefined || value === null ? '' : value).trim();
    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(text)) {
        const err = new Error(`${field} wajib format HH:MM 24 jam, contoh 23:00`);
        err.code = 'INVALID_TIME';
        throw err;
    }
    return text;
}

async function groupSchedule(sock, chat, closeTime, openTime, enabled = true) {
    if (!chat) { const e = new Error('chat wajib diisi'); e.code = 'NO_TARGET'; throw e; }
    const { setDailySchedule, disableDailySchedule, getGroupStatus } = require('./group_manager');

    if (enabled === false) {
        const off = await disableDailySchedule(sock, chat, { isOwner: true, adminName: 'control-api' });
        const status = await getGroupStatus(sock, chat);
        return {
            chat,
            ...off,
            dailySchedule: status.dailySchedule || null,
            closed: status.isClosed,
            verified: !status.dailySchedule
        };
    }

    const close = parseClock(closeTime, 'closeTime');
    const open = parseClock(openTime, 'openTime');
    if (close === open) {
        const err = new Error('closeTime dan openTime tidak boleh sama');
        err.code = 'INVALID_TIME';
        throw err;
    }

    const result = await setDailySchedule(sock, chat, close, open, { isOwner: true, adminName: 'control-api' });
    const status = await getGroupStatus(sock, chat);
    const saved = status.dailySchedule || null;
    return {
        chat,
        ...result,
        dailySchedule: saved,
        closed: status.isClosed,
        verified: Boolean(saved && saved.closeTime === close && saved.openTime === open)
    };
}

async function groupScheduleStatus(sock, chat) {
    if (!chat) { const e = new Error('chat wajib diisi'); e.code = 'NO_TARGET'; throw e; }
    const { getGroupStatus } = require('./group_manager');
    const status = await getGroupStatus(sock, chat);
    if (status.success === false) {
        const err = new Error(status.message || 'Gagal membaca status grup');
        err.code = 'NOT_A_GROUP';
        throw err;
    }
    return {
        chat,
        success: true,
        groupName: status.groupName,
        botIsAdmin: status.isBotAdmin,
        closed: status.isClosed,
        currentMode: status.currentMode,
        totalMembers: status.totalMembers,
        dailySchedule: status.dailySchedule || null,
        tempClose: status.tempClose || null
    };
}

function messageRecent(chat, { limit = 10, sinceMinutes = null, sender = null } = {}) {
    const Cache = require('./message_cache');
    if (!chat) { const e = new Error('chat wajib diisi'); e.code = 'NO_TARGET'; throw e; }
    const sinceMs = sinceMinutes ? Date.now() - Number(sinceMinutes) * 60000 : null;
    const list = Cache.recent(chat, { limit: Number(limit) || 10, sinceMs, sender });
    return {
        success: true,
        chat,
        count: list.length,
        messages: list.map((r) => ({
            id: r.id,
            time: r.iso,
            relative: Cache.relativeFrom(r.ts),
            sender: r.sender,
            senderNumber: r.senderNumber,
            pushName: r.pushName,
            type: r.type,
            text: r.text,
            media: r.media,
            quotedId: r.quoted?.id || null
        }))
    };
}

function messageGet(chat, id) {
    const Cache = require('./message_cache');
    if (!chat || !id) { const e = new Error('chat dan id wajib diisi'); e.code = 'NO_TARGET'; throw e; }
    const rec = Cache.get(chat, id);
    if (!rec) { const e = new Error('pesan tidak ada di cache'); e.code = 'NOT_FOUND'; throw e; }
    return { success: true, message: rec };
}

function messageSearch(chat, query, { limit = 20 } = {}) {
    const Cache = require('./message_cache');
    if (!chat) { const e = new Error('chat wajib diisi'); e.code = 'NO_TARGET'; throw e; }
    if (!query || !String(query).trim()) { const e = new Error('query wajib diisi'); e.code = 'NO_TARGET'; throw e; }
    const list = Cache.search(chat, query, { limit: Number(limit) || 20 });
    return {
        success: true,
        chat,
        query: String(query),
        count: list.length,
        messages: list.map((r) => ({
            id: r.id,
            time: r.iso,
            sender: r.sender,
            pushName: r.pushName,
            type: r.type,
            text: r.text,
            media: r.media
        }))
    };
}

async function messageFetch(sock, chat, { count = 50, waitMs = 6000, anchorId = null, anchorTs = null, fromMe = null } = {}) {
    const Cache = require('./message_cache');
    if (!chat) { const e = new Error('chat wajib diisi'); e.code = 'NO_TARGET'; throw e; }
    if (!sock || typeof sock.fetchMessageHistory !== 'function') {
        const e = new Error('socket tidak mendukung fetchMessageHistory'); e.code = 'LIVE_UNSUPPORTED'; throw e;
    }
    
    
    const known = Cache.recent(chat, { limit: Cache.MAX_PER_CHAT });
    
    
    
    const anchorMsg = anchorId
        ? { id: String(anchorId), ts: Number(anchorTs) || Date.now(), fromMe: fromMe === null ? false : Boolean(fromMe), iso: null }
        : known[0];
    if (!anchorMsg) {
        const e = new Error('belum ada pesan di cache chat ini, tidak ada anchor untuk minta riwayat');
        e.code = 'NO_ANCHOR'; throw e;
    }
    const requested = Math.max(1, Math.min(Number(count) || 50, 200));
    const startedAt = Date.now();
    const result = await sock.fetchMessageHistory(
        requested,
        { remoteJid: chat, fromMe: Boolean(anchorMsg.fromMe), id: anchorMsg.id },
        Math.floor((anchorMsg.ts || Date.now()) / 1000)
    );
    let ingested = 0;
    let totalCached = known.length;
    while (Date.now() - startedAt < Math.max(1000, Number(waitMs) || 6000)) {
        await new Promise((r) => setTimeout(r, 500));
        const now = Cache.recent(chat, { limit: Cache.MAX_PER_CHAT });
        totalCached = now.length;
        ingested = Math.max(0, now.length - known.length);
        if (ingested > 0) break;
        
        if (!sock?.user) break;
    }
    let storeResult = { available: false, ingested: 0, received: 0 };
    if (ingested === 0) {
        storeResult = ingestFromStore(chat, Math.max(requested, 100));
        if (storeResult.ingested > 0) totalCached = Cache.recent(chat, { limit: Cache.MAX_PER_CHAT }).length;
    }

    return {
        success: true,
        chat,
        requested,
        anchorId: anchorMsg.id,
        anchorTime: anchorMsg.iso,
        ingested,
        totalCached,
        waitedMs: Date.now() - startedAt,
        peerRequestId: result?.id || null,
        store: storeResult,
        note: ingested > 0
            ? 'riwayat masuk ke memory (on-demand history)'
            : (storeResult.ingested > 0
                ? 'on-demand history tidak dijawab server, tapi store memory memberi tambahan pesan'
                : 'server tidak mengirim riwayat dan store tidak punya pesan tambahan untuk chat ini')
    };
}

function ingestFromStore(chat, count = 100, chatName = null) {
    const Cache = require('./message_cache');
    const store = globalThis.__waStore;
    if (!store || typeof store.loadMessages !== 'function') {
        return { available: false, ingested: 0, received: 0, reason: 'store belum terpasang (perlu restart bot sekali)' };
    }
    try {
        const messages = store.loadMessages(chat, Math.max(1, Number(count) || 100)) || [];
        const res = Cache.ingestRaw(messages, { chatName, source: 'store' });
        return { available: true, ingested: res.ingested, received: messages.length };
    } catch (err) {
        return { available: true, ingested: 0, received: 0, error: err.message };
    }
}

async function messageThreadWithLive(sock, chat, id, opts = {}) {
    const Cache = require('./message_cache');
    let data = messageThread(chat, id, opts);
    if (!data.found && opts.live) {
        try {
            const storeTry = ingestFromStore(chat, opts.fetchCount || 200);
            if (storeTry.ingested > 0) data = messageThread(chat, id, opts);
            if (data.found) {
                data.liveFetch = { attempted: true, source: 'store', ingested: storeTry.ingested, received: storeTry.received };
                return data;
            }
            const fetched = await messageFetch(sock, chat, { count: opts.fetchCount || 50, waitMs: opts.waitMs || 5000 });
            data = messageThread(chat, id, opts);
            data.liveFetch = { attempted: true, ingested: fetched.ingested, waitedMs: fetched.waitedMs, note: fetched.note, store: fetched.store };
        } catch (err) {
            data.liveFetch = { attempted: true, error: err.code || 'LIVE_FAILED', message: err.message };
        }
    }
    return data;
}

async function deleteOwnMessage(sock, chat, id) {
    const Cache = require('./message_cache');
    const targetChat = String(chat || '').trim();
    const targetId = String(id || '').trim();
    if (!targetChat || !targetId) {
        const e = new Error('chat dan id pesan wajib diisi'); e.code = 'NO_TARGET'; throw e;
    }

    
    
    
    let rec = Cache.get(targetChat, targetId);
    if (rec?.chat === targetChat && rec.id === targetId && rec.fromMe !== true && rec.quotedId) {
        const quoted = Cache.get(targetChat, rec.quotedId);
        if (quoted?.chat === targetChat && quoted.id === rec.quotedId && quoted.fromMe === true) {
            rec = quoted;
        }
    }
    if (!rec) {
        const e = new Error('pesan target tidak ada di cache; pastikan ID benar dan chat cocok'); e.code = 'NOT_FOUND'; throw e;
    }
    if (rec.chat !== targetChat || rec.fromMe !== true) {
        const e = new Error('hanya pesan yang dikirim bot sendiri yang bisa dihapus'); e.code = 'NOT_OWN_MESSAGE'; throw e;
    }
    const resolvedId = rec.id;

     if (!sock || typeof sock.sendMessage !== 'function') {
        const e = new Error('socket WhatsApp tidak tersedia'); e.code = 'SOCKET_UNAVAILABLE'; throw e;
    }

    const key = {
        remoteJid: targetChat,
        id: resolvedId,
        fromMe: true,
        ...(targetChat.endsWith('@g.us') && rec.sender ? { participant: rec.sender } : {})
    };
    await sock.sendMessage(targetChat, { delete: key });
    return { success: true, chat: targetChat, id: resolvedId, deleted: true };
}

async function messageGetWithLive(sock, chat, id, opts = {}) {
    const Cache = require('./message_cache');
    let rec = Cache.get(chat, id);
    if (!rec && opts.live) {
        try {
            ingestFromStore(chat, opts.fetchCount || 200);
            rec = Cache.get(chat, id);
            if (rec) return { success: true, message: rec, source: 'store' };
            const fetched = await messageFetch(sock, chat, { count: opts.fetchCount || 50, waitMs: opts.waitMs || 5000 });
            rec = Cache.get(chat, id);
            if (!rec) {
                const e = new Error('pesan tidak ada di cache setelah live fetch');
                e.code = 'NOT_FOUND';
                e.detail = { ingested: fetched.ingested, note: fetched.note };
                throw e;
            }
        } catch (err) {
            if (err.code === 'NOT_FOUND') throw err;
            const e = new Error(`pesan tidak ada di cache (live fetch gagal: ${err.code || err.message})`);
            e.code = 'NOT_FOUND';
            throw e;
        }
    }
    if (!rec) { const e = new Error('pesan tidak ada di cache'); e.code = 'NOT_FOUND'; throw e; }
    return { success: true, message: rec };
}

function messageThread(chat, id, { before = 5, after = 5, depth = 4, head = 3 } = {}) {
    const Cache = require('./message_cache');
    if (!chat || !id) { const e = new Error('chat dan id wajib diisi'); e.code = 'NO_TARGET'; throw e; }
    const t = Cache.thread(chat, id, {
        before: Number(before) || 0,
        after: Number(after) || 0,
        depth: Number(depth) || 4,
        head: Number(head) || 0
    });
    const brief = (r) => (r ? {
        id: r.id,
        time: r.iso || null,
        relative: r.ts ? Cache.relativeFrom(r.ts) : null,
        sender: r.sender || null,
        senderNumber: r.senderNumber || null,
        pushName: r.pushName || null,
        type: r.type || null,
        text: r.text || null,
        media: r.media || null,
        quotedId: r.quoted?.id || null
    } : null);

    return {
        success: true,
        chat,
        id,
        found: Boolean(t.target),
        target: brief(t.target),
        chain: t.chain.map((c) => ({
            level: c.level,
            inCache: c.inCache,
            message: brief(c.record)
        })),
        before: t.before.map(brief),
        after: t.after.map(brief),
        head: t.head.map(brief),
        totalCached: t.totalCached
    };
}

function messageStats() {
    const Cache = require('./message_cache');
    return { success: true, ...Cache.stats() };
}

async function antiforwardStatus(chat) {
    const Store = require('./antiforward_store');
    const state = Store.readState();
    const scope = chat ? String(chat) : null;
    return {
        success: true,
        enabledAll: state.enabled_all === true,
        group: scope ? { chat: scope, enabled: Store.isGroupEnabled(state, scope) } : null,
        exempt: scope ? Store.listExempt(state, scope) : {
            groups: Object.keys(state.exempt || {})
        }
    };
}

async function antiforwardExempt(sock, chat, type, target, action, addedBy) {
    const Store = require('./antiforward_store');
    const scope = chat && String(chat).trim() ? String(chat).trim() : Store.GLOBAL_KEY;
    const kind = String(type || 'sender').toLowerCase();
    const act = String(action || 'add').toLowerCase();
    if (!['add', 'remove'].includes(act)) {
        const err = new Error("action wajib 'add' atau 'remove'");
        err.code = 'INVALID_ACTION';
        throw err;
    }
    if (!target || !String(target).trim()) {
        const err = new Error('target wajib diisi (nomor, JID, atau JID @newsletter)');
        err.code = 'NO_TARGET';
        throw err;
    }

    const state = Store.readState();
    const who = addedBy || 'control-api';

    if (kind === 'channel' || kind === 'newsletter') {
        const jid = String(target).trim();
        const res = act === 'add'
            ? Store.addChannel(state, scope, { jid, addedBy: who })
            : Store.removeChannel(state, scope, jid);
        Store.writeState(state);
        const after = Store.listExempt(Store.readState(), scope);
        return {
            success: true,
            scope,
            type: 'channel',
            action: act,
            target: jid,
            changed: act === 'add' ? res.added : res.removed,
            alreadyExists: Boolean(res.alreadyExists),
            entry: res.entry || null,
            verified: act === 'add'
                ? after.channels.some((e) => e.jid === Store.normJid(jid))
                : !after.channels.some((e) => e.jid === Store.normJid(jid))
        };
    }

    if (kind !== 'sender') {
        const err = new Error("type wajib 'sender' atau 'channel'");
        err.code = 'INVALID_ACTION';
        throw err;
    }

    const raw = String(target).trim();
    const isJid = raw.includes('@');
    let jid = isJid ? raw : `${Store.digitsOf(raw)}@s.whatsapp.net`;
    let lid = isJid && raw.endsWith('@lid') ? raw : null;
    const number = Store.digitsOf(raw) || null;

    if (!isJid && !number) {
        const err = new Error('nomor tidak valid');
        err.code = 'INVALID_TARGET';
        throw err;
    }

    if (act === 'add' && !lid && sock?.signalRepository?.lidMapping?.getLIDForPN) {
        try {
            const resolved = await sock.signalRepository.lidMapping.getLIDForPN(jid);
            if (resolved) lid = resolved;
        } catch (_) {}
    }

    const res = act === 'add'
        ? Store.addSender(state, scope, { jid, lid, number, addedBy: who })
        : Store.removeSender(state, scope, jid);
    Store.writeState(state);

    const after = Store.listExempt(Store.readState(), scope);
    const stillThere = after.senders.some((e) => Store.samePerson(e.jid, jid) || (lid && Store.samePerson(e.lid, lid)));

    return {
        success: true,
        scope,
        type: 'sender',
        action: act,
        target: raw,
        jid: Store.normJid(jid),
        lid: lid ? Store.normJid(lid) : null,
        changed: act === 'add' ? res.added : res.removed,
        alreadyExists: Boolean(res.alreadyExists),
        entry: res.entry || null,
        verified: act === 'add' ? stillThere : !stillThere
    };
}

async function groupDescription(sock, chat, desc) {
    await requireBotAdmin(sock, chat);
    if (desc === undefined || desc === null || !String(desc).trim()) {
        const err = new Error('desc wajib diisi (kirim string kosong hanya kalau memang mau menghapus deskripsi)');
        err.code = 'NO_DESC';
        throw err;
    }
    const text = String(desc).trim();
    const before = await metadataOf(sock, chat);
    await sock.groupUpdateDescription(chat, text);
    return {
        chat,
        success: true,
        beforeLength: String(before.desc || '').length,
        afterLength: text.length
    };
}

async function groupJoinRequests(sock, chat, action, numbers) {
    await requireBotAdmin(sock, chat);
    const act = String(action || 'list').toLowerCase();
    if (act === 'list') {
        const pending = await sock.groupRequestParticipantsList(chat);
        return {
            chat,
            total: (pending || []).length,
            requests: (pending || []).map(p => ({
                jid: p.jid,
                number: digits(p.jid) || null,
                requestedAt: p.request_time || null
            }))
        };
    }
    if (act === 'approve' || act === 'reject') {
        const list = Array.isArray(numbers) ? numbers : [numbers];
        const meta = await metadataOf(sock, chat);
        const jids = list.map(n => findParticipant(meta, n)).filter(Boolean).map(p => p.id);
        const targets = jids.length ? jids : list.map(toJid).filter(Boolean);
        if (!targets.length) {
            const err = new Error('numbers wajib diisi');
            err.code = 'NO_TARGET';
            throw err;
        }
        const results = await sock.groupRequestParticipantsUpdate(chat, targets, act);
        return {
            chat,
            action: act,
            success: (results || []).some(r => String(r.status) === '200'),
            results: (results || []).map(r => ({ jid: r.jid, status: String(r.status), ok: String(r.status) === '200' }))
        };
    }
    const err = new Error('action tidak dikenal: pakai list | approve | reject');
    err.code = 'INVALID_ACTION';
    throw err;
}

function parseInviteCode(input) {
    if (!input || typeof input !== 'string' || !input.trim()) {
        const err = new Error('Field "link" wajib diisi: URL undangan grup atau kode undangannya');
        err.code = 'NO_LINK';
        throw err;
    }
    let raw = input.trim();
    const fromUrl = raw.match(/chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9_-]{8,})/i);
    if (fromUrl) raw = fromUrl[1];
    raw = raw.split('?')[0].split('#')[0].trim();
    if (!/^[A-Za-z0-9_-]{8,40}$/.test(raw)) {
        const err = new Error('Kode undangan tidak valid. Kirim URL https://chat.whatsapp.com/... atau kode mentahnya.');
        err.code = 'INVALID_LINK';
        throw err;
    }
    return raw;
}

function upsertDiag(chat = null) {
    const list = globalThis.__waUpsertDiag || [];
    const out = chat ? list.filter(x => x.chat === chat) : list;
    return { total: list.length, items: out.slice(-20).reverse() };
}

async function messageRawDiag(sock, chat, id) {
    const Cache = require('./message_cache');
    const attempts = [];
    let raw = null;
    let source = null;

    const mem = Cache.rawGet(chat, id);
    attempts.push({ path: 'memory', hit: Boolean(mem) });
    if (mem) { raw = mem.raw || mem; source = 'memory'; }

    if (!raw) {
        const quo = Cache.quotedRawGet(chat, id);
        attempts.push({ path: 'quoted', hit: Boolean(quo) });
        if (quo) { raw = quo.raw || quo; source = 'quoted'; }
    }

    if (!raw) {
        try {
            const store = globalThis.__waStore;
            const list = typeof store?.loadMessages === 'function' ? await store.loadMessages(chat, 200) : [];
            const found = (list || []).find(x => x?.key?.id === id || x?.id === id);
            attempts.push({ path: 'store', hit: Boolean(found), scanned: (list || []).length });
            if (found) { raw = found; source = 'store'; }
        } catch (e) {
            attempts.push({ path: 'store', hit: false, error: e.message });
        }
    }

    if (!raw) {
        const err = new Error('Pesan mentah tidak ada di memory/quoted/store; coba balas pesannya dengan mention bot atau kirim ulang');
        err.code = 'NOT_FOUND';
        err.attempts = attempts;
        throw err;
    }

    const topKeys = Object.keys(raw?.message || {});
    const { type, body } = Cache.unwrapMessage(raw?.message);
    return {
        id,
        chat,
        source,
        attempts,
        topKeys,
        viewOnce: Cache.viewOnceOf(raw?.message),
        type,
        bodyKeys: body && typeof body === 'object' ? Object.keys(body) : [],
        hasUrl: Boolean(body?.url),
        hasDirectPath: Boolean(body?.directPath),
        hasMediaKey: Boolean(body?.mediaKey),
        hasFileSha: Boolean(body?.fileSha256),
        fileLength: body?.fileLength ? Number(body.fileLength) : null,
        mimetype: body?.mimetype || null,
        mtype: raw?.mtype || null,
        messageNull: !raw?.message
    };
}

async function groupJoin(sock, link) {
    const code = parseInviteCode(link);

    let info = null;
    try {
        info = await sock.groupGetInviteInfo(code);
    } catch (e) {
        const err = new Error('Undangan tidak bisa dibaca (mungkin sudah dicabut/kedaluwarsa): ' + (e.message || 'unknown'));
        err.code = 'INVITE_INVALID';
        err.detail = e.message || null;
        throw err;
    }

    const preview = {
        jid: info?.id || null,
        name: info?.subject || null,
        participants: typeof info?.size === 'number' ? info.size : (Array.isArray(info?.participants) ? info.participants.length : null),
        approvalRequired: Boolean(info?.joinApprovalMode),
        announce: Boolean(info?.announce)
    };

    
    if (preview.jid) {
        try {
            const meta = await sock.groupMetadata(preview.jid);
            if (meta && Array.isArray(meta.participants)) {
                return { joined: true, alreadyMember: true, pending: false, ...preview, inviteCode: code };
            }
        } catch (e) {
            
        }
    }

    let accepted = null;
    let acceptError = null;
    try {
        accepted = await sock.groupAcceptInvite(code);
    } catch (e) {
        acceptError = e;
    }

    const jid = preview.jid
        || (typeof accepted === 'string' ? accepted : accepted?.id)
        || null;

    let meta = null;
    if (jid) {
        try {
            meta = await sock.groupMetadata(jid);
        } catch (e) {
            meta = null;
        }
    }
    const isMember = Boolean(meta && Array.isArray(meta.participants));

    if (!isMember) {
        if (preview.approvalRequired) {
            return {
                joined: false,
                pending: true,
                approvalRequired: true,
                jid,
                name: preview.name,
                participants: preview.participants,
                inviteCode: code,
                note: 'Grup memakai persetujuan admin. Permintaan join sudah dikirim, tinggal tunggu admin approve.'
            };
        }
        const err = new Error('Gagal join grup: ' + (acceptError?.message || 'status keanggotaan tidak terkonfirmasi'));
        err.code = 'JOIN_FAILED';
        err.detail = acceptError?.message || null;
        throw err;
    }

    return {
        joined: true,
        pending: false,
        approvalRequired: preview.approvalRequired,
        jid,
        name: meta.subject || preview.name,
        participants: meta.participants.length,
        announce: Boolean(meta.announce),
        inviteCode: code
    };
}

async function groupLeave(sock, chat, confirm) {
    if (confirm !== true) {
        const err = new Error('Set confirm=true untuk keluar grup. Aksi ini tidak bisa dibatalkan.');
        err.code = 'NEED_CONFIRM';
        throw err;
    }
    const meta = await metadataOf(sock, chat);
    await sock.groupLeave(chat);
    return { chat, left: true, name: meta.subject };
}


async function mediaSave(sock, chat, id, { tags = null, note = null, live = true } = {}) {
    const Store = require('./media_store');
    const res = await Store.save(sock, { chat, id, tags, note, live: live !== false });
    return { chat, messageId: id || null, ...res };
}

async function voiceTranscribe(sock, chat, id, { live = true } = {}) {
    const Store = require('./media_store');
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);
    const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'wa-stt-'));
    const audioPath = path.join(tmpDir, 'voice.ogg');
    try {
        const audio = await Store.downloadRawMedia(sock, { chat, id, live: live !== false });
        const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
        if (audio.buffer.length > MAX_AUDIO_BYTES) {
            const e = new Error('audio melebihi batas 16 MB'); e.code = 'TOO_LARGE'; throw e;
        }
        fs.writeFileSync(audioPath, audio.buffer, { mode: 0o600, flag: 'wx' });
        audio.buffer = null;
        const { stdout } = await execFileAsync(
            process.env.WA_STT_PYTHON || 'python3',
            [process.env.WA_STT_SCRIPT || path.join(__dirname, 'voice_transcribe.py'), '--input', audioPath],
            { timeout: 300000, maxBuffer: 1024 * 1024, env: { ...process.env, WA_STT_MODEL_DIR: process.env.WA_STT_MODEL_DIR || path.join(require('os').homedir(), '.cache', 'whisper'), WA_STT_MODEL: process.env.WA_STT_MODEL || 'small' } }
        );
        const result = JSON.parse(stdout);
        if (!result.success) { const e = new Error(result.error || 'transkripsi gagal'); e.code = 'TRANSCRIPTION_FAILED'; throw e; }
        return { chat, messageId: id, text: result.text, language: result.language, duration: result.duration, source: audio.source, localOnly: true };
    } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
}

async function runVoiceTranscription(sock, chat, id, opts = {}) {
    try { return await voiceTranscribe(sock, chat, id, opts); }
    catch (err) {
        if (!err.code) {
            err.code = err.killed ? 'TRANSCRIPTION_TIMEOUT' : 'TRANSCRIPTION_FAILED';
            if (err.stderr) err.message = String(err.stderr).slice(-1200).trim() || err.message;
        }
        throw err;
    }
}

async function voiceTranscriberStatus() {
    try {
        const { stdout } = await require('util').promisify(require('child_process').execFile)(
            process.env.WA_STT_PYTHON || 'python3', ['-c', 'import faster_whisper; print("ready")'],
            { timeout: 10000, maxBuffer: 1024, env: { ...process.env } }
        );
        return { available: stdout.trim() === 'ready', localOnly: true, model: process.env.WA_STT_MODEL || 'small' };
    } catch (err) { return { available: false, localOnly: true, error: err.message }; }
}

function mediaList({ tags = null, kind = null, chat = null, q = null, limit = 20, offset = 0 } = {}) {
    return require('./media_store').list({ tags, kind, chat, q, limit, offset });
}

function mediaGet(ref) {
    if (!ref) { const e = new Error('ref wajib diisi (sha atau potongan sha)'); e.code = 'NO_TARGET'; throw e; }
    return require('./media_store').get(ref);
}

function mediaTag(ref, { add = null, remove = null, replace = null } = {}) {
    if (!ref) { const e = new Error('ref wajib diisi (sha atau potongan sha)'); e.code = 'NO_TARGET'; throw e; }
    return require('./media_store').tag(ref, { add, remove, replace });
}

function mediaStats() {
    const out = require('./media_store').stats();
    
    
    try {
        const Cache = require('./message_cache');
        if (typeof Cache.rawStats === 'function') out.raw = Cache.rawStats();
        out.cacheTap = {
            attached: !!global.__waControlSock?.__waCacheTap,
            ingested: Number(global.__waCacheTapCount) || 0
        };
        const st = globalThis.__waStore;
        out.store = {
            available: !!(st && typeof st.loadMessages === 'function'),
            note: st ? null : 'store Baileys belum tertangkap proses; aktif setelah pesan berikutnya masuk atau bot restart'
        };
    } catch {  }
    return out;
}

async function mediaDelete(ref) {
    if (!ref) { const e = new Error('ref wajib diisi (sha atau potongan sha)'); e.code = 'NO_TARGET'; throw e; }
    return require('./media_store').remove(ref);
}

async function mediaSend(sock, ref, { to = null, caption = null, asDocument = false } = {}) {
    const Store = require('./media_store');
    const { item, payload } = Store.payloadFor(ref, { caption, asDocument });
    const target = to || item.source?.chat;
    if (!target) { const e = new Error('tujuan kirim tidak diketahui, isi to'); e.code = 'NO_TARGET'; throw e; }
    const jid = await resolveSendJid(sock, target);
    if (!jid) { const e = new Error(`Target tidak valid: ${target}`); e.code = 'INVALID_TARGET'; throw e; }
    const sent = await sock.sendMessage(jid, payload);
    return {
        success: true,
        to: jid,
        addressing: jid.endsWith('@lid') ? 'lid' : (jid.endsWith('@g.us') ? 'group' : 'pn'),
        messageId: sent?.key?.id || null,
        item
    };
}


function json(res, code, payload) {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
}

function authorized(req, url) {
    if (!TOKEN) return false;
    const header = req.headers['x-control-token'] || req.headers['authorization'];
    const token = String(header || '').replace(/^Bearer\s+/i, '').trim();
    if (token && token === TOKEN) return true;
    const q = url.searchParams.get('token');
    return Boolean(q && q === TOKEN);
}

function createHandler(getSock) {
    return function handler(req, res) {
        const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
        const route = url.pathname.replace(/\/+$/, '') || '/';

        if (!authorized(req, url)) {
            return json(res, 401, { success: false, error: 'Unauthorized: header x-control-token tidak valid' });
        }

        const sock = typeof getSock === 'function' ? getSock() : null;

        if (route === '/health') {
            return json(res, 200, {
                success: true,
                service: 'WhatsApp Group Control API',
                version: VERSION,
                botConnected: Boolean(sock?.user?.id),
                botId: sock?.user?.id || null,
                botLid: sock?.user?.lid || null,
                port: PORT,
                actions: ['list_groups', 'group_info', 'group_members', 'group_setting', 'members_action', 'invite', 'rename', 'description', 'join_requests', 'join', 'leave', 'schedule', 'schedule_status', 'antiforward_status', 'antiforward_exempt', 'message_recent', 'message_get', 'message_search', 'message_thread', 'message_fetch', 'message_stats', 'message_delete_own', 'voice_transcribe', 'voice_transcriber_status', 'message_raw', 'upsert_diag', 'send_document', 'media_save', 'media_list', 'media_get', 'media_tag', 'media_send', 'media_delete', 'media_stats']
            });
        }

        if (!sock) {
            return json(res, 503, { success: false, error: 'Socket WhatsApp belum terhubung' });
        }

        const run = async () => {
            try {
                if (req.method === 'GET' && route === '/groups') {
                    return json(res, 200, { success: true, groups: await listGroups(sock) });
                }
                if (req.method === 'GET' && route === '/group/info') {
                    const fresh = ['1', 'true', 'yes'].includes(String(url.searchParams.get('fresh') || '').toLowerCase());
                    return json(res, 200, { success: true, ...(await groupInfo(sock, url.searchParams.get('chat'), { fresh })) });
                }
                if (req.method === 'GET' && route === '/group/members') {
                    const data = await groupMembers(sock, url.searchParams.get('chat'), {
                        filter: url.searchParams.get('filter'),
                        limit: url.searchParams.get('limit'),
                        offset: url.searchParams.get('offset')
                    });
                    return json(res, 200, { success: true, ...data });
                }
                if (req.method === 'POST' && route === '/send-document') {
                    let body = '';
                    for await (const chunk of req) body += chunk;
                    const data = JSON.parse(body || '{}');
                    const result = await sendDocument(sock, data.to || data.chat || data.target, data.filePath || data.path, data);
                    return json(res, 200, result);
                }
                if (req.method === 'POST' && route === '/group/action') {
                    let body = '';
                    for await (const chunk of req) body += chunk;
                    const data = JSON.parse(body || '{}');
                    const chat = data.chat || data.groupId || data.target;
                    const action = String(data.action || '').toLowerCase();

                    let result;
                    if (action === 'setting') {
                        result = await groupSetting(sock, chat, data.mode, data);
                    } else if (action === 'members' || action === 'kick' || action === 'add' || action === 'promote' || action === 'demote') {
                        const act = action === 'members' ? data.memberAction : action;
                        result = await groupMembersAction(sock, chat, act, data.numbers || data.number);
                    } else if (action === 'invite') {
                        result = await groupInvite(sock, chat, Boolean(data.revoke));
                    } else if (action === 'rename') {
                        result = await groupRename(sock, chat, data.subject);
                    } else if (action === 'description' || action === 'desc') {
                        result = await groupDescription(sock, chat, data.desc ?? data.description);
                    } else if (action === 'join_requests') {
                        result = await groupJoinRequests(sock, chat, data.requestAction, data.numbers || data.number);
                    } else if (action === 'upsert_diag') {
                        result = upsertDiag(chat || null);
                    } else if (action === 'message_raw') {
                        result = await messageRawDiag(sock, chat, data.id || data.messageId);
                    } else if (action === 'join' || action === 'join_group' || action === 'masuk') {
                        result = await groupJoin(sock, data.link || data.url || data.invite || data.code);
                    } else if (action === 'leave') {
                        result = await groupLeave(sock, chat, data.confirm === true);
                    } else if (action === 'schedule' || action === 'jadwal') {
                        result = await groupSchedule(sock, chat, data.closeTime || data.close, data.openTime || data.open, data.enabled !== false);
                    } else if (action === 'schedule_status' || action === 'jadwal_status') {
                        result = await groupScheduleStatus(sock, chat);
                    } else if (action === 'message_recent') {
                        result = messageRecent(chat, { limit: data.limit, sinceMinutes: data.sinceMinutes || data.since_minutes, sender: data.sender });
                    } else if (action === 'message_fetch') {
                        result = await messageFetch(sock, chat, { count: data.count, waitMs: data.waitMs, anchorId: data.anchorId || data.anchor_id || null, anchorTs: data.anchorTs || data.anchor_ts || null, fromMe: data.fromMe ?? null });
                    } else if (action === 'message_get') {
                        result = await messageGetWithLive(sock, chat, data.id || data.messageId, { live: data.live !== false });
                    } else if (action === 'message_search') {
                        result = messageSearch(chat, data.query || data.q, { limit: data.limit });
                    } else if (action === 'message_thread') {
                        result = await messageThreadWithLive(sock, chat, data.id || data.messageId, {
                            before: data.before, after: data.after, depth: data.depth, head: data.head,
                            live: data.live !== false
                        });
                    } else if (action === 'message_stats') {
                        result = messageStats();
                    } else if (action === 'message_delete_own') {
                        result = await deleteOwnMessage(sock, chat, data.id || data.messageId);
                    } else if (action === 'voice_transcribe') {
                        result = await runVoiceTranscription(sock, chat, data.id || data.messageId, { live: data.live !== false });
                    } else if (action === 'voice_transcriber_status') {
                        result = await voiceTranscriberStatus();
                    } else if (action === 'media_save') {
                        result = await mediaSave(sock, chat, data.id || data.messageId, {
                            tags: data.tags, note: data.note, live: data.live !== false
                        });
                    } else if (action === 'media_list') {
                        result = mediaList({
                            tags: data.tags, kind: data.kind || data.type, chat: data.chatFilter || null,
                            q: data.query || data.q, limit: data.limit, offset: data.offset
                        });
                    } else if (action === 'media_get') {
                        result = mediaGet(data.ref || data.sha256 || data.sha);
                    } else if (action === 'media_tag') {
                        result = mediaTag(data.ref || data.sha256 || data.sha, {
                            add: data.add || data.tags, remove: data.remove, replace: data.replace
                        });
                    } else if (action === 'media_send') {
                        result = await mediaSend(sock, data.ref || data.sha256 || data.sha, {
                            to: data.to, caption: data.caption, asDocument: Boolean(data.asDocument)
                        });
                    } else if (action === 'media_delete') {
                        result = await mediaDelete(data.ref || data.sha256 || data.sha);
                    } else if (action === 'media_stats') {
                        result = mediaStats();
                    } else if (action === 'antiforward_status') {
                        result = await antiforwardStatus(chat);
                    } else if (action === 'antiforward_exempt') {
                        result = await antiforwardExempt(sock, chat, data.type, data.target, data.exemptAction || data.action2 || data.operation || 'add', data.addedBy);
                    } else {
                        return json(res, 400, { success: false, error: 'action tidak dikenal', valid: ['setting', 'members', 'invite', 'rename', 'description', 'join_requests', 'leave', 'schedule', 'schedule_status', 'antiforward_status', 'antiforward_exempt', 'message_recent', 'message_get', 'message_search', 'message_thread', 'message_fetch', 'message_stats', 'voice_transcribe', 'voice_transcriber_status', 'send_document', 'media_save', 'media_list', 'media_get', 'media_tag', 'media_send', 'media_delete', 'media_stats'] });
                    }
                    return json(res, 200, { success: result.success !== false, ...result });
                }
                return json(res, 404, { success: false, error: `Route ${route} tidak ada` });
            } catch (err) {
                const code = err.code === 'BOT_NOT_ADMIN' ? 409
                    : ['NOT_A_GROUP', 'INVALID_MODE', 'INVALID_ACTION', 'NEED_CONFIRM', 'NO_TARGET', 'INVALID_DURATION', 'INVALID_TIME', 'LIMIT_REACHED', 'NOT_FOUND', 'NO_ANCHOR', 'LIVE_UNSUPPORTED', 'NO_SUBJECT', 'NO_DESC', 'NO_FILE', 'BLOCKED_PATH', 'TOO_LARGE', 'INVALID_TARGET', 'NO_MEDIA', 'MEDIA_NOT_FOUND', 'AMBIGUOUS_REF', 'STORE_FULL', 'DOWNLOAD_FAILED', 'DOWNLOAD_TIMEOUT', 'NOT_OWN_MESSAGE', 'SOCKET_UNAVAILABLE'].includes(err.code) ? 400
                        : 500;
                return json(res, code, { success: false, error: err.message, code: err.code || 'ERROR' });
            }
        };

        run().catch(e => json(res, 500, { success: false, error: e.message }));
    };
}

function install(getSock) {
    global.__waControlHandler = createHandler(getSock);

    const existing = global.__waControlServer;
    if (existing && existing.listening) return existing;

    const server = http.createServer((req, res) => {
        const h = global.__waControlHandler;
        if (typeof h === 'function') return h(req, res);
        return json(res, 503, { success: false, error: 'Handler belum siap' });
    });

    server.on('error', (e) => {
        console.error('[CONTROL API] Server error:', e.message);
    });

    server.listen(PORT, HOST, () => {
        console.log(`[CONTROL API] v${VERSION} listening on http://${HOST}:${PORT} (token: ${TOKEN_FILE})`);
    });

    global.__waControlServer = server;
    return server;
}

function stop() {
    const s = global.__waControlServer;
    if (s) {
        try { s.close(); } catch (_) {}
        global.__waControlServer = null;
        console.log('[CONTROL API] Stopped');
    }
}

module.exports = {
    install,
    stop,
    PORT,
    VERSION,
    TOKEN_FILE,
    messageFetch,
    mediaSave,
    mediaList,
    mediaGet,
    mediaTag,
    mediaSend,
    mediaDelete,
    mediaStats,
    groupJoin,
    messageRawDiag,
    upsertDiag,
    parseInviteCode,
    _internal: { digits, toJid, findParticipant, isBotAdminIn, participantView, createHandler, deleteOwnMessage }
};
