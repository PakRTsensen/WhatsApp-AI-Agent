'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { NOPPO_CONFIG } = require('./noppo_config');

const STORE_PATH = process.env.NOPPO_SESSION_STORE || path.join(__dirname, 'database', 'noppo_sessions.json');
const STORE_VERSION = 1;

function emptyStore() {
    return { version: STORE_VERSION, enabled: false, defaultModelId: null, activeByChat: {}, preferredModelByChat: {}, imageModels: [], sessions: {} };
}

function readStore() {
    try {
        const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || parsed.version !== STORE_VERSION ||
            !parsed.activeByChat || typeof parsed.activeByChat !== 'object' ||
            !parsed.sessions || typeof parsed.sessions !== 'object') return emptyStore();
        parsed.preferredModelByChat ||= {};
        if (!Array.isArray(parsed.imageModels)) parsed.imageModels = [];
        return parsed;
    } catch (error) {
        if (error.code !== 'ENOENT') console.error('[NOPPO SESSIONS] Read failed:', error.message);
        return emptyStore();
    }
}

function isEnabled() {
    return readStore().enabled === true;
}

function setEnabled(enabled) {
    const store = readStore();
    store.enabled = Boolean(enabled);
    writeStore(store);
    return store.enabled;
}

function writeStore(store) {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    const tempPath = `${STORE_PATH}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
    try {
        fs.writeFileSync(tempPath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
        fs.renameSync(tempPath, STORE_PATH);
        try { fs.chmodSync(STORE_PATH, 0o600); } catch (_) {}
    } catch (error) {
        try { fs.unlinkSync(tempPath); } catch (_) {}
        throw error;
    }
}

function createSession(chatId, { modelId, title = '', hermesSessionId = null, origin = 'manual' } = {}) {
    if (!chatId) throw new TypeError('chatId is required');
    const store = readStore();
    const chatKey = String(chatId);
    const selectedModel = modelId || store.preferredModelByChat[chatKey] || store.defaultModelId || NOPPO_CONFIG.defaultModelId;
    const id = `noppo-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const row = {
        id,
        chatId: chatKey,
        hermesSessionId: hermesSessionId || null,
        modelId: selectedModel,
        launchPolicy: {
            maxTurns: 0,
            yolo: NOPPO_CONFIG.execution.allowOwnerRootTools,
            checkpoints: true
        },
        title: String(title).slice(0, 160),
        origin: origin === 'auto' ? 'auto' : 'manual',
        status: 'new',
        createdAt: now,
        updatedAt: now,
        lastTurnAt: null,
        turnCount: 0,
        lastError: null
    };
    store.sessions[id] = row;
    store.activeByChat[String(chatId)] = id;
    writeStore(store);
    return { ...row };
}

function getSession(id) {
    if (!id) return null;
    const row = readStore().sessions[String(id)];
    return row ? { ...row } : null;
}

function getActiveSession(chatId) {
    const store = readStore();
    const id = store.activeByChat[String(chatId)];
    const row = id && store.sessions[id];
    return row ? { ...row } : null;
}



function ensureActiveSession(chatId, { modelId, title = '', origin = 'auto' } = {}) {
    const existing = getActiveSession(chatId);
    if (existing) return { session: existing, created: false };
    const session = createSession(chatId, {
        modelId: modelId || getPreferredModel(chatId),
        title,
        origin
    });
    return { session, created: true };
}

function activateSession(chatId, id) {
    const store = readStore();
    const row = store.sessions[String(id)];
    if (!row) return null;
    for (const [ownerChat, activeId] of Object.entries(store.activeByChat)) {
        if (activeId === row.id && ownerChat !== String(chatId)) delete store.activeByChat[ownerChat];
    }
    row.chatId = String(chatId);
    row.updatedAt = new Date().toISOString();
    store.activeByChat[String(chatId)] = row.id;
    writeStore(store);
    return { ...row };
}

function clearActiveSession(chatId) {
    const store = readStore();
    const previousId = store.activeByChat[String(chatId)] || null;
    delete store.activeByChat[String(chatId)];
    if (previousId && store.sessions[previousId]) {
        store.sessions[previousId].status = 'inactive';
        store.sessions[previousId].updatedAt = new Date().toISOString();
    }
    writeStore(store);
    return previousId;
}

function bindHermesSession(id, hermesSessionId, modelId) {
    const store = readStore();
    const row = store.sessions[String(id)];
    if (!row) return null;
    if (hermesSessionId) row.hermesSessionId = String(hermesSessionId);
    if (modelId) row.modelId = String(modelId);
    row.status = 'idle';
    row.lastTurnAt = new Date().toISOString();
    row.updatedAt = row.lastTurnAt;
    row.turnCount += 1;
    row.lastError = null;
    writeStore(store);
    return { ...row };
}

