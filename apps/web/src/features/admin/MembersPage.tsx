/**
 * Campaign members & roles — /c/:campaignId/members.
 * Mirrors design/claude-design/Campfire.dc.html "Players" (~1508-1559): an invite-link
 * card, pending invites, and a members table (role select + character link + remove).
 *
 * Design gap: the invite-link card (generate/copy/regenerate a join link, "joins as"
 * role picker) and the pending-invites list have NO backing API — there is no invite/join
 * -token mechanism anywhere in apps/server (members are added today by looking up an
 * existing user's account and adding them directly, which IS wired below). The invite
 * card is rendered disabled with a "soon" tag rather than inventing an endpoint; pending
 * invites are omitted entirely since there's no way to have any. See report for details.
 *
 * Audit log kept (existing functionality, not in this design block).
 */
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { Character, CampaignMember, Role, AuditEntry } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { Card, Btn, TextInput, Skeleton, ErrorNote, EmptyState } from '../../components/ui';
import { ConfirmDialog } from '../../components/ConfirmDialog';

const ROLE_CHIP: Record<Role, string> = {
  dm: 'cf-chip-dm',
  player: 'cf-chip-party',
  viewer: 'cf-chip-private',
};
const ROLE_LABEL: Record<Role, string> = { dm: 'DM', player: 'Player', viewer: 'Viewer' };

export default function MembersPage() {
  const { campaignId } = useParams<{ campaignId: string }>();
  const id = Number(campaignId);
  const { roleIn, isAdmin } = useAuth();
  const role = roleIn(id);

  const [members, setMembers] = useState<CampaignMember[] | null>(null);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const isDm = role === 'dm';

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (isDm) {
        const [m, c, a] = await Promise.all([
          api.get<CampaignMember[]>(`${API}/campaigns/${id}/members`),
          api.get<Character[]>(`${API}/campaigns/${id}/characters`),
          api.get<AuditEntry[]>(`${API}/campaigns/${id}/audit`),
        ]);
        setMembers(m);
        setCharacters(c);
        setAudit(a);
      } else {
        const m = await api.get<CampaignMember[]>(`${API}/campaigns/${id}/members`);
        setMembers(m);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load members.");
    } finally {
      setLoading(false);
    }
  }, [id, isDm]);

  useEffect(() => {
    if (Number.isFinite(id) && role) void load();
  }, [id, role, load]);

  if (!Number.isFinite(id)) {
    return (
      <div className="max-w-4xl mx-auto px-4 mt-5">
        <ErrorNote message="No campaign selected." />
      </div>
    );
  }

  if (!role) {
    return (
      <div className="max-w-4xl mx-auto px-4 mt-5">
        <Card className="text-center space-y-1">
          <p className="text-2xl">🔒</p>
          <p className="text-sm text-slate-300 font-semibold">You're not a member of this campaign</p>
        </Card>
      </div>
    );
  }

  if (loading && !members) {
    return (
      <div className="max-w-4xl mx-auto px-4 mt-5 space-y-5">
        <Card>
          <Skeleton lines={4} />
        </Card>
      </div>
    );
  }

  if (error && !members) {
    return (
      <div className="max-w-4xl mx-auto px-4 mt-5">
        <ErrorNote message={error} onRetry={load} />
      </div>
    );
  }

  if (!isDm) {
    return (
      <div className="max-w-4xl mx-auto px-4 mt-5 space-y-5 pb-20 md:pb-10">
        <h1 className="text-xl font-extrabold text-white">Members</h1>
        {error && <ErrorNote message={error} onRetry={load} />}
        <Card className="space-y-3">
          <h2 className="font-bold text-white text-sm border-b border-slate-700 pb-2">Members</h2>
          <ReadOnlyMemberTable members={members ?? []} />
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 mt-5 space-y-4 pb-20 md:pb-10" style={{ maxWidth: 760 }}>
      <h1 className="text-xl font-extrabold text-white m-0">Members</h1>
      {error && <ErrorNote message={error} onRetry={load} />}

      {!isAdmin && (
        <div className="cf-inset border-amber-500/30 p-3.5">
          <p className="text-[12.5px] text-amber-200/90 m-0">
            <strong>Players need an account first</strong> — ask a server admin to create one at Admin → Users,
            then add them here by username.
          </p>
        </div>
      )}

      <InviteCard />

      <MembersCard campaignId={id} members={members ?? []} characters={characters} onChange={load} />

      <Card className="space-y-3">
        <h2 className="font-bold text-white text-sm border-b border-slate-700 pb-2">Audit log</h2>
        <AuditList entries={audit ?? []} members={members ?? []} />
      </Card>
    </div>
  );
}

