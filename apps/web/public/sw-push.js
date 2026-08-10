/**
 * Browser Web Push display + click handling (issue #1323).
 * Loaded by the generated Workbox service worker via importScripts.
 */
const PUSH_WORKER_CAPABILITY_REQUEST = 'campfire:push-capability';
const PUSH_WORKER_CAPABILITY_RESPONSE = 'campfire:push-capable:v1';
const PUSH_DISPLAY_STATE_CACHE = 'cf-push-display-state-v1';
const PUSH_DISPLAY_SUPPRESSED_PATH = '__campfire_push_suppressed__';

function fallbackUrl() {
  return self.registration.scope;
}

function safeTarget(value) {
  try {
    const target = new URL(typeof value === 'string' ? value : fallbackUrl(), self.location.origin);
    return target.href.startsWith(self.registration.scope) ? target.href : fallbackUrl();
  } catch {
    return fallbackUrl();
  }
}

function withinCampfireScope(value) {
  try {
    return new URL(value).href.startsWith(self.registration.scope);
  } catch {
    return false;
  }
}

async function pushDisplaySuppressed() {
  try {
    const cache = await self.caches.open(PUSH_DISPLAY_STATE_CACHE);
    const key = new URL(PUSH_DISPLAY_SUPPRESSED_PATH, self.registration.scope).href;
    return Boolean(await cache.match(key));
  } catch {
    // If the browser cannot read its persisted transition state, do not risk
    // showing a departed account's campaign excerpt.
    return true;
  }
}

self.addEventListener('message', (event) => {
  if (event.data?.type !== PUSH_WORKER_CAPABILITY_REQUEST) return;
  event.ports[0]?.postMessage(PUSH_WORKER_CAPABILITY_RESPONSE);
});

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
  event.waitUntil(
    (async () => {
      if (await pushDisplaySuppressed()) return;
      await self.registration.showNotification(title, options);
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = safeTarget(event.notification.data?.url);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const campfireWindows = windows.filter((client) => withinCampfireScope(client.url));
      const exact = campfireWindows.find((client) => client.url === target);
      if (exact) return exact.focus();
      for (const client of campfireWindows) {
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
