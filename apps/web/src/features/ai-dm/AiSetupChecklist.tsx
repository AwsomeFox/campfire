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
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import type { AiConsoleOverview, AiProviderEffectiveView } from '@campfire/schema';
import { api, API } from '../../lib/api';
import { useAiDmSeat } from '../../lib/query';
import { classifyAiGate } from './aiGate';
import { GameIcon } from '../../components/GameIcon';

/** One computed checklist step. `done: null` = state is unknown (e.g. flag, for a non-admin). */
interface Step {
  key: string;
  title: string;
  body: string;
  done: boolean | null;
  actor: 'admin' | 'dm';
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

  // Real state source ①: the seat (GET /campaigns/:id/ai-dm) — mode / tokenBudget.
  const seatQuery = useAiDmSeat(campaignId);
  const seat = seatQuery.data;

  // Real state source ②: the effective provider indicator. `ready` accounts for
  // campaign/server stored keys, environment fallback, and keyless mock providers.
  const providerQuery = useQuery({
    queryKey: ['campaign', campaignId, 'ai-provider', 'effective'],
    queryFn: () => api.get<AiProviderEffectiveView>(`${API}/campaigns/${campaignId}/ai-provider/effective`),
  });
  const provider = providerQuery.data ?? null;

  // Real state source ③ (admin only): the server flag lives on the admin AI console
  // (GET /settings/ai → killSwitchEnabled = experimentalAiDm). Non-admins can't read it,
  // so the flag step stays a "ask your admin" note for them.
  const flagQuery = useQuery({
    queryKey: ['ai-console', 'overview'],
    queryFn: () => api.get<AiConsoleOverview>(`${API}/settings/ai`),
    enabled: isAdmin,
  });
  const flagOn = flagQuery.data?.killSwitchEnabled ?? null;

  if (seatQuery.isLoading) {
    return <p className="text-xs text-[var(--color-neutral-600)]">{t('aiOnboarding.checklist.loading')}</p>;
  }

  const mode = seat?.mode ?? 'off';
  const budget = seat?.tokenBudget ?? 0;

  const steps: Step[] = [
    {
      key: 'flag',
      title: t('aiOnboarding.checklist.steps.flag.title'),
      body: isAdmin
        ? flagOn
          ? t('aiOnboarding.checklist.steps.flag.onAdmin')
          : t('aiOnboarding.checklist.steps.flag.offAdmin')
        : t('aiOnboarding.checklist.steps.flag.askAdmin'),
      done: isAdmin ? flagOn : null,
      actor: 'admin',
      fix: isAdmin && !flagOn ? { label: t('aiOnboarding.checklist.fixServerAi'), to: '/admin/ai' } : undefined,
      extra: !isAdmin ? <CopyRequest text={t('aiOnboarding.checklist.steps.flag.copyRequest')} /> : undefined,
    },
    {
      key: 'provider',
      title: t('aiOnboarding.checklist.steps.provider.title'),
      body: provider?.ready
        ? t('aiOnboarding.checklist.steps.provider.done', { model: provider.model || provider.providerType })
        : t('aiOnboarding.checklist.steps.provider.todo'),
      done: !!provider?.ready,
      actor: 'dm',
      fix: provider?.ready
        ? undefined
        : { label: t('aiOnboarding.checklist.fixProvider'), to: `/c/${campaignId}/settings#ai-dm-provider` },
    },
    {
      key: 'mode',
      title: t('aiOnboarding.checklist.steps.mode.title'),
      body:
        mode === 'co_dm'
          ? t('aiOnboarding.checklist.steps.mode.doneCoDm')
          : mode === 'driver'
            ? t('aiOnboarding.checklist.steps.mode.doneDriver')
            : t('aiOnboarding.checklist.steps.mode.todo'),
      done: mode !== 'off',
      actor: 'dm',
      fix: mode !== 'off' ? undefined : { label: t('aiOnboarding.checklist.fixMode'), to: `/c/${campaignId}/settings#ai-dm-mode` },
    },
    {
      key: 'budget',
      title: t('aiOnboarding.checklist.steps.budget.title'),
      body:
        budget > 0
          ? t('aiOnboarding.checklist.steps.budget.done', { budget: budget.toLocaleString() })
          : t('aiOnboarding.checklist.steps.budget.todo'),
      done: budget > 0,
      actor: 'dm',
      fix: budget > 0 ? undefined : { label: t('aiOnboarding.checklist.fixBudget'), to: `/c/${campaignId}/settings#ai-dm-budget` },
    },
    {
      key: 'table',
      title: t('aiOnboarding.checklist.steps.table.title'),
      body: mode === 'driver' ? t('aiOnboarding.checklist.steps.table.driver') : t('aiOnboarding.checklist.steps.table.notYet'),
      done: mode === 'driver' ? true : null,
      actor: 'dm',
      fix: mode === 'driver' ? { label: t('aiOnboarding.checklist.openTable'), to: `/c/${campaignId}/table` } : undefined,
    },
  ];

