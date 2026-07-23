/**
 * Server sign-in settings card (signup/local-login toggles) — extracted from
 * AdminPage.tsx as part of the /admin/* page split (issue #350). Lives on
 * /admin/users.
 *
 * Issue #848: warn before making OIDC the only login path (turning off local
 * login) when there is no successful end-to-end OIDC diagnostic matching the
 * current effective config.
 */
import { useState } from 'react';
import type { OidcSettings, ServerSettings } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { Card } from '../../components/ui';
import { ConfirmDialog } from '../../components/ConfirmDialog';

export function SettingsCard({ settings, onChange }: { settings: ServerSettings | null; onChange: () => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDisableLocal, setConfirmDisableLocal] = useState<null | { reason: string }>(null);

  async function applyToggle(key: 'allowLocalLogin' | 'allowSignup') {
    if (!settings) return;
    setSaving(true);
    setError(null);
    try {
      await api.patch(`${API}/settings`, { [key]: !settings[key] });
      onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't update settings.");
    } finally {
      setSaving(false);
    }
  }

  async function toggle(key: 'allowLocalLogin' | 'allowSignup') {
    if (!settings) return;

    // Turning local login OFF can lock non-admins into SSO — require a matching
    // successful end-to-end OIDC diagnostic, or an explicit acknowledgement.
    if (key === 'allowLocalLogin' && settings.allowLocalLogin) {
      try {
        const oidc = await api.get<OidcSettings>(`${API}/settings/oidc`);
        const e2eOk =
          oidc.enabled &&
          !!oidc.lastE2eTest?.ok &&
          oidc.lastE2eTest.fingerprint === oidc.configFingerprint;
        if (oidc.enabled && !e2eOk) {
          setConfirmDisableLocal({
            reason: oidc.lastE2eTest?.ok
              ? 'OIDC is enabled, but the last successful end-to-end test does not match the current configuration.'
              : 'OIDC is enabled, but there is no successful end-to-end test login for the current configuration.',
          });
          return;
        }
      } catch {
        // If we cannot load OIDC status, still warn — safer than silent disable.
        setConfirmDisableLocal({
          reason: 'Could not verify that OIDC end-to-end diagnostics succeeded for the current configuration.',
        });
        return;
      }
    }

    await applyToggle(key);
  }

  return (
    <Card className="space-y-3">
      <h2 className="font-bold text-white text-sm border-b border-slate-700 pb-2">Server settings</h2>
      {error && <p className="text-xs text-rose-400">{error}</p>}
      <SettingToggleRow
        title="Allow username/password sign-in for non-admin users"
        hint="When off, only server admins can sign in locally (SSO coming later)."
        checked={settings?.allowLocalLogin ?? false}
        disabled={!settings || saving}
        onToggle={() => toggle('allowLocalLogin')}
      />
      <SettingToggleRow
        title="Allow self-service signup"
        hint="When on, anyone who can reach this server can create their own (non-admin) account from the login page. Requires local sign-in to be on."
        checked={settings?.allowSignup ?? false}
        disabled={!settings || saving}
        onToggle={() => toggle('allowSignup')}
      />

      {confirmDisableLocal && (
        <ConfirmDialog
          title="Disable local sign-in?"
          body={
            <div className="space-y-2 text-sm text-slate-300">
              <p>{confirmDisableLocal.reason}</p>
              <p>
                Turning off username/password sign-in for non-admins makes OIDC the only login path for those users.
                Run <strong>Admin → Auth → Test login (end-to-end)</strong> successfully first, or confirm you
                understand the lockout risk.
              </p>
            </div>
          }
          confirmLabel="Disable local sign-in"
          busy={saving}
          onConfirm={() => {
            setConfirmDisableLocal(null);
            void applyToggle('allowLocalLogin');
          }}
          onCancel={() => setConfirmDisableLocal(null)}
        />
      )}
    </Card>
  );
}

function SettingToggleRow({
  title,
  hint,
  checked,
  disabled,
  onToggle,
}: {
  title: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="cf-inset p-3.5 flex items-center justify-between gap-3 flex-wrap">
      <div>
        <p className="text-sm font-semibold text-white">{title}</p>
        <p className="text-[11px] text-slate-500">{hint}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={onToggle}
        disabled={disabled}
        className="cf-btn !min-h-0 !py-1.5 text-xs"
      >
        {checked ? 'On' : 'Off'}
      </button>
    </div>
  );
}
