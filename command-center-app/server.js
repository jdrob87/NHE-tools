// NHE Command Center. Node built-ins only. All secrets come from the environment.
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const COOKIE = 'nhe_cc';
const MAX_AGE_SEC = 90 * 24 * 60 * 60;
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 10 * 60 * 1000;
const BODY_LIMIT = 32 * 1024;
const RESPONSE_LIMIT = 8000;

const PASSCODE = process.env.PASSCODE || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const PUBLIC_DIR = __dirname + '/public';

function failStartup(message) {
  fs.writeSync(2, message + '\n');
  process.exit(1);
}

function loadItems() {
  const raw = process.env.ITEMS_JSON;
  if (!raw || !raw.trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    failStartup('ITEMS_JSON is not valid JSON');
  }
  if (!Array.isArray(parsed)) failStartup('ITEMS_JSON must be a JSON array');
  const seen = new Set();
  return parsed.map(function (item, index) {
    if (!item || typeof item !== 'object') failStartup('ITEMS_JSON item ' + index + ' is not an object');
    if (typeof item.id !== 'string' || item.id.trim() === '' || item.id.length > 80) {
      failStartup('ITEMS_JSON item ' + index + ' needs a string id');
    }
    if (typeof item.title !== 'string' || item.title.trim() === '' || item.title.length > 200) {
      failStartup('ITEMS_JSON item ' + index + ' needs a string title');
    }
    if (item.detail != null && (typeof item.detail !== 'string' || item.detail.length > 2000)) {
      failStartup('ITEMS_JSON item ' + index + ' has a detail that is not a string');
    }
    if (seen.has(item.id)) failStartup('ITEMS_JSON has a duplicate id');
    seen.add(item.id);
    return {
      id: item.id,
      title: item.title,
      detail: item.detail || '',
      lead: optionalText(item.lead, 8),
      meta: optionalText(item.meta, 120),
      status: optionalStatus(item.status),
    };
  });
}

function optionalText(value, max) {
  if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return '';
  return trimmed;
}

function optionalStatus(status) {
  if (!status || typeof status !== 'object') return null;
  const label = optionalText(status.label, 40);
  if (!label) return null;
  const tone = typeof status.tone === 'string' ? status.tone.trim().toLowerCase() : '';
  if (tone === 'warning') return { label: label, tone: 'warning' };
  if (tone === 'done' || tone === 'success') return { label: label, tone: 'done' };
  return { label: label, tone: 'neutral' };
}

function validateConfig() {
  if (!PASSCODE) failStartup('PASSCODE is required');
  if (!SESSION_SECRET || SESSION_SECRET.length < 16) {
    failStartup('SESSION_SECRET is required and must be at least 16 characters');
  }
  const header = process.env.WEBHOOK_AUTH_HEADER || 'Authorization';
  if (!/^[A-Za-z0-9-]{1,64}$/.test(header)) {
    failStartup('WEBHOOK_AUTH_HEADER must be one token of letters, numbers, or hyphens');
  }
  const key = process.env.WEBHOOK_KEY || '';
  if (/[\r\n]/.test(key)) failStartup('WEBHOOK_KEY must be a single line');
  const port = Number(process.env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    failStartup('PORT must be a TCP port number');
  }
}

validateConfig();
const ITEMS = loadItems();
const doneIds = new Set();
const attempts = new Map();

const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8', 'no-store'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8', 'no-store'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8', 'no-store'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8', 'public, max-age=86400'],
  '/icon.svg': ['icon.svg', 'image/svg+xml', 'public, max-age=86400'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png', 'public, max-age=86400'],
  '/apple-touch-icon-precomposed.png': ['apple-touch-icon.png', 'image/png', 'public, max-age=86400'],
  '/icon-192.png': ['icon-192.png', 'image/png', 'public, max-age=86400'],
  '/icon-512.png': ['icon-512.png', 'image/png', 'public, max-age=86400'],
};

const STATIC = {};
Object.keys(FILES).forEach(function (route) {
  const name = FILES[route][0];
  if (STATIC[name]) return;
  try {
    STATIC[name] = fs.readFileSync(PUBLIC_DIR + '/' + name);
  } catch (err) {
    failStartup('Missing file public/' + name);
  }
});

