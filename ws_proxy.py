# ws_proxy.py
# VisionClaw Local WebSocket Proxy for Gemini Live
# Proxies browser WebSocket connections to bypass browser Origin-based key revocation checks (Code 1008)

import asyncio
import websockets
import os
import sys
import urllib.parse

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

async def handler(websocket):
    # Parse API key from query params or fall back to .env
    try:
        path = websocket.request.path
    except AttributeError:
        path = websocket.path
    parsed = urllib.parse.urlparse(path)
    params = urllib.parse.parse_qs(parsed.query)
    api_key_list = params.get('key')
    
    api_key = api_key_list[0] if api_key_list else None
    if not api_key:
        api_key = load_api_key()
        
    if not api_key:
        print("[Proxy] Error: GEMINI_API_KEY not found in query parameters or .env file.", flush=True)
        await websocket.close(1008, "GEMINI_API_KEY missing")
        return
        
    google_url = f"wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key={api_key}"
    print(f"[Proxy] Client connected. Connecting to Google Gemini Live API...", flush=True)
    
    try:
        # Connect to Google. This backend request will not include the browser Origin header.
        async with websockets.connect(google_url) as google_ws:
            print("[Proxy] Handshake established with Google. Relaying traffic bidirectionally...", flush=True)
            
            async def forward_to_google():
                try:
                    async for message in websocket:
                        await google_ws.send(message)
                except websockets.exceptions.ConnectionClosed:
                    pass
                    
            async def forward_to_browser():
                try:
                    async for message in google_ws:
                        await websocket.send(message)
                except websockets.exceptions.ConnectionClosed:
                    pass
                    
            await asyncio.gather(forward_to_google(), forward_to_browser())
            
    except Exception as e:
        print(f"[Proxy Exception] Error connecting to Google or forwarding traffic: {e}", flush=True)
        try:
            await websocket.close(1011, f"Proxy Error: {e}")
        except Exception:
            pass
    finally:
        print("[Proxy] Connection session terminated.", flush=True)

async def main():
    print("[Proxy] Starting local WebSocket proxy on ws://localhost:18791...", flush=True)
    async with websockets.serve(handler, "localhost", 18791, max_size=10*1024*1024):
        await asyncio.Future() # run forever

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("[Proxy] Stopped by user.", flush=True)
