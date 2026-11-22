'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const { NOPPO_CONFIG, getModel, getEngineModel } = require('./noppo_config');
const Sessions = require('./noppo_sessions');

const activeTurns = new Map();
const stopRequests = new Set();

function binaryPath() {
    return process.env.NOPPO_TEST_OPENCODE_BINARY || NOPPO_CONFIG.execution.opencodeBinary;
}

function isAvailable() {
    try {
        const result = spawnSync(binaryPath(), ['--version'], {
            encoding: 'utf8',
            timeout: 10000,
            env: process.env
        });
        return result.status === 0;
    } catch (_) {
        return false;
    }
}

function getProviderKey() {
    const fromEnv = process.env[NOPPO_CONFIG.provider.apiKeyEnv];
    if (fromEnv) return fromEnv;
    try {
        const content = fs.readFileSync(NOPPO_CONFIG.provider.credentialsFile, 'utf8');
        for (const line of content.split(/\r?\n/)) {
            const match = line.match(/^\s*NOPPO_ROUTER_API_KEY\s*=\s*(.*?)\s*$/);
            if (match) return match[1].replace(/^(['"])(.*)\1$/, '$2');
        }
    } catch (_) {}
    return '';
}

function hasProviderKey() {
    return Boolean(getProviderKey());
}

function signalProcessGroup(child, signal) {
    if (!child?.pid) return;
    try { process.kill(-child.pid, signal); }
    catch (_) { try { child.kill(signal); } catch (_) {} }
}

function interruptViaApi(sessionId) {
    return new Promise(resolve => {
        if (!sessionId) return resolve(false);
        let settled = false;
        let child;
        const done = value => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        };
        const timer = setTimeout(() => {
            try { child?.kill('SIGKILL'); } catch (_) {}
            done(false);
        }, NOPPO_CONFIG.execution.interruptTimeoutMs);
        timer.unref?.();
        try {
            child = spawn(binaryPath(), ['api', 'post', `/api/session/${sessionId}/interrupt`], {
                stdio: ['ignore', 'ignore', 'ignore'],
                env: process.env
            });
        } catch (_) {
            return done(false);
        }
        child.on('error', () => done(false));
        child.on('close', code => done(code === 0));
    });
}

function stopTurn(chatId, { force = false, reason = 'owner_stop' } = {}) {
    const active = activeTurns.get(String(chatId));
    if (!active) return { stopped: false, reason: 'not_running' };
    active.reason = reason;
    stopRequests.add(active.turnId);

    if (force) {
        clearTimeout(active.termTimer);
        signalProcessGroup(active.child, 'SIGKILL');
        return { stopped: true, forced: true, turnId: active.turnId };
    }

    const isTest = Boolean(process.env.NOPPO_TEST_OPENCODE_BINARY);
    if (!isTest) void interruptViaApi(active.engineSessionId);

    const grace = isTest ? 0 : NOPPO_CONFIG.execution.stopGraceMs;
    active.termTimer = setTimeout(() => {
        if (activeTurns.get(String(chatId)) === active) signalProcessGroup(active.child, 'SIGTERM');
    }, grace);
    active.termTimer.unref?.();

    active.forceTimer = setTimeout(() => {
        if (activeTurns.get(String(chatId)) === active) signalProcessGroup(active.child, 'SIGKILL');
    }, NOPPO_CONFIG.execution.stopForceMs);
    active.forceTimer.unref?.();

    return { stopped: true, forced: false, turnId: active.turnId };
}

function status(chatId) {
    const row = activeTurns.get(String(chatId));
    if (!row) return { running: false };
    return {
        running: true,
        turnId: row.turnId,
        sessionId: row.sessionId,
        engineSessionId: row.engineSessionId,
        modelId: row.model.id,
        startedAt: row.startedAt
    };
}

function runTurn({ chatId, prompt, session, modelId, signal, onEvent = () => {}, cwd }) {
    chatId = String(chatId);
    if (activeTurns.has(chatId)) return Promise.reject(new Error('Turn Noppo masih berjalan untuk chat ini.'));
    if (!session?.id) return Promise.reject(new TypeError('Noppo session metadata is required.'));

    const model = getModel(modelId || session.modelId || NOPPO_CONFIG.defaultModelId);
    if (!model) return Promise.reject(new Error(`Model Noppo tidak terdaftar: ${modelId || session.modelId}`));
    const engineModel = getEngineModel(model);

    const args = [
        'run', '--format', 'json',
        '--agent', NOPPO_CONFIG.execution.agent,
        '--model', engineModel,
        '--auto'
    ];
    if (session.engineSessionId) args.push('--session', String(session.engineSessionId));
    else args.push('--title', `Noppo ${chatId}`);

    const child = spawn(binaryPath(), args, {
        cwd: cwd || NOPPO_CONFIG.execution.workingDirectory,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env }
    });

    const turn = {
        turnId: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        child,
        sessionId: session.id,
        engineSessionId: session.engineSessionId || null,
        model,
        engineModel,
        startedAt: Date.now(),
        buffer: '',
        accumulatedText: '',
        textParts: new Map(),
        toolSeen: new Set(),
        toolCounts: new Map(),
        toolCallTotal: 0,
        tokens: { input: 0, output: 0, reasoning: 0 },
        error: null,
        reason: null,
        started: false,
        termTimer: null,
        forceTimer: null
    };
    activeTurns.set(chatId, turn);
    Sessions.setStatus(session.id, 'running');

    return new Promise((resolve, reject) => {
        let settled = false;
        let stderr = '';
        const finish = (error, result) => {
            if (settled) return;
            settled = true;
            clearTimeout(turn.termTimer);
            clearTimeout(turn.forceTimer);
            if (activeTurns.get(chatId) === turn) activeTurns.delete(chatId);
            if (signal) signal.removeEventListener('abort', abortHandler);
            if (error) {
                Sessions.setStatus(session.id, 'error', error.message);
                reject(error);
            } else {
                Sessions.setStatus(session.id, result.stopped ? 'stopped' : 'idle', result.error || null);
                resolve(result);
            }
        };

        const abortHandler = () => stopTurn(chatId, { reason: signal.reason || 'aborted' });
        if (signal?.aborted) abortHandler();
        else signal?.addEventListener('abort', abortHandler, { once: true });

        const dispatchLine = line => {
            const trimmed = String(line || '').trim();
            if (!trimmed) return;
            let event;
            try { event = JSON.parse(trimmed); }
            catch (_) { onEvent({ type: 'diagnostic', text: trimmed.slice(0, 500) }); return; }
            if (!event || typeof event !== 'object') return;
            if (event.sessionID) turn.engineSessionId = String(event.sessionID);

            if (event.type === 'step_start') {
                if (!turn.started) {
                    turn.started = true;
                    onEvent({
                        type: 'started',
                        sessionId: turn.engineSessionId,
                        modelId: model.id,
                        engineModel
                    });
                }
                return;
            }

            if (event.type === 'text') {
                const part = event.part || {};
                const text = String(part.text || '');
                if (!text) return;
                const partId = String(part.id || '');
                if (partId) {
                    turn.textParts.set(partId, text);
                    turn.accumulatedText = [...turn.textParts.values()].join('');
                } else {
                    turn.accumulatedText += text;
                }
                onEvent({ type: 'text_delta', text, accumulatedText: turn.accumulatedText });
                return;
            }

            if (event.type === 'tool_use') {
                const part = event.part || {};
                const state = part.state || {};
                const toolName = String(part.tool || 'unknown');
                const input = state.input && typeof state.input === 'object' ? state.input : {};
                const partKey = String(part.id || part.partID || `${toolName}:${turn.toolCallTotal + 1}`);
                if (!turn.toolSeen.has(partKey)) {
                    turn.toolSeen.add(partKey);
                    const count = (turn.toolCounts.get(toolName) || 0) + 1;
                    turn.toolCounts.set(toolName, count);
                    turn.toolCallTotal += 1;
                    onEvent({
                        type: 'tool_started',
                        toolName,
                        input,
                        count,
                        iteration: turn.toolCallTotal,
                        repeatCount: null
                    });
                }
                if (state.status === 'running' || state.status === 'pending') return;
                const exit = Number(state.metadata?.metadata?.exit);
                const isError = state.status === 'error' || (Number.isFinite(exit) && exit !== 0);
                const start = Number(state.time?.start);
                const end = Number(state.time?.end);
                onEvent({
                    type: 'tool_completed',
                    toolName,
                    output: String(state.output ?? ''),
                    isError,
                    durationMs: Number.isFinite(start) && Number.isFinite(end) ? end - start : null
                });
                return;
            }

            if (event.type === 'step_finish') {
                const tokens = event.part?.tokens || {};
                turn.tokens.input += Number(tokens.input) || 0;
                turn.tokens.output += Number(tokens.output) || 0;
                turn.tokens.reasoning += Number(tokens.reasoning) || 0;
                return;
            }

            if (event.type === 'error') {
                turn.error = event.error && typeof event.error === 'object'
                    ? event.error
                    : { type: 'unknown', message: String(event.error || 'OpenCode error') };
                onEvent({
                    type: 'diagnostic',
                    text: `OpenCode error: ${turn.error.message || turn.error.type || 'unknown'}`
                });
            }
        };

        child.stdout.on('data', chunk => {
            turn.buffer += chunk.toString('utf8');
            const lines = turn.buffer.split('\n');
            turn.buffer = lines.pop() || '';
            for (const line of lines) dispatchLine(line);
        });

        child.stderr.on('data', chunk => {
            const text = chunk.toString('utf8');
            stderr += text;
            if (stderr.length > 12000) stderr = stderr.slice(-12000);
            onEvent({ type: 'diagnostic', text: text.slice(0, 400) });
        });

        child.stdin.on('error', () => {});
        child.stdin.end(String(prompt));

        child.on('error', err => finish(err));
        child.on('close', (code, exitSignal) => {
            if (turn.buffer.trim()) dispatchLine(turn.buffer);
            const stoppedByRequest = stopRequests.delete(turn.turnId);
            const aborted = turn.error?.type === 'aborted';
            const stopped = stoppedByRequest || Boolean(exitSignal) || aborted;
            const finalText = turn.accumulatedText;
            const result = {
                stopped,
                timedOut: false,
                reason: turn.reason,
                exitCode: code,
                signal: exitSignal,
                text: finalText,
                sessionId: turn.engineSessionId,
                tokens: turn.tokens,
                error: stopped ? null : (turn.error?.message || (code && !finalText ? stderr.slice(-1000) : null))
            };
            if (turn.engineSessionId) {
                try { Sessions.bindEngineSession(session.id, turn.engineSessionId, model.id); }
                catch (err) { console.error('[NOPPO SESSION BIND]', err.message); }
            }
            if (stopped) return finish(null, result);
            if (code !== 0 && !finalText) return finish(new Error(result.error || `OpenCode exit ${code}`));
            return finish(null, result);
        });
    });
}

module.exports = {
    runTurn,
    stopTurn,
    status,
    isAvailable,
    hasProviderKey,
    getProviderKey,
    binaryPath
};
