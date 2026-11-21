
const MAX_PER_CHAT = 500;
const MAX_CHATS = 50;
const MAX_TEXT = 800;




const STATE = globalThis.__waMessageCacheState || (globalThis.__waMessageCacheState = { cache: new Map() });
const cache = STATE.cache; 




const RAW_MAX = Number(process.env.WA_RAW_MAX || 300);
const RAW = globalThis.__waRawState || (globalThis.__waRawState = { map: new Map(), keys: [] });

const RAW_MEDIA_TYPES = new Set([
    'imageMessage', 'videoMessage', 'audioMessage', 'documentMessage',
    'documentWithCaptionMessage', 'stickerMessage'
]);

function rawKeyOf(chat, id) {
    return `${normJid(chat)}|${String(id || '').trim()}`;
}

function contextInfoOf(message) {
    if (!message) return null;
    const direct = message.extendedTextMessage?.contextInfo
        || message.imageMessage?.contextInfo
        || message.videoMessage?.contextInfo
        || message.documentMessage?.contextInfo
        || message.documentWithCaptionMessage?.contextInfo
        || message.audioMessage?.contextInfo
        || message.stickerMessage?.contextInfo;
    if (direct) return direct;
    const inner = unwrapMessage(message).body;
    return inner?.contextInfo || null;
}

function quotedMediaOf(msg) {
    const ctx = contextInfoOf(msg?.message);
    if (!ctx || !ctx.quotedMessage) return null;
    const q = unwrapMessage(ctx.quotedMessage);
    if (!q.type || !RAW_MEDIA_TYPES.has(q.type)) return null;
    return { id: ctx.stanzaId || null, type: q.type, body: ctx.quotedMessage, participant: ctx.participant || null };
}

function keepRaw(msg, chatHint = null) {
    if (!msg) return false;
    const chat = normJid(msg.chat || msg.key?.remoteJid || chatHint);
    const id = msg.key?.id || msg.id;
    if (!chat || !id) return false;
    const type = msg.mtype || (msg.message ? (Object.keys(msg.message)[0] || null) : null);
    if (!type) return false;
    const unwrapped = RAW_MEDIA_TYPES.has(type) ? type : (msg.message ? unwrapMessage(msg.message).type : null);
    const isMedia = !!unwrapped && RAW_MEDIA_TYPES.has(unwrapped);
    
    
    const quoted = isMedia ? null : quotedMediaOf(msg);
    if (!isMedia && !quoted) return false;

    const key = rawKeyOf(chat, id);
    const entry = {
        chat,
        key: msg.key || { id, remoteJid: chat },
        message: msg.message || null,
        msg: msg.msg || null,
        mtype: isMedia ? unwrapped : type,
        quoted,
        pushName: msg.pushName || null,
        messageTimestamp: msg.messageTimestamp || null
    };
    if (!RAW.map.has(key)) RAW.keys.push(key);
    RAW.map.set(key, entry);
    while (RAW.keys.length > RAW_MAX) {
        const old = RAW.keys.shift();
        RAW.map.delete(old);
    }
    return true;
}

function rawGet(chat, id) {
    return RAW.map.get(rawKeyOf(chat, id)) || null;
}

function quotedRawGet(chat, id) {
    const want = String(id || '').trim();
    const chatId = normJid(chat);
    if (!want || !chatId) return null;
    for (const entry of RAW.map.values()) {
        if (entry.chat !== chatId) continue;
        if (!entry.quoted || entry.quoted.id !== want) continue;
        return {
            key: { id: want, remoteJid: chatId },
            message: entry.quoted.body,
            mtype: entry.quoted.type,
            quoted: true,
            quotedFrom: entry.key?.id || null
        };
    }
    return null;
}

function rawStats() {
    return {
        kept: RAW.map.size,
        max: RAW_MAX,
        storage: 'memory',
        sample: RAW.keys.slice(-8)
    };
}

function normJid(value) {
    if (!value) return '';
    return String(value).replace(/:\d+(?=@)/, '').trim();
}

function digitsOf(value) {
    if (!value) return '';
    return normJid(value).split('@')[0].replace(/[^0-9]/g, '');
}

function clip(text, max = MAX_TEXT) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    return s.length > max ? `${s.slice(0, max)}…` : s;
}

