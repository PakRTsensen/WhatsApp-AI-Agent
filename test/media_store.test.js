
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { Readable } = require('stream');


const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'media-store-test-'));
process.env.WA_MEDIA_DIR = path.join(TMP, 'media');
process.env.WA_MEDIA_INDEX = path.join(TMP, 'media_store.json');
process.env.WA_MEDIA_MAX_ITEM = String(1024 * 1024);        
process.env.WA_MEDIA_MAX_TOTAL = String(1024 * 1024); 
process.env.WA_MEDIA_TIMEOUT_MS = '5000';

const Cache = require('../lib/message_cache');
const Store = require('../lib/media_store');

const INDEX = Store.INDEX_FILE;
const CHAT = '120363488888888888@g.us';
const SENDER = '258192697225241@lid';
const TS = Math.floor(Date.UTC(2026, 10, 16, 3, 30, 0) / 1000); 

let pass = 0;
let fail = 0;

function ok(name, cond, detail = '') {
    if (cond) { pass += 1; console.log(`  ok  ${name}`); return; }
    fail += 1;
    console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`);
}

function raw(overrides = {}) {
    const id = overrides.id || `MSG-${Math.random().toString(36).slice(2, 10)}`;
    return {
        key: { id, remoteJid: CHAT, participant: SENDER, fromMe: false },
        pushName: 'Mynfkua',
        messageTimestamp: TS,
        message: { conversation: 'teks biasa' },
        ...overrides
    };
}

function imageRaw(id, caption = 'sketsa') {
    return raw({
        id,
        message: {
            imageMessage: {
                mimetype: 'image/jpeg',
                fileLength: 2048,
                width: 1080,
                height: 1350,
                caption,
                mediaKey: 'k',
                url: 'https://mmg.example/x'
            }
        }
    });
}

function documentRaw(id, fileName = 'brief v3.pdf') {
    return raw({
        id,
        message: {
            documentMessage: {
                fileName,
                mimetype: 'application/pdf',
                fileLength: 4096,
                pageCount: 12,
                mediaKey: 'k',
                url: 'https://mmg.example/y'
            }
        }
    });
}

function videoRaw(id) {
    return raw({
        id,
        message: { videoMessage: { mimetype: 'video/mp4', fileLength: 900, seconds: 12, mediaKey: 'k' } }
    });
}

function audioRaw(id, ptt = false) {
    return raw({
        id,
        message: { audioMessage: { mimetype: 'audio/ogg', fileLength: 700, seconds: 5, ptt, mediaKey: 'k' } }
    });
}

function stickerRaw(id) {
    return raw({
        id,
        message: { stickerMessage: { mimetype: 'image/webp', fileLength: 300, isAnimated: false, mediaKey: 'k' } }
    });
}

function streamOf(buffer) {
    return Readable.from([buffer]);
}

function seed(list) {
    for (const item of list) {
        Cache.keepRaw(item, CHAT);
        Cache.ingestRaw([item], { chatName: 'CodeLearn Llama | NoppoKun' });
    }
}

async function run() {
    console.log('[1] simpan media per jenis');
    const imgBytes = Buffer.from('JPEG-BYTES-'.repeat(20));
    const docBytes = Buffer.from('%PDF-1.7 brief '.repeat(30));
    const vidBytes = Buffer.from('MP4-BYTES'.repeat(10));
    const audBytes = Buffer.from('OGG-BYTES'.repeat(10));
    const stkBytes = Buffer.from('WEBP'.repeat(10));

    const byKind = {
        imageMessage: imgBytes,
        documentMessage: docBytes,
        videoMessage: vidBytes,
        audioMessage: audBytes,
        stickerMessage: stkBytes
    };

    Store.setDownloader(async (content, kind) => {
        const bytes = content?.mimetype === 'image/jpeg' ? imgBytes
            : content?.mimetype === 'application/pdf' ? docBytes
                : content?.mimetype === 'video/mp4' ? vidBytes
                    : content?.mimetype === 'audio/ogg' ? audBytes
                        : stkBytes;
        return streamOf(bytes);
    });

    seed([
        imageRaw('IMG-1'),
        documentRaw('DOC-1'),
        videoRaw('VID-1'),
        audioRaw('AUD-1'),
        stickerRaw('STK-1')
    ]);

    const savedImg = await Store.save(null, { chat: CHAT, id: 'IMG-1', tags: 'Desain, Referensi UI', note: 'sketsa awal' });
    ok('simpan gambar', savedImg.success === true && savedImg.item.kind === 'image');
    ok('tag dinormalisasi', JSON.stringify(savedImg.item.tags) === JSON.stringify(['desain', 'referensi-ui']), JSON.stringify(savedImg.item.tags));
    ok('file gambar ada di disk', fs.existsSync(savedImg.item.path));
    ok('ukuran file = byte unduhan', fs.statSync(savedImg.item.path).size === imgBytes.length);
    ok('nama file aman', /^[a-f0-9]{8}_[A-Za-z0-9._-]+\.jpg$/.test(path.basename(savedImg.item.path)), path.basename(savedImg.item.path));

    const savedDoc = await Store.save(null, { chat: CHAT, id: 'DOC-1', tags: 'brief' });
    ok('simpan dokumen', savedDoc.item.kind === 'document' && savedDoc.item.mimetype === 'application/pdf');
    ok('nama file dokumen dipertahankan', savedDoc.item.fileName === 'brief_v3.pdf', savedDoc.item.fileName);
    ok('pageCount terbawa', savedDoc.item.pageCount === 12);

    const savedVid = await Store.save(null, { chat: CHAT, id: 'VID-1', tags: 'klip' });
    const savedAud = await Store.save(null, { chat: CHAT, id: 'AUD-1', tags: 'vn' });
    const savedStk = await Store.save(null, { chat: CHAT, id: 'STK-1', tags: 'sticker' });
    ok('simpan video/audio/sticker', savedVid.item.kind === 'video' && savedAud.item.kind === 'audio' && savedStk.item.kind === 'sticker');
    ok('sumber pesan tercatat', savedImg.item.source.messageId === 'IMG-1' && savedImg.item.source.chat === CHAT);
    ok('waktu sumber WIB', savedImg.item.source.time === '2026-11-16 10:30:00 WIB', String(savedImg.item.source.time));

    console.log('[2] dedupe sha256');
    const again = await Store.save(null, { chat: CHAT, id: 'IMG-1', tags: 'desain, favorit' });
    ok('byte sama terdeteksi duplikat', again.duplicate === true);
    ok('ref bertambah', again.item.refs === 2);
    ok('tag digabung tanpa dobel', JSON.stringify(again.item.tags) === JSON.stringify(['desain', 'referensi-ui', 'favorit']), JSON.stringify(again.item.tags));
    const files = fs.readdirSync(Store.DIR);
    ok('tidak ada file kedua untuk byte sama', files.length === 5, `files=${files.length}`);

    console.log('[3] tag');
    const added = Store.tag(savedDoc.item.sha256.slice(0, 8), { add: 'klien, 2026' });
    ok('tambah tag lewat potongan sha', added.item.tags.includes('klien') && added.item.tags.includes('2026'));
    const removed = Store.tag(savedDoc.item.sha256, { remove: 'klien' });
    ok('hapus tag', !removed.item.tags.includes('klien') && removed.item.tags.includes('brief'));
    const replaced = Store.tag(savedDoc.item.sha256, { replace: 'arsip, final' });
    ok('replace tag', JSON.stringify(replaced.item.tags) === JSON.stringify(['arsip', 'final']));
    let threw = null;
    try { Store.tag(savedDoc.item.sha256, {}); } catch (e) { threw = e.code; }
    ok('tag tanpa add/remove/replace ditolak', threw === 'NO_TARGET', String(threw));

    console.log('[4] list & get');
    const listAll = Store.list({ limit: 50 });
    ok('list memuat semua item', listAll.total === 5, `total=${listAll.total}`);
    const listTag = Store.list({ tags: 'final' });
    ok('filter tag', listTag.total === 1 && listTag.items[0].kind === 'document');
    const listKind = Store.list({ kind: 'sticker' });
    ok('filter kind', listKind.total === 1 && listKind.items[0].kind === 'sticker');
    const listQuery = Store.list({ q: 'brief' });
    ok('filter query nama file', listQuery.total === 1);
    const listChat = Store.list({ chat: CHAT });
    ok('filter chat', listChat.total === 5);
    const page = Store.list({ limit: 2, offset: 0 });
    ok('paging limit', page.count === 2 && page.total === 5);
    const got = Store.get(savedImg.item.sha256.slice(0, 10));
    ok('get lewat potongan sha', got.item.sha256 === savedImg.item.sha256);
    let ambiguous = null;
    try { Store.get('zzzzzzzz'); } catch (e) { ambiguous = e.code; }
    ok('ref tidak dikenal -> MEDIA_NOT_FOUND', ambiguous === 'MEDIA_NOT_FOUND', String(ambiguous));

    console.log('[5] payloadFor');
    const imgPayload = Store.payloadFor(savedImg.item.sha256);
    ok('payload gambar', imgPayload.payload.image.length === imgBytes.length && imgPayload.payload.caption === 'sketsa');
    const docPayload = Store.payloadFor(savedDoc.item.sha256);
    ok('payload dokumen', docPayload.payload.document.length === docBytes.length && docPayload.payload.fileName === 'brief_v3.pdf');
    const audioPayload = Store.payloadFor(savedAud.item.sha256);
    ok('payload audio ptt=false', audioPayload.payload.ptt === false && audioPayload.payload.audio.length === audBytes.length);
    const stkPayload = Store.payloadFor(savedStk.item.sha256);
    ok('payload sticker', stkPayload.payload.sticker.length === stkBytes.length);
    const forced = Store.payloadFor(savedImg.item.sha256, { asDocument: true });
    ok('asDocument memaksa dokumen', Boolean(forced.payload.document) && !forced.payload.image);

    console.log('[6] batas ukuran');
    Store.setDownloader(async () => streamOf(Buffer.alloc(1024 * 1024 + 10, 1)));
    seed([imageRaw('BIG-1')]);
    let tooLarge = null;
    try { await Store.save(null, { chat: CHAT, id: 'BIG-1' }); } catch (e) { tooLarge = e.code; }
    ok('item di atas batas -> TOO_LARGE', tooLarge === 'TOO_LARGE', String(tooLarge));

    let fillRun = 0;
    Store.setDownloader(async () => streamOf(Buffer.alloc(700 * 1024, 2 + fillRun++)));
    seed([imageRaw('FILL-1'), imageRaw('FILL-2')]);
    const fill1 = await Store.save(null, { chat: CHAT, id: 'FILL-1', tags: 'besar' });
    ok('item besar pertama masuk', fill1.success === true);
    let full = null;
    try { await Store.save(null, { chat: CHAT, id: 'FILL-2', tags: 'besar' }); } catch (e) { full = e.code; }
    ok('kuota habis -> STORE_FULL', full === 'STORE_FULL', String(full));

    console.log('[7] non-media & pesan hilang');
    seed([raw({ id: 'TEXT-1' })]);
    let noMedia = null;
    try { await Store.save(null, { chat: CHAT, id: 'TEXT-1' }); } catch (e) { noMedia = e.code; }
    ok('pesan teks ditolak NO_MEDIA', noMedia === 'NO_MEDIA', String(noMedia));
    let notFound = null;
    try { await Store.save(null, { chat: CHAT, id: 'TIDAK-ADA', live: false }); } catch (e) { notFound = e.code; }
    ok('id tidak ada -> NOT_FOUND', notFound === 'NOT_FOUND', String(notFound));

    console.log('[8] stats');
    const stats = Store.stats();
    ok('stats jumlah item', stats.items === 6, `items=${stats.items}`);
    ok('stats byKind', stats.byKind.image === 2 && stats.byKind.document === 1, JSON.stringify(stats.byKind));
    ok('stats tag terhitung', stats.tags.some(t => t.tag === 'desain' && t.count === 1));
    ok('stats sisa kuota masuk akal', stats.freeBytes >= 0 && stats.bytes > 0);

    console.log('[9] remove');
    const del = Store.remove(savedStk.item.sha256);
    ok('hapus item', del.success === true && del.fileDeleted === true);
    ok('file terhapus dari disk', !fs.existsSync(savedStk.item.path));
    ok('indeks ikut bersih', Store.list({ kind: 'sticker' }).total === 0);
    let delMissing = null;
    try { Store.remove(savedStk.item.sha256); } catch (e) { delMissing = e.code; }
    ok('hapus dua kali -> MEDIA_NOT_FOUND', delMissing === 'MEDIA_NOT_FOUND', String(delMissing));

    console.log('[10] retensi raw di message_cache');
    ok('raw media ditahan di memory', Boolean(Cache.rawGet(CHAT, 'IMG-1')));
    ok('raw pesan teks tidak ditahan', Cache.rawGet(CHAT, 'TEXT-1') === null);
    const rawStats = Cache.rawStats();
    ok('rawStats melaporkan batas', rawStats.max > 0 && rawStats.storage === 'memory');

    console.log('[10b] media lama lewat quotedMessage (reply + mention)');
    
    for (const it of Store.list({ limit: 100 }).items) {
        if ((it.tags || []).includes('besar')) Store.remove(it.sha256);
    }
    const quotedDoc = {
        documentMessage: {
            url: 'https://mmg.whatsapp.net/v/t62/quoted-doc',
            directPath: '/v/t62/quoted-doc',
            mediaKey: Buffer.alloc(32, 7).toString('base64'),
            mimetype: 'application/pdf',
            fileName: 'laporan-lama.pdf',
            fileLength: 2048
        }
    };
    seed([raw({
        id: 'REPLY-QUOTED-1',
        message: {
            extendedTextMessage: {
                text: '@2766646861999 simpan file ini',
                contextInfo: { stanzaId: 'DOC-OLD-1', participant: SENDER, quotedMessage: quotedDoc }
            }
        }
    })]);
    ok('pesan pembalas media ikut ditahan di memory', Boolean(Cache.rawGet(CHAT, 'REPLY-QUOTED-1')));
    ok('quotedRawGet menemukan media dari reply', Boolean(Cache.quotedRawGet(CHAT, 'DOC-OLD-1')));
    ok('teks tanpa quoted media tetap tidak ditahan', Cache.rawGet(CHAT, 'TEXT-1') === null);

    let quotedPayload = null;
    Store.setDownloader(async (body, kind) => {
        quotedPayload = { kind, mimetype: body?.mimetype, fileName: body?.fileName };
        return streamOf(Buffer.from('%PDF-1.4 dokumen lama '.repeat(20)));
    });
    const savedQuoted = await Store.save(null, { chat: CHAT, id: 'DOC-OLD-1', tags: 'lama, arsip', live: false });
    ok('save lewat quoted sukses', savedQuoted.success === true && savedQuoted.source === 'quoted', `source=${savedQuoted.source}`);
    ok('nama file diambil dari quotedMessage', savedQuoted.item.fileName === 'laporan-lama.pdf', savedQuoted.item.fileName);
    ok('unduhan pakai jalur dokumen', quotedPayload?.kind === 'document' && quotedPayload?.mimetype === 'application/pdf', JSON.stringify(quotedPayload));
    ok('tag ikut tersimpan', (savedQuoted.item.tags || []).includes('lama'), JSON.stringify(savedQuoted.item.tags));

    console.log('[11] indeks di disk');
    ok('file indeks ada', fs.existsSync(INDEX));
    const idx = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
    ok('indeks schema v1', idx._v === 1 && typeof idx.items === 'object');
    ok('tidak ada file .tmp tertinggal', !fs.existsSync(`${INDEX}.tmp`));

    
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
    Cache.clear(CHAT);

    console.log(`\nhasil: ${pass} ok, ${fail} FAIL`);
    if (fail > 0) process.exitCode = 1;
}

run().catch((err) => {
    console.error('test error:', err);
    process.exitCode = 1;
});
