
const fs = require('fs');
const path = require('path');

const DATABASE = path.join(__dirname, 'database', 'antiforward.json');
const SCHEMA = 3;
const MAX_ENTRIES_PER_GROUP = 200;
const GLOBAL_KEY = '*';

const emptyState = () => ({ _v: SCHEMA, enabled_all: false, groups: {}, exempt: {} });

function readState() {
    try {
        if (!fs.existsSync(DATABASE)) {
            const dir = path.dirname(DATABASE);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const initial = emptyState();
            fs.writeFileSync(DATABASE, JSON.stringify(initial, null, 2));
            return initial;
        }
        const raw = JSON.parse(fs.readFileSync(DATABASE, 'utf8'));
        if (!raw || typeof raw !== 'object') return emptyState();

        
        let groups = raw.groups;
        let enabledAll = Boolean(raw.enabled_all);
        if (!groups) {
            groups = {};
            for (const [k, v] of Object.entries(raw)) {
                if (k.endsWith('@g.us')) groups[k] = v;
            }
        }

        const state = {
            _v: SCHEMA,
            enabled_all: enabledAll,
            groups: groups && typeof groups === 'object' ? groups : {},
            exempt: raw.exempt && typeof raw.exempt === 'object' ? raw.exempt : {}
        };
        return state;
    } catch (_) {
        return emptyState();
    }
}

