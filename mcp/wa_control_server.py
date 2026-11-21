
"""
MCP server: kontrol grup WhatsApp bot (wa_control).

Bukan konek langsung ke WhatsApp — dia memanggil HTTP control API yang hidup di
dalam proses bot (127.0.0.1:5685, wajib token). Jadi tidak ada dua sesi
WhatsApp yang berebut, dan aksi tetap dieksekusi oleh socket yang sudah login.

Env:
  WA_CONTROL_URL    default http://127.0.0.1:5685
  WA_CONTROL_TOKEN  opsional; kalau kosong dibaca dari
                    /LlamaAgentHermes/control/control_token
"""

from __future__ import annotations 

import json 
import os 
import urllib .error 
import urllib .parse 
import urllib .request 
from pathlib import Path 
from typing import Any 

from mcp .server .mcpserver import MCPServer 

BASE_URL =os .environ .get ("WA_CONTROL_URL","http://127.0.0.1:5685").rstrip ("/")
TOKEN_FILE =Path (
os .environ .get ("WA_CONTROL_TOKEN_FILE","/LlamaAgentHermes/control/control_token")
)
TIMEOUT =float (os .environ .get ("WA_CONTROL_TIMEOUT","90"))

server =MCPServer (
name ="wa_control",
title ="WhatsApp Bot Group Control",
description =(
"Kontrol grup WhatsApp milik bot: buka/tutup grup, kick/add anggota, "
"promote/demote admin, link undangan, ganti nama grup, jadwal harian, join request, "
"pengecualian anti-forward saluran, metadata & riwayat pesan live, arsip media "
"(simpan/cari/tag/kirim ulang dokumen, gambar, video, audio, sticker; transkripsi VN lokal), keluar grup."
),
instructions =(
"Semua aksi tulis (kick, add, promote, demote, close, rename, leave) mengubah "
"state grup nyata. Cek wa_group_info dulu untuk memastikan bot admin dan target "
"benar. Aksi yang tidak bisa dibatalkan: wa_group_leave (wajib confirm=true)."
),
version ="1.8.1",
)


def _token ()->str :
    token =os .environ .get ("WA_CONTROL_TOKEN","").strip ()
    if token :
        return token 
    try :
        return TOKEN_FILE .read_text (encoding ="utf-8").strip ()
    except OSError :
        return ""


def _call (path :str ,payload :dict [str ,Any ]|None =None ,params :dict [str ,Any ]|None =None )->dict [str ,Any ]:
    url =f"{BASE_URL }{path }"
    if params :
        clean ={k :v for k ,v in params .items ()if v is not None }
        if clean :
            url +="?"+urllib .parse .urlencode (clean )
    data =None 
    headers ={"x-control-token":_token (),"Accept":"application/json"}
    if payload is not None :
        data =json .dumps (payload ).encode ("utf-8")
        headers ["Content-Type"]="application/json"

    req =urllib .request .Request (url ,data =data ,headers =headers ,method ="POST"if data else "GET")
    try :
        with urllib .request .urlopen (req ,timeout =TIMEOUT )as resp :
            return json .loads (resp .read ().decode ("utf-8")or "{}")
    except urllib .error .HTTPError as e :
        body =e .read ().decode ("utf-8","replace")
        try :
            parsed =json .loads (body )
        except json .JSONDecodeError :
            parsed ={"error":body }
        parsed .setdefault ("http_status",e .code )
        return parsed 
    except urllib .error .URLError as e :
        return {
        "success":False ,
        "error":(
        f"Tidak bisa menghubungi control API di {BASE_URL } ({e .reason }). "
        "Pastikan bot jalan dan plugin kontrol sudah memuat socket."
        ),
        }
    except TimeoutError :
        return {"success":False ,"error":f"Timeout {TIMEOUT }s menunggu control API"}


@server .tool (
description ="Cek apakah control API bot hidup dan socket WhatsApp tersambung. Panggil ini dulu kalau tool lain gagal."
)
def wa_control_health ()->dict [str ,Any ]:
    return _call ("/health")


@server .tool (
description ="Daftar semua grup WhatsApp yang diikuti bot: nama, jumlah anggota, status tutup, apakah bot admin."
)
def wa_group_list ()->dict [str ,Any ]:
    return _call ("/groups")


@server .tool (
description ="Info satu grup: nama, deskripsi, jumlah anggota/admin, status tutup, apakah bot admin, mode ephemeral."
)
def wa_group_info (chat :str ,fresh :bool =False )->dict [str ,Any ]:
    return _call ("/group/info",params ={"chat":chat ,"fresh":"1"if fresh else None })


