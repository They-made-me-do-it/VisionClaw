# test_dialogue_stacking.py
# Integration test to verify that multiple concurrent connections do not stack dialogue
# and that connection takeover and resource cleanup are properly executed.

import asyncio
import websockets
import json
import os
import sys
import datetime
import urllib.request

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

# Define debugger logger file
log_file_path = os.path.join('_handoff', 'STACKING_DEBUG.log')

def log_debug(level, component, message, cross_ref_ts=None):
    timestamp = datetime.datetime.now(datetime.timezone.utc).isoformat()
    ref_str = f" [Cross-Ref TS: {cross_ref_ts}]" if cross_ref_ts else ""
    log_line = f"[{timestamp}] [{level.upper()}] [{component}] {message}{ref_str}\n"
    
    os.makedirs(os.path.dirname(log_file_path), exist_ok=True)
    with open(log_file_path, 'a', encoding='utf-8') as f:
        f.write(log_line)
    print(log_line.strip())

def save_transcript(sender, type_val, content):
    url = "http://localhost:18790/api/transcript"
    ts = datetime.datetime.now(datetime.timezone.utc).isoformat()
    data = json.dumps({
        "timestamp": ts,
        "sender": sender,
        "type": type_val,
        "content": content
    }).encode('utf-8')
    req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'}, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=3) as response:
            pass
        return ts
    except Exception as e:
        log_debug("ERROR", "TestHarness", f"Failed to log transcript: {e}")
        return ts

