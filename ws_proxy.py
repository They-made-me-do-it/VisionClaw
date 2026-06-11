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

active_session = None
connection_counter = 0

async def handler(websocket):
    global active_session
    current_task = asyncio.current_task()
    
    if active_session is not None:
        print("[Proxy] Closing existing active session to allow new session takeover...", flush=True)
        prev_session = active_session
        active_session = None
        
        # 1. Close Google WS first to disconnect Google Gemini instantly
        if prev_session.get('google_ws'):
            try:
                asyncio.create_task(prev_session['google_ws'].close())
            except Exception:
                pass
                
        # 2. Close client websocket with 1008 takeover code
        try:
            asyncio.create_task(prev_session['websocket'].close(1008, "New session takeover"))
        except Exception:
            pass
            
        # 3. Cancel the handler task of the previous session and wait for it to terminate
        if prev_session.get('task') and prev_session['task'] != current_task:
            try:
                prev_session['task'].cancel()
                await prev_session['task']
            except (asyncio.CancelledError, Exception):
                pass
                
    global connection_counter
    connection_counter += 1
    session_id = connection_counter

    session_info = {
        'id': session_id,
        'websocket': websocket,
        'google_ws': None,
        'task': current_task
    }
    active_session = session_info
    print(f"[Proxy][Session {session_id}] New connection established. Active session updated.", flush=True)

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
            session_info['google_ws'] = google_ws
            print(f"[Proxy][Session {session_id}] Handshake established with Google. Relaying traffic bidirectionally...", flush=True)
            
            async def forward_to_google():
                print(f"[Proxy][Session {session_id}] Task 'forward_to_google' started.", flush=True)
                try:
                    async for message in websocket:
                        if active_session is None or active_session['id'] != session_id:
                            print(f"[Proxy][Session {session_id}] WARNING: Forwarding to Google while NOT active session! Stacking risk!", flush=True)
                        await google_ws.send(message)
                except websockets.exceptions.ConnectionClosed:
                    print(f"[Proxy][Session {session_id}] Browser websocket closed. Stopping forward_to_google.", flush=True)
                except asyncio.CancelledError:
                    print(f"[Proxy][Session {session_id}] forward_to_google cancelled.", flush=True)
                    
            async def forward_to_browser():
                print(f"[Proxy][Session {session_id}] Task 'forward_to_browser' started.", flush=True)
                try:
                    async for message in google_ws:
                        if active_session is None or active_session['id'] != session_id:
                            print(f"[Proxy][Session {session_id}] WARNING: Forwarding from Google to Browser while NOT active session! STACKED VOICE DETECTED!", flush=True)
                        await websocket.send(message)
                except websockets.exceptions.ConnectionClosed:
                    print(f"[Proxy][Session {session_id}] Google websocket closed. Stopping forward_to_browser.", flush=True)
                except asyncio.CancelledError:
                    print(f"[Proxy][Session {session_id}] forward_to_browser cancelled.", flush=True)
                    
            task_google = asyncio.create_task(forward_to_google())
            task_browser = asyncio.create_task(forward_to_browser())
            
            try:
                done, pending = await asyncio.wait(
                    [task_google, task_browser],
                    return_when=asyncio.FIRST_COMPLETED
                )
            finally:
                task_google.cancel()
                task_browser.cancel()
                
    except asyncio.CancelledError:
        print(f"[Proxy][Session {session_id}] Connection handler cancelled due to session takeover.", flush=True)
        raise
    except Exception as e:
        print(f"[Proxy Exception][Session {session_id}] Error connecting to Google or forwarding traffic: {e}", flush=True)
        try:
            await websocket.close(1011, f"Proxy Error: {e}")
        except Exception:
            pass
    finally:
        if active_session == session_info:
            active_session = None
        print(f"[Proxy][Session {session_id}] Connection session terminated cleanly.", flush=True)

async def main():
    print("[Proxy] Starting local WebSocket proxy on ws://localhost:18791...", flush=True)
    async with websockets.serve(handler, "localhost", 18791, max_size=10*1024*1024):
        await asyncio.Future() # run forever

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("[Proxy] Stopped by user.", flush=True)
