(function () {
  const DONE_KEY = 'nhe-command-center-done';
  const loginView = document.getElementById('login-view');
  const appView = document.getElementById('app-view');
  const loginForm = document.getElementById('login-form');
  const passcodeInput = document.getElementById('passcode');
  const loginError = document.getElementById('login-error');
  const banner = document.getElementById('banner');
  const openList = document.getElementById('open-list');
  const doneList = document.getElementById('done-list');
  const doneSection = document.getElementById('done-section');
  const doneHeading = document.getElementById('done-heading');
  const toggleDone = document.getElementById('toggle-done');
  const empty = document.getElementById('empty');
  const logout = document.getElementById('logout');

  let showDone = false;

  function readDone() {
    try {
      const parsed = JSON.parse(localStorage.getItem(DONE_KEY) || '[]');
      if (!Array.isArray(parsed)) return new Set();
      return new Set(parsed.filter((id) => typeof id === 'string'));
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

  async function api(path, options) {
    const res = await fetch(path, {
      method: (options && options.method) || 'GET',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: options && options.body,
      credentials: 'same-origin',
    });
    let data = {};
    try {
      data = await res.json();
    } catch (err) {
      data = {};
    }
    return { ok: res.ok, status: res.status, data: data };
  }

  function showLogin(message) {
    appView.hidden = true;
    loginView.hidden = false;
    setMessage(loginError, message ? 'err' : '', message || '');
    passcodeInput.focus();
  }

  function refreshChrome() {
    const openCount = openList.children.length;
    const doneCount = doneList.children.length;
    empty.hidden = openCount !== 0;
    doneSection.hidden = doneCount === 0;
    doneHeading.textContent = 'Sent / done';
    doneList.hidden = !showDone;
    toggleDone.textContent = showDone ? 'Hide done' : 'Show done';
    toggleDone.setAttribute('aria-expanded', showDone ? 'true' : 'false');
    if (doneCount === 0) showDone = false;
  }

  function renderCard(item) {
    const card = document.createElement('article');
    card.className = 'card';
    card.dataset.id = item.id;

    const title = document.createElement('h2');
    title.textContent = item.title;

    const detail = document.createElement('p');
    detail.className = 'detail';
    detail.textContent = item.detail || '';
    detail.hidden = !item.detail;

    const label = document.createElement('label');
    const span = document.createElement('span');
    span.className = 'field-label';
    span.textContent = 'Response';
    const area = document.createElement('textarea');
    area.maxLength = 8000;
    area.rows = 4;
    area.placeholder = 'Type or dictate a response';
    area.setAttribute('aria-label', 'Response for ' + item.title);
    label.append(span, area);

    const actions = document.createElement('div');
    actions.className = 'actions';
    const send = document.createElement('button');
    send.type = 'button';
    send.className = 'secondary';
    send.dataset.action = 'send';
    send.textContent = 'Send';
    const doneBtn = document.createElement('button');
    doneBtn.type = 'button';
    doneBtn.className = 'primary actions-btn';
    doneBtn.dataset.action = 'done';
    doneBtn.textContent = 'Send + done';
    actions.append(send, doneBtn);

    const status = document.createElement('p');
    status.className = 'card-status message';
    status.setAttribute('role', 'status');

    card.append(title, detail, label, actions, status);

    async function submit(markDone) {
      const response = area.value.trim();
      if (!response) {
        setMessage(status, 'err', 'Write a response before sending.');
        area.focus();
        return;
      }
      send.disabled = true;
      doneBtn.disabled = true;
      setMessage(status, '', '');
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
          const message = (result.data && result.data.error) || 'Could not send that response.';
          setMessage(status, 'err', message);
          setMessage(banner, 'err', message);
          return;
        }
        area.value = '';
        if (markDone) {
          const ids = readDone();
          ids.add(item.id);
          writeDone(ids);
          item.done = true;
          doneList.appendChild(card);
          setMessage(status, 'ok', 'Sent and marked done.');
          setMessage(banner, 'ok', 'Sent and marked done.');
        } else {
          setMessage(status, 'ok', 'Sent to your assistant.');
          setMessage(banner, 'ok', 'Sent to your assistant.');
        }
        refreshChrome();
      } catch (err) {
        setMessage(status, 'err', 'Network error. Check your connection and try again.');
        setMessage(banner, 'err', 'Network error. Check your connection and try again.');
      } finally {
        send.disabled = false;
        doneBtn.disabled = false;
      }
    }

    send.addEventListener('click', function () { submit(false); });
    doneBtn.addEventListener('click', function () { submit(true); });
    return card;
  }

  function render(items) {
    openList.replaceChildren();
    doneList.replaceChildren();
    items.forEach(function (item) {
      const card = renderCard(item);
      if (isDone(item)) doneList.appendChild(card);
      else openList.appendChild(card);
    });
    refreshChrome();
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
    render(result.data.items || []);
    const first = openList.querySelector('textarea');
    if (first) first.focus();
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
    try {
      await api('/api/logout', { method: 'POST', body: '{}' });
    } catch (err) {
      /* still return to the lock screen */
    }
    showLogin('');
  });

  toggleDone.addEventListener('click', function () {
    showDone = !showDone;
    refreshChrome();
  });

  api('/api/session').then(function (result) {
    if (result.ok) showApp();
    else passcodeInput.focus();
  }).catch(function () {
    setMessage(loginError, 'err', 'Network error. Check your connection and try again.');
  });
})();
