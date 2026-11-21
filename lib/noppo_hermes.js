'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { NOPPO_CONFIG, getModel } = require('./noppo_config');
const Sessions = require('./noppo_sessions');

const activeTurns = new Map();
const stopRequests = new Set();

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
function hasProviderKey() { return Boolean(getProviderKey()); }

function signalProcessGroup(child, signal) {
    if (!child?.pid) return;
    try { process.kill(-child.pid, signal); }
    catch (_) { try { child.kill(signal); } catch (_) {} }
}

function stopTurn(chatId, { force = false, reason = 'owner_stop' } = {}) {
    const active = activeTurns.get(String(chatId));
    if (!active) return { stopped: false, reason: 'not_running' };
    active.reason = reason;
    stopRequests.add(active.turnId);
    signalProcessGroup(active.child, force ? 'SIGKILL' : 'SIGTERM');
    if (force) {
        active.forceTimer = null;
    } else if (!active.forceTimer) {
        active.forceTimer = setTimeout(() => {
            if (activeTurns.get(String(chatId)) === active) signalProcessGroup(active.child, 'SIGKILL');
        }, 4000);
        active.forceTimer.unref?.();
    }
    return { stopped: true, forced: force, turnId: active.turnId };
}

function status(chatId) {
    const row = activeTurns.get(String(chatId));
    if (!row) return { running: false };
    return { running: true, turnId: row.turnId, sessionId: row.sessionId, modelId: row.model.id, startedAt: row.startedAt };
}

