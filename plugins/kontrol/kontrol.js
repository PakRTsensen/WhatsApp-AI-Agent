
const LIB_PATH = require.resolve('../../lib/group_control_api');
delete require.cache[LIB_PATH];



for (const dep of ['../../lib/antiforward_store', '../../lib/group_manager', '../../lib/message_cache', '../../lib/media_store']) {
    try {
        delete require.cache[require.resolve(dep)];
    } catch (_) {}
}

const { install } = require('../../lib/group_control_api');



let latestSock = global.__waControlSock || null;




try {
    install(() => latestSock || global.__waControlSock || null);
} catch (e) {
    console.error('[KONTROL] Gagal memasang control API:', e.message);
}

function attachCacheTap(sock) {
    if (!sock?.ev || typeof sock.ev.on !== 'function') return false;
    
    
    const TAP_VERSION = 2;
    if (sock.__waCacheTapV === TAP_VERSION) return true;
    sock.__waCacheTapV = TAP_VERSION;
    sock.__waCacheTap = true;
    sock.ev.on('messages.upsert', (ev) => {
        try {
            const list = ev?.messages || [];
            if (!list.length) return;
            const Cache = require('../../lib/message_cache');
            Cache.ingestRaw(list, { source: 'upsert' });
            
            
            try {
                const diag = globalThis.__waUpsertDiag || (globalThis.__waUpsertDiag = []);
                for (const raw of list) {
                    const { type, body } = Cache.unwrapMessage(raw?.message);
                    diag.push({
                        t: Date.now(),
                        chat: raw?.key?.remoteJid || null,
                        id: raw?.key?.id || null,
                        topKeys: Object.keys(raw?.message || {}),
                        type,
                        viewOnce: Cache.viewOnceOf(raw?.message),
                        hasUrl: Boolean(body?.url),
                        hasDirectPath: Boolean(body?.directPath),
                        hasMediaKey: Boolean(body?.mediaKey),
                        mtype: raw?.mtype || null,
                        messageNull: !raw?.message
                    });
                }
                while (diag.length > 30) diag.shift();
            } catch (_) {  }
            global.__waCacheTapCount = (global.__waCacheTapCount || 0) + list.length;
        } catch (e) {
            console.error('[KONTROL] cache tap gagal:', e.message);
        }
    });
    
    
    
    sock.ev.on('messages.update', (updates) => {
        try {
            const list = Array.isArray(updates) ? updates : [];
            const rebuilt = [];
            for (const u of list) {
                const msg = u?.update?.message;
                if (!msg || !u?.key?.id) continue;
                rebuilt.push({
                    key: u.key,
                    message: msg,
                    messageTimestamp: u?.update?.messageTimestamp || null
                });
            }
            if (!rebuilt.length) return;
            const Cache = require('../../lib/message_cache');
            const res = Cache.ingestRaw(rebuilt, { source: 'update' });
            global.__waCacheTapCount = (global.__waCacheTapCount || 0) + res.ingested;
        } catch (e) {
            console.error('[KONTROL] cache tap update gagal:', e.message);
        }
    });
    return true;
}

try {
    if (global.__waControlSock) attachCacheTap(global.__waControlSock);
} catch (e) {
    console.error('[KONTROL] gagal pasang cache tap:', e.message);
}

module.exports = {
    name: 'kontrol',
    category: 'owner',
    description: 'HTTP control API grup untuk MCP wa_control (localhost + token)',
    owner: true,
    hidden: true,

    before: async (context) => {
        try {
            
            
            if (context?.store && !globalThis.__waStore) {
                globalThis.__waStore = context.store;
            }
            if (context?.sock && context.sock !== latestSock) {
                latestSock = context.sock;
                global.__waControlSock = context.sock;
                attachCacheTap(context.sock);
                install(() => latestSock || global.__waControlSock || null);
            }
        } catch (e) {
            console.error('[KONTROL] Gagal start control API:', e.message);
        }
        return false;
    },

    run: async () => {}
};
