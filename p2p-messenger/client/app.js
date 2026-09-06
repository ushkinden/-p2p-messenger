(() => {
  'use strict';

  let vhRaf = null;
  function setVhVar() {
    if (vhRaf) return;
    vhRaf = requestAnimationFrame(() => {
      vhRaf = null;
      const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
      document.documentElement.style.setProperty('--vh', (h * 0.01) + 'px');
    });
  }
  setVhVar();
  window.addEventListener('resize', setVhVar);
  window.addEventListener('orientationchange', setVhVar);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', setVhVar);
  }

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
    pinSalt: 'p2p_pin_salt',
    pinVerifierIv: 'p2p_pin_verifier_iv',
    pinVerifierData: 'p2p_pin_verifier_data',
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
  // Криптография: подпись личности и шифрование локального хранилища
  // ============================================================

  const IDENTITY_ALG = { name: 'ECDSA', namedCurve: 'P-256' };

  function bytesToB64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function bytesFromB64(str) {
    const bin = atob(str);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  // Пара ключей для подтверждения владения номером — приватный ключ
  // непригоден к экспорту (даже мы сами не можем его прочитать из кода),
  // сервер видит только подпись, а не сам ключ.
  async function generateIdentityKeyPair() {
    return crypto.subtle.generateKey(IDENTITY_ALG, false, ['sign', 'verify']);
  }
  async function exportPublicKeyB64(publicKey) {
    return bytesToB64(new Uint8Array(await crypto.subtle.exportKey('spki', publicKey)));
  }
  async function signNonce(privateKey, nonce) {
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, new TextEncoder().encode(nonce));
    return bytesToB64(new Uint8Array(sig));
  }

  // Код безопасности — короткий отпечаток пары ключей, который можно
  // сверить с собеседником лично или вслух, чтобы убедиться, что канал
  // никто не подменил. Порядок ключей фиксирован, поэтому обе стороны
  // всегда получают одинаковый код.
  async function computeSafetyCode(myKeyB64, peerKeyB64) {
    const a = myKeyB64 < peerKeyB64 ? myKeyB64 : peerKeyB64;
    const b = myKeyB64 < peerKeyB64 ? peerKeyB64 : myKeyB64;
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(a + b)));
    let big = 0n;
    for (const byte of digest.slice(0, 10)) big = (big << 8n) | BigInt(byte);
    const parts = [];
    for (let i = 0; i < 5; i++) {
      parts.unshift(String(big % 100000n).padStart(5, '0'));
      big /= 100000n;
    }
    return parts.join('  ');
  }

  // Шифрование содержимого сообщений на устройстве (PIN-код). Ключ живёт
  // только в памяти вкладки и никогда не сохраняется — поэтому PIN
  // спрашивается заново при каждом открытии мессенджера.
  async function deriveKeyFromPin(pin, saltBytes) {
    const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: saltBytes, iterations: 150000, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }
  async function aesEncrypt(key, plainBytes) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plainBytes));
    return { iv, ciphertext };
  }
  async function aesDecrypt(key, iv, ciphertext) {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext));
  }
  async function encryptText(str) {
    return aesEncrypt(state.encryptionKey, new TextEncoder().encode(str));
  }
  async function decryptText(enc) {
    return new TextDecoder().decode(await aesDecrypt(state.encryptionKey, enc.encIv, enc.encData));
  }
  async function encryptBlob(blob) {
    return aesEncrypt(state.encryptionKey, new Uint8Array(await blob.arrayBuffer()));
  }
  async function decryptBlob(enc, mimeType) {
    const bytes = await aesDecrypt(state.encryptionKey, enc.encIv, enc.encData);
    return new Blob([bytes], { type: mimeType || 'application/octet-stream' });
  }
  async function setupPin(pin) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKeyFromPin(pin, salt);
    const { iv, ciphertext } = await aesEncrypt(key, new TextEncoder().encode('ok'));
    localStorage.setItem(LS.pinSalt, bytesToB64(salt));
    localStorage.setItem(LS.pinVerifierIv, bytesToB64(iv));
    localStorage.setItem(LS.pinVerifierData, bytesToB64(ciphertext));
    state.encryptionKey = key;
  }
  async function tryUnlockWithPin(pin) {
    const salt = bytesFromB64(localStorage.getItem(LS.pinSalt));
    const key = await deriveKeyFromPin(pin, salt);
    const iv = bytesFromB64(localStorage.getItem(LS.pinVerifierIv));
    const ciphertext = bytesFromB64(localStorage.getItem(LS.pinVerifierData));
    const plain = await aesDecrypt(key, iv, ciphertext);
    if (new TextDecoder().decode(plain) !== 'ok') throw new Error('bad pin');
    state.encryptionKey = key;
  }

  // ============================================================
  // IndexedDB: контакты, сообщения (включая вложения) и личный ключ
  // ============================================================

  let dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open('p2p-messenger-db', 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('contacts')) {
        db.createObjectStore('contacts', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('messages')) {
        const store = db.createObjectStore('messages', { keyPath: 'msgId' });
        store.createIndex('peerId', 'peerId', { unique: false });
      }
      if (!db.objectStoreNames.contains('identity')) {
        db.createObjectStore('identity', { keyPath: 'key' });
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

  async function idbGet(storeName, key) {
    const db = await dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
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

  async function loadOrCreateIdentity() {
    const existing = await idbGet('identity', 'me');
    if (existing && existing.keyPair) return existing.keyPair;
    const keyPair = await generateIdentityKeyPair();
    await idbPut('identity', { key: 'me', keyPair });
    return keyPair;
  }

  // ============================================================
  // Состояние приложения
  // ============================================================

  const state = {
    myId: localStorage.getItem(LS.id),
    myName: localStorage.getItem(LS.name) || '',
    contacts: [], // { id, name, addedAt, publicKey }
    online: new Map(), // peerId -> bool (по данным сигнального сервера)
    peers: new Map(), // peerId -> { pc, dc, incomingFile, outbox, sending }
    activePeerId: null,
    objectUrls: [], // созданные URL.createObjectURL — чистим при смене чата
    ws: null,
    wsReconnectDelay: 1000,
    identityKeyPair: null,
    myPublicKeyB64: null,
    encryptionKey: null, // ключ для шифрования хранилища, только в памяти
    pendingPubkeyRequests: new Map(), // id -> resolve()
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
  // Запуск: PIN-экраны → идентичность → настройка → приложение
  // ============================================================

  function needsSetup() {
    return !state.myId || !localStorage.getItem(LS.signaling);
  }

  async function afterUnlock() {
    state.identityKeyPair = await loadOrCreateIdentity();
    state.myPublicKeyB64 = await exportPublicKeyB64(state.identityKeyPair.publicKey);
    if (needsSetup()) {
      el('setup-name').value = state.myName;
      el('setup-signaling').value = localStorage.getItem(LS.signaling) || '';
      setupScreen.classList.remove('hidden');
    } else {
      await startApp();
    }
  }

  async function boot() {
    const hasPin = !!localStorage.getItem(LS.pinSalt);
    if (hasPin) {
      el('unlock-screen').classList.remove('hidden');
      return;
    }
    if (!needsSetup()) {
      // Уже настроен раньше, но PIN ещё не заводили (обновление версии).
      el('pin-setup-screen').classList.remove('hidden');
      return;
    }
    el('setup-name').value = state.myName;
    el('setup-signaling').value = localStorage.getItem(LS.signaling) || '';
    setupScreen.classList.remove('hidden');
  }

  el('unlock-continue').addEventListener('click', async () => {
    const pin = el('unlock-pin').value;
    const err = el('unlock-error');
    err.classList.add('hidden');
    try {
      await tryUnlockWithPin(pin);
    } catch (e) {
      err.textContent = 'Неверный PIN.';
      err.classList.remove('hidden');
      return;
    }
    el('unlock-screen').classList.add('hidden');
    await afterUnlock();
  });

  el('pinsetup-continue').addEventListener('click', async () => {
    const pin = el('pinsetup-pin').value;
    const pinRepeat = el('pinsetup-pin-repeat').value;
    const err = el('pinsetup-error');
    if (!/^\d{4,}$/.test(pin)) {
      err.textContent = 'PIN должен состоять минимум из 4 цифр.';
      err.classList.remove('hidden');
      return;
    }
    if (pin !== pinRepeat) {
      err.textContent = 'PIN-коды не совпадают.';
      err.classList.remove('hidden');
      return;
    }
    await setupPin(pin);
    el('pin-setup-screen').classList.add('hidden');
    await afterUnlock();
  });

  el('setup-continue').addEventListener('click', async () => {
    const name = el('setup-name').value.trim();
    const signaling = el('setup-signaling').value.trim();
    const pin = el('setup-pin').value;
    const pinRepeat = el('setup-pin-repeat').value;
    const err = el('setup-error');
    if (!signaling || !/^wss?:\/\//.test(signaling)) {
      err.textContent = 'Укажите корректный адрес сервера (начинается с ws:// или wss://).';
      err.classList.remove('hidden');
      return;
    }
    if (!/^\d{4,}$/.test(pin)) {
      err.textContent = 'PIN должен состоять минимум из 4 цифр.';
      err.classList.remove('hidden');
      return;
    }
    if (pin !== pinRepeat) {
      err.textContent = 'PIN-коды не совпадают.';
      err.classList.remove('hidden');
      return;
    }
    await setupPin(pin);
    if (!state.myId) {
      state.myId = genId();
      localStorage.setItem(LS.id, state.myId);
    }
    state.myName = name;
    localStorage.setItem(LS.name, name);
    localStorage.setItem(LS.signaling, signaling);
    setupScreen.classList.add('hidden');
    await afterUnlock();
  });

  // ============================================================
  // Запуск приложения
  // ============================================================

  async function startApp() {
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

  function requestPubkey(id) {
    return new Promise((resolve) => {
      state.pendingPubkeyRequests.set(id, resolve);
      send({ type: 'get_pubkey', id });
      setTimeout(() => {
        if (state.pendingPubkeyRequests.has(id)) {
          state.pendingPubkeyRequests.delete(id);
          resolve(null);
        }
      }, 5000);
    });
  }

  async function handleSignalingMessage(msg) {
    switch (msg.type) {
      case 'challenge': {
        // Сервер просит доказать, что мы владеем ключом этого номера —
        // подписываем одноразовый код приватным ключом устройства.
        state.lastNonce = msg.nonce;
        const signature = await signNonce(state.identityKeyPair.privateKey, msg.nonce);
        send({ type: 'register', id: state.myId, publicKey: state.myPublicKeyB64, signature });
        break;
      }
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
        if (msg.online) {
          attemptDeliver(msg.id);
          const contact = state.contacts.find((c) => c.id === msg.id);
          if (contact && !contact.publicKey) {
            requestPubkey(msg.id).then(async (pk) => {
              if (pk) { contact.publicKey = pk; await idbPut('contacts', contact); }
            });
          }
        }
        break;
      }
      case 'pubkey': {
        const resolve = state.pendingPubkeyRequests.get(msg.id);
        if (resolve) {
          state.pendingPubkeyRequests.delete(msg.id);
          resolve(msg.publicKey);
        }
        break;
      }
      case 'signal':
        handleSignal(msg.from, msg.data);
        break;
      case 'error':
        if (msg.reason === 'peer_offline') {
          // Собеседник офлайн — сообщение остаётся в очереди, отправится
          // автоматически, как только придёт presence-update online:true.
        } else if (msg.reason === 'id_taken') {
          // Этот номер уже привязан к другому ключу на сервере — либо
          // ключ этого устройства был утерян (например, очистили
          // браузер), либо кто-то пытается перехватить номер. В любом
          // случае продолжать с этим номером небезопасно — получаем
          // новый и пробуем зарегистрироваться заново тем же ключом.
          console.warn('Номер уже привязан к другому ключу устройства — создаю новый номер.');
          state.myId = genId();
          localStorage.setItem(LS.id, state.myId);
          if (myIdValue) myIdValue.textContent = formatId(state.myId);
          if (state.lastNonce) {
            const signature = await signNonce(state.identityKeyPair.privateKey, state.lastNonce);
            send({ type: 'register', id: state.myId, publicKey: state.myPublicKeyB64, signature });
          }
        } else if (msg.reason === 'invalid_signature') {
          signalingStatusText.textContent = 'ошибка проверки ключа устройства';
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
      li.textContent = 'Контактов пока нет. Обменяйтесь номерами с собеседником и добавьте его.';
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
    const publicKey = await requestPubkey(id);
    const contact = { id, name: name || formatId(id), addedAt: Date.now(), publicKey: publicKey || null };
    await idbPut('contacts', contact);
    state.contacts.push(contact);
    renderContacts();
    resubscribe();
    el('add-contact-modal').classList.add('hidden');
  });

  async function deleteContact(peerId, name) {
    const ok = confirm(`Удалить контакт «${name || formatId(peerId)}»? Переписка с ним тоже будет удалена с этого устройства.`);
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
  // Код безопасности
  // ============================================================

  el('safety-code-btn').addEventListener('click', async () => {
    const contact = state.contacts.find((c) => c.id === state.activePeerId);
    if (!contact) return;
    el('safety-code-modal').classList.remove('hidden');
    el('safety-code-value').textContent = 'Вычисляю…';

    let peerKey = contact.publicKey;
    if (!peerKey) {
      peerKey = await requestPubkey(contact.id);
      if (peerKey) {
        contact.publicKey = peerKey;
        await idbPut('contacts', contact);
      }
    }
    if (!peerKey) {
      el('safety-code-value').textContent = 'Собеседник ещё ни разу не выходил в сеть с момента установки — код появится, когда он это сделает.';
      return;
    }
    el('safety-code-value').textContent = await computeSafetyCode(state.myPublicKeyB64, peerKey);
  });
  el('safety-code-close').addEventListener('click', () => el('safety-code-modal').classList.add('hidden'));

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
      statusEl.textContent = 'включены — придёт уведомление о новом сообщении';
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
  // Открытие чата
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
    const rawMsgs = (await idbGetByIndex('messages', 'peerId', peerId)).sort((a, b) => a.createdAt - b.createdAt);
    for (const m of rawMsgs) {
      await decorateWithPlaintext(m);
      renderMessage(m);
    }
    scrollToBottom();

    attemptDeliver(peerId);
  }

  // Расшифровывает текст/файл сообщения для отображения. Сама запись в
  // IndexedDB остаётся зашифрованной — расшифровка только "на лету".
  async function decorateWithPlaintext(m) {
    if (!m.encData) return m;
    try {
      if (m.kind === 'text') {
        m.text = await decryptText(m);
      } else {
        m.blob = await decryptBlob(m, m.mimeType);
      }
    } catch (e) {
      console.error('Не удалось расшифровать сообщение (неверный PIN?):', e);
      m.text = '⚠ не удалось расшифровать';
    }
    return m;
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
      peerStatusText.textContent = 'в сети — соединяемся…';
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
    const enc = await encryptText(text);
    const msg = {
      msgId: crypto.randomUUID(),
      peerId: state.activePeerId,
      direction: 'out',
      kind: 'text',
      encIv: enc.iv,
      encData: enc.ciphertext,
      createdAt: Date.now(),
      status: 'pending',
    };
    await idbPut('messages', msg);
    if (state.activePeerId) { renderMessage({ ...msg, text }); scrollToBottom(); }
    attemptDeliver(state.activePeerId);
  });

  attachBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async () => {
    if (!fileInput.files.length || !state.activePeerId) return;
    const file = fileInput.files[0];
    const kind = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : 'file';
    const enc = await encryptBlob(file);
    const msg = {
      msgId: crypto.randomUUID(),
      peerId: state.activePeerId,
      direction: 'out',
      kind,
      encIv: enc.iv,
      encData: enc.ciphertext,
      fileName: file.name,
      mimeType: file.type || 'application/octet-stream',
      fileSize: file.size,
      createdAt: Date.now(),
      status: 'pending',
    };
    await idbPut('messages', msg);
    if (state.activePeerId) { renderMessage({ ...msg, blob: file }); scrollToBottom(); }
    fileInput.value = '';
    attemptDeliver(state.activePeerId);
  });

  // Очередь на отправку для каждого собеседника обрабатывается по одному
  // сообщению за рас (чтобы не мешать несколько файлов в отном канале).
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
          const text = await decryptText(m);
          peerConn.dc.send(JSON.stringify({ kind: 'text', msgId: m.msgId, text, ts: m.createdAt }));
        } else {
          const blob = await decryptBlob(m, m.mimeType);
          await sendFileOverChannel(peerConn.dc, { ...m, blob });
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

  async function handleChannelMessage(peerId, data) {
    const peerConn = getOrCreatePeerConn(peerId);

    if (typeof data === 'string') {
      let ctrl;
      try { ctrl = JSON.parse(data); } catch { return; }

      if (ctrl.kind === 'text') {
        const enc = await encryptText(ctrl.text);
        const m = {
          msgId: ctrl.msgId || crypto.randomUUID(),
          peerId,
          direction: 'in',
          kind: 'text',
          encIv: enc.iv,
          encData: enc.ciphertext,
          createdAt: ctrl.ts || Date.now(),
          status: 'received',
        };
        await idbPut('messages', m);
        if (state.activePeerId === peerId) { renderMessage({ ...m, text: ctrl.text }); scrollToBottom(); }
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
        const enc = await encryptBlob(blob);
        const kind = (incoming.mime || '').startsWith('image/') ? 'image' : (incoming.mime || '').startsWith('video/') ? 'video' : 'file';
        const m = {
          msgId: incoming.msgId, peerId, direction: 'in',
          kind,
          encIv: enc.iv, encData: enc.ciphertext,
          fileName: incoming.name, fileSize: incoming.size, mimeType: incoming.mime,
          createdAt: Date.now(), status: 'received',
        };
        await idbPut('messages', m);
        peerConn.incomingFile = null;
        if (state.activePeerId === peerId) replaceMessageRow({ ...m, blob });
        notifyNewMessage(peerId, kind === 'image' ? '📷 Фото' : kind === 'video' ? '🎞 Видео' : `📎 ${m.fileName || 'Файл'}`);
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
    // Принимаем соединения только от уже добавленных контактов. Сам ID
    // отправителя ("from") подтверждён сервером криптографически — он
    // уже не может быть подделан кем-то без ключа этого номера.
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

  boot();
})();
