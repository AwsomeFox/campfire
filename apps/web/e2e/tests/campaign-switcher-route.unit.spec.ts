/**
 * Issue #760 — campaign switcher preserves equivalent module or last safe route.
 *
 * DOM-free coverage for the pure resolver + user-namespaced storage used by
 * Layout (remember) and HomePage (chooser). Scenarios: multi-campaign roles,
 * DM-only modules, archived campaigns, expired/removed memberships, shared
 * devices (per-user keys), and unsaved-work confirmation.
 */
import { expect, test } from '@playwright/test';
import type { Campaign, Role } from '@campfire/schema';
import {
  campaignDashboardPath,
  campaignModulePath,
  clearCampaignSwitcherForUser,
  filterChooserCampaigns,
  forgetCampaignRoute,
  getLastSafeCampaignRoute,
  isModuleAllowedForRole,
  isSafeCampaignRoute,
  listRecentCampaignIds,
  parseCampaignPath,
  rememberCampaignRoute,
  resolveCampaignSwitchTarget,
  switchFromPath,
  type CampaignSwitcherStorage,
} from '../../src/lib/campaignSwitcherRoute';
import {
  clearAllUnsavedWork,
  confirmDiscardUnsavedWork,
  hasUnsavedWork,
  setUnsavedWork,
  UNSAVED_WORK_CONFIRM_MESSAGE,
} from '../../src/lib/unsavedWork';

