/**
 * Admin AI console (issue #315) — the server-admin cockpit over the AI program
 * (epic #308), rendered on /admin. One card that surfaces and drives:
 *   - the global KILL SWITCH (experimentalAiDm) — off pauses all AI immediately;
 *   - server-wide + per-campaign token caps/budgets;
 *   - a usage dashboard (tokens/turns by campaign and by model) aggregated from
 *     the per-seat metering;
 *   - the model allowlist editor (drives #310's allowedModels);
 *   - a provider-health "test all".
 *
 * All backed by /settings/ai/* (admin-only). No key or raw prompt is ever shown.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AiConsoleOverview, AiProviderHealthEntry } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { Card, Btn, TextInput, Skeleton, ErrorNote } from '../../components/ui';
import { ProviderForm } from '../settings/ProviderForm';

function fmt(n: number): string {
  return n.toLocaleString();
}

const ALLOWLIST_MAX_MODELS = 200;
const ALLOWLIST_MAX_MODEL_ID_LENGTH = 120;

type AllowlistDraftValidation = {
  allowedModels: string[];
  errors: string[];
};

function validateAllowlistDraft(text: string): AllowlistDraftValidation {
  const allowedModels = text
    .split(/[\n,]/)
    .map((value) => value.trim())
    .filter(Boolean);
  const errors: string[] = [];
  const firstEntryByModel = new Map<string, number>();

  allowedModels.forEach((model, index) => {
    const entryNumber = index + 1;
    if (model.length > ALLOWLIST_MAX_MODEL_ID_LENGTH) {
      errors.push(
        `Entry ${entryNumber} is ${model.length} characters; model IDs can be at most ${ALLOWLIST_MAX_MODEL_ID_LENGTH} characters.`,
      );
    }
    if (/\s/.test(model)) {
      errors.push(`Entry ${entryNumber} contains whitespace. Separate model IDs with a comma or line break.`);
    }

    const firstEntry = firstEntryByModel.get(model);
    if (firstEntry !== undefined) {
      errors.push(`Entry ${entryNumber} duplicates entry ${firstEntry}: “${model}”.`);
    } else {
      firstEntryByModel.set(model, entryNumber);
    }
  });

  if (allowedModels.length > ALLOWLIST_MAX_MODELS) {
    errors.push(`The allowlist has ${allowedModels.length} entries; it can contain at most ${ALLOWLIST_MAX_MODELS}.`);
  }

  return { allowedModels, errors };
}

export function AiConsoleCard() {
  const [ov, setOv] = useState<AiConsoleOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setOv(await api.get<AiConsoleOverview>(`${API}/settings/ai`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load the AI console.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleKill() {
    if (!ov) return;
    setBusy(true);
    setError(null);
    try {
      setOv(await api.post<AiConsoleOverview>(`${API}/settings/ai/kill`, { enabled: !ov.killSwitchEnabled }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't toggle the kill switch.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-4">
      <div className="flex items-center justify-between border-b border-slate-700 pb-2">
        <h2 className="font-bold text-white text-sm">AI console</h2>
        {ov && (
          <span className={`cf-chip ${ov.killSwitchEnabled ? 'cf-chip-completed' : 'cf-chip-failed'}`}>
            {ov.killSwitchEnabled ? 'AI enabled' : 'AI paused'}
          </span>
        )}
      </div>

      {error && <ErrorNote message={error} onRetry={load} />}

      {!ov ? (
        <Skeleton lines={4} />
      ) : (
        <>
          <p className="text-[11px] text-slate-500">
            Opt in, cap spend, watch usage, and stop everything with one switch. The kill switch pauses{' '}
            <strong>all</strong> AI server-wide instantly — no new turn can start while it&apos;s off.
          </p>

          {/* Kill switch */}
          <div className="cf-inset p-3.5 flex items-center justify-between gap-3 flex-wrap">
            <div>
              <p className="text-sm font-semibold text-white">Server-wide AI</p>
              <p className="text-[11px] text-slate-500">
                {ov.killSwitchEnabled
                  ? 'AI is enabled. Turn this off to pause every campaign immediately.'
                  : 'AI is paused server-wide. Turn on to opt the server in.'}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={ov.killSwitchEnabled}
              onClick={toggleKill}
              disabled={busy}
              className={`cf-btn !min-h-0 !py-1.5 text-xs ${ov.killSwitchEnabled ? '' : '!bg-rose-600 !border-rose-500'}`}
            >
              {ov.killSwitchEnabled ? 'On — click to pause' : 'Paused — click to enable'}
            </button>
          </div>

          {/* Usage totals */}
          <UsageSummary ov={ov} />

          {/* Budgets & caps */}
          <CapsEditor ov={ov} onSaved={setOv} onError={setError} />

          {/* Default AI provider + write-only key (issue #399) — the fallback every campaign inherits. */}
          <ProviderDefaultSection ov={ov} onChanged={load} />

          {/* Model allowlist — kept next to the provider it constrains. */}
          <AllowlistEditor ov={ov} onSaved={setOv} onError={setError} />

          {/* Per-campaign usage table */}
          <CampaignUsageTable ov={ov} />

          {/* Provider health */}
          <HealthPanel onError={setError} />
        </>
      )}
    </Card>
  );
}

function UsageSummary({ ov }: { ov: AiConsoleOverview }) {
  const u = ov.usage;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      <Stat label="Tokens used" value={fmt(u.totalTokensUsed)} />
      <Stat label="Turns" value={fmt(u.totalTurns)} />
      <Stat label="Active seats" value={`${u.activeSeatCount} / ${u.seatCount}`} />
      <Stat
        label="Server cap"
        value={
          u.serverTokenCap > 0
            ? `${fmt(u.serverBudgetRemaining ?? 0)} left`
            : 'Unlimited'
        }
        sub={u.serverTokenCap > 0 ? `of ${fmt(u.serverTokenCap)}` : undefined}
      />
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="cf-inset p-3">
      <p className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">{label}</p>
      <p className="text-lg font-extrabold text-white leading-tight">{value}</p>
      {sub && <p className="text-[10px] text-slate-600">{sub}</p>}
    </div>
  );
}

function CapsEditor({
  ov,
  onSaved,
  onError,
}: {
  ov: AiConsoleOverview;
  onSaved: (o: AiConsoleOverview) => void;
  onError: (msg: string | null) => void;
}) {
  const [cap, setCap] = useState(String(ov.serverTokenCap));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setCap(String(ov.serverTokenCap));
  }, [ov.serverTokenCap]);

  async function save() {
    const n = Math.max(0, Math.floor(Number(cap) || 0));
    setSaving(true);
    onError(null);
    setSaved(false);
    try {
      onSaved(await api.put<AiConsoleOverview>(`${API}/settings/ai/caps`, { serverTokenCap: n }));
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Couldn't save the cap.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="cf-inset p-3.5 space-y-2">
      <p className="text-[10px] font-bold text-amber-500 uppercase tracking-widest">Budgets &amp; cost caps</p>
      <p className="text-[11px] text-slate-500">
        A server-wide <strong>hard</strong> token cap across every campaign. 0 = unlimited. Once the total metered
        tokens reach it, new turns are refused with a clear reason (per-campaign budgets are set per row below).
      </p>
      <div className="flex items-end gap-2 flex-wrap">
        <label className="block">
          <span className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">Server token cap</span>
          <TextInput
            className="!min-h-0 !py-2 text-sm mt-1 w-40"
            type="number"
            min={0}
            value={cap}
            onChange={(e) => setCap(e.target.value)}
          />
        </label>
        {saved && <span className="text-xs text-emerald-400 mb-2">Saved.</span>}
        <Btn className="!min-h-0 !py-1.5 text-xs mb-0.5" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save cap'}
        </Btn>
      </div>
    </div>
  );
}

function ProviderDefaultSection({ ov, onChanged }: { ov: AiConsoleOverview; onChanged: () => void }) {
  return (
    <div className="cf-inset p-3.5 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-[10px] font-bold text-amber-500 uppercase tracking-widest">Default AI provider</p>
        <span className={`cf-chip ${ov.serverProviderReady ? 'cf-chip-completed' : 'cf-chip-private'}`}>
          {ov.serverProviderConfigured
            ? `${ov.serverProviderReady ? 'Ready' : 'Credential missing'}${ov.serverProviderType ? ` · ${ov.serverProviderType}` : ''}`
            : 'Not set'}
        </span>
      </div>
      <p className="text-[11px] text-slate-500">
        One set of credentials, one bill. This is the server default every campaign falls back to unless a DM sets a
        per-campaign override. The API key is <strong>write-only</strong> — it is never shown back, only its last 4
        digits. Setting it here is all a DM needs to run AI (no per-campaign key required).
      </p>
      <ProviderForm basePath="/settings/ai-provider" scope="server" onChanged={onChanged} />
    </div>
  );
}

function AllowlistEditor({
  ov,
  onSaved,
  onError,
}: {
  ov: AiConsoleOverview;
  onSaved: (o: AiConsoleOverview) => void;
  onError: (msg: string | null) => void;
}) {
  const savedText = ov.allowedModels.join('\n');
  const [text, setText] = useState(savedText);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const validation = useMemo(() => validateAllowlistDraft(text), [text]);
  const hasErrors = validation.errors.length > 0;
  const inputId = 'ai-allowed-model-ids';
  const helpId = 'ai-allowed-model-ids-help';
  const errorId = 'ai-allowed-model-ids-errors';
  const effectiveStateId = 'ai-allowed-model-ids-effective-state';

  useEffect(() => {
    setText(savedText);
  }, [savedText]);

  async function save() {
    if (hasErrors) return;
    setSaving(true);
    onError(null);
    setSaved(false);
    try {
      onSaved(
        await api.put<AiConsoleOverview>(`${API}/settings/ai/allowlist`, {
          allowedModels: validation.allowedModels,
        }),
      );
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Couldn't save the allowlist.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="cf-inset p-3.5 space-y-2 min-w-0" data-testid="ai-model-allowlist">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-[10px] font-bold text-amber-500 uppercase tracking-widest">Model allowlist</p>
        <p
          id={effectiveStateId}
          role="status"
          aria-live="polite"
          aria-label="Effective allowlist state"
          className="text-[11px] text-slate-400"
        >
          <span className="font-semibold text-slate-300">Effective state:</span>{' '}
          {ov.allowedModels.length === 0
            ? 'Unrestricted — any model ID is allowed.'
            : `Restricted to ${ov.allowedModels.length} model ${ov.allowedModels.length === 1 ? 'ID' : 'IDs'}.`}
        </p>
      </div>
      <p className="text-[11px] text-slate-400">
        When restricted, campaign provider overrides may only select a model on this list. Requires a configured
        server-default provider.
      </p>
      <label htmlFor={inputId} className="block text-[10px] uppercase tracking-widest text-slate-400 font-bold">
        Allowed model IDs
      </label>
      <p id={helpId} className="text-[11px] text-slate-400">
        Separate model IDs with commas or line breaks. Leave blank to allow any model ID.
      </p>
      <textarea
        id={inputId}
        className="cf-input !min-h-0 py-2 text-sm w-full max-w-full font-mono"
        rows={3}
        placeholder="gpt-4o-mini&#10;claude-3-5-haiku"
        value={text}
        aria-describedby={`${helpId}${hasErrors ? ` ${errorId}` : ''}`}
        aria-invalid={hasErrors}
        aria-errormessage={hasErrors ? errorId : undefined}
        onChange={(e) => {
          setText(e.target.value);
          setSaved(false);
        }}
      />
      {hasErrors && (
        <div id={errorId} role="alert" className="text-[11px] text-rose-400 min-w-0">
          <p className="font-semibold">Fix the following before saving:</p>
          <ul className="list-disc pl-5 space-y-0.5">
            {validation.errors.map((validationError) => (
              <li key={validationError} className="break-words">
                {validationError}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex gap-2 justify-end items-center flex-wrap">
        {saved && <span className="text-xs text-emerald-400 mr-auto">Saved.</span>}
        <Btn className="!min-h-0 !py-1.5 text-xs" onClick={save} disabled={saving || hasErrors}>
          {saving ? 'Saving…' : 'Save allowlist'}
        </Btn>
      </div>
    </div>
  );
}

function CampaignUsageTable({ ov }: { ov: AiConsoleOverview }) {
  const rows = ov.usage.byCampaign;
  if (rows.length === 0) {
    return (
      <p className="text-[11px] text-slate-500">
        No campaign has configured an AI-DM seat yet. Once a DM enables one, its usage and budget show up here.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Usage by campaign</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[10px] uppercase text-slate-500 text-left">
              <th className="py-2 pr-4 font-bold">Campaign</th>
              <th className="pr-4 font-bold">Model</th>
              <th className="pr-4 font-bold">Seat</th>
              <th className="pr-4 font-bold text-right">Used / budget</th>
              <th className="pr-4 font-bold text-right">Turns</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {rows.map((r) => {
              const over = r.tokenBudget > 0 && r.tokensUsed >= r.tokenBudget;
              return (
                <tr key={r.campaignId}>
                  <td className="py-2 pr-4 font-semibold text-white">{r.campaignName}</td>
                  <td className="pr-4 text-slate-400">{r.model || <span className="text-slate-600">—</span>}</td>
                  <td className="pr-4">
                    <span className={`cf-chip ${r.enabled ? 'cf-chip-completed' : 'cf-chip-private'}`}>
                      {r.enabled ? 'On' : 'Off'}
                    </span>
                  </td>
                  <td className={`pr-4 text-right ${over ? 'text-rose-400' : 'text-slate-300'}`}>
                    {fmt(r.tokensUsed)} / {r.tokenBudget > 0 ? fmt(r.tokenBudget) : '∞'}
                  </td>
                  <td className="pr-4 text-right text-slate-400">{fmt(r.turnCount)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {ov.usage.byModel.length > 0 && (
        <p className="text-[11px] text-slate-500">
          By model:{' '}
          {ov.usage.byModel.map((m, i) => (
            <span key={m.model || `_${i}`}>
              {i > 0 && ' · '}
              <span className="text-slate-300">{m.model || '(unset)'}</span> {fmt(m.tokensUsed)} tok
            </span>
          ))}
        </p>
      )}
      <p className="text-[11px] text-slate-600">
        Set a campaign&apos;s budget from its own AI-DM settings, or raise the server cap above. Usage aggregates the
        per-turn metering.
      </p>
    </div>
  );
}

function HealthPanel({ onError }: { onError: (msg: string | null) => void }) {
  const [results, setResults] = useState<AiProviderHealthEntry[] | null>(null);
  const [testing, setTesting] = useState(false);

  async function testAll() {
    setTesting(true);
    onError(null);
    try {
      setResults(await api.post<AiProviderHealthEntry[]>(`${API}/settings/ai/health`));
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Couldn't run the health check.");
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="cf-inset p-3.5 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-bold text-amber-500 uppercase tracking-widest">Provider health</p>
        <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={testAll} disabled={testing}>
          {testing ? 'Testing…' : 'Test all'}
        </Btn>
      </div>
      {results && results.length === 0 && (
        <p className="text-[11px] text-slate-500">No AI provider is configured yet.</p>
      )}
      {results && results.length > 0 && (
        <ul className="space-y-1">
          {results.map((r, i) => (
            <li key={`${r.scope}-${r.campaignId ?? 'server'}-${i}`} className="text-[11px] flex items-center gap-2">
              <span className={r.ok ? 'text-emerald-400' : 'text-rose-400'}>{r.ok ? '✓' : '✗'}</span>
              <span className="text-slate-300">
                {r.scope === 'server' ? 'Server default' : r.campaignName}
              </span>
              <span className="text-slate-600">·</span>
              <span className="text-slate-500">
                {r.providerType} / {r.model || '—'}
              </span>
              {!r.ok && r.error && <span className="text-rose-400/80 truncate">— {r.error}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