/**
 * Invite-link generation ("+ Invite to <campaign>") — no backing API. There is no
 * join-token/invite mechanism anywhere in apps/server/src; members are added today via
 * direct username/display-name lookup (see MembersCard/AddMemberForm below, which IS wired).
 * Rendered disabled with a "soon" tag rather than inventing an endpoint.
 */
function InviteCard() {
  return (
    <Card className="space-y-2.5">
      <div className="flex items-center gap-2">
        <p className="card-kicker mb-0">Invite</p>
        <span className="tag tag-neutral" style={{ fontSize: 9 }}>soon</span>
      </div>
      <div className="flex gap-2 flex-wrap items-end opacity-50 pointer-events-none">
        <div className="field" style={{ flex: 1, minWidth: 190 }}>
          <label>Invite link</label>
          <input className="input" disabled value="Invite links aren't available yet" />
        </div>
        <div className="field" style={{ minWidth: 110 }}>
          <label>Joins as</label>
          <select className="input" disabled>
            <option>player</option>
            <option>viewer</option>
          </select>
        </div>
        <button className="btn btn-primary" disabled style={{ minHeight: 36 }}>
          Copy link
        </button>
      </div>
      <p className="text-muted text-[11.5px] m-0">
        Add players below by looking up their existing account — invite links are on the roadmap.
      </p>
    </Card>
  );
}

