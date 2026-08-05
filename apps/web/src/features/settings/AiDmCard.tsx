/**
 * AI Dungeon Master settings — a DM-only card on the campaign settings page
 * (issue #311). One cohesive surface that drives:
 *   - the operating MODE (Off / Co-DM / Driver) via PUT /campaigns/:id/ai-dm.
 *   - the PROVIDER + model + write-only API key via the #310 endpoints
 *     (PUT /campaigns/:id/ai-provider). The key is NEVER displayed — a stored key
 *     shows only as "configured" + its last 4 chars; the input is write-only
 *     (blank = keep, a value = set/rotate).
 *   - the seat's steering INSTRUCTIONS + token BUDGET (also via the ai-dm seat).
 *   - a live "Test connection" probe (POST /campaigns/:id/ai-provider/test).
 *
 * Everything here is gated server-side on the experimental flag: writes 403 with a
 * clear reason when a server admin hasn't enabled the feature, and Driver mode 409s
 * unless a budget + provider are set. We surface those server messages verbatim.
 *
 * i18n (#1579): every literal here routes through `t()`. Two errors intentionally do
 * NOT come from this file's own catalog keys: server 403/409 messages are surfaced
 * verbatim (see the class doc above), and `apps/web/src/features/ai-dm/aiGate.ts`
 * substring-matches specific server strings ('requires a positive token budget',
 * 'server-wide ai token cap') to classify those gates — those come from the server and
 * are out of scope for this card's localization.
 */
import { useCallback, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useTranslation, Trans } from 'react-i18next';
import { formatNumber, formatDateTime } from '../../lib/format';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AiCostBasis,
  AiDmMode,
  AiDmReadiness,
  AiDmSeat,
  AiProviderEffectiveView,
  Campaign,
  NarrationLanguage,
} from '@campfire/schema';
import {
  AI_COST_BASIS_UNKNOWN,
  AI_DM_COMPREHENSION_PROFILE_AXES,
  AI_DM_COMPREHENSION_PROFILE_OPTIONS,
  AI_DM_STYLE_PRESET_AXES,
  AI_DM_STYLE_PRESET_OPTIONS,
  NARRATION_LANGUAGE_OPTIONS,
  type AiDmComprehensionProfile,
  type AiDmStylePresets,
} from '@campfire/schema';
import { api, ApiError, API } from '../../lib/api';
import { Card, SkeletonCard } from '../../components/ui';
import { AI_DM_BUDGET_INPUT_ID, AI_DM_BUDGET_SECTION_ID } from './aiDmBudgetIds';
import { AI_DM_STYLE_SECTION_ID, aiDmStyleSelectId } from './aiDmStyleIds';
import { AI_DM_COMPREHENSION_SECTION_ID, aiDmComprehensionSelectId } from './aiDmComprehensionIds';
import { ProviderForm } from './ProviderForm';
import { queryKeys } from '../../lib/query';
import { useAuth } from '../../app/auth';
import { AiSetupChecklist } from '../ai-dm/AiSetupChecklist';
import { CostDisclosure } from '../ai-dm/CostDisclosure';
import { formatUsdRange } from '../ai-dm/costEstimate';
import { TermHelp } from '../../components/TermHelp';
import { useSaveFeedback } from '../../components/SaveFeedback';

const AI_DM_INSTRUCTIONS_SECTION_ID = 'ai-dm-instructions';
const AI_DM_INSTRUCTIONS_INPUT_ID = 'ai-dm-instructions-input';

/**
 * The three operating modes, in display order. `label`/`blurb` are the English SOURCE
 * copy — also the fallback `t()` passes as `defaultValue` for
 * `settings.aiDm.modeOptions.<value>.{label,blurb}`, so a catalog miss degrades to this
 * text instead of a blank. Exported: `ai-trust-copy.unit.spec.ts` (#752) asserts the
 * canonical English Driver/Co-DM copy directly against the policy manifest, independent
 * of which locale happens to be active.
 */
