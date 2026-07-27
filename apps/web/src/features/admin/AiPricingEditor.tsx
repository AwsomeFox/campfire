/**
 * Admin model-pricing editor (issue #1065).
 *
 * The one place a dollar figure can enter the system. Everything downstream — the budget
 * field, the pre-Driver checklist, the per-turn line — either renders a number that came from
 * this table or renders the cannot-estimate disclosure. There is no third source.
 *
 * Two deliberate properties:
 *
 *   1. PREFILL IS AN ACT, NOT A DEFAULT. Campfire's reference figures are offered as a button.
 *      They land in the form as editable values that do nothing until saved. Nothing estimates
 *      against the reference list, so an admin who never opens this screen gets the disclosure
 *      everywhere rather than numbers nobody vouched for. Pressing the button is the consent
 *      signal, given by the person best placed to judge, while looking at the actual figures —
 *      which is why there is no separate per-campaign opt-in toggle anywhere in this feature.
 *
 *   2. THE ENDPOINT IS PART OF THE KEY. The Base URL column is not decoration. A price entered
 *      for a vendor's own endpoint is never applied to a custom one, because a model name
 *      behind a proxy says nothing about what that proxy charges.
 */
import { useEffect, useMemo, useState } from 'react';
import type { AiPricingView } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { Btn } from '../../components/ui';

interface Row {
  providerType: string;
  model: string;
  baseUrl: string;
  input: string;
  output: string;
  source: 'manual' | 'reference';
  asOf: string | null;
}

function toRows(view: AiPricingView): Row[] {
  return view.entries.map((e) => ({
    providerType: e.providerType,
    model: e.model,
    baseUrl: e.baseUrl,
    input: String(e.inputUsdPerMTok),
    output: String(e.outputUsdPerMTok),
    source: e.source,
    asOf: e.asOf,
  }));
}

