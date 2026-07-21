/**
 * Character sheet — mirrors design/claude-design/Campfire.dc.html "Character sheet" (~720-864).
 * Layout: back link, avatar + name/class/level/owner header, HP card w/ editor, then a
 * two-column body — ability scores / HP / background / conditions on the left, a
 * portrait upload + player info panel on the right.
 *
 * Owner or DM can edit everything (HP, conditions, stats, saves, skills, actions,
 * spell slots, story, portrait); everyone else gets a read-only view.
 *
 * Sheet depth (issue #1): saving throws (toggle proficiency per ability), skills
 * (cycle none → proficient → expertise), actions (attack/spell/feature rows), and
 * spell slots (per-level pips; spend/restore via POST /characters/:id/spell-slots,
 * maxima via PATCH spellSlots) are all backed by the Character schema now.
 *
 * Design affordances with no backing API (rendered disabled with a "soon" tag — see report):
 *  - Inventory (no inventory API — `Character` has no items field)
 *  - D&D Beyond link (schema has `ddbId` but there is no linking flow/endpoint)
 */
import { useCallback, useEffect, useState, type MouseEvent } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import type { Attachment, Character, CharacterAction, CampaignMember, CharacterStatus, SkillRank } from '@campfire/schema';
import { xpForLevel, ruleSystemAdapter, type RuleSystemAdapter } from '@campfire/schema';
import { CHARACTER_STATUSES, STATUS_LABEL, StatusTag } from './status';
import { api, API, ApiError } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { useCampaign } from '../../app/CampaignContext';
import { Card, Chip, Btn, TextInput, TextArea, Skeleton, ErrorNote } from '../../components/ui';
import { NotFoundState } from '../../components/NotFoundState';
import { Markdown } from '../../components/Markdown';
import { NotesRail } from '../../components/NotesRail';
import { ImageUpload, attachmentFileUrl } from '../../components/ImageUpload';
import { initials } from './avatar';

const ABILITY_KEYS = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'] as const;
type Ability = (typeof ABILITY_KEYS)[number];

/** SRD 5e skill list with governing abilities. */
const SKILLS: ReadonlyArray<{ name: string; ability: Ability }> = [
  { name: 'Acrobatics', ability: 'DEX' },
  { name: 'Animal Handling', ability: 'WIS' },
  { name: 'Arcana', ability: 'INT' },
  { name: 'Athletics', ability: 'STR' },
  { name: 'Deception', ability: 'CHA' },
  { name: 'History', ability: 'INT' },
  { name: 'Insight', ability: 'WIS' },
  { name: 'Intimidation', ability: 'CHA' },
  { name: 'Investigation', ability: 'INT' },
  { name: 'Medicine', ability: 'WIS' },
  { name: 'Nature', ability: 'INT' },
  { name: 'Perception', ability: 'WIS' },
  { name: 'Performance', ability: 'CHA' },
  { name: 'Persuasion', ability: 'CHA' },
  { name: 'Religion', ability: 'INT' },
  { name: 'Sleight of Hand', ability: 'DEX' },
  { name: 'Stealth', ability: 'DEX' },
  { name: 'Survival', ability: 'WIS' },
];

const SPELL_LEVELS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

/** 5e proficiency bonus by level: +2 at 1-4 up to +6 at 17-20. */
function profBonus(level: number): number {
  return 2 + Math.floor((Math.max(1, level) - 1) / 4);
}

/**
 * Read an ability score tolerantly. `stats` is a free-keyed record, so a character
 * saved with lowercase keys (`{ str: 16 }` — schema-valid, and what some API/MCP
 * writers produce) would miss a canonical-uppercase lookup and read 10 (issue #48).
 * The server now folds keys to uppercase, but this guards data that reaches the
 * client by any other path. Defaults to 10 when the ability is absent.
 */
function abilityScore(character: Character, ability: Ability): number {
  const stats = character.stats;
  return stats[ability] ?? stats[ability.toLowerCase()] ?? 10;
}

