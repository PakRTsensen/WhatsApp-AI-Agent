const fs = require("fs");
const path = require("path");
const { generateWAMessageFromContent, areJidsSameUser } = require("@itsliaaa/baileys");

const Store = require("../../lib/antiforward_store");
const CHANNEL_LINK_REGEX = /https?:\/\/(?:www\.)?(?:chat\.)?whatsapp\.com\/channel\/[A-Za-z0-9_-]+/i;

const readState = () => Store.readState();
const writeState = (state) => Store.writeState(state);
const isGroupEnabled = (state, chatId) => Store.isGroupEnabled(state, chatId);
const digitsOf = (jid) => Store.digitsOf(jid);
const normJid = (jid) => Store.normJid(jid);

function checkIsBotAdmin(context) {
    const { isBotAdmins, isBotGroupAdmins, participants, sock, botNumber } = context;
    if (isBotAdmins || isBotGroupAdmins) return true;

    if (!Array.isArray(participants) || !participants.length) {
        
        return true;
    }

    const botDigits = new Set([
        digitsOf(botNumber),
        digitsOf(sock?.user?.id),
        digitsOf(sock?.user?.lid)
    ].filter(Boolean));

    for (const p of participants) {
        if (!p.admin) continue;
        const pDigits = [digitsOf(p.id), digitsOf(p.phoneNumber), digitsOf(p.lid)].filter(Boolean);
        for (const d of pDigits) {
            if (botDigits.has(d)) return true;
        }
        if (typeof areJidsSameUser === "function") {
            for (const bJid of [botNumber, sock?.user?.id, sock?.user?.lid].filter(Boolean)) {
                for (const pJid of [p.id, p.phoneNumber, p.lid].filter(Boolean)) {
                    try {
                        if (areJidsSameUser(bJid, pJid)) return true;
                    } catch (_) {}
                }
            }
        }
    }
    return false;
}

function detectChannelForward(m, budy, body) {
    if (!m) return null;

    const rawText = String(budy || body || m.text || "").trim();
    if (rawText && CHANNEL_LINK_REGEX.test(rawText)) {
        const matched = rawText.match(CHANNEL_LINK_REGEX);
        return {
            reason: "channel_link_in_text",
            channelName: "Tautan Saluran WhatsApp",
            detail: matched ? matched[0] : rawText
        };
    }

    const msg = m.message || {};
    const newsletterMessageKeys = [
        "newsletterAdminInviteMessage",
        "newsletterFollowerInviteMessageV2",
        "newsletterAdminProfileMessage",
        "newsletterAdminProfileMessageV2",
        "newsletterAdminProfileStatusMessage"
    ];
    for (const key of newsletterMessageKeys) {
        if (msg[key] || m.msg?.[key]) {
            const inner = msg[key] || m.msg?.[key];
            return {
                reason: "newsletter_message_type",
                channelName: inner?.newsletterName || "Saluran WhatsApp",
                detail: key
            };
        }
    }

    const contextInfos = [];
    const directNewsletterHits = [];

    function scan(obj, depth = 0) {
        if (!obj || typeof obj !== "object" || depth > 8) return;

        for (const k of Object.keys(obj)) {
            if (k.toLowerCase().startsWith("newsletter") && obj[k] && typeof obj[k] === "object") {
                directNewsletterHits.push({ key: k, data: obj[k] });
            }
        }

        if (obj.contextInfo && typeof obj.contextInfo === "object") {
            contextInfos.push(obj.contextInfo);
        }

        if (obj.forwardedNewsletterMessageInfo && typeof obj.forwardedNewsletterMessageInfo === "object") {
            contextInfos.push({ forwardedNewsletterMessageInfo: obj.forwardedNewsletterMessageInfo });
        }

        for (const key of Object.keys(obj)) {
            const val = obj[key];
            if (val && typeof val === "object") {
                scan(val, depth + 1);
            }
        }
    }

    scan(m.message || m);
    if (m.msg?.contextInfo) contextInfos.push(m.msg.contextInfo);

    if (directNewsletterHits.length > 0) {
        const hit = directNewsletterHits[0];
        return {
            reason: `newsletter_type:${hit.key}`,
            channelName: hit.data?.newsletterName || "Saluran WhatsApp",
            detail: hit.key
        };
    }

    for (const ctx of contextInfos) {

        if (ctx.forwardedNewsletterMessageInfo && typeof ctx.forwardedNewsletterMessageInfo === "object") {
            const info = ctx.forwardedNewsletterMessageInfo;
            return {
                reason: "forwardedNewsletterMessageInfo",
                channelName: info.newsletterName || info.newsletterJid || "Saluran WhatsApp",
                newsletterJid: info.newsletterJid || null
            };
        }

        if (ctx.forwardOrigin === 3 || String(ctx.forwardOrigin).toUpperCase() === "CHANNELS") {
            return {
                reason: "forwardOrigin:CHANNELS",
                channelName: "Saluran WhatsApp",
                newsletterJid: null
            };
        }

        if (ctx.serverMessageId && (ctx.newsletterJid || ctx.isForwarded)) {
            return {
                reason: "serverMessageId_newsletter",
                channelName: "Saluran WhatsApp",
                newsletterJid: ctx.newsletterJid || null
            };
        }

        for (const [k, v] of Object.entries(ctx)) {
            if (typeof v === "string" && v.endsWith("@newsletter")) {
                return {
                    reason: `newsletter_jid:${k}`,
                    channelName: "Saluran WhatsApp",
                    newsletterJid: v
                };
            }
        }
    }

    return null;
}

