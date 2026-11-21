'use strict';

const { NOPPO_CONFIG, getModel } = require('./noppo_config');

function instructionFor(prompt) {
    const base = 'Baca gambar yang dilampirkan. Jelaskan isi yang benar-benar terlihat, lalu jawab permintaan pengguna. Jika ada bagian yang tidak terbaca, sebutkan.';
    const request = String(prompt || '').trim();
    return request ? `${base}\n\nPermintaan pengguna: ${request}` : base;
}

async function analyzeImages({ images, prompt, modelId, apiKey, baseUrl, timeoutMs, maxTokens, fetchImpl } = {}) {
    if (!Array.isArray(images) || !images.length) return '';
    if (!apiKey) throw new Error('API key provider belum tersedia untuk analisis gambar.');
    const model = getModel(modelId);
    if (!model) throw new Error(`Model Noppo tidak terdaftar: ${modelId}`);
    if (model.supportsImage !== true) throw new Error(`Model ${model.id} tidak mendukung analisis gambar.`);

    const settings = NOPPO_CONFIG.image;
    const endpoint = `${String(baseUrl || NOPPO_CONFIG.provider.baseUrl).replace(/\/+$/, '')}/chat/completions`;
    const content = [
        { type: 'text', text: instructionFor(prompt) },
        ...images.map(image => ({
            type: 'image_url',
            image_url: { url: `data:${image.mimetype};base64,${image.buffer.toString('base64')}` }
        }))
    ];

    const doFetch = fetchImpl || globalThis.fetch;
    if (typeof doFetch !== 'function') throw new Error('fetch tidak tersedia untuk analisis gambar.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('vision_timeout'), timeoutMs || settings.timeoutMs);
    try {
        const response = await doFetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: model.id,
                messages: [{ role: 'user', content }],
                max_tokens: maxTokens || settings.maxTokens,
                stream: false
            }),
            signal: controller.signal
        });
        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            throw new Error(`Analisis gambar gagal (HTTP ${response.status}): ${detail.slice(0, 300)}`);
        }
        const data = await response.json();
        return String(data?.choices?.[0]?.message?.content || '').trim();
    } finally {
        clearTimeout(timer);
    }
}

module.exports = { analyzeImages, instructionFor };
