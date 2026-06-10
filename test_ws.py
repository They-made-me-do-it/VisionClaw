import asyncio
import websockets
import json
import os

def load_api_key():
    # Read .env file manually
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

async def test_connection():
    api_key = load_api_key()
    if not api_key:
        print("Error: GEMINI_API_KEY not found in .env or environment variables.")
        return

    print(f"Loaded API key: {api_key[:10]}... (length: {len(api_key)})")
    
    # Try different models
    models_to_test = [
        "models/gemini-2.0-flash-exp",
        "models/gemini-2.5-flash-native-audio-preview-09-2025",
        "models/gemini-2.5-flash",
    ]

    for model in models_to_test:
        print(f"\nTesting connection with model: {model}")
        ws_url = f"wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key={api_key}"
        
        try:
            async with websockets.connect(ws_url) as ws:
                print("WebSocket connection established! Sending setup message...")
                setup_msg = {
                    "setup": {
                        "model": model
                    }
                }
                await ws.send(json.dumps(setup_msg))
                
                # Wait for response
                try:
                    response_text = await asyncio.wait_for(ws.recv(), timeout=5.0)
                    response = json.loads(response_text)
                    print(f"Received response: {json.dumps(response, indent=2)}")
                except asyncio.TimeoutError:
                    print("Timeout waiting for response after setup.")
                except Exception as e:
                    print(f"Error receiving response: {e}")
        except websockets.exceptions.ConnectionClosed as e:
            print(f"Connection closed. Code: {e.code}, Reason: {e.reason}")
        except Exception as e:
            print(f"Failed to connect: {e}")

if __name__ == "__main__":
    asyncio.run(test_connection())
