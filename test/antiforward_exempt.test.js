
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const Store = require('../lib/antiforward_store');
const DB = Store.DATABASE;
const CHAT = '120363499999999999@g.us';
const CHAT2 = '120363488888888888@g.us';
const CHANNEL = '120363499999999999@newsletter';

const backup = fs.existsSync(DB) ? fs.readFileSync(DB) : null;

function restore() {
    if (backup) fs.writeFileSync(DB, backup);
    else if (fs.existsSync(DB)) fs.unlinkSync(DB);
}

async function main() {
    
    const s = Store.readState();
    s.enabled_all = true;
    s.groups = { ...(s.groups || {}), [CHAT]: { enabled: true } };
    delete (s.exempt || {})[CHAT];
    delete (s.exempt || {})[CHAT2];
    Store.writeState(s);

    let st0 = Store.readState();
    const add = Store.addSender(st0, CHAT, { jid: '628111222333@s.whatsapp.net', number: '628111222333', addedBy: 'test' });
    Store.writeState(st0);
    assert.strictEqual(add.added, true, 'addSender harus menambah');
    assert.strictEqual(add.entry.number, '628111222333');

    st0 = Store.readState();
    const again = Store.addSender(st0, CHAT, { jid: '628111222333@s.whatsapp.net', number: '628111222333', addedBy: 'test' });
    assert.strictEqual(again.alreadyExists, true, 'addSender duplikat harus terdeteksi');

    st0 = Store.readState();
    const lidAdd = Store.addSender(st0, CHAT, { jid: '12345678901234@lid', lid: '12345678901234@lid', addedBy: 'test' });
    Store.writeState(st0);
    assert.strictEqual(lidAdd.added, true);

    let st = Store.readState();
    assert.strictEqual(Store.checkExempt(st, CHAT, { senderJid: '628111222333@s.whatsapp.net' }).exempt, true);
    assert.strictEqual(Store.checkExempt(st, CHAT, { senderJid: '628111222333:12@s.whatsapp.net' }).exempt, true, 'device suffix harus diabaikan');
    assert.strictEqual(Store.checkExempt(st, CHAT, { senderLid: '12345678901234@lid' }).exempt, true, 'match lewat LID');
    assert.strictEqual(Store.checkExempt(st, CHAT, { senderJid: '628999888777@s.whatsapp.net' }).exempt, false, 'pengirim lain tetap diblok');
    assert.strictEqual(Store.checkExempt(st, CHAT2, { senderJid: '628111222333@s.whatsapp.net' }).exempt, false, 'pengecualian tidak bocor ke grup lain');

    let stc = Store.readState();
    const chAdd = Store.addChannel(stc, CHAT, { jid: CHANNEL, name: 'Saluran Uji', addedBy: 'test' });
    Store.writeState(stc);
    assert.strictEqual(chAdd.added, true);
    st = Store.readState();
    assert.strictEqual(Store.checkExempt(st, CHAT, { senderJid: '628999888777@s.whatsapp.net', newsletterJid: CHANNEL }).exempt, true, 'saluran dikecualikan');
    assert.strictEqual(Store.checkExempt(st, CHAT, { senderJid: '628999888777@s.whatsapp.net', newsletterJid: '120363400000000000@newsletter' }).exempt, false);

    let str = Store.readState();
    const rmSender = Store.removeSender(str, CHAT, '628111222333');
    Store.writeState(str);
    assert.strictEqual(rmSender.removed, true);
    st = Store.readState();
    assert.strictEqual(Store.checkExempt(st, CHAT, { senderJid: '628111222333@s.whatsapp.net' }).exempt, false, 'hapus harus benar-benar mencabut');

    let str2 = Store.readState();
    const rmChannel = Store.removeChannel(str2, CHAT, CHANNEL);
    Store.writeState(str2);
    assert.strictEqual(rmChannel.removed, true);

    
    fs.writeFileSync(DB, JSON.stringify({ _v: 2, enabled_all: true, groups: { [CHAT]: { enabled: true } } }, null, 2));
    const migrated = Store.readState();
    assert.strictEqual(migrated._v, Store.SCHEMA);
    assert.deepStrictEqual(migrated.exempt, {});
    assert.strictEqual(Store.isGroupEnabled(migrated, CHAT), true);
    console.log('PASS: store pengecualian (sender, LID, device suffix, saluran, isolasi per grup, migrasi)');

    
    const plugin = require('../plugins/grup/antiforward.js');
    assert.ok(typeof plugin.before === 'function', 'plugin harus punya before()');

    const st2 = Store.readState();
    st2.enabled_all = true;
    st2.groups = { [CHAT]: { enabled: true } };
    st2.exempt = { [CHAT]: { senders: [{ jid: '628111222333@s.whatsapp.net', number: '628111222333', addedAt: new Date().toISOString(), addedBy: 'test' }], channels: [] } };
    Store.writeState(st2);

    function makeCtx(sender, channelJid) {
        const calls = { delete: 0 };
        const sock = {
            user: { id: '6283167054726@s.whatsapp.net' },
            sendMessage: async (_chat, payload) => {
                if (payload && payload.delete) calls.delete += 1;
                return { key: { id: 'X' } };
            },
            relayMessage: async () => ({ key: { id: 'X' } })
        };
        const m = {
            chat: CHAT,
            sender,
            key: { id: 'TESTMSG1', participant: sender, fromMe: false },
            message: {
                extendedTextMessage: {
                    text: 'cek',
                    contextInfo: {
                        forwardedNewsletterMessageInfo: {
                            newsletterName: 'Saluran Uji',
                            newsletterJid: channelJid
                        }
                    }
                }
            }
        };
        return {
            calls,
            ctx: {
                isGroup: true,
                m,
                sock,
                budy: '',
                body: '',
                isBotAdmins: true,
                isGroupAdmins: false,
                participants: [{ id: '6283167054726@s.whatsapp.net', admin: 'admin' }],
                botNumber: '6283167054726',
                prefix: '/',
                reply: async () => {}
            }
        };
    }

    const exemptCtx = makeCtx('628111222333@s.whatsapp.net', '120363400000000000@newsletter');
    const r1 = await plugin.before(exemptCtx.ctx);
    assert.strictEqual(r1, false, 'pengirim dikecualikan -> before() harus false');
    assert.strictEqual(exemptCtx.calls.delete, 0, 'pesan TIDAK boleh dihapus untuk pengirim dikecualikan');

    const blockedCtx = makeCtx('628999888777@s.whatsapp.net', '120363400000000000@newsletter');
    const r2 = await plugin.before(blockedCtx.ctx);
    assert.strictEqual(r2, true, 'pengirim tidak dikecualikan -> before() harus true');
    assert.strictEqual(blockedCtx.calls.delete, 1, 'pesan harus dihapus untuk pengirim biasa');

    const st3 = Store.readState();
    st3.exempt = { [CHAT]: { senders: [], channels: [{ jid: CHANNEL, name: 'Saluran Uji', addedAt: new Date().toISOString(), addedBy: 'test' }] } };
    Store.writeState(st3);
    const channelCtx = makeCtx('628999888777@s.whatsapp.net', CHANNEL);
    const r3 = await plugin.before(channelCtx.ctx);
    assert.strictEqual(r3, false, 'saluran dikecualikan -> before() harus false');
    assert.strictEqual(channelCtx.calls.delete, 0, 'pesan dari saluran dikecualikan tidak boleh dihapus');

    const otherChannelCtx = makeCtx('628999888777@s.whatsapp.net', '120363477777777777@newsletter');
    const r4 = await plugin.before(otherChannelCtx.ctx);
    assert.strictEqual(r4, true, 'saluran lain tetap diblok');
    assert.strictEqual(otherChannelCtx.calls.delete, 1);

    console.log('PASS: gate plugin (pengirim dikecualikan lolos, pengirim biasa dihapus, saluran dikecualikan lolos)');
    console.log('PASS: semua test anti-forward exemption');
}

main()
    .then(() => { restore(); })
    .catch((err) => {
        restore();
        console.error('FAIL:', err.message);
        process.exit(1);
    });
