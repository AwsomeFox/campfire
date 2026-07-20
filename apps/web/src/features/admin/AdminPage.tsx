/**
 * Server admin console — /admin (no campaignId; server-wide).
 * Mirrors design/10-admin.html layout/tone, adapted for this round's scope:
 * users + settings + members (PAT tokens shown as a disabled "coming soon" card).
 */
import { useCallback, useEffect, useState } from 'react';
import type { ServerRole, User, ServerSettings, Campaign, PasswordResetRequest, PasswordResetApproval, AuditEntry } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { Card, Btn, TextInput, Skeleton, ErrorNote, EmptyState } from '../../components/ui';
import { TokensCard } from './TokensCard';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { RulePacksCard } from './RulePacksCard';

export default function AdminPage() {
  const { isAdmin } = useAuth();

  const [users, setUsers] = useState<User[] | null>(null);
  const [settings, setSettings] = useState<ServerSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [u, s] = await Promise.all([
        api.get<User[]>(`${API}/users`),
        api.get<ServerSettings>(`${API}/settings`),
      ]);
      setUsers(u);
      setSettings(s);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load admin data.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAdmin) void load();
  }, [isAdmin, load]);

  if (!isAdmin) {
    return (
      <div className="max-w-4xl mx-auto px-4 mt-5">
        <Card className="text-center space-y-1">
          <p className="text-2xl">🔒</p>
          <p className="text-sm text-slate-300 font-semibold">Server admins only</p>
          <p className="text-xs text-slate-500">Ask a server admin if you need access to this console.</p>
        </Card>
      </div>
    );
  }

  if (loading && !users) {
    return (
      <div className="max-w-4xl mx-auto px-4 mt-5 space-y-5">
        <Card>
          <Skeleton lines={4} />
        </Card>
        <Card>
          <Skeleton lines={2} />
        </Card>
      </div>
    );
  }

  if (error && !users) {
    return (
      <div className="max-w-4xl mx-auto px-4 mt-5">
        <ErrorNote message={error} onRetry={load} />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 mt-5 space-y-5 pb-20 md:pb-10">
      <h1 className="text-xl font-extrabold text-white">⚙️ Server admin</h1>
      {error && <ErrorNote message={error} onRetry={load} />}

      <UsersCard users={users ?? []} onChange={load} />
      <ResetRequestsCard />
      <SettingsCard settings={settings} onChange={load} />
      <RulePacksCard />
      <TokensCard />
      <AuditLogCard />
      <BackupCard />
    </div>
  );
}

// ---------- Server admin audit log (#23) ----------

/**
 * Server-wide admin trail: account create/disable/delete, settings changes,
 * rule-pack installs, admin token mints (every audit row not tied to a
 * campaign). Read-only, newest-first, capped at 100 by the API.
 */
