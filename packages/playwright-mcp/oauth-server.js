#!/usr/bin/env node
/**
 * OAuth 2.0 PKCE proxy for playwright-mcp.
 *
 * Spawns playwright-mcp on an internal port, then exposes:
 *   - OAuth discovery + PKCE auth endpoints on the public PORT
 *   - Bearer token gating on all other paths
 *   - Transparent proxy (including SSE streaming) to the internal MCP server
 *   - Session resurrection: if playwright-mcp returns 404 "Session not found",
 *     automatically initializes a new session and replays the request.
 *
 * Required env vars:
 *   MCP_AUTH_TOKEN      — shared secret issued as Bearer token after OAuth
 *   OAUTH_CLIENT_ID     — OAuth client ID (use "claude-pathfinder")
 *   OAUTH_CLIENT_SECRET — OAuth client secret
 *
 * Optional env vars:
 *   PORT                — public port (default: 8080)
 */
'use strict';

const http = require('http');
const { createHash, randomUUID } = require('crypto');
const { spawn } = require('child_process');
const { URLSearchParams } = require('url');

const PORT = parseInt(process.env.PORT || '8080', 10);
const INTERNAL_PORT = 8081;
const AUTH_TOKEN = (process.env.MCP_AUTH_TOKEN || '').trim();
const OAUTH_CLIENT_ID = (process.env.OAUTH_CLIENT_ID || 'claude-pathfinder').trim();
const OAUTH_CLIENT_SECRET = (process.env.OAUTH_CLIENT_SECRET || '').trim();

/** @type {Record<string, {codeChallenge:string, codeChallengeMethod:string, redirectUri:string, expiresAt:number}>} */
const authCodes = {};

/**
 * Maps stale session IDs to resurrected session IDs.
 * When a client sends a stale session, we create a new one and remember the mapping
 * so subsequent requests with the same stale ID get routed to the new session.
 * @type {Map<string, string>}
 */
const sessionMap = new Map();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function parseFormBody(body) {
  const result = {};
  for (const [k, v] of new URLSearchParams(body)) result[k] = v;
  return result;
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

/** Retry until playwright-mcp's HTTP port accepts connections. */
function waitForMcp() {
  return new Promise((resolve) => {
    const check = () => {
      const req = http.request({ hostname: '127.0.0.1', port: INTERNAL_PORT, path: '/' }, () => resolve());
      req.on('error', () => setTimeout(check, 200));
      req.end();
    };
    setTimeout(check, 500);
  });
}

/** Make an HTTP request to the internal playwright-mcp and collect the full response. */
function internalRequest(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1',
      port: INTERNAL_PORT,
      path,
      method,
      headers,
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** Initialize a new MCP session against the internal playwright-mcp. */
async function createSession() {
  const initBody = JSON.stringify({
    jsonrpc: '2.0',
    id: `proxy-init-${Date.now()}`,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'oauth-proxy', version: '1.0.0' },
    },
  });
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'Host': `localhost:${INTERNAL_PORT}`,
    'Content-Length': Buffer.byteLength(initBody),
  };
  const res = await internalRequest('POST', '/mcp', headers, initBody);
  if (res.statusCode !== 200) {
    throw new Error(`Init failed: ${res.statusCode} ${res.body}`);
  }
  const sessionId = res.headers['mcp-session-id'];
  if (!sessionId) {
    throw new Error('Init succeeded but no Mcp-Session-Id in response');
  }

  // Send initialized notification
  const notifBody = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const notifHeaders = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'Host': `localhost:${INTERNAL_PORT}`,
    'Mcp-Session-Id': sessionId,
    'Content-Length': Buffer.byteLength(notifBody),
  };
  await internalRequest('POST', '/mcp', notifHeaders, notifBody);

  console.log(`[SESSION] Created new session: ${sessionId}`);
  return sessionId;
}

/**
 * Forward req → internal playwright-mcp, pipe response back (handles SSE).
 * If the request body was already consumed, pass it as `bufferedBody`.
 */
function proxyRequest(req, res, { bufferedBody, overrideSessionId } = {}) {
  const sessionId = overrideSessionId || req.headers['mcp-session-id'] || null;
  console.log('[PROXY]', req.method, req.url,
    'session=' + (sessionId || 'NONE'),
    'accept=' + (req.headers['accept'] || 'NONE'));

  const headers = { ...req.headers, host: `localhost:${INTERNAL_PORT}` };
  delete headers['authorization'];
  delete headers['origin'];
  if (overrideSessionId) {
    headers['mcp-session-id'] = overrideSessionId;
  }

  const opts = {
    hostname: '127.0.0.1',
    port: INTERNAL_PORT,
    path: req.url,
    method: req.method,
    headers,
  };

  const proxy = http.request(opts, (proxyRes) => {
    if (proxyRes.statusCode >= 400) {
      let body = '';
      proxyRes.on('data', chunk => { body += chunk; });
      proxyRes.on('end', () => {
        console.error(`Upstream ${proxyRes.statusCode} for ${req.method} ${req.url}: ${body.slice(0, 500)}`);
      });
    }
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });
  proxy.on('error', (err) => {
    console.error('Proxy error:', err.message);
    if (!res.headersSent) json(res, 502, { error: 'bad_gateway' });
    else res.destroy();
  });

  if (bufferedBody !== undefined) {
    proxy.write(bufferedBody);
    proxy.end();
  } else {
    req.pipe(proxy, { end: true });
  }
}

