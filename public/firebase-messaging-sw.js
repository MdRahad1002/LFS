// firebase-messaging-sw.js
// Web Push Service Worker for Last Flag Standing
// Handles push notifications and notification click routing.
// Place this file at the ROOT of your served domain (not inside /public/).

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

// ─────────────────────────────────────────────────────────────
//  PUSH RECEIVED
// ─────────────────────────────────────────────────────────────
self.addEventListener('push', event => {
  if (!event.data) return;

  let data;
  try { data = event.data.json(); }
  catch { data = { title: '🚩 Last Flag Standing', body: event.data.text() }; }

  const { title = '🚩 Last Flag Standing', body = '', icon, data: extraData = {} } = data;

  // Pick notification color by type
  const bgMap = {
    elimination: '#ff2d2d',
    win:         '#f5c518',
    alert:       '#ff9900',
    default:     '#122030',
  };
  const tag   = extraData.tag || 'lfs-' + Date.now();
  const badge = '/icons/badge-72.png';

  const options = {
    body,
    icon:    icon || '/icons/icon-192.png',
    badge,
    tag,
    vibrate: extraData.vibrate || [200, 100, 200],
    renotify: true,
    data:    { url: extraData.url || '/hub.html', ...extraData },
    actions: extraData.actions || [],
  };

  // Add themed image for eliminations
  if (extraData.type === 'elimination') {
    options.image = extraData.image || '/icons/elimination-banner.png';
  }

  event.waitUntil(self.registration.showNotification(title, options));
});

// ─────────────────────────────────────────────────────────────
//  NOTIFICATION CLICK
// ─────────────────────────────────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();

  const url = event.notification.data?.url || '/hub.html';
  const action = event.action;

  // Handle action buttons
  if (action === 'view-game')  return navigateTo('/public/play.html');
  if (action === 'dismiss')    return;

  event.waitUntil(navigateTo(url));
});

// ─────────────────────────────────────────────────────────────
//  BACKGROUND SYNC  (retry failed API calls)
// ─────────────────────────────────────────────────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'sync-analytics') {
    event.waitUntil(flushAnalyticsQueue());
  }
});

async function flushAnalyticsQueue() {
  const cache = await caches.open('analytics-queue');
  const keys  = await cache.keys();
  for (const req of keys) {
    try {
      const clone = await cache.match(req);
      await fetch(req, { method: 'POST', body: await clone.text(),
        headers: { 'Content-Type': 'application/json' } });
      await cache.delete(req);
    } catch { /* retry next sync */ }
  }
}

// ─────────────────────────────────────────────────────────────
//  HELPER
// ─────────────────────────────────────────────────────────────
async function navigateTo(url) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clients) {
    if (new URL(client.url).pathname === new URL(url, self.location.origin).pathname) {
      return client.focus();
    }
  }
  if (self.clients.openWindow) return self.clients.openWindow(url);
}
