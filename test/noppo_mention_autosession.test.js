'use strict';




const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'noppo-mention-'));
process.env.NOPPO_SESSION_STORE = path.join(tmp, 'sessions.json');
process.env.NOPPO_ROUTER_API_KEY = 'fixture-key';
process.env.NOPPO_TEST_HERMES_BINARY = path.join(__dirname, 'fixtures', 'noppo-hermes-fake.sh');
process.env.NOPPO_FAKE_MODE = 'success';

const Sessions = require('../lib/noppo_sessions');
const noppo = require('../lib/noppo_commands');

const CHAT = '120363499999999999@g.us';
const BOT_ID = '6283167054726@s.whatsapp.net';
const BOT_LID = '111222333@lid';

function makeSock(sent) {
    return {
        user: { id: BOT_ID, lid: BOT_LID },
        decodeJid: value => String(value || ''),
        sendPresenceUpdate() {},
        async sendMessage(chat, content) {
            sent.push({ chat, content });
            return { key: { id: `msg-${sent.length}` } };
        }
    };
}

function mentionContext(sock, text) {
    const mentionedJid = [BOT_LID];
    const m = {
        chat: CHAT,
        key: { id: `in-${Date.now()}`, fromMe: false },
        body: text,
        budy: text,
        mentionedJid,
        mtype: null,
        message: { conversation: text },
        msg: { contextInfo: { mentionedJid } }
    };
    return { sock, m, authorizedOwner: true, isOwner: true, budy: text, body: text };
}

async function waitFor(predicate, { timeout = 30000, step = 150 } = {}) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
        if (predicate()) return true;
        await new Promise(resolve => setTimeout(resolve, step));
    }
    return false;
}

async function main() {
    Sessions.setEnabled(true);
    assert.equal(Sessions.getActiveSession(CHAT), null, 'chat harus mulai tanpa sesi');

    const sent = [];
    const sock = makeSock(sent);
    const handled = await noppo.handleMessage(mentionContext(sock, 'noppo cek status server'));
    assert.equal(handled, true, 'mention owner harus ditangani Noppo');

    const session = Sessions.getActiveSession(CHAT);
    assert.ok(session, 'sesi harus otomatis dibuat tanpa /noppo new');
    assert.equal(session.origin, 'auto');
    assert.equal(session.chatId, CHAT);

    const replied = await waitFor(() => sent.length > 0);
    assert.ok(replied, 'bot harus membalas mention di chat tanpa sesi');
    const texts = sent.map(item => String(item.content?.text || '')).join('\n');
    assert.ok(!/\/noppo new/.test(texts), `balasan tidak boleh menyuruh /noppo new, dapat: ${texts.slice(0, 200)}`);
    assert.ok(/Noppo/.test(texts), `balasan harus berisi jawaban Noppo, dapat: ${texts.slice(0, 200)}`);

    const finished = await waitFor(() => Sessions.getSession(session.id)?.status === 'idle');
    assert.ok(finished, 'turn harus selesai dan sesi kembali idle');

    
    const sentBefore = sent.length;
    await noppo.handleMessage(mentionContext(sock, 'noppo lagi'));
    await waitFor(() => sent.length > sentBefore);
    const after = Sessions.getActiveSession(CHAT);
    assert.equal(after.id, session.id, 'mention berikutnya harus memakai sesi yang sama');
    assert.equal(Sessions.listSessions(CHAT).length, 1, 'tidak boleh ada sesi ganda untuk satu chat');

    console.log('PASS: mention owner di chat tanpa sesi -> sesi otomatis + balasan, tanpa /noppo new');
}

main()
    .catch(error => { console.error(error); process.exitCode = 1; })
    .finally(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });
