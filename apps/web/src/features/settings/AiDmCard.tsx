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
import type { AiDmMode, AiDmSeat, AiProviderConfigType, AiProviderConfigView, AiProviderTestResult } from '@campfire/schema';
import { api, ApiError, API } from '../../lib/api';

const MODES: { value: AiDmMode; label: string; blurb: string }[] = [
  {
    value: 'off',
    label: 'Off',
    blurb: 'No AI participation. The seat is idle — nothing is proposed or narrated.',
  },
  {
    value: 'co_dm',
    label: 'Co-DM (assist)',
    blurb:
      'The AI only proposes — every change lands in the approval queue for you to accept or reject. You run the table. Recommended.',
  },
  {
    value: 'driver',
    label: 'Driver',
    blurb:
      'The AI holds the DM seat and runs the session. Requires the experimental server flag, a positive token budget, and a configured provider.',
  },
];

const PROVIDER_TYPES: AiProviderConfigType[] = ['openai', 'anthropic', 'mock'];

const MODE_LABEL: Record<AiDmMode, string> = { off: 'Off', co_dm: 'Co-DM', driver: 'Driver' };
const MODE_TAG: Record<AiDmMode, string> = { off: 'tag-neutral', co_dm: 'tag-accent-2', driver: 'tag-accent' };

export default function AiDmCard({ campaignId }: { campaignId: number }) {
  const [seat, setSeat] = useState<AiDmSeat | null>(null);
  const [provider, setProvider] = useState<AiProviderConfigView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [s, p] = await Promise.all([
        api.get<AiDmSeat>(`${API}/campaigns/${campaignId}/ai-dm`),
        api.get<AiProviderConfigView | null>(`${API}/campaigns/${campaignId}/ai-provider`),
      ]);
      setSeat(s);
      setProvider(p);
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
        Experimental. A server admin must enable server-side AI for any of this to take effect; until then, saving here
        returns a clear "disabled" message. The API key is write-only — it's never shown back to you.
      </p>

      <ModeSection campaignId={campaignId} seat={seat} onChanged={(s) => setSeat(s)} />
      <ProviderSection campaignId={campaignId} provider={provider} onChanged={(p) => setProvider(p)} />
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

function ProviderSection({
  campaignId,
  provider,
  onChanged,
}: {
  campaignId: number;
  provider: AiProviderConfigView | null;
  onChanged: (p: AiProviderConfigView) => void;
}) {
  const [providerType, setProviderType] = useState<AiProviderConfigType>(provider?.providerType ?? 'openai');
  const [model, setModel] = useState(provider?.model ?? '');
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState(''); // write-only; blank keeps the stored key
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<AiProviderTestResult | null>(null);

  async function save() {
    if (!model.trim()) {
      setError('A model is required.');
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const body: Record<string, unknown> = { providerType, model: model.trim() };
      if (baseUrl.trim()) body.baseUrl = baseUrl.trim();
      // Only send apiKey when the DM typed one — an omitted key keeps the stored value.
      if (apiKey !== '') body.apiKey = apiKey;
      const updated = await api.put<AiProviderConfigView>(`${API}/campaigns/${campaignId}/ai-provider`, body);
      onChanged(updated);
      setApiKey(''); // never retain the plaintext key in state
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save the provider.");
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api.post<AiProviderTestResult>(`${API}/campaigns/${campaignId}/ai-provider/test`);
      setTestResult(r);
    } catch (err) {
      setTestResult({
        ok: false,
        scope: 'campaign',
        providerType,
        model,
        error: err instanceof ApiError ? err.message : 'Test failed.',
      });
    } finally {
      setTesting(false);
    }
  }

  return (
    <Section title="Provider & model" id="ai-dm-provider">
      <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>
        {provider
          ? provider.configured
            ? `A key is stored for this campaign (ends ••${provider.keyLast4 ?? '????'}). Leave the key blank to keep it, or enter a new one to rotate.`
            : 'No API key stored yet for this campaign. It may fall back to the server default when set.'
          : 'Using the server default (if configured). Set a provider below to override it for this campaign.'}
      </p>
      <div className="flex gap-2 flex-wrap">
        <div className="field" style={{ maxWidth: 160 }}>
          <label htmlFor="ai-provider-type">Provider</label>
          <select
            id="ai-provider-type"
            className="input"
            value={providerType}
            onChange={(e) => setProviderType(e.target.value as AiProviderConfigType)}
          >
            {PROVIDER_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
        <div className="field" style={{ flex: 1, minWidth: 160 }}>
          <label htmlFor="ai-provider-model">Model</label>
          <input
            id="ai-provider-model"
            className="input"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="e.g. gpt-4o-mini"
          />
        </div>
      </div>
      <div className="field">
        <label htmlFor="ai-provider-baseurl">Base URL (optional)</label>
        <input
          id="ai-provider-baseurl"
          className="input"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="Leave blank for the provider default"
        />
      </div>
      <div className="field">
        <label htmlFor="ai-provider-key">API key {provider?.configured ? '(set — blank keeps it)' : '(write-only)'}</label>
        <input
          id="ai-provider-key"
          className="input"
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={provider?.configured ? '•••••••• (unchanged)' : 'Paste a key to set it'}
        />
      </div>
      {error && <p className="text-sm" style={{ color: '#f87171' }}>{error}</p>}
      {testResult && (
        <p className="text-sm" style={{ color: testResult.ok ? 'var(--color-accent, #4ade80)' : '#f87171' }}>
          {testResult.ok
            ? `Connection OK — ${testResult.providerType} / ${testResult.model}`
            : `Connection failed: ${testResult.error ?? 'unknown error'}`}
        </p>
      )}
      <div className="flex gap-2 items-center flex-wrap">
        <button className="btn btn-primary" style={{ fontSize: 12.5 }} disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save provider'}
        </button>
        <button className="btn btn-secondary" style={{ fontSize: 12.5 }} disabled={testing} onClick={() => void test()}>
          {testing ? 'Testing…' : 'Test connection'}
        </button>
        {saved && <span className="text-muted" style={{ fontSize: 12 }}>Saved.</span>}
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
    <Section title="Budget & usage" id="ai-dm-budget">
      <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>
        A hard token cap. Turns stop once it's reached — a positive budget is required to run Driver mode.
      </p>
      <div className="field" style={{ maxWidth: 200 }}>
        <label htmlFor="ai-dm-budget">Token budget</label>
        <input
          id="ai-dm-budget"
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
