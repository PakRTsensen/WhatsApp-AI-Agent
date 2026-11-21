const { generateWAMessageFromContent, downloadContentFromMessage } = require("@itsliaaa/baileys");
const sharp = require("sharp");
const { categorySections } = require("../../lib/menu");

async function streamToBuffer(stream) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
}

async function upscaleBuffer(buffer, scale = "2", type = "0") {
    const normalized = await sharp(buffer).jpeg({ quality: 95 }).toBuffer();
    const username = Math.random().toString(36).substring(2, 10) + "_aiimglarger";
    const form = new FormData();
    form.append("file", new Blob([normalized], { type: "image/jpeg" }), "input.jpg");
    form.append("type", String(type));
    form.append("username", username);
    if (String(type) === "0" || String(type) === "13") {
        form.append("scaleRadio", String(scale));
    }

    const upRes = await fetch("https://photoai.imglarger.com/api/PhoAi/Upload", {
        method: "POST",
        headers: { "User-Agent": "Dart/3.5 (dart:io)" },
        body: form,
        signal: AbortSignal.timeout(60000)
    });
    const upText = await upRes.text();
    let upJson;
    try {
        upJson = JSON.parse(upText);
    } catch {
        throw new Error("Gagal mengunggah ke server enhancer (respons tidak valid)");
    }
    if (!upJson.data?.code) {
        throw new Error(upJson.msg || "Gagal mengunggah gambar ke server HD enhancer");
    }
    const code = upJson.data.code;

    for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 2000));
        try {
            const checkRes = await fetch("https://photoai.imglarger.com/api/PhoAi/CheckStatus", {
                method: "POST",
                headers: {
                    "User-Agent": "Dart/3.5 (dart:io)",
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    code: code,
                    type: parseInt(type, 10),
                    username: username,
                    ...(String(type) === "0" || String(type) === "13" ? { scaleRadio: String(scale) } : {})
                }),
                signal: AbortSignal.timeout(30000)
            });
            const checkText = await checkRes.text();
            const checkJson = JSON.parse(checkText);
            if (checkJson.data?.status === "success" && checkJson.data.downloadUrls?.length) {
                return {
                    ok: true,
                    result_url: checkJson.data.downloadUrls[0],
                    via: "StenlyAPI-Hub",
                    scale: `${scale}x`
                };
            }
        } catch {

        }
    }
    throw new Error("Proses penjernihan gambar timeout");
}

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
    return sock.relayMessage(m.chat, menuMessage.message, { messageId: menuMessage.key.id });
}

module.exports = {
    name: "hd",
    category: "tools",
    command: ["hd", "remini", "upscale"],
    description: "Upscale & jernihkan gambar via StenlyAPI-Hub",
    run: async (context) => {
        const { sock, m, args, prefix, mime, qmsg, botName, reply } = context;

        let scale = "2";
        if (args.includes("8")) scale = "8";
        else if (args.includes("4")) scale = "4";

        let type = "0";
        if (args.includes("deblur") || args.includes("retouch") || args.includes("face")) type = "3";
        else if (args.includes("color") || args.includes("enhance")) type = "2";
        else if (args.includes("sharpen")) type = "1";

        const inputUrl = args.find(value => /^https?:\/\//i.test(value));
        const hasImageMessage = m.mtype === "imageMessage" && m.msg;
        const hasQuotedImage = qmsg && /image\//i.test(mime || "");

        if (!inputUrl && !hasImageMessage && !hasQuotedImage) {
            return sendMenuStyle(sock, m, context, "HD Tools", [
                `> Cara pakai : *${prefix}hd [2|4|8]*`,
                `> Reply gambar dengan *${prefix}hd*`,
                `> URL : *${prefix}hd https://contoh.com/foto.jpg*`,
                `> Contoh : *${prefix}hd 4* (upscale 4x)`,
                `> Mode lain : *${prefix}hd deblur* / *${prefix}hd enhance*`
            ]);
        }

        const modeLabel = type === "3" ? "Face Retouch / Deblur" : type === "2" ? "Color & Contrast" : type === "1" ? "Sharpen" : `${scale}x HD Upscale`;

        await sendMenuStyle(sock, m, context, "HD Proses", [
            `> Mode : *${modeLabel}*`,
            `> Engine : *StenlyAPI-Hub*`,
            `> Status : *Memproses penjernihan gambar...*`
        ]);

        try {
            let imageBuffer;
            if (inputUrl) {
                const res = await fetch(inputUrl, {
                    headers: { "User-Agent": "Mozilla/5.0" },
                    signal: AbortSignal.timeout(30000)
                });
                if (!res.ok) throw new Error(`Gagal mengunduh gambar dari URL (${res.status})`);
                imageBuffer = Buffer.from(await res.arrayBuffer());
            } else {
                const imageMessage = hasImageMessage ? m.msg : qmsg;
                const stream = await downloadContentFromMessage(imageMessage, "image");
                imageBuffer = await streamToBuffer(stream);
            }

            if (!imageBuffer || !imageBuffer.length) throw new Error("Media gambar kosong");

            const result = await upscaleBuffer(imageBuffer, scale, type);
            const resultUrl = result.result_url;
            if (!resultUrl) return reply(`*Respons API tidak valid.*`);

            const dl = await fetch(resultUrl, { signal: AbortSignal.timeout(60000) });
            if (!dl.ok) return reply(`*Gagal mengunduh hasil penjernihan.*`);
            const outBuf = Buffer.from(await dl.arrayBuffer());

            const caption = `\`「 ${botName} 」\`\n\`「 HD Result 」\`\n> Mode : *${modeLabel}*\n> Status : *Berhasil Dijernihkan*\n> Engine : *${result.via}*\n\n_*Tekan tombol di bawah untuk melihat semua menu*_`;
            return await sock.sendMessage(m.chat, { image: outBuf, caption }, { quoted: m });
        } catch (e) {
            console.error(e);
            return reply(`*Gagal memproses gambar: ${e.message}*`);
        }
    }
};
