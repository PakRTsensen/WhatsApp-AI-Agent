'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const config = require('../lib/noppo_config');

const storePath = path.join(os.tmpdir(), `noppo-autosession-${process.pid}.json`);
process.env.NOPPO_SESSION_STORE = storePath;
const sessions = require('../lib/noppo_sessions');

function main() {
    
    const first = sessions.ensureActiveSession('chat-new');
    assert.equal(first.created, true, 'chat tanpa sesi harus membuat sesi otomatis');
    assert.equal(first.session.origin, 'auto', 'sesi hasil mention ditandai origin auto');
    assert.equal(first.session.modelId, config.DEFAULT_MODEL_ID);
    assert.equal(sessions.getActiveSession('chat-new').id, first.session.id, 'sesi otomatis langsung aktif');

    
    const again = sessions.ensureActiveSession('chat-new');
    assert.equal(again.created, false, 'ensure tidak boleh membuat sesi ganda');
    assert.equal(again.session.id, first.session.id);

    
    const manual = sessions.createSession('chat-new');
    assert.equal(manual.origin, 'manual');
    assert.notEqual(manual.id, first.session.id);
    assert.equal(sessions.getActiveSession('chat-new').id, manual.id);

    
    assert.equal(sessions.getActiveSession('chat-other'), null);
    const other = sessions.ensureActiveSession('chat-other');
    assert.equal(other.created, true);
    assert.notEqual(other.session.id, manual.id);

    
    sessions.setPreferredModel('chat-model', 'dco/deepseek-ai/DeepSeek-V4.1-Flash-1017');
    const withModel = sessions.ensureActiveSession('chat-model');
    assert.equal(withModel.session.modelId, 'dco/deepseek-ai/DeepSeek-V4.1-Flash-1017');

    
    sessions.clearActiveSession('chat-new');
    assert.equal(sessions.getActiveSession('chat-new'), null);
    const reopened = sessions.ensureActiveSession('chat-new');
    assert.equal(reopened.created, true);
    assert.notEqual(reopened.session.id, manual.id);

    
    const activeIds = new Set(Object.values(
        sessions.listSessions().filter(row => row.active).map(row => row.chatId)
    ));
    assert.equal(activeIds.size, sessions.listSessions().filter(row => row.active).length,
        'satu chat hanya boleh punya satu sesi aktif');

    try { fs.unlinkSync(storePath); } catch (_) {}
    console.log('PASS: sesi otomatis saat owner mention, /noppo new tetap manual, isolasi per chat');
}

try {
    main();
} catch (error) {
    console.error(error);
    process.exitCode = 1;
}