export const MODES: { value: AiDmMode; label: string; blurb: string }[] = [
  {
    value: 'off',
    label: 'Off',
    blurb: 'No AI participation. The seat is idle — nothing is proposed or narrated.',
  },
  {
    value: 'co_dm',
    label: 'Co-DM (assist)',
    blurb:
      'Asks. The AI only proposes — every draft lands in your approval queue, and nothing changes until a human DM accepts or rejects it. The AI never writes to canon directly. Recommended.',
  },
  {
    value: 'driver',
    label: 'Driver',
    blurb:
      'Acts. The AI holds the DM seat and runs the session directly — it narrates, rolls dice, applies HP and conditions, awards XP, advances turns, creates an encounter when the scene calls for one (always as DM-only prep, hidden until you reveal it), reveals map regions, and jots table notes within the budget you set. Canon edits (new NPCs, quests, locations) still become proposals for your review. Requires the experimental server flag, a positive token budget, and a configured provider.',
  },
];

const MODE_LABEL: Record<AiDmMode, string> = { off: 'Off', co_dm: 'Co-DM', driver: 'Driver' };
/** Field names as a DM would read them in the inherited-defaults notice (#1070). English fallback. */
const INHERITED_FIELD_LABEL: Record<string, string> = {
  mode: 'operating mode',
  instructions: 'steering',
  tokenBudget: 'token budget',
  actionQueueDepth: 'action queue depth',
};
const CREDENTIAL_SOURCE_LABEL: Record<AiProviderEffectiveView['credentialSource'], string> = {
  stored: 'stored encrypted key',
  environment: 'environment credential',
  server: 'server-default credential',
  'not-required': 'no credential required',
  none: 'no credential available',
};

const MODE_TAG: Record<AiDmMode, string> = { off: 'tag-neutral', co_dm: 'tag-accent-2', driver: 'tag-accent' };

export default function AiDmCard({
  campaignId,
  campaign,
  onCampaignSaved,
}: {
  campaignId: number;
  campaign: Campaign;
  onCampaignSaved: (c: Campaign) => void;
}) {
  const { t } = useTranslation();
  const { isAdmin } = useAuth();
  const queryClient = useQueryClient();
  // Every section below writes state the readiness checklist derives from (mode, budget,
  // provider), but they keep their result in local component state. Without an explicit
  // invalidation the co-located checklist would keep rendering the pre-save answer (#519).
  const refreshReadiness = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.aiDmReadiness(campaignId) });
  }, [queryClient, campaignId]);
  const [seat, setSeat] = useState<AiDmSeat | null>(null);
  const [effective, setEffective] = useState<AiProviderEffectiveView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadEffective = useCallback(async () => {
    try {
      setEffective(await api.get<AiProviderEffectiveView>(`${API}/campaigns/${campaignId}/ai-provider/effective`));
    } catch {
      // Non-fatal: the status line degrades gracefully if this read fails.
      setEffective(null);
    }
  }, [campaignId]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [s] = await Promise.all([
        api.get<AiDmSeat>(`${API}/campaigns/${campaignId}/ai-dm`),
        loadEffective(),
      ]);
      setSeat(s);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : t('settings.aiDm.errors.load'));
    } finally {
      setLoading(false);
    }
  }, [campaignId, loadEffective, t]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !seat) {
    return <SkeletonCard sections={3} lines={2} label={t('settings.aiDm.loading')} />;
  }

  if (loadError && !seat) {
    return (
      <Card density="compact" elev="sm">
        <span className="card-kicker">{t('settings.aiDm.title')}</span>
        <p className="text-sm" style={{ color: '#f87171' }}>{loadError}</p>
        <button className="btn btn-secondary" style={{ fontSize: 12.5, alignSelf: 'flex-start' }} onClick={() => void load()}>
          {t('common.retry')}
        </button>
      </Card>
    );
  }

  if (!seat) return null;

  const committedTokens = seat.tokensUsed + seat.tokensReserved + seat.tokensUnknown;
  const usagePct = seat.tokenBudget > 0 ? Math.min(100, Math.round((committedTokens / seat.tokenBudget) * 100)) : 0;

  return (
    <Card
      density="compact" elev="sm" className="settings-anchor"
      id="ai-dm"
      tabIndex={-1}
      aria-labelledby="ai-dm-heading"
      style={{ scrollMarginTop: 72 }}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span id="ai-dm-heading" className="card-kicker" style={{ margin: 0 }}>{t('settings.aiDm.title')}</span>
        <span className={`tag ${MODE_TAG[seat.mode]}`} style={{ fontSize: 10 }}>
          {t('settings.aiDm.statusTag', {
            mode: t(`settings.aiDm.modeStatusLabels.${seat.mode}`, { defaultValue: MODE_LABEL[seat.mode] }),
          })}
        </span>
      </div>
      <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>
        {t('settings.aiDm.intro')}
      </p>

      {/*
        #1070 — this campaign has never configured its seat, so these values are coming LIVE from
        the server-wide defaults. Shown BEFORE the mode/budget controls because enabling the seat
        is what lets it start spending: an inherited token budget has to be visible ahead of that
        decision, not discovered after it. Saving anything here detaches this campaign, seeded
        from what it is inheriting now, so nothing it currently shows will silently change.
      */}
      {seat.inheritedFields.length > 0 && (
        <p className="cf-inset p-3 text-muted" style={{ margin: 0, fontSize: 11.5 }} data-testid="ai-dm-inherited-notice">
          <Trans
            i18nKey="settings.aiDm.inheritedNotice"
            values={{
              fields: seat.inheritedFields
                .map((f) => t(`settings.aiDm.inheritedFieldLabels.${f}`, { defaultValue: INHERITED_FIELD_LABEL[f] ?? f }))
                .join(', '),
            }}
            components={[<strong key="f" />]}
          />
        </p>
      )}

      <AiSetupChecklist campaignId={campaignId} isAdmin={isAdmin} className="cf-inset p-3" />
      <ModeSection campaignId={campaignId} seat={seat} onChanged={(s) => { setSeat(s); refreshReadiness(); }} />
      <NarrationLanguageSection
        campaignId={campaignId}
        campaign={campaign}
        onSaved={onCampaignSaved}
      />
      <EffectiveProviderSection
        campaignId={campaignId}
        effective={effective}
        onChanged={() => { void loadEffective(); refreshReadiness(); }}
      />
      <BudgetSection
        campaignId={campaignId}
        seat={seat}
        usagePct={usagePct}
        onChanged={(s) => { setSeat(s); refreshReadiness(); }}
      />
      <InstructionsSection campaignId={campaignId} seat={seat} onChanged={(s) => setSeat(s)} />
      <TableStyleSection campaignId={campaignId} seat={seat} onChanged={(s) => setSeat(s)} />
      <ComprehensionProfileSection campaignId={campaignId} seat={seat} onChanged={(s) => setSeat(s)} />
    </Card>
  );
}

