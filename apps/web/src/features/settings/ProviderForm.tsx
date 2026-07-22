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
import { useEffect, useState } from 'react';
import type { AiProviderConfigType, AiProviderConfigView, AiProviderTestResult } from '@campfire/schema';
import { api, ApiError, API } from '../../lib/api';

const PROVIDER_TYPES: AiProviderConfigType[] = ['openai', 'anthropic', 'mock'];

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

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<AiProviderTestResult | null>(null);
  const [removing, setRemoving] = useState(false);

  function hydrate(p: AiProviderConfigView | null) {
    setProvider(p);
    setProviderType(p?.providerType ?? 'openai');
    setModel(p?.model ?? '');
    setBaseUrl(p?.baseUrl ?? '');
    setApiKey('');
  }

  useEffect(() => {
    let alive = true;
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
  }, [basePath]);

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
      // Only send apiKey when one was typed — an omitted key keeps the stored value.
      if (apiKey !== '') body.apiKey = apiKey;
      const updated = await api.put<AiProviderConfigView>(`${API}${basePath}`, body);
      setProvider(updated);
      setApiKey(''); // never retain the plaintext key in state
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
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api.post<AiProviderTestResult>(`${API}${basePath}/test`);
      setTestResult(r);
    } catch (err) {
      setTestResult({
        ok: false,
        scope,
        providerType,
        model,
        error: err instanceof ApiError ? err.message : 'Test failed.',
      });
    } finally {
      setTesting(false);
    }
  }

  async function remove() {
    setRemoving(true);
    setError(null);
    setTestResult(null);
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
        : 'No server-default key stored yet. Set one here so every campaign can use AI without configuring their own.'
      : provider?.configured
        ? `A key is stored for this campaign (ends ••${provider.keyLast4 ?? '????'}). Leave the key blank to keep it, or enter a new one to rotate.`
        : 'No campaign key stored — this override still falls back to the server default key when set. Most tables leave this blank.';

  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>{hint}</p>
      <div className="flex gap-2 flex-wrap">
        <div className="field" style={{ maxWidth: 160 }}>
          <label htmlFor={`ai-provider-type-${scope}`}>Provider</label>
          <select
            id={`ai-provider-type-${scope}`}
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
          <label htmlFor={`ai-provider-model-${scope}`}>Model</label>
          <input
            id={`ai-provider-model-${scope}`}
            className="input"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="e.g. gpt-4o-mini"
          />
        </div>
      </div>
      <div className="field">
        <label htmlFor={`ai-provider-baseurl-${scope}`}>Base URL (optional)</label>
        <input
          id={`ai-provider-baseurl-${scope}`}
          className="input"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
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
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={provider?.configured ? '•••• (unchanged)' : 'Paste a key to set it'}
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
        {provider && (
          <button
            className="btn btn-secondary"
            style={{ fontSize: 12.5, color: '#f87171', borderColor: 'rgba(248,113,113,0.4)' }}
            disabled={removing}
            onClick={() => void remove()}
          >
            {removing ? 'Removing…' : 'Remove'}
          </button>
        )}
        {saved && <span className="text-muted" style={{ fontSize: 12 }}>Saved.</span>}
      </div>
    </div>
  );
}
