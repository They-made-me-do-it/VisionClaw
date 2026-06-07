#!/usr/bin/env node
// test_server.js
// Lightweight integration test for server.js. Assumes the server is already
// running at http://127.0.0.1:18790 (e.g. started by START_APP.ps1).
//
// Exits 0 on success, 1 on first failure.

const http = require('http');
const fs = require('fs');
const path = require('path');

const HOST = process.env.TEST_HOST || '127.0.0.1';
const PORT = parseInt(process.env.TEST_PORT || '18790', 10);

let failed = 0;
let passed = 0;

function request(method, urlPath, options = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: HOST,
            port: PORT,
            path: urlPath,
            method,
            headers: options.headers || {}
        }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const body = Buffer.concat(chunks);
                resolve({ status: res.statusCode, headers: res.headers, body });
            });
        });
        req.on('error', reject);
        if (options.body) req.write(options.body);
        req.end();
    });
}

function assert(name, cond, detail) {
    if (cond) {
        passed++;
        console.log(`  ok   ${name}`);
    } else {
        failed++;
        console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`);
    }
}

async function run() {
    console.log(`Running server.js integration tests against http://${HOST}:${PORT}`);

    // 1. /api/config
    {
        const r = await request('GET', '/api/config');
        const json = JSON.parse(r.body.toString('utf-8'));
        assert('GET /api/config returns 200', r.status === 200, `status=${r.status}`);
        assert('/api/config has geminiApiKey + gatewayToken', 'geminiApiKey' in json && 'gatewayToken' in json);
        assert('/api/config sets Cache-Control: no-store', (r.headers['cache-control'] || '').includes('no-store'));
    }

    // 2. /api/amazon/search with invalid JSON
    {
        const r = await request('POST', '/api/amazon/search', {
            headers: { 'Content-Type': 'application/json' },
            body: 'not-json'
        });
        assert('POST /api/amazon/search with bad JSON returns 400', r.status === 400, `status=${r.status}`);
    }

    // 3. /workspace/upload with no Content-Length
    {
        const r = await request('POST', '/workspace/upload', { headers: { 'Content-Length': '0' } });
        assert('POST /workspace/upload with zero length returns 411', r.status === 411, `status=${r.status}`);
    }

    // 4. /workspace/upload with real bytes
    {
        const bytes = Buffer.alloc(32);
        for (let i = 0; i < bytes.length; i++) bytes[i] = i;
        const r = await request('POST', '/workspace/upload', {
            headers: {
                'Content-Type': 'image/jpeg',
                'Content-Length': String(bytes.length)
            },
            body: bytes
        });
        assert('POST /workspace/upload with 32 bytes returns 200', r.status === 200, `status=${r.status} body=${r.body.toString('utf-8')}`);
        let json = {};
        try { json = JSON.parse(r.body.toString('utf-8')); } catch (e) {}
        assert('/workspace/upload response includes filename', !!json.filename && json.filename.startsWith('capture_'));
    }

    // 5. /api/images lists at least one capture_ file
    {
        const r = await request('GET', '/api/images');
        const list = JSON.parse(r.body.toString('utf-8'));
        assert('GET /api/images returns array', Array.isArray(list));
        assert('GET /api/images has capture_ files', list.some(f => f.startsWith('capture_')));
    }

    // 6. Path traversal blocked
    {
        const r = await request('GET', '/../package.json');
        assert('GET /../package.json is blocked (not 200)', r.status !== 200, `status=${r.status}`);
    }

    // 7. /tools/invoke propagates gateway status
    {
        const r = await request('POST', '/tools/invoke', {
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': '46'
            },
            body: JSON.stringify({ tool: 'ping', arguments: {}, gatewayHost: 'localhost' })
        });
        // Expect either 200 (if gateway up) or a 5xx proxied from OpenClaw
        const ok = r.status === 200 || (r.status >= 400 && r.status < 600);
        assert('POST /tools/invoke responds (any code)', ok, `status=${r.status}`);
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
}

run().catch(err => {
    console.error('Test harness crashed:', err);
    process.exit(2);
});
