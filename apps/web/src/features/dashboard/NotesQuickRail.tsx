import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Note, Role } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { Chip, TextInput, Btn, ErrorNote, EmptyState, type ChipVariant } from '../../components/ui';

const visMeta: Record<Note['visibility'], { chip: ChipVariant; label: string }> = {
  private: { chip: 'private', label: '🔒 Private' },
  dm_shared: { chip: 'dm', label: '🎩 DM' },
  party_shared: { chip: 'party', label: '👥 Party' },
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
  const [saved, setSaved] = useState(false);

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
    setSaved(false);
    try {
      // Personal quick capture — a private note, same as MyNotesPage's quickCapture.
      await api.post(`${API}/campaigns/${campaignId}/notes`, { body: quickNote.trim(), visibility: 'private' });
      setQuickNote('');
      setSaved(true);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save the note.");
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
        <EmptyState icon="📝" title="No notes yet" hint="Jot your first thought below." />
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
              <Chip variant={visMeta[n.visibility].chip}>{visMeta[n.visibility].label}</Chip>
              <span className="text-muted" style={{ fontSize: 10.5 }}>
                {timeAgo(n.updatedAt)}
              </span>
            </div>
          </div>
        ))
      )}

      <form className="flex gap-2 pt-1" onSubmit={saveQuickNote}>
        <TextInput
          style={{ minHeight: 0, paddingTop: 8, paddingBottom: 8 }}
          placeholder="Quick note… (private, just for you)"
          value={quickNote}
          onChange={(e) => {
            setQuickNote(e.target.value);
            setSaved(false);
          }}
        />
        <Btn type="submit" className="!min-h-0 !py-2 text-sm shrink-0" disabled={saving || !quickNote.trim()}>
          Save
        </Btn>
      </form>
      {saved && <p className="text-[11px] text-emerald-400">Saved to your notes.</p>}
      {!isDm && (
        <Link to={`/c/${campaignId}/notes`} className="text-[11px]" style={{ color: 'var(--color-accent-300)' }}>
          Want the DM to see something? Open My Notes → share a note with the DM →
        </Link>
      )}
    </div>
  );
}
