#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');

if (process.argv.includes('--version')) {
    process.stdout.write('2.3.2\n');
    process.exit(0);
}

if (process.argv[2] === 'api') {
    process.exit(0);
}

const mode = process.env.NOPPO_FAKE_MODE || 'success';
const sessionIndex = process.argv.indexOf('--session');
const modelIndex = Math.max(process.argv.indexOf('--model'), process.argv.indexOf('-m'));
const sessionId = sessionIndex >= 0 ? process.argv[sessionIndex + 1] : 'ses_fixture';
const hasModel = modelIndex >= 0;

if (sessionIndex >= 0 && !hasModel) {
    console.error('Resume must include explicit model');
    process.exit(2);
}

const write = event => process.stdout.write(`${JSON.stringify(event)}\n`);

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
    write({
        type: 'step_start',
        timestamp: Date.now(),
        sessionID: sessionId,
        part: { id: 'prt_step', sessionID: sessionId, type: 'step-start' }
    });

    if (mode === 'hang') {
        setInterval(() => {}, 1000);
        return;
    }

    if (mode === 'spawn-child') {
        const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore' });
        write({
            type: 'text',
            timestamp: Date.now(),
            sessionID: sessionId,
            part: { id: 'prt_child', sessionID: sessionId, type: 'text', text: JSON.stringify({ childPid: child.pid }) }
        });
        setInterval(() => {}, 1000);
        return;
    }

    if (mode === 'many-tools') {
        for (let i = 0; i < 25; i++) {
            write({
                type: 'tool_use',
                timestamp: Date.now(),
                sessionID: sessionId,
                part: {
                    id: `prt_tool_${i}`,
                    sessionID: sessionId,
                    type: 'tool',
                    tool: 'bash',
                    state: { status: 'completed', input: { command: `echo ${i}` }, output: `${i}\n`, time: { start: Date.now(), end: Date.now() } }
                }
            });
        }
        write({
            type: 'text',
            timestamp: Date.now(),
            sessionID: sessionId,
            part: { id: 'prt_many', sessionID: sessionId, type: 'text', text: 'completed after many tools' }
        });
        write({ type: 'step_finish', timestamp: Date.now(), sessionID: sessionId, part: { id: 'prt_step', sessionID: sessionId, type: 'step-finish', tokens: { input: 10, output: 5, reasoning: 0 } } });
        return;
    }

    write({
        type: 'text',
        timestamp: Date.now(),
        sessionID: sessionId,
        part: { id: 'prt_text_1', sessionID: sessionId, type: 'text', text: 'Noppo ' }
    });
    write({
        type: 'tool_use',
        timestamp: Date.now(),
        sessionID: sessionId,
        part: {
            id: 'prt_tool_1',
            sessionID: sessionId,
            type: 'tool',
            tool: 'bash',
            state: { status: 'running', input: { command: 'pwd' } }
        }
    });
    write({
        type: 'tool_use',
        timestamp: Date.now(),
        sessionID: sessionId,
        part: {
            id: 'prt_tool_1',
            sessionID: sessionId,
            type: 'tool',
            tool: 'bash',
            state: {
                status: 'completed',
                input: { command: 'pwd' },
                output: '/tmp\n',
                time: { start: Date.now() - 4, end: Date.now() },
                metadata: { metadata: { exit: 0 } }
            }
        }
    });
    write({
        type: 'text',
        timestamp: Date.now(),
        sessionID: sessionId,
        part: { id: 'prt_text_2', sessionID: sessionId, type: 'text', text: `selesai: ${prompt.trim()}` }
    });
    write({ type: 'step_finish', timestamp: Date.now(), sessionID: sessionId, part: { id: 'prt_step', sessionID: sessionId, type: 'step-finish', tokens: { input: 20, output: 8, reasoning: 0 } } });
});
