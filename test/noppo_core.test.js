'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const config = require('../lib/noppo_config');
const routing = require('../lib/noppo_routing');
const wa = require('../lib/noppo_whatsapp');

async function main() {
const catalog = [
    { providerID: 'provider-a', modelID: 'model-one', name: 'Model One', enabled: true, status: 'active', limit: { context: 64000, output: 4096 }, capabilities: { input: ['text'] }, variants: [{ id: 'low' }, { id: 'high' }] },
    { providerID: 'provider-a', modelID: 'model-two', name: 'Model Two', enabled: true, status: 'active', limit: { context: 32000, output: 2048 }, capabilities: { input: ['text', 'image'] }, variants: [] },
    { providerID: 'provider-b', modelID: 'model-three', name: 'Model Three', enabled: true, status: 'active', limit: { context: 16000, output: 1024 }, capabilities: { input: ['text'] }, variants: [] },
    { providerID: 'provider-a', modelID: 'disabled', name: 'Disabled', enabled: false, status: 'disabled', limit: {}, capabilities: {}, variants: [] }
];
process.env.NOPPO_OPENCODE_BINARY = path.join(os.tmpdir(), `noppo-model-catalog-${process.pid}.js`);
fs.writeFileSync(process.env.NOPPO_OPENCODE_BINARY, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({data:${JSON.stringify(catalog)}}));\n`, { mode: 0o700 });

assert.equal(config.DEFAULT_MODEL_ID, '9router/ca/deepseek-v4-1-flash-1017#max');
assert.equal(config.getModel().contextWindow, 1000000);
assert.equal(config.getModel().maxOutputTokens, 384000);
assert.equal(config.getModel('cx/gpt-6-luna[1m]').contextWindow, 1050000, 'legacy ID migrates to its OpenCode catalog entry');
assert.equal(config.getModel('dco/deepseek-ai/DeepSeek-V4.1-Flash-1017').contextWindow, 1000000);
assert.equal(config.getModel('dco/deepseek-ai/DeepSeek-V4.1-Flash-1017').maxInputTokens, 1000000);
assert.equal(config.getModel('dco/deepseek-ai/DeepSeek-V4.1-Flash-1017').maxOutputTokens, 384000);
assert.equal(config.getModel('re/opencode/hy4-flash-free').contextWindow, 200000);
assert.equal(config.getModel('re/opencode/hy4-flash-free').maxInputTokens, 200000);
assert.equal(config.getModel('re/opencode/hy4-flash-free').maxOutputTokens, 64000);
assert.equal(config.getModel().engineModel, '9router/ca/deepseek-v4-1-flash-1017');
assert.equal(config.getEngineModel(), '9router/ca/deepseek-v4-1-flash-1017#max');
assert.equal(config.getEngineModel('cx/gpt-6-luna[1m]'), '9router/ca/gpt-6-luna');
assert.equal(config.getEngineModel('re/opencode/hy4-flash-free'), '9router/ca/hy4');
assert.equal(config.getModel('unknown'), null);
const catalogModels = config.listModels();
assert.deepEqual(catalogModels.map(model => model.id), ['provider-a/model-one', 'provider-a/model-two', 'provider-b/model-three']);
const selectableModels = config.getSelectableModels();
assert.equal(selectableModels.length, 3, 'only models in the active catalogue are selectable');
assert.equal(new Set(selectableModels.map(model => model.engineModel)).size, selectableModels.length, 'each model route appears once');
assert.equal(config.listModels({ provider: 'provider-a' }).length, 2);
assert.equal(config.listModels({ query: 'MODEL TWO' })[0].id, 'provider-a/model-two');
assert.equal(config.findSelectableModel('provider-a/model-one', catalogModels).id, 'provider-a/model-one');
assert.equal(config.findSelectableModel('provider-a/model-one#high', catalogModels).defaultVariant, 'high');
assert.equal(config.findSelectableModel('provider-a/model-one#bogus', catalogModels), null);
assert.equal(config.findSelectableModel('provider-a/not-in-catalog', catalogModels), null);
assert.equal(config.getModel('provider-a/model-two').supportsImage, false, 'vision adapter only uses the 9Router API');
assert.equal(config.getModel('9router/not-in-catalog'), null, 'unknown direct IDs must not be accepted');
assert.equal(config.getEngineModel('provider-a/model-one#high'), 'provider-a/model-one#high');
fs.unlinkSync(process.env.NOPPO_OPENCODE_BINARY);

assert.deepEqual(routing.parseCommand('/noppo new'), ['new']);
assert.deepEqual(routing.parseCommand('/NOPPO resume abc'), ['resume', 'abc']);
assert.equal(routing.parseCommand('/noppoevil new'), null);
assert.equal(routing.isShortStatusQuestion('Jawab aja dulu, udh belum ?'), true);
assert.equal(routing.isShortStatusQuestion('sudah selesai?'), true);
assert.equal(routing.isShortStatusQuestion('Sempurnakan scraper AniBiPlay dan tambahkan HLS'), false);

assert.equal(routing.shouldTrigger({ isOwner: false, isPrivate: true, text: 'nop' }), false);
assert.equal(routing.shouldTrigger({ isOwner: true, isPrivate: true, text: 'hai' }), true);
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
assert.equal(first.engineSessionId, null, 'new Noppo sessions start without an engine session');
assert.equal(sessions.getActiveSession('chat-B').id, second.id);
assert.equal(sessions.setSessionModel(first.id, 'dco/deepseek-ai/DeepSeek-V4.1-Flash-1017').modelId,
    config.DEFAULT_MODEL_ID, 'legacy persisted IDs migrate to the direct OpenCode ID');
assert.equal(sessions.getActiveSession('chat-A').modelId, config.DEFAULT_MODEL_ID);
const freshAfterSwitch = sessions.createSession('chat-A');
assert.equal(freshAfterSwitch.modelId, config.DEFAULT_MODEL_ID);
assert.equal(sessions.getPreferredModel('chat-A'), config.DEFAULT_MODEL_ID);
assert.throws(() => sessions.setPreferredModel('chat-A', 'unknown/provider-model'), /Unknown Noppo model/);
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
