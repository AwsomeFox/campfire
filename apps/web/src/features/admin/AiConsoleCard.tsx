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
 *
 * i18n (#1579): every literal here now routes through `t()`. Before this pass, all
 * four subcomponents called `useTranslation()` and destructured `t`, but only ever
 * passed it into `translateApiError()` — never called directly — so the card's OWN
 * copy (the card title, section headings, and button labels) stayed hardcoded
 * English while `CostDisclosure`/`AiPricingEditor` next to it were already
 * localized. That mixed state is the bug: a reader in `ar` got some lines in Arabic
 * and some in English on the same card, which reads as broken rather than as
 * "not translated yet". `validateAllowlistDraft` now returns translation keys +
 * params instead of formatted English prose, since it runs outside any component
 * and has no `t` to call.
 */
import { useTranslation, Trans } from 'react-i18next';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AiConsoleOverview, AiProviderHealthEntry } from '@campfire/schema';
import { api, API, ApiError, translateApiError } from '../../lib/api';
import { Card, Btn, TextInput, Skeleton, ErrorNote } from '../../components/ui';
import { ProviderForm } from '../settings/ProviderForm';
import { formatNumber } from '../../lib/format';
import { AiPricingEditor } from './AiPricingEditor';
import { useSaveFeedback } from '../../components/SaveFeedback';

function fmt(n: number): string {
  return formatNumber(n);
}

const ALLOWLIST_MAX_MODELS = 200;
const ALLOWLIST_MAX_MODEL_ID_LENGTH = 120;

/** One allowlist validation finding as a translation KEY + params, never as prose (matches AiPricingEditor's `RowError`). */
interface AllowlistError {
  key: string;
  params: Record<string, string | number>;
}

type AllowlistDraftValidation = {
  allowedModels: string[];
  errors: AllowlistError[];
};

function validateAllowlistDraft(text: string): AllowlistDraftValidation {
  const allowedModels = text
    .split(/[\n,]/)
    .map((value) => value.trim())
    .filter(Boolean);
  const errors: AllowlistError[] = [];
  const firstEntryByModel = new Map<string, number>();

  allowedModels.forEach((model, index) => {
    const entryNumber = index + 1;
    if (model.length > ALLOWLIST_MAX_MODEL_ID_LENGTH) {
      errors.push({
        key: 'admin.aiConsole.allowlist.errEntryLength',
        params: { n: entryNumber, length: model.length, max: ALLOWLIST_MAX_MODEL_ID_LENGTH },
      });
    }
    if (/\s/.test(model)) {
      errors.push({ key: 'admin.aiConsole.allowlist.errWhitespace', params: { n: entryNumber } });
    }

    const firstEntry = firstEntryByModel.get(model);
    if (firstEntry !== undefined) {
      errors.push({ key: 'admin.aiConsole.allowlist.errDuplicate', params: { n: entryNumber, first: firstEntry, model } });
    } else {
      firstEntryByModel.set(model, entryNumber);
    }
  });

  if (allowedModels.length > ALLOWLIST_MAX_MODELS) {
    errors.push({ key: 'admin.aiConsole.allowlist.errTooMany', params: { n: allowedModels.length, max: ALLOWLIST_MAX_MODELS } });
  }

  return { allowedModels, errors };
}

