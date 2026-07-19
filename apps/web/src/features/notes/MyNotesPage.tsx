/**
 * My notes — mirrors design/08-my-notes.html.
 * Route: /c/:campaignId/notes
 * Shows the caller's own notes (server visibility-filters to mine + shared-with-me).
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Note } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { Card, Chip, Btn, TextInput, EmptyState, Skeleton, ErrorNote, type ChipVariant } from '../../components/ui';

type EntityTypeValue = Exclude<Note['entityType'], null>;

const visMeta: Record<Note['visibility'], { chip: ChipVariant; label: string; short: string }> = {
  private: { chip: 'private', label: '🔒 Private', short: '🔒 Private' },
  dm_shared: { chip: 'dm', label: '🎩 Shared with DM', short: '🎩 DM' },
  party_shared: { chip: 'party', label: '👥 Shared with party', short: '👥 Party' },
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

  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [filter, setFilter] = useState<FilterValue>('all');

  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    setForbidden(false);
    setLoading(true);
    try {
      const list = await api.get<Note[]>(`${API}/campaigns/${cid}/notes`);
      setNotes(list);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        setForbidden(true);
      } else {
        setError("Couldn't load notes.");
      }
    } finally {
      setLoading(false);
    }
  }, [cid]);

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
    if (!confirm('Delete this note? This cannot be undone.')) return;
    const prev = notes;
    setNotes((cur) => cur.filter((n) => n.id !== note.id));
    try {
      await api.delete(`${API}/notes/${note.id}`);
    } catch {
      setNotes(prev);
      setError("Couldn't delete the note.");
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
    <div className="max-w-3xl mx-auto px-4 mt-5 space-y-5 pb-20 md:pb-10">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-extrabold text-white">My notes</h1>
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
      </div>

      {/* Quick capture */}
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
                onSetVisibility={(v) => setVisibility(note, v)}
                onDelete={() => deleteNote(note)}
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
              title="Empty state"
              hint="Your notes live here — private until you share them. Jot your first thought above."
            />
          )}
        </div>
      )}

      <p className="text-[11px] text-slate-600">
        Notes are per-user: the DM cannot read private notes (API-enforced). Shared-with-DM notes appear in the DM&apos;s
        scribe view; shared-with-party notes appear on entity pages for everyone.
      </p>
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
  onSetVisibility,
  onDelete,
}: {
  campaignId: number;
  note: Note;
  editable: boolean;
  onSetVisibility?: (v: Note['visibility']) => void;
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
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <Chip variant={meta.chip}>{meta.label}</Chip>
          {note.entityType && anchorHref && (
            <Link to={anchorHref} className="text-[11px] text-amber-400 hover:underline">
              {entityIcon[note.entityType]} {entityLabel(note)}
            </Link>
          )}
          {!note.entityType && <span className="text-[11px] text-slate-500">no anchor</span>}
        </div>
        <span className="text-[10px] text-slate-600">{timeAgo(note.createdAt)}</span>
      </div>
      <p className="text-sm text-slate-300 whitespace-pre-wrap">{note.body}</p>
      {editable && (
        <div className="flex items-center gap-3 pt-1 border-t border-slate-700/60">
          <span className="text-[10px] font-bold text-slate-500 uppercase">Visibility</span>
          <div className="flex rounded-lg overflow-hidden border border-slate-700 text-[11px] font-semibold">
            {(Object.keys(visMeta) as Note['visibility'][]).map((v) => (
              <button
                key={v}
                onClick={() => onSetVisibility?.(v)}
                className={`px-2.5 py-1 ${
                  note.visibility === v ? 'bg-slate-700 text-white' : 'text-slate-400 hover:bg-slate-800'
                }`}
              >
                {visMeta[v].short}
              </button>
            ))}
          </div>
          <button onClick={onDelete} className="ml-auto text-[11px] text-slate-500 hover:text-rose-400">
            delete
          </button>
        </div>
      )}
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