function isoWib(ms) {
    const d = new Date(ms);
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Jakarta',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).formatToParts(d).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} WIB`;
}

function relativeFrom(ms, now = Date.now()) {
    const diff = Math.max(0, now - ms);
    const s = Math.floor(diff / 1000);
    if (s < 60) return `${s} detik lalu`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} menit lalu`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} jam lalu`;
    return `${Math.floor(h / 24)} hari lalu`;
}

function mediaOf(mtype, msg) {
    if (!msg || !mtype) return null;
    
    
    const body = msg[mtype] && typeof msg[mtype] === 'object' ? msg[mtype] : msg;
    switch (mtype) {
        case 'imageMessage':
            return {
                kind: 'image',
                mimetype: body.mimetype || null,
                bytes: body.fileLength ? Number(body.fileLength) : null,
                width: body.width || null,
                height: body.height || null,
                caption: clip(body.caption, 300) || null
            };
        case 'videoMessage':
            return {
                kind: 'video',
                mimetype: body.mimetype || null,
                bytes: body.fileLength ? Number(body.fileLength) : null,
                seconds: body.seconds || null,
                caption: clip(body.caption, 300) || null
            };
        case 'documentMessage':
            return {
                kind: 'document',
                fileName: body.fileName || null,
                mimetype: body.mimetype || null,
                bytes: body.fileLength ? Number(body.fileLength) : null,
                pageCount: body.pageCount || null,
                caption: clip(body.caption, 300) || null
            };
        case 'audioMessage':
            return {
                kind: body.ptt ? 'voice_note' : 'audio',
                mimetype: body.mimetype || null,
                bytes: body.fileLength ? Number(body.fileLength) : null,
                seconds: body.seconds || null
            };
        case 'stickerMessage':
            return {
                kind: 'sticker',
                mimetype: body.mimetype || null,
                bytes: body.fileLength ? Number(body.fileLength) : null,
                animated: Boolean(body.isAnimated)
            };
        case 'locationMessage':
            return {
                kind: 'location',
                latitude: body.degreesLatitude ?? null,
                longitude: body.degreesLongitude ?? null,
                name: body.name || null,
                address: body.address || null
            };
        case 'liveLocationMessage':
            return {
                kind: 'live_location',
                latitude: body.degreesLatitude ?? null,
                longitude: body.degreesLongitude ?? null,
                caption: clip(body.caption, 200) || null
            };
        case 'contactMessage':
            return { kind: 'contact', displayName: body.displayName || null };
        case 'contactsArrayMessage':
            return { kind: 'contacts', count: Array.isArray(body.contacts) ? body.contacts.length : null };
        case 'pollCreationMessage':
        case 'pollCreationMessageV2':
        case 'pollCreationMessageV3':
            return {
                kind: 'poll',
                name: body.name || null,
                options: Array.isArray(body.options) ? body.options.map(o => o.optionName).filter(Boolean) : []
            };
        case 'reactionMessage':
            return { kind: 'reaction', emoji: body.text || null, targetId: body.key?.id || null };
        case 'protocolMessage':
            return {
                kind: 'protocol',
                protocolType: body.type ?? null,
                targetId: body.key?.id || null,
                editedText: clip(body.editedMessage?.conversation || body.editedMessage?.extendedTextMessage?.text, 300) || null
            };
        default:
            return null;
    }
}

