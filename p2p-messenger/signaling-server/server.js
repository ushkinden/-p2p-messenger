// Сигнальный сервер для P2P-мессенджера.
//
// Он НЕ хранит и не читает сообщения переписки — только:
//   1) знает, какие ID сейчас онлайн;
//   2) сообщает клиентам о смене статуса их контактов (онлайн/офлайн);
//   3) пересылает между двумя ID служебные WebRTC-данные (offer/answer/
//      ICE-кандидаты), чтобы они смогли договориться о прямом соединении.
// Сама переписка (текст, фото, видео, файлы) после установления соединения
// идёт напрямую между устройствами, минуя этот сервер.

require('dotenv').config();

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 4000;

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

wss.on('connection', (ws) => {
  ws.id = null;
  ws.watching = new Set(); // какие id этот сокет отслеживает (для очистки при отключении)
  ws.isAlive = true;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
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
