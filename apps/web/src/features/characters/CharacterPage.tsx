/**
 * Character sheet — mirrors design/claude-design/Campfire.dc.html "Character sheet" (~720-864).
 * Layout: back link, avatar + name/class/level/owner header, HP card w/ editor, then a
 * two-column body — ability scores / HP / background / conditions on the left, a
 * portrait upload + player info panel on the right.
 *
 * Owner or DM can edit everything (HP, conditions, stats, story, portrait); everyone else
 * gets a read-only view.
 *
 * Design affordances with no backing API (rendered disabled with a "soon" tag — see report):
 *  - Saving throws (no per-character save/proficiency data in the schema)
 *  - Skills (no skill/proficiency data in the schema)
 *  - Actions (no per-attack/action-row API; dice themselves ARE modeled —
 *    see POST /campaigns/:id/roll, used by the dashboard Dice card and
 *    encounter dice log — this card is about missing action rows, not dice)
 *  - Inventory (no inventory API — `Character` has no items field)
 *  - D&D Beyond link (schema has `ddbId` but there is no linking flow/endpoint)
 */
import { useCallback, useEffect, useState, type MouseEvent } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import type { Attachment, Character, CampaignMember } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { Card, Chip, Btn, TextInput, TextArea, Skeleton, ErrorNote } from '../../components/ui';
import { Markdown } from '../../components/Markdown';
import { NotesRail } from '../../components/NotesRail';
import { ImageUpload, attachmentFileUrl } from '../../components/ImageUpload';
import { initials, abilityMod } from './avatar';

const ABILITY_KEYS = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'];