function AuditLogCard() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setEntries(await api.get<AuditEntry[]>(`${API}/admin/audit`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load the audit log.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between border-b border-slate-700 pb-2">
        <h2 className="font-bold text-white text-sm">Admin audit log</h2>
        <button type="button" className="text-[11px] text-slate-500 hover:text-white" onClick={() => void load()}>
          refresh
        </button>
      </div>
      {error && <p className="text-xs text-rose-400">{error}</p>}
      {!entries ? (
        <Skeleton lines={3} />
      ) : entries.length === 0 ? (
        <p className="text-xs text-slate-500">
          No server-wide admin actions logged yet. Creating or disabling users, changing settings, and installing
          rule packs will show up here.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] uppercase text-slate-500 text-left">
                <th className="py-2 pr-4 font-bold">When</th>
                <th className="pr-4 font-bold">Actor</th>
                <th className="pr-4 font-bold">Action</th>
                <th className="pr-4 font-bold">Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {entries.map((e) => (
                <tr key={e.id}>
                  <td className="py-2 pr-4 whitespace-nowrap text-slate-400">{new Date(e.createdAt).toLocaleString()}</td>
                  <td className="pr-4 text-slate-300">{e.actor}</td>
                  <td className="pr-4">
                    <code className="text-[11px] text-amber-400">{e.action}</code>
                  </td>
                  <td className="pr-4 text-slate-400 break-all">{e.detail || <span className="text-slate-600">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[11px] text-slate-500">Server-wide actions only — per-campaign history lives on each campaign.</p>
    </Card>
  );
}

// ---------- Users ----------

function UsersCard({ users, onChange }: { users: User[]; onChange: () => void }) {
  const [showNew, setShowNew] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [resetId, setResetId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between border-b border-slate-700 pb-3">
        <h2 className="font-bold text-white text-sm">Users</h2>
        <Btn className="!min-h-0 !py-1.5 text-xs" onClick={() => setShowNew((v) => !v)}>
          {showNew ? 'Cancel' : '+ New user'}
        </Btn>
      </div>

      {error && <p className="text-xs text-rose-400">{error}</p>}

      {showNew && (
        <NewUserForm
          onCancel={() => setShowNew(false)}
          onCreated={() => {
            setShowNew(false);
            onChange();
          }}
          onError={setError}
        />
      )}

      {users.length === 0 ? (
        <EmptyState icon="👤" title="No users yet" hint="Create the first account above." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] uppercase text-slate-500 text-left">
                <th className="py-2 pr-4 font-bold">Username</th>
                <th className="pr-4 font-bold">Display name</th>
                <th className="pr-4 font-bold">Role</th>
                <th className="pr-4 font-bold">Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {users.map((u) => (
                <UserRow
                  key={u.id}
                  user={u}
                  editing={editingId === u.id}
                  resetting={resetId === u.id}
                  onEdit={() => {
                    setEditingId(editingId === u.id ? null : u.id);
                    setResetId(null);
                  }}
                  onReset={() => {
                    setResetId(resetId === u.id ? null : u.id);
                    setEditingId(null);
                  }}
                  onClose={() => {
                    setEditingId(null);
                    setResetId(null);
                  }}
                  onChange={onChange}
                  onError={setError}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[11px] text-slate-500">
        This is how players &amp; DMs get accounts — create a user here, then add them to a campaign from that
        campaign&apos;s Members page.
      </p>
    </Card>
  );
}

function NewUserForm({
  onCancel,
  onCreated,
  onError,
}: {
  onCancel: () => void;
  onCreated: () => void;
  onError: (msg: string | null) => void;
}) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [serverRole, setServerRole] = useState<ServerRole>('user');
  const [saving, setSaving] = useState(false);

  async function create() {
    if (!username.trim() || password.length < 8) return;
    setSaving(true);
    onError(null);
    try {
      await api.post(`${API}/users`, {
        username: username.trim(),
        password,
        displayName: displayName.trim() || undefined,
        serverRole,
      });
      onCreated();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Couldn't create user.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="cf-inset border-amber-500/30 p-3.5 space-y-2">
      <p className="text-[10px] font-bold text-amber-500 uppercase tracking-widest">New user</p>
      <div className="grid sm:grid-cols-4 gap-2">
        <TextInput
          className="!min-h-0 !py-2 text-sm"
          placeholder="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <TextInput
          className="!min-h-0 !py-2 text-sm"
          placeholder="Display name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
        <TextInput
          className="!min-h-0 !py-2 text-sm"
          placeholder="Password (min 8 chars)"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <select
          className="cf-select !min-h-0 !py-2 text-sm"
          value={serverRole}
          onChange={(e) => setServerRole(e.target.value as ServerRole)}
        >
          <option value="user">Role: User</option>
          <option value="admin">Role: Admin</option>
        </select>
      </div>
      <div className="flex gap-2 justify-end">
        <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={onCancel} disabled={saving}>
          Cancel
        </Btn>
        <Btn
          className="!min-h-0 !py-1.5 text-xs"
          onClick={create}
          disabled={saving || !username.trim() || password.length < 8}
        >
          Create
        </Btn>
      </div>
    </div>
  );
}

function UserRow({
  user,
  editing,
  resetting,
  onEdit,
  onReset,
  onClose,
  onChange,
  onError,
}: {
  user: User;
  editing: boolean;
  resetting: boolean;
  onEdit: () => void;
  onReset: () => void;
  onClose: () => void;
  onChange: () => void;
  onError: (msg: string | null) => void;
}) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [serverRole, setServerRole] = useState<ServerRole>(user.serverRole);
  const [disabled, setDisabled] = useState(user.disabled);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  function startEdit() {
    setDisplayName(user.displayName);
    setServerRole(user.serverRole);
    setDisabled(user.disabled);
    onEdit();
  }

  async function save() {
    setSaving(true);
    onError(null);
    try {
      await api.patch(`${API}/users/${user.id}`, {
        displayName: displayName.trim(),
        serverRole,
        disabled,
      });
      onClose();
      onChange();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Couldn't update user.");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    setRemoving(true);
    onError(null);
    try {
      await api.delete(`${API}/users/${user.id}`);
      setConfirmingDelete(false);
      onChange();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Couldn't delete user.");
    } finally {
      setRemoving(false);
    }
  }

  return (
    <>
      <tr>
        <td className="py-2.5 pr-4 font-semibold text-white">{user.username}</td>
        <td className="pr-4 text-slate-400">{user.displayName || <span className="text-slate-600">—</span>}</td>
        <td className="pr-4">
          <span className={`cf-chip ${user.serverRole === 'admin' ? 'cf-chip-dm' : 'cf-chip-private'}`}>
            {user.serverRole === 'admin' ? 'Admin' : 'User'}
          </span>
        </td>
        <td className="pr-4">
          {user.disabled ? (
            <span className="cf-chip cf-chip-failed">Disabled</span>
          ) : (
            <span className="cf-chip cf-chip-completed">Active</span>
          )}
        </td>
        <td className="text-right whitespace-nowrap">
          <button type="button" className="text-[11px] text-slate-500 hover:text-white mr-3" onClick={startEdit}>
            edit ▾
          </button>
          <button type="button" className="text-[11px] text-slate-500 hover:text-white mr-3" onClick={onReset}>
            reset password
          </button>
          <button type="button" className="text-[11px] text-rose-500/80 hover:text-rose-400" onClick={() => setConfirmingDelete(true)}>
            delete
          </button>
          {confirmingDelete && (
            <ConfirmDialog
              title={`Delete user "${user.username}"?`}
              body="This cannot be undone."
              confirmLabel={removing ? 'Deleting…' : 'Delete user'}
              busy={removing}
              onConfirm={remove}
              onCancel={() => setConfirmingDelete(false)}
            />
          )}
        </td>
      </tr>
      {editing && (
        <tr>
          <td colSpan={5} className="pb-3">
            <div className="cf-inset p-3.5 space-y-2">
              <div className="grid sm:grid-cols-3 gap-2">
                <TextInput
                  className="!min-h-0 !py-2 text-sm"
                  placeholder="Display name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
                <select
                  className="cf-select !min-h-0 !py-2 text-sm"
                  value={serverRole}
                  onChange={(e) => setServerRole(e.target.value as ServerRole)}
                >
                  <option value="user">Role: User</option>
                  <option value="admin">Role: Admin</option>
                </select>
                <label className="flex items-center gap-2 text-sm text-slate-300">
                  <input type="checkbox" checked={disabled} onChange={(e) => setDisabled(e.target.checked)} />
                  Disabled
                </label>
              </div>
              <div className="flex gap-2 justify-end">
                <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={onClose} disabled={saving}>
                  Cancel
                </Btn>
                <Btn className="!min-h-0 !py-1.5 text-xs" onClick={save} disabled={saving}>
                  Save
                </Btn>
              </div>
            </div>
          </td>
        </tr>
      )}
      {resetting && <ResetPasswordRow userId={user.id} onClose={onClose} onError={onError} />}
    </>
  );
}

function ResetPasswordRow({
  userId,
  onClose,
  onError,
}: {
  userId: number;
  onClose: () => void;
  onError: (msg: string | null) => void;
}) {
  const [newPassword, setNewPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  async function submit() {
    if (newPassword.length < 8) return;
    setSaving(true);
    onError(null);
    try {
      await api.post(`${API}/users/${userId}/password`, { newPassword });
      setDone(true);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Couldn't reset password.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <tr>
      <td colSpan={5} className="pb-3">
        <div className="cf-inset border-amber-500/30 p-3.5 space-y-2">
          <p className="text-[10px] font-bold text-amber-500 uppercase tracking-widest">Reset password</p>
          {done ? (
            <div className="flex items-center justify-between">
              <p className="text-sm text-emerald-400">Password updated.</p>
              <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={onClose}>
                Close
              </Btn>
            </div>
          ) : (
            <>
              <div className="grid sm:grid-cols-3 gap-2">
                <TextInput
                  className="!min-h-0 !py-2 text-sm sm:col-span-2"
                  placeholder="New password (min 8 chars)"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
              </div>
              <div className="flex gap-2 justify-end">
                <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={onClose} disabled={saving}>
                  Cancel
                </Btn>
                <Btn
                  className="!min-h-0 !py-1.5 text-xs"
                  onClick={submit}
                  disabled={saving || newPassword.length < 8}
                >
                  Set password
                </Btn>
              </div>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}

// ---------- Password reset requests ----------

/**
 * Forgot-password (issue #10): users file requests from the login screen;
 * approving one mints a ONE-TIME reset code (shown here once) that the admin
 * relays out-of-band. The admin never learns the user's new password.
 */
function ResetRequestsCard() {
  const [requests, setRequests] = useState<PasswordResetRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  // Raw one-time codes by request id — only lives in this render; gone on reload.
  const [codes, setCodes] = useState<Record<number, PasswordResetApproval>>({});
  const [copiedId, setCopiedId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRequests(await api.get<PasswordResetRequest[]>(`${API}/users/reset-requests`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load reset requests.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function approve(id: number) {
    setBusyId(id);
    setError(null);
    try {
      const approval = await api.post<PasswordResetApproval>(`${API}/users/reset-requests/${id}/approve`);
      setCodes((prev) => ({ ...prev, [id]: approval }));
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't approve request.");
    } finally {
      setBusyId(null);
    }
  }

  async function dismiss(id: number) {
    setBusyId(id);
    setError(null);
    try {
      await api.delete(`${API}/users/reset-requests/${id}`);
      setCodes((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't dismiss request.");
    } finally {
      setBusyId(null);
    }
  }

  async function copy(id: number) {
    const approval = codes[id];
    if (!approval) return;
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/reset-password?code=${approval.code}`);
      setCopiedId(id);
      setTimeout(() => setCopiedId((v) => (v === id ? null : v)), 1500);
    } catch {
      /* clipboard unavailable — code is still visible to copy manually */
    }
  }

  return (
    <Card className="space-y-3">
      <h2 className="font-bold text-white text-sm border-b border-slate-700 pb-2">Password reset requests</h2>
      {error && <p className="text-xs text-rose-400">{error}</p>}
      {!requests || requests.length === 0 ? (
        <p className="text-xs text-slate-500">
          None right now. When someone taps &ldquo;Forgot password?&rdquo; on the sign-in screen, their request shows up
          here — approve it to get a one-time reset code to hand to them.
        </p>
      ) : (
        <div className="space-y-2">
          {requests.map((r) => (
            <div key={r.id} className="cf-inset p-3.5 space-y-2">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <p className="text-sm font-semibold text-white">
                    {r.username}
                    {r.displayName && <span className="text-slate-500 font-normal"> · {r.displayName}</span>}
                  </p>
                  <p className="text-[11px] text-slate-500">
                    Requested {new Date(r.requestedAt).toLocaleString()}
                    {r.status === 'approved' && r.expiresAt && (
                      <> · code expires {new Date(r.expiresAt).toLocaleTimeString()}</>
                    )}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Btn
                    className="!min-h-0 !py-1.5 text-xs"
                    onClick={() => approve(r.id)}
                    disabled={busyId === r.id}
                  >
                    {r.status === 'approved' ? 'New code' : 'Approve'}
                  </Btn>
                  <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={() => dismiss(r.id)} disabled={busyId === r.id}>
                    Dismiss
                  </Btn>
                </div>
              </div>
              {codes[r.id] && (
                <div className="border border-amber-500/30 rounded p-2.5 space-y-1">
                  <p className="text-[10px] font-bold text-amber-500 uppercase tracking-widest">
                    One-time reset code — shown once, give it to {codes[r.id].request.username} now
                  </p>
                  <div className="flex items-center gap-2 flex-wrap">
                    <code className="text-xs text-emerald-400 break-all">{codes[r.id].code}</code>
                    <Btn ghost className="!min-h-0 !py-1 text-[11px]" onClick={() => copy(r.id)}>
                      {copiedId === r.id ? 'Copied!' : 'Copy reset link'}
                    </Btn>
                  </div>
                  <p className="text-[11px] text-slate-500">
                    Expires {new Date(codes[r.id].expiresAt).toLocaleTimeString()} · single-use · they set their own
                    password at /reset-password.
                  </p>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ---------- Settings ----------

function SettingsCard({ settings, onChange }: { settings: ServerSettings | null; onChange: () => void }) {
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

// ---------- Backup & export ----------

function BackupCard() {
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [campaignId, setCampaignId] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const list = await api.get<Campaign[]>(`${API}/campaigns`);
        setCampaigns(list);
        if (list.length > 0) setCampaignId(String(list[0].id));
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Couldn't load campaigns.");
      }
    })();
  }, []);

  const canExport = Boolean(campaignId);

  return (
    <Card className="space-y-3">
      <h2 className="font-bold text-white text-sm border-b border-slate-700 pb-2">Backup &amp; export</h2>
      <p className="text-xs text-slate-400">Take everything with you — no lock-in.</p>
      {error && <p className="text-xs text-rose-400">{error}</p>}
      <select
        className="cf-select !min-h-0 !py-2 text-sm"
        value={campaignId}
        onChange={(e) => setCampaignId(e.target.value)}
        disabled={!campaigns || campaigns.length === 0}
      >
        {(campaigns ?? []).length === 0 ? (
          <option value="">No campaigns</option>
        ) : (
          campaigns!.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))
        )}
      </select>
      <div className="flex gap-2">
        <a
          className={`cf-btn cf-btn-ghost !min-h-0 !py-2 text-xs ${!canExport ? 'pointer-events-none opacity-50' : ''}`}
          href={canExport ? `${API}/campaigns/${campaignId}/export?format=json` : undefined}
        >
          ⬇ JSON export
        </a>
        <a
          className={`cf-btn cf-btn-ghost !min-h-0 !py-2 text-xs ${!canExport ? 'pointer-events-none opacity-50' : ''}`}
          href={canExport ? `${API}/campaigns/${campaignId}/export?format=mdzip` : undefined}
        >
          ⬇ Markdown zip
        </a>
      </div>
      <p className="text-[11px] text-slate-600">DM-only per campaign.</p>
    </Card>
  );
}
