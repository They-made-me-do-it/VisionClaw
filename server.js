// server.js
// VisionClaw Mock API Gateway and Dashboard Static File Server
// Uses native Node.js libraries to process real local uploads and tool calls

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const PORT = 18790;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

// Global state for diagnostics
let latestDiagnosticReport = null;
let voiceCheckStatus = "PENDING"; // State: "PENDING", "PASS", "FAIL"

// Load and parse d:\Meta\.env configuration file
const envPath = path.join(__dirname, '.env');
let envConfig = {};
if (fs.existsSync(envPath)) {
    try {
        const envContent = fs.readFileSync(envPath, 'utf-8');
        let malformed = 0;
        envContent.split(/\r?\n/).forEach((line, idx) => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) return;
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx <= 0) {
                malformed++;
                return;
            }
            const key = trimmed.slice(0, eqIdx).trim();
            let value = trimmed.slice(eqIdx + 1).trim();
            if (value.length >= 2) {
                const first = value.charAt(0);
                const last = value.charAt(value.length - 1);
                if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
                    value = value.slice(1, -1);
                }
            }
            envConfig[key] = value;
        });
        console.log(`[Config] Successfully loaded config variables from .env`);
    } catch (e) {
        console.error(`[Config Error] Failed to read .env: ${e.message}`);
    }
}

const MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png'
};

