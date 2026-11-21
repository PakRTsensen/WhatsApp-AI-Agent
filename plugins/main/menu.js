const { generateWAMessageFromContent } = require("@itsliaaa/baileys");

module.exports = {
    name: "menu",
    category: "main",
    command: ["menu", "allmenu", /.+menu$/i],
    description: "Tampilkan menu bot WhatsApp berdasarkan kategori plugins",
    run: async (context) => {
        const {
            sock,
            m,
            command,
            args,
            botName,
            botVersion,
            botDev,
            prefix,
            runtime,
            memoryUsage,
            thumb,
            plugins
        } = context;

        const categories = plugins ? plugins.getCategories() : {};
        const catKeys = Object.keys(categories).sort((a, b) => {
            if (a === 'main') return -1;
            if (b === 'main') return 1;
            if (a === 'owner') return 1;
            if (b === 'owner') return -1;
            return a.localeCompare(b);
        });

        const categoryRows = catKeys.map(cat => {
            const label = cat.charAt(0).toUpperCase() + cat.slice(1) + " Menu";
            return {
                header: "",
                title: label,
                description: `Lihat daftar fitur ${cat}`,
                id: `${prefix}menu ${cat}`
            };
        });

        const commandSections = [
            {
                title: "Pilihan Menu Plugins",
                rows: categoryRows
            }
        ];

        let selectedCat = null;
        if (args && args[0] && categories[args[0].toLowerCase()]) {
            selectedCat = args[0].toLowerCase();
        } else if (command && command.endsWith("menu") && command !== "menu" && command !== "allmenu") {
            const potentialCat = command.replace(/menu$/, '').toLowerCase();
            if (categories[potentialCat]) {
                selectedCat = potentialCat;
            }
        }

        const makeMenuButtons = () => [
            {
                buttonId: "allmenu",
                buttonText: {
                    displayText: "Pilih Menu"
                },
                nativeFlowInfo: {
                    name: "single_select",
                    paramsJson: JSON.stringify({
                        title: "Pilih Kategori Menu",
                        sections: commandSections
                    })
                },
                type: 1
            },
            {
                buttonId: `${prefix}owner`,
                buttonText: {
                    displayText: "Owner"
                },
                type: 1
            }
        ];

        if (selectedCat) {
            const catFormatted = selectedCat.charAt(0).toUpperCase() + selectedCat.slice(1) + "menu";
            const cmds = categories[selectedCat] || [];
            const cmdLines = cmds.map(c => `> ${prefix}${c}`).join('\n');

            const contentText = `\`「 ${botName} 」\``;
            const footerText = `\`「 ${catFormatted} 」\`
${cmdLines}

_*Tekan tombol di bawah untuk melihat semua menu*_`;

            const menuMessage = generateWAMessageFromContent(m.chat, {
                buttonsMessage: {
                    buttons: makeMenuButtons(),
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

            try {
                const result = await sock.sendMessage(m.chat, {
                    text: `${contentText}\n\n${footerText}`
                }, { quoted: m });
                console.log(`[MENU TEXT SENT] chat=${m.chat} messageId=${result?.key?.id || 'unknown'}`);
                return result;
            } catch (error) {
                console.error(`[MENU TEXT ERROR] chat=${m.chat}:`, error?.stack || error);
                try {
                    const fallback = await sock.relayMessage(m.chat, menuMessage.message, { messageId: menuMessage.key.id });
                    console.log(`[MENU BUTTON FALLBACK SENT] chat=${m.chat} id=${menuMessage.key.id}`);
                    return fallback;
                } catch (fallbackError) {
                    console.error(`[MENU TEXT FALLBACK ERROR] chat=${m.chat}:`, fallbackError?.stack || fallbackError);
                    throw fallbackError;
                }
            }
        }

        const totalCmds = plugins ? plugins.countCommands() : (global.totalcmd || 8);
        const totalCats = catKeys.length || (global.botcategory || 1);

        const contentText = `\`「 ${botName} 」\``;
        const footerText = `\`「 Info bot 」\`
> Nama : *${botName}*
> Versi : *${botVersion}*
> Dev : *${botDev}*
> Prefix : *${prefix}*
> Mode : *${sock.public ? "Public" : "Self"}*
> Uptime : *${runtime(process.uptime())}*
> RAM : *${memoryUsage}*
> Kategori : *${totalCats}*
> Total Cmd : *${totalCmds}*

_*Tekan tombol di bawah untuk melihat semua menu*_`;

        const menuMessage = generateWAMessageFromContent(m.chat, {
            buttonsMessage: {
                buttons: makeMenuButtons(),
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

        try {
            const result = await sock.sendMessage(m.chat, { text: `${contentText}\n\n${footerText}` }, { quoted: m });
            console.log(`[MENU TEXT SENT] chat=${m.chat} messageId=${result?.key?.id || 'unknown'}`);
            return result;
        } catch (error) {
            console.error(`[MENU TEXT ERROR] chat=${m.chat}:`, error?.stack || error);
            try {
                const fallback = await sock.relayMessage(m.chat, menuMessage.message, { messageId: menuMessage.key.id });
                console.log(`[MENU BUTTON FALLBACK SENT] chat=${m.chat} id=${menuMessage.key.id}`);
                return fallback;
            } catch (fallbackError) {
                console.error(`[MENU TEXT FALLBACK ERROR] chat=${m.chat}:`, fallbackError?.stack || fallbackError);
                throw fallbackError;
            }
        }
    }
};
