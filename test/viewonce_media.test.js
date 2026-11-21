
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { Readable } = require('stream');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'viewonce-test-'));
process.env.WA_MEDIA_DIR = path.join(TMP, 'media');
process.env.WA_MEDIA_INDEX = path.join(TMP, 'media_store.json');
process.env.WA_MEDIA_MAX_ITEM = String(2 * 1024 * 1024);
process.env.WA_MEDIA_MAX_TOTAL = String(4 * 1024 * 1024);
process.env.WA_MEDIA_TIMEOUT_MS = '5000';

const Cache = require('../lib/message_cache');
const Store = require('../lib/media_store');

const CHAT = '120363405197851405@g.us';
const SENDER = '258192697225241@lid';
const TS = Math.floor(Date.UTC(2026, 10, 16, 4, 50, 0) / 1000); 

let pass = 0;
let fail = 0;

function ok(name, fn) {
    try {
        fn();
        pass++;
        console.log(`ok   ${name}`);
    } catch (e) {
        fail++;
        console.log(`FAIL ${name}: ${e.message}`);
    }
}

async function okAsync(name, fn) {
    try {
        await fn();
        pass++;
        console.log(`ok   ${name}`);
    } catch (e) {
        fail++;
        console.log(`FAIL ${name}: ${e.message}`);
    }
}

function imageMsg(extra = {}) {
    return {
        url: 'https://mmg.whatsapp.net/d/fake',
        mimetype: 'image/jpeg',
        fileSha256: Buffer.from('sha-image'),
        fileLength: '12345',
        mediaKey: Buffer.from('key-image'),
        directPath: '/v/t62.7118-24/fake',
        width: 720,
        height: 1280,
        caption: 'sekali lihat',
        viewOnce: true,
        ...extra
    };
}

function audioMsg(extra = {}) {
    return {
        url: 'https://mmg.whatsapp.net/d/fake-audio',
        mimetype: 'audio/ogg; codecs=opus',
        fileLength: '23456',
        mediaKey: Buffer.from('key-audio'),
        directPath: '/v/t62.7117-24/fake-audio',
        ptt: true,
        seconds: 7,
        viewOnce: true,
        ...extra
    };
}

function rawWith(message, id) {
    return {
        key: { remoteJid: CHAT, fromMe: false, id, participant: SENDER },
        message,
        messageTimestamp: TS,
        pushName: 'Mynfkua'
    };
}

const RAW_ONCE_IMAGE = rawWith(
    { viewOnceMessageV2: { message: { imageMessage: imageMsg() } } },
    'A5000000000000000000000000000001'
);

const RAW_ONCE_VOICE = rawWith(
    { viewOnceMessageV2Extension: { message: { audioMessage: audioMsg() } } },
    'A5000000000000000000000000000002'
);

const RAW_ONCE_EPHEMERAL = rawWith(
    {
        ephemeralMessage: {
            message: {
                viewOnceMessage: { message: { imageMessage: imageMsg({ caption: 'dobel bungkus' }) } }
            }
        }
    },
    'A5000000000000000000000000000003'
);


const downloads = [];
Store.setDownloader((content, kind) => {
    downloads.push({ content, kind });
    const buf = Buffer.concat([Buffer.from('media-'), Buffer.from(kind), Buffer.from('-sekali-lihat')]);
    return Readable.from([buf]);
});