// Ability modifier comes from the active campaign's rule-system adapter (issue #234),
// not the 5e formula hardcoded here — so a future non-5e adapter's math takes effect.
// Default (5e) yields floor((score - 10) / 2), unchanged.
function modOf(adapter: RuleSystemAdapter, character: Character, ability: Ability): number {
  return adapter.abilityModifier(abilityScore(character, ability));
}

function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

export default function CharacterPage() {
  const { campaignId, characterId } = useParams<{ campaignId: string; characterId: string }>();
  const cid = Number(campaignId);
  const id = Number(characterId);
  const navigate = useNavigate();
  const { me, roleIn } = useAuth();
  const role = roleIn(cid);
  const isDm = role === 'dm';
  // Rule-system adapter resolved from the active campaign (issue #234): drives ability
  // modifiers and the condition vocabulary instead of a call-site 5e default.
  const adapter = ruleSystemAdapter(useCampaign(Number.isFinite(cid) ? cid : undefined)?.ruleSystem);

  const [character, setCharacter] = useState<Character | null>(null);
  const [members, setMembers] = useState<CampaignMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editingSheet, setEditingSheet] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    setNotFound(false);
    try {
      const data = await api.get<Character>(`${API}/characters/${id}`);
      setCharacter(data);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setNotFound(true);
      } else {
        setError(err instanceof ApiError ? err.message : "Couldn't load this character.");
      }
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

  if (notFound && !character) {
    return (
      <div className="max-w-5xl mx-auto px-4 mt-5">
        <NotFoundState title="Character not found" backTo={`/c/${cid}/party`} backLabel="← Back to party" />
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
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-2xl font-extrabold text-white leading-tight break-words">{character.name}</h1>
            {character.status !== 'active' && <StatusTag status={character.status} />}
          </div>
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
                const score = abilityScore(character, k);
                return (
                  <div key={k} className="cf-inset text-center py-2.5 px-1.5">
                    <p className="text-[10px] tracking-wide text-slate-500">{k}</p>
                    <p className="text-xl font-heading my-0.5">{score}</p>
                    <p className="text-[11px]" style={{ color: 'var(--color-accent-300)' }}>
                      {signed(adapter.abilityModifier(score))}
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

          <XpCard character={character} canEdit={canEdit} onChange={load} onError={setActionError} />

          <ActionsCard character={character} canEdit={canEdit} onChange={load} onError={setActionError} />

          <SavingThrowsCard character={character} canEdit={canEdit} onChange={load} onError={setActionError} adapter={adapter} />

          <SkillsCard character={character} canEdit={canEdit} onChange={load} onError={setActionError} adapter={adapter} />

          <SpellSlotsCard character={character} canEdit={canEdit} onChange={load} onError={setActionError} />

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
            <ConditionsRow character={character} canEdit={canEdit} onChange={load} onError={setActionError} adapter={adapter} />
          </Card>

          {isDm && <DmSecretCard character={character} onChange={load} onError={setActionError} />}
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
  const [status, setStatus] = useState<CharacterStatus>(character.status);
  const [stats, setStats] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const k of ABILITY_KEYS) init[k] = String(abilityScore(character, k));
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
        status,
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
        <label className="space-y-1 col-span-2">
          <span className="text-[10px] text-slate-500 font-bold uppercase">Status</span>
          <select
            className="cf-select w-full"
            aria-label="Character status"
            value={status}
            onChange={(e) => setStatus(e.target.value as CharacterStatus)}
            title="Only active characters are auto-added to new encounters. Dead/retired/inactive PCs stay on the roster."
          >
            {CHARACTER_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
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

/**
 * Experience card — XP total, progress toward the next 5e threshold, a
 * quick-award input, and the guided level-up flow (issue #14). The threshold
 * is advisory only: "Level up" always works so milestone campaigns aren't
 * blocked, but the card calls out when the XP actually qualifies.
 */
function XpCard({
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
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [levellingUp, setLevellingUp] = useState(false);
  const [newHpMax, setNewHpMax] = useState(String(character.hpMax));
  // Level-up celebration (issue #67): the level a confirm just reached; the
  // banner clears itself after a beat (timeout, not animationEnd, so it also
  // clears under prefers-reduced-motion where no animation fires).
  const [celebratedLevel, setCelebratedLevel] = useState<number | null>(null);
  useEffect(() => {
    if (celebratedLevel == null) return;
    const t = setTimeout(() => setCelebratedLevel(null), 2600);
    return () => clearTimeout(t);
  }, [celebratedLevel]);

  const atCap = character.level >= 20;
  const currentThreshold = xpForLevel(character.level);
  const nextThreshold = atCap ? null : xpForLevel(character.level + 1);
  const ready = nextThreshold != null && character.xp >= nextThreshold;
  const pct =
    nextThreshold == null
      ? 100
      : Math.max(0, Math.min(100, ((character.xp - currentThreshold) / (nextThreshold - currentThreshold)) * 100));

  async function addXp() {
    const delta = Number(amount);
    if (!Number.isFinite(delta) || !Number.isInteger(delta) || delta === 0 || busy) return;
    setBusy(true);
    onError(null);
    try {
      await api.post(`${API}/characters/${character.id}/xp`, { delta });
      setAmount('');
      onChange();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Couldn't award XP.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmLevelUp() {
    if (busy) return;
    const hpMaxNum = Number(newHpMax);
    if (!Number.isInteger(hpMaxNum) || hpMaxNum < 1) return;
    setBusy(true);
    onError(null);
    try {
      await api.post(`${API}/characters/${character.id}/level-up`, hpMaxNum !== character.hpMax ? { hpMax: hpMaxNum } : {});
      setLevellingUp(false);
      setCelebratedLevel(character.level + 1);
      onChange();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Couldn't level up.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-3">
      <div className="flex items-baseline gap-2.5 flex-wrap">
        <p className="card-kicker mb-0">Experience</p>
        {ready && (
          <span className="tag tag-accent cf-anim-ready" style={{ fontSize: 10 }}>
            Ready to level up
          </span>
        )}
      </div>
      {celebratedLevel != null && (
        <div
          className="cf-anim-levelup cf-inset flex items-center gap-2.5 px-3.5 py-2.5"
          role="status"
          style={{
            background: 'linear-gradient(90deg, color-mix(in srgb, var(--cf-crit) 20%, transparent), color-mix(in srgb, var(--color-accent) 22%, transparent))',
            border: '1px solid color-mix(in srgb, var(--cf-crit) 45%, transparent)',
          }}
        >
          <span aria-hidden="true" style={{ fontSize: 22, position: 'relative' }}>
            🎉
            <span className="cf-sparkle" aria-hidden="true" style={{ position: 'absolute', top: -6, right: -8, fontSize: 12 }}>✨</span>
          </span>
          <span className="font-heading" style={{ fontSize: 15, color: 'var(--cf-crit)' }}>
            Level {celebratedLevel}! You grow stronger.
          </span>
        </div>
      )}
      <div className="flex items-center gap-3.5 flex-wrap">
        <span className="font-heading text-[34px] leading-none">
          {character.xp.toLocaleString()}
          <span className="text-base text-slate-500">
            {nextThreshold != null ? ` / ${nextThreshold.toLocaleString()} XP` : ' XP'}
          </span>
        </span>
        <div className="flex-1 min-w-[120px] h-[7px] rounded bg-[var(--color-neutral-800)] overflow-hidden">
          <div className="h-full bg-[var(--color-accent)]" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <p className="text-xs text-slate-500">
        {atCap
          ? 'Level 20 — the summit. XP still accrues for bragging rights.'
          : ready
            ? `Enough XP for level ${character.level + 1}!`
            : `${(nextThreshold! - character.xp).toLocaleString()} XP to level ${character.level + 1}.`}
      </p>
      {canEdit && (
        <div className="flex gap-2 flex-wrap items-center">
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void addXp();
            }}
            placeholder="XP…"
            className="cf-input !min-h-0 !w-24 text-sm"
            style={{ minHeight: 44, padding: '4px 10px' }}
          />
          <Btn className="!min-h-0" style={{ minHeight: 44 }} disabled={busy || !amount.trim()} onClick={addXp}>
            + Award XP
          </Btn>
          {!atCap && !levellingUp && (
            <Btn
              ghost={!ready}
              className="!min-h-0 ml-auto"
              style={{ minHeight: 44 }}
              disabled={busy}
              onClick={() => {
                setNewHpMax(String(character.hpMax));
                setLevellingUp(true);
              }}
            >
              ⬆ Level up
            </Btn>
          )}
        </div>
      )}
      {canEdit && levellingUp && (
        <div className="cf-inset p-3 space-y-2.5">
          <p className="text-sm font-bold text-white">
            Level {character.level} → {character.level + 1}
          </p>
          <p className="text-xs text-slate-500">
            Set the new max HP (currently {character.hpMax}) — hit points gained are added to current HP too.
          </p>
          <div className="flex gap-2 items-center flex-wrap">
            <div className="w-32">
              <TextInput
                type="number"
                min={1}
                value={newHpMax}
                onChange={(e) => setNewHpMax(e.target.value)}
                placeholder="New max HP"
              />
            </div>
            <div className="flex-1" />
            <Btn ghost className="!min-h-0 !py-1.5 text-xs" disabled={busy} onClick={() => setLevellingUp(false)}>
              Cancel
            </Btn>
            <Btn
              className="!min-h-0 !py-1.5 text-xs"
              disabled={busy || !Number.isInteger(Number(newHpMax)) || Number(newHpMax) < 1}
              onClick={confirmLevelUp}
            >
              {busy ? 'Levelling…' : `Confirm level ${character.level + 1}`}
            </Btn>
          </div>
        </div>
      )}
    </Card>
  );
}

type SheetCardProps = {
  character: Character;
  canEdit: boolean;
  onChange: () => void;
  onError: (msg: string | null) => void;
};

function SavingThrowsCard({ character, canEdit, onChange, onError, adapter }: SheetCardProps & { adapter: RuleSystemAdapter }) {
  const [busy, setBusy] = useState(false);
  const pb = profBonus(character.level);
  const profs = new Set(character.saveProficiencies);

  async function toggle(k: Ability) {
    if (!canEdit || busy) return;
    setBusy(true);
    onError(null);
    try {
      const next = profs.has(k)
        ? character.saveProficiencies.filter((a) => a !== k)
        : [...character.saveProficiencies, k];
      await api.patch(`${API}/characters/${character.id}`, { saveProficiencies: next });
      onChange();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Couldn't update saving throws.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-2">
      <div className="flex items-center gap-2">
        <p className="card-kicker mb-0">Saving throws</p>
        <span className="text-[11px] text-slate-500">proficiency {signed(pb)}</span>
      </div>
      <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(84px, 1fr))' }}>
        {ABILITY_KEYS.map((k) => {
          const proficient = profs.has(k);
          const mod = modOf(adapter, character, k) + (proficient ? pb : 0);
          const inner = (
            <>
              <p className="text-[10px] tracking-wide text-slate-500">
                {k}
                {proficient && (
                  <span className="ml-1" style={{ color: 'var(--color-accent-300)' }}>
                    ●
                  </span>
                )}
              </p>
              <p className="text-[15px] mt-0.5 font-semibold">{signed(mod)}</p>
            </>
          );
          if (!canEdit) {
            return (
              <div key={k} className="cf-inset text-center py-2 px-1.5">
                {inner}
              </div>
            );
          }
          return (
            <button
              key={k}
              type="button"
              onClick={() => toggle(k)}
              disabled={busy}
              className="cf-inset text-center py-2 px-1.5"
              style={{ cursor: busy ? 'default' : 'pointer', font: 'inherit', color: 'inherit' }}
              title={proficient ? `Remove ${k} save proficiency` : `Add ${k} save proficiency`}
            >
              {inner}
            </button>
          );
        })}
      </div>
      {canEdit && <p className="text-[11px] text-slate-500">Tap an ability to toggle save proficiency.</p>}
    </Card>
  );
}

function SkillsCard({ character, canEdit, onChange, onError, adapter }: SheetCardProps & { adapter: RuleSystemAdapter }) {
  const [busy, setBusy] = useState(false);
  const pb = profBonus(character.level);

  async function cycle(name: string) {
    if (!canEdit || busy) return;
    setBusy(true);
    onError(null);
    try {
      const rank = character.skills[name];
      const next: Record<string, SkillRank> = { ...character.skills };
      if (rank === undefined) next[name] = 'proficient';
      else if (rank === 'proficient') next[name] = 'expertise';
      else delete next[name];
      await api.patch(`${API}/characters/${character.id}`, { skills: next });
      onChange();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Couldn't update skills.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-2">
      <div className="flex items-center gap-2">
        <p className="card-kicker mb-0">Skills</p>
        {canEdit && <span className="text-[11px] text-slate-500">tap to cycle: none → proficient ● → expertise ★</span>}
      </div>
      <div className="grid gap-x-4 gap-y-0.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
        {SKILLS.map(({ name, ability }) => {
          const rank = character.skills[name];
          const mod = modOf(adapter, character, ability) + (rank === 'expertise' ? pb * 2 : rank === 'proficient' ? pb : 0);
          const marker = rank === 'expertise' ? '★' : rank === 'proficient' ? '●' : '○';
          const row = (
            <>
              <span
                className="w-4 shrink-0 text-center"
                style={{ color: rank ? 'var(--color-accent-300)' : 'var(--color-neutral-600)' }}
                aria-hidden
              >
                {marker}
              </span>
              <span className="flex-1 text-left truncate">{name}</span>
              <span className="text-[10px] text-slate-500">{ability}</span>
              <span className="w-8 text-right font-semibold">{signed(mod)}</span>
            </>
          );
          if (!canEdit) {
            return (
              <div key={name} className="flex items-center gap-1.5 text-[13px] py-0.5">
                {row}
              </div>
            );
          }
          return (
            <button
              key={name}
              type="button"
              onClick={() => cycle(name)}
              disabled={busy}
              className="flex items-center gap-1.5 text-[13px] py-0.5"
              style={{ cursor: busy ? 'default' : 'pointer', background: 'transparent', border: 0, padding: 0, font: 'inherit', color: 'inherit' }}
              title={rank === undefined ? `Mark ${name} proficient` : rank === 'proficient' ? `Mark ${name} expertise` : `Clear ${name} proficiency`}
            >
              {row}
            </button>
          );
        })}
      </div>
    </Card>
  );
}

function ActionsCard({ character, canEdit, onChange, onError }: SheetCardProps) {
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState('');
  const [toHit, setToHit] = useState('');
  const [damage, setDamage] = useState('');
  const [notes, setNotes] = useState('');

  async function saveActions(next: CharacterAction[], failMsg: string) {
    if (busy) return;
    setBusy(true);
    onError(null);
    try {
      await api.patch(`${API}/characters/${character.id}`, { actions: next });
      onChange();
      return true;
    } catch (err) {
      onError(err instanceof ApiError ? err.message : failMsg);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    if (!name.trim()) return;
    const action: CharacterAction = {
      name: name.trim(),
      kind: kind.trim(),
      toHit: toHit.trim(),
      damage: damage.trim(),
      notes: notes.trim(),
    };
    const ok = await saveActions([...character.actions, action], "Couldn't add the action.");
    if (ok) {
      setName('');
      setKind('');
      setToHit('');
      setDamage('');
      setNotes('');
      setAdding(false);
    }
  }

  function remove(index: number) {
    void saveActions(
      character.actions.filter((_, i) => i !== index),
      "Couldn't remove the action.",
    );
  }

  return (
    <Card className="space-y-2.5">
      <div className="flex items-center gap-2">
        <p className="card-kicker mb-0">Actions</p>
        {canEdit && !adding && (
          <Btn ghost className="!min-h-0 !py-1 text-xs ml-auto" onClick={() => setAdding(true)}>
            + Add
          </Btn>
        )}
      </div>
      {character.actions.length === 0 && !adding && (
        <p className="text-xs text-slate-500">
          No actions yet{canEdit ? ' — add attacks, spells, and features' : ''}. Dice already work: roll from the
          dashboard's Dice card or an encounter's dice log.
        </p>
      )}
      {character.actions.map((action, i) => (
        <div key={`${action.name}-${i}`} className="cf-inset px-3 py-2 flex items-start gap-2.5">
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-semibold flex items-center gap-1.5 flex-wrap">
              {action.name}
              {action.kind && (
                <span className="tag tag-neutral" style={{ fontSize: 9 }}>
                  {action.kind}
                </span>
              )}
            </p>
            <p className="text-xs text-slate-400 flex gap-3 flex-wrap">
              {action.toHit && <span>to hit {action.toHit}</span>}
              {action.damage && <span>{action.damage}</span>}
            </p>
            {action.notes && <p className="text-[11px] text-slate-500 mt-0.5">{action.notes}</p>}
          </div>
          {canEdit && (
            <button
              type="button"
              aria-label={`Remove ${action.name}`}
              onClick={() => remove(i)}
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
        </div>
      ))}
      {adding && (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2.5">
            <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (Longsword, Fire Bolt…)" />
            <TextInput value={kind} onChange={(e) => setKind(e.target.value)} placeholder="Kind (melee, ranged, spell…)" />
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <TextInput value={toHit} onChange={(e) => setToHit(e.target.value)} placeholder="To hit (+5)" />
            <TextInput value={damage} onChange={(e) => setDamage(e.target.value)} placeholder="Damage (1d8+3 slashing)" />
          </div>
          <TextInput value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (versatile, 60 ft range…)" />
          <div className="flex gap-2 justify-end">
            <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={() => setAdding(false)} disabled={busy}>
              Cancel
            </Btn>
            <Btn className="!min-h-0 !py-1.5 text-xs" onClick={add} disabled={busy || !name.trim()}>
              {busy ? 'Saving…' : 'Add action'}
            </Btn>
          </div>
        </div>
      )}
    </Card>
  );
}

function SpellSlotsCard({ character, canEdit, onChange, onError }: SheetCardProps) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [maxima, setMaxima] = useState<Record<string, string>>({});

  const levels = SPELL_LEVELS.filter((lvl) => (character.spellSlots[lvl]?.max ?? 0) > 0);

  async function adjust(level: string, delta: number) {
    if (busy) return;
    setBusy(true);
    onError(null);
    try {
      await api.post(`${API}/characters/${character.id}/spell-slots`, { level: Number(level), delta });
      onChange();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Couldn't update spell slots.");
    } finally {
      setBusy(false);
    }
  }

  function startEdit() {
    const init: Record<string, string> = {};
    for (const lvl of SPELL_LEVELS) init[lvl] = String(character.spellSlots[lvl]?.max ?? 0);
    setMaxima(init);
    setEditing(true);
  }

  async function saveMaxima() {
    if (busy) return;
    setBusy(true);
    onError(null);
    try {
      const next: Record<string, { max: number; used: number }> = {};
      for (const lvl of SPELL_LEVELS) {
        const max = Math.max(0, Math.min(20, Number(maxima[lvl]) || 0));
        if (max > 0) next[lvl] = { max, used: Math.min(character.spellSlots[lvl]?.used ?? 0, max) };
      }
      await api.patch(`${API}/characters/${character.id}`, { spellSlots: next });
      setEditing(false);
      onChange();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Couldn't save spell slots.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-2.5">
      <div className="flex items-center gap-2">
        <p className="card-kicker mb-0">Spell slots</p>
        {canEdit && !editing && (
          <Btn ghost className="!min-h-0 !py-1 text-xs ml-auto" onClick={startEdit}>
            ✎ Edit slots
          </Btn>
        )}
      </div>
      {editing ? (
        <div className="space-y-2">
          <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(64px, 1fr))' }}>
            {SPELL_LEVELS.map((lvl) => (
              <div key={lvl} className="space-y-1">
                <label className="text-[10px] text-slate-500 font-bold uppercase">Lv {lvl}</label>
                <TextInput
                  type="number"
                  min={0}
                  max={20}
                  value={maxima[lvl] ?? '0'}
                  onChange={(e) => setMaxima((m) => ({ ...m, [lvl]: e.target.value }))}
                />
              </div>
            ))}
          </div>
          <div className="flex gap-2 justify-end">
            <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </Btn>
            <Btn className="!min-h-0 !py-1.5 text-xs" onClick={saveMaxima} disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </Btn>
          </div>
        </div>
      ) : levels.length === 0 ? (
        <p className="text-xs text-slate-500">
          No spell slots configured{canEdit ? ' — set per-level maxima with “Edit slots”' : ''}.
        </p>
      ) : (
        <div className="space-y-1.5">
          {levels.map((lvl) => {
            const slot = character.spellSlots[lvl]!;
            const available = Math.max(0, slot.max - slot.used);
            return (
              <div key={lvl} className="flex items-center gap-2.5 flex-wrap">
                <span className="text-[11px] text-slate-500 font-bold uppercase w-9">Lv {lvl}</span>
                <span className="tracking-[3px] text-[15px] leading-none" aria-label={`${available} of ${slot.max} slots available`}>
                  {Array.from({ length: slot.max }, (_, i) => (
                    <span key={i} style={{ color: i < available ? 'var(--color-accent-300)' : 'var(--color-neutral-600)' }}>
                      {i < available ? '●' : '○'}
                    </span>
                  ))}
                </span>
                <span className="text-[11px] text-slate-500">
                  {available}/{slot.max}
                </span>
                {canEdit && (
                  <span className="inline-flex gap-1 ml-auto">
                    <Btn ghost className="!min-h-0 !py-1 text-xs" disabled={busy || available === 0} onClick={() => adjust(lvl, 1)}>
                      Use
                    </Btn>
                    <Btn ghost className="!min-h-0 !py-1 text-xs" disabled={busy || slot.used === 0} onClick={() => adjust(lvl, -1)}>
                      Restore
                    </Btn>
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
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
  adapter,
}: {
  character: Character;
  canEdit: boolean;
  onChange: () => void;
  onError: (msg: string | null) => void;
  adapter: RuleSystemAdapter;
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
              list="cf-condition-vocab"
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
            <datalist id="cf-condition-vocab">
              {adapter.conditions.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
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

/**
 * DM-only secret notes (a secret curse, a hidden true identity…) — mirrors the
 * QuestPage DM panel. Server strips `dmSecret` for non-DM reads and ignores
 * non-DM writes, so this card renders for the DM only; the owning player never
 * sees it even though they can edit the rest of the sheet.
 */
function DmSecretCard({
  character,
  onChange,
  onError,
}: {
  character: Character;
  onChange: () => void;
  onError: (msg: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    onError(null);
    try {
      await api.patch(`${API}/characters/${character.id}`, { dmSecret: draft });
      setEditing(false);
      onChange();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Couldn't save the DM notes.");
    } finally {
      setSaving(false);
    }
  }

  if (!character.dmSecret && !editing) {
    return (
      <button
        onClick={() => {
          setDraft('');
          setEditing(true);
        }}
        className="text-xs text-slate-500 hover:text-slate-300 text-left"
      >
        + DM notes
      </button>
    );
  }

  return (
    <div
      className="card"
      style={{
        border: '1px solid var(--color-accent-700)',
        background: 'color-mix(in srgb, var(--color-accent) 5%, var(--color-surface))',
      }}
    >
      <span className="card-kicker">DM only — hidden from players</span>
      {editing ? (
        <div className="space-y-2">
          <TextArea style={{ minHeight: 100 }} value={draft} onChange={(e) => setDraft(e.target.value)} />
          <div className="flex gap-2 justify-end">
            <Btn ghost onClick={() => setEditing(false)} className="!min-h-0 !py-1.5 text-xs">
              Cancel
            </Btn>
            <Btn onClick={save} disabled={saving} className="!min-h-0 !py-1.5 text-xs">
              {saving ? 'Saving…' : 'Save'}
            </Btn>
          </div>
        </div>
      ) : (
        <div className="flex items-start justify-between gap-3">
          <p style={{ margin: 0, fontSize: 13.5, color: 'var(--color-accent-200)', whiteSpace: 'pre-wrap' }}>{character.dmSecret}</p>
          <button
            onClick={() => {
              setDraft(character.dmSecret);
              setEditing(true);
            }}
            className="text-[10px] text-slate-500 hover:text-slate-300 shrink-0"
          >
            ✎ edit
          </button>
        </div>
      )}
    </div>
  );
}
