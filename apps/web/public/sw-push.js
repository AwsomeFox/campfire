/**
 * Browser Web Push display + click handling (issue #1323).
 * Loaded by the generated Workbox service worker via importScripts.
 */
function fallbackUrl() {
  return self.registration.scope;
}

function safeTarget(value) {
  try {
    const target = new URL(typeof value === 'string' ? value : fallbackUrl(), self.location.origin);
    return target.origin === self.location.origin ? target.href : fallbackUrl();
  } catch {
    return fallbackUrl();
  }
}

self.addEventListener('push', (event) => {
  const payload = (() => {
    try {
      return event.data ? event.data.json() : {};
    } catch {
      return {};
    }
  })();
  const title = typeof payload.title === 'string' && payload.title ? payload.title : 'Campfire';
  const options = {
    body: typeof payload.body === 'string' ? payload.body : '',
    icon: typeof payload.icon === 'string' ? payload.icon : undefined,
    badge: typeof payload.badge === 'string' ? payload.badge : undefined,
    tag: typeof payload.tag === 'string' ? payload.tag : undefined,
    data: { url: safeTarget(payload.url) },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = safeTarget(event.notification.data?.url);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        if ('navigate' in client && client.url !== target) {
          try {
            await client.navigate(target);
          } catch {
            // A stale window can reject navigation; try the next one/openWindow.
            continue;
          }
        }
        return client.focus();
      }
      return self.clients.openWindow(target);
    })(),
  );
});
