/**
 * AI-DM onboarding & discoverability (issue #343).
 *
 * A new DM has no way to discover the AI DM: a server admin must flip an experimental
 * flag, then the DM must configure a provider + mode + budget deep in campaign settings.
 * Nothing teaches that path. This module makes it obvious:
 *
 *   - {@link AiSetupChecklist} — a stepper that reads REAL state (the seat, the provider
 *     config, and — for admins — the server flag) and deep-links each unmet step to the
 *     exact control that fixes it, naming who can complete it (admin vs DM).
 *   - {@link AiDmDashboardOnboarding} — a dismissible dashboard nudge for DMs whose seat
 *     is still off, expanding into the same checklist.
 *   - {@link AiGateExplainer} — renders the mapped explainer + deep link for a blocked AI
 *     action (see aiGate.ts), so a gate is never a bare 403 string.
 *   - {@link AiTransparencyNote} — the player-facing "what the AI sees" paragraph, reused
 *     by the mode badge and the checklist.
 *
 * All reads already exist; this is orchestration UI only (no new endpoints).
 */
import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { AI_COST_BASIS_UNKNOWN, aiDmReadinessProgress, aiDmSetupComplete, type AiDmReadiness } from '@campfire/schema';
import { api, API } from '../../lib/api';
import { formatNumber } from '../../lib/format';
import { queryKeys, useAiDmSeat } from '../../lib/query';
import { classifyAiGate } from './aiGate';
import { localizeDetailParams } from './aiReadiness';
import { CopyControl } from '../../components/CopyControl';
import { GameIcon } from '../../components/GameIcon';
import { Btn, Card } from '../../components/ui';
import { CostDisclosure } from './CostDisclosure';
import { formatUsdRangeValue } from './costEstimate';
import { UI_ICON_SIZE } from '../../lib/uiIcons';

/** One computed checklist step. `done: null` = state is unknown (e.g. flag, for a non-admin). */
interface Step {
  key: string;
  title: string;
  body: string;
  done: boolean | null;
  /** Who has to act. `table` = the players (e.g. support-note consent), not the DM. */
  actor: 'admin' | 'dm' | 'table';
  fix?: { label: string; to: string };
  /** Extra node rendered under an unmet step (e.g. the copyable admin request). */
  extra?: React.ReactNode;
}

/**
 * The setup stepper. Rendered on the Table page's off/gated empty state and (collapsed)
 * on the dashboard. Reads the seat + provider config for real state; when the viewer is a
 * server admin it also reads the server flag so step ① shows a true on/off rather than a
 * "ask your admin" note.
 */
