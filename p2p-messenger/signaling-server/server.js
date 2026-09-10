// Сигнальный сервер для P2P-мессенджера.
//
// Он НЕ может прочитать сообщения переписки — только:
//   1) знает, какие ID сейчас онлайн;
//   2) сообщает клиентам о смене статуса их контактов (онлайн/офлайн);
//   3) пересылает между двумя ID служебные WebRTC-данные (offer/answer/
//      ICE-кандидаты), чтобы они смогли договориться о прямом соединении;
//   4) привязывает номер к криптографическому ключу устройства, чтобы его
//      нельзя было "угнать" — занять чужой номер сможет только тот, у кого
//      есть приватный ключ, созданный на устройстве владельца;
//   5) если получатель офлайн, временно держит у себя его сообщения —
//      уже зашифрованные ключом получателя, сервер их прочитать не может —
//      и стирает их сразу же, как только получатель подключится и заберёт.
// Пока обе стороны онлайн, переписка (текст, фото, видео, файлы) идёт
// напрямую между устройствами, минуя этот сервер.

require('dotenv').config();

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const webpush = require('web-push');

const { subtle } = crypto.webcrypto;

const PORT = process.env.PORT || 4000;
const DATA_DIR = path.join(__dirname, 'data');
const IDENTITIES_FILE = path.join(DATA_DIR, 'identities.json');
const QUEUE_FILE = path.join(DATA_DIR, 'queue.json');
const PUSH_SUBS_FILE = path.join(DATA_DIR, 'push_subscriptions.json');

// Публичный ключ отдаётся клиенту "как есть" — это нормально для VAPID,
// секретность обеспечивает только приватный ключ ниже. Значения по
// умолчанию — рабочая пара для этого проекта; при желании можно задать
// свои через переменные окружения (см. README).
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || 'BFdF2UU4JeeYd2CXibf9KJYy7S2jCrtXTWQfeEGMkulWb3mkIbXG3RR4wdA7TYaogj7oyseZ30H0GxHtMD046sg';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || 'NbWYAvEMoFzUmkkRHVF5x32MYhopwN0CABVRkAIuk-o';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// Ограничения на офлайн-очередь: сколько сообщений на одного получателя
// и максимальный размер одного элемента (уже зашифрованного, в base64).
const MAX_QUEUE_PER_RECIPIENT = 200;
const MAX_QUEUE_ITEM_BYTES = 8 * 1024 * 1024;
const QUEUE_ITEM_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 дней

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// id -> publicKey (base64 SPKI) — привязка номера к ключу, "кто первый
// зарегистрировался с этим ID и подписью, тот и владелец". Хранится в
// файле, чтобы связка не терялась при перезапуске сервера (если диск
// хостинга не эфемерный — см. README).
let identities = {};
try {
  identities = JSON.parse(fs.readFileSync(IDENTITIES_FILE, 'utf8'));
} catch (e) {
  identities = {};
}
let identitiesSaveTimer = null;
function saveIdentities() {
  clearTimeout(identitiesSaveTimer);
  identitiesSaveTimer = setTimeout(() => {
    fs.writeFileSync(IDENTITIES_FILE, JSON.stringify(identities));
  }, 50);
}

// id получателя -> массив ожидающих сообщений. Каждое сообщение — уже
// зашифровано отправителем ключом получателя (сервер видит только
// шифротекст и служебные поля: кто, кому, когда, какого типа). Как только
// получатель подключается, сервер отдаёт ему все накопленные сообщения и
// сразу стирает их у себя — на сервере ничего не остаётся.
let messageQueue = {};
try {
  messageQueue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
} catch (e) {
  messageQueue = {};
}
let queueSaveTimer = null;
function saveQueue() {
  clearTimeout(queueSaveTimer);
  queueSaveTimer = setTimeout(() => {
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(messageQueue));
  }, 50);
}

// Удаляет слишком старые невостребованные сообщения (получатель долго не
// заходил), чтобы очередь не росла бесконечно.
function pruneQueue() {
  const now = Date.now();
  let changed = false;
  for (const id of Object.keys(messageQueue)) {
    const before = messageQueue[id].length;
    messageQueue[id] = messageQueue[id].filter((m) => now - (m.queuedAt || 0) < QUEUE_ITEM_MAX_AGE_MS);
    if (messageQueue[id].length === 0) delete messageQueue[id];
    else if (messageQueue[id].length !== before) changed = true;
  }
  if (changed) saveQueue();
}
pruneQueue();
setInterval(pruneQueue, 6 * 60 * 60 * 1000);

