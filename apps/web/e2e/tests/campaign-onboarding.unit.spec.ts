import { expect, test } from '@playwright/test';
import { deriveCampaignOnboarding } from '../../src/features/dashboard/campaignOnboarding';
import {
  campaignOnboardingStorageKey,
  persistCampaignOnboardingPrefs,
  readCampaignOnboardingPrefs,
} from '../../src/features/dashboard/campaignOnboardingState';

type SummaryInput = Parameters<typeof deriveCampaignOnboarding>[0];

function summary(overrides: Partial<SummaryInput> = {}): SummaryInput {
  return {
    campaign: { ruleSystem: '' },
    characters: [],
    party: [],
    quests: [],
    locations: [],
    encounters: [],
    sessions: [],
    inventoryCount: 0,
    treasury: { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 },
    ...overrides,
  } as SummaryInput;
}

test.describe('campaign one-shot onboarding derivation (#507)', () => {
  test('starts an empty homebrew campaign at invite and hides unavailable helpers', () => {
    const plan = deriveCampaignOnboarding(summary(), {
      campaignId: 42,
      memberCount: 1,
      aiAvailable: false,
      compendiumAvailable: false,
    });

    expect(plan.homebrew).toBe(true);
    expect(plan.nextStep?.id).toBe('invite');
    expect(plan.doneCount).toBe(0);
    expect(plan.totalCount).toBe(6);
    expect(plan.steps.find((step) => step.id === 'ai')?.hidden).toBe(true);
    expect(plan.steps.find((step) => step.id === 'compendium')?.hidden).toBe(true);
    expect(plan.visibleSteps.map((step) => step.id)).toEqual([
      'rules',
      'invite',
      'party',
      'adventure',
      'encounter',
      'rewards',
      'recap',
    ]);
  });

  test('solo mode skips invitations and resumes at party setup', () => {
    const plan = deriveCampaignOnboarding(summary(), {
      campaignId: 42,
      memberCount: 1,
      soloMode: true,
    });

    expect(plan.solo).toBe(true);
    expect(plan.steps.find((step) => step.id === 'invite')?.hidden).toBe(true);
    expect(plan.nextStep?.id).toBe('party');
    expect(plan.totalCount).toBe(5);
  });

  test('optional AI and compendium helpers do not steal the fast-path CTA', () => {
    const plan = deriveCampaignOnboarding(summary({
      campaign: { ruleSystem: 'e2e-open5e-actions' },
    } as Partial<SummaryInput>), {
      campaignId: 42,
      memberCount: 2,
      aiAvailable: true,
      aiEnabled: false,
      compendiumAvailable: true,
    });

    expect(plan.homebrew).toBe(false);
    expect(plan.visibleSteps.map((step) => step.id).slice(0, 4)).toEqual(['rules', 'ai', 'compendium', 'invite']);
    expect(plan.steps.find((step) => step.id === 'ai')?.done).toBe(false);
    expect(plan.nextStep?.id).toBe('party');
  });

  test('detects completion through party, adventure, encounter, reward, and recap state', () => {
    const plan = deriveCampaignOnboarding(summary({
      characters: [{ status: 'active', xp: 0, level: 1 }],
      party: [{ id: 1, name: 'Aria', status: 'active' }],
      quests: [{ title: 'A one-shot hook' }],
      encounters: [{ status: 'ended' }],
      sessions: [{ recapExcerpt: 'The party saved the lighthouse.' }],
      inventoryCount: 1,
    } as Partial<SummaryInput>), {
      campaignId: 42,
      memberCount: 3,
    });

    expect(plan.complete).toBe(true);
    expect(plan.nextStep).toBeNull();
    expect(plan.doneCount).toBe(plan.totalCount);
  });

  test('counts XP and coins as reward progress', () => {
    const xpPlan = deriveCampaignOnboarding(summary({
      characters: [{ status: 'active', xp: 50, level: 1 }],
    } as Partial<SummaryInput>), { campaignId: 42, memberCount: 2 });
    expect(xpPlan.steps.find((step) => step.id === 'rewards')?.done).toBe(true);

    const coinPlan = deriveCampaignOnboarding(summary({
      treasury: { cp: 0, sp: 0, ep: 0, gp: 25, pp: 0 },
    }), { campaignId: 42, memberCount: 2 });
    expect(coinPlan.steps.find((step) => step.id === 'rewards')?.done).toBe(true);
  });
});

test.describe('campaign onboarding localStorage state (#507)', () => {
  test('round-trips per-campaign preferences and tolerates bad storage', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };

    expect(readCampaignOnboardingPrefs(storage, 7)).toEqual({
      skipped: false,
      checklistOpen: false,
      soloMode: false,
    });
    expect(persistCampaignOnboardingPrefs(storage, 7, {
      skipped: true,
      checklistOpen: true,
      soloMode: true,
    })).toBe(true);
    expect(values.has(campaignOnboardingStorageKey(7))).toBe(true);
    expect(readCampaignOnboardingPrefs(storage, 7)).toEqual({
      skipped: true,
      checklistOpen: true,
      soloMode: true,
    });

    values.set(campaignOnboardingStorageKey(8), '{not json');
    expect(readCampaignOnboardingPrefs(storage, 8).skipped).toBe(false);
    expect(persistCampaignOnboardingPrefs(null, 8, {
      skipped: true,
      checklistOpen: true,
      soloMode: true,
    })).toBe(false);
  });
});
