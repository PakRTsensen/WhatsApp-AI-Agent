'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DEFAULT_MODEL_ID = '9router/ca/deepseek-v4-1-flash-1017#max';
const DEFAULT_MODEL_BASE_ID = '9router/ca/deepseek-v4-1-flash-1017';

// These IDs were stored by older Noppo releases. Keep them only as a data
// migration path; new choices and OpenCode invocations use canonical IDs.
const LEGACY_MODEL_MIGRATIONS = Object.freeze({
    'cx/gpt-6-luna[1m]': '9router/ca/gpt-6-luna',
    'dco/deepseek-ai/DeepSeek-V4.1-Flash-1017': DEFAULT_MODEL_ID,
    're/opencode/hy4-flash-free': '9router/ca/hy4'
});

const MODEL_REGISTRY = Object.freeze({
    '9router/ca/gpt-6-luna': Object.freeze({
        id: '9router/ca/gpt-6-luna',
        name: 'GPT Luna 6 1M',
        provider: '9router',
        engineModel: '9router/ca/gpt-6-luna',
        apiModelId: 'ca/gpt-6-luna',
        variants: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
        contextWindow: 1050000,
        maxInputTokens: 1050000,
        maxOutputTokens: 128000,
        supportsImage: true,
        supportsImageSource: '9Router /v1/models'
    }),
    [DEFAULT_MODEL_ID]: Object.freeze({
        id: DEFAULT_MODEL_ID,
        name: 'DeepSeek V4.1 Flash 1017',
        provider: '9router',
        engineModel: DEFAULT_MODEL_BASE_ID,
        apiModelId: 'ca/deepseek-v4-1-flash-1017',
        defaultVariant: 'max',
        variants: ['none', 'high', 'max'],
        contextWindow: 1000000,
        maxInputTokens: 1000000,
        maxOutputTokens: 384000,
        supportsImage: false,
        supportsImageSource: '9Router /v1/models'
    }),
    '9router/ca/hy4': Object.freeze({
        id: '9router/ca/hy4',
        name: 'HY4 Flash Free 1M',
        provider: '9router',
        engineModel: '9router/ca/hy4',
        apiModelId: 'ca/hy4',
        variants: [],
        contextWindow: 200000,
        maxInputTokens: 200000,
        maxOutputTokens: 64000,
        supportsImage: false,
        supportsImageSource: '9Router /v1/models'
    })
});

const NOPPO_CONFIG = Object.freeze({
    defaultModelId: DEFAULT_MODEL_ID,
    models: MODEL_REGISTRY,
    provider: Object.freeze({
        name: 'openai-compatible',
        baseUrl: process.env.NOPPO_ROUTER_URL || 'https://9router.stenly.id/v1',
        apiKeyEnv: 'NOPPO_ROUTER_API_KEY',
        credentialsFile: process.env.NOPPO_CREDENTIALS_FILE || path.join(ROOT, 'control', 'noppo.env')
    }),
    execution: Object.freeze({
        toolStatusPreviewChars: 120,
        maxQueuedFollowupsPerChat: 8,
        streamEditIntervalMs: 900,
        streamMessageLimit: 3000,
        opencodeBinary: process.env.NOPPO_OPENCODE_BINARY || 'opencode',
        workingDirectory: process.env.NOPPO_WORKDIR || ROOT,
        agent: process.env.NOPPO_AGENT || 'noppo',
        stopGraceMs: 1500,
        stopForceMs: 6000,
        interruptTimeoutMs: 8000
    }),
    image: Object.freeze({
        maxBytes: 8 * 1024 * 1024,
        maxImages: 4,
        timeoutMs: 60000,
        maxTokens: 900
    })
});

let modelCache = null;
let modelCacheAt = 0;
const MODEL_CACHE_MS = 15000;

function normalizeModelId(modelId) {
    const id = String(modelId || '').trim();
    return LEGACY_MODEL_MIGRATIONS[id] || id;
}

function parseModelReference(modelId) {
    const id = normalizeModelId(modelId);
    const hash = id.indexOf('#');
    const baseId = hash < 0 ? id : id.slice(0, hash);
    const variant = hash < 0 ? null : id.slice(hash + 1);
    const slash = baseId.indexOf('/');
    if (slash <= 0 || slash === baseId.length - 1 || baseId.includes('//')) return null;
    if (variant !== null && (!variant || variant.includes('#'))) return null;
    if (/\s/.test(id)) return null;
    return { id, baseId, providerID: baseId.slice(0, slash), modelID: baseId.slice(slash + 1), variant };
}

function queryOpenCodeModels() {
    const raw = execFileSync(process.env.NOPPO_OPENCODE_BINARY || NOPPO_CONFIG.execution.opencodeBinary,
        ['api', 'get', '/api/model'], {
            cwd: process.env.NOPPO_OPENCODE_CWD || NOPPO_CONFIG.execution.workingDirectory,
            encoding: 'utf8',
            timeout: 20000,
            maxBuffer: 10 * 1024 * 1024,
            env: process.env
        });
    const response = JSON.parse(raw);
    if (!Array.isArray(response.data)) throw new TypeError('OpenCode returned an invalid model catalogue.');
    return response.data;
}

