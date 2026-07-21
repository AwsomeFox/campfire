/**
 * My notes — mirrors design/claude-design/Campfire.dc.html "My notes" (~1076-1101).
 * Route: /c/:campaignId/notes
 * Shows the caller's own notes (server visibility-filters to mine + shared-with-me).
 * Design: header + "+ New note", each note's visibility badge is tap-to-cycle
 * (private -> shared with DM -> shared with party -> private).
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import type { CampaignMember, Note } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { usePollWhileVisible } from '../../lib/usePollWhileVisible';
import { useAuth } from '../../app/auth';
import { useCampaignAccessError } from '../../app/useCampaignAccessError';
import { Card, Chip, Btn, TextInput, EmptyState, Skeleton, ErrorNote, type ChipVariant } from '../../components/ui';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { UndoSnackbar } from '../../components/UndoSnackbar';
import { Markdown } from '../../components/Markdown';
import { EntityPicker, type EntityLink } from './EntityPicker';
import { GameIcon } from '../../components/GameIcon';
import { ENTITY_ICON, NOTE_VISIBILITY_ICON } from '../../lib/uiIcons';

type EntityTypeValue = Exclude<Note['entityType'], null>;

const visMeta: Record<Note['visibility'], { chip: ChipVariant; slug: string; label: string; short: string }> = {
  private: { chip: 'private', slug: NOTE_VISIBILITY_ICON.private, label: 'Private', short: 'Private' },
  dm_shared: { chip: 'dm', slug: NOTE_VISIBILITY_ICON.dm_shared, label: 'Shared with DM', short: 'DM' },
  party_shared: { chip: 'party', slug: NOTE_VISIBILITY_ICON.party_shared, label: 'Shared with party', short: 'Party' },
  whisper: { chip: 'whisper', slug: NOTE_VISIBILITY_ICON.whisper, label: 'Whisper', short: 'Whisper' },
};

/**
 * Design's tap-to-cycle order on a note's own visibility badge. `whisper` is
 * deliberately NOT in the cycle — it needs a chosen recipient, so a blind tap can't
 * create one; a whispered note shows a static badge instead (issue #127). Cycling a
 * note INTO whisper happens via the compose recipient picker, not the badge.
 */
const VIS_CYCLE: Record<'private' | 'dm_shared' | 'party_shared', Note['visibility']> = {
  private: 'dm_shared',
  dm_shared: 'party_shared',
  party_shared: 'private',
};

const entityRoute: Record<EntityTypeValue, string | null> = {
  quest: 'quests',
  npc: 'npcs',
  faction: 'factions',
  location: 'locations',
  character: 'characters',
  session: 'sessions',
  encounter: 'encounters',
  campaign: null, // links to campaign dashboard
};

const entityIcon: Record<EntityTypeValue, string> = {
  quest: ENTITY_ICON.quest,
  npc: ENTITY_ICON.npc,
  faction: ENTITY_ICON.faction,
  location: ENTITY_ICON.location,
  character: ENTITY_ICON.character,
  session: ENTITY_ICON.session,
  encounter: ENTITY_ICON.encounter,
  campaign: ENTITY_ICON.campaign,
};

type FilterValue = 'all' | Note['visibility'];

