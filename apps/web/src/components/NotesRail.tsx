/**
 * "My notes on this <entity>" rail — shared by quest/npc/location/session/character pages.
 * Shows the caller's notes (+ party-shared from others) anchored to an entity, with the
 * private → DM → party visibility toggle from the design package.
 */
import { useCallback, useEffect, useState } from 'react';
import type { Note } from '@campfire/schema';
import { api, API } from '../lib/api';
import { Card, Chip, Btn, TextArea, ErrorNote, type ChipVariant } from './ui';
import { Markdown } from './Markdown';

const visMeta: Record<Note['visibility'], { chip: ChipVariant; label: string }> = {
  private: { chip: 'private', label: '🔒 Private' },
  dm_shared: { chip: 'dm', label: '🎩 DM' },
  party_shared: { chip: 'party', label: '👥 Party' },
};

export function NotesRail({ campaignId, entityType, entityId }: { campaignId: number; entityType: Note['entityType']; entityId: number }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState<Note['visibility']>('private');
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

  async function save() {
    if (!body.trim()) return;
    setSaving(true);
    try {
      await api.post(`${API}/campaigns/${campaignId}/notes`, { body: body.trim(), visibility, entityType, entityId });
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
      <h2 className="font-bold text-white text-sm">📝 Notes</h2>
      {error && <ErrorNote message={error} onRetry={load} />}
      {notes.map((n) => (
        <div key={n.id} className="cf-inset p-3 space-y-1">
          <div className="flex items-center justify-between">
            <Chip variant={visMeta[n.visibility].chip}>{visMeta[n.visibility].label}</Chip>
            <span className="text-[10px]" style={{ color: 'var(--color-neutral-600)' }}>
              {n.authorName || n.authorUserId}
            </span>
          </div>
          <Markdown className="!text-xs">{n.body}</Markdown>
        </div>
      ))}
      <div className="space-y-2">
        <TextArea style={{ minHeight: 70 }} placeholder="Add a note… (private by default)" value={body} onChange={(e) => setBody(e.target.value)} />
        <div className="flex items-center justify-between gap-2">
          <div className="seg">
            {(Object.keys(visMeta) as Note['visibility'][]).map((v) => (
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
                {visMeta[v].label}
              </button>
            ))}
          </div>
          <Btn onClick={save} disabled={saving || !body.trim()} style={{ minHeight: 0, paddingTop: 8, paddingBottom: 8 }}>
            Save
          </Btn>
        </div>
      </div>
    </Card>
  );
}