function writeState(state) {
    const dir = path.dirname(DATABASE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    state._v = SCHEMA;
    fs.writeFileSync(DATABASE, JSON.stringify(state, null, 2));
    return state;
}

function isGroupEnabled(state, chatId) {
    if (!state || typeof state !== 'object') return false;
    const groups = state.groups || {};
    if (state.enabled_all === true) {
        if (groups[chatId]?.enabled === false) return false;
        return true;
    }
    return Boolean(groups[chatId]?.enabled);
}

function normJid(value) {
    if (!value) return '';
    return String(value).replace(/:\d+(?=@)/, '').trim();
}

function digitsOf(value) {
    if (!value) return '';
    return normJid(value).split('@')[0].replace(/[^0-9]/g, '');
}

function samePerson(a, b) {
    const ja = normJid(a);
    const jb = normJid(b);
    if (!ja || !jb) return false;
    if (ja === jb) return true;
    const da = digitsOf(ja);
    const db = digitsOf(jb);
    return Boolean(da && db && da === db);
}

function bucket(state, chatId, create = false) {
    if (!state.exempt || typeof state.exempt !== 'object') state.exempt = {};
    const key = String(chatId || '').trim() || GLOBAL_KEY;
    if (!state.exempt[key] && create) {
        state.exempt[key] = { senders: [], channels: [] };
    }
    const b = state.exempt[key];
    if (!b) return null;
    if (!Array.isArray(b.senders)) b.senders = [];
    if (!Array.isArray(b.channels)) b.channels = [];
    return b;
}

function findSenderEntry(entries, target) {
    return (entries || []).find((e) => samePerson(e.jid, target) || samePerson(e.lid, target) || (digitsOf(target) && digitsOf(e.number) === digitsOf(target)));
}

function findChannelEntry(entries, target) {
    const t = normJid(target).toLowerCase();
    return (entries || []).find((e) => String(e.jid || '').toLowerCase() === t);
}

/**
 * Cek apakah pesan dari sender ini (atau forward dari channel ini) dikecualikan.
 * Cakupan: bucket grup dulu, lalu bucket global '*'.
 */
function checkExempt(state, chatId, { senderJid, senderLid, newsletterJid } = {}) {
    const keys = [String(chatId || ''), GLOBAL_KEY];
    const targets = [senderJid, senderLid].filter(Boolean);
    const channel = normJid(newsletterJid);

    for (const key of keys) {
        const b = bucket(state, key, false);
        if (!b) continue;

        if (targets.length) {
            for (const t of targets) {
                const hit = findSenderEntry(b.senders, t);
                if (hit) return { exempt: true, scope: key, type: 'sender', entry: hit };
            }
        }
        if (channel) {
            const hit = findChannelEntry(b.channels, channel);
            if (hit) return { exempt: true, scope: key, type: 'channel', entry: hit };
        }
    }
    return { exempt: false };
}

function addSender(state, chatId, { jid, lid, number, addedBy }) {
    const b = bucket(state, chatId, true);
    const primary = normJid(jid || lid || number);
    if (!primary) {
        const err = new Error('target pengirim tidak valid');
        err.code = 'INVALID_TARGET';
        throw err;
    }
    if (findSenderEntry(b.senders, primary)) {
        return { added: false, alreadyExists: true, entry: findSenderEntry(b.senders, primary) };
    }
    if (b.senders.length >= MAX_ENTRIES_PER_GROUP) {
        const err = new Error(`batas ${MAX_ENTRIES_PER_GROUP} pengecualian per grup sudah penuh`);
        err.code = 'LIMIT_REACHED';
        throw err;
    }
    const entry = {
        jid: normJid(jid || (primary.includes('@') ? primary : `${primary}@s.whatsapp.net`)),
        lid: lid ? normJid(lid) : null,
        number: number ? digitsOf(number) : (digitsOf(primary) || null),
        addedAt: new Date().toISOString(),
        addedBy: addedBy || 'unknown'
    };
    b.senders.push(entry);
    return { added: true, alreadyExists: false, entry };
}

function pruneBucket(state, chatId) {
    const key = String(chatId || '').trim() || GLOBAL_KEY;
    const b = state.exempt && state.exempt[key];
    if (!b) return;
    const empty = (!b.senders || !b.senders.length) && (!b.channels || !b.channels.length);
    if (empty) delete state.exempt[key];
}

function removeSender(state, chatId, target) {
    const b = bucket(state, chatId, false);
    if (!b) return { removed: false, entry: null };
    const entry = findSenderEntry(b.senders, target);
    if (!entry) return { removed: false, entry: null };
    b.senders = b.senders.filter((e) => e !== entry);
    pruneBucket(state, chatId);
    return { removed: true, entry };
}

function addChannel(state, chatId, { jid, name, addedBy }) {
    const b = bucket(state, chatId, true);
    const channel = normJid(jid);
    if (!channel || !channel.endsWith('@newsletter')) {
        const err = new Error('jid channel wajib berakhiran @newsletter');
        err.code = 'INVALID_TARGET';
        throw err;
    }
    if (findChannelEntry(b.channels, channel)) {
        return { added: false, alreadyExists: true, entry: findChannelEntry(b.channels, channel) };
    }
    if (b.channels.length >= MAX_ENTRIES_PER_GROUP) {
        const err = new Error(`batas ${MAX_ENTRIES_PER_GROUP} pengecualian per grup sudah penuh`);
        err.code = 'LIMIT_REACHED';
        throw err;
    }
    const entry = {
        jid: channel,
        name: name || null,
        addedAt: new Date().toISOString(),
        addedBy: addedBy || 'unknown'
    };
    b.channels.push(entry);
    return { added: true, alreadyExists: false, entry };
}

function removeChannel(state, chatId, target) {
    const b = bucket(state, chatId, false);
    if (!b) return { removed: false, entry: null };
    const entry = findChannelEntry(b.channels, target);
    if (!entry) return { removed: false, entry: null };
    b.channels = b.channels.filter((e) => e !== entry);
    pruneBucket(state, chatId);
    return { removed: true, entry };
}

function listExempt(state, chatId) {
    const own = bucket(state, chatId, false);
    const global = bucket(state, GLOBAL_KEY, false);
    return {
        chat: String(chatId || ''),
        senders: own ? own.senders : [],
        channels: own ? own.channels : [],
        globalSenders: global ? global.senders : [],
        globalChannels: global ? global.channels : []
    };
}

module.exports = {
    DATABASE,
    SCHEMA,
    GLOBAL_KEY,
    MAX_ENTRIES_PER_GROUP,
    readState,
    writeState,
    isGroupEnabled,
    normJid,
    digitsOf,
    samePerson,
    checkExempt,
    addSender,
    removeSender,
    addChannel,
    removeChannel,
    pruneBucket,
    listExempt
};
