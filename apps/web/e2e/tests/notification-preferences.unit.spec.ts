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
const CARD_SOURCE = readFileSync(CARD, 'utf8');
const PAGE_SOURCE = readFileSync(PAGE, 'utf8');

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

  test('routes status through the shared Announcer, not a new aria-live region', () => {
    expect(CARD_SOURCE).toContain('useAnnounce');
    // No hand-rolled live region — the Announcer owns polite/assertive output.
    expect(CARD_SOURCE).not.toContain('aria-live="');
  });
});
