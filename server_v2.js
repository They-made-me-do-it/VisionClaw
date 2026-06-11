const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 18790;
let latestDiagnosticReport = null;

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    if (req.url === '/api/config') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ geminiApiKey: "AIzaSyAq9doF17T9IEX5nD4zXxEm2XberYGApYw", gatewayToken: "bcc2b8fb978d0aaab930713064dff7ac9c801c2e7e6a5f16" }));
    } else if (req.url === '/api/diagnostics') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            latestDiagnosticReport = JSON.parse(body);
            fs.appendFileSync(path.join(__dirname, '_handoff', 'DIAG_REPORTS.jsonl'), body + '\n');
            res.writeHead(200);
            res.end();
        });
    } else if (req.url === '/api/diagnostics_latest') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(latestDiagnosticReport || { error: 'none' }));
    } else {
        res.writeHead(200);
        res.end('VisionClaw Active');
    }
});

server.listen(PORT, '0.0.0.0');
