import { expect, test } from '@playwright/test';
import {
  ENTITY_DEEP_LINK_HASH,
  APP_DOCUMENT_TITLE,
  fallbackPageTitle,
  focusSkipDestination,
  formatDocumentTitle,
  isEntityDeepLinkHash,
  shouldMoveFocusOnNavigation,
} from '../../src/app/routeFocus';

/**
 * Issue #591 — skip navigation + route-change focus decisions.
 */

test.describe('route focus helpers (#591)', () => {
  test('entity deep-link hash pattern matches entity anchors only', () => {
    expect(isEntityDeepLinkHash('#entity-npc-12')).toBe(true);
    expect(isEntityDeepLinkHash('#entity-quest-3')).toBe(true);
    expect(isEntityDeepLinkHash('#sessions-tab-schedule')).toBe(false);
    expect(isEntityDeepLinkHash('')).toBe(false);
    expect(ENTITY_DEEP_LINK_HASH.test('#entity-npc-12')).toBe(true);
  });

  test('shouldMoveFocusOnNavigation ignores same-pathname and hash-only updates', () => {
    // Query-only navigations never call this with a pathname change (RouteChangeFocus omits search).
    expect(shouldMoveFocusOnNavigation('/c/1/sessions', '/c/1/sessions', '')).toBe(false);
    expect(shouldMoveFocusOnNavigation('/c/1/compendium', '/c/1/compendium', '#item-42')).toBe(false);
    expect(shouldMoveFocusOnNavigation('/c/1/party', '/c/1/party', '#entity-npc-1')).toBe(false);
  });

  test('shouldMoveFocusOnNavigation runs on pathname changes but not entity hash navigations', () => {
    expect(shouldMoveFocusOnNavigation('/c/1', '/c/1/quests', '')).toBe(true);
    expect(shouldMoveFocusOnNavigation(null, '/c/1/party', '')).toBe(true);
    expect(shouldMoveFocusOnNavigation('/c/1/npcs', '/c/1/npcs/4', '#entity-npc-4')).toBe(false);
  });

  test('fallbackPageTitle maps common campaign routes', () => {
    expect(fallbackPageTitle('/')).toBe('Campaigns');
    expect(fallbackPageTitle('/c/42')).toBe('Dashboard');
    expect(fallbackPageTitle('/c/42/party')).toBe('Party');
    expect(fallbackPageTitle('/c/42/compendium')).toBe('Compendium');
    expect(fallbackPageTitle('/admin/users')).toBe('Users');
  });

  test('formatDocumentTitle includes campaign name when provided', () => {
    expect(formatDocumentTitle({ page: 'Party', campaignName: 'Cinderhaven' })).toBe(
      'Party · Cinderhaven · Campfire',
    );
    expect(formatDocumentTitle({ page: 'Campaigns' })).toBe('Campaigns · Campfire');
  });

  test('formatDocumentTitle avoids duplicating the app title when page is already Campfire', () => {
    expect(formatDocumentTitle({ page: APP_DOCUMENT_TITLE })).toBe(APP_DOCUMENT_TITLE);
    expect(formatDocumentTitle({ page: APP_DOCUMENT_TITLE, campaignName: 'Cinderhaven' })).toBe(
      `${APP_DOCUMENT_TITLE} · Cinderhaven`,
    );
  });

  test('focusSkipDestination focuses the main landmark even when an h1 is present', () => {
    let focused: HTMLElement | null = null;
    const h1 = {
      tagName: 'H1',
      tabIndex: 0,
      focus() {
        focused = h1 as unknown as HTMLElement;
      },
    };
    const main = {
      tagName: 'MAIN',
      tabIndex: -1,
      querySelector(sel: string) {
        if (sel === 'h1') return h1;
        return null;
      },
      focus() {
        focused = main as unknown as HTMLElement;
      },
    } as unknown as HTMLElement;

    focusSkipDestination(main);
    expect(focused).toBe(main);
  });
});
