'use strict';

const MODEL_REGISTRY = Object.freeze({
    'cx/gpt-6-luna[1m]': Object.freeze({
        id: 'cx/gpt-6-luna[1m]',
        name: 'GPT Luna 6 1M',
        provider: 'custom',
        contextWindow: 872000,
        maxInputTokens: 744000,
        maxOutputTokens: 128000,
        limitsSource: '9Router /v1/models: context_length=872000, max_completion_tokens=128000',
        supportsImage: null
    }),
    'dco/deepseek-ai/DeepSeek-V4.1-Flash-1017': Object.freeze({
        id: 'dco/deepseek-ai/DeepSeek-V4.1-Flash-1017',
        name: 'DeepSeek V4.1 Flash 1017',
        provider: 'custom',
        contextWindow: 256000,
        maxInputTokens: 256000,
        maxOutputTokens: null,
        limitsSource: 'Context window requested by user; output limit not yet verified from 9Router /v1/models',
        supportsImage: true,
        supportsImageSource: 'Verified 2026-11-10: POST /v1/chat/completions with image_url returned HTTP 200 and read a test image correctly'
    }),
    're/opencode/hy4-flash-free': Object.freeze({
        id: 're/opencode/hy4-flash-free',
        name: 'HY4 Flash Free 1M',
        provider: 'custom',
        contextWindow: 1000000,
        maxInputTokens: 1000000,
        maxOutputTokens: 64000,
        limitsSource: 'Context window 1m requested by user; 9Router /v1/models: max_completion_tokens=64000',
        supportsImage: false
    })
});

const DEFAULT_MODEL_ID = 'dco/deepseek-ai/DeepSeek-V4.1-Flash-1017';

const NOPPO_CONFIG = Object.freeze({
    defaultModelId: DEFAULT_MODEL_ID,
    models: MODEL_REGISTRY,
    provider: Object.freeze({
        name: 'custom',
        baseUrl: process.env.NOPPO_ROUTER_URL || 'https://9router.stenly.id/v1',
        apiKeyEnv: 'NOPPO_ROUTER_API_KEY',
        credentialsFile: process.env.NOPPO_CREDENTIALS_FILE || '/root/.hermes/noppo.env'
    }),
    execution: Object.freeze({
        toolStatusPreviewChars: 120,
        maxQueuedFollowupsPerChat: 8,
        streamEditIntervalMs: 900,
        streamMessageLimit: 3000,
        allowOwnerRootTools: true,
        hermesBinary: '/usr/bin/hermes',
        workingDirectory: '/root'
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

module.exports = { NOPPO_CONFIG, MODEL_REGISTRY, DEFAULT_MODEL_ID, getModel };
