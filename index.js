// index.js
// VisionClaw Dashboard Controller - UI Logic, Local POST self-test, and browser Gemini Live client

document.addEventListener('DOMContentLoaded', () => {
    // Health Lights
    const lightNode = document.getElementById('light-node');
    const lightGateway = document.getElementById('light-gateway');
    const lightPhone = document.getElementById('light-phone');
    const lightGemini = document.getElementById('light-gemini');
    const lightGlasses = document.getElementById('light-glasses');

    // POST Panel Elements
    const postOverallStatus = document.getElementById('post-overall-status');
    const localModeCheckbox = document.getElementById('local-mode-checkbox');
    const defaultLocal = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
    localModeCheckbox.checked = defaultLocal;

    const postNode = document.getElementById('post-node');
    const postGateway = document.getElementById('post-gateway');
    const postClient = document.getElementById('post-client');
    const postAudio = document.getElementById('post-audio');
    const postGemini = document.getElementById('post-gemini');
    const postFeedback = document.getElementById('post-feedback');

    // Gemini Live Ingress Elements
    const connectWsBtn = document.getElementById('connect-ws-btn');
    const disconnectWsBtn = document.getElementById('disconnect-ws-btn');
    const apiKeyInput = document.getElementById('api-key-input');
    const gatewayIpInput = document.getElementById('gateway-ip-input');
    const socketStatusBadge = document.getElementById('socket-status-badge');
    const resumptionTokenEl = document.getElementById('resumption-token');
    const wssLogsEl = document.getElementById('wss-logs');

    // Media Elements
    const cameraCanvas = document.getElementById('camera-canvas');
    const cameraCtx = cameraCanvas.getContext('2d');
    const waveformCanvas = document.getElementById('waveform-canvas');
    const waveformCtx = waveformCanvas.getContext('2d');
    const frameCounterEl = document.getElementById('frame-counter');
    const micToggleBtn = document.getElementById('mic-toggle-btn');
    const snapBtn = document.getElementById('snap-btn');

    // Action Router & Metrics Elements
    const toolForm = document.getElementById('tool-form');
    const toolSelect = document.getElementById('tool-select');
    const toolArgs = document.getElementById('tool-args');
    const invocationCountEl = document.getElementById('metric-invocations');
    const failureCountEl = document.getElementById('metric-failures');
    const rttEl = document.getElementById('metric-rtt');
    const clawLogsEl = document.getElementById('claw-logs');
    const refreshGalleryBtn = document.getElementById('refresh-gallery-btn');
    const galleryGrid = document.getElementById('gallery-grid');

    // Amazon Inventory Recon Elements
    const amazonQuery = document.getElementById('amazon-query');
    const amazonSearchBtn = document.getElementById('amazon-search-btn');
    const amazonResults = document.getElementById('amazon-results');

    // State Variables
    let isLocalMode = defaultLocal;
    let isWebsocketConnected = false;
    let ws = null;
    let audioCtx = null;
    let micStream = null;
    let mediaRecorderNode = null;
    let processorNode = null;
    let nextAudioPlayTime = 0;
    let cameraStream = null;
    let frameCount = 0;
    let audioInputReady = false;
    let isRecordingAudio = false;
    let videoTimerId = null;
    let diagnosticInterval = null;
    let isPostChecking = false;

    // Metrics Counter
    let metricInvocations = 0;
    let metricFailures = 0;

    function logTerminal(message, type = 'system') {
        const line = document.createElement('div');
        line.className = `terminal-line ${type}`;
        const timestamp = new Date().toLocaleTimeString();
        line.innerText = `[${timestamp}] ${message}`;
        wssLogsEl.appendChild(line);
        wssLogsEl.scrollTop = wssLogsEl.scrollHeight;
    }

    function logClaw(message, type = 'system') {
        const line = document.createElement('div');
        line.className = `log-entry ${type}`;
        line.innerText = message;
        clawLogsEl.appendChild(line);
        clawLogsEl.scrollTop = clawLogsEl.scrollHeight;
    }

    function setLightStatus(el, status) {
        if (!el) return;
        el.className = `status-light light-${status}`;
    }

    function setBadgeStatus(el, text, statusClass) {
        if (!el) return;
        el.innerText = text.toUpperCase();
        el.className = `status-badge ${statusClass}`;
    }

    // --- 1. POST (Power-On Self-Test) Logic ---
    async function runPostCheck() {
        postFeedback.style.display = 'block';
        postFeedback.innerText = "Initializing Power-On Self-Test (POST)...";
        isPostChecking = true;
        localModeCheckbox.disabled = true; // Block interaction during diagnostic test
        setBadgeStatus(postOverallStatus, 'post: checking', 'state-checking');

        // Step 1: Check Node Server
        setBadgeStatus(postNode, 'checking', 'state-checking');
        await new Promise(r => setTimeout(r, 600));
        let nodeOk = false;
        try {
            const res = await fetch('/api/config');
            if (res.ok) nodeOk = true;
        } catch(e) {}

        if (nodeOk) {
            setBadgeStatus(postNode, 'pass', 'state-pass');
            setLightStatus(lightNode, 'ok');
        } else {
            setBadgeStatus(postNode, 'fail', 'state-fail');
            setLightStatus(lightNode, 'error');
            postFeedback.innerText = "POST Failed: Node server unreachable.";
            setBadgeStatus(postOverallStatus, 'post: failed', 'state-fail');
            localModeCheckbox.disabled = false;
            isPostChecking = false;
            return;
        }

        // Step 2: Check OpenClaw Gateway
        setBadgeStatus(postGateway, 'checking', 'state-checking');
        await new Promise(r => setTimeout(r, 600));
        let gatewayOk = false;
        try {
            const res = await fetch('/api/post_check');
            const data = await res.json();
            if (data.gateway === "PASS") gatewayOk = true;
        } catch(e) {}

        if (gatewayOk) {
            setBadgeStatus(postGateway, 'pass', 'state-pass');
            setLightStatus(lightGateway, 'ok');
        } else {
            setBadgeStatus(postGateway, 'fail', 'state-fail');
            setLightStatus(lightGateway, 'error');
            postFeedback.innerText = "POST Failed: OpenClaw gateway offline. Ensure port 18789 is running.";
            setBadgeStatus(postOverallStatus, 'post: failed', 'state-fail');
            localModeCheckbox.disabled = false;
            isPostChecking = false;
            return;
        }

        // Step 3: Check Client Device
        setBadgeStatus(postClient, 'checking', 'state-checking');
        await new Promise(r => setTimeout(r, 600));
        
        if (isLocalMode) {
            setBadgeStatus(postClient, 'pass', 'state-pass');
            setLightStatus(lightPhone, 'ok');
        } else {
            // Check if we have received S25 diagnostics recently
            let s25Active = false;
            try {
                const res = await fetch('/api/diagnostics_latest');
                const report = await res.json();
                if (report && !report.error && (Date.now() - report.timestamp < 30000)) {
                    s25Active = true;
                }
            } catch(e) {}

            if (s25Active) {
                setBadgeStatus(postClient, 'pass', 'state-pass');
                setLightStatus(lightPhone, 'ok');
            } else {
                setBadgeStatus(postClient, 'fail', 'state-fail');
                setLightStatus(lightPhone, 'error');
                postFeedback.innerText = "POST Failed: Client device heartbeat not detected. Connect phone or switch to Local PC Mode.";
                setBadgeStatus(postOverallStatus, 'post: failed', 'state-fail');
                localModeCheckbox.disabled = false;
                isPostChecking = false;
                return;
            }
        }

        // Step 4: Check Audio IO
        setBadgeStatus(postAudio, 'checking', 'state-checking');
        await new Promise(r => setTimeout(r, 600));
        
        if (isLocalMode) {
            // Ask for browser microphone access
            try {
                const testStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                testStream.getTracks().forEach(t => t.stop()); // close immediately
                audioInputReady = true;
                setBadgeStatus(postAudio, 'pass', 'state-pass');
                setLightStatus(lightGlasses, 'ok');
            } catch (e) {
                audioInputReady = false;
                setBadgeStatus(postAudio, 'fail', 'state-fail');
                setLightStatus(lightGlasses, 'error');
                postFeedback.innerText = "POST Failed: Cannot access microphone.";
                setBadgeStatus(postOverallStatus, 'post: failed', 'state-fail');
                localModeCheckbox.disabled = false;
                isPostChecking = false;
                return;
            }
        } else {
            // Check Android audio scope state
            let glassesAudioOk = false;
            try {
                const res = await fetch('/api/diagnostics_latest');
                const report = await res.json();
                if (report && report.audioHardware && report.audioHardware.isScoConnected) {
                    glassesAudioOk = true;
                }
            } catch(e) {}

            if (glassesAudioOk) {
                setBadgeStatus(postAudio, 'pass', 'state-pass');
                setLightStatus(lightGlasses, 'ok');
            } else {
                setBadgeStatus(postAudio, 'fail', 'state-fail');
                setLightStatus(lightGlasses, 'error');
                postFeedback.innerText = "POST Warning: Smart glasses audio not active. Connect audio on device.";
                setBadgeStatus(postAudio, 'warn', 'state-checking');
            }
        }

        // Step 5: Check Gemini Live connection & trigger conversational check-in
        setBadgeStatus(postGemini, 'checking', 'state-checking');
        await new Promise(r => setTimeout(r, 600));

        if (isWebsocketConnected) {
            setBadgeStatus(postGemini, 'pass', 'state-pass');
            setLightStatus(lightGemini, 'active');
            postFeedback.innerText = "POST Passed. Gemini Live connected. Voice handshake complete.";
            setBadgeStatus(postOverallStatus, 'post: passed', 'state-pass');
            localModeCheckbox.disabled = false;
            
            // Automatically engage microphone and ask Gemini to check in
            isPostChecking = false;
            await startMicrophoneCapture();
            const handshakePrompt = "VisionClaw Power-On Self-Test (POST) check completed successfully. Gemini, please check in with the user by asking them in a friendly, conversational tone if they can hear you, and confirm that our two-way audio link is active.";
            sendIntroGreeting(handshakePrompt);
        } else {
            postFeedback.innerText = "POST Local Checks Passed. Connecting to Gemini Live for voice validation...";
            try {
                await connectGeminiLive();
                
                setBadgeStatus(postGemini, 'pass', 'state-pass');
                setLightStatus(lightGemini, 'active');
                postFeedback.innerText = "POST Passed. Gemini Live connected. Voice handshake active...";
                setBadgeStatus(postOverallStatus, 'post: passed', 'state-pass');
                localModeCheckbox.disabled = false;
                
                isPostChecking = false;
                
                // Automatically engage microphone and ask Gemini to check in
                setTimeout(async () => {
                    await startMicrophoneCapture();
                    const handshakePrompt = "VisionClaw Power-On Self-Test (POST) check completed successfully. Gemini, please check in with the user by asking them in a friendly, conversational tone if they can hear you, and confirm that our two-way audio link is active.";
                    sendIntroGreeting(handshakePrompt);
                }, 800);
            } catch (err) {
                setBadgeStatus(postGemini, 'fail', 'state-fail');
                setLightStatus(lightGemini, 'error');
                postFeedback.innerText = `POST Failed: Gemini Live Connection Error: ${err.message}`;
                setBadgeStatus(postOverallStatus, 'post: failed', 'state-fail');
                localModeCheckbox.disabled = false;
                isPostChecking = false;
            }
        }
    }

    // --- 2. Live Health Checking Loop ---
    function updateHealthDashboard() {
        if (isLocalMode) {
            // Direct Local values overrides phone heartbeats
            setLightStatus(lightNode, 'ok');
            setLightStatus(lightGateway, 'ok'); // Managed by POST response check
            setLightStatus(lightPhone, 'ok'); // Phone light stands for local browser
            setLightStatus(lightGlasses, audioInputReady ? 'ok' : 'error');
            setLightStatus(lightGemini, isWebsocketConnected ? 'active' : 'off');
            return;
        }

        // Regular phone heartbeat mode
        fetch('/api/config')
            .then(res => res.ok ? res.json() : Promise.reject())
            .then(() => setLightStatus(lightNode, 'ok'))
            .catch(() => setLightStatus(lightNode, 'error'));

        fetch('/api/diagnostics_latest')
            .then(res => res.json())
            .then(report => {
                if (report.error) {
                    setLightStatus(lightPhone, 'off');
                    setLightStatus(lightGemini, 'off');
                    setLightStatus(lightGlasses, 'off');
                    return;
                }

                const reportAge = Date.now() - report.timestamp;
                if (reportAge < 20000) {
                    setLightStatus(lightPhone, 'ok');
                    setLightStatus(lightGemini, report.isGeminiActive ? 'active' : 'off');
                    setLightStatus(lightGlasses, (report.audioHardware && report.audioHardware.isScoConnected) ? 'ok' : 'error');
                } else {
                    setLightStatus(lightPhone, 'warn');
                    setLightStatus(lightGemini, 'off');
                    setLightStatus(lightGlasses, 'off');
                }
            })
            .catch(() => setLightStatus(lightPhone, 'off'));
    }

    // --- 3. Browser Gemini Live WebSocket Client ---
    function connectGeminiLive() {
        return new Promise((resolve, reject) => {
            const apiKey = apiKeyInput.value.trim();
            const gatewayHost = gatewayIpInput.value.trim() || 'localhost';

            if (!apiKey) {
                logTerminal("Connection Failed: Gemini API Key is required.", "error");
                reject(new Error("Gemini API Key is missing. Please configure D:\\Meta\\.env."));
                return;
            }

            logTerminal("Initiating WebSocket connection to Gemini Live...", "system");
            
            // Initialize Web Audio context
            try {
                if (!audioCtx) {
                    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                }
            } catch (e) {
                logTerminal(`Failed to initialize AudioContext: ${e.message}`, "error");
            }

            const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(apiKey)}`;

            try {
                ws = new WebSocket(wsUrl);
            } catch(e) {
                logTerminal(`WebSocket failed to create: ${e.message}`, "error");
                reject(e);
                return;
            }

            // Connection & Handshake timeout (10 seconds)
            const connTimeout = setTimeout(() => {
                logTerminal("Gemini Live WebSocket connection/handshake timed out.", "error");
                try { ws.close(); } catch(err) {}
                reject(new Error("Connection/handshake timed out waiting for setupComplete."));
            }, 10000);

            ws.onopen = () => {
                isWebsocketConnected = true;
                logTerminal("WebSocket connection successfully established.", "server");
                socketStatusBadge.innerText = "CONNECTED";
                socketStatusBadge.className = "status-value status-ok";
                setLightStatus(lightGemini, 'active');

                // Send setup config block
                const setupMsg = {
                    setup: {
                        model: "models/gemini-2.5-flash-native-audio-preview-09-2025"
                    }
                };
                ws.send(JSON.stringify(setupMsg));
                logTerminal("> BidiGenerateContentSetup [Target: models/gemini-2.5-flash-native-audio-preview-09-2025] sent.", "client");

                // Update UI elements
                connectWsBtn.classList.add('hidden');
                disconnectWsBtn.classList.remove('hidden');

                // Start Webcam frame streaming if permitted
                startCameraPipeline();
            };

            ws.onmessage = async (event) => {
                let text = "";
                if (event.data instanceof Blob) {
                    const arrayBuffer = await event.data.arrayBuffer();
                    const pcm16 = new Int16Array(arrayBuffer);
                    playPCM24k(pcm16);
                    return;
                } else {
                    text = event.data;
                }

                try {
                    const response = JSON.parse(text);
                    
                    // Print to terminal logs
                    if (response.setupComplete) {
                        clearTimeout(connTimeout);
                        logTerminal("< setupComplete payload received.", "server");
                        resolve();
                    }

                    // Handle text transcript display
                    if (response.serverContent) {
                        const serverContent = response.serverContent;
                        const modelTurn = serverContent.modelTurn;
                        const parts = modelTurn ? modelTurn.parts : serverContent.parts;
                        
                        if (parts) {
                            parts.forEach(part => {
                                if (part.text) {
                                    logTerminal(`Gemini: ${part.text}`, "server");
                                }
                                if (part.inlineData) {
                                    const mime = part.inlineData.mimeType;
                                    if (mime.includes("audio/pcm")) {
                                        const base64Data = part.inlineData.data;
                                        const rawBytes = atob(base64Data);
                                        const pcmData = new Int16Array(rawBytes.length / 2);
                                        for(let i=0; i<pcmData.length; i++) {
                                            pcmData[i] = (rawBytes.charCodeAt(i*2) & 0xFF) | ((rawBytes.charCodeAt(i*2+1) & 0xFF) << 8);
                                        }
                                        playPCM24k(pcmData);
                                    }
                                }
                            });
                        }
                    }

                    // Handle session resumption tokens
                    if (response.sessionResumptionUpdate) {
                        const token = response.sessionResumptionUpdate.new_handle || response.sessionResumptionUpdate.resumptionToken;
                        if (token) {
                            resumptionTokenEl.innerText = token.slice(0, 16) + "...";
                        }
                    }

                    // Handle Tool Calls
                    if (response.toolCall) {
                        const functionCalls = response.toolCall.functionCalls;
                        if (functionCalls) {
                            for (let call of functionCalls) {
                                if (call.name === "execute") {
                                    handleGeminiToolCall(call.args, call.id, gatewayHost);
                                }
                            }
                        }
                    }
                } catch(e) {
                    console.error("Parse error:", e);
                }
            };

            ws.onerror = (error) => {
                clearTimeout(connTimeout);
                logTerminal(`WebSocket Error occurred. Connection aborted.`, "error");
                reject(new Error("WebSocket encountered a network error. Check Internet connectivity."));
            };

            ws.onclose = (e) => {
                clearTimeout(connTimeout);
                handleWebsocketCleanup();
                reject(new Error(`WebSocket closed. Code: ${e.code}. Reason: ${e.reason || "None"}`));
            };
        });
    }

    function sendIntroGreeting(customPrompt) {
        const prompt = customPrompt || "VisionClaw PC Host Online. Gemini, introducing myself. Confirm audio/video telemetry link active.";
        const greeting = {
            clientContent: {
                turns: [
                    {
                        role: "user",
                        parts: [{ text: prompt }]
                    }
                ],
                turnComplete: true
            }
        };
        ws.send(JSON.stringify(greeting));
        logTerminal(`> Send Handshake Content: "${prompt}"`, "client");
    }

    function handleWebsocketCleanup() {
        isWebsocketConnected = false;
        ws = null;
        logTerminal("WebSocket connection closed cleanly.", "system");
        socketStatusBadge.innerText = "DISCONNECTED";
        socketStatusBadge.className = "status-value status-error";
        setLightStatus(lightGemini, 'off');

        connectWsBtn.classList.remove('hidden');
        disconnectWsBtn.classList.add('hidden');

        // Stop camera
        if (cameraStream) {
            cameraStream.getTracks().forEach(t => t.stop());
            cameraStream = null;
        }
        if (videoTimerId) {
            clearInterval(videoTimerId);
            videoTimerId = null;
        }
        stopMicrophoneCapture();
    }

    function disconnectGeminiLive() {
        if (ws) {
            ws.close();
        }
    }

    // --- 4. Audio Input streaming to Gemini Live ---
    async function startMicrophoneCapture() {
        if (!isWebsocketConnected) {
            alert("Please connect to the Gemini Live session first.");
            return;
        }

        try {
            micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const source = audioCtx.createMediaStreamSource(micStream);
            
            // ScriptProcessorNode for sample conversion (using standard buffer size 4096)
            processorNode = audioCtx.createScriptProcessor(4096, 1, 1);
            
            const nativeSampleRate = audioCtx.sampleRate;
            let sampleBuffer = [];

            processorNode.onaudioprocess = (e) => {
                if (!isWebsocketConnected) return;

                const inputData = e.inputBuffer.getChannelData(0);
                
                // Simple downsampling to 16 kHz Mono
                const ratio = nativeSampleRate / 16000;
                let index = 0;
                while (index < inputData.length) {
                    const sample = inputData[Math.round(index)];
                    // Convert float to Int16 PCM sample
                    const intSample = sample < 0 ? sample * 32768 : sample * 32767;
                    sampleBuffer.push(Math.max(-32768, Math.min(32767, intSample)));
                    index += ratio;
                }

                // If sample buffer size >= 1600 samples (100 ms chunk), stream it
                if (sampleBuffer.length >= 1600) {
                    const chunk = new Int16Array(sampleBuffer.slice(0, 1600));
                    sampleBuffer = sampleBuffer.slice(1600);

                    // Convert Int16 array to base64
                    const binaryString = String.fromCharCode.apply(null, new Uint8Array(chunk.buffer));
                    const base64Str = btoa(binaryString);

                    const chunkMsg = {
                        realtimeInput: {
                            mediaChunks: [
                                {
                                    mimeType: "audio/pcm;rate=16000",
                                    data: base64Str
                                }
                            ]
                        }
                    };
                    ws.send(JSON.stringify(chunkMsg));
                }
            };

            source.connect(processorNode);
            processorNode.connect(audioCtx.destination);
            
            isRecordingAudio = true;
            micToggleBtn.innerText = "Disconnect Audio Input";
            micToggleBtn.className = "btn btn-sm btn-connect";
            document.getElementById('audio-source-status').innerText = "Web Audio Mic";
            logTerminal("Microphone streaming engaged (16 kHz Int16 PCM).", "client");
        } catch(e) {
            logTerminal(`Failed to initialize microphone capture: ${e.message}`, "error");
        }
    }

    function stopMicrophoneCapture() {
        if (micStream) {
            micStream.getTracks().forEach(t => t.stop());
            micStream = null;
        }
        if (processorNode) {
            processorNode.disconnect();
            processorNode = null;
        }
        isRecordingAudio = false;
        micToggleBtn.innerText = "Connect Audio Input";
        micToggleBtn.className = "btn btn-sm btn-secondary";
        document.getElementById('audio-source-status').innerText = "Simulated Sine";
    }

    // --- 5. Audio Playback (Paced Playback Queue) ---
    function playPCM24k(int16Array) {
        if (!audioCtx) return;
        
        // Convert Int16 back to Floats
        const floatArray = new Float32Array(int16Array.length);
        for(let i=0; i<int16Array.length; i++) {
            floatArray[i] = int16Array[i] / 32768.0;
        }

        const buffer = audioCtx.createBuffer(1, floatArray.length, 24000);
        buffer.getChannelData(0).set(floatArray);

        const sourceNode = audioCtx.createBufferSource();
        sourceNode.buffer = buffer;
        sourceNode.connect(audioCtx.destination);

        const now = audioCtx.currentTime;
        if (nextAudioPlayTime < now) {
            nextAudioPlayTime = now;
        }

        sourceNode.start(nextAudioPlayTime);
        nextAudioPlayTime += buffer.duration;
    }

    // --- 6. Camera Snapshots & Simulated Ingestion Pipeline (1 FPS) ---
    async function startCameraPipeline() {
        // Try getting webcam stream
        try {
            cameraStream = await navigator.mediaDevices.getUserMedia({ video: { width: 504, height: 896 } });
            const video = document.createElement('video');
            video.srcObject = cameraStream;
            video.play();
            
            videoTimerId = setInterval(() => {
                if (video.readyState === video.HAVE_ENOUGH_DATA) {
                    cameraCtx.drawImage(video, 0, 0, cameraCanvas.width, cameraCanvas.height);
                    frameCount++;
                    frameCounterEl.innerText = `FRAMES: ${frameCount}`;
                    
                    // Stream to Gemini if connected
                    streamCurrentFrame();
                }
            }, 1000);
            logTerminal("Webcam ingestion pipeline connected (1 FPS).", "client");
        } catch(e) {
            logTerminal("Webcam not available. Engaging scrolling telemetry camera generator.", "system");
            
            // Falling back to a scrolling simulation canvas frame
            let offset = 0;
            videoTimerId = setInterval(() => {
                // Draw scrolling grid
                cameraCtx.fillStyle = '#0a0d16';
                cameraCtx.fillRect(0, 0, cameraCanvas.width, cameraCanvas.height);

                cameraCtx.strokeStyle = 'rgba(139, 92, 246, 0.2)';
                cameraCtx.lineWidth = 1;
                offset = (offset + 10) % 40;

                for (let x = offset; x < cameraCanvas.width; x += 40) {
                    cameraCtx.beginPath();
                    cameraCtx.moveTo(x, 0);
                    cameraCtx.lineTo(x, cameraCanvas.height);
                    cameraCtx.stroke();
                }
                for (let y = offset; y < cameraCanvas.height; y += 40) {
                    cameraCtx.beginPath();
                    cameraCtx.moveTo(0, y);
                    cameraCtx.lineTo(cameraCanvas.width, y);
                    cameraCtx.stroke();
                }

                // Draw central crosshair & overlay text
                cameraCtx.strokeStyle = '#8b5cf6';
                cameraCtx.lineWidth = 2;
                cameraCtx.strokeRect(cameraCanvas.width * 0.2, cameraCanvas.height * 0.2, cameraCanvas.width * 0.6, cameraCanvas.height * 0.6);

                cameraCtx.fillStyle = '#f3f4f6';
                cameraCtx.font = '14px Outfit, sans-serif';
                cameraCtx.fillText("VISIONCLAW SIMULATOR FRAME", 40, 60);
                cameraCtx.fillText(`UTC: ${new Date().toISOString()}`, 40, 90);
                cameraCtx.fillText("PRIVACY FILTER: PASSING", 40, 120);

                frameCount++;
                frameCounterEl.innerText = `FRAMES: ${frameCount}`;

                streamCurrentFrame();
            }, 1000);
        }
    }

    function streamCurrentFrame() {
        if (!isWebsocketConnected) return;

        // Get JPEG base64 representation
        cameraCanvas.toBlob((blob) => {
            const reader = new FileReader();
            reader.readAsDataURL(blob);
            reader.onloadend = () => {
                const dataUrl = reader.result;
                const base64Str = dataUrl.split(',')[1];
                
                const frameMsg = {
                    realtimeInput: {
                        mediaChunks: [
                            {
                                mimeType: "image/jpeg",
                                data: base64Str
                            }
                        ]
                    }
                };
                ws.send(JSON.stringify(frameMsg));
            };
        }, 'image/jpeg', 0.8);
    }

    // --- 7. Gemini Tool Delegation to Local OpenClaw Gateway ---
    function handleGeminiToolCall(argsPayload, callId, gatewayHost) {
        logTerminal(`[Tool Dispatch] Intercepted callId: ${callId}. Routing: ${JSON.stringify(argsPayload)}`, "client");
        logClaw(`Proxying execution request to http://${gatewayHost}:18789...`, "invoke");

        const startTime = Date.now();

        fetch('/tools/invoke', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                tool: argsPayload.tool || "ping",
                arguments: argsPayload.arguments || {},
                gatewayHost: gatewayHost
            })
        })
        .then(async (res) => {
            const latency = Date.now() - startTime;
            rttEl.innerText = `${latency} ms`;

            if (res.ok) {
                const data = await res.json();
                metricInvocations++;
                invocationCountEl.innerText = metricInvocations;

                logClaw(`Tool returned execution response code: ${res.status}`, "success");
                logTerminal(`Tool callback SUCCESS: ${JSON.stringify(data)}`, "server");

                // Route response back to GeminiLive WebSocket
                const responseMsg = {
                    toolResponse: {
                        functionResponses: [
                            {
                                id: callId,
                                name: "execute",
                                response: { result: JSON.stringify(data) }
                            }
                        ]
                    }
                };
                ws.send(JSON.stringify(responseMsg));
            } else {
                const text = await res.text();
                throw new Error(text || `HTTP ${res.status}`);
            }
        })
        .catch(err => {
            metricFailures++;
            failureCountEl.innerText = metricFailures;
            logClaw(`Tool execution FAILED: ${err.message}`, "fail");
            logTerminal(`Tool callback FAILED: ${err.message}`, "error");

            // Dispatch error structure back to Gemini
            const errorMsg = {
                toolResponse: {
                    functionResponses: [
                        {
                            id: callId,
                            name: "execute",
                            response: { error: err.message }
                        }
                    ]
                }
            };
            ws.send(JSON.stringify(errorMsg));
        });
    }

    // --- 8. UI Handlers and Interactions ---
    localModeCheckbox.addEventListener('change', (e) => {
        isLocalMode = e.target.checked;
        if (isLocalMode) {
            logTerminal("Local PC Simulation mode active. Status lights redirected.", "system");
        } else {
            logTerminal("Wearable Link mode active. Waiting for S25 diagnostics heartbeat.", "system");
        }
        updateHealthDashboard();
    });

    // Auto-resume AudioContext on first document interaction to bypass autoplay restrictions
    document.addEventListener('click', async () => {
        if (audioCtx && audioCtx.state === 'suspended') {
            await audioCtx.resume();
            logTerminal("AudioContext resumed via user interaction.", "system");
        }
    });

    postOverallStatus.addEventListener('click', runPostCheck);

    connectWsBtn.addEventListener('click', async () => {
        try {
            await connectGeminiLive();
            sendIntroGreeting();
        } catch (err) {
            logTerminal(`Connection failed: ${err.message}`, "error");
            alert(`Connection failed: ${err.message}`);
        }
    });
    disconnectWsBtn.addEventListener('click', disconnectGeminiLive);

    micToggleBtn.addEventListener('click', () => {
        if (isRecordingAudio) {
            stopMicrophoneCapture();
        } else {
            startMicrophoneCapture();
        }
    });

    snapBtn.addEventListener('click', () => {
        // Force manual snapshot send to local OpenClaw gateway
        cameraCanvas.toBlob(blob => {
            const formData = new FormData();
            formData.append('file', blob, `snap_${Date.now()}.jpg`);
            
            logClaw("Manually capturing snapshot frame and sending to OpenClaw...", "invoke");
            
            fetch('/tools/invoke', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    tool: "capture_photo",
                    arguments: { width: 504, height: 896 },
                    gatewayHost: gatewayIpInput.value || 'localhost'
                })
            })
            .then(res => {
                if (res.ok) {
                    logClaw("Manual snapshot processed by OpenClaw Gateway.", "success");
                    refreshGallery();
                } else {
                    logClaw(`Failed to upload snapshot: HTTP ${res.status}`, "fail");
                }
            })
            .catch(e => {
                logClaw(`Upload network error: ${e.message}`, "fail");
            });
        }, 'image/jpeg');
    });

    // Amazon search integration
    amazonSearchBtn.addEventListener('click', () => {
        const query = amazonQuery.value.trim();
        if (!query) return;

        amazonResults.style.display = 'block';
        amazonResults.innerText = `Searching Amazon listings for "${query}"...\n`;

        fetch('/tools/invoke', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                tool: "google_search",
                arguments: { query: `site:amazon.com ${query}` },
                gatewayHost: gatewayIpInput.value || 'localhost'
            })
        })
        .then(async res => {
            if (res.ok) {
                const data = await res.json();
                amazonResults.innerText = JSON.stringify(data, null, 2);
            } else {
                const errText = await res.text();
                amazonResults.innerText = `Search Error: HTTP ${res.status}\n${errText}`;
            }
        })
        .catch(err => {
            amazonResults.innerText = `Network Error: ${err.message}`;
        });
    });

    // --- 9. Gallery Management ---
    function refreshGallery() {
        fetch('/api/images')
            .then(res => res.json())
            .then(files => {
                galleryGrid.innerHTML = '';
                if (files.length === 0) {
                    galleryGrid.innerHTML = '<p class="empty-gallery-msg">No images found in workspace.</p>';
                    return;
                }
                files.forEach(file => {
                    const card = document.createElement('div');
                    card.className = 'gallery-card';
                    card.innerHTML = `
                        <img src="/assets/${file}" class="gallery-thumbnail">
                        <div class="gallery-meta">${file}</div>
                    `;
                    galleryGrid.appendChild(card);
                });
            })
            .catch(() => {
                galleryGrid.innerHTML = '<p class="empty-gallery-msg">Failed to query workspace assets folder.</p>';
            });
    }

    refreshGalleryBtn.addEventListener('click', refreshGallery);

    // --- 10. Initialization ---
    diagnosticInterval = setInterval(updateHealthDashboard, 3000);
    setInterval(refreshGallery, 15000);
    updateHealthDashboard();
    refreshGallery();

    // Draw Decorative Waveform (Active when mic is not streaming, otherwise placeholder visualizer)
    let audioPhase = 0;
    function drawWaveform() {
        requestAnimationFrame(drawWaveform);
        waveformCtx.clearRect(0, 0, waveformCanvas.width, waveformCanvas.height);

        const gradient = waveformCtx.createLinearGradient(0, 0, waveformCanvas.width, 0);
        gradient.addColorStop(0, '#3b82f6');
        gradient.addColorStop(0.5, '#8b5cf6');
        gradient.addColorStop(1, '#ec4899');

        waveformCtx.strokeStyle = gradient;
        waveformCtx.lineWidth = 2;
        waveformCtx.beginPath();

        const amp = isRecordingAudio ? 35 : 15;
        const freq = isRecordingAudio ? 0.12 : 0.05;
        audioPhase += isRecordingAudio ? 0.25 : 0.08;

        for (let x = 0; x < waveformCanvas.width; x++) {
            const y = waveformCanvas.height / 2 + Math.sin(x * freq + audioPhase) * amp;
            if (x === 0) waveformCtx.moveTo(x, y);
            else waveformCtx.lineTo(x, y);
        }
        waveformCtx.stroke();
    }
    drawWaveform();

    // Handle startup overlay and direct gesture for AudioContext initialization
    const startPostBtn = document.getElementById('start-post-btn');
    const startupOverlay = document.getElementById('startup-overlay');

    startPostBtn.addEventListener('click', async () => {
        // Initialize Web Audio Context from direct click to bypass browser autoplay blocks
        try {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            await audioCtx.resume();
            logTerminal("AudioContext initialized & resumed successfully via direct user gesture.", "system");
        } catch (e) {
            logTerminal(`Failed to initialize AudioContext: ${e.message}`, "error");
        }

        // Hide overlay
        startupOverlay.classList.add('hidden');

        // Fetch configurations and run Power-On Self-Test (POST)
        fetch('/api/config')
            .then(res => res.json())
            .then(config => {
                if (config.geminiApiKey) apiKeyInput.value = config.geminiApiKey;
                if (config.gatewayToken) {
                    console.log("[Config Init] Token successfully loaded from local .env config.");
                }
                
                // Run diagnostic check sequence
                runPostCheck();
            });
    });

    console.log("VisionClaw Web Dashboard & Simulation Client initialized.");
});
