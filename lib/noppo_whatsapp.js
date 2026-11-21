'use strict';

const { areJidsSameUser } = require('@itsliaaa/baileys');

function normalizeJid(sock, value) {
    if (!value) return '';
    try { return sock.decodeJid ? sock.decodeJid(String(value)) : String(value); }
    catch (_) { return String(value); }
}

function isReplyToBot(message, sock) {
    if (message?.quoted?.key?.fromMe === true) return true;
    const info = message?.msg?.contextInfo || message?.message?.extendedTextMessage?.contextInfo || {};
    const quotedIds = [
        message?.quoted?.sender,
        message?.quoted?.key?.participant,
        info.participant,
        message?.message?.extendedTextMessage?.contextInfo?.participant
    ].filter(Boolean).map(id => normalizeJid(sock, id));
    const botIds = [sock?.user?.id, sock?.user?.lid].map(id => normalizeJid(sock, id)).filter(Boolean);
    return quotedIds.some(quoted => botIds.some(bot => {
        try { return areJidsSameUser(quoted, bot); } catch (_) { return quoted === bot; }
    }));
}

async function isMentionToBot(message, sock) {
    const info = message?.msg?.contextInfo || message?.message?.extendedTextMessage?.contextInfo || {};
    const mentioned = [
        ...(Array.isArray(message?.mentionedJid) ? message.mentionedJid : []),
        ...(Array.isArray(info.mentionedJid) ? info.mentionedJid : [])
    ];
    const botIds = [sock?.user?.id, sock?.user?.lid].map(id => normalizeJid(sock, id)).filter(Boolean);
    return mentioned.some(candidate => {
        const jid = normalizeJid(sock, candidate);
        return botIds.some(bot => {
            try { return areJidsSameUser(jid, bot); } catch (_) { return jid === bot; }
        });
    });
}

module.exports = { isReplyToBot, isMentionToBot, normalizeJid };
