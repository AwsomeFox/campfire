/**
 * OIDC/SSO configuration card — extracted from AdminPage.tsx as part of the
 * /admin/* page split (issue #350). Lives on /admin/auth.
 *
 * In-app OIDC config (issue #25). Persisted server-side; env vars of the same
 * name override stored values per-field (server surfaces which via `envKeys`).
 * The client secret is write-only — the API never returns it, only whether one
 * is set. "Test connection" validates the issuer's discovery document.
 */
import { useCallback, useEffect, useState } from 'react';
import type { OidcSettings, OidcTestResult } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { Card, Btn, TextInput, ErrorNote } from '../../components/ui';

export function OidcCard() {
  const [cfg, setCfg] = useState<OidcSettings | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  // Editable form fields.
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
  const [testResult, setTestResult] = useState<OidcTestResult | null>(null);

  const apply = useCallback((c: OidcSettings) => {
    setCfg(c);
    setIssuer(c.issuer);
    setClientId(c.clientId);
    setClientSecret('');
    setRedirectUri(c.redirectUri);
    setAdminGroup(c.adminGroup);
    setAllowedGroup(c.allowedGroup);
    setGroupsClaim(c.groupsClaim);
    setScope(c.scope);
  }, []);

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

  const envPinned = (envVar: string) => (cfg?.envKeys ?? []).includes(envVar);

  async function save() {
    setSaving(true);
    setSaveErr(null);
    setSaved(false);
    try {
      const body: Record<string, string> = {
        issuer: issuer.trim(),
        clientId: clientId.trim(),
        redirectUri: redirectUri.trim(),
        adminGroup: adminGroup.trim(),
        allowedGroup: allowedGroup.trim(),
        groupsClaim: groupsClaim.trim(),
        scope: scope.trim(),
      };
      // Write-only secret: only send when the admin typed something (blank = keep current).
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

  async function test() {
    setTesting(true);
    setTestResult(null);
    setSaveErr(null);
    try {
      // Test the issuer currently in the form (lets you validate before saving).
      const result = await api.post<OidcTestResult>(`${API}/settings/oidc/test`, { issuer: issuer.trim() });
      setTestResult(result);
    } catch (err) {
      setSaveErr(err instanceof ApiError ? err.message : "Couldn't run the connection test.");
    } finally {
      setTesting(false);
    }
  }

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
        variable wins for that field. Fill in issuer, client id &amp; secret, then <strong>Test connection</strong> to
        validate the discovery endpoint.
      </p>

      {cfg && cfg.envKeys.length > 0 && (
        <div className="cf-inset border-amber-500/30 p-3 text-[11px] text-amber-300/90">
          Set via environment (these override the values below):{' '}
          <span className="font-mono">{cfg.envKeys.join(', ')}</span>
        </div>
      )}

      {cfg && (
        <div className="space-y-2">
          <OidcField
            label="Issuer / discovery URL"
            value={issuer}
            onChange={setIssuer}
            placeholder="https://idp.example.com"
            envPinned={envPinned('OIDC_ISSUER')}
          />
          <div className="grid sm:grid-cols-2 gap-2">
            <OidcField
              label="Client ID"
              value={clientId}
              onChange={setClientId}
              placeholder="campfire"
              envPinned={envPinned('OIDC_CLIENT_ID')}
            />
            <OidcField
              label="Client secret"
              value={clientSecret}
              onChange={setClientSecret}
              type="password"
              placeholder={cfg.clientSecretSet ? '•••••••• (leave blank to keep)' : 'client secret'}
              envPinned={envPinned('OIDC_CLIENT_SECRET')}
            />
          </div>
          <OidcField
            label="Redirect URI"
            value={redirectUri}
            onChange={setRedirectUri}
            placeholder={cfg.effectiveRedirectUri}
            envPinned={envPinned('OIDC_REDIRECT_URI')}
            hint={`Effective: ${cfg.effectiveRedirectUri}`}
          />
          <div className="grid sm:grid-cols-2 gap-2">
            <OidcField
              label="Admin group"
              value={adminGroup}
              onChange={setAdminGroup}
              placeholder="(optional) e.g. campfire-admins"
              envPinned={envPinned('OIDC_ADMIN_GROUP')}
              hint="Members become server admins."
            />
            <OidcField
              label="Allowed group"
              value={allowedGroup}
              onChange={setAllowedGroup}
              placeholder="(optional) restrict sign-in to this group"
              envPinned={envPinned('OIDC_ALLOWED_GROUP')}
              hint="When set, only members (or admins) may sign in."
            />
          </div>
          <div className="grid sm:grid-cols-2 gap-2">
            <OidcField
              label="Groups claim"
              value={groupsClaim}
              onChange={setGroupsClaim}
              placeholder="groups"
              envPinned={envPinned('OIDC_GROUPS_CLAIM')}
            />
            <OidcField
              label="Scope"
              value={scope}
              onChange={setScope}
              placeholder="openid profile email"
              envPinned={envPinned('OIDC_SCOPE')}
            />
          </div>

          {testResult && (
            <div
              className={`cf-inset p-3 text-[11px] ${
                testResult.ok ? 'border-emerald-500/40 text-emerald-300' : 'border-rose-500/40 text-rose-300'
              }`}
            >
              <p className="font-semibold">{testResult.ok ? '✓ Connection OK' : '✗ Connection failed'}</p>
              <p className="text-slate-400 mt-0.5">{testResult.message}</p>
              {testResult.ok && testResult.authorizationEndpoint && (
                <p className="text-slate-500 mt-1 font-mono break-all">authorize: {testResult.authorizationEndpoint}</p>
              )}
            </div>
          )}

          {saveErr && <p className="text-xs text-rose-400">{saveErr}</p>}

          <div className="flex gap-2 justify-end items-center flex-wrap">
            {saved && <span className="text-xs text-emerald-400 mr-auto">Saved.</span>}
            <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={test} disabled={testing || !issuer.trim()}>
              {testing ? 'Testing…' : 'Test connection'}
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
