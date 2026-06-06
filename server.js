// server.js
// VisionClaw Mock API Gateway and Dashboard Static File Server
// Uses native Node.js libraries to process real local uploads and tool calls

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 18790;

// Load and parse d:\Meta\.env configuration file
const envPath = path.join(__dirname, '.env');
let envConfig = {};
if (fs.existsSync(envPath)) {
    try {
        const envContent = fs.readFileSync(envPath, 'utf-8');
        envContent.split(/\r?\n/).forEach(line => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) return;
            const match = trimmed.match(/^([\w.-]+)\s*=\s*(.*)?\s*$/);
            if (match) {
                let key = match[1];
                let value = match[2] ? match[2].trim() : '';
                // Strip quotes
                if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                    value = value.substring(1, value.length - 1);
                }
                envConfig[key] = value;
            }
        });
        console.log(`[Config] Successfully loaded config variables from .env`);
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
        res.writeHead(200, { 'Content-Type': 'application/json' });
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
        let body = [];
        req.on('data', chunk => {
            body.push(chunk);
        }).on('end', () => {
            const buffer = Buffer.concat(body);
            const filename = `capture_${Date.now()}.jpg`;
            const assetsDir = path.join(__dirname, 'assets');
            const filePath = path.join(assetsDir, filename);

            const os = require('os');
            const workspaceDir = path.join(os.homedir(), '.openclaw', 'workspace');

            // Ensure assets folder exists on disk
            fs.mkdir(assetsDir, { recursive: true }, (dirErr) => {
                if (dirErr) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'ERROR', message: 'Failed to create assets directory.' }));
                    return;
                }

                fs.mkdir(workspaceDir, { recursive: true }, (wsDirErr) => {
                    // Write to local assets first for the UI gallery
                    fs.writeFile(filePath, buffer, (writeErr) => {
                        if (writeErr) {
                            res.writeHead(500, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ status: 'ERROR', message: writeErr.message }));
                        } else {
                            console.log(`[OpenClaw Workspace] Image snapshot saved to: ${filePath}`);

                            // Also write copy to home OpenClaw workspace
                            const wsFilePath = path.join(workspaceDir, filename);
                            fs.writeFile(wsFilePath, buffer, (wsWriteErr) => {
                                if (wsWriteErr) {
                                    console.log(`[OpenClaw Workspace Warning] Failed to write copy to ${wsFilePath}: ${wsWriteErr.message}`);
                                } else {
                                    console.log(`[OpenClaw Workspace] Copied image snapshot to OpenClaw workspace: ${wsFilePath}`);
                                }
                            });

                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({
                                status: 'SUCCESS',
                                filename: filename
                            }));
                        }
                    });
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
            const images = files.filter(f => f.startsWith('capture_') && f.endsWith('.jpg'))
                                 .sort((a, b) => b.localeCompare(a)); // sort descending (newest first)
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(images));
        });
        return;
    }

    // 4. Static Files Server
    let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
    const extname = String(path.extname(filePath)).toLowerCase();
    const contentType = MIME_TYPES[extname] || 'application/octet-stream';

    if (!filePath.startsWith(__dirname)) {
        res.writeHead(403);
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
