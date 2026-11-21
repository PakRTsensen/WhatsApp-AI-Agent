
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const Cache = require('../lib/message_cache');
const Context = require('../lib/noppo_context');

const CHAT = '120363477777777777@g.us';
const CHAT2 = '120363466666666666@g.us';
const TS = Math.floor(Date.UTC(2026, 10, 16, 2, 12, 44) / 1000); 


function fakeMessage(overrides = {}) {
    return {
        key: { id: 'MSG-' + Math.random().toString(36).slice(2, 10), fromMe: false, participant: '258192697225241@lid' },
        chat: CHAT,
        sender: '258192697225241@lid',
        pushName: 'Stenly',
        messageTimestamp: TS,
        mtype: 'conversation',
        text: 'halo nop',
        msg: { conversation: 'halo nop' },
        ...overrides
    };
}

function run() {
    let pass = 0;
    const fail = [];

    const check = (name, fn) => {
        try {
            fn();
            pass += 1;
            console.log(`  ok  ${name}`);
        } catch (err) {
            fail.push(`${name}: ${err.message}`);
            console.log(`  FAIL ${name} -> ${err.message}`);
        }
    };

    console.log('[1] ekstraksi metadata');

    check('teks biasa: id, chat, pengirim, waktu WIB', () => {
        const rec = Cache.buildRecord(fakeMessage(), { chatName: 'Grup Tes' });
        assert.strictEqual(rec.chat, CHAT);
        assert.strictEqual(rec.chatType, 'group');
        assert.strictEqual(rec.chatName, 'Grup Tes');
        assert.strictEqual(rec.sender, '258192697225241@lid');
        assert.strictEqual(rec.senderNumber, '258192697225241');
        assert.strictEqual(rec.pushName, 'Stenly');
        assert.strictEqual(rec.type, 'conversation');
        assert.strictEqual(rec.text, 'halo nop');
        assert.strictEqual(rec.iso, '2026-11-16 09:12:44 WIB');
        assert.strictEqual(rec.ts, TS * 1000);
    });

    check('dokumen: nama file, mimetype, ukuran, caption', () => {
        const rec = Cache.buildRecord({
            key: { id: 'DOC-1', fromMe: false },
            chat: CHAT,
            sender: '6285199430173@s.whatsapp.net',
            pushName: 'Stenly',
            messageTimestamp: TS,
            mtype: 'documentMessage',
            msg: {
                documentMessage: {
                    fileName: 'laporan.pdf',
                    mimetype: 'application/pdf',
                    fileLength: 250880,
                    caption: 'ini file yang kamu minta'
                }
            }
        });
        assert.strictEqual(rec.media.kind, 'document');
        assert.strictEqual(rec.media.fileName, 'laporan.pdf');
        assert.strictEqual(rec.media.mimetype, 'application/pdf');
        assert.strictEqual(rec.media.bytes, 250880);
        assert.strictEqual(rec.media.caption, 'ini file yang kamu minta');
    });

    check('video: durasi + caption', () => {
        const rec = Cache.buildRecord({
            key: { id: 'VID-1' }, chat: CHAT, sender: '6281@s.whatsapp.net', messageTimestamp: TS,
            mtype: 'videoMessage',
            msg: { videoMessage: { mimetype: 'video/mp4', fileLength: 5242880, seconds: 12, caption: 'cek ini' } }
        });
        assert.strictEqual(rec.media.kind, 'video');
        assert.strictEqual(rec.media.seconds, 12);
        assert.strictEqual(rec.media.bytes, 5242880);
    });

    check('voice note terdeteksi dari ptt', () => {
        const rec = Cache.buildRecord({
            key: { id: 'AUD-1' }, chat: CHAT, sender: '6281@s.whatsapp.net', messageTimestamp: TS,
            mtype: 'audioMessage',
            msg: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', fileLength: 40960, seconds: 7, ptt: true } }
        });
        assert.strictEqual(rec.media.kind, 'voice_note');
        assert.strictEqual(rec.media.seconds, 7);
    });

    check('sticker animasi', () => {
        const rec = Cache.buildRecord({
            key: { id: 'STK-1' }, chat: CHAT, sender: '6281@s.whatsapp.net', messageTimestamp: TS,
            mtype: 'stickerMessage',
            msg: { stickerMessage: { mimetype: 'image/webp', fileLength: 102400, isAnimated: true } }
        });
        assert.strictEqual(rec.media.kind, 'sticker');
        assert.strictEqual(rec.media.animated, true);
    });

    check('poll + opsi', () => {
        const rec = Cache.buildRecord({
            key: { id: 'POLL-1' }, chat: CHAT, sender: '6281@s.whatsapp.net', messageTimestamp: TS,
            mtype: 'pollCreationMessage',
            msg: { pollCreationMessage: { name: 'Makan apa?', options: [{ optionName: 'nasi' }, { optionName: 'mi' }] } }
        });
        assert.strictEqual(rec.media.kind, 'poll');
        assert.deepStrictEqual(rec.media.options, ['nasi', 'mi']);
    });

    check('pesan yang dibalas ikut tercatat', () => {
        const rec = Cache.buildRecord(fakeMessage({
            quoted: {
                key: { id: 'Q-1', fromMe: false },
                sender: '628111@s.whatsapp.net',
                pushName: 'Budi',
                mtype: 'documentMessage',
                msg: { documentMessage: { fileName: 'tugas.docx', mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', fileLength: 51200 } }
            }
        }));
        assert.strictEqual(rec.quoted.id, 'Q-1');
        assert.strictEqual(rec.quoted.pushName, 'Budi');
        assert.strictEqual(rec.quoted.media.fileName, 'tugas.docx');
    });

    console.log('[2] record / recent / get / search');

    check('record lalu recent mengembalikan pesan berurutan', () => {
        Cache.clear(CHAT);
        const a = Cache.record(fakeMessage({ key: { id: 'A' }, text: 'satu', messageTimestamp: TS }));
        const b = Cache.record(fakeMessage({ key: { id: 'B' }, text: 'dua', messageTimestamp: TS + 60 }));
        assert.ok(a && b);
        const list = Cache.recent(CHAT, { limit: 5 });
        assert.deepStrictEqual(list.map(r => r.id), ['A', 'B']);
    });

    check('record id sama = update, bukan duplikat', () => {
        Cache.clear(CHAT);
        Cache.record(fakeMessage({ key: { id: 'DUP' }, text: 'versi awal' }));
        Cache.record(fakeMessage({ key: { id: 'DUP' }, text: 'versi edit' }));
        const list = Cache.recent(CHAT, { limit: 10 });
        assert.strictEqual(list.length, 1);
        assert.strictEqual(list[0].text, 'versi edit');
    });

    check('get by id', () => {
        Cache.clear(CHAT);
        Cache.record(fakeMessage({ key: { id: 'GET-1' }, text: 'cari aku' }));
        const rec = Cache.get(CHAT, 'GET-1');
        assert.strictEqual(rec.text, 'cari aku');
        assert.strictEqual(Cache.get(CHAT, 'TIDAK-ADA'), null);
    });

    check('search by kata kunci teks & nama file', () => {
        Cache.clear(CHAT);
        Cache.record(fakeMessage({ key: { id: 'S1' }, text: 'rapat jam 9' }));
        Cache.record({
            key: { id: 'S2' }, chat: CHAT, sender: '6281@s.whatsapp.net', pushName: 'Budi', messageTimestamp: TS,
            mtype: 'documentMessage',
            msg: { documentMessage: { fileName: 'rapat.pdf', mimetype: 'application/pdf', fileLength: 1024 } }
        });
        assert.deepStrictEqual(Cache.search(CHAT, 'rapat').map(r => r.id).sort(), ['S1', 'S2']);
        assert.deepStrictEqual(Cache.search(CHAT, 'budi').map(r => r.id), ['S2']);
        assert.deepStrictEqual(Cache.search(CHAT, 'tidak-ada-yang-cocok'), []);
    });

    check('filter sender + sinceMs', () => {
        Cache.clear(CHAT);
        Cache.record(fakeMessage({ key: { id: 'F1' }, sender: '628111@s.whatsapp.net', messageTimestamp: TS }));
        Cache.record(fakeMessage({ key: { id: 'F2' }, sender: '628222@s.whatsapp.net', messageTimestamp: TS + 600 }));
        assert.deepStrictEqual(Cache.recent(CHAT, { limit: 5, sender: '628222' }).map(r => r.id), ['F2']);
        assert.deepStrictEqual(Cache.recent(CHAT, { limit: 5, sinceMs: (TS + 300) * 1000 }).map(r => r.id), ['F2']);
    });

    check(`batas per chat ${Cache.MAX_PER_CHAT} pesan (yang lama dibuang)`, () => {
        Cache.clear(CHAT);
        for (let i = 0; i < Cache.MAX_PER_CHAT + 5; i += 1) {
            Cache.record(fakeMessage({ key: { id: `CAP-${i}` }, text: `pesan ${i}`, messageTimestamp: TS + i }));
        }
        const list = Cache.recent(CHAT, { limit: 500 });
        assert.strictEqual(list.length, Cache.MAX_PER_CHAT);
        assert.strictEqual(list[0].id, 'CAP-5');
        assert.strictEqual(list[list.length - 1].id, `CAP-${Cache.MAX_PER_CHAT + 4}`);
    });

    check('chat terpisah tidak tercampur', () => {
        Cache.clear(CHAT);
        Cache.clear(CHAT2);
        Cache.record(fakeMessage({ key: { id: 'C1' } }));
        Cache.record(fakeMessage({ key: { id: 'C2' }, chat: CHAT2 }));
        assert.deepStrictEqual(Cache.recent(CHAT, { limit: 5 }).map(r => r.id), ['C1']);
        assert.deepStrictEqual(Cache.recent(CHAT2, { limit: 5 }).map(r => r.id), ['C2']);
    });

    console.log('[2b] rantai balasan & jendela thread');

    check('quoted bertingkat tersimpan rekursif', () => {
        const rec = Cache.buildRecord(fakeMessage({
            key: { id: 'DEEP-1' },
            quoted: {
                key: { id: 'DEEP-Q1' }, sender: '628111@s.whatsapp.net', pushName: 'Budi',
                mtype: 'conversation', msg: { conversation: 'level satu' },
                quoted: {
                    key: { id: 'DEEP-Q2' }, sender: '628222@s.whatsapp.net', pushName: 'Pablo',
                    mtype: 'conversation', msg: { conversation: 'level dua' },
                    quoted: {
                        key: { id: 'DEEP-Q3' }, sender: '628333@s.whatsapp.net',
                        mtype: 'conversation', msg: { conversation: 'level tiga' }
                    }
                }
            }
        }));
        assert.strictEqual(rec.quoted.id, 'DEEP-Q1');
        assert.strictEqual(rec.quoted.quoted.id, 'DEEP-Q2');
        assert.strictEqual(rec.quoted.quoted.quoted.id, 'DEEP-Q3');
        assert.strictEqual(rec.quoted.quoted.text, 'level dua');
    });

    check('thread(): rantai + jendela sebelum/sesudah + head', () => {
        Cache.clear(CHAT);
        for (let i = 0; i < 8; i += 1) {
            Cache.record(fakeMessage({ key: { id: `W-${i}` }, text: `pesan ${i}`, messageTimestamp: TS + i }));
        }
        Cache.record(fakeMessage({
            key: { id: 'W-TARGET' }, text: 'balasan target', messageTimestamp: TS + 10,
            quoted: {
                key: { id: 'W-3' }, sender: '628111@s.whatsapp.net', pushName: 'Budi',
                mtype: 'conversation', msg: { conversation: 'pesan 3' },
                quoted: {
                    key: { id: 'W-1' }, sender: '628222@s.whatsapp.net', pushName: 'Pablo',
                    mtype: 'conversation', msg: { conversation: 'pesan 1' }
                }
            }
        }));
        const t = Cache.thread(CHAT, 'W-TARGET', { before: 2, after: 2, depth: 4, head: 2 });
        assert.ok(t.target);
        assert.strictEqual(t.target.text, 'balasan target');
        assert.strictEqual(t.chain.length, 2, 'rantai harus dua level');
        assert.strictEqual(t.chain[0].record.id, 'W-3');
        assert.strictEqual(t.chain[0].inCache, true, 'W-3 ada di cache');
        assert.strictEqual(t.chain[1].record.id, 'W-1');
        assert.strictEqual(t.chain[1].inCache, true, 'W-1 ada di cache');
        assert.deepStrictEqual(t.before.map(r => r.id), ['W-6', 'W-7']);
        assert.deepStrictEqual(t.after.map(r => r.id), []);
        assert.strictEqual(t.head.length, 2);
        assert.strictEqual(t.totalCached, 9);
    });

    check('thread(): pesan target tidak ada di cache tetap balik head', () => {
        Cache.clear(CHAT);
        Cache.record(fakeMessage({ key: { id: 'H-1' }, text: 'awal', messageTimestamp: TS }));
        Cache.record(fakeMessage({ key: { id: 'H-2' }, text: 'kedua', messageTimestamp: TS + 1 }));
        const t = Cache.thread(CHAT, 'TIDAK-ADA', { before: 2, after: 2, head: 2 });
        assert.strictEqual(t.target, null);
        assert.deepStrictEqual(t.chain, []);
        assert.strictEqual(t.head.length, 2);
    });

    check('thread(): depth membatasi rantai', () => {
        Cache.clear(CHAT);
        Cache.record(fakeMessage({
            key: { id: 'LIM-0' },
            quoted: {
                key: { id: 'LIM-1' }, mtype: 'conversation', msg: { conversation: 'a' },
                quoted: { key: { id: 'LIM-2' }, mtype: 'conversation', msg: { conversation: 'b' },
                    quoted: { key: { id: 'LIM-3' }, mtype: 'conversation', msg: { conversation: 'c' } } }
            }
        }));
        const t = Cache.thread(CHAT, 'LIM-0', { depth: 2 });
        assert.strictEqual(t.chain.length, 2);
    });

    check('prompt menampilkan rantai balasan bertingkat', () => {
        const m = {
            key: { id: 'CHAIN-1' }, chat: CHAT, sender: '628111@s.whatsapp.net', pushName: 'Budi',
            messageTimestamp: TS, mtype: 'conversation', text: 'iya bener',
            quoted: {
                key: { id: 'CHAIN-Q1' }, sender: '628222@s.whatsapp.net', pushName: 'Pablo',
                mtype: 'conversation', msg: { conversation: 'kode nya jelek' },
                quoted: {
                    key: { id: 'CHAIN-Q2' }, sender: '628333@s.whatsapp.net', pushName: 'Aulia',
                    mtype: 'conversation', msg: { conversation: 'menurut kamu?' }
                }
            }
        };
        const meta = Context.buildMessageMeta(m, { chatName: 'Grup Tes' });
        const prompt = Context.buildPrompt({ text: 'cek', meta });
        assert.ok(prompt.includes('Membalas    :'), 'baris membalas hilang');
        assert.ok(prompt.includes('Pablo'), 'level 1 hilang');
        assert.ok(prompt.includes('↳ dibalas :'), 'rantai level 2 hilang');
        assert.ok(prompt.includes('Aulia'), 'nama level 2 hilang');
    });

    console.log('[3] prompt Noppo');

    check('buildPrompt memuat metadata lengkap + dokumen', () => {
        const m = {
            key: { id: 'PROMPT-1', fromMe: false },
            chat: CHAT,
            sender: '258192697225241@lid',
            pushName: 'Stenly',
            messageTimestamp: TS,
            mtype: 'documentMessage',
            msg: { documentMessage: { fileName: 'laporan.pdf', mimetype: 'application/pdf', fileLength: 250880, caption: 'ini file yang kamu minta' } },
            quoted: {
                key: { id: 'Q-9' },
                sender: '628111@s.whatsapp.net',
                pushName: 'Budi',
                mtype: 'conversation',
                msg: { conversation: 'kirim filenya' }
            }
        };
        const meta = Context.buildMessageMeta(m, { chatName: 'Grup Tes' });
        const quotedMeta = Context.buildMessageMeta(m.quoted, { chatId: CHAT, chatName: 'Grup Tes' });
        const prompt = Context.buildPrompt({
            text: 'ini filenya',
            quoted: Context.buildQuotedContext(m),
            meta,
            quotedMeta,
            recent: [meta]
        });
        assert.ok(prompt.includes('[Metadata pesan]'), 'blok metadata pesan hilang');
        assert.ok(prompt.includes('2026-11-16 09:12:44 WIB'), 'waktu WIB hilang');
        assert.ok(prompt.includes('Grup Tes'), 'nama chat hilang');
        assert.ok(prompt.includes('documentMessage'), 'jenis pesan hilang');
        assert.ok(prompt.includes('laporan.pdf'), 'nama file hilang');
        assert.ok(prompt.includes('application/pdf'), 'mimetype hilang');
        assert.ok(prompt.includes('245.0 KB'), 'ukuran file hilang');
        assert.ok(prompt.includes('[Metadata pesan yang dibalas]'), 'blok quoted hilang');
        assert.ok(prompt.includes('Budi'), 'nama pengirim quoted hilang');
        assert.ok(prompt.includes('[Pesan terakhir di chat ini]'), 'blok recent hilang');
        assert.ok(prompt.includes('PROMPT-1'), 'pesan id hilang');
    });

    check('tanpa meta, prompt tetap jalan (kompatibel)', () => {
        const prompt = Context.buildPrompt({ text: 'halo' });
        assert.ok(prompt.includes('halo'));
        assert.ok(!prompt.includes('[Metadata pesan]'));
    });

    console.log('[4] ingest live (WAMessage mentah)');

    check('fromRawMessage: dokumen mentah jadi record lengkap', () => {
        const rec = Cache.fromRawMessage({
            key: { remoteJid: CHAT, fromMe: false, id: 'RAW-1', participant: '628111@s.whatsapp.net' },
            messageTimestamp: TS,
            message: { documentMessage: { fileName: 'raw.pdf', mimetype: 'application/pdf', fileLength: 2048, caption: 'dari live' } }
        }, { chatName: 'Grup Tes' });
        assert.strictEqual(rec.type, 'documentMessage');
        assert.strictEqual(rec.media.kind, 'document');
        assert.strictEqual(rec.media.fileName, 'raw.pdf');
        assert.strictEqual(rec.text, 'dari live');
        assert.strictEqual(rec.source, 'live');
        assert.strictEqual(rec.iso, '2026-11-16 09:12:44 WIB');
    });

    check('unwrapMessage: pesan ephemeral dibuka ke tipe asli', () => {
        const rec = Cache.fromRawMessage({
            key: { remoteJid: CHAT, id: 'RAW-2', fromMe: false },
            messageTimestamp: TS,
            message: { ephemeralMessage: { message: { extendedTextMessage: { text: 'halo ephemeral' } } } }
        });
        assert.strictEqual(rec.type, 'extendedTextMessage');
        assert.strictEqual(rec.text, 'halo ephemeral');
    });

    check('fromRawMessage: quoted ikut terbaca dari contextInfo', () => {
        const rec = Cache.fromRawMessage({
            key: { remoteJid: CHAT, id: 'RAW-3', fromMe: false, participant: '628222@s.whatsapp.net' },
            messageTimestamp: TS,
            message: {
                extendedTextMessage: {
                    text: 'iya',
                    contextInfo: {
                        stanzaId: 'QUOTED-9',
                        participant: '628333@s.whatsapp.net',
                        quotedMessage: { conversation: 'kode nya jelek' }
                    }
                }
            }
        });
        assert.strictEqual(rec.quoted.id, 'QUOTED-9');
        assert.strictEqual(rec.quoted.text, 'kode nya jelek');
    });

    check('ingestRaw: masuk memory dan tidak dobel', () => {
        Cache.clear(CHAT);
        const raws = [0, 1, 2].map((i) => ({
            key: { remoteJid: CHAT, id: `ING-${i}`, fromMe: false, participant: '628111@s.whatsapp.net' },
            messageTimestamp: TS + i,
            message: { conversation: `live ${i}` }
        }));
        const first = Cache.ingestRaw(raws, { source: 'history' });
        assert.strictEqual(first.ingested, 3);
        Cache.ingestRaw(raws, { source: 'history' });
        assert.strictEqual(Cache.recent(CHAT, { limit: 10 }).length, 3);
        assert.deepStrictEqual(Cache.recent(CHAT, { limit: 10 }).map(r => r.text), ['live 0', 'live 1', 'live 2']);
    });

    console.log('[5] tidak menulis disk');

    check('file state tidak dibuat sama sekali', () => {
        Cache.clear(CHAT);
        Cache.record(fakeMessage({ key: { id: 'NODISK-1' } }));
        Cache.ingestRaw([{ key: { remoteJid: CHAT, id: 'NODISK-2', fromMe: false }, messageTimestamp: TS, message: { conversation: 'x' } }]);
        assert.strictEqual(fs.existsSync(path.join(__dirname, '..', 'lib', 'database', 'message_cache.json')), false,
            'message_cache.json masih ada di disk');
        assert.strictEqual(fs.existsSync(path.join(__dirname, '..', 'lib', 'database', 'message_cache.json.tmp')), false,
            'file tmp masih ada di disk');
    });

    const report = (extraPass = 0, extraFail = []) => {
        const totalPass = pass + extraPass;
        const totalFail = [...fail, ...extraFail];
        console.log(`\n${totalPass} ok, ${totalFail.length} gagal`);
        if (totalFail.length) {
            totalFail.forEach(f => console.log(`  - ${f}`));
            process.exit(1);
        }
    };

    const unusedPersist = async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        try {
            Cache.clear(CHAT);
            Cache.record(fakeMessage({ key: { id: 'PERSIST-1' }, text: 'simpan aku' }));
            const deadline = Date.now() + 6000;
            while (Date.now() < deadline) {
                await sleep(200);
                if (!fs.existsSync(FILE)) continue;
                const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
                if (raw.chats?.[CHAT]?.some(r => r.id === 'PERSIST-1')) {
                    console.log('  ok  state tersimpan ke message_cache.json');
                    return { ok: true };
                }
            }
            throw new Error('state tidak tersimpan dalam 6 detik');
        } catch (err) {
            console.log(`  FAIL state tersimpan -> ${err.message}`);
            return { ok: false, message: err.message };
        }
    };

    report();
}

run();