function quotedOf(m, depth = 0) {
    const q = m?.quoted;
    if (!q || depth > 4) return null;
    const qtype = q.mtype || null;
    const qmsg = q.msg || null;
    const inner = q.quoted || null;
    let nested = inner ? quotedOf({ quoted: inner }, depth + 1) : null;

    if (!nested) {
        const ctx = qmsg?.contextInfo || null;
        const stanzaId = ctx?.stanzaId || null;
        const innerMsg = ctx?.quotedMessage || null;
        if (stanzaId && innerMsg) {
            const innerType = Object.keys(innerMsg)[0] || null;
            const innerBody = innerType ? innerMsg[innerType] : null;
            nested = {
                id: stanzaId,
                sender: normJid(ctx.participant) || null,
                senderNumber: digitsOf(ctx.participant) || null,
                pushName: null,
                fromMe: false,
                ts: null,
                type: innerType,
                text: clip(typeof innerBody === 'string' ? innerBody : (innerBody?.text || innerBody?.caption || innerBody?.conversation), 400) || null,
                media: mediaOf(innerType, innerBody),
                quoted: null
            };
        }
    }

    return {
        id: q.key?.id || q.id || null,
        sender: normJid(q.sender || q.key?.participant) || null,
        senderNumber: digitsOf(q.sender || q.key?.participant) || null,
        pushName: q.pushName || null,
        fromMe: Boolean(q.key?.fromMe),
        ts: Number(q.messageTimestamp || 0) * 1000 || null,
        type: qtype,
        text: clip(
            q.text || q.caption || q.conversation
            || qmsg?.conversation || qmsg?.extendedTextMessage?.text
            || (qtype && qmsg?.[qtype]?.text) || (qtype && qmsg?.[qtype]?.caption),
            400
        ) || null,
        media: mediaOf(qtype, qmsg),
        quoted: nested
    };
}

function mentionsOf(m) {
    const msg = m?.msg || {};
    const list = msg.contextInfo?.mentionedJid || m?.mentionedJid || [];
    return Array.isArray(list) ? list.map(normJid).filter(Boolean).slice(0, 20) : [];
}

function forwardOf(m) {
    const ctx = m?.msg?.contextInfo || m?.message?.extendedTextMessage?.contextInfo || {};
    const info = ctx.forwardedNewsletterMessageInfo;
    const forwarded = Boolean(ctx.isForwarded || info || ctx.forwardOrigin !== undefined);
    if (!forwarded) return null;
    return {
        forwarded: true,
        origin: ctx.forwardOrigin ?? null,
        newsletterJid: info?.newsletterJid || ctx.newsletterJid || null,
        newsletterName: info?.newsletterName || null
    };
}

function buildRecord(m, extra = {}) {
    if (!m || !m.chat) return null;
    
    
    const tsRaw = Number(m.messageTimestamp || extra.timestamp || 0) * 1000;
    const ts = Number.isFinite(tsRaw) && tsRaw > 0 ? tsRaw : null;
    const sender = normJid(extra.sender || m.sender || m.key?.participant);
    const type = m.mtype || null;
    return {
        id: m.key?.id || null,
        chat: normJid(m.chat),
        chatType: String(m.chat).endsWith('@g.us') ? 'group' : (String(m.chat).endsWith('@newsletter') ? 'channel' : 'private'),
        chatName: extra.chatName || null,
        sender,
        senderNumber: digitsOf(sender) || null,
        senderPn: normJid(extra.senderPn || m.senderPn) || null,
        senderLid: normJid(extra.senderLid || m.senderLid) || null,
        pushName: m.pushName || extra.pushName || null,
        fromMe: Boolean(m.key?.fromMe),
        viewOnce: viewOnceOf(m?.message) || Boolean(m?.msg?.viewOnce) || false,
        ts,
        iso: ts ? isoWib(ts) : null,
        type,
        text: clip(m.text || m.body || m.msg?.conversation || m.msg?.extendedTextMessage?.text, MAX_TEXT) || null,
        media: mediaOf(type, m.msg),
        mentions: mentionsOf(m),
        quoted: quotedOf(m),
        forward: forwardOf(m),
        recordedAt: Date.now()
    };
}

function viewOnceOf(message) {
    if (!message || typeof message !== 'object') return false;
    const ONCE = ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension'];
    const WRAP = ['ephemeralMessage', 'documentWithCaptionMessage', 'editedMessage', 'deviceSentMessage'];
    let cur = message;
    for (let depth = 0; depth < 6 && cur && typeof cur === 'object'; depth++) {
        const key = Object.keys(cur)[0];
        if (!key) return false;
        if (ONCE.includes(key)) return true;
        if (!WRAP.includes(key)) {
            const body = cur[key];
            return Boolean(body && typeof body === 'object' && body.viewOnce);
        }
        cur = cur[key]?.message || null;
    }
    return false;
}

