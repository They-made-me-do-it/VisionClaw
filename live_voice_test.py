import asyncio
import websockets
import json
import os
import sys

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

async def main():
    api_key = load_api_key()
    if not api_key:
        print("Error: GEMINI_API_KEY is not defined in .env or environment.")
        sys.exit(1)

    print(f"Loaded key: {api_key[:10]}... (length: {len(api_key)})")
    model = "models/gemini-2.5-flash-native-audio-preview-09-2025"
    ws_url = f"wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key={api_key}"

    print(f"Connecting to Gemini Live WebSocket...")
    try:
        async with websockets.connect(ws_url) as ws:
            print("Connected! Sending Setup Message...")
            setup_msg = {
                "setup": {
                    "model": model,
                    "generationConfig": {
                        "responseModalities": ["AUDIO"]
                    }
                }
            }
            await ws.send(json.dumps(setup_msg))

            # Wait for setupComplete
            resp = await asyncio.wait_for(ws.recv(), timeout=5.0)
            resp_json = json.loads(resp)
            if "setupComplete" in resp_json:
                print("Handshake Success: setupComplete received!")
            else:
                print(f"Unexpected initial response: {resp}")
                return

            # Send the voice check prompt
            prompt = "VisionClaw Power-On Self-Test (POST) check completed successfully. Gemini, please check in with the user by asking them in a friendly, conversational tone if they can hear you, and confirm that our two-way audio link is active."
            print(f"Sending client turn content: '{prompt}'")
            
            client_msg = {
                "clientContent": {
                    "turns": [
                        {
                            "role": "user",
                            "parts": [
                                { "text": prompt }
                            ]
                        }
                    ],
                    "turnComplete": True
                }
            }
            await ws.send(json.dumps(client_msg))

            print("Listening for Gemini response audio stream...")
            audio_bytes_count = 0
            text_received = []
            
            # Read messages for 8 seconds
            start_time = asyncio.get_event_loop().time()
            while asyncio.get_event_loop().time() - start_time < 8.0:
                try:
                    msg = await asyncio.wait_for(ws.recv(), timeout=1.0)
                    
                    if isinstance(msg, bytes):
                        audio_bytes_count += len(msg)
                        continue
                    
                    data = json.loads(msg)
                    if "serverContent" in data:
                        server_content = data["serverContent"]
                        model_turn = server_content.get("modelTurn", {})
                        parts = model_turn.get("parts", server_content.get("parts", []))
                        for part in parts:
                            if "text" in part:
                                text_val = part["text"]
                                print(f"[Gemini Text]: {text_val}")
                                text_received.append(text_val)
                            if "inlineData" in part:
                                inline_data = part["inlineData"]
                                mime = inline_data.get("mimeType", "")
                                if "audio" in mime:
                                    b64_data = inline_data.get("data", "")
                                    audio_bytes_count += (len(b64_data) * 3) // 4
                except asyncio.TimeoutError:
                    continue
                except Exception as e:
                    print(f"Error during receive loop: {e}")
                    break

            print("\n=== TEST RESULTS ===")
            print(f"Total Text Parts Received: {len(text_received)}")
            print(f"Total Audio Data Received: {audio_bytes_count} bytes")
            if audio_bytes_count > 0:
                print("SUCCESS: Live bidirectional audio handshake is active and fully functional!")
                sys.exit(0)
            else:
                print("FAILED: Did not receive any audio bytes.")
                sys.exit(1)

    except Exception as e:
        print(f"WebSocket Connection Failed: {e}")
        sys.exit(1)

if __name__ == "__main__":
    asyncio.run(main())
