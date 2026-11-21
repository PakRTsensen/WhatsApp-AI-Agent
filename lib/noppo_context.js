'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { downloadContentFromMessage, normalizeMessageContent, getContentType } = require('@itsliaaa/baileys');
const { NOPPO_CONFIG } = require('./noppo_config');

const IMAGE_EXT = Object.freeze({
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif'
});

function unwrap(content) {
    if (!content || typeof content !== 'object') return content;
    try { return normalizeMessageContent(content) || content; } catch (_) { return content; }
}

function looksLikeImageMedia(value) {
    if (!value || typeof value !== 'object') return false;
    const mimetype = String(value.mimetype || '').toLowerCase();
    if (!mimetype.startsWith('image/')) return false;
    return Boolean(value.mediaKey || value.directPath || value.url || value.fileSha256);
}

// smsg() menaruh m.quoted sebagai objek media mentah (hasil quoted[type]),
// bukan envelope { imageMessage: ... }. Keduanya harus dikenali.
function imageContentOf(content) {
    if (!content || typeof content !== 'object') return null;
    if (looksLikeImageMedia(content)) return content;
    const inner = unwrap(content);
    if (!inner || typeof inner !== 'object') return null;
    if (getContentType(inner) !== 'imageMessage') return null;
    return inner.imageMessage && typeof inner.imageMessage === 'object' ? inner.imageMessage : null;
}

function collectImageParts(m) {
    const parts = [];
    if (!m) return parts;
    const current = m.mtype === 'imageMessage' ? imageContentOf(m.msg) : null;
    if (current) parts.push({ source: 'current', content: current, mimetype: String(current.mimetype || 'image/jpeg').toLowerCase() });
    const quotedImage = imageContentOf(m.quoted);
    if (quotedImage) {
        const duplicate = current && current.url === quotedImage.url && current.fileSha256 && quotedImage.fileSha256 &&
            current.fileSha256.toString('base64') === quotedImage.fileSha256.toString('base64');
        if (!duplicate) parts.push({ source: 'quoted', content: quotedImage, mimetype: String(quotedImage.mimetype || 'image/jpeg').toLowerCase() });
    }
    return parts;
}

function buildQuotedContext(m) {
    const quoted = m?.quoted;
    if (!quoted) return null;
    const text = String(quoted.text || quoted.caption || quoted.conversation || '').trim();
    const hasImage = Boolean(imageContentOf(quoted));
    if (!text && !hasImage) return null;
    return {
        sender: String(quoted.sender || quoted.key?.participant || '').trim(),
        text,
        hasImage
    };
}

