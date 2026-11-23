'use strict';

const { NOPPO_CONFIG, getModel, getEngineModel, getSelectableModels, findSelectableModel } = require('./noppo_config');
const Sessions = require('./noppo_sessions');
const Engine = require('./noppo_opencode');
const Context = require('./noppo_context');
const Vision = require('./noppo_vision');
const { makeWhatsAppRenderer, sendWithQuoted, toolStatus, toolResultStatus } = require('./noppo_delivery');
const { parseCommand, isShortStatusQuestion, isAuthorizedOwner, shouldTrigger } = require('./noppo_routing');
const { isReplyToBot, isMentionToBot } = require('./noppo_whatsapp');

const MAX_PENDING = NOPPO_CONFIG.execution.maxQueuedFollowupsPerChat;
const queues = new Map();
const pending = new Map();
const chatEpochs = new Map();
const commandStates = new Map();
function getPendingCount(chatId) { return (pending.get(String(chatId)) || []).length; }
function getEpoch(chatId) { return chatEpochs.get(String(chatId)) || 0; }
function bumpEpoch(chatId) { chatId = String(chatId); const next = getEpoch(chatId) + 1; chatEpochs.set(chatId, next); return next; }

function enqueue(chatId, job) {
    chatId = String(chatId);
    const previous = queues.get(chatId) || Promise.resolve();
    const current = previous.catch(() => {}).then(job).catch(error => {
        console.error('[NOPPO QUEUE]', error?.message || error);
    }).finally(() => {
        if (queues.get(chatId) === current) queues.delete(chatId);
    });
    queues.set(chatId, current);
    return current;
}

function enqueuePrompt(chatId, item) {
    const id = String(chatId);
    const list = pending.get(id) || [];
    if (list.length >= MAX_PENDING) return false;
    list.push(item);
    pending.set(id, list);
    return true;
}

function takePrompt(chatId) {
    const id = String(chatId);
    const list = pending.get(id);
    if (!list?.length) { pending.delete(id); return null; }
    const item = list.shift();
    if (!list.length) pending.delete(id);
    return item;
}

async function send(sock, chat, text, quoted) {
    return sendWithQuoted(sock, chat, { text }, quoted);
}

async function sendUi(context, text, options = {}) {
    const { sock, m } = context;
    const chat = String(m.chat);
    return sendWithQuoted(sock, chat, { text: String(text).trim(), ...(options.buttons ? { buttons: options.buttons } : {}) }, m);
}