export function AiSetupChecklist({
  campaignId,
  isAdmin,
  className = '',
}: {
  campaignId: number;
  isAdmin: boolean;
  className?: string;
}) {
  const { t } = useTranslation();

  const readinessQuery = useQuery({
    queryKey: queryKeys.aiDmReadiness(campaignId),
    queryFn: () => api.get<AiDmReadiness>(`${API}/campaigns/${campaignId}/ai-dm/readiness`),
  });
  const readiness = readinessQuery.data ?? null;

  if (readinessQuery.isLoading) {
    return <p className="text-xs text-secondary">{t('aiOnboarding.checklist.loading')}</p>;
  }

  if (!readiness) {
    return <p className="text-xs text-secondary">{t('aiOnboarding.checklist.unavailable')}</p>;
  }

  const mode = readiness.mode;
  const readinessSteps: Step[] = readiness.checks.map((check): Step => ({
    key: check.key,
    // Titles and CTA labels are stable per check KEY, so they stay localized here. The body
    // is localized off the check's `detailKey` (a stable id) with the server's live values
    // interpolated; the server's English `detail` is only the fallback for an id this build
    // does not carry, so a newer server never blanks a row (#629 keeps the checklist
    // translatable rather than pinned to the server's English).
    title: t(`aiOnboarding.checklist.checkTitles.${check.key}`, { defaultValue: check.title }),
    body: t(`aiOnboarding.checklist.checkDetails.${check.detailKey}`, {
      defaultValue: check.detail,
      ...localizeDetailParams(check.detailParams),
    }),
    done: check.status === 'unknown' ? null : check.ok,
    actor: check.actor,
    fix: check.fixHref && !check.ok
      ? {
          label: t(`aiOnboarding.checklist.fixLabels.${check.key}`, {
            defaultValue: t('aiOnboarding.checklist.fixLabels.fallback'),
          }),
          to: check.fixHref,
        }
      : undefined,
    extra: check.key === 'serverFlag' && !isAdmin && !check.ok
      ? <CopyRequest text={t('aiOnboarding.checklist.steps.flag.copyRequest')} />
      : undefined,
  }));
  const steps: Step[] = readinessSteps.concat([
    {
      key: 'table',
      title: t('aiOnboarding.checklist.steps.table.title'),
      body: mode === 'driver' ? t('aiOnboarding.checklist.steps.table.driver') : t('aiOnboarding.checklist.steps.table.notYet'),
      done: mode === 'driver' ? true : null,
      actor: 'dm',
      fix: mode === 'driver' ? { label: t('aiOnboarding.checklist.openTable'), to: `/c/${campaignId}/table` } : undefined,
    },
  ]);

  // Progress counts BLOCKING checks only, so the tally reaches its total exactly when the
  // done-banner fires. Advisory `warning` checks (a campaign with no session-zero content)
  // are still rendered as suggestions, but counting them would strand a perfectly runnable
  // table at "10 of 11" next to a green "the AI DM is ready" — the same class of
  // self-contradiction this checklist exists to remove. The invariant is pinned in
  // apps/server/test/unit/ai-dm-readiness-rules.spec.ts.
  const { done: doneCount, total: gatingTotal } = aiDmReadinessProgress(readiness);
  const allDone = aiDmSetupComplete(readiness);

  return (
    <div id="ai-dm-readiness" className={`text-left space-y-3 settings-anchor ${className}`} tabIndex={-1}>
      <div>
        <p className="font-bold text-[var(--color-text)]">{t('aiOnboarding.checklist.title')}</p>
        <p className="text-xs text-[var(--color-neutral-400)] mt-0.5">{t('aiOnboarding.checklist.intro')}</p>
      </div>

      {allDone && (
        <div className="cf-inset p-3 text-sm">
          <p className="font-semibold text-[var(--color-accent)]">{t('aiOnboarding.checklist.allDoneTitle')}</p>
          <p className="text-xs text-[var(--color-neutral-400)] mt-0.5">
            {mode === 'driver' ? t('aiOnboarding.checklist.allDoneDriver') : t('aiOnboarding.checklist.allDoneCoDm')}
          </p>
        </div>
      )}

      {/* #1065 — the money block, rendered ABOVE the mode selector in AiDmCard, so the
          estimate-or-disclosure is on screen before a DM commits the seat to Driver. The
          token line stays: tokens are what the budget is actually denominated in, and the
          dollar figure is an interpretation of them, not a replacement. */}
      <div className="cf-inset p-3 text-xs text-[var(--color-neutral-300)]">
        <p className="font-semibold text-[var(--color-neutral-200)] m-0">{t('aiOnboarding.checklist.costTitle')}</p>
        {/* The prompt/completion breakdown appears only when the server actually has one to
            give. Metered turns record a total, so claiming a split there would be inventing
            the more specific half of the sentence. */}
        <p className="m-0 mt-1">
          {readiness.estimatedCost.estimatedPromptTokens === null ||
          readiness.estimatedCost.estimatedCompletionTokens === null
            ? t('aiOnboarding.checklist.costTokensTotal', {
                tokens: formatNumber(readiness.estimatedCost.estimatedTotalTokens),
              })
            : t('aiOnboarding.checklist.costTokens', {
                tokens: formatNumber(readiness.estimatedCost.estimatedTotalTokens),
                prompt: formatNumber(readiness.estimatedCost.estimatedPromptTokens),
                completion: formatNumber(readiness.estimatedCost.estimatedCompletionTokens),
              })}
        </p>
        <CostDisclosure
          className="mt-1.5"
          // `?? AI_COST_BASIS_UNKNOWN` matches BudgetSection. The schema default already
          // supplies it on a same-version response, so this is not defending against a gap —
          // it keeps the two sibling call sites reading the same, so the convention the next
          // reader copies is the one that also holds against an older or partial payload.
          basis={readiness.estimatedCost.basis ?? AI_COST_BASIS_UNKNOWN}
          amount={formatUsdRangeValue(readiness.estimatedCost.estimatedUsdRange)}
          scopeKey="aiOnboarding.cost.scopePerTurn"
        />
        {/* Server prose is the API/log rendering; localized clients prefer `noteKey` and fall
            back to it, so a server that grows a new variant never blanks this line (#629). */}
        <p className="m-0 mt-1 text-[11px] text-secondary">
          {readiness.estimatedCost.noteKey
            ? t(`aiOnboarding.runCost.notes.${readiness.estimatedCost.noteKey}`, {
                defaultValue: readiness.estimatedCost.note,
                ...readiness.estimatedCost.noteParams,
              })
            : readiness.estimatedCost.note}
        </p>
      </div>

      <p className="text-[11px] text-secondary">
        {t('aiOnboarding.checklist.progress', { done: doneCount, total: gatingTotal })}
      </p>

      <ol className="space-y-2.5">
        {steps.map((step) => (
          <StepRow key={step.key} step={step} />
        ))}
      </ol>

      <AiTransparencyNote />
    </div>
  );
}

