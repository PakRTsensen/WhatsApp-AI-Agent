'use strict';

const { NOPPO_CONFIG, getModel, getEngineModel } = require('./noppo_config');
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

async function sendUi(context, text) {
    const { sock, m } = context;
    const chat = String(m.chat);
    return send(sock, chat, String(text).trim(), m);
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
        const available = Object.values(NOPPO_CONFIG.models);
        const selector = rest.join(' ').trim();
        const index = /^\d+$/.test(selector) ? Number(selector) - 1 : -1;
        const selected = index >= 0 ? available[index] : available.find(model => model.id === selector);
        if (!selected) {
            const choices = available.map((model, i) => ({ header: '', title: `${i + 1}. ${model.name}`, description: model.id, id: `/noppo selectmodel ${i + 1}` }));
            const buttons = [{ buttonId: 'selectmodel', buttonText: { displayText: 'Pilih Model' }, nativeFlowInfo: { name: 'single_select', paramsJson: JSON.stringify({ title: 'Pilih Model Noppo', sections: [{ title: 'Model Tersedia', rows: choices }] }) }, type: 1 }];
            return sendUi(context, `Pilih model dengan nomor atau kirim ID lengkap.\n${available.map((model, i) => `${i + 1}. ${model.name} — ${model.id}`).join('\n')}`, { buttons, title: 'Pilih Model' });
        }
        Sessions.setPreferredModel(chatId, selected.id);
        const updated = Sessions.setSessionModel(session.id, selected.id);
        return sendUi(context, `Model sesi diganti ke *${selected.name}* (\`${selected.id}\`).\nEngine: \`${getEngineModel(selected)}\`\nContext window: ${selected.contextWindow.toLocaleString()} token; output max: ${selected.maxOutputTokens ? `${selected.maxOutputTokens.toLocaleString()} token` : 'mengikuti default model OpenCode (belum diverifikasi)'}.\nModel dipakai mulai turn berikutnya pada sesi ini.`, { title: 'Model Aktif' });
    }
    if (sub === 'modeldefault') {
        const available = Object.values(NOPPO_CONFIG.models);
        const selector = rest.join(' ').trim();
        const currentDefaultId = Sessions.getDefaultModel();
        const currentModel = NOPPO_CONFIG.models[currentDefaultId] || { name: currentDefaultId, id: currentDefaultId };
        if (!selector) {
            const choices = available.map((model, i) => ({ header: '', title: `${i + 1}. ${model.name}`, description: model.id, id: `/noppo modeldefault ${i + 1}` }));
            const buttons = [{ buttonId: 'modeldefault', buttonText: { displayText: 'Pilih Model Default' }, nativeFlowInfo: { name: 'single_select', paramsJson: JSON.stringify({ title: 'Pilih Model Default Noppo', sections: [{ title: 'Model Tersedia', rows: choices }] }) }, type: 1 }];
            return sendUi(context, `Model default saat ini: *${currentModel.name}* (\`${currentDefaultId}\`)\n\nPilih nomor atau kirim ID lengkap untuk mengganti model default ketika sesi baru/otomatis dibuat:\n${available.map((model, i) => `${i + 1}. ${model.name} — ${model.id}`).join('\n')}`, { buttons, title: 'Model Default Sesi' });
        }
        const index = /^\d+$/.test(selector) ? Number(selector) - 1 : -1;
        const selected = index >= 0 ? available[index] : available.find(model => model.id === selector);
        if (!selected) {
            return sendUi(context, `Model tidak ditemukan: \`${selector}\`\nGunakan nomor atau ID valid dari \`/noppo listmodel\`.`);
        }
        Sessions.setDefaultModel(selected.id);
        return sendUi(context, `Model default untuk sesi awal/otomatis berhasil diatur ke *${selected.name}* (\`${selected.id}\`).\n\nSetiap sesi baru atau sesi otomatis yang dibuat saat owner menyapa bot akan menggunakan model ini sebagai default.`, { title: 'Model Default Diperbarui' });
    }
    if (sub === 'modeluniversal') {
        const available = Object.values(NOPPO_CONFIG.models);
        const selector = rest.join(' ').trim();
        const currentDefaultId = Sessions.getDefaultModel();
        const currentModel = NOPPO_CONFIG.models[currentDefaultId] || { name: currentDefaultId, id: currentDefaultId };
        if (!selector) {
            const choices = available.map((model, i) => ({ header: '', title: `${i + 1}. ${model.name}`, description: model.id, id: `/noppo modeluniversal ${i + 1}` }));
            const buttons = [{ buttonId: 'modeluniversal', buttonText: { displayText: 'Pilih Model Universal' }, nativeFlowInfo: { name: 'single_select', paramsJson: JSON.stringify({ title: 'Pilih Model Universal Noppo', sections: [{ title: 'Model Tersedia', rows: choices }] }) }, type: 1 }];
            return sendUi(context, `Perintah ini akan mengganti model di *SELURUH* sesi, grup, dan chat aktif sekaligus, serta menjadikannya model default baru.\n\nModel default saat ini: *${currentModel.name}* (\`${currentDefaultId}\`)\n\nPilih nomor atau kirim ID lengkap:\n${available.map((model, i) => `${i + 1}. ${model.name} — ${model.id}`).join('\n')}`, { buttons, title: 'Model Universal' });
        }
        const index = /^\d+$/.test(selector) ? Number(selector) - 1 : -1;
        const selected = index >= 0 ? available[index] : available.find(model => model.id === selector);
        if (!selected) {
            return sendUi(context, `Model tidak ditemukan: \`${selector}\`\nGunakan nomor atau ID valid dari \`/noppo listmodel\`.`);
        }
        const result = Sessions.setUniversalModel(selected.id);
        return sendUi(context, `Model UNIVERSAL berhasil diterapkan ke *${selected.name}* (\`${selected.id}\`)!\n\n• ${result.sessionCount} sesi di seluruh chat/grup telah diubah ke model ini.\n• Preferensi model di ${result.chatCount} chat/grup diselaraskan.\n• Ditetapkan juga sebagai default untuk seluruh sesi baru berikutnya.\n\nContext window: ${selected.contextWindow.toLocaleString()} token.`, { title: 'Model Universal Aktif' });
    }
    if (sub === 'modelimage') {
        const available = Object.values(NOPPO_CONFIG.models);
        const target = rest[0];
        const action = String(rest[1] || '').toLowerCase();
        if (!target) {
            const rows = available.map((model, i) => {
                const vision = model.supportsImage === true ? 'didukung' : model.supportsImage === false ? 'tidak didukung' : 'belum diverifikasi';
                return `${i + 1}. *${model.name}* — \`${model.id}\`\n   Vision: ${vision} | Analisis gambar: ${Sessions.isImageModelEnabled(model.id) ? 'ON' : 'OFF'}`;
            }).join('\n');
            return sendUi(context, `${rows}\n\nFormat: \`/noppo modelimage <nomor|ID> on|off\``, { title: 'Model Gambar' });
        }
        const index = /^\d+$/.test(target) ? Number(target) - 1 : -1;
        const selected = index >= 0 ? available[index] : available.find(model => model.id === target);
        if (!selected) return sendUi(context, `Model tidak ditemukan: \`${target}\`\nGunakan nomor dari \`/noppo modelimage\`.`);
        if (action !== 'on' && action !== 'off') return sendUi(context, 'Format: `/noppo modelimage <nomor|ID> on|off`');
        if (action === 'on' && selected.supportsImage !== true) {
            return sendUi(context, `Model *${selected.name}* belum terverifikasi mendukung gambar, jadi analisis gambar tidak bisa diaktifkan.`);
        }
        try {
            Sessions.setImageModelEnabled(selected.id, action === 'on');
        } catch (error) {
            return sendUi(context, `Gagal mengubah analisis gambar: ${String(error.message || error).slice(0, 200)}`);
        }
        return sendUi(context, `Analisis gambar untuk *${selected.name}*: ${action === 'on' ? 'ON' : 'OFF'}.${action === 'on' ? '\nGambar pada pesan baru atau pesan yang dibalas akan dibaca model ini.' : ''}`, { title: 'Model Gambar' });
    }
    if (sub === 'listsesi') {
        const rows = Sessions.listSessions();
        const body = rows.length ? rows.map(row => `${row.active ? '▶' : '•'} \`${row.id}\` | ${row.status} | ${row.modelId || NOPPO_CONFIG.defaultModelId} | turns ${row.turnCount}`).join('\n') : 'Belum ada sesi Noppo.';
        return sendUi(context, body, { title: 'Daftar Sesi' });
    }
    if (sub === 'listmodel') {
        const rows = Object.values(NOPPO_CONFIG.models).map((model, i) => `${i + 1}. *${model.name}* — \`${model.id}\`\n   Engine: \`${getEngineModel(model)}\`\n   Context window: ${model.contextWindow.toLocaleString()} token; max input efektif: ${model.maxInputTokens.toLocaleString()}; max output: ${model.maxOutputTokens ? model.maxOutputTokens.toLocaleString() : 'belum diverifikasi'}`).join('\n');
        const choices = Object.values(NOPPO_CONFIG.models).map((model, i) => ({ header: '', title: `${i + 1}. ${model.name}`, description: `${model.id} | Context ${model.contextWindow.toLocaleString()}`, id: `/noppo selectmodel ${i + 1}` }));
        const buttons = [{ buttonId: 'selectmodel', buttonText: { displayText: 'Pilih Model' }, nativeFlowInfo: { name: 'single_select', paramsJson: JSON.stringify({ title: 'Pilih Model Noppo', sections: [{ title: 'Model Tersedia', rows: choices }] }) }, type: 1 }];
        return sendUi(context, rows, { buttons, title: 'Daftar Model' });
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
