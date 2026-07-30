import type { CampaignSummary } from '@campfire/schema';

export type CampaignOnboardingStepId =
  | 'rules'
  | 'ai'
  | 'compendium'
  | 'invite'
  | 'party'
  | 'adventure'
  | 'encounter'
  | 'rewards'
  | 'recap';

export type CampaignOnboardingStepKind = 'core' | 'helper';

export interface CampaignOnboardingContext {
  campaignId: number;
  /** Total campaign members, including the DM. `null` means the member read is still unknown. */
  memberCount?: number | null;
  /** User-chosen dashboard preference: this campaign is being run without invited players for now. */
  soloMode?: boolean;
  /** Whether AI-DM setup is a meaningful optional helper for this campaign/server. */
  aiAvailable?: boolean;
  /** Whether the AI-DM is already enabled for this campaign. */
  aiEnabled?: boolean;
  /** Whether a rules-backed compendium exists for this campaign. */
  compendiumAvailable?: boolean;
}

export interface CampaignOnboardingStep {
  id: CampaignOnboardingStepId;
  kind: CampaignOnboardingStepKind;
  done: boolean;
  hidden: boolean;
  href: string;
  titleKey: string;
  bodyKey: string;
  actionKey: string;
  badgeKey: string;
}

export interface CampaignOnboardingPlan {
  steps: CampaignOnboardingStep[];
  visibleSteps: CampaignOnboardingStep[];
  coreSteps: CampaignOnboardingStep[];
  nextStep: CampaignOnboardingStep | null;
  doneCount: number;
  totalCount: number;
  complete: boolean;
  homebrew: boolean;
  solo: boolean;
}

type SummaryInput = Pick<
  CampaignSummary,
  'campaign' | 'characters' | 'party' | 'quests' | 'locations' | 'encounters' | 'sessions' | 'inventoryCount' | 'treasury'
>;

function hasParty(summary: SummaryInput): boolean {
  return summary.party.some((character) => character.status === 'active');
}

function hasAdventureSeed(summary: SummaryInput): boolean {
  return summary.quests.length > 0 || summary.locations.length > 0;
}

function hasRewards(summary: SummaryInput): boolean {
  const hasCoins = Object.values(summary.treasury).some((value) => value > 0);
  const hasProgress = summary.characters.some((character) => character.xp > 0 || character.level > 1);
  return summary.inventoryCount > 0 || hasCoins || hasProgress;
}

function hasRecap(summary: SummaryInput): boolean {
  return summary.sessions.some((session) => Boolean(session.recapExcerpt?.trim()));
}

function coreBadge(done: boolean): string {
  return done ? 'campaignOnboarding.badges.done' : 'campaignOnboarding.badges.todo';
}

function helperBadge(done: boolean): string {
  return done ? 'campaignOnboarding.badges.ready' : 'campaignOnboarding.badges.optional';
}

/**
 * Derive the one-shot runway from already-loaded dashboard state.
 *
 * The core path is intentionally linear: invite/solo -> party -> adventure -> encounter
 * -> rewards -> recap. Optional helper steps can appear in the checklist, but they never
 * steal the single fast-path CTA from the first incomplete core step.
 */
