(function () {
  const DONE_KEY = 'nhe-command-center-done';
  const loginView = document.getElementById('login-view');
  const appView = document.getElementById('app-view');
  const loginForm = document.getElementById('login-form');
  const passcodeInput = document.getElementById('passcode');
  const loginError = document.getElementById('login-error');
  const banner = document.getElementById('banner');
  const summary = document.getElementById('summary');
  const waitingList = document.getElementById('waiting-list');
  const doneList = document.getElementById('done-list');
  const doneSection = document.getElementById('done-section');
  const empty = document.getElementById('empty');
  const logout = document.getElementById('logout');
  const sheetRoot = document.getElementById('sheet-root');
  const sheet = document.getElementById('sheet');
  const sheetTitle = document.getElementById('sheet-title');
  const sheetText = document.getElementById('sheet-text');
  const sheetInterim = document.getElementById('sheet-interim');
  const sheetError = document.getElementById('sheet-error');
  const sheetSend = document.getElementById('sheet-send');
  const alsoDone = document.getElementById('also-done');
  const mic = document.getElementById('mic');
  const micHint = document.getElementById('mic-hint');
  const recState = document.getElementById('rec-state');
  const backdrop = document.getElementById('sheet-backdrop');

  let items = [];
  let sheetId = null;
  let recognition = null;
  let recording = false;

  function readDone() {
    try {
      const parsed = JSON.parse(localStorage.getItem(DONE_KEY) || '[]');
      if (!Array.isArray(parsed)) return new Set();
      return new Set(parsed.filter(function (id) { return typeof id === 'string'; }));
    } catch (err) {
      return new Set();
    }
  }

  function writeDone(ids) {
    localStorage.setItem(DONE_KEY, JSON.stringify(Array.from(ids)));
  }

  function isDone(item) {
    return item.done === true || readDone().has(item.id);
  }

  function setMessage(node, kind, text) {
    node.dataset.kind = kind || '';
    node.textContent = text || '';
  }

  function speechCtor() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  async function api(path, options) {
    const res = await fetch(path, {
      method: (options && options.method) || 'GET',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: options && options.body,
      credentials: 'same-origin',
    });
    let data = {};
    try { data = await res.json(); } catch (err) { data = {}; }
    return { ok: res.ok, status: res.status, data: data };
  }

  function showLogin(message) {
    closeSheet();
    appView.hidden = true;
    loginView.hidden = false;
    setMessage(loginError, message ? 'err' : '', message || '');
    passcodeInput.focus();
  }

  function badgeText(item, position, done) {
    if (done) return '\u2713';
    if (item.lead) return item.lead;
    return String(position);
  }

  function renderRow(item, position, done) {
    const row = document.createElement('article');
    row.className = done ? 'row is-done' : 'row';
    row.dataset.id = item.id;

    const badge = document.createElement('div');
    badge.className = 'badge';
    badge.textContent = badgeText(item, position, done);
    if (done) badge.setAttribute('aria-label', 'Done');

    const body = document.createElement('div');
    const titleLine = document.createElement('div');
    titleLine.className = 'title-line';
    const title = document.createElement('h3');
    title.className = 'title';
    title.textContent = item.title;
    titleLine.appendChild(title);
    if (item.status && item.status.label) {
      const pill = document.createElement('span');
      pill.className = 'pill ' + (item.status.tone || 'neutral');
      pill.textContent = item.status.label;
      titleLine.appendChild(pill);
    }

    const detail = document.createElement('p');
    detail.className = 'detail';
    detail.textContent = item.detail || '';
    detail.hidden = !item.detail;

    const meta = document.createElement('p');
    meta.className = 'meta';
    meta.textContent = item.meta || '';
    meta.hidden = !item.meta;

    const actions = document.createElement('div');
    actions.className = 'row-actions';
    const respond = document.createElement('button');
    respond.type = 'button';
    respond.className = 'respond';
    respond.textContent = 'Respond';
    respond.addEventListener('click', function () { openSheet(item.id); });

    const switchLabel = document.createElement('label');
    switchLabel.className = 'switch';
    const switchName = document.createElement('span');
    switchName.className = 'switch-name';
    switchName.textContent = 'Done';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('role', 'switch');
    input.setAttribute('aria-label', 'Done');
    input.checked = done;
    const track = document.createElement('span');
    track.className = 'track';
    switchLabel.append(switchName, input, track);
    input.addEventListener('change', function () {
      const want = input.checked;
      input.disabled = true;
      setDone(item, want);
    });

    actions.append(respond, switchLabel);
    body.append(titleLine, detail, meta, actions);
    row.append(badge, body);
    return row;
  }

  function render() {
    const waiting = [];
    const finished = [];
    items.forEach(function (item) {
      if (isDone(item)) finished.push(item);
      else waiting.push(item);
    });
    waitingList.replaceChildren.apply(waitingList, waiting.map(function (item, index) {
      return renderRow(item, index + 1, false);
    }));
    doneList.replaceChildren.apply(doneList, finished.map(function (item, index) {
      return renderRow(item, index + 1, true);
    }));
    if (waiting.length === 0) summary.textContent = 'Nothing waiting on you';
    else if (waiting.length === 1) summary.textContent = '1 item waiting on you';
    else summary.textContent = waiting.length + ' items waiting on you';
    empty.hidden = waiting.length !== 0;
    waitingList.hidden = waiting.length === 0;
    doneSection.hidden = finished.length === 0;
  }

  async function setDone(item, want) {
    try {
      const result = await api('/api/submit', {
        method: 'POST',
        body: JSON.stringify({ itemId: item.id, response: '', done: want }),
      });
      if (result.status === 401) {
        showLogin('Your session expired. Enter the passcode again.');
        return;
      }
      if (!result.ok) {
        setMessage(banner, 'err', (result.data && result.data.error) || 'Could not update that item.');
        render();
        return;
      }
      const ids = readDone();
      if (want) ids.add(item.id);
      else ids.delete(item.id);
      writeDone(ids);
      item.done = want;
      setMessage(banner, 'ok', want ? 'Marked done.' : 'Moved back to Waiting on you.');
      render();
    } catch (err) {
      setMessage(banner, 'err', 'Network error. Check your connection and try again.');
      render();
    }
  }

  function setRecordingUi(on) {
    recording = on;
    mic.classList.toggle('recording', on);
    mic.textContent = on ? 'Stop' : 'Mic';
    mic.setAttribute('aria-pressed', on ? 'true' : 'false');
    sheet.classList.toggle('recording', on);
    recState.hidden = !on;
  }

  function stopMic() {
    const session = recognition;
    recording = false;
    recognition = null;
    setRecordingUi(false);
    sheetInterim.textContent = '';
    if (session) {
      session.onend = null;
      try { session.stop(); } catch (err) { /* already stopped */ }
    }
  }

  function startMic() {
    const Ctor = speechCtor();
    if (!Ctor) return;
    stopMic();
    const session = new Ctor();
    recognition = session;
    session.continuous = true;
    session.interimResults = true;
    session.lang = 'en-US';
    const prefix = sheetText.value;
    setRecordingUi(true);
    session.onresult = function (event) {
      let finals = '';
      let interim = '';
      for (let i = 0; i < event.results.length; i++) {
        const piece = event.results[i][0].transcript;
        if (event.results[i].isFinal) finals += piece;
        else interim += piece;
      }
      const spoken = finals + interim;
      let value = prefix;
      if (spoken) {
        if (prefix && !/\s$/.test(prefix) && !/^\s/.test(spoken)) value += ' ';
        value += spoken;
      }
      sheetText.value = value;
      sheetInterim.textContent = interim;
    };
    session.onerror = function (event) {
      if (!event || event.error === 'no-speech') return;
      stopMic();
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        setMessage(sheetError, 'err', 'Microphone permission was blocked. Type instead, or use the keyboard microphone key.');
      }
    };
    session.onend = function () {
      if (recording && recognition === session) {
        try { session.start(); } catch (err) { stopMic(); }
      }
    };
    try {
      session.start();
    } catch (err) {
      stopMic();
      setMessage(sheetError, 'err', 'Could not start dictation. Use the keyboard microphone key.');
    }
  }

  function syncMic() {
    const available = !!speechCtor();
    mic.hidden = !available;
    micHint.hidden = available;
  }

  function closeSheet() {
    stopMic();
    sheetId = null;
    sheetRoot.hidden = true;
    setMessage(sheetError, '', '');
    sheetInterim.textContent = '';
  }

  function openSheet(id) {
    const item = items.find(function (entry) { return entry.id === id; });
    if (!item) return;
    stopMic();
    sheetId = id;
    sheetTitle.textContent = item.title;
    sheetText.value = '';
    alsoDone.checked = isDone(item);
    setMessage(sheetError, '', '');
    sheetInterim.textContent = '';
    syncMic();
    sheetRoot.hidden = false;
    sheetText.focus();
  }

  async function sendSheet() {
    const item = items.find(function (entry) { return entry.id === sheetId; });
    if (!item) return;
    const response = sheetText.value.trim();
    if (!response) {
      setMessage(sheetError, 'err', 'Write a response before sending.');
      sheetText.focus();
      return;
    }
    const markDone = alsoDone.checked;
    sheetSend.disabled = true;
    mic.disabled = true;
    stopMic();
    try {
      const result = await api('/api/submit', {
        method: 'POST',
        body: JSON.stringify({ itemId: item.id, response: response, done: markDone }),
      });
      if (result.status === 401) {
        showLogin('Your session expired. Enter the passcode again.');
        return;
      }
      if (!result.ok) {
        setMessage(sheetError, 'err', (result.data && result.data.error) || 'Could not send that response.');
        return;
      }
      const ids = readDone();
      if (markDone) {
        ids.add(item.id);
        item.done = true;
      } else {
        ids.delete(item.id);
        item.done = false;
      }
      writeDone(ids);
      closeSheet();
      setMessage(banner, 'ok', 'Sent to Tony');
      render();
    } catch (err) {
      setMessage(sheetError, 'err', 'Network error. Check your connection and try again.');
    } finally {
      sheetSend.disabled = false;
      mic.disabled = false;
    }
  }

  async function showApp() {
    loginView.hidden = true;
    appView.hidden = false;
    setMessage(banner, '', '');
    const result = await api('/api/items');
    if (result.status === 401) {
      showLogin('Your session expired. Enter the passcode again.');
      return;
    }
    if (!result.ok) {
      setMessage(banner, 'err', (result.data && result.data.error) || 'Could not load items.');
      return;
    }
    items = result.data.items || [];
    const ids = readDone();
    items.forEach(function (item) {
      if (item.done) ids.add(item.id);
    });
    writeDone(ids);
    render();
  }

  loginForm.addEventListener('submit', async function (event) {
    event.preventDefault();
    setMessage(loginError, '', '');
    const button = loginForm.querySelector('button');
    button.disabled = true;
    try {
      const result = await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({ passcode: passcodeInput.value }),
      });
      if (!result.ok) {
        setMessage(loginError, 'err', (result.data && result.data.error) || 'Could not sign in.');
        return;
      }
      passcodeInput.value = '';
      await showApp();
    } catch (err) {
      setMessage(loginError, 'err', 'Network error. Check your connection and try again.');
    } finally {
      button.disabled = false;
    }
  });

  logout.addEventListener('click', async function () {
    closeSheet();
    try { await api('/api/logout', { method: 'POST', body: '{}' }); } catch (err) { /* still lock the screen */ }
    showLogin('');
  });

  mic.addEventListener('click', function () {
    if (recording) stopMic();
    else startMic();
  });
  sheetSend.addEventListener('click', sendSheet);
  backdrop.addEventListener('click', closeSheet);
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !sheetRoot.hidden) closeSheet();
  });

  api('/api/session').then(function (result) {
    if (result.ok) showApp();
    else passcodeInput.focus();
  }).catch(function () {
    setMessage(loginError, 'err', 'Network error. Check your connection and try again.');
  });
})();
