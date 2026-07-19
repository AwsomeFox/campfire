/**
 * Character sheet — mirrors design/06-character-sheet.html.
 * Owner or DM can edit everything (HP, conditions, stats, story); everyone else gets a
 * read-only view. The mockup renders as the owning player; we derive that from useAuth().
 */
import { useCallback, useEffect, useState, type MouseEvent } from 'react';
import { useParams, Link } from 'react-router-dom';
import type { Character } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { Card, Chip, Btn, TextInput, TextArea, HpBar, Skeleton, ErrorNote } from '../../components/ui';
import { Markdown } from '../../components/Markdown';
import { NotesRail } from '../../components/NotesRail';
import { initials, abilityMod } from './avatar';

const ABILITY_KEYS = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'];

export default function CharacterPage() {
  const { campaignId, characterId } = useParams<{ campaignId: string; characterId: string }>();
  const cid = Number(campaignId);
  const id = Number(characterId);
  const { me, roleIn } = useAuth();
  const role = roleIn(cid);
  const isDm = role === 'dm';

  const [character, setCharacter] = useState<Character | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api.get<Character>(`${API}/characters/${id}`);
      setCharacter(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load this character.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (Number.isFinite(id)) void load();
  }, [id, load]);

  if (!Number.isFinite(cid) || !Number.isFinite(id)) {
    return (
      <div className="max-w-5xl mx-auto px-4 mt-5">
        <ErrorNote message="Character not found." />
      </div>
    );
  }

  if (loading && !character) {
    return (
      <div className="max-w-5xl mx-auto px-4 mt-5 space-y-5">
        <Card>
          <Skeleton lines={4} />
        </Card>
      </div>
    );
  }

  if (error && !character) {
    return (
      <div className="max-w-5xl mx-auto px-4 mt-5">
        <ErrorNote message={error} onRetry={load} />
      </div>
    );
  }

  if (!character) return null;

  const myUserId = me?.user.id;
  const isOwner = character.ownerUserId != null && myUserId != null && character.ownerUserId === String(myUserId);
  const canEdit = isDm || isOwner;

  return (
    <div className="max-w-5xl mx-auto px-4 mt-5 space-y-5 pb-20 md:pb-10">
      <div className="text-sm text-slate-400">
        <Link to={`/c/${cid}/characters`} className="hover:text-white">
          Party
        </Link>
        <span className="mx-1.5 text-slate-700">/</span>
        <span className="text-slate-200 font-semibold">{character.name}</span>
      </div>

      {actionError && <ErrorNote message={actionError} onRetry={() => setActionError(null)} />}

      <HeaderCard character={character} canEdit={canEdit} isOwner={isOwner} onChange={load} onError={setActionError} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <AbilityCard character={character} canEdit={canEdit} />
        <StoryCard character={character} canEdit={canEdit} onChange={load} onError={setActionError} />
      </div>

      {isOwner && <NotesRail campaignId={cid} entityType="character" entityId={character.id} />}
    </div>
  );
}

function HeaderCard({
  character,
  canEdit,
  isOwner,
  onChange,
  onError,
}: {
  character: Character;
  canEdit: boolean;
  isOwner: boolean;
  onChange: () => void;
  onError: (msg: string | null) => void;
}) {
  const [editingSheet, setEditingSheet] = useState(false);

  return (
    <section className="cf-card p-5 md:p-6">
      <div className="flex flex-col sm:flex-row gap-5">
        <div className="h-28 w-28 rounded-2xl bg-purple-500/10 border-2 border-dashed border-purple-500/50 flex flex-col items-center justify-center text-purple-400 shrink-0 mx-auto sm:mx-0">
          <span className="text-3xl font-extrabold">{initials(character.name)}</span>
          <span className="text-[9px] font-semibold text-purple-500/80 text-center px-1">P1: upload portrait</span>
        </div>
        <div className="flex-1 space-y-3 min-w-0">
          {editingSheet ? (
            <SheetEditForm
              character={character}
              onCancel={() => setEditingSheet(false)}
              onSaved={() => {
                setEditingSheet(false);
                onChange();
              }}
              onError={onError}
            />
          ) : (
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h1 className="text-2xl font-extrabold text-white truncate">{character.name}</h1>
                <p className="text-sm text-slate-400">
                  {character.species || 'Unknown species'} ·{' '}
                  <span className="text-purple-400 font-semibold">
                    {character.className || 'Unknown class'} {character.level}
                  </span>
                  {character.background && <> · {character.background}</>}
                  {isOwner && <Chip variant="party" className="ml-2">yours</Chip>}
                </p>
              </div>
              {canEdit && (
                <Btn ghost className="!min-h-0 !py-1.5 text-xs shrink-0" onClick={() => setEditingSheet(true)}>
                  ✎ Edit sheet
                </Btn>
              )}
            </div>
          )}

          <HpEditor character={character} canEdit={canEdit} onChange={onChange} onError={onError} />
          <ConditionsRow character={character} canEdit={canEdit} onChange={onChange} onError={onError} />
        </div>
      </div>
    </section>
  );
}