export function deriveCampaignOnboarding(
  summary: SummaryInput,
  ctx: CampaignOnboardingContext,
): CampaignOnboardingPlan {
  const campaignId = ctx.campaignId;
  const homebrew = summary.campaign.ruleSystem === '';
  const solo = Boolean(ctx.soloMode);
  const memberCount = ctx.memberCount ?? null;
  const invited = solo || (memberCount != null && memberCount > 1);
  const partyDone = hasParty(summary);
  const adventureDone = hasAdventureSeed(summary);
  const encounterDone = summary.encounters.length > 0;
  const rewardsDone = hasRewards(summary);
  const recapDone = hasRecap(summary);
  const compendiumAvailable = ctx.compendiumAvailable ?? !homebrew;

  const steps: CampaignOnboardingStep[] = [
    {
      id: 'rules',
      kind: 'helper',
      done: true,
      hidden: false,
      href: `/c/${campaignId}/settings#campaign-rules`,
      titleKey: homebrew ? 'campaignOnboarding.steps.rules.homebrewTitle' : 'campaignOnboarding.steps.rules.rulesetTitle',
      bodyKey: homebrew ? 'campaignOnboarding.steps.rules.homebrewBody' : 'campaignOnboarding.steps.rules.rulesetBody',
      actionKey: 'campaignOnboarding.steps.rules.action',
      badgeKey: 'campaignOnboarding.badges.ready',
    },
    {
      id: 'ai',
      kind: 'helper',
      done: Boolean(ctx.aiEnabled),
      hidden: !ctx.aiAvailable,
      href: `/c/${campaignId}/settings#ai-dm-mode`,
      titleKey: 'campaignOnboarding.steps.ai.title',
      bodyKey: ctx.aiEnabled ? 'campaignOnboarding.steps.ai.doneBody' : 'campaignOnboarding.steps.ai.todoBody',
      actionKey: ctx.aiEnabled ? 'campaignOnboarding.steps.ai.doneAction' : 'campaignOnboarding.steps.ai.todoAction',
      badgeKey: helperBadge(Boolean(ctx.aiEnabled)),
    },
    {
      id: 'compendium',
      kind: 'helper',
      done: compendiumAvailable,
      hidden: !compendiumAvailable,
      href: `/c/${campaignId}/compendium`,
      titleKey: 'campaignOnboarding.steps.compendium.title',
      bodyKey: 'campaignOnboarding.steps.compendium.body',
      actionKey: 'campaignOnboarding.steps.compendium.action',
      badgeKey: 'campaignOnboarding.badges.ready',
    },
    {
      id: 'invite',
      kind: 'core',
      done: invited,
      hidden: solo,
      href: `/c/${campaignId}/members#invite`,
      titleKey: 'campaignOnboarding.steps.invite.title',
      bodyKey: memberCount == null ? 'campaignOnboarding.steps.invite.unknownBody' : 'campaignOnboarding.steps.invite.body',
      actionKey: 'campaignOnboarding.steps.invite.action',
      badgeKey: coreBadge(invited),
    },
    {
      id: 'party',
      kind: 'core',
      done: partyDone,
      hidden: false,
      href: `/c/${campaignId}/party?action=new`,
      titleKey: 'campaignOnboarding.steps.party.title',
      bodyKey: 'campaignOnboarding.steps.party.body',
      actionKey: 'campaignOnboarding.steps.party.action',
      badgeKey: coreBadge(partyDone),
    },
    {
      id: 'adventure',
      kind: 'core',
      done: adventureDone,
      hidden: false,
      href: summary.quests.length === 0 ? `/c/${campaignId}/quests/new` : `/c/${campaignId}/locations?action=new`,
      titleKey: 'campaignOnboarding.steps.adventure.title',
      bodyKey: 'campaignOnboarding.steps.adventure.body',
      actionKey: summary.quests.length === 0
        ? 'campaignOnboarding.steps.adventure.questAction'
        : 'campaignOnboarding.steps.adventure.locationAction',
      badgeKey: coreBadge(adventureDone),
    },
    {
      id: 'encounter',
      kind: 'core',
      done: encounterDone,
      hidden: false,
      href: `/c/${campaignId}/encounters?action=new`,
      titleKey: 'campaignOnboarding.steps.encounter.title',
      bodyKey: 'campaignOnboarding.steps.encounter.body',
      actionKey: 'campaignOnboarding.steps.encounter.action',
      badgeKey: coreBadge(encounterDone),
    },
    {
      id: 'rewards',
      kind: 'core',
      done: rewardsDone,
      hidden: false,
      href: `/c/${campaignId}/inventory?action=add-item`,
      titleKey: 'campaignOnboarding.steps.rewards.title',
      bodyKey: 'campaignOnboarding.steps.rewards.body',
      actionKey: 'campaignOnboarding.steps.rewards.action',
      badgeKey: coreBadge(rewardsDone),
    },
    {
      id: 'recap',
      kind: 'core',
      done: recapDone,
      hidden: false,
      href: `/c/${campaignId}/sessions?action=new-recap`,
      titleKey: 'campaignOnboarding.steps.recap.title',
      bodyKey: 'campaignOnboarding.steps.recap.body',
      actionKey: 'campaignOnboarding.steps.recap.action',
      badgeKey: coreBadge(recapDone),
    },
  ];

  const visibleSteps = steps.filter((step) => !step.hidden);
  const coreSteps = visibleSteps.filter((step) => step.kind === 'core');
  const nextStep = coreSteps.find((step) => !step.done) ?? null;
  const doneCount = coreSteps.filter((step) => step.done).length;
  const totalCount = coreSteps.length;

  return {
    steps,
    visibleSteps,
    coreSteps,
    nextStep,
    doneCount,
    totalCount,
    complete: nextStep == null,
    homebrew,
    solo,
  };
}