/** A row is saveable when it names a model and both prices parse as non-negative numbers. */
function rowErrors(rows: Row[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  rows.forEach((r, i) => {
    const where = `Row ${i + 1}`;
    if (!r.providerType.trim()) errors.push(`${where}: choose a provider.`);
    if (!r.model.trim()) errors.push(`${where}: enter a model ID.`);
    for (const [label, raw] of [['input', r.input], ['output', r.output]] as const) {
      const n = Number(raw);
      if (raw.trim() === '' || !Number.isFinite(n) || n < 0) {
        errors.push(`${where}: ${label} price must be a number of dollars per million tokens (0 or more).`);
      }
    }
    // The natural key. Two rows for the same target would make resolution order-dependent.
    const key = `${r.providerType.trim().toLowerCase()}|${r.model.trim().toLowerCase()}|${r.baseUrl.trim().toLowerCase()}`;
    if (seen.has(key)) errors.push(`${where}: duplicate provider + model + endpoint.`);
    seen.add(key);
  });
  return errors;
}

export function AiPricingEditor({ onError }: { onError: (msg: string | null) => void }) {
  const [view, setView] = useState<AiPricingView | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [prefillProvider, setPrefillProvider] = useState('openai');

  useEffect(() => {
    void (async () => {
      try {
        const v = await api.get<AiPricingView>(`${API}/settings/ai/pricing`);
        setView(v);
        setRows(toRows(v));
      } catch {
        // Non-fatal: the rest of the console still works without the pricing panel.
        setView(null);
      }
    })();
  }, []);

  const errors = useMemo(() => rowErrors(rows), [rows]);
  const hasErrors = errors.length > 0;
  const providerOptions = useMemo(
    () => [...new Set((view?.reference ?? []).map((r) => r.providerType))],
    [view],
  );

  function update(i: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch, source: 'manual' } : r)));
    setSaved(false);
  }

  function prefill() {
    if (!view) return;
    const additions = view.reference
      .filter((r) => r.providerType === prefillProvider)
      // Never clobber a price an admin already set — theirs is the authoritative one.
      .filter(
        (r) =>
          !rows.some(
            (existing) =>
              existing.providerType.trim().toLowerCase() === r.providerType.toLowerCase() &&
              existing.model.trim().toLowerCase() === r.model.toLowerCase() &&
              existing.baseUrl.trim() === '',
          ),
      )
      .map<Row>((r) => ({
        providerType: r.providerType,
        model: r.model,
        baseUrl: '',
        input: String(r.inputUsdPerMTok),
        output: String(r.outputUsdPerMTok),
        // Recorded so the estimate can later say where the figure came from and how old the
        // list was — the admin reviewed these, but they did not originate them.
        source: 'reference',
        asOf: view.referenceAsOf,
      }));
    if (additions.length === 0) return;
    setRows((prev) => [...prev, ...additions]);
    setSaved(false);
  }

  async function save() {
    if (hasErrors) return;
    setSaving(true);
    onError(null);
    setSaved(false);
    try {
      const next = await api.put<AiPricingView>(`${API}/settings/ai/pricing`, {
        entries: rows.map((r) => ({
          providerType: r.providerType.trim(),
          model: r.model.trim(),
          baseUrl: r.baseUrl.trim(),
          inputUsdPerMTok: Number(r.input),
          outputUsdPerMTok: Number(r.output),
          source: r.source,
          asOf: r.asOf,
        })),
      });
      setView(next);
      setRows(toRows(next));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Couldn't save model pricing.");
    } finally {
      setSaving(false);
    }
  }

  if (!view) return null;

  return (
    <div className="cf-inset p-3.5 space-y-2 min-w-0" data-testid="ai-model-pricing">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-[10px] font-bold text-amber-500 uppercase tracking-widest">Model pricing</p>
        <p role="status" aria-live="polite" className="text-[11px] text-slate-400">
          <span className="font-semibold text-slate-300">Effective state:</span>{' '}
          {rows.length === 0
            ? 'No pricing — every campaign shows “cannot estimate cost”.'
            : `${rows.length} priced model${rows.length === 1 ? '' : 's'}.`}
        </p>
      </div>
      <p className="text-[11px] text-slate-400">
        Turns token budgets into dollar estimates for DMs. A model with no entry here shows an explicit
        “Campfire cannot estimate cost — monitor your provider’s billing” instead of a figure, which is the
        intended behaviour: a wrong number is worse than none. Prices are USD per <strong>million</strong> tokens.
      </p>
      <p className="text-[11px] text-slate-400">
        Leave <strong>Base URL</strong> blank for the provider’s own endpoint. If a campaign points at a proxy or a
        self-hosted server, enter that URL explicitly — a model name behind a proxy does not imply the vendor’s price.
      </p>

      <div className="overflow-x-auto">
        <table className="w-full text-[11px] min-w-[640px]">
          <thead className="text-slate-400">
            <tr>
              <th className="text-left font-semibold py-1">Provider</th>
              <th className="text-left font-semibold py-1">Model ID</th>
              <th className="text-left font-semibold py-1">Base URL (blank = default)</th>
              <th className="text-left font-semibold py-1">$ / M input</th>
              <th className="text-left font-semibold py-1">$ / M output</th>
              <th className="sr-only">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="py-0.5 pr-1">
                  <input
                    className="cf-input !min-h-0 py-1 text-[11px] w-full"
                    aria-label={`Row ${i + 1} provider`}
                    value={r.providerType}
                    onChange={(e) => update(i, { providerType: e.target.value })}
                  />
                </td>
                <td className="py-0.5 pr-1">
                  <input
                    className="cf-input !min-h-0 py-1 text-[11px] w-full font-mono"
                    aria-label={`Row ${i + 1} model ID`}
                    value={r.model}
                    onChange={(e) => update(i, { model: e.target.value })}
                  />
                </td>
                <td className="py-0.5 pr-1">
                  <input
                    className="cf-input !min-h-0 py-1 text-[11px] w-full font-mono"
                    aria-label={`Row ${i + 1} base URL`}
                    placeholder="(provider default)"
                    value={r.baseUrl}
                    onChange={(e) => update(i, { baseUrl: e.target.value })}
                  />
                </td>
                <td className="py-0.5 pr-1">
                  <input
                    className="cf-input !min-h-0 py-1 text-[11px] w-24"
                    aria-label={`Row ${i + 1} input price per million tokens`}
                    inputMode="decimal"
                    value={r.input}
                    onChange={(e) => update(i, { input: e.target.value })}
                  />
                </td>
                <td className="py-0.5 pr-1">
                  <input
                    className="cf-input !min-h-0 py-1 text-[11px] w-24"
                    aria-label={`Row ${i + 1} output price per million tokens`}
                    inputMode="decimal"
                    value={r.output}
                    onChange={(e) => update(i, { output: e.target.value })}
                  />
                </td>
                <td className="py-0.5">
                  <button
                    type="button"
                    className="text-[11px] text-rose-400 underline"
                    aria-label={`Remove row ${i + 1}`}
                    onClick={() => {
                      setRows((prev) => prev.filter((_, idx) => idx !== i));
                      setSaved(false);
                    }}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {hasErrors && (
        <div role="alert" className="text-[11px] text-rose-400 min-w-0">
          <p className="font-semibold">Fix the following before saving:</p>
          <ul className="list-disc pl-5 space-y-0.5">
            {errors.map((e) => (
              <li key={e} className="break-words">{e}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex gap-2 items-center flex-wrap">
        <Btn
          className="!min-h-0 !py-1.5 text-xs"
          ghost
          onClick={() => {
            setRows((prev) => [
              ...prev,
              { providerType: '', model: '', baseUrl: '', input: '', output: '', source: 'manual', asOf: null },
            ]);
            setSaved(false);
          }}
        >
          Add a model
        </Btn>

        {providerOptions.length > 0 && (
          <>
            <select
              className="cf-input !min-h-0 py-1.5 text-xs"
              aria-label="Provider to prefill reference prices for"
              value={prefillProvider}
              onChange={(e) => setPrefillProvider(e.target.value)}
            >
              {providerOptions.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
            <Btn className="!min-h-0 !py-1.5 text-xs" ghost onClick={prefill}>
              Prefill from reference list
            </Btn>
          </>
        )}

        {saved && <span className="text-xs text-emerald-400">Saved.</span>}
        <Btn className="!min-h-0 !py-1.5 text-xs ml-auto" onClick={() => void save()} disabled={saving || hasErrors}>
          {saving ? 'Saving…' : 'Save pricing'}
        </Btn>
      </div>

      {/* Staleness, stated at the moment of prefill rather than buried. These figures are as
          good as the day someone last checked them, and saying so is the only honest option. */}
      <p className="text-[11px] text-slate-400">
        Campfire’s reference figures were last verified on <strong>{view.referenceAsOf}</strong>. They are a
        starting point, not a quote — vendors change prices without notice, so confirm them against your provider’s
        billing page before relying on the estimates.
        {view.updatedAt && <> Your pricing was last saved {new Date(view.updatedAt).toLocaleDateString()}.</>}
      </p>
    </div>
  );
}