@server .tool (
description ="Daftar anggota grup dengan filter admin/member, plus pagination limit & offset. Berguna sebelum kick/promote."
)
def wa_group_members (chat :str ,filter :str ="all",limit :int =50 ,offset :int =0 )->dict [str ,Any ]:
    return _call (
    "/group/members",
    params ={"chat":chat ,"filter":filter ,"limit":limit ,"offset":offset },
    )


@server .tool (
description =(
"Buka atau tutup obrolan grup. mode: open | close | temp_close (butuh duration_minutes) | "
"locked | unlocked. Bot wajib admin. Hasil menyertakan verified=true kalau state server sudah cocok."
)
)
def wa_group_setting (chat :str ,mode :str ,duration_minutes :int =60 )->dict [str ,Any ]:
    return _call (
    "/group/action",
    payload ={
    "chat":chat ,
    "action":"setting",
    "mode":mode ,
    "durationMinutes":duration_minutes ,
    },
    )


@server .tool (
description =(
"Ubah keanggotaan grup. action: kick | add | promote | demote. "
"numbers diisi nomor telepon (08xx / 62xx) atau JID (@lid / @s.whatsapp.net). "
"Catatan: peserta yang hanya punya @lid harus dikirim dalam bentuk JID-nya."
)
)
def wa_group_members_action (chat :str ,action :str ,numbers :list [str ])->dict [str ,Any ]:
    return _call (
    "/group/action",
    payload ={"chat":chat ,"action":action ,"numbers":numbers },
    )


@server .tool (
description ="Ambil link undangan grup (https://chat.whatsapp.com/...). Set revoke=true untuk membuat link lama tidak berlaku."
)
def wa_group_invite (chat :str ,revoke :bool =False )->dict [str ,Any ]:
    return _call ("/group/action",payload ={"chat":chat ,"action":"invite","revoke":revoke })


@server .tool (
description =(
"Masuk ke grup lewat link undangan. Kirim URL penuh (https://chat.whatsapp.com/... dengan atau "
"tanpa query) atau kode undangannya saja. Grup terbuka: langsung join dan balikan joined=true. "
"Grup yang memakai persetujuan admin: permintaan join dikirim, balikan pending=true dan "
"approvalRequired=true — jangan laporkan sebagai sudah masuk. Kalau bot sudah jadi anggota, "
"balikan alreadyMember=true. Balikan berisi jid, name, participants."
)
)
def wa_group_join (link :str )->dict [str ,Any ]:
    return _call ("/group/action",payload ={"action":"join","link":link })


@server .tool (description ="Ganti nama (subject) grup. Bot wajib admin.")
def wa_group_rename (chat :str ,subject :str )->dict [str ,Any ]:
    return _call ("/group/action",payload ={"chat":chat ,"action":"rename","subject":subject })


@server .tool (
description =(
"Ganti deskripsi grup (teks panjang di bawah nama grup, dipakai untuk aturan/deskripsi). "
"Maksimal 2048 karakter. Bot wajib admin."
)
)
def wa_group_description (chat :str ,desc :str )->dict [str ,Any ]:
    return _call ("/group/action",payload ={"chat":chat ,"action":"description","desc":desc })


@server .tool (
description =(
"Kelola permintaan bergabung. action: list | approve | reject. "
"Untuk approve/reject isi numbers dengan JID/nomor pemohon."
)
)
def wa_group_join_requests (chat :str ,action :str ="list",numbers :list [str ]|None =None )->dict [str ,Any ]:
    payload :dict [str ,Any ]={"chat":chat ,"action":"join_requests","requestAction":action }
    if numbers :
        payload ["numbers"]=numbers 
    return _call ("/group/action",payload =payload )


@server .tool (
description =(
"Atur jadwal harian otomatis: grup ditutup pukul close_time dan dibuka pukul open_time "
"(format HH:MM 24 jam, WIB). Bot wajib admin. Jadwal disimpan di group_schedules.json "
"dan dijalankan watcher bot, jadi tahan restart. Set enabled=false untuk mematikan jadwal. "
"Balikan menyertakan verified=true kalau jadwal tersimpan persis seperti yang diminta."
)
)
def wa_group_schedule (
chat :str ,
close_time :str ="",
open_time :str ="",
enabled :bool =True ,
)->dict [str ,Any ]:
    return _call (
    "/group/action",
    payload ={
    "chat":chat ,
    "action":"schedule",
    "closeTime":close_time ,
    "openTime":open_time ,
    "enabled":enabled ,
    },
    )


