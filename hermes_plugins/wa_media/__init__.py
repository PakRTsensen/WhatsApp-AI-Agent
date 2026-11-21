"""wa_media — kirim media ke chat WhatsApp yang menjalankan sesi ini.

Agent (Noppo) jalan sebagai child process Hermes di dalam bot WhatsApp, jadi dia tidak
memegang socket Baileys. Plugin ini menyalurkan media ke WhatsApp outbound bridge lokal
milik bot (default ``http://127.0.0.1:5680``), yang memegang socket asli dan melakukan
``sock.sendMessage``.

Endpoint bridge yang dipakai: ``POST /send-media`` (image, video, audio/ptt, document,
sticker) dan ``GET /health`` untuk status. Tanpa dependency eksternal — cukup stdlib.
"""

from __future__ import annotations 

import json 
import os 
import urllib .error 
import urllib .request 
from typing import Any ,Dict 

BRIDGE_URL =os .environ .get ("WA_BRIDGE_URL","http://127.0.0.1:5680").rstrip ("/")
TIMEOUT_S =float (os .environ .get ("WA_BRIDGE_TIMEOUT","120"))


def _request (method :str ,path :str ,payload :Dict [str ,Any ]|None =None )->Dict [str ,Any ]:
    url =f"{BRIDGE_URL }{path }"
    data =None 
    headers ={"Accept":"application/json"}
    if payload is not None :
        data =json .dumps (payload ).encode ("utf-8")
        headers ["Content-Type"]="application/json"
    req =urllib .request .Request (url ,data =data ,headers =headers ,method =method )
    try :
        with urllib .request .urlopen (req ,timeout =TIMEOUT_S )as resp :
            body =resp .read ().decode ("utf-8","replace")
            try :
                return json .loads (body )
            except json .JSONDecodeError :
                return {"success":False ,"error":f"Respons bridge bukan JSON: {body [:300 ]}"}
    except urllib .error .HTTPError as e :
        detail =e .read ().decode ("utf-8","replace")
        hint =""
        if e .code ==404 and path .startswith ("/send-media"):
            hint =(
            " Endpoint /send-media belum termuat di proses bot — kode baru ada di disk "
            "tapi bot perlu restart sekali supaya aktif."
            )
        try :
            parsed =json .loads (detail )
        except json .JSONDecodeError :
            parsed =None 
        if isinstance (parsed ,dict ):
            parsed .setdefault ("success",False )
            if hint :
                parsed ["error"]=f"{parsed .get ('error')or f'HTTP {e .code }'}{hint }"
            return parsed 
        return {"success":False ,"error":f"HTTP {e .code }: {detail [:300 ]}{hint }"}
    except urllib .error .URLError as e :
        return {
        "success":False ,
        "error":(
        f"Bridge WhatsApp tidak bisa dihubungi di {BRIDGE_URL } ({e .reason }). "
        "Kalau endpoint /send-media belum ada, bot perlu restart supaya kode baru termuat."
        ),
        }
    except Exception as e :
        return {"success":False ,"error":f"{type (e ).__name__ }: {e }"}


def _source_props ()->Dict [str ,Any ]:
    return {
    "filePath":{"type":"string","description":"Path file lokal di VPS (paling umum)."},
    "url":{"type":"string","description":"URL publik; bridge akan mengunduhnya dulu."},
    "base64":{"type":"string","description":"Isi file dalam base64 (atau data URI)."},
    "to":{
    "type":"string",
    "description":"Nomor tujuan (08xx / 62xx) atau JID grup @g.us. Kosongkan untuk kirim ke owner.",
    },
    "caption":{"type":"string","description":"Teks caption; markdown WhatsApp (**x** otomatis jadi *x*)."},
    "mimetype":{"type":"string","description":"Override MIME type kalau ekstensi file tidak jelas."},
    "fileName":{"type":"string","description":"Nama file yang tampil di WhatsApp (khusus dokumen)."},
    }


def _schema (name :str ,description :str ,required :list [str ],extra :Dict [str ,Any ]|None =None )->Dict [str ,Any ]:
    props =_source_props ()
    if extra :
        props .update (extra )
    return {
    "name":name ,
    "description":description ,
    "parameters":{
    "type":"object",
    "properties":props ,
    "required":required ,
    "additionalProperties":False ,
    },
    }


def _payload (args :Dict [str ,Any ],kind :str ,*,keep_caption :bool =True ,keep_name :bool =True )->Dict [str ,Any ]:
    payload :Dict [str ,Any ]={"type":kind }
    for key in ("filePath","url","base64","to","mimetype"):
        value =args .get (key )
        if value :
            payload [key ]=value 
    if keep_caption and args .get ("caption"):
        payload ["caption"]=args ["caption"]
    if keep_name and args .get ("fileName"):
        payload ["fileName"]=args ["fileName"]
    return payload 