const server = http.createServer((req, res) => {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // 1. API: Config
    if (req.method === 'GET' && req.url === '/api/config') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            geminiApiKey: envConfig['GEMINI_API_KEY'] || '',
            gatewayToken: envConfig['OPENCLAW_GATEWAY_TOKEN'] || ''
        }));
        return;
    }

    // 2. API: Diagnostics POST
    if (req.method === 'POST' && req.url === '/api/diagnostics') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                latestDiagnosticReport = JSON.parse(body);
                const logFile = path.join(__dirname, '_handoff', 'DIAG_REPORTS.jsonl');
                if (!fs.existsSync(path.dirname(logFile))) fs.mkdirSync(path.dirname(logFile), { recursive: true });
                fs.appendFileSync(logFile, body + '\n');
                console.log(`[DIAGNOSTICS] Received report from S25`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'RECEIVED' }));
            } catch (e) {
                res.writeHead(400);
                res.end();
            }
        });
        return;
    }

    // 3. API: Latest Diagnostic GET
    if (req.method === 'GET' && req.url === '/api/diagnostics_latest') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(latestDiagnosticReport || { error: 'No report received yet from S25' }));
        return;
    }

    // 3a. API: Remote Console Logger
    if (req.method === 'POST' && req.url === '/api/log') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const payload = JSON.parse(body);
                const logMsg = `[BROWSER LOG] [${payload.type.toUpperCase()}] ${payload.message}`;
                console.log(logMsg);
                
                // Write to handoff/LAST_RUN.log too
                const logFile = path.join(__dirname, '_handoff', 'LAST_RUN.log');
                fs.appendFileSync(logFile, `${new Date().toISOString()} ${logMsg}\n`);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'OK' }));
            } catch (e) {
                res.writeHead(400);
                res.end();
            }
        });
        return;
    }

    // 3b. API: Cleanup Tasks
    if (req.method === 'POST' && req.url === '/api/cleanup') {
        // Run powershell command to kill run_voice_handshake.py processes
        const { exec } = require('child_process');
        exec('powershell.exe -Command "Get-CimInstance Win32_Process -Filter \\"Name = \'python.exe\' AND CommandLine LIKE \'%run_voice_handshake.py%\'\\" | Invoke-CimMethod -MethodName Terminate"', (err, stdout, stderr) => {
            const logFile = path.join(__dirname, '_handoff', 'LAST_RUN.log');
            fs.appendFileSync(logFile, `${new Date().toISOString()} [SERVER] /api/cleanup executed. Output: ${stdout.trim() || 'No rogue tasks found'}\n`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'OK', message: 'Cleanup complete' }));
        });
        return;
    }

    // 3c. API: Context Integration (RAG)
    if (req.method === 'GET' && req.url === '/api/context') {
        const contextFile = path.join(__dirname, '_handoff', 'RAG_CONTEXT.md');
        if (fs.existsSync(contextFile)) {
            const contextStr = fs.readFileSync(contextFile, 'utf-8');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'OK', context: contextStr }));
        } else {
            // Provide a default template if missing
            const defaultContext = "You are Gemini, connected to the VisionClaw interface. This is a local development environment. You have access to real-time audio and egocentric video from the user's POV.";
            fs.mkdirSync(path.dirname(contextFile), { recursive: true });
            fs.writeFileSync(contextFile, defaultContext);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'OK', context: defaultContext }));
        }
        return;
    }

    // 3d. API: Daily Transcript Logger
    if (req.method === 'POST' && req.url === '/api/transcript') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const payload = JSON.parse(body);
                const dateStr = new Date().toISOString().split('T')[0];
                const logFile = path.join(__dirname, '_handoff', `TRANSCRIPT_${dateStr}.log`);
                const timestamp = new Date().toISOString();
                
                fs.mkdirSync(path.dirname(logFile), { recursive: true });
                const logEntry = `[${timestamp}] [${payload.sender.toUpperCase()}] [${payload.type.toUpperCase()}] ${payload.content}\n`;
                fs.appendFileSync(logFile, logEntry);
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'OK' }));
            } catch (e) {
                console.error("[SERVER] Failed to append transcript:", e);
                res.writeHead(400);
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // 3e. API: POST Check
    if (req.method === 'GET' && req.url === '/api/post_check') {
        const geminiKey = envConfig['GEMINI_API_KEY'] || process.env.GEMINI_API_KEY || '';
        const gwToken = envConfig['OPENCLAW_GATEWAY_TOKEN'] || process.env.OPENCLAW_GATEWAY_TOKEN || '';
        
        const gatewayCheck = new Promise((resolve) => {
            const checkReq = http.request({
                hostname: 'localhost',
                port: 18789,
                path: '/tools/invoke',
                method: 'OPTIONS',
                timeout: 1500
            }, (checkRes) => {
                resolve(true);
            });
            checkReq.on('error', () => {
                resolve(false);
            });
            checkReq.on('timeout', () => {
                checkReq.destroy();
                resolve(false);
            });
            checkReq.end();
        });

        gatewayCheck.then((gwOnline) => {
            const nodeOk = "PASS";
            const gwOk = gwOnline ? "PASS" : "FAIL";
            const keyOk = (geminiKey && geminiKey.trim().length > 0) ? "PASS" : "FAIL";
            const tokenOk = (gwToken && gwToken.trim().length > 0) ? "PASS" : "FAIL";
            
            const overallOk = (
                nodeOk === "PASS" &&
                gwOk === "PASS" &&
                keyOk === "PASS" &&
                tokenOk === "PASS" &&
                voiceCheckStatus === "PASS"
            ) ? "PASS" : (
                (gwOk === "FAIL" || keyOk === "FAIL" || tokenOk === "FAIL" || voiceCheckStatus === "FAIL") ? "FAIL" : "PENDING"
            );

            const report = {
                nodeServer: nodeOk,
                gateway: gwOk,
                geminiApiKey: keyOk,
                gatewayToken: tokenOk,
                voiceCheck: voiceCheckStatus,
                overall: overallOk
            };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(report));
        });
        return;
    }

    // 3c. API: POST Check Voice Handshake Update
    if (req.method === 'POST' && req.url === '/api/post_check/voice') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const payload = JSON.parse(body);
                if (payload.status === "PASS" || payload.status === "FAIL" || payload.status === "PENDING") {
                    voiceCheckStatus = payload.status;
                    console.log(`[POST CHECK] Voice handshake status updated to: ${voiceCheckStatus}`);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'OK', voiceCheckStatus }));
                } else {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Invalid status' }));
                }
            } catch (e) {
                res.writeHead(400);
                res.end();
            }
        });
        return;
    }

    // 3d. API: Append Transcript / Save Images
    if (req.method === 'POST' && req.url === '/api/transcript') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const payload = JSON.parse(body);
                const timestamp = payload.timestamp || new Date().toISOString();
                const sender = payload.sender; // "user" or "gemini"
                const type = payload.type;     // "text", "audio_transcription", "image"
                const content = payload.content; // text content or base64 image data
                
                const handoffDir = path.join(__dirname, '_handoff');
                if (!fs.existsSync(handoffDir)) fs.mkdirSync(handoffDir, { recursive: true });
                
                let transcriptEntry = { timestamp, sender, type };
                
                if (type === 'image') {
                    // Save image separately in assets/
                    const assetsDir = path.join(__dirname, 'assets');
                    if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });
                    
                    // Create clean file-safe timestamp string
                    const safeTime = timestamp.replace(/[:.]/g, '-');
                    const filename = `frame_${safeTime}.jpg`;
                    const filepath = path.join(assetsDir, filename);
                    
                    const buffer = Buffer.from(content, 'base64');
                    fs.writeFileSync(filepath, buffer);
                    console.log(`[Transcript] Saved streamed frame to: ${filepath}`);
                    
                    transcriptEntry.imageFile = filename;
                } else {
                    transcriptEntry.text = content;
                }
                
                // 1. Save to JSONL file
                const jsonlPath = path.join(handoffDir, 'transcript.jsonl');
                fs.appendFileSync(jsonlPath, JSON.stringify(transcriptEntry) + '\n');
                
                // 2. Append to Markdown file (TRANSCRIPT.md)
                const mdPath = path.join(handoffDir, 'TRANSCRIPT.md');
                let mdLine = '';
                if (!fs.existsSync(mdPath)) {
                    fs.writeFileSync(mdPath, `# VisionClaw Multimodal Conversation Transcript\n\nGenerated on: ${new Date().toLocaleDateString()}\n\n---\n\n`);
                }
                
                const timeStr = new Date(timestamp).toLocaleTimeString();
                if (type === 'image') {
                    mdLine = `**[${timeStr}] User (Camera Frame)**:\n\n![Camera Frame](../assets/${transcriptEntry.imageFile})\n\n---\n\n`;
                } else {
                    const senderLabel = sender === 'user' ? 'User' : 'Gemini';
                    mdLine = `**[${timeStr}] ${senderLabel}**: ${content}\n\n---\n\n`;
                }
                fs.appendFileSync(mdPath, mdLine);
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'OK', entry: transcriptEntry }));
            } catch (e) {
                console.error("[Transcript Error]", e);
                res.writeHead(400);
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // 3e. API: Amazon Recon Proxy
    if (req.method === 'POST' && req.url === '/api/amazon_recon') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const payload = JSON.parse(body);
                const query = payload.query || '';
                if (!query) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: "Query is required" }));
                }

                const apiKey = envConfig['SERPAPI_API_KEY'];
                if (!apiKey) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: "SERPAPI_API_KEY is not configured" }));
                }

                const serpUrl = `https://serpapi.com/search?engine=google&q=site:amazon.com+${encodeURIComponent(query)}&api_key=${apiKey}`;

                const serpReq = https.get(serpUrl, { timeout: 10000 }, (serpRes) => {
                    let data = '';
                    serpRes.on('data', chunk => { data += chunk; });
                    serpRes.on('end', () => {
                        try {
                            const parsed = JSON.parse(data);
                            const organic = parsed.organic_results || [];
                            
                            const topItems = organic.slice(0, 3).map(item => ({
                                title: item.title,
                                price: item.extracted_price ? `$${item.extracted_price}` : (item.price || "N/A"),
                                link: item.link
                            }));

                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({
                                status: "success",
                                results: topItems,
                                message: `Found ${topItems.length} matching items on Amazon via SerpApi.`
                            }));
                        } catch (e) {
                            res.writeHead(500, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: "Failed to parse SerpApi response" }));
                        }
                    });
                });

                serpReq.on('timeout', () => {
                    serpReq.destroy();
                    res.writeHead(504, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: "SerpApi request timed out after 10 seconds." }));
                });

                serpReq.on('error', (err) => {
                    res.writeHead(502, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: `SerpApi connection error: ${err.message}` }));
                });

            } catch (e) {
                console.error("[Amazon Recon Error]", e);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message || "Failed to execute Amazon Recon" }));
            }
        });
        return;
    }

    // 4. API: Tool Invoke Proxy
    if (req.method === 'POST' && req.url === '/tools/invoke') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const payload = JSON.parse(body);
                const gatewayHost = payload.gatewayHost || 'localhost';
                const gatewayPort = 18789;

                const proxyReq = http.request({
                    hostname: gatewayHost,
                    port: gatewayPort,
                    path: '/tools/invoke',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${envConfig['OPENCLAW_GATEWAY_TOKEN'] || ''}`
                    }
                }, (proxyRes) => {
                    res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
                    proxyRes.pipe(res);
                });
                proxyReq.on('error', () => {
                    res.writeHead(502);
                    res.end(JSON.stringify({ error: 'Gateway unreachable' }));
                });
                proxyReq.write(body);
                proxyReq.end();
            } catch (e) {
                res.writeHead(400);
                res.end();
            }
        });
        return;
    }

    // 5. API: Images
    if (req.method === 'GET' && req.url === '/api/images') {
        const assetsDir = path.join(__dirname, 'assets');
        if (!fs.existsSync(assetsDir)) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify([]));
            return;
        }
        const files = fs.readdirSync(assetsDir).filter(f => f.endsWith('.jpg')).sort().reverse();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(files));
        return;
    }

    // 6. Static File Server
    let requestedPath = req.url === '/' ? '/index.html' : req.url;
    // Strip query strings
    requestedPath = requestedPath.split('?')[0];

    const filePath = path.join(__dirname, requestedPath);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, content) => {
        if (err) {
            res.writeHead(404);
            res.end('Not Found');
        } else {
            res.writeHead(200, { 
                'Content-Type': contentType,
                'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
                'Pragma': 'no-cache',
                'Expires': '0'
            });
            res.end(content);
        }
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`VisionClaw Dashboard Server running at http://localhost:${PORT}`);
});