function setSessionModel(id, modelId) {
    const store = readStore();
    const row = store.sessions[String(id)];
    if (!row) return null;
    row.modelId = String(modelId);
    store.preferredModelByChat[row.chatId] = String(modelId);
    row.updatedAt = new Date().toISOString();
    writeStore(store);
    return { ...row };
}

function getPreferredModel(chatId) {
    const store = readStore();
    return store.preferredModelByChat[String(chatId)] || store.defaultModelId || NOPPO_CONFIG.defaultModelId;
}

function getDefaultModel() {
    const store = readStore();
    return store.defaultModelId || NOPPO_CONFIG.defaultModelId;
}

function setDefaultModel(modelId) {
    const selected = String(modelId);
    if (!NOPPO_CONFIG.models[selected]) throw new TypeError(`Unknown Noppo model: ${selected}`);
    const store = readStore();
    store.defaultModelId = selected;
    writeStore(store);
    return selected;
}

function setUniversalModel(modelId) {
    const selected = String(modelId);
    if (!NOPPO_CONFIG.models[selected]) throw new TypeError(`Unknown Noppo model: ${selected}`);
    const store = readStore();
    store.defaultModelId = selected;
    let sessionCount = 0;
    for (const session of Object.values(store.sessions || {})) {
        session.modelId = selected;
        session.updatedAt = new Date().toISOString();
        sessionCount++;
    }
    const chatIds = Object.keys(store.preferredModelByChat || {});
    for (const chatId of chatIds) {
        store.preferredModelByChat[chatId] = selected;
    }
    writeStore(store);
    return {
        modelId: selected,
        sessionCount,
        chatCount: chatIds.length
    };
}

function setPreferredModel(chatId, modelId) {
    const selected = String(modelId);
    if (!NOPPO_CONFIG.models[selected]) throw new TypeError(`Unknown Noppo model: ${selected}`);
    const store = readStore();
    store.preferredModelByChat[String(chatId)] = selected;
    writeStore(store);
    return selected;
}

function listImageModels() {
    return [...(readStore().imageModels || [])];
}

function isImageModelEnabled(modelId) {
    return (readStore().imageModels || []).includes(String(modelId));
}

function setImageModelEnabled(modelId, enabled) {
    const id = String(modelId);
    const model = NOPPO_CONFIG.models[id];
    if (!model) throw new TypeError(`Unknown Noppo model: ${id}`);
    if (enabled && model.supportsImage !== true) {
        throw new TypeError(`Model ${id} belum terverifikasi mendukung gambar.`);
    }
    const store = readStore();
    const models = new Set(store.imageModels || []);
    if (enabled) models.add(id); else models.delete(id);
    store.imageModels = [...models];
    writeStore(store);
    return store.imageModels.includes(id);
}

function setStatus(id, status, error = null) {
    const allowed = new Set(['new', 'queued', 'running', 'idle', 'stopped', 'error']);
    if (!allowed.has(status)) throw new TypeError(`Invalid Noppo session status: ${status}`);
    const store = readStore();
    const row = store.sessions[String(id)];
    if (!row) return null;
    row.status = status;
    row.updatedAt = new Date().toISOString();
    row.lastError = error ? String(error).slice(0, 500) : null;
    writeStore(store);
    return { ...row };
}

function listSessions(chatId = null) {
    const store = readStore();
    return Object.values(store.sessions)
        .filter(row => chatId === null || row.chatId === String(chatId))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(row => ({ ...row, active: store.activeByChat[row.chatId] === row.id }));
}

function deleteSession(id) {
    const store = readStore();
    const key = String(id);
    if (!store.sessions[key]) return false;
    delete store.sessions[key];
    for (const [chatId, activeId] of Object.entries(store.activeByChat)) {
        if (activeId === key) delete store.activeByChat[chatId];
    }
    writeStore(store);
    return true;
}

module.exports = {
    STORE_PATH,
    isEnabled,
    setEnabled,
    createSession,
    getSession,
    getActiveSession,
    ensureActiveSession,
    activateSession,
    clearActiveSession,
    bindHermesSession,
    setSessionModel,
    getPreferredModel,
    setPreferredModel,
    getDefaultModel,
    setDefaultModel,
    setUniversalModel,
    listImageModels,
    isImageModelEnabled,
    setImageModelEnabled,
    setStatus,
    listSessions,
    deleteSession
};
