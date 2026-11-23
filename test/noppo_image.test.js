'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noppo-image-store-'));
process.env.NOPPO_SESSION_STORE = path.join(storeDir, 'noppo_sessions.json');

const Sessions = require('../lib/noppo_sessions');
const Context = require('../lib/noppo_context');
const Vision = require('../lib/noppo_vision');

const IMAGE_MODEL = '9router/ca/gpt-6-luna';
const TEXT_MODEL = 'dco/deepseek-ai/DeepSeek-V4.1-Flash-1017';

function fakeImageMessage(overrides = {}) {
    return { mimetype: 'image/png', url: 'https://example.invalid/a.enc', ...overrides };
}

(async () => {
    assert.equal(Sessions.isImageModelEnabled(IMAGE_MODEL), false, 'image analysis starts disabled');
    assert.equal(Sessions.setImageModelEnabled(IMAGE_MODEL, true), true);
    assert.equal(Sessions.isImageModelEnabled(IMAGE_MODEL), true);
    assert.throws(() => Sessions.setImageModelEnabled(TEXT_MODEL, true), /belum terverifikasi/);
    assert.equal(Sessions.setImageModelEnabled(IMAGE_MODEL, false), false);
    assert.equal(Sessions.isImageModelEnabled(IMAGE_MODEL), false);
    Sessions.setImageModelEnabled(IMAGE_MODEL, true);

    const current = Context.collectImageParts({ mtype: 'imageMessage', msg: fakeImageMessage() });
    assert.equal(current.length, 1);
    assert.equal(current[0].source, 'current');

    const quoted = Context.collectImageParts({
        mtype: 'extendedTextMessage',
        msg: { text: 'lihat ini' },
        quoted: fakeImageMessage({ url: 'https://example.invalid/b.enc' })
    });
    assert.equal(quoted.length, 1, 'smsg stores the quoted image as a raw media object');
    assert.equal(quoted[0].source, 'quoted');

    const quotedEnvelope = Context.collectImageParts({
        mtype: 'extendedTextMessage',
        msg: { text: 'lihat ini' },
        quoted: { imageMessage: fakeImageMessage({ url: 'https://example.invalid/c.enc' }) }
    });
    assert.equal(quotedEnvelope.length, 1, 'an envelope-shaped quoted image must also be recognized');

    const textQuote = Context.buildQuotedContext({
        quoted: { conversation: 'ada yang punya tools osint?', sender: '628111@s.whatsapp.net', key: { participant: '628111@s.whatsapp.net' } }
    });
    assert.equal(textQuote.text, 'ada yang punya tools osint?');
    assert.equal(textQuote.hasImage, false);
    assert.equal(Context.buildQuotedContext({}), null);
    const imageQuote = Context.buildQuotedContext({ quoted: fakeImageMessage() });
    assert.equal(imageQuote.hasImage, true, 'a raw quoted image object must be reported as an image');

    const prompt = Context.buildPrompt({
        text: '@noppo dia nanya tuh',
        quoted: textQuote,
        images: [{ path: '/tmp/noppo-image-x/image.png' }],
        imageAnalysis: 'Angka 7429 dengan lingkaran merah.'
    });
    assert.match(prompt, /\[Konteks pesan yang dibalas\]/);
    assert.match(prompt, /ada yang punya tools osint\?/);
    assert.match(prompt, /\[Gambar yang dilampirkan\]/);
    assert.match(prompt, /\/tmp\/noppo-image-x\/image\.png/);
    assert.match(prompt, /Angka 7429 dengan lingkaran merah\./);
    assert.match(prompt, /\[Permintaan\]\n@noppo dia nanya tuh/);
    assert.ok(prompt.endsWith('[Permintaan]\n@noppo dia nanya tuh'));

    const disabled = Context.buildPrompt({ text: 'apa ini', images: [], imageDisabled: true });
    assert.match(disabled, /analisis gambar nonaktif/);

    const failed = Context.buildPrompt({ text: 'apa ini', images: [], imageDisabled: true, imageError: 'HTTP 503' });
    assert.match(failed, /analisis gambar gagal: HTTP 503/);
    assert.doesNotMatch(failed, /analisis gambar nonaktif/);

    const imageOnly = Context.buildPrompt({ text: '', quoted: null, images: [{ path: '/tmp/a.png' }], imageAnalysis: 'x' });
    assert.match(imageOnly, /Analisis gambar yang dilampirkan/);

    const quotedOnly = Context.buildPrompt({ text: '', quoted: textQuote, images: [] });
    assert.match(quotedOnly, /Tanggapi pesan yang dibalas/);

    const seen = [];
    const fakeFetch = async (url, options) => {
        seen.push({ url, body: JSON.parse(options.body), headers: options.headers });
        return {
            ok: true,
            status: 200,
            json: async () => ({ choices: [{ message: { content: 'Angka 7429, lingkaran merah.' } }] })
        };
    };
    const analysis = await Vision.analyzeImages({
        images: [{ buffer: Buffer.from('fake-png'), mimetype: 'image/png' }],
        prompt: 'sebutkan angka',
        modelId: IMAGE_MODEL,
        apiKey: 'test-key',
        baseUrl: 'https://example.invalid/v1',
        fetchImpl: fakeFetch
    });
    assert.equal(analysis, 'Angka 7429, lingkaran merah.');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'https://example.invalid/v1/chat/completions');
    assert.equal(seen[0].body.model, 'ca/gpt-6-luna');
    const parts = seen[0].body.messages[0].content;
    assert.equal(parts[0].type, 'text');
    assert.equal(parts[1].type, 'image_url');
    assert.match(parts[1].image_url.url, /^data:image\/png;base64,/);

    await assert.rejects(
        Vision.analyzeImages({ images: [{ buffer: Buffer.from('x'), mimetype: 'image/png' }], modelId: TEXT_MODEL, apiKey: 'k', fetchImpl: fakeFetch }),
        /tidak mendukung analisis gambar/
    );

    const saved = Context.saveImage(Buffer.from('png-bytes'), 'image/png');
    assert.equal(fs.existsSync(saved.file), true);
    Context.cleanupImage(saved);
    assert.equal(fs.existsSync(saved.dir), false);

    fs.rmSync(storeDir, { recursive: true, force: true });
    console.log('PASS: image store toggle, WhatsApp image extraction, quoted context, prompt assembly, vision request');
})().catch(error => {
    console.error('FAIL:', error);
    process.exit(1);
});
