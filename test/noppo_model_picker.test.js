'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'noppo-model-picker-'));
const catalog = Array.from({ length: 12 }, (_, index) => ({
    providerID: 'provider-a',
    modelID: `model-${index + 1}`,
    name: `Catalog Model ${index + 1}`,
    enabled: true,
    status: 'active',
    limit: { context: 64000, output: 4096 },
    capabilities: { input: ['text'] },
    variants: index === 0 ? [{ id: 'low' }, { id: 'high' }] : []
}));

process.env.NOPPO_SESSION_STORE = path.join(tmp, 'sessions.json');
process.env.NOPPO_OPENCODE_BINARY = path.join(tmp, 'opencode-model-catalog');
fs.writeFileSync(process.env.NOPPO_OPENCODE_BINARY,
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify({ data: catalog }))});\n`,
    { mode: 0o700 });

const Config = require('../lib/noppo_config');
const Sessions = require('../lib/noppo_sessions');
const Commands = require('../lib/noppo_commands');

async function main() {
    const sent = [];
    const sock = { async sendMessage(chat, content, options) { sent.push({ chat, content, options }); return {}; } };
    const context = { authorizedOwner: true, m: { chat: 'picker-chat' }, sock };

    await Commands.handleCommand(context, ['listmodel']);
    assert.match(sent.at(-1).content.text, /12 model/);
    assert.match(sent.at(-1).content.text, /halaman 1\/2/);
    assert.match(sent.at(-1).content.text, /provider-a\/model-1/);
    assert.equal(sent.at(-1).content.buttons[0].nativeFlowInfo.name, 'single_select');
    const listParams = JSON.parse(sent.at(-1).content.buttons[0].nativeFlowInfo.paramsJson);
    assert.ok(listParams.sections[0].rows.some(row => /Halaman 2/.test(row.title)), 'picker exposes next page');

    await Commands.handleCommand(context, ['listmodel', 'page:2']);
    assert.match(sent.at(-1).content.text, /halaman 2\/2/);
    assert.match(sent.at(-1).content.text, /Catalog Model 8/);

    await Commands.handleCommand(context, ['selectmodel', 'provider-a/model-12']);
    assert.equal(Sessions.getActiveSession('picker-chat').modelId, 'provider-a/model-12');
    assert.match(sent.at(-1).content.text, /OpenCode: `provider-a\/model-12`/);

    await Commands.handleCommand(context, ['selectmodel', 'provider-a/model-1#high']);
    assert.equal(Sessions.getActiveSession('picker-chat').modelId, 'provider-a/model-1#high');
    assert.match(sent.at(-1).content.text, /OpenCode: `provider-a\/model-1#high`/);
    assert.equal(Config.getEngineModel('provider-a/model-1#high'), 'provider-a/model-1#high');

    await Commands.handleCommand(context, ['modeldefault', 'provider-a/model-12']);
    assert.equal(Sessions.getDefaultModel(), 'provider-a/model-12');
    await Commands.handleCommand(context, ['modeluniversal', 'provider-a/model-2']);
    assert.equal(Sessions.getDefaultModel(), 'provider-a/model-2');
    assert.equal(Sessions.getActiveSession('picker-chat').modelId, 'provider-a/model-2');

    await Commands.handleCommand(context, ['modelimage']);
    const imageParams = JSON.parse(sent.at(-1).content.buttons[0].nativeFlowInfo.paramsJson);
    assert.ok(imageParams.sections[0].rows.some(row => row.id === '/noppo modelimage provider-a/model-1 on'), 'image picker toggles a model on');

    assert.throws(() => Sessions.setPreferredModel('picker-chat', 'provider-a/not-in-catalog'), /Unknown Noppo model/);
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('PASS: dynamic all-model WhatsApp picker, pagination, exact provider/model routing, and variants');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
});
