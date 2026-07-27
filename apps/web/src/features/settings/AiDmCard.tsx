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
 */
import { useCallback, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
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
  AI_DM_STYLE_PRESET_AXES,
  AI_DM_STYLE_PRESET_OPTIONS,
  NARRATION_LANGUAGE_OPTIONS,
  type AiDmStylePresets,
} from '@campfire/schema';
import { api, ApiError, API } from '../../lib/api';
import { SkeletonCard } from '../../components/ui';
import { AI_DM_BUDGET_INPUT_ID, AI_DM_BUDGET_SECTION_ID } from './aiDmBudgetIds';
import { AI_DM_STYLE_SECTION_ID, aiDmStyleSelectId } from './aiDmStyleIds';
import { ProviderForm } from './ProviderForm';
import { queryKeys } from '../../lib/query';
import { useAuth } from '../../app/auth';
import { AiSetupChecklist } from '../ai-dm/AiSetupChecklist';
import { CostDisclosure } from '../ai-dm/CostDisclosure';
import { formatUsdRange } from '../ai-dm/costEstimate';
import { TermHelp } from '../../components/TermHelp';

const AI_DM_INSTRUCTIONS_SECTION_ID = 'ai-dm-instructions';
const AI_DM_INSTRUCTIONS_INPUT_ID = 'ai-dm-instructions-input';

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
/** Field names as a DM would read them in the inherited-defaults notice (#1070). */
const INHERITED_FIELD_LABEL: Record<string, string> = {
  mode: 'operating mode',
  instructions: 'steering',
  tokenBudget: 'token budget',
  actionQueueDepth: 'action queue depth',
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

  const loadEffective = async () => {
    try {
      setEffective(await api.get<AiProviderEffectiveView>(`${API}/campaigns/${campaignId}/ai-provider/effective`));
    } catch {
      // Non-fatal: the status line degrades gracefully if this read fails.
      setEffective(null);
    }
  };

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [s] = await Promise.all([
        api.get<AiDmSeat>(`${API}/campaigns/${campaignId}/ai-dm`),
        loadEffective(),
      ]);
      setSeat(s);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Couldn't load AI DM settings.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId]);

  if (loading && !seat) {
    return <SkeletonCard sections={3} lines={2} label="Loading AI DM settings…" />;
  }

  if (loadError && !seat) {
    return (
      <div className="card elev-sm">
        <span className="card-kicker">AI Dungeon Master</span>
        <p className="text-sm" style={{ color: '#f87171' }}>{loadError}</p>
        <button className="btn btn-secondary" style={{ fontSize: 12.5, alignSelf: 'flex-start' }} onClick={() => void load()}>
          Retry
        </button>
      </div>
    );
  }

  if (!seat) return null;

  const committedTokens = seat.tokensUsed + seat.tokensReserved + seat.tokensUnknown;
  const usagePct = seat.tokenBudget > 0 ? Math.min(100, Math.round((committedTokens / seat.tokenBudget) * 100)) : 0;

  return (
    <div
      className="card elev-sm settings-anchor"
      id="ai-dm"
      tabIndex={-1}
      aria-labelledby="ai-dm-heading"
      style={{ scrollMarginTop: 72 }}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span id="ai-dm-heading" className="card-kicker" style={{ margin: 0 }}>AI Dungeon Master</span>
        <span className={`tag ${MODE_TAG[seat.mode]}`} style={{ fontSize: 10 }}>
          AI is currently: {MODE_LABEL[seat.mode]}
        </span>
      </div>
      <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>
        Experimental. A server admin must enable server-side AI and set the provider + API key in the AI console for
        any of this to take effect; until then, saving here returns a clear "disabled" message. This page carries only
        the settings that vary per table — mode, budget, and steering.
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
          Using the server-wide defaults for{' '}
          <strong>{seat.inheritedFields.map((f) => INHERITED_FIELD_LABEL[f] ?? f).join(', ')}</strong>. This campaign
          hasn't been configured yet, so it follows the server default and moves when an admin changes it. Saving any
          setting below keeps the current values and stops following.
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
    </div>
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
  const [narrationLanguage, setNarrationLanguage] = useState<NarrationLanguage>(campaign.narrationLanguage);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = narrationLanguage !== campaign.narrationLanguage;

  useEffect(() => {
    setNarrationLanguage(campaign.narrationLanguage);
  }, [campaign.id, campaign.narrationLanguage]);

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const updated = await api.patch<Campaign>(`${API}/campaigns/${campaignId}`, { narrationLanguage });
      onSaved(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save narration language.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section title="Narration language" id="ai-dm-narration-language">
      <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>
        Governs AI-generated narration from the Driver, co-DM drafts, and Scribe recaps. This is separate from your
        personal UI language in Preferences.
      </p>
      <div className="field" style={{ maxWidth: 320 }}>
        <label htmlFor="ai-dm-narration-language-select">Campaign narration language</label>
        <select
          id="ai-dm-narration-language-select"
          className="input"
          value={narrationLanguage}
          disabled={saving}
          onChange={(e) => setNarrationLanguage(e.target.value as NarrationLanguage)}
        >
          {NARRATION_LANGUAGE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
      {error && <p className="text-sm" style={{ color: '#f87171' }}>{error}</p>}
      <div className="flex gap-2 items-center">
        <button className="btn btn-primary" style={{ fontSize: 12.5 }} disabled={saving || !dirty} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save language'}
        </button>
        {saved && <span className="text-muted" style={{ fontSize: 12 }}>Saved.</span>}
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
      setError(err instanceof ApiError ? err.message : "Couldn't change the mode.");
    } finally {
      setSaving(null);
    }
  }

  return (
    <Section title="Operating mode" id="ai-dm-mode">
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
                    {m.label}
                  </label>
                  {m.value === 'co_dm' && <TermHelp termId="coDm" />}
                  {m.value === 'driver' && <TermHelp termId="driver" />}
                </span>
                <label
                  htmlFor={inputId}
                  className="text-muted"
                  style={{ cursor: saving ? 'wait' : 'pointer', fontSize: 11.5 }}
                >
                  {m.blurb}
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
  const location = useLocation();
  const [showOverride, setShowOverride] = useState(() => location.hash === '#ai-dm-provider');

  useEffect(() => {
    if (location.hash === '#ai-dm-provider') setShowOverride(true);
  }, [location.hash]);

  const sourceLabel = effective?.source === 'campaign' ? 'campaign override' : 'server default';
  const sourceTag = effective?.source === 'campaign' ? 'tag-accent' : 'tag-accent-2';

  return (
    <Section title="AI provider" id="ai-dm-provider">
      {effective?.configured ? (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span style={{ fontSize: 13, fontWeight: 600 }}>
              {effective.providerType} / {effective.model || '—'}
            </span>
            <span className={`tag ${sourceTag}`} style={{ fontSize: 10 }}>{sourceLabel}</span>
            <span className={`tag ${effective.ready ? 'tag-accent' : 'tag-neutral'}`} style={{ fontSize: 10 }}>
              {effective.ready ? 'credential ready' : 'credential missing'}
            </span>
          </div>
          <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>
            {effective.ready
              ? `Credential source: ${effective.credentialSource.replace('-', ' ')}. ${
                  effective.source === 'campaign'
                    ? 'This campaign overrides the server default below.'
                    : 'Inherited from the server default set by your server admin.'
                }`
              : 'The provider settings exist, but no usable credential is available. Ask the server admin to set a key or environment credential.'}
          </p>
        </div>
      ) : (
        <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>
          No AI provider configured — ask your server admin to set one in the AI console. You can also set a
          campaign-specific override below.
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
          {showOverride ? '▾' : '▸'} Advanced: override provider for this campaign
        </button>
        {showOverride && (
          <div
            className="flex flex-col gap-2"
            style={{ borderLeft: '2px solid var(--color-divider)', paddingLeft: 12 }}
          >
            <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>
              Optional. Most campaigns leave this blank and use the server default. Set a provider here to override it
              for this table only (a key is optional — a keyless override still uses the server key with the server's
              endpoint).
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
  const [tokenBudget, setTokenBudget] = useState(String(seat.tokenBudget));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      setError('Enter a non-negative number.');
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const updated = await api.put<AiDmSeat>(`${API}/campaigns/${campaignId}/ai-dm`, { tokenBudget: Math.floor(n) });
      onChanged(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save the budget.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section title="Budget & usage" id={AI_DM_BUDGET_SECTION_ID}>
      <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>
        A hard token cap. Turns stop once it's reached — a positive budget is required to run Driver mode.
      </p>
      <div className="field" style={{ maxWidth: 200 }}>
        <label htmlFor={AI_DM_BUDGET_INPUT_ID}>Token budget</label>
        <input
          id={AI_DM_BUDGET_INPUT_ID}
          className="input"
          type="number"
          min={0}
          value={tokenBudget}
          onChange={(e) => setTokenBudget(e.target.value)}
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
          {seat.tokensUsed.toLocaleString()} used
          {' · '}
          {seat.tokensReserved.toLocaleString()} reserved
          {' · '}
          {seat.tokensUnknown.toLocaleString()} unknown
          {' · '}
          {seat.budgetRemaining.toLocaleString()} / {seat.tokenBudget.toLocaleString()} remaining
          {' · '}
          {seat.turnCount} turn{seat.turnCount === 1 ? '' : 's'}
          {seat.lastTurnAt ? ` · last ${new Date(seat.lastTurnAt).toLocaleString()}` : ''}
        </span>
        {(seat.tokensRefunded > 0 || seat.tokensOverage > 0) && (
          <span className="text-muted" style={{ fontSize: 11 }}>
            {seat.tokensRefunded.toLocaleString()} refunded
            {seat.tokensOverage > 0 ? ` · ${seat.tokensOverage.toLocaleString()} overage recorded` : ''}
          </span>
        )}
      </div>
      {error && <p className="text-sm" style={{ color: '#f87171' }}>{error}</p>}
      <div className="flex gap-2 items-center">
        <button className="btn btn-primary" style={{ fontSize: 12.5 }} disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save budget'}
        </button>
        {saved && <span className="text-muted" style={{ fontSize: 12 }}>Saved.</span>}
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
  const [instructions, setInstructions] = useState(seat.instructions ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const updated = await api.put<AiDmSeat>(`${API}/campaigns/${campaignId}/ai-dm`, { instructions });
      onChanged(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save the instructions.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section title="Steering instructions" id={AI_DM_INSTRUCTIONS_SECTION_ID}>
      <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>
        DM-only persona / house rules for the AI. Never shown to players — this is where plot secrets can live.
      </p>
      <div className="field">
        <label htmlFor={AI_DM_INSTRUCTIONS_INPUT_ID} className="sr-only">Steering instructions</label>
        <textarea
          id={AI_DM_INSTRUCTIONS_INPUT_ID}
          className="input"
          style={{ minHeight: 96 }}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="e.g. Be terse and grim. Never reveal the traitor's identity until Act 3."
        />
      </div>
      {error && <p className="text-sm" style={{ color: '#f87171' }}>{error}</p>}
      <div className="flex gap-2 items-center">
        <button className="btn btn-primary" style={{ fontSize: 12.5 }} disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save instructions'}
        </button>
        {saved && <span className="text-muted" style={{ fontSize: 12 }}>Saved.</span>}
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
  const [presets, setPresets] = useState<AiDmStylePresets>(seat.stylePresets);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Deliberately NOT re-synced from `seat`, matching InstructionsSection above.
  // Every section on this card shares one `seat` object in the parent, so saving the
  // mode, budget or instructions replaces it wholesale — and `stylePresets` comes back
  // as a NEW object reference even when its values are identical. An effect keyed on
  // that reference would fire on every sibling save and overwrite dropdown choices the
  // DM had picked but not yet saved, with no warning. The parent doesn't mount this
  // section until the seat has loaded, so seeding once in useState is sufficient.

  async function save() {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const updated = await api.put<AiDmSeat>(`${API}/campaigns/${campaignId}/ai-dm`, { stylePresets: presets });
      onChanged(updated);
      setSaved(true);
      // Matches every other section on this card: the confirmation is a flash, not a state.
      // Without this the "Saved." line stays up indefinitely and reads as still-current
      // after the DM has gone on to edit something else.
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save table style.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section title="Table style" id={AI_DM_STYLE_SECTION_ID}>
      <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>
        Asks the AI to narrate a certain way. Each choice adds a line of guidance to its prompt — it steers voice and
        pacing, it does not change what is true, and a model can ignore it. Leave an axis on Default to say nothing
        about it.
      </p>
      <div className="flex gap-2 flex-wrap">
        {AI_DM_STYLE_PRESET_AXES.map((axis) => (
          <div className="field" style={{ maxWidth: 260 }} key={axis.key}>
            <label htmlFor={aiDmStyleSelectId(axis.key)}>{axis.label}</label>
            <select
              id={aiDmStyleSelectId(axis.key)}
              className="input"
              value={presets[axis.key]}
              disabled={saving}
              onChange={(e) => setPresets((prev) => ({ ...prev, [axis.key]: e.target.value }))}
            >
              {AI_DM_STYLE_PRESET_OPTIONS[axis.key].map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>
      {error && <p className="text-sm" style={{ color: '#f87171' }}>{error}</p>}
      <div className="flex gap-2 items-center">
        <button className="btn btn-primary" style={{ fontSize: 12.5 }} disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save table style'}
        </button>
        {saved && <span className="text-muted" style={{ fontSize: 12 }}>Saved.</span>}
      </div>
    </Section>
  );
}
