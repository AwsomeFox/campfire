/**
 * EntityPicker — a two-step "attach to…" control for note quick-capture (issue #65).
 * Pick an entity type (quest/npc/location/session/character), then a specific entity
 * from that type's list. Emits the chosen {entityType, entityId} up to the parent, or
 * null when no specific entity is selected. Extracted from the InboxPage resolve flow so
 * both the dashboard NotesQuickRail and MyNotesPage quick-capture share one implementation.
 *
 * `resetKey` — change it (e.g. after a successful save) to clear the picker back to
 * "No entity" without the parent needing to reach into internal state.
 */
import { useEffect, useState } from 'react';
import type { Note } from '@campfire/schema';
import { api, API } from '../../lib/api';

export type EntityTypeValue = Exclude<Note['entityType'], null>;
export type EntityLink = { entityType: EntityTypeValue; entityId: number };

/** Entity types quick-capture can attach to (campaign excluded — nothing anchors "to the campaign" here). */
const ATTACHABLE: { value: EntityTypeValue; label: string; listPath: string }[] = [
  { value: 'quest', label: 'Quest', listPath: 'quests' },
  { value: 'npc', label: 'NPC', listPath: 'npcs' },
  { value: 'faction', label: 'Faction', listPath: 'factions' },
  { value: 'location', label: 'Location', listPath: 'locations' },
  { value: 'session', label: 'Session', listPath: 'sessions' },
  { value: 'character', label: 'Character', listPath: 'characters' },
  { value: 'encounter', label: 'Encounter', listPath: 'encounters' },
];

interface EntityOption {
  id: number;
  label: string;
}

function optionLabel(type: EntityTypeValue, row: Record<string, unknown>): string {
  if (type === 'session') {
    const title = typeof row.title === 'string' && row.title ? ` — ${row.title}` : '';
    return `Session ${String(row.number ?? row.id)}${title}`;
  }
  const name = row.title ?? row.name;
  return typeof name === 'string' && name ? name : `#${String(row.id)}`;
}

export function EntityPicker({
  campaignId,
  onChange,
  disabled,
  resetKey,
}: {
  campaignId: number;
  onChange: (link: EntityLink | null) => void;
  disabled?: boolean;
  resetKey?: unknown;
}) {
  const [type, setType] = useState<EntityTypeValue | ''>('');
  const [id, setId] = useState<number | ''>('');
  const [options, setOptions] = useState<EntityOption[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(false);

  // Parent-driven reset (e.g. after a save): clear both selections.
  useEffect(() => {
    setType('');
    setId('');
  }, [resetKey]);

  // Load the option list whenever the chosen type changes.
  useEffect(() => {
    setId('');
    setOptions([]);
    if (!type) return;
    const meta = ATTACHABLE.find((l) => l.value === type);
    if (!meta) return;
    let cancelled = false;
    setOptionsLoading(true);
    api
      .get<Record<string, unknown>[]>(`${API}/campaigns/${campaignId}/${meta.listPath}`)
      .then((rows) => {
        if (cancelled) return;
        setOptions(rows.map((row) => ({ id: Number(row.id), label: optionLabel(type, row) })));
      })
      .catch(() => {
        if (!cancelled) setOptions([]);
      })
      .finally(() => {
        if (!cancelled) setOptionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [type, campaignId]);

  // A link only exists once BOTH a type and a specific id are chosen.
  function emit(nextType: EntityTypeValue | '', nextId: number | '') {
    onChange(nextType && nextId !== '' ? { entityType: nextType, entityId: nextId } : null);
  }

  return (
    <div className="flex gap-2 flex-wrap">
      <select
        className="cf-select !min-h-0 !py-2 text-xs"
        aria-label="Attach note to entity type"
        value={type}
        disabled={disabled}
        onChange={(e) => {
          const next = e.target.value as EntityTypeValue | '';
          setType(next);
          setId('');
          emit(next, '');
        }}
      >
        <option value="">No entity</option>
        {ATTACHABLE.map((l) => (
          <option key={l.value} value={l.value}>
            {l.label}
          </option>
        ))}
      </select>
      {type && (
        <select
          className="cf-select !min-h-0 !py-2 text-xs flex-1 min-w-0"
          aria-label="Attach note to entity"
          value={id}
          disabled={disabled || optionsLoading}
          onChange={(e) => {
            const next = e.target.value === '' ? '' : Number(e.target.value);
            setId(next);
            emit(type, next);
          }}
        >
          <option value="">{optionsLoading ? 'Loading…' : options.length === 0 ? 'Nothing to attach' : 'Pick one…'}</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
