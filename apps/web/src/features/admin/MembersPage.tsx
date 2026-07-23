/**
 * Campaign members & roles — /c/:campaignId/members.
 * Mirrors design/claude-design/Campfire.dc.html "Players" (~1508-1559): an invite-link
 * card, live invite links, and a members table (role select + character link + remove).
 *
 * The invite card is backed by the campaign-invites API (issue #7): a DM generates a
 * /join/<code> link at a chosen role (player/viewer — never dm), copies it, and can
 * revoke it any time. Whoever opens the link creates their own account (or joins with
 * an existing one) and lands in this campaign — no server admin involved per player.
 *
 * Audit log kept (existing functionality, not in this design block).
 */
import { useCallback, useEffect, useState } from 'react';
import { useAnnounce } from '../../components/Announcer';
import { useNavigate, useParams } from 'react-router-dom';
import type { Character, CampaignMember, CampaignInvite, InviteRole, Role, AuditEntry, AuditActorRole } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { usePanelData } from '../../lib/usePanelData';
import { useAuth } from '../../app/auth';
import { useCampaigns } from '../../app/CampaignContext';
import { Card, Btn, TextInput, Skeleton, ErrorNote, EmptyState } from '../../components/ui';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { GameIcon } from '../../components/GameIcon';
import {
  INVITE_COPY_FAILURE,
  INVITE_COPY_SUCCESS,
  inviteLinkFieldLabel,
  inviteRoleOptions,
} from './inviteRoleOptions';

const ROLE_CHIP: Record<Role, string> = {
  dm: 'cf-chip-dm',
  player: 'cf-chip-party',
  viewer: 'cf-chip-private',
};
const ROLE_LABEL: Record<Role, string> = { dm: 'DM', player: 'Player', viewer: 'Viewer' };

export default function MembersPage() {
  const { campaignId } = useParams<{ campaignId: string }>();
  const id = Number(campaignId);
  const { roleIn, me } = useAuth();
  const role = roleIn(id);
  const myUserId = me?.user?.id ?? null;

  // Core content is the member roster — it drives the page. The character list
  // (for linking characters to members) and the audit log are AUXILIARY panels
  // (issue #697): each loads on its own, so a character or audit outage degrades
  // only its own card and never blanks the roster or maps to a page-level error.
  const [members, setMembers] = useState<CampaignMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const isDm = role === 'dm';

  // Auxiliary panels load independently with panel-scoped error/retry. A failure
  // here sets only `charactersPanel.error` / `auditPanel.error` — never the
  // page-level `error` above, and never a not-found state.
  const charactersPanel = usePanelData<Character[]>(
    useCallback(() => api.get<Character[]>(`${API}/campaigns/${id}/characters`), [id]),
    isDm,
    "Couldn't load characters for linking.",
  );
  const auditPanel = usePanelData<AuditEntry[]>(
    useCallback(() => api.get<AuditEntry[]>(`${API}/campaigns/${id}/audit`), [id]),
    isDm,
    "Couldn't load the audit log.",
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const m = await api.get<CampaignMember[]>(`${API}/campaigns/${id}/members`);
      setMembers(m);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load members.");
    } finally {
      setLoading(false);
    }
  }, [id]);

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
          <p className="flex justify-center text-[var(--color-neutral-400)]"><GameIcon slug="padlock" size={28} reserveSpace /></p>
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
        <YourMembershipCard campaignId={id} members={members ?? []} myUserId={myUserId} />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 mt-5 space-y-4 pb-20 md:pb-10" style={{ maxWidth: 760 }}>
      <h1 className="text-xl font-extrabold text-white m-0">Members</h1>
      {error && <ErrorNote message={error} onRetry={load} />}

      <InviteCard campaignId={id} />

      <MembersCard
        campaignId={id}
        members={members ?? []}
        characters={charactersPanel.data ?? []}
        charactersLoading={charactersPanel.loading}
        charactersError={charactersPanel.error}
        onRetryCharacters={charactersPanel.retry}
        onChange={load}
      />

      <Card className="space-y-3">
        <h2 className="font-bold text-white text-sm border-b border-slate-700 pb-2">Audit log</h2>
        {auditPanel.loading && !auditPanel.data && <Skeleton lines={3} />}
        {auditPanel.error && !auditPanel.data ? (
          <ErrorNote message={auditPanel.error} onRetry={auditPanel.retry} />
        ) : (
          <AuditList entries={auditPanel.data ?? []} members={members ?? []} />
        )}
      </Card>
    </div>
  );
}

