'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'noppo-e2e-'));
process.env.NOPPO_SESSION_STORE = path.join(tmp, 'sessions.json');
process.env.NOPPO_ROUTER_API_KEY = 'fixture-key';
process.env.NOPPO_TEST_OPENCODE_BINARY = path.join(__dirname, 'fixtures', 'noppo-opencode-fake.js');
process.env.NOPPO_FAKE_MODE = 'success';

const Sessions = require('../lib/noppo_sessions');
const Engine = require('../lib/noppo_opencode');
const { makeWhatsAppRenderer, toolStatus } = require('../lib/noppo_delivery');

async function main() {
    const session = Sessions.createSession('wa-owner-chat', { modelId: 'cx/gpt-6-luna[1m]' });
    const events = [];
    const sent = [];
    const fakeWhatsApp = { async sendMessage(chat, content, options) {
        sent.push({ chat, content, options });
        return { key: { id: 'one-wa-message' } };
    } };
    const renderer = makeWhatsAppRenderer({ sock: fakeWhatsApp, chat: 'wa-owner-chat' });
    const result = await Engine.runTurn({
        chatId: 'wa-owner-chat',
        prompt: 'Inspect project',
        session,
        onEvent(event) {
            events.push(event.type);
            if (event.type === 'text_delta') renderer.update(event.accumulatedText).catch(() => {});
            if (event.type === 'tool_started') renderer.update(toolStatus(event)).catch(() => {});
            if (event.type === 'result') renderer.finish(event.text).catch(() => {});
        }
    });
    await renderer.finish(result.text);
    assert.equal(result.exitCode, 0);
    assert.ok(events.includes('text_delta'));
    assert.ok(events.includes('tool_started'));
    assert.ok(events.includes('tool_completed'));
    assert.equal(sent[0].content.text, 'Noppo ');
    assert.equal(sent.filter(item => !item.content.edit).length, 1, 'one WhatsApp message is created');
    assert.ok(sent.slice(1).every(item => item.content.edit?.id === 'one-wa-message'));
    assert.equal(sent.at(-1).content.text, 'Noppo selesai: Inspect project');
    assert.equal(Sessions.getSession(session.id).status, 'idle');
    console.log(`PASS: fake OpenCode tools+stream -> one WhatsApp message, ${sent.length - 1} edits, final response`);
}

main().catch(error => { console.error(error); process.exitCode = 1; })
    .finally(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });
