'use strict';

const assert = require('node:assert/strict');
const { makeWhatsAppRenderer, sendWithQuoted, toolStatus, toolResultStatus } = require('../lib/noppo_delivery');

async function main() {
    const sent = [];
    const sock = { async sendMessage(chat, content, options) {
        sent.push({ chat, content, options });
        await new Promise(resolve => setTimeout(resolve, 2));
        return { key: { id: 'noppo-single-message' } };
    } };
    const renderer = makeWhatsAppRenderer({ sock, chat: 'owner@g.us' });
    await Promise.all([
        renderer.update('Mulai'), renderer.update('Mulai memeriksa'), renderer.update('Mulai memeriksa file')
    ]);
    await renderer.update('⚙️ Mengedit file `src/a.ts`…');
    await renderer.finish('Selesai.');
    assert.equal(sent[0].content.text, 'Mulai');
    assert.equal(sent[0].content.edit, undefined);
    assert.ok(sent.slice(1).every(row => row.content.edit?.id === 'noppo-single-message'));
    assert.ok(sent.some(row => row.content.text === '⚙️ Mengedit file `src/a.ts`…'));
    assert.equal(sent.at(-1).content.text, 'Selesai.');

    let finalRichPayload = null;
    const richRenderer = makeWhatsAppRenderer({
        sock, chat: 'owner@g.us',
        makeFinalContent: async answer => {
            finalRichPayload = { footerText: answer, buttons: ['menu'], locationMessage: { name: 'Stenly' }, jpegThumbnail: 'image' };
            return { relay: true, message: { message: finalRichPayload } };
        }
    });
    await richRenderer.update('Jawaban bertahap');
    const result = await richRenderer.finish('Jawaban final');
    assert.deepEqual(finalRichPayload, { footerText: 'Jawaban final', buttons: ['menu'], locationMessage: { name: 'Stenly' }, jpegThumbnail: 'image' });
    assert.equal(result.relay, true);
    assert.equal(sent.length, 4, 'rich final delivery must not send a second plain-text message');
    const shellStatus = toolStatus({ toolName: 'terminal', iteration: 2, input: { command: 'npm test -- --runInBand', workdir: '/root/project', timeout: 60 } });
    assert.ok(shellStatus.startsWith('Menjalankan "terminal" :'));
    assert.ok(shellStatus.includes('`npm test -- --runInBand`'));
    assert.ok(!shellStatus.includes('```'));
    assert.ok(!/[⚙️⏳✅⚠️🛑]/u.test(shellStatus));
    assert.ok(!shellStatus.includes('Proses berjalan'));
    assert.ok(shellStatus.includes('npm test -- --runInBand'));
    assert.ok(shellStatus.includes('/root/project'));
    const webStatus = toolStatus({ toolName: 'web_extract', input: { url: 'https://example.test', query: 'episode list' } });
    assert.ok(webStatus.includes('`{"url":"https://example.test","query":"episode list"}`'));
    assert.ok(!webStatus.includes('```'));
    assert.ok(webStatus.includes('https://example.test'));
    assert.ok(webStatus.includes('episode list'));
    const patchStatus = toolStatus({ toolName: 'patch', input: { path: '/repo/a.ts', old_string: 'before', new_string: 'after', api_key: 'secret-value' } });
    assert.ok(patchStatus.includes('before'));
    assert.ok(patchStatus.includes('after'));
    assert.ok(!patchStatus.includes('secret-value'));
    const outputStatus = toolResultStatus({ toolName: 'web_extract', output: 'Found episode list', isError: false });
    assert.ok(outputStatus.includes('Tool selesai "web_extract" :'));
    assert.ok(outputStatus.includes('`Found episode list`'));
    assert.ok(!outputStatus.includes('```'));
    assert.equal(toolResultStatus({ toolName: 'terminal', output: 'denied', isError: true }).includes('Tool gagal'), true);

    const quotedCalls = [];
    const quotedSock = { async sendMessage(chat, content, options) {
        quotedCalls.push({ chat, content, options });
        return { key: { id: `quoted-${quotedCalls.length}` } };
    } };
    const validQuoted = { key: { remoteJid: 'owner@g.us', id: 'Q1', fromMe: false }, message: { conversation: 'halo' } };
    await sendWithQuoted(quotedSock, 'owner@g.us', { text: 'a' }, validQuoted);
    assert.equal(quotedCalls[0].options.quoted, validQuoted);
    await sendWithQuoted(quotedSock, 'owner@g.us', { text: 'b' }, { key: { id: 'Q2' } });
    assert.equal(quotedCalls[1].options, undefined);
    await sendWithQuoted(quotedSock, 'owner@g.us', { text: 'c' }, { key: { id: 'Q3' }, message: { documentWithCaptionMessage: { message: {} } } });
    assert.equal(quotedCalls[2].options, undefined);

    let crashAttempts = 0;
    const crashSock = { async sendMessage(chat, content, options) {
        if (options?.quoted) {
            crashAttempts += 1;
            throw new TypeError("Cannot read properties of undefined (reading 'undefined')");
        }
        return { key: { id: 'after-fallback' } };
    } };
    const crashQuoted = { key: { remoteJid: 'owner@g.us', id: 'Q4', fromMe: false }, message: { imageMessage: { mimetype: 'image/jpeg' } } };
    const crashRenderer = makeWhatsAppRenderer({ sock: crashSock, chat: 'owner@g.us', quoted: crashQuoted });
    await crashRenderer.update('Halo');
    await crashRenderer.finish('Selesai.');
    assert.equal(crashAttempts, 1);
    assert.equal(crashRenderer.getMessageKey().id, 'after-fallback');

    console.log('PASS: Noppo delivery serializes one WhatsApp message and sanitizes tool previews');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