async function menuReply(sock, m, context, title, lines) {
    const { botName, prefix, thumb } = context;
    try {
        const message = generateWAMessageFromContent(m.chat, {
            buttonsMessage: {
                buttons: [{
                    buttonId: `${prefix}antiforward on`,
                    buttonText: { displayText: "Aktifkan Grup Ini" },
                    type: 1
                }, {
                    buttonId: `${prefix}antiforward off`,
                    buttonText: { displayText: "Matikan Grup Ini" },
                    type: 1
                }],
                locationMessage: {
                    degreesLatitude: 0,
                    degreesLongitude: 0,
                    name: botName,
                    address: global.namaown || "WhatsApp Bot",
                    jpegThumbnail: thumb ? thumb.toString("base64") : ""
                },
                contentText: `\`「 ${botName} 」\``,
                footerText: `\`「 ${title} 」\`\n${lines.join("\n")}\n\n_*Pilih status fitur di bawah*_`,
                headerType: 6
            }
        }, { userJid: m.chat, upload: sock.waUploadToServer });
        return await sock.relayMessage(m.chat, message.message, { messageId: message.key.id });
    } catch (_) {
        const fallbackText = `\`「 ${title} 」\`\n${lines.join("\n")}`;
        return context.reply ? context.reply(fallbackText) : sock.sendMessage(m.chat, { text: fallbackText }, { quoted: m });
    }
}