(async () => {
    
    console.log('[1] viewOnceOf');

    ok('viewOnceMessageV2 terdeteksi', () => {
        assert.strictEqual(Cache.viewOnceOf(RAW_ONCE_IMAGE.message), true);
    });

    ok('viewOnceMessageV2Extension terdeteksi', () => {
        assert.strictEqual(Cache.viewOnceOf(RAW_ONCE_VOICE.message), true);
    });

    ok('viewOnce di dalam ephemeral terdeteksi', () => {
        assert.strictEqual(Cache.viewOnceOf(RAW_ONCE_EPHEMERAL.message), true);
    });

    ok('imageMessage.viewOnce tanpa pembungkus terdeteksi', () => {
        assert.strictEqual(Cache.viewOnceOf({ imageMessage: imageMsg() }), true);
    });

    ok('gambar biasa bukan sekali lihat', () => {
        assert.strictEqual(Cache.viewOnceOf({ imageMessage: imageMsg({ viewOnce: false }) }), false);
    });

    ok('pesan teks bukan sekali lihat', () => {
        assert.strictEqual(Cache.viewOnceOf({ conversation: 'halo' }), false);
    });

    ok('null aman', () => {
        assert.strictEqual(Cache.viewOnceOf(null), false);
        assert.strictEqual(Cache.viewOnceOf(undefined), false);
    });

    
    console.log('[2] record cache mengenali jenis asli');

    Cache.ingestRaw([RAW_ONCE_IMAGE, RAW_ONCE_VOICE, RAW_ONCE_EPHEMERAL], { chat: CHAT });

    ok('gambar sekali lihat: type imageMessage + flag true', () => {
        const rec = Cache.get(CHAT, RAW_ONCE_IMAGE.key.id);
        assert.ok(rec, 'record harus ada');
        assert.strictEqual(rec.type, 'imageMessage');
        assert.strictEqual(rec.viewOnce, true);
        assert.strictEqual(rec.media.kind, 'image');
        assert.strictEqual(rec.media.width, 720);
    });

    ok('voice note sekali lihat: type audioMessage + kind voice_note', () => {
        const rec = Cache.get(CHAT, RAW_ONCE_VOICE.key.id);
        assert.ok(rec, 'record harus ada');
        assert.strictEqual(rec.type, 'audioMessage');
        assert.strictEqual(rec.viewOnce, true);
        assert.strictEqual(rec.media.kind, 'voice_note');
        assert.strictEqual(rec.media.seconds, 7);
    });

    ok('dobel bungkus ephemeral+viewOnce tetap terbaca', () => {
        const rec = Cache.get(CHAT, RAW_ONCE_EPHEMERAL.key.id);
        assert.strictEqual(rec.type, 'imageMessage');
        assert.strictEqual(rec.viewOnce, true);
    });

    
    console.log('[3] simpan ke arsip media');

    await okAsync('gambar sekali lihat tersimpan + viewOnce:true', async () => {
        const res = await Store.save({}, { chat: CHAT, id: RAW_ONCE_IMAGE.key.id, tags: 'sekali-lihat, test' });
        assert.strictEqual(res.success, true);
        assert.strictEqual(res.item.kind, 'image');
        assert.strictEqual(res.item.viewOnce, true);
        assert.ok(res.item.tags.includes('sekali-lihat'));
        assert.ok(fs.existsSync(res.item.path), 'file arsip harus ada di disk');
        const bytes = fs.readFileSync(res.item.path);
        assert.ok(bytes.length > 0);
        const mode = fs.statSync(res.item.path).mode & 0o777;
        assert.strictEqual(mode, 0o600, 'file arsip harus 0600');
    });

    await okAsync('voice note sekali lihat tersimpan + kind voice_note', async () => {
        const res = await Store.save({}, { chat: CHAT, id: RAW_ONCE_VOICE.key.id });
        assert.strictEqual(res.item.kind, 'voice_note');
        assert.strictEqual(res.item.viewOnce, true);
        assert.strictEqual(res.item.seconds, 7);
    });

    
    console.log('[4] isi unduhan sudah unwrap');

    ok('downloader tidak menerima objek pembungkus', () => {
        assert.ok(downloads.length >= 2, 'harus ada minimal 2 unduhan');
        for (const d of downloads) {
            assert.ok(d.content, 'content harus ada');
            assert.strictEqual(d.content.viewOnceMessageV2, undefined);
            assert.strictEqual(d.content.viewOnceMessageV2Extension, undefined);
            assert.strictEqual(d.content.ephemeralMessage, undefined);
            assert.ok(d.content.mediaKey, 'mediaKey harus ikut supaya unduhan bisa jalan');
        }
    });

    ok('kind unduhan sesuai jenis', () => {
        const kinds = downloads.map(d => d.kind);
        assert.ok(kinds.includes('image'), 'harus ada unduhan image');
        assert.ok(kinds.includes('audio'), 'voice note diunduh sebagai audio');
    });

    
    console.log('[5] list/get menampilkan viewOnce');

    await okAsync('media_list memuat viewOnce true', async () => {
        const list = Store.list({ tags: 'sekali-lihat' });
        assert.strictEqual(list.count, 1);
        assert.strictEqual(list.items[0].viewOnce, true);
    });

    console.log(`\n${pass} ok, ${fail} FAIL`);
    process.exit(fail ? 1 : 0);
})();
