/**
 * My notes — mirrors design/claude-design/Campfire.dc.html "My notes" (~1076-1101).
 * Route: /c/:campaignId/notes
 * Shows the caller's own notes (server visibility-filters to mine + shared-with-me).
 * Design: header + "+ New note", each note's visibility badge is tap-to-cycle
 * (private -> shared with DM -> shared with party -> private).
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Note } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { useCampaignAccessError } from '../../app/useCampaignAccessError';
import { Card, Chip, Btn, TextInput, EmptyState, Skeleton, ErrorNote, type ChipVariant } from '../../components/ui';
import { ConfirmDialog } from '../../components/ConfirmDialog';

type EntityTypeValue = Exclude<Note['entityType'], null>;

const visMeta: Record<Note['visibility'], { chip: ChipVariant; label: string; short: string }> = {
  private: { chip: 'private', label: '🔒 Private', short: '🔒 Private' },
  dm_shared: { chip: 'dm', label: '🎩 Shared with DM', short: '🎩 DM' },
  party_shared: { chip: 'party', label: '👥 Shared with party', short: '👥 Party' },
};

/** Design's tap-to-cycle order on a note's own visibility badge. */
const VIS_CYCLE: Record<Note['visibility'], Note['visibility']> = {
  private: 'dm_shared',
  dm_shared: 'party_shared',
  party_shared: 'private',
};

const entityRoute: Record<EntityTypeValue, string | null> = {
  quest: 'quests',
  npc: 'npcs',
  location: 'locations',
  character: 'characters',
  session: 'sessions',
  campaign: null, // links to campaign dashboard
};

const entityIcon: Record<EntityTypeValue, string> = {
  quest: '📜',
  npc: '🤝',
  location: '🗺',
  character: '🛡',
  session: '📓',
  campaign: '🔥',
};

type FilterValue = 'all' | Note['visibility'];