function unwrapMessage(message) {
    if (!message) return { type: null, body: null };
    let type = Object.keys(message)[0] || null;
    let body = type ? message[type] : null;
    const wrappers = [
        'ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2',
        'viewOnceMessageV2Extension', 'documentWithCaptionMessage',
        'editedMessage', 'deviceSentMessage'
    ];
    while (type && wrappers.includes(type) && body?.message) {
        const inner = body.message;
        type = Object.keys(inner)[0] || null;
        body = type ? inner[type] : null;
    }
    return { type, body };
}

function fromRawMessage(raw, extra = {}) {
    if (!raw || !raw.key) return null;
    const chat = normJid(raw.key.remoteJid || extra.chat);
    if (!chat) return null;
    const { type, body } = unwrapMessage(raw.message);
    const sender = normJid(raw.key.participant || (raw.key.fromMe ? extra.botJid : raw.key.remoteJid));
    const tsRaw = Number(raw.messageTimestamp || 0) * 1000;
    const ts = Number.isFinite(tsRaw) && tsRaw > 0 ? tsRaw : null;
    const ctx = body?.contextInfo || null;
    const inner = ctx?.quotedMessage || null;
    const innerType = inner ? (Object.keys(inner)[0] || null) : null;
    const innerBody = innerType ? inner[innerType] : null;

    return {
        id: raw.key.id || null,
        chat,
        chatType: chat.endsWith('@g.us') ? 'group' : (chat.endsWith('@newsletter') ? 'channel' : 'private'),
        chatName: extra.chatName || null,
        sender,
        senderNumber: digitsOf(sender) || null,
        senderPn: sender.endsWith('@s.whatsapp.net') ? sender : null,
        senderLid: sender.endsWith('@lid') ? sender : null,
        pushName: raw.pushName || null,
        fromMe: Boolean(raw.key.fromMe),
        viewOnce: viewOnceOf(raw.message) || Boolean(body?.viewOnce) || false,
        ts,
        iso: ts ? isoWib(ts) : null,
        type,
        text: clip(
            typeof body === 'string' ? body
                : (body?.text || body?.caption || body?.conversation || body?.extendedTextMessage?.text),
            MAX_TEXT
        ) || null,
        media: mediaOf(type, body),
        mentions: Array.isArray(ctx?.mentionedJid) ? ctx.mentionedJid.map(normJid).slice(0, 20) : [],
        quoted: ctx?.stanzaId ? {
            id: ctx.stanzaId,
            sender: normJid(ctx.participant) || null,
            senderNumber: digitsOf(ctx.participant) || null,
            pushName: null,
            fromMe: false,
            ts: null,
            type: innerType,
            text: clip(typeof innerBody === 'string' ? innerBody : (innerBody?.text || innerBody?.caption || innerBody?.conversation), 400) || null,
            media: mediaOf(innerType, innerBody),
            quoted: null
        } : null,
        forward: ctx && (ctx.isForwarded || ctx.forwardedNewsletterMessageInfo || ctx.forwardOrigin !== undefined)
            ? {
                forwarded: true,
                origin: ctx.forwardOrigin ?? null,
                newsletterJid: ctx.forwardedNewsletterMessageInfo?.newsletterJid || null,
                newsletterName: ctx.forwardedNewsletterMessageInfo?.newsletterName || null
            }
            : null,
        source: extra.source || 'live',
        recordedAt: Date.now()
    };
}

function trimChats() {
    if (cache.size <= MAX_CHATS) return;
    const entries = [...cache.entries()].sort((a, b) => {
        const la = a[1][a[1].length - 1]?.ts || 0;
        const lb = b[1][b[1].length - 1]?.ts || 0;
        return la - lb;
    });
    while (cache.size > MAX_CHATS) {
        const [chat] = entries.shift();
        cache.delete(chat);
    }
}

function put(rec) {
    if (!rec || !rec.id || !rec.chat) return null;
    const list = cache.get(rec.chat) || [];
    const existing = list.findIndex(item => item.id === rec.id);
    if (existing >= 0) {
        list[existing] = { ...list[existing], ...rec };
    } else {
        list.push(rec);
        list.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    }
    while (list.length > MAX_PER_CHAT) list.shift();
    cache.set(rec.chat, list);
    trimChats();
    return rec;
}

function record(m, extra = {}) {
    keepRaw(m, m?.chat);
    return put(buildRecord(m, extra));
}