@server .tool (
description =(
"Lihat jadwal harian yang aktif pada satu grup, plus status tutup/buka sekarang, "
"temp_close yang sedang berjalan, dan apakah bot admin di grup itu."
)
)
def wa_group_schedule_status (chat :str )->dict [str ,Any ]:
    return _call ("/group/action",payload ={"chat":chat ,"action":"schedule_status"})


@server .tool (
description =(
"Ambil metadata pesan terakhir di satu chat dari cache bot: waktu (WIB + relatif), "
"pengirim (JID/nomor/nama), jenis pesan, dan detail media (dokumen: nama file + mimetype + ukuran, "
"video/audio/sticker/lokasi/poll). Filter opsional: since_minutes, sender, limit."
)
)
def wa_message_recent (
chat :str ,
limit :int =10 ,
since_minutes :int =0 ,
sender :str ="",
)->dict [str ,Any ]:
    return _call (
    "/group/action",
    payload ={
    "chat":chat ,
    "action":"message_recent",
    "limit":limit ,
    "sinceMinutes":since_minutes or None ,
    "sender":sender or None ,
    },
    )


@server .tool (
description =(
"Ambil satu pesan lengkap dari cache berdasarkan ID pesan (record penuh: metadata, media, "
"pesan yang dibalas, info forward)."
)
)
def wa_message_get (chat :str ,id :str )->dict [str ,Any ]:
    return _call ("/group/action",payload ={"chat":chat ,"action":"message_get","id":id })


@server .tool (
description =(
"Cari pesan di cache satu chat berdasarkan kata kunci (teks, nama pengirim, nama file, "
"jenis media). Berguna untuk 'siapa yang kirim dokumen tadi'."
)
)
def wa_message_search (chat :str ,query :str ,limit :int =20 )->dict [str ,Any ]:
    return _call (
    "/group/action",
    payload ={"chat":chat ,"action":"message_search","query":query ,"limit":limit },
    )


@server .tool (
description =(
"Telusuri struktur satu pesan: record target, rantai balasan ke atas (quoted of quoted, "
"sampai depth level), pesan sebelum & sesudahnya, plus pesan paling awal di cache chat. "
"Pakai ini kalau perlu tahu konteks lengkap sebuah balasan, bukan cuma satu pesan."
)
)
def wa_message_thread (
chat :str ,
id :str ,
before :int =5 ,
after :int =5 ,
depth :int =4 ,
head :int =3 ,
)->dict [str ,Any ]:
    return _call (
    "/group/action",
    payload ={
    "chat":chat ,
    "action":"message_thread",
    "id":id ,
    "before":before ,
    "after":after ,
    "depth":depth ,
    "head":head ,
    },
    )


@server .tool (
description =(
"Minta riwayat pesan lebih lama langsung ke WhatsApp (on-demand history sync), tanpa "
"menyimpan apa pun ke disk. Butuh minimal satu pesan di cache chat sebagai anchor. "
"Balikan: requested, ingested, totalCached, waitedMs, note (kalau server tidak mengirim riwayat)."
)
)
def wa_message_fetch (chat :str ,count :int =50 ,wait_ms :int =6000 )->dict [str ,Any ]:
    return _call (
    "/group/action",
    payload ={"chat":chat ,"action":"message_fetch","count":count ,"waitMs":wait_ms },
    )


@server .tool (
description =(
"Hapus pesan yang dikirim bot sendiri untuk semua orang. Isi chat dengan JID chat dan id "
"pesan dari wa_message_recent/wa_message_thread. Tool menolak pesan orang lain atau ID yang "
"tidak ada di cache; tidak mendukung penghapusan massal."
)
)
def wa_message_delete_own (chat :str ,id :str )->dict [str ,Any ]:
    return _call ("/group/action",payload ={"chat":chat ,"action":"message_delete_own","id":id })


@server .tool (
description =(
"Statistik cache pesan: berapa chat terekam, berapa pesan, kapan terakhir, plus batas "
"kapasitas (per chat dan jumlah chat)."
)
)
def wa_message_stats ()->dict [str ,Any ]:
    return _call ("/group/action",payload ={"action":"message_stats"})


@server .tool (
description =(
"Lihat status fitur anti-forward saluran WhatsApp: apakah aktif global, aktif di grup tertentu, "
"dan daftar pengecualian (pengirim + saluran) untuk grup itu. Kosongkan chat untuk lihat ringkasan."
)
)
def wa_antiforward_status (chat :str ="")->dict [str ,Any ]:
    return _call ("/group/action",payload ={"chat":chat ,"action":"antiforward_status"})


