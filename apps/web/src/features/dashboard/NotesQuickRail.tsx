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
  const isViewer = role === 'viewer';
  const [notes, setNotes] = useState<Note[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [quickNote, setQuickNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    if (isViewer) return; // viewers have no personal notes access — just the quick capture box
    setError(null);
    try {
      setNotes(await api.get<Note[]>(`${API}/campaigns/${campaignId}/notes`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load notes.");
    }
  }, [campaignId, isViewer]);

  useEffect(() => {
    void load();
  }, [load]);

  async function leaveNote(e: React.FormEvent) {
    e.preventDefault();
    if (!quickNote.trim()) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await api.post(`${API}/campaigns/${campaignId}/inbox`, { authorName: 'me', body: quickNote.trim() });
      setQuickNote('');
      setSaved(true);
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

      {error && <ErrorNote message={error} onRetry={isViewer ? undefined : load} />}

      {!isViewer &&
        (notes.length === 0 ? (
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
        ))}

      {isViewer && (
        <p className="text-muted" style={{ fontSize: 12.5, margin: 0 }}>
          Notes need a player seat — viewers can still leave a note for the DM.
        </p>
      )}

      <form className="flex gap-2 pt-1" onSubmit={leaveNote}>
        <TextInput
          style={{ minHeight: 0, paddingTop: 8, paddingBottom: 8 }}
          placeholder="Quick note… (private)"
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
      {saved && <p className="text-[11px] text-emerald-400">Sent to the DM&apos;s inbox.</p>}
    </div>
  );
}
