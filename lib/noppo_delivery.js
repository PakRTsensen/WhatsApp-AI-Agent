'use strict';

const { NOPPO_CONFIG } = require('./noppo_config');
const { normalizeMessageContent, getContentType } = require('@itsliaaa/baileys');

function safeQuoted(value) {
    if (!value || typeof value !== 'object' || !value.key) return null;
    if (!value.message) return null;
    try {
        const inner = normalizeMessageContent(value.message);
        if (!inner || !getContentType(inner)) return null;
    } catch (_) {
        return null;
    }
    return value;
}

function quotedFailure(error) {
    return /reading 'undefined'|Cannot use 'in' operator/.test(String(error?.message || ''));
}

async function sendWithQuoted(sock, chat, content, quoted) {
    const target = safeQuoted(quoted);
    try {
        return await sock.sendMessage(chat, content, target ? { quoted: target } : undefined);
    } catch (error) {
        if (target && quotedFailure(error)) {
            console.error('[NOPPO QUOTED FALLBACK]', JSON.stringify({
                hasKey: !!quoted?.key,
                hasMessage: !!quoted?.message,
                mtype: quoted?.mtype || null,
                messageKeys: quoted?.message ? Object.keys(quoted.message) : null
            }));
            return sock.sendMessage(chat, content);
        }
        throw error;
    }
}

function makeWhatsAppRenderer({ sock, chat, quoted, onFailure = () => {}, makeFinalContent = null }) {
    let messageKey = null;
    let text = '';
    let revision = 0;
    let sentRevision = 0;
    let inFlight = Promise.resolve();
    let waiters = [];
    let busy = false;
    let dirty = false;
    let closed = false;
    let lastEditAt = 0;
    let timer = null;
    const minInterval = NOPPO_CONFIG.execution.streamEditIntervalMs;
    const maxChars = NOPPO_CONFIG.execution.streamMessageLimit;

    function clip(value) {
        const source = String(value || '');
        if (source.length <= maxChars) return source;
        return `${source.slice(0, maxChars - 24)}\n…(output dipotong)`;
    }

    function serialize() {
        dirty = true;
        if (busy) return inFlight;
        busy = true;
        inFlight = (async () => {
            try {
                while (dirty && !closed) {
                    dirty = false;
                    const targetRevision = revision;
                    const targetText = clip(text);
                    if (!targetText || targetRevision <= sentRevision) continue;
                    const wait = Math.max(0, minInterval - (Date.now() - lastEditAt));
                    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
                    if (closed) break;
                    if (!messageKey) {
                        const sent = await sendWithQuoted(sock, chat, { text: targetText }, quoted);
                        messageKey = sent?.key || null;
                        if (!messageKey) throw new Error('WhatsApp did not return the initial message key');
                    } else {
                        await sock.sendMessage(chat, { text: targetText, edit: messageKey });
                    }
                    sentRevision = targetRevision;
                    lastEditAt = Date.now();
                    if (revision > sentRevision) dirty = true;
                }
            } finally {
                busy = false;
            }
        })().catch(error => {
            onFailure(error);
            throw error;
        });
        inFlight = inFlight.finally(() => {
            const completed = waiters;
            waiters = [];
            for (const resolve of completed) resolve();
            if (dirty && !closed) void serialize();
        });
        return inFlight;
    }

    function update(value, { immediate = false } = {}) {
        if (closed) return Promise.resolve();
        text = String(value || '');
        revision += 1;
        if (makeFinalContent) return Promise.resolve();
        const waitForDrain = new Promise(resolve => waiters.push(resolve));
        if (timer) clearTimeout(timer);
        if (immediate || !messageKey) {
            serialize().catch(() => {});
            return waitForDrain;
        }
        timer = setTimeout(() => {
            timer = null;
            serialize().catch(() => {});
        }, Math.max(0, minInterval - (Date.now() - lastEditAt)));
        return waitForDrain;
    }

    async function finish(value) {
        if (value !== undefined && value !== null) {
            text = String(value);
            revision += 1;
        }
        if (timer) { clearTimeout(timer); timer = null; }
        // Do not emit a plain-text streaming message and then a second rich final
        // message. When a rich final payload is requested, send it exactly once.
        if (makeFinalContent) {
            closed = true;
            await inFlight.catch(() => {});
            const content = await makeFinalContent(clip(text));
            if (content?.relay) return content;
            const sent = await sendWithQuoted(sock, chat, content, quoted);
            messageKey = sent?.key || null;
            sentRevision = revision;
            return sent;
        }
        await update(text, { immediate: true });
        closed = true;
    }

    function fail(value) {
        return finish(value || 'Noppo gagal menyelesaikan turn.');
    }

    function cancel() {
        closed = true;
        if (timer) clearTimeout(timer);
        timer = null;
    }

    return {
        update,
        finish,
        fail,
        cancel,
        getMessageKey: () => messageKey,
        getText: () => text,
        flush: () => serialize()
    };
}

const TOOL_INPUT_DISPLAY_LIMIT = 2200;

function redactToolInput(value, key = '', depth = 0) {
    if (/(?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|password|passwd|secret|cookie)/i.test(key)) return '[REDACTED]';
    if (typeof value === 'string') {
        return value
            .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_KEY]')
            .replace(/\bBearer\s+[^\s"'`]+/gi, 'Bearer [REDACTED]');
    }
    if (depth >= 8) return '[MAX_DEPTH]';
    if (Array.isArray(value)) return value.map(item => redactToolInput(item, '', depth + 1));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactToolInput(v, k, depth + 1)]));
    }
    return value;
}

function toolStatus(event) {
    const name = String(event?.toolName || 'tool');
    const input = event?.input && typeof event.input === 'object' ? event.input : {};
    const safeInput = redactToolInput(input);
    const isShell = /terminal|shell|run_command|execute/i.test(name);
    const inline = value => `\`${String(value).replace(/`/g, "'").replace(/\s+/g, ' ').trim()}\``;
    const renderedInput = isShell && typeof safeInput.command === 'string'
        ? ` ${inline(safeInput.command)}${Object.keys(safeInput).some(key => key !== 'command') ? `\nParameter: ${inline(JSON.stringify(Object.fromEntries(Object.entries(safeInput).filter(([key]) => key !== 'command'))))}` : ''}`
        : ` ${inline(JSON.stringify(safeInput))}`;
    let rendered = renderedInput;
    const max = TOOL_INPUT_DISPLAY_LIMIT;
    const clipped = rendered.length > max;
    if (clipped) rendered = `${rendered.slice(0, max)}\n…[input dipotong; total ${rendered.length} karakter]`;
    return `Menjalankan "${name}" :${rendered}`;
}

function toolResultStatus(event) {
    const name = String(event?.toolName || 'tool');
    const output = redactToolInput(String(event?.output || ''), 'output').trim();
    const body = output || (event?.isError ? '(tanpa pesan error)' : '(output kosong)');
    const clipped = body.length > TOOL_INPUT_DISPLAY_LIMIT;
    const preview = clipped ? `${body.slice(0, TOOL_INPUT_DISPLAY_LIMIT)}\n…[output dipotong]` : body;
    return `${event?.isError ? 'Tool gagal' : 'Tool selesai'} "${name}" : ${inlineWhatsApp(preview)}`;
}

function inlineWhatsApp(value) {
    return `\`${String(value || '').replace(/`/g, "'").replace(/\s+/g, ' ').trim()}\``;
}

module.exports = { makeWhatsAppRenderer, sendWithQuoted, toolStatus, toolResultStatus, redactToolInput };
