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
            // Strip a single matching pair of surrounding quotes (double or single)
            if (value.length >= 2) {
                const first = value.charAt(0);
                const last = value.charAt(value.length - 1);
                if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
                    value = value.slice(1, -1);
                }
            }
            envConfig[key] = value;
        });
        console.log(`[Config] Successfully loaded config variables from .env${malformed ? ` (skipped ${malformed} malformed line${malformed === 1 ? '' : 's'})` : ''}`);
    } catch (e) {
        console.error(`[Config Error] Failed to read .env: ${e.message}`);
    }
} else {
    console.log(`[Config Warning] .env file not found at ${envPath}`);
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
    console.log(`[REQUEST] ${req.method} ${req.url}`);

    // Enable CORS for testing
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // config API endpoint to serve Gemini API Key and OpenClaw Gateway Token to clients on LAN
    if (req.method === 'GET' && req.url === '/api/config') {
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store'
        });
        res.end(JSON.stringify({
            geminiApiKey: envConfig['GEMINI_API_KEY'] || '',
            gatewayToken: envConfig['OPENCLAW_GATEWAY_TOKEN'] || ''
        }));
        return;
    }

    // 1. Live API Route: OpenClaw tool call invocation (Proxy bridge with strict error reporting)
    if (req.method === 'POST' && req.url === '/tools/invoke') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const payload = JSON.parse(body);
                const toolName = payload.tool;
                const toolArguments = payload.arguments || {};
                const gatewayHost = payload.gatewayHost || 'localhost';
                const gatewayPort = 18789;

                console.log(`[Proxy Link] Forwarding tool '${toolName}' to OpenClaw at http://${gatewayHost}:${gatewayPort}/tools/invoke`);

                const postData = JSON.stringify({
                    tool: toolName,
                    arguments: toolArguments
                });

                const gatewayToken = envConfig['OPENCLAW_GATEWAY_TOKEN'] || 'oc_live_token_7a9c8b3d2e1f0';
                const authHeader = `Bearer ${gatewayToken}`;

                const proxyReq = http.request({
                    hostname: gatewayHost,
                    port: gatewayPort,
                    path: '/tools/invoke',
                    method: 'POST',
                    timeout: 5000,
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(postData),
                        'Authorization': authHeader
                    }
                }, (proxyRes) => {
                    let responseData = '';
                    proxyRes.on('data', chunk => { responseData += chunk; });
                    proxyRes.on('end', () => {
                        res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
                        res.end(responseData);
                    });
                });

                proxyReq.on('timeout', () => {
                    proxyReq.destroy(new Error('Gateway request timed out after 5000ms'));
                });

                proxyReq.on('error', (err) => {
                    console.error(`[Proxy Link Refused] ${err.message}`);
                    res.writeHead(502, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        status: 'ERROR',
                        message: `OpenClaw gateway is offline or unreachable at ${gatewayHost}:${gatewayPort} (${err.message})`
                    }));
                });

                proxyReq.write(postData);
                proxyReq.end();

            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'ERROR', message: 'Invalid JSON payload' }));
            }
        });
        return;
    }

    // 2. Live API Route: OpenClaw workspace upload (Writes actual binary JPEG buffer to disk)
    if (req.method === 'POST' && req.url === '/workspace/upload') {
        const contentLength = parseInt(req.headers['content-length'] || '0', 10);
        if (Number.isNaN(contentLength) || contentLength <= 0) {
            res.writeHead(411, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ERROR', message: 'Content-Length header required.' }));
            return;
        }
        if (contentLength > MAX_UPLOAD_BYTES) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ERROR', message: `Upload exceeds ${MAX_UPLOAD_BYTES} byte limit.` }));
            return;
        }

        let received = 0;
        let aborted = false;
        const chunks = [];
        req.on('data', chunk => {
            if (aborted) return;
            received += chunk.length;
            if (received > MAX_UPLOAD_BYTES) {
                aborted = true;
                res.writeHead(413, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'ERROR', message: `Upload exceeds ${MAX_UPLOAD_BYTES} byte limit.` }));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        }).on('end', () => {
            if (aborted) return;
            const buffer = Buffer.concat(chunks);
            const filename = `capture_${Date.now()}.jpg`;
            const assetsDir = path.join(__dirname, 'assets');
            const filePath = path.join(assetsDir, filename);

            const workspaceDir = path.join(os.homedir(), '.openclaw', 'workspace');

            // Ensure assets folder exists on disk
            fs.mkdir(assetsDir, { recursive: true }, (dirErr) => {
                if (dirErr) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'ERROR', message: 'Failed to create assets directory.' }));
                    return;
                }

                // Write to local assets first for the UI gallery
                fs.writeFile(filePath, buffer, (writeErr) => {
                    if (writeErr) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ status: 'ERROR', message: writeErr.message }));
                        return;
                    }
                    console.log(`[OpenClaw Workspace] Image snapshot saved to: ${filePath}`);

                    // Fire-and-forget copy to the home OpenClaw workspace. This is best-effort
                    // and intentionally does not gate the HTTP response on completion.
                    fs.mkdir(workspaceDir, { recursive: true }, (wsDirErr) => {
                        if (wsDirErr) {
                            console.log(`[OpenClaw Workspace Warning] Could not ensure ${workspaceDir}: ${wsDirErr.message}`);
                            return;
                        }
                        const wsFilePath = path.join(workspaceDir, filename);
                        fs.writeFile(wsFilePath, buffer, (wsWriteErr) => {
                            if (wsWriteErr) {
                                console.log(`[OpenClaw Workspace Warning] Failed to write copy to ${wsFilePath}: ${wsWriteErr.message}`);
                            } else {
                                console.log(`[OpenClaw Workspace] Copied image snapshot to OpenClaw workspace: ${wsFilePath}`);
                            }
                        });
                    });

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        status: 'SUCCESS',
                        filename: filename
                    }));
                });
            });
        });
        return;
    }

    // 3. API Route: List saved images in workspace
    if (req.method === 'GET' && req.url === '/api/images') {
        const assetsDir = path.join(__dirname, 'assets');
        fs.readdir(assetsDir, (err, files) => {
            if (err) {
                // Return empty if directory doesn't exist yet
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify([]));
                return;
            }
            const filteredFiles = files.filter(f => f.startsWith('capture_') && f.endsWith('.jpg'));
            if (filteredFiles.length === 0) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify([]));
                return;
            }
            const images = [];
            let pending = filteredFiles.length;
            filteredFiles.forEach(f => {
                const fullPath = path.join(assetsDir, f);
                fs.stat(fullPath, (statErr, stats) => {
                    if (!statErr && stats.size > 1024) {
                        images.push(f);
                    }
                    pending--;
                    if (pending === 0) {
                        images.sort((a, b) => b.localeCompare(a)); // sort descending (newest first)
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(images));
                    }
                });
            });
        });
        return;
    }

    // 4. Live API Route: Amazon Inventory Bypass (SerpApi site:amazon.com Search Proxy)
    if (req.method === 'POST' && req.url === '/api/amazon/search') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const payload = JSON.parse(body);
                const query = encodeURIComponent(`site:amazon.com ${payload.query || ''}`);
                const apiKey = envConfig['SERPAPI_API_KEY'];

                if (!apiKey) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'ERROR', message: 'SerpApi API key missing from .env' }));
                    return;
                }

                const url = `https://serpapi.com/search.json?q=${query}&api_key=${encodeURIComponent(apiKey)}&engine=google`;

                const upstreamReq = https.get(url, (apiRes) => {
                    let data = '';
                    apiRes.on('data', chunk => { data += chunk; });
                    apiRes.on('end', () => {
                        if (apiRes.statusCode >= 400) {
                            res.writeHead(502, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ status: 'ERROR', message: `SerpApi upstream returned HTTP ${apiRes.statusCode}` }));
                            return;
                        }
                        try {
                            const json = JSON.parse(data);
                            if (json.error) {
                                res.writeHead(500, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ status: 'ERROR', message: json.error }));
                                return;
                            }
                            const organicResults = json.organic_results || [];
                            // Extract top 3 results
                            const results = organicResults.slice(0, 3).map(item => {
                                let price = 'N/A';
                                if (item.rich_snippet && item.rich_snippet.shopping && item.rich_snippet.shopping.price) {
                                    price = item.rich_snippet.shopping.price;
                                } else {
                                    // Try to parse price from snippet (e.g. "$49.99")
                                    const match = (item.snippet || '').match(/\$[0-9]+(?:\.[0-9]{2})?/);
                                    if (match) {
                                        price = match[0];
                                    }
                                }
                                return {
                                    title: item.title.replace(" - Amazon.com", "").replace(": Amazon.com", ""),
                                    price: price,
                                    link: item.link
                                };
                            });
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify(results));
                        } catch (e) {
                            res.writeHead(500, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ status: 'ERROR', message: 'Failed to parse search response' }));
                        }
                    });
                });
                upstreamReq.setTimeout(10000, () => {
                    upstreamReq.destroy(new Error('SerpApi request timed out after 10000ms'));
                });
                upstreamReq.on('error', (err) => {
                    res.writeHead(502, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'ERROR', message: err.message }));
                });

            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'ERROR', message: 'Invalid payload' }));
            }
        });
        return;
    }

    // Mock ClawHub API: Skill verification route
    if (req.method === 'GET' && req.url.startsWith('/api/v1/skills/amazon-recon/verify')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            ok: true,
            decision: 'pass',
            card: {
                available: true,
                url: '/api/v1/skills/amazon-recon/card'
            }
        }));
        return;
    }

    // Mock ClawHub API: Skill card route
    if (req.method === 'GET' && req.url === '/api/v1/skills/amazon-recon/card') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end([
            "┌────────────────────────────────────────────────────────┐",
            "│                 AMAZON-RECON SKILL CARD                │",
            "├────────────────────────────────────────────────────────┤",
            "│ Slug:        amazon-recon                              │",
            "│ Status:      ACTIVE                                    │",
            "│ Invocable:   true                                      │",
            "│ Gated Bins:  curl (PASSED)                             │",
            "│ Gated Config:chatCompletions (PASSED)                  │",
            "│ Gated OS:    darwin, linux (PASSED via bypass)         │",
            "└────────────────────────────────────────────────────────┘"
        ].join("\n") + "\n");
        return;
    }

    // 5. Static Files Server
    const requestedPath = req.url === '/' ? '/index.html' : req.url.split('?')[0].split('#')[0];
    const decodedPath = decodeURIComponent(requestedPath);
    const filePath = path.normalize(path.join(__dirname, decodedPath));
    const extname = String(path.extname(filePath)).toLowerCase();
    const contentType = MIME_TYPES[extname] || 'application/octet-stream';

    const root = path.resolve(__dirname) + path.sep;
    if (filePath !== path.resolve(__dirname) && !filePath.startsWith(root)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
    }

    fs.readFile(filePath, (error, content) => {
        if (error) {
            if (error.code === 'ENOENT') {
                res.writeHead(404, { 'Content-Type': 'text/html' });
                res.end('<h1>404 Not Found</h1>', 'utf-8');
            } else {
                res.writeHead(500);
                res.end(`Server Error: ${error.code}`);
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
});

server.listen(PORT, () => {
    console.log(`==================================================`);
    console.log(`   VISIONCLAW STATIC DASHBOARD FILE SERVER        `);
    console.log(`==================================================`);
    console.log(`Dashboard Server: http://localhost:${PORT}`);
    console.log(`OpenClaw Target:  http://localhost:18789/tools/invoke`);
    console.log(`Press Ctrl+C to terminate dashboard server.`);
});