function base64url(value) {
  return Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64urlDecode(value) {
  const pad = value.length % 4 === 0 ? '' : '='.repeat(4 - (value.length % 4));
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function sign(payload) {
  return base64url(crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest());
}

function safeEqualString(a, b) {
  const left = crypto.createHash('sha256').update(String(a), 'utf8').digest();
  const right = crypto.createHash('sha256').update(String(b), 'utf8').digest();
  return crypto.timingSafeEqual(left, right);
}

function issueToken() {
  const payload = base64url(JSON.stringify({ exp: Date.now() + MAX_AGE_SEC * 1000 }));
  return payload + '.' + sign(payload);
}

function verifyToken(token) {
  if (typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot <= 0 || token.lastIndexOf('.') !== dot) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(payload);
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return false;
  try {
    const data = JSON.parse(base64urlDecode(payload).toString('utf8'));
    return !!data && typeof data.exp === 'number' && data.exp > Date.now();
  } catch (err) {
    return false;
  }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  String(header).split(';').forEach(function (part) {
    const index = part.indexOf('=');
    if (index === -1) return;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try {
      out[key] = decodeURIComponent(value);
    } catch (err) {
      out[key] = value;
    }
  });
  return out;
}

function authed(req) {
  return verifyToken(parseCookies(req.headers.cookie)[COOKIE]);
}

function cookieHeader(value, maxAge) {
  const expires = maxAge > 0
    ? new Date(Date.now() + maxAge * 1000).toUTCString()
    : 'Thu, 01 Jan 1970 00:00:00 GMT';
  return [
    COOKIE + '=' + value,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Path=/',
    'Max-Age=' + maxAge,
    'Expires=' + expires,
  ].join('; ');
}

function isPrivateIp(ip) {
  const host = String(ip || '').replace(/^::ffff:/, '');
  return host === '127.0.0.1'
    || host === '::1'
    || host.startsWith('10.')
    || host.startsWith('192.168.')
    || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
}

function clientIp(req) {
  const remote = req.socket.remoteAddress || '';
  if (!isPrivateIp(remote)) return remote || 'unknown';
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    const parts = forwarded.split(',').map(function (part) { return part.trim(); }).filter(Boolean);
    if (parts.length) return parts[parts.length - 1].slice(0, 80);
  }
  return remote || 'unknown';
}

function limited(ip) {
  const rec = attempts.get(ip);
  if (!rec || Date.now() > rec.reset) return false;
  return rec.count >= MAX_ATTEMPTS;
}

function recordFailure(ip) {
  const now = Date.now();
  let rec = attempts.get(ip);
  if (!rec || now > rec.reset) rec = { count: 0, reset: now + WINDOW_MS };
  rec.count += 1;
  attempts.set(ip, rec);
  if (attempts.size > 10000) {
    const cutoff = now;
    attempts.forEach(function (value, key) {
      if (cutoff > value.reset) attempts.delete(key);
    });
  }
}

function securityHeaders(cache) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'Cache-Control': cache || 'no-store',
  };
}

function sendJson(res, status, payload, extra) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
  }, securityHeaders('no-store'), extra || {}));
  res.end(body);
}

function sendFile(res, route) {
  const spec = FILES[route];
  const body = STATIC[spec[0]];
  res.writeHead(200, Object.assign({
    'Content-Type': spec[1],
    'Content-Length': body.length,
  }, securityHeaders(spec[2])));
  res.end(body);
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let size = 0;
    req.on('data', function (chunk) {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        const err = new Error('Request body is too large.');
        err.status = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', function () { resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.length) {
    const err = new Error('Request body must be JSON.');
    err.status = 400;
    throw err;
  }
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch (err) {
    const error = new Error('Request body must be JSON.');
    error.status = 400;
    throw error;
  }
}

function postWebhook(payload) {
  const urlValue = process.env.WEBHOOK_URL || '';
  const key = process.env.WEBHOOK_KEY || '';
  if (!urlValue || !key) {
    const err = new Error('The assistant webhook is not configured. Set WEBHOOK_URL and WEBHOOK_KEY on the server.');
    err.status = 503;
    return Promise.reject(err);
  }
  let target;
  try {
    target = new URL(urlValue);
  } catch (err) {
    const error = new Error('The assistant webhook URL is invalid.');
    error.status = 503;
    return Promise.reject(error);
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    const err = new Error('The assistant webhook URL is invalid.');
    err.status = 503;
    return Promise.reject(err);
  }

  const headerName = process.env.WEBHOOK_AUTH_HEADER || 'Authorization';
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'User-Agent': 'nhe-command-center',
  };
  if (headerName.toLowerCase() === 'authorization') headers.Authorization = 'Bearer ' + key;
  else headers[headerName] = key;

  const lib = target.protocol === 'https:' ? https : http;
  return new Promise(function (resolve, reject) {
    let settled = false;
    function succeed() {
      if (settled) return;
      settled = true;
      resolve();
    }
    function fail(err) {
      if (settled) return;
      settled = true;
      reject(err);
    }
    const req = lib.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      path: target.pathname + target.search,
      method: 'POST',
      headers: headers,
      timeout: 15000,
    }, function (webhookRes) {
      let received = 0;
      webhookRes.on('data', function (chunk) {
        received += chunk.length;
        if (received > 1024 * 1024) webhookRes.destroy();
      });
      webhookRes.on('end', function () {
        if (webhookRes.statusCode >= 200 && webhookRes.statusCode < 300) succeed();
        else {
          const err = new Error('The assistant webhook failed (HTTP ' + webhookRes.statusCode + '). The item was not marked done.');
          err.status = 502;
          fail(err);
        }
      });
    });
    req.on('timeout', function () {
      req.destroy();
      const err = new Error('Could not reach the assistant webhook. The item was not marked done.');
      err.status = 502;
      fail(err);
    });
    req.on('error', function () {
      const err = new Error('Could not reach the assistant webhook. The item was not marked done.');
      err.status = 502;
      fail(err);
    });
    req.write(payload);
    req.end();
  });
}

