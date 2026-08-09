import type { BrowserPushStatus, BrowserPushSubscription } from '@campfire/schema';
import { API, api } from './api';

export type BrowserPushUiState =
  | { kind: 'loading' }
  | { kind: 'unsupported' }
  | { kind: 'unconfigured' }
  | { kind: 'error' }
  | {
      kind: 'ready';
      publicKey: string;
      permission: NotificationPermission;
      enabled: boolean;
    };

const SERVICE_WORKER_READY_TIMEOUT_MS = 10_000;
const PUSH_WORKER_CAPABILITY_TIMEOUT_MS = 1_500;
const PUSH_WORKER_CAPABILITY_REQUEST = 'campfire:push-capability';
const PUSH_WORKER_CAPABILITY_RESPONSE = 'campfire:push-capable:v1';
const PUSH_ENDPOINT_STORAGE_KEY = 'cf.browserPushEndpoint';
const PUSH_REBIND_BLOCKED_STORAGE_KEY = 'cf.browserPushRebindBlocked';
const PUSH_DISPLAY_STATE_CACHE = 'cf-push-display-state-v1';
const PUSH_DISPLAY_SUPPRESSED_PATH = '__campfire_push_suppressed__';
let pendingLocalDetach: Promise<void> = Promise.resolve();
let pushEndpointInMemory: string | null = null;
let pushRebindBlockedInMemory = false;

export function browserPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    'Notification' in window &&
    'PushManager' in window &&
    'serviceWorker' in navigator
  );
}

function applicationServerKey(value: string): ArrayBuffer {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const buffer = new ArrayBuffer(raw.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return buffer;
}

function rememberEndpoint(endpoint: string): void {
  pushEndpointInMemory = endpoint;
  try {
    localStorage.setItem(PUSH_ENDPOINT_STORAGE_KEY, endpoint);
  } catch {
    /* Browser storage may be disabled; PushManager remains authoritative. */
  }
}

function rememberedEndpoint(): string | null {
  try {
    return localStorage.getItem(PUSH_ENDPOINT_STORAGE_KEY) ?? pushEndpointInMemory;
  } catch {
    return pushEndpointInMemory;
  }
}

/** Endpoint included in logout so the server can detach it before revoking the session. */
export function browserPushEndpointForLogout(): string | undefined {
  return rememberedEndpoint() ?? undefined;
}

function forgetEndpoint(): void {
  pushEndpointInMemory = null;
  try {
    localStorage.removeItem(PUSH_ENDPOINT_STORAGE_KEY);
  } catch {
    /* best effort */
  }
}

function blockAutomaticRebind(): void {
  pushRebindBlockedInMemory = true;
  try {
    localStorage.setItem(PUSH_REBIND_BLOCKED_STORAGE_KEY, '1');
  } catch {
    /* The in-memory guard still protects this page session. */
  }
}

function automaticRebindBlocked(): boolean {
  try {
    return pushRebindBlockedInMemory || localStorage.getItem(PUSH_REBIND_BLOCKED_STORAGE_KEY) === '1';
  } catch {
    return pushRebindBlockedInMemory;
  }
}

function allowAutomaticRebind(): void {
  pushRebindBlockedInMemory = false;
  try {
    localStorage.removeItem(PUSH_REBIND_BLOCKED_STORAGE_KEY);
  } catch {
    /* best effort */
  }
}

function usesApplicationServerKey(subscription: PushSubscription, publicKey: string): boolean {
  const current = subscription.options.applicationServerKey;
  if (!current) return true;
  const expected = new Uint8Array(applicationServerKey(publicKey));
  const actual = new Uint8Array(current);
  if (actual.length !== expected.length) return false;
  return actual.every((byte, index) => byte === expected[index]);
}

async function currentRegistration(): Promise<ServiceWorkerRegistration | undefined> {
  return (await navigator.serviceWorker.getRegistration()) ?? undefined;
}

async function setPushDisplaySuppressed(
  registration: ServiceWorkerRegistration | undefined,
  suppressed: boolean,
): Promise<void> {
  if (!registration || !('caches' in window)) return;
  const cache = await window.caches.open(PUSH_DISPLAY_STATE_CACHE);
  const key = new URL(PUSH_DISPLAY_SUPPRESSED_PATH, registration.scope).href;
  if (suppressed) {
    await cache.put(key, new Response('1'));
  } else {
    await cache.delete(key);
  }
}

/**
 * Stop this browser capability without requiring a live session. AuthProvider
 * calls this for explicit, cross-tab, expired-session, and account-switch paths.
 * Serializing detaches prevents a fast re-login from re-binding a subscription
 * while the prior account's local unsubscribe is still in flight.
 */
export function detachBrowserPushLocally(): Promise<void> {
  forgetEndpoint();
  if (!browserPushSupported()) return pendingLocalDetach;
  pendingLocalDetach = pendingLocalDetach.then(async () => {
    try {
      const registration = await currentRegistration();
      const subscription = (await registration?.pushManager.getSubscription()) ?? null;
      if (!subscription) {
        await setPushDisplaySuppressed(registration, false);
        allowAutomaticRebind();
        return;
      }
      await setPushDisplaySuppressed(registration, true);
      const unsubscribed = await subscription.unsubscribe();
      if (!unsubscribed) {
        blockAutomaticRebind();
        return;
      }
      await setPushDisplaySuppressed(registration, false);
      allowAutomaticRebind();
    } catch {
      // Auth transitions must complete even if browser cleanup fails. Persist a
      // fail-closed marker so another account cannot inherit the subscription.
      blockAutomaticRebind();
    }
  });
  return pendingLocalDetach;
}

async function readyRegistration(): Promise<ServiceWorkerRegistration> {
  const existing = await currentRegistration();
  if (existing) return existing;
  let timer = 0;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = window.setTimeout(
      () => reject(new Error('The Campfire service worker is not ready. Reload and try again.')),
      SERVICE_WORKER_READY_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([navigator.serviceWorker.ready, timeout]);
  } finally {
    window.clearTimeout(timer);
  }
}

async function requirePushCapableWorker(registration: ServiceWorkerRegistration): Promise<void> {
  const worker = registration.active;
  const unavailable = () =>
    new Error(
      'The active Campfire service worker cannot receive push notifications. Install the pending update or reload, then try again.',
    );
  if (!worker) throw unavailable();

  await new Promise<void>((resolve, reject) => {
    const channel = new MessageChannel();
    let settled = false;
    let timer = 0;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      channel.port1.close();
      if (error) reject(error);
      else resolve();
    };
    timer = window.setTimeout(
      () => finish(unavailable()),
      PUSH_WORKER_CAPABILITY_TIMEOUT_MS,
    );
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      finish(event.data === PUSH_WORKER_CAPABILITY_RESPONSE ? undefined : unavailable());
    };
    channel.port1.onmessageerror = () => finish(unavailable());
    try {
      worker.postMessage({ type: PUSH_WORKER_CAPABILITY_REQUEST }, [channel.port2]);
    } catch {
      finish(unavailable());
    }
  });
}

