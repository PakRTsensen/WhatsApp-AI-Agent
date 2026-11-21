const fs = require('fs');
const path = require('path');
let areJidsSameUser = null;
try {
    ({ areJidsSameUser } = require('@itsliaaa/baileys'));
} catch (_) {}

const DB_PATH = path.join(__dirname, 'database/group_schedules.json');

let watcherInterval = null;
let currentSock = null;

function readDatabase() {
    try {
        if (!fs.existsSync(DB_PATH)) {
            const initial = {
                _v: 1,
                groups: {},
                updated_at: new Date().toISOString()
            };
            fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2), 'utf8');
            return initial;
        }
        return JSON.parse(fs.readFileSync(DB_PATH, 'utf8') || '{"groups":{}}');
    } catch (_) {
        return { groups: {} };
    }
}

function writeDatabase(data) {
    try {
        const dir = path.dirname(DB_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        data.updated_at = new Date().toISOString();
        fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
        return true;
    } catch (e) {
        console.error('[GROUP DB SAVE ERROR]', e.message);
        return false;
    }
}

function safeDecodeJid(sock, jid) {
    try {
        return sock.decodeJid ? sock.decodeJid(String(jid || '')) : String(jid || '');
    } catch (_) {
        return String(jid || '');
    }
}

function sameUser(a, b) {
    if (!a || !b) return false;
    try {
        if (typeof areJidsSameUser === 'function') {
            return areJidsSameUser(a, b);
        }
        const cleanA = String(a).split('@')[0].replace(/[^0-9]/g, '');
        const cleanB = String(b).split('@')[0].replace(/[^0-9]/g, '');
        return cleanA && cleanB && cleanA === cleanB;
    } catch (_) {
        return false;
    }
}

/**
 * Fetch metadata grup 1x untuk verifikasi cepat Bot Admin & Sender Admin
 */
async function resolveGroupAuth(sock, chat, senderJid, isOwner = false) {
    if (!chat || !chat.endsWith('@g.us')) {
        return { isGroup: false, isBotAdmin: false, isSenderAdmin: false, groupName: "Bukan Grup" };
    }

    try {
        const metadata = await sock.groupMetadata(chat);
        if (!metadata || !Array.isArray(metadata.participants)) {
            return { isGroup: true, isBotAdmin: false, isSenderAdmin: false, groupName: "Grup", metadata: null };
        }

        const groupName = metadata.subject || "Grup";
        const botJid = safeDecodeJid(sock, sock.user?.id);
        const botLid = sock.user?.lid || "";
        const botNumber = (botJid.split('@')[0] || '').replace(/[^0-9]/g, '');

        const isBotAdmin = metadata.participants.some(p => {
            if (!p.admin) return false;
            return sameUser(p.id, botJid) ||
                   sameUser(p.id, botLid) ||
                   (p.phoneNumber && sameUser(p.phoneNumber, botNumber));
        });

        let isSenderAdmin = false;
        if (isOwner) {
            isSenderAdmin = true;
        } else if (senderJid) {
            const cleanSender = safeDecodeJid(sock, senderJid);
            const senderNum = cleanSender.split('@')[0].replace(/[^0-9]/g, '');
            isSenderAdmin = metadata.participants.some(p => {
                if (!p.admin) return false;
                const pNum = String(p.id || '').split('@')[0].replace(/[^0-9]/g, '');
                return sameUser(p.id, cleanSender) || (senderNum && pNum && senderNum === pNum);
            });
        }

        return {
            isGroup: true,
            isBotAdmin,
            isSenderAdmin,
            groupName,
            metadata
        };
    } catch (err) {
        console.error(`[RESOLVE GROUP AUTH ERROR in ${chat}]:`, err.message);
        return { isGroup: true, isBotAdmin: false, isSenderAdmin: false, groupName: "Grup", error: err.message };
    }
}

async function closeGroup(sock, chat, options = {}) {
    const auth = await resolveGroupAuth(sock, chat, options.sender, Boolean(options.isOwner));
    if (!auth.isBotAdmin) {
        return {
            success: false,
            code: "BOT_NOT_ADMIN",
            isBotAdmin: false,
            groupName: auth.groupName,
            message: "Bot belum menjadi Admin di grup ini. Mohon jadikan bot sebagai Admin grup terlebih dahulu agar memiliki wewenang untuk menutup obrolan grup."
        };
    }

    if (options.sender && !auth.isSenderAdmin) {
        return {
            success: false,
            code: "SENDER_NOT_ADMIN",
            isSenderAdmin: false,
            groupName: auth.groupName,
            message: "Akses ditolak: Hanya Admin grup atau Owner bot yang memiliki hak untuk menutup obrolan grup."
        };
    }

    try {
        await sock.groupSettingUpdate(chat, 'announcement');

        const db = readDatabase();
        if (db.groups[chat] && db.groups[chat].tempClose) {
            delete db.groups[chat].tempClose;
            writeDatabase(db);
        }

        return {
            success: true,
            code: "GROUP_CLOSED",
            status: "closed",
            isBotAdmin: true,
            isSenderAdmin: true,
            groupName: auth.groupName,
            chat: chat,
            action: "close",
            message: "Grup berhasil ditutup. Pengaturan diubah ke mode announcement (hanya admin yang dapat mengirim pesan)."
        };
    } catch (err) {
        console.error(`[CLOSE GROUP ERROR in ${chat}]:`, err.message);
        return { success: false, code: "SOCKET_ERROR", error: err.message };
    }
}

async function openGroup(sock, chat, options = {}) {
    const auth = await resolveGroupAuth(sock, chat, options.sender, Boolean(options.isOwner));
    if (!auth.isBotAdmin) {
        return {
            success: false,
            code: "BOT_NOT_ADMIN",
            isBotAdmin: false,
            groupName: auth.groupName,
            message: "Bot belum menjadi Admin di grup ini. Mohon jadikan bot sebagai Admin grup terlebih dahulu agar memiliki wewenang untuk membuka obrolan grup."
        };
    }

    if (options.sender && !auth.isSenderAdmin) {
        return {
            success: false,
            code: "SENDER_NOT_ADMIN",
            isSenderAdmin: false,
            groupName: auth.groupName,
            message: "Akses ditolak: Hanya Admin grup atau Owner bot yang memiliki hak untuk membuka obrolan grup."
        };
    }

    try {
        await sock.groupSettingUpdate(chat, 'not_announcement');

        const db = readDatabase();
        if (db.groups[chat] && db.groups[chat].tempClose) {
            delete db.groups[chat].tempClose;
            writeDatabase(db);
        }

        return {
            success: true,
            code: "GROUP_OPENED",
            status: "opened",
            isBotAdmin: true,
            isSenderAdmin: true,
            groupName: auth.groupName,
            chat: chat,
            action: "open",
            message: "Grup berhasil dibuka. Pengaturan diubah ke mode normal (seluruh anggota dapat mengirim pesan)."
        };
    } catch (err) {
        console.error(`[OPEN GROUP ERROR in ${chat}]:`, err.message);
        return { success: false, code: "SOCKET_ERROR", error: err.message };
    }
}

async function tempCloseGroup(sock, chat, durationMinutes, options = {}) {
    const auth = await resolveGroupAuth(sock, chat, options.sender, Boolean(options.isOwner));
    if (!auth.isBotAdmin) {
        return {
            success: false,
            code: "BOT_NOT_ADMIN",
            isBotAdmin: false,
            groupName: auth.groupName,
            message: "Bot belum menjadi Admin di grup ini. Mohon jadikan bot sebagai Admin grup terlebih dahulu."
        };
    }

    if (options.sender && !auth.isSenderAdmin) {
        return {
            success: false,
            code: "SENDER_NOT_ADMIN",
            isSenderAdmin: false,
            groupName: auth.groupName,
            message: "Akses ditolak: Hanya Admin grup atau Owner bot yang memiliki hak untuk mengatur penutupan grup sementara."
        };
    }

    const minutes = parseInt(durationMinutes, 10);
    if (isNaN(minutes) || minutes <= 0) {
        return {
            success: false,
            code: "INVALID_DURATION",
            message: "Durasi penutupan sementara tidak valid. Masukkan jumlah menit berupa angka positif (contoh: 30, 45, 60)."
        };
    }

    const now = Date.now();
    const reopenAt = now + minutes * 60 * 1000;
    const reopenDate = new Date(reopenAt);
    const reopenTimeStr = `${String(reopenDate.getHours()).padStart(2, '0')}:${String(reopenDate.getMinutes()).padStart(2, '0')} WIB`;

    try {
        await sock.groupSettingUpdate(chat, 'announcement');

        const db = readDatabase();
        if (!db.groups[chat]) db.groups[chat] = {};
        db.groups[chat].tempClose = {
            reopenAt: reopenAt,
            durationMinutes: minutes,
            closedAt: now,
            adminName: options.adminName || 'Admin'
        };
        writeDatabase(db);

        return {
            success: true,
            code: "GROUP_TEMP_CLOSED",
            status: "temp_closed",
            isBotAdmin: true,
            isSenderAdmin: true,
            groupName: auth.groupName,
            chat: chat,
            action: "temp_close",
            durationMinutes: minutes,
            reopenAtTime: reopenTimeStr,
            message: `Grup berhasil ditutup sementara selama ${minutes} menit dan akan otomatis dibuka kembali pada pukul ${reopenTimeStr}.`
        };
    } catch (err) {
        console.error(`[TEMP CLOSE ERROR in ${chat}]:`, err.message);
        return { success: false, code: "SOCKET_ERROR", error: err.message };
    }
}

async function setDailySchedule(sock, chat, closeTime, openTime, options = {}) {
    const auth = await resolveGroupAuth(sock, chat, options.sender, Boolean(options.isOwner));
    if (!auth.isBotAdmin) {
        return {
            success: false,
            code: "BOT_NOT_ADMIN",
            isBotAdmin: false,
            groupName: auth.groupName,
            message: "Bot belum menjadi Admin di grup ini. Mohon jadikan bot sebagai Admin grup terlebih dahulu."
        };
    }

    if (options.sender && !auth.isSenderAdmin) {
        return {
            success: false,
            code: "SENDER_NOT_ADMIN",
            isSenderAdmin: false,
            groupName: auth.groupName,
            message: "Akses ditolak: Hanya Admin grup atau Owner bot yang berhak mengatur jadwal operasional grup."
        };
    }

    const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
    if (!timeRegex.test(closeTime) || !timeRegex.test(openTime)) {
        return {
            success: false,
            code: "INVALID_TIME_FORMAT",
            message: "Format waktu tidak valid. Gunakan format jam 24 jam HH:MM (contoh: 23:00 untuk tutup, 05:00 untuk buka)."
        };
    }

    const db = readDatabase();
    if (!db.groups[chat]) db.groups[chat] = {};
    db.groups[chat].dailySchedule = {
        enabled: true,
        closeTime: closeTime,
        openTime: openTime,
        setBy: options.adminName || 'Admin',
        updatedAt: new Date().toISOString()
    };
    writeDatabase(db);

    return {
        success: true,
        code: "SCHEDULE_CONFIGURED",
        isBotAdmin: true,
        isSenderAdmin: true,
        groupName: auth.groupName,
        chat: chat,
        action: "schedule",
        closeTime: closeTime,
        openTime: openTime,
        message: `Jadwal harian otomatis berhasil dikonfigurasi: Tutup pukul ${closeTime} WIB dan Buka pukul ${openTime} WIB.`
    };
}

async function disableDailySchedule(sock, chat, options = {}) {
    const auth = await resolveGroupAuth(sock, chat, options.sender, Boolean(options.isOwner));
    if (options.sender && !auth.isSenderAdmin) {
        return {
            success: false,
            code: "SENDER_NOT_ADMIN",
            isSenderAdmin: false,
            message: "Akses ditolak: Hanya Admin grup atau Owner bot yang berhak mematikan jadwal operasional grup."
        };
    }

    const db = readDatabase();
    if (!db.groups[chat] || !db.groups[chat].dailySchedule) {
        return {
            success: true,
            code: "NO_SCHEDULE_ACTIVE",
            message: "Grup ini tidak memiliki jadwal harian otomatis yang sedang aktif."
        };
    }

    delete db.groups[chat].dailySchedule;
    writeDatabase(db);

    return {
        success: true,
        code: "SCHEDULE_DISABLED",
        action: "disable_schedule",
        message: "Jadwal harian buka & tutup otomatis untuk grup ini telah dinonaktifkan."
    };
}

async function getGroupStatus(sock, chat) {
    if (!chat || !chat.endsWith('@g.us')) {
        return { success: false, error: "NOT_A_GROUP", message: "Target bukan grup WhatsApp (@g.us)." };
    }

    const auth = await resolveGroupAuth(sock, chat, null, false);
    const isAnnounce = Boolean(auth.metadata?.announce);
    const participantCount = auth.metadata?.participants ? auth.metadata.participants.length : 0;

    const db = readDatabase();
    const groupData = db.groups[chat] || {};

    let tempCloseInfo = null;
    if (groupData.tempClose && groupData.tempClose.reopenAt) {
        const remainingMs = groupData.tempClose.reopenAt - Date.now();
        if (remainingMs > 0) {
            const remMin = Math.ceil(remainingMs / 60000);
            const reopenDate = new Date(groupData.tempClose.reopenAt);
            tempCloseInfo = {
                reopenAtTime: `${String(reopenDate.getHours()).padStart(2, '0')}:${String(reopenDate.getMinutes()).padStart(2, '0')} WIB`,
                remainingMinutes: remMin
            };
        }
    }

    return {
        success: true,
        isGroup: true,
        groupId: chat,
        groupName: auth.groupName,
        totalMembers: participantCount,
        isBotAdmin: auth.isBotAdmin,
        isClosed: isAnnounce,
        currentMode: isAnnounce ? "announcement (hanya admin)" : "normal (semua anggota)",
        tempClose: tempCloseInfo,
        dailySchedule: groupData.dailySchedule || null
    };
}

function startScheduleWatcher(sock) {
    currentSock = sock;
    if (watcherInterval) clearInterval(watcherInterval);

    watcherInterval = setInterval(async () => {
        if (!currentSock) return;

        const now = Date.now();
        const dateObj = new Date();
        const curHours = String(dateObj.getHours()).padStart(2, '0');
        const curMins = String(dateObj.getMinutes()).padStart(2, '0');
        const curTimeStr = `${curHours}:${curMins}`;

        const db = readDatabase();
        let dbChanged = false;

        for (const [chat, data] of Object.entries(db.groups || {})) {

            if (data.tempClose && data.tempClose.reopenAt) {
                if (now >= data.tempClose.reopenAt) {
                    console.log(`[GROUP WATCHER] Waktu penutupan sementara grup ${chat} telah berakhir. Membuka grup...`);
                    delete data.tempClose;
                    dbChanged = true;
                    try {
                        await currentSock.groupSettingUpdate(chat, 'not_announcement');
                        await currentSock.sendMessage(chat, {
                            text: "*Waktu penutupan sementara telah selesai.*\nObrolan grup telah dibuka kembali dan semua anggota dapat kembali mengirim pesan."
                        });
                    } catch (e) {
                        console.error(`[WATCHER AUTO REOPEN ERROR]`, e.message);
                    }
                }
            }

            if (data.dailySchedule && data.dailySchedule.enabled) {
                const lastTrigger = data.dailySchedule.lastTriggerDate;
                const todayStr = dateObj.toISOString().slice(0, 10);

                if (curTimeStr === data.dailySchedule.closeTime && lastTrigger !== `${todayStr}_close`) {
                    console.log(`[GROUP WATCHER] Jadwal tutup (${curTimeStr}) untuk grup ${chat}. Menutup grup...`);
                    data.dailySchedule.lastTriggerDate = `${todayStr}_close`;
                    dbChanged = true;
                    try {
                        await currentSock.groupSettingUpdate(chat, 'announcement');
                        await currentSock.sendMessage(chat, {
                            text: `*Pemberitahuan Jadwal Operasional:*\nPukul ${data.dailySchedule.closeTime} WIB telah tiba. Obrolan grup ditutup sementara untuk istirahat malam dan hanya admin yang dapat mengirim pesan.`
                        });
                    } catch (e) {
                        console.error(`[WATCHER AUTO CLOSE ERROR]`, e.message);
                    }
                } else if (curTimeStr === data.dailySchedule.openTime && lastTrigger !== `${todayStr}_open`) {
                    console.log(`[GROUP WATCHER] Jadwal buka (${curTimeStr}) untuk grup ${chat}. Membuka grup...`);
                    data.dailySchedule.lastTriggerDate = `${todayStr}_open`;
                    dbChanged = true;
                    try {
                        await currentSock.groupSettingUpdate(chat, 'not_announcement');
                        await currentSock.sendMessage(chat, {
                            text: `*Pemberitahuan Jadwal Operasional:*\nPukul ${data.dailySchedule.openTime} WIB telah tiba. Obrolan grup dibuka kembali dan semua anggota dapat berinteraksi.`
                        });
                    } catch (e) {
                        console.error(`[WATCHER AUTO OPEN ERROR]`, e.message);
                    }
                }
            }
        }

        if (dbChanged) {
            writeDatabase(db);
        }
    }, 25000);
}

function stopScheduleWatcher() {
    if (watcherInterval) {
        clearInterval(watcherInterval);
        watcherInterval = null;
    }
    currentSock = null;
}

module.exports = {
    resolveGroupAuth,
    closeGroup,
    openGroup,
    tempCloseGroup,
    setDailySchedule,
    disableDailySchedule,
    getGroupStatus,
    startScheduleWatcher,
    stopScheduleWatcher
};
