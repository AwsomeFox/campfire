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
import { useTranslation } from 'react-i18next';
import { AI_PRICING_MAX_ENTRIES, aiPricingDuplicateIndices, type AiPricingView } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { Btn } from '../../components/ui';
import { formatDate } from '../../lib/format';

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

/**
 * Validation findings as translation KEYS plus params, never as prose.
 *
 * The messages are built at the render site so they localize; returning English here would put
 * user-facing strings in a pure function where no `t` exists, which is how untranslated copy
 * usually gets in.
 */
interface RowError {
  key: string;
  params: Record<string, string | number>;
}

/** A row is saveable when it names a model and both prices parse as non-negative numbers. */
function rowErrors(rows: Row[]): RowError[] {
  const errors: RowError[] = [];
  rows.forEach((r, i) => {
    const n = i + 1;
    if (!r.providerType.trim()) errors.push({ key: 'admin.pricing.errProvider', params: { n } });
    if (!r.model.trim()) errors.push({ key: 'admin.pricing.errModel', params: { n } });
    for (const [field, raw] of [['fieldInput', r.input], ['fieldOutput', r.output]] as const) {
      const v = Number(raw);
      if (raw.trim() === '' || !Number.isFinite(v) || v < 0) {
        errors.push({ key: 'admin.pricing.errPrice', params: { n, field } });
      }
    }
  });
  // Duplicate detection comes from the SCHEMA, so the check that blocks Save here and the
  // one the server enforces on write are the same function, not two implementations that
  // agree until someone edits one. It also skips rows whose key fields are still blank:
  // pressing "Add model" twice used to collapse two empty rows to the same key and stack a
  // phantom duplicate error on top of the required-field errors already being shown.
  for (const index of aiPricingDuplicateIndices(rows)) {
    errors.push({ key: 'admin.pricing.errDuplicate', params: { n: index + 1 } });
  }
  // The server caps the list at the same number. Enforced here too so an admin hits the
  // limit while adding a row rather than after typing out a table the save will reject.
  if (rows.length > AI_PRICING_MAX_ENTRIES) {
    errors.push({ key: 'admin.pricing.errTooMany', params: { max: AI_PRICING_MAX_ENTRIES } });
  }
  return errors;
}