function subscriptionBody(subscription: PushSubscription): BrowserPushSubscription {
  const json = subscription.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!p256dh || !auth) throw new Error('The browser returned an incomplete push subscription.');
  return {
    endpoint: subscription.endpoint,
    keys: { p256dh, auth },
    userAgent: navigator.userAgent,
  };
}

export async function inspectBrowserPush(): Promise<BrowserPushUiState> {
  await pendingLocalDetach;
  if (!browserPushSupported()) return { kind: 'unsupported' };
  const status = await api.get<BrowserPushStatus>(`${API}/notifications/push-status`);
  if (!status.configured || !status.publicKey) return { kind: 'unconfigured' };

  const registration = await currentRegistration();
  let subscription = (await registration?.pushManager.getSubscription()) ?? null;

  // A VAPID rotation invalidates old subscriptions. Remove the stale endpoint
  // now so the next explicit enable action can subscribe with the new key.
  if (subscription && !usesApplicationServerKey(subscription, status.publicKey)) {
    const unsubscribed = await subscription.unsubscribe();
    if (!unsubscribed) {
      throw new Error('The browser could not remove its stale push subscription. Try again.');
    }
    await api.delete(`${API}/notifications/push-subscribe`, {
      json: { endpoint: subscription.endpoint },
    });
    forgetEndpoint();
    subscription = null;
  }

  if (!subscription) {
    await setPushDisplaySuppressed(registration, false);
    allowAutomaticRebind();
  }
  let rebindBlocked = automaticRebindBlocked();

  // Permission can be revoked outside Campfire. The next preferences visit
  // cleans up both sides so the server does not retain a dead capability.
  if (Notification.permission === 'denied') {
    const endpoint = subscription?.endpoint ?? rememberedEndpoint();
    if (endpoint) {
      await api.delete(`${API}/notifications/push-subscribe`, {
        json: { endpoint },
      });
    }
    forgetEndpoint();
    if (subscription) {
      await setPushDisplaySuppressed(registration, true);
      const unsubscribed = await subscription.unsubscribe().catch(() => false);
      if (unsubscribed) {
        await setPushDisplaySuppressed(registration, false);
        allowAutomaticRebind();
        rebindBlocked = false;
        subscription = null;
      } else {
        blockAutomaticRebind();
        rebindBlocked = true;
      }
    } else {
      allowAutomaticRebind();
      rebindBlocked = false;
    }
  } else if (subscription && !rebindBlocked) {
    // Idempotently re-bind this browser to the current signed-in user. This is
    // essential on shared devices where the PushManager subscription survives
    // an account switch.
    await api.post(`${API}/notifications/push-subscribe`, subscriptionBody(subscription));
    rememberEndpoint(subscription.endpoint);
  }

  return {
    kind: 'ready',
    publicKey: status.publicKey,
    permission: Notification.permission,
    enabled: subscription !== null && !rebindBlocked,
  };
}

export async function enableBrowserPush(publicKey: string): Promise<void> {
  await pendingLocalDetach;
  const registration = await readyRegistration();
  await requirePushCapableWorker(registration);
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(permission === 'denied' ? 'Browser notifications are blocked.' : 'Browser notification permission was not granted.');
  }

  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey(publicKey),
    }));
  try {
    await api.post(`${API}/notifications/push-subscribe`, subscriptionBody(subscription));
    await setPushDisplaySuppressed(registration, false);
    allowAutomaticRebind();
    rememberEndpoint(subscription.endpoint);
  } catch (error) {
    if (!existing) await subscription.unsubscribe().catch(() => false);
    throw error;
  }
}

export async function disableBrowserPush(): Promise<void> {
  if (!browserPushSupported()) return;
  const registration = await currentRegistration();
  const subscription = (await registration?.pushManager.getSubscription()) ?? null;
  const endpoint = subscription?.endpoint ?? rememberedEndpoint();
  if (!endpoint) return;
  await api.delete(`${API}/notifications/push-subscribe`, { json: { endpoint } });
  await subscription?.unsubscribe();
  forgetEndpoint();
}