function StepRow({ step }: { step: Step }) {
  const { t } = useTranslation();
  const actorLabel =
    step.actor === 'admin'
      ? t('aiOnboarding.checklist.actorAdmin')
      : step.actor === 'table'
        ? t('aiOnboarding.checklist.actorTable')
        : t('aiOnboarding.checklist.actorDm');
  const marker = step.done === true ? '✓' : step.done === null ? '•' : '○';
  const markerColor = step.done === true ? 'var(--color-accent)' : 'var(--color-neutral-600)';
  return (
    <li className="flex gap-2.5">
      <span className="shrink-0 mt-0.5 text-sm font-bold" style={{ color: markerColor }} aria-hidden>
        {marker}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-[var(--color-neutral-200)]">{step.title}</span>
          <span className="text-[10px] text-secondary">
            {step.done === true
              ? t('aiOnboarding.checklist.completedBy', { actor: actorLabel })
              : t('aiOnboarding.checklist.todoBy', { actor: actorLabel })}
          </span>
        </div>
        <p className="text-xs text-[var(--color-neutral-400)] mt-0.5">{step.body}</p>
        {step.extra}
        {step.fix && (
          <Link to={step.fix.to} className="cf-btn cf-btn-ghost cf-density-compact text-xs mt-1.5 inline-flex no-underline">
            {step.fix.label} →
          </Link>
        )}
      </div>
    </li>
  );
}

/** A copy-to-clipboard chip carrying the exact ask a DM can send their server admin. */
function CopyRequest({ text }: { text: string }) {
  const { t } = useTranslation();
  const textId = useId();
  return (
    <div className="cf-inset p-2 mt-1.5 space-y-1">
      <p className="text-[11px] text-[var(--color-neutral-400)] italic">
        “<span id={textId}>{text}</span>”
      </p>
      <CopyControl
        text={text}
        selectTargetId={textId}
        label={t('aiOnboarding.checklist.steps.flag.copy')}
        copiedLabel={t('aiOnboarding.checklist.steps.flag.copied')}
        ghost
        density="compact"
        className="text-[11px]"
      />
    </div>
  );
}

/**
 * Player-facing transparency paragraph: what data the AI sees, that canon changes need DM
 * approval, and where the pause/takeover levers live. Content only — reused by the mode
 * badge disclosure and the checklist.
 */
export function AiTransparencyNote({ className = '' }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <div className={`cf-inset p-3 ${className}`}>
      <p className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-neutral-400)]">
        {t('aiOnboarding.transparency.title')}
      </p>
      <p className="text-xs text-[var(--color-neutral-400)] mt-1">{t('aiOnboarding.transparency.body')}</p>
    </div>
  );
}

/**
 * Maps a blocked AI action (or a session state) to a friendly explainer + deep link.
 * Callers pass a rejected {@link import('../../lib/api').ApiError} or a session `state`
 * string; the fix link is shown only when the current viewer can act on it.
 */
