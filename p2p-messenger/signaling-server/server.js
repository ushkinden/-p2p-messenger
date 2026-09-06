// Сигнальный сервер для P2P-мессенджера.
//
// Он НЕ хранит и не читает сообщения переписки — только:
//   1) знает, какие ID сейчас онлайн;
//   2) сообщает клиентам о смене статуса их контактов (онлайн/офлайн);
//   3) пересылает между двумя ID служебные WebRTC-данные (offer/answer/
//      ICE-кандидаты), чтобы они смогли договориться о прямом соединении;
//   4) привязывает номер к криптографическому ключу устройства, чтобы его
//      нельзя было "угнать" — занять чужой номер сможет только тот, у кого
//      есть приватный ключ, созданный на устройстве владельца.
// Сама переписка (текст, фото, видео, файлы) после установления соединения
// идёт напрямую между устройствами, минуя этот сервер.

require('dotenv').config();

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const { subtle } = crypto.webcrypto;

const PORT = process.env.PORT || 4000;
const DATA_DIR = path.join(__dirname, 'data');
const IDENTITIES_FILE = path.join(DATA_DIR, 'identities.json');

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
    res.end('Сигнальный сервер P2P-мессенджера работает. Сообщения через него не хранятся.');
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
        const boundKey = identities[msg.id];
        if (boundKey && boundKey !== msg.publicKey) {
          // Этот номер уже привязан к другому ключу — значит, это не
          // настоящий владелец (либо кто-то пытается перехватить номер).
          return send(ws, { type: 'error', reason: 'id_taken' });
        }
        if (!boundKey) {
          identities[msg.id] = msg.publicKey;
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
        send(ws, { type: 'pubkey', id: msg.id, publicKey: identities[msg.id] || null });
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
