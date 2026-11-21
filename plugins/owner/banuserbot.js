const fs = require("fs");
const path = require("path");
const { generateWAMessageFromContent } = require("@itsliaaa/baileys");
const { categorySections } = require("../../lib/menu");
const {
    isBotBanned,
    banBotUser,
    unbanBotUser,
    getBotBannedList,
    cleanNumber,
    normalizeJid,
    resolveLidToPnFile,
    resolvePnToLidFile
} = require("../../lib/banned_bot");

function makeButtons(prefix, plugins) {
    return [
        {
            buttonId: "allmenu",
            buttonText: { displayText: "Pilih Menu" },
            nativeFlowInfo: {
                name: "single_select",
                paramsJson: JSON.stringify({
                    title: "Pilih Kategori Menu",
                    sections: categorySections(plugins, prefix)
                })
            },
            type: 1
        },
        {
            buttonId: `${prefix}owner`,
            buttonText: { displayText: "Owner" },
            type: 1
        }
    ];
}

async function sendMenuStyle(sock, m, ctx, title, lines) {
    const { botName, prefix, thumb, plugins } = ctx;
    const contentText = `\`「 ${botName} 」\``;
    const footerText = `\`「 ${title} 」\`\n${lines.join('\n')}\n\n_*Tekan tombol di bawah untuk melihat semua menu*_`;

    try {
        const menuMessage = generateWAMessageFromContent(m.chat, {
            buttonsMessage: {
                buttons: makeButtons(prefix, plugins),
                locationMessage: {
                    degreesLatitude: 0,
                    degreesLongitude: 0,
                    name: botName,
                    address: global.namaown || "WhatsApp Bot",
                    jpegThumbnail: thumb ? thumb.toString('base64') : ''
                },
                contentText,
                footerText,
                headerType: 6
            }
        }, { userJid: m.chat, upload: sock.waUploadToServer });

        return await sock.relayMessage(m.chat, menuMessage.message, { messageId: menuMessage.key.id });
    } catch (_) {
        return ctx.reply(`${contentText}\n\n${footerText}`);
    }
}

async function resolveTargetUser(sock, m, args, groupMetadata) {
    // 1. Dari Reply Pesan (Quoted)
    if (m.quoted) {
        const qSender = m.quoted.sender || m.quoted.key?.participant || m.msg?.contextInfo?.participant;
        if (qSender) return qSender;
    }

    // 2. Dari Mention (@user)
    const mentioned = [
        ...(Array.isArray(m?.mentionedJid) ? m.mentionedJid : []),
        ...(Array.isArray(m?.msg?.contextInfo?.mentionedJid) ? m.msg.contextInfo.mentionedJid : []),
        ...(Array.isArray(m?.message?.extendedTextMessage?.contextInfo?.mentionedJid) ? m.message.extendedTextMessage.contextInfo.mentionedJid : [])
    ];
    if (mentioned.length) return mentioned[0];

    // 3. Dari Argumen teks (Nomor / JID)
    if (args && args[0]) {
        return args[0];
    }

    return null;
}

