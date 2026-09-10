// Service Worker: нужен только для того, чтобы показывать уведомления,
// даже когда приложение закрыто или телефон заблокирован. Никакой
// переписки здесь нет и быть не может — пуш от сервера не содержит
// текста сообщений (сервер их не видит и не хранит), только "кто-то
// написал". Имя собеседника (если оно у вас сохранено) сервис-воркер
// подсматривает в локальной базе прямо на устройстве, никуда её не
// отправляя.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('p2p-messenger-db');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getContactName(peerId) {
  try {
    const db = await openDb();
    const name = await new Promise((resolve) => {
      if (!db.objectStoreNames.contains('contacts')) return resolve(null);
      const tx = db.transaction('contacts', 'readonly');
      const req = tx.objectStore('contacts').get(peerId);
      req.onsuccess = () => resolve(req.result ? req.result.name : null);
      req.onerror = () => resolve(null);
    });
    db.close();
    return name;
  } catch (e) {
    return null;
  }
}

function formatId(id) {
  return String(id || '').replace(/(\d{3})(\d{3})(\d{3})/, '$1 $2 $3');
}

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}

  event.waitUntil((async () => {
    let title = 'Новое сообщение';
    if (data.from) {
      const name = await getContactName(data.from);
      title = name || formatId(data.from);
    }
    await self.registration.showNotification(title, {
      body: 'Откройте приложение, чтобы прочитать',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: data.from ? 'p2p-msg-' + data.from : 'p2p-msg',
      data: { peerId: data.from || null },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const peerId = event.notification.data && event.notification.data.peerId;

  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of allClients) {
      if ('focus' in client) {
        client.postMessage({ type: 'open-chat', peerId });
        return client.focus();
      }
    }
    if (self.clients.openWindow) {
      return self.clients.openWindow(peerId ? ('/?chat=' + peerId) : '/');
    }
  })());
});
