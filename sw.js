// Service Worker des Familienkalenders: zeigt Push-Erinnerungen an.
// Der Push selbst enthaelt keinen Text; die Meldung wird beim Worker abgeholt (nur mit dem geheimen Hash dieses Geraets).
const API = 'https://familienkalender.ocho1511.workers.dev';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

async function sha256hex(t) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let items = [];
    try {
      const sub = await self.registration.pushManager.getSubscription();
      if (sub) {
        const r = await fetch(API + '/pending?h=' + (await sha256hex(sub.endpoint)));
        items = ((await r.json()).items) || [];
      }
    } catch (e) { /* Fallback unten */ }
    if (!items.length) items = [{ title: 'Familienkalender', body: 'Neue Erinnerung' }];
    for (const it of items.slice(0, 5)) {
      await self.registration.showNotification(String(it.title || 'Familienkalender'), {
        body: String(it.body || ''),
        icon: 'icons/icon-192.png',
        data: { url: './' },
      });
    }
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow('./');
  })());
});

// Offline-Start: erst das Netz, bei Ausfall die zuletzt geladene Kopie der Seite und ihrer Dateien
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open('fk-v1').then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((m) => m || caches.match('./')))
  );
});