async function downloadImage(part, { maxBytes = NOPPO_CONFIG.image.maxBytes, timeoutMs = 30000 } = {}) {
    let stream = null;
    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            try { stream?.destroy?.(); } catch (_) {}
            reject(new Error(`Unduh gambar melebihi ${timeoutMs} ms.`));
        }, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
    });
    const task = (async () => {
        stream = await downloadContentFromMessage(part.content, 'image');
        const chunks = [];
        let size = 0;
        for await (const chunk of stream) {
            size += chunk.length;
            if (size > maxBytes) throw new Error(`Gambar melebihi batas ${maxBytes} byte.`);
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

function saveImage(buffer, mimetype) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noppo-image-'));
    const ext = IMAGE_EXT[String(mimetype || '').toLowerCase()] || 'img';
    const file = path.join(dir, `image.${ext}`);
    fs.writeFileSync(file, buffer, { mode: 0o600 });
    return { dir, file };
}

function cleanupImage(image) {
    if (!image?.dir) return;
    try { fs.rmSync(image.dir, { recursive: true, force: true }); } catch (_) {}
}

const PERSONA = 'Kamu Noppo, asisten Stenly Christian.';

function formatBytes(value) {
    const n = Number(value);
    if (!value || !Number.isFinite(n) || n <= 0) return null;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function buildMessageMeta(m, { chatId = null, chatName = null } = {}) {
    if (!m) return null;
    try {
        const Cache = require('./message_cache');
        const source = m.chat ? m : (chatId ? { ...m, chat: chatId } : null);
        if (!source) return null;
        return Cache.buildRecord(source, { chatName: chatName || null });
    } catch (_) {
        return null;
    }
}

function formatMeta(rec) {
    if (!rec) return [];
    const Cache = require('./message_cache');
    const lines = [];
    const chatType = rec.chatType === 'group' ? 'grup' : (rec.chatType === 'channel' ? 'saluran' : 'pribadi');
    lines.push(`Chat        : ${rec.chatName ? `${rec.chatName} ` : ''}(${rec.chat}, ${chatType})`);
    if (rec.id) lines.push(`Pesan ID    : ${rec.id}`);
    if (rec.ts) lines.push(`Waktu       : ${rec.iso} (${Cache.relativeFrom(rec.ts)})`);
    const ids = [...new Set([rec.senderLid, rec.sender, rec.senderPn].filter(Boolean))];
    lines.push(`Pengirim    : ${rec.pushName || 'tanpa nama'}${ids.length ? ` — ${ids.join(' / ')}` : ''}${rec.fromMe ? ' (dikirim bot sendiri)' : ''}`);
    if (rec.type) lines.push(`Jenis       : ${rec.type}${rec.viewOnce ? ' (sekali lihat / view once)' : ''}`);

    const media = rec.media;
    if (media) {
        const size = formatBytes(media.bytes);
        if (media.kind === 'document') {
            lines.push(`Dokumen     : ${media.fileName || 'tanpa nama file'} | ${media.mimetype || 'mimetype tidak diketahui'}${size ? ` | ${size}` : ''}${media.pageCount ? ` | ${media.pageCount} halaman` : ''}`);
        } else if (media.kind === 'image') {
            lines.push(`Gambar      : ${media.mimetype || '?'}${size ? ` | ${size}` : ''}${media.width && media.height ? ` | ${media.width}x${media.height}` : ''}`);
        } else if (media.kind === 'video') {
            lines.push(`Video       : ${media.mimetype || '?'}${size ? ` | ${size}` : ''}${media.seconds ? ` | ${media.seconds} detik` : ''}`);
        } else if (media.kind === 'audio' || media.kind === 'voice_note') {
            lines.push(`Audio       : ${media.kind === 'voice_note' ? 'voice note' : 'audio'} | ${media.mimetype || '?'}${size ? ` | ${size}` : ''}${media.seconds ? ` | ${media.seconds} detik` : ''}`);
        } else if (media.kind === 'sticker') {
            lines.push(`Sticker     : ${media.animated ? 'animasi' : 'statis'}${size ? ` | ${size}` : ''}`);
        } else if (media.kind === 'location' || media.kind === 'live_location') {
            lines.push(`Lokasi      : ${media.latitude}, ${media.longitude}${media.name ? ` | ${media.name}` : ''}${media.address ? ` | ${media.address}` : ''}`);
        } else if (media.kind === 'poll') {
            lines.push(`Poll        : ${media.name || '?'}${media.options?.length ? ` | opsi: ${media.options.join(', ')}` : ''}`);
        } else if (media.kind === 'reaction') {
            lines.push(`Reaksi      : ${media.emoji || '?'}${media.targetId ? ` | ke pesan ${media.targetId}` : ''}`);
        } else if (media.kind === 'protocol') {
            lines.push(`Sistem      : ${media.protocolType === 14 ? 'edit pesan' : (media.protocolType === 0 ? 'hapus pesan' : `protocol ${media.protocolType}`)}${media.targetId ? ` | target ${media.targetId}` : ''}`);
        } else {
            lines.push(`Media       : ${media.kind}${size ? ` | ${size}` : ''}`);
        }
        if (media.caption) lines.push(`Caption     : ${media.caption}`);
    }

    if (rec.text && rec.text !== media?.caption) lines.push(`Teks        : ${rec.text}`);
    if (rec.mentions?.length) lines.push(`Mention     : ${rec.mentions.join(', ')}`);
    if (rec.forward?.forwarded) {
        const src = rec.forward.newsletterName || rec.forward.newsletterJid;
        lines.push(`Forward     : ya${src ? ` | asal: ${src}` : ''}${rec.forward.origin !== null ? ` | origin ${rec.forward.origin}` : ''}`);
    }
    const describeQuoted = (q) => {
        const what = q.media?.kind === 'document'
            ? `dokumen ${q.media.fileName || ''}`
            : (q.media?.kind ? q.media.kind : (q.text ? `"${String(q.text).slice(0, 80)}"` : q.type || 'pesan'));
        const when = q.ts ? ` | ${Cache.isoWib(q.ts)}` : '';
        return `${q.pushName || q.senderNumber || q.sender || '?'} | ${what}${when}${q.id ? ` | id ${q.id}` : ''}`;
    };

    let cursor = rec.quoted;
    let level = 0;
    while (cursor && level < 2) {
        const label = level === 0 ? 'Membalas    :' : `${'  '.repeat(level)}↳ dibalas :`;
        lines.push(`${label} ${describeQuoted(cursor)}`);
        cursor = cursor.quoted || null;
        level += 1;
    }
    return lines;
}

function formatRecent(list) {
    if (!Array.isArray(list) || !list.length) return [];
    const lines = [`[Pesan terakhir di chat ini] (${list.length} pesan, terbaru di bawah)`];
    for (const r of list) {
        const time = String(r.iso || '').slice(11, 19) || '--:--:--';
        const who = r.pushName || r.senderNumber || r.sender || '?';
        let what;
        if (r.media?.kind === 'document') {
            const size = formatBytes(r.media.bytes);
            what = `dokumen ${r.media.fileName || ''} (${r.media.mimetype || '?'}${size ? `, ${size}` : ''})`;
        } else if (r.media?.kind) {
            what = `${r.media.kind}${r.media.caption ? `: ${String(r.media.caption).slice(0, 80)}` : ''}`;
        } else if (r.text) {
            what = `teks: ${String(r.text).slice(0, 120)}`;
        } else {
            what = r.type || 'pesan';
        }
        lines.push(`${time} | ${who} | ${what}`);
    }
    return lines;
}

function buildPrompt({ text, quoted, images = [], imageAnalysis = '', imageDisabled = false, imageError = '', meta = null, quotedMeta = null, recent = [], threadBefore = [], threadHead = [] }) {
    const blocks = [];
    if (PERSONA) blocks.push(PERSONA);

    const metaLines = formatMeta(meta);
    if (metaLines.length) blocks.push(['[Metadata pesan]', ...metaLines].join('\n'));

    const quotedLines = formatMeta(quotedMeta);
    if (quotedLines.length) blocks.push(['[Metadata pesan yang dibalas]', ...quotedLines].join('\n'));

    const recentLines = formatRecent(recent);
    if (recentLines.length) blocks.push(recentLines.join('\n'));

    const beforeLines = formatRecent(threadBefore);
    if (beforeLines.length) {
        blocks.push(['[Konteks sebelum pesan yang dibalas]', ...beforeLines.slice(1)].join('\n'));
    }

    
    
    if (recentLines.length || beforeLines.length) {
        blocks.push([
            '[Catatan konteks]',
            'Blok riwayat di atas hanya latar belakang, bukan bagian dari permintaan.',
            'Jawab [Permintaan] dan pesan yang dibalas saja. Jangan melanjutkan atau',
            'menghidupkan lagi topik lama yang tidak diminta.'
        ].join('\n'));
    }

    if (quoted && !quotedLines.length) {
        const lines = ['[Konteks pesan yang dibalas]'];
        if (quoted.sender) lines.push(`Pengirim: ${quoted.sender}`);
        if (quoted.text) lines.push(`Teks: ${quoted.text}`);
        if (quoted.hasImage) lines.push('Pesan yang dibalas berisi gambar.');
        blocks.push(lines.join('\n'));
    }
    if (images.length) {
        const lines = ['[Gambar yang dilampirkan]'];
        images.forEach((image, index) => lines.push(`Gambar ${index + 1} disimpan di: ${image.path}`));
        if (imageAnalysis) lines.push(`Analisis gambar: ${imageAnalysis}`);
        if (imageError) lines.push(`Analisis gambar gagal: ${imageError}`);
        blocks.push(lines.join('\n'));
    } else if (imageError) {
        blocks.push(`[Catatan] Pengguna melampirkan gambar, tetapi analisis gambar gagal: ${imageError}. Jangan mengarang isi gambar.`);
    } else if (imageDisabled) {
        blocks.push('[Catatan] Pengguna melampirkan gambar, tetapi analisis gambar nonaktif untuk model ini. Jangan mengarang isi gambar.');
    }
    const request = String(text || '').trim()
        || (images.length ? 'Analisis gambar yang dilampirkan dan jawab pengguna.' : (quoted ? 'Tanggapi pesan yang dibalas.' : ''));
    if (request) blocks.push(`[Permintaan]\n${request}`);
    return blocks.join('\n\n');
}

module.exports = {
    collectImageParts,
    buildQuotedContext,
    downloadImage,
    saveImage,
    cleanupImage,
    buildPrompt,
    buildMessageMeta,
    formatMeta,
    formatRecent,
    PERSONA,
    IMAGE_EXT
};