export default function CharacterPage() {
  const { campaignId, characterId } = useParams<{ campaignId: string; characterId: string }>();
  const cid = Number(campaignId);
  const id = Number(characterId);
  const navigate = useNavigate();
  const { me, roleIn } = useAuth();
  const role = roleIn(cid);
  const isDm = role === 'dm';

  const [character, setCharacter] = useState<Character | null>(null);
  const [members, setMembers] = useState<CampaignMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editingSheet, setEditingSheet] = useState(false);

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

  // Members list to resolve ownerUserId (a raw userId string) to a display name;
  // available to every campaign role, not just the DM.
  useEffect(() => {
    if (!Number.isFinite(cid)) return;
    let cancelled = false;
    (async () => {
      try {
        const list = await api.get<CampaignMember[]>(`${API}/campaigns/${cid}/members`);
        if (!cancelled) setMembers(list);
      } catch {
        if (!cancelled) setMembers([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cid]);

  function ownerLabel(ownerUserId: string | null): string {
    if (!ownerUserId) return 'DM-managed';
    const member = members.find((m) => String(m.userId) === ownerUserId);
    return member?.displayName || member?.username || 'Unknown player';
  }

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
  const hpPct = character.hpMax > 0 ? Math.max(0, Math.min(100, (character.hpCurrent / character.hpMax) * 100)) : 0;

  async function savePortrait(attachment: Attachment) {
    setActionError(null);
    try {
      await api.patch(`${API}/characters/${id}`, { portraitUrl: attachmentFileUrl(attachment.id) });
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't save the portrait.");
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-4 mt-5 space-y-4 pb-20 md:pb-10">
      <div>
        <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={() => navigate(`/c/${cid}/party`)}>
          ← Back
        </Btn>
      </div>

      {(error || actionError) && <ErrorNote message={actionError ?? error ?? ''} onRetry={() => { setActionError(null); void load(); }} />}

      <div className="flex items-center gap-3 flex-wrap">
        <div className="h-14 w-14 shrink-0 rounded-full bg-[var(--color-accent-900)] text-[var(--color-accent-200)] flex items-center justify-center text-[17px] font-semibold">
          {initials(character.name)}
        </div>
        <div>
          <h1 className="text-2xl font-extrabold text-white leading-tight">{character.name}</h1>
          <p className="text-sm text-slate-400">
            {character.className || 'Unknown class'} · Level {character.level} · played by{' '}
            {character.ownerUserId ? ownerLabel(character.ownerUserId) : 'DM'}
          </p>
        </div>
        {isOwner && <Chip variant="dm">You can edit</Chip>}
        {canEdit && !editingSheet && (
          <Btn ghost className="!min-h-0 !py-1.5 text-xs ml-auto" onClick={() => setEditingSheet(true)}>
            ✎ Edit sheet
          </Btn>
        )}
      </div>

      {editingSheet && (
        <Card className="space-y-3">
          <SheetEditForm
            character={character}
            onCancel={() => setEditingSheet(false)}
            onSaved={() => {
              setEditingSheet(false);
              void load();
            }}
            onError={setActionError}
          />
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-[1fr_280px] gap-4 items-start">
        <div className="space-y-4 min-w-0">
          <Card className="space-y-3">
            <p className="card-kicker">Ability scores</p>
            <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(84px, 1fr))' }}>
              {ABILITY_KEYS.map((k) => {
                const score = character.stats[k] ?? 10;
                return (
                  <div key={k} className="cf-inset text-center py-2.5 px-1.5">
                    <p className="text-[10px] tracking-wide text-slate-500">{k}</p>
                    <p className="text-xl font-heading my-0.5">{score}</p>
                    <p className="text-[11px]" style={{ color: 'var(--color-accent-300)' }}>
                      {abilityMod(score)}
                    </p>
                  </div>
                );
              })}
            </div>
          </Card>

          <Card className="space-y-3">
            <div className="flex items-baseline gap-2.5">
              <p className="card-kicker">Hit points</p>
              <span className="text-xs text-slate-500">AC {character.ac ?? '—'}</span>
            </div>
            <div className="flex items-center gap-3.5 flex-wrap">
              <span className="font-heading text-[34px] leading-none">
                {character.hpCurrent}
                <span className="text-base text-slate-500"> / {character.hpMax}</span>
              </span>
              <div className="flex-1 min-w-[120px] h-[7px] rounded bg-[var(--color-neutral-800)] overflow-hidden">
                <div className="h-full bg-[var(--color-accent)]" style={{ width: `${hpPct}%` }} />
              </div>
            </div>
            {canEdit && <HpEditor character={character} onChange={load} onError={setActionError} />}
          </Card>

          <Card className="space-y-2">
            <div className="flex items-center gap-2">
              <p className="card-kicker mb-0">Actions</p>
              <span className="tag tag-neutral" style={{ fontSize: 9 }}>soon</span>
            </div>
            <p className="text-xs text-slate-500">
              Per-attack action rows aren't modeled yet — attach a weapon/spell list here. Dice already work: roll
              from the dashboard's Dice card or an encounter's dice log.
            </p>
          </Card>

          <Card className="space-y-2">
            <div className="flex items-center gap-2">
              <p className="card-kicker mb-0">Saving throws</p>
              <span className="tag tag-neutral" style={{ fontSize: 9 }}>soon</span>
            </div>
            <div className="grid gap-2 opacity-40 pointer-events-none" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(84px, 1fr))' }}>
              {ABILITY_KEYS.map((k) => (
                <div key={k} className="cf-inset text-center py-2 px-1.5">
                  <p className="text-[10px] tracking-wide text-slate-500">{k}</p>
                  <p className="text-[15px] mt-0.5">—</p>
                </div>
              ))}
            </div>
          </Card>

          <Card className="space-y-2">
            <div className="flex items-center gap-2">
              <p className="card-kicker mb-0">Skills</p>
              <span className="tag tag-neutral" style={{ fontSize: 9 }}>soon</span>
            </div>
            <p className="text-xs text-slate-500">Skill proficiencies aren't tracked yet — this arrives with the full sheet model.</p>
          </Card>

          <Card className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="card-kicker mb-0">Background</p>
            </div>
            <div className="space-y-1.5 text-[13px]">
              <div className="flex justify-between gap-2">
                <span className="text-muted">Species</span>
                <span>{character.species || '—'}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted">Background</span>
                <span>{character.background || '—'}</span>
              </div>
            </div>
            <StoryBody character={character} canEdit={canEdit} onChange={load} onError={setActionError} />
          </Card>

          <Card className="space-y-2">
            <div className="flex items-baseline gap-2.5">
              <p className="card-kicker mb-0">Inventory</p>
              <span className="tag tag-neutral" style={{ fontSize: 9 }}>soon</span>
            </div>
            <p className="text-xs text-slate-500">Item tracking arrives with the Compendium — no inventory API yet.</p>
          </Card>

          <Card className="space-y-2.5">
            <p className="card-kicker mb-0">Conditions</p>
            <ConditionsRow character={character} canEdit={canEdit} onChange={load} onError={setActionError} />
          </Card>
        </div>

        <div className="space-y-4 min-w-0">
          <Card className="items-center text-center py-6 space-y-1.5">
            {canEdit ? (
              <ImageUpload
                campaignId={cid}
                kind="portrait"
                shape="circle"
                previewUrl={character.portraitUrl ?? undefined}
                label="Portrait"
                onUploaded={savePortrait}
                onError={setActionError}
              />
            ) : character.portraitUrl ? (
              <img
                src={character.portraitUrl}
                alt=""
                className="h-24 w-24 rounded-full object-cover border border-[var(--color-neutral-700)]"
              />
            ) : (
              <span className="h-24 w-24 rounded-full border border-dashed border-[var(--color-neutral-700)] flex items-center justify-center text-[11px] text-[var(--color-neutral-600)]">
                Portrait
              </span>
            )}
            {canEdit && <span className="text-[11px] text-slate-500">Click or drop to change</span>}
          </Card>
          <Card className="space-y-2">
            <p className="card-kicker mb-0">Player</p>
            <div className="space-y-1.5 text-[13px]">
              <div className="flex justify-between">
                <span className="text-muted">Owner</span>
                <span>{ownerLabel(character.ownerUserId)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">D&amp;D Beyond</span>
                <span className="text-muted">Not linked — soon</span>
              </div>
            </div>
          </Card>
        </div>
      </div>

      {isOwner && <NotesRail campaignId={cid} entityType="character" entityId={character.id} />}
    </div>
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
  const [hpMax, setHpMax] = useState(String(character.hpMax));
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
        hpMax: Math.max(1, Number(hpMax) || 1),
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
        <div className="space-y-1">
          <TextInput
            type="number"
            min={1}
            value={hpMax}
            onChange={(e) => setHpMax(e.target.value)}
            placeholder="Max HP"
            title="Current HP is clamped to the new max automatically."
          />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2.5">
        {ABILITY_KEYS.map((k) => (
          <div key={k} className="space-y-1">
            <label className="text-[10px] text-slate-500 font-bold uppercase">{k}</label>
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
  onChange,
  onError,
}: {
  character: Character;
  onChange: () => void;
  onError: (msg: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);

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

  async function fullHeal() {
    if (busy) return;
    setBusy(true);
    onError(null);
    try {
      await api.post(`${API}/characters/${character.id}/hp`, { set: character.hpMax });
      onChange();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Couldn't heal to full.");
    } finally {
      setBusy(false);
    }
  }

  function click(delta: number, e: MouseEvent) {
    void applyDelta(e.shiftKey ? delta * 5 : delta);
  }

  return (
    <div className="flex gap-2 flex-wrap">
      <Btn className="!min-h-0" style={{ minWidth: 52, minHeight: 44 }} disabled={busy} onClick={(e) => click(-5, e)}>
        −5
      </Btn>
      <Btn className="!min-h-0" style={{ minWidth: 52, minHeight: 44 }} disabled={busy} onClick={(e) => click(-1, e)}>
        −1
      </Btn>
      <Btn className="!min-h-0" style={{ minWidth: 52, minHeight: 44 }} disabled={busy} onClick={(e) => click(1, e)}>
        +1
      </Btn>
      <Btn className="!min-h-0" style={{ minWidth: 52, minHeight: 44 }} disabled={busy} onClick={(e) => click(5, e)}>
        +5
      </Btn>
      <Btn style={{ minHeight: 44 }} disabled={busy} onClick={fullHeal}>
        Full heal
      </Btn>
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
    <div className="flex items-center gap-1.5 flex-wrap">
      {character.conditions.map((cond) => (
        <span key={cond} className="tag tag-outline" style={{ gap: 6 }}>
          {cond}
          {canEdit && (
            <button
              type="button"
              aria-label={`Remove ${cond}`}
              onClick={() => removeCondition(cond)}
              disabled={busy}
              style={{
                cursor: busy ? 'default' : 'pointer',
                opacity: 0.7,
                background: 'transparent',
                border: 0,
                padding: 0,
                font: 'inherit',
                color: 'inherit',
              }}
            >
              ✕
            </button>
          )}
        </span>
      ))}
      {character.conditions.length === 0 && <span className="text-muted text-xs">None — feeling fine.</span>}
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
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="btn btn-ghost"
            style={{ fontSize: 12, border: '1px dashed var(--color-divider)', borderRadius: 'var(--radius-md)', minHeight: 0, padding: '4px 10px' }}
          >
            + add
          </button>
        ))}
    </div>
  );
}

function StoryBody({
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

  if (editing) {
    return (
      <div className="space-y-2">
        <TextArea style={{ minHeight: 140 }} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Markdown supported…" />
        <div className="flex gap-2 justify-end">
          <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={() => setEditing(false)} disabled={saving}>
            Cancel
          </Btn>
          <Btn className="!min-h-0 !py-1.5 text-xs" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Btn>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {character.notes ? (
        <Markdown className="!text-[13px]">{character.notes}</Markdown>
      ) : (
        <p className="text-sm text-slate-500 italic">No story written yet.</p>
      )}
      {canEdit && (
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
  );
}
