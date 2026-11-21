'use strict';

function parseCommand(text) {
    const match = String(text || '').trim().match(/^\/noppo(?:\s+(.+))?$/i);
    return match ? String(match[1] || '').trim().split(/\s+/).filter(Boolean) : null;
}

function isShortStatusQuestion(text) {
    const s = String(text || '').trim().toLowerCase().replace(/[?!.,]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (s.length > 90) return false;
    if (/\b(jawab|jawabkan)\b/.test(s) && /\bdulu\b/.test(s) && /\b(udah|sudah|belum|selesai|beres)\b/.test(s)) return true;
    return /^(udah|sudah|belum|done|selesai|beres|jalan|masih|masih jalan|masih aktif|ada turn|ada respons|ada respon|kok|kenapa|status)(\s+(belum|sudah|udah|nih|ga|nggak|gak|ya|kah|dong|sih|sekarang|skrg|turn|respon|respons|aktif|selesai)){0,5}$/.test(s)
        || /^(udah belum|sudah belum|udah selesai|sudah selesai|udah jalan|sudah jalan)$/.test(s);
}

function isAuthorizedOwner(context) {
    return Boolean(context && (context.authorizedOwner || context.isCreator || context.isOwner));
}

function shouldTrigger({ isOwner, isReplyToBot, isMentionToBot, text }) {
    if (!isOwner) return false;
    return Boolean(isReplyToBot || isMentionToBot || /\b(?:noppo|nop)\b/i.test(String(text || '')));
}

module.exports = { parseCommand, isShortStatusQuestion, isAuthorizedOwner, shouldTrigger };
