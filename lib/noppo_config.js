'use strict';

const path = require('path');

const ROOT = path.join(__dirname, '..');

const MODEL_REGISTRY = Object.freeze({
    'cx/gpt-6-luna[1m]': Object.freeze({
        id: 'cx/gpt-6-luna[1m]',
        name: 'GPT Luna 6 1M',
        provider: 'opencode',
        engineModel: 'ca/gpt-6-luna',
        contextWindow: 1050000,
        maxInputTokens: 1050000,
        maxOutputTokens: 128000,
        limitsSource: 'OpenCode provider 9router /v1/models: contextWindow=1050000, maxOutput=128000',
        supportsImage: true,
        supportsImageSource: 'OpenCode provider 9router /v1/models capabilities: vision=true'
    }),
    'dco/deepseek-ai/DeepSeek-V4.1-Flash-1017': Object.freeze({
        id: 'dco/deepseek-ai/DeepSeek-V4.1-Flash-1017',
        name: 'DeepSeek V4.1 Flash 1017',
        provider: 'opencode',
        engineModel: 'ca/deepseek-v4-1-flash-1017',
        contextWindow: 1000000,
        maxInputTokens: 1000000,
        maxOutputTokens: 384000,
        limitsSource: 'OpenCode provider 9router /v1/models: contextWindow=1000000, maxOutput=384000',
        supportsImage: false,
        supportsImageSource: 'OpenCode provider 9router /v1/models capabilities: vision=false'
    }),
    're/opencode/hy4-flash-free': Object.freeze({
        id: 're/opencode/hy4-flash-free',
        name: 'HY4 Flash Free 1M',
        provider: 'opencode',
        engineModel: 'ca/hy4',
        contextWindow: 200000,
        maxInputTokens: 200000,
        maxOutputTokens: 64000,
        limitsSource: 'OpenCode provider 9router /v1/models: contextWindow=200000, maxOutput=64000',
        supportsImage: false,
        supportsImageSource: 'OpenCode provider 9router /v1/models capabilities: vision=false'
    })
});

const DEFAULT_MODEL_ID = 'dco/deepseek-ai/DeepSeek-V4.1-Flash-1017';

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
        engineProvider: process.env.NOPPO_ENGINE_PROVIDER || '9router',
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

function getModel(modelId = DEFAULT_MODEL_ID) {
    return MODEL_REGISTRY[modelId] || null;
}

function getEngineModel(modelOrId = DEFAULT_MODEL_ID) {
    const model = typeof modelOrId === 'string' ? getModel(modelOrId) : modelOrId;
    if (!model) return null;
    return `${NOPPO_CONFIG.execution.engineProvider}/${model.engineModel || model.id}`;
}

module.exports = { NOPPO_CONFIG, MODEL_REGISTRY, DEFAULT_MODEL_ID, getModel, getEngineModel, ROOT };
