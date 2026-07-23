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
import type {
  AiProviderConfigType,
  AiProviderConfigView,
  AiProviderTestRequest,
  AiProviderTestResult,
} from '@campfire/schema';
import { api, ApiError, API } from '../../lib/api';
import { ConfirmDialog } from '../../components/ConfirmDialog';

const PROVIDER_TYPES: AiProviderConfigType[] = ['openai', 'anthropic', 'gemini', 'mock'];

interface ProviderDraft {
  providerType: AiProviderConfigType;
  model: string;
  baseUrl: string;
  apiKey: string;
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

  const [providerType, setProviderType] = useState<AiProviderConfigType>('openai');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState(''); // write-only; blank keeps the stored key
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    setSaved(false);
    if (field === 'providerType') setProviderType(value as AiProviderConfigType);
    else if (field === 'model') setModel(value);
    else if (field === 'baseUrl') setBaseUrl(value);
    else setApiKey(value);
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
      setError('A model is required.');
      return;
    }
    invalidateTestForAction();
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const body: Record<string, unknown> = { providerType, model: model.trim() };
      if (baseUrl.trim()) body.baseUrl = baseUrl.trim();
      // Only send apiKey when one was typed — an omitted key keeps the stored value.
      if (apiKey !== '') body.apiKey = apiKey;
      const updated = await api.put<AiProviderConfigView>(`${API}${basePath}`, body);
      hydrate(updated); // also drops the plaintext key and fingerprints the saved draft
      onChanged?.(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save the provider.");
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    if (!model.trim()) {
      invalidateTestForAction();
      setError('A model is required.');
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
    setError(null);
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
    setError(null);
    try {
      await api.delete(`${API}${basePath}`);
      hydrate(null);
      onChanged?.(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't remove the provider.");
    } finally {
      setRemoving(false);
    }
  }

  async function clearStoredKey() {
    invalidateTestForAction();
    setClearing(true);
    setError(null);
    try {
      const updated = await api.delete<AiProviderConfigView>(`${API}${basePath}/key`);
      setProvider(updated);
      editDraft('apiKey', '');
      setConfirmClear(false);
      onChanged?.(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't clear the stored key.");
    } finally {
      setClearing(false);
    }
  }

  if (loading) {
    return <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>Loading…</p>;
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
                onChange={(e) => editDraft('model', e.target.value)}
                placeholder="e.g. gpt-4o-mini"
                list={`ai-provider-models-${scope}`}
                style={{ flex: 1 }}
              />
              <button
                type="button"
                className="btn btn-secondary"
                style={{ fontSize: 11, whiteSpace: 'nowrap', padding: '4px 8px' }}
                disabled={fetchingModels}
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
            aria-describedby={`ai-provider-key-help-${scope}`}
            value={apiKey}
            onChange={(e) => editDraft('apiKey', e.target.value)}
            placeholder={provider?.configured ? '•••• (unchanged)' : 'Paste a key to set it'}
          />
          <p id={`ai-provider-key-help-${scope}`} className="text-muted" style={{ margin: '3px 0 0', fontSize: 11 }}>
            For testing and saving, blank reuses this scope&apos;s stored key or its permitted environment/server
            fallback. A value tests or saves that new key.
          </p>
        </div>
        {error && <p className="text-sm" style={{ color: '#f87171' }}>{error}</p>}
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
                <time dateTime={testResult.testedAt}>{new Date(testResult.testedAt).toLocaleString()}</time>
              </dd>
            </dl>
          </div>
        )}
        <div className="flex gap-2 items-center flex-wrap">
          <button
            className="btn btn-primary"
            style={{ fontSize: 12.5 }}
            disabled={saving || clearing}
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
              disabled={removing || clearing}
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
              disabled={clearing || removing}
              onClick={() => setConfirmClear(true)}
            >
              {clearing ? 'Clearing…' : 'Clear stored key'}
            </button>
          )}
          {saved && <span className="text-muted" style={{ fontSize: 12 }}>Saved.</span>}
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