/**
 * Divider + subsection heading to keep the one card readable. The optional `id` is the
 * deep-link anchor the onboarding checklist (#343) targets (e.g. #ai-dm-provider);
 * `scrollMarginTop` keeps the heading clear of the sticky app header when jumped to.
 */
function Section({ title, id, children }: { title: string; id: string; children: React.ReactNode }) {
  const headingId = `${id}-heading`;
  return (
    <div
      id={id}
      className="flex flex-col gap-2 settings-anchor"
      style={{ borderTop: '1px solid var(--color-neutral-800, #2a2a2a)', paddingTop: 12, marginTop: 4, scrollMarginTop: 72 }}
      tabIndex={-1}
      aria-labelledby={headingId}
    >
      <h3 id={headingId} style={{ margin: 0, fontSize: 12, fontWeight: 700, color: 'var(--color-neutral-200)' }}>{title}</h3>
      {children}
    </div>
  );
}

function NarrationLanguageSection({
  campaignId,
  campaign,
  onSaved,
}: {
  campaignId: number;
  campaign: Campaign;
  onSaved: (c: Campaign) => void;
}) {
  const { t } = useTranslation();
  const [narrationLanguage, setNarrationLanguage] = useState<NarrationLanguage>(campaign.narrationLanguage);
  const feedback = useSaveFeedback(t('settings.aiDm.narrationLanguage.feedbackSubject'));
  const saving = feedback.state === 'saving';
  const dirty = narrationLanguage !== campaign.narrationLanguage;

  useEffect(() => {
    setNarrationLanguage(campaign.narrationLanguage);
  }, [campaign.id, campaign.narrationLanguage]);

  async function save() {
    if (saving) return;
    feedback.begin();
    try {
      const updated = await api.patch<Campaign>(`${API}/campaigns/${campaignId}`, { narrationLanguage });
      onSaved(updated);
      feedback.succeed();
    } catch (err) {
      if (err instanceof ApiError) {
        feedback.fail(err.message);
      } else {
        feedback.fail(t('settings.aiDm.errors.saveNarrationLanguage'), { generic: true });
      }
    }
  }

  return (
    <Section title={t('settings.aiDm.narrationLanguage.sectionTitle')} id="ai-dm-narration-language">
      <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>
        {t('settings.aiDm.narrationLanguage.body')}
      </p>
      <div className="field" style={{ maxWidth: 320 }}>
        <label htmlFor="ai-dm-narration-language-select">{t('settings.aiDm.narrationLanguage.label')}</label>
        <select
          id="ai-dm-narration-language-select"
          className="input"
          value={narrationLanguage}
          disabled={saving}
          aria-describedby={feedback.statusId}
          onChange={(e) => { const value = e.target.value as NarrationLanguage; setNarrationLanguage(value); feedback.syncDirty(value !== campaign.narrationLanguage); }}
        >
          {NARRATION_LANGUAGE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {t(`settings.aiDm.narrationLanguage.options.${opt.value}`, { defaultValue: opt.label })}
            </option>
          ))}
        </select>
      </div>
      <div className="flex gap-2 items-center">
        <button className="btn btn-primary" style={{ fontSize: 12.5 }} disabled={saving || !dirty} onClick={() => void save()}>
          {saving ? t('common.saving') : t('settings.aiDm.narrationLanguage.save')}
        </button>
        {feedback.announcement}
      </div>
    </Section>
  );
}

