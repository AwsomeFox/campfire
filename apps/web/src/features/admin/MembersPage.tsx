/**
 * Campaign members & roles — /c/:campaignId/members.
 * Mirrors design/10-admin.html "Members & roles" section, adapted: no Authentik
 * groups yet (local accounts), audit log added per this round's scope.
 */
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { Character, CampaignMember, Role, AuditEntry } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { Card, Btn, TextInput, Skeleton, ErrorNote, EmptyState } from '../../components/ui';

const ROLE_CHIP: Record<Role, string> = {
  dm: 'cf-chip-dm',
  player: 'cf-chip-party',
  viewer: 'cf-chip-private',
};
const ROLE_LABEL: Record<Role, string> = { dm: 'DM', player: 'Player', viewer: 'Viewer' };

export default function MembersPage() {
  const { campaignId } = useParams<{ campaignId: string }>();
  const id = Number(campaignId);
  const { roleIn } = useAuth();
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
        <h1 className="text-xl font-extrabold text-white">🛡 Members</h1>
        {error && <ErrorNote message={error} onRetry={load} />}
        <Card className="space-y-3">
          <h2 className="font-bold text-white text-sm border-b border-slate-700 pb-2">Party</h2>
          <ReadOnlyMemberTable members={members ?? []} />
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 mt-5 space-y-5 pb-20 md:pb-10">
      <h1 className="text-xl font-extrabold text-white">🛡 Campaign members</h1>
      {error && <ErrorNote message={error} onRetry={load} />}

      <MembersCard campaignId={id} members={members ?? []} characters={characters} onChange={load} />

      <Card className="space-y-3">
        <h2 className="font-bold text-white text-sm border-b border-slate-700 pb-2">Audit log</h2>
        <AuditList entries={audit ?? []} />
      </Card>
    </div>
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
    <Card className="space-y-3">
      <div className="flex items-center justify-between border-b border-slate-700 pb-3">
        <h2 className="font-bold text-white text-sm">Members &amp; roles</h2>
        <Btn className="!min-h-0 !py-1.5 text-xs" onClick={() => setShowAdd((v) => !v)}>
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
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] uppercase text-slate-500 text-left">
                <th className="py-2 pr-4 font-bold">User</th>
                <th className="pr-4 font-bold">Role</th>
                <th className="pr-4 font-bold">Character</th>
                <th></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {members.map((m) => (
                <MemberRow
                  key={m.id}
                  campaignId={campaignId}
                  member={m}
                  characters={characters}
                  onChange={onChange}
                  onError={setError}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[11px] text-slate-500">
        Players need an account first — a server admin creates one in Admin → Users.
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
    if (!confirm(`Remove ${member.displayName || member.username} from this campaign?`)) return;
    onError(null);
    try {
      await api.delete(`${API}/campaigns/${campaignId}/members/${member.id}`);
      onChange();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Couldn't remove member.");
    }
  }

  return (
    <tr>
      <td className="py-2.5 pr-4">
        <span className="font-semibold text-white">{member.displayName || member.username}</span>{' '}
        <span className="text-slate-600">{member.username}</span>
      </td>
      <td className="pr-4">
        <div className="flex items-center gap-2">
          <span className={`cf-chip ${ROLE_CHIP[member.role]}`}>{ROLE_LABEL[member.role]}</span>
          <select
            className="cf-select !min-h-0 !py-1 text-xs w-auto"
            value={member.role}
            disabled={savingRole}
            onChange={(e) => changeRole(e.target.value as Role)}
          >
            <option value="dm">DM</option>
            <option value="player">Player</option>
            <option value="viewer">Viewer</option>
          </select>
        </div>
      </td>
      <td className="pr-4">
        <select
          className="cf-select !min-h-0 !py-1 text-xs w-auto"
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
      </td>
      <td className="text-right">
        <button type="button" className="text-[11px] text-rose-500/80 hover:text-rose-400" onClick={remove}>
          remove
        </button>
      </td>
    </tr>
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
      <p className="text-[11px] text-slate-500">
        Players need an account first — a server admin creates one in Admin → Users.
      </p>
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

function AuditList({ entries }: { entries: AuditEntry[] }) {
  if (entries.length === 0) return <EmptyState icon="📜" title="No activity yet" />;
  return (
    <ul className="text-xs space-y-2 text-slate-400">
      {entries.slice(0, 20).map((e) => (
        <li key={e.id}>
          <span className="text-slate-600">{timeAgo(e.createdAt)}</span> {ACTOR_ICON[e.actorRole]}{' '}
          <b className="text-slate-300">{e.actor}</b> {e.action}
          {e.detail && <span className="text-slate-500"> — {e.detail}</span>}
        </li>
      ))}
    </ul>
  );
}
