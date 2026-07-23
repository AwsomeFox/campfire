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
import { useEffect, useState } from 'react';
import type { AiDmMode, AiDmSeat, AiProviderEffectiveView } from '@campfire/schema';
import { api, ApiError, API } from '../../lib/api';
import { ProviderForm } from './ProviderForm';

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
      'Acts. The AI holds the DM seat and runs the session directly — it narrates, rolls dice, applies HP and conditions, awards XP, advances turns, reveals map regions, and jots table notes within the budget you set. Canon edits (new NPCs, quests, locations) still become proposals for your review. Requires the experimental server flag, a positive token budget, and a configured provider.',
  },
];

const MODE_LABEL: Record<AiDmMode, string> = { off: 'Off', co_dm: 'Co-DM', driver: 'Driver' };
const MODE_TAG: Record<AiDmMode, string> = { off: 'tag-neutral', co_dm: 'tag-accent-2', driver: 'tag-accent' };

/** Deep-link hash for the Budget & usage section (onboarding checklist / gate CTAs). */
export const AI_DM_BUDGET_SECTION_ID = 'ai-dm-budget';
/** Distinct control id for the token-budget input — must not collide with the section anchor (#751). */
export const AI_DM_BUDGET_INPUT_ID = 'ai-dm-budget-input';

export default function AiDmCard({ campaignId }: { campaignId: number }) {
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
    return (
      <div className="card elev-sm">
        <span className="card-kicker">AI Dungeon Master</span>
        <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>Loading…</p>
      </div>
    );
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

  const usagePct = seat.tokenBudget > 0 ? Math.min(100, Math.round((seat.tokensUsed / seat.tokenBudget) * 100)) : 0;

  return (
    <div className="card elev-sm" id="ai-dm" style={{ scrollMarginTop: 72 }}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="card-kicker" style={{ margin: 0 }}>AI Dungeon Master</span>
        <span className={`tag ${MODE_TAG[seat.mode]}`} style={{ fontSize: 10 }}>
          AI is currently: {MODE_LABEL[seat.mode]}
        </span>
      </div>
      <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>
        Experimental. A server admin must enable server-side AI and set the provider + API key in the AI console for
        any of this to take effect; until then, saving here returns a clear "disabled" message. This page carries only
        the settings that vary per table — mode, budget, and steering.
      </p>

      <ModeSection campaignId={campaignId} seat={seat} onChanged={(s) => setSeat(s)} />
      <EffectiveProviderSection campaignId={campaignId} effective={effective} onChanged={() => void loadEffective()} />
      <BudgetSection campaignId={campaignId} seat={seat} usagePct={usagePct} onChanged={(s) => setSeat(s)} />
      <InstructionsSection campaignId={campaignId} seat={seat} onChanged={(s) => setSeat(s)} />
    </div>
  );
}

/**
 * Divider + subsection heading to keep the one card readable. The optional `id` is the
 * deep-link anchor the onboarding checklist (#343) targets (e.g. #ai-dm-provider);
 * `scrollMarginTop` keeps the heading clear of the sticky app header when jumped to.
 */
function Section({ title, id, children }: { title: string; id?: string; children: React.ReactNode }) {
  return (
    <div
      id={id}
      className="flex flex-col gap-2"
      style={{ borderTop: '1px solid var(--color-neutral-800, #2a2a2a)', paddingTop: 12, marginTop: 4, scrollMarginTop: 72 }}
    >
      <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-neutral-200)' }}>{title}</span>
      {children}
    </div>
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
        {MODES.map((m) => (
          <label
            key={m.value}
            className="flex gap-2"
            style={{ cursor: saving ? 'wait' : 'pointer', alignItems: 'flex-start' }}
          >
            <input
              type="radio"
              name="ai-dm-mode"
              checked={seat.mode === m.value}
              disabled={!!saving}
              onChange={() => void pick(m.value)}
              style={{ marginTop: 2 }}
            />
            <span className="flex flex-col">
              <span style={{ fontSize: 13, fontWeight: 600 }}>{m.label}</span>
              <span className="text-muted" style={{ fontSize: 11.5 }}>{m.blurb}</span>
            </span>
          </label>
        ))}
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
  const [showOverride, setShowOverride] = useState(false);

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
          {seat.tokensUsed.toLocaleString()} / {seat.tokenBudget.toLocaleString()} tokens used
          {' · '}
          {seat.turnCount} turn{seat.turnCount === 1 ? '' : 's'}
          {seat.lastTurnAt ? ` · last ${new Date(seat.lastTurnAt).toLocaleString()}` : ''}
        </span>
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
    <Section title="Steering instructions">
      <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>
        DM-only persona / house rules for the AI. Never shown to players — this is where plot secrets can live.
      </p>
      <div className="field">
        <label htmlFor="ai-dm-instructions" className="sr-only">Steering instructions</label>
        <textarea
          id="ai-dm-instructions"
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
