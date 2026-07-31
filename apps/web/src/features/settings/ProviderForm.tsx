/**
 * Shared AI provider + write-only API-key form (issue #399).
 *
 * ONE form drives both scopes, parameterized by endpoint `basePath` + `scope`:
 *   - server default  → basePath="/settings/ai-provider"       (admin AI console)
 *   - campaign override → basePath="/campaigns/:id/ai-provider" (campaign AI settings)
 *
 * Both scopes speak the identical REST shape (GET redacted view · PUT write ·
 * DELETE · POST /test), so the whole load/save/test/remove flow lives here once
 * instead of being duplicated. The API key is WRITE-ONLY: a stored key shows only as
 * "configured" + its last 4 chars; the input is blank-keeps / value-sets-or-rotates,
 * and the plaintext is never retained in state after a save.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AI_EXTERNAL_PROVIDER_PRIVACY,
  type AiProviderConfigType,
  type AiProviderConfigView,
  type AiProviderTestRequest,
  type AiProviderTestResult,
} from '@campfire/schema';
import { api, ApiError, API } from '../../lib/api';
import { AiProviderPrivacyNotice } from '../../components/AiProviderPrivacyNotice';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { formatDateTime } from '../../lib/format';
import { SkeletonConditionalRegion } from '../../components/ui';
import { useSaveFeedback } from '../../components/SaveFeedback';

const PROVIDER_TYPES: AiProviderConfigType[] = ['openai', 'anthropic', 'gemini', 'mock'];

interface ProviderDraft {
  providerType: AiProviderConfigType;
  model: string;
  baseUrl: string;
  apiKey: string;
}

function isProviderDraftDirty(provider: AiProviderConfigView | null, draft: ProviderDraft): boolean {
  return draft.providerType !== (provider?.providerType ?? 'openai') ||
    draft.model !== (provider?.model ?? '') ||
    draft.baseUrl !== (provider?.baseUrl ?? '') ||
    // API keys are write-only: any non-blank value represents an unsaved rotation.
    draft.apiKey !== '';
}

/**
 * A local-only fingerprint used to bind an async result to the exact draft
 * revision that launched it. The write-only key is represented only as
 * blank/present plus the revision nonce — plaintext is never copied into the
 * fingerprint, rendered, logged, or returned by the API.
 */
function draftFingerprint(scope: 'server' | 'campaign', basePath: string, draft: ProviderDraft, revision: number): string {
  return JSON.stringify([
    scope,
    basePath,
    draft.providerType,
    draft.model,
    draft.baseUrl,
    draft.apiKey === '' ? 'key:blank' : 'key:present',
    revision,
  ]);
}

