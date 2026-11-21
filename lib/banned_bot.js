const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'database/banned_bot.json');
const SESSION_DIR = path.join(__dirname, '../session');

function readBannedBotConfig() {
    try {
        if (!fs.existsSync(DB_PATH)) {
            const initial = { _v: 1, banned_users: [] };
            fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2), 'utf8');
            return initial;
        }
        const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8') || '{}');
        if (!Array.isArray(data.banned_users)) data.banned_users = [];
        return data;
    } catch (_) {
        return { _v: 1, banned_users: [] };
    }
}

function saveBannedBotConfig(cfg) {
    try {
        const dir = path.dirname(DB_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(DB_PATH, JSON.stringify(cfg, null, 2), 'utf8');
        return true;
    } catch (e) {
        console.error('[BANNED BOT SAVE ERROR]', e);
        return false;
    }
}

function cleanNumber(input) {
    if (!input) return '';
    return String(input).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
}

function normalizeJid(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (raw.includes('@')) return raw.replace(/:\d+(?=@)/, '');
    const digits = raw.replace(/[^0-9]/g, '');
    if (!digits) return '';
    return (digits.startsWith('0') ? `62${digits.slice(1)}` : digits) + '@s.whatsapp.net';
}

function resolveLidToPnFile(lidDigits) {
    const digits = cleanNumber(lidDigits);
    if (!digits) return '';
    const reverseFile = path.join(SESSION_DIR, `lid-mapping-${digits}_reverse.json`);
    if (fs.existsSync(reverseFile)) {
        try {
            const content = JSON.parse(fs.readFileSync(reverseFile, 'utf8'));
            return cleanNumber(content);
        } catch (_) {}
    }
    return '';
}

/**
 * Resolusi cepat Phone Number ke LID melalui file session Baileys
 */
function resolvePnToLidFile(pnDigits) {
    const digits = cleanNumber(pnDigits);
    if (!digits) return '';
    const forwardFile = path.join(SESSION_DIR, `lid-mapping-${digits}.json`);
    if (fs.existsSync(forwardFile)) {
        try {
            const content = JSON.parse(fs.readFileSync(forwardFile, 'utf8'));
            return cleanNumber(content);
        } catch (_) {}
    }
    return '';
}

/**
 * Kumpulkan semua kemungkinan identitas user (JID, LID, PN, nomor)
 */
function collectUserCandidates(jid, extraNumber = '', options = {}) {
    const candidates = new Set();
    const addCandidate = (val) => {
        if (!val) return;
        const raw = String(val).trim();
        const norm = raw.replace(/:\d+(?=@)/, '');
        const num = cleanNumber(norm);
        if (norm) candidates.add(norm.toLowerCase());
        if (num) {
            candidates.add(num);
            candidates.add(`${num}@s.whatsapp.net`);
            candidates.add(`${num}@lid`);
            const mappedPn = resolveLidToPnFile(num);
            if (mappedPn) {
                candidates.add(mappedPn);
                candidates.add(`${mappedPn}@s.whatsapp.net`);
            }
            const mappedLid = resolvePnToLidFile(num);
            if (mappedLid) {
                candidates.add(mappedLid);
                candidates.add(`${mappedLid}@lid`);
            }
        }
    };

    addCandidate(jid);
    addCandidate(extraNumber);

    if (options.groupMetadata?.participants && Array.isArray(options.groupMetadata.participants)) {
        const jidNorm = String(jid || '').trim().replace(/:\d+(?=@)/, '');
        const num = cleanNumber(jidNorm);
        for (const p of options.groupMetadata.participants) {
            const pId = String(p.id || '').replace(/:\d+(?=@)/, '');
            const pLid = String(p.lid || '').replace(/:\d+(?=@)/, '');
            const pPhone = String(p.phoneNumber || '').replace(/:\d+(?=@)/, '');
            if (pId === jidNorm || pLid === jidNorm || pPhone === jidNorm ||
                cleanNumber(pId) === num || cleanNumber(pLid) === num || cleanNumber(pPhone) === num) {
                addCandidate(pId);
                addCandidate(pLid);
                addCandidate(pPhone);
                break;
            }
        }
    }

    return Array.from(candidates);
}

/**
 * Cek apakah user (berdasarkan JID, LID, atau Nomor) di-ban total dari bot
 */
function isBotBanned(jid, extraNumber = '', options = {}) {
    const cfg = readBannedBotConfig();
    if (!cfg.banned_users || !cfg.banned_users.length) return false;

    const candidates = collectUserCandidates(jid, extraNumber, options);

    return cfg.banned_users.some(b => {
        if (!b) return false;
        const bJid = String(b.jid || '').trim().replace(/:\d+@/, '@').toLowerCase();
        const bNum = cleanNumber(b.number || b.jid);
        const bLid = String(b.lid || '').trim().replace(/:\d+@/, '@').toLowerCase();
        const bLidNum = cleanNumber(b.lid_number || b.lid);

        return candidates.some(c => {
            if (bJid && c === bJid) return true;
            if (bNum && c === bNum) return true;
            if (bLid && c === bLid) return true;
            if (bLidNum && c === bLidNum) return true;
            return false;
        });
    });
}

/**
 * Tambah user ke daftar banned total
 */
function banBotUser(targetJid, extraInfo = {}) {
    const cfg = readBannedBotConfig();
    const jidNorm = normalizeJid(targetJid);
    let number = cleanNumber(extraInfo.number || jidNorm);

    let lid = extraInfo.lid || '';
    let lidNum = cleanNumber(lid);
    if (!lidNum && number) {
        const foundLid = resolvePnToLidFile(number);
        if (foundLid) {
            lidNum = foundLid;
            lid = `${foundLid}@lid`;
        }
    }
    if (!number && targetJid.includes('@lid')) {
        const foundPn = resolveLidToPnFile(targetJid);
        if (foundPn) {
            number = foundPn;
        }
    }

    const exists = cfg.banned_users.some(b => {
        const bJid = String(b.jid || '').trim().replace(/:\d+@/, '@');
        const bNum = cleanNumber(b.number || b.jid);
        const bLidNum = cleanNumber(b.lid_number || b.lid);
        if (bJid && bJid === jidNorm) return true;
        if (bNum && number && bNum === number) return true;
        if (bLidNum && lidNum && bLidNum === lidNum) return true;
        return false;
    });

    if (exists) return false;

    cfg.banned_users.push({
        jid: jidNorm,
        number: number,
        lid: lid || undefined,
        lid_number: lidNum || undefined,
        banned_at: new Date().toISOString(),
        banned_by: extraInfo.banned_by || 'owner',
        reason: extraInfo.reason || 'Permanent total bot ban by owner'
    });

    saveBannedBotConfig(cfg);
    return true;
}

function unbanBotUser(targetInput) {
    const cfg = readBannedBotConfig();
    const clean = String(targetInput || '').trim().replace(/:\d+@/, '@');
    const num = cleanNumber(clean);
    const mappedPn = resolveLidToPnFile(num);
    const mappedLid = resolvePnToLidFile(num);

    const initialLen = cfg.banned_users.length;
    cfg.banned_users = cfg.banned_users.filter(b => {
        const bJid = String(b.jid || '').trim().replace(/:\d+@/, '@');
        const bNum = cleanNumber(b.number || b.jid);
        const bLidNum = cleanNumber(b.lid_number || b.lid);

        if (bJid && bJid === clean) return false;
        if (bNum && num && bNum === num) return false;
        if (bLidNum && num && bLidNum === num) return false;
        if (mappedPn && bNum && mappedPn === bNum) return false;
        if (mappedLid && bLidNum && mappedLid === bLidNum) return false;
        return true;
    });

    if (cfg.banned_users.length < initialLen) {
        saveBannedBotConfig(cfg);
        return true;
    }
    return false;
}

function getBotBannedList() {
    const cfg = readBannedBotConfig();
    return cfg.banned_users || [];
}

module.exports = {
    isBotBanned,
    banBotUser,
    unbanBotUser,
    getBotBannedList,
    cleanNumber,
    normalizeJid,
    resolveLidToPnFile,
    resolvePnToLidFile,
    collectUserCandidates
};
