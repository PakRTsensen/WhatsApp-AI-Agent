
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = process.env.WA_MEDIA_DIR || path.join(__dirname, 'database/media');
const INDEX_FILE = process.env.WA_MEDIA_INDEX || path.join(__dirname, 'database/media_store.json');

const MAX_ITEM_BYTES = Number(process.env.WA_MEDIA_MAX_ITEM || 100 * 1024 * 1024);
const MAX_TOTAL_BYTES = Number(process.env.WA_MEDIA_MAX_TOTAL || 2 * 1024 * 1024 * 1024);
const MAX_TAGS = 20;
const MAX_TAG_LEN = 32;
const DOWNLOAD_TIMEOUT_MS = Number(process.env.WA_MEDIA_TIMEOUT_MS || 60000);


const MEDIA_TYPES = new Set([
    'imageMessage', 'videoMessage', 'audioMessage', 'documentMessage',
    'documentWithCaptionMessage', 'stickerMessage'
]);

const KIND_BY_TYPE = {
    imageMessage: 'image',
    videoMessage: 'video',
    audioMessage: 'audio',
    documentMessage: 'document',
    documentWithCaptionMessage: 'document',
    stickerMessage: 'sticker'
};

const EXT_BY_MIME = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
    'video/mp4': 'mp4', 'video/3gpp': '3gp', 'video/quicktime': 'mov', 'video/webm': 'webm',
    'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/opus': 'opus',
    'audio/aac': 'aac', 'audio/amr': 'amr', 'audio/wav': 'wav',
    'application/pdf': 'pdf', 'application/zip': 'zip', 'application/gzip': 'gz',
    'application/json': 'json', 'text/plain': 'txt', 'text/csv': 'csv',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-powerpoint': 'ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/vnd.android.package-archive': 'apk'
};

let injectedDownloader = null;

function setDownloader(fn) {
    injectedDownloader = typeof fn === 'function' ? fn : null;
}


function emptyIndex() {
    return { _v: 1, updatedAt: null, items: {} };
}

function readIndex() {
    try {
        if (!fs.existsSync(INDEX_FILE)) return emptyIndex();
        const parsed = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
        if (!parsed || typeof parsed !== 'object') return emptyIndex();
        if (!parsed.items || typeof parsed.items !== 'object') parsed.items = {};
        if (parsed._v !== 1) parsed._v = 1;
        return parsed;
    } catch (err) {
        console.error('[MEDIA STORE] indeks rusak, mulai kosong:', err.message);
        return emptyIndex();
    }
}