// id -> объект подписки Push API (endpoint + ключи шифрования браузера).
// Позволяет разбудить телефон, даже если приложение закрыто или экран
// заблокирован — сама подписка не даёт доступа к содержимому переписки,
// только "адрес", по которому можно постучаться в конкретное устройство.
let pushSubscriptions = {};
try {
  pushSubscriptions = JSON.parse(fs.readFileSync(PUSH_SUBS_FILE, 'utf8'));
} catch (e) {
  pushSubscriptions = {};
}
let pushSaveTimer = null;
function savePushSubscriptions() {
  clearTimeout(pushSaveTimer);
  pushSaveTimer = setTimeout(() => {
    fs.writeFileSync(PUSH_SUBS_FILE, JSON.stringify(pushSubscriptions));
  }, 50);
}

// Отправляет "разбуди меня" через Push API. Само уведомление намеренно
// не содержит текста сообщения — сервер не может его прочитать, поэтому
// и push не может ничего "слить"; текст на экране телефона появляется
// уже после того, как приложение само расшифрует накопленные сообщения.
async function sendPushWake(id, fromId) {
  const sub = pushSubscriptions[id];
  if (!sub) return;
  try {
    await webpush.sendNotification(sub, JSON.stringify({ type: 'new_message', from: fromId }));
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) {
      // Подписка больше не действительна (переустановили приложение и т.п.) — забываем её.
      delete pushSubscriptions[id];
      savePushSubscriptions();
    } else {
      console.error('Не удалось отправить push:', err.message);
    }
  }
}

// id -> ws (кто сейчас online)
const online = new Map();
// id -> Set(ws) — кто хочет получать обновления статуса для этого id
const subscribers = new Map();

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, online: online.size }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Сигнальный сервер P2P-мессенджера работает. Сообщения хранятся временно, только для офлайн-получателя, в зашифрованном виде, и удаляются сразу после доставки.');
});

const wss = new WebSocketServer({ server });

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function isValidId(id) {
  return typeof id === 'string' && /^[0-9]{9}$/.test(id);
}

function notifySubscribers(id, isOnline) {
  const subs = subscribers.get(id);
  if (!subs) return;
  for (const subWs of subs) {
    send(subWs, { type: 'presence-update', id, online: isOnline });
  }
}

// Проверяет подпись nonce ключом в формате SPKI (base64). Возвращает
// true/false; никогда не бросает исключение наружу.
async function verifySignature(publicKeyB64, nonce, signatureB64) {
  try {
    const publicKeyBytes = Buffer.from(publicKeyB64, 'base64');
    const signatureBytes = Buffer.from(signatureB64, 'base64');
    const publicKey = await subtle.importKey(
      'spki',
      publicKeyBytes,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );
    return await subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      signatureBytes,
      new TextEncoder().encode(nonce)
    );
  } catch (e) {
    return false;
  }
}

