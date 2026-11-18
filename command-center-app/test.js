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

async function main() {
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
    assert(!client.includes('innerHTML') && !client.includes('insertAdjacentHTML'), 'client renders item text without HTML injection');
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
  console.log('all checks passed');
}

main().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