function SheetEditForm({
  character,
  onCancel,
  onSaved,
  onError,
}: {
  character: Character;
  onCancel: () => void;
  onSaved: () => void;
  onError: (msg: string | null) => void;
}) {
  const [name, setName] = useState(character.name);
  const [species, setSpecies] = useState(character.species);
  const [className, setClassName] = useState(character.className);
  const [background, setBackground] = useState(character.background);
  const [level, setLevel] = useState(String(character.level));
  const [ac, setAc] = useState(character.ac != null ? String(character.ac) : '');
  const [stats, setStats] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const k of ABILITY_KEYS) init[k] = String(character.stats[k] ?? 10);
    return init;
  });
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!name.trim()) return;
    setSaving(true);
    onError(null);
    try {
      const statNums: Record<string, number> = {};
      for (const k of ABILITY_KEYS) statNums[k] = Number(stats[k]) || 0;
      await api.patch(`${API}/characters/${character.id}`, {
        name: name.trim(),
        species: species.trim(),
        className: className.trim(),
        background: background.trim(),
        level: Math.max(1, Math.min(20, Number(level) || 1)),
        ac: ac.trim() === '' ? null : Number(ac),
        stats: statNums,
      });
      onSaved();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Couldn't save the sheet.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
      <div className="grid grid-cols-2 gap-2.5">
        <TextInput value={species} onChange={(e) => setSpecies(e.target.value)} placeholder="Species" />
        <TextInput value={className} onChange={(e) => setClassName(e.target.value)} placeholder="Class" />
      </div>
      <div className="grid grid-cols-3 gap-2.5">
        <TextInput value={background} onChange={(e) => setBackground(e.target.value)} placeholder="Background" />
        <TextInput type="number" min={1} max={20} value={level} onChange={(e) => setLevel(e.target.value)} placeholder="Level" />
        <TextInput type="number" value={ac} onChange={(e) => setAc(e.target.value)} placeholder="AC" />
      </div>
      <div className="grid grid-cols-3 gap-2.5">
        {ABILITY_KEYS.map((k) => (
          <div key={k} className="space-y-1">
            <label className="text-[10px] font-bold text-slate-500 uppercase">{k}</label>
            <TextInput
              type="number"
              value={stats[k]}
              onChange={(e) => setStats((s) => ({ ...s, [k]: e.target.value }))}
            />
          </div>
        ))}
      </div>
      <div className="flex gap-2 justify-end">
        <Btn ghost type="button" onClick={onCancel} disabled={saving}>
          Cancel
        </Btn>
        <Btn type="button" onClick={save} disabled={saving || !name.trim()}>
          {saving ? 'Saving…' : 'Save'}
        </Btn>
      </div>
    </div>
  );
}

