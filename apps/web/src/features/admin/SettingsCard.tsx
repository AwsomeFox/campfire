/**
 * Server sign-in settings card (signup/local-login toggles) — extracted from
 * AdminPage.tsx as part of the /admin/* page split (issue #350). Lives on
 * /admin/users.
 */
import { useState } from 'react';
import type { ServerSettings } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { Card } from '../../components/ui';

export function SettingsCard({ settings, onChange }: { settings: ServerSettings | null; onChange: () => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(key: 'allowLocalLogin' | 'allowSignup') {
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