/**
 * Attempt to proxy a request; if upstream returns 404 "Session not found",
 * create a new session and replay. Only works for POST (body must be buffered).
 */
async function proxyWithResurrection(req, res, bodyBuffer) {
  const staleSessionId = req.headers['mcp-session-id'] || null;

  // Check if we already have a mapped replacement for this stale session
  if (staleSessionId && sessionMap.has(staleSessionId)) {
    const mapped = sessionMap.get(staleSessionId);
    console.log(`[SESSION] Remapping stale ${staleSessionId.slice(0, 8)}… → ${mapped.slice(0, 8)}…`);
    proxyRequest(req, res, { bufferedBody: bodyBuffer, overrideSessionId: mapped });
    return;
  }

  // First attempt: proxy as-is, but buffer the upstream response to check for 404
  const headers = { ...req.headers, host: `localhost:${INTERNAL_PORT}` };
  delete headers['authorization'];
  delete headers['origin'];

  let probeRes;
  try {
    probeRes = await internalRequest(req.method, req.url, headers, bodyBuffer);
  } catch (err) {
    console.error('Probe error:', err.message);
    if (!res.headersSent) json(res, 502, { error: 'bad_gateway' });
    return;
  }

  // If not a session-not-found error, return the response as-is
  if (probeRes.statusCode !== 404 || !probeRes.body.includes('Session not found')) {
    res.writeHead(probeRes.statusCode, probeRes.headers);
    res.end(probeRes.body);
    return;
  }

  // Session is stale — resurrect
  if (!staleSessionId) {
    // No session ID was sent but we still got 404 — just pass through
    res.writeHead(probeRes.statusCode, probeRes.headers);
    res.end(probeRes.body);
    return;
  }

  console.log(`[SESSION] Stale session ${staleSessionId.slice(0, 8)}… — resurrecting`);
  let newSessionId;
  try {
    newSessionId = await createSession();
  } catch (err) {
    console.error('[SESSION] Resurrection failed:', err.message);
    res.writeHead(probeRes.statusCode, probeRes.headers);
    res.end(probeRes.body);
    return;
  }

  // Remember the mapping for future requests
  sessionMap.set(staleSessionId, newSessionId);

  // Cap map size to prevent unbounded growth
  if (sessionMap.size > 100) {
    const firstKey = sessionMap.keys().next().value;
    sessionMap.delete(firstKey);
  }

  // Replay the original request with the new session
  console.log(`[SESSION] Replaying ${req.method} ${req.url} with new session ${newSessionId.slice(0, 8)}…`);
  proxyRequest(req, res, { bufferedBody: bodyBuffer, overrideSessionId: newSessionId });
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  try {
    // Health check (no auth required)
    if (path === '/health' && req.method === 'GET') {
      json(res, 200, { status: 'ok' });
      return;
    }

    // OAuth Protected Resource Metadata
    if (path === '/.well-known/oauth-protected-resource' && req.method === 'GET') {
      const base = `https://${req.headers.host}`;
      json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base] });
      return;
    }

    // OAuth Authorization Server Metadata
    if (path === '/.well-known/oauth-authorization-server' && req.method === 'GET') {
      const base = `https://${req.headers.host}`;
      json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/oauth/token`,
        grant_types_supported: ['authorization_code', 'client_credentials'],
        code_challenge_methods_supported: ['S256'],
        response_types_supported: ['code'],
      });
      return;
    }

    // Authorization endpoint
    if (path === '/authorize' && req.method === 'GET') {
      const response_type = url.searchParams.get('response_type');
      const client_id = url.searchParams.get('client_id');
      const redirect_uri = url.searchParams.get('redirect_uri');
      const code_challenge = url.searchParams.get('code_challenge');
      const code_challenge_method = url.searchParams.get('code_challenge_method') || 'S256';
      const state = url.searchParams.get('state');

      if (client_id !== OAUTH_CLIENT_ID) { json(res, 401, { error: 'invalid_client' }); return; }
      if (response_type !== 'code') { json(res, 400, { error: 'unsupported_response_type' }); return; }
      if (!code_challenge) { json(res, 400, { error: 'code_challenge_required' }); return; }

      const code = randomUUID();
      authCodes[code] = {
        codeChallenge: code_challenge,
        codeChallengeMethod: code_challenge_method,
        redirectUri: redirect_uri,
        expiresAt: Date.now() + 5 * 60 * 1000,
      };

      const redirectUrl = new URL(redirect_uri);
      redirectUrl.searchParams.set('code', code);
      if (state) redirectUrl.searchParams.set('state', state);
      res.writeHead(302, { Location: redirectUrl.toString() });
      res.end();
      return;
    }

    // Token endpoint
    if (path === '/oauth/token' && req.method === 'POST') {
      if (!OAUTH_CLIENT_ID || !AUTH_TOKEN) { json(res, 500, { error: 'server_misconfigured' }); return; }

      const bodyRaw = await readBody(req);
      const contentType = req.headers['content-type'] || '';
      const body = contentType.includes('application/json') ? JSON.parse(bodyRaw) : parseFormBody(bodyRaw);
      const grant_type = body.grant_type;

      if (grant_type === 'authorization_code') {
        const { code, code_verifier, redirect_uri } = body;
        const stored = authCodes[code];
        if (!stored || stored.expiresAt < Date.now()) { json(res, 400, { error: 'invalid_grant' }); return; }
        const expected = createHash('sha256').update(code_verifier).digest('base64url');
        if (expected !== stored.codeChallenge) { json(res, 400, { error: 'invalid_grant' }); return; }
        if (redirect_uri && redirect_uri !== stored.redirectUri) { json(res, 400, { error: 'invalid_grant' }); return; }
        delete authCodes[code];
        json(res, 200, { access_token: AUTH_TOKEN, token_type: 'Bearer', expires_in: 86400 });
        return;
      }

      // client_credentials grant
      if (!OAUTH_CLIENT_SECRET) { json(res, 500, { error: 'server_misconfigured' }); return; }
      let client_id, client_secret;
      const basicAuth = req.headers['authorization'];
      if (basicAuth && basicAuth.startsWith('Basic ')) {
        const decoded = Buffer.from(basicAuth.slice(6), 'base64').toString();
        const colon = decoded.indexOf(':');
        client_id = decoded.slice(0, colon);
        client_secret = decoded.slice(colon + 1);
      } else {
        client_id = body.client_id;
        client_secret = body.client_secret;
      }
      if (client_id !== OAUTH_CLIENT_ID || client_secret !== OAUTH_CLIENT_SECRET) {
        json(res, 401, { error: 'invalid_client' }); return;
      }
      json(res, 200, { access_token: AUTH_TOKEN, token_type: 'Bearer', expires_in: 86400 });
      return;
    }

    // Bearer token enforcement for all other routes
    if (AUTH_TOKEN) {
      const authHeader = req.headers['authorization'];
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        const host = req.headers.host;
        res.writeHead(401, {
          'WWW-Authenticate': `Bearer resource_metadata="https://${host}/.well-known/oauth-protected-resource"`,
          'Content-Type': 'application/json',
        });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      if (authHeader.slice(7) !== AUTH_TOKEN) {
        res.writeHead(401, { 'WWW-Authenticate': 'Bearer error="invalid_token"', 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }

    // For POST requests with a session ID, use resurrection-aware proxy
    if (req.method === 'POST' && req.headers['mcp-session-id']) {
      const bodyBuffer = await readBody(req);
      await proxyWithResurrection(req, res, bodyBuffer);
      return;
    }

    // For GET requests with a stale session ID, remap if we have a replacement
    if (req.method === 'GET' && req.headers['mcp-session-id']) {
      const staleId = req.headers['mcp-session-id'];
      if (sessionMap.has(staleId)) {
        const mapped = sessionMap.get(staleId);
        console.log(`[SESSION] GET remap ${staleId.slice(0, 8)}… → ${mapped.slice(0, 8)}…`);
        proxyRequest(req, res, { overrideSessionId: mapped });
        return;
      }
    }

    // Default: proxy as-is (handles SSE via pipe)
    proxyRequest(req, res);

  } catch (err) {
    console.error('Server error:', err);
    if (!res.headersSent) json(res, 500, { error: 'internal_server_error' });
  }
});

// ---------------------------------------------------------------------------
// Start playwright-mcp on internal port
// ---------------------------------------------------------------------------

const mcpProcess = spawn('node', [
  'cli.js',
  '--headless', '--browser', 'chromium', '--no-sandbox',
  '--port', String(INTERNAL_PORT), '--host', '127.0.0.1',
], { stdio: 'inherit' });

mcpProcess.on('exit', (code) => {
  console.error(`playwright-mcp exited with code ${code}`);
  process.exit(code ?? 1);
});

process.on('SIGTERM', () => {
  mcpProcess.kill('SIGTERM');
  server.close(() => process.exit(0));
});

// ---------------------------------------------------------------------------
// Start proxy after MCP is ready
// ---------------------------------------------------------------------------

waitForMcp().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`OAuth proxy listening on port ${PORT} → playwright-mcp on port ${INTERNAL_PORT}`);
  });
}).catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