function ModeSection({
  campaignId,
  seat,
  onChanged,
}: {
  campaignId: number;
  seat: AiDmSeat;
  onChanged: (s: AiDmSeat) => void;
}) {
  const { t } = useTranslation();
  const [saving, setSaving] = useState<AiDmMode | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function pick(mode: AiDmMode) {
    if (mode === seat.mode || saving) return;
    setSaving(mode);
    setError(null);
    try {
      const updated = await api.put<AiDmSeat>(`${API}/campaigns/${campaignId}/ai-dm`, { mode });
      onChanged(updated);
    } catch (err) {
      // 409 = Driver preconditions not met; 403 = feature disabled. Surface verbatim.
      setError(err instanceof ApiError ? err.message : t('settings.aiDm.errors.saveMode'));
    } finally {
      setSaving(null);
    }
  }

  return (
    <Section title={t('settings.aiDm.mode.sectionTitle')} id="ai-dm-mode">
      <div className="flex flex-col gap-2">
        {MODES.map((m) => {
          const inputId = `ai-dm-mode-${m.value}`;
          return (
            <div key={m.value} className="flex gap-2" style={{ alignItems: 'flex-start' }}>
              <input
                id={inputId}
                type="radio"
                name="ai-dm-mode"
                checked={seat.mode === m.value}
                disabled={!!saving}
                onChange={() => void pick(m.value)}
                style={{ marginTop: 2 }}
              />
              <span className="flex flex-col">
                <span className="inline-flex items-center gap-1 flex-wrap" style={{ fontSize: 13, fontWeight: 600 }}>
                  <label htmlFor={inputId} style={{ cursor: saving ? 'wait' : 'pointer' }}>
                    {t(`settings.aiDm.modeOptions.${m.value}.label`, { defaultValue: m.label })}
                  </label>
                  {m.value === 'co_dm' && <TermHelp termId="coDm" />}
                  {m.value === 'driver' && <TermHelp termId="driver" />}
                </span>
                <label
                  htmlFor={inputId}
                  className="text-muted"
                  style={{ cursor: saving ? 'wait' : 'pointer', fontSize: 11.5 }}
                >
                  {t(`settings.aiDm.modeOptions.${m.value}.blurb`, { defaultValue: m.blurb })}
                </label>
              </span>
            </div>
          );
        })}
      </div>
      {error && <p className="text-sm" style={{ color: '#f87171' }}>{error}</p>}
    </Section>
  );
}

/**
 * Effective-provider status + optional per-campaign override (issue #399).
 *
 * The provider + API key now live in the server-admin AI console. Here we show only a
 * non-secret status line — which provider is in effect and whether it's the server
 * default or a campaign override — read from the DM-safe `/ai-provider/effective`
 * endpoint (never any key). The full per-campaign provider form is kept, but tucked
 * behind an Advanced disclosure since most tables just use the server default.
 */
