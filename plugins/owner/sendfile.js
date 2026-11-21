const fs = require("fs");
const path = require("path");
const { generateWAMessageFromContent } = require("@itsliaaa/baileys");

const ALIAS = {};

const ALLOWED_DIRS = ["/root", "/LlamaAgentHermes"];
const BLOCKED_PARTS = ["/session", "/session_backup_", "/.pm2/", "/.hermes/state.db"];
const MAX_BYTES = 15 * 1024 * 1024;

function menuReply(sock, m, ctx, title, lines) {
    const { botName, prefix, thumb } = ctx;
    const message = generateWAMessageFromContent(m.chat, {
        buttonsMessage: {
            buttons: [{
                buttonId: "allmenu",
                buttonText: { displayText: "Pilih Menu" },
                nativeFlowInfo: {
                    name: "single_select",
                    paramsJson: JSON.stringify({
                        title: "Pilih Kategori Menu",
                        sections: [{ title: "Pilihan Menu", rows: [{ title: "Owner Menu", description: "Lihat daftar fitur owner", id: `${prefix}menu owner` }] }]
                    })
                },
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
            footerText: `\`「 ${title} 」\`\n${lines.join("\n")}\n\n_*Tekan tombol di bawah untuk melihat semua menu*_`,
            headerType: 6
        }
    }, { userJid: m.chat, upload: sock.waUploadToServer });
    return sock.relayMessage(m.chat, message.message, { messageId: message.key.id });
}

function resolveTarget(arg) {
    if (!arg) return null;
    const clean = String(arg).trim();
    if (ALIAS[clean]) return ALIAS[clean];
    const p = path.resolve(clean);
    if (!ALLOWED_DIRS.some(d => p === d || p.startsWith(d + "/"))) return { err: "Path di luar area izin (/root, /LlamaAgentHermes)." };
    if (BLOCKED_PARTS.some(b => p.includes(b))) return { err: "Path kredensial/session diblokir." };
    if (path.extname(p).toLowerCase() !== ".js") return { err: "Hanya file .js yang boleh dikirim." };
    return p;
}

module.exports = {
    name: "sendfile",
    category: "owner",
    command: ["sendfile", "getfile", "kirimfile"],
    owner: true,
    description: "Kirim file .js sebagai dokumen (owner only)",
    run: async (context) => {
        const { sock, m, args, prefix, isCreator, isOwner, botName } = context;
        if (!isCreator && !isOwner) return context.reply("*khusus owner*");
        const target = resolveTarget(args[0]);

        if (!target) {
            const files = Object.entries(ALIAS).map(([k, v]) => {
                let size = "-";
                try { size = (fs.statSync(v).size / 1024).toFixed(1) + " KB"; } catch (_) {}
                return `> *${prefix}sendfile ${k}* (${size})`;
            });
            return menuReply(sock, m, context, "Send File", [
                `> Bot : *${botName}*`,
                "",
                "*File siap kirim:*",
                ...files,
                "",
                "*Bebas path:*",
                `> *${prefix}sendfile /root/namafile.js*`,
                "_(.js saja, maks 15 MB)_",
            ]);
        }
        if (typeof target === "object" && target.err) return context.reply(`*${target.err}*`);
        if (!fs.existsSync(target)) return context.reply(`*File tidak ditemukan: ${target}*`);

        const stat = fs.statSync(target);
        if (!stat.isFile()) return context.reply("*Bukan file.*");
        if (stat.size > MAX_BYTES) return context.reply(`*File kebesaran (${(stat.size / 1024 / 1024).toFixed(1)} MB, maks 15 MB).*`);
        if (stat.size === 0) return context.reply("*File kosong.*");

        try {
            await sock.sendMessage(m.chat, {
                document: fs.readFileSync(target),
                fileName: path.basename(target),
                mimetype: "text/javascript",
                caption: `\`「 ${botName} 」\`\n> File : *${path.basename(target)}*\n> Size : *${(stat.size / 1024).toFixed(1)} KB*`,
            }, { quoted: m });
        } catch (e) {
            return context.reply(`*Gagal kirim file: ${e.message}*`);
        }
    },
};