  const gating = steps.filter((s) => s.key !== 'table');
  const doneCount = gating.filter((s) => s.done === true).length;
  const allDone = doneCount === gating.length;

  return (
    <div className={`text-left space-y-3 ${className}`}>
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

      <p className="text-[11px] text-[var(--color-neutral-600)]">
        {t('aiOnboarding.checklist.progress', { done: doneCount, total: gating.length })}
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
  const actorLabel = step.actor === 'admin' ? t('aiOnboarding.checklist.actorAdmin') : t('aiOnboarding.checklist.actorDm');
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
          <span className="text-[10px] text-[var(--color-neutral-600)]">
            {step.done === true
              ? t('aiOnboarding.checklist.completedBy', { actor: actorLabel })
              : t('aiOnboarding.checklist.todoBy', { actor: actorLabel })}
          </span>
        </div>
        <p className="text-xs text-[var(--color-neutral-400)] mt-0.5">{step.body}</p>
        {step.extra}
        {step.fix && (
          <Link to={step.fix.to} className="cf-btn cf-btn-ghost !min-h-0 !py-1 text-xs mt-1.5 inline-flex no-underline">
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
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard?.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the text is visible below regardless */
    }
  }
  return (
    <div className="cf-inset p-2 mt-1.5 space-y-1">
      <p className="text-[11px] text-[var(--color-neutral-400)] italic">“{text}”</p>
      <button type="button" onClick={copy} className="cf-btn cf-btn-ghost !min-h-0 !py-1 text-[11px]">
        {copied ? t('aiOnboarding.checklist.steps.flag.copied') : t('aiOnboarding.checklist.steps.flag.copy')}
      </button>
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
      <p className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-neutral-600)]">
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
        <Link to={to} className="cf-btn cf-btn-ghost !min-h-0 !py-1 text-xs inline-flex no-underline">
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
    <section className="cf-card p-4">
      {!expanded ? (
        <div className="flex items-start gap-3 flex-wrap">
          <span className="flex text-[var(--color-accent)]" aria-hidden>
            <GameIcon slug="sparkles" size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-bold text-[var(--color-text)]">{t('aiOnboarding.dashboard.hintTitle')}</p>
            <p className="text-xs text-[var(--color-neutral-400)] mt-0.5">{t('aiOnboarding.dashboard.hintBody')}</p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" className="cf-btn cf-btn-ghost !min-h-0 !py-1.5 text-xs" onClick={dismiss}>
              {t('aiOnboarding.dashboard.hide')}
            </button>
            <button type="button" className="cf-btn !min-h-0 !py-1.5 text-xs" onClick={() => setExpanded(true)}>
              {t('aiOnboarding.dashboard.setUp')}
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex justify-end">
            <button type="button" className="cf-btn cf-btn-ghost !min-h-0 !py-1 text-xs" onClick={dismiss}>
              {t('aiOnboarding.dashboard.dismiss')}
            </button>
          </div>
          <AiSetupChecklist campaignId={campaignId} isAdmin={isAdmin} />
        </div>
      )}
    </section>
  );
}
