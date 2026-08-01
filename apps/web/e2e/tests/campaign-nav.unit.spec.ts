import { expect, test } from '@playwright/test';
import type { TFunction } from 'i18next';
import {
  buildCampaignNavGroups,
  flattenNavGroups,
  isActiveNavPath,
  MOBILE_TAB_BAR_KEYS,
  navGroupsForMoreSheet,
} from '../../src/app/campaignNav';

const t = ((key: string) => key) as TFunction;

test.describe('campaign nav IA (#643)', () => {
  test('groups routes into Play, Prepare, World, Records, Manage', () => {
    const groups = buildCampaignNavGroups(t, 42, {
      isDm: true,
      aiDriverActive: true,
      inboxCount: 2,
      pendingProposals: 1,
      trashCount: 3,
    });
    expect(groups.map((g) => g.key)).toEqual(['play', 'prepare', 'world', 'records', 'manage']);
    expect(groups.find((g) => g.key === 'play')?.items.map((i) => i.key)).toEqual([
      'dashboard',
      'party',
      'inventory',
      'encounters',
      'table',
      'notes',
    ]);
    expect(groups.find((g) => g.key === 'manage')?.items.map((i) => i.key)).toEqual([
      'settings',
      'inbox',
      'proposals',
      'trash',
      'members',
      // Moderation (issue #597 — block, mute, direct silence) sits with the other
      // per-campaign administration entries, above the audit log.
      'moderation',
      'audit',
    ]);
  });

  test('player Manage group exposes my proposals and your data', () => {
    const groups = buildCampaignNavGroups(t, 7, {
      isDm: false,
      aiDriverActive: false,
      inboxCount: 0,
      pendingProposals: 0,
      trashCount: 0,
    });
    const manage = groups.find((g) => g.key === 'manage');
    expect(manage?.items).toEqual([
      { key: 'proposals', label: 'nav.myProposals', to: '/c/7/proposals', termId: 'proposals' },
      // A player reaches the same route as "My reports" (issue #597) — their own
      // block/mute list, not the DM's moderation queue.
      { key: 'moderation', label: 'nav.myReports', to: '/c/7/moderation' },
      { key: 'membership', label: 'nav.yourData', to: '/c/7/members' },
    ]);
    expect(groups.find((g) => g.key === 'prepare')?.items.some((i) => i.key === 'storylines')).toBe(false);
  });

  test('More sheet omits tab-bar duplicates', () => {
    const groups = buildCampaignNavGroups(t, 1, {
      isDm: true,
      aiDriverActive: false,
      inboxCount: 0,
      pendingProposals: 0,
      trashCount: 0,
    });
    const more = navGroupsForMoreSheet(groups);
    const keys = flattenNavGroups(more).map((i) => i.key);
    for (const tabKey of MOBILE_TAB_BAR_KEYS) {
      expect(keys).not.toContain(tabKey);
    }
    expect(keys).toContain('members');
    expect(keys).toContain('inventory');
  });

  test('isActiveNavPath marks dashboard exactly and children by prefix', () => {
    expect(isActiveNavPath('/c/5', '/c/5', 5)).toBe(true);
    expect(isActiveNavPath('/c/5/quests', '/c/5', 5)).toBe(false);
    expect(isActiveNavPath('/c/5/quests', '/c/5/quests', 5)).toBe(true);
    expect(isActiveNavPath('/c/5/quests/3', '/c/5/quests', 5)).toBe(true);
  });
});
