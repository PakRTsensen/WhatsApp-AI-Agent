



function cache() { return require('../../lib/message_cache'); }


const subscribed = new WeakSet();

module.exports = {
    name: 'message_cache',
    category: 'tools',
    command: [],
    moderation: true,
    description: 'Rekam metadata pesan masuk untuk konteks Noppo (internal, tanpa command)',

    before: async (context) => {
        const { m, groupName, pushname, sock } = context || {};

        
        
        if (sock?.ev && !subscribed.has(sock)) {
            subscribed.add(sock);
            sock.ev.on('messaging-history.set', (payload) => {
                try {
                    const messages = payload?.messages || [];
                    if (messages.length) {
                        const res = cache().ingestRaw(messages, { source: 'history' });
                        console.log(`[MESSAGE CACHE] history sync: ${res.ingested} pesan masuk memory (${messages.length} diterima)`);
                    }
                } catch (error) {
                    console.error('[MESSAGE CACHE] gagal ingest history:', error?.message || error);
                }
            });
        }

        if (!m?.chat || !m?.key?.id) return false;

        try {
            cache().record(m, {
                chatName: groupName || null,
                pushName: m.pushName || pushname || null
            });
        } catch (error) {
            console.error('[MESSAGE CACHE]', error?.message || error);
        }

        return false;
    }
};
