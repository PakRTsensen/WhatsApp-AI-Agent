
"""
Smoke test MCP `wa_control` lewat protokol stdio (bukan import langsung).

Default: hanya baca (health, list, info, members, invite, join_requests) +
validasi error path. Aman dijalankan kapan saja.

Dengan --write: tambah uji close lalu open grup (state balik ke semula), dan
verifikasi lewat metadata segar.

Pakai:
  python3 mcp/smoke_test.py --chat 120363405197851405@g.us
  python3 mcp/smoke_test.py --chat 120363405197851405@g.us --write
"""

import argparse 
import asyncio 
import json 
import sys 
from pathlib import Path 

from mcp import ClientSession ,StdioServerParameters 
from mcp .client .stdio import stdio_client 

SERVER =str (Path (__file__ ).with_name ("wa_control_server.py"))


def summarize (label ,parsed ):
    if isinstance (parsed ,str ):
        print (f"  {label }: {parsed [:160 ]}")
        return 
    keys =["success","verified","closed","mode","code","error","version","botConnected","total","revoked"]
    line ="  ".join (f"{k }={parsed [k ]}"for k in keys if k in parsed )
    print (f"  {label }: {line or json .dumps (parsed ,ensure_ascii =False )[:160 ]}")


async def run (chat ,do_write ):
    params =StdioServerParameters (command =sys .executable ,args =[SERVER ],env =None )
    failures =[]
    async with stdio_client (params )as (read ,write ):
        async with ClientSession (read ,write )as session :
            await session .initialize ()
            tools =await session .list_tools ()
            print (f"tools: {len (tools .tools )}")

            async def call (name ,args ):
                res =await session .call_tool (name ,args )
                text =next ((c .text for c in res .content if getattr (c ,"text",None )),None )
                return json .loads (text )if text else (res .structuredContent or {})

            health =await call ("wa_control_health",{})
            summarize ("health",health )
            if not health .get ("success"):
                failures .append ("health gagal: control API tidak hidup")

            groups =await call ("wa_group_list",{})
            summarize ("list",groups )
            print (f"    grup: {len (groups .get ('groups',[]))}")

            info =await call ("wa_group_info",{"chat":chat })
            summarize ("info",info )
            if not info .get ("success"):
                failures .append (f"info gagal: {info .get ('error')}")
            elif not info .get ("botIsAdmin"):
                failures .append ("bot bukan admin di grup uji — aksi tulis tidak bisa diuji")

            summarize ("members",await call ("wa_group_members",{"chat":chat ,"filter":"admin","limit":3 }))
            summarize ("invite",await call ("wa_group_invite",{"chat":chat }))
            summarize ("join_requests",await call ("wa_group_join_requests",{"chat":chat ,"action":"list"}))

            bogus =await call ("wa_group_members_action",{"chat":chat ,"action":"kick","numbers":["6280000000000"]})
            summarize ("kick bogus (harus ditolak)",bogus )
            if bogus .get ("code")!="NO_PARTICIPANT_MATCH":
                failures .append ("kick nomor tak dikenal tidak mengembalikan NO_PARTICIPANT_MATCH")

            leave =await call ("wa_group_leave",{"chat":chat ,"confirm":False })
            summarize ("leave tanpa confirm (harus ditolak)",leave )
            if leave .get ("code")!="NEED_CONFIRM":
                failures .append ("leave tanpa confirm tidak ditolak")

            if do_write :
                close =await call ("wa_group_setting",{"chat":chat ,"mode":"close"})
                summarize ("close",close )
                after_close =await call ("wa_group_info",{"chat":chat ,"fresh":True })
                summarize ("info setelah close",after_close )
                if not (close .get ("verified")and after_close .get ("closed")):
                    failures .append ("close tidak terverifikasi")

                open_ =await call ("wa_group_setting",{"chat":chat ,"mode":"open"})
                summarize ("open",open_ )
                after_open =await call ("wa_group_info",{"chat":chat ,"fresh":True })
                summarize ("info setelah open",after_open )
                if not (open_ .get ("verified")and after_open .get ("closed")is False ):
                    failures .append ("open tidak terverifikasi")

    print ()
    if failures :
        print ("GAGAL:")
        for f in failures :
            print (f"  - {f }")
        return 1 
    print ("SEMUA CEK LULUS")
    return 0 


def main ():
    ap =argparse .ArgumentParser ()
    ap .add_argument ("--chat",required =True ,help ="JID grup uji, mis. 1203...@g.us")
    ap .add_argument ("--write",action ="store_true",help ="uji close lalu open (state dikembalikan)")
    args =ap .parse_args ()
    sys .exit (asyncio .run (run (args .chat ,args .write )))


if __name__ =="__main__":
    main ()
