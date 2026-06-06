// server.js
// VisionClaw Mock API Gateway and Dashboard Static File Server
// Uses native Node.js libraries to process real local uploads and tool calls

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 18790;

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

    // 1. Live API Route: OpenClaw tool call invocation
    if (req.method === 'POST' && req.url === '/tools/invoke') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const payload = JSON.parse(body);
                console.log(`[OpenClaw Tool Intercept] Running: ${payload.tool} with args:`, payload.arguments);
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: 'SUCCESS',
                    message: `OpenClaw gateway simulated tool '${payload.tool}' execution completed successfully.`,
                    timestamp: new Date().toISOString()
                }));
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

            // Ensure assets folder exists on disk
            fs.mkdir(assetsDir, { recursive: true }, (dirErr) => {
                if (dirErr) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'ERROR', message: 'Failed to create assets directory.' }));
                    return;
                }

                // Write binary image buffer to disk
                fs.writeFile(filePath, buffer, (writeErr) => {
                    if (writeErr) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ status: 'ERROR', message: writeErr.message }));
                    } else {
                        console.log(`[OpenClaw Workspace] Image snapshot saved to: ${filePath}`);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            status: 'SUCCESS',
                            filename: filename
                        }));
                    }
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
