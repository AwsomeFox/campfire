/**
 * OIDC/SSO configuration card — extracted from AdminPage.tsx as part of the
 * /admin/* page split (issue #350). Lives on /admin/auth.
 *
 * In-app OIDC config (issue #25). Persisted server-side; env vars of the same
 * name override stored values per-field (server surfaces which via `envKeys`).
 * The client secret is write-only — the API never returns it, only whether one
 * is set.
 *
 * Diagnostics (issue #848): "Test discovery" probes reachability / issuer
 * equality / redirect+client; "Test login (end-to-end)" runs a real auth-code
 * round trip without replacing the admin session or provisioning a user.
 * Results invalidate on relevant edits/saves and show timestamp + fingerprint.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { OidcCheckResult, OidcSettings, OidcTestLoginStart, OidcTestResult } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { Card, Btn, TextInput, ErrorNote } from '../../components/ui';

interface OidcDraft {
  providerName: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  adminGroup: string;
  allowedGroup: string;
  groupsClaim: string;
  scope: string;
}

/**
 * Local-only fingerprint binding an async diagnostic result to the draft
 * revision that launched it. The write-only secret is represented only as
 * blank/present — plaintext is never copied into the fingerprint.
 */
function draftFingerprint(draft: OidcDraft, revision: number): string {
  return JSON.stringify([
    draft.providerName,
    draft.issuer,
    draft.clientId,
    draft.clientSecret === '' ? 'secret:blank' : 'secret:present',
    draft.redirectUri,
    draft.adminGroup,
    draft.allowedGroup,
    draft.groupsClaim,
    draft.scope,
    revision,
  ]);
}

function checkTone(status: OidcCheckResult['status']): string {
  if (status === 'pass') return 'text-emerald-300';
  if (status === 'fail') return 'text-rose-300';
  return 'text-slate-500';
}

function checkLabel(status: OidcCheckResult['status']): string {
  if (status === 'pass') return 'pass';
  if (status === 'fail') return 'fail';
  return 'skip';
}

function sourceSummary(result: OidcTestResult): string {
  const entries = Object.entries(result.fieldSources) as [string, string][];
  const counts = { draft: 0, stored: 0, environment: 0, default: 0 };
  for (const [, src] of entries) {
    if (src in counts) counts[src as keyof typeof counts] += 1;
  }
  const parts: string[] = [];
  if (counts.draft) parts.push('draft');
  if (counts.stored) parts.push('stored');
  if (counts.environment) parts.push('environment-overridden');
  if (counts.default && parts.length === 0) parts.push('defaults');
  return parts.length ? parts.join(' + ') : 'stored';
}

