/**
 * Users management card — extracted from AdminPage.tsx to its own file as part
 * of the /admin/* page split (issue #350). Lives on /admin/users. Supports an
 * accessible new-user dialog, inline edit/disable/delete controls, and an
 * inline one-time password reset.
 */
import { useId, useState, type FormEvent } from 'react';
import type { ServerRole, User } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { Card, Btn, TextInput, EmptyState } from '../../components/ui';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useDialog } from '../../components/useDialog';

export function UsersCard({ users, onChange }: { users: User[]; onChange: () => void }) {
  const [showNew, setShowNew] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [resetId, setResetId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between border-b border-slate-700 pb-3">
        <h2 className="font-bold text-white text-sm">Users</h2>
        <Btn
          type="button"
          className="!min-h-0 !py-1.5 text-xs"
          aria-haspopup="dialog"
          aria-expanded={showNew}
          onClick={() => {
            setError(null);
            setShowNew(true);
          }}
        >
          + New user
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
        />
      )}

      {users.length === 0 ? (
        <EmptyState icon="person" title="No users yet" hint="Create the first account above." />
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
}: {
  onCancel: () => void;
  onCreated: () => void;
}) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [serverRole, setServerRole] = useState<ServerRole>('user');
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ username?: string; password?: string }>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  const idPrefix = useId();
  const titleId = `${idPrefix}-title`;
  const descriptionId = `${idPrefix}-description`;
  const usernameId = `${idPrefix}-username`;
  const usernameHelpId = `${idPrefix}-username-help`;
  const usernameErrorId = `${idPrefix}-username-error`;
  const displayNameId = `${idPrefix}-display-name`;
  const displayNameHelpId = `${idPrefix}-display-name-help`;
  const passwordId = `${idPrefix}-password`;
  const passwordHelpId = `${idPrefix}-password-help`;
  const passwordErrorId = `${idPrefix}-password-error`;
  const roleId = `${idPrefix}-role`;
  const roleHelpId = `${idPrefix}-role-help`;

  const dialogRef = useDialog<HTMLDivElement>({ onClose: onCancel, disabled: saving });

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    const trimmedUsername = username.trim();
    const errors: { username?: string; password?: string } = {};
    if (!trimmedUsername) {
      errors.username = 'Enter a username.';
    } else if (trimmedUsername.length < 2) {
      errors.username = 'Username must be at least 2 characters.';
    } else if (!/^[a-z0-9_.-]+$/i.test(trimmedUsername)) {
      errors.username = 'Use only letters, numbers, underscores, periods, and hyphens.';
    }
    if (!password) {
      errors.password = 'Enter a password.';
    } else if (password.length < 8) {
      errors.password = 'Password must be at least 8 characters.';
    }

    setFieldErrors(errors);
    setSubmitError(null);
    if (errors.username || errors.password) {
      document.getElementById(errors.username ? usernameId : passwordId)?.focus();
      return;
    }

    setSaving(true);
    try {
      await api.post(`${API}/users`, {
        username: trimmedUsername,
        password,
        displayName: displayName.trim() || undefined,
        serverRole,
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setFieldErrors({ username: 'That username is already in use.' });
        document.getElementById(usernameId)?.focus();
      } else {
        setSubmitError(err instanceof ApiError ? err.message : "Couldn't create user.");
      }
      setSaving(false);
      return;
    }

    // Success closes and unmounts the dialog. Do not schedule another local
    // state update after handing lifecycle ownership back to the parent.
    onCreated();
  }

  return (
    <div className="dialog-backdrop" style={{ zIndex: 50 }} onClick={() => !saving && onCancel()}>
      <div
        ref={dialogRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={saving}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="dialog-title" id={titleId}>New user</h2>
        <p className="dialog-body" id={descriptionId}>
          Create a Campfire account. You can add the user to campaigns after creation.
        </p>

        <form className="space-y-3" onSubmit={create} noValidate>
          <div className="field">
            <label htmlFor={usernameId}>Username</label>
            <TextInput
              id={usernameId}
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
                setFieldErrors((current) => ({ ...current, username: undefined }));
              }}
              autoComplete="username"
              minLength={2}
              maxLength={60}
              pattern="[A-Za-z0-9_.-]+"
              required
              aria-invalid={!!fieldErrors.username}
              aria-describedby={`${usernameHelpId}${fieldErrors.username ? ` ${usernameErrorId}` : ''}`}
            />
            <p id={usernameHelpId} className="mt-1 text-xs text-slate-400">
              2–60 characters; letters, numbers, underscores, periods, and hyphens.
            </p>
            {fieldErrors.username && (
              <p id={usernameErrorId} role="alert" className="mt-1 text-xs text-rose-400">
                {fieldErrors.username}
              </p>
            )}
          </div>

          <div className="field">
            <label htmlFor={displayNameId}>
              Display name <span className="text-slate-400 normal-case tracking-normal">· optional</span>
            </label>
            <TextInput
              id={displayNameId}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              autoComplete="name"
              maxLength={120}
              aria-describedby={displayNameHelpId}
            />
            <p id={displayNameHelpId} className="mt-1 text-xs text-slate-400">
              Shown to other Campfire users instead of the username.
            </p>
          </div>

          <div className="field">
            <label htmlFor={passwordId}>Temporary password</label>
            <TextInput
              id={passwordId}
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setFieldErrors((current) => ({ ...current, password: undefined }));
              }}
              autoComplete="new-password"
              minLength={8}
              maxLength={200}
              required
              aria-invalid={!!fieldErrors.password}
              aria-describedby={`${passwordHelpId}${fieldErrors.password ? ` ${passwordErrorId}` : ''}`}
            />
            <p id={passwordHelpId} className="mt-1 text-xs text-slate-400">
              At least 8 characters. Share it with the user through a secure channel.
            </p>
            {fieldErrors.password && (
              <p id={passwordErrorId} role="alert" className="mt-1 text-xs text-rose-400">
                {fieldErrors.password}
              </p>
            )}
          </div>

          <div className="field">
            <label htmlFor={roleId}>Server role</label>
            <select
              id={roleId}
              className="cf-select"
              value={serverRole}
              onChange={(e) => setServerRole(e.target.value as ServerRole)}
              aria-describedby={roleHelpId}
            >
              <option value="user">User</option>
              <option value="admin">Admin</option>
            </select>
            <p id={roleHelpId} className="mt-1 text-xs text-slate-400">
              Admins can manage server settings and user accounts.
            </p>
          </div>

          {submitError && <p role="alert" className="text-sm text-rose-400">{submitError}</p>}

          <div className="dialog-actions">
            <Btn
              ghost
              type="button"
              aria-label="Cancel creating user"
              onClick={onCancel}
              disabled={saving}
            >
              Cancel
            </Btn>
            <Btn type="submit" disabled={saving}>
              {saving ? 'Creating…' : 'Create user'}
            </Btn>
          </div>
        </form>
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
