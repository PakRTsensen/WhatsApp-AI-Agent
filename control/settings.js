const ownerFromEnv = String(process.env.BOT_OWNER_NUMBERS || '')
    .split(',')
    .map(value => value.replace(/\D/g, ''))
    .filter(Boolean);

global.namaown = process.env.BOT_DISPLAY_NAME || "Stenly WhatsApp BotSimple"
global.prefix = process.env.BOT_PREFIX || "/"
global.botname = process.env.BOT_NAME || "Stenly WhatsApp Bot"
global.botversion = "v1.0"
global.botdev = process.env.BOT_DEVELOPER || "Stenly Christian"
global.botcategory = 1
global.totalcmd = 8
global.owner = ownerFromEnv
global.botNumber = String(process.env.BOT_NUMBER || '').replace(/\D/g, '')
global.session = "sessions"

global.samp = {
    domain: "https://publik.pterokudesu.web.id",
    pltc: process.env.SAMP_PANEL_TOKEN || "",
    serverId: "c770e261",
    path: "/scriptfiles/whitelist/",
    extension: ".txt",
    serverName: "Stenly Roleplay",
    ip: "51.53.781.18",
    port: "1111",
    gamemode: "Roleplay v1.0"
}

global.random_reply_chance = 0;