export function OidcCard() {
  const [cfg, setCfg] = useState<OidcSettings | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const [providerName, setProviderName] = useState('');
  const [issuer, setIssuer] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState(''); // blank = keep current
  const [redirectUri, setRedirectUri] = useState('');
  const [adminGroup, setAdminGroup] = useState('');
  const [allowedGroup, setAllowedGroup] = useState('');
  const [groupsClaim, setGroupsClaim] = useState('');
  const [scope, setScope] = useState('');

  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testingLogin, setTestingLogin] = useState(false);
  const [testResult, setTestResult] = useState<OidcTestResult | null>(null);

  const draftRevision = useRef(0);
  const currentDraftFingerprint = useRef('');

  const currentDraft = useCallback(
    (): OidcDraft => ({
      providerName,
      issuer,
      clientId,
      clientSecret,
      redirectUri,
      adminGroup,
      allowedGroup,
      groupsClaim,
      scope,
    }),
    [providerName, issuer, clientId, clientSecret, redirectUri, adminGroup, allowedGroup, groupsClaim, scope],
  );

  const bumpFingerprint = useCallback(
    (draft: OidcDraft) => {
      draftRevision.current += 1;
      currentDraftFingerprint.current = draftFingerprint(draft, draftRevision.current);
    },
    [],
  );

  const invalidateDiagnostics = useCallback(() => {
    bumpFingerprint(currentDraft());
    setTestResult(null);
    setTesting(false);
    setTestingLogin(false);
  }, [bumpFingerprint, currentDraft]);

  const apply = useCallback(
    (c: OidcSettings) => {
      const next: OidcDraft = {
        providerName: c.providerName,
        issuer: c.issuer,
        clientId: c.clientId,
        clientSecret: '',
        redirectUri: c.redirectUri,
        adminGroup: c.adminGroup,
        allowedGroup: c.allowedGroup,
        groupsClaim: c.groupsClaim,
        scope: c.scope,
      };
      setCfg(c);
      setProviderName(next.providerName);
      setIssuer(next.issuer);
      setClientId(next.clientId);
      setClientSecret(next.clientSecret);
      setRedirectUri(next.redirectUri);
      setAdminGroup(next.adminGroup);
      setAllowedGroup(next.allowedGroup);
      setGroupsClaim(next.groupsClaim);
      setScope(next.scope);
      bumpFingerprint(next);
      setTestResult(null);
      setTesting(false);
      setTestingLogin(false);
    },
    [bumpFingerprint],
  );

  const load = useCallback(async () => {
    setLoadErr(null);
    try {
      apply(await api.get<OidcSettings>(`${API}/settings/oidc`));
    } catch (err) {
      setLoadErr(err instanceof ApiError ? err.message : "Couldn't load OIDC settings.");
    }
  }, [apply]);

  useEffect(() => {
    void load();
  }, [load]);

  // After an end-to-end diagnostic redirect (?oidcDiag=1), fetch the stored result.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('oidcDiag') !== '1') return;
    let alive = true;
    void (async () => {
      try {
        const result = await api.get<OidcTestResult | null>(`${API}/settings/oidc/test-login/result`);
        if (alive && result) setTestResult(result);
        // Refresh cfg so lastE2eTest / configFingerprint stay current.
        if (alive) {
          const fresh = await api.get<OidcSettings>(`${API}/settings/oidc`);
          setCfg(fresh);
        }
      } catch {
        // Non-fatal — the card still loads normally.
      } finally {
        params.delete('oidcDiag');
        const next = `${window.location.pathname}${params.toString() ? `?${params}` : ''}`;
        window.history.replaceState({}, '', next);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const envPinned = (envVar: string) => (cfg?.envKeys ?? []).includes(envVar);

  function editField<K extends keyof OidcDraft>(field: K, value: OidcDraft[K]) {
    const next = { ...currentDraft(), [field]: value };
    bumpFingerprint(next);
    setTestResult(null);
    setTesting(false);
    setTestingLogin(false);
    setSaved(false);
    if (field === 'providerName') setProviderName(value);
    else if (field === 'issuer') setIssuer(value);
    else if (field === 'clientId') setClientId(value);
    else if (field === 'clientSecret') setClientSecret(value);
    else if (field === 'redirectUri') setRedirectUri(value);
    else if (field === 'adminGroup') setAdminGroup(value);
    else if (field === 'allowedGroup') setAllowedGroup(value);
    else if (field === 'groupsClaim') setGroupsClaim(value);
    else if (field === 'scope') setScope(value);
  }

  function testBody(): Record<string, string> {
    const body: Record<string, string> = {
      issuer: issuer.trim(),
      clientId: clientId.trim(),
      redirectUri: redirectUri.trim(),
      adminGroup: adminGroup.trim(),
      allowedGroup: allowedGroup.trim(),
      groupsClaim: groupsClaim.trim(),
      scope: scope.trim(),
    };
    // Write-only secret: only send when typed (blank = reuse stored/env).
    if (clientSecret !== '') body.clientSecret = clientSecret;
    return body;
  }

  async function save() {
    invalidateDiagnostics();
    setSaving(true);
    setSaveErr(null);
    setSaved(false);
    try {
      const body: Record<string, string> = {
        providerName: providerName.trim(),
        issuer: issuer.trim(),
        clientId: clientId.trim(),
        redirectUri: redirectUri.trim(),
        adminGroup: adminGroup.trim(),
        allowedGroup: allowedGroup.trim(),
        groupsClaim: groupsClaim.trim(),
        scope: scope.trim(),
      };
      if (clientSecret !== '') body.clientSecret = clientSecret;
      apply(await api.patch<OidcSettings>(`${API}/settings/oidc`, body));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setSaveErr(err instanceof ApiError ? err.message : "Couldn't save OIDC settings.");
    } finally {
      setSaving(false);
    }
  }

  async function testDiscovery() {
    const fingerprint = currentDraftFingerprint.current;
    setTesting(true);
    setTestResult(null);
    setSaveErr(null);
    try {
      const result = await api.post<OidcTestResult>(`${API}/settings/oidc/test`, testBody());
      if (currentDraftFingerprint.current === fingerprint) setTestResult(result);
    } catch (err) {
      if (currentDraftFingerprint.current === fingerprint) {
        setSaveErr(err instanceof ApiError ? err.message : "Couldn't run the discovery test.");
      }
    } finally {
      if (currentDraftFingerprint.current === fingerprint) setTesting(false);
    }
  }

  async function testLogin() {
    const fingerprint = currentDraftFingerprint.current;
    setTestingLogin(true);
    setTestResult(null);
    setSaveErr(null);
    try {
      const started = await api.post<OidcTestLoginStart>(`${API}/settings/oidc/test-login`, testBody());
      if (currentDraftFingerprint.current !== fingerprint) return;
      // Full-page navigate so the IdP round-trip shares this admin session's
      // cookies; the callback returns to /admin/auth?oidcDiag=1 without
      // replacing the session.
      window.location.assign(started.authorizationUrl);
    } catch (err) {
      if (currentDraftFingerprint.current === fingerprint) {
        setSaveErr(err instanceof ApiError ? err.message : "Couldn't start the end-to-end test login.");
        setTestingLogin(false);
      }
    }
  }

  const e2eFingerprintMatches =
    !!cfg?.lastE2eTest &&
    !!cfg.configFingerprint &&
    cfg.lastE2eTest.fingerprint === cfg.configFingerprint;
  // Successful e2e against the current effective config — drives the amber
  // "run Test login" banner. Fingerprint match alone must not require ok.
  const e2eVerified = e2eFingerprintMatches && !!cfg?.lastE2eTest?.ok;

  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between border-b border-slate-700 pb-2">
        <h2 className="font-bold text-white text-sm">OIDC single sign-on</h2>
        {cfg && (
          <span className={`cf-chip ${cfg.enabled ? 'cf-chip-completed' : 'cf-chip-private'}`}>
            {cfg.enabled ? 'Enabled' : 'Not configured'}
          </span>
        )}
      </div>

      {loadErr && <ErrorNote message={loadErr} onRetry={load} />}

      <p className="text-[11px] text-slate-500">
        Configure OIDC/SSO here, or via <code>OIDC_*</code> environment variables. When both are set, the environment
        variable wins for that field. Use <strong>Test discovery</strong> to confirm the issuer is reachable, then{' '}
        <strong>Test login (end-to-end)</strong> before relying on SSO as the only sign-in path.
      </p>

      {cfg && cfg.envKeys.length > 0 && (
        <div className="cf-inset border-amber-500/30 p-3 text-[11px] text-amber-300/90">
          Set via environment (these override the values below):{' '}
          <span className="font-mono">{cfg.envKeys.join(', ')}</span>
        </div>
      )}

      {cfg && cfg.enabled && !e2eVerified && (
        <div className="cf-inset border-amber-500/30 p-3 text-[11px] text-amber-300/90">
          No successful end-to-end test login matches the current effective configuration. Run{' '}
          <strong>Test login (end-to-end)</strong> before making OIDC the only login path.
        </div>
      )}

      {cfg && (
        <div className="space-y-2">
          <OidcField
            label="Provider display name"
            value={providerName}
            onChange={(v) => editField('providerName', v)}
            placeholder="(optional) e.g. Keycloak"
            envPinned={envPinned('OIDC_PROVIDER_NAME')}
            hint="Shown on the public sign-in button. Leave blank to use SSO."
          />
          <OidcField
            label="Issuer / discovery URL"
            value={issuer}
            onChange={(v) => editField('issuer', v)}
            placeholder="https://idp.example.com"
            envPinned={envPinned('OIDC_ISSUER')}
          />
          <div className="grid sm:grid-cols-2 gap-2">
            <OidcField
              label="Client ID"
              value={clientId}
              onChange={(v) => editField('clientId', v)}
              placeholder="campfire"
              envPinned={envPinned('OIDC_CLIENT_ID')}
            />
            <OidcField
              label="Client secret"
              value={clientSecret}
              onChange={(v) => editField('clientSecret', v)}
              type="password"
              placeholder={cfg.clientSecretSet ? '•••••••• (leave blank to keep)' : 'client secret'}
              envPinned={envPinned('OIDC_CLIENT_SECRET')}
            />
          </div>
          <OidcField
            label="Redirect URI"
            value={redirectUri}
            onChange={(v) => editField('redirectUri', v)}
            placeholder={cfg.effectiveRedirectUri}
            envPinned={envPinned('OIDC_REDIRECT_URI')}
            hint={`Effective: ${cfg.effectiveRedirectUri}`}
          />
          <div className="grid sm:grid-cols-2 gap-2">
            <OidcField
              label="Admin group"
              value={adminGroup}
              onChange={(v) => editField('adminGroup', v)}
              placeholder="(optional) e.g. campfire-admins"
              envPinned={envPinned('OIDC_ADMIN_GROUP')}
              hint="Members become server admins."
            />
            <OidcField
              label="Allowed group"
              value={allowedGroup}
              onChange={(v) => editField('allowedGroup', v)}
              placeholder="(optional) restrict sign-in to this group"
              envPinned={envPinned('OIDC_ALLOWED_GROUP')}
              hint="When set, only members (or admins) may sign in."
            />
          </div>
          <div className="grid sm:grid-cols-2 gap-2">
            <OidcField
              label="Groups claim"
              value={groupsClaim}
              onChange={(v) => editField('groupsClaim', v)}
              placeholder="groups"
              envPinned={envPinned('OIDC_GROUPS_CLAIM')}
            />
            <OidcField
              label="Scope"
              value={scope}
              onChange={(v) => editField('scope', v)}
              placeholder="openid profile email"
              envPinned={envPinned('OIDC_SCOPE')}
            />
          </div>

          {testResult && (
            <div
              className={`cf-inset p-3 text-[11px] space-y-2 ${
                testResult.ok ? 'border-emerald-500/40 text-emerald-300' : 'border-rose-500/40 text-rose-300'
              }`}
            >
              <p className="font-semibold">
                {testResult.kind === 'discovery'
                  ? testResult.checks.discovery.status === 'pass'
                    ? '✓ Discovery reachable'
                    : '✗ Discovery failed'
                  : testResult.ok
                    ? '✓ End-to-end test login OK'
                    : '✗ End-to-end test login failed'}
              </p>
              <p className="text-slate-400">{testResult.message}</p>
              <p className="text-slate-500">
                Tested {new Date(testResult.testedAt).toLocaleString()} · fingerprint{' '}
                <span className="font-mono">{testResult.fingerprint || '—'}</span> · values from{' '}
                {sourceSummary(testResult)}
              </p>
              <ul className="space-y-1 text-slate-400">
                {(
                  [
                    ['Discovery', testResult.checks.discovery],
                    ['Redirect / client', testResult.checks.redirectClient],
                    ['Token exchange', testResult.checks.tokenExchange],
                    ['Required claims', testResult.checks.requiredClaims],
                    ['Group policy', testResult.checks.groupPolicy],
                  ] as const
                ).map(([label, check]) => (
                  <li key={label} className="flex gap-2">
                    <span className={`font-mono uppercase text-[10px] w-12 shrink-0 ${checkTone(check.status)}`}>
                      {checkLabel(check.status)}
                    </span>
                    <span>
                      <span className="text-slate-300">{label}:</span> {check.message}
                    </span>
                  </li>
                ))}
              </ul>
              {testResult.authorizationEndpoint && (
                <p className="text-slate-500 font-mono break-all">authorize: {testResult.authorizationEndpoint}</p>
              )}
            </div>
          )}

          {cfg.lastE2eTest && (
            <p className="text-[10px] text-slate-600">
              Last end-to-end test: {cfg.lastE2eTest.ok ? 'OK' : 'failed'} at{' '}
              {new Date(cfg.lastE2eTest.testedAt).toLocaleString()} · fingerprint{' '}
              <span className="font-mono">{cfg.lastE2eTest.fingerprint || '—'}</span>
              {e2eFingerprintMatches
                ? ' (matches current config)'
                : ' (does not match current config)'}
            </p>
          )}

          {saveErr && <p className="text-xs text-rose-400">{saveErr}</p>}

          <div className="flex gap-2 justify-end items-center flex-wrap">
            {saved && <span className="text-xs text-emerald-400 mr-auto">Saved.</span>}
            <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={testDiscovery} disabled={testing || testingLogin || !issuer.trim()}>
              {testing ? 'Testing…' : 'Test discovery'}
            </Btn>
            <Btn
              ghost
              className="!min-h-0 !py-1.5 text-xs"
              onClick={testLogin}
              disabled={testing || testingLogin || !issuer.trim()}
            >
              {testingLogin ? 'Starting…' : 'Test login (end-to-end)'}
            </Btn>
            <Btn className="!min-h-0 !py-1.5 text-xs" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Btn>
          </div>
        </div>
      )}
    </Card>
  );
}

function OidcField({
  label,
  value,
  onChange,
  placeholder,
  type,
  envPinned,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  envPinned?: boolean;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-widest text-slate-500 font-bold flex items-center gap-1.5">
        {label}
        {envPinned && <span className="cf-chip cf-chip-private !py-0 !text-[9px]">env</span>}
      </span>
      <TextInput
        className="!min-h-0 !py-2 text-sm mt-1"
        value={value}
        type={type}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <span className="text-[10px] text-slate-600 mt-0.5 block">{hint}</span>}
    </label>
  );
}