export function AiGateExplainer({
  err,
  campaignId,
  canFix = true,
  className = '',
}: {
  err: unknown;
  campaignId: number | undefined;
  /** Whether to show the deep link (e.g. hide the admin fix from a non-admin). */
  canFix?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const info = classifyAiGate(err);
  const to = info.to && campaignId !== undefined ? info.to(campaignId) : null;
  return (
    <div className={`space-y-1.5 ${className}`}>
      <p className="font-semibold text-[var(--color-text)]">{t(info.titleKey)}</p>
      <p className="text-sm text-[var(--color-neutral-400)]">{t(info.bodyKey)}</p>
      {canFix && to && (
        <Link to={to} className="cf-btn cf-btn-ghost cf-density-compact text-xs inline-flex no-underline">
          {t('aiOnboarding.gate.openFix')} →
        </Link>
      )}
    </div>
  );
}

/**
 * Dismissible dashboard nudge (DM-only). Shows only while the seat mode is still `off`
 * — once the DM has picked a mode the seat surfaces speak for themselves. Expands into
 * the full {@link AiSetupChecklist}. Dismissal is per-campaign in localStorage.
 */
export function AiDmDashboardOnboarding({
  campaignId,
  isDm,
  isAdmin,
}: {
  campaignId: number;
  isDm: boolean;
  isAdmin: boolean;
}) {
  const { t } = useTranslation();
  const storageKey = `cf.aiOnboarding.dismissed.${campaignId}`;
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(storageKey) === '1';
    } catch {
      return false;
    }
  });
  const [expanded, setExpanded] = useState(false);

  const seatQuery = useAiDmSeat(isDm ? campaignId : undefined);
  const seat = seatQuery.data;

  // Only for DMs, only while the seat is off, only until dismissed. Nothing AI-related
  // renders otherwise (acceptance criterion: silent when off + not-DM/dismissed).
  if (!isDm || dismissed || !seat || seat.mode !== 'off') return null;

  function dismiss() {
    try {
      localStorage.setItem(storageKey, '1');
    } catch {
      /* non-fatal */
    }
    setDismissed(true);
  }

  return (
    <Card density="default">
      {!expanded ? (
        // Mobile reflow (issue #675): below `sm` the actions used to sit in the
        // same row as the icon + copy. Because the copy block carries `min-w-0`
        // it would collapse to an unreadable narrow column (≈73px at 390px) while
        // the two buttons held ≈199px. Instead we stack: icon + copy on a top row,
        // then a full-width actions row underneath. Above `sm` the original inline
        // row (icon + copy + actions together) is preserved so the hint stays
        // compact on wide viewports. The copy block keeps `min-w-0` for ellipsis
        // safety but never has to fight the buttons for width on mobile.
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-3 sm:flex-wrap">
          <div className="flex items-start gap-3">
            <span className="flex shrink-0 text-[var(--color-accent)]" aria-hidden>
              <GameIcon slug="sparkles" size={UI_ICON_SIZE.md} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-bold text-[var(--color-text)]">{t('aiOnboarding.dashboard.hintTitle')}</p>
              <p className="text-xs text-[var(--color-neutral-400)] mt-0.5">{t('aiOnboarding.dashboard.hintBody')}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 sm:shrink-0 w-full sm:w-auto sm:ml-auto">
            <Btn type="button" density="compact" ghost className="text-xs flex-1 sm:flex-none" onClick={dismiss}>
              {t('aiOnboarding.dashboard.hide')}
            </Btn>
            <Btn type="button" density="compact" className="text-xs flex-1 sm:flex-none" onClick={() => setExpanded(true)}>
              {t('aiOnboarding.dashboard.setUp')}
            </Btn>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex justify-end">
            <Btn type="button" density="compact" ghost className="text-xs" onClick={dismiss}>
              {t('aiOnboarding.dashboard.dismiss')}
            </Btn>
          </div>
          <AiSetupChecklist campaignId={campaignId} isAdmin={isAdmin} />
        </div>
      )}
    </Card>
  );
}
