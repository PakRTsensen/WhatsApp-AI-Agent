'use strict';

const assert = require('node:assert/strict');
const { smsg } = require('../lib/myfunc');
const plugins = require('../lib/plugins');
plugins.initPlugins();

const sock = {
    user: { id: '6283167054726@s.whatsapp.net' },
    decodeJid: value => String(value || ''),
    sendMessage: async () => ({}),
    waUploadToServer: async () => ({})
};
const store = {};

function parsed(message, id) {
    return smsg(sock, {
        key: { id, remoteJid: '120363416869256797@g.us', participant: '6285199430173@s.whatsapp.net', fromMe: false },
        message
    }, store);
}

for (const [name, message] of [
    ['conversation', { conversation: '/menu' }],
    ['extended text', { extendedTextMessage: { text: '/menu' } }],
    ['ephemeral conversation', { ephemeralMessage: { message: { conversation: '/menu' } } }],
    ['ephemeral extended', { ephemeralMessage: { message: { extendedTextMessage: { text: '/menu' } } } }]
]) {
    const m = parsed(message, `test-${name}`);
    assert.equal(m.text, '/menu', `${name} normalized text`);
    const commandBody = String(m.text || '').trim();
    const prefixMatch = commandBody.startsWith('/') ? '/' : null;
    const command = prefixMatch ? commandBody.slice(prefixMatch.length).trim().split(/ +/)[0].toLowerCase() : '';
    assert.equal(command, 'menu', `${name} routes to menu command`);
    assert.equal(typeof plugins.findPlugin(command)?.run, 'function');
}

console.log('PASS: plain, extended-text, and ephemeral-wrapped /menu messages normalize and resolve to menu plugin');
process.exit(0);
