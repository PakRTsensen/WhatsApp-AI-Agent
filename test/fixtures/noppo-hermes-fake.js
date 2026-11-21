#!/usr/bin/env node
'use strict';

const mode = process.env.NOPPO_FAKE_MODE || 'success';
const queryIndex = process.argv.indexOf('--query-file');
const input = queryIndex >= 0 ? require('node:fs').readFileSync(process.argv[queryIndex + 1], 'utf8') : '';
const write = event => process.stdout.write(`${JSON.stringify(event)}\n`);

if (process.argv.includes('--resume') && !process.argv.includes('-m')) {
    console.error('Resume must include explicit session model');
    process.exit(2);
}

write({ type: 'system', subtype: 'init', model: 'cx/gpt-6-luna[1m]', session_id: 'hermes-session-fixture' });

if (mode === 'hang') {
    setInterval(() => process.stdout.write(' '), 250).unref?.();
    setInterval(() => {}, 1000);
} else if (mode === 'spawn-child') {
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore' });
    write({ type: 'text', text: JSON.stringify({ childPid: child.pid }) });
    setInterval(() => {}, 1000);
} else if (mode === 'loop') {
    for (let i = 0; i < 6; i++) write({ type: 'tool_use', name: 'terminal', input: { command: 'echo loop' } });
    setTimeout(() => write({ type: 'result', session_id: 'hermes-session-fixture', exit_code: 0, text: 'loop unexpectedly continued' }), 300);
} else if (mode === 'many-tools') {
    for (let i = 0; i < 25; i++) write({ type: 'tool_use', name: 'terminal', input: { command: `echo ${i}` } });
    write({ type: 'result', session_id: 'hermes-session-fixture', exit_code: 0, text: 'completed after many tools' });
} else {
    write({ type: 'text', text: 'Noppo ' });
    write({ type: 'tool_use', name: 'terminal', input: { command: 'pwd' } });
    write({ type: 'tool_result', name: 'terminal', output: '/tmp', duration_ms: 4, is_error: false });
    write({ type: 'text', text: `selesai: ${input}` });
    write({ type: 'result', session_id: 'hermes-session-fixture', exit_code: 0, text: `Noppo selesai: ${input}` });
}