function inviteLinkFor(code: string): string {
  return `${window.location.origin}/join/${code}`;
}

/** "expires in 6d" / "expires in 3h" — invites are short-lived, no need for finer grain. */
function expiresIn(iso: string): string {
  const msLeft = new Date(iso).getTime() - Date.now();
  if (msLeft <= 0) return 'expired';
  const hours = Math.ceil(msLeft / 3_600_000);
  if (hours < 24) return `expires in ${hours}h`;
  return `expires in ${Math.ceil(hours / 24)}d`;
}

/**
 * Invite-link generation + live links list, backed by /campaigns/:id/invites.
 * Anyone with a link self-onboards at the chosen role via /join/<code> (see
 * features/auth/JoinPage.tsx) — revoke a link here if it leaks.
 */
const INVITE_ROLE_SELECT_ID = 'invite-join-role';

function InviteCard({ campaignId }: { campaignId: number }) {
  const [invites, setInvites] = useState<CampaignInvite[]>([]);
  const [role, setRole] = useState<InviteRole>('player');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const announce = useAnnounce();

  const load = useCallback(async () => {
    try {
      setInvites(await api.get<CampaignInvite[]>(`${API}/campaigns/${campaignId}/invites`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load invites.");
    }
  }, [campaignId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setCreating(true);
    setError(null);
    try {
      await api.post<CampaignInvite>(`${API}/campaigns/${campaignId}/invites`, { role });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create the invite.");
    } finally {
      setCreating(false);
    }
  }

  async function revoke(inviteId: number) {
    setError(null);
    try {
      await api.delete(`${API}/campaigns/${campaignId}/invites/${inviteId}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't revoke the invite.");
    }
  }

  async function copy(invite: CampaignInvite) {
    try {
      await navigator.clipboard.writeText(inviteLinkFor(invite.code));
      setCopiedId(invite.id);
      // `error` is shared across create/revoke/copy for this card, so only
      // clear it here if it's the copy-failure message we set below —
      // otherwise a successful copy could silently dismiss an unrelated
      // create/revoke failure that's still unresolved.
      setError((current) => (current === INVITE_COPY_FAILURE ? null : current));
      announce(INVITE_COPY_SUCCESS);
      setTimeout(() => setCopiedId((current) => (current === invite.id ? null : current)), 1500);
    } catch {
      setCopiedId((current) => (current === invite.id ? null : current));
      announce(INVITE_COPY_FAILURE);
      setError(INVITE_COPY_FAILURE);
    }
  }

  return (
    <Card className="space-y-2.5" data-testid="invite-card">
      <p className="card-kicker mb-0">Invite</p>
      <div className="flex gap-2 flex-wrap items-end">
        <div className="field" style={{ minWidth: 110 }}>
          <label htmlFor={INVITE_ROLE_SELECT_ID}>Joins as</label>
          <select
            id={INVITE_ROLE_SELECT_ID}
            className="input"
            value={role}
            onChange={(e) => setRole(e.target.value as InviteRole)}
          >
            {inviteRoleOptions().map((opt) => (
              <option key={opt.role} value={opt.role}>
                {opt.description}
              </option>
            ))}
          </select>
        </div>
        <button className="btn btn-primary" style={{ minHeight: 36 }} onClick={create} disabled={creating}>
          {creating ? 'Generating…' : 'Generate invite link'}
        </button>
      </div>

      {error && <p className="text-xs text-rose-400 m-0">{error}</p>}

      {invites.map((invite) => {
        const linkFieldId = `invite-link-${invite.id}`;
        return (
        <div key={invite.id} className="flex gap-2 flex-wrap items-center">
          <div className="field !mb-0" style={{ flex: 1, minWidth: 190 }}>
            <label className="sr-only" htmlFor={linkFieldId}>
              {inviteLinkFieldLabel(invite.role, invite.id)}
            </label>
            <input
              id={linkFieldId}
              className="input"
              style={{ width: '100%' }}
              readOnly
              aria-readonly="true"
              value={inviteLinkFor(invite.code)}
              onFocus={(e) => e.currentTarget.select()}
            />
          </div>
          <span className={`cf-chip ${ROLE_CHIP[invite.role]}`}>{ROLE_LABEL[invite.role]}</span>
          <span className="text-muted text-[11px] whitespace-nowrap">
            {expiresIn(invite.expiresAt)} · used {invite.useCount}
            {invite.maxUses != null ? `/${invite.maxUses}` : '×'}
          </span>
          <button
            type="button"
            className="btn btn-primary"
            style={{ minHeight: 36 }}
            aria-label={`Copy ${inviteLinkFieldLabel(invite.role, invite.id)}`}
            onClick={() => copy(invite)}
          >
            {copiedId === invite.id ? 'Copied!' : 'Copy link'}
          </button>
          <button className="btn btn-ghost" style={{ minHeight: 36, fontSize: 12.5 }} onClick={() => revoke(invite.id)}>
            Revoke
          </button>
        </div>
        );
      })}

      <p className="text-muted text-[11.5px] m-0">
        Anyone with a link creates their own account (or signs in) and joins as the chosen role — no server
        admin needed. Links expire after 7 days; revoke one any time if it leaks.
      </p>
    </Card>
  );
}

function ReadOnlyMemberTable({ members }: { members: CampaignMember[] }) {
  if (members.length === 0) return <EmptyState icon="shield" title="No members yet" />;
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
                {m.disabled && <span className="ml-2 text-[10px] text-rose-400">disabled</span>}
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

/**
 * Player data rights (issue #128): a member's own controls on the campaign they
 * can see but not administer — export THEIR OWN data (characters/notes/proposals),
 * and leave the campaign themselves. Distinct from the DM's campaign-wide export
 * (settings page, dm-only) and the DM's remove-member control above.
 */
function YourMembershipCard({
  campaignId,
  members,
  myUserId,
}: {
  campaignId: number;
  members: CampaignMember[];
  myUserId: number | null;
}) {
  const navigate = useNavigate();
  const { refresh: refreshCampaigns } = useCampaigns();
  const [confirming, setConfirming] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const myMember = myUserId != null ? members.find((m) => m.userId === myUserId) : undefined;
  if (!myMember) return null;

  async function leave() {
    if (!myMember) return;
    setLeaving(true);
    setError(null);
    try {
      await api.delete(`${API}/campaigns/${campaignId}/members/${myMember.id}`);
      await refreshCampaigns();
      navigate('/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't leave the campaign.");
      setLeaving(false);
      setConfirming(false);
    }
  }

  return (
    <Card className="space-y-2.5">
      <p className="card-kicker mb-0">Your data</p>
      <p className="text-muted text-[11.5px] m-0">
        Take a copy of what's yours, or leave the table. Your export includes only the characters you own, the
        notes you wrote and the proposals you submitted — not the DM's secrets or anyone else's private data.
      </p>
      {error && <p className="text-xs text-rose-400 m-0">{error}</p>}
      <div className="flex gap-2 flex-wrap items-center">
        <a
          className="btn btn-secondary"
          style={{ fontSize: 12.5 }}
          href={`${API}/campaigns/${campaignId}/export/me`}
        >
          ⬇ Export my data
        </a>
        <button
          type="button"
          className="btn btn-ghost btn-danger"
          style={{ fontSize: 12.5 }}
          onClick={() => setConfirming(true)}
        >
          Leave campaign…
        </button>
      </div>
      <p className="text-muted text-[11px] m-0">
        Leaving closes your seat. Character sheets you own stay with the campaign (they're just un-owned); your
        notes stay too. A sole DM must hand off DM before leaving.
      </p>
      {confirming && (
        <ConfirmDialog
          title="Leave this campaign?"
          body="You'll lose access to it. Export your data first if you want a copy."
          confirmLabel={leaving ? 'Leaving…' : 'Leave'}
          busy={leaving}
          onConfirm={leave}
          onCancel={() => setConfirming(false)}
        />
      )}
    </Card>
  );
}

function MembersCard({
  campaignId,
  members,
  characters,
  charactersLoading,
  charactersError,
  onRetryCharacters,
  onChange,
}: {
  campaignId: number;
  members: CampaignMember[];
  characters: Character[];
  charactersLoading: boolean;
  charactersError: string | null;
  onRetryCharacters: () => void;
  onChange: () => void;
}) {
  // A failed character roster reads as an empty list. Without this flag the
  // per-member character select would still render (with only "— unlinked —"),
  // and a DM could silently unlink a member from its character by saving the
  // "empty" selection. We block the select entirely while the roster is
  // unavailable so a failed load can never clear an assignment (#697 review).
  const charactersUnavailable = !!charactersError;
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

      {/* Character roster is auxiliary (#697): if it fails to load, the roster still
          renders; linking is just unavailable until retry succeeds. */}
      {charactersError && (
        <ErrorNote message={charactersError} onRetry={onRetryCharacters} />
      )}

      {members.length === 0 ? (
        <EmptyState icon="shield" title="No members yet" hint="Add one above." />
      ) : (
        <div className="flex flex-col">
          {members.map((m) => (
            <MemberRow
              key={m.id}
              campaignId={campaignId}
              member={m}
              characters={characters}
              charactersLoading={charactersLoading}
              charactersUnavailable={charactersUnavailable}
              onChange={onChange}
              onError={setError}
            />
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
  charactersLoading,
  charactersUnavailable,
  onChange,
  onError,
}: {
  campaignId: number;
  member: CampaignMember;
  characters: Character[];
  charactersLoading: boolean;
  charactersUnavailable: boolean;
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

  // Two fields can describe "who plays this character": the membership pointer
  // (campaignMembers.characterId) and character ownership (characters.ownerUserId).
  // Ownership is authoritative app-wide — it drives edit rights, inventory and
  // encounters, and it's what the character sheet's "played by …" shows. The
  // membership pointer is normally kept in sync, but a direct DM ownerUserId change
  // (PATCH /characters/:id) leaves it stale, which read as a contradiction (issue
  // #274): sheet says "played by Pete" while Members said "— unlinked —". Fall back
  // to the owned character so both surfaces agree.
  const linkedCharacter = characters.find((c) => c.id === member.characterId);
  const ownedCharacter = characters.find(
    (c) => c.ownerUserId != null && c.ownerUserId === String(member.userId),
  );
  const character = linkedCharacter ?? ownedCharacter;

  return (
    <div className="flex items-center gap-2.5 py-2.5 flex-wrap" style={{ borderTop: '1px solid var(--color-divider)' }}>
      <span className="h-8 w-8 shrink-0 rounded-full bg-[var(--color-neutral-900)] border border-[var(--color-divider)] flex items-center justify-center text-[12px] text-[var(--color-neutral-300)]">
        {(member.displayName || member.username || '?').slice(0, 1).toUpperCase()}
      </span>
      <div className="min-w-0">
        <p className="text-[13.5px] m-0 flex items-center gap-1.5">
          {member.displayName || member.username}
          {member.disabled && <span className="text-[10px] text-rose-400">disabled</span>}
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
        <option value="dm" disabled={member.disabled}>dm</option>
        <option value="player">player</option>
        <option value="viewer">viewer</option>
      </select>
      <select
        className="cf-select !min-h-0 !py-1 text-xs"
        style={{ width: 130 }}
        value={character?.id ?? ''}
        disabled={savingChar || charactersLoading || charactersUnavailable}
        title={
          charactersUnavailable
            ? "Character roster didn't load — retry above before changing links."
            : undefined
        }
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
        Add someone who already has an account on this server by username. To bring in someone new, send them
        an invite link from the Invite card above instead.
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

// Issue #526: actorRole is now AuditActorRole (dm/player/viewer + the 'admin'
// sentinel). This per-campaign audit list only ever sees campaign-scoped rows,
// so 'admin' won't legitimately appear here (admin actions are server-scoped
// and live on /admin/audit) — but key the full widened type and give 'admin' a
// distinct icon so a stray value renders gracefully instead of `undefined`.
const ACTOR_ICON: Record<AuditActorRole, string> = { dm: 'top-hat', player: 'person', viewer: 'person', admin: 'crown' };

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
  if (entries.length === 0) return <EmptyState icon="scroll-unfurled" title="No activity yet" />;
  return (
    <ul className="text-xs space-y-2 text-slate-400">
      {entries.slice(0, 20).map((e) => {
        const { label, isToken } = resolveActorLabel(e.actor, members);
        return (
          <li key={e.id}>
            <span className="text-slate-600">{timeAgo(e.createdAt)}</span> <GameIcon slug={ACTOR_ICON[e.actorRole]} size={12} className="inline align-text-bottom" />{' '}
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
