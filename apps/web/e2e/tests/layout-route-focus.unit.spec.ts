import { expect, test } from '@playwright/test';
import {
  ENTITY_DEEP_LINK_HASH,
  fallbackPageTitle,
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

  test('shouldMoveFocusOnNavigation ignores query/hash-only updates', () => {
    expect(shouldMoveFocusOnNavigation('/c/1/sessions', '/c/1/sessions', '?tab=schedule')).toBe(false);
    expect(shouldMoveFocusOnNavigation('/c/1/compendium', '/c/1/compendium', '?q=fire')).toBe(false);
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
});
