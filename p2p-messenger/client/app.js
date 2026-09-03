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