function modelFromCatalogItem(item, variant = null) {
    const baseId = `${item.providerID}/${item.modelID}`;
    const variants = Array.isArray(item.variants) ? item.variants.map(value => String(value.id || '')).filter(Boolean) : [];
    const configuredVariant = baseId === DEFAULT_MODEL_BASE_ID && variants.includes('max') ? 'max' : null;
    const selectedVariant = variant || configuredVariant;
    const input = Array.isArray(item.capabilities?.input) ? item.capabilities.input : ['text'];
    const contextWindow = Number(item.limit?.context) || 200000;
    return Object.freeze({
        id: selectedVariant ? `${baseId}#${selectedVariant}` : baseId,
        name: String(item.name || item.modelID),
        provider: String(item.providerID),
        engineModel: baseId,
        apiModelId: item.providerID === '9router' ? String(item.modelID) : null,
        defaultVariant: selectedVariant,
        catalogDefaultVariant: configuredVariant,
        variants,
        contextWindow,
        maxInputTokens: contextWindow,
        maxOutputTokens: Number(item.limit?.output) || null,
        // Noppo's image-analysis adapter talks directly to 9Router's OpenAI API.
        supportsImage: item.providerID === '9router' ? input.includes('image') : false,
        supportsImageSource: item.providerID === '9router' ? '9Router /v1/models' : 'Vision adapter saat ini hanya memakai API 9Router'
    });
}

function listModels({ provider = 'all', query = '' } = {}) {
    const now = Date.now();
    if (!modelCache || now - modelCacheAt > MODEL_CACHE_MS) {
        modelCache = queryOpenCodeModels()
            .filter(item => item && item.providerID && item.modelID && item.enabled !== false && item.status !== 'disabled')
            .map(item => modelFromCatalogItem(item));
        modelCacheAt = now;
    }
    const search = String(query || '').trim().toLowerCase();
    const filtered = modelCache
        .filter(model => provider === 'all' || model.provider === provider)
        .filter(model => !search || `${model.name} ${model.id} ${model.provider}`.toLowerCase().includes(search));
    const unique = new Map();
    for (const model of filtered) {
        if (!unique.has(model.engineModel) || model.catalogDefaultVariant) unique.set(model.engineModel, model);
    }
    return [...unique.values()];
}

function getModel(modelId = DEFAULT_MODEL_ID) {
    const id = normalizeModelId(modelId);
    if (MODEL_REGISTRY[id]) return MODEL_REGISTRY[id];
    const reference = parseModelReference(id);
    if (!reference) return null;
    try {
        const item = listModels().find(model => model.engineModel === reference.baseId && model.provider === reference.providerID);
        if (!item) return null;
        if (reference.variant && !item.variants.includes(reference.variant)) return null;
        return Object.freeze({ ...item, id, defaultVariant: reference.variant || item.defaultVariant });
    } catch (error) {
        return null;
    }
}

function getEngineModel(modelOrId = DEFAULT_MODEL_ID) {
    if (typeof modelOrId === 'string') {
        const normalized = normalizeModelId(modelOrId);
        if (LEGACY_MODEL_MIGRATIONS[modelOrId] || MODEL_REGISTRY[normalized]) {
            const configured = MODEL_REGISTRY[normalized];
            const base = configured.engineModel || configured.id;
            return configured.defaultVariant ? `${base}#${configured.defaultVariant}` : base;
        }
        const directReference = parseModelReference(normalized);
        if (directReference && directReference.variant) return directReference.id;
    }
    const model = typeof modelOrId === 'string' ? getModel(modelOrId) : modelOrId;
    if (!model) return null;
    const id = normalizeModelId(model.id || model.engineModel || '');
    if (id.includes('#')) return id;
    const base = model.engineModel || id;
    const variant = model.defaultVariant;
    return variant ? `${base}#${variant}` : base;
}

function findSelectableModel(modelId, models = getSelectableModels()) {
    const reference = parseModelReference(modelId);
    if (!reference) return null;
    const found = models.find(model => model.engineModel === reference.baseId || model.id === reference.id);
    if (!found) return null;
    if (reference.variant) {
        if (!found.variants.includes(reference.variant)) return null;
        return Object.freeze({ ...found, id: reference.id, defaultVariant: reference.variant });
    }
    if (found.id.includes('#')) {
        return Object.freeze({ ...found, id: reference.baseId, defaultVariant: null });
    }
    return found;
}

function getSelectableModels(options = {}) {
    try {
        const models = listModels(options);
        const defaultBase = DEFAULT_MODEL_ID.split('#')[0];
        if (options.provider === undefined || options.provider === 'all' || options.provider === '9router') {
            const defaultIndex = models.findIndex(model => model.engineModel === defaultBase);
            if (defaultIndex >= 0) models.splice(defaultIndex, 1, MODEL_REGISTRY[DEFAULT_MODEL_ID]);
        }
        const unique = new Map();
        for (const model of models) {
            const key = model.engineModel;
            if (!unique.has(key) || model.catalogDefaultVariant) unique.set(key, model);
        }
        return [...unique.values()];
    } catch (error) {
        console.error('[NOPPO MODELS] OpenCode model catalogue unavailable:', error.message);
        return [];
    }
}

module.exports = {
    NOPPO_CONFIG,
    MODEL_REGISTRY,
    DEFAULT_MODEL_ID,
    LEGACY_MODEL_MIGRATIONS,
    normalizeModelId,
    getModel,
    getEngineModel,
    listModels,
    findSelectableModel,
    getSelectableModels,
    ROOT
};