wss.on('connection', (ws) => {
  ws.id = null;
  ws.watching = new Set(); // какие id этот сокет отслеживает (для очистки при отключении)
  ws.isAlive = true;
  ws.nonce = crypto.randomBytes(18).toString('base64');

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  // Сразу после подключения просим доказать владение ключом: клиент должен
  // подписать этот одноразовый nonce своим приватным ключом.
  send(ws, { type: 'challenge', nonce: ws.nonce });

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return send(ws, { type: 'error', reason: 'bad_json' });
    }
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'register': {
        if (!isValidId(msg.id)) {
          return send(ws, { type: 'error', reason: 'invalid_id' });
        }
        if (typeof msg.publicKey !== 'string' || typeof msg.signature !== 'string') {
          return send(ws, { type: 'error', reason: 'missing_signature' });
        }
        const validSig = await verifySignature(msg.publicKey, ws.nonce, msg.signature);
        if (!validSig) {
          return send(ws, { type: 'error', reason: 'invalid_signature' });
        }
        // identities[id] исторически мог быть просто строкой (publicKey).
        // Приводим к единому объектному виду на лету, ничего не теряя.
        const existingEntry = identities[msg.id];
        const boundKey = typeof existingEntry === 'string' ? existingEntry : existingEntry?.publicKey;
        if (boundKey && boundKey !== msg.publicKey) {
          // Этот номер уже привязан к другому ключу — значит, это не
          // настоящий владелец (либо кто-то пытается перехватить номер).
          return send(ws, { type: 'error', reason: 'id_taken' });
        }
        const encPublicKey = typeof msg.encPublicKey === 'string' ? msg.encPublicKey : (existingEntry?.encPublicKey || null);
        if (!boundKey || existingEntry?.encPublicKey !== encPublicKey || typeof existingEntry === 'string') {
          identities[msg.id] = { publicKey: msg.publicKey, encPublicKey };
          saveIdentities();
        }
        // Если этот же ID уже был подключён с другой вкладки/устройства —
        // отключаем старое соединение, новое считается актуальным.
        const existing = online.get(msg.id);
        if (existing && existing !== ws) {
          existing.close(4000, 'replaced_by_new_connection');
        }
        ws.id = msg.id;
        online.set(msg.id, ws);
        send(ws, { type: 'registered', id: msg.id });
        notifySubscribers(msg.id, true);

        // Отдаём накопленные, пока получатель был офлайн, сообщения — и
        // сразу стираем их у себя, они больше нигде не хранятся.
        const queued = messageQueue[msg.id];
        if (queued && queued.length) {
          delete messageQueue[msg.id];
          saveQueue();
          for (const item of queued) {
            send(ws, { type: 'queued_message', ...item });
          }
        }
        break;
      }

      case 'subscribe': {
        const ids = Array.isArray(msg.ids) ? msg.ids.filter(isValidId) : [];
        const statuses = {};
        for (const id of ids) {
          if (!subscribers.has(id)) subscribers.set(id, new Set());
          subscribers.get(id).add(ws);
          ws.watching.add(id);
          statuses[id] = online.has(id);
        }
        send(ws, { type: 'presence', statuses });
        break;
      }

      case 'get_pubkey': {
        if (!isValidId(msg.id)) return send(ws, { type: 'error', reason: 'invalid_id' });
        const entry = identities[msg.id];
        const publicKey = typeof entry === 'string' ? entry : entry?.publicKey || null;
        const encPublicKey = typeof entry === 'string' ? null : entry?.encPublicKey || null;
        send(ws, { type: 'pubkey', id: msg.id, publicKey, encPublicKey });
        break;
      }

      case 'push_subscribe': {
        // Клиент прислал "адрес" для Push API после разрешения уведомлений.
        // Сама подписка — не секрет отправителя, а служебные данные браузера.
        if (!ws.id) return send(ws, { type: 'error', reason: 'not_registered' });
        if (!msg.subscription || typeof msg.subscription.endpoint !== 'string') {
          return send(ws, { type: 'error', reason: 'bad_payload' });
        }
        pushSubscriptions[ws.id] = msg.subscription;
        savePushSubscriptions();
        break;
      }

      case 'push_unsubscribe': {
        if (!ws.id) return send(ws, { type: 'error', reason: 'not_registered' });
        delete pushSubscriptions[ws.id];
        savePushSubscriptions();
        break;
      }

      case 'queue_message': {
        // Сообщение для офлайн-получателя: отправитель уже зашифровал его
        // ключом получателя, сервер содержимое прочитать не может.
        if (!ws.id) return send(ws, { type: 'error', reason: 'not_registered' });
        if (!isValidId(msg.to)) return send(ws, { type: 'error', reason: 'invalid_target' });
        if (typeof msg.msgId !== 'string' || typeof msg.encIv !== 'string' || typeof msg.encData !== 'string') {
          return send(ws, { type: 'error', reason: 'bad_payload' });
        }
        const item = {
          from: ws.id,
          msgId: msg.msgId,
          kind: typeof msg.kind === 'string' ? msg.kind : 'text',
          encIv: msg.encIv,
          encData: msg.encData,
          fileName: typeof msg.fileName === 'string' ? msg.fileName : undefined,
          mimeType: typeof msg.mimeType === 'string' ? msg.mimeType : undefined,
          fileSize: typeof msg.fileSize === 'number' ? msg.fileSize : undefined,
          ts: typeof msg.ts === 'number' ? msg.ts : Date.now(),
          queuedAt: Date.now(),
        };
        if (Buffer.byteLength(JSON.stringify(item)) > MAX_QUEUE_ITEM_BYTES) {
          return send(ws, { type: 'error', reason: 'too_large' });
        }
        // Получатель прямо сейчас на связи — доставляем без сохранения.
        const targetWs = online.get(msg.to);
        if (targetWs) {
          send(targetWs, { type: 'queued_message', ...item });
          return;
        }
        if (!messageQueue[msg.to]) messageQueue[msg.to] = [];
        if (messageQueue[msg.to].length >= MAX_QUEUE_PER_RECIPIENT) {
          return send(ws, { type: 'error', reason: 'queue_full' });
        }
        messageQueue[msg.to].push(item);
        saveQueue();
        sendPushWake(msg.to, ws.id);
        break;
      }

      case 'signal': {
        if (!ws.id) return send(ws, { type: 'error', reason: 'not_registered' });
        if (!isValidId(msg.to)) return send(ws, { type: 'error', reason: 'invalid_target' });
        const target = online.get(msg.to);
        if (!target) {
          return send(ws, { type: 'error', reason: 'peer_offline', to: msg.to });
        }
        send(target, { type: 'signal', from: ws.id, data: msg.data });
        break;
      }

      default:
        send(ws, { type: 'error', reason: 'unknown_type' });
    }
  });

  ws.on('close', () => {
    if (ws.id && online.get(ws.id) === ws) {
      online.delete(ws.id);
      notifySubscribers(ws.id, false);
    }
    for (const id of ws.watching) {
      const subs = subscribers.get(id);
      if (subs) {
        subs.delete(ws);
        if (subs.size === 0) subscribers.delete(id);
      }
    }
  });
});

// Проверка живости соединений — закрываем "зависшие" сокеты
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`Сигнальный сервер запущен: http://localhost:${PORT}`);
});
