# run_voice_handshake.py
import asyncio
import websockets
import json
import os
import sys
import urllib.request
import datetime

def load_api_key():
    if os.path.exists('.env'):
        with open('.env', 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#'):
                    continue
                if '=' in line:
                    key, val = line.split('=', 1)
                    if key.strip() == 'GEMINI_API_KEY':
                        val = val.strip()
                        if val.startswith('"') and val.endswith('"'):
                            val = val[1:-1]
                        elif val.startswith("'") and val.endswith("'"):
                            val = val[1:-1]
                        return val
    return os.environ.get('GEMINI_API_KEY')

def report_status(status):
    url = "http://localhost:18790/api/post_check/voice"
    data = json.dumps({"status": status}).encode('utf-8')
    req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'}, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=3) as response:
            print(f"[Python Handshake] Status '{status}' successfully reported to Node server. Response Code: {response.status}")
    except Exception as e:
        print(f"[Python Handshake Error] Failed to report status '{status}' to Node server: {e}")

def save_transcript(sender, type_val, content):
    url = "http://localhost:18790/api/transcript"
    data = json.dumps({
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "sender": sender,
        "type": type_val,
        "content": content
    }).encode('utf-8')
    req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'}, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=3) as response:
            pass
    except Exception as e:
        print(f"[Python Handshake Log Error] Failed to log transcript: {e}")

async def main():
    api_key = load_api_key()
    if not api_key:
        print("Error: GEMINI_API_KEY is not defined in .env or environment.")
        report_status("FAIL")
        sys.exit(1)

    print(f"[Python Handshake] Loaded key: {api_key[:10]}... (length: {len(api_key)})")
    model = "models/gemini-2.5-flash-native-audio-preview-09-2025"
    ws_url = f"ws://localhost:18791/?key={api_key}"

    print(f"[Python Handshake] Connecting to Gemini Live WebSocket...")
    try:
        async with websockets.connect(ws_url) as ws:
            print("[Python Handshake] Connected! Sending Setup Message...")
            setup_msg = {
                "setup": {
                    "model": model,
                    "generationConfig": {
                        "responseModalities": ["AUDIO"]
                    },
                    "systemInstruction": {
                        "parts": [
                            {
                                "text": "You are a concise, helpful real-time voice assistant for the VisionClaw wearable device. Speak naturally, keep responses extremely brief and conversational, and do not use markdown formatting or list thoughts. Directly answer the user without conversational filler or prefaces."
                            }
                        ]
                    },
                    "inputAudioTranscription": {},
                    "outputAudioTranscription": {}
                }
            }
            await ws.send(json.dumps(setup_msg))

            # 1. Wait for setupComplete
            resp = await asyncio.wait_for(ws.recv(), timeout=5.0)
            resp_json = json.loads(resp)
            if "setupComplete" in resp_json:
                print("[Python Handshake] Handshake Success: setupComplete received!")
            else:
                print(f"[Python Handshake Error] Unexpected initial response: {resp}")
                report_status("FAIL")
                sys.exit(1)

            # 2. Turn 1: Send the voice check prompt
            turn1_prompt = "VisionClaw POST check initiated. Gemini, please perform step 1 of the voice check-in: ask the user 'Hello, this is Gemini. Can you hear me?' and STOP speaking immediately. Do NOT say anything else. You must wait for their response."
            print(f"[Python Handshake] Sending Turn 1 content: '{turn1_prompt}'")
            
            client_msg = {
                "clientContent": {
                    "turns": [
                        {
                            "role": "user",
                            "parts": [
                                { "text": turn1_prompt }
                            ]
                        }
                    ],
                    "turnComplete": True
                }
            }
            await ws.send(json.dumps(client_msg))
            save_transcript("user", "text", turn1_prompt)

            print("[Python Handshake] Listening for Gemini Turn 1 ask...")
            
            # Receive loop for Turn 1
            turn1_complete = False
            start_time = asyncio.get_event_loop().time()
            turn1_text = ""
            
            while not turn1_complete and (asyncio.get_event_loop().time() - start_time < 15.0):
                try:
                    msg = await asyncio.wait_for(ws.recv(), timeout=2.0)
                except asyncio.TimeoutError:
                    continue
                
                # Try to decode msg as JSON
                data = None
                is_json = False
                if isinstance(msg, bytes):
                    try:
                        decoded = msg.decode('utf-8')
                        if decoded.strip().startswith('{'):
                            data = json.loads(decoded)
                            is_json = True
                    except Exception:
                        pass
                else:
                    try:
                        data = json.loads(msg)
                        is_json = True
                    except Exception:
                        pass

                if not is_json:
                    # Raw PCM audio bytes
                    continue
                
                print(f"[Python Handshake Turn 1 Msg] {json.dumps(data)}")
                server_content = data.get("serverContent", {})
                
                if "outputTranscription" in server_content:
                    text_val = server_content["outputTranscription"].get("text", "")
                    if text_val:
                        print(f"[Python Handshake] Gemini Turn 1 output transcription: '{text_val}'")
                        turn1_text += text_val
                
                # Check parts
                model_turn = server_content.get("modelTurn", {})
                parts = model_turn.get("parts", server_content.get("parts", []))
                for part in parts:
                    if "text" in part:
                        turn1_text += part["text"]

                # Check for turnComplete to end Turn 1
                if ("turnComplete" in server_content and server_content["turnComplete"]):
                    print("[Python Handshake] Gemini Turn 1 completed speaking. Transitioning to Turn 2.")
                    if turn1_text:
                        save_transcript("gemini", "text", turn1_text)
                    turn1_complete = True
                    break

            if not turn1_complete:
                print("[Python Handshake Error] Turn 1 speaking completion timed out.")
                report_status("FAIL")
                sys.exit(1)

            # 3. Turn 2: Send user response
            await asyncio.sleep(1.0)
            turn2_response = "Yes, I can hear you clearly. You MUST now say exactly: 'The link is verified and operational.'"
            print(f"[Python Handshake] Sending Turn 2 content: '{turn2_response}'")
            
            response_msg = {
                "clientContent": {
                    "turns": [
                        {
                            "role": "user",
                            "parts": [
                                { "text": turn2_response }
                            ]
                        }
                    ],
                    "turnComplete": True
                }
            }
            await ws.send(json.dumps(response_msg))
            save_transcript("user", "text", turn2_response)


            print("[Python Handshake] Listening for Gemini Turn 2 confirmation...")
            
            # Receive loop for Turn 2
            confirmed = False
            start_time = asyncio.get_event_loop().time()
            transcripts = []
            
            while (asyncio.get_event_loop().time() - start_time < 15.0):
                try:
                    msg = await asyncio.wait_for(ws.recv(), timeout=2.0)
                except asyncio.TimeoutError:
                    if confirmed:
                        break
                    continue
                
                # Try to decode msg as JSON
                data = None
                is_json = False
                if isinstance(msg, bytes):
                    try:
                        decoded = msg.decode('utf-8')
                        if decoded.strip().startswith('{'):
                            data = json.loads(decoded)
                            is_json = True
                    except Exception:
                        pass
                else:
                    try:
                        data = json.loads(msg)
                        is_json = True
                    except Exception:
                        pass

                if not is_json:
                    # Raw PCM audio bytes
                    continue
                
                print(f"[Python Handshake Turn 2 Msg] {json.dumps(data)}")
                server_content = data.get("serverContent", {})
                # Check transcripts
                trans_text = ""
                if "outputTranscription" in server_content:
                    trans_text = server_content["outputTranscription"].get("text", "")
                
                model_turn = server_content.get("modelTurn", {})
                parts = model_turn.get("parts", server_content.get("parts", []))
                for part in parts:
                    if "text" in part:
                        trans_text = part["text"]

                if trans_text:
                    print(f"[Python Handshake] Gemini Turn 2 output transcript: '{trans_text}'")
                    transcripts.append(trans_text.lower())
                    
                # Check if any transcript has confirmation words
                full_text = " ".join(transcripts)
                if any(word in full_text for word in ["verified", "operational", "working", "hear you", "online", "success"]):
                    print("[Python Handshake] SUCCESS: Gemini confirmed link is verified and operational!")
                    if not confirmed:
                        save_transcript("gemini", "text", trans_text or full_text)
                    confirmed = True
                    
                if "turnComplete" in server_content and server_content["turnComplete"]:
                    if confirmed:
                        break


            if confirmed:
                report_status("PASS")
                sys.exit(0)
            else:
                print(f"[Python Handshake Error] Failed to obtain operational/verified confirmation. Received transcripts: {transcripts}")
                report_status("FAIL")
                sys.exit(1)

    except Exception as e:
        print(f"[Python Handshake Error] Connection or execution error: {e}")
        report_status("FAIL")
        sys.exit(1)

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        report_status("FAIL")
        sys.exit(1)
