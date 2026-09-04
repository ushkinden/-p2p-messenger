(() => {
  'use strict';

  // ============================================================
  // Настройки / локальное хранилище
  // ============================================================

  const LS = {
    id: 'p2p_id',
    name: 'p2p_name',
    signaling: 'p2p_signaling_url',
    turnUrl: 'p2p_turn_url',
    turnUser: 'p2p_turn_user',
    turnPass: 'p2p_turn_pass',
  };

  function genId() {
    const bytes = new Uint32Array(3);
    crypto.getRandomValues(bytes);
    let n = (bytes[0] ^ bytes[1] ^ bytes[2]) % 1000000000;
    return String(Math.abs(n)).padStart(9, '0');
  }

  function formatId(id) {
    return id.replace(/(\d{3})(\d{3})(\d{3})/, '$1 $2 $3');
  }

  function iceServers() {
    const servers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ];
    const turnUrl = localStorage.getItem(LS.turnUrl);
    if (turnUrl) {
      servers.push({
        urls: turnUrl,
        username: localStorage.getItem(LS.turnUser) || undefined,
        credential: localStorage.getItem(LS.turnPass) || undefined,
      });
    }
    return servers;
  }

  // ============================================================
  // IndexedDB: контакты и сообщения (включая вложения-Blob)
  // ============================================================

  let dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open('p2p-messenger-db', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('contacts')) {
        db.createObjectStore('contacts', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('messages')) {
        const store = db.createObjectStore('messages', { keyPath: 'msgId' });
        store.createIndex('peerId', 'peerId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  async function idbPut(storeName, value) {
    const db = await dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(value);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function idbGetAll(storeName) {
    const db = await dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbGetByIndex(storeName, indexName, value) {
    const db = await dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).index(indexName).getAll(value);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbDelete(storeName, key) {
    const db = await dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ============================================================
  // Состояние приложения
  // ============================================================

  const state = {
    myId: localStorage.getItem(LS.id),
    myName: localStorage.getItem(LS.name) || '',
    contacts: [], // { id, name, addedAt }
    online: new Map(), // peerId -> bool (по данным сигнального сервера)
    peers: new Map(), // peerId -> { pc, dc, incomingFile, outbox, sending }
    activePeerId: null,
    objectUrls: [], // созданные URL.createObjectURL — чистим при смене чата
    ws: null,
    wsReconnectDelay: 1000,
  };

  // ============================================================
  // Элементы DOM
  // ============================================================

  const el = (id) => document.getElementById(id);
  const setupScreen = el('setup-screen');
  const appScreen = el('app-screen');
  const myIdValue = el('my-id-value');
  const signalingDot = el('signaling-dot');
  const signalingStatusText = el('signaling-status-text');
  const contactsList = el('contacts-list');
  const chatEmpty = el('chat-empty');
  const chatActive = el('chat-active');
  const peerAvatar = el('peer-avatar');
  const peerName = el('peer-name');
  const peerStatusDot = el('peer-status-dot');
  const peerStatusText = el('peer-status-text');
  const messagesEl = el('messages');
  const messageForm = el('message-form');
  const textInput = el('text-input');
  const attachBtn = el('attach-btn');
  const fileInput = el('file-input');
  const backBtn = el('back-btn');
  const sidebar = document.querySelector('.sidebar');

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
  function initials(name) {
    return (name || '?').trim().slice(0, 2).toUpperCase();
  }
  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }
  function fmtSize(bytes) {
    if (bytes < 1024) return `${bytes} Б`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
  }
  function trackedUrl(blob) {
    const url = URL.createObjectURL(blob);
    state.objectUrls.push(url);
    return url;
  }

  // ============================================================
  // Первый запуск / настройка
  // ============================================================

  function needsSetup() {
    return !state.myId || !localStorage.getItem(LS.signaling);
  }

  el('setup-continue').addEventListener('click', () => {
    const name = el('setup-name').value.trim();
    const signaling = el('setup-signaling').value.trim();
    const err = el('setup-error');
    if (!signaling || !/^wss?:\/\//.test(signaling)) {
      err.textContent = 'Укажите корректный адрес сервера (начинается с ws:// или wss://).';
      err.classList.remove('hidden');
      return;
    }
    if (!state.myId) {
      state.myId = genId();
      localStorage.setItem(LS.id, state.myId);
    }
    state.myName = name;
    localStorage.setItem(LS.name, name);
    localStorage.setItem(LS.signaling, signaling);
    startApp();
  });

  // ============================================================
  // Запуск приложения
  // ============================================================

  async function startApp() {
    setupScreen.classList.add('hidden');
    appScreen.classList.remove('hidden');
    myIdValue.textContent = formatId(state.myId);
    state.contacts = await idbGetAll('contacts');
    renderContacts();
    connectSignaling();
  }

  el('copy-id-btn').addEventListener('click', () => {
    navigator.clipboard.writeText(state.myId).then(() => {
      const btn = el('copy-id-btn');
      const old = btn.textContent;
      btn.textContent = 'Скопировано';
      setTimeout(() => (btn.textContent = old), 1200);
    });
  });

  // ============================================================
  // Сигнальный сервер (WebSocket)
  // ============================================================

  function connectSignaling() {
    const url = localStorage.getItem(LS.signaling);
    if (!url) return;
    signalingDot.className = 'status-dot connecting';
    signalingStatusText.textContent = 'подключение…';

    const ws = new WebSocket(url);
    state.ws = ws;

    ws.onopen = () => {
      state.wsReconnectDelay = 1000;
      send({ type: 'register', id: state.myId });
      resubscribe();
    };

    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      handleSignalingMessage(msg);
    };

    ws.onclose = () => {
      signalingDot.className = 'status-dot';
      signalingStatusText.textContent = 'нет связи с сервером — повтор…';
      setTimeout(connectSignaling, state.wsReconnectDelay);
      state.wsReconnectDelay = Math.min(state.wsReconnectDelay * 1.6, 15000);
    };

    ws.onerror = () => ws.close();
  }

  function send(obj) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(obj));
    }
  }

  function resubscribe() {
    const ids = state.contacts.map((c) => c.id);
    if (ids.length) send({ type: 'subscribe', ids });
  }

  function handleSignalingMessage(msg) {
    switch (msg.type) {
      case 'registered':
        signalingDot.className = 'status-dot online';
        signalingStatusText.textContent = 'в сети';
        break;
      case 'presence': {
        for (const [id, online] of Object.entries(msg.statuses)) {
          state.online.set(id, online);
        }
        renderContacts();
        updatePeerStatusUI();
        break;
      }
      case 'presence-update': {
        state.online.set(msg.id, msg.online);
        renderContacts();
        updatePeerStatusUI();
        if (msg.online) attemptDeliver(msg.id);
        break;
      }
      case 'signal':
        handleSignal(msg.from, msg.data);
        break;
      case 'error':
        if (msg.reason === 'peer_offline') {
          // Собеседник офлайн — сообщение остаётся в очереди, отправится
          // автоматически, как только придёт presence-update online:true.
        }
        break;
    }
  }

  // ============================================================
  // Контакты
  // ============================================================

  function renderContacts() {
    contactsList.innerHTML = '';
    if (state.contacts.length === 0) {
      const li = document.createElement('li');
      li.className = 'contacts-empty';
      li.textContent = 'Контактов пока нет. Обменяйтесь номерами с собеседником и добавление его.";
      contactsList.appendChild(li);
      return;
    }
    state.contacts.forEach((c) => {
      const li = document.createElement('li');
      li.className = 'contact-item' + (c.id === state.activePeerId ? ' active' : '');
      const isOnline = state.online.get(c.id);
      li.innerHTML = `
        <span class="avatar">${initials(c.name || c.id)}</span>
        <span class="contact-text">
          <div class="contact-name">${escapeHtml(c.name || 'Без имени')}</div>
          <div class="contact-id mono">${formatId(c.id)}</div>
        </span>
        <span class="status-dot ${isOnline ? 'online' : ''}"></span>
        <button type="button" class="contact-delete-btn" title="Удалить контакт">✕</button>
      `;
      li.addEventListener('click', () => openChat(c.id));
      li.querySelector('.contact-delete-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        deleteContact(c.id, c.name);
      });
      contactsList.appendChild(li);
    });
  }

  el('add-contact-btn').addEventListener('click', () => {
    el('contact-id-input').value = '';
    el('contact-name-input').value = '';
    el('add-contact-error').classList.add('hidden');
    el('add-contact-modal').classList.remove('hidden');
  });
  el('add-contact-cancel').addEventListener('click', () => el('add-contact-modal').classList.add('hidden'));

  el('add-contact-confirm').addEventListener('click', async () => {
    const id = el('contact-id-input').value.replace(/\D/g, '');
    const name = el('contact-name-input').value.trim();
    const err = el('add-contact-error');
    if (!/^\d{9}$/.test(id)) {
      err.textContent = 'Номер должен состоять из 9 цифр.';
      err.classList.remove('hidden');
      return;
    }
    if (id === state.myId) {
      err.textContent = 'Это ваш собственный номер.';
      err.classList.remove('hidden');
      return;
    }
    if (state.contacts.some((c) => c.id === id)) {
      err.textContent = 'Такой контакт уже добавлен.';
      err.classList.remove('hidden');
      return;
    }
    const contact = { id, name: name || formatId(id), addedAt: Date.now() };
    await idbPut('contacts', contact);
    state.contacts.push(contact);
    renderContacts();
    resubscribe();
    el('add-contact-modal').classList.add('hidden');
  });

  async function deleteContact(peerId, name) {
    const ok = confirm(`Удалить контакт «${name || formatId(peerId)}«? Переписка с ним тоже будет удалена с этого устройства.`);
    if (!ok) return;

    cleanupPeerConnection(peerId);

    await idbDelete('contacts', peerId);
    const msgs = await idbGetByIndex('messages', 'peerId', peerId);
    for (const m of msgs) {
      await idbDelete('messages', m.msgId);
    }

    state.contacts = state.contacts.filter((c) => c.id !== peerId);
    state.online.delete(peerId);
    state.peers.delete(peerId);

    if (state.activePeerId === peerId) {
      state.activePeerId = null;
      chatActive.classList.add('hidden');
      chatEmpty.classList.remove('hidden');
      backBtn.classList.add('hidden');
    }

    renderContacts();
  }

  // ============================================================
  // Настройки
  // ============================================================

  el('settings-btn').addEventListener('click', () => {
    el('settings-name').value = state.myName;
    el('settings-signaling').value = localStorage.getItem(LS.signaling) || '';
    el('settings-turn-url').value = localStorage.getItem(LS.turnUrl) || '';
    el('settings-turn-user').value = localStorage.getItem(LS.turnUser) || '';
    el('settings-turn-pass').value = localStorage.getItem(LS.turnPass) || '';
    updateNotificationsUI();
    el('settings-modal').classList.remove('hidden');
  });

  function updateNotificationsUI() {
    const statusEl = el('notifications-status');
    const btn = el('notifications-enable-btn');
    if (!('Notification' in window)) {
      statusEl.textContent = 'браузер не поддерживает уведомления';
      btn.classList.add('hidden');
      return;
    }
    if (Notification.permission === 'granted') {
      statusEl.textContent = 'включены - придёт уведомление о новом сообщении';
      btn.classList.add('hidden');
    } else if (Notification.permission === 'denied') {
      statusEl.textContent = 'запрещены в браузере — включите вручную в настройках сайта браузера';
      btn.classList.add('hidden');
    } else {
      statusEl.textContent = 'пока не разрешены';
      btn.classList.remove('hidden');
    }
  }

  el('notifications-enable-btn').addEventListener('click', async () => {
    if (!('Notification' in window)) return;
    await Notification.requestPermission();
    updateNotificationsUI();
  });

  function notifyNewMessage(peerId, text) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    // Не отпугиваем уведомлением, если вкладка открыта и переписка с этим
    // собеседником уже на экране — тогда сообщение и так видно.
    if (!document.hidden && state.activePeerId === peerId) return;
    const contact = state.contacts.find((c) => c.id === peerId);
    const title = contact ? contact.name : 'Новое сообщение';
    const notification = new Notification(title, { body: text, tag: 'p2p-msg-' + peerId });
    notification.onclick = () => {
      window.focus();
      openChat(peerId);
      notification.close();
    };
  }
  el('settings-cancel').addEventListener('click', () => el('settings-modal').classList.add('hidden'));

  el('settings-save').addEventListener('click', () => {
    const newName = el('settings-name').value.trim();
    const newSignaling = el('settings-signaling').value.trim();
    state.myName = newName;
    localStorage.setItem(LS.name, newName);
    localStorage.setItem(LS.turnUrl, el('settings-turn-url').value.trim());
    localStorage.setItem(LS.turnUser, el('settings-turn-user').value.trim());
    localStorage.setItem(LS.turnPass, el('settings-turn-pass').value.trim());
    const signalingChanged = newSignaling !== localStorage.getItem(LS.signaling);
    if (newSignaling) localStorage.setItem(LS.signaling, newSignaling);
    el('settings-modal').classList.add('hidden');
    if (signalingChanged && state.ws) {
      state.ws.close();
    }
  });

  // ============================================================
  // Отрисовка чата
  // ============================================================

  async function openChat(peerId) {
    state.activePeerId = peerId;
    const contact = state.contacts.find((c) => c.id === peerId);
    if (!contact) return;

    chatEmpty.classList.add('hidden');
    chatActive.classList.remove('hidden');
    peerAvatar.textContent = initials(contact.name);
    peerName.textContent = contact.name;
    updatePeerStatusUI();

    sidebar.classList.remove('mobile-visible');
    backBtn.classList.remove('hidden');
    renderContacts();

    // чистим старые blob-URL перед перерисовкой
    state.objectUrls.forEach((u) => URL.revokeObjectURL(u));
    state.objectUrls = [];

    messagesEl.innerHTML = '';
    const msgs = (await idbGetByIndex('messages', 'peerId', peerId)).sort((a, b) => a.createdAt - b.createdAt);
    msgs.forEach(renderMessage);
    scrollToBottom();

    attemptDeliver(peerId);
  }

  backBtn.addEventListener('click', () => sidebar.classList.add('mobile-visible'));

  function updatePeerStatusUI() {
    if (!state.activePeerId) return;
    const peerConn = state.peers.get(state.activePeerId);
    const connected = peerConn && peerConn.dc && peerConn.dc.readyState === 'open';
    const online = state.online.get(state.activePeerId);
    if (connected) {
      peerStatusDot.className = 'status-dot online';
      peerStatusText.textContent = 'соединение установлено';
    } else if (online) {
      peerStatusDot.className = 'status-dot connecting';
      peerStatusText.textContent = 'в сети — соединяемс…';
    } else {
      peerStatusDot.className = 'status-dot';
      peerStatusText.textContent = 'офлайн — сообщения будут отправлены, когда появится';
    }
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // ============================================================
  // Отрисовка сообщений
  // ============================================================

  function renderMessage(m) {
    const row = document.createElement('div');
    row.className = 'msg-row' + (m.direction === 'out' ? ' mine' : '');
    row.dataset.msgId = m.msgId;

    const bubble = document.createElement('div');
    bubble.className = 'bubble';

    if (m.kind === 'text') {
      const p = document.createElement('div');
      p.textContent = m.text;
      bubble.appendChild(p);
    } else if (m.kind === 'image' && m.blob) {
      const img = document.createElement('img');
      img.src = trackedUrl(m.blob);
      bubble.appendChild(img);
    } else if (m.kind === 'video' && m.blob) {
      const vid = document.createElement('video');
      vid.src = trackedUrl(m.blob);
      vid.controls = true;
      bubble.appendChild(vid);
    } else if (m.blob) {
      const a = document.createElement('a');
      a.className = 'file-chip';
      a.href = trackedUrl(m.blob);
      a.download = m.fileName || 'файл';
      a.innerHTML = `📄 <span>${escapeHtml(m.fileName || 'файл')}${m.fileSize ? ` · ${fmtSize(m.fileSize)}` : ''}</span>`;
      bubble.appendChild(a);
    } else {
      // файл ещё передаётся
      const label = document.createElement('div');
      label.textContent = `📎 ${m.fileName || 'файл'}${m.fileSize ? ` · ${fmtSize(m.fileSize)}` : ''}`;
      bubble.appendChild(label);
      const bar = document.createElement('div');
      bar.className = 'transfer-progress';
      bar.innerHTML = '<div class="transfer-progress-bar"></div>';
      bubble.appendChild(bar);
    }

    const meta = document.createElement('div');
    meta.className = 'bubble-meta';
    const time = document.createElement('span');
    time.textContent = fmtTime(m.createdAt);
    meta.appendChild(time);
    if (m.direction === 'out') {
      const status = document.createElement('span');
      status.textContent = m.status === 'pending' ? '· ожидает' : m.status === 'sent' ? '· отправлено' : '';
      meta.appendChild(status);
    }
    bubble.appendChild(meta);

    row.appendChild(bubble);
    messagesEl.appendChild(row);
    return row;
  }

  function updateMessageProgress(msgId, fraction) {
    const row = messagesEl.querySelector(`[data-msg-id="${msgId}"]`);
    if (!row) return;
    const bar = row.querySelector('.transfer-progress-bar');
    if (bar) bar.style.width = `${Math.round(fraction * 100)}%`;
  }

  function replaceMessageRow(m) {
    const old = messagesEl.querySelector(`[data-msg-id="${m.msgId}"]`);
    const row = renderMessage(m);
    if (old) {
      old.replaceWith(row);
    }
  }

  // ============================================================
  // Отправка: текст и файлы
  // ============================================================

  messageForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = textInput.value.trim();
    if (!text || !state.activePeerId) return;
    textInput.value = '';
    const msg = {
      msgId: crypto.randomUUID(),
      peerId: state.activePeerId,
      direction: 'out',
      kind: 'text',
      text,
      createdAt: Date.now(),
      status: 'pending',
    };
    await idbPut('messages', msg);
    if (state.activePeerId) { renderMessage(msg); scrollToBottom(); }
    attemptDeliver(state.activePeerId);
  });

  attachBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async () => {
    if (!fileInput.files.length || !state.activePeerId) return;
    const file = fileInput.files[0];
    const kind = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : 'file';
    const msg = {
      msgId: crypto.randomUUID(),
      peerId: state.activePeerId,
      direction: 'out',
      kind,
      blob: file,
      fileName: file.name,
      mimeType: file.type || 'application/octet-stream',
      fileSize: file.size,
      createdAt: Date.now(),
      status: 'pending',
    };
    await idbPut('messages', msg);
    if (state.activePeerId) { renderMessage(msg); scrollToBottom(); }
    fileInput.value = '';
    attemptDeliver(state.activePeerId);
  });

  // Очередь �
 отправку для каждого собеседника обрабатывается по одному
  // сообщению за раз (чтобы не мешать несколько файлов в одном канале).
  async function attemptDeliver(peerId) {
    const peerConn = getOrCreatePeerConn(peerId);
    if (peerConn.sending) return;
    if (!peerConn.dc || peerConn.dc.readyState !== 'open') {
      if (state.online.get(peerId)) connectToPeer(peerId);
      return;
    }
    const pending = (await idbGetByIndex('messages', 'peerId', peerId))
      .filter((m) => m.direction === 'out' && m.status === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt);
    if (!pending.length) return;

    peerConn.sending = true;
    for (const m of pending) {
      if (!peerConn.dc || peerConn.dc.readyState !== 'open') break;
      try {
        if (m.kind === 'text') {
          peerConn.dc.send(JSON.stringify({ kind: 'text', msgId: m.msgId, text: m.text, ts: m.createdAt }));
        } else {
          await sendFileOverChannel(peerConn.dc, m);
        }
        m.status = 'sent';
        await idbPut('messages', m);
        if (state.activePeerId === peerId) updateBubbleStatus(m);
      } catch (err) {
        console.error('Не удалось отправить сообщение, останется в очереди:', err);
        break;
      }
    }
    peerConn.sending = false;
  }

  function updateBubbleStatus(m) {
    const row = messagesEl.querySelector(`[data-msg-id="${m.msgId}"]`);
    if (!row) return;
    const statusEl = row.querySelector('.bubble-meta span:last-child');
    if (statusEl) statusEl.textContent = '· отправлено';
  }

  const CHUNK_SIZE = 16 * 1024;
  const BUFFERED_AMOUNT_LOW_THRESHOLD = 256 * 1024;

  async function sendFileOverChannel(dc, m) {
    dc.send(JSON.stringify({
      kind: 'file-meta', msgId: m.msgId, name: m.fileName, mime: m.mimeType, size: m.fileSize, ts: m.createdAt,
    }));
    const buf = await m.blob.arrayBuffer();
    let offset = 0;
    dc.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW_THRESHOLD;
    while (offset < buf.byteLength) {
      if (dc.readyState !== 'open') throw new Error('канал закрылся во время передачи');
      if (dc.bufferedAmount > BUFFERED_AMOUNT_LOW_THRESHOLD) {
        await new Promise((resolve) => {
          dc.addEventListener('bufferedamountlow', resolve, { once: true });
        });
      }
      const chunk = buf.slice(offset, offset + CHUNK_SIZE);
      dc.send(chunk);
      offset += CHUNK_SIZE;
      if (state.activePeerId === m.peerId) updateMessageProgress(m.msgId, offset / buf.byteLength);
    }
    dc.send(JSON.stringify({ kind: 'file-end', msgId: m.msgId }));
  }

  // ============================================================
  // WebRTC: установление соединения
  // ============================================================

  function getOrCreatePeerConn(peerId) {
    if (!state.peers.has(peerId)) {
      state.peers.set(peerId, { pc: null, dc: null, incomingFile: null, sending: false, makingOffer: false, pendingCandidates: [] });
    }
    return state.peers.get(peerId);
  }

  function createPeerConnection(peerId) {
    const pc = new RTCPeerConnection({ iceServers: iceServers() });
    const peerConn = getOrCreatePeerConn(peerId);
    peerConn.pc = pc;

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        send({ type: 'signal', to: peerId, data: { type: 'candidate', candidate: e.candidate } });
      }
    };

    pc.onconnectionstatechange = () => {
      if (state.activePeerId === peerId) updatePeerStatusUI();
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        cleanupPeerConnection(peerId);
      }
    };

    pc.ondatachannel = (e) => {
      setupDataChannel(peerId, e.channel);
    };

    return pc;
  }

  function connectToPeer(peerId) {
    const peerConn = getOrCreatePeerConn(peerId);
    if (peerConn.pc) return; // уже соединяемся или соединены
    const pc = createPeerConnection(peerId);
    const dc = pc.createDataChannel('chat', { ordered: true });
    setupDataChannel(peerId, dc);

    peerConn.makingOffer = true;
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() => {
        send({ type: 'signal', to: peerId, data: { type: 'offer', sdp: pc.localDescription } });
      })
      .catch((err) => console.error('Ошибка создания offer:', err))
      .finally(() => { peerConn.makingOffer = false; });
  }

  function setupDataChannel(peerId, dc) {
    const peerConn = getOrCreatePeerConn(peerId);
    peerConn.dc = dc;
    dc.binaryType = 'arraybuffer';

    dc.onopen = () => {
      if (state.activePeerId === peerId) updatePeerStatusUI();
      attemptDeliver(peerId);
    };
    dc.onclose = () => {
      if (state.activePeerId === peerId) updatePeerStatusUI();
    };
    dc.onmessage = (e) => handleChannelMessage(peerId, e.data);
  }

  function handleChannelMessage(peerId, data) {
    const peerConn = getOrCreatePeerConn(peerId);

    if (typeof data === 'string') {
      let ctrl;
      try { ctrl = JSON.parse(data); } catch { return; }

      if (ctrl.kind === 'text') {
        const m = {
          msgId: ctrl.msgId || crypto.randomUUID(),
          peerId,
          direction: 'in',
          kind: 'text',
          text: ctrl.text,
          createdAt: ctrl.ts || Date.now(),
          status: 'received',
        };
        idbPut('messages', m);
        if (state.activePeerId === peerId) { renderMessage(m); scrollToBottom(); }
        notifyNewMessage(peerId, ctrl.text);

      } else if (ctrl.kind === 'file-meta') {
        peerConn.incomingFile = {
          msgId: ctrl.msgId, name: ctrl.name, mime: ctrl.mime, size: ctrl.size,
          chunks: [], received: 0,
        };
        const placeholder = {
          msgId: ctrl.msgId, peerId, direction: 'in',
          kind: (ctrl.mime || '').startsWith('image/') ? 'image' : (ctrl.mime || '').startsWith('video/') ? 'video' : 'file',
          fileName: ctrl.name, fileSize: ctrl.size, mimeType: ctrl.mime,
          createdAt: ctrl.ts || Date.now(), status: 'receiving',
        };
        if (state.activePeerId === peerId) { renderMessage(placeholder); scrollToBottom(); }

      } else if (ctrl.kind === 'file-end') {
        const incoming = peerConn.incomingFile;
        if (!incoming || incoming.msgId !== ctrl.msgId) return;
        const blob = new Blob(incoming.chunks, { type: incoming.mime || 'application/octet-stream' });
        const m = {
          msgId: incoming.msgId, peerId, direction: 'in',
          kind: (incoming.mime || '').startsWith('image/') ? 'image' : (incoming.mime || '').startsWith('video/') ? 'video' : 'file',
          blob, fileName: incoming.name, fileSize: incoming.size, mimeType: incoming.mime,
          createdAt: Date.now(), status: 'received',
        };
        idbPut('messages', m);
        peerConn.incomingFile = null;
        if (state.activePeerId === peerId) replaceMessageRow(m);
        notifyNewMessage(peerId, m.kind === 'image' ? '📷 Фото' : m.kind === 'video' ? '🎞 Видео' : `📎 ${m.fileName || 'Файл'}`);
      }
    } else {
      // бинарный чанк файла
      const incoming = peerConn.incomingFile;
      if (!incoming) return;
      incoming.chunks.push(data);
      incoming.received += data.byteLength;
      if (state.activePeerId === peerId) updateMessageProgress(incoming.msgId, incoming.received / incoming.size);
    }
  }

  function cleanupPeerConnection(peerId) {
    const peerConn = state.peers.get(peerId);
    if (!peerConn) return;
    if (peerConn.pc) { try { peerConn.pc.close(); } catch {} }
    state.peers.delete(peerId);
    if (state.activePeerId === peerId) updatePeerStatusUI();
  }

  // ============================================================
  // Обработка входящих сигналов (offer/answer/candidate)
  // ============================================================

  async function handleSignal(from, data) {
    // Принимаем соединения только от уже добавленных контактов.
    if (!state.contacts.some((c) => c.id === from)) return;

    const peerConn = getOrCreatePeerConn(from);
    let pc = peerConn.pc;

    async function flushPendingCandidates() {
      const queued = peerConn.pendingCandidates;
      peerConn.pendingCandidates = [];
      for (const c of queued) {
        try { await pc.addIceCandidate(c); } catch (err) { console.warn('ICE candidate error:', err); }
      }
    }

    if (data.type === 'offer') {
      const polite = state.myId < from;
      const offerCollision = peerConn.makingOffer || (pc && pc.signalingState !== 'stable');
      if (offerCollision && !polite) {
        return; // мы "невежливый" узел — игнорируем встречное предложение, наше должно победить
      }
      if (!pc) pc = createPeerConnection(from);
      if (offerCollision && polite) {
        await Promise.all([
          pc.setLocalDescription({ type: 'rollback' }).catch(() => {}),
        ]);
      }
      await pc.setRemoteDescription(data.sdp);
      await flushPendingCandidates();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({ type: 'signal', to: from, data: { type: 'answer', sdp: pc.localDescription } });

    } else if (data.type === 'answer') {
      if (!pc) return;
      if (pc.signalingState !== 'have-local-offer') return;
      await pc.setRemoteDescription(data.sdp);
      await flushPendingCandidates();

    } else if (data.type === 'candidate') {
      if (!pc) return; // кандидат от узла, с которым мы ещё не начали соединение — нечего буферизовать
      if (pc.remoteDescription) {
        try { await pc.addIceCandidate(data.candidate); } catch (err) { console.warn('ICE candidate error:', err); }
      } else {
        peerConn.pendingCandidates.push(data.candidate);
      }
    }
  }

  // ============================================================
  // Инициализация
  // ============================================================

  if (needsSetup()) {
    el('setup-name').value = state.myName;
    el('setup-signaling').value = localStorage.getItem(LS.signaling) || '';
  } else {
    startApp();
  }
})();
(() => {
  'use strict';

  // ============================================================
  // Настройки / локальное хранилище
  // ============================================================

  const LS = {
    id: 'p2p_id',
    name: 'p2p_name',
    signaling: 'p2p_signaling_url',
    turnUrl: 'p2p_turn_url',
    turnUser: 'p2p_turn_user',
    turnPass: 'p2p_turn_pass',
  };

  function genId() {
    const bytes = new Uint32Array(3);
    crypto.getRandomValues(bytes);
    let n = (bytes[0] ^ bytes[1] ^ bytes[2]) % 1000000000;
    return String(Math.abs(n)).padStart(9, '0');
  }

  function formatId(id) {
    return id.replace(/(\d{3})(\d{3})(\d{3})/, '$1 $2 $3');
  }

  function iceServers() {
    const servers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ];
    const turnUrl = localStorage.getItem(LS.turnUrl);
    if (turnUrl) {
      servers.push({
        urls: turnUrl,
        username: localStorage.getItem(LS.turnUser) || undefined,
        credential: localStorage.getItem(LS.turnPass) || undefined,
      });
    }
    return servers;
  }

  // ============================================================
  // IndexedDB: контакты и сообщения (включая вложения-Blob)
  // ============================================================

  let dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open('p2p-messenger-db', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('contacts')) {
        db.createObjectStore('contacts', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('messages')) {
        const store = db.createObjectStore('messages', { keyPath: 'msgId' });
        store.createIndex('peerId', 'peerId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  async function idbPut(storeName, value) {
    const db = await dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(value);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function idbGetAll(storeName) {
    const db = await dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbGetByIndex(storeName, indexName, value) {
    const db = await dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).index(indexName).getAll(value);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbDelete(storeName, key) {
    const db = await dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ============================================================
  // Состояние приложения
  // ============================================================

  const state = {
    myId: localStorage.getItem(LS.id),
    myName: localStorage.getItem(LS.name) || '',
    contacts: [], // { id, name, addedAt }
    online: new Map(), // peerId -> bool (по данным сигнального сервера)
    peers: new Map(), // peerId -> { pc, dc, incomingFile, outbox, sending }
    activePeerId: null,
    objectUrls: [], // созданные URL.createObjectURL — чистим при смене чата
    ws: null,
    wsReconnectDelay: 1000,
  };

  // ============================================================
  // Элементы DOM
  // ============================================================

  const el = (id) => document.getElementById(id);
  const setupScreen = el('setup-screen');
  const appScreen = el('app-screen');
  const myIdValue = el('my-id-value');
  const signalingDot = el('signaling-dot');
  const signalingStatusText = el('signaling-status-text');
  const contactsList = el('contacts-list');
  const chatEmpty = el('chat-empty');
  const chatActive = el('chat-active');
  const peerAvatar = el('peer-avatar');
  const peerName = el('peer-name');
  const peerStatusDot = el('peer-status-dot');
  const peerStatusText = el('peer-status-text');
  const messagesEl = el('messages');
  const messageForm = el('message-form');
  const textInput = el('text-input');
  const attachBtn = el('attach-btn');
  const fileInput = el('file-input');
  const backBtn = el('back-btn');
  const sidebar = document.querySelector('.sidebar');

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
  function initials(name) {
    return (name || '?').trim().slice(0, 2).toUpperCase();
  }
  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }
  function fmtSize(bytes) {
    if (bytes < 1024) return `${bytes} Б`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
  }
  function trackedUrl(blob) {
    const url = URL.createObjectURL(blob);
    state.objectUrls.push(url);
    return url;
  }

  // ============================================================
  // Первый запуск / настройка
  // ============================================================

  function needsSetup() {
    return !state.myId || !localStorage.getItem(LS.signaling);
  }

  el('setup-continue').addEventListener('click', () => {
    const name = el('setup-name').value.trim();
    const signaling = el('setup-signaling').value.trim();
    const err = el('setup-error');
    if (!signaling || !/^wss?:\/\//.test(signaling)) {
      err.textContent = 'Укажите корректный адрес сервера (начинается с ws:// или wss://).';
      err.classList.remove('hidden');
      return;
    }
    if (!state.myId) {
      state.myId = genId();
      localStorage.setItem(LS.id, state.myId);
    }
    state.myName = name;
    localStorage.setItem(LS.name, name);
    localStorage.setItem(LS.signaling, signaling);
    startApp();
  });

  // ============================================================
  // Запуск приложения
  // ============================================================

  async function startApp() {
    setupScreen.classList.add('hidden');
    appScreen.classList.remove('hidden');
    myIdValue.textContent = formatId(state.myId);
    state.contacts = await idbGetAll('contacts');
    renderContacts();
    connectSignaling();
  }

  el('copy-id-btn').addEventListener('click', () => {
    navigator.clipboard.writeText(state.myId).then(() => {
      const btn = el('copy-id-btn');
      const old = btn.textContent;
      btn.textContent = 'Скопировано';
      setTimeout(() => (btn.textContent = old), 1200);
    });
  });

  // ============================================================
  // Сигнальный сервер (WebSocket)
  // ============================================================

  function connectSignaling() {
    const url = localStorage.getItem(LS.signaling);
    if (!url) return;
    signalingDot.className = 'status-dot connecting';
    signalingStatusText.textContent = 'подключение…';

    const ws = new WebSocket(url);
    state.ws = ws;

    ws.onopen = () => {
      state.wsReconnectDelay = 1000;
      send({ type: 'register', id: state.myId });
      resubscribe();
    };

    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      handleSignalingMessage(msg);
    };

    ws.onclose = () => {
      signalingDot.className = 'status-dot';
      signalingStatusText.textContent = 'нет связи с сервером — повтор…';
      setTimeout(connectSignaling, state.wsReconnectDelay);
      state.wsReconnectDelay = Math.min(state.wsReconnectDelay * 1.6, 15000);
    };

    ws.onerror = () => ws.close();
  }

  function send(obj) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(obj));
    }
  }

  function resubscribe() {
    const ids = state.contacts.map((c) => c.id);
    if (ids.length) send({ type: 'subscribe', ids });
  }

  function handleSignalingMessage(msg) {
    switch (msg.type) {
      case 'registered':
        signalingDot.className = 'status-dot online';
        signalingStatusText.textContent = 'в сети';
        break;
      case 'presence': {
        for (const [id, online] of Object.entries(msg.statuses)) {
          state.online.set(id, online);
        }
        renderContacts();
        updatePeerStatusUI();
        break;
      }
      case 'presence-update': {
        state.online.set(msg.id, msg.online);
        renderContacts();
        updatePeerStatusUI();
        if (msg.online) attemptDeliver(msg.id);
        break;
      }
      case 'signal':
        handleSignal(msg.from, msg.data);
        break;
      case 'error':
        if (msg.reason === 'peer_offline') {
          // Собеседник офлайн — сообщение остаётся в очереди, отправится
          // автоматически, как только придёт presence-update online:true.
        }
        break;
    }
  }

  // ============================================================
  // Контакты
  // ============================================================

  function renderContacts() {
    contactsList.innerHTML = '';
    if (state.contacts.length === 0) {
      const li = document.createElement('li');
      li.className = 'contacts-empty';
      li.textContent = 'Контактов пока нет. Обменяйтесь номерами с собеседником и добавление его.";
      contactsList.appendChild(li);
      return;
    }
    state.contacts.forEach((c) => {
      const li = document.createElement('li');
      li.className = 'contact-item' + (c.id === state.activePeerId ? ' active' : '');
      const isOnline = state.online.get(c.id);
      li.innerHTML = `
        <span class="avatar">${initials(c.name || c.id)}</span>
        <span class="contact-text">
          <div class="contact-name">${escapeHtml(c.name || 'Без имени')}</div>
          <div class="contact-id mono">${formatId(c.id)}</div>
        </span>
        <span class="status-dot ${isOnline ? 'online' : ''}"></span>
        <button type="button" class="contact-delete-btn" title="Удалить контакт">✕</button>
      `;
      li.addEventListener('click', () => openChat(c.id));
      li.querySelector('.contact-delete-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        deleteContact(c.id, c.name);
      });
      contactsList.appendChild(li);
    });
  }

  el('add-contact-btn').addEventListener('click', () => {
    el('contact-id-input').value = '';
    el('contact-name-input').value = '';
    el('add-contact-error').classList.add('hidden');
    el('add-contact-modal').classList.remove('hidden');
  });
  el('add-contact-cancel').addEventListener('click', () => el('add-contact-modal').classList.add('hidden'));

  el('add-contact-confirm').addEventListener('click', async () => {
    const id = el('contact-id-input').value.replace(/\D/g, '');
    const name = el('contact-name-input').value.trim();
    const err = el('add-contact-error');
    if (!/^\d{9}$/.test(id)) {
      err.textContent = 'Номер должен состоять из 9 цифр.';
      err.classList.remove('hidden');
      return;
    }
    if (id === state.myId) {
      err.textContent = 'Это ваш собственный номер.';
      err.classList.remove('hidden');
      return;
    }
    if (state.contacts.some((c) => c.id === id)) {
      err.textContent = 'Такой контакт уже добавлен.';
      err.classList.remove('hidden');
      return;
    }
    const contact = { id, name: name || formatId(id), addedAt: Date.now() };
    await idbPut('contacts', contact);
    state.contacts.push(contact);
    renderContacts();
    resubscribe();
    el('add-contact-modal').classList.add('hidden');
  });

  async function deleteContact(peerId, name) {
    const ok = confirm(`Удалить контакт «${name || formatId(peerId)}«? Переписка с ним тоже будет удалена с этого устройства.`);
    if (!ok) return;

    cleanupPeerConnection(peerId);

    await idbDelete('contacts', peerId);
    const msgs = await idbGetByIndex('messages', 'peerId', peerId);
    for (const m of msgs) {
      await idbDelete('messages', m.msgId);
    }

    state.contacts = state.contacts.filter((c) => c.id !== peerId);
    state.online.delete(peerId);
    state.peers.delete(peerId);

    if (state.activePeerId === peerId) {
      state.activePeerId = null;
      chatActive.classList.add('hidden');
      chatEmpty.classList.remove('hidden');
      backBtn.classList.add('hidden');
    }

    renderContacts();
  }

  // ============================================================
  // Настройки
  // ============================================================

  el('settings-btn').addEventListener('click', () => {
    el('settings-name').value = state.myName;
    el('settings-signaling').value = localStorage.getItem(LS.signaling) || '';
    el('settings-turn-url').value = localStorage.getItem(LS.turnUrl) || '';
    el('settings-turn-user').value = localStorage.getItem(LS.turnUser) || '';
    el('settings-turn-pass').value = localStorage.getItem(LS.turnPass) || '';
    updateNotificationsUI();
    el('settings-modal').classList.remove('hidden');
  });

  function updateNotificationsUI() {
    const statusEl = el('notifications-status');
    const btn = el('notifications-enable-btn');
    if (!('Notification' in window)) {
      statusEl.textContent = 'браузер не поддерживает уведомления';
      btn.classList.add('hidden');
      return;
    }
    if (Notification.permission === 'granted') {
      statusEl.textContent = 'включены - придёт уведомление о новом сообщении';
      btn.classList.add('hidden');
    } else if (Notification.permission === 'denied') {
      statusEl.textContent = 'запрещены в браузере — включите вручную в настройках сайта браузера';
      btn.classList.add('hidden');
    } else {
      statusEl.textContent = 'пока не разрешены';
      btn.classList.remove('hidden');
    }
  }

  el('notifications-enable-btn').addEventListener('click', async () => {
    if (!('Notification' in window)) return;
    await Notification.requestPermission();
    updateNotificationsUI();
  });

  function notifyNewMessage(peerId, text) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    // Не отпугиваем уведомлением, если вкладка открыта и переписка с этим
    // собеседником уже на экране — тогда сообщение и так видно.
    if (!document.hidden && state.activePeerId === peerId) return;
    const contact = state.contacts.find((c) => c.id === peerId);
    const title = contact ? contact.name : 'Новое сообщение';
    const notification = new Notification(title, { body: text, tag: 'p2p-msg-' + peerId });
    notification.onclick = () => {
      window.focus();
      openChat(peerId);
      notification.close();
    };
  }
  el('settings-cancel').addEventListener('click', () => el('settings-modal').classList.add('hidden'));

  el('settings-save').addEventListener('click', () => {
    const newName = el('settings-name').value.trim();
    const newSignaling = el('settings-signaling').value.trim();
    state.myName = newName;
    localStorage.setItem(LS.name, newName);
    localStorage.setItem(LS.turnUrl, el('settings-turn-url').value.trim());
    localStorage.setItem(LS.turnUser, el('settings-turn-user').value.trim());
    localStorage.setItem(LS.turnPass, el('settings-turn-pass').value.trim());
    const signalingChanged = newSignaling !== localStorage.getItem(LS.signaling);
    if (newSignaling) localStorage.setItem(LS.signaling, newSignaling);
    el('settings-modal').classList.add('hidden');
    if (signalingChanged && state.ws) {
      state.ws.close();
    }
  });

  // ============================================================
  // Отрисовка чата
  // ============================================================

  async function openChat(peerId) {
    state.activePeerId = peerId;
    const contact = state.contacts.find((c) => c.id === peerId);
    if (!contact) return;

    chatEmpty.classList.add('hidden');
    chatActive.classList.remove('hidden');
    peerAvatar.textContent = initials(contact.name);
    peerName.textContent = contact.name;
    updatePeerStatusUI();

    sidebar.classList.remove('mobile-visible');
    backBtn.classList.remove('hidden');
    renderContacts();

    // чистим старые blob-URL перед перерисовкой
    state.objectUrls.forEach((u) => URL.revokeObjectURL(u));
    state.objectUrls = [];

    messagesEl.innerHTML = '';
    const msgs = (await idbGetByIndex('messages', 'peerId', peerId)).sort((a, b) => a.createdAt - b.createdAt);
    msgs.forEach(renderMessage);
    scrollToBottom();

    attemptDeliver(peerId);
  }

  backBtn.addEventListener('click', () => sidebar.classList.add('mobile-visible'));

  function updatePeerStatusUI() {
    if (!state.activePeerId) return;
    const peerConn = state.peers.get(state.activePeerId);
    const connected = peerConn && peerConn.dc && peerConn.dc.readyState === 'open';
    const online = state.online.get(state.activePeerId);
    if (connected) {
      peerStatusDot.className = 'status-dot online';
      peerStatusText.textContent = 'соединение установлено';
    } else if (online) {
      peerStatusDot.className = 'status-dot connecting';
      peerStatusText.textContent = 'в сети — соединяемс…';
    } else {
      peerStatusDot.className = 'status-dot';
      peerStatusText.textContent = 'офлайн — сообщения будут отправлены, когда появится';
    }
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // ============================================================
  // Отрисовка сообщений ходтнойцепаки (offer/answer/candidate)
  // ============================================================

  async function handleSignal(from, data) {
    // Принимаем соединения только от уже добавленных контактов.
    if (!state.contacts.some((c) => c.id === from)) return;

    const peerConn = getOrCreatePeerConn(from);
    let pc = peerConn.pc;

    async function flushPendingCandidates() {
      const queued = peerConn.pendingCandidates;
      peerConn.pendingCandidates = [];
      for (const c of queued) {
        try { await pc.addIceCandidate(c); } catch (err) { console.warn('ICE candidate error:', err); }
      }
    }

    if (data.type === 'offer') {
      const polite = state.myId < from;
      const offerCollision = peerConn.makingOffer || (pc && pc.signalingState !== 'stable');
      if (offerCollision && !polite) {
        return; // мы "невежливый" узел — игнорируем встречное предложение, наше должно победить
      }
      if (!pc) pc = createPeerConnection(from);
      if (offerCollision && polite) {
        await Promise.all([
          pc.setLocalDescription({ type: 'rollback' }).catch(() => {}),
        ]);
      }
      await pc.setRemoteDescription(data.sdp);
      await flushPendingCandidates();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({ type: 'signal', to: from, data: { type: 'answer', sdp: pc.localDescription } });

    } else if (data.type === 'answer') {
      if (!pc) return;
      if (pc.signalingState !== 'have-local-offer') return;
      await pc.setRemoteDescription(data.sdp);
      await flushPendingCandidates();

    } else if (data.type === 'candidate') {
      if (!pc) return; // кандидат от узла, с которым мы ещё не начали соединение — нечего буферизовать
      if (pc.remoteDescription) {
        try { await pc.addIceCandidate(data.candidate); } catch (err) { console.warn('ICE candidate error:', err); }
      } else {
        peerConn.pendingCandidates.push(data.candidate);
      }
    }
  }

  // ============================================================
  // Инициализация
  // ============================================================

  if (needsSetup()) {
    el('setup-name').value = state.myName;
    el('setup-signaling').value = localStorage.getItem(LS.signaling) || '';
  } else {
    startApp();
  }
})();
