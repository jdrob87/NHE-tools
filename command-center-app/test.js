const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const { spawn } = require('child_process');

const PASSCODE = 'test-passcode';
const SESSION_SECRET = 'test-session-secret-not-real';
const WEBHOOK_KEY = 'whk_test_only_not_a_real_key';
const ITEMS = JSON.parse(fs.readFileSync(__dirname + '/items.example.json', 'utf8'));

const failures = [];

function assert(cond, msg) {
  if (!cond) {
    failures.push(msg);
    console.error('FAIL: ' + msg);
    throw new Error(msg);
  }
  console.log('ok: ' + msg);
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function freePort() {
  return new Promise(function (resolve, reject) {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', function () {
      const port = server.address().port;
      server.close(function (err) {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

function request(port, method, path, options) {
  const opts = options || {};
  return new Promise(function (resolve, reject) {
    const data = opts.body == null ? null : Buffer.from(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
    const headers = Object.assign({}, opts.headers || {});
    if (data && !headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = data.length;
    }
    if (opts.cookie) headers.Cookie = opts.cookie;
    const req = http.request({
      hostname: '127.0.0.1',
      port: port,
      method: method,
      path: path,
      headers: headers,
    }, function (res) {
      const chunks = [];
      res.on('data', function (chunk) { chunks.push(chunk); });
      res.on('end', function () {
        const raw = Buffer.concat(chunks);
        const text = raw.toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (err) { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, raw: raw, text: text, json: json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function sessionCookie(res) {
  const raw = res.headers['set-cookie'];
  if (!raw) return '';
  const line = Array.isArray(raw) ? raw[0] : raw;
  return line.split(';')[0];
}

function base64url(value) {
  return Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function signedToken(exp) {
  const payload = base64url(JSON.stringify({ exp: exp }));
  const sig = base64url(crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest());
  return payload + '.' + sig;
}

function startWebhook() {
  const hits = [];
  let mode = 'ok';
  const server = http.createServer(function (req, res) {
    const chunks = [];
    req.on('data', function (chunk) { chunks.push(chunk); });
    req.on('end', function () {
      const body = Buffer.concat(chunks).toString('utf8');
      let json = null;
      try { json = JSON.parse(body); } catch (err) { json = null; }
      hits.push({ method: req.method, url: req.url, headers: req.headers, body: body, json: json });
      if (mode === 'fail') {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('fail');
        return;
      }
      res.writeHead(204);
      res.end();
    });
  });
  return new Promise(function (resolve) {
    server.listen(0, '127.0.0.1', function () {
      resolve({
        server: server,
        hits: hits,
        port: server.address().port,
        setMode: function (next) { mode = next; },
      });
    });
  });
}

function startApp(env) {
  return new Promise(function (resolve, reject) {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: __dirname,
      env: env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error('server start timeout\n' + stdout + '\n' + stderr));
    }, 5000);
    child.stdout.on('data', function (buf) {
      stdout += buf;
      if (!settled && stdout.includes('listening')) {
        settled = true;
        clearTimeout(timer);
        resolve({ child: child, stdout: function () { return stdout; }, stderr: function () { return stderr; } });
      }
    });
    child.stderr.on('data', function (buf) { stderr += buf; });
    child.on('exit', function (code) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('server exited ' + code + '\n' + stderr + stdout));
    });
  });
}

function stop(child) {
  return new Promise(function (resolve) {
    if (!child || child.exitCode !== null) return resolve();
    const timer = setTimeout(function () {
      child.kill('SIGKILL');
      resolve();
    }, 1500);
    child.once('exit', function () {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

function runNode(env) {
  return new Promise(function (resolve) {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: __dirname,
      env: env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', function (buf) { stderr += buf; });
    child.on('exit', function (code) { resolve({ code: code, stderr: stderr }); });
  });
}

function baseEnv(extra) {
  return Object.assign({
    PATH: process.env.PATH || '',
    PORT: '1',
    PASSCODE: PASSCODE,
    SESSION_SECRET: SESSION_SECRET,
    ITEMS_JSON: JSON.stringify(ITEMS),
  }, extra || {});
}

async function testConfigFailures() {
  const missingPass = await runNode(baseEnv({ PASSCODE: '' }));
  assert(missingPass.code === 1, 'startup fails without PASSCODE');
  assert(missingPass.stderr.includes('PASSCODE is required'), 'startup names the missing PASSCODE');
  assert(!missingPass.stderr.includes(SESSION_SECRET), 'startup error does not print the session secret');

  const shortSecret = await runNode(baseEnv({ SESSION_SECRET: 'too-short' }));
  assert(shortSecret.code === 1, 'startup fails when SESSION_SECRET is shorter than 16 characters');

  const badItems = await runNode(baseEnv({ ITEMS_JSON: '{not json' }));
  assert(badItems.code === 1 && badItems.stderr.includes('ITEMS_JSON'), 'startup fails on invalid ITEMS_JSON');

  const sampleDash = JSON.stringify({ waiting: [{ id: 'fake-9', title: 'Example only' }] });
  const itemsStillChecked = await runNode(baseEnv({
    ITEMS_JSON: '{not json',
    DASHBOARD_JSON: sampleDash,
  }));
  assert(itemsStillChecked.code === 1 && itemsStillChecked.stderr.includes('ITEMS_JSON'), 'invalid ITEMS_JSON still fails when DASHBOARD_JSON is set');

  const badDashboards = [
    ['{', 'DASHBOARD_JSON is not valid JSON'],
    ['[]', 'DASHBOARD_JSON must be a JSON object'],
    ['null', 'DASHBOARD_JSON must be a JSON object'],
    [JSON.stringify({ updatedAt: 'yesterday' }), 'DASHBOARD_JSON.updatedAt must be an ISO-8601 time'],
    [JSON.stringify({ events: [{ date: '2026-02-31', title: 'Example', lane: 'work' }] }), 'YYYY-MM-DD'],
    [JSON.stringify({ events: [{ date: '2026-11-19', title: 'Example', lane: 'home' }] }), 'lane'],
    [JSON.stringify({ bots: [{ bot: 'Demo Bot', focus: 'Pretend', state: 'paused' }] }), 'state'],
    [JSON.stringify({ links: [{ title: 'Example link', href: 'javascript:alert(1)' }] }), 'http or https'],
    [JSON.stringify({ waiting: [{ id: 'fake-1' }] }), 'needs a string title'],
    [JSON.stringify({ waiting: [{ id: 'fake-1', title: 'One' }, { id: 'fake-1', title: 'Two' }] }), 'duplicate id'],
    [JSON.stringify({ inProgress: {} }), 'DASHBOARD_JSON.inProgress must be an array'],
  ];
  for (let i = 0; i < badDashboards.length; i++) {
    const result = await runNode(baseEnv({ DASHBOARD_JSON: badDashboards[i][0] }));
    assert(result.code === 1 && result.stderr.includes(badDashboards[i][1]), 'startup fails for bad DASHBOARD_JSON case ' + i);
    assert(result.stderr.includes('DASHBOARD_JSON'), 'startup names DASHBOARD_JSON for case ' + i);
    assert(!result.stderr.includes(SESSION_SECRET), 'dashboard startup error does not print the session secret');
    assert(!result.stderr.includes('alert(1)'), 'dashboard startup error does not echo the rejected href');
  }
}

async function login(port, passcode) {
  return request(port, 'POST', '/api/login', { body: { passcode: passcode } });
}

async function testAuthAndList(port, hook) {
  const page = await request(port, 'GET', '/');
  assert(page.status === 200, 'login page returns 200');
  assert(page.text.includes('NHE Team Command Center'), 'page title is NHE Team Command Center');
  assert(page.text.includes('apple-mobile-web-app-capable'), 'page opts into the iOS home-screen app');
  assert(page.text.includes('/manifest.webmanifest'), 'page links the web app manifest');
  assert(page.text.includes('/apple-touch-icon.png'), 'page links the apple touch icon');
  assert(!page.text.includes('Call the example seller'), 'login HTML does not include item titles');
  assert(!page.text.includes(WEBHOOK_KEY), 'login HTML does not include the webhook key');

  const manifest = await request(port, 'GET', '/manifest.webmanifest');
  assert(manifest.status === 200, 'manifest returns 200');
  assert(manifest.json.name === 'NHE Team Command Center', 'manifest name is NHE Team Command Center');
  assert(manifest.json.display === 'standalone', 'manifest display is standalone');

  const svg = await request(port, 'GET', '/icon.svg');
  assert(svg.status === 200 && svg.text.includes('>NHE<'), 'SVG icon contains NHE');

  const icon = await request(port, 'GET', '/apple-touch-icon.png');
  assert(icon.status === 200 && icon.raw.slice(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'apple touch icon is a PNG');
  assert(icon.raw.readUInt32BE(16) === 180 && icon.raw.readUInt32BE(20) === 180, 'apple touch icon is 180x180');

  const unauthItems = await request(port, 'GET', '/api/items');
  assert(unauthItems.status === 401, 'items reject a missing session');
  assert(!unauthItems.text.includes('Call the example seller'), 'rejected items response hides titles');

  const unauthSubmit = await request(port, 'POST', '/api/submit', {
    body: { itemId: 'fake-1', response: 'should not send', done: true },
  });
  assert(unauthSubmit.status === 401, 'submit rejects a missing session');
  assert(hook.hits.length === 0, 'unauthenticated submit does not call the webhook');

  const wrong = await login(port, 'nope');
  assert(wrong.status === 401 && wrong.json.error.includes('not right'), 'wrong passcode is rejected');
  assert(!wrong.headers['set-cookie'], 'wrong passcode does not set a cookie');

  const differentLength = await login(port, 'x');
  assert(differentLength.status === 401, 'a different-length passcode is rejected');

  const good = await login(port, PASSCODE);
  assert(good.status === 200 && good.json.ok === true, 'right passcode signs in');
  const setCookie = Array.isArray(good.headers['set-cookie']) ? good.headers['set-cookie'].join('; ') : good.headers['set-cookie'];
  assert(/HttpOnly/i.test(setCookie), 'session cookie is HttpOnly');
  assert(/Secure/i.test(setCookie), 'session cookie is Secure');
  assert(/SameSite=Lax/i.test(setCookie), 'session cookie is SameSite=Lax');
  assert(/Max-Age=7776000/.test(setCookie), 'session cookie lasts 90 days');
  assert(good.text === '{"ok":true}', 'login body does not echo the cookie');

  const cookie = sessionCookie(good);
  const items = await request(port, 'GET', '/api/items', { cookie: cookie });
  assert(items.status === 200, 'signed-in list returns 200');
  assert(items.json.items.length === ITEMS.length, 'list returns the sample items');
  assert(items.json.items[0].title === 'Call the example seller', 'list renders the first title');
  assert(items.json.items[0].detail.indexOf('123 Sample Street') !== -1, 'list renders the first detail');
  assert(items.json.items[0].lead === '1', 'optional lead is returned');
  assert(items.json.items[0].meta === 'Since Nov 16', 'optional meta is returned');
  assert(items.json.items[0].status.label === 'Time-sensitive' && items.json.items[0].status.tone === 'warning', 'optional status is returned');
  assert(items.json.items[2].lead === null, 'a missing lead falls back to null');
  assert(items.json.items.every(function (item) { return item.done === false; }), 'nothing starts done');
  assert(!items.text.includes(WEBHOOK_KEY), 'items JSON does not include the webhook key');

  const forged = await request(port, 'GET', '/api/items', { cookie: 'nhe_cc=forged.token' });
  assert(forged.status === 401, 'a forged cookie is rejected');

  const expired = signedToken(Date.now() - 1000);
  const old = await request(port, 'GET', '/api/items', { cookie: 'nhe_cc=' + expired });
  assert(old.status === 401, 'an expired cookie is rejected');

  const unauthDash = await request(port, 'GET', '/api/dashboard');
  assert(unauthDash.status === 401, 'dashboard rejects a missing session');
  assert(!unauthDash.text.includes('family') && !unauthDash.json.events, 'rejected dashboard hides calendar content');

  const dash = await request(port, 'GET', '/api/dashboard', { cookie: cookie });
  assert(dash.status === 200, 'signed-in dashboard returns 200 without DASHBOARD_JSON');
  assert(dash.json.events.length === 0 && dash.json.bots.length === 0, 'missing DASHBOARD_JSON yields empty sections');
  assert(dash.json.counts.waiting === ITEMS.length, 'waiting count follows ITEMS_JSON when dashboard waiting is absent');
  assert(dash.json.counts.inProgress === 0 && dash.json.counts.deals === 0 && dash.json.counts.botsWaiting === 0, 'other counts are zero without DASHBOARD_JSON');
  assert(!Object.prototype.hasOwnProperty.call(dash.json, 'waiting'), 'dashboard payload leaves waiting items on /api/items');
  assert(Object.keys(items.json).length === 1, 'items payload is only the list');

  const loggedOut = await request(port, 'POST', '/api/logout', { cookie: cookie });
  assert(loggedOut.status === 200, 'logout returns 200');
  const after = await request(port, 'GET', '/api/items', { cookie: sessionCookie(loggedOut) || cookie });
  assert(after.status === 401, 'logout ends the session');

  return cookie;
}

async function freshCookie(port) {
  const good = await login(port, PASSCODE);
  assert(good.status === 200, 'can sign in again');
  return sessionCookie(good);
}

async function testWebhook(port, hook, cookie) {
  const before = hook.hits.length;
  const sent = await request(port, 'POST', '/api/submit', {
    cookie: cookie,
    body: {
      itemId: 'fake-1',
      itemTitle: 'HACKED TITLE',
      response: '  please call them back  ',
      done: false,
      source: 'evil',
      sentAt: '1999-01-01T00:00:00.000Z',
    },
  });
  assert(sent.status === 200 && sent.json.done === false, 'send succeeds without marking done');
  assert(hook.hits.length === before + 1, 'send hits the webhook once');
  const hit = hook.hits[hook.hits.length - 1];
  assert(hit.method === 'POST', 'webhook method is POST');
  assert(hit.headers['content-type'] === 'application/json', 'webhook content type is JSON');
  assert(hit.headers.authorization === 'Bearer ' + WEBHOOK_KEY, 'default auth header is Bearer');
  assert(hit.json.source === 'command-center-phone', 'webhook source is command-center-phone');
  assert(hit.json.itemId === 'fake-1', 'webhook item id comes from the list');
  assert(hit.json.itemTitle === 'Call the example seller', 'webhook title comes from the server');
  assert(hit.json.response === 'please call them back', 'webhook response is trimmed');
  assert(hit.json.done === false, 'webhook done flag is false');
  assert(Math.abs(Date.now() - Date.parse(hit.json.sentAt)) < 15000, 'webhook sentAt is a current ISO time');

  const stillOpen = await request(port, 'GET', '/api/items', { cookie: cookie });
  assert(stillOpen.json.items.find(function (item) { return item.id === 'fake-1'; }).done === false, 'send leaves the item open');

  hook.setMode('fail');
  const failed = await request(port, 'POST', '/api/submit', {
    cookie: cookie,
    body: { itemId: 'fake-1', response: 'this should not complete', done: true },
  });
  hook.setMode('ok');
  assert(failed.status === 502 && /not marked done/.test(failed.json.error), 'webhook failure is returned to the page');
  assert(!failed.text.includes(WEBHOOK_KEY) && !/https?:\/\//.test(failed.json.error), 'webhook error hides the URL and key');
  const notDone = await request(port, 'GET', '/api/items', { cookie: cookie });
  assert(notDone.json.items.find(function (item) { return item.id === 'fake-1'; }).done === false, 'a failed webhook does not mark done');

  const done = await request(port, 'POST', '/api/submit', {
    cookie: cookie,
    body: { itemId: 'fake-1', response: 'Left a fictional voicemail.', done: true },
  });
  assert(done.status === 200 && done.json.done === true, 'send + done succeeds');
  const marked = await request(port, 'GET', '/api/items', { cookie: cookie });
  assert(marked.json.items.find(function (item) { return item.id === 'fake-1'; }).done === true, 'done id is tracked in memory');
  assert(marked.json.items.find(function (item) { return item.id === 'fake-2'; }).done === false, 'the other item stays open');

  const hitsBeforeEmpty = hook.hits.length;
  const empty = await request(port, 'POST', '/api/submit', {
    cookie: cookie,
    body: { itemId: 'fake-2', response: '   ' },
  });
  assert(empty.status === 400, 'a blank response without done is rejected');
  assert(hook.hits.length === hitsBeforeEmpty, 'a blank response does not call the webhook');

  const toggled = await request(port, 'POST', '/api/submit', {
    cookie: cookie,
    body: { itemId: 'fake-2', response: '', done: true },
  });
  assert(toggled.status === 200 && toggled.json.done === true, 'an empty response is accepted when done is true');
  const toggleHit = hook.hits[hook.hits.length - 1];
  assert(toggleHit.json.response === '' && toggleHit.json.done === true, 'the done switch posts an empty response');
  const markedOff = await request(port, 'GET', '/api/items', { cookie: cookie });
  assert(markedOff.json.items.find(function (item) { return item.id === 'fake-2'; }).done === true, 'the done switch updates memory');

  const untoggled = await request(port, 'POST', '/api/submit', {
    cookie: cookie,
    body: { itemId: 'fake-2', done: false },
  });
  assert(untoggled.status === 200 && untoggled.json.done === false, 'an empty response is accepted when done is false');
  const offHit = hook.hits[hook.hits.length - 1];
  assert(offHit.json.response === '' && offHit.json.done === false, 'turning done off posts done false');
  const reopened = await request(port, 'GET', '/api/items', { cookie: cookie });
  assert(reopened.json.items.find(function (item) { return item.id === 'fake-2'; }).done === false, 'turning the switch off clears memory');

  const unknown = await request(port, 'POST', '/api/submit', {
    cookie: cookie,
    body: { itemId: 'missing', response: 'hello', done: false },
  });
  assert(unknown.status === 404, 'an unknown item is rejected');
}

async function testRateLimit(port) {
  for (let i = 0; i < 5; i++) {
    const res = await login(port, 'wrong-' + i);
    assert(res.status === 401, 'failed attempt ' + (i + 1) + ' is still a normal rejection');
  }
  const locked = await login(port, PASSCODE);
  assert(locked.status === 429, 'further attempts are rate limited');
  assert(/Too many attempts/.test(locked.json.error), 'rate limit error is explicit');
  assert(!locked.headers['set-cookie'], 'a locked correct passcode does not sign in');
}

async function testCustomHeader() {
  const hook = await startWebhook();
  const port = await freePort();
  const app = await startApp(baseEnv({
    PORT: String(port),
    WEBHOOK_URL: 'http://127.0.0.1:' + hook.port + '/hook',
    WEBHOOK_KEY: WEBHOOK_KEY,
    WEBHOOK_AUTH_HEADER: 'X-NHE-Key',
  }));
  try {
    const cookie = sessionCookie(await login(port, PASSCODE));
    const res = await request(port, 'POST', '/api/submit', {
      cookie: cookie,
      body: { itemId: 'fake-2', response: 'custom header check', done: false },
    });
    assert(res.status === 200, 'custom auth header send succeeds');
    const hit = hook.hits[hook.hits.length - 1];
    assert(hit.headers['x-nhe-key'] === WEBHOOK_KEY, 'custom header carries the raw key');
    assert(!hit.headers.authorization, 'custom header does not also send Authorization');
  } finally {
    await stop(app.child);
    hook.server.close();
  }
}

async function testMissingWebhook() {
  const port = await freePort();
  const app = await startApp(baseEnv({ PORT: String(port) }));
  try {
    const cookie = sessionCookie(await login(port, PASSCODE));
    const res = await request(port, 'POST', '/api/submit', {
      cookie: cookie,
      body: { itemId: 'fake-1', response: 'nobody home', done: true },
    });
    assert(res.status === 503, 'missing webhook returns 503');
    assert(/not configured/.test(res.json.error), 'missing webhook error is clear');
    const items = await request(port, 'GET', '/api/items', { cookie: cookie });
    assert(items.json.items.every(function (item) { return item.done === false; }), 'unconfigured webhook does not mark done');
  } finally {
    await stop(app.child);
  }
}

function chromePath() {
  const candidates = ['/usr/local/bin/google-chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'];
  return candidates.find(function (path) { return fs.existsSync(path); }) || '';
}

function waitForLine(stream, pattern, timeout) {
  return new Promise(function (resolve, reject) {
    let text = '';
    const timer = setTimeout(function () {
      reject(new Error('timed out waiting for ' + pattern + '\n' + text));
    }, timeout || 8000);
    function onData(buf) {
      text += buf;
      const match = text.match(pattern);
      if (match) {
        clearTimeout(timer);
        stream.off('data', onData);
        resolve(match);
      }
    }
    stream.on('data', onData);
  });
}

async function startChrome() {
  const bin = chromePath();
  assert(bin, 'google-chrome is installed');
  const dir = fs.mkdtempSync(os.tmpdir() + '/nhe-cc-chrome-');
  const chrome = spawn(bin, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=390,844',
    '--user-data-dir=' + dir,
    '--remote-debugging-port=0',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const match = await waitForLine(chrome.stderr, /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
  const version = await fetch('http://127.0.0.1:' + match[1] + '/json/list').then(function (res) { return res.json(); });
  const page = version.find(function (target) { return target.type === 'page'; });
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(function (resolve, reject) {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  let nextId = 0;
  const pending = new Map();
  ws.addEventListener('message', function (event) {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const job = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) job.reject(new Error(JSON.stringify(message.error)));
      else job.resolve(message.result);
    }
  });
  function send(method, params) {
    const id = ++nextId;
    return new Promise(function (resolve, reject) {
      pending.set(id, { resolve: resolve, reject: reject });
      ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
    });
  }
  async function bodyText() {
    const result = await send('Runtime.evaluate', {
      expression: 'document.body ? document.body.innerText : ""',
      returnByValue: true,
    });
    return (result.result && result.result.value) || '';
  }
  async function evalJson(expression) {
    const result = await send('Runtime.evaluate', { expression: expression, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function waitForText(snippet) {
    const start = Date.now();
    let latest = '';
    while (Date.now() - start < 5000) {
      latest = await bodyText();
      if (latest.includes(snippet)) return latest;
      await sleep(100);
    }
    throw new Error('timed out waiting for ' + JSON.stringify(snippet) + '\n' + latest);
  }
  return {
    chrome: chrome,
    dir: dir,
    send: send,
    bodyText: bodyText,
    evalJson: evalJson,
    waitForText: waitForText,
    async close() {
      ws.close();
      chrome.kill('SIGKILL');
      await sleep(100);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function waitForReady(ui) {
  const start = Date.now();
  while (Date.now() - start < 5000) {
    const ready = await ui.evalJson('!!(document.getElementById("login-form") && document.getElementById("login-form").dataset.bound === "yes" && window.NheView)');
    if (ready) return;
    await sleep(40);
  }
  throw new Error('login form was not bound');
}

async function testUi(port, hook) {
  const ui = await startChrome();
  const shots = {};
  try {
    await ui.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await ui.send('Page.enable');
    await ui.send('Page.navigate', { url: 'http://127.0.0.1:' + port + '/' });
    const loginText = await ui.waitForText('Unlock');
    await waitForReady(ui);
    assert(loginText.includes('NHE Team Command Center'), 'browser shows the login title');
    assert(!loginText.includes('Call the example seller'), 'browser login does not list items');
    shots.login = await ui.send('Page.captureScreenshot', { format: 'png' });

    await ui.evalJson("document.getElementById('passcode').value = 'wrong-pass'; document.getElementById('login-form').requestSubmit(); true");
    const wrongText = await ui.waitForText('not right');
    assert(wrongText.includes('That passcode is not right.'), 'browser shows the wrong-passcode error');

    await ui.evalJson("document.getElementById('passcode').value = " + JSON.stringify(PASSCODE) + "; document.getElementById('login-form').requestSubmit(); true");
    const listText = await ui.waitForText('3 items waiting on you');
    assert(listText.includes('Call the example seller'), 'browser renders the first item');
    assert(listText.includes('Review the demo offer'), 'browser renders every open item');
    assert(listText.includes('Waiting on you'), 'browser shows the Waiting on you section');
    assert(listText.includes('Time-sensitive'), 'browser shows a status pill');
    assert(listText.includes('Since Nov 16'), 'browser shows the meta line');
    assert(listText.includes('Respond'), 'browser shows Respond');
    const badges = await ui.evalJson([
      '(function () {',
      '  function badge(id) {',
      '    const row = document.querySelector(\'#waiting-list [data-id="\' + id + \'"] .badge\');',
      '    return row ? row.textContent : "";',
      '  }',
      '  return { first: badge("fake-1"), third: badge("fake-3") };',
      '})()',
    ].join('\n'));
    assert(badges.first === '1' && badges.third === '3', 'missing lead falls back to a number');
    shots.list = await ui.send('Page.captureScreenshot', { format: 'png' });

    await ui.evalJson('document.querySelector(\'#waiting-list [data-id="fake-1"] .respond\').click()');
    await ui.waitForText('Also mark done');
    const micState = await ui.evalJson([
      '(function () {',
      '  return {',
      '    micHidden: document.getElementById("mic").hidden,',
      '    hintHidden: document.getElementById("mic-hint").hidden,',
      '    hadApi: !!(window.SpeechRecognition || window.webkitSpeechRecognition)',
      '  };',
      '})()',
    ].join('\n'));
    if (!micState.hadApi) {
      assert(micState.micHidden === true && micState.hintHidden === false, 'mic is hidden when speech recognition is missing');
    }
    await ui.evalJson('document.getElementById("sheet-backdrop").click()');
    await ui.evalJson([
      '(function () {',
      '  function Mock() {}',
      '  Mock.prototype.start = function () {',
      '    const self = this;',
      '    setTimeout(function () {',
      '      if (!self.onresult) return;',
      '      self.onresult({',
      '        resultIndex: 0,',
      '        results: [{ 0: { transcript: "Left a fictional voicemail" }, isFinal: false, length: 1 }]',
      '      });',
      '    }, 30);',
      '  };',
      '  Mock.prototype.stop = function () { if (this.onend) this.onend(); };',
      '  window.SpeechRecognition = Mock;',
      '  window.webkitSpeechRecognition = Mock;',
      '  return true;',
      '})()',
    ].join('\n'));
    await ui.evalJson('document.querySelector(\'#waiting-list [data-id="fake-1"] .respond\').click()');
    await ui.waitForText('Also mark done');
    const micShown = await ui.evalJson('document.getElementById("mic").hidden === false && document.getElementById("mic-hint").hidden === true');
    assert(micShown, 'mic is available when speech recognition exists');
    await ui.evalJson('document.getElementById("mic").click()');
    let box = '';
    const dictationStart = Date.now();
    while (Date.now() - dictationStart < 2000) {
      box = await ui.evalJson('document.getElementById("sheet-text").value');
      if (box.indexOf('Left a fictional voicemail') !== -1) break;
      await sleep(40);
    }
    assert(box.indexOf('Left a fictional voicemail') !== -1, 'interim dictation fills the text box');
    const dictated = await ui.bodyText();
    assert(dictated.includes('Listening') && dictated.includes('Stop'), 'recording shows a red listening state and Stop');
    shots.sheet = await ui.send('Page.captureScreenshot', { format: 'png' });
    await ui.evalJson('document.getElementById("also-done").checked = false; document.getElementById("mic").click(); true');

    const before = hook.hits.length;
    await ui.evalJson('document.getElementById("sheet-send").click()');
    const sentText = await ui.waitForText('Sent to Tony');
    assert(sentText.includes('Call the example seller'), 'a reply keeps the item in Waiting on you');
    assert(hook.hits.length === before + 1, 'browser send reaches the webhook');
    const hit = hook.hits[hook.hits.length - 1];
    assert(hit.json.itemId === 'fake-1' && hit.json.done === false, 'browser send posts the open item');
    assert(hit.json.response === 'Left a fictional voicemail', 'browser send posts the dictated response');
    assert(hit.headers.authorization === 'Bearer ' + WEBHOOK_KEY, 'browser send uses the bearer header');

    await ui.evalJson('document.querySelector(\'#waiting-list [data-id="fake-2"] input[type="checkbox"]\').click()');
    await ui.waitForText('Marked done.');
    const placed = await ui.evalJson([
      '(function () {',
      '  const doneRow = document.querySelector(\'#done-list [data-id="fake-2"]\');',
      '  return {',
      '    open: !!document.querySelector(\'#waiting-list [data-id="fake-2"]\'),',
      '    done: !!doneRow,',
      '    check: doneRow ? doneRow.querySelector(".badge").textContent : "",',
      '    strike: doneRow ? getComputedStyle(doneRow.querySelector(".title")).textDecorationLine : "",',
      '    heading: document.getElementById("done-heading").textContent',
      '  };',
      '})()',
    ].join('\n'));
    assert(placed.open === false && placed.done === true, 'the Done switch moves the row into Done');
    assert(placed.heading === 'Done', 'done section heading is Done');
    assert(placed.check === '\u2713', 'done rows use a check mark');
    assert(placed.strike === 'none', 'done titles are not struck through');
    const toggleHit = hook.hits[hook.hits.length - 1];
    assert(toggleHit.json.itemId === 'fake-2' && toggleHit.json.done === true && toggleHit.json.response === '', 'the switch posts done with an empty response');
    await ui.evalJson('document.getElementById("done-section").scrollIntoView({ block: "start" })');
    await sleep(100);
    shots.done = await ui.send('Page.captureScreenshot', { format: 'png' });

    const stored = await ui.evalJson('localStorage.getItem("nhe-command-center-done")');
    assert(JSON.parse(stored).indexOf('fake-2') !== -1, 'done id is stored in localStorage');
    return { ui: ui, shots: shots };
  } catch (err) {
    try {
      const shot = await ui.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync('/tmp/cc-ui-failure.png', Buffer.from(shot.data, 'base64'));
    } catch (shotErr) { /* ignore */ }
    await ui.close();
    throw err;
  }
}

async function testLocalStorageAfterRestart(ui, port) {
  await ui.send('Page.reload', { ignoreCache: true });
  await ui.waitForText('Call the example seller');
  const afterReload = await ui.evalJson([
    '(function () {',
    '  return {',
    '    open1: !!document.querySelector(\'#waiting-list [data-id="fake-1"]\'),',
    '    open2: !!document.querySelector(\'#waiting-list [data-id="fake-2"]\'),',
    '    done2: !!document.querySelector(\'#done-list [data-id="fake-2"]\')',
    '  };',
    '})()',
  ].join('\n'));
  assert(afterReload.open1 === true, 'server restart puts the untouched item back in the open list');
  assert(afterReload.open2 === false && afterReload.done2 === true, 'localStorage keeps the finished item hidden after restart');

  const cookie = await freshCookie(port);
  const items = await request(port, 'GET', '/api/items', { cookie: cookie });
  const second = items.json.items.find(function (item) { return item.id === 'fake-2'; });
  assert(second.done === false, 'server memory forgot the done id, so the phone hid it locally');
}

function writeShots(shots) {
  const dir = '/tmp/cc-shots';
  fs.mkdirSync(dir, { recursive: true });
  Object.keys(shots).forEach(function (name) {
    fs.writeFileSync(dir + '/' + name + '.png', Buffer.from(shots[name].data, 'base64'));
  });
  console.log('screenshots in ' + dir);
}

function sampleDashboard() {
  return JSON.parse(fs.readFileSync(__dirname + '/dashboard.example.json', 'utf8'));
}

async function testViewModel() {
  const view = require('./public/dashboard-view.js');
  const sample = sampleDashboard();
  const html = fs.readFileSync(__dirname + '/public/index.html', 'utf8');
  const exampleRaw = fs.readFileSync(__dirname + '/dashboard.example.json', 'utf8');
  assert(!html.includes('Example family event'), 'login HTML does not include the sample family event');
  assert(!html.includes('123 Sample Street'), 'login HTML does not include the sample deal');
  assert(!html.includes('Demo Bot'), 'login HTML does not include the sample bot');
  assert(exampleRaw.indexOf('@') === -1, 'sample dashboard has no email addresses');
  assert(!/whk_|sk-|BEGIN /.test(exampleRaw), 'sample dashboard has no secret-shaped strings');

  assert(view.inWindow('2026-11-18', '2026-11-18') === true, 'the window includes calendar today');
  assert(view.inWindow('2026-12-01', '2026-11-18') === true, 'the window includes the 14th day');
  assert(view.inWindow('2026-12-02', '2026-11-18') === false, 'the window stops after 14 days');
  assert(view.inWindow('2026-11-17', '2026-11-18') === false, 'the window skips earlier days');

  const all = view.filterEvents(sample.events, sample.calendarToday, 'all');
  const work = view.filterEvents(sample.events, sample.calendarToday, 'work');
  const family = view.filterEvents(sample.events, sample.calendarToday, 'family');
  assert(all.map(function (event) { return event.title; }).join('|') === 'Example work call|Example family event|Another work note', 'all events in the window stay in date order');
  assert(work.length === 2 && work.every(function (event) { return event.lane === 'work'; }), 'work filter keeps work events');
  assert(family.length === 1 && family[0].title === 'Example family event', 'family filter keeps the family event');

  const outside = sample.events.concat([{ date: '2026-11-01', title: 'Early example', lane: 'work' }]);
  const listed = view.filterEvents(outside, sample.calendarToday, 'all');
  assert(listed.every(function (event) { return event.date !== '2026-11-01'; }), 'an event before the window stays off the list');
  const month = view.buildMonth('2026-11', '2026-11-18', outside);
  assert(month.label === 'November 2026', 'month label is November 2026');
  assert(month.cells[0].day === 1 && month.cells[0].date === '2026-11-01', 'November 2026 starts on Sunday');
  const early = month.cells.find(function (cell) { return cell && cell.date === '2026-11-01'; });
  const today = month.cells.find(function (cell) { return cell && cell.date === '2026-11-18'; });
  const familyDay = month.cells.find(function (cell) { return cell && cell.date === '2026-11-20'; });
  assert(early.hasEvent === true, 'a day outside the list still marks the month grid');
  assert(today.isToday === true, 'calendar today is highlighted');
  assert(familyDay.hasEvent === true, 'a family day is marked on the all-events grid');
  const workMonth = view.buildMonth('2026-11', '2026-11-18', view.eventsForLane(sample.events, 'work'));
  const workFamilyDay = workMonth.cells.find(function (cell) { return cell && cell.date === '2026-11-20'; });
  assert(workFamilyDay.hasEvent === false, 'the work filter removes the family dot');

  const months = view.monthsForWindow('2026-11', '2026-11-18');
  assert(months.join(',') === '2026-11,2026-12', 'a window that crosses a month shows both months');

  const bots = view.filterBots(sample.bots, 'you');
  const active = view.filterBots(sample.bots, 'active');
  const everyBot = view.filterBots(sample.bots, 'all');
  assert(bots.length === 1 && bots[0].bot === 'Sample Bot', 'waiting-on-you keeps state you');
  assert(active.length === 1 && active[0].bot === 'Demo Bot', 'active keeps state active');
  assert(everyBot.length === 3, 'all bots includes the one on hold');
  assert(view.botPill('you').label === 'Waiting on you' && view.botPill('you').tone === 'warning', 'you pill says Waiting on you');
  assert(view.botPill('active').label === 'Active' && view.botPill('active').tone === 'done', 'active pill says Active');
  assert(view.botPill('hold').label === 'On hold' && view.botPill('hold').tone === 'neutral', 'hold pill says On hold');

  const sorted = view.sortActivity([
    { at: '2026-11-01T00:00:00.000Z', who: 'Sample Bot', text: 'Older pretend note' },
    { at: '2026-11-02T00:00:00.000Z', who: 'Demo Bot', text: 'Newer pretend note' },
  ]);
  assert(sorted[0].text === 'Newer pretend note' && sorted[1].text === 'Older pretend note', 'activity sorts newest first');
  const stamp = view.formatStamp('2026-11-18T07:27:00.000Z');
  const when = new Date('2026-11-18T07:27:00.000Z');
  const short = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][when.getMonth()];
  assert(stamp.indexOf(short + ' ' + when.getDate()) === 0, 'updated time uses the local month and day');
}

async function testDashboardData() {
  const sample = sampleDashboard();
  const hook = await startWebhook();
  const port = await freePort();
  const app = await startApp(baseEnv({
    PORT: String(port),
    DASHBOARD_JSON: JSON.stringify(sample),
    WEBHOOK_URL: 'http://127.0.0.1:' + hook.port + '/hook',
    WEBHOOK_KEY: WEBHOOK_KEY,
  }));
  try {
    const page = await request(port, 'GET', '/');
    assert(!page.text.includes('Example family event'), 'served login page hides the family event');
    assert(!page.text.includes('Demo Bot'), 'served login page hides bot names');
    const blocked = await request(port, 'GET', '/api/dashboard');
    assert(blocked.status === 401, 'dashboard with data still requires a session');
    assert(!blocked.text.includes('Example family event'), '401 dashboard body hides the family event');
    assert(!blocked.text.includes('123 Sample Street'), '401 dashboard body hides the deal');
    assert(!/family/i.test(blocked.text), '401 dashboard body does not mention family');

    const cookie = sessionCookie(await login(port, PASSCODE));
    const items = await request(port, 'GET', '/api/items', { cookie: cookie });
    assert(items.json.items.length === 2, 'a non-empty dashboard waiting list replaces ITEMS_JSON');
    assert(items.json.items.map(function (item) { return item.id; }).join(',') === 'fake-1,fake-2', 'dashboard waiting ids are used');
    assert(items.json.items[0].detail === 'Fictional follow-up about 123 Sample Street.', 'dashboard waiting detail is used');
    assert(items.json.items[0].status.tone === 'warning', 'dashboard waiting status is preserved');
    assert(Object.keys(items.json).length === 1, 'items payload stays a list when the dashboard is set');

    const dash = await request(port, 'GET', '/api/dashboard', { cookie: cookie });
    assert(dash.status === 200, 'signed-in dashboard returns the sample');
    assert(dash.json.summary === sample.summary, 'dashboard summary is returned');
    assert(dash.json.updatedAt === sample.updatedAt, 'dashboard updatedAt is returned');
    assert(dash.json.calendarMonth === '2026-11' && dash.json.calendarToday === '2026-11-18', 'calendar month and today are returned');
    assert(dash.json.events.some(function (event) { return event.lane === 'family' && event.title === 'Example family event'; }), 'signed-in dashboard includes the family event');
    assert(dash.json.inProgress.length === 2, 'in progress rows are returned');
    assert(dash.json.deals[0].deal === '123 Sample Street' && dash.json.deals[0].stage === 'Listing (example)', 'deal fields are returned');
    assert(dash.json.bots.length === 3, 'bots are returned');
    assert(dash.json.inbox[0].label === 'Latest work pass', 'inbox rows are returned');
    assert(dash.json.links[0].href === 'https://example.com', 'quick links are returned');
    assert(dash.json.activity[0].text === 'Finished a sample job', 'activity stays newest first');
    assert(dash.json.counts.waiting === 2 && dash.json.counts.inProgress === 2, 'waiting and in-progress counts match the lists');
    assert(dash.json.counts.deals === 1 && dash.json.counts.botsWaiting === 1, 'deal and bot-waiting counts match the lists');
    assert(!dash.text.includes(WEBHOOK_KEY) && !dash.text.includes(PASSCODE), 'dashboard JSON hides secrets');

    const sent = await request(port, 'POST', '/api/submit', {
      cookie: cookie,
      body: { itemId: 'fake-1', response: 'Left a fictional voicemail.', done: true },
    });
    assert(sent.status === 200 && sent.json.done === true, 'submit still marks a dashboard waiting item done');
    const hit = hook.hits[hook.hits.length - 1];
    assert(JSON.stringify(Object.keys(hit.json)) === JSON.stringify(['source', 'itemId', 'itemTitle', 'response', 'done', 'sentAt']), 'webhook keys are unchanged');
    assert(hit.json.source === 'command-center-phone', 'webhook source is unchanged');
    assert(hit.json.itemId === 'fake-1' && hit.json.itemTitle === 'Call the example seller', 'webhook title still comes from the server list');
    assert(hit.json.response === 'Left a fictional voicemail.' && hit.json.done === true, 'webhook response and done flag are unchanged');
    assert(hit.headers.authorization === 'Bearer ' + WEBHOOK_KEY, 'webhook bearer header is unchanged');

    const missing = await request(port, 'POST', '/api/submit', {
      cookie: cookie,
      body: { itemId: 'fake-3', response: 'not on this list', done: false },
    });
    assert(missing.status === 404, 'an ITEMS_JSON id is rejected when dashboard waiting replaces the list');
  } finally {
    await stop(app.child);
    hook.server.close();
  }

  const noWaiting = sampleDashboard();
  delete noWaiting.waiting;
  const fallbackPort = await freePort();
  const fallback = await startApp(baseEnv({
    PORT: String(fallbackPort),
    DASHBOARD_JSON: JSON.stringify(noWaiting),
  }));
  try {
    const cookie = sessionCookie(await login(fallbackPort, PASSCODE));
    const items = await request(fallbackPort, 'GET', '/api/items', { cookie: cookie });
    assert(items.json.items.length === ITEMS.length, 'omitted dashboard waiting falls back to ITEMS_JSON');
    assert(items.json.items[0].detail.indexOf('555-0100') !== -1, 'fallback items keep the ITEMS_JSON detail');
    const dash = await request(fallbackPort, 'GET', '/api/dashboard', { cookie: cookie });
    assert(dash.json.deals.length === 1 && dash.json.events.length === 3, 'other sections still load when waiting is omitted');
  } finally {
    await stop(fallback.child);
  }

  const emptyWaitingPort = await freePort();
  const emptyWaiting = await startApp(baseEnv({
    PORT: String(emptyWaitingPort),
    DASHBOARD_JSON: JSON.stringify({ waiting: [], deals: [{ deal: '123 Sample Street' }] }),
  }));
  try {
    const cookie = sessionCookie(await login(emptyWaitingPort, PASSCODE));
    const items = await request(emptyWaitingPort, 'GET', '/api/items', { cookie: cookie });
    assert(items.json.items.length === ITEMS.length, 'an empty dashboard waiting array falls back to ITEMS_JSON');
  } finally {
    await stop(emptyWaiting.child);
  }

  const nonePort = await freePort();
  const none = await startApp(baseEnv({
    PORT: String(nonePort),
    ITEMS_JSON: '[]',
    DASHBOARD_JSON: JSON.stringify({ waiting: [] }),
  }));
  try {
    const cookie = sessionCookie(await login(nonePort, PASSCODE));
    const items = await request(nonePort, 'GET', '/api/items', { cookie: cookie });
    assert(items.json.items.length === 0, 'empty dashboard waiting and empty ITEMS_JSON yield no waiting items');
  } finally {
    await stop(none.child);
  }

  const customPort = await freePort();
  const custom = await startApp(baseEnv({
    PORT: String(customPort),
    DASHBOARD_JSON: JSON.stringify({
      extra: 'ignored',
      calendarToday: '2026-12-02',
      activity: [
        { at: '2026-11-01T00:00:00.000Z', who: 'Sample Bot', text: 'Older pretend note' },
        { at: '2026-11-02T00:00:00.000Z', who: 'Demo Bot', text: 'Newer pretend note' },
      ],
      done: [
        { text: 'Sample task completed' },
        { text: 'Left open on purpose', done: false },
      ],
      events: [{ date: '2026-11-19', title: 'Example work call', lane: 'work' }],
    }),
  }));
  try {
    const cookie = sessionCookie(await login(customPort, PASSCODE));
    const dash = await request(customPort, 'GET', '/api/dashboard', { cookie: cookie });
    assert(dash.status === 200, 'unknown dashboard keys are ignored');
    assert(dash.json.activity[0].text === 'Newer pretend note', 'the server sorts activity newest first');
    assert(dash.json.done[0].done === true && dash.json.done[1].done === false, 'done defaults to true unless set false');
    assert(dash.json.calendarMonth === '2026-12' && dash.json.calendarToday === '2026-12-02', 'calendar month defaults from calendarToday');
    const items = await request(customPort, 'GET', '/api/items', { cookie: cookie });
    assert(items.json.items.length === ITEMS.length, 'dashboard data without waiting keeps ITEMS_JSON');
  } finally {
    await stop(custom.child);
  }

  const blankPort = await freePort();
  const blank = await startApp(baseEnv({
    PORT: String(blankPort),
    DASHBOARD_JSON: '   ',
  }));
  try {
    const cookie = sessionCookie(await login(blankPort, PASSCODE));
    const items = await request(blankPort, 'GET', '/api/items', { cookie: cookie });
    const dash = await request(blankPort, 'GET', '/api/dashboard', { cookie: cookie });
    assert(items.json.items.length === ITEMS.length, 'blank DASHBOARD_JSON falls back to ITEMS_JSON');
    assert(dash.json.events.length === 0, 'blank DASHBOARD_JSON does not invent events');
    assert(dash.json.calendarToday === new Date().toISOString().slice(0, 10), 'calendar today defaults to the UTC date');
  } finally {
    await stop(blank.child);
  }
}

async function testDashboardUi(port, hook) {
  const ui = await startChrome();
  const shots = {};
  try {
    await ui.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await ui.send('Page.enable');
    await ui.send('Page.navigate', { url: 'http://127.0.0.1:' + port + '/' });
    const loginText = await ui.waitForText('Unlock');
    await waitForReady(ui);
    assert(!loginText.includes('Example family event'), 'browser login hides the family event');
    assert(!loginText.includes('Demo Bot'), 'browser login hides bot names');
    assert(!loginText.includes('123 Sample Street'), 'browser login hides the deal');

    await ui.evalJson("document.getElementById('passcode').value = " + JSON.stringify(PASSCODE) + "; document.getElementById('login-form').requestSubmit(); true");
    const board = await ui.waitForText('Latest team activity');
    assert(board.includes('2 items waiting on you'), 'dashboard waiting count is the open list');
    assert(board.includes('Sample dashboard for tests'), 'dashboard summary is shown');
    assert(board.includes('Finished a sample job'), 'activity feed shows the newest sample');
    assert(board.includes('In progress'), 'in progress section is shown');
    assert(board.includes('Recently done'), 'recently done section is shown');
    assert(board.includes('Deals'), 'deals section is shown');
    assert(board.includes('Next two weeks'), 'calendar section is shown');
    assert(board.includes('What each bot is doing'), 'bots section is shown');
    assert(board.includes('Inbox'), 'inbox section is shown');
    assert(board.includes('Quick links'), 'quick links section is shown');
    assert(board.includes('Example family event'), 'family event is visible only after sign-in');
    assert(board.includes('Call the example seller'), 'waiting rows still render from the dashboard list');
    assert(board.includes('Respond'), 'Respond stays on waiting items');

    const counts = await ui.evalJson([
      '(function () {',
      '  return {',
      '    waiting: document.getElementById("count-waiting").textContent,',
      '    progress: document.getElementById("count-progress").textContent,',
      '    deals: document.getElementById("count-deals").textContent,',
      '    bots: document.getElementById("count-bots").textContent,',
      '    updated: document.getElementById("updated").textContent,',
      '    stamp: document.getElementById("updated").dataset.updated,',
      '    sections: Array.from(document.querySelectorAll(".section-updated")).every(function (node) {',
      '      return node.textContent === document.getElementById("updated").textContent;',
      '    })',
      '  };',
      '})()',
    ].join('\n'));
    assert(counts.waiting === '2' && counts.progress === '2' && counts.deals === '1' && counts.bots === '1', 'top counts match the sample');
    assert(counts.stamp === '2026-11-18T07:27:00.000Z', 'updated time keeps the source timestamp');
    assert(counts.updated.indexOf('Updated ') === 0 && counts.sections === true, 'each section shows the same updated time');
    shots.board = await ui.send('Page.captureScreenshot', { format: 'png' });

    await ui.evalJson('document.querySelector(\'#cal-chips [data-lane="work"]\').click()');
    const workTitles = await ui.evalJson('Array.from(document.querySelectorAll("#event-list .title")).map(function (node) { return node.textContent; })');
    const workDots = await ui.evalJson([
      '(function () {',
      '  const family = document.querySelector(\'[data-date="2026-11-20"]\');',
      '  const work = document.querySelector(\'[data-date="2026-11-19"]\');',
      '  return {',
      '    family: family.classList.contains("has-event"),',
      '    work: work.classList.contains("has-event"),',
      '    today: document.querySelector(\'[data-date="2026-11-18"]\').classList.contains("is-today"),',
      '    december: document.body.innerText.indexOf("December 2026") !== -1',
      '  };',
      '})()',
    ].join('\n'));
    assert(workTitles.indexOf('Example work call') !== -1 && workTitles.indexOf('Example family event') === -1, 'work filter hides the family event');
    assert(workDots.family === false && workDots.work === true, 'work filter drops the family day dot');
    assert(workDots.today === true && workDots.december === true, 'today is highlighted and the crossing month is shown');

    await ui.evalJson('document.querySelector(\'#cal-chips [data-lane="family"]\').click()');
    const familyTitles = await ui.evalJson('Array.from(document.querySelectorAll("#event-list .title")).map(function (node) { return node.textContent; })');
    assert(familyTitles.join('|') === 'Example family event', 'family filter shows only the family event');
    await ui.evalJson('document.getElementById("calendar-section").scrollIntoView({ block: "start" })');
    await sleep(100);
    shots.calendar = await ui.send('Page.captureScreenshot', { format: 'png' });

    await ui.evalJson('document.querySelector(\'#cal-chips [data-lane="all"]\').click()');
    const allTitles = await ui.evalJson('Array.from(document.querySelectorAll("#event-list .title")).map(function (node) { return node.textContent; })');
    assert(allTitles.length === 3, 'all filter restores every event in the window');

    const pills = await ui.evalJson([
      '(function () {',
      '  function pill(state) {',
      '    const node = document.querySelector(\'#bot-list [data-state="\' + state + \'"] .pill\');',
      '    return node ? node.textContent : "";',
      '  }',
      '  return { you: pill("you"), active: pill("active"), hold: pill("hold") };',
      '})()',
    ].join('\n'));
    assert(pills.you === 'Waiting on you' && pills.active === 'Active' && pills.hold === 'On hold', 'bot status pills use the three labels');

    await ui.evalJson('document.querySelector(\'#bot-chips [data-bot-filter="you"]\').click()');
    const youBots = await ui.evalJson('Array.from(document.querySelectorAll("#bot-list .title")).map(function (node) { return node.textContent; })');
    assert(youBots.join('|') === 'Sample Bot', 'waiting-on-you filter shows the bot that needs a fake OK');
    await ui.evalJson('document.querySelector(\'#bot-chips [data-bot-filter="active"]\').click()');
    const activeBots = await ui.evalJson('Array.from(document.querySelectorAll("#bot-list .title")).map(function (node) { return node.textContent; })');
    assert(activeBots.join('|') === 'Demo Bot', 'active filter shows the active bot');
    await ui.evalJson('document.querySelector(\'#bot-chips [data-bot-filter="all"]\').click()');
    const allBots = await ui.evalJson('Array.from(document.querySelectorAll("#bot-list [data-state]")).map(function (node) { return node.dataset.state; })');
    assert(allBots.join(',') === 'active,you,hold', 'all bots shows active, waiting, and hold');
    await ui.evalJson('document.getElementById("bots-section").scrollIntoView({ block: "start" })');
    await sleep(100);
    shots.bots = await ui.send('Page.captureScreenshot', { format: 'png' });

    const link = await ui.evalJson([
      '(function () {',
      '  const node = document.querySelector("#links-list a");',
      '  return { href: node.getAttribute("href"), target: node.target, rel: node.rel, title: node.querySelector(".title").textContent };',
      '})()',
    ].join('\n'));
    assert(link.href === 'https://example.com' && link.title === 'Example link', 'quick link points at the sample URL');
    assert(link.target === '_blank' && link.rel.indexOf('noopener') !== -1, 'quick link opens in a new tab without the opener');

    const before = hook.hits.length;
    await ui.evalJson('document.querySelector(\'#waiting-list [data-id="fake-2"] input[type="checkbox"]\').click()');
    await ui.waitForText('Marked done.');
    const placed = await ui.evalJson([
      '(function () {',
      '  return {',
      '    open: !!document.querySelector(\'#waiting-list [data-id="fake-2"]\'),',
      '    done: !!document.querySelector(\'#done-list [data-id="fake-2"]\'),',
      '    recent: document.getElementById("recent-list").textContent.indexOf("Review the demo offer") !== -1,',
      '    count: document.getElementById("count-waiting").textContent,',
      '    summary: document.getElementById("summary").textContent',
      '  };',
      '})()',
    ].join('\n'));
    assert(placed.open === false && placed.done === true, 'Done still moves a dashboard waiting row into Done');
    assert(placed.recent === false, 'the phone Done row is not copied into Recently done');
    assert(placed.count === '1' && placed.summary === '1 item waiting on you', 'the waiting count drops when an item is marked done');
    const toggleHit = hook.hits[hook.hits.length - 1];
    assert(hook.hits.length === before + 1, 'the Done switch still calls the webhook once');
    assert(toggleHit.json.itemId === 'fake-2' && toggleHit.json.done === true && toggleHit.json.response === '', 'the Done switch payload is unchanged');
    assert(toggleHit.json.source === 'command-center-phone' && toggleHit.json.itemTitle === 'Review the demo offer', 'the Done switch still sends the server title');

    await ui.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await ui.evalJson('window.scrollTo(0, 0)');
    await sleep(100);
    const xs = await ui.evalJson('Array.from(document.querySelectorAll(".count")).map(function (node) { return Math.round(node.getBoundingClientRect().x); })');
    assert(xs[0] < xs[1] && xs[1] < xs[2] && xs[2] < xs[3], 'counts sit in a row on a wide screen');
    shots.desktop = await ui.send('Page.captureScreenshot', { format: 'png' });

    await ui.evalJson('document.getElementById("logout").click()');
    await ui.waitForText('Unlock');
    const cleared = await ui.evalJson([
      '(function () {',
      '  return {',
      '    events: document.getElementById("event-list").textContent,',
      '    bots: document.getElementById("bot-list").textContent,',
      '    deals: document.getElementById("deals-list").textContent,',
      '    body: document.body.innerText',
      '  };',
      '})()',
    ].join('\n'));
    assert(cleared.events === '' && cleared.bots === '' && cleared.deals === '', 'logout clears calendar, bot, and deal text');
    assert(cleared.body.indexOf('Example family event') === -1, 'logout hides the family event again');
    return shots;
  } catch (err) {
    try {
      const shot = await ui.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync('/tmp/cc-dashboard-failure.png', Buffer.from(shot.data, 'base64'));
    } catch (shotErr) { /* ignore */ }
    throw err;
  } finally {
    await ui.close();
  }
}

async function main() {
  await testViewModel();
  await testConfigFailures();
  const hook = await startWebhook();
  const port = await freePort();
  let app = await startApp(baseEnv({
    PORT: String(port),
    WEBHOOK_URL: 'http://127.0.0.1:' + hook.port + '/hook',
    WEBHOOK_KEY: WEBHOOK_KEY,
  }));
  let ui = null;
  try {
    const client = fs.readFileSync(__dirname + '/public/app.js', 'utf8');
    const viewSource = fs.readFileSync(__dirname + '/public/dashboard-view.js', 'utf8');
    assert(!client.includes('innerHTML') && !client.includes('insertAdjacentHTML'), 'client renders item text without HTML injection');
    assert(!viewSource.includes('innerHTML') && !viewSource.includes('insertAdjacentHTML'), 'view helper does not build HTML strings');
    await testAuthAndList(port, hook);
    const uiResult = await testUi(port, hook);
    ui = uiResult.ui;
    writeShots(uiResult.shots);

    await stop(app.child);
    app = await startApp(baseEnv({
      PORT: String(port),
      WEBHOOK_URL: 'http://127.0.0.1:' + hook.port + '/hook',
      WEBHOOK_KEY: WEBHOOK_KEY,
    }));
    await testLocalStorageAfterRestart(ui, port);
    const cookie = await freshCookie(port);
    await testWebhook(port, hook, cookie);
    await testRateLimit(port);
  } finally {
    if (ui) await ui.close();
    if (app) await stop(app.child);
    hook.server.close();
  }
  await testCustomHeader();
  await testMissingWebhook();
  await testDashboardData();

  const sample = sampleDashboard();
  const dashHook = await startWebhook();
  const dashPort = await freePort();
  const dashApp = await startApp(baseEnv({
    PORT: String(dashPort),
    DASHBOARD_JSON: JSON.stringify(sample),
    WEBHOOK_URL: 'http://127.0.0.1:' + dashHook.port + '/hook',
    WEBHOOK_KEY: WEBHOOK_KEY,
  }));
  try {
    const shots = await testDashboardUi(dashPort, dashHook);
    writeShots(shots);
  } finally {
    await stop(dashApp.child);
    dashHook.server.close();
  }
  console.log('all checks passed');
}

main().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