class MemoryStorage {
  private data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.has(key) ? this.data.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

function campaign(
  id: number,
  overrides: Partial<Campaign> = {},
): Campaign {
  return {
    id,
    name: `Campaign ${id}`,
    description: '',
    status: 'active',
    currentLocationId: null,
    dangerLevel: 'low',
    dmControlsProgression: false,
    publicRecapSharingEnabled: true,
    publicInvitesEnabled: true,
    sessionCount: 0,
    ruleSystem: '',
    mapAttachmentId: null,
    storageQuotaBytes: null,
    deletedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test.describe('parseCampaignPath / module mapping (#760)', () => {
  test('dashboard and module roots parse', () => {
    expect(parseCampaignPath('/c/12')).toEqual({
      campaignId: 12,
      module: 'dashboard',
      modulePath: '/c/12',
      pathname: '/c/12',
    });
    expect(parseCampaignPath('/c/12/quests')?.module).toBe('quests');
    expect(parseCampaignPath('/c/12/locations/9')?.modulePath).toBe('/c/12/locations');
  });

  test('detail URLs collapse to module root for equivalence', () => {
    const parsed = parseCampaignPath('/c/3/npcs/99');
    expect(parsed).toMatchObject({ campaignId: 3, module: 'npcs', modulePath: '/c/3/npcs' });
    expect(campaignModulePath(7, 'npcs')).toBe('/c/7/npcs');
  });

  test('strips query/hash and rejects screen / unknown / non-campaign', () => {
    expect(parseCampaignPath('/c/1/quests?x=1')?.module).toBe('quests');
    expect(parseCampaignPath('/c/1/screen')).toBeNull();
    expect(parseCampaignPath('/c/1/nope')).toBeNull();
    expect(parseCampaignPath('/admin')).toBeNull();
    expect(parseCampaignPath('/c/0/quests')).toBeNull();
  });
});

test.describe('role validation (#760)', () => {
  test('DM-only modules require dm', () => {
    for (const module of ['settings', 'members', 'inbox', 'trash', 'storylines'] as const) {
      expect(isModuleAllowedForRole(module, 'dm')).toBe(true);
      expect(isModuleAllowedForRole(module, 'player')).toBe(false);
      expect(isModuleAllowedForRole(module, 'viewer')).toBe(false);
      expect(isModuleAllowedForRole(module, null)).toBe(false);
    }
  });

  test('shared modules allowed for player/viewer', () => {
    expect(isModuleAllowedForRole('quests', 'player')).toBe(true);
    expect(isModuleAllowedForRole('notes', 'viewer')).toBe(true);
  });

  test('isSafeCampaignRoute rejects other campaigns and DM surfaces for players', () => {
    expect(isSafeCampaignRoute('/c/2/quests', 2, 'player')).toBe(true);
    expect(isSafeCampaignRoute('/c/2/quests/5', 2, 'player')).toBe(true);
    expect(isSafeCampaignRoute('/c/9/quests', 2, 'player')).toBe(false);
    expect(isSafeCampaignRoute('/c/2/settings', 2, 'player')).toBe(false);
    expect(isSafeCampaignRoute('/c/2/settings', 2, 'dm')).toBe(true);
    expect(isSafeCampaignRoute('//evil', 2, 'dm')).toBe(false);
  });
});

test.describe('resolveCampaignSwitchTarget (#760)', () => {
  test('prefers equivalent module when role allows', () => {
    expect(
      resolveCampaignSwitchTarget({
        targetCampaignId: 2,
        role: 'dm',
        campaignAccessible: true,
        sourcePath: '/c/1/quests/44',
        lastSafeRoute: '/c/2/sessions',
      }),
    ).toBe('/c/2/quests');
  });

  test('falls back to last safe when equivalent module is DM-only for player', () => {
    expect(
      resolveCampaignSwitchTarget({
        targetCampaignId: 2,
        role: 'player',
        campaignAccessible: true,
        sourcePath: '/c/1/settings',
        lastSafeRoute: '/c/2/party',
      }),
    ).toBe('/c/2/party');
  });

  test('falls back to dashboard when no equivalent and no last safe', () => {
    expect(
      resolveCampaignSwitchTarget({
        targetCampaignId: 5,
        role: 'viewer',
        campaignAccessible: true,
        sourcePath: '/c/1/settings',
        lastSafeRoute: null,
      }),
    ).toBe('/c/5');
  });

  test('explicit Dashboard wins over equivalent and last safe', () => {
    expect(
      resolveCampaignSwitchTarget({
        targetCampaignId: 2,
        role: 'dm',
        campaignAccessible: true,
        sourcePath: '/c/1/encounters',
        lastSafeRoute: '/c/2/notes',
        preferDashboard: true,
      }),
    ).toBe(campaignDashboardPath(2));
  });

  test('table is never treated as equivalent across campaigns', () => {
    expect(
      resolveCampaignSwitchTarget({
        targetCampaignId: 2,
        role: 'player',
        campaignAccessible: true,
        sourcePath: '/c/1/table',
        lastSafeRoute: '/c/2/compendium',
      }),
    ).toBe('/c/2/compendium');
  });

  test('inaccessible / expired membership fails closed to hub', () => {
    expect(
      resolveCampaignSwitchTarget({
        targetCampaignId: 2,
        role: null,
        campaignAccessible: false,
        sourcePath: '/c/1/quests',
        lastSafeRoute: '/c/2/quests',
      }),
    ).toBe('/');
  });

  test('archived (paused) campaign still restores routes when membership remains', () => {
    expect(
      resolveCampaignSwitchTarget({
        targetCampaignId: 8,
        role: 'dm',
        campaignAccessible: true,
        sourcePath: '/c/1/timeline',
        lastSafeRoute: '/c/8/sessions/3',
      }),
    ).toBe('/c/8/timeline');
  });

  test('last-safe DM path is rejected after demotion to player', () => {
    expect(
      resolveCampaignSwitchTarget({
        targetCampaignId: 2,
        role: 'player',
        campaignAccessible: true,
        sourcePath: null,
        lastSafeRoute: '/c/2/members',
      }),
    ).toBe('/c/2');
  });
});

test.describe('user-namespaced storage / shared devices (#760)', () => {
  test('routes are isolated per userId', () => {
    const store = new MemoryStorage();
    rememberCampaignRoute(1, '/c/10/quests', 100, store);
    rememberCampaignRoute(2, '/c/10/notes', 100, store);

    expect(getLastSafeCampaignRoute(1, 10, 'dm', store)).toBe('/c/10/quests');
    expect(getLastSafeCampaignRoute(2, 10, 'dm', store)).toBe('/c/10/notes');
  });

  test('recent list prunes campaigns the user can no longer access', () => {
    const store = new MemoryStorage();
    rememberCampaignRoute(1, '/c/1/quests', 1, store);
    rememberCampaignRoute(1, '/c/2/quests', 2, store);
    rememberCampaignRoute(1, '/c/3/quests', 3, store);

    const recent = listRecentCampaignIds(1, new Set([1, 3]), store);
    expect(recent).toEqual([3, 1]);
    // Stale campaign 2 memory dropped.
    expect(getLastSafeCampaignRoute(1, 2, 'dm', store)).toBeNull();
  });

  test('forget + clear remove memory (logout / trash)', () => {
    const store = new MemoryStorage();
    rememberCampaignRoute(9, '/c/4/encounters', 1, store);
    forgetCampaignRoute(9, 4, store);
    expect(getLastSafeCampaignRoute(9, 4, 'dm', store)).toBeNull();

    rememberCampaignRoute(9, '/c/5/notes', 1, store);
    clearCampaignSwitcherForUser(9, store);
    expect(getLastSafeCampaignRoute(9, 5, 'dm', store)).toBeNull();
  });

  test('getLastSafeCampaignRoute hides DM-only paths from players', () => {
    const store = new MemoryStorage();
    rememberCampaignRoute(1, '/c/2/settings', 1, store);
    expect(getLastSafeCampaignRoute(1, 2, 'dm', store)).toBe('/c/2/settings');
    expect(getLastSafeCampaignRoute(1, 2, 'player', store)).toBeNull();
  });

  test('storage JSON round-trips', () => {
    const store = new MemoryStorage();
    rememberCampaignRoute(3, '/c/1/party', 50, store);
    const raw = store.getItem('campfire.campaignSwitcher.v1.3');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!) as CampaignSwitcherStorage;
    expect(parsed.recent[0]).toBe(1);
    expect(parsed.byCampaign['1']?.path).toBe('/c/1/party');
  });
});

test.describe('chooser filters (#760)', () => {
  test('search + role + status filters compose', () => {
    const items = [
      { campaign: campaign(1, { name: 'Ash Road', status: 'active', description: 'dragons' }), role: 'dm' as Role },
      { campaign: campaign(2, { name: 'Glass Sea', status: 'paused' }), role: 'player' as Role },
      { campaign: campaign(3, { name: 'Ashen Vault', status: 'completed' }), role: 'viewer' as Role },
      { campaign: campaign(4, { name: 'Gone', deletedAt: '2026-02-01T00:00:00.000Z' }), role: 'dm' as Role },
    ];

    expect(filterChooserCampaigns(items, { query: 'ash', role: 'all', status: 'all' }).map((i) => i.campaign.id)).toEqual([
      1,
      3,
    ]);
    expect(filterChooserCampaigns(items, { query: '', role: 'player', status: 'all' }).map((i) => i.campaign.id)).toEqual([
      2,
    ]);
    expect(
      filterChooserCampaigns(items, { query: '', role: 'all', status: 'paused' }).map((i) => i.campaign.id),
    ).toEqual([2]);
    // Deleted never listed.
    expect(filterChooserCampaigns(items, { query: 'Gone', role: 'all', status: 'all' })).toEqual([]);
  });
});

test.describe('switchFrom location state (#760)', () => {
  test('reads switchFrom when it is a campaign path', () => {
    expect(switchFromPath({ switchFrom: '/c/4/encounters/2' })).toBe('/c/4/encounters/2');
    expect(switchFromPath({ switchFrom: '/admin' })).toBeNull();
    expect(switchFromPath(null)).toBeNull();
  });
});

test.describe('unsaved-work protection (#760)', () => {
  test.beforeEach(() => {
    clearAllUnsavedWork();
  });

  test('confirm proceeds when clean', () => {
    expect(hasUnsavedWork()).toBe(false);
    expect(confirmDiscardUnsavedWork(() => false)).toBe(true);
  });

  test('confirm asks when dirty and honors cancel/accept', () => {
    setUnsavedWork('settings', true);
    expect(hasUnsavedWork()).toBe(true);
    expect(confirmDiscardUnsavedWork(() => false)).toBe(false);
    expect(
      confirmDiscardUnsavedWork((message) => {
        expect(message).toBe(UNSAVED_WORK_CONFIRM_MESSAGE);
        return true;
      }),
    ).toBe(true);
    setUnsavedWork('settings', false);
    expect(hasUnsavedWork()).toBe(false);
  });
});

test.describe('multi-campaign role matrix (#760)', () => {
  test('DM in A / player in B: settings → last safe notes in B', () => {
    const store = new MemoryStorage();
    rememberCampaignRoute(1, '/c/2/notes', 1, store);
    const target = resolveCampaignSwitchTarget({
      targetCampaignId: 2,
      role: 'player',
      campaignAccessible: true,
      sourcePath: '/c/1/settings',
      lastSafeRoute: getLastSafeCampaignRoute(1, 2, 'player', store),
    });
    expect(target).toBe('/c/2/notes');
  });

  test('player in A / DM in B: quests → equivalent quests in B', () => {
    expect(
      resolveCampaignSwitchTarget({
        targetCampaignId: 2,
        role: 'dm',
        campaignAccessible: true,
        sourcePath: '/c/1/quests',
        lastSafeRoute: '/c/2/members',
      }),
    ).toBe('/c/2/quests');
  });
});