function writeIndex(index) {
    index._v = 1;
    index.updatedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(INDEX_FILE), { recursive: true });
    const tmp = `${INDEX_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(index, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, INDEX_FILE);
    return index;
}

function ensureDir() {
    fs.mkdirSync(DIR, { recursive: true });
}


function err(message, code) {
    const e = new Error(message);
    e.code = code;
    return e;
}

function safeName(name, fallback) {
    const raw = String(name || '').replace(/\\/g, '/').split('/').pop();
    const cleaned = raw
        .normalize('NFKD')
        .replace(/[^\w.\- ]+/g, '_')
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^[._]+/, '')
        .slice(0, 80);
    return cleaned || fallback;
}

function extFor(mimetype, kind, fileName) {
    const fromName = fileName ? path.extname(fileName).replace(/^\./, '').toLowerCase() : '';
    if (fromName && /^[a-z0-9]{1,5}$/.test(fromName)) return fromName;
    const byMime = EXT_BY_MIME[String(mimetype || '').toLowerCase()];
    if (byMime) return byMime;
    if (kind === 'image') return 'jpg';
    if (kind === 'video') return 'mp4';
    if (kind === 'audio') return 'ogg';
    if (kind === 'sticker') return 'webp';
    return 'bin';
}

function normTags(input) {
    const list = Array.isArray(input)
        ? input
        : String(input || '').split(',');
    const out = [];
    for (const item of list) {
        const tag = String(item || '')
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9._-]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, MAX_TAG_LEN);
        if (!tag) continue;
        if (!out.includes(tag)) out.push(tag);
        if (out.length >= MAX_TAGS) break;
    }
    return out;
}

function kindOfType(type) {
    return KIND_BY_TYPE[type] || null;
}

function isMediaType(type) {
    return MEDIA_TYPES.has(type);
}

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function totalBytes(index) {
    return Object.values(index.items).reduce((sum, it) => sum + (Number(it.bytes) || 0), 0);
}

function findItem(index, ref) {
    const key = String(ref || '').trim().toLowerCase();
    if (!key) return null;
    if (index.items[key]) return index.items[key];
    const matches = Object.keys(index.items).filter((sha) => sha.startsWith(key));
    if (matches.length === 1) return index.items[matches[0]];
    if (matches.length > 1) throw err(`ref "${ref}" ambigu (${matches.length} item cocok), pakai sha lebih panjang`, 'AMBIGUOUS_REF');
    const byName = Object.values(index.items).filter((it) => String(it.fileName || '').toLowerCase() === key
        || String(it.file || '').toLowerCase() === key);
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) throw err(`nama file "${ref}" dipakai ${byName.length} item, pakai sha`, 'AMBIGUOUS_REF');
    return null;
}

function filePathOf(item) {
    return path.join(DIR, item.file);
}

function publicView(item) {
    if (!item) return null;
    return {
        sha256: item.sha256,
        ref: item.sha256.slice(0, 12),
        kind: item.kind,
        fileName: item.fileName,
        mimetype: item.mimetype,
        bytes: item.bytes,
        sizeLabel: `${(item.bytes / 1024).toFixed(1)} KB`,
        caption: item.caption || null,
        width: item.width || null,
        height: item.height || null,
        seconds: item.seconds || null,
        pageCount: item.pageCount || null,
        animated: item.animated ?? null,
        viewOnce: item.viewOnce ?? false,
        tags: item.tags || [],
        note: item.note || null,
        source: item.source || null,
        savedAt: item.savedAt || null,
        refs: item.refs || 1,
        path: filePathOf(item)
    };
}


async function resolveRaw(sock, chat, id, { live = true, fetchCount = 200 } = {}) {
    const Cache = require('./message_cache');
    const chatId = Cache.normJid(chat);
    const messageId = String(id || '').trim();
    if (!chatId || !messageId) throw err('chat dan id wajib diisi', 'NO_TARGET');

    let raw = Cache.rawGet(chatId, messageId);
    if (raw) return { raw, source: 'memory' };

    
    
    const quoted = Cache.quotedRawGet(chatId, messageId);
    if (quoted) return { raw: quoted, source: 'quoted' };

    const store = globalThis.__waStore;
    if (store && typeof store.loadMessages === 'function') {
        try {
            const list = store.loadMessages(chatId, Math.max(1, Number(fetchCount) || 200)) || [];
            Cache.ingestRaw(list, { source: 'store' });
            raw = Cache.rawGet(chatId, messageId);
            if (raw) return { raw, source: 'store' };
        } catch (_) {  }
    }

    if (live && sock && typeof sock.fetchMessageHistory === 'function') {
        const Api = require('./group_control_api');
        try {
            await Api.messageFetch(sock, chatId, { count: Math.min(Number(fetchCount) || 50, 200), waitMs: 6000 });
        } catch (_) {  }
        raw = Cache.rawGet(chatId, messageId);
        if (raw) return { raw, source: 'live' };
    }

    
    
    const rec = Cache.get(chatId, messageId);
    if (rec) {
        if (!isMediaType(rec.type)) {
            throw err(`pesan ini bukan media (jenis: ${rec.type || 'teks'}); yang bisa disimpan: dokumen, gambar, video, audio, sticker`, 'NO_MEDIA');
        }
        throw err('pesan bermedia ini ada di metadata cache tapi isi mentahnya sudah keluar dari memory; kirim ulang pesannya lalu simpan lagi', 'NOT_FOUND');
    }

    throw err('media tidak ketemu di memory, quotedMessage, store, maupun riwayat live; balas pesan medianya dengan mention bot (supaya quotedMessage terekam) atau kirim ulang file-nya', 'NOT_FOUND');
}


function contentOf(raw) {
    const Cache = require('./message_cache');
    const { type, body } = Cache.unwrapMessage(raw?.message);
    return { type, body };
}

async function collectStream(content, kind, maxBytes = MAX_ITEM_BYTES) {
    let downloader = injectedDownloader;
    if (!downloader) {
        const { downloadContentFromMessage } = require('@itsliaaa/baileys');
        downloader = (c, k) => downloadContentFromMessage(c, k);
    }

    let timer = null;
    let stream = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            try { stream?.destroy?.(); } catch (_) {  }
            reject(err(`unduh media melebihi ${DOWNLOAD_TIMEOUT_MS} ms`, 'DOWNLOAD_TIMEOUT'));
        }, DOWNLOAD_TIMEOUT_MS);
        if (typeof timer.unref === 'function') timer.unref();
    });

    const task = (async () => {
        stream = await downloader(content, kind);
        const chunks = [];
        let size = 0;
        for await (const chunk of stream) {
            size += chunk.length;
            if (size > maxBytes) throw err(`media melebihi batas ${maxBytes} byte`, 'TOO_LARGE');
            chunks.push(chunk);
        }
        return Buffer.concat(chunks);
    })();

    try {
        return await Promise.race([task, timeout]);
    } finally {
        if (timer) clearTimeout(timer);
        task.catch(() => {});
    }
}

async function downloadRawMedia(sock, { chat, id, live = true } = {}) {
    const resolved = await resolveRaw(sock, chat, id, { live });
    let { raw, source } = resolved;
    let { type, body } = contentOf(raw);
    if (body && !body.url && !body.directPath && body.mediaKey && typeof sock?.updateMediaMessage === 'function') {
        try {
            const refreshed = await sock.updateMediaMessage(raw);
            if (refreshed?.message) {
                raw = refreshed;
                const next = contentOf(raw);
                type = next.type;
                body = next.body;
                source = `${source}+retry`;
            }
        } catch (e) {
            console.warn('[MEDIA STORE] media retry gagal:', e.message);
        }
    }
    if (!isMediaType(type) || type !== 'audioMessage' || !body) {
        throw err(`pesan ini bukan audio/voice note (jenis: ${type || 'tidak diketahui'})`, 'NO_MEDIA');
    }
    const meta = require('./message_cache').mediaOf(type, body) || {};
    if (Number(meta.seconds) > 600) throw err('audio melebihi batas transkripsi 10 menit', 'TOO_LARGE');
    const buffer = await collectStream(body, 'audio', 16 * 1024 * 1024);
    if (!buffer.length) throw err('unduhan media kosong', 'DOWNLOAD_FAILED');
    return { buffer, source, type, mimetype: body.mimetype || null, seconds: Number(meta.seconds) || null };
}

async function save(sock, { chat, id, tags, note = null, live = true } = {}) {
    const Cache = require('./message_cache');
    const resolved = await resolveRaw(sock, chat, id, { live });
    let { raw, source } = resolved;
    let { type, body } = contentOf(raw);

    
    
    
    if (body && !body.url && !body.directPath && body.mediaKey && typeof sock?.updateMediaMessage === 'function') {
        try {
            const refreshed = await sock.updateMediaMessage(raw);
            const next = refreshed?.message ? refreshed : null;
            if (next) {
                raw = next;
                const again = contentOf(raw);
                type = again.type;
                body = again.body;
                source = `${source}+retry`;
            }
        } catch (e) {
            console.warn('[MEDIA STORE] media retry gagal:', e.message);
        }
    }

    if (!isMediaType(type)) {
        throw err(`pesan ini bukan media (jenis: ${type || 'teks'}); yang bisa disimpan: dokumen, gambar, video, audio, sticker`, 'NO_MEDIA');
    }
    if (!body) throw err('isi media tidak ada di pesan ini', 'NO_MEDIA');

    
    
    const meta = Cache.mediaOf(type, body) || {};
    const kind = meta.kind || kindOfType(type);
    const downloadKind = kind === 'document' ? 'document' : (kind === 'sticker' ? 'sticker' : (kind === 'voice_note' ? 'audio' : kind));
    const buffer = await collectStream(body, downloadKind);
    if (!buffer.length) throw err('unduhan media kosong', 'DOWNLOAD_FAILED');
    if (buffer.length > MAX_ITEM_BYTES) throw err(`media melebihi batas ${MAX_ITEM_BYTES} byte`, 'TOO_LARGE');

    const index = readIndex();
    const hash = sha256(buffer);
    const chatId = Cache.normJid(raw.key?.remoteJid || chat);
    const sender = Cache.normJid(raw.key?.participant || (raw.key?.fromMe ? 'me' : chatId));
    const tsRaw = Number(raw.messageTimestamp || 0) * 1000;
    const ts = Number.isFinite(tsRaw) && tsRaw > 0 ? tsRaw : null;

    const existing = index.items[hash];
    if (existing) {
        
        const merged = normTags([...(existing.tags || []), ...normTags(tags)]);
        existing.tags = merged;
        if (note && String(note).trim()) existing.note = String(note).trim().slice(0, 300);
        existing.refs = (Number(existing.refs) || 1) + 1;
        existing.lastSavedAt = new Date().toISOString();
        writeIndex(index);
        return {
            success: true,
            duplicate: true,
            source,
            item: publicView(existing)
        };
    }

    const used = totalBytes(index);
    if (used + buffer.length > MAX_TOTAL_BYTES) {
        throw err(`arsip penuh: ${(used / 1048576).toFixed(1)} MB terpakai, batas ${(MAX_TOTAL_BYTES / 1048576).toFixed(0)} MB. Hapus item lama dulu.`, 'STORE_FULL');
    }

    ensureDir();
    const fileName = safeName(meta.fileName || body.fileName, `${kind}.${extFor(body.mimetype, kind, meta.fileName || body.fileName)}`);
    const ext = extFor(body.mimetype, kind, fileName);
    const file = `${hash.slice(0, 8)}_${fileName.replace(new RegExp(`\\.${ext}$`, 'i'), '')}.${ext}`;
    fs.writeFileSync(path.join(DIR, file), buffer, { mode: 0o600 });

    index.items[hash] = {
        sha256: hash,
        file,
        kind,
        fileName: fileName.includes('.') ? fileName : `${fileName}.${ext}`,
        mimetype: body.mimetype || null,
        bytes: buffer.length,
        width: meta.width || null,
        height: meta.height || null,
        seconds: meta.seconds || null,
        pageCount: meta.pageCount || null,
        animated: meta.animated ?? null,
        viewOnce: Boolean(Cache.viewOnceOf(raw?.message) || body.viewOnce),
        caption: meta.caption || null,
        tags: normTags(tags),
        note: note && String(note).trim() ? String(note).trim().slice(0, 300) : null,
        source: {
            chat: chatId,
            chatType: chatId.endsWith('@g.us') ? 'group' : 'private',
            messageId: raw.key?.id || null,
            time: ts ? Cache.isoWib(ts) : null,
            sender: sender || null,
            senderNumber: Cache.digitsOf(sender) || null,
            pushName: raw.pushName || null,
            fromMe: Boolean(raw.key?.fromMe),
            type
        },
        refs: 1,
        savedAt: new Date().toISOString()
    };
    writeIndex(index);

    return {
        success: true,
        duplicate: false,
        source,
        item: publicView(index.items[hash])
    };
}


function list({ tags = null, kind = null, chat = null, q = null, limit = 20, offset = 0 } = {}) {
    const index = readIndex();
    const wantTags = normTags(tags);
    const wantKind = kind ? String(kind).toLowerCase() : null;
    const needle = q ? String(q).toLowerCase() : null;
    const chatFilter = chat ? require('./message_cache').normJid(chat) : null;

    let items = Object.values(index.items);
    if (wantTags.length) items = items.filter((it) => wantTags.every((t) => (it.tags || []).includes(t)));
    if (wantKind) items = items.filter((it) => it.kind === wantKind);
    if (chatFilter) items = items.filter((it) => it.source?.chat === chatFilter);
    if (needle) {
        items = items.filter((it) => [
            it.fileName, it.caption, it.note, it.mimetype, it.kind,
            (it.tags || []).join(' '), it.source?.pushName, it.source?.senderNumber
        ].filter(Boolean).join(' ').toLowerCase().includes(needle));
    }

    items.sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')));
    const total = items.length;
    const page = items.slice(Math.max(0, Number(offset) || 0), Math.max(0, Number(offset) || 0) + Math.max(1, Number(limit) || 20));
    return {
        success: true,
        total,
        count: page.length,
        offset: Math.max(0, Number(offset) || 0),
        filters: { tags: wantTags, kind: wantKind, chat: chatFilter, q: needle },
        items: page.map(publicView)
    };
}

function get(ref) {
    const index = readIndex();
    const item = findItem(index, ref);
    if (!item) throw err(`media "${ref}" tidak ada di arsip`, 'MEDIA_NOT_FOUND');
    if (!fs.existsSync(filePathOf(item))) throw err(`file media hilang dari disk: ${item.file}`, 'MEDIA_NOT_FOUND');
    return { success: true, item: publicView(item) };
}

function tag(ref, { add = null, remove = null, replace = null } = {}) {
    const index = readIndex();
    const item = findItem(index, ref);
    if (!item) throw err(`media "${ref}" tidak ada di arsip`, 'MEDIA_NOT_FOUND');

    if (replace !== null && replace !== undefined) {
        item.tags = normTags(replace);
    } else {
        const added = normTags(add);
        const removed = normTags(remove);
        if (!added.length && !removed.length) throw err('isi add atau remove (atau replace) untuk mengubah tag', 'NO_TARGET');
        const next = (item.tags || []).filter((t) => !removed.includes(t));
        for (const t of added) if (!next.includes(t)) next.push(t);
        item.tags = next.slice(0, MAX_TAGS);
    }
    writeIndex(index);
    return { success: true, item: publicView(item) };
}

function remove(ref, { deleteFile = true } = {}) {
    const index = readIndex();
    const item = findItem(index, ref);
    if (!item) throw err(`media "${ref}" tidak ada di arsip`, 'MEDIA_NOT_FOUND');
    const file = filePathOf(item);
    if (deleteFile && fs.existsSync(file)) {
        try { fs.unlinkSync(file); } catch (e) { console.error('[MEDIA STORE] gagal hapus file:', e.message); }
    }
    delete index.items[item.sha256];
    writeIndex(index);
    return { success: true, removed: publicView(item), fileDeleted: deleteFile && !fs.existsSync(file) };
}

function stats() {
    const index = readIndex();
    const items = Object.values(index.items);
    const byKind = {};
    for (const it of items) byKind[it.kind] = (byKind[it.kind] || 0) + 1;
    const tagCount = {};
    for (const it of items) for (const t of it.tags || []) tagCount[t] = (tagCount[t] || 0) + 1;
    const bytes = totalBytes(index);
    return {
        success: true,
        items: items.length,
        bytes,
        sizeLabel: `${(bytes / 1048576).toFixed(2)} MB`,
        limitBytes: MAX_TOTAL_BYTES,
        limitLabel: `${(MAX_TOTAL_BYTES / 1048576).toFixed(0)} MB`,
        freeBytes: Math.max(0, MAX_TOTAL_BYTES - bytes),
        byKind,
        tags: Object.entries(tagCount).sort((a, b) => b[1] - a[1]).map(([tag, count]) => ({ tag, count })),
        dir: DIR,
        updatedAt: index.updatedAt
    };
}

function payloadFor(ref, { caption = null, asDocument = false } = {}) {
    const { item } = get(ref);
    const buffer = fs.readFileSync(item.path);
    const cap = caption ? String(caption).replace(/\*\*(.+?)\*\*/g, '*$1*') : (item.caption || undefined);

    if (asDocument) {
        return { item, payload: { document: buffer, fileName: item.fileName, mimetype: item.mimetype || 'application/octet-stream', caption: cap } };
    }
    switch (item.kind) {
        case 'image':
            return { item, payload: { image: buffer, mimetype: item.mimetype || 'image/jpeg', caption: cap } };
        case 'video':
            return { item, payload: { video: buffer, mimetype: item.mimetype || 'video/mp4', caption: cap } };
        case 'audio':
            return { item, payload: { audio: buffer, mimetype: item.mimetype || 'audio/ogg', ptt: item.kind === 'voice_note' } };
        case 'sticker':
            return { item, payload: { sticker: buffer } };
        default:
            return { item, payload: { document: buffer, fileName: item.fileName, mimetype: item.mimetype || 'application/octet-stream', caption: cap } };
    }
}

module.exports = {
    DIR,
    INDEX_FILE,
    MAX_ITEM_BYTES,
    MAX_TOTAL_BYTES,
    MAX_TAGS,
    isMediaType,
    kindOfType,
    normTags,
    save,
    downloadRawMedia,
    list,
    get,
    tag,
    remove,
    stats,
    payloadFor,
    resolveRaw,
    readIndex,
    findItem,
    setDownloader
};