export function AiPricingEditor({ onError }: { onError: (msg: string | null) => void }) {
  const { t } = useTranslation();
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
    // Touching a row makes it the admin's own figure, so the provenance pair moves TOGETHER:
    // `source` back to 'manual' AND `asOf` cleared. `asOf` dates the reference list a row was
    // prefilled from; once the admin has edited the row it dates nothing, and leaving it
    // behind put a verification date on a number that list never contained — staleness
    // signalling in reverse, which is worse than none.
    setRows((prev) =>
      prev.map((r, idx) => (idx === i ? { ...r, ...patch, source: 'manual', asOf: null } : r)),
    );
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
    // Clamped to the same ceiling the server enforces — prefill is the one action that can
    // add many rows at once, so it is the one that could walk an admin past the cap.
    const room = AI_PRICING_MAX_ENTRIES - rows.length;
    if (additions.length === 0 || room <= 0) return;
    setRows((prev) => [...prev, ...additions.slice(0, room)]);
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
      onError(err instanceof ApiError && err.message ? err.message : t('admin.pricing.saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  if (!view) return null;

  return (
    <div className="cf-inset p-3.5 space-y-2 min-w-0" data-testid="ai-model-pricing">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-[10px] font-bold text-amber-500 uppercase tracking-widest">{t('admin.pricing.heading')}</p>
        <p role="status" aria-live="polite" className="text-[11px] text-slate-400">
          <span className="font-semibold text-slate-300">{t('admin.pricing.effectiveLabel')}</span>{' '}
          {/* Deliberately not i18next's `count` plural machinery: Arabic has six plural
              categories, and a catalog missing one of them renders the raw key. Two explicit
              keys say the same thing and cannot fail that way. */}
          {rows.length === 0
            ? t('admin.pricing.effectiveNone')
            : rows.length === 1
              ? t('admin.pricing.effectiveOne')
              : t('admin.pricing.effectiveSome', { n: rows.length })}
        </p>
      </div>
      <p className="text-[11px] text-slate-400">{t('admin.pricing.intro')}</p>
      <p className="text-[11px] text-slate-400">{t('admin.pricing.endpointNote')}</p>

      {/*
        `relative` is load-bearing, not decoration. The Actions column header below is an
        `sr-only` cell, and `sr-only` is `position: absolute`. A scroll container only clips
        descendants it is a CONTAINING BLOCK for, so with no positioned ancestor that cell
        resolved against the initial containing block, escaped the scroll box, and pushed the
        whole PAGE out to its own right edge — 689px at the 320px viewport of a 400% zoom,
        breaking reflow for every panel on the admin AI screen, not just this table. The
        table's own 640px minimum was never the problem: it scrolls inside this box correctly
        either way. Positioning this element puts the hidden cell back under the scroll
        container's clip, which is where the rest of the table already was.
      */}
      <div className="relative overflow-x-auto">
        <table className="w-full text-[11px] min-w-[640px]">
          <thead className="text-slate-400">
            <tr>
              <th className="text-left font-semibold py-1">{t('admin.pricing.colProvider')}</th>
              <th className="text-left font-semibold py-1">{t('admin.pricing.colModel')}</th>
              <th className="text-left font-semibold py-1">{t('admin.pricing.colBaseUrl')}</th>
              <th className="text-left font-semibold py-1">{t('admin.pricing.colInput')}</th>
              <th className="text-left font-semibold py-1">{t('admin.pricing.colOutput')}</th>
              <th className="sr-only">{t('admin.pricing.colActions')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="py-0.5 pr-1">
                  <input
                    className="cf-input py-1 text-[11px] w-full cf-density-xs"
                    aria-label={t('admin.pricing.rowProvider', { n: i + 1 })}
                    value={r.providerType}
                    onChange={(e) => update(i, { providerType: e.target.value })}
                  />
                </td>
                <td className="py-0.5 pr-1">
                  <input
                    className="cf-input py-1 text-[11px] w-full font-mono cf-density-xs"
                    aria-label={t('admin.pricing.rowModel', { n: i + 1 })}
                    value={r.model}
                    onChange={(e) => update(i, { model: e.target.value })}
                  />
                </td>
                <td className="py-0.5 pr-1">
                  <input
                    className="cf-input py-1 text-[11px] w-full font-mono cf-density-xs"
                    aria-label={t('admin.pricing.rowBaseUrl', { n: i + 1 })}
                    placeholder={t('admin.pricing.baseUrlPlaceholder')}
                    value={r.baseUrl}
                    onChange={(e) => update(i, { baseUrl: e.target.value })}
                  />
                </td>
                <td className="py-0.5 pr-1">
                  <input
                    className="cf-input py-1 text-[11px] w-24 cf-density-xs"
                    aria-label={t('admin.pricing.rowInput', { n: i + 1 })}
                    inputMode="decimal"
                    value={r.input}
                    onChange={(e) => update(i, { input: e.target.value })}
                  />
                </td>
                <td className="py-0.5 pr-1">
                  <input
                    className="cf-input py-1 text-[11px] w-24 cf-density-xs"
                    aria-label={t('admin.pricing.rowOutput', { n: i + 1 })}
                    inputMode="decimal"
                    value={r.output}
                    onChange={(e) => update(i, { output: e.target.value })}
                  />
                </td>
                <td className="py-0.5">
                  <button
                    type="button"
                    className="text-[11px] text-rose-400 underline"
                    aria-label={t('admin.pricing.rowRemove', { n: i + 1 })}
                    onClick={() => {
                      setRows((prev) => prev.filter((_, idx) => idx !== i));
                      setSaved(false);
                    }}
                  >
                    {t('admin.pricing.remove')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {hasErrors && (
        <div role="alert" className="text-[11px] text-rose-400 min-w-0">
          <p className="font-semibold">{t('admin.pricing.fixErrors')}</p>
          <ul className="list-disc pl-5 space-y-0.5">
            {errors.map((e) => (
              <li key={`${e.key}:${JSON.stringify(e.params)}`} className="break-words">
                {t(e.key, { ...e.params, field: e.params.field ? t(`admin.pricing.${e.params.field}`) : undefined })}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex gap-2 items-center flex-wrap">
        <Btn density="xs"
          className="text-xs"
          ghost
          disabled={rows.length >= AI_PRICING_MAX_ENTRIES}
          onClick={() => {
            setRows((prev) => [
              ...prev,
              { providerType: '', model: '', baseUrl: '', input: '', output: '', source: 'manual', asOf: null },
            ]);
            setSaved(false);
          }}
        >
          {t('admin.pricing.addModel')}
        </Btn>

        {providerOptions.length > 0 && (
          <>
            <select
              className="cf-input py-1.5 text-xs cf-density-xs"
              aria-label={t('admin.pricing.prefillLabel')}
              value={prefillProvider}
              onChange={(e) => setPrefillProvider(e.target.value)}
            >
              {providerOptions.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
            <Btn density="xs" className="text-xs" ghost onClick={prefill}>
              {t('admin.pricing.prefill')}
            </Btn>
          </>
        )}

        {saved && <span className="text-xs text-emerald-400">{t('admin.pricing.saved')}</span>}
        <Btn density="xs" className="text-xs ml-auto" onClick={() => void save()} disabled={saving || hasErrors}>
          {saving ? t('admin.pricing.saving') : t('admin.pricing.save')}
        </Btn>
      </div>

      {/* Staleness, stated at the moment of prefill rather than buried. These figures are as
          good as the day someone last checked them, and saying so is the only honest option. */}
      <p className="text-[11px] text-slate-400">
        {t('admin.pricing.referenceAsOf', { date: view.referenceAsOf })}
        {view.updatedAt && <> {t('admin.pricing.lastSaved', { date: formatDate(view.updatedAt) })}</>}
      </p>
    </div>
  );
}
