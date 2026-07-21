import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Note, Role } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { Chip, TextInput, Btn, ErrorNote, EmptyState, type ChipVariant } from '../../components/ui';
import { GameIcon } from '../../components/GameIcon';
import { EntityPicker, type EntityLink } from '../notes/EntityPicker';

const visMeta: Record<Note['visibility'], { chip: ChipVariant; slug: string; label: string }> = {
  private: { chip: 'private', slug: 'padlock', label: 'Private' },
  dm_shared: { chip: 'dm', slug: 'top-hat', label: 'DM' },
  party_shared: { chip: 'party', slug: 'meeple', label: 'Party' },
  whisper: { chip: 'whisper', slug: 'secret-book', label: 'Whisper' },
};

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  if (days <= 0) return 'today';
  if (days === 1) return '1d ago';
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
}

export function NotesQuickRail({
  campaignId,
  openInboxCount,
  role,
}: {
  campaignId: number;
  openInboxCount: number;
  role: Role | null;
}) {
  const isDm = role === 'dm';
  const [notes, setNotes] = useState<Note[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [quickNote, setQuickNote] = useState('');
  const [saving, setSaving] = useState(false);
  // Where the quick capture goes: a private note, or straight to the DM's scribe inbox.
  // The inbox option is player-facing (the DM already owns the inbox), but the server
  // allows any member to submit, so we simply hide it for the DM rather than gate it.
  const [dest, setDest] = useState<'private' | 'inbox'>('private');
  const [savedTo, setSavedTo] = useState<'private' | 'inbox' | null>(null);
  // Optional entity to anchor a private quick note to (issue #65). Inbox items are
  // unanchored — the DM links them on resolve — so this only applies to private notes.
  const [attach, setAttach] = useState<EntityLink | null>(null);
  const [attachResetKey, setAttachResetKey] = useState(0);

  const load = useCallback(async () => {
    // Server allows private notes for every role, including viewers.
    setError(null);
    try {
      setNotes(await api.get<Note[]>(`${API}/campaigns/${campaignId}/notes`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load notes.");
    }
  }, [campaignId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveQuickNote(e: React.FormEvent) {
    e.preventDefault();
    if (!quickNote.trim()) return;
    setSaving(true);
    setError(null);
    setSavedTo(null);
    try {
      if (dest === 'inbox') {
        // Player-facing scribe-inbox submission — the server stamps the author from
        // the session, so only the body is needed (POST /campaigns/:id/inbox).
        await api.post(`${API}/campaigns/${campaignId}/inbox`, { body: quickNote.trim() });
        setQuickNote('');
        setSavedTo('inbox');
      } else {
        // Personal quick capture — a private note, same as MyNotesPage's quickCapture.
        await api.post(`${API}/campaigns/${campaignId}/notes`, {
          body: quickNote.trim(),
          visibility: 'private',
          ...(attach ? { entityType: attach.entityType, entityId: attach.entityId } : {}),
        });
        setQuickNote('');
        setAttach(null);
        setAttachResetKey((k) => k + 1);
        setSavedTo('private');
        await load();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : dest === 'inbox' ? "Couldn't send to the DM's inbox." : "Couldn't save the note.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card elev-sm">
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <span className="card-kicker">My notes</span>
        <div style={{ flex: 1 }} />
        {isDm ? (
          <Link to={`/c/${campaignId}/inbox`} className="btn btn-ghost" style={{ fontSize: 12, gap: 6 }}>
            Inbox
            {openInboxCount > 0 && <span className="cf-chip cf-chip-active">{openInboxCount}</span>}
          </Link>
        ) : (
          <Link to={`/c/${campaignId}/notes`} className="btn btn-ghost" style={{ fontSize: 12 }}>
            All →
          </Link>
        )}
      </div>

      {error && <ErrorNote message={error} onRetry={load} />}

      {notes.length === 0 ? (
        <EmptyState icon="quill-ink" title="No notes yet" hint="Jot your first thought below." />
      ) : (
        notes.slice(0, 5).map((n) => (
          <div
            key={n.id}
            style={{
              padding: '7px 0',
              background:
                'linear-gradient(to right, transparent, var(--color-divider) 48px, var(--color-divider) calc(100% - 48px), transparent) no-repeat top / 100% 1px',
            }}
          >
            <div style={{ fontSize: 13, color: 'var(--color-neutral-200)' }}>{n.body}</div>
            <div style={{ display: 'flex', gap: 6, marginTop: 5, alignItems: 'center' }}>
              <Chip variant={visMeta[n.visibility].chip}><span className="inline-flex items-center gap-1"><GameIcon slug={visMeta[n.visibility].slug} size={12} /> {visMeta[n.visibility].label}</span></Chip>
              <span className="text-muted" style={{ fontSize: 10.5 }}>
                {timeAgo(n.updatedAt)}
              </span>
            </div>
          </div>
        ))
      )}

      {!isDm && (
        <div className="flex gap-1.5 pt-1">
          <button type="button" onClick={() => setDest('private')} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
            <Chip variant={dest === 'private' ? 'active' : 'private'}><span className="inline-flex items-center gap-1"><GameIcon slug="padlock" size={12} /> Private note</span></Chip>
          </button>
          <button type="button" onClick={() => setDest('inbox')} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
            <Chip variant={dest === 'inbox' ? 'active' : 'dm'}><span className="inline-flex items-center gap-1"><GameIcon slug="envelope" size={12} /> To DM inbox</span></Chip>
          </button>
        </div>
      )}

      <form className="flex gap-2 pt-1" onSubmit={saveQuickNote}>
        <TextInput
          style={{ minHeight: 0, paddingTop: 8, paddingBottom: 8 }}
          placeholder={dest === 'inbox' ? 'Leave a note for the DM… goes to their inbox' : 'Quick note… (private, just for you)'}
          value={quickNote}
          onChange={(e) => {
            setQuickNote(e.target.value);
            setSavedTo(null);
          }}
        />
        <Btn type="submit" className="!min-h-0 !py-2 text-sm shrink-0" disabled={saving || !quickNote.trim()}>
          {dest === 'inbox' ? 'Send' : 'Save'}
        </Btn>
      </form>
      {dest === 'private' && (
        <div className="flex items-center gap-2 flex-wrap pt-1">
          <span className="text-[11px] text-slate-500">Attach to:</span>
          <EntityPicker campaignId={campaignId} onChange={setAttach} resetKey={attachResetKey} disabled={saving} />
        </div>
      )}
      {savedTo === 'private' && <p className="text-[11px] text-emerald-400">Saved to your notes.</p>}
      {savedTo === 'inbox' && <p className="text-[11px] text-emerald-400">Sent to the DM&apos;s inbox.</p>}
      {!isDm && (
        <Link to={`/c/${campaignId}/notes`} className="text-[11px]" style={{ color: 'var(--color-accent-300)' }}>
          Want to share a longer note with the DM or party? Open My Notes →
        </Link>
      )}
    </div>
  );
}