export function AiConsoleCard() {
  const { t } = useTranslation();
  const [ov, setOv] = useState<AiConsoleOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setOv(await api.get<AiConsoleOverview>(`${API}/settings/ai`));
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'admin.errors.loadAiConsole' }));
    }
  }, [t]);

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
      setError(translateApiError(err, t, { fallbackKey: 'admin.errors.toggleKillSwitch' }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-4">
      <div className="flex items-center justify-between border-b border-slate-700 pb-2">
        <h2 className="font-bold text-white text-sm">{t('admin.aiConsole.title')}</h2>
        {ov && (
          <span className={`cf-chip ${ov.killSwitchEnabled ? 'cf-chip-completed' : 'cf-chip-failed'}`}>
            {ov.killSwitchEnabled ? t('admin.aiConsole.statusEnabled') : t('admin.aiConsole.statusPaused')}
          </span>
        )}
      </div>

      {error && <ErrorNote message={error} onRetry={load} />}

      {!ov ? (
        <Skeleton lines={4} />
      ) : (
        <>
          <p className="text-[11px] text-secondary">
            <Trans i18nKey="admin.aiConsole.intro" components={[<strong key="all" />]} />
          </p>

          {/* Kill switch */}
          <div className="cf-inset p-3.5 flex items-center justify-between gap-3 flex-wrap">
            <div>
              <p className="text-sm font-semibold text-white">{t('admin.aiConsole.killSwitch.heading')}</p>
              <p className="text-[11px] text-secondary">
                {ov.killSwitchEnabled
                  ? t('admin.aiConsole.killSwitch.enabledBody')
                  : t('admin.aiConsole.killSwitch.pausedBody')}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={ov.killSwitchEnabled}
              onClick={toggleKill}
              disabled={busy}
              className={`cf-btn cf-density-compact text-xs ${ov.killSwitchEnabled ? '' : '!bg-rose-600 !border-rose-500'}`}
            >
              {ov.killSwitchEnabled ? t('admin.aiConsole.killSwitch.onButton') : t('admin.aiConsole.killSwitch.offButton')}
            </button>
          </div>

          {/* Usage totals */}
          <UsageSummary ov={ov} />

          {/* Budgets & caps */}
          <CapsEditor ov={ov} onSaved={setOv} />

          {/* Default AI provider + write-only key (issue #399) — the fallback every campaign inherits. */}
          <ProviderDefaultSection ov={ov} onChanged={load} />

          {/* Model allowlist — kept next to the provider it constrains. */}
          <AllowlistEditor ov={ov} onSaved={setOv} />
          {/* #1065 — model pricing sits next to the allowlist: both are admin-owned facts
              about models that every campaign resolves against. */}
          <AiPricingEditor onError={setError} />

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
  const { t } = useTranslation();
  const u = ov.usage;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      <Stat label={t('admin.aiConsole.usage.tokensUsed')} value={fmt(u.totalTokensUsed)} />
      <Stat label={t('admin.aiConsole.usage.turns')} value={fmt(u.totalTurns)} />
      <Stat label={t('admin.aiConsole.usage.activeSeats')} value={`${u.activeSeatCount} / ${u.seatCount}`} />
      <Stat
        label={t('admin.aiConsole.usage.serverCap')}
        value={
          u.serverTokenCap > 0
            ? t('admin.aiConsole.usage.leftSuffix', { n: fmt(u.serverBudgetRemaining ?? 0) })
            : t('admin.aiConsole.usage.unlimited')
        }
        sub={u.serverTokenCap > 0 ? t('admin.aiConsole.usage.ofTotal', { n: fmt(u.serverTokenCap) }) : undefined}
      />
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="cf-inset p-3">
      <p className="text-[10px] uppercase tracking-widest text-secondary font-bold">{label}</p>
      <p className="text-lg font-extrabold text-white leading-tight">{value}</p>
      {sub && <p className="text-[10px] text-secondary">{sub}</p>}
    </div>
  );
}

function CapsEditor({
  ov,
  onSaved,
}: {
  ov: AiConsoleOverview;
  onSaved: (o: AiConsoleOverview) => void;
}) {
  const { t } = useTranslation();
  const [cap, setCap] = useState(String(ov.serverTokenCap));
  const feedback = useSaveFeedback(t('admin.aiConsole.caps.feedbackSubject'));
  const saving = feedback.state === 'saving';

  useEffect(() => {
    setCap(String(ov.serverTokenCap));
  }, [ov.serverTokenCap]);

  async function save() {
    const n = Math.max(0, Math.floor(Number(cap) || 0));
    if (saving) return;
    feedback.begin();
    try {
      onSaved(await api.put<AiConsoleOverview>(`${API}/settings/ai/caps`, { serverTokenCap: n }));
      feedback.succeed();
    } catch (err) {
      feedback.fail(translateApiError(err, t, { fallbackKey: 'admin.errors.saveCap' }), {
        generic: !(err instanceof ApiError) || (!err.code && !err.message),
      });
    }
  }

  return (
    <div className="cf-inset p-3.5 space-y-2">
      <p className="text-[10px] font-bold text-amber-500 uppercase tracking-widest">{t('admin.aiConsole.caps.heading')}</p>
      <p className="text-[11px] text-secondary">
        <Trans i18nKey="admin.aiConsole.caps.body" components={[<strong key="hard" />]} />
      </p>
      <div className="flex items-end gap-2 flex-wrap">
        <label className="block">
          <span className="text-[10px] uppercase tracking-widest text-secondary font-bold">{t('admin.aiConsole.caps.label')}</span>
          <TextInput density="compact"
            className="text-sm mt-1 w-40"
            type="number"
            min={0}
            value={cap}
            aria-describedby={feedback.statusId}
            disabled={saving}
            onChange={(e) => { const value = e.target.value; setCap(value); feedback.syncDirty(value !== String(ov.serverTokenCap)); }}
          />
        </label>
        {feedback.announcement}
        <Btn density="compact" className="text-xs mb-0.5" onClick={save} disabled={saving}>
          {saving ? t('common.saving') : t('admin.aiConsole.caps.save')}
        </Btn>
      </div>
    </div>
  );
}

function ProviderDefaultSection({ ov, onChanged }: { ov: AiConsoleOverview; onChanged: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="cf-inset p-3.5 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-[10px] font-bold text-amber-500 uppercase tracking-widest">{t('admin.aiConsole.providerDefault.heading')}</p>
        <span className={`cf-chip ${ov.serverProviderReady ? 'cf-chip-completed' : 'cf-chip-private'}`}>
          {ov.serverProviderConfigured
            ? `${ov.serverProviderReady ? t('admin.aiConsole.providerDefault.ready') : t('admin.aiConsole.providerDefault.credentialMissing')}${ov.serverProviderType ? ` · ${ov.serverProviderType}` : ''}`
            : t('admin.aiConsole.providerDefault.notSet')}
        </span>
      </div>
      <p className="text-[11px] text-secondary">
        <Trans i18nKey="admin.aiConsole.providerDefault.body" components={[<strong key="wo" />]} />
      </p>
      <ProviderForm basePath="/settings/ai-provider" scope="server" onChanged={onChanged} />
    </div>
  );
}

function AllowlistEditor({
  ov,
  onSaved,
}: {
  ov: AiConsoleOverview;
  onSaved: (o: AiConsoleOverview) => void;
}) {
  const { t } = useTranslation();
  const savedText = ov.allowedModels.join('\n');
  const [text, setText] = useState(savedText);
  const feedback = useSaveFeedback(t('admin.aiConsole.allowlist.feedbackSubject'));
  const saving = feedback.state === 'saving';
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
    if (saving) return;
    feedback.begin();
    try {
      onSaved(
        await api.put<AiConsoleOverview>(`${API}/settings/ai/allowlist`, {
          allowedModels: validation.allowedModels,
        }),
      );
      feedback.succeed();
    } catch (err) {
      feedback.fail(translateApiError(err, t, { fallbackKey: 'admin.errors.saveAllowlist' }), {
        generic: !(err instanceof ApiError) || (!err.code && !err.message),
      });
    }
  }

  return (
    <div className="cf-inset p-3.5 space-y-2 min-w-0" data-testid="ai-model-allowlist">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-[10px] font-bold text-amber-500 uppercase tracking-widest">{t('admin.aiConsole.allowlist.heading')}</p>
        <p
          id={effectiveStateId}
          role="status"
          aria-live="polite"
          aria-label={t('admin.aiConsole.allowlist.effectiveAriaLabel')}
          className="text-[11px] text-slate-400"
        >
          <span className="font-semibold text-slate-300">{t('admin.aiConsole.allowlist.effectiveLabel')}</span>{' '}
          {ov.allowedModels.length === 0
            ? t('admin.aiConsole.allowlist.unrestricted')
            : ov.allowedModels.length === 1
              ? t('admin.aiConsole.allowlist.restrictedOne')
              : t('admin.aiConsole.allowlist.restrictedSome', { n: ov.allowedModels.length })}
        </p>
      </div>
      <p className="text-[11px] text-slate-400">
        {t('admin.aiConsole.allowlist.body')}
      </p>
      <label htmlFor={inputId} className="block text-[10px] uppercase tracking-widest text-slate-400 font-bold">
        {t('admin.aiConsole.allowlist.inputLabel')}
      </label>
      <p id={helpId} className="text-[11px] text-slate-400">
        {t('admin.aiConsole.allowlist.help')}
      </p>
      <textarea
        id={inputId}
        className="cf-input py-2 text-sm w-full max-w-full font-mono cf-density-compact"
        rows={3}
        placeholder="gpt-4o-mini&#10;claude-3-5-haiku"
        value={text}
        disabled={saving}
        aria-describedby={`${helpId}${hasErrors ? ` ${errorId}` : ''} ${feedback.statusId}`}
        aria-invalid={hasErrors}
        aria-errormessage={hasErrors ? errorId : undefined}
        onChange={(e) => {
          setText(e.target.value);
          feedback.syncDirty(e.target.value !== savedText);
        }}
      />
      {hasErrors && (
        <div id={errorId} role="alert" className="text-[11px] text-rose-400 min-w-0">
          <p className="font-semibold">{t('admin.aiConsole.allowlist.fixErrors')}</p>
          <ul className="list-disc pl-5 space-y-0.5">
            {validation.errors.map((validationError, i) => (
              <li key={`${validationError.key}:${i}`} className="break-words">
                {t(validationError.key, validationError.params)}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex gap-2 justify-end items-center flex-wrap">
        {feedback.announcement}
        <Btn density="compact" className="text-xs" onClick={save} disabled={saving || hasErrors}>
          {saving ? t('common.saving') : t('admin.aiConsole.allowlist.save')}
        </Btn>
      </div>
    </div>
  );
}

function CampaignUsageTable({ ov }: { ov: AiConsoleOverview }) {
  const { t } = useTranslation();
  const rows = ov.usage.byCampaign;
  if (rows.length === 0) {
    return (
      <p className="text-[11px] text-secondary">
        {t('admin.aiConsole.usageTable.empty')}
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{t('admin.aiConsole.usageTable.heading')}</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[10px] uppercase text-secondary text-left">
              <th className="py-2 pr-4 font-bold">{t('admin.aiConsole.usageTable.colCampaign')}</th>
              <th className="pr-4 font-bold">{t('admin.aiConsole.usageTable.colModel')}</th>
              <th className="pr-4 font-bold">{t('admin.aiConsole.usageTable.colSeat')}</th>
              <th className="pr-4 font-bold text-right">{t('admin.aiConsole.usageTable.colUsedBudget')}</th>
              <th className="pr-4 font-bold text-right">{t('admin.aiConsole.usageTable.colTurns')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {rows.map((r) => {
              const committed = r.tokensUsed + r.tokensReserved + r.tokensUnknown;
              const over = r.tokenBudget > 0 && committed >= r.tokenBudget;
              return (
                <tr key={r.campaignId}>
                  <td className="py-2 pr-4 font-semibold text-white">{r.campaignName}</td>
                  <td className="pr-4 text-slate-400">{r.model || <span className="text-secondary">—</span>}</td>
                  <td className="pr-4">
                    <span className={`cf-chip ${r.enabled ? 'cf-chip-completed' : 'cf-chip-private'}`}>
                      {r.enabled ? t('admin.aiConsole.usageTable.seatOn') : t('admin.aiConsole.usageTable.seatOff')}
                    </span>
                  </td>
                  <td className={`pr-4 text-right ${over ? 'text-rose-400' : 'text-slate-300'}`}>
                    <div>{fmt(r.tokensUsed)} / {r.tokenBudget > 0 ? fmt(r.tokenBudget) : '∞'}</div>
                    {(r.tokensReserved > 0 || r.tokensUnknown > 0 || r.tokensOverage > 0) && (
                      <div className="text-[10px] text-secondary">
                        {r.tokensReserved > 0 ? t('admin.aiConsole.usageTable.reservedSuffix', { n: fmt(r.tokensReserved) }) : ''}
                        {r.tokensReserved > 0 && (r.tokensUnknown > 0 || r.tokensOverage > 0) ? ' · ' : ''}
                        {r.tokensUnknown > 0 ? t('admin.aiConsole.usageTable.unknownSuffix', { n: fmt(r.tokensUnknown) }) : ''}
                        {r.tokensUnknown > 0 && r.tokensOverage > 0 ? ' · ' : ''}
                        {r.tokensOverage > 0 ? t('admin.aiConsole.usageTable.overageSuffix', { n: fmt(r.tokensOverage) }) : ''}
                      </div>
                    )}
                  </td>
                  <td className="pr-4 text-right text-slate-400">{fmt(r.turnCount)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {ov.usage.byModel.length > 0 && (
        <p className="text-[11px] text-secondary">
          {t('admin.aiConsole.usageTable.byModel')}{' '}
          {ov.usage.byModel.map((m, i) => (
            <span key={m.model || `_${i}`}>
              {i > 0 && ' · '}
              <span className="text-slate-300">{m.model || t('admin.aiConsole.usageTable.unsetModel')}</span> {t('admin.aiConsole.usageTable.tokensSuffix', { n: fmt(m.tokensUsed) })}
            </span>
          ))}
        </p>
      )}
      <p className="text-[11px] text-secondary">
        {t('admin.aiConsole.usageTable.footnote')}
      </p>
    </div>
  );
}

function HealthPanel({ onError }: { onError: (msg: string | null) => void }) {
  const { t } = useTranslation();
  const [results, setResults] = useState<AiProviderHealthEntry[] | null>(null);
  const [testing, setTesting] = useState(false);

  async function testAll() {
    setTesting(true);
    onError(null);
    try {
      setResults(await api.post<AiProviderHealthEntry[]>(`${API}/settings/ai/health`));
    } catch (err) {
      onError(translateApiError(err, t, { fallbackKey: 'admin.errors.runHealthCheck' }));
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="cf-inset p-3.5 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-bold text-amber-500 uppercase tracking-widest">{t('admin.aiConsole.health.heading')}</p>
        <Btn density="compact" ghost className="text-xs" onClick={testAll} disabled={testing}>
          {testing ? t('admin.aiConsole.health.testing') : t('admin.aiConsole.health.testAll')}
        </Btn>
      </div>
      {results && results.length === 0 && (
        <p className="text-[11px] text-secondary">{t('admin.aiConsole.health.none')}</p>
      )}
      {results && results.length > 0 && (
        <ul className="space-y-1">
          {results.map((r, i) => (
            <li key={`${r.scope}-${r.campaignId ?? 'server'}-${i}`} className="text-[11px] flex items-center gap-2">
              <span className={r.ok ? 'text-emerald-400' : 'text-rose-400'}>{r.ok ? '✓' : '✗'}</span>
              <span className="text-slate-300">
                {r.scope === 'server' ? t('admin.aiConsole.health.serverDefault') : r.campaignName}
              </span>
              <span className="text-secondary">·</span>
              <span className="text-secondary">
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