async function handleLogin(req, res) {
  const ip = clientIp(req);
  const body = await readJson(req);
  if (limited(ip)) {
    sendJson(res, 429, { ok: false, error: 'Too many attempts. Wait a few minutes and try again.' }, { 'Retry-After': '600' });
    return;
  }
  const supplied = body && typeof body.passcode === 'string' ? body.passcode : '';
  if (!safeEqualString(supplied, PASSCODE)) {
    recordFailure(ip);
    sendJson(res, 401, { ok: false, error: 'That passcode is not right.' });
    return;
  }
  attempts.delete(ip);
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(issueToken(), MAX_AGE_SEC) });
}

async function handleSubmit(req, res) {
  if (!authed(req)) {
    sendJson(res, 401, { ok: false, error: 'Sign in first.' });
    return;
  }
  const body = await readJson(req);
  const itemId = body && typeof body.itemId === 'string' ? body.itemId : '';
  const item = ITEMS.find(function (entry) { return entry.id === itemId; });
  if (!item) {
    sendJson(res, 404, { ok: false, error: 'That item is not on the list.' });
    return;
  }
  const hasDone = !!(body && typeof body.done === 'boolean');
  const responseText = body && typeof body.response === 'string' ? body.response.trim() : '';
  if (!responseText && !hasDone) {
    sendJson(res, 400, { ok: false, error: 'Write a response before sending.' });
    return;
  }
  if (responseText.length > RESPONSE_LIMIT) {
    sendJson(res, 400, { ok: false, error: 'That response is too long.' });
    return;
  }
  const done = hasDone && body.done === true;
  const payload = JSON.stringify({
    source: 'command-center-phone',
    itemId: item.id,
    itemTitle: item.title,
    response: responseText,
    done: done,
    sentAt: new Date().toISOString(),
  });
  await postWebhook(payload);
  if (hasDone) {
    if (body.done) doneIds.add(item.id);
    else doneIds.delete(item.id);
  }
  sendJson(res, 200, { ok: true, done: doneIds.has(item.id) });
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const method = req.method || 'GET';

  if (method === 'GET' && path === '/robots.txt') {
    const body = Buffer.from('User-agent: *\nDisallow: /\n');
    res.writeHead(200, Object.assign({
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': body.length,
    }, securityHeaders('no-store')));
    res.end(body);
    return;
  }

  if (method === 'GET' && FILES[path]) {
    sendFile(res, path);
    return;
  }

  if (path === '/api/session' && method === 'GET') {
    if (!authed(req)) {
      sendJson(res, 401, { ok: false, error: 'Sign in first.' });
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (path === '/api/login' && method === 'POST') {
    await handleLogin(req, res);
    return;
  }

  if (path === '/api/logout' && method === 'POST') {
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader('', 0) });
    return;
  }

  if (path === '/api/items' && method === 'GET') {
    if (!authed(req)) {
      sendJson(res, 401, { ok: false, error: 'Sign in first.' });
      return;
    }
    sendJson(res, 200, {
      items: ITEMS.map(function (item) {
        return {
          id: item.id,
          title: item.title,
          detail: item.detail,
          lead: item.lead || null,
          meta: item.meta || null,
          status: item.status,
          done: doneIds.has(item.id),
        };
      }),
    });
    return;
  }

  if (path === '/api/submit' && method === 'POST') {
    await handleSubmit(req, res);
    return;
  }

  sendJson(res, 404, { ok: false, error: 'Not found.' });
}

const server = http.createServer(function (req, res) {
  route(req, res).catch(function (err) {
    if (res.headersSent) return;
    const status = err && err.status ? err.status : 500;
    const message = status === 500 ? 'Something went wrong.' : err.message;
    if (status === 500) console.error('request failed');
    sendJson(res, status, { ok: false, error: message });
  });
});

server.requestTimeout = 20000;

function shutdown() {
  server.close(function () { process.exit(0); });
  setTimeout(function () { process.exit(0); }, 2000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

const port = Number(process.env.PORT);
server.listen(port, '0.0.0.0', function () {
  console.log('NHE Team Command Center listening on ' + port);
});