function selectableModels() {
    return getSelectableModels().sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function selectModel(selector, available) {
    const value = String(selector || '').trim();
    const page = value.match(/^page:(\d+)$/i);
    if (page) return { page: Math.max(1, Number(page[1])) };
    if (/^\d+$/.test(value)) return available[Number(value) - 1] || null;
    const withVariant = value.match(/^(.+?)\s+(none|minimal|low|medium|high|xhigh|max)$/i);
    if (withVariant) return findSelectableModel(`${withVariant[1]}#${withVariant[2]}`, available);
    return findSelectableModel(value, available);
}

function imageRow(model, n) {
    const enabled = Sessions.isImageModelEnabled(model.id);
    return {
        title: `${n}. ${enabled ? 'ON' : 'OFF'} ${model.name}`,
        description: `${model.id} · ${model.supportsImage === true ? 'vision' : 'non-vision'}`,
        id: `/noppo modelimage ${model.id} ${enabled ? 'off' : 'on'}`
    };
}

function modelPage(context, available, { page = 1, title = 'Model Tersedia', pageCommand = 'listmodel', actionCommand = 'selectmodel', hint = 'Pilih dengan nomor global atau ID lengkap (#variant opsional).', describeRow } = {}) {
    if (!available.length) return sendUi(context, `${title}: tidak ada model yang cocok di katalog OpenCode aktif. Pastikan OpenCode API berjalan dan model aktif tersedia.`);
    const pageSelector = String(page).match(/^page:(\d+)$/i);
    page = pageSelector ? Number(pageSelector[1]) : page;
    const pageSize = 8;
    const maxPage = Math.max(1, Math.ceil(available.length / pageSize));
    const currentPage = Math.max(1, Math.min(maxPage, Number(page) || 1));
    const start = (currentPage - 1) * pageSize;
    const pageRows = available.slice(start, start + pageSize);
    const text = pageRows.map((model, index) => {
        const n = start + index + 1;
        return `${n}. *${model.name}* — \`${model.id}\`\n   Context: ${model.contextWindow.toLocaleString()} | output: ${model.maxOutputTokens ? model.maxOutputTokens.toLocaleString() : 'n/a'}${model.variants?.length ? ` | variants: ${model.variants.join(',')}` : ''}`;
    }).join('\n') || 'Tidak ada model ditemukan.';
    const choices = pageRows.map((model, index) => {
        const n = start + index + 1;
        const row = describeRow ? describeRow(model, n) : {
            title: `${n}. ${model.name}`,
            description: model.id,
            id: `/noppo ${actionCommand} ${model.id}`
        };
        return { header: '', title: row.title.slice(0, 24), description: row.description.slice(0, 72), id: row.id };
    });
    if (currentPage > 1) choices.push({ header: '', title: `← Halaman ${currentPage - 1}`, description: 'Model sebelumnya', id: `/noppo ${pageCommand} page:${currentPage - 1}` });
    if (currentPage < maxPage) choices.push({ header: '', title: `Halaman ${currentPage + 1} →`, description: 'Model berikutnya', id: `/noppo ${pageCommand} page:${currentPage + 1}` });
    const buttons = choices.length ? [{
        buttonId: actionCommand,
        buttonText: { displayText: 'Pilih model / halaman' },
        nativeFlowInfo: { name: 'single_select', paramsJson: JSON.stringify({ title: `${title} (${currentPage}/${maxPage})`.slice(0, 24), sections: [{ title: `Model ${start + 1}–${start + pageRows.length}`, rows: choices }] }) },
        type: 1
    }] : [];
    return sendUi(context, `${title} — halaman ${currentPage}/${maxPage} (${available.length} model)\n\n${text}\n\n${hint}`, { buttons });
}


async function processPrompt(context, prompt, session, { epoch = getEpoch(context.m.chat) } = {}) {
    const { sock, m } = context;
    const chatId = String(m.chat);
    let selected = session || Sessions.getActiveSession(chatId);
    if (!selected) {
        
        selected = Sessions.ensureActiveSession(chatId, { modelId: Sessions.getPreferredModel(chatId) }).session;
    }
    const controller = new AbortController();
    const state = commandStates.get(chatId) || { controllers: new Set() };
    state.controllers.add(controller);
    commandStates.set(chatId, state);
    const renderer = makeWhatsAppRenderer({
        sock, chat: chatId, quoted: m,
        onFailure: error => console.error('[NOPPO WA EDIT]', error?.message || error)
    });
    const deliverFinal = value => renderer.finish(value);
    const typingTimer = setInterval(() => {
        try { sock.sendPresenceUpdate('composing', chatId); } catch (_) {}
    }, 3500);
    try { sock.sendPresenceUpdate('composing', chatId); } catch (_) {}
    let currentTool = null;
    let answerText = '';
    let toolProgress = '';
    const renderProgress = () => renderer.update(
        `${answerText}${answerText && toolProgress ? '\n\n' : ''}${toolProgress}`
    ).catch(() => {});
    try {
        if (epoch !== getEpoch(chatId)) return null;
        Sessions.setStatus(selected.id, 'queued');
        const result = await Engine.runTurn({
            chatId,
            prompt,
            session: selected,
            modelId: selected.modelId || NOPPO_CONFIG.defaultModelId,
            signal: controller.signal,
            onEvent: event => {
                if (event.type === 'text_delta') {
                    answerText = String(event.accumulatedText || '');
                    renderProgress();
                } else if (event.type === 'tool_started') {
                    currentTool = event.toolName;
                    toolProgress = toolStatus(event);
                    renderProgress();
                } else if (event.type === 'tool_completed') {
                    currentTool = null;
                    toolProgress = toolResultStatus(event);
                    renderProgress();
                } else if (event.type === 'diagnostic') {
                    console.error('[NOPPO OPENCODE]', event.text);
                }
            }
        });
        const finalText = result.stopped
            ? (result.error || (result.reason === 'owner_stop' ? 'Turn Noppo dihentikan.' : 'Turn Noppo dihentikan oleh guardrail.'))
            : (result.text || answerText || 'OpenCode menyelesaikan turn tanpa teks jawaban.');
        await deliverFinal(finalText);
        return { ...result, session: Sessions.getSession(selected.id), currentTool };
    } catch (error) {
        Sessions.setStatus(selected.id, 'error', error.message);
        const failureText = `Noppo gagal: ${String(error.message || error).slice(0, 500)}`;
        await deliverFinal(failureText).catch(deliveryError => {
            console.error('[NOPPO FAILURE DELIVERY]', deliveryError?.message || deliveryError);
            return send(sock, chatId, failureText, m).catch(() => {});
        });
        return { error };
    } finally {
        clearInterval(typingTimer);
        try { sock.sendPresenceUpdate('paused', chatId); } catch (_) {}
        state.controllers.delete(controller);
        if (!state.controllers.size) commandStates.delete(chatId);
    }
}

async function prepareImages(context, session) {
    const parts = Context.collectImageParts(context.m).slice(0, NOPPO_CONFIG.image.maxImages);
    if (!parts.length) return { images: [], imageAnalysis: '', imageDisabled: false, dirs: [] };
    if (!session || !Sessions.isImageModelEnabled(session.modelId)) {
        return { images: [], imageAnalysis: '', imageDisabled: true, dirs: [] };
    }
    const dirs = [];
    const prepared = [];
    try {
        for (const part of parts) {
            const buffer = await Context.downloadImage(part);
            const stored = Context.saveImage(buffer, part.mimetype);
            dirs.push(stored);
            prepared.push({ ...stored, mimetype: part.mimetype, buffer });
        }
        const analysis = await Vision.analyzeImages({
            images: prepared.map(item => ({ buffer: item.buffer, mimetype: item.mimetype })),
            prompt: context.body || context.budy || '',
            modelId: session.modelId,
            apiKey: Engine.getProviderKey(),
            baseUrl: NOPPO_CONFIG.provider.baseUrl
        });
        return { images: prepared.map(item => ({ path: item.file })), imageAnalysis: analysis, imageDisabled: false, dirs };
    } catch (error) {
        for (const dir of dirs) Context.cleanupImage(dir);
        return { images: [], imageAnalysis: '', imageDisabled: true, dirs: [], imageError: String(error.message || error).slice(0, 300) };
    }
}

async function drain(context, firstPrompt, session, startEpoch = getEpoch(context.m.chat)) {
    const chatId = String(context.m.chat);
    let prompt = firstPrompt;
    let activeSession = session;
    while (prompt !== null && prompt !== undefined) {
        if (startEpoch !== getEpoch(chatId)) break;
        const prepared = await prepareImages(context, activeSession);
        const chatName = context.groupName || null;
        const meta = Context.buildMessageMeta(context.m, { chatName });
        const quotedMeta = context.m?.quoted
            ? Context.buildMessageMeta(context.m.quoted, { chatId: String(context.m.chat), chatName })
            : null;
        let recent = [];
        let threadBefore = [];
        let threadHead = [];
        try {
            const MC = require('./message_cache');
            
            
            
            const nowMs = meta?.ts || Date.now();
            const WINDOW_MS = 30 * 60 * 1000;
            recent = MC.recent(chatId, { limit: 20, beforeMs: nowMs })
                .filter(r => r.ts && nowMs - r.ts <= WINDOW_MS)
                .filter(r => !r.fromMe)
                .filter(r => r.media?.kind !== 'protocol')
                .slice(-4);
            const quotedId = context.m?.quoted?.key?.id || context.m?.quoted?.id || null;
            if (quotedId) {
                
                
                const t = MC.thread(chatId, quotedId, { before: 2, after: 0, depth: 2 });
                threadBefore = t.before;
            }
        } catch (_) {}
        const fullPrompt = Context.buildPrompt({
            text: prompt,
            quoted: Context.buildQuotedContext(context.m),
            images: prepared.images,
            imageAnalysis: prepared.imageAnalysis,
            imageDisabled: prepared.imageDisabled,
            imageError: prepared.imageError,
            meta,
            quotedMeta,
            recent,
            threadBefore,
            threadHead
        });
        let result;
        try {
            result = await processPrompt(context, fullPrompt, activeSession, { epoch: startEpoch });
        } finally {
            for (const dir of prepared.dirs) Context.cleanupImage(dir);
        }
        activeSession = result?.session || Sessions.getActiveSession(chatId) || activeSession;
        if (startEpoch !== getEpoch(chatId)) break;
        const next = takePrompt(chatId);
        if (!next) break;
        prompt = next.prompt;
        if (next.freshSession) {
            activeSession = Sessions.createSession(chatId, { modelId: Sessions.getPreferredModel(chatId) });
        }
        context = next.context || context;
    }
}

async function handleCommand(context, args) {
    const { sock, m } = context;
    if (!isAuthorizedOwner(context)) return false;
    const chatId = String(m.chat);
    const [sub = 'help', ...rest] = args.map(v => String(v));
    if (sub === 'on' || sub === 'start') {
        if (!Engine.isAvailable()) {
            return sendUi(context, 'OpenCode CLI tidak ditemukan. Noppo tetap OFF; install OpenCode lalu atur NOPPO_OPENCODE_BINARY bila perlu.');
        }
        Sessions.setEnabled(true);
        return sendUi(context, 'Noppo Assistant aktif.');
    }
    if (sub === 'off') {
        Sessions.setEnabled(false);
        pending.delete(chatId);
        bumpEpoch(chatId);
        for (const controller of commandStates.get(chatId)?.controllers || []) controller.abort('noppo_off');
        Engine.stopTurn(chatId, { reason: 'noppo_off' });
        return sendUi(context, 'Noppo dinonaktifkan; turn aktif dan antrean chat ini dihentikan.');
    }
    if (sub === 'stop' || sub === 'kill') {
        const active = Engine.status(chatId);
        const hadQueued = getPendingCount(chatId) > 0;
        pending.delete(chatId);
        bumpEpoch(chatId);
        for (const controller of commandStates.get(chatId)?.controllers || []) controller.abort(`owner_${sub}`);
        if (!active.running) return sendUi(context, (hadQueued || queues.has(chatId)) ? 'Turn/antrean Noppo dibatalkan.' : 'Tidak ada turn Noppo yang sedang berjalan di chat ini.');
        const result = Engine.stopTurn(chatId, { force: sub === 'kill', reason: `owner_${sub}` });
        return sendUi(context, result.stopped ? (sub === 'kill' ? 'Turn Noppo dihentikan paksa.' : 'Permintaan stop dikirim; proses diberi 4 detik untuk berhenti rapi.') : 'Tidak ada turn aktif.');
    }
    if (sub === 'new') {
        if (Engine.status(chatId).running || queues.has(chatId) || getPendingCount(chatId)) return sendUi(context, 'Turn/antrean sedang berjalan. Gunakan `/noppo stop` sebelum membuat sesi baru.');
        const session = Sessions.createSession(chatId, { modelId: Sessions.getPreferredModel(chatId) });
        return sendUi(context, `Sesi Noppo baru: \`${session.id}\`\nModel: \`${session.modelId}\``, { title: 'Sesi Baru' });
    }
    if (sub === 'resume') {
        const id = rest[0];
        if (!id) return sendUi(context, 'Format: `/noppo resume <session_id>`');
        if (Engine.status(chatId).running || queues.has(chatId) || getPendingCount(chatId)) return sendUi(context, 'Turn/antrean sedang berjalan. Gunakan `/noppo stop` sebelum berganti sesi.');
        const session = Sessions.activateSession(chatId, id);
        if (!session) return sendUi(context, `Sesi Noppo tidak ditemukan: \`${id}\``);
        return sendUi(context, `Sesi aktif: \`${session.id}\`\nModel: \`${session.modelId || NOPPO_CONFIG.defaultModelId}\``, { title: 'Sesi Aktif' });
    }
    if (sub === 'selectmodel') {
        if (Engine.status(chatId).running || queues.has(chatId) || getPendingCount(chatId)) {
            return sendUi(context, 'Turn/antrean sedang berjalan. Model sesi dapat diganti setelah selesai atau dihentikan dengan `/noppo stop`.');
        }
        const session = Sessions.ensureActiveSession(chatId, { modelId: Sessions.getPreferredModel(chatId) }).session;
        const available = selectableModels();
        const selector = rest.join(' ').trim();
        const selected = selectModel(selector, available);
        if (selected?.page) return modelPage(context, available, { page: selected.page, title: 'Pilih Model Sesi', pageCommand: 'selectmodel', actionCommand: 'selectmodel' });
        if (!selected) return modelPage(context, available, { title: 'Pilih Model Sesi', pageCommand: 'selectmodel', actionCommand: 'selectmodel' });
        Sessions.setPreferredModel(chatId, selected.id);
        Sessions.setSessionModel(session.id, selected.id);
        return sendUi(context, `Model sesi diganti ke *${selected.name}* (\`${selected.id}\`).\nOpenCode: \`${getEngineModel(selected)}\`\nContext: ${selected.contextWindow.toLocaleString()} | output max: ${selected.maxOutputTokens ? selected.maxOutputTokens.toLocaleString() : 'n/a'}.\nDipakai mulai turn berikutnya.`, { title: 'Model Aktif' });
    }
    if (sub === 'modeldefault') {
        const available = selectableModels();
        const selector = rest.join(' ').trim();
        const currentDefaultId = Sessions.getDefaultModel();
        const currentModel = getModel(currentDefaultId) || { name: currentDefaultId, id: currentDefaultId };
        const selected = selectModel(selector, available);
        if (selected?.page) return modelPage(context, available, { page: selected.page, title: 'Pilih Model Default', pageCommand: 'modeldefault', actionCommand: 'modeldefault' });
        if (!selected) return modelPage(context, available, { title: `Model Default — saat ini ${currentModel.name}`, pageCommand: 'modeldefault', actionCommand: 'modeldefault' });
        Sessions.setDefaultModel(selected.id);
        return sendUi(context, `Model default sesi baru diatur ke *${selected.name}* (\`${selected.id}\`).`, { title: 'Model Default Diperbarui' });
    }
    if (sub === 'modeluniversal') {
        const available = selectableModels();
        const selector = rest.join(' ').trim();
        const currentDefaultId = Sessions.getDefaultModel();
        const currentModel = getModel(currentDefaultId) || { name: currentDefaultId, id: currentDefaultId };
        const selected = selectModel(selector, available);
        if (selected?.page) return modelPage(context, available, { page: selected.page, title: 'Pilih Model Universal', pageCommand: 'modeluniversal', actionCommand: 'modeluniversal' });
        if (!selected) return modelPage(context, available, { title: `Model Universal — saat ini ${currentModel.name}. Memilih akan mengganti semua sesi.`, pageCommand: 'modeluniversal', actionCommand: 'modeluniversal' });
        const result = Sessions.setUniversalModel(selected.id);
        return sendUi(context, `Model UNIVERSAL diganti ke *${selected.name}* (\`${selected.id}\`).\n• ${result.sessionCount} sesi diperbarui.\n• ${result.chatCount} preferensi chat diperbarui.\n• Model ini menjadi default sesi baru.`, { title: 'Model Universal Aktif' });
    }
    if (sub === 'modelimage') {
        const available = selectableModels();
        const target = rest[0];
        const action = String(rest[1] || '').toLowerCase();
        const selected = selectModel(target, available);
        const imageHint = 'Ketuk model untuk ON/OFF, atau kirim `/noppo modelimage <nomor|ID> on|off`.';
        if (selected?.page) return modelPage(context, available, { page: selected.page, title: 'Pilih Model Gambar', pageCommand: 'modelimage', actionCommand: 'modelimage', hint: imageHint, describeRow: imageRow });
        if (!target) return modelPage(context, available, { title: 'Pilih Model untuk Analisis Gambar', pageCommand: 'modelimage', actionCommand: 'modelimage', hint: imageHint, describeRow: imageRow });
        if (!selected) return sendUi(context, `Model tidak ditemukan: \`${target}\`\nGunakan nomor atau ID dari \`/noppo modelimage\`.`);
        if (action !== 'on' && action !== 'off') return sendUi(context, 'Format: `/noppo modelimage <nomor|provider/model[#variant]> on|off`');
        if (action === 'on' && selected.supportsImage !== true) {
            return sendUi(context, `Model *${selected.name}* tidak ditandai mendukung gambar melalui adapter vision Noppo.`);
        }
        try {
            Sessions.setImageModelEnabled(selected.id, action === 'on');
        } catch (error) {
            return sendUi(context, `Gagal mengubah analisis gambar: ${String(error.message || error).slice(0, 200)}`);
        }
        return sendUi(context, `Analisis gambar untuk *${selected.name}*: ${action === 'on' ? 'ON' : 'OFF'}.`, { title: 'Model Gambar' });
    }
    if (sub === 'listsesi') {
        const rows = Sessions.listSessions();
        const body = rows.length ? rows.map(row => `${row.active ? '▶' : '•'} \`${row.id}\` | ${row.status} | ${row.modelId || NOPPO_CONFIG.defaultModelId} | turns ${row.turnCount}`).join('\n') : 'Belum ada sesi Noppo.';
        return sendUi(context, body, { title: 'Daftar Sesi' });
    }
    if (sub === 'listmodel') {
        const available = selectableModels();
        const selector = rest.join(' ').trim();
        const pageMatch = selector.match(/^page:(\d+)$/i) || selector.match(/^(\d+)$/);
        const query = selector && !pageMatch ? selector : '';
        const filtered = query
            ? available.filter(model => `${model.name} ${model.id} ${model.provider}`.toLowerCase().includes(query.toLowerCase()))
            : available;
        return modelPage(context, filtered, {
            page: pageMatch ? Number(pageMatch[1] || pageMatch[0]) : 1,
            title: query ? `Hasil pencarian “${query}”` : 'Daftar Model OpenCode',
            pageCommand: 'listmodel',
            actionCommand: 'selectmodel'
        });
    }
    if (sub === 'status') {
        const active = Engine.status(chatId);
        const session = Sessions.getActiveSession(chatId);
        return sendUi(context, `Noppo: ${Sessions.isEnabled() ? 'ON' : 'OFF'}\nEngine: OpenCode (\`${NOPPO_CONFIG.execution.agent}\`)\nTurn: ${active.running ? 'RUNNING' : queues.has(chatId) ? 'QUEUED' : 'IDLE'}\nSesi: ${session?.id || 'belum dibuat (auto saat owner mention)'}\nAntrean: ${getPendingCount(chatId)}`, { title: 'Status' });
    }
    return sendUi(context, 'Command Noppo\n/noppo on|start|off|status\n/noppo stop|kill\n/noppo new (sesi baru; sesi pertama dibuat otomatis saat mention)\n/noppo resume <session_id>\n/noppo selectmodel <ID|nomor>\n/noppo modeldefault <ID|nomor>\n/noppo modeluniversal <ID|nomor>\n/noppo modelimage <nomor|ID> on|off\n/noppo listsesi\n/noppo listmodel', { title: 'Bantuan' });
}

async function handleMessage(context) {
    const { m, sock } = context;
    if (!isAuthorizedOwner(context)) return false;
    const text = String(context.budy || context.body || '').trim();
    const args = parseCommand(text);
    if (args) {
        await handleCommand(context, args);
        return true;
    }
    if (!Sessions.isEnabled() || m.key?.fromMe) return false;

    const repliedToBot = isReplyToBot(m, sock);
    const mentioned = await isMentionToBot(m, sock);
    const isPrivate = !String(m.chat || '').endsWith('@g.us');
    if (!shouldTrigger({ isOwner: true, isPrivate, isReplyToBot: repliedToBot, isMentionToBot: mentioned, text })) return false;

    const prompt = text.replace(/@\d+/g, '').trim();
    const hasImages = Context.collectImageParts(m).length > 0;
    const hasQuoted = Boolean(Context.buildQuotedContext(m));
    if (!prompt && !hasImages && !hasQuoted) return false;

    const chatKey = String(m.chat);
    let activeSession = Sessions.getActiveSession(chatKey);
    if (Engine.status(chatKey).running || queues.has(chatKey)) {
        const queued = enqueuePrompt(m.chat, { prompt, context });
        if (!queued) await send(sock, m.chat, 'Antrean Noppo penuh; instruksi tidak diterima.', m);
        return true;
    }
    if (!activeSession) {
        
        const ensured = Sessions.ensureActiveSession(chatKey, { modelId: Sessions.getPreferredModel(chatKey) });
        activeSession = ensured.session;
        console.log(`[NOPPO] sesi otomatis ${activeSession.id} untuk ${chatKey}`);
    }
    const epoch = getEpoch(m.chat);
    enqueue(String(m.chat), () => drain(context, prompt, activeSession, epoch));
    return true;
}

module.exports = { handleMessage, handleCommand, parseCommand, isShortStatusQuestion, status: Engine.status };