export function ProviderForm({
  basePath,
  scope,
  onChanged,
}: {
  /** Endpoint root WITHOUT the API prefix, e.g. `/settings/ai-provider` or `/campaigns/7/ai-provider`. */
  basePath: string;
  scope: 'server' | 'campaign';
  /** Notified after any successful save/remove so a parent can refresh its status line. */
  onChanged?: (view: AiProviderConfigView | null) => void;
}) {
  const [provider, setProvider] = useState<AiProviderConfigView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { t } = useTranslation();

  const [providerType, setProviderType] = useState<AiProviderConfigType>('openai');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState(''); // write-only; blank keeps the stored key
  const feedback = useSaveFeedback(t(`settings.providerForm.feedbackSubject.${scope}`));
  const saving = feedback.state === 'saving';
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<AiProviderTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const draftRevision = useRef(0);
  const currentDraftFingerprint = useRef('');
  const [removing, setRemoving] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  // Remove/clear are not saves — keep their copy off the shared save-feedback vocabulary.
  const [actionNotice, setActionNotice] = useState<{ role: 'status' | 'alert'; text: string } | null>(null);

  function hydrate(p: AiProviderConfigView | null) {
    const nextDraft: ProviderDraft = {
      providerType: p?.providerType ?? 'openai',
      model: p?.model ?? '',
      baseUrl: p?.baseUrl ?? '',
      apiKey: '',
    };
    draftRevision.current += 1;
    currentDraftFingerprint.current = draftFingerprint(scope, basePath, nextDraft, draftRevision.current);
    setProvider(p);
    setProviderType(nextDraft.providerType);
    setModel(nextDraft.model);
    setBaseUrl(nextDraft.baseUrl);
    setApiKey(nextDraft.apiKey);
    setTestResult(null);
    setTestError(null);
    setTesting(false);
  }

  function editDraft(field: keyof ProviderDraft, value: string) {
    const nextDraft: ProviderDraft = { providerType, model, baseUrl, apiKey, [field]: value } as ProviderDraft;
    draftRevision.current += 1;
    currentDraftFingerprint.current = draftFingerprint(scope, basePath, nextDraft, draftRevision.current);
    setTestResult(null);
    setTestError(null);
    setTesting(false);
    setActionNotice(null);
    feedback.syncDirty(isProviderDraftDirty(provider, nextDraft));
    if (field === 'providerType') setProviderType(value as AiProviderConfigType);
    else if (field === 'model') setModel(value);
    else if (field === 'baseUrl') setBaseUrl(value);
    else setApiKey(value);
  }

  function currentDraft(): ProviderDraft {
    return { providerType, model, baseUrl, apiKey };
  }

  function syncCurrentDraftFeedback() {
    feedback.syncDirty(isProviderDraftDirty(provider, currentDraft()));
  }

  function invalidateTestForAction() {
    draftRevision.current += 1;
    currentDraftFingerprint.current = draftFingerprint(
      scope,
      basePath,
      { providerType, model, baseUrl, apiKey },
      draftRevision.current,
    );
    setTestResult(null);
    setTestError(null);
    setTesting(false);
  }

  useEffect(() => {
    let alive = true;
    draftRevision.current += 1;
    currentDraftFingerprint.current = `scope-change:${scope}:${basePath}:${draftRevision.current}`;
    setTestResult(null);
    setTestError(null);
    setTesting(false);
    setLoading(true);
    setLoadError(null);
    api
      .get<AiProviderConfigView | null>(`${API}${basePath}`)
      .then((p) => {
        if (alive) hydrate(p);
      })
      .catch((err) => {
        if (alive) setLoadError(err instanceof ApiError ? err.message : "Couldn't load the provider.");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basePath, scope]);

  async function save() {
    if (!model.trim()) {
      setActionNotice(null);
      feedback.fail('A model is required.');
      return;
    }
    invalidateTestForAction();
    if (saving) return;
    setActionNotice(null);
    feedback.begin();
    try {
      const body: Record<string, unknown> = { providerType, model: model.trim() };
      if (baseUrl.trim()) body.baseUrl = baseUrl.trim();
      // Only send apiKey when one was typed — an omitted key keeps the stored value.
      if (apiKey !== '') body.apiKey = apiKey;
      const updated = await api.put<AiProviderConfigView>(`${API}${basePath}`, body);
      hydrate(updated); // also drops the plaintext key and fingerprints the saved draft
      onChanged?.(updated);
      feedback.succeed();
    } catch (err) {
      if (err instanceof ApiError) {
        feedback.fail(err.message);
      } else {
        feedback.fail("Couldn't save the provider.", { generic: true });
      }
    }
  }

  async function test() {
    if (!model.trim()) {
      invalidateTestForAction();
      // Non-mutating validation — do not claim a save failed.
      setActionNotice({ role: 'alert', text: 'A model is required to test the connection.' });
      feedback.syncDirty(isProviderDraftDirty(provider, { providerType, model, baseUrl, apiKey }));
      return;
    }
    const body: AiProviderTestRequest = {
      providerType,
      model: model.trim(),
      // Sending '' makes the blank-key reuse/inheritance semantics explicit.
      apiKey,
      ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
    };
    const fingerprint = currentDraftFingerprint.current;
    setTesting(true);
    setTestResult(null);
    setTestError(null);
    setActionNotice(null);
    // Test connection is non-mutating — keep/recompute dirty so unsaved drafts
    // do not look idle/discarded while the probe runs.
    feedback.syncDirty(isProviderDraftDirty(provider, { providerType, model, baseUrl, apiKey }));
    try {
      const r = await api.post<AiProviderTestResult>(`${API}${basePath}/test`, body);
      if (currentDraftFingerprint.current === fingerprint) setTestResult(r);
    } catch (err) {
      if (currentDraftFingerprint.current === fingerprint) {
        setTestError(err instanceof ApiError ? err.message : 'Test failed.');
      }
    } finally {
      if (currentDraftFingerprint.current === fingerprint) setTesting(false);
    }
  }

  async function fetchModels() {
    setFetchingModels(true);
    setModelsError(null);
    setAvailableModels([]);
    try {
      const result = await api.post<{ models: string[] }>(`${API}${basePath}/models`, {
        providerType,
        model: model || 'placeholder',
        ...(baseUrl ? { baseUrl } : {}),
        ...(apiKey ? { apiKey } : {}),
      });
      setAvailableModels(result.models ?? []);
      if ((result.models ?? []).length === 0) setModelsError('No models returned by the provider.');
    } catch (err) {
      setModelsError(err instanceof ApiError ? err.message : "Couldn't fetch models.");
    } finally {
      setFetchingModels(false);
    }
  }

  async function remove() {
    invalidateTestForAction();
    setRemoving(true);
    setActionNotice(null);
    feedback.reset();
    try {
      await api.delete(`${API}${basePath}`);
      hydrate(null);
      onChanged?.(null);
      setActionNotice({
        role: 'status',
        text: `${scope === 'server' ? 'Server' : 'Campaign'} AI provider removed.`,
      });
    } catch (err) {
      setActionNotice({
        role: 'alert',
        text: err instanceof ApiError ? err.message : "Couldn't remove the provider.",
      });
      syncCurrentDraftFeedback();
    } finally {
      setRemoving(false);
    }
  }

  async function clearStoredKey() {
    invalidateTestForAction();
    setClearing(true);
    setActionNotice(null);
    feedback.reset();
    try {
      const updated = await api.delete<AiProviderConfigView>(`${API}${basePath}/key`);
      setProvider(updated);
      editDraft('apiKey', '');
      setConfirmClear(false);
      onChanged?.(updated);
      setActionNotice({ role: 'status', text: 'Stored API key cleared.' });
    } catch (err) {
      setActionNotice({
        role: 'alert',
        text: err instanceof ApiError ? err.message : "Couldn't clear the stored key.",
      });
      syncCurrentDraftFeedback();
    } finally {
      setClearing(false);
    }
  }

  if (loading) {
    return <SkeletonConditionalRegion preset="provider-form" />;
  }
  if (loadError) {
    return <p className="text-sm" style={{ color: '#f87171' }}>{loadError}</p>;
  }

  const hint =
    scope === 'server'
      ? provider?.configured
        ? `A key is stored for the server default (ends ••${provider.keyLast4 ?? '????'}). Leave the key blank to keep it, or enter a new one to rotate. Every campaign falls back to this unless it sets its own override.`
        : provider?.credentialSource === 'environment'
          ? 'No encrypted key is stored. The matching environment credential is ready; entering a key here will override it.'
          : 'No server-default key stored yet. Set one here so every campaign can use AI without configuring their own.'
      : provider?.configured
        ? `A key is stored for this campaign (ends ••${provider.keyLast4 ?? '????'}). Leave the key blank to keep it, or enter a new one to rotate.`
        : provider?.ready
          ? 'No campaign key is stored. This override is ready through its server or environment fallback.'
          : 'No campaign key stored — this override will use a server default when one is ready. Most tables leave this blank.';

  const credentialLabel: Record<AiProviderConfigView['credentialSource'], string> = {
    stored: 'Stored encrypted key',
    environment: 'Environment credential',
    server: 'Server-default credential',
    'not-required': 'No credential required',
    none: 'No credential available',
  };

  const testedCredentialLabel: Record<AiProviderTestResult['credentialSource'], string> = {
    candidate: 'Unsaved candidate key',
    stored: 'Stored key for this scope',
    environment: 'Environment credential',
    server: 'Stored server-default credential',
    'not-required': 'No credential required',
    none: 'No credential available',
  };
  const testedScopeLabel: Record<AiProviderTestResult['testedTarget'], string> = {
    'server-default': 'Server default draft',
    'campaign-override': 'Campaign override draft',
    'inherited-server-default': 'Campaign draft using the inherited server default',
  };

  return (
    <>
      <div className="flex flex-col gap-2" data-testid={`ai-provider-form-${scope}`}>
        <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>
          Review the{' '}
          <a href={`#${AI_EXTERNAL_PROVIDER_PRIVACY.settingsAnchorId}`} className="text-muted" style={{ textDecoration: 'underline' }}>
            AI privacy notice
          </a>{' '}
          below before saving — it lists what campaign context leaves your server when this provider is enabled.
        </p>
        <AiProviderPrivacyNotice />
        <div className="flex gap-2 items-center flex-wrap" aria-live="polite">
          <span className={`tag ${provider?.ready ? 'tag-accent' : 'tag-neutral'}`} style={{ fontSize: 10 }}>
            {provider?.ready ? 'Ready' : 'Not ready'}
          </span>
          <span className="text-muted" style={{ fontSize: 11.5 }}>
            Credential: {provider ? credentialLabel[provider.credentialSource] : 'provider not configured'}
          </span>
        </div>
        <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>{hint}</p>
        <div className="flex gap-2 flex-wrap">
          <div className="field" style={{ maxWidth: 160 }}>
            <label htmlFor={`ai-provider-type-${scope}`}>Provider</label>
            <select
              id={`ai-provider-type-${scope}`}
              className="input"
              value={providerType}
              disabled={saving || clearing || removing}
              aria-describedby={feedback.statusId}
              onChange={(e) => editDraft('providerType', e.target.value)}
            >
              {PROVIDER_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: 1, minWidth: 160 }}>
            <label htmlFor={`ai-provider-model-${scope}`}>Model</label>
            <div className="flex gap-1">
              <input
                id={`ai-provider-model-${scope}`}
                className="input"
                value={model}
                aria-describedby={feedback.statusId}
                disabled={saving || clearing || removing}
                onChange={(e) => editDraft('model', e.target.value)}
                placeholder="e.g. gpt-4o-mini"
                list={`ai-provider-models-${scope}`}
                style={{ flex: 1 }}
              />
              <button
                type="button"
                className="btn btn-secondary"
                style={{ fontSize: 11, whiteSpace: 'nowrap', padding: '4px 8px' }}
                disabled={fetchingModels || saving || clearing || removing}
                onClick={() => void fetchModels()}
                title="Fetch available models from the provider"
              >
                {fetchingModels ? 'Fetching…' : 'Fetch Models'}
              </button>
            </div>
            <datalist id={`ai-provider-models-${scope}`}>
              {availableModels.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            {modelsError && <p className="text-danger" style={{ fontSize: 11, margin: '2px 0 0' }}>{modelsError}</p>}
            {availableModels.length > 0 && <p className="text-muted" style={{ fontSize: 11, margin: '2px 0 0' }}>{availableModels.length} models found — start typing to filter.</p>}
          </div>
        </div>
        <div className="field">
          <label htmlFor={`ai-provider-baseurl-${scope}`}>Base URL (optional)</label>
          <input
            id={`ai-provider-baseurl-${scope}`}
            className="input"
            value={baseUrl}
            disabled={saving || clearing || removing}
            aria-describedby={feedback.statusId}
            onChange={(e) => editDraft('baseUrl', e.target.value)}
            placeholder="Leave blank for the provider default"
          />
        </div>
        <div className="field">
          <label htmlFor={`ai-provider-key-${scope}`}>
            API key {provider?.configured ? '(set — blank keeps it)' : '(write-only)'}
          </label>
          <input
            id={`ai-provider-key-${scope}`}
            className="input"
            type="password"
            autoComplete="off"
            aria-describedby={`ai-provider-key-help-${scope} ${feedback.statusId}`}
            value={apiKey}
            disabled={saving || clearing || removing}
            onChange={(e) => editDraft('apiKey', e.target.value)}
            placeholder={provider?.configured ? '•••• (unchanged)' : 'Paste a key to set it'}
          />
          <p id={`ai-provider-key-help-${scope}`} className="text-muted" style={{ margin: '3px 0 0', fontSize: 11 }}>
            For testing and saving, blank reuses this scope&apos;s stored key or its permitted environment/server
            fallback. A value tests or saves that new key.
          </p>
        </div>
        <p className="text-muted" style={{ margin: 0, fontSize: 11 }}>
          Test connection is safe and non-mutating: it sends the visible draft to the provider test endpoint without
          saving provider settings or returning any key material.
        </p>
        {testError && <p role="alert" className="text-sm" style={{ color: '#f87171' }}>Test failed: {testError}</p>}
        {testResult && (
          <div
            role="status"
            aria-label="Connection test result"
            className="text-sm"
            style={{ color: testResult.ok ? 'var(--color-accent, #4ade80)' : '#f87171' }}
          >
            <p style={{ margin: 0, fontWeight: 600 }}>
              {testResult.ok ? 'Connection OK' : `Connection failed: ${testResult.error ?? 'unknown error'}`}
            </p>
            <dl style={{ margin: '4px 0 0', display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '2px 8px' }}>
              <dt>Target</dt>
              <dd style={{ margin: 0 }}>
                {testResult.providerType} / {testResult.model} · {testResult.baseUrl ?? 'provider default endpoint'}
              </dd>
              <dt>Scope</dt>
              <dd style={{ margin: 0 }}>{testedScopeLabel[testResult.testedTarget]}</dd>
              <dt>Credential</dt>
              <dd style={{ margin: 0 }}>{testedCredentialLabel[testResult.credentialSource]}</dd>
              <dt>Tested</dt>
              <dd style={{ margin: 0 }}>
                <time dateTime={testResult.testedAt}>{formatDateTime(testResult.testedAt)}</time>
              </dd>
            </dl>
          </div>
        )}
        <div className="flex gap-2 items-center flex-wrap">
          <button
            className="btn btn-primary"
            style={{ fontSize: 12.5 }}
            disabled={saving || clearing || removing}
            onClick={() => void save()}
          >
            {saving ? 'Saving…' : 'Save provider'}
          </button>
          <button
            className="btn btn-secondary"
            style={{ fontSize: 12.5 }}
            disabled={testing || clearing || saving || removing}
            onClick={() => void test()}
          >
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          {provider && (
            <button
              className="btn btn-danger"
              style={{ fontSize: 12.5 }}
              disabled={removing || clearing || saving}
              aria-busy={removing || undefined}
              onClick={() => void remove()}
            >
              {removing ? 'Removing…' : 'Remove'}
            </button>
          )}
          {provider?.configured && (
            <button
              className="btn btn-secondary"
              style={{ fontSize: 12.5, color: '#fbbf24', borderColor: 'rgba(251,191,36,0.4)' }}
              disabled={clearing || removing || saving}
              onClick={() => setConfirmClear(true)}
            >
              {clearing ? 'Clearing…' : 'Clear stored key'}
            </button>
          )}
          {feedback.announcement}
          {actionNotice && (
            <p
              role={actionNotice.role}
              aria-live={actionNotice.role === 'alert' ? 'assertive' : 'polite'}
              className={`text-xs ${actionNotice.role === 'alert' ? 'text-rose-400' : 'text-muted'}`}
              style={{ margin: 0 }}
            >
              {actionNotice.text}
            </p>
          )}
        </div>
      </div>
      {confirmClear && provider?.configured && (
        <ConfirmDialog
          title="Clear stored API key?"
          body={
            <p style={{ margin: 0 }}>
              This permanently removes the encrypted key ending ••{provider.keyLast4 ?? '????'}. The provider,
              model, base URL, parameters, and allowlist stay unchanged. Campfire will use an available server or
              environment credential; otherwise this provider will show as not ready.
            </p>
          }
          confirmLabel="Clear stored key"
          busy={clearing}
          onConfirm={() => void clearStoredKey()}
          onCancel={() => setConfirmClear(false)}
        />
      )}
    </>
  );
}