export default function MyNotesPage() {
  const { campaignId } = useParams<{ campaignId: string }>();
  const cid = Number(campaignId);
  const { me } = useAuth();
  const myUserId = me ? String(me.user.id) : null;
  const { lostAccess, handle: handleAccessError } = useCampaignAccessError();

  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [filter, setFilter] = useState<FilterValue>('all');

  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Note | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    setForbidden(false);
    setLoading(true);
    try {
      const list = await api.get<Note[]>(`${API}/campaigns/${cid}/notes`);
      setNotes(list);
    } catch (e) {
      if (handleAccessError(e)) {
        // handled: lostAccess flag drives the UI
      } else if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        setForbidden(true);
      } else {
        setError("Couldn't load notes.");
      }
    } finally {
      setLoading(false);
    }
  }, [cid, handleAccessError]);

  useEffect(() => {
    if (Number.isFinite(cid)) void load();
  }, [cid, load]);

  async function quickCapture(e: FormEvent) {
    e.preventDefault();
    if (!draft.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await api.post(`${API}/campaigns/${cid}/notes`, { body: draft.trim(), visibility: 'private' });
      setDraft('');
      await load();
    } catch {
      setError("Couldn't save the note.");
    } finally {
      setSaving(false);
    }
  }

  async function setVisibility(note: Note, visibility: Note['visibility']) {
    const prev = notes;
    setNotes((cur) => cur.map((n) => (n.id === note.id ? { ...n, visibility } : n)));
    try {
      await api.patch(`${API}/notes/${note.id}`, { visibility });
    } catch {
      setNotes(prev);
      setError("Couldn't update visibility.");
    }
  }

  async function deleteNote(note: Note) {
    const prev = notes;
    setDeleting(true);
    setNotes((cur) => cur.filter((n) => n.id !== note.id));
    try {
      await api.delete(`${API}/notes/${note.id}`);
      setPendingDelete(null);
    } catch {
      setNotes(prev);
      setError("Couldn't delete the note.");
    } finally {
      setDeleting(false);
    }
  }

  const filtered = useMemo(
    () => (filter === 'all' ? notes : notes.filter((n) => n.visibility === filter)),
    [notes, filter],
  );

  const mine = useMemo(
    () => filtered.filter((n) => !myUserId || n.authorUserId === myUserId),
    [filtered, myUserId],
  );
  const sharedWithMe = useMemo(
    () => filtered.filter((n) => myUserId && n.authorUserId !== myUserId),
    [filtered, myUserId],
  );

  if (!Number.isFinite(cid)) {
    return (
      <div className="max-w-3xl mx-auto px-4 mt-5">
        <ErrorNote message="No campaign selected." />
      </div>
    );
  }

  if (lostAccess) {
    return (
      <div className="max-w-3xl mx-auto px-4 mt-5">
        <Card className="text-center space-y-2">
          <p className="text-2xl">🔒</p>
          <p className="font-bold text-white">You no longer have access to this campaign</p>
          <Link to="/" className="btn btn-primary" style={{ display: 'inline-flex', marginTop: 4 }}>
            Back to your campaigns
          </Link>
        </Card>
      </div>
    );
  }

  if (forbidden) {
    return (
      <div className="max-w-3xl mx-auto px-4 mt-5">
        <Card>
          <EmptyState icon="🔒" title="You don't have access to this campaign" />
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 mt-5 space-y-4 pb-20 md:pb-10">
      <div className="flex items-center gap-2.5">
        <h1 className="text-xl font-extrabold text-white m-0">My notes</h1>
        <div className="flex-1" />
        <Btn
          className="!min-h-0 !py-1.5 text-xs"
          onClick={() => document.getElementById('note-quick-capture')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
        >
          + New note
        </Btn>
      </div>
      <p className="text-muted text-xs m-0">
        Private by default. Share a note with the DM or the whole party — tap the badge to change who sees it.
      </p>

      <div className="flex gap-1.5 flex-wrap">
        <FilterChip active={filter === 'all'} onClick={() => setFilter('all')}>
          All
        </FilterChip>
        <FilterChip active={filter === 'private'} variant="private" onClick={() => setFilter('private')}>
          🔒 Private
        </FilterChip>
        <FilterChip active={filter === 'dm_shared'} variant="dm" onClick={() => setFilter('dm_shared')}>
          🎩 → DM
        </FilterChip>
        <FilterChip active={filter === 'party_shared'} variant="party" onClick={() => setFilter('party_shared')}>
          👥 → Party
        </FilterChip>
      </div>

      {/* Quick capture */}
      <div id="note-quick-capture">
        <Card className="!p-4">
          <form className="flex gap-2" onSubmit={quickCapture}>
            <TextInput
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Jot something down… saves as private"
            />
            <Btn type="submit" className="shrink-0" disabled={saving || !draft.trim()}>
              Save
            </Btn>
          </form>
        </Card>
      </div>

      {error && <ErrorNote message={error} onRetry={load} />}

      {loading && notes.length === 0 ? (
        <Card>
          <Skeleton lines={4} />
        </Card>
      ) : (
        <div className="space-y-5">
          <section className="space-y-3">
            {mine.length > 0 && sharedWithMe.length > 0 && (
              <p className="text-[11px] font-bold text-slate-500 uppercase tracking-wide">Mine</p>
            )}
            {mine.map((note) => (
              <NoteCard
                key={note.id}
                campaignId={cid}
                note={note}
                editable
                onCycleVisibility={() => setVisibility(note, VIS_CYCLE[note.visibility])}
                onDelete={() => setPendingDelete(note)}
              />
            ))}
          </section>

          {sharedWithMe.length > 0 && (
            <section className="space-y-3">
              <p className="text-[11px] font-bold text-slate-500 uppercase tracking-wide">Shared with me</p>
              {sharedWithMe.map((note) => (
                <NoteCard key={note.id} campaignId={cid} note={note} editable={false} />
              ))}
            </section>
          )}

          {filtered.length === 0 && (
            <EmptyState
              icon="🕯️"
              title="No notes yet"
              hint="Jot your first thought above."
            />
          )}
        </div>
      )}

      <p className="text-[11px] text-slate-600">
        Notes are per-user: the DM cannot read private notes (API-enforced). Shared-with-DM notes appear in the DM&apos;s
        scribe view; shared-with-party notes appear on entity pages for everyone.
      </p>

      {pendingDelete && (
        <ConfirmDialog
          title="Delete this note?"
          body="This cannot be undone."
          confirmLabel={deleting ? 'Deleting…' : 'Delete note'}
          busy={deleting}
          onConfirm={() => deleteNote(pendingDelete)}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}

function FilterChip({
  active,
  variant,
  onClick,
  children,
}: {
  active: boolean;
  variant?: ChipVariant;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button onClick={onClick}>
      <Chip variant={active ? 'active' : variant ?? 'available'}>{children}</Chip>
    </button>
  );
}

function NoteCard({
  campaignId,
  note,
  editable,
  onCycleVisibility,
  onDelete,
}: {
  campaignId: number;
  note: Note;
  editable: boolean;
  onCycleVisibility?: () => void;
  onDelete?: () => void;
}) {
  const meta = visMeta[note.visibility];
  const anchorPath = note.entityType ? entityRoute[note.entityType] : null;
  const anchorHref = note.entityType
    ? anchorPath
      ? `/c/${campaignId}/${anchorPath}/${note.entityId}`
      : `/c/${campaignId}`
    : null;

  return (
    <div className="cf-card p-4 space-y-2">
      <p className="text-sm text-slate-100 whitespace-pre-wrap m-0">{note.body}</p>
      <div className="flex items-center gap-2 flex-wrap">
        {editable ? (
          <button onClick={onCycleVisibility} className="cf-chip" style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}>
            <Chip variant={meta.chip}>{meta.label} · tap to change</Chip>
          </button>
        ) : (
          <>
            <Chip variant={meta.chip}>{meta.label}</Chip>
            <span className="text-[11px] text-slate-500">from {note.authorName || note.authorUserId}</span>
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          {note.entityType && anchorHref && (
            <Link to={anchorHref} className="text-[11px] text-amber-400 hover:underline">
              {entityIcon[note.entityType]} {entityLabel(note)}
            </Link>
          )}
          <span className="text-[11px] text-slate-600">{timeAgo(note.createdAt)}</span>
          {editable && (
            <button onClick={onDelete} className="text-[11px] text-slate-500 hover:text-rose-400">
              delete
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function entityLabel(note: Note): string {
  // Server doesn't denormalize entity names onto notes; fall back to type + id.
  return note.entityType ? `${capitalize(note.entityType)} #${note.entityId}` : '';
}

function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffMs = Date.now() - then;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
}
