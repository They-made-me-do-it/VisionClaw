const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 18790;
let latestDiagnosticReport = null;

const server = http.createServer((req, res) => {
    // Enable CORS for dashboard
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    if (req.method === 'GET' && req.url === '/api/config') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            geminiApiKey: "AIzaSyAq9doF17T9IEX5nD4zXxEm2XberYGApYw",
            gatewayToken: "bcc2b8fb978d0aaab930713064dff7ac9c801c2e7e6a5f16"
        }));
        return;
    }

    if (req.method === 'POST' && req.url === '/api/diagnostics') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                latestDiagnosticReport = JSON.parse(body);
                const logFile = path.join(__dirname, '_handoff', 'DIAG_REPORTS.jsonl');
                fs.appendFileSync(logFile, body + '\n');
                console.log(`[DIAGNOSTICS] Received report: ${body}`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'RECEIVED', timestamp: new Date().toISOString() }));
            } catch (e) {
                res.writeHead(400);
                res.end();
            }
        });
        return;
    }

    if (req.method === 'GET' && req.url === '/api/diagnostics_latest') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(latestDiagnosticReport || { error: 'No report yet' }));
        return;
    }

    // Static file serving for Dashboard
    let filePath = '.' + req.url;
    if (filePath == './') filePath = './index.html';

    const extname = path.extname(filePath);
    let contentType = 'text/html';
    switch (extname) {
        case '.js': contentType = 'text/javascript'; break;
        case '.css': contentType = 'text/css'; break;
        case '.json': contentType = 'application/json'; break;
        case '.png': contentType = 'image/png'; break;
        case '.jpg': contentType = 'image/jpg'; break;
    }

    fs.readFile(filePath, (error, content) => {
        if (error) {
            res.writeHead(404);
            res.end('File not found');
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`VisionClaw Dashboard Server running on port ${PORT}`);
});
