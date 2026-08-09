import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useCampaignAccess } from '../../app/CampaignAccessContext';
import type { Note, NoteListPage } from '@campfire/schema';
import { NOTES_RECENT_LIMIT } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { Card, Chip, TextInput, Btn, ErrorNote, EmptyState, Skeleton, type ChipVariant } from '../../components/ui';
import { GameIcon } from '../../components/GameIcon';
import { NOTE_VISIBILITY_ICON, UI_ICON_SIZE } from '../../lib/uiIcons';
import { Markdown } from '../../components/Markdown';
import { EntityPicker, type EntityLink } from '../notes/EntityPicker';
import { useKeyboardCommandHint } from '../../components/KeyboardCommandProvider';
import { timeAgo, useTimeTick } from '../../lib/format';

const visMeta: Record<Note['visibility'], { chip: ChipVariant; slug: string; label: string }> = {
  private: { chip: 'private', slug: NOTE_VISIBILITY_ICON.private, label: 'Private' },
  dm_shared: { chip: 'dm', slug: NOTE_VISIBILITY_ICON.dm_shared, label: 'DM' },
  party_shared: { chip: 'party', slug: NOTE_VISIBILITY_ICON.party_shared, label: 'Party' },
  whisper: { chip: 'whisper', slug: NOTE_VISIBILITY_ICON.whisper, label: 'Whisper' },
};



export function NotesQuickRail({
  campaignId,
  openInboxCount,
}: {
  campaignId: number;
  openInboxCount: number;
}) {
  useTimeTick();
  const { isDm, canMemberWrite } = useCampaignAccess();
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
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
  const quickCaptureHint = useKeyboardCommandHint('quickCapture');

  const load = useCallback(async () => {
    // Exact recent-five query (issue #608) — newest-first page, not fetch-all-then-slice.
    // Server allows private notes for every role, including viewers.
    setError(null);
    setLoading(true);
    try {
      const page = await api.get<NoteListPage>(
        `${API}/campaigns/${campaignId}/notes?limit=${NOTES_RECENT_LIMIT}`,
      );
      setNotes(page.items);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load notes.");
      // Keep prior results visible when a refetch fails (stale + recovery).
      setNotes((prev) => prev);
    } finally {
      setLoading(false);
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
    <Card density="compact" elev="sm">
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

      {loading && notes.length === 0 ? (
        <Skeleton lines={3} />
      ) : notes.length === 0 ? (
        <EmptyState
          icon="quill-ink"
          title="No notes yet"
          hint={canMemberWrite ? 'Jot down quick thoughts, session notes, or ideas for the campaign.' : 'Notes created during sessions or shared with you will appear here.'}
          action={
            canMemberWrite ? (
              <Btn density="xs"
                type="button"
                className="text-xs btn-primary"
                onClick={() => {
                  const input = document.getElementById('dashboard-quick-note-input');
                  input?.focus();
                }}
              >
                + Write a note
              </Btn>
            ) : undefined
          }
        />
      ) : (
        notes.map((n) => (
          <div
            key={n.id}
            style={{
              padding: '7px 0',
              background:
                'linear-gradient(to right, transparent, var(--color-divider) 48px, var(--color-divider) calc(100% - 48px), transparent) no-repeat top / 100% 1px',
            }}
          >
            <Markdown className="!text-[color:var(--color-neutral-200)]">{n.body}</Markdown>
            <div style={{ display: 'flex', gap: 6, marginTop: 5, alignItems: 'center' }}>
              <Chip variant={visMeta[n.visibility].chip}><span className="inline-flex items-center gap-1"><GameIcon slug={visMeta[n.visibility].slug} size={UI_ICON_SIZE.xs} /> {visMeta[n.visibility].label}</span></Chip>
              <span className="text-muted" style={{ fontSize: 'var(--type-meta)' }}>
                {timeAgo(n.updatedAt)}
              </span>
            </div>
          </div>
        ))
      )}

      {canMemberWrite && (
        <>
      {!isDm && (
        <div className="flex gap-1.5 pt-1">
          <button type="button" onClick={() => setDest('private')} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
            <Chip variant={dest === 'private' ? 'active' : 'private'}><span className="inline-flex items-center gap-1"><GameIcon slug="padlock" size={UI_ICON_SIZE.xs} /> Private note</span></Chip>
          </button>
          <button type="button" onClick={() => setDest('inbox')} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
            <Chip variant={dest === 'inbox' ? 'active' : 'dm'}><span className="inline-flex items-center gap-1"><GameIcon slug="envelope" size={UI_ICON_SIZE.xs} /> To DM inbox</span></Chip>
          </button>
        </div>
      )}

      <form className="flex gap-2 pt-1" onSubmit={saveQuickNote}>
        <TextInput
          id="dashboard-quick-note-input"
          style={{ minHeight: 0, paddingTop: 8, paddingBottom: 8 }}
          placeholder={dest === 'inbox' ? 'Leave a note for the DM… goes to their inbox' : 'Quick note… (private, just for you)'}
          value={quickNote}
          onChange={(e) => {
            setQuickNote(e.target.value);
            setSavedTo(null);
          }}
          aria-keyshortcuts={quickCaptureHint.ariaKeyshortcuts}
          title={`Quick note${quickCaptureHint.titleSuffix}`}
          // The `title` is the shortcut hint, and a placeholder disappears the moment you type,
          // so neither is this field's NAME — axe `label-title-only`. The accessible name says
          // where the note goes, which is the one thing about this box that changes.
          aria-label={dest === 'inbox' ? 'Note for the DM inbox' : 'Quick note, private to you'}
        />
        {/* compact, not xs (issue #1692 review — Codex): the quick-note form's only
            submit control, not a dense inline row action. */}
        <Btn density="compact" type="submit" className="text-sm shrink-0" disabled={saving || !quickNote.trim()}>
          {dest === 'inbox' ? 'Send' : 'Save'}
        </Btn>
      </form>
      {dest === 'private' && (
        <div className="flex items-center gap-2 flex-wrap pt-1">
          <span className="text-[11px] text-secondary">Attach to:</span>
          <EntityPicker campaignId={campaignId} onChange={setAttach} resetKey={attachResetKey} disabled={saving} />
        </div>
      )}
      {savedTo === 'private' && <p className="text-[11px] text-emerald-400">Saved to your notes.</p>}
      {savedTo === 'inbox' && <p className="text-[11px] text-emerald-400">Sent to the DM&apos;s inbox.</p>}
        </>
      )}
      {!isDm && (
        <Link to={`/c/${campaignId}/notes`} className="text-[11px]" style={{ color: 'var(--color-accent-300)' }}>
          Want to share a longer note with the DM or party? Open My Notes →
        </Link>
      )}
    </Card>
  );
}
