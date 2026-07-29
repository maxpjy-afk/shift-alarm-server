const CACHE = 'shift-alarm-v3-cache-2';
const SHELL = [
  './shift_alarm_v3.html',
  './manifest.json',
  './icons/icon.svg'
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.includes('/v1/messages')) return;

  e.respondWith(
    caches.match(e.request).then((cached) => {
      const fetchPromise = fetch(e.request)
        .then((res) => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});

const BACKEND_URL = 'https://shift-alarm-server.onrender.com';

// Fires even when the app is fully closed — this is the whole point of the
// backup push server. The payload is whatever server.js sent for the due
// alarm: { title, body, deviceId }.
self.addEventListener('push', (e) => {
  let data = { title: '근무 알람', body: '', deviceId: null };
  try {
    if (e.data) data = Object.assign(data, e.data.json());
  } catch (err) {}
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: './icons/icon.svg',
      badge: './icons/icon.svg',
      vibrate: [200, 100, 200, 100, 200],
      tag: 'shift-alarm',
      renotify: true,
      requireInteraction: true,
      actions: [{ action: 'snooze', title: '⏰ 10분 후 다시' }],
      data: { deviceId: data.deviceId, title: data.title, body: data.body }
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  const data = e.notification.data || {};
  if (e.action === 'snooze') {
    e.notification.close();
    e.waitUntil(
      fetch(BACKEND_URL + '/snooze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: data.deviceId,
          title: data.title || '근무 알람',
          body: data.body || '',
          delayMs: 10 * 60 * 1000
        })
      }).catch(() => {})
    );
    return;
  }
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./shift_alarm_v3.html');
    })
  );
});

// The browser can silently rotate a push subscription (key rotation,
// expiry). Without this handler the old subscription just goes dead and
// the backend keeps sending to a black hole until it gets a 410 back.
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil(
    self.registration.pushManager
      .subscribe(e.oldSubscription ? e.oldSubscription.options : { userVisibleOnly: true })
      .then((sub) => {
        return self.clients.matchAll().then((clients) => {
          clients.forEach((c) => c.postMessage({ type: 'RESUBSCRIBE', subscription: sub }));
        });
      })
      .catch(() => {})
  );
});