function ReadOnlyMemberTable({ members }: { members: CampaignMember[] }) {
  if (members.length === 0) return <EmptyState icon="🛡" title="No members yet" />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[10px] uppercase text-slate-500 text-left">
            <th className="py-2 pr-4 font-bold">User</th>
            <th className="pr-4 font-bold">Role</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800">
          {members.map((m) => (
            <tr key={m.id}>
              <td className="py-2.5 pr-4">
                <span className="font-semibold text-white">{m.displayName || m.username}</span>
              </td>
              <td className="pr-4">
                <span className={`cf-chip ${ROLE_CHIP[m.role]}`}>{ROLE_LABEL[m.role]}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MembersCard({
  campaignId,
  members,
  characters,
  onChange,
}: {
  campaignId: number;
  members: CampaignMember[];
  characters: Character[];
  onChange: () => void;
}) {
  const [showAdd, setShowAdd] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Card className="space-y-2.5">
      <div className="flex items-center gap-2">
        <p className="card-kicker mb-0">Members</p>
        <Btn className="!min-h-0 !py-1.5 text-xs ml-auto" onClick={() => setShowAdd((v) => !v)}>
          {showAdd ? 'Cancel' : '+ Add member'}
        </Btn>
      </div>

      {error && <p className="text-xs text-rose-400">{error}</p>}

      {showAdd && (
        <AddMemberForm
          campaignId={campaignId}
          existingUserIds={members.map((m) => m.userId)}
          onCancel={() => setShowAdd(false)}
          onAdded={() => {
            setShowAdd(false);
            onChange();
          }}
          onError={setError}
        />
      )}

      {members.length === 0 ? (
        <EmptyState icon="🛡" title="No members yet" hint="Add one above." />
      ) : (
        <div className="flex flex-col">
          {members.map((m) => (
            <MemberRow key={m.id} campaignId={campaignId} member={m} characters={characters} onChange={onChange} onError={setError} />
          ))}
        </div>
      )}
      <p className="text-[11px] text-slate-500">
        Linking a character makes that player its owner, so they can edit its sheet. Removing someone keeps
        their character and notes — the seat just closes.
      </p>
    </Card>
  );
}

function MemberRow({
  campaignId,
  member,
  characters,
  onChange,
  onError,
}: {
  campaignId: number;
  member: CampaignMember;
  characters: Character[];
  onChange: () => void;
  onError: (msg: string | null) => void;
}) {
  const [savingRole, setSavingRole] = useState(false);
  const [savingChar, setSavingChar] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  async function changeRole(role: Role) {
    setSavingRole(true);
    onError(null);
    try {
      await api.patch(`${API}/campaigns/${campaignId}/members/${member.id}`, { role });
      onChange();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Couldn't update role.");
    } finally {
      setSavingRole(false);
    }
  }

  async function changeCharacter(characterId: number | null) {
    setSavingChar(true);
    onError(null);
    try {
      await api.patch(`${API}/campaigns/${campaignId}/members/${member.id}`, { characterId });
      onChange();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Couldn't link character.");
    } finally {
      setSavingChar(false);
    }
  }

  async function remove() {
    setRemoving(true);
    onError(null);
    try {
      await api.delete(`${API}/campaigns/${campaignId}/members/${member.id}`);
      setConfirmingRemove(false);
      onChange();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Couldn't remove member.");
    } finally {
      setRemoving(false);
    }
  }

  const character = characters.find((c) => c.id === member.characterId);

  return (
    <div className="flex items-center gap-2.5 py-2.5 flex-wrap" style={{ borderTop: '1px solid var(--color-divider)' }}>
      <span className="h-8 w-8 shrink-0 rounded-full bg-[var(--color-neutral-900)] border border-[var(--color-divider)] flex items-center justify-center text-[12px] text-[var(--color-neutral-300)]">
        {(member.displayName || member.username || '?').slice(0, 1).toUpperCase()}
      </span>
      <div className="min-w-0">
        <p className="text-[13.5px] m-0 flex items-center gap-1.5">
          {member.displayName || member.username}
        </p>
        <p className="text-muted text-[11px] m-0">{character?.name || 'no character linked'}</p>
      </div>
      <div className="flex-1" />
      <select
        className="cf-select !min-h-0 !py-1 text-xs"
        style={{ width: 96 }}
        value={member.role}
        disabled={savingRole}
        onChange={(e) => changeRole(e.target.value as Role)}
      >
        <option value="dm">dm</option>
        <option value="player">player</option>
        <option value="viewer">viewer</option>
      </select>
      <select
        className="cf-select !min-h-0 !py-1 text-xs"
        style={{ width: 130 }}
        value={member.characterId ?? ''}
        disabled={savingChar}
        onChange={(e) => changeCharacter(e.target.value ? Number(e.target.value) : null)}
      >
        <option value="">— unlinked —</option>
        {characters.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <button type="button" className="text-[12px] text-slate-500 hover:text-rose-400" onClick={() => setConfirmingRemove(true)}>
        Remove
      </button>
      {confirmingRemove && (
        <ConfirmDialog
          title={`Remove ${member.displayName || member.username} from this campaign?`}
          confirmLabel={removing ? 'Removing…' : 'Remove'}
          busy={removing}
          onConfirm={remove}
          onCancel={() => setConfirmingRemove(false)}
        />
      )}
    </div>
  );
}

interface LookupUser {
  id: number;
  username: string;
  displayName: string;
}

function AddMemberForm({
  campaignId,
  existingUserIds,
  onCancel,
  onAdded,
  onError,
}: {
  campaignId: number;
  existingUserIds: number[];
  onCancel: () => void;
  onAdded: () => void;
  onError: (msg: string | null) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<LookupUser[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<LookupUser | null>(null);
  const [role, setRole] = useState<Role>('player');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (selected) return; // don't re-search after picking
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    setSearching(true);
    const handle = setTimeout(async () => {
      try {
        const found = await api.get<LookupUser[]>(`${API}/users/lookup?query=${encodeURIComponent(q)}`);
        setResults(found.filter((u) => !existingUserIds.includes(u.id)));
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(handle);
  }, [query, selected, existingUserIds]);

  async function add() {
    if (!selected) return;
    setSaving(true);
    onError(null);
    try {
      await api.post(`${API}/campaigns/${campaignId}/members`, { userId: selected.id, role });
      onAdded();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Couldn't add member.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="cf-inset border-amber-500/30 p-3.5 space-y-2">
      <p className="text-[10px] font-bold text-amber-500 uppercase tracking-widest">Add member</p>
      <p className="text-[12px] text-amber-200/90 cf-inset !border-amber-500/20 px-2.5 py-2">
        Accounts are created by a server admin (Admin → Users). Once an account exists, add it to this campaign
        below by username.
      </p>
      {selected ? (
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <p className="text-sm text-white">
            {selected.displayName || selected.username} <span className="text-slate-500">{selected.username}</span>
          </p>
          <button
            type="button"
            className="text-[11px] text-slate-500 hover:text-white"
            onClick={() => {
              setSelected(null);
              setQuery('');
            }}
          >
            change
          </button>
        </div>
      ) : (
        <div className="space-y-1">
          <TextInput
            className="!min-h-0 !py-2 text-sm"
            placeholder="Search by username or display name…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {searching && <p className="text-[11px] text-slate-500">Searching…</p>}
          {!searching && query.trim().length >= 2 && results.length === 0 && (
            <p className="text-[11px] text-slate-500">No matching users.</p>
          )}
          {results.length > 0 && (
            <ul className="cf-inset divide-y divide-slate-800">
              {results.map((u) => (
                <li key={u.id}>
                  <button
                    type="button"
                    className="w-full text-left px-3 py-2 text-sm text-slate-200 hover:bg-slate-800/60"
                    onClick={() => setSelected(u)}
                  >
                    {u.displayName || u.username} <span className="text-slate-500">{u.username}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="grid sm:grid-cols-3 gap-2">
        <select className="cf-select !min-h-0 !py-2 text-sm" value={role} onChange={(e) => setRole(e.target.value as Role)}>
          <option value="dm">Role: DM</option>
          <option value="player">Role: Player</option>
          <option value="viewer">Role: Viewer</option>
        </select>
      </div>
      <div className="flex gap-2 justify-end">
        <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={onCancel} disabled={saving}>
          Cancel
        </Btn>
        <Btn className="!min-h-0 !py-1.5 text-xs" onClick={add} disabled={saving || !selected}>
          Add
        </Btn>
      </div>
    </div>
  );
}

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

const ACTOR_ICON: Record<Role, string> = { dm: '🎩', player: '👤', viewer: '👤' };

/**
 * Resolve an AuditEntry.actor (see auditActor() in apps/server/src/common/user.types.ts)
 * to something human-readable:
 *  - `token:<name>` → PAT actor, rendered as-is with a subtle "token" tag
 *  - a plain user id string that matches a campaign member's userId → that member's
 *    displayName || username
 *  - anything else (e.g. a user id no longer in this campaign) → falls back to `#id`
 */
function resolveActorLabel(actor: string, members: CampaignMember[]): { label: string; isToken: boolean } {
  if (actor.startsWith('token:')) {
    return { label: actor.slice('token:'.length), isToken: true };
  }
  const member = members.find((m) => String(m.userId) === actor);
  if (member) {
    return { label: member.displayName || member.username || `#${actor}`, isToken: false };
  }
  return { label: `#${actor}`, isToken: false };
}

function AuditList({ entries, members }: { entries: AuditEntry[]; members: CampaignMember[] }) {
  if (entries.length === 0) return <EmptyState icon="📜" title="No activity yet" />;
  return (
    <ul className="text-xs space-y-2 text-slate-400">
      {entries.slice(0, 20).map((e) => {
        const { label, isToken } = resolveActorLabel(e.actor, members);
        return (
          <li key={e.id}>
            <span className="text-slate-600">{timeAgo(e.createdAt)}</span> {ACTOR_ICON[e.actorRole]}{' '}
            <b className="text-slate-300">{label}</b>{' '}
            {isToken && (
              <span className="tag tag-neutral" style={{ fontSize: 9 }}>
                token
              </span>
            )}{' '}
            {e.action}
            {e.detail && <span className="text-slate-500"> — {e.detail}</span>}
          </li>
        );
      })}
    </ul>
  );
}
