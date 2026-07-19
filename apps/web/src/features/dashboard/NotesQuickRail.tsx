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
    <section className="cf-card p-5 space-y-3">
      <div className="flex items-center justify-between border-b border-slate-700 pb-3">
        <h2 className="font-bold text-white flex items-center gap-2">📝 My notes</h2>
        {isDm ? (
          <Link to={`/c/${campaignId}/inbox`} className="text-xs text-slate-400 hover:text-white flex items-center gap-1.5">
            Inbox
            {openInboxCount > 0 && <span className="cf-chip cf-chip-active">{openInboxCount}</span>}
          </Link>
        ) : (
          <Link to={`/c/${campaignId}/notes`} className="text-xs text-slate-400 hover:text-white">
            All notes →
          </Link>
        )}
      </div>

      {error && <ErrorNote message={error} onRetry={isViewer ? undefined : load} />}

      {!isViewer && (
        notes.length === 0 ? (
          <EmptyState icon="📝" title="No notes yet" hint="Jot your first thought below." />
        ) : (
          notes.slice(0, 5).map((n) => (
            <div key={n.id} className="cf-inset p-3 space-y-1">
              <div className="flex items-center justify-between">
                <Chip variant={visMeta[n.visibility].chip}>{visMeta[n.visibility].label}</Chip>
                <span className="text-[10px] text-slate-600">{timeAgo(n.updatedAt)}</span>
              </div>
              <p className="text-xs text-slate-300">{n.body}</p>
            </div>
          ))
        )
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
    </section>
  );
}
