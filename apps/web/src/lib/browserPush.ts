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
const PUSH_ENDPOINT_STORAGE_KEY = 'cf.browserPushEndpoint';

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
  try {
    localStorage.setItem(PUSH_ENDPOINT_STORAGE_KEY, endpoint);
  } catch {
    /* Browser storage may be disabled; PushManager remains authoritative. */
  }
}

function rememberedEndpoint(): string | null {
  try {
    return localStorage.getItem(PUSH_ENDPOINT_STORAGE_KEY);
  } catch {
    return null;
  }
}

function forgetEndpoint(): void {
  try {
    localStorage.removeItem(PUSH_ENDPOINT_STORAGE_KEY);
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
  if (!browserPushSupported()) return { kind: 'unsupported' };
  const status = await api.get<BrowserPushStatus>(`${API}/notifications/push-status`);
  if (!status.configured || !status.publicKey) return { kind: 'unconfigured' };

  const registration = await currentRegistration();
  let subscription = (await registration?.pushManager.getSubscription()) ?? null;

  // A VAPID rotation invalidates old subscriptions. Remove the stale endpoint
  // now so the next explicit enable action can subscribe with the new key.
  if (subscription && !usesApplicationServerKey(subscription, status.publicKey)) {
    await api.delete(`${API}/notifications/push-subscribe`, {
      json: { endpoint: subscription.endpoint },
    });
    await subscription.unsubscribe();
    forgetEndpoint();
    subscription = null;
  }

  // Permission can be revoked outside Campfire. The next preferences visit
  // cleans up both sides so the server does not retain a dead capability.
  if (Notification.permission === 'denied') {
    const endpoint = subscription?.endpoint ?? rememberedEndpoint();
    if (endpoint) {
      await api.delete(`${API}/notifications/push-subscribe`, {
        json: { endpoint },
      });
    }
    await subscription?.unsubscribe().catch(() => false);
    forgetEndpoint();
    subscription = null;
  } else if (subscription) {
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
    enabled: subscription !== null,
  };
}

export async function enableBrowserPush(publicKey: string): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(permission === 'denied' ? 'Browser notifications are blocked.' : 'Browser notification permission was not granted.');
  }

  const registration = await readyRegistration();
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey(publicKey),
    }));
  try {
    await api.post(`${API}/notifications/push-subscribe`, subscriptionBody(subscription));
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