def _send (args :Dict [str ,Any ],kind :str ,**kwargs :Any )->str :
    if not any (args .get (key )for key in ("filePath","url","base64")):
        return json .dumps ({"success":False ,"error":"Butuh salah satu: filePath, url, atau base64."})
    payload =_payload (args ,kind ,**kwargs )
    result =_request ("POST","/send-media",payload )
    return json .dumps (result ,ensure_ascii =False )


def handle_wa_send_image (args :Dict [str ,Any ],**_kw :Any )->str :
    return _send (args ,"image")


def handle_wa_send_video (args :Dict [str ,Any ],**_kw :Any )->str :
    return _send (args ,"video")


def handle_wa_send_document (args :Dict [str ,Any ],**_kw :Any )->str :
    return _send (args ,"document")


def handle_wa_send_sticker (args :Dict [str ,Any ],**_kw :Any )->str :
    return _send (args ,"sticker",keep_caption =False ,keep_name =False )


def handle_wa_send_voice (args :Dict [str ,Any ],**_kw :Any )->str :
    payload =_payload (args ,"audio",keep_caption =False ,keep_name =False )
    payload ["ptt"]=True 
    if not any (payload .get (key )for key in ("filePath","url","base64")):
        return json .dumps ({"success":False ,"error":"Butuh salah satu: filePath, url, atau base64."})
    result =_request ("POST","/send-media",payload )
    if not result .get ("success")and "belum termuat"in str (result .get ("error",""))and payload .get ("filePath"):

        legacy ={"filePath":payload ["filePath"]}
        if payload .get ("to"):
            legacy ["to"]=payload ["to"]
        result =_request ("POST","/send-voice",legacy )
        result .setdefault ("transport","legacy:/send-voice")
    return json .dumps (result ,ensure_ascii =False )


def handle_wa_send_media (args :Dict [str ,Any ],**_kw :Any )->str :
    kind =str (args .get ("type")or "").strip ().lower ()
    if kind not in {"image","video","audio","document","sticker"}:
        return json .dumps (
        {"success":False ,"error":"type wajib: image | video | audio | document | sticker."}
        )
    payload =_payload (args ,kind )
    if kind =="audio"and args .get ("ptt")is True :
        payload ["ptt"]=True 
    if not any (payload .get (key )for key in ("filePath","url","base64")):
        return json .dumps ({"success":False ,"error":"Butuh salah satu: filePath, url, atau base64."})
    return json .dumps (_request ("POST","/send-media",payload ),ensure_ascii =False )


def handle_wa_media_status (args :Dict [str ,Any ]|None =None ,**_kw :Any )->str :
    return json .dumps (_request ("GET","/health"),ensure_ascii =False )


_TOOLS =(
(
"wa_send_image",
_schema (
"wa_send_image",
"Kirim gambar/screenshot ke chat WhatsApp ini. Pakai setelah take_screenshot atau saat "
"butuh menunjukkan hasil visual ke user. Sumber: filePath (lokal), url, atau base64.",
[],
),
handle_wa_send_image ,
"🖼️",
),
(
"wa_send_video",
_schema ("wa_send_video","Kirim video (maks 16 MB) ke chat WhatsApp ini.",[]),
handle_wa_send_video ,
"🎬",
),
(
"wa_send_document",
_schema (
"wa_send_document",
"Kirim file/dokumen apa pun (pdf, docx, xlsx, zip, txt, log, js) ke chat WhatsApp ini, maks 100 MB.",
[],
),
handle_wa_send_document ,
"📄",
),
(
"wa_send_voice",
_schema (
"wa_send_voice",
"Kirim voice note (PTT) ke chat WhatsApp ini. File audio ogg/opus paling aman; mp3/m4a juga bisa.",
[],
),
handle_wa_send_voice ,
"🎙️",
),
(
"wa_send_sticker",
_schema ("wa_send_sticker","Kirim sticker WhatsApp (wajib WebP, maks 2 MB).",[]),
handle_wa_send_sticker ,
"🩹",
),
(
"wa_send_media",
_schema (
"wa_send_media",
"Kirim media apa pun ke chat WhatsApp ini dengan tipe eksplisit. Gunakan ini kalau tipe "
"tidak jelas atau butuh kontrol penuh (mimetype, fileName, ptt).",
["type"],
extra ={
"type":{
"type":"string",
"enum":["image","video","audio","document","sticker"],
"description":"Jenis media yang dikirim.",
},
"ptt":{
"type":"boolean",
"description":"Khusus audio: true = voice note (PTT), false = file audio biasa.",
},
},
),
handle_wa_send_media ,
"📤",
),
(
"wa_media_status",
{
"name":"wa_media_status",
"description":"Cek status WhatsApp outbound bridge: bot connected, endpoint yang tersedia, tipe media yang didukung.",
"parameters":{"type":"object","properties":{},"additionalProperties":False },
},
handle_wa_media_status ,
"🔌",
),
)


def register (ctx )->None :
    """Daftarkan tool media WhatsApp ke agent (dipanggil sekali oleh plugin loader)."""
    for name ,schema ,handler ,emoji in _TOOLS :
        ctx .register_tool (name =name ,toolset ="wa_media",schema =schema ,handler =handler ,emoji =emoji )
