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
 *
 * D&D Beyond provenance (issue #720): the schema carries `ddbId` for characters
 * imported once from a public DDB sheet (issue #18 — a one-time import, not a live
 * link). The Player card's provenance row now branches on `ddbId`: imported sheets
 * show "Imported from D&D Beyond" + a copyable source id (no "sync" overclaim),
 * while manually-created sheets get honest guidance instead of "soon".
 */
import { useCallback, useEffect, useId, useRef, useState, type MouseEvent } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import type { Attachment, Character, CharacterAction, CampaignMember, CharacterStatus, SkillRank } from '@campfire/schema';
import { xpForLevel, ruleSystemAdapter, type RuleSystemAdapter } from '@campfire/schema';
import { CHARACTER_STATUSES, STATUS_LABEL, StatusTag } from './status';
import { api, API, ApiError } from '../../lib/api';
import {
  compositionSafeEscapeHandler,
  compositionSafeFormSubmit,
  createCompositionSubmitGate,
} from '../../lib/compositionSafeSubmit';
import { useAuth } from '../../app/auth';
import { useCampaign } from '../../app/CampaignContext';
import { Card, Chip, Btn, TextInput, TextArea, Skeleton, ErrorNote, HpBar } from '../../components/ui';
import { NotFoundState } from '../../components/NotFoundState';
import { Markdown } from '../../components/Markdown';
import { NotesRail } from '../../components/NotesRail';
import { ImageUpload, attachmentFileUrl } from '../../components/ImageUpload';
import { initials } from './avatar';
import { GameIcon } from '../../components/GameIcon';
import { entityTargetProps } from '../../lib/entityLinks';
import {
  ABILITY_KEYS,
  type Ability,
  SKILLS,
  SPELL_LEVELS,
  profBonus,
  abilityScore,
  modOf,
  signed,
  d20Expr,
  toHitExpr,
  damageExpr,
  rollPreview,
} from '../../lib/characterStats';
import { RollModeChooser } from './RollModeChooser';
import { resolveRollMode, rollModeSummary, type RollMode } from './rollMode';
import { useRoller, type Roller } from '../../lib/useRoller';
import { RollResultBanner } from '../../components/RollResultBanner';
import { UndoSnackbar } from '../../components/UndoSnackbar';
import { CopyControl } from '../../components/CopyControl';
import { CharacterTrashMenu } from './CharacterTrashMenu';
import { parseLocalizedInteger } from '../../lib/i18nNumbers';
import {
  XP_AWARD_HELP,
  XP_AWARD_LABEL,
  hpDeltaLabel,
  hpFullHealLabel,
  saveProficiencyLabel,
  skillProficiencyLabel,
} from './characterSheetA11y';
import { useFormattingLocale } from '../../lib/format';

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
  // Move-to-Trash (issue #716): soft-delete is reversible, so the sheet offers the
  // action for owners + the DM, shows an immediate Undo snackbar, and only redirects
  // to the roster once that snackbar expires (or is dismissed).
  const [trashing, setTrashing] = useState(false);
  const [pendingUndo, setPendingUndo] = useState(false);
  // Shared dice-log roller for click-to-roll saves/skills/attacks (issue #258).
  const roller = useRoller(cid, setActionError);

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

  async function savePortrait(attachment: Attachment) {
    setActionError(null);
    try {
      // Issue #498: embed the authorization-aware version token in the stored portrait
      // URL so a later content/hidden change invalidates any cached copy.
      await api.patch(`${API}/characters/${id}`, {
        portraitUrl: attachmentFileUrl(attachment.id, { hidden: attachment.hidden, updatedAt: attachment.updatedAt }),
      });
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't save the portrait.");
    }
  }

  // Soft-delete (issue #716/#116) — reversible. The sheet stays mounted so the Undo
  // snackbar can restore in place; the redirect to the roster happens when the
  // snackbar expires or is dismissed (onExpire), not on delete itself.
  async function trash() {
    setTrashing(true);
    setActionError(null);
    try {
      await api.delete(`${API}/characters/${id}`);
      setPendingUndo(true);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't move this character to the Trash.");
    } finally {
      setTrashing(false);
    }
  }

  async function undoTrash() {
    await api.post(`${API}/characters/${id}/restore`);
    setPendingUndo(false);
    await load();
  }

  return (
    <div className="reading-surface max-w-5xl mx-auto px-4 mt-5 space-y-4 pb-20 md:pb-10" {...entityTargetProps('character', character.id)}>
      <div>
        <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={() => navigate(`/c/${cid}/party`)}>
          ← Back
        </Btn>
      </div>

      {(error || actionError) && <ErrorNote message={actionError ?? error ?? ''} onRetry={() => { setActionError(null); void load(); }} />}

      {roller.last && <RollResultBanner roll={roller.last} onDismiss={roller.dismiss} />}

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
        <div className="flex items-center gap-1 ml-auto">
          {canEdit && !editingSheet && (
            <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={() => setEditingSheet(true)}>
              ✎ Edit sheet
            </Btn>
          )}
          {canEdit && (
            <CharacterTrashMenu characterName={character.name} busy={trashing} onTrash={trash} />
          )}
        </div>
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
                    <p className="text-[length:var(--type-label)] tracking-wide text-slate-500">{k}</p>
                    <p className="text-xl font-heading my-0.5">{score}</p>
                    <p className="text-[length:var(--type-meta)]" style={{ color: 'var(--color-accent-300)' }}>
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
              <div className="flex-1 min-w-[120px]">
                <HpBar current={character.hpCurrent} max={character.hpMax} />
              </div>
            </div>
            {canEdit && <HpEditor character={character} onChange={load} onError={setActionError} />}
          </Card>

          <XpCard character={character} canEdit={canEdit} onChange={load} onError={setActionError} />

          <ActionsCard character={character} canEdit={canEdit} onChange={load} onError={setActionError} roller={roller} />

          <SavingThrowsCard character={character} canEdit={canEdit} onChange={load} onError={setActionError} adapter={adapter} roller={roller} />

          <SkillsCard character={character} canEdit={canEdit} onChange={load} onError={setActionError} adapter={adapter} roller={roller} />

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
              <span className="tag tag-neutral">soon</span>
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
              <span className="h-24 w-24 rounded-full border border-dashed border-[var(--color-neutral-700)] flex items-center justify-center text-[length:var(--type-label)] text-[var(--color-neutral-600)]">
                Portrait
              </span>
            )}
            {canEdit && <span className="text-[length:var(--type-label)] text-slate-500">Click or drop to change</span>}
          </Card>
          <Card className="space-y-2">
            <p className="card-kicker mb-0">Player</p>
            <div className="space-y-1.5 text-[13px]">
              <div className="flex justify-between">
                <span className="text-muted">Owner</span>
                <span>{ownerLabel(character.ownerUserId)}</span>
              </div>
              <DdbProvenanceRow ddbId={character.ddbId} canEdit={canEdit} />
            </div>
          </Card>
        </div>
      </div>

      {isOwner && <NotesRail campaignId={cid} entityType="character" entityId={character.id} />}

      {pendingUndo && (
        <UndoSnackbar
          message={`${character.name} moved to the Trash.`}
          onUndo={undoTrash}
          onExpire={() => navigate(`/c/${cid}/party`)}
        />
      )}
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
  // Per-field parse errors (issue #633): level/AC/HP/stats are parsed in the
  // viewer's locale; an unparseable value keeps the field's current text and
  // surfaces a message here rather than silently coercing to 0/1.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const formatLocale = useFormattingLocale();

  async function save() {
    if (!name.trim()) return;
    // Issue #633: parse each numeric field in the viewer's locale. On any
    // failure, surface the per-field errors, keep the current field values,
    // and abort — do NOT fall back to 0/1 and silently corrupt the sheet.
    const errs: Record<string, string> = {};
    const levelParsed = parseLocalizedInteger(level, formatLocale, { min: 1, max: 20 });
    if (!levelParsed.ok) errs.level = levelParsed.error;
    // AC may be blank (cleared to null on the server); only validate when present.
    let acValue: number | null = null;
    if (ac.trim() !== '') {
      const acParsed = parseLocalizedInteger(ac, formatLocale);
      if (!acParsed.ok) errs.ac = acParsed.error;
      else acValue = acParsed.value;
    }
    const hpMaxParsed = parseLocalizedInteger(hpMax, formatLocale, { min: 1 });
    if (!hpMaxParsed.ok) errs.hpMax = hpMaxParsed.error;
    const statNums: Record<string, number> = {};
    for (const k of ABILITY_KEYS) {
      const parsed = parseLocalizedInteger(stats[k], formatLocale);
      if (!parsed.ok) errs[k] = parsed.error;
      else statNums[k] = parsed.value;
    }
    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs);
      return;
    }
    setFieldErrors({});
    // Every field parsed cleanly above (we returned otherwise), so the ok
    // branches are guaranteed here. Re-bind to plain numbers for the payload.
    const levelNum = (levelParsed as { ok: true; value: number }).value;
    const hpMaxNum = (hpMaxParsed as { ok: true; value: number }).value;
    setSaving(true);
    onError(null);
    try {
      await api.patch(`${API}/characters/${character.id}`, {
        name: name.trim(),
        species: species.trim(),
        className: className.trim(),
        background: background.trim(),
        level: levelNum,
        ac: acValue,
        hpMax: hpMaxNum,
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
        {/* type="text" + inputMode="numeric" (issue #633): a type="number" field
            silently strips locale grouping (en "1,000" → "", de "1.000" → "1")
            before the parser sees it, so the localized path is bypassed. */}
        <div className="space-y-1">
          <TextInput
            type="text"
            inputMode="numeric"
            min={1}
            max={20}
            value={level}
            aria-invalid={fieldErrors.level != null}
            onChange={(e) => {
              setLevel(e.target.value);
              setFieldErrors((fe) => ({ ...fe, level: '' }));
            }}
            placeholder="Level"
          />
          {fieldErrors.level && <span className="block text-[11px] text-rose-400">{fieldErrors.level}</span>}
        </div>
        <div className="space-y-1">
          <TextInput
            type="text"
            inputMode="numeric"
            value={ac}
            aria-invalid={fieldErrors.ac != null}
            onChange={(e) => {
              setAc(e.target.value);
              setFieldErrors((fe) => ({ ...fe, ac: '' }));
            }}
            placeholder="AC"
          />
          {fieldErrors.ac && <span className="block text-[11px] text-rose-400">{fieldErrors.ac}</span>}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2.5">
        <div className="space-y-1">
          <TextInput
            type="text"
            inputMode="numeric"
            min={1}
            value={hpMax}
            aria-invalid={fieldErrors.hpMax != null}
            onChange={(e) => {
              setHpMax(e.target.value);
              setFieldErrors((fe) => ({ ...fe, hpMax: '' }));
            }}
            placeholder="Max HP"
            title="Current HP is clamped to the new max automatically."
          />
          {fieldErrors.hpMax && <span className="block text-[11px] text-rose-400">{fieldErrors.hpMax}</span>}
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
              type="text"
              inputMode="numeric"
              value={stats[k]}
              aria-invalid={fieldErrors[k] != null}
              onChange={(e) => {
                setStats((s) => ({ ...s, [k]: e.target.value }));
                setFieldErrors((fe) => ({ ...fe, [k]: '' }));
              }}
            />
            {fieldErrors[k] && <span className="block text-[11px] text-rose-400">{fieldErrors[k]}</span>}
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
  // Per-field parse errors (issue #633): XP award and level-up HP are parsed in
  // the viewer's locale; an unparseable value keeps the field's current text and
  // surfaces a message here rather than being silently dropped.
  const [amountError, setAmountError] = useState<string | null>(null);
  const [hpMaxError, setHpMaxError] = useState<string | null>(null);
  const formatLocale = useFormattingLocale();
  // XP award field a11y (issue #448): persistent label + help/error association.
  const xpFieldId = useId();
  const xpHelpId = `${xpFieldId}-help`;
  const xpErrorId = `${xpFieldId}-error`;
  const xpDescribedBy = amountError ? `${xpHelpId} ${xpErrorId}` : xpHelpId;
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
    if (busy) return;
    // Issue #633: parse the XP amount in the viewer's locale. On failure,
    // surface a field error and keep the current text — do NOT silently drop
    // the award (the old `Number(amount)` path returned early on NaN, hiding
    // the problem from the user).
    const parsed = parseLocalizedInteger(amount, formatLocale);
    if (!parsed.ok) {
      setAmountError(parsed.error);
      return;
    }
    if (parsed.value === 0) {
      setAmountError('Enter an amount other than 0.');
      return;
    }
    setAmountError(null);
    setBusy(true);
    onError(null);
    try {
      await api.post(`${API}/characters/${character.id}/xp`, { delta: parsed.value });
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
    // Issue #633: parse the new max HP in the viewer's locale; surface a field
    // error instead of silently no-op'ing on unparseable input.
    const parsed = parseLocalizedInteger(newHpMax, formatLocale, { min: 1 });
    if (!parsed.ok) {
      setHpMaxError(parsed.error);
      return;
    }
    setHpMaxError(null);
    const hpMaxNum = parsed.value;
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
    <Card className="space-y-3" data-testid="character-xp">
      <div className="flex items-baseline gap-2.5 flex-wrap">
        <p className="card-kicker mb-0">Experience</p>
        {ready && (
          <span className="tag tag-accent cf-anim-ready">
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
        <div className="flex gap-2 flex-wrap items-end">
          {/* Labeled XP award (issue #448): associated label/help/error so the
              control is not an unnamed spinbutton/textbox. type="text" +
              inputMode="numeric" (issue #633) preserves locale digits. */}
          <div className="space-y-1">
            <label htmlFor={xpFieldId} className="block text-[10px] font-bold uppercase tracking-wide text-slate-500">
              {XP_AWARD_LABEL}
            </label>
            <input
              id={xpFieldId}
              type="text"
              inputMode="numeric"
              value={amount}
              aria-invalid={amountError != null}
              aria-describedby={xpDescribedBy}
              onChange={(e) => {
                setAmount(e.target.value);
                setAmountError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void addXp();
              }}
              placeholder="XP…"
              className="cf-input !min-h-0 !w-24 text-sm"
              style={{ minHeight: 44, padding: '4px 10px' }}
            />
            <p id={xpHelpId} className="text-[11px] text-slate-500 m-0 max-w-[16rem]">
              {XP_AWARD_HELP}
            </p>
            {amountError && (
              <p id={xpErrorId} role="alert" className="text-xs text-rose-400 m-0">
                {amountError}
              </p>
            )}
          </div>
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
                type="text"
                inputMode="numeric"
                min={1}
                value={newHpMax}
                aria-invalid={hpMaxError != null}
                onChange={(e) => {
                  setNewHpMax(e.target.value);
                  setHpMaxError(null);
                }}
                placeholder="New max HP"
              />
            </div>
            {hpMaxError && <span className="text-xs text-rose-400">{hpMaxError}</span>}
            <div className="flex-1" />
            <Btn ghost className="!min-h-0 !py-1.5 text-xs" disabled={busy} onClick={() => setLevellingUp(false)}>
              Cancel
            </Btn>
            <Btn
              className="!min-h-0 !py-1.5 text-xs"
              disabled={busy || !newHpMax.trim()}
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

/** A small dice-roll button that posts a roll to the shared dice log. */
function RollChip({
  label,
  title,
  onClick,
  disabled,
}: {
  label: string;
  title: string;
  onClick: (e: MouseEvent) => void;
  disabled: boolean;
}) {
  return (
    <Btn ghost type="button" className="!min-h-0 !py-1 text-xs" style={{ minHeight: 32 }} onClick={onClick} disabled={disabled} title={title}>
      <GameIcon slug="rolling-dices" size={13} className="inline align-text-bottom mr-1" />{label}
    </Btn>
  );
}

function SavingThrowsCard({ character, canEdit, onChange, onError, adapter, roller }: SheetCardProps & { adapter: RuleSystemAdapter; roller: Roller }) {
  const [busy, setBusy] = useState(false);
  // Roll-mode chooser (issue #713): a touch- and keyboard-visible Flat / Advantage
  // / Disadvantage selector shared by every save in this card. The chooser holds
  // the persistent one-tap default; a shift/alt-click still overrides it for a
  // single roll so the desktop keyboard shortcut keeps working (resolveRollMode).
  const [mode, setMode] = useState<RollMode>('flat');
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
    <Card className="space-y-2" data-testid="character-saving-throws">
      <div className="flex items-center gap-2 flex-wrap">
        <p className="card-kicker mb-0">Saving throws</p>
        <span className="text-[11px] text-slate-500">proficiency {signed(pb)}</span>
        <span className="ml-auto cf-roll-mode-status" role="status" aria-live="polite" style={{ fontSize: 11, color: 'var(--color-accent-300)' }}>
          {rollModeSummary(mode)}
        </span>
      </div>
      <RollModeChooser
        value={mode}
        onChange={setMode}
        disabled={roller.rolling}
        aria-label="Saving throw roll mode"
      />
      <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(84px, 1fr))' }}>
        {ABILITY_KEYS.map((k) => {
          const proficient = profs.has(k);
          const mod = modOf(adapter, character, k) + (proficient ? pb : 0);
          return (
            <div key={k} className="cf-inset text-center py-2 px-1.5 relative">
              <button
                type="button"
                onClick={(e) => void roller.roll(d20Expr(mod, resolveRollMode(mode, e)), `${character.name} · ${k} save`)}
                disabled={roller.rolling}
                className="w-full"
                style={{ background: 'transparent', border: 0, padding: 0, font: 'inherit', color: 'inherit', cursor: roller.rolling ? 'default' : 'pointer' }}
                title={`Roll ${k} save (${signed(mod)}) · ${rollModeSummary(mode)}`}
                aria-label={`Roll ${k} save (${signed(mod)}) with ${rollModeSummary(mode).toLowerCase()}`}
              >
                <p className="text-[10px] tracking-wide text-slate-500">{k}</p>
                <p className="text-[15px] mt-0.5 font-semibold">{signed(mod)}</p>
              </button>
              {canEdit ? (
                <button
                  type="button"
                  onClick={() => void toggle(k)}
                  disabled={busy}
                  aria-pressed={proficient}
                  aria-label={saveProficiencyLabel(k, proficient)}
                  className="absolute top-1 right-1"
                  style={{ background: 'transparent', border: 0, padding: 2, lineHeight: 1, fontSize: 10, cursor: busy ? 'default' : 'pointer', color: proficient ? 'var(--color-accent-300)' : 'var(--color-neutral-600)' }}
                  title={proficient ? `Remove ${k} save proficiency` : `Add ${k} save proficiency`}
                >
                  <span aria-hidden="true">{proficient ? '●' : '○'}</span>
                </button>
              ) : (
                proficient && (
                  <span className="absolute top-1 right-1" aria-hidden style={{ fontSize: 10, color: 'var(--color-accent-300)' }}>
                    ●
                  </span>
                )
              )}
            </div>
          );
        })}
      </div>
      <p className="text-[11px] text-slate-500">
        Tap a save to roll a d20{canEdit ? '; tap the ● to toggle proficiency' : ''}. Pick a mode above; shift-click for a one-tap advantage, alt-click for disadvantage.
      </p>
    </Card>
  );
}

function SkillsCard({ character, canEdit, onChange, onError, adapter, roller }: SheetCardProps & { adapter: RuleSystemAdapter; roller: Roller }) {
  const [busy, setBusy] = useState(false);
  // Roll-mode chooser (issue #713): one persistent default for every skill roll
  // in this card; the keyboard shortcut (shift/alt-click) still overrides once.
  const [mode, setMode] = useState<RollMode>('flat');
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
    <Card className="space-y-2" data-testid="character-skills">
      <div className="flex items-center gap-2 flex-wrap">
        <p className="card-kicker mb-0">Skills</p>
        <span className="text-[11px] text-slate-500">
          tap a skill to roll{canEdit ? '; tap the ○/●/★ to cycle proficiency' : ''}
        </span>
        <span className="ml-auto cf-roll-mode-status" role="status" aria-live="polite" style={{ fontSize: 11, color: 'var(--color-accent-300)' }}>
          {rollModeSummary(mode)}
        </span>
      </div>
      <RollModeChooser
        value={mode}
        onChange={setMode}
        disabled={roller.rolling}
        aria-label="Skill check roll mode"
      />
      <div className="grid gap-x-4 gap-y-0.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
        {SKILLS.map(({ name, ability }) => {
          const rank = character.skills[name];
          const mod = modOf(adapter, character, ability) + (rank === 'expertise' ? pb * 2 : rank === 'proficient' ? pb : 0);
          const marker = rank === 'expertise' ? '★' : rank === 'proficient' ? '●' : '○';
          return (
            <div key={name} className="flex items-center gap-1.5 text-[13px] py-0.5">
              {canEdit ? (
                <button
                  type="button"
                  onClick={() => void cycle(name)}
                  disabled={busy}
                  aria-label={skillProficiencyLabel(name, rank ?? 'none')}
                  aria-pressed={rank != null}
                  className="w-4 shrink-0 text-center"
                  style={{ background: 'transparent', border: 0, padding: 0, font: 'inherit', cursor: busy ? 'default' : 'pointer', color: rank ? 'var(--color-accent-300)' : 'var(--color-neutral-600)' }}
                  title={rank === undefined ? `Mark ${name} proficient` : rank === 'proficient' ? `Mark ${name} expertise` : `Clear ${name} proficiency`}
                >
                  <span aria-hidden="true">{marker}</span>
                </button>
              ) : (
                <span
                  className="w-4 shrink-0 text-center"
                  style={{ color: rank ? 'var(--color-accent-300)' : 'var(--color-neutral-600)' }}
                  aria-hidden
                >
                  {marker}
                </span>
              )}
              <button
                type="button"
                onClick={(e) => void roller.roll(d20Expr(mod, resolveRollMode(mode, e)), `${character.name} · ${name} check`)}
                disabled={roller.rolling}
                className="flex-1 flex items-center gap-1.5 min-w-0"
                style={{ background: 'transparent', border: 0, padding: 0, font: 'inherit', color: 'inherit', cursor: roller.rolling ? 'default' : 'pointer' }}
                title={`Roll ${name} (${signed(mod)}) · ${rollModeSummary(mode)}`}
                aria-label={`Roll ${name} (${signed(mod)}) with ${rollModeSummary(mode).toLowerCase()}`}
              >
                <span className="flex-1 text-left truncate">{name}</span>
                <span className="text-[10px] text-slate-500">{ability}</span>
                <span className="w-8 text-right font-semibold">{signed(mod)}</span>
              </button>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function ActionsCard({ character, canEdit, onChange, onError, roller }: SheetCardProps & { roller: Roller }) {
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState('');
  const [toHit, setToHit] = useState('');
  const [damage, setDamage] = useState('');
  const [notes, setNotes] = useState('');
  // Roll-mode chooser (issue #713): the attack "to hit" roll mode. Applies to
  // every action's attack roll in this card; a shift/alt-click still overrides
  // once (resolveRollMode) so the desktop shortcut keeps working.
  const [mode, setMode] = useState<RollMode>('flat');
  // In-place edit (issue #718): editingIndex is the position in character.actions
  // being edited, or null when not editing an existing row. The row collapses into
  // the same form Add uses, so order is preserved by writing back to the same index.
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

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

  function resetForm() {
    setName('');
    setKind('');
    setToHit('');
    setDamage('');
    setNotes('');
    setEditingIndex(null);
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
      resetForm();
      setAdding(false);
    }
  }

  async function saveEdit() {
    if (editingIndex == null || !name.trim()) return;
    const action: CharacterAction = {
      name: name.trim(),
      kind: kind.trim(),
      toHit: toHit.trim(),
      damage: damage.trim(),
      notes: notes.trim(),
    };
    const next = character.actions.map((a, i) => (i === editingIndex ? action : a));
    const ok = await saveActions(next, "Couldn't save the action.");
    if (ok) resetForm();
  }

  function startEdit(index: number) {
    const a = character.actions[index];
    if (!a) return;
    setName(a.name);
    setKind(a.kind);
    setToHit(a.toHit);
    setDamage(a.damage);
    setNotes(a.notes);
    setEditingIndex(index);
    setAdding(false);
  }

  function remove(index: number) {
    void saveActions(
      character.actions.filter((_, i) => i !== index),
      "Couldn't remove the action.",
    );
  }

  // Only surface the chooser when at least one action carries a "to hit" roll —
  // a list of feature-only actions has nothing to take with advantage.
  const hasAttackRoll = character.actions.some((a) => a.toHit && toHitExpr(a.toHit, 'flat'));

  return (
    <Card className="space-y-2.5">
      <div className="flex items-center gap-2 flex-wrap">
        <p className="card-kicker mb-0">Actions</p>
        {hasAttackRoll && (
          <span className="cf-roll-mode-status" role="status" aria-live="polite" style={{ fontSize: 11, color: 'var(--color-accent-300)' }}>
            {rollModeSummary(mode)}
          </span>
        )}
        {canEdit && !adding && editingIndex == null && (
          <Btn ghost className="!min-h-0 !py-1 text-xs ml-auto" onClick={() => { resetForm(); setAdding(true); }}>
            + Add
          </Btn>
        )}
      </div>
      {hasAttackRoll && (
        <RollModeChooser
          value={mode}
          onChange={setMode}
          disabled={roller.rolling}
          aria-label="Attack roll mode"
        />
      )}
      {character.actions.length === 0 && !adding && (
        <p className="text-xs text-slate-500">
          No actions yet{canEdit ? ' — add attacks, spells, and features to roll them straight from the sheet' : ''}.
        </p>
      )}
      {character.actions.map((action, i) => {
        // Editing this row: render the inline form in place of the read view.
        if (editingIndex === i) {
          return (
            <ActionForm
              key={`edit-${i}`}
              busy={busy}
              name={name}
              kind={kind}
              toHit={toHit}
              damage={damage}
              notes={notes}
              setName={setName}
              setKind={setKind}
              setToHit={setToHit}
              setDamage={setDamage}
              setNotes={setNotes}
              onCancel={resetForm}
              onSave={saveEdit}
              saveLabel="Save"
              autoFocusName
            />
          );
        }
        const attackExpr = action.toHit ? toHitExpr(action.toHit, 'flat') : null;
        const dmgExpr = action.damage ? damageExpr(action.damage) : null;
        return (
          <div key={`${action.name}-${i}`} className="cf-inset px-3 py-2 flex items-start gap-2.5">
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-semibold flex items-center gap-1.5 flex-wrap">
                {action.name}
                {action.kind && (
                  <span className="tag tag-neutral">
                    {action.kind}
                  </span>
                )}
              </p>
              {(action.toHit || action.damage) && (
                <div className="flex gap-2 flex-wrap items-center mt-1">
                  {action.toHit &&
                    (attackExpr ? (
                      <RollChip
                        label={`to hit ${action.toHit}`}
                        title={`Roll ${action.name} attack (${attackExpr}) · ${rollModeSummary(mode)}`}
                        disabled={roller.rolling}
                        onClick={(e) => void roller.roll(toHitExpr(action.toHit, resolveRollMode(mode, e))!, `${character.name} · ${action.name} to hit`)}
                      />
                    ) : (
                      <span className="text-xs text-slate-400" title="Not a rollable to-hit value — edit the action and use +5, -1, or 1d20+5">
                        to hit {action.toHit} (not rollable)
                      </span>
                    ))}
                  {action.damage &&
                    (dmgExpr ? (
                      <RollChip
                        label={action.damage}
                        title={`Roll ${action.name} damage (${dmgExpr})`}
                        disabled={roller.rolling}
                        onClick={() => void roller.roll(dmgExpr, `${character.name} · ${action.name} damage`)}
                      />
                    ) : (
                      <span className="text-xs text-slate-400" title="Flat or unparseable damage — no dice to roll">
                        {action.damage} (flat)
                      </span>
                    ))}
                </div>
              )}
              {action.notes && <p className="text-[11px] text-slate-500 mt-0.5">{action.notes}</p>}
            </div>
            {canEdit && (
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  aria-label={`Edit ${action.name}`}
                  onClick={() => startEdit(i)}
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
                  ✎
                </button>
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
              </div>
            )}
          </div>
        );
      })}
      {adding && (
        <ActionForm
          busy={busy}
          name={name}
          kind={kind}
          toHit={toHit}
          damage={damage}
          notes={notes}
          setName={setName}
          setKind={setKind}
          setToHit={setToHit}
          setDamage={setDamage}
          setNotes={setNotes}
          onCancel={() => { resetForm(); setAdding(false); }}
          onSave={add}
          saveLabel="Add action"
          autoFocusName
        />
      )}
    </Card>
  );
}

/**
 * Shared add/edit form for a character action (issue #718). Renders a live
 * "Campfire will roll …" preview from the to-hit/damage fields so the author can
 * see — before saving — exactly how the sheet will interpret them. Empty fields
 * are explained rather than silently dropped.
 */
function ActionForm({
  busy,
  name,
  kind,
  toHit,
  damage,
  notes,
  setName,
  setKind,
  setToHit,
  setDamage,
  setNotes,
  onCancel,
  onSave,
  saveLabel,
  autoFocusName,
}: {
  busy: boolean;
  name: string;
  kind: string;
  toHit: string;
  damage: string;
  notes: string;
  setName: (v: string) => void;
  setKind: (v: string) => void;
  setToHit: (v: string) => void;
  setDamage: (v: string) => void;
  setNotes: (v: string) => void;
  onCancel: () => void;
  onSave: () => void;
  saveLabel: string;
  autoFocusName?: boolean;
}) {
  const preview = rollPreview(toHit, damage);
  return (
    <div className="cf-inset px-3 py-2.5 space-y-2">
      <div className="grid grid-cols-2 gap-2.5">
        <TextInput autoFocus={autoFocusName} value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (Longsword, Fire Bolt…)" />
        <TextInput value={kind} onChange={(e) => setKind(e.target.value)} placeholder="Kind (melee, ranged, spell…)" />
      </div>
      <div className="grid grid-cols-2 gap-2.5">
        <TextInput
          value={toHit}
          onChange={(e) => setToHit(e.target.value)}
          placeholder="To hit (+5 or 1d20+5)"
          aria-invalid={toHit.trim() !== '' && preview.hit == null}
        />
        <TextInput
          value={damage}
          onChange={(e) => setDamage(e.target.value)}
          placeholder="Damage (1d8+3 slashing, 5 fire)"
          aria-invalid={false}
        />
      </div>
      <TextInput value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (versatile, 60 ft range…)" />
      {(toHit.trim() || damage.trim()) && (
        <p className="text-[11px] text-slate-400">
          {preview.hit == null && preview.dmg == null ? (
            <>No rollable dice recognized — this action will display as text only.</>
          ) : (
            <>
              Campfire will roll{' '}
              {[preview.hit, preview.dmg].filter(Boolean).join(', ') || 'nothing'}.
            </>
          )}
        </p>
      )}
      <div className="flex gap-2 justify-end">
        <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={onCancel} disabled={busy}>
          Cancel
        </Btn>
        <Btn className="!min-h-0 !py-1.5 text-xs" onClick={onSave} disabled={busy || !name.trim()}>
          {busy ? 'Saving…' : saveLabel}
        </Btn>
      </div>
    </div>
  );
}

function SpellSlotsCard({ character, canEdit, onChange, onError }: SheetCardProps) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [maxima, setMaxima] = useState<Record<string, string>>({});
  // Per-level parse errors (issue #633): a slot maximum that can't be parsed in
  // the viewer's locale surfaces a message here rather than silently coercing
  // to 0 (which would erase the configured maximum on save).
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const formatLocale = useFormattingLocale();

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
    setFieldErrors({});
    setEditing(true);
  }

  async function saveMaxima() {
    if (busy) return;
    // Issue #633: parse each level's maximum in the viewer's locale. On any
    // failure, surface the per-field errors and keep the current values — do
    // NOT silently coerce to 0, which would erase configured slots on save.
    const errs: Record<string, string> = {};
    const next: Record<string, { max: number; used: number }> = {};
    for (const lvl of SPELL_LEVELS) {
      const parsed = parseLocalizedInteger(maxima[lvl] ?? '0', formatLocale, { min: 0, max: 20 });
      if (!parsed.ok) {
        errs[lvl] = parsed.error;
        continue;
      }
      if (parsed.value > 0) {
        next[lvl] = { max: parsed.value, used: Math.min(character.spellSlots[lvl]?.used ?? 0, parsed.value) };
      }
    }
    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs);
      return;
    }
    setFieldErrors({});
    setBusy(true);
    onError(null);
    try {
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
                {/* type="text" + inputMode="numeric" (issue #633): preserves
                    locale grouping for the localized parser. */}
                <TextInput
                  type="text"
                  inputMode="numeric"
                  min={0}
                  max={20}
                  value={maxima[lvl] ?? '0'}
                  aria-invalid={fieldErrors[lvl] != null}
                  onChange={(e) => {
                    setMaxima((m) => ({ ...m, [lvl]: e.target.value }));
                    setFieldErrors((fe) => ({ ...fe, [lvl]: '' }));
                  }}
                />
                {fieldErrors[lvl] && <span className="block text-[10px] text-rose-400">{fieldErrors[lvl]}</span>}
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

  // Contextual HP labels (issue #448): announce character + current/max, not bare deltas.
  const { name, hpCurrent, hpMax } = character;
  return (
    <div
      className="flex gap-2 flex-wrap"
      role="group"
      aria-label={`${name} hit points`}
      data-testid="character-hp-editor"
    >
      {([-5, -1, 1, 5] as const).map((step) => (
        <Btn
          key={step}
          className="!min-h-0"
          style={{ minWidth: 52, minHeight: 44 }}
          disabled={busy}
          aria-label={hpDeltaLabel(name, step, hpCurrent, hpMax)}
          onClick={(e) => click(step, e)}
        >
          {step > 0 ? `+${step}` : `−${Math.abs(step)}`}
        </Btn>
      ))}
      <Btn
        style={{ minHeight: 44 }}
        disabled={busy}
        aria-label={hpFullHealLabel(name, hpMax)}
        onClick={fullHeal}
      >
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
  // Issue #854: IME confirm Enter must not add; Escape must not dismiss mid-composition.
  const compositionGateRef = useRef<ReturnType<typeof createCompositionSubmitGate> | null>(null);
  if (compositionGateRef.current === null) {
    compositionGateRef.current = createCompositionSubmitGate();
  }
  const compositionGate = compositionGateRef.current;

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
          <form
            className="inline-flex items-center gap-1"
            onSubmit={compositionSafeFormSubmit(compositionGate, () => {
              void addCondition();
            })}
          >
            <input
              autoFocus
              list="cf-condition-vocab"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={compositionSafeEscapeHandler(compositionGate, () => {
                setAdding(false);
                setValue('');
              })}
              {...compositionGate.inputProps}
              placeholder="Condition…"
              className="cf-input !min-h-0 !py-1 !w-28 text-xs"
              style={{ minHeight: 0, padding: '4px 8px' }}
            />
            <datalist id="cf-condition-vocab">
              {adapter.conditions.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
            <button type="submit" disabled={busy || !value.trim()} className="cf-chip cf-chip-available">
              Add
            </button>
          </form>
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
        <Markdown>{character.notes}</Markdown>
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

/**
 * The stable public URL pattern for a D&D Beyond character sheet. The importer
 * (issue #18) resolves a numeric id from this URL or a bare id and reads the
 * public character-service JSON once; this is a one-time import, not a live
 * link. We only render the link for an id that looks like a bare DDB character
 * id (digits) so we never fabricate a URL from a malformed/garbage `ddbId`.
 */
const DDB_CHARACTER_URL = (id: string) => `https://www.dndbeyond.com/characters/${id}`;

/**
 * D&D Beyond provenance row (issue #720). The schema persists `ddbId` on
 * import, but the sheet previously always said "Not linked — soon" — misleading
 * for imported characters (they ARE linked) and vague for manual ones. This row
 * now reflects the actual provenance honestly:
 *
 *  - `ddbId` present → "Imported from D&D Beyond", a copyable source id, and a
 *    link to the public DDB sheet. Explicit that this was a one-time import, not
 *    live synchronization — the app does not re-fetch or push changes.
 *  - `ddbId` absent → "Created manually" with accurate guidance (import from a
 *    public DDB sheet on the party page), never "soon".
 *
 * Only owners/DMs (canEdit) see the copy action; viewers still see the provenance
 * label so they know where the sheet came from, but not the copy affordance.
 */
function DdbProvenanceRow({ ddbId, canEdit }: { ddbId: string | null; canEdit: boolean }) {
  // Stable DOM id for failure-recovery selection (must be above early return).
  const sourceIdEl = useId();

  // Manual character (no ddbId) — honest guidance, no "soon" hand-wave.
  if (!ddbId) {
    return (
      <div className="flex justify-between gap-2">
        <span className="text-muted">D&amp;D Beyond</span>
        <span className="text-right text-slate-500">
          Created manually
          {canEdit && (
            <span className="block text-[11px] text-slate-600">
              Import from a public sheet on the party page.
            </span>
          )}
        </span>
      </div>
    );
  }

  // Capture the narrowed non-null id so nested JSX keeps the `string` type
  // (TS does not carry early-return narrowing into nested scopes reliably).
  const sourceId = ddbId;
  const isBareId = /^\d+$/.test(sourceId);

  return (
    <div className="flex justify-between gap-2">
      <span className="text-muted">D&amp;D Beyond</span>
      <span className="text-right min-w-0">
        <span className="block">Imported from D&amp;D Beyond</span>
        <span className="block text-[11px] text-slate-500">
          One-time import — not synced.{' '}
          {/* Selectable target must contain exactly `text` (raw id) — not a
              prefixed label — so manual recovery after a clipboard failure
              copies the same payload as writeText. */}
          <span title="D&D Beyond character id">
            id <span id={sourceIdEl}>{sourceId}</span>
          </span>
          {isBareId && (
            <>
              {' '}
              <a
                href={DDB_CHARACTER_URL(sourceId)}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="underline hover:text-slate-300"
              >
                Source sheet ↗
              </a>
            </>
          )}
          {canEdit && (
            <CopyControl
              text={sourceId}
              selectTargetId={sourceIdEl}
              label="Copy id"
              title="Copy D&D Beyond character id"
              showFailureMessage={false}
              unstyled
              className="underline hover:text-slate-300 ml-1"
              style={{ background: 'transparent', border: 0, padding: 0, font: 'inherit', cursor: 'pointer' }}
              successAnnouncement="D&D Beyond character id copied to clipboard."
              failureAnnouncement="Copy failed. Clipboard blocked — copy the id manually."
            />
          )}
        </span>
      </span>
    </div>
  );
}
