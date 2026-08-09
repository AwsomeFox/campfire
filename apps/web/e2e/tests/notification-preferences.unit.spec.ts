/**
 * Notification preferences card (issue #789).
 *
 * Source-level guard: the re-added Notifications card must expose per-campaign
 * category delivery selectors, always-on critical categories, quiet-hours
 * controls, and route status through the shared Announcer (no second aria-live
 * region — that would break live-region-logout.spec.ts).
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CARD = resolve(__dirname, '../../src/features/preferences/NotificationPreferencesCard.tsx');
const PAGE = resolve(__dirname, '../../src/features/preferences/PreferencesPage.tsx');
const BROWSER_PUSH = resolve(__dirname, '../../src/lib/browserPush.ts');
const AUTH_PROVIDER = resolve(__dirname, '../../src/app/AuthProvider.tsx');
const PUSH_WORKER = resolve(__dirname, '../../public/sw-push.js');
const CARD_SOURCE = readFileSync(CARD, 'utf8');
const PAGE_SOURCE = readFileSync(PAGE, 'utf8');
const BROWSER_PUSH_SOURCE = readFileSync(BROWSER_PUSH, 'utf8');
const AUTH_PROVIDER_SOURCE = readFileSync(AUTH_PROVIDER, 'utf8');
const PUSH_WORKER_SOURCE = readFileSync(PUSH_WORKER, 'utf8');

test.describe('Notification preferences card (#789)', () => {
  test('is rendered on the Preferences page', () => {
    expect(PAGE_SOURCE).toContain('NotificationPreferencesCard');
    expect(CARD_SOURCE).toContain('data-testid="notification-preferences"');
  });

  test('offers immediate / digest / muted per category', () => {
    expect(CARD_SOURCE).toContain("['immediate', 'digest', 'muted']");
    expect(CARD_SOURCE).toContain('notif-mode-');
    expect(CARD_SOURCE).toContain('/notifications/preferences');
  });

  test('renders critical categories as locked (always-on)', () => {
    expect(CARD_SOURCE).toContain('CRITICAL_NOTIFICATION_CATEGORIES');
    expect(CARD_SOURCE).toContain('notif-alwayson-');
    expect(CARD_SOURCE).toContain('notifAlwaysOn');
  });

  test('exposes quiet-hours controls (enable + from/to + timezone)', () => {
    expect(CARD_SOURCE).toContain('notif-quiet-enabled-');
    expect(CARD_SOURCE).toContain('notif-quiet-from-');
    expect(CARD_SOURCE).toContain('notif-quiet-to-');
    expect(CARD_SOURCE).toContain('notif-quiet-tz-');
  });

  test('offers an explicit per-browser Web Push opt-in with server cleanup', () => {
    expect(CARD_SOURCE).toContain('data-testid="browser-push-toggle"');
    expect(BROWSER_PUSH_SOURCE).toContain('Notification.requestPermission()');
    expect(BROWSER_PUSH_SOURCE).toContain('pushManager.subscribe');
    expect(BROWSER_PUSH_SOURCE).toContain('/notifications/push-subscribe');
    expect(BROWSER_PUSH_SOURCE).toContain('subscription.unsubscribe()');
    expect(BROWSER_PUSH_SOURCE).toContain("Notification.permission === 'denied'");
  });

  test('does not delete the server binding until local unsubscribe succeeds', () => {
    const disableSource = BROWSER_PUSH_SOURCE.slice(
      BROWSER_PUSH_SOURCE.indexOf('export async function disableBrowserPush'),
    );
    expect(disableSource).toContain('if (!unsubscribed)');
    expect(disableSource.indexOf('subscription.unsubscribe()')).toBeLessThan(
      disableSource.indexOf("api.delete(`${API}/notifications/push-subscribe`"),
    );
  });

  test('does not clear a rotated-key subscription when local unsubscribe fails', () => {
    const rotationSource = BROWSER_PUSH_SOURCE.slice(
      BROWSER_PUSH_SOURCE.indexOf('// A VAPID rotation'),
      BROWSER_PUSH_SOURCE.indexOf('// Permission can be revoked outside Campfire'),
    );
    expect(rotationSource).toContain('if (!unsubscribed)');
    expect(rotationSource.indexOf('subscription.unsubscribe()')).toBeLessThan(
      rotationSource.indexOf("api.delete(`${API}/notifications/push-subscribe`"),
    );
    expect(rotationSource.indexOf('if (!unsubscribed)')).toBeLessThan(
      rotationSource.indexOf('forgetEndpoint()'),
    );
  });
  test('service worker displays pushes and opens/focuses their Campfire link', () => {
    expect(PUSH_WORKER_SOURCE).toContain("addEventListener('push'");
    expect(PUSH_WORKER_SOURCE).toContain("addEventListener('notificationclick'");
    expect(PUSH_WORKER_SOURCE).toContain('showNotification');
    expect(PUSH_WORKER_SOURCE).toContain('client.navigate(target)');
    expect(PUSH_WORKER_SOURCE).toContain('openWindow(target)');
  });

  test('requires the active worker to confirm push capability before subscribing', () => {
    const enableSource = BROWSER_PUSH_SOURCE.slice(
      BROWSER_PUSH_SOURCE.indexOf('export async function enableBrowserPush'),
    );
    expect(BROWSER_PUSH_SOURCE).toContain('registration.active');
    expect(BROWSER_PUSH_SOURCE).toContain('new MessageChannel()');
    expect(PUSH_WORKER_SOURCE).toContain("addEventListener('message'");
    expect(PUSH_WORKER_SOURCE).toContain('campfire:push-capable:v1');
    expect(enableSource.indexOf('requirePushCapableWorker(registration)')).toBeLessThan(
      enableSource.indexOf('Notification.requestPermission()'),
    );
    expect(enableSource.indexOf('requirePushCapableWorker(registration)')).toBeLessThan(
      enableSource.indexOf('pushManager.subscribe'),
    );
  });

  test('detaches the browser capability on logout and global authentication loss', () => {
    expect(BROWSER_PUSH_SOURCE).toContain('detachBrowserPushLocally');
    expect(BROWSER_PUSH_SOURCE).toContain('pendingLocalDetach');
    expect(AUTH_PROVIDER_SOURCE).toContain('browserPushEndpointForLogout');
    expect(AUTH_PROVIDER_SOURCE).toContain("api.post(`${API}/auth/logout`, pushEndpoint ? { pushEndpoint } : {})");
    expect(AUTH_PROVIDER_SOURCE.match(/detachBrowserPushLocally\(\)/g)?.length).toBeGreaterThanOrEqual(4);
  });

  test('blocks automatic rebinding when auth-transition cleanup leaves a subscription behind', () => {
    const detachSource = BROWSER_PUSH_SOURCE.slice(
      BROWSER_PUSH_SOURCE.indexOf('export function detachBrowserPushLocally'),
      BROWSER_PUSH_SOURCE.indexOf('async function readyRegistration'),
    );
    const inspectSource = BROWSER_PUSH_SOURCE.slice(
      BROWSER_PUSH_SOURCE.indexOf('export async function inspectBrowserPush'),
      BROWSER_PUSH_SOURCE.indexOf('export async function enableBrowserPush'),
    );
    const enableSource = BROWSER_PUSH_SOURCE.slice(
      BROWSER_PUSH_SOURCE.indexOf('export async function enableBrowserPush'),
      BROWSER_PUSH_SOURCE.indexOf('export async function disableBrowserPush'),
    );
    expect(BROWSER_PUSH_SOURCE).toContain("const PUSH_REBIND_BLOCKED_STORAGE_KEY = 'cf.browserPushRebindBlocked'");
    expect(detachSource).toContain('if (!unsubscribed)');
    expect(detachSource.match(/blockAutomaticRebind\(\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(inspectSource).toContain('subscription && !rebindBlocked');
    expect(inspectSource).toContain('enabled: subscription !== null && !rebindBlocked');
    expect(enableSource.indexOf('api.post')).toBeLessThan(enableSource.indexOf('allowAutomaticRebind()'));
  });

  test('routes status through the shared Announcer, not a new aria-live region', () => {
    expect(CARD_SOURCE).toContain('useAnnounce');
    // No hand-rolled live region — the Announcer owns polite/assertive output.
    expect(CARD_SOURCE).not.toContain('aria-live="');
  });
});
