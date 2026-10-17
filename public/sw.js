/* Trend Web Store admin service worker: install support + push notifications. No caching, so the store always shows live data. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {}); // pass-through (lets browsers treat the app as installable)

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: 'Trend Web Store', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'New order', {
    body: d.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    tag: d.tag || 'order',
    renotify: true,
    data: { url: d.url || '/admin/' }
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/admin/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if (c.url.indexOf('/admin') !== -1 && 'focus' in c) return c.focus();
    return self.clients.openWindow(url);
  }));
});

function b64(s) {
  const p = '='.repeat((4 - s.length % 4) % 4), r = atob((s + p).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(r, ch => ch.charCodeAt(0));
}
self.addEventListener('pushsubscriptionchange', e => {
  e.waitUntil((async () => {
    const k = await (await fetch('/api/admin/push/key', { credentials: 'same-origin' })).json();
    const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(k.publicKey) });
    await fetch('/api/admin/push/subscribe', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub) });
  })().catch(() => {}));
});