async def run_test():
    api_key = load_api_key()
    if not api_key:
        log_debug("ERROR", "TestInit", "GEMINI_API_KEY not found in env or .env")
        sys.exit(1)

    proxy_url = f"ws://localhost:18791?key={api_key}"
    log_debug("INFO", "TestInit", f"Starting stacking dialogue test. Target proxy: {proxy_url}")
    
    test_start_time = datetime.datetime.now(datetime.timezone.utc)
    
    conn1_closed = asyncio.Event()
    conn1_setup_done = asyncio.Event()
    conn2_setup_done = asyncio.Event()
    
    # Setup message definition
    setup_msg = {
        "setup": {
            "model": "models/gemini-2.5-flash-native-audio-preview-09-2025",
            "generationConfig": {
                "responseModalities": ["AUDIO"]
            },
            "systemInstruction": {
                "parts": [
                    {
                        "text": "You are a concise, helpful real-time voice assistant. Keep responses extremely brief and conversational."
                    }
                ]
            }
        }
    }

    # Connection 1 Coroutine
    async def run_connection_1():
        log_debug("INFO", "Conn1", "Initiating WebSocket Connection 1 to proxy...")
        try:
            async with websockets.connect(proxy_url) as ws1:
                log_debug("INFO", "Conn1", "Connection 1 established. Sending setup payload...")
                await ws1.send(json.dumps(setup_msg))
                
                # Wait for setupComplete
                resp = await ws1.recv()
                resp_json = json.loads(resp)
                if "setupComplete" in resp_json:
                    log_debug("INFO", "Conn1", "Connection 1 setupComplete received.")
                    conn1_setup_done.set()
                else:
                    log_debug("WARNING", "Conn1", f"Unexpected setup response: {resp}")
                
                # Send first prompt
                prompt1 = "Hello Gemini, this is Session One. Please say the word 'Alpha' and stop."
                ts = save_transcript("user", "text", prompt1)
                log_debug("INFO", "Conn1", "Connection 1 user prompt registered in transcript log.", cross_ref_ts=ts)
                
                client_msg = {
                    "clientContent": {
                        "turns": [{"role": "user", "parts": [{"text": prompt1}]}],
                        "turnComplete": True
                    }
                }
                log_debug("INFO", "Conn1", "Connection 1 sending prompt payload.")
                await ws1.send(json.dumps(client_msg))
                
                # Keep reading until closed by takeover
                async for message in ws1:
                    # Parse transcript parts if any received before takeover
                    if isinstance(message, bytes):
                        continue
                    try:
                        data = json.loads(message)
                        server_content = data.get("serverContent", {})
                        if "outputTranscription" in server_content:
                            txt = server_content["outputTranscription"].get("text", "")
                            if txt:
                                ts_resp = save_transcript("gemini", "text", txt)
                                log_debug("INFO", "Conn1", "Connection 1 received Gemini response transcript.", cross_ref_ts=ts_resp)
                    except Exception:
                        pass
        except websockets.exceptions.ConnectionClosed as e:
            log_debug("INFO", "Conn1", f"Connection 1 closed as expected due to takeover. Code: {e.code}, Reason: {e.reason}")
            conn1_closed.set()
        except Exception as e:
            log_debug("ERROR", "Conn1", f"Connection 1 encountered unexpected error: {e}")

    # Connection 2 Coroutine
    async def run_connection_2():
        log_debug("INFO", "Conn2", "Waiting for Connection 1 setup before starting Connection 2...")
        await conn1_setup_done.wait()
        
        # Wait 1 second to simulate staggered connection
        await asyncio.sleep(1.0)
        
        log_debug("INFO", "Conn2", "Initiating WebSocket Connection 2 (Takeover)...")
        try:
            async with websockets.connect(proxy_url) as ws2:
                log_debug("INFO", "Conn2", "Connection 2 established. Sending setup payload...")
                await ws2.send(json.dumps(setup_msg))
                
                # Wait for setupComplete
                resp = await ws2.recv()
                resp_json = json.loads(resp)
                if "setupComplete" in resp_json:
                    log_debug("INFO", "Conn2", "Connection 2 setupComplete received.")
                    conn2_setup_done.set()
                
                # Send second prompt
                prompt2 = "Hello Gemini, this is Session Two. Please confirm connection two is active and verify our link."
                ts = save_transcript("user", "text", prompt2)
                log_debug("INFO", "Conn2", "Connection 2 user prompt registered in transcript log.", cross_ref_ts=ts)
                
                client_msg = {
                    "clientContent": {
                        "turns": [{"role": "user", "parts": [{"text": prompt2}]}],
                        "turnComplete": True
                    }
                }
                log_debug("INFO", "Conn2", "Connection 2 sending prompt payload.")
                await ws2.send(json.dumps(client_msg))
                
                # Receive responses
                turn_complete = False
                while not turn_complete:
                    msg = await ws2.recv()
                    data = None
                    if isinstance(msg, bytes):
                        continue
                    try:
                        data = json.loads(msg)
                    except Exception:
                        continue
                        
                    server_content = data.get("serverContent", {})
                    if "outputTranscription" in server_content:
                        txt = server_content["outputTranscription"].get("text", "")
                        if txt:
                            ts_resp = save_transcript("gemini", "text", txt)
                            log_debug("INFO", "Conn2", "Connection 2 received Gemini response transcript.", cross_ref_ts=ts_resp)
                    
                    if "turnComplete" in server_content and server_content["turnComplete"]:
                        log_debug("INFO", "Conn2", "Connection 2 turn completed successfully.")
                        turn_complete = True
                        break
        except Exception as e:
            log_debug("ERROR", "Conn2", f"Connection 2 encountered error: {e}")

    # Start tasks
    task1 = asyncio.create_task(run_connection_1())
    task2 = asyncio.create_task(run_connection_2())
    
    # Wait for test to complete or timeout
    try:
        await asyncio.wait_for(asyncio.gather(task1, task2), timeout=25.0)
    except asyncio.TimeoutError:
        log_debug("WARNING", "TestHarness", "Test timed out before all connections exited naturally.")

    # Verification phase
    log_debug("INFO", "Verification", "Beginning Verification Phase. Analysing transcript log file...")
    
    # Read transcript.jsonl
    transcript_path = os.path.join('_handoff', 'transcript.jsonl')
    if not os.path.exists(transcript_path):
        log_debug("ERROR", "Verification", f"Transcript log file not found at {transcript_path}")
        sys.exit(1)
        
    test_entries = []
    with open(transcript_path, 'r', encoding='utf-8') as f:
        for line in f:
            if not line.strip():
                continue
            try:
                entry = json.loads(line)
                entry_time = datetime.datetime.fromisoformat(entry['timestamp'].replace('Z', '+00:00'))
                if entry_time >= test_start_time:
                    test_entries.append(entry)
            except Exception as e:
                pass
                
    log_debug("INFO", "Verification", f"Found {len(test_entries)} transcript entries logged during test window.")
    
    # Assertions
    is_takeover_successful = conn1_closed.is_set()
    no_stacked_responses = True
    
    # Check if Connection 1's Gemini response is present
    conn1_response_leaked = False
    for entry in test_entries:
        if entry.get('sender') == 'gemini' and entry.get('type') == 'text':
            text = entry.get('text', '').lower()
            if 'alpha' in text:
                conn1_response_leaked = True
                log_debug("FAIL", "Verification", "Leaked response found in transcript.", entry['timestamp'])
                
    if not is_takeover_successful:
        log_debug("FAIL", "Verification", "Connection 1 was NOT closed by session takeover.")
    else:
        log_debug("PASS", "Verification", "Connection 1 was closed cleanly by session takeover.")
        
    if conn1_response_leaked:
        log_debug("FAIL", "Verification", "Stacking Dialogue detected: Old session response leaked into logs.")
        no_stacked_responses = False
    else:
        log_debug("PASS", "Verification", "No stacking dialogue detected. Dialogue isolation verified.")
        
    if is_takeover_successful and no_stacked_responses:
        log_debug("PASS", "TestSummary", "ALL DIALOGUE STACKING TESTS PASSED successfully!")
        sys.exit(0)
    else:
        log_debug("FAIL", "TestSummary", "DIALOGUE STACKING TEST FAILED.")
        sys.exit(1)

if __name__ == "__main__":
    asyncio.run(run_test())
