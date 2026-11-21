
"""Local-only WhatsApp voice-note transcription helper. Audio is never uploaded."""
import argparse 
import json 
import os 
import sys 
import tempfile 
from pathlib import Path 

MAX_BYTES =16 *1024 *1024 
MAX_SECONDS =600 
MODEL_DIR =Path (os .environ .get ("WA_STT_MODEL_DIR","/root/.cache/whisper"))
MODEL_NAME =os .environ .get ("WA_STT_MODEL","small")


def main ()->int :
    parser =argparse .ArgumentParser ()
    parser .add_argument ("--input",required =True )
    args =parser .parse_args ()
    source =Path (args .input )
    if not source .is_file ()or source .stat ().st_size ==0 or source .stat ().st_size >MAX_BYTES :
        print (json .dumps ({"success":False ,"error":"Input audio missing, empty, or exceeds 16 MB"}))
        return 2 
    from faster_whisper import WhisperModel 
    with tempfile .TemporaryDirectory (prefix ="wa-stt-")as temp :
        model =WhisperModel (MODEL_NAME ,device ="cpu",compute_type ="int8",download_root =str (MODEL_DIR ))
        segments ,info =model .transcribe (str (source ),language ="id",beam_size =1 ,vad_filter =True )
        output =[]
        elapsed =0.0 
        for seg in segments :
            if seg .end >MAX_SECONDS :
                break 
            elapsed =seg .end 
            text =seg .text .strip ()
            if text :
                output .append (text )
        print (json .dumps ({"success":True ,"text":" ".join (output ),"language":info .language ,"duration":min (float (info .duration or elapsed ),MAX_SECONDS )},ensure_ascii =False ))
    return 0 


if __name__ =="__main__":
    try :
        raise SystemExit (main ())
    except Exception as exc :
        print (json .dumps ({"success":False ,"error":str (exc )[:500 ]},ensure_ascii =False ))
        raise SystemExit (0 )
