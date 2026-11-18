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
  let dashboard = blankDashboard();
  let calLane = 'all';
  let botFilter = 'all';
  let sheetId = null;
  let recognition = null;
  let recording = false;

  function blankDashboard() {
    return {
      updatedAt: null,
      summary: null,
      inProgress: [],
      done: [],
      deals: [],
      events: [],
      calendarMonth: '',
      calendarToday: '',
      bots: [],
      inbox: [],
      links: [],
      activity: [],
    };
  }

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
    clearBoard();
    appView.hidden = true;
    loginView.hidden = false;
    setMessage(loginError, message ? 'err' : '', message || '');
    passcodeInput.focus();
  }

  function clearBoard() {
    items = [];
    dashboard = blankDashboard();
    calLane = 'all';
    botFilter = 'all';
    syncChips();
    render();
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

  function syncChips() {
    document.querySelectorAll('#cal-chips .chip').forEach(function (chip) {
      chip.setAttribute('aria-pressed', chip.dataset.lane === calLane ? 'true' : 'false');
    });
    document.querySelectorAll('#bot-chips .chip').forEach(function (chip) {
      chip.setAttribute('aria-pressed', chip.dataset.botFilter === botFilter ? 'true' : 'false');
    });
  }

  function safeHref(value) {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim();
    try {
      const url = new URL(trimmed);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
      return trimmed;
    } catch (err) {
      return '';
    }
  }

  function fillList(listId, emptyId, nodes) {
    const list = document.getElementById(listId);
    const empty = document.getElementById(emptyId);
    list.replaceChildren.apply(list, nodes);
    const none = nodes.length === 0;
    list.hidden = none;
    empty.hidden = !none;
  }

  function feedRow() {
    const row = document.createElement('article');
    row.className = 'row feed';
    const body = document.createElement('div');
    row.appendChild(body);
    return { row: row, body: body };
  }

  function addTitle(body, text, pill) {
    const titleLine = document.createElement('div');
    titleLine.className = 'title-line';
    const title = document.createElement('h3');
    title.className = 'title';
    title.textContent = text;
    titleLine.appendChild(title);
    if (pill && pill.label) {
      const node = document.createElement('span');
      node.className = 'pill ' + (pill.tone || 'neutral');
      node.textContent = pill.label;
      titleLine.appendChild(node);
    }
    body.appendChild(titleLine);
  }

  function addLine(body, className, text) {
    if (!text) return;
    const node = document.createElement('p');
    node.className = className;
    node.textContent = text;
    body.appendChild(node);
  }

  function paintUpdated() {
    const stamp = dashboard && dashboard.updatedAt && window.NheView
      ? window.NheView.formatStamp(dashboard.updatedAt)
      : '';
    const updated = document.getElementById('updated');
    if (stamp) {
      updated.textContent = 'Updated ' + stamp;
      updated.dataset.updated = dashboard.updatedAt;
    } else {
      updated.textContent = '';
      delete updated.dataset.updated;
    }
    document.querySelectorAll('.section-updated').forEach(function (node) {
      node.textContent = stamp ? 'Updated ' + stamp : '';
    });
    const dashSummary = document.getElementById('dash-summary');
    if (dashboard && dashboard.summary) {
      dashSummary.hidden = false;
      dashSummary.textContent = dashboard.summary;
    } else {
      dashSummary.hidden = true;
      dashSummary.textContent = '';
    }
  }

  function paintCounts() {
    let waiting = 0;
    items.forEach(function (item) {
      if (!isDone(item)) waiting += 1;
    });
    document.getElementById('count-waiting').textContent = String(waiting);
    const progress = dashboard && dashboard.inProgress ? dashboard.inProgress.length : 0;
    const deals = dashboard && dashboard.deals ? dashboard.deals.length : 0;
    const botsWaiting = dashboard && dashboard.bots
      ? dashboard.bots.filter(function (bot) { return bot.state === 'you'; }).length
      : 0;
    document.getElementById('count-progress').textContent = String(progress);
    document.getElementById('count-deals').textContent = String(deals);
    document.getElementById('count-bots').textContent = String(botsWaiting);
  }

  function renderActivity() {
    const rows = window.NheView.sortActivity(dashboard.activity || []).map(function (item) {
      const card = feedRow();
      const when = window.NheView.formatStamp(item.at);
      addLine(card.body, 'meta', when ? item.who + ' · ' + when : item.who);
      addTitle(card.body, item.text);
      return card.row;
    });
    fillList('activity-list', 'activity-empty', rows);
  }

  function renderProgress() {
    const rows = (dashboard.inProgress || []).map(function (item) {
      const card = feedRow();
      addTitle(card.body, item.who);
      addLine(card.body, 'detail', item.what);
      addLine(card.body, 'meta', item.last);
      return card.row;
    });
    fillList('progress-list', 'progress-empty', rows);
  }

  function renderRecent() {
    const rows = (dashboard.done || []).map(function (item) {
      const card = feedRow();
      if (item.done !== false) card.row.classList.add('is-done');
      addTitle(card.body, item.text, item.done === false ? null : { label: 'Done', tone: 'done' });
      addLine(card.body, 'meta', item.meta);
      return card.row;
    });
    fillList('recent-list', 'recent-empty', rows);
  }

  function renderDeals() {
    const rows = (dashboard.deals || []).map(function (item) {
      const card = feedRow();
      addTitle(card.body, item.deal, item.stage ? { label: item.stage, tone: 'neutral' } : null);
      addLine(card.body, 'detail', item.stands);
      addLine(card.body, 'meta', item.next ? 'Next: ' + item.next : '');
      return card.row;
    });
    fillList('deals-list', 'deals-empty', rows);
  }

  function renderMonth(model) {
    const wrap = document.createElement('div');
    wrap.className = 'month';
    const label = document.createElement('p');
    label.className = 'month-label';
    label.textContent = model.label;
    const grid = document.createElement('div');
    grid.className = 'cal-grid';
    ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].forEach(function (name) {
      const cell = document.createElement('div');
      cell.className = 'cal-dow';
      cell.textContent = name;
      grid.appendChild(cell);
    });
    model.cells.forEach(function (cell) {
      const node = document.createElement('div');
      node.className = 'cal-cell';
      if (!cell) {
        node.classList.add('is-empty');
        grid.appendChild(node);
        return;
      }
      node.textContent = String(cell.day);
      node.dataset.date = cell.date;
      if (cell.isToday) node.classList.add('is-today');
      if (cell.hasEvent) node.classList.add('has-event');
      grid.appendChild(node);
    });
    wrap.append(label, grid);
    return wrap;
  }

  function renderCalendar() {
    const view = window.NheView;
    const events = dashboard.events || [];
    const laneEvents = view.eventsForLane(events, calLane);
    const months = view.monthsForWindow(dashboard.calendarMonth, dashboard.calendarToday);
    const grids = document.getElementById('calendar-grids');
    grids.replaceChildren.apply(grids, months.map(function (month) {
      return renderMonth(view.buildMonth(month, dashboard.calendarToday, laneEvents));
    }));
    const rows = view.filterEvents(events, dashboard.calendarToday, calLane).map(function (event) {
      const card = feedRow();
      card.row.dataset.lane = event.lane;
      card.row.dataset.date = event.date;
      addTitle(card.body, event.title, {
        label: event.lane === 'family' ? 'Family' : 'Work',
        tone: event.lane === 'family' ? 'warning' : 'neutral',
      });
      addLine(card.body, 'meta', event.date);
      return card.row;
    });
    fillList('event-list', 'event-empty', rows);
  }

  function renderBots() {
    const rows = window.NheView.filterBots(dashboard.bots || [], botFilter).map(function (bot) {
      const card = feedRow();
      card.row.dataset.state = bot.state;
      addTitle(card.body, bot.bot, window.NheView.botPill(bot.state));
      addLine(card.body, 'detail', bot.focus);
      addLine(card.body, 'meta', bot.last);
      return card.row;
    });
    fillList('bot-list', 'bot-empty', rows);
  }

  function renderInbox() {
    const rows = (dashboard.inbox || []).map(function (item) {
      const card = feedRow();
      addLine(card.body, 'meta', item.label);
      addLine(card.body, 'detail', item.value);
      return card.row;
    });
    fillList('inbox-list', 'inbox-empty', rows);
  }

  function renderLinks() {
    const rows = (dashboard.links || []).map(function (item) {
      const href = safeHref(item.href);
      if (!href) return null;
      const link = document.createElement('a');
      link.className = 'link-row';
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      const title = document.createElement('h3');
      title.className = 'title';
      title.textContent = item.title;
      link.appendChild(title);
      if (item.site) {
        const site = document.createElement('p');
        site.className = 'link-site';
        site.textContent = item.site;
        link.appendChild(site);
      }
      return link;
    }).filter(function (node) { return !!node; });
    fillList('links-list', 'links-empty', rows);
  }

  function renderDashboard() {
    if (!window.NheView || !dashboard) return;
    paintUpdated();
    renderActivity();
    renderProgress();
    renderRecent();
    renderDeals();
    renderCalendar();
    renderBots();
    renderInbox();
    renderLinks();
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
    paintCounts();
    renderDashboard();
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
    const dashResult = await api('/api/dashboard');
    if (dashResult.status === 401) {
      showLogin('Your session expired. Enter the passcode again.');
      return;
    }
    if (!dashResult.ok) {
      dashboard = blankDashboard();
      setMessage(banner, 'err', (dashResult.data && dashResult.data.error) || 'Could not load the dashboard.');
    } else {
      dashboard = dashResult.data || blankDashboard();
    }
    calLane = 'all';
    botFilter = 'all';
    syncChips();
    const ids = readDone();
    items.forEach(function (item) {
      if (item.done) ids.add(item.id);
    });
    writeDone(ids);
    render();
  }

  loginForm.dataset.bound = 'yes';
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

  document.getElementById('cal-chips').addEventListener('click', function (event) {
    const button = event.target.closest('button');
    if (!button || !button.dataset.lane) return;
    calLane = button.dataset.lane;
    syncChips();
    renderDashboard();
  });

  document.getElementById('bot-chips').addEventListener('click', function (event) {
    const button = event.target.closest('button');
    if (!button || !button.dataset.botFilter) return;
    botFilter = button.dataset.botFilter;
    syncChips();
    renderDashboard();
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