async function handleBanBotCommand(context) {
    const { sock, m, args, prefix, isOwner, isCreator, reply, groupMetadata } = context;

    if (!isOwner && !isCreator) {
        return sendMenuStyle(sock, m, context, "Akses Ditolak", [
            "> Status : *Akses Ditolak*",
            "> Fitur banuserbot khusus untuk Owner bot."
        ]);
    }

    const rawCmd = (context.command || "").toLowerCase();
    const actionArg = (args[0] || "").toLowerCase();

    // 1. Tampilkan List jika command listbanbot atau argumen list
    if (rawCmd === "listbanbot" || rawCmd === "listbannedbot" || actionArg === "list") {
        const list = getBotBannedList();
        if (!list.length) {
            return sendMenuStyle(sock, m, context, "Daftar Banned Bot", [
                "> Status : *Tidak ada user yang di-ban*",
                "> Semua user bebas berinteraksi dengan bot."
            ]);
        }

        const lines = [
            `> Total User Di-ban : *${list.length} orang*`,
            "",
            "*Daftar User Terblokir Total dari Bot:*",
            "-----------------------------------"
        ];

        for (let i = 0; i < list.length; i++) {
            const u = list[i];
            const num = u.number ? `+${u.number}` : u.jid;
            lines.push(`*${i + 1}. ${num}*`);
            lines.push(`   • JID: \`${u.jid}\``);
            lines.push(`   • Waktu: ${new Date(u.banned_at).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB`);
            lines.push("");
        }

        lines.push("-----------------------------------");
        lines.push(`Buka blokir dengan: *${prefix}unbanuserbot <nomor/mention/reply>*`);

        return sendMenuStyle(sock, m, context, "Daftar Banned Bot", lines);
    }

    if (rawCmd === "unbanuserbot" || rawCmd === "unbanbot" || actionArg === "unban") {
        const effectiveArgs = actionArg === "unban" ? args.slice(1) : args;
        let target = await resolveTargetUser(sock, m, effectiveArgs, groupMetadata);

        if (!target) {
            return reply(`Format salah. Gunakan:\n*${prefix}unbanuserbot <nomor/mention/reply>*`);
        }

        if (target.endsWith("@lid") && sock?.signalRepository?.lidMapping?.getPNForLID) {
            try {
                const pn = await sock.signalRepository.lidMapping.getPNForLID(target);
                if (pn) target = pn;
            } catch (_) {}
        }

        const unbanned = unbanBotUser(target);
        if (unbanned) {
            const num = cleanNumber(target);
            return sendMenuStyle(sock, m, context, "User Dibebaskan", [
                `> Status : *SUKSES DIBUKA (UNBANNED)*`,
                `> Target : *+${num || target}*`,
                `> JID : \`${target}\``,
                "",
                `Bot sekarang akan kembali merespons interaksi dari orang ini.`
            ]);
        } else {
            return reply(`User tersebut tidak ditemukan dalam daftar banned bot.`);
        }
    }

    // 3. Command Ban (/banuserbot atau .banuserbot)
    let target = await resolveTargetUser(sock, m, args, groupMetadata);

    if (!target) {
        return sendMenuStyle(sock, m, context, "Ban User Bot", [
            "*Cara Penggunaan:*",
            `> *${prefix}banuserbot 628xxx* (Berdasarkan nomor)`,
            `> *${prefix}banuserbot @user* (Mention orangnya)`,
            `> *${prefix}banuserbot* (Reply pesan orangnya)`,
            "",
            `> *${prefix}unbanuserbot* (Buka blokir)`,
            `> *${prefix}listbanbot* (Lihat daftar banned)`,
            "",
            "*Keterangan:*",
            "User yang di-ban TIDAK akan direspon sama sekali oleh bot, termasuk command statis maupun agent, selamanya di semua grup maupun private chat."
        ]);
    }

    // Resolusi mendalam LID <-> Phone Number
    let targetLid = "";
    let targetPn = "";

    if (target.endsWith("@lid")) {
        targetLid = target;
        const foundPn = resolveLidToPnFile(target);
        if (foundPn) targetPn = `${foundPn}@s.whatsapp.net`;
        if (!targetPn && sock?.signalRepository?.lidMapping?.getPNForLID) {
            try {
                const pn = await sock.signalRepository.lidMapping.getPNForLID(target);
                if (pn) targetPn = pn;
            } catch (_) {}
        }
    } else {
        targetPn = normalizeJid(target);
        const foundLid = resolvePnToLidFile(target);
        if (foundLid) targetLid = `${foundLid}@lid`;
        if (!targetLid && sock?.signalRepository?.lidMapping?.getLIDForPN) {
            try {
                const lid = await sock.signalRepository.lidMapping.getLIDForPN(targetPn);
                if (lid) targetLid = lid;
            } catch (_) {}
        }
    }

    const targetNum = cleanNumber(targetPn || target);
    const targetLidNum = cleanNumber(targetLid);

    const botJid = sock.user?.id ? normalizeJid(sock.user.id) : "";
    const isOwnerTarget = (global.owner || []).some(o => cleanNumber(o) === targetNum || (targetLidNum && cleanNumber(o) === targetLidNum));
    if (isOwnerTarget || cleanNumber(botJid) === targetNum) {
        return reply(`❌ Tidak dapat memblokir nomor Owner atau nomor Bot sendiri.`);
    }

    const success = banBotUser(targetPn || target, {
        number: targetNum,
        lid: targetLid || undefined,
        lid_number: targetLidNum || undefined,
        banned_by: m.sender || 'owner',
        reason: 'Permanent total bot ban by owner'
    });

    if (success) {
        const displayJid = targetPn || target;
        return sendMenuStyle(sock, m, context, "User Berhasil Di-Ban", [
            `> Status : *PERMANENT BANNED*`,
            `> Nomor  : *+${targetNum || cleanNumber(target)}*`,
            `> JID PN : \`${displayJid}\``,
            targetLid ? `> JID LID: \`${targetLid}\`` : "",
            "",
            `Bot TIDAK AKAN PERNAH merespons chat dari orang ini selamanya, termasuk semua command statis maupun agent, di semua grup maupun private chat.`,
            "",
            `Buka blokir kapan saja dengan: *${prefix}unbanuserbot ${targetNum || cleanNumber(target)}*`
        ].filter(Boolean));
    } else {
        return reply(`User tersebut sudah berada dalam daftar banned bot.`);
    }
}

module.exports = {
    name: "banuserbot",
    category: "owner",
    command: ["banuserbot", "banbot", "botban", "unbanuserbot", "unbanbot", "listbanbot", "listbannedbot"],
    owner: true,
    description: "Blokir user agar tidak direspon sama sekali oleh bot termasuk command statis (Reply, Mention, atau Nomor)",
    before: async (context) => {
        const { body, prefix } = context;
        const bodyTrim = (body || "").trim();
        if (!bodyTrim) return false;

        const firstWord = bodyTrim.split(/\s+/)[0].toLowerCase();
        const validTriggers = [
            ".banuserbot", ".banbot", ".botban",
            ".unbanuserbot", ".unbanbot", ".listbanbot", ".listbannedbot",
            `${prefix}banuserbot`, `${prefix}banbot`, `${prefix}botban`,
            `${prefix}unbanuserbot`, `${prefix}unbanbot`, `${prefix}listbanbot`, `${prefix}listbannedbot`
        ];

        if (validTriggers.includes(firstWord)) {
            const parts = bodyTrim.split(/\s+/);
            const cmdWord = parts.shift().toLowerCase().replace(/^[./!#$]/, "");
            context.command = cmdWord;
            context.args = parts;
            context.text = parts.join(" ");
            context.q = context.text;
            await handleBanBotCommand(context);
            return true;
        }
        return false;
    },
    run: async (context) => {
        await handleBanBotCommand(context);
    }
};