export default function MyNotesPage() {
  const { t } = useTranslation();
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
  const [search, setSearch] = useState('');

  const [draft, setDraft] = useState('');
  const [attach, setAttach] = useState<EntityLink | null>(null);
  const [attachResetKey, setAttachResetKey] = useState(0);
  // Per-player whisper recipient for the compose form (issue #127): '' = not a whisper
  // (saves private, as before); a member userId = whisper that one player.
  const [whisperTo, setWhisperTo] = useState('');
  const [members, setMembers] = useState<CampaignMember[]>([]);
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Note | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [undoNote, setUndoNote] = useState<Note | null>(null);

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
        setError(t('notes.couldntLoadNotes'));
      }
    } finally {
      setLoading(false);
    }
  }, [cid, handleAccessError, t]);

  useEffect(() => {
    if (Number.isFinite(cid)) void load();
  }, [cid, load]);

  // Load members for the whisper recipient picker. Best-effort — a failure just leaves
  // the picker empty (whisper is an opt-in extra, never blocks plain note-taking).
  useEffect(() => {
    if (!Number.isFinite(cid)) return;
    let cancelled = false;
    api
      .get<CampaignMember[]>(`${API}/campaigns/${cid}/members`)
      .then((list) => {
        if (!cancelled) setMembers(list);
      })
      .catch(() => {
        /* picker just stays empty */
      });
    return () => {
      cancelled = true;
    };
  }, [cid]);

  // Keep the notes list live at the table (issue #113): poll ~5s while visible.
  // Only the fetched `notes` are replaced — the compose draft is separate state.
  usePollWhileVisible(() => void load(), 5000, Number.isFinite(cid));

  async function quickCapture(e: FormEvent) {
    e.preventDefault();
    if (!draft.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await api.post(`${API}/campaigns/${cid}/notes`, {
        body: draft.trim(),
        ...(whisperTo
          ? { visibility: 'whisper', recipientUserId: whisperTo }
          : { visibility: 'private' }),
        ...(attach ? { entityType: attach.entityType, entityId: attach.entityId } : {}),
      });
      setDraft('');
      setAttach(null);
      setWhisperTo('');
      setAttachResetKey((k) => k + 1);
      await load();
    } catch {
      setError(t('notes.couldntSaveNote'));
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
      setError(t('notes.couldntUpdateVisibility'));
    }
  }

  async function deleteNote(note: Note) {
    const prev = notes;
    setDeleting(true);
    setNotes((cur) => cur.filter((n) => n.id !== note.id));
    try {
      // Soft-delete (issue #116) — reversible; offer an Undo that restores the note.
      await api.delete(`${API}/notes/${note.id}`);
      setPendingDelete(null);
      setUndoNote(note);
    } catch {
      setNotes(prev);
      setError(t('notes.couldntDeleteNote'));
    } finally {
      setDeleting(false);
    }
  }

  async function undoDeleteNote(note: Note) {
    const restored = await api.post<Note>(`${API}/notes/${note.id}/restore`);
    setUndoNote(null);
    // Re-insert in id order so it lands where it was.
    setNotes((cur) => [...cur, restored].sort((a, b) => a.id - b.id));
  }

  const filtered = useMemo(() => {
    const byVis = filter === 'all' ? notes : notes.filter((n) => n.visibility === filter);
    const q = search.trim().toLowerCase();
    if (!q) return byVis;
    // Ten sessions in, find "the one about the relic": match body or the anchored
    // entity's name (issue #65). Client-side over the already-loaded, visible set.
    return byVis.filter(
      (n) => n.body.toLowerCase().includes(q) || (n.entityName?.toLowerCase().includes(q) ?? false),
    );
  }, [notes, filter, search]);

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
        <ErrorNote message={t('notes.noCampaign')} />
      </div>
    );
  }

  if (lostAccess) {
    return (
      <div className="max-w-3xl mx-auto px-4 mt-5">
        <Card className="text-center space-y-2">
          <p className="flex justify-center text-[var(--color-neutral-400)]"><GameIcon slug="padlock" size={28} /></p>
          <p className="font-bold text-white">{t('notes.lostAccessTitle')}</p>
          <Link to="/" className="btn btn-primary" style={{ display: 'inline-flex', marginTop: 4 }}>
            {t('notes.backToCampaigns')}
          </Link>
        </Card>
      </div>
    );
  }

  if (forbidden) {
    return (
      <div className="max-w-3xl mx-auto px-4 mt-5">
        <Card>
          <EmptyState icon="padlock" title={t('notes.noAccess')} />
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
          <span className="inline-flex items-center gap-1"><GameIcon slug="padlock" size={12} /> Private</span>
        </FilterChip>
        <FilterChip active={filter === 'dm_shared'} variant="dm" onClick={() => setFilter('dm_shared')}>
          <span className="inline-flex items-center gap-1"><GameIcon slug="top-hat" size={12} /> DM</span>
        </FilterChip>
        <FilterChip active={filter === 'party_shared'} variant="party" onClick={() => setFilter('party_shared')}>
          <span className="inline-flex items-center gap-1"><GameIcon slug="meeple" size={12} /> Party</span>
        </FilterChip>
        <FilterChip active={filter === 'whisper'} variant="whisper" onClick={() => setFilter('whisper')}>
          <span className="inline-flex items-center gap-1"><GameIcon slug="secret-book" size={12} /> Whisper</span>
        </FilterChip>
      </div>

      {/* Search over note bodies (and anchored entity names) */}
      <div className="relative">
        <TextInput
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search your notes…"
          aria-label="Search notes"
        />
        {search && (
          <button
            onClick={() => setSearch('')}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 text-sm"
            aria-label="Clear search"
          >
            ✕
          </button>
        )}
      </div>

      {/* Quick capture */}
      <div id="note-quick-capture">
        <Card className="!p-4 space-y-2">
          <form className="flex gap-2" onSubmit={quickCapture}>
            <TextInput
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={whisperTo ? 'Whisper something to one player…' : 'Jot something down… saves as private'}
            />
            <Btn type="submit" className="shrink-0" disabled={saving || !draft.trim()}>
              {whisperTo ? 'Whisper' : 'Save'}
            </Btn>
          </form>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] text-slate-500">Attach to:</span>
            <EntityPicker campaignId={cid} onChange={setAttach} resetKey={attachResetKey} disabled={saving} />
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="inline-flex items-center gap-1 text-[11px] text-slate-500"><GameIcon slug="secret-book" size={12} /> Whisper to:</span>
            <select
              value={whisperTo}
              onChange={(e) => setWhisperTo(e.target.value)}
              disabled={saving}
              aria-label="Whisper to a specific player"
              className="cf-input !min-h-0 !py-1 text-xs"
            >
              <option value="">No one (private)</option>
              {members
                .filter((m) => !myUserId || String(m.userId) !== myUserId)
                .map((m) => (
                  <option key={m.userId} value={String(m.userId)}>
                    {(m.displayName || m.username || `User ${m.userId}`) + (m.role === 'dm' ? ' (DM)' : '')}
                  </option>
                ))}
            </select>
            {whisperTo && (
              <span className="text-[11px] text-violet-300">Only they (and the DM) will see this.</span>
            )}
          </div>
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
                myUserId={myUserId}
                onCycleVisibility={
                  note.visibility === 'whisper'
                    ? undefined
                    : () => setVisibility(note, VIS_CYCLE[note.visibility as keyof typeof VIS_CYCLE])
                }
                onDelete={() => setPendingDelete(note)}
              />
            ))}
          </section>

          {sharedWithMe.length > 0 && (
            <section className="space-y-3">
              <p className="text-[11px] font-bold text-slate-500 uppercase tracking-wide">Shared with me</p>
              {sharedWithMe.map((note) => (
                <NoteCard key={note.id} campaignId={cid} note={note} editable={false} myUserId={myUserId} />
              ))}
            </section>
          )}

          {filtered.length === 0 &&
            (search.trim() ? (
              <EmptyState
                icon="magnifying-glass"
                title="No notes match your search"
                hint={`Nothing found for "${search.trim()}". Try a different word.`}
              />
            ) : (
              <EmptyState icon="candle-flame" title="No notes yet" hint="Jot your first thought above." />
            ))}
        </div>
      )}

      <p className="text-[11px] text-slate-600">
        Notes are per-user: the DM cannot read private notes (API-enforced). Sharing a note with the DM notifies them
        (it shows in their notification bell) and lands under their &quot;Shared with me&quot;; shared-with-party notes
        appear on entity pages for everyone. A <GameIcon slug="secret-book" size={12} className="inline align-text-bottom" /> whisper reaches exactly one player (plus the DM) — the per-player
        secret channel for &quot;only the rogue notices the trap door&quot;.
      </p>

      {pendingDelete && (
        <ConfirmDialog
          title="Delete this note?"
          body="This moves the note to the Trash — you can undo it right after."
          confirmLabel={deleting ? 'Deleting…' : 'Delete note'}
          busy={deleting}
          onConfirm={() => deleteNote(pendingDelete)}
          onCancel={() => setPendingDelete(null)}
        />
      )}
      {undoNote && (
        <UndoSnackbar
          message="Note moved to Trash."
          onUndo={() => undoDeleteNote(undoNote)}
          onExpire={() => setUndoNote(null)}
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
  myUserId,
  onCycleVisibility,
  onDelete,
}: {
  campaignId: number;
  note: Note;
  editable: boolean;
  myUserId?: string | null;
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

  const isWhisper = note.visibility === 'whisper';
  // Whisper indicator, from the reader's point of view: the author sees who it went to,
  // the recipient sees it came to them, a DM sees both ends of the exchange (issue #127).
  const recipientLabel = note.recipientName || note.recipientUserId || 'a player';
  const whisperLabel = isWhisper
    ? myUserId && note.recipientUserId === myUserId
      ? `Whispered to you by ${note.authorName || note.authorUserId}`
      : editable
        ? `Whispered to ${recipientLabel}`
        : `Whisper: ${note.authorName || note.authorUserId} → ${recipientLabel}`
    : '';

  return (
    <div className="cf-card p-4 space-y-2">
      <Markdown className="text-slate-100">{note.body}</Markdown>
      <div className="flex items-center gap-2 flex-wrap">
        {isWhisper ? (
          // No tap-to-cycle: a whisper is bound to its recipient, so the badge is a
          // static indicator (re-targeting happens in compose, not by cycling).
          <Chip variant="whisper"><span className="inline-flex items-center gap-1"><GameIcon slug="secret-book" size={12} /> {whisperLabel}</span></Chip>
        ) : editable ? (
          <button onClick={onCycleVisibility} className="cf-chip" style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}>
            <Chip variant={meta.chip}><span className="inline-flex items-center gap-1"><GameIcon slug={meta.slug} size={12} /> {meta.label} · tap to change</span></Chip>
          </button>
        ) : (
          <>
            <Chip variant={meta.chip}><span className="inline-flex items-center gap-1"><GameIcon slug={meta.slug} size={12} /> {meta.label}</span></Chip>
            <span className="text-[11px] text-slate-500">from {note.authorName || note.authorUserId}</span>
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          {note.entityType && anchorHref && (
            <Link to={anchorHref} className="inline-flex items-center gap-1 text-[11px] text-amber-400 hover:underline">
              <GameIcon slug={entityIcon[note.entityType]} size={12} /> {entityLabel(note)}
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
  // Server resolves the anchored entity's display name (entityName); fall back to
  // type + id only when the entity no longer exists (or an older server omits it).
  if (note.entityName) return note.entityName;
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