function EffectiveProviderSection({
  campaignId,
  effective,
  onChanged,
}: {
  campaignId: number;
  effective: AiProviderEffectiveView | null;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const location = useLocation();
  const [showOverride, setShowOverride] = useState(() => location.hash === '#ai-dm-provider');

  useEffect(() => {
    if (location.hash === '#ai-dm-provider') setShowOverride(true);
  }, [location.hash]);

  const sourceLabel = effective?.source === 'campaign'
    ? t('settings.aiDm.provider.sourceCampaign')
    : t('settings.aiDm.provider.sourceServer');
  const sourceTag = effective?.source === 'campaign' ? 'tag-accent' : 'tag-accent-2';
  const credentialSourceLabel = effective
    ? t(`settings.aiDm.provider.credentialSourceLabels.${effective.credentialSource}`, {
        defaultValue: CREDENTIAL_SOURCE_LABEL[effective.credentialSource],
      })
    : '';

  return (
    <Section title={t('settings.aiDm.provider.sectionTitle')} id="ai-dm-provider">
      {effective?.configured ? (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span style={{ fontSize: 13, fontWeight: 600 }}>
              {effective.providerType} / {effective.model || '—'}
            </span>
            <span className={`tag ${sourceTag}`} style={{ fontSize: 10 }}>{sourceLabel}</span>
            <span className={`tag ${effective.ready ? 'tag-accent' : 'tag-neutral'}`} style={{ fontSize: 10 }}>
              {effective.ready ? t('settings.aiDm.provider.readyTag') : t('settings.aiDm.provider.missingTag')}
            </span>
          </div>
          <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>
            {effective.ready
              ? t('settings.aiDm.provider.readyDetail', {
                  source: credentialSourceLabel,
                  scopeNote:
                    effective.source === 'campaign'
                      ? t('settings.aiDm.provider.scopeNoteCampaign')
                      : t('settings.aiDm.provider.scopeNoteServer'),
                })
              : t('settings.aiDm.provider.missingDetail')}
          </p>
        </div>
      ) : (
        <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>
          {t('settings.aiDm.provider.noneConfigured')}
        </p>
      )}

      <div className="flex flex-col gap-2" style={{ marginTop: 4 }}>
        <button
          type="button"
          className="btn btn-ghost"
          style={{ fontSize: 12, alignSelf: 'flex-start', padding: '2px 4px' }}
          aria-expanded={showOverride}
          onClick={() => setShowOverride((v) => !v)}
        >
          {showOverride ? '▾' : '▸'} {t('settings.aiDm.provider.advancedToggle')}
        </button>
        {showOverride && (
          <div
            className="flex flex-col gap-2"
            style={{ borderLeft: '2px solid var(--color-divider)', paddingLeft: 12 }}
          >
            <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>
              {t('settings.aiDm.provider.advancedIntro')}
            </p>
            <ProviderForm basePath={`/campaigns/${campaignId}/ai-provider`} scope="campaign" onChanged={onChanged} />
          </div>
        )}
      </div>
    </Section>
  );
}

function BudgetSection({
  campaignId,
  seat,
  usagePct,
  onChanged,
}: {
  campaignId: number;
  seat: AiDmSeat;
  usagePct: number;
  onChanged: (s: AiDmSeat) => void;
}) {
  const { t } = useTranslation();
  const [tokenBudget, setTokenBudget] = useState(String(seat.tokenBudget));
  const feedback = useSaveFeedback(t('settings.aiDm.budget.feedbackSubject'));
  const saving = feedback.state === 'saving';

  // #1065 — the cost basis rides along on readiness, which the checklist in this same card
  // has already fetched, so this shares that cache rather than adding a request. When it has
  // not loaded yet the basis is `unknown`, which renders the disclosure: the honest state to
  // be in while we do not know, and the state we must never silently skip past.
  const readinessQuery = useQuery({
    queryKey: queryKeys.aiDmReadiness(campaignId),
    queryFn: () => api.get<AiDmReadiness>(`${API}/campaigns/${campaignId}/ai-dm/readiness`),
  });
  const costBasis: AiCostBasis = readinessQuery.data?.estimatedCost.basis ?? AI_COST_BASIS_UNKNOWN;
  // Price the number being TYPED when it is valid, otherwise the saved one. A BLANK field is
  // not a valid zero: `Number('')` is 0, so clearing the box to retype it made the estimate
  // read "≈$0.00" — an answer to a question the DM had not finished asking, and the one
  // number in this feature that must never appear without a basis behind it. Whitespace is
  // handled the same way, and `Number(' ')` is 0 too.
  const trimmedBudget = tokenBudget.trim();
  const typedBudget = trimmedBudget === '' ? Number.NaN : Number(trimmedBudget);
  const budgetForEstimate = Number.isFinite(typedBudget) && typedBudget >= 0 ? typedBudget : seat.tokenBudget;

  async function save() {
    const n = Number(tokenBudget);
    if (!Number.isFinite(n) || n < 0) {
      feedback.fail(t('settings.aiDm.errors.invalidBudget'));
      return;
    }
    if (saving) return;
    feedback.begin();
    try {
      const updated = await api.put<AiDmSeat>(`${API}/campaigns/${campaignId}/ai-dm`, { tokenBudget: Math.floor(n) });
      onChanged(updated);
      feedback.succeed();
    } catch (err) {
      if (err instanceof ApiError) {
        feedback.fail(err.message);
      } else {
        feedback.fail(t('settings.aiDm.errors.saveBudget'), { generic: true });
      }
    }
  }

  return (
    <Section title={t('settings.aiDm.budget.sectionTitle')} id={AI_DM_BUDGET_SECTION_ID}>
      <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>
        {t('settings.aiDm.budget.body')}
      </p>
      <div className="field" style={{ maxWidth: 200 }}>
        <label htmlFor={AI_DM_BUDGET_INPUT_ID}>{t('settings.aiDm.budget.label')}</label>
        <input
          id={AI_DM_BUDGET_INPUT_ID}
          className="input"
          type="number"
          min={0}
          value={tokenBudget}
          disabled={saving}
          aria-describedby={feedback.statusId}
          onChange={(e) => { const value = e.target.value; setTokenBudget(value); feedback.syncDirty(value !== String(seat.tokenBudget)); }}
        />
      </div>
      {/* #1065 — what that budget is worth in real money, or an explicit statement that we
          cannot say. Tracks the TYPED value rather than the saved one: this is the moment a
          DM is choosing a number, so showing the consequence of the number under the cursor
          is the entire point. A token cap nobody can price is not a spending limit, and
          until now nothing on this screen said so. */}
      <CostDisclosure
        className="text-xs text-[var(--color-neutral-300)]"
        basis={costBasis}
        amount={formatUsdRange(budgetForEstimate, costBasis)}
        scopeKey="aiOnboarding.cost.scopeBudget"
      />
      {/* Usage meter */}
      <div className="flex flex-col gap-1">
        <div style={{ height: 8, borderRadius: 4, background: 'var(--color-neutral-800, #2a2a2a)', overflow: 'hidden' }}>
          <div
            style={{
              width: `${usagePct}%`,
              height: '100%',
              background: usagePct >= 100 ? '#f87171' : 'var(--color-accent, #6366f1)',
              transition: 'width 200ms',
            }}
          />
        </div>
        <span className="text-muted" style={{ fontSize: 11 }}>
          {t('settings.aiDm.budget.usageLine', {
            used: formatNumber(seat.tokensUsed),
            reserved: formatNumber(seat.tokensReserved),
            unknown: formatNumber(seat.tokensUnknown),
            remaining: formatNumber(seat.budgetRemaining),
            budget: formatNumber(seat.tokenBudget),
            turns:
              seat.turnCount === 1
                ? t('settings.aiDm.budget.turnsOne')
                : t('settings.aiDm.budget.turnsSome', { n: seat.turnCount }),
          })}
          {seat.lastTurnAt
            ? t('settings.aiDm.budget.lastTurnSuffix', { when: formatDateTime(seat.lastTurnAt) })
            : ''}
        </span>
        {(seat.tokensRefunded > 0 || seat.tokensOverage > 0) && (
          <span className="text-muted" style={{ fontSize: 11 }}>
            {t('settings.aiDm.budget.refundedLine', { refunded: formatNumber(seat.tokensRefunded) })}
            {seat.tokensOverage > 0
              ? t('settings.aiDm.budget.overageSuffix', { overage: formatNumber(seat.tokensOverage) })
              : ''}
          </span>
        )}
      </div>
      <div className="flex gap-2 items-center">
        <button className="btn btn-primary" style={{ fontSize: 12.5 }} disabled={saving} onClick={() => void save()}>
          {saving ? t('common.saving') : t('settings.aiDm.budget.save')}
        </button>
        {feedback.announcement}
      </div>
    </Section>
  );
}

function InstructionsSection({
  campaignId,
  seat,
  onChanged,
}: {
  campaignId: number;
  seat: AiDmSeat;
  onChanged: (s: AiDmSeat) => void;
}) {
  const { t } = useTranslation();
  const [instructions, setInstructions] = useState(seat.instructions ?? '');
  const feedback = useSaveFeedback(t('settings.aiDm.instructions.feedbackSubject'));
  const saving = feedback.state === 'saving';

  async function save() {
    if (saving) return;
    feedback.begin();
    try {
      const updated = await api.put<AiDmSeat>(`${API}/campaigns/${campaignId}/ai-dm`, { instructions });
      onChanged(updated);
      feedback.succeed();
    } catch (err) {
      if (err instanceof ApiError) {
        feedback.fail(err.message);
      } else {
        feedback.fail(t('settings.aiDm.errors.saveInstructions'), { generic: true });
      }
    }
  }

  return (
    <Section title={t('settings.aiDm.instructions.sectionTitle')} id={AI_DM_INSTRUCTIONS_SECTION_ID}>
      <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>
        {t('settings.aiDm.instructions.body')}
      </p>
      <div className="field">
        <label htmlFor={AI_DM_INSTRUCTIONS_INPUT_ID} className="sr-only">{t('settings.aiDm.instructions.sectionTitle')}</label>
        <textarea
          id={AI_DM_INSTRUCTIONS_INPUT_ID}
          className="input"
          style={{ minHeight: 96 }}
          value={instructions}
          disabled={saving}
          aria-describedby={feedback.statusId}
          onChange={(e) => { const value = e.target.value; setInstructions(value); feedback.syncDirty(value !== (seat.instructions ?? '')); }}
          placeholder={t('settings.aiDm.instructions.placeholder')}
        />
      </div>
      <div className="flex gap-2 items-center">
        <button className="btn btn-primary" style={{ fontSize: 12.5 }} disabled={saving} onClick={() => void save()}>
          {saving ? t('common.saving') : t('settings.aiDm.instructions.save')}
        </button>
        {feedback.announcement}
      </div>
    </Section>
  );
}


/**
 * Structured table style (#1049).
 *
 * The steering textarea above already accepts anything, but a blank box gives no hint that
 * pacing or NPC depth were dials at all. These dropdowns make the common axes discoverable
 * without replacing the freeform field — the two are complementary, and both feed the same
 * part of the system prompt.
 *
 * The copy says "asks the AI to" rather than "makes the AI", because that is the truth: each
 * choice adds a line of guidance to the prompt. It is a request to a language model, not a
 * setting the server enforces, and nothing checks the narration that comes back against it.
 */
function TableStyleSection({
  campaignId,
  seat,
  onChanged,
}: {
  campaignId: number;
  seat: AiDmSeat;
  onChanged: (seat: AiDmSeat) => void;
}) {
  const { t } = useTranslation();
  const [presets, setPresets] = useState<AiDmStylePresets>(seat.stylePresets);
  const feedback = useSaveFeedback(t('settings.aiDm.tableStyle.feedbackSubject'));
  const saving = feedback.state === 'saving';

  // Deliberately NOT re-synced from `seat`, matching InstructionsSection above.
  // Every section on this card shares one `seat` object in the parent, so saving the
  // mode, budget or instructions replaces it wholesale — and `stylePresets` comes back
  // as a NEW object reference even when its values are identical. An effect keyed on
  // that reference would fire on every sibling save and overwrite dropdown choices the
  // DM had picked but not yet saved, with no warning. The parent doesn't mount this
  // section until the seat has loaded, so seeding once in useState is sufficient.

  async function save() {
    if (saving) return;
    feedback.begin();
    try {
      const updated = await api.put<AiDmSeat>(`${API}/campaigns/${campaignId}/ai-dm`, { stylePresets: presets });
      onChanged(updated);
      feedback.succeed();
    } catch (e) {
      if (e instanceof ApiError) {
        feedback.fail(e.message);
      } else {
        feedback.fail(t('settings.aiDm.errors.saveTableStyle'), { generic: true });
      }
    }
  }

  return (
    <Section title={t('settings.aiDm.tableStyle.sectionTitle')} id={AI_DM_STYLE_SECTION_ID}>
      <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>
        {t('settings.aiDm.tableStyle.body')}
      </p>
      <div className="flex gap-2 flex-wrap">
        {AI_DM_STYLE_PRESET_AXES.map((axis) => (
          <div className="field" style={{ maxWidth: 260 }} key={axis.key}>
            <label htmlFor={aiDmStyleSelectId(axis.key)}>
              {t(`settings.aiDm.tableStyle.axes.${axis.key}`, { defaultValue: axis.label })}
            </label>
            <select
              id={aiDmStyleSelectId(axis.key)}
              className="input"
              value={presets[axis.key]}
              disabled={saving}
              aria-describedby={feedback.statusId}
              onChange={(e) => { const value = e.target.value; const next = { ...presets, [axis.key]: value }; setPresets(next); feedback.syncDirty(JSON.stringify(next) !== JSON.stringify(seat.stylePresets)); }}
            >
              {AI_DM_STYLE_PRESET_OPTIONS[axis.key].map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {t(`settings.aiDm.tableStyle.options.${axis.key}.${opt.value}`, { defaultValue: opt.label })}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>
      <div className="flex gap-2 items-center">
        <button className="btn btn-primary" style={{ fontSize: 12.5 }} disabled={saving} onClick={() => void save()}>
          {saving ? t('common.saving') : t('settings.aiDm.tableStyle.save')}
        </button>
        {feedback.announcement}
      </div>
    </Section>
  );
}

/**
 * Comprehension profile (#874).
 *
 * A DIFFERENT axis from the table style above: style is a voice/taste preference, this is an
 * ACCESSIBILITY preference — how readable a turn's narration is for the humans at this table.
 * Same shape as {@link TableStyleSection} on purpose (closed dropdowns beside the freeform
 * textarea, never replacing it), and the same honesty about what it is: each choice adds a line
 * of guidance to the prompt, never a rule the server enforces. Unlike table style, some of this
 * feature's behaviour — chunked narration, a "What changed"/"What can you do" ending, and
 * support for Simplify/Recap/Explain — is always on regardless of these dropdowns; the copy
 * below says so rather than implying every default here is a no-op the way an all-default style
 * preset is.
 */
function ComprehensionProfileSection({
  campaignId,
  seat,
  onChanged,
}: {
  campaignId: number;
  seat: AiDmSeat;
  onChanged: (seat: AiDmSeat) => void;
}) {
  const { t } = useTranslation();
  const [profile, setProfile] = useState<AiDmComprehensionProfile>(seat.comprehensionProfile);
  const feedback = useSaveFeedback(t('settings.aiDm.comprehension.feedbackSubject'));
  const saving = feedback.state === 'saving';

  // Deliberately NOT re-synced from `seat` — same reasoning as TableStyleSection above.

  async function save() {
    if (saving) return;
    feedback.begin();
    try {
      const updated = await api.put<AiDmSeat>(`${API}/campaigns/${campaignId}/ai-dm`, { comprehensionProfile: profile });
      onChanged(updated);
      feedback.succeed();
    } catch (e) {
      if (e instanceof ApiError) {
        feedback.fail(e.message);
      } else {
        feedback.fail(t('settings.aiDm.errors.saveComprehension'), { generic: true });
      }
    }
  }

  return (
    <Section title={t('settings.aiDm.comprehension.sectionTitle')} id={AI_DM_COMPREHENSION_SECTION_ID}>
      <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>
        {t('settings.aiDm.comprehension.body')}
      </p>
      <div className="flex gap-2 flex-wrap">
        {AI_DM_COMPREHENSION_PROFILE_AXES.map((axis) => (
          <div className="field" style={{ maxWidth: 260 }} key={axis.key}>
            <label htmlFor={aiDmComprehensionSelectId(axis.key)}>
              {t(`settings.aiDm.comprehension.axes.${axis.key}`, { defaultValue: axis.label })}
            </label>
            <select
              id={aiDmComprehensionSelectId(axis.key)}
              className="input"
              value={profile[axis.key]}
              disabled={saving}
              aria-describedby={feedback.statusId}
              onChange={(e) => { const value = e.target.value; const next = { ...profile, [axis.key]: value }; setProfile(next); feedback.syncDirty(JSON.stringify(next) !== JSON.stringify(seat.comprehensionProfile)); }}
            >
              {AI_DM_COMPREHENSION_PROFILE_OPTIONS[axis.key].map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {t(`settings.aiDm.comprehension.options.${axis.key}.${opt.value}`, { defaultValue: opt.label })}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>
      <div className="flex gap-2 items-center">
        <button className="btn btn-primary" style={{ fontSize: 12.5 }} disabled={saving} onClick={() => void save()}>
          {saving ? t('common.saving') : t('settings.aiDm.comprehension.save')}
        </button>
        {feedback.announcement}
      </div>
    </Section>
  );
}
