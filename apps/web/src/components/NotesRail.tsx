/**
 * "My notes on this <entity>" rail — shared by quest/npc/location/session/character pages.
 * Shows the caller's notes (+ party-shared from others) anchored to an entity, with the
 * private → DM → party → whisper visibility toggle from the design package. A whisper
 * (issue #127) is a per-player secret anchored to this entity — "only the rogue notices
 * the trap door" lives right on the location/NPC page for that one player.
 *
 * Visibility controls use radiogroup / aria-checked semantics (issue #452) so exactly
 * one scope is selected and secret implications are announced.
 */
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { CampaignMember, Note, NoteListPage } from '@campfire/schema';
import { api, API } from '../lib/api';
import { Card, Chip, Btn, ErrorNote, type ChipVariant } from './ui';
import { Field, sanitizeFieldPrefix } from './Field';
import {
  NOTES_COMPOSE_PREFIX,
  NOTES_FIELD,
} from './formFieldLabels';
import { Markdown } from './Markdown';
import { GameIcon } from './GameIcon';
import { NOTE_VISIBILITY_ICON } from '../lib/uiIcons';
import {
  NOTE_BODY_HELP,
  NOTE_BODY_LABEL,
  NOTE_VISIBILITY_GROUP_LABEL,
  NOTE_VISIBILITY_HELP,
  NOTE_VISIBILITY_ORDER,
  noteVisibilityOptionLabel,
} from './noteVisibilityA11y';

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

export function NotesRail({ campaignId, entityType, entityId }: { campaignId: number; entityType: Note['entityType']; entityId: number }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [members, setMembers] = useState<CampaignMember[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState<Note['visibility']>('private');
  const [whisperTo, setWhisperTo] = useState('');
  const [saving, setSaving] = useState(false);
  const reactId = useId();
  // Mount-local prefix so multiple NotesRails never collide; still predictable
  // enough for tests via the NOTES_COMPOSE_PREFIX fragment.
  const idPrefix = `${NOTES_COMPOSE_PREFIX}-${sanitizeFieldPrefix(reactId)}`;
  const visHelpId = `${idPrefix}-vis-help`;
  const radioRefs = useRef<Partial<Record<Note['visibility'], HTMLButtonElement | null>>>({});

  const load = useCallback(async () => {
    setError(null);
    try {
      // Entity rails are typically small; still consume the paginated page shape
      // (issue #608) so an unbounded array is never the contract.
      const page = await api.get<NoteListPage>(
        `${API}/campaigns/${campaignId}/notes?entityType=${entityType}&entityId=${entityId}&limit=200`,
      );
      setNotes(page.items);
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

  function onVisibilityKeyDown(e: KeyboardEvent<HTMLButtonElement>, current: Note['visibility']) {
    const idx = NOTE_VISIBILITY_ORDER.indexOf(current);
    if (idx < 0) return;
    let nextIdx: number;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      nextIdx = (idx + 1) % NOTE_VISIBILITY_ORDER.length;
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      nextIdx = (idx - 1 + NOTE_VISIBILITY_ORDER.length) % NOTE_VISIBILITY_ORDER.length;
    } else if (e.key === 'Home') {
      nextIdx = 0;
    } else if (e.key === 'End') {
      nextIdx = NOTE_VISIBILITY_ORDER.length - 1;
    } else {
      return;
    }
    e.preventDefault();
    const next = NOTE_VISIBILITY_ORDER[nextIdx];
    setVisibility(next);
    radioRefs.current[next]?.focus();
  }

  return (
    <Card className="space-y-3" data-testid="notes-rail">
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
      <div className="space-y-2" data-testid="notes-compose">
        <Field
          idPrefix={idPrefix}
          name={NOTES_FIELD.body}
          as="textarea"
          label={NOTE_BODY_LABEL}
          labelClassName="text-[10px] text-slate-300 font-bold uppercase tracking-wide"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          help={NOTE_BODY_HELP}
          placeholder="Add a note… (private by default)"
          minHeight={70}
        />
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div
            className="seg seg-wrap min-w-0 flex-1"
            role="radiogroup"
            aria-label={NOTE_VISIBILITY_GROUP_LABEL}
            aria-describedby={visHelpId}
            data-testid="note-visibility"
          >
            {NOTE_VISIBILITY_ORDER.map((v) => {
              const checked = visibility === v;
              return (
                <button
                  key={v}
                  ref={(el) => {
                    radioRefs.current[v] = el;
                  }}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  aria-label={noteVisibilityOptionLabel(v)}
                  tabIndex={checked ? 0 : -1}
                  onClick={() => setVisibility(v)}
                  onKeyDown={(e) => onVisibilityKeyDown(e, v)}
                  className="seg-opt"
                  style={
                    checked
                      ? { color: 'var(--color-accent)', boxShadow: 'inset 0 0 0 1px var(--color-accent)' }
                      : undefined
                  }
                >
                  <VisLabel visibility={v} />
                </button>
              );
            })}
          </div>
          <Btn onClick={save} disabled={saving || !body.trim() || whisperMissingRecipient} style={{ minHeight: 0, paddingTop: 8, paddingBottom: 8 }}>
            Save
          </Btn>
        </div>
        <p id={visHelpId} className="text-[11px] text-slate-500 m-0">
          {NOTE_VISIBILITY_HELP[visibility]}
        </p>
        {visibility === 'whisper' && (
          <Field
            idPrefix={idPrefix}
            name={NOTES_FIELD.whisperTo}
            as="select"
            label={
              <span className="inline-flex items-center gap-1">
                <GameIcon slug={NOTE_VISIBILITY_ICON.whisper} size={12} /> Whisper to
              </span>
            }
            labelClassName="text-[11px] text-slate-400"
            selectClassName="cf-input !min-h-0 !py-1 text-xs w-full"
            value={whisperTo}
            onChange={(e) => setWhisperTo(e.target.value)}
            disabled={saving}
            help="Secret to exactly one player plus the DM."
            required
          >
            <option value="">Choose a player…</option>
            {members.map((m) => (
              <option key={m.userId} value={String(m.userId)}>
                {(m.displayName || m.username || `User ${m.userId}`) + (m.role === 'dm' ? ' (DM)' : '')}
              </option>
            ))}
          </Field>
        )}
      </div>
    </Card>
  );
}
