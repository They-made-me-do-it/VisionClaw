// index.js
// VisionClaw Dashboard Controller - UI Logic, Local POST self-test, and browser Gemini Live client

document.addEventListener('DOMContentLoaded', () => {
    // Remote Console Logger Proxy
    function sendRemoteLog(type, message) {
        fetch('/api/log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type, message })
        }).catch(() => {});
    }
    const orgLog = console.log;
    const orgErr = console.error;
    console.log = function(...args) {
        orgLog.apply(console, args);
        sendRemoteLog('info', args.join(' '));
    };
    console.error = function(...args) {
        orgErr.apply(console, args);
        sendRemoteLog('error', args.join(' '));
    };
    window.onerror = function(message, source, lineno, colno, error) {
        sendRemoteLog('uncaught_error', `${message} at ${source}:${lineno}:${colno}`);
        return false;
    };

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
    const postActionsContainer = document.getElementById('post-actions-container');
    const postAnswerBtn = document.getElementById('post-answer-btn');

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
    let activeVideoElement = null;
    let offscreenCanvas = null;
    let offscreenCtx = null;
    let frameCount = 0;
    let audioInputReady = false;
    let isRecordingAudio = false;
    let videoTimerId = null;
    let diagnosticInterval = null;
    let isPostChecking = false;
    let voiceHandshakeStep = 0; // 0=idle, 1=connected (waiting for Gemini Turn 1 ask), 2=Gemini asked (waiting for user answer), 3=User answered (waiting for Gemini confirm), 4=Passed
    let activeAudioNodes = [];
    let currentGeminiResponseText = "";

    // Metrics Counter
    let metricInvocations = 0;
    let metricFailures = 0;

    function logTerminal(message, type = 'system') {
        if (type === 'error' || type === 'uncaught_error') {
            console.error(`[Terminal Error] ${message}`);
        } else {
            console.log(`[Terminal] ${message}`);
        }
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

    function saveTranscript(sender, type, content) {
        fetch('/api/transcript', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                timestamp: new Date().toISOString(),
                sender,
                type,
                content
            })
        }).catch(() => {});
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
    async function initiateVoiceHandshake() {
        voiceHandshakeStep = 1;
        isPostChecking = true;
        setBadgeStatus(postGemini, 'checking', 'state-checking');
        setLightStatus(lightGemini, 'active');
        postFeedback.innerText = "Gemini Live connected. Starting voice handshake...";
        setBadgeStatus(postOverallStatus, 'voice check', 'state-checking');
        localModeCheckbox.disabled = false;
        
        await startMicrophoneCapture();
        
        const turn1Prompt = "VisionClaw POST check initiated. Gemini, please perform step 1 of the voice check-in: ask the user 'Hello, this is Gemini. Can you hear me?' and STOP speaking immediately. Do NOT say anything else. You must wait for their response.";
        sendIntroGreeting(turn1Prompt);
    }

    function sendUserResponseText() {
        postActionsContainer.style.display = 'none';
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        
        const responsePrompt = "Yes, I can hear you clearly. Please confirm our link is verified and operational.";
        logTerminal(`> Send User Response: "${responsePrompt}"`, "client");
        
        const userTurn = {
            clientContent: {
                turns: [
                    {
                        role: "user",
                        parts: [{ text: responsePrompt }]
                    }
                ],
                turnComplete: true
            }
        };
        ws.send(JSON.stringify(userTurn));
        saveTranscript("user", "text", responsePrompt);
        voiceHandshakeStep = 3;
        postFeedback.innerText = "Sent response. Waiting for Gemini confirmation...";
    }

    function passVoiceHandshake() {
        postActionsContainer.style.display = 'none';
        voiceHandshakeStep = 4;
        isPostChecking = false;
        
        setBadgeStatus(postGemini, 'pass', 'state-pass');
        setLightStatus(lightGemini, 'active');
        postFeedback.innerText = "POST Passed: Bidirectional voice handshake successfully verified!";
        setBadgeStatus(postOverallStatus, 'post: passed', 'state-pass');
        localModeCheckbox.disabled = false;
        
        fetch('/api/post_check/voice', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'PASS' })
        }).catch(err => console.error("Failed to update server voice status:", err));

        // In Wearable Link mode, disconnect the browser connection so it doesn't run concurrently with S25 phone Gemini session.
        if (!isLocalMode) {
            disconnectGeminiLive();
        }
    }

    async function runPostCheck() {
        postFeedback.style.display = 'block';
        postFeedback.innerText = "Initializing Power-On Self-Test (POST)...";
        isPostChecking = true;
        voiceHandshakeStep = 0;
        postActionsContainer.style.display = 'none';

        // Reset voice check state on server
        await fetch('/api/post_check/voice', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'PENDING' })
        }).catch(() => {});

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
            await initiateVoiceHandshake();
        } else {
            postFeedback.innerText = "POST Local Checks Passed. Connecting to Gemini Live for voice validation...";
            try {
                await connectGeminiLive();
                await initiateVoiceHandshake();
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

            // Connect via our local WebSocket proxy on port 18791 to bypass browser Origin-based key checks (Code 1008)
            const wsUrl = `ws://localhost:18791?key=${encodeURIComponent(apiKey)}`;

            // Close existing active WebSocket and unregister handlers to prevent duplicate sessions
            if (ws) {
                logTerminal("Closing existing active WebSocket before opening a new connection...", "system");
                try {
                    ws.onopen = null;
                    ws.onmessage = null;
                    ws.onerror = null;
                    ws.onclose = null;
                    ws.close();
                } catch(e) {}
                ws = null;
            }

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
                        model: "models/gemini-2.5-flash-native-audio-preview-09-2025",
                        generationConfig: {
                            responseModalities: ["AUDIO"]
                        },
                        systemInstruction: {
                            parts: [
                                {
                                    text: "You are a concise, helpful real-time voice assistant for the VisionClaw wearable device. Speak naturally, keep responses extremely brief and conversational, and do not use markdown formatting or list thoughts. Directly answer the user without conversational filler or prefaces."
                                }
                            ]
                        },
                        inputAudioTranscription: {},
                        outputAudioTranscription: {}
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
                console.log(`[WebSocket onmessage] data type: ${typeof event.data}, isBlob: ${event.data instanceof Blob}`);
                if (typeof event.data === 'string') {
                    console.log(`[WebSocket message content]: ${event.data}`);
                }
                let text = "";
                if (event.data instanceof Blob) {
                    const arrayBuffer = await event.data.arrayBuffer();
                    try {
                        const decoder = new TextDecoder("utf-8");
                        const decodedText = decoder.decode(arrayBuffer);
                        if (decodedText.trim().startsWith('{')) {
                            const parsed = JSON.parse(decodedText);
                            console.log(`[WebSocket Blob decoded as JSON]: ${decodedText}`);
                            text = decodedText;
                        } else {
                            throw new Error("Not JSON");
                        }
                    } catch (e) {
                        const pcm16 = new Int16Array(arrayBuffer);
                        playPCM24k(pcm16);
                        return;
                    }
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
                        
                        if (serverContent.interrupted) {
                            interruptAudioPlayback();
                            logTerminal("< Interrupted event received from Gemini.", "system");
                            if (currentGeminiResponseText) {
                                saveTranscript("gemini", "text", currentGeminiResponseText + " [INTERRUPTED]");
                                currentGeminiResponseText = "";
                            }
                        }
                        
                        // Capture User Speech Transcription
                        if (serverContent.userTurn && serverContent.userTurn.parts) {
                            serverContent.userTurn.parts.forEach(part => {
                                if (part.text) {
                                    logTerminal(`User (Audio Transcript): ${part.text}`, "client");
                                    saveTranscript("user", "audio_transcription", part.text);
                                }
                            });
                        }
                        
                        // Handle transcribed text if available
                        if (serverContent.outputTranscription && serverContent.outputTranscription.text) {
                            const transText = serverContent.outputTranscription.text;
                            logTerminal(`Gemini (Transcript): ${transText}`, "server");
                            
                            if (isPostChecking) {
                                if (voiceHandshakeStep === 1) {
                                    postFeedback.innerText = `Gemini: "${transText}"`;
                                } else if (voiceHandshakeStep === 2 || voiceHandshakeStep === 3) {
                                    postFeedback.innerText = `Gemini: "${transText}"`;
                                    const textLower = transText.toLowerCase();
                                    if (textLower.includes("verified") || textLower.includes("operational") || textLower.includes("working") || textLower.includes("hear you") || textLower.includes("online") || textLower.includes("successful")) {
                                        passVoiceHandshake();
                                    }
                                }
                            }
                        }

                        const modelTurn = serverContent.modelTurn;
                        const parts = modelTurn ? modelTurn.parts : serverContent.parts;
                        
                        if (parts) {
                            parts.forEach(part => {
                                if (part.text) {
                                    logTerminal(`Gemini: ${part.text}`, "server");
                                    currentGeminiResponseText += part.text;
                                    
                                    // Monitor for conversational check-in verification
                                    if (isPostChecking) {
                                        if (voiceHandshakeStep === 1) {
                                            postFeedback.innerText = `Gemini: "${part.text}"`;
                                        } else if (voiceHandshakeStep === 2 || voiceHandshakeStep === 3) {
                                            postFeedback.innerText = `Gemini: "${part.text}"`;
                                            const textLower = part.text.toLowerCase();
                                            if (textLower.includes("verified") || textLower.includes("operational") || textLower.includes("working") || textLower.includes("hear you") || textLower.includes("online") || textLower.includes("successful")) {
                                                passVoiceHandshake();
                                            }
                                        }
                                    }
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

                        // Monitor turn complete to transition states
                        if (serverContent.turnComplete) {
                            logTerminal("< turnComplete received from Gemini.", "server");
                            if (currentGeminiResponseText) {
                                saveTranscript("gemini", "text", currentGeminiResponseText);
                                currentGeminiResponseText = "";
                            }
                            if (isPostChecking && voiceHandshakeStep === 1) {
                                voiceHandshakeStep = 2;
                                postFeedback.innerText = "Gemini: 'Can you hear me?' (Speak into mic or click Answer)";
                                postActionsContainer.style.display = 'block';
                            }
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
        saveTranscript("user", "text", prompt);
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
        if (activeVideoElement) {
            try {
                activeVideoElement.pause();
                activeVideoElement.srcObject = null;
                document.body.removeChild(activeVideoElement);
            } catch(e) {}
            activeVideoElement = null;
        }
        offscreenCanvas = null;
        offscreenCtx = null;
        if (videoTimerId) {
            clearInterval(videoTimerId);
            videoTimerId = null;
        }
        stopMicrophoneCapture();
        interruptAudioPlayback(); // Stop any currently playing/queued audio streams from the closed connection
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

        // Clean up any existing microphone capture to prevent multiple concurrent tracks
        if (micStream || processorNode) {
            try {
                stopMicrophoneCapture();
            } catch(e) {}
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

                // Silence output buffer to prevent microphone feedback loopback
                const outputBuffer = e.outputBuffer.getChannelData(0);
                outputBuffer.fill(0);

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
        if (nextAudioPlayTime < now || nextAudioPlayTime - now > 0.5) {
            nextAudioPlayTime = now + 0.05;
        }

        sourceNode.start(nextAudioPlayTime);
        nextAudioPlayTime += buffer.duration;

        // Keep track of active audio nodes to enable interruption
        activeAudioNodes.push(sourceNode);
        sourceNode.onended = () => {
            const idx = activeAudioNodes.indexOf(sourceNode);
            if (idx > -1) {
                activeAudioNodes.splice(idx, 1);
            }
        };
    }

    function interruptAudioPlayback() {
        console.log("[Audio] Interruption triggered. Stopping all active audio nodes.");
        activeAudioNodes.forEach(node => {
            try {
                node.stop();
            } catch(e) {}
        });
        activeAudioNodes = [];
        nextAudioPlayTime = 0;
    }

    // --- 6. Camera Snapshots & Simulated Ingestion Pipeline (1 FPS) ---
    async function startCameraPipeline() {
        // Clean up any existing camera stream/pipeline to prevent duplicate frames/intervals
        if (cameraStream) {
            try {
                cameraStream.getTracks().forEach(t => t.stop());
            } catch(e) {}
            cameraStream = null;
        }
        if (activeVideoElement) {
            try {
                activeVideoElement.pause();
                activeVideoElement.srcObject = null;
                document.body.removeChild(activeVideoElement);
            } catch(e) {}
            activeVideoElement = null;
        }
        if (videoTimerId) {
            clearInterval(videoTimerId);
            videoTimerId = null;
        }

        // Try getting webcam stream with compatible landscape dimensions
        try {
            cameraStream = await navigator.mediaDevices.getUserMedia({ 
                video: { width: { ideal: 640 }, height: { ideal: 480 } } 
            });
            
            // Create in-memory video element and configure it to prevent frame render suspension
            const video = document.createElement('video');
            video.muted = true;
            video.playsInline = true;
            video.style.display = 'none';
            document.body.appendChild(video);
            
            activeVideoElement = video;
            video.srcObject = cameraStream;
            video.play();
            
            // Initialize offscreen canvas for network streaming
            offscreenCanvas = document.createElement('canvas');
            offscreenCanvas.width = 252;
            offscreenCanvas.height = 448;
            offscreenCtx = offscreenCanvas.getContext('2d');
            
            // 1. Smooth display drawing loop at 30+ FPS (resolves visual lag)
            const drawLoop = () => {
                if (!cameraStream) return;
                if (video.readyState === video.HAVE_ENOUGH_DATA) {
                    const canvasWidth = cameraCanvas.width;
                    const canvasHeight = cameraCanvas.height;
                    const videoWidth = video.videoWidth;
                    const videoHeight = video.videoHeight;
                    
                    const videoAspect = videoWidth / videoHeight;
                    const canvasAspect = canvasWidth / canvasHeight;
                    
                    let sx, sy, sWidth, sHeight;
                    if (videoAspect > canvasAspect) {
                        // Landscape source -> crop width to fit portrait canvas
                        sHeight = videoHeight;
                        sWidth = videoHeight * canvasAspect;
                        sx = (videoWidth - sWidth) / 2;
                        sy = 0;
                    } else {
                        // Portrait source -> crop height
                        sWidth = videoWidth;
                        sHeight = videoWidth / canvasAspect;
                        sx = 0;
                        sy = (videoHeight - sHeight) / 2;
                    }
                    cameraCtx.drawImage(video, sx, sy, sWidth, sHeight, 0, 0, canvasWidth, canvasHeight);
                }
                requestAnimationFrame(drawLoop);
            };
            requestAnimationFrame(drawLoop);
            
            // 2. Network streaming loop throttled to 1 FPS to prevent bandwidth buffer lag
            videoTimerId = setInterval(() => {
                if (video.readyState === video.HAVE_ENOUGH_DATA) {
                    frameCount++;
                    frameCounterEl.innerText = `FRAMES: ${frameCount}`;
                    
                    // Stream to Gemini if connected
                    streamCurrentFrame();
                }
            }, 1000);
            logTerminal("Webcam ingestion pipeline connected (Smooth 30 FPS display, 1 FPS network stream).", "client");
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

        // Check backpressure on socket buffer to prevent network queue lag
        if (ws && ws.bufferedAmount > 0) {
            console.log("[Webcam] Skipping frame send due to websocket backpressure.");
            return;
        }

        // Draw current frame from activeVideoElement to offscreenCanvas if available to scale down
        if (offscreenCanvas && offscreenCtx && activeVideoElement && activeVideoElement.readyState === activeVideoElement.HAVE_ENOUGH_DATA) {
            const videoWidth = activeVideoElement.videoWidth;
            const videoHeight = activeVideoElement.videoHeight;
            const videoAspect = videoWidth / videoHeight;
            const canvasAspect = offscreenCanvas.width / offscreenCanvas.height;
            
            let sx, sy, sWidth, sHeight;
            if (videoAspect > canvasAspect) {
                sHeight = videoHeight;
                sWidth = videoHeight * canvasAspect;
                sx = (videoWidth - sWidth) / 2;
                sy = 0;
            } else {
                sWidth = videoWidth;
                sHeight = videoWidth / canvasAspect;
                sx = 0;
                sy = (videoHeight - sHeight) / 2;
            }
            
            offscreenCtx.drawImage(activeVideoElement, sx, sy, sWidth, sHeight, 0, 0, offscreenCanvas.width, offscreenCanvas.height);
            
            offscreenCanvas.toBlob((blob) => {
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
                    saveTranscript("user", "image", base64Str);
                };
            }, 'image/jpeg', 0.4);
        } else {
            // Fallback for simulation canvas or if video is not ready
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
                    saveTranscript("user", "image", base64Str);
                };
            }, 'image/jpeg', 0.4);
        }
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
            disconnectGeminiLive();
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
    postAnswerBtn.addEventListener('click', sendUserResponseText);

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