function HpEditor({
  character,
  canEdit,
  onChange,
  onError,
}: {
  character: Character;
  canEdit: boolean;
  onChange: () => void;
  onError: (msg: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [setValue, setSetValue] = useState('');

  async function applyDelta(delta: number) {
    if (busy) return;
    setBusy(true);
    onError(null);
    try {
      await api.post(`${API}/characters/${character.id}/hp`, { delta });
      onChange();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Couldn't update HP.");
    } finally {
      setBusy(false);
    }
  }

  async function applySet() {
    const n = Number(setValue);
    if (!Number.isFinite(n) || n < 0 || busy) return;
    setBusy(true);
    onError(null);
    try {
      await api.post(`${API}/characters/${character.id}/hp`, { set: n });
      setSetValue('');
      onChange();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Couldn't set HP.");
    } finally {
      setBusy(false);
    }
  }

  function handlePointerDown(delta: number, e: MouseEvent) {
    const step = e.shiftKey ? delta * 5 : delta;
    void applyDelta(step);
  }

  return (
    <div className="cf-inset p-3.5 flex items-center gap-4">
      <div className="flex-1 space-y-1.5 min-w-0">
        <div className="flex items-center justify-between">
          <p className="text-[10px] font-bold text-slate-500 uppercase">Hit points</p>
          <p className="text-sm font-bold text-white">
            {character.hpCurrent} <span className="text-slate-500 font-normal">/ {character.hpMax}</span>
          </p>
        </div>
        <HpBar current={character.hpCurrent} max={character.hpMax} />
        {canEdit && (
          <div className="flex items-center gap-1.5 pt-1">
            <TextInput
              type="number"
              placeholder="Set…"
              value={setValue}
              onChange={(e) => setSetValue(e.target.value)}
              className="!py-1 !min-h-0 !w-20 text-xs"
              style={{ minHeight: 0, padding: '4px 8px' }}
            />
            <Btn ghost className="!min-h-0 !py-1 text-xs" onClick={applySet} disabled={busy || setValue.trim() === ''}>
              Set
            </Btn>
          </div>
        )}
      </div>
      {canEdit && (
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            disabled={busy}
            onClick={(e) => handlePointerDown(-1, e)}
            title="−1 (shift-click for −5)"
            className="h-11 w-11 rounded-xl bg-rose-500/15 border border-rose-500/50 text-rose-400 font-bold text-lg disabled:opacity-50"
          >
            −
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={(e) => handlePointerDown(1, e)}
            title="+1 (shift-click for +5)"
            className="h-11 w-11 rounded-xl bg-emerald-500/15 border border-emerald-500/50 text-emerald-400 font-bold text-lg disabled:opacity-50"
          >
            +
          </button>
        </div>
      )}
    </div>
  );
}

function ConditionsRow({
  character,
  canEdit,
  onChange,
  onError,
}: {
  character: Character;
  canEdit: boolean;
  onChange: () => void;
  onError: (msg: string | null) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  async function addCondition() {
    const v = value.trim();
    if (!v || busy) return;
    setBusy(true);
    onError(null);
    try {
      await api.post(`${API}/characters/${character.id}/conditions`, { add: [v] });
      setValue('');
      setAdding(false);
      onChange();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Couldn't add condition.");
    } finally {
      setBusy(false);
    }
  }

  async function removeCondition(cond: string) {
    if (busy) return;
    setBusy(true);
    onError(null);
    try {
      await api.post(`${API}/characters/${character.id}/conditions`, { remove: [cond] });
      onChange();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Couldn't remove condition.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-[10px] font-bold text-slate-500 uppercase">Conditions</span>
      {character.conditions.map((cond) => (
        <Chip key={cond} variant="failed">
          {cond}
          {canEdit && (
            <button type="button" onClick={() => removeCondition(cond)} disabled={busy} className="ml-1">
              ✕
            </button>
          )}
        </Chip>
      ))}
      {canEdit &&
        (adding ? (
          <span className="inline-flex items-center gap-1">
            <input
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void addCondition();
                if (e.key === 'Escape') {
                  setAdding(false);
                  setValue('');
                }
              }}
              placeholder="Condition…"
              className="cf-input !min-h-0 !py-1 !w-28 text-xs"
              style={{ minHeight: 0, padding: '4px 8px' }}
            />
            <button type="button" onClick={addCondition} disabled={busy || !value.trim()} className="cf-chip cf-chip-available">
              Add
            </button>
          </span>
        ) : (
          <button type="button" onClick={() => setAdding(true)} className="cf-chip cf-chip-available">
            + add
          </button>
        ))}
    </div>
  );
}

function AbilityCard({ character, canEdit }: { character: Character; canEdit: boolean }) {
  return (
    <Card className="space-y-3">
      <h2 className="font-bold text-white text-sm border-b border-slate-700 pb-2">Ability scores</h2>
      <div className="grid grid-cols-3 gap-2.5">
        {ABILITY_KEYS.map((k) => {
          const score = character.stats[k] ?? 10;
          return (
            <div key={k} className="cf-inset p-3 text-center">
              <p className="text-[10px] font-bold text-slate-500">{k}</p>
              <p className="text-xl font-extrabold text-white">{score}</p>
              <p className="text-[10px] text-slate-500">{abilityMod(score)}</p>
            </div>
          );
        })}
      </div>
      <div className="grid grid-cols-3 gap-2.5 pt-1">
        <div className="cf-inset p-2.5 text-center">
          <p className="text-[9px] font-bold text-slate-500 uppercase">AC</p>
          <p className="font-bold text-white">{character.ac ?? '—'}</p>
        </div>
        <div className="cf-inset p-2.5 text-center">
          <p className="text-[9px] font-bold text-slate-500 uppercase">Level</p>
          <p className="font-bold text-white">{character.level}</p>
        </div>
        <div className="cf-inset p-2.5 text-center">
          <p className="text-[9px] font-bold text-slate-500 uppercase">Background</p>
          <p className="font-bold text-white truncate">{character.background || '—'}</p>
        </div>
      </div>
      {!canEdit && <p className="text-[10px] text-slate-600">Read-only — only the owner or DM can edit this sheet.</p>}
    </Card>
  );
}

function StoryCard({
  character,
  canEdit,
  onChange,
  onError,
}: {
  character: Character;
  canEdit: boolean;
  onChange: () => void;
  onError: (msg: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [notes, setNotes] = useState(character.notes);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    onError(null);
    try {
      await api.patch(`${API}/characters/${character.id}`, { notes });
      setEditing(false);
      onChange();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Couldn't save the story.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between border-b border-slate-700 pb-2">
        <h2 className="font-bold text-white text-sm">Story &amp; gear</h2>
        {canEdit && !editing && (
          <Btn
            ghost
            className="!min-h-0 !py-1 text-xs"
            onClick={() => {
              setNotes(character.notes);
              setEditing(true);
            }}
          >
            ✎ Edit
          </Btn>
        )}
      </div>

      {editing ? (
        <div className="space-y-2">
          <TextArea style={{ minHeight: 140 }} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Markdown supported…" />
          <div className="flex gap-2 justify-end">
            <Btn ghost className="!min-h-0 !py-2 text-sm" onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </Btn>
            <Btn className="!min-h-0 !py-2 text-sm" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Btn>
          </div>
        </div>
      ) : character.notes ? (
        <Markdown>{character.notes}</Markdown>
      ) : (
        <p className="text-sm text-slate-500">No story written yet.</p>
      )}
    </Card>
  );
}
