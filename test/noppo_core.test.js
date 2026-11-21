'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const config = require('../lib/noppo_config');
const routing = require('../lib/noppo_routing');
const wa = require('../lib/noppo_whatsapp');

async function main() {
assert.equal(config.DEFAULT_MODEL_ID, 'dco/deepseek-ai/DeepSeek-V4.1-Flash-1017');
assert.equal(config.getModel().contextWindow, 256000);
assert.equal(config.getModel().maxOutputTokens, null);
assert.equal(config.getModel('cx/gpt-6-luna[1m]').contextWindow, 872000, 'model lama tetap terdaftar');
assert.equal(config.getModel('dco/deepseek-ai/DeepSeek-V4.1-Flash-1017').contextWindow, 256000);
assert.equal(config.getModel('dco/deepseek-ai/DeepSeek-V4.1-Flash-1017').maxInputTokens, 256000);
assert.equal(config.getModel('dco/deepseek-ai/DeepSeek-V4.1-Flash-1017').maxOutputTokens, null);
assert.equal(config.getModel('re/opencode/hy4-flash-free').contextWindow, 1000000);
assert.equal(config.getModel('re/opencode/hy4-flash-free').maxInputTokens, 1000000);
assert.equal(config.getModel('re/opencode/hy4-flash-free').maxOutputTokens, 64000);
assert.equal(config.getModel('unknown'), null);

assert.deepEqual(routing.parseCommand('/noppo new'), ['new']);
assert.deepEqual(routing.parseCommand('/NOPPO resume abc'), ['resume', 'abc']);
assert.equal(routing.parseCommand('/noppoevil new'), null);
assert.equal(routing.isShortStatusQuestion('Jawab aja dulu, udh belum ?'), true);
assert.equal(routing.isShortStatusQuestion('sudah selesai?'), true);
assert.equal(routing.isShortStatusQuestion('Sempurnakan scraper AniBiPlay dan tambahkan HLS'), false);

assert.equal(routing.shouldTrigger({ isOwner: false, isPrivate: true, text: 'nop' }), false);
assert.equal(routing.shouldTrigger({ isOwner: true, isPrivate: true, text: 'hai' }), false);
assert.equal(routing.shouldTrigger({ isOwner: true, isPrivate: false, isReplyToBot: true, text: 'lanjut' }), true);
assert.equal(routing.shouldTrigger({ isOwner: true, isPrivate: false, isMentionToBot: true, text: 'halo' }), true);
assert.equal(routing.shouldTrigger({ isOwner: true, isPrivate: false, text: 'noppo bantu' }), true);
assert.equal(routing.shouldTrigger({ isOwner: true, isPrivate: false, text: 'halo semua' }), false);
const botSock = { user: { id: '6283167054726@s.whatsapp.net', lid: '111222333@lid' }, decodeJid: value => String(value || '') };
assert.equal(wa.isReplyToBot({ quoted: { key: { fromMe: true } } }, botSock), true);
assert.equal(wa.isReplyToBot({ msg: { contextInfo: { participant: '6283167054726@s.whatsapp.net' } } }, botSock), true);
assert.equal(wa.isReplyToBot({ msg: { contextInfo: { participant: '6289999999999@s.whatsapp.net' } } }, botSock), false);
const mentionResults = await Promise.all([
    wa.isMentionToBot({ mentionedJid: ['6283167054726@s.whatsapp.net'] }, botSock),
    wa.isMentionToBot({ msg: { contextInfo: { mentionedJid: ['111222333@lid'] } } }, botSock)
]);
assert.deepEqual(mentionResults, [true, true]);

const storePath = path.join(os.tmpdir(), `noppo-sessions-${process.pid}.json`);
process.env.NOPPO_SESSION_STORE = storePath;
const sessions = require('../lib/noppo_sessions');
const first = sessions.createSession('chat-A', { modelId: config.DEFAULT_MODEL_ID });
const second = sessions.createSession('chat-B', { modelId: config.DEFAULT_MODEL_ID });
assert.notEqual(first.id, second.id);
assert.equal(sessions.getActiveSession('chat-A').id, first.id);
assert.equal(first.launchPolicy.maxTurns, 0, 'new Noppo sessions should default to unlimited Hermes tool iterations');
assert.equal(sessions.getActiveSession('chat-B').id, second.id);
assert.equal(sessions.setSessionModel(first.id, 'dco/deepseek-ai/DeepSeek-V4.1-Flash-1017').modelId,
    'dco/deepseek-ai/DeepSeek-V4.1-Flash-1017');
assert.equal(sessions.getActiveSession('chat-A').modelId, 'dco/deepseek-ai/DeepSeek-V4.1-Flash-1017');
const freshAfterSwitch = sessions.createSession('chat-A');
assert.equal(freshAfterSwitch.modelId, 'dco/deepseek-ai/DeepSeek-V4.1-Flash-1017');
assert.equal(sessions.getPreferredModel('chat-A'), 'dco/deepseek-ai/DeepSeek-V4.1-Flash-1017');
assert.equal(sessions.getPreferredModel('chat-B'), config.DEFAULT_MODEL_ID);
assert.equal(sessions.activateSession('chat-A', second.id).chatId, 'chat-A');
assert.equal(sessions.getActiveSession('chat-B'), null);
sessions.clearActiveSession('chat-A');
assert.equal(sessions.getActiveSession('chat-A'), null);
assert.equal(sessions.listSessions().length, 3);
sessions.deleteSession(first.id);
sessions.deleteSession(second.id);
sessions.deleteSession(freshAfterSwitch.id);
try { fs.unlinkSync(storePath); } catch (_) {}
console.log('PASS: model limits, owner authorization, triggers, status interruption, and isolated sessions');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
