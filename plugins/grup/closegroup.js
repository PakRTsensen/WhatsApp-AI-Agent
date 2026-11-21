const { generateWAMessageFromContent } = require("@itsliaaa/baileys");

async function menuReply(sock, m, context, title, lines) {
    const { botName, prefix, thumb } = context;
    const message = generateWAMessageFromContent(m.chat, {
        buttonsMessage: {
            buttons: [{
                buttonId: `${prefix}closegroup`,
                buttonText: { displayText: "Tutup" },
                type: 1
            }, {
                buttonId: `${prefix}opengroup`,
                buttonText: { displayText: "Buka" },
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
            footerText: `\`「 ${title} 」\`\n${lines.join("\n")}\n\n_*Tekan tombol di bawah*_`,
            headerType: 6
        }
    }, { userJid: m.chat, upload: sock.waUploadToServer });
    return sock.relayMessage(m.chat, message.message, { messageId: message.key.id });
}

function digitsOf(jid) {
    if (!jid) return "";
    // Buang suffix device ":xx@", ambil user, sisakan digit
    return String(jid).replace(/:\d+(?=@)/, "").split("@")[0].replace(/[^0-9]/g, "");
}

function collectIds(...jids) {
    const out = new Set();
    for (const j of jids) {
        const d = digitsOf(j);
        if (d) out.add(d);
    }
    return out;
}

function findBotEntry(context) {
    const { sock, participants, botNumber } = context;
    const botIds = collectIds(botNumber, sock.user?.id, sock.user?.lid);
    let sameUser = null;
    try {
        const { areJidsSameUser } = require("@itsliaaa/baileys");
        sameUser = (a, b) => { try { return !!a && !!b && areJidsSameUser(a, b); } catch (_) { return false; } };
    } catch (_) {}
    const botJids = [botNumber, sock.user?.id, sock.user?.lid].filter(Boolean);
    for (const p of (participants || [])) {
        const pJids = [p.id, p.phoneNumber, p.lid].filter(Boolean);

        const pIds = collectIds(...pJids);
        for (const d of pIds) {
            if (botIds.has(d)) return { me: p, via: "digit:" + d };
        }

        if (sameUser) {
            for (const a of pJids) {
                for (const b of botJids) {
                    if (sameUser(a, b)) return { me: p, via: "jid:" + a };
                }
            }
        }
    }
    return { me: null, via: null, botIds: [...botIds] };
}

function getBotRole(context) {
    const { groupMetadata, sock } = context;
    const found = findBotEntry(context);
    if (!found.me) return { role: "anggota", detail: "tidak ketemu di daftar peserta", found };
    const me = found.me;
    const owner = groupMetadata?.owner || "";
    const ownerIds = collectIds(owner, groupMetadata?.ownerPn);
    const meIds = collectIds(me.id, me.phoneNumber, me.lid);
    const isOwner = [...meIds].some(d => ownerIds.has(d));
    if (me.admin === "superadmin" || isOwner) return { role: "owner grup", detail: found.via, found };
    if (me.admin) return { role: String(me.admin), detail: found.via, found };
    return { role: "anggota", detail: found.via + " | admin field null", found };
}

async function safeMenuReply(sock, m, context, title, lines) {
    try {
        return await menuReply(sock, m, context, title, lines);
    } catch (e) {

        const body = `「 ${title} 」\n` + lines.join("\n");
        try {
            return await sock.sendMessage(m.chat, { text: body }, { quoted: m });
        } catch (_) {
            return await context.reply(body);
        }
    }
}

async function setGroupMode(sock, chat, mode) {

    if (typeof sock.groupSettingUpdate === "function") {
        await sock.groupSettingUpdate(chat, mode);
    } else if (typeof sock.query === "function") {

        await sock.query({
            tag: "iq",
            attrs: { type: "set", xmlns: "w:g2", to: chat },
            content: [{ tag: mode, attrs: {} }]
        });
    } else {

        const keys = sock ? Object.keys(sock).filter(k => /group|query|setting/i.test(k)) : [];
        throw new Error("sock tidak punya groupSettingUpdate/query (typeof groupSettingUpdate=" +
            typeof sock?.groupSettingUpdate + ", typeof query=" + typeof sock?.query +
            ", kunci mirip: [" + keys.join(",") + "])");
    }

    try {
        await new Promise(r => setTimeout(r, 1500));
        const meta = await sock.groupMetadata(chat);
        const wantClosed = mode === "announcement";
        if (meta && typeof meta.announce === "boolean" && meta.announce !== wantClosed) {
            throw new Error("verifikasi gagal: status grup tidak berubah (metadata announce=" + meta.announce + ")");
        }
        return meta;
    } catch (e) {
        if (e.message && e.message.startsWith("verifikasi gagal")) throw e;
        return null;
    }
}

module.exports = {
    name: "closegroup",
    category: "grup",
    command: ["closegroup", "tutupgrup", "opengroup", "bukagrup", "infogrup"],
    owner: true,
    group: true,
    description: "Tutup/buka grup + info jabatan bot (khusus owner)",
    run: async context => {
        const { sock, m, command, isGroup, isBotAdmins, groupName } = context;
        try {
        if (!isGroup) return context.reply("*Command ini hanya bisa dipakai di grup.*");

        const info = getBotRole(context);
        const role = info.role;
        const cmd = command.toLowerCase();

        const botIsAdmin = isBotAdmins || role === "admin" || role === "owner grup" || role === "superadmin";

        if (cmd === "infogrup") {
            const me = info.found?.me;
            return safeMenuReply(sock, m, context, "Info Grup", [
                `> Grup : *${groupName || m.chat}*`,
                `> Jabatan bot : *${role}*`,
                `> Cocok via : *${info.detail || "-"}*`,
                `> Entri ketemu : *${me ? `${me.id}${me.admin ? " (" + me.admin + ")" : ""}` : "tidak ada"}*`,
                `> Bot admin (core) : *${isBotAdmins ? "Ya" : "Tidak"}*`,
                `> Bot admin (final) : *${botIsAdmin ? "Ya" : "Tidak"}*`
            ]);
        }

        const closing = cmd === "closegroup" || cmd === "tutupgrup";
        if (!botIsAdmin) {
            return safeMenuReply(sock, m, context, closing ? "Tutup Grup" : "Buka Grup", [
                `> Status : *Gagal*`,
                `> Jabatan bot : *${role}*`,
                `> Bot bukan admin di grup ini`,
                `> Jadikan bot admin terlebih dahulu`
            ]);
        }

        try {
            await setGroupMode(sock, m.chat, closing ? "announcement" : "not_announcement");
        } catch (e) {
            return safeMenuReply(sock, m, context, closing ? "Tutup Grup" : "Buka Grup", [
                `> Status : *Gagal (${e.message})*`,
                `> Jabatan bot : *${role}*`
            ]);
        }

        return safeMenuReply(sock, m, context, closing ? "Tutup Grup" : "Buka Grup", [
            `> Grup : *${groupName || m.chat}*`,
            `> Jabatan bot : *${role}*`,
            `> Status : *${closing ? "Ditutup, hanya admin bisa kirim" : "Dibuka, semua anggota bisa kirim"}*`
        ]);
        } catch (e) {

            try { await context.reply(`*Gagal: ${e.message}*`); } catch (_) {}
        }
    }
};
