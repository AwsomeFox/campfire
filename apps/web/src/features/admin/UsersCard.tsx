/**
 * Users management card — extracted from AdminPage.tsx to its own file as part
 * of the /admin/* page split (issue #350). Lives on /admin/users. Unchanged
 * behavior from the original inline component: create/edit/disable/delete
 * users, plus an inline one-time password reset.
 */
import { useState } from 'react';
import type { ServerRole, User } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { Card, Btn, TextInput, EmptyState } from '../../components/ui';
import { ConfirmDialog } from '../../components/ConfirmDialog';

export function UsersCard({ users, onChange }: { users: User[]; onChange: () => void }) {
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
              <p className="text-sm text-emerald-400">Password updated. Signed out of all sessions and revoked all access tokens.</p>
              <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={onClose}>
                Close
              </Btn>
            </div>
          ) : (
            <>
              <p className="text-xs text-muted">
                This is an incident-response reset: it signs the user out of every session and revokes all their access
                tokens, so no pre-existing credential survives.
              </p>
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