function ingestRaw(list, extra = {}) {
    if (!Array.isArray(list)) return { ingested: 0, skipped: 0 };
    let ingested = 0;
    let skipped = 0;
    for (const raw of list) {
        keepRaw(raw, extra.chat || null);
        const rec = fromRawMessage(raw, extra);
        if (rec && put(rec)) ingested += 1;
        else skipped += 1;
    }
    return { ingested, skipped };
}

function recent(chatId, { limit = 10, sinceMs = null, sender = null, beforeMs = null } = {}) {
    const chat = normJid(chatId);
    const list = cache.get(chat) || [];
    let out = list;
    if (sinceMs) out = out.filter(r => r.ts >= sinceMs);
    if (beforeMs) out = out.filter(r => r.ts < beforeMs);
    if (sender) {
        const want = digitsOf(sender) || normJid(sender);
        out = out.filter(r => digitsOf(r.sender) === want || normJid(r.sender) === normJid(sender));
    }
    return out.slice(-Math.max(1, Math.min(limit, MAX_PER_CHAT)));
}

function get(chatId, id) {
    const list = cache.get(normJid(chatId)) || [];
    return list.find(r => r.id === id) || null;
}

function thread(chatId, id, { before = 5, after = 5, depth = 4, head = 3 } = {}) {
    const chat = normJid(chatId);
    const list = cache.get(chat) || [];
    const target = list.find(r => r.id === id) || null;

    const chain = [];
    let cursor = target?.quoted || null;
    const seen = new Set([id]);
    let level = 0;
    while (cursor && level < depth) {
        const key = cursor.id || `anon-${level}`;
        if (seen.has(key)) break;
        seen.add(key);
        const cached = cursor.id ? list.find(r => r.id === cursor.id) : null;
        chain.push({
            level: level + 1,
            inCache: Boolean(cached),
            record: cached || cursor
        });
        cursor = cached?.quoted || cursor.quoted || null;
        level += 1;
    }

    let beforeList = [];
    let afterList = [];
    if (target) {
        const idx = list.findIndex(r => r.id === id);
        beforeList = list.slice(Math.max(0, idx - Math.max(0, before)), idx);
        afterList = list.slice(idx + 1, idx + 1 + Math.max(0, after));
    }

    return {
        chat,
        target,
        chain,
        before: beforeList,
        after: afterList,
        head: list.slice(0, Math.max(0, head)),
        totalCached: list.length
    };
}

function search(chatId, query, { limit = 20 } = {}) {
    const chat = normJid(chatId);
    const q = String(query || '').toLowerCase().trim();
    if (!q) return [];
    const list = cache.get(chat) || [];
    return list.filter(r => {
        const hay = [r.text, r.pushName, r.sender, r.senderNumber, r.media?.fileName, r.media?.caption, r.media?.kind, r.type]
            .filter(Boolean).join(' ').toLowerCase();
        return hay.includes(q);
    }).slice(-Math.max(1, Math.min(limit, MAX_PER_CHAT)));
}

function stats() {
    const chats = [...cache.entries()].map(([chat, list]) => ({
        chat,
        name: list[list.length - 1]?.chatName || null,
        count: list.length,
        lastTs: list[list.length - 1]?.ts || null,
        lastIso: list[list.length - 1]?.iso || null
    })).sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
    return {
        chats: chats.length,
        messages: chats.reduce((sum, c) => sum + c.count, 0),
        maxPerChat: MAX_PER_CHAT,
        maxChats: MAX_CHATS,
        storage: 'memory',
        detail: chats
    };
}

function clear(chatId) {
    if (chatId) cache.delete(normJid(chatId));
    else cache.clear();
}

module.exports = {
    MAX_PER_CHAT,
    MAX_CHATS,
    buildRecord,
    fromRawMessage,
    keepRaw,
    rawGet,
    quotedRawGet,
    quotedMediaOf,
    rawStats,
    unwrapMessage,
    viewOnceOf,
    record,
    put,
    ingestRaw,
    recent,
    get,
    thread,
    search,
    stats,
    clear,
    isoWib,
    relativeFrom,
    mediaOf,
    normJid,
    digitsOf
};