module.exports = {
    name: "antiforward",
    category: "grup",
    command: ["antiforward", "antifoward", "antichannel"],
    moderation: true,
    group: true,
    description: "Deteksi dan hapus otomatis pesan terusan atau tautan dari Saluran / Channel WhatsApp (bisa kecualikan pengirim/saluran)",

    before: async (context) => {
        const { isGroup, m, sock, budy, body } = context;
        if (!isGroup || !m?.chat) return false;

        const state = readState();
        if (!isGroupEnabled(state, m.chat)) return false;

        const myJid = sock?.user?.id ? digitsOf(sock.user.id) : "";
        const senderJid = digitsOf(m.sender || m.key?.participant);
        if (m.key?.fromMe && myJid && senderJid === myJid) {
            if (m.key?.id?.startsWith("BAE5") || m.key?.id?.startsWith("Stenly")) return false;
        }

        const detection = detectChannelForward(m, budy, body);
        if (!detection) return false;

        const senderRaw = m.sender || m.key?.participant || m.participant;
        const senderLid = m.senderLid || m.key?.participantLid || (String(senderRaw || "").endsWith("@lid") ? senderRaw : null);
        const exemptInfo = Store.checkExempt(state, m.chat, {
            senderJid: senderRaw,
            senderLid,
            newsletterJid: detection.newsletterJid || null
        });
        if (exemptInfo.exempt) {
            console.log(`[ANTIFORWARD] Lewati ${m.chat}: ${exemptInfo.type} dikecualikan (scope ${exemptInfo.scope})`);
            return false;
        }

        const botIsAdmin = checkIsBotAdmin(context);
        if (!botIsAdmin) {
            console.log(`[ANTIFORWARD] Terdeteksi forward saluran di ${m.chat} (${detection.channelName}), batal hapus karena bot bukan admin.`);
            return false;
        }

        const isSenderAdmin = Boolean(context.isGroupAdmins || (Array.isArray(context.groupAdmins) && (
            context.groupAdmins.includes(m.sender) || context.groupAdmins.includes(m.key?.participant)
        )));
        if (isSenderAdmin) {
            console.log(`[ANTIFORWARD] Catatan: Pengirim ${m.sender} adalah Admin di ${m.chat}. WhatsApp server melarang admin menghapus pesan sesama admin.`);
        }

        console.log(`[ANTIFORWARD] Menghapus pesan saluran di ${m.chat} (${detection.channelName}) via ${detection.reason}`);

        try {
            await sock.sendMessage(m.chat, { delete: m.key });
            return true;
        } catch (e1) {
            try {
                const deleteKey = {
                    remoteJid: m.chat,
                    fromMe: Boolean(m.key?.fromMe),
                    id: m.key?.id,
                    participant: m.key?.participant || m.participant || m.sender
                };
                await sock.sendMessage(m.chat, { delete: deleteKey });
                return true;
            } catch (e2) {
                console.error(`[ANTIFORWARD] Gagal menghapus pesan di ${m.chat}: ${e2.message || e1.message}`);
                return false;
            }
        }
    },

    run: async (context) => {
        const { sock, m, args, isGroup, isGroupAdmins, isCreator, isOwner, prefix } = context;

        if (args[0] && args[0].toLowerCase() === "all") {
            if (!isCreator && !isOwner) {
                return context.reply("*Perintah 'all on/off' khusus untuk Owner bot.*");
            }
            const toggle = (args[1] || "").toLowerCase();
            if (toggle === "on" || toggle === "off") {
                const state = readState();
                state.enabled_all = toggle === "on";
                writeState(state);
                return menuReply(sock, m, context, "Anti-Forward Channel (Semua Grup)", [
                    `> Status Global : *${toggle === "on" ? "AKTIF DI SEMUA GRUP" : "MODE PER-GRUP (NONAKTIF)"}*`,
                    `> Keterangan : ${toggle === "on" ? "Semua grup otomatis terlindungi dari forward saluran WhatsApp." : "Proteksi hanya aktif di grup yang menyalakan fitur ini."}`
                ]);
            }
            return context.reply(`*Gunakan:* ${prefix}antiforward all on / off`);
        }

        if (!isGroup) return context.reply("*Command ini hanya bisa dipakai di grup.*");

        if (!isGroupAdmins && !isCreator && !isOwner) {
            return context.reply("*Fitur ini khusus untuk Admin Grup atau Owner Bot.*");
        }

        const action = String(args[0] || "").toLowerCase();
        const state = readState();

        const exemptActions = ["exempt", "unexempt", "exemptchannel", "unexemptchannel", "exemptlist"];
        if (exemptActions.includes(action)) {
            const target = args[1];
            const actor = isOwner || isCreator ? "owner" : (m.sender || m.key?.participant || "admin");

            if (action === "exemptlist") {
                const list = Store.listExempt(state, m.chat);
                const lines = [
                    `> Grup : *${context.groupName || m.chat}*`,
                    `> Pengecualian pengirim : *${list.senders.length}*`
                ];
                list.senders.slice(0, 10).forEach((e) => lines.push(`   • ${e.number || e.jid} — oleh ${e.addedBy}`));
                lines.push(`> Pengecualian saluran : *${list.channels.length}*`);
                list.channels.slice(0, 10).forEach((e) => lines.push(`   • ${e.name || e.jid}`));
                if (list.globalSenders.length || list.globalChannels.length) {
                    lines.push(`> Global : *${list.globalSenders.length} pengirim, ${list.globalChannels.length} saluran*`);
                }
                lines.push("");
                lines.push(`> *${prefix}antiforward exempt <nomor|jid>*`);
                lines.push(`> *${prefix}antiforward unexempt <nomor|jid>*`);
                lines.push(`> *${prefix}antiforward exemptchannel <jid@newsletter>*`);
                lines.push(`> *${prefix}antiforward unexemptchannel <jid@newsletter>*`);
                return menuReply(sock, m, context, "Pengecualian Anti-Forward", lines);
            }

            if (!target) return context.reply(`*Gunakan:* ${prefix}antiforward ${action} <target>`);

            try {
                if (action === "exempt" || action === "unexempt") {
                    const jid = String(target).includes("@") ? target : `${Store.digitsOf(target)}@s.whatsapp.net`;
                    if (!Store.digitsOf(target) && !String(target).includes("@")) {
                        return context.reply("*Target tidak valid. Pakai nomor (08xx/62xx) atau JID lengkap.*");
                    }
                    const res = action === "exempt"
                        ? Store.addSender(state, m.chat, { jid, number: target, addedBy: actor })
                        : Store.removeSender(state, m.chat, jid);
                    writeState(state);
                    if (action === "exempt" && res.alreadyExists) {
                        return context.reply(`*${target} sudah ada di daftar pengecualian grup ini.*`);
                    }
                    return menuReply(sock, m, context, "Pengecualian Anti-Forward", [
                        `> Target : *${target}*`,
                        `> Aksi : *${action === "exempt" ? "DITAMBAHKAN" : "DIHAPUS"}*`,
                        `> Grup : *${context.groupName || m.chat}*`,
                        `> Catatan : ${action === "exempt" ? "Pesan forward saluran dari target ini tidak akan dihapus di grup ini." : "Target ini kembali kena aturan anti-forward."}`
                    ]);
                }

                const channelJid = String(target);
                if (!channelJid.endsWith("@newsletter")) {
                    return context.reply("*Target saluran wajib JID berakhiran @newsletter.*");
                }
                const res = action === "exemptchannel"
                    ? Store.addChannel(state, m.chat, { jid: channelJid, addedBy: actor })
                    : Store.removeChannel(state, m.chat, channelJid);
                writeState(state);
                if (action === "exemptchannel" && res.alreadyExists) {
                    return context.reply(`*${channelJid} sudah ada di daftar pengecualian saluran grup ini.*`);
                }
                return menuReply(sock, m, context, "Pengecualian Anti-Forward", [
                    `> Saluran : *${channelJid}*`,
                    `> Aksi : *${action === "exemptchannel" ? "DITAMBAHKAN" : "DIHAPUS"}*`,
                    `> Grup : *${context.groupName || m.chat}*`,
                    `> Catatan : ${action === "exemptchannel" ? "Semua forward dari saluran ini dibiarkan di grup ini." : "Saluran ini kembali diblok."}`
                ]);
            } catch (err) {
                return context.reply(`*Gagal:* ${err.message}${err.code ? ` (${err.code})` : ""}`);
            }
        }

        if (action === "status" || !["on", "off"].includes(action)) {
            const current = isGroupEnabled(state, m.chat) ? "Aktif" : "Nonaktif";
            return menuReply(sock, m, context, "Anti-Forward Channel Status", [
                `> Status Grup Ini : *${current}*`,
                `> Mode Semua Grup : *${state.enabled_all ? "ON (Semua Grup)" : "OFF"}*`,
                `> Pengecualian : *${Store.listExempt(state, m.chat).senders.length} pengirim, ${Store.listExempt(state, m.chat).channels.length} saluran*`,
                "",
                "*Pilihan Pengaturan:*",
                `> *${prefix}antiforward on* - Aktifkan di grup ini`,
                `> *${prefix}antiforward off* - Matikan di grup ini`,
                isCreator || isOwner ? `> *${prefix}antiforward all on/off* - Mode semua grup (Owner)` : ""
            ].filter(Boolean));
        }

        const botIsAdmin = checkIsBotAdmin(context);
        if (action === "on" && !botIsAdmin) {
            return menuReply(sock, m, context, "Anti-Forward Channel", [
                "> Status : *Gagal Diaktifkan*",
                "> Penyebab : *Bot belum menjadi Admin di grup ini*",
                "> Solusi : *Jadikan bot sebagai admin grup terlebih dahulu*"
            ]);
        }

        if (!state.groups) state.groups = {};
        state.groups[m.chat] = {
            enabled: action === "on",
            updatedAt: new Date().toISOString()
        };
        writeState(state);

        return menuReply(sock, m, context, "Anti-Forward Channel", [
            `> Grup : *${context.groupName || m.chat}*`,
            `> Status : *${action === "on" ? "AKTIF" : "NONAKTIF"}*`,
            `> Keterangan : Pesan terusan saluran & tautan channel WhatsApp akan ${action === "on" ? "*dihapus otomatis*" : "*dibiarkan*"}`
        ]);
    }
};
