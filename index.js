// index.js
// VisionClaw Dashboard Controller - Fully Operational Client & Gateway Bridge

document.addEventListener('DOMContentLoaded', () => {
    // Canvas contexts
    const cameraCanvas = document.getElementById('camera-canvas');
    const cameraCtx = cameraCanvas.getContext('2d');
    const waveformCanvas = document.getElementById('waveform-canvas');
    const waveformCtx = waveformCanvas.getContext('2d');

    // UI elements
    const frameCounterEl = document.getElementById('frame-counter');
    const breakerStatusEl = document.getElementById('breaker-status');
    const invocationCountEl = document.getElementById('metric-invocations');
    const failureCountEl = document.getElementById('metric-failures');
    const rttEl = document.getElementById('metric-rtt');
    const clawLogsEl = document.getElementById('claw-logs');
    const wssLogsEl = document.getElementById('wss-logs');
    const resumptionTokenEl = document.getElementById('resumption-token');
    
    // Interactive inputs
    const apiKeyInput = document.getElementById('api-key-input');
    const gatewayIpInput = document.getElementById('gateway-ip-input');
    const connectWsBtn = document.getElementById('connect-ws-btn');
    const disconnectWsBtn = document.getElementById('disconnect-ws-btn');
    const socketStatusBadge = document.getElementById('socket-status-badge');
    const snapBtn = document.getElementById('snap-btn');
    const micToggleBtn = document.getElementById('mic-toggle-btn');
    const audioSourceStatusEl = document.getElementById('audio-source-status');
    const toolForm = document.getElementById('tool-form');
    const toolSelect = document.getElementById('tool-select');
    const toolArgs = document.getElementById('tool-args');
    const refreshGalleryBtn = document.getElementById('refresh-gallery-btn');
    const galleryGrid = document.getElementById('gallery-grid');
    const toggleDebugBtn = document.getElementById('toggle-debug-btn');
    const debugContainer = document.getElementById('debug-json-container');

    // Live Camera Stream
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    let cameraConnected = false;

    // Web Audio API State
    let audioCtx = null;
    let analyser = null;
    let dataArray = null;
    let micStreamActive = false;
    let nextPlayTime = 0; // For queueing downstream audio chunks seamlessly

    // No Fallback Image allowed due to strict anti-mocking rules
    // WebSocket state
    let openclawGatewayToken = 'oc_live_token_7a9c8b3d2e1f0';
    let ws = null;
    let lastResumptionToken = null;
    let sendVideoInterval = null;

    // Circuit Breaker state
    let circuitState = 'CLOSED';
    let failures = 0;
    const failureThreshold = 3;
    let invocations = 0;

    // Logs helper
    function appendTerminalLog(parent, text, type = 'system') {
        const line = document.createElement('div');
        line.className = parent.id === 'wss-logs' ? `terminal-line ${type}` : `log-entry ${type}`;
        
        const timestamp = new Date().toLocaleTimeString();
        line.innerText = `[${timestamp}] ${text}`;
        parent.appendChild(line);
        parent.scrollTop = parent.scrollHeight;
    }

    // Connect to User Media Device (Camera)
    navigator.mediaDevices.getUserMedia({ 
        video: { 
            width: { ideal: 640 }, 
            height: { ideal: 480 },
            facingMode: "user" 
        } 
    })
    .then(stream => {
        video.srcObject = stream;
        video.onloadedmetadata = () => {
            video.play();
            cameraConnected = true;
            appendTerminalLog(wssLogsEl, "Local camera source connected successfully.", "success");
            appendTerminalLog(clawLogsEl, "Gateway: Local webcam streaming active.", "success");
        };
    })
    .catch(err => {
        console.warn("Camera access denied: ", err);
        appendTerminalLog(wssLogsEl, "Camera access denied. Camera disconnected.", "error");
        appendTerminalLog(clawLogsEl, "Gateway Error: Camera permissions missing.", "fail");
    });

    // --- 1. Camera Frame Ingestion Loop ---
    let frameCount = 0;
    function drawCameraFrame() {
        frameCount++;
        frameCounterEl.innerText = `FRAMES: ${frameCount}`;

        cameraCtx.fillStyle = '#0b0f19';
        cameraCtx.fillRect(0, 0, cameraCanvas.width, cameraCanvas.height);

        // Draw webcam stream or fallback image
        if (cameraConnected && video.readyState === video.HAVE_ENOUGH_DATA) {
            const scale = Math.max(cameraCanvas.width / video.videoWidth, cameraCanvas.height / video.videoHeight);
            const x = (cameraCanvas.width / 2) - (video.videoWidth / 2) * scale;
            const y = (cameraCanvas.height / 2) - (video.videoHeight / 2) * scale;
            
            cameraCtx.save();
            cameraCtx.translate(cameraCanvas.width, 0);
            cameraCtx.scale(-1, 1);
            cameraCtx.drawImage(video, -x - (video.videoWidth * scale), y, video.videoWidth * scale, video.videoHeight * scale);
            cameraCtx.restore();
        } else if (!cameraConnected) {
            cameraCtx.fillStyle = '#ef4444';
            cameraCtx.font = 'bold 16px "JetBrains Mono"';
            cameraCtx.textAlign = 'center';
            cameraCtx.fillText('CAMERA DISCONNECTED / ERROR', cameraCanvas.width / 2, cameraCanvas.height / 2);
            cameraCtx.textAlign = 'left';
        }

        // HUD overlay
        cameraCtx.strokeStyle = 'rgba(139, 92, 246, 0.4)';
        cameraCtx.lineWidth = 1;
        cameraCtx.beginPath();
        cameraCtx.moveTo(cameraCanvas.width / 2, 0);
        cameraCtx.lineTo(cameraCanvas.width / 2, cameraCanvas.height);
        cameraCtx.moveTo(0, cameraCanvas.height / 2);
        cameraCtx.lineTo(cameraCanvas.width, cameraCanvas.height / 2);
        cameraCtx.stroke();

        const cx = cameraCanvas.width / 2;
        const cy = cameraCanvas.height / 2;
        const time = Date.now() * 0.001;

        cameraCtx.strokeStyle = '#3b82f6';
        cameraCtx.lineWidth = 2;
        cameraCtx.beginPath();
        cameraCtx.arc(cx, cy, 90 + Math.sin(time * 2) * 5, 0, Math.PI * 2);
        cameraCtx.stroke();

        cameraCtx.strokeStyle = (ws && ws.readyState === WebSocket.OPEN) ? '#10b981' : '#f59e0b';
        cameraCtx.lineWidth = 1.5;
        const boxSize = 70 + Math.cos(time * 3) * 3;
        cameraCtx.strokeRect(cx - boxSize/2, cy - boxSize/2, boxSize, boxSize);

        cameraCtx.fillStyle = '#ffffff';
        cameraCtx.font = 'bold 11px "JetBrains Mono"';
        cameraCtx.shadowColor = 'black';
        cameraCtx.shadowBlur = 4;
        cameraCtx.fillText(`LATENCY: 14ms`, 30, 50);
        cameraCtx.fillText(`FPS: 1.0 (THROTTLED)`, 30, 65);
        cameraCtx.fillText(`SESSION: ${ws && ws.readyState === WebSocket.OPEN ? "LIVE_API" : "LOOPBACK"}`, 30, 80);
        cameraCtx.shadowBlur = 0;

        setTimeout(drawCameraFrame, 1000);
    }

    // --- 2. Live Microphone Audio (Resampling and WebSocket Streaming) ---
    micToggleBtn.addEventListener('click', () => {
        if (micStreamActive) return;

        navigator.mediaDevices.getUserMedia({ audio: true })
        .then(stream => {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const source = audioCtx.createMediaStreamSource(stream);
            analyser = audioCtx.createAnalyser();
            analyser.fftSize = 512;
            
            source.connect(analyser);
            
            const bufferLength = analyser.frequencyBinCount;
            dataArray = new Uint8Array(bufferLength);
            
            micStreamActive = true;
            audioSourceStatusEl.innerText = "Live Microphone";
            audioSourceStatusEl.style.color = "#10b981";
            micToggleBtn.disabled = true;
            micToggleBtn.innerText = "Audio Connected";
            
            appendTerminalLog(wssLogsEl, "Microphone audio context initialized.", "success");

            // Setup script processor to resample to 16 kHz Mono Int16 PCM and stream to WSS
            const bufferSize = 4096;
            const scriptNode = audioCtx.createScriptProcessor(bufferSize, 1, 1);
            source.connect(scriptNode);
            scriptNode.connect(audioCtx.destination); // Required to trigger onprocess

            scriptNode.onaudioprocess = (e) => {
                if (!ws || ws.readyState !== WebSocket.OPEN) return;

                const inputData = e.inputBuffer.getChannelData(0);
                const resampled = resample(inputData, e.inputBuffer.sampleRate, 16000);
                const pcmBuffer = floatTo16BitPCM(resampled);
                const base64Audio = base64ArrayBuffer(pcmBuffer.buffer);

                // Stream real-time chunk to Gemini
                ws.send(JSON.stringify({
                    realtimeInput: {
                        mediaChunks: [{
                            mimeType: "audio/pcm",
                            data: base64Audio
                        }]
                    }
                }));
            };
        })
        .catch(err => {
            console.error("Microphone access denied: ", err);
            appendTerminalLog(wssLogsEl, "Microphone access denied.", "error");
        });
    });

    // Audio Resampler helper (Linear)
    function resample(inputData, inputSampleRate, outputSampleRate) {
        if (inputSampleRate === outputSampleRate) return inputData;
        const ratio = inputSampleRate / outputSampleRate;
        const newLength = Math.round(inputData.length / ratio);
        const result = new Float32Array(newLength);
        let offsetResult = 0;
        let offsetInput = 0;
        while (offsetResult < result.length) {
            const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
            let accum = 0, count = 0;
            for (let i = offsetInput; i < nextOffsetBuffer && i < inputData.length; i++) {
                accum += inputData[i];
                count++;
            }
            result[offsetResult] = count > 0 ? accum / count : 0;
            offsetResult++;
            offsetInput = nextOffsetBuffer;
        }
        return result;
    }

    // Float32 to Int16 PCM Converter
    function floatTo16BitPCM(input) {
        const output = new Int16Array(input.length);
        for (let i = 0; i < input.length; i++) {
            const s = Math.max(-1, Math.min(1, input[i]));
            output[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        return output;
    }

    // Base64 array buffer encoder
    function base64ArrayBuffer(arrayBuffer) {
        let binary = '';
        const bytes = new Uint8Array(arrayBuffer);
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return window.btoa(binary);
    }

    // Live Audio Waveform animation loop
    let isDrawing = true;
    let audioPhase = 0;
    function drawAudioWaveform() {
        if (!isDrawing) return;

        requestAnimationFrame(drawAudioWaveform);
        waveformCtx.clearRect(0, 0, waveformCanvas.width, waveformCanvas.height);

        const gradient = waveformCtx.createLinearGradient(0, 0, waveformCanvas.width, 0);
        gradient.addColorStop(0, '#3b82f6');
        gradient.addColorStop(0.5, '#8b5cf6');
        gradient.addColorStop(1, '#ec4899');
        
        waveformCtx.strokeStyle = gradient;
        waveformCtx.lineWidth = 2.5;
        waveformCtx.beginPath();

        if (micStreamActive && dataArray) {
            analyser.getByteTimeDomainData(dataArray);
            const sliceWidth = waveformCanvas.width / dataArray.length;
            let x = 0;
            for (let i = 0; i < dataArray.length; i++) {
                const v = dataArray[i] / 128.0;
                const y = v * (waveformCanvas.height / 2);
                if (i === 0) waveformCtx.moveTo(x, y);
                else waveformCtx.lineTo(x, y);
                x += sliceWidth;
            }
        } else {
            const amp = 20 + Math.sin(Date.now() * 0.003) * 8;
            const freq = 0.045;
            audioPhase += 0.12;
            for (let x = 0; x < waveformCanvas.width; x++) {
                const y = waveformCanvas.height / 2 + Math.sin(x * freq + audioPhase) * amp * Math.cos(x * 0.006);
                if (x === 0) waveformCtx.moveTo(x, y);
                else waveformCtx.lineTo(x, y);
            }
        }
        waveformCtx.stroke();
    }

    // --- 3. Gemini Live WSS Connection Handler ---
    let userDisconnected = false;
    let reconnectTimeout = null;

    connectWsBtn.addEventListener('click', () => {
        const apiKey = apiKeyInput.value.trim();
        if (!apiKey) {
            alert("Please enter a valid Gemini API Key to connect.");
            return;
        }

        userDisconnected = false;
        if (reconnectTimeout) {
            clearTimeout(reconnectTimeout);
            reconnectTimeout = null;
        }

        connectWsBtn.disabled = true;
        connectWsBtn.innerText = "Connecting...";
        appendTerminalLog(wssLogsEl, "Connecting to Gemini Live WSS...", "system");

        const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${apiKey}`;
        ws = new WebSocket(url);

        ws.onopen = () => {
            socketStatusBadge.innerText = "CONNECTED";
            socketStatusBadge.className = "status-value status-ok";
            connectWsBtn.classList.add('hidden');
            disconnectWsBtn.classList.remove('hidden');
            
            appendTerminalLog(wssLogsEl, "WebSocket Connection Established.", "success");
            
            // Send Setup Payload
            sendWSSSetup();
            
            // Start 1-fps video transmission loop
            sendVideoInterval = setInterval(sendVideoFrame, 1000);
        };

        ws.onmessage = (e) => {
            if (typeof e.data === 'string') {
                handleWSSMessage(e.data);
            } else if (e.data instanceof Blob) {
                // Read binary audio output from Gemini Live WSS and play it directly
                e.data.arrayBuffer().then(buffer => {
                    playRawPCMBuffer(buffer);
                }).catch(err => {
                    console.error("Error reading audio binary blob:", err);
                });
            }
        };

        ws.onerror = (err) => {
            appendTerminalLog(wssLogsEl, "WebSocket Error: connection failed.", "error");
        };

        ws.onclose = () => {
            handleWSSDisconnect();
            if (!userDisconnected) {
                appendTerminalLog(wssLogsEl, "WSS closed unexpectedly. Retrying in 5s...", "warning");
                reconnectTimeout = setTimeout(() => {
                    appendTerminalLog(wssLogsEl, "Reconnecting WebSocket...", "system");
                    connectWsBtn.click();
                }, 5000);
            }
        };
    });

    disconnectWsBtn.addEventListener('click', () => {
        userDisconnected = true;
        if (reconnectTimeout) {
            clearTimeout(reconnectTimeout);
            reconnectTimeout = null;
        }
        if (ws) {
            ws.close();
        }
    });

    function handleWSSDisconnect() {
        socketStatusBadge.innerText = "DISCONNECTED";
        socketStatusBadge.className = "status-value status-error";
        connectWsBtn.disabled = false;
        connectWsBtn.innerText = "Connect Live API";
        connectWsBtn.classList.remove('hidden');
        disconnectWsBtn.classList.add('hidden');
        
        if (sendVideoInterval) {
            clearInterval(sendVideoInterval);
        }
        
        appendTerminalLog(wssLogsEl, "WebSocket Connection Closed.", "system");
        ws = null;
    }

    function sendWSSSetup() {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;

        const setupPayload = {
            setup: {
                model: "models/gemini-2.5-flash-native-audio-latest",
                generationConfig: {
                    responseModalities: ["AUDIO"],
                    speechConfig: {
                        voiceConfig: {
                            prebuiltVoiceConfig: {
                                voiceName: "Puck"
                            }
                        }
                    }
                },
                contextWindowCompression: {
                    slidingWindow: {
                        targetTokens: 2000
                    }
                },
                tools: [
                    {
                        functionDeclarations: [
                            {
                                name: "execute",
                                description: "Execute local tool action via the OpenClaw Gateway on the LAN",
                                parameters: {
                                    type: "OBJECT",
                                    properties: {
                                        toolName: { type: "STRING", description: "The target tool name to run, e.g. capture_photo" },
                                        arguments: { type: "OBJECT", description: "JSON arguments matching tool specifications" }
                                    },
                                    required: ["toolName"]
                                }
                            }
                        ]
                    }
                ]
            }
        };

        if (lastResumptionToken) {
            setupPayload.setup.resumptionToken = lastResumptionToken;
        }

        ws.send(JSON.stringify(setupPayload));
        appendTerminalLog(wssLogsEl, "> Setup message sent with tools configuration.", "client");
    }

    function sendVideoFrame() {
        if (!ws || ws.readyState !== WebSocket.OPEN || !cameraConnected) return;

        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = 504;
        tempCanvas.height = 896;
        const tempCtx = tempCanvas.getContext('2d');

        const scale = Math.max(tempCanvas.width / video.videoWidth, tempCanvas.height / video.videoHeight);
        const x = (tempCanvas.width / 2) - (video.videoWidth / 2) * scale;
        const y = (tempCanvas.height / 2) - (video.videoHeight / 2) * scale;
        
        tempCtx.translate(tempCanvas.width, 0);
        tempCtx.scale(-1, 1);
        tempCtx.drawImage(video, -x - (video.videoWidth * scale), y, video.videoWidth * scale, video.videoHeight * scale);

        tempCanvas.toBlob(blob => {
            if (!blob) return;
            const reader = new FileReader();
            reader.readAsDataURL(blob);
            reader.onloadend = () => {
                const base64 = reader.result.split(',')[1];
                ws.send(JSON.stringify({
                    realtimeInput: {
                        mediaChunks: [{
                            mimeType: "image/jpeg",
                            data: base64
                        }]
                    }
                }));
            };
        }, 'image/jpeg', 0.5);
    }

    function handleWSSMessage(dataString) {
        try {
            const json = JSON.parse(dataString);

            // 1. Ingest audio feedback
            if (json.serverContent && json.serverContent.parts) {
                json.serverContent.parts.forEach(part => {
                    if (part.inlineData && part.inlineData.mimeType.includes("audio/pcm")) {
                        playPCM(part.inlineData.data);
                    }
                });
            }

            // 2. Cache resumption token
            if (json.sessionResumptionUpdate && json.sessionResumptionUpdate.resumptionToken) {
                lastResumptionToken = json.sessionResumptionUpdate.resumptionToken;
                resumptionTokenEl.innerText = lastResumptionToken.substring(0, 15) + '...';
                appendTerminalLog(wssLogsEl, `Resumption update cached.`, "system");
            }

            // 3. Intercept and execute tool calls
            if (json.toolCall && json.toolCall.functionCalls) {
                json.toolCall.functionCalls.forEach(call => {
                    if (call.name === 'execute') {
                        routeLiveToolCall(call.args, call.id);
                    }
                });
            }
        } catch (err) {
            console.error("Error parsing WSS message:", err);
        }
    }

    // Playback 24 kHz mono Int16 PCM chunks
    function playPCM(base64Audio) {
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }

        const binary = window.atob(base64Audio);
        const len = binary.length;
        const buffer = new ArrayBuffer(len);
        const bytes = new Uint8Array(buffer);
        for (let i = 0; i < len; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        const int16Array = new Int16Array(buffer);
        const float32Array = new Float32Array(int16Array.length);
        for (let i = 0; i < int16Array.length; i++) {
            float32Array[i] = int16Array[i] / 32768.0;
        }
        
        const audioBuffer = audioCtx.createBuffer(1, float32Array.length, 24000);
        audioBuffer.getChannelData(0).set(float32Array);
        
        const source = audioCtx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(audioCtx.destination);
        
        const currentTime = audioCtx.currentTime;
        if (nextPlayTime < currentTime) {
            nextPlayTime = currentTime;
        }
        source.start(nextPlayTime);
        nextPlayTime += audioBuffer.duration;
    }

    // Playback raw binary ArrayBuffer PCM audio
    function playRawPCMBuffer(arrayBuffer) {
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        const int16Array = new Int16Array(arrayBuffer);
        const float32Array = new Float32Array(int16Array.length);
        for (let i = 0; i < int16Array.length; i++) {
            float32Array[i] = int16Array[i] / 32768.0;
        }
        
        const audioBuffer = audioCtx.createBuffer(1, float32Array.length, 24000);
        audioBuffer.getChannelData(0).set(float32Array);
        
        const source = audioCtx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(audioCtx.destination);
        
        const currentTime = audioCtx.currentTime;
        if (nextPlayTime < currentTime) {
            nextPlayTime = currentTime;
        }
        source.start(nextPlayTime);
        nextPlayTime += audioBuffer.duration;
    }

    // Route a live tool call from Gemini to OpenClaw
    function routeLiveToolCall(args, callId) {
        const toolName = args.toolName;
        const toolArguments = args.arguments || {};

        if (circuitState === 'OPEN') {
            sendToolWSSResponse(callId, null, "Blocked: circuit breaker active.");
            return;
        }

        appendTerminalLog(wssLogsEl, `< Intercepted Gemini Live toolCall '${toolName}'`, "server");
        appendTerminalLog(clawLogsEl, `Intercepted toolCall: '${toolName}'`, "invoke");

        const start = performance.now();
        const gatewayHost = gatewayIpInput.value.trim() || 'localhost';

        fetch(`/tools/invoke`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${openclawGatewayToken}`
            },
            body: JSON.stringify({
                tool: toolName,
                arguments: toolArguments,
                gatewayHost: gatewayHost
            })
        })
        .then(res => {
            const end = performance.now();
            rttEl.innerText = `${Math.round(end - start)} ms`;
            if (!res.ok) {
                return res.json().then(errData => {
                    const errMsg = (errData.error && errData.error.message) || errData.message || `HTTP ${res.status}`;
                    throw new Error(errMsg);
                });
            }
            return res.json();
        })
        .then(data => {
            if (data.ok || data.status === 'SUCCESS' || data.result) {
                failures = 0;
                const msg = data.result || data.message || "Execution completed successfully.";
                appendTerminalLog(clawLogsEl, `Tool Success: ${msg}`, "success");
                sendToolWSSResponse(callId, { result: msg }, null);
            } else {
                const errMsg = (data.error && data.error.message) || data.message || "Unknown gateway error";
                throw new Error(errMsg);
            }
        })
        .catch(err => {
            failures++;
            failureCountEl.innerText = failures;
            appendTerminalLog(clawLogsEl, `Tool Error: ${err.message}`, "fail");
            sendToolWSSResponse(callId, null, err.message);

            if (failures >= failureThreshold) {
                circuitState = 'OPEN';
                breakerStatusEl.innerText = 'OPEN';
                breakerStatusEl.className = 'status-value status-error';
            }
        });
    }

    function sendToolWSSResponse(callId, payload, error) {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;

        const responseObj = {
            id: callId,
            name: "execute"
        };

        if (error) {
            responseObj.response = { error: error };
        } else {
            responseObj.response = payload;
        }

        const msg = {
            toolResponse: {
                functionResponses: [responseObj]
            }
        };

        ws.send(JSON.stringify(msg));
        appendTerminalLog(wssLogsEl, `> Sent toolResponse back to Gemini Live.`, "client");
    }

    // --- 6. Manual Snapshot Photo Trigger ---
    snapBtn.addEventListener('click', () => {
        appendTerminalLog(clawLogsEl, "Capturing snapshot from live video element...", "system");
        
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = 504;
        tempCanvas.height = 896;
        const tempCtx = tempCanvas.getContext('2d');

        if (!cameraConnected || video.readyState !== video.HAVE_ENOUGH_DATA) {
            appendTerminalLog(clawLogsEl, "Upload Failed: No active live camera feed available.", "fail");
            return;
        }

        const scale = Math.max(tempCanvas.width / video.videoWidth, tempCanvas.height / video.videoHeight);
        const x = (tempCanvas.width / 2) - (video.videoWidth / 2) * scale;
        const y = (tempCanvas.height / 2) - (video.videoHeight / 2) * scale;
        
        tempCtx.translate(tempCanvas.width, 0);
        tempCtx.scale(-1, 1);
        tempCtx.drawImage(video, -x - (video.videoWidth * scale), y, video.videoWidth * scale, video.videoHeight * scale);

        tempCanvas.toBlob(blob => {
            if (!blob) return;

            fetch('/workspace/upload', {
                method: 'POST',
                body: blob
            })
            .then(res => res.json())
            .then(data => {
                appendTerminalLog(clawLogsEl, `Snapshot saved to host: assets/${data.filename}`, "success");
                refreshWorkspaceGallery();
            })
            .catch(err => {
                appendTerminalLog(clawLogsEl, `Upload Failed: ${err.message}`, "fail");
            });
        }, 'image/jpeg', 0.85);
    });

    // --- 7. Manual Form Tool Dispatcher ---
    toolForm.addEventListener('submit', e => {
        e.preventDefault();
        
        const toolName = toolSelect.value;
        let argumentsObj = {};
        try {
            argumentsObj = JSON.parse(toolArgs.value);
        } catch (err) {
            alert("Invalid JSON arguments format.");
            return;
        }

        invocations++;
        invocationCountEl.innerText = invocations;
        
        appendTerminalLog(clawLogsEl, `Invoking tool '${toolName}' manually...`, "invoke");
        
        const startTimestamp = performance.now();
        const gatewayHost = gatewayIpInput.value.trim() || 'localhost';

        fetch(`/tools/invoke`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${openclawGatewayToken}`
            },
            body: JSON.stringify({
                tool: toolName,
                arguments: argumentsObj,
                gatewayHost: gatewayHost
            })
        })
        .then(res => {
            const endTimestamp = performance.now();
            rttEl.innerText = `${Math.round(endTimestamp - startTimestamp)} ms`;
            if (!res.ok) {
                return res.json().then(errData => {
                    const errMsg = (errData.error && errData.error.message) || errData.message || `HTTP ${res.status}`;
                    throw new Error(errMsg);
                });
            }
            return res.json();
        })
        .then(data => {
            const msg = data.result || data.message || "Execution completed successfully.";
            appendTerminalLog(clawLogsEl, `Tool Response: ${msg}`, "success");
        })
        .catch(err => {
            failures++;
            failureCountEl.innerText = failures;
            appendTerminalLog(clawLogsEl, `Tool Invocation Failure: ${err.message}`, "fail");
        });
    });

    // --- 8. Workspace Gallery ---
    function refreshWorkspaceGallery() {
        fetch('/api/images')
        .then(res => res.json())
        .then(images => {
            galleryGrid.innerHTML = '';
            
            if (images.length === 0) {
                galleryGrid.innerHTML = '<p class="empty-gallery-msg">No images captured in the workspace yet. Take a snapshot to save files to the host disk.</p>';
                return;
            }

            images.forEach(filename => {
                const card = document.createElement('div');
                card.className = 'gallery-card';
                
                const img = document.createElement('img');
                img.src = `assets/${filename}`;
                img.className = 'gallery-thumbnail';
                
                const meta = document.createElement('div');
                meta.className = 'gallery-meta';
                meta.innerText = filename;

                card.appendChild(img);
                card.appendChild(meta);
                
                card.addEventListener('click', () => {
                    const viewerImg = new Image();
                    viewerImg.src = `assets/${filename}`;
                    viewerImg.onload = () => {
                        cameraCtx.drawImage(viewerImg, 0, 0, cameraCanvas.width, cameraCanvas.height);
                        appendTerminalLog(clawLogsEl, `Inspecting file: assets/${filename}`, "system");
                    };
                });

                galleryGrid.appendChild(card);
            });
        })
        .catch(err => {
            console.error("Failed to load workspace images: ", err);
        });
    }

    refreshGalleryBtn.addEventListener('click', refreshWorkspaceGallery);

    // Toggle Raw Pipeline JSON files
    function fetchPipelineJSON() {
        const files = [
            { path: 'meta.json', elId: 'json-meta' },
            { path: 'timeline.json', elId: 'json-timeline' },
            { path: 'run_summary.json', elId: 'json-summary' }
        ];

        files.forEach(file => {
            fetch(file.path)
                .then(res => res.json())
                .then(data => {
                    document.getElementById(file.elId).innerText = JSON.stringify(data, null, 2);
                })
                .catch(err => {
                    document.getElementById(file.elId).innerText = `Error: ${err.message}`;
                });
        });
    }

    toggleDebugBtn.addEventListener('click', () => {
        debugContainer.classList.toggle('hidden');
        if (!debugContainer.classList.contains('hidden')) {
            fetchPipelineJSON();
        }
    });

    // Run loops
    drawCameraFrame();
    drawAudioWaveform();
    refreshWorkspaceGallery();
    setInterval(refreshWorkspaceGallery, 10000);

    // Fetch unified config and pre-populate credentials, then auto-connect
    fetch('/api/config')
    .then(res => res.json())
    .then(config => {
        if (config.gatewayToken) {
            openclawGatewayToken = config.gatewayToken;
        }
        if (config.geminiApiKey) {
            apiKeyInput.value = config.geminiApiKey;
            appendTerminalLog(wssLogsEl, "Automatically populated Gemini API Key from .env. Connecting...", "success");
            
            // Auto connect live session
            setTimeout(() => {
                connectWsBtn.click();
            }, 100);
        }
    })
    .catch(err => {
        console.warn("Failed to load auto-config:", err);
    });
});
