'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'noppo-engine-test-'));
process.env.NOPPO_SESSION_STORE = path.join(tmp, 'sessions.json');
process.env.NOPPO_ROUTER_API_KEY = 'fixture-key';
process.env.NOPPO_TEST_OPENCODE_BINARY = path.join(__dirname, 'fixtures', 'noppo-opencode-fake.js');

const Sessions = require('../lib/noppo_sessions');
const Engine = require('../lib/noppo_opencode');

async function main() {
    const session = Sessions.createSession('chat-1', { modelId: 'cx/gpt-6-luna[1m]' });
    const events = [];
    const result = await Engine.runTurn({ chatId: 'chat-1', prompt: 'fixture prompt', session, onEvent: e => events.push(e) });
    assert.equal(result.exitCode, 0);
    assert.equal(result.sessionId, 'ses_fixture');
    assert.equal(result.text, 'Noppo selesai: fixture prompt');
    assert.deepEqual(events.filter(e => e.type === 'text_delta').map(e => e.text), ['Noppo ', 'selesai: fixture prompt']);
    assert.equal(events.filter(e => e.type === 'tool_started').length, 1);
    assert.equal(events.filter(e => e.type === 'tool_completed').length, 1);
    assert.equal(Sessions.getSession(session.id).engineSessionId, 'ses_fixture');
    assert.equal(Sessions.getSession(session.id).status, 'idle');

    const resumedSession = Sessions.getSession(session.id);
    const resumed = await Engine.runTurn({ chatId: 'chat-1', prompt: 'resume fixture', session: resumedSession });
    assert.equal(resumed.exitCode, 0, 'resume must carry explicit session model and launch policy');
    assert.equal(resumed.sessionId, 'ses_fixture');

    process.env.NOPPO_FAKE_MODE = 'many-tools';
    const loopSession = Sessions.createSession('chat-loop', { modelId: 'cx/gpt-6-luna[1m]' });
    const loopResult = await Engine.runTurn({ chatId: 'chat-loop', prompt: 'many tools', session: loopSession });
    assert.equal(loopResult.stopped, false, 'long tool sequences must not hit an arbitrary Noppo call limit');
    assert.equal(loopResult.text, 'completed after many tools');

    process.env.NOPPO_FAKE_MODE = 'hang';
    const stopSession = Sessions.createSession('chat-stop', { modelId: 'cx/gpt-6-luna[1m]' });
    const running = Engine.runTurn({ chatId: 'chat-stop', prompt: 'hang', session: stopSession });
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(Engine.status('chat-stop').running, true);
    await assert.rejects(Engine.runTurn({ chatId: 'chat-stop', prompt: 'parallel', session: stopSession }), /masih berjalan/);
    Engine.stopTurn('chat-stop', { reason: 'fixture_stop' });
    const stopped = await running;
    assert.equal(stopped.stopped, true);
    assert.equal(Engine.status('chat-stop').running, false);
    assert.equal(Sessions.getSession(stopSession.id).status, 'stopped');

    process.env.NOPPO_FAKE_MODE = 'spawn-child';
    const childSession = Sessions.createSession('chat-child-stop', { modelId: 'cx/gpt-6-luna[1m]' });
    let childPid = null;
    const childRun = Engine.runTurn({ chatId: 'chat-child-stop', prompt: 'spawn child', session: childSession, onEvent(event) {
        if (event.type === 'text_delta') {
            const parsed = JSON.parse(event.accumulatedText);
            childPid = parsed.childPid;
        }
    } });
    for (let i = 0; i < 30 && !childPid; i++) await new Promise(resolve => setTimeout(resolve, 30));
    assert.ok(childPid, 'fixture child process should be reported');
    Engine.stopTurn('chat-child-stop', { reason: 'fixture_kill_tree' });
    await childRun;
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.throws(() => process.kill(childPid, 0), 'stop should kill the subprocess group');

    console.log('PASS: OpenCode JSON delta/tool/result flow, session binding, max loop guard, duplicate-turn rejection, stop');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
});
