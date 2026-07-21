/**
 * "My notes on this <entity>" rail — shared by quest/npc/location/session/character pages.
 * Shows the caller's notes (+ party-shared from others) anchored to an entity, with the
 * private → DM → party → whisper visibility toggle from the design package. A whisper
 * (issue #127) is a per-player secret anchored to this entity — "only the rogue notices
 * the trap door" lives right on the location/NPC page for that one player.
 */
import { useCallback, useEffect, useState } from 'react';
import type { CampaignMember, Note } from '@campfire/schema';
import { api, API } from '../lib/api';
import { Card, Chip, Btn, TextArea, ErrorNote, type ChipVariant } from './ui';
import { Markdown } from './Markdown';
import { GameIcon } from './GameIcon';
import { NOTE_VISIBILITY_ICON } from '../lib/uiIcons';

const visMeta: Record<Note['visibility'], { chip: ChipVariant; slug: string; label: string }> = {
  private: { chip: 'private', slug: NOTE_VISIBILITY_ICON.private, label: 'Private' },
  dm_shared: { chip: 'dm', slug: NOTE_VISIBILITY_ICON.dm_shared, label: 'DM' },
  party_shared: { chip: 'party', slug: NOTE_VISIBILITY_ICON.party_shared, label: 'Party' },
  whisper: { chip: 'whisper', slug: NOTE_VISIBILITY_ICON.whisper, label: 'Whisper' },
};

/** Inline visibility label with its icon, for chips and the compose toggle. */
function VisLabel({ visibility }: { visibility: Note['visibility'] }) {
  const m = visMeta[visibility];
  return (
    <span className="inline-flex items-center gap-1">
      <GameIcon slug={m.slug} size={12} /> {m.label}
    </span>
  );
}

const VIS_ORDER: Note['visibility'][] = ['private', 'dm_shared', 'party_shared', 'whisper'];

export function NotesRail({ campaignId, entityType, entityId }: { campaignId: number; entityType: Note['entityType']; entityId: number }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [members, setMembers] = useState<CampaignMember[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState<Note['visibility']>('private');
  const [whisperTo, setWhisperTo] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setNotes(await api.get<Note[]>(`${API}/campaigns/${campaignId}/notes?entityType=${entityType}&entityId=${entityId}`));
    } catch {
      setError("Couldn't load notes.");
    }
  }, [campaignId, entityType, entityId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Members for the whisper recipient picker — best-effort (empty picker on failure).
  useEffect(() => {
    let cancelled = false;
    api
      .get<CampaignMember[]>(`${API}/campaigns/${campaignId}/members`)
      .then((list) => {
        if (!cancelled) setMembers(list);
      })
      .catch(() => {
        /* picker stays empty */
      });
    return () => {
      cancelled = true;
    };
  }, [campaignId]);

  const whisperMissingRecipient = visibility === 'whisper' && !whisperTo;

  async function save() {
    if (!body.trim() || whisperMissingRecipient) return;
    setSaving(true);
    try {
      await api.post(`${API}/campaigns/${campaignId}/notes`, {
        body: body.trim(),
        visibility,
        entityType,
        entityId,
        ...(visibility === 'whisper' ? { recipientUserId: whisperTo } : {}),
      });
      setBody('');
      await load();
    } catch {
      setError("Couldn't save the note.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="space-y-3">
      <h2 className="flex items-center gap-2 font-bold text-white text-sm"><GameIcon slug="quill-ink" size={16} /> Notes</h2>
      {error && <ErrorNote message={error} onRetry={load} />}
      {notes.map((n) => (
        <div key={n.id} className="cf-inset p-3 space-y-1">
          <div className="flex items-center justify-between">
            <Chip variant={visMeta[n.visibility].chip}>
              {n.visibility === 'whisper' ? (
                <span className="inline-flex items-center gap-1">
                  <GameIcon slug={NOTE_VISIBILITY_ICON.whisper} size={12} /> Whisper{n.recipientName ? ` → ${n.recipientName}` : ''}
                </span>
              ) : (
                <VisLabel visibility={n.visibility} />
              )}
            </Chip>
            <span className="text-[10px]" style={{ color: 'var(--color-neutral-600)' }}>
              {n.authorName || n.authorUserId}
            </span>
          </div>
          <Markdown className="!text-xs">{n.body}</Markdown>
        </div>
      ))}
      <div className="space-y-2">
        <TextArea style={{ minHeight: 70 }} placeholder="Add a note… (private by default)" value={body} onChange={(e) => setBody(e.target.value)} />
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="seg seg-wrap min-w-0 flex-1">
            {VIS_ORDER.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setVisibility(v)}
                className="seg-opt"
                style={
                  visibility === v
                    ? { color: 'var(--color-accent)', boxShadow: 'inset 0 0 0 1px var(--color-accent)' }
                    : undefined
                }
              >
                <VisLabel visibility={v} />
              </button>
            ))}
          </div>
          <Btn onClick={save} disabled={saving || !body.trim() || whisperMissingRecipient} style={{ minHeight: 0, paddingTop: 8, paddingBottom: 8 }}>
            Save
          </Btn>
        </div>
        {visibility === 'whisper' && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="inline-flex items-center gap-1 text-[11px] text-slate-500"><GameIcon slug={NOTE_VISIBILITY_ICON.whisper} size={12} /> To:</span>
            <select
              value={whisperTo}
              onChange={(e) => setWhisperTo(e.target.value)}
              disabled={saving}
              aria-label="Whisper to a specific player"
              className="cf-input !min-h-0 !py-1 text-xs"
            >
              <option value="">Choose a player…</option>
              {members.map((m) => (
                <option key={m.userId} value={String(m.userId)}>
                  {(m.displayName || m.username || `User ${m.userId}`) + (m.role === 'dm' ? ' (DM)' : '')}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
    </Card>
  );
}