@server .tool (
description =(
"Kelola pengecualian anti-forward. type='sender' (nomor atau JID, mis. 628xx / 123@lid) atau "
"type='channel' (JID berakhiran @newsletter). action='add' atau 'remove'. chat = grup sasaran, "
"kosongkan untuk cakupan global semua grup. Balikan menyertakan verified=true kalau state di file "
"sudah cocok dengan permintaan. Pengecualian berarti pesan forward saluran dari target itu TIDAK dihapus."
)
)
def wa_antiforward_exempt (
chat :str ,
type :str ,
target :str ,
action :str ="add",
)->dict [str ,Any ]:
    return _call (
    "/group/action",
    payload ={
    "chat":chat ,
    "action":"antiforward_exempt",
    "type":type ,
    "target":target ,
    "exemptAction":action ,
    },
    )


@server .tool (
description =(
"Bot keluar dari grup. TIDAK BISA DIBATALKAN — wajib confirm=true. "
"Tanpa confirm, tool cuma mengembalikan penolakan."
)
)
def wa_group_leave (chat :str ,confirm :bool =False )->dict [str ,Any ]:
    return _call ("/group/action",payload ={"chat":chat ,"action":"leave","confirm":confirm })




@server .tool (
description =(
"Simpan media dari satu pesan ke arsip: dokumen, gambar, video, audio, voice note, sticker. "
"Butuh chat + id pesan (ambil dari wa_message_recent / wa_message_thread). Media yang dikirim "
"atau dibalas bisa disimpan dengan cara ini. Tag dipisah koma, contoh 'desain, referensi'. "
"Byte media identik tidak disimpan dua kali — tag digabung."
)
)
def wa_media_save (
chat :str ,
id :str ,
tags :str ="",
note :str ="",
)->dict [str ,Any ]:
    return _call (
    "/group/action",
    payload ={
    "chat":chat ,
    "action":"media_save",
    "id":id ,
    "tags":tags or None ,
    "note":note or None ,
    },
    )


@server .tool (
description =(
"Daftar isi arsip media, terbaru dulu. Filter: tags (semua tag harus cocok, dipisah koma), "
"kind (image|video|audio|document|sticker), query (cari di nama file, caption, tag, pengirim), "
"plus limit/offset. Balikan tiap item membawa sha256, ref pendek, ukuran, tag, sumber pesan, path."
)
)
def wa_media_list (
tags :str ="",
kind :str ="",
query :str ="",
limit :int =20 ,
offset :int =0 ,
)->dict [str ,Any ]:
    return _call (
    "/group/action",
    payload ={
    "action":"media_list",
    "tags":tags or None ,
    "kind":kind or None ,
    "query":query or None ,
    "limit":limit ,
    "offset":offset ,
    },
    )


@server .tool (
description =(
"Detail satu item arsip media (sha penuh, potongan sha minimal 8 karakter, atau nama file). "
"Balikan metadata lengkap + path file di disk."
)
)
def wa_media_get (ref :str )->dict [str ,Any ]:
    return _call ("/group/action",payload ={"action":"media_get","ref":ref })


@server .tool (
description =(
"Ubah tag satu item arsip. add menambah, remove membuang, replace mengganti seluruh tag. "
"Boleh gabung add + remove. Tag otomatis huruf kecil dan tanpa spasi."
)
)
def wa_media_tag (
ref :str ,
add :str ="",
remove :str ="",
replace :str ="",
)->dict [str ,Any ]:
    return _call (
    "/group/action",
    payload ={
    "action":"media_tag",
    "ref":ref ,
    "add":add or None ,
    "remove":remove or None ,
    "replace":replace or None ,
    },
    )


@server .tool (
description =(
"Kirim ulang item arsip media ke chat (grup, LID, atau nomor). Tanpa to, dikirim balik ke chat "
"asalnya. as_document=true memaksa dikirim sebagai dokumen, bukan gambar/video inline."
)
)
def wa_media_send (
ref :str ,
to :str ="",
caption :str ="",
as_document :bool =False ,
)->dict [str ,Any ]:
    return _call (
    "/group/action",
    payload ={
    "action":"media_send",
    "ref":ref ,
    "to":to or None ,
    "caption":caption or None ,
    "asDocument":as_document ,
    },
    )


@server .tool (
description =(
"Hapus satu item dari arsip media: file di disk + entri indeks. Tidak bisa dibatalkan."
)
)
def wa_media_delete (ref :str )->dict [str ,Any ]:
    return _call ("/group/action",payload ={"action":"media_delete","ref":ref })


@server .tool (
description =(
"Statistik arsip media: jumlah item, total byte terpakai, sisa kuota, sebaran per jenis, "
"dan tag paling sering dipakai."
)
)
def wa_media_stats ()->dict [str ,Any ]:
    return _call ("/group/action",payload ={"action":"media_stats"})


if __name__ =="__main__":
    server .run ("stdio")
