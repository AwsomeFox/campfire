import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { CampaignMember, CampaignSummary } from '@campfire/schema';
import { api, API } from '../../lib/api';
import { queryKeys, useAiDmSeat } from '../../lib/query';
import { useAnnounce } from '../../components/Announcer';
import { Card, Btn } from '../../components/ui';
import { GameIcon } from '../../components/GameIcon';
import { deriveCampaignOnboarding, type CampaignOnboardingStep } from './campaignOnboarding';
import {
  persistCampaignOnboardingPrefs,
  readCampaignOnboardingPrefs,
  type CampaignOnboardingPrefs,
} from './campaignOnboardingState';
import { UI_ICON_SIZE } from '../../lib/uiIcons';

export function CampaignOnboardingCard({
  campaignId,
  summary,
  isDm,
}: {
  campaignId: number;
  summary: CampaignSummary;
  isDm: boolean;
}) {
  const { t } = useTranslation();
  const announce = useAnnounce();
  const [prefs, setPrefs] = useState<CampaignOnboardingPrefs>(() =>
    readCampaignOnboardingPrefs(typeof localStorage === 'undefined' ? null : localStorage, campaignId),
  );

  useEffect(() => {
    setPrefs(readCampaignOnboardingPrefs(typeof localStorage === 'undefined' ? null : localStorage, campaignId));
  }, [campaignId]);

  const membersQuery = useQuery({
    queryKey: queryKeys.campaignMembers(campaignId),
    queryFn: () => api.get<CampaignMember[]>(`${API}/campaigns/${campaignId}/members`),
    enabled: isDm,
  });
  const aiSeatQuery = useAiDmSeat(isDm ? campaignId : undefined);

  const updatePrefs = useCallback((patch: Partial<CampaignOnboardingPrefs>, announcement: string) => {
    setPrefs((current) => {
      const next = { ...current, ...patch };
      persistCampaignOnboardingPrefs(typeof localStorage === 'undefined' ? null : localStorage, campaignId, next);
      return next;
    });
    announce(announcement);
  }, [announce, campaignId]);

  const plan = useMemo(() => deriveCampaignOnboarding(summary, {
    campaignId,
    memberCount: membersQuery.data?.length ?? null,
    soloMode: prefs.soloMode,
    aiAvailable: Boolean(aiSeatQuery.data) && !aiSeatQuery.isError,
    aiEnabled: Boolean(aiSeatQuery.data && aiSeatQuery.data.mode !== 'off'),
    compendiumAvailable: Boolean(summary.campaign.ruleSystem),
  }), [aiSeatQuery.data, aiSeatQuery.isError, campaignId, membersQuery.data, prefs.soloMode, summary]);

  if (!isDm) return null;
  if (plan.complete) return null;

  if (prefs.skipped) {
    return (
      <Card
        density="compact"
        className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
        data-testid="campaign-onboarding-resume"
      >
        <div className="min-w-0">
          <p className="text-sm font-bold text-[var(--color-text)]">{t('campaignOnboarding.paused.title')}</p>
          <p className="text-xs text-[var(--color-neutral-400)] mt-0.5">
            {t('campaignOnboarding.paused.body', { done: plan.doneCount, total: plan.totalCount })}
          </p>
        </div>
        <Btn
          type="button"
          density="compact"
          className="w-full sm:w-auto"
          onClick={() => updatePrefs({ skipped: false, checklistOpen: true }, t('campaignOnboarding.announcements.resumed'))}
        >
          {t('campaignOnboarding.actions.resume')}
        </Btn>
      </Card>
    );
  }

  const next = plan.nextStep;
  const checklistId = `campaign-onboarding-checklist-${campaignId}`;

  return (
    <Card density="default" className="space-y-4" data-testid="campaign-onboarding-card" aria-labelledby="campaign-onboarding-title">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3 min-w-0">
          <span className="flex shrink-0 text-[var(--color-accent)]" aria-hidden>
            <GameIcon slug="campfire" size={UI_ICON_SIZE.lg} />
          </span>
          <div className="min-w-0">
            <p id="campaign-onboarding-title" className="font-bold text-[var(--color-text)]">
              {t('campaignOnboarding.title')}
            </p>
            <p className="text-xs text-[var(--color-neutral-400)] mt-0.5">
              {t('campaignOnboarding.intro', { done: plan.doneCount, total: plan.totalCount })}
            </p>
            {plan.homebrew && (
              <p className="text-[11px] text-[var(--color-neutral-400)] mt-1">
                {t('campaignOnboarding.homebrewNote')}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 sm:shrink-0">
          <Btn
            type="button"
            density="compact"
            ghost
            className="text-xs flex-1 sm:flex-none"
            aria-expanded={prefs.checklistOpen}
            aria-controls={checklistId}
            onClick={() => updatePrefs(
              { checklistOpen: !prefs.checklistOpen },
              prefs.checklistOpen
                ? t('campaignOnboarding.announcements.checklistHidden')
                : t('campaignOnboarding.announcements.checklistShown'),
            )}
          >
            {prefs.checklistOpen ? t('campaignOnboarding.actions.hideChecklist') : t('campaignOnboarding.actions.showChecklist')}
          </Btn>
          <Btn
            type="button"
            density="compact"
            ghost
            className="text-xs flex-1 sm:flex-none"
            onClick={() => updatePrefs({ skipped: true }, t('campaignOnboarding.announcements.skipped'))}
          >
            {t('campaignOnboarding.actions.skip')}
          </Btn>
        </div>
      </div>

      {plan.complete ? (
        <div className="cf-inset p-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between" data-testid="campaign-onboarding-complete">
          <div>
            <p className="text-sm font-semibold text-[var(--color-accent)]">{t('campaignOnboarding.complete.title')}</p>
            <p className="text-xs text-[var(--color-neutral-400)] mt-0.5">{t('campaignOnboarding.complete.body')}</p>
          </div>
          <Link to={`/c/${campaignId}/sessions`} className="cf-btn cf-density-compact text-xs no-underline justify-center">
            {t('campaignOnboarding.complete.action')}
          </Link>
        </div>
      ) : next ? (
        <NextActionPanel
          step={next}
          soloMode={plan.solo}
          onSolo={() => updatePrefs(
            { soloMode: true },
            t('campaignOnboarding.announcements.soloEnabled'),
          )}
        />
      ) : null}

      {prefs.checklistOpen && (
        <ol id={checklistId} className="space-y-2.5" aria-label={t('campaignOnboarding.checklistLabel')}>
          {plan.visibleSteps.map((step) => (
            <ChecklistRow key={step.id} step={step} current={step.id === next?.id} />
          ))}
        </ol>
      )}
    </Card>
  );
}

function NextActionPanel({
  step,
  soloMode,
  onSolo,
}: {
  step: CampaignOnboardingStep;
  soloMode: boolean;
  onSolo: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="cf-inset p-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between" data-testid="campaign-onboarding-next">
      <div className="min-w-0">
        <p className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-neutral-400)]">
          {t('campaignOnboarding.nextLabel')}
        </p>
        <p className="text-sm font-semibold text-[var(--color-text)] mt-0.5">{t(step.titleKey)}</p>
        <p className="text-xs text-[var(--color-neutral-400)] mt-0.5">{t(step.bodyKey)}</p>
      </div>
      <div className="flex flex-col sm:flex-row gap-2 sm:shrink-0">
        {step.id === 'invite' && !soloMode && (
          <Btn type="button" density="compact" ghost className="text-xs" onClick={onSolo}>
            {t('campaignOnboarding.actions.solo')}
          </Btn>
        )}
        <Link to={step.href} className="cf-btn cf-density-compact text-xs no-underline justify-center">
          {t(step.actionKey)}
        </Link>
      </div>
    </div>
  );
}

function ChecklistRow({ step, current }: { step: CampaignOnboardingStep; current: boolean }) {
  const { t } = useTranslation();
  return (
    <li
      className="flex gap-2.5"
      aria-current={current ? 'step' : undefined}
      data-testid={`campaign-onboarding-step-${step.id}`}
      data-done={step.done ? 'true' : 'false'}
    >
      <span
        className="shrink-0 mt-0.5 text-sm font-bold"
        style={{ color: step.done ? 'var(--color-accent)' : 'var(--color-neutral-600)' }}
        aria-hidden
      >
        {step.done ? '✓' : '○'}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-[var(--color-neutral-200)]">{t(step.titleKey)}</span>
          <span className="text-[10px] text-secondary">{t(step.badgeKey)}</span>
        </div>
        <p className="text-xs text-[var(--color-neutral-400)] mt-0.5">{t(step.bodyKey)}</p>
        <Link to={step.href} className="cf-btn cf-btn-ghost cf-density-compact text-xs mt-1.5 inline-flex no-underline">
          {t(step.actionKey)} →
        </Link>
      </div>
    </li>
  );
}