function runTurn({ chatId, prompt, session, modelId, signal, onEvent = () => {}, cwd }) {
    chatId = String(chatId);
    if (activeTurns.has(chatId)) return Promise.reject(new Error('Turn Noppo masih berjalan untuk chat ini.'));
    if (!session?.id) return Promise.reject(new TypeError('Noppo session metadata is required.'));

    const model = getModel(modelId || session.modelId || NOPPO_CONFIG.defaultModelId);
    if (!model) return Promise.reject(new Error(`Model Noppo tidak terdaftar: ${modelId || session.modelId}`));
    const apiKey = getProviderKey();
    if (!apiKey) return Promise.reject(new Error('NOPPO_ROUTER_API_KEY belum dikonfigurasi. Isi environment lalu restart bot.'));
    const baseUrl = process.env.NOPPO_ROUTER_URL || NOPPO_CONFIG.provider.baseUrl;
    const launchPolicy = session.launchPolicy || {
        maxTurns: 0,
        yolo: NOPPO_CONFIG.execution.allowOwnerRootTools,
        checkpoints: true
    };
    const queryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noppo-query-'));
    const queryPath = path.join(queryDir, 'prompt.txt');
    fs.writeFileSync(queryPath, String(prompt), { mode: 0o600 });
    const args = [
        'chat', '--query-file', queryPath,
        '--format', 'stream-json',
        '--provider', model.provider,
        '-m', model.id,
        '--base-url', baseUrl,
        ...(!session.hermesSessionId ? [
            '--max-turns', String(launchPolicy.maxTurns ?? 0),
            ...(launchPolicy.checkpoints ? ['--checkpoints'] : []),
            ...(launchPolicy.yolo ? ['--yolo'] : [])
        ] : [])
    ];
    if (session.hermesSessionId) args.push('--resume', session.hermesSessionId);

    const child = spawn(process.env.NOPPO_TEST_HERMES_BINARY || NOPPO_CONFIG.execution.hermesBinary, args, {
        cwd: cwd || NOPPO_CONFIG.execution.workingDirectory,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, OPENAI_BASE_URL: baseUrl, OPENAI_API_KEY: apiKey }
    });
    const turn = {
        turnId: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        child,
        sessionId: session.id,
        model,
        startedAt: Date.now(),
        buffer: '',
        accumulatedText: '',
        finalText: '',
        hermesSessionId: session.hermesSessionId || null,
        toolCounts: new Map(),
        toolCallTotal: 0,
        timedOut: false,
        reason: null,
        forceTimer: null,
        timeout: null
    };
    activeTurns.set(chatId, turn);
    Sessions.setStatus(session.id, 'running');

    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, result) => {
            if (settled) return;
            settled = true;
            clearTimeout(turn.timeout);
            clearTimeout(turn.forceTimer);
            try { fs.unlinkSync(queryPath); } catch (_) {}
            try { fs.rmdirSync(queryDir); } catch (_) {}
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
            if (event.type === 'system' && event.session_id) turn.hermesSessionId = event.session_id;
            if (event.type === 'text') {
                turn.accumulatedText += String(event.text || '');
                onEvent({ type: 'text_delta', text: String(event.text || ''), accumulatedText: turn.accumulatedText });
            } else if (event.type === 'tool_use') {
                const toolName = String(event.name || 'unknown');
                const count = (turn.toolCounts.get(toolName) || 0) + 1;
                turn.toolCounts.set(toolName, count);
                turn.toolCallTotal += 1;
                const input = event.input && typeof event.input === 'object' ? event.input : {};
                onEvent({ type: 'tool_started', toolName, input, count, iteration: turn.toolCallTotal, repeatCount: null });
            } else if (event.type === 'tool_result') {
                onEvent({ type: 'tool_completed', toolName: String(event.name || 'unknown'), output: String(event.output || ''), isError: Boolean(event.is_error), durationMs: Number(event.duration_ms) || null });
            } else if (event.type === 'result') {
                turn.hermesSessionId = event.session_id || turn.hermesSessionId;
                turn.finalText = String(event.text || turn.accumulatedText || '');
                onEvent({ type: 'result', text: turn.finalText, exitCode: Number(event.exit_code) || 0, error: event.error || null, tokens: event.tokens || null });
            } else if (event.type === 'system') {
                onEvent({ type: 'started', sessionId: turn.hermesSessionId, modelId: model.id });
            }
        };

        child.stdout.on('data', chunk => {
            turn.buffer += chunk.toString('utf8');
            const lines = turn.buffer.split('\n');
            turn.buffer = lines.pop() || '';
            for (const line of lines) dispatchLine(line);
        });
        let stderr = '';
        child.stderr.on('data', chunk => {
            stderr += chunk.toString('utf8');
            if (stderr.length > 12000) stderr = stderr.slice(-12000);
            const match = stderr.match(/(?:Session:|session_id:)\s*([a-zA-Z0-9_-]+)/);
            if (match) turn.hermesSessionId = match[1];
            onEvent({ type: 'diagnostic', text: chunk.toString('utf8').slice(0, 400) });
        });
        child.on('error', err => finish(err));
        child.on('close', (code, exitSignal) => {
            if (turn.buffer.trim()) dispatchLine(turn.buffer);
            const stopped = stopRequests.delete(turn.turnId) || Boolean(exitSignal);
            const timedOut = turn.timedOut;
            const finalText = turn.finalText || turn.accumulatedText;
            const result = {
                stopped: stopped || timedOut,
                timedOut,
                reason: turn.reason,
                exitCode: code,
                signal: exitSignal,
                text: finalText,
                sessionId: turn.hermesSessionId,
                error: timedOut ? 'Batas waktu Noppo tercapai.' : (code && !stopped ? stderr.slice(-1000) : null)
            };
            if (turn.hermesSessionId) {
                try { Sessions.bindHermesSession(session.id, turn.hermesSessionId, model.id); }
                catch (err) { console.error('[NOPPO SESSION BIND]', err.message); }
            }
            if (timedOut) return finish(null, result);
            if (stopped) return finish(null, result);
            if (code !== 0 && !finalText) return finish(new Error(result.error || `Hermes exit ${code}`));
            return finish(null, result);
        });
    });
}

module.exports = { runTurn, stopTurn, status, hasProviderKey, getProviderKey };
