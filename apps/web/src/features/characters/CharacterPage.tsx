/**
 * Character sheet — mirrors the Claude Design template
 * `templates/character-sheet/CharacterSheet.dc.html` ("Character sheet — play surface").
 *
 * Layout: back link + identity header + tab bar across the top, then a three-pane play
 * surface — a persistent vitals rail (HP, temp HP, death saves, defenses/initiative/
 * speed/proficiency, conditions, rests), the Play/Build tabpanels, and the table's shared
 * roll feed. The template's `position:fixed` full-viewport shell maps onto the same
 * sticky-rail grid RunSessionPage already uses, so the sheet stays inside the app chrome
 * and still reads as a document when printed or narrowed.
 *
 * The vitals rail sits OUTSIDE both tabpanels on purpose (as it does in the template):
 * HP, conditions and rests stay reachable while you are reading Build. `?focus=hp` and
 * `?focus=conditions` still select Play — the sections they point at are simply always
 * mounted.
 *
 * Owner or DM can edit everything (HP, conditions, stats, saves, skills, actions,
 * spell slots, story, portrait); everyone else gets a read-only view.
 *
 * Sheet depth (issue #1): saving throws (toggle proficiency per ability), skills
 * (cycle none → proficient → expertise), actions (attack/spell/feature rows), and
 * spell slots (per-level pips; spend/restore via POST /characters/:id/spell-slots,
 * maxima via PATCH spellSlots) are all backed by the Character schema now.
 *
 * Inventory (issue #454): character pack items are loaded from the campaign
 * inventory API and filtered by characterId — see CharacterInventorySection.
 *
 * D&D Beyond provenance (issue #720): the schema carries `ddbId` for characters
 * imported once from a public DDB sheet (issue #18 — a one-time import, not a live
 * link). The Player card's provenance row now branches on `ddbId`: imported sheets
 * show "Imported from D&D Beyond" + a copyable source id (no "sync" overclaim),
 * while manually-created sheets get honest guidance instead of "soon".
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type MouseEvent } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useLiveEncounterState } from '../../lib/useLiveEncounterState';
import { DetailPageWayfinding } from '../../components/DetailPageWayfinding';
import { UIIcon } from '../../components/UIIcon';
import { CharacterSheetNav } from './CharacterSheetNav';
import { characterSheetSectionId } from './characterSheetTabs';
import { useCharacterSheetTab } from './useCharacterSheetTab';
import type {
  ActionSpec,
  Attachment,
  Character,
  CharacterAction,
  CampaignMember,
  InventoryItem,
  CharacterStatus,
  SkillRank,
  LeveledConditionTrack,
  AdapterResourceDef,
} from '@campfire/schema';
import { formatNumber, useFormattingLocale } from '../../lib/format';
import {
  abilityLabelForAdapter,
  xpProgressForCharacter,
  ruleSystemAdapter,
  type RuleSystemAdapter,
  type RollCheckDefinition,
  checkCatalogForAdapter,
  sortCheckCatalog,
  formatCheckBreakdown,
  restOptionsForAdapter,
  inferActionSpecFromText,
  isResolvableSpec,
  hasDeathSavesForAdapter,
} from '@campfire/schema';
import { DeathSaveTracker } from '../encounters/combat/DeathSaves';
import { SharedDiceLog } from '../dice/SharedDiceLog';
import { findLeveledConditionTrack, conditionLevel } from './leveledCondition';
import { CHARACTER_STATUSES, STATUS_LABEL, StatusTag } from './status';
import { api, API, ApiError } from '../../lib/api';
import {
  compositionSafeEscapeHandler,
  compositionSafeFormSubmit,
  createCompositionSubmitGate,
  isImeComposing,
} from '../../lib/compositionSafeSubmit';
import { useAuth } from '../../app/auth';
import { useProtectedForm } from '../../lib/useProtectedForm';
import {
  characterSheetDraftFrom,
  characterSheetDraftsEqual,
  isCharacterSheetDirty,
  normalizeRestoredDraft,
  snapshotCharacterSheetDraft,
} from './characterSheetFormState';
import { useCampaignAccess } from '../../app/CampaignAccessContext';
import { useCampaign } from '../../app/CampaignContext';
import { Card, Chip, Btn, TextInput, TextArea, ErrorNote, HpBar } from '../../components/ui';
import { useTranslation } from 'react-i18next';
import { CharacterDetailLoadingSkeleton } from './CharacterDetailLoadingSkeleton';
import { Field } from '../../components/Field';
import {
  CHARACTER_AC_LABEL,
  CHARACTER_ACTION_DAMAGE_HELP,
  CHARACTER_ACTION_DAMAGE_LABEL,
  CHARACTER_ACTION_FIELD,
  CHARACTER_ACTION_KIND_LABEL,
  CHARACTER_ACTION_NAME_LABEL,
  CHARACTER_ACTION_NOTES_LABEL,
  CHARACTER_ACTION_PREFIX,
  CHARACTER_ACTION_TO_HIT_HELP,
  CHARACTER_ACTION_TO_HIT_LABEL,
  CHARACTER_BACKGROUND_LABEL,
  CHARACTER_CLASS_LABEL,
  CHARACTER_CONDITION_HELP,
  CHARACTER_CONDITION_LABEL,
  CHARACTER_CONDITION_PREFIX,
  CHARACTER_EDIT_PREFIX,
  CHARACTER_FIELD,
  CHARACTER_HP_MAX_HELP,
  CHARACTER_HP_MAX_LABEL,
  CHARACTER_LEVEL_LABEL,
  CHARACTER_NAME_LABEL,
  CHARACTER_SPECIES_LABEL,
  CHARACTER_SPEED_LABEL,
  CHARACTER_STATUS_HELP,
  CHARACTER_STATUS_LABEL,
  CHARACTER_STORY_HELP,
  CHARACTER_STORY_LABEL,
  CHARACTER_STORY_PREFIX,
} from '../../components/formFieldLabels';
import { NotFoundState } from '../../components/NotFoundState';
import { Markdown } from '../../components/Markdown';
import { PrintControl } from '../../components/PrintControl';
import { RollContextMenu, type RollMode } from '../../components/RollContextMenu';
import { EntityDiscussion } from '../comments/EntityDiscussion';
import { NotesRail } from '../../components/NotesRail';
import { ImageUpload, attachmentFileUrl } from '../../components/ImageUpload';
import { initials } from './avatar';
import { GameIcon } from '../../components/GameIcon';
import { entityTargetProps } from '../../lib/entityLinks';
import {
  type Ability,
  SPELL_LEVELS,
  profBonus,
  abilityScore,
  abilityFieldsForCharacter,
  signed,
  toHitExpr,
  damageExpr, critDamageExpr,
  rollPreview,
} from '../../lib/characterStats';
import { RollModeChooser } from './RollModeChooser';
import { resolveRollMode, toCheckRollMode, rollModeSummary } from './rollMode';
import { useRoller, type Roller } from '../../lib/useRoller';
import { UndoSnackbar } from '../../components/UndoSnackbar';
import { useAnnounce } from '../../components/Announcer';
import { CopyControl } from '../../components/CopyControl';
import { CharacterTrashMenu } from './CharacterTrashMenu';
import { CharacterCompletionBanner } from './CharacterCompletionBanner';
import { CharacterInventorySection } from './CharacterInventorySection';
import { parseLocalizedInteger } from '../../lib/i18nNumbers';
import {
  XP_AWARD_HELP,
  XP_AWARD_LABEL,
  hpDeltaLabel,
  hpFullHealLabel,
  saveProficiencyLabel,
  skillProficiencyLabel,
  skillRankLabel,
  type SkillProficiencyRank,
} from './characterSheetA11y';
import {
  canAdjustSpecialResource,
  findSpecialResource,
  resourceAvailability,
  specialResourceAdjustBody,
} from './specialCharacterResource';
import { UI_ICON_SIZE } from '../../lib/uiIcons';
import { actionSpecEffects, actionSpecFacts, actionSourceText } from './actionSpecFacts';
import { adapterConditionLabel, adapterResourceLabel } from '../../lib/adapterVocabularyLabel';

export default function CharacterPage() {
  const { campaignId, characterId } = useParams<{ campaignId: string; characterId: string }>();
  const cid = Number(campaignId);
  const id = Number(characterId);
  const navigate = useNavigate();
  const { me } = useAuth();
  const { isDm, canDmWrite, canPlayerWrite } = useCampaignAccess();
  const activeCampaign = useCampaign(Number.isFinite(cid) ? cid : undefined);
  // Rule-system adapter resolved from the active campaign (issue #234, #2003): drives ability
  // modifiers and the condition vocabulary instead of a call-site 5e default.
  const adapter = ruleSystemAdapter(activeCampaign?.ruleSystem, activeCampaign?.customMechanicsProfile);

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
  const [markingActive, setMarkingActive] = useState(false);
  // This character's pack, read only to surface the actions their EQUIPPED gear grants
  // (`InventoryItem.equippedAction`, issue #1326/#1791) in the Actions card, as the design
  // template does with its 🎒 chips. Those actions are already usable in an encounter, so a
  // sheet that omits them hides half of what a geared character can do. Best-effort: a
  // failed read costs the gear rows, never the sheet.
  const [packItems, setPackItems] = useState<InventoryItem[]>([]);
  // Shared dice-log roller for click-to-roll saves/skills/attacks (issue #258).
  const roller = useRoller(cid, setActionError);
  const { liveEncounter } = useLiveEncounterState(Number.isFinite(cid) ? cid : undefined);
  const announce = useAnnounce();
  const { tab, setTab, tabRefs, onTabKeyDown } = useCharacterSheetTab({
    campaignId: cid,
    characterId: id,
    canViewDmSecret: isDm,
  });
  const xpProgress = useMemo(
    () => (character ? xpProgressForCharacter(adapter, character.level, character.xp) : null),
    [adapter, character],
  );

  const load = useCallback(async () => {
    setLoading(true);
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

  // Drop stale sheet data immediately when the route id changes so reload and
  // character-to-character navigation never flash the previous character.
  useEffect(() => {
    if (!Number.isFinite(id)) return;
    setCharacter(null);
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

  useEffect(() => {
    if (!Number.isFinite(cid) || !Number.isFinite(id)) return;
    let cancelled = false;
    (async () => {
      try {
        const list = await api.get<InventoryItem[]>(`${API}/campaigns/${cid}/inventory`);
        if (!cancelled) setPackItems(list.filter((item) => item.ownerType === 'character' && item.characterId === id));
      } catch {
        if (!cancelled) setPackItems([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cid, id]);

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
    return <CharacterDetailLoadingSkeleton />;
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
  const canEdit = canDmWrite || (canPlayerWrite && isOwner);
  const classField = adapter.characterSheet?.classField ?? { label: 'Class', placeholder: 'Class', required: true, visible: true };
  const classSummary = classField.visible && character.className.trim()
    ? `${character.className} · `
    : classField.visible
      ? `${classField.label} not set · `
      : '';
  const defenseLabel = adapter.presentation?.defense.short ?? adapter.presentation?.defense.full ?? 'AC';
  const defenseTitle = adapter.presentation?.defense.full ?? 'Defense';
  const showSavingThrowEditor = adapter.characterSheet?.supportsSavingThrowEditor ?? true;
  const showSkillEditor = adapter.characterSheet?.supportsSkillEditor ?? true;
  const showSpellSlotEditor = adapter.characterSheet?.supportsSpellSlotEditor ?? true;
  // Issue #1643: whichever leveled condition track (if any) THIS campaign's adapter
  // declares — 5e Exhaustion, or nothing for a system with none (PF2e). Never assumed.
  const leveledConditionTrack = findLeveledConditionTrack(adapter);
  // Issue #1642: whichever of the two special counted resources THIS campaign's adapter
  // actually declares (5e `inspiration`, PF2e `heroPoints`, or neither) — never assumed.
  // A system declaring neither renders nothing here; see specialCharacterResource.ts.
  const specialResource = findSpecialResource(adapter);

  async function savePortrait(attachment: Attachment) {
    setActionError(null);
    try {
      // Issue #498: embed the authorization-aware version token in the stored portrait
      // URL so a later content/hidden change invalidates any cached copy.
      await api.patch(`${API}/characters/${id}`, {
        portraitUrl: attachmentFileUrl(attachment.id, { hidden: attachment.hidden, updatedAt: attachment.updatedAt }),
      });
      await load();
      announce('Portrait saved');
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
    announce('Character restored');
  }

  async function markActive() {
    setMarkingActive(true);
    setActionError(null);
    try {
      await api.patch(`${API}/characters/${id}`, { status: 'active' });
      await load();
      announce('Character marked active');
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't mark this character active.");
    } finally {
      setMarkingActive(false);
    }
  }

  return (
    <div className="cf-character-sheet-root reading-surface max-w-5xl xl:max-w-[80rem] 2xl:max-w-[100rem] mx-auto px-4 mt-5 space-y-4 pb-20 md:pb-10" {...entityTargetProps('character', character.id)}>
      <div className="cf-print-hide">
        <DetailPageWayfinding
          campaignId={cid}
          defaultPath={`/c/${cid}/party`}
          defaultLabel="← Back to party"
        />
      </div>

      {(error || actionError) && <ErrorNote message={actionError ?? error ?? ''} onRetry={() => { setActionError(null); void load(); }} />}

      <div className="flex items-center gap-3 flex-wrap">
        {character.portraitUrl ? (
          <img
            src={character.portraitUrl}
            alt=""
            className="h-14 w-14 shrink-0 rounded-full object-cover border border-[var(--color-neutral-700)]"
          />
        ) : (
          <div className="cf-print-paper h-14 w-14 shrink-0 rounded-full bg-[var(--color-accent-900)] text-[var(--color-accent-200)] flex items-center justify-center text-[17px] font-semibold">
            {initials(character.name)}
          </div>
        )}
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-2xl font-extrabold text-white leading-tight break-words">{character.name}</h1>
            {character.status !== 'active' && <StatusTag status={character.status} />}
          </div>
          <p className="text-sm text-slate-400">
            {classSummary}Level {character.level} · played by{' '}
            {character.ownerUserId ? ownerLabel(character.ownerUserId) : 'DM'}
            {xpProgress?.ready && (
              <span className="cf-print-hide" aria-hidden="true">
                {' · '}
                <span className="tag tag-accent text-[9px]" aria-label="Ready to level up">
                  Ready to level up
                </span>
              </span>
            )}
          </p>
        </div>
        {isOwner && <Chip variant="dm" className="cf-print-hide">You can edit</Chip>}
        <div className="flex items-center gap-1 ml-auto">
          {!editingSheet && (
            <PrintControl
              resetKey={character.id}
              allowSecrets={isDm && Boolean(character.dmSecret)}
            />
          )}
          {canEdit && !editingSheet && (
            <Btn density="xs" ghost className="cf-print-hide text-xs" onClick={() => setEditingSheet(true)}>
              ✎ Edit sheet
            </Btn>
          )}
          {canEdit && (
            <span className="cf-print-hide">
              <CharacterTrashMenu characterName={character.name} busy={trashing} onTrash={trash} />
            </span>
          )}
        </div>
      </div>

      <CharacterCompletionBanner
        character={character}
        adapter={adapter}
        canEdit={canEdit}
        onMarkActive={() => void markActive()}
        markingActive={markingActive}
      />

      {editingSheet && (
        <Card className="space-y-3">
          <SheetEditForm
            character={character}
            adapter={adapter}
            onCancel={() => setEditingSheet(false)}
            onSaved={() => {
              setEditingSheet(false);
              void load();
            }}
            onError={setActionError}
          />
        </Card>
      )}

      <CharacterSheetNav
        tab={tab}
        setTab={setTab}
        tabRefs={tabRefs}
        onTabKeyDown={onTabKeyDown}
        liveEncounter={liveEncounter != null}
        levelUpReady={xpProgress?.ready}
      />

      {/*
        Three-pane play surface from the design template: vitals rail | tabpanels |
        roll feed. The panes appear as the width to hold them does — rail at xl, roll feed
        at 2xl — because the centre pane's own grids (six ability tiles, six save tiles)
        stop being tappable long before they stop fitting. Below xl everything stacks, rail
        first, since HP and conditions are what a player reaches for at the table; that is
        also the print order.
      */}
      <div className="cf-character-play-surface grid gap-4 min-w-0 items-start xl:grid-cols-[16rem_minmax(0,1fr)] 2xl:grid-cols-[16rem_minmax(0,1fr)_19rem]">
        <CharacterVitalsRail
          character={character}
          adapter={adapter}
          canEdit={canEdit}
          onChange={load}
          onError={setActionError}
          roller={roller}
          leveledConditionTrack={leveledConditionTrack}
          defenseLabel={defenseLabel}
          defenseTitle={defenseTitle}
        />

        <div className="min-w-0 space-y-4">
          {/*
            Play vs Build/Profile IA (issue #646): at-table controls live in Play;
            advancement, story, portrait, and DM admin live in Build. Both panels stay
            mounted (WAI-ARIA tabpanels) so deep links and aria-controls resolve; the
            inactive panel is hidden to cut mobile scroll depth.
          */}
          <div
            id="character-sheet-panel-play"
            role="tabpanel"
            aria-labelledby="character-sheet-tab-play"
            tabIndex={0}
            data-testid="character-sheet-panel-play"
            className={tab === 'play' ? 'space-y-4 min-w-0' : 'cf-character-sheet-panel-hidden space-y-4 min-w-0'}
            aria-hidden={tab !== 'play'}
          >
            <section
              id={characterSheetSectionId('abilities')}
              aria-labelledby={`${characterSheetSectionId('abilities')}-heading`}
              className="cf-sheet-section"
            >
              <AbilityScoresCard character={character} adapter={adapter} roller={roller} />
            </section>

            <section
              id={characterSheetSectionId('actions')}
              aria-labelledby={`${characterSheetSectionId('actions')}-heading`}
              className="cf-sheet-section"
            >
              <ActionsCard
                character={character}
                canEdit={canEdit}
                onChange={load}
                onError={setActionError}
                roller={roller}
                packItems={packItems}
                onShowInventory={() => setTab('build', { focus: 'inventory' })}
              />
            </section>

            {showSavingThrowEditor && (
              <section
                id={characterSheetSectionId('saves')}
                aria-labelledby={`${characterSheetSectionId('saves')}-heading`}
                className="cf-sheet-section"
              >
                <SavingThrowsCard character={character} canEdit={canEdit} onChange={load} onError={setActionError} adapter={adapter} roller={roller} />
              </section>
            )}

            {showSkillEditor && (
              <section
                id={characterSheetSectionId('skills')}
                aria-labelledby={`${characterSheetSectionId('skills')}-heading`}
                className="cf-sheet-section"
              >
                <SkillsCard character={character} canEdit={canEdit} onChange={load} onError={setActionError} adapter={adapter} roller={roller} />
              </section>
            )}

            {showSpellSlotEditor ? (
              <section
                id={characterSheetSectionId('slots')}
                aria-labelledby={`${characterSheetSectionId('slots')}-heading`}
                className="cf-sheet-section"
              >
                <SpellSlotsCard character={character} canEdit={canEdit} onChange={load} onError={setActionError} />
              </section>
            ) : adapter.characterSheet?.genericModeDescription ? (
              <Card className="space-y-1.5">
                <h2 id="character-rules-native-heading" className="card-kicker mb-0">Rules-native sheet mode</h2>
                <p className="text-xs text-secondary">{adapter.characterSheet.genericModeDescription}</p>
              </Card>
            ) : null}

            {specialResource && (
              <section
                id={characterSheetSectionId('resources')}
                aria-labelledby={`${characterSheetSectionId('resources')}-heading`}
                className="cf-sheet-section"
              >
                <AdapterResourceCard character={character} canEdit={canEdit} onChange={load} onError={setActionError} def={specialResource} />
              </section>
            )}
          </div>

          <div
            id="character-sheet-panel-build"
            role="tabpanel"
            aria-labelledby="character-sheet-tab-build"
            tabIndex={0}
            data-testid="character-sheet-panel-build"
            className={tab === 'build'
              ? 'grid grid-cols-1 md:grid-cols-[1fr_280px] gap-4 items-start min-w-0'
              : 'cf-character-sheet-panel-hidden grid grid-cols-1 md:grid-cols-[1fr_280px] gap-4 items-start min-w-0'}
            aria-hidden={tab !== 'build'}
          >
            <div className="space-y-4 min-w-0">
              <section
                id={characterSheetSectionId('xp')}
                aria-labelledby={`${characterSheetSectionId('xp')}-heading`}
                className="cf-sheet-section"
              >
                <XpCard character={character} adapter={adapter} canEdit={canEdit} onChange={load} onError={setActionError} />
              </section>

              <section
                id={characterSheetSectionId('background')}
                aria-labelledby={`${characterSheetSectionId('background')}-heading`}
                className="cf-sheet-section"
              >
                <Card className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h2 id={`${characterSheetSectionId('background')}-heading`} className="card-kicker mb-0">Background</h2>
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
              </section>

              <section
                id={characterSheetSectionId('inventory')}
                aria-labelledby={`${characterSheetSectionId('inventory')}-heading`}
                className="cf-sheet-section"
              >
                <Card>
                  <CharacterInventorySection campaignId={cid} character={character} />
                </Card>
              </section>

              {isDm && (
                <section
                  id={characterSheetSectionId('dm-secret')}
                  aria-labelledby={`${characterSheetSectionId('dm-secret')}-heading`}
                  className="cf-sheet-section cf-print-secret"
                >
                  <DmSecretCard character={character} onChange={load} onError={setActionError} />
                </section>
              )}
            </div>

            <div className="space-y-4 min-w-0">
              <section
                id={characterSheetSectionId('portrait')}
                aria-labelledby={`${characterSheetSectionId('portrait')}-heading`}
                className="cf-sheet-section"
              >
                <Card className="items-center text-center py-6 space-y-1.5">
                  {canEdit ? (
                    <>
                      <div className="cf-print-hide">
                        <ImageUpload
                          campaignId={cid}
                          kind="portrait"
                          shape="circle"
                          previewUrl={character.portraitUrl ?? undefined}
                          label="Portrait"
                          onUploaded={savePortrait}
                          onError={setActionError}
                        />
                      </div>
                      {character.portraitUrl ? (
                        <img
                          src={character.portraitUrl}
                          alt=""
                          className="cf-print-only h-24 w-24 rounded-full object-cover border border-[var(--color-neutral-700)]"
                        />
                      ) : (
                        <span className="cf-print-only h-24 w-24 rounded-full border border-dashed border-[var(--color-neutral-700)] flex items-center justify-center text-[length:var(--type-label)] text-secondary">
                          Portrait
                        </span>
                      )}
                      <span className="text-[length:var(--type-label)] text-secondary cf-print-hide">Click or drop to change</span>
                    </>
                  ) : character.portraitUrl ? (
                    <img
                      src={character.portraitUrl}
                      alt=""
                      className="h-24 w-24 rounded-full object-cover border border-[var(--color-neutral-700)]"
                    />
                  ) : (
                    <span className="h-24 w-24 rounded-full border border-dashed border-[var(--color-neutral-700)] flex items-center justify-center text-[length:var(--type-label)] text-secondary">
                      Portrait
                    </span>
                  )}
                </Card>
              </section>
              <section
                id={characterSheetSectionId('player')}
                aria-labelledby={`${characterSheetSectionId('player')}-heading`}
                className="cf-sheet-section"
              >
                <Card className="space-y-2">
                  <h2 id={`${characterSheetSectionId('player')}-heading`} className="card-kicker mb-0">Player</h2>
                  <div className="space-y-1.5 text-[13px]">
                    <div className="flex justify-between">
                      <span className="text-muted">Owner</span>
                      <span>{ownerLabel(character.ownerUserId)}</span>
                    </div>
                    <DdbProvenanceRow ddbId={character.ddbId} canEdit={canEdit} />
                  </div>
                </Card>
              </section>
            </div>
          </div>
        </div>

        {/*
          The template's right-hand "Roll feed — shared with the table" rail. This is the
          SAME campaign-scoped shared log the encounter screen and the dashboard show
          (SharedDiceLog), including its quick d4–d20 tray, so a save rolled here and a
          save rolled in the encounter land in one feed rather than two.
        */}
        <aside
          className="min-w-0 cf-print-hide xl:col-span-2 2xl:col-span-1 2xl:sticky 2xl:max-h-[calc(100vh-var(--app-header-h,0px)-5rem)] 2xl:overflow-y-auto 2xl:overscroll-contain"
          style={{ top: 'calc(var(--app-header-h, 0px) + 4rem)' }}
          aria-label="Roll feed"
          data-testid="character-roll-feed"
        >
          <SharedDiceLog campaignId={cid} />
        </aside>
      </div>

      <div className="cf-print-hide">
        <EntityDiscussion campaignId={cid} entityType="character" entityId={character.id} />
        {isOwner && <NotesRail campaignId={cid} entityType="character" entityId={character.id} />}
      </div>

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
  adapter,
  onCancel,
  onSaved,
  onError,
}: {
  character: Character;
  adapter: RuleSystemAdapter;
  onCancel: () => void;
  onSaved: () => void;
  onError: (msg: string | null) => void;
}) {
  const { me } = useAuth();
  const baseline = useMemo(() => characterSheetDraftFrom(character, adapter), [adapter, character]);
  const [name, setName] = useState(baseline.name);
  const [species, setSpecies] = useState(baseline.species);
  const [className, setClassName] = useState(baseline.className);
  const [background, setBackground] = useState(baseline.background);
  const [level, setLevel] = useState(baseline.level);
  const [ac, setAc] = useState(baseline.ac);
  const [speed, setSpeed] = useState(baseline.speed);
  const [hpMax, setHpMax] = useState(baseline.hpMax);
  const [status, setStatus] = useState<CharacterStatus>(baseline.status);
  const [stats, setStats] = useState<Record<string, string>>(baseline.stats);
  const [saving, setSaving] = useState(false);
  // Per-field parse errors (issue #633): level/AC/HP/stats are parsed in the
  // viewer's locale; an unparseable value keeps the field's current text and
  // surfaces a message here rather than silently coercing to 0/1.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const formatLocale = useFormattingLocale();
  const announce = useAnnounce();
  const clearPersistedDraftRef = useRef<() => void>(() => {});
  const classField = adapter.characterSheet?.classField ?? { label: 'Class', placeholder: 'Class', required: true, visible: true };
  const classFieldVisible = classField.visible;
  const defenseLabel = adapter.presentation?.defense.short ?? adapter.presentation?.defense.full ?? CHARACTER_AC_LABEL;
  const statFields = Object.keys(stats).map((key) => ({ key, label: abilityLabelForAdapter(adapter, key) }));

  const draft = snapshotCharacterSheetDraft({
    name,
    species,
    className,
    background,
    level,
    ac,
    speed,
    hpMax,
    status,
    stats,
  });
  const dirty = isCharacterSheetDirty(draft, baseline);

  const save = useCallback(async (): Promise<boolean> => {
    if (!name.trim()) return false;
    const errs: Record<string, string> = {};
    const levelMax = Number.isFinite(adapter.maxLevel) ? adapter.maxLevel : undefined;
    const levelParsed = parseLocalizedInteger(level, formatLocale, levelMax ? { min: 1, max: levelMax } : { min: 1 });
    if (!levelParsed.ok) errs.level = levelParsed.error;
    let acValue: number | null = null;
    if (ac.trim() !== '') {
      const acParsed = parseLocalizedInteger(ac, formatLocale);
      if (!acParsed.ok) errs.ac = acParsed.error;
      else acValue = acParsed.value;
    }
    // Issue #1910: optional, locale-parsed like AC. min:0 mirrors the schema's
    // speed.min(0) — no upper bound, unlike AC's implicit sanity ceiling.
    let speedValue: number | null = null;
    if (speed.trim() !== '') {
      const speedParsed = parseLocalizedInteger(speed, formatLocale, { min: 0 });
      if (!speedParsed.ok) errs.speed = speedParsed.error;
      else speedValue = speedParsed.value;
    }
    const hpMaxParsed = parseLocalizedInteger(hpMax, formatLocale, { min: 1 });
    if (!hpMaxParsed.ok) errs.hpMax = hpMaxParsed.error;
    const statNums: Record<string, number> = {};
    for (const [k, value] of Object.entries(stats)) {
      const parsed = parseLocalizedInteger(value, formatLocale);
      if (!parsed.ok) errs[k] = parsed.error;
      else statNums[k] = parsed.value;
    }
    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs);
      return false;
    }
    setFieldErrors({});
    const levelNum = (levelParsed as { ok: true; value: number }).value;
    const hpMaxNum = (hpMaxParsed as { ok: true; value: number }).value;
    setSaving(true);
    onError(null);
    try {
      await api.patch(`${API}/characters/${character.id}`, {
        name: name.trim(),
        species: species.trim(),
        className: classFieldVisible ? className.trim() : '',
        background: background.trim(),
        level: levelNum,
        ac: acValue,
        speed: speedValue,
        hpMax: hpMaxNum,
        status,
        stats: { ...character.stats, ...statNums },
      });
      clearPersistedDraftRef.current();
      onSaved();
      announce(`${name.trim()} profile saved`);
      return true;
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Couldn't save the sheet.");
      return false;
    } finally {
      setSaving(false);
    }
  }, [
    ac,
    announce,
    background,
    character.id,
    character.stats,
    className,
    classFieldVisible,
    adapter,
    formatLocale,
    hpMax,
    level,
    name,
    onError,
    onSaved,
    species,
    speed,
    stats,
    status,
  ]);

  const protectedSheet = useProtectedForm({
    formId: `character-sheet:${character.id}`,
    userId: me?.user.id,
    campaignId: character.campaignId,
    active: true,
    dirty,
    draft,
    baseline,
    serverUpdatedAt: character.updatedAt,
    isDraftEqual: characterSheetDraftsEqual,
    // Issue #1910 review (Devin, PR #1980): readFormDraft only validates the
    // envelope (v: 1) + that `data` exists, not the field set — a draft
    // persisted before `speed` joined CharacterSheetDraft restores with
    // `data.speed === undefined`. Feeding that straight into setSpeed puts a
    // non-string into state typed `string`, and save()'s later `speed.trim()`
    // throws inside the async handler — an unhandled rejection (the handler
    // is `void save()`), so the Save button silently does nothing.
    // normalizeRestoredDraft fills every field defensively, not just the one
    // reported line — see its own doc comment for why the rest of this shape
    // has no CURRENT equivalent gap, but could gain one the next time a field
    // is added here.
    onRestoreDraft: (restored) => {
      const safe = normalizeRestoredDraft(restored);
      setName(safe.name);
      setSpecies(safe.species);
      setClassName(safe.className);
      setBackground(safe.background);
      setLevel(safe.level);
      setAc(safe.ac);
      setSpeed(safe.speed);
      setHpMax(safe.hpMax);
      setStatus(safe.status);
      setStats(safe.stats);
    },
    onDiscard: onCancel,
    onSave: save,
  });
  clearPersistedDraftRef.current = protectedSheet.clearPersistedDraft;

  const cardLabel = 'text-[10px] text-slate-300 font-bold uppercase tracking-wide';

  return (
    <div className="space-y-3" data-testid="character-sheet-edit">
      {protectedSheet.restorePrompt}
      {protectedSheet.leavePrompt}
      <Field
        idPrefix={CHARACTER_EDIT_PREFIX}
        name={CHARACTER_FIELD.name}
        label={CHARACTER_NAME_LABEL}
        labelClassName={cardLabel}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name"
        required
      />
      <div className={classField.visible ? 'grid grid-cols-2 gap-2.5' : 'grid grid-cols-1 gap-2.5'}>
        <Field
          idPrefix={CHARACTER_EDIT_PREFIX}
          name={CHARACTER_FIELD.species}
          label={CHARACTER_SPECIES_LABEL}
          labelClassName={cardLabel}
          value={species}
          onChange={(e) => setSpecies(e.target.value)}
          placeholder="Species"
          optional
        />
        {classField.visible && (
          <Field
            idPrefix={CHARACTER_EDIT_PREFIX}
            name={CHARACTER_FIELD.className}
            label={classField.label || CHARACTER_CLASS_LABEL}
            labelClassName={cardLabel}
            value={className}
            onChange={(e) => setClassName(e.target.value)}
            placeholder={classField.placeholder}
            optional={!classField.required}
          />
        )}
      </div>
      <div className="grid grid-cols-3 gap-2.5">
        <Field
          idPrefix={CHARACTER_EDIT_PREFIX}
          name={CHARACTER_FIELD.background}
          label={CHARACTER_BACKGROUND_LABEL}
          labelClassName={cardLabel}
          value={background}
          onChange={(e) => setBackground(e.target.value)}
          placeholder="Background"
          optional
        />
        {/* type="text" + inputMode="numeric" (issue #633): a type="number" field
            silently strips locale grouping (en "1,000" → "", de "1.000" → "1")
            before the parser sees it, so the localized path is bypassed. */}
        <Field
          idPrefix={CHARACTER_EDIT_PREFIX}
          name={CHARACTER_FIELD.level}
          label={CHARACTER_LEVEL_LABEL}
          labelClassName={cardLabel}
          type="text"
          inputMode="numeric"
          min={1}
          max={Number.isFinite(adapter.maxLevel) ? adapter.maxLevel : undefined}
          value={level}
          error={fieldErrors.level || null}
          onChange={(e) => {
            setLevel(e.target.value);
            setFieldErrors((fe) => ({ ...fe, level: '' }));
          }}
          placeholder="Level"
        />
        <Field
          idPrefix={CHARACTER_EDIT_PREFIX}
          name={CHARACTER_FIELD.ac}
          label={defenseLabel}
          labelClassName={cardLabel}
          type="text"
          inputMode="numeric"
          value={ac}
          error={fieldErrors.ac || null}
          onChange={(e) => {
            setAc(e.target.value);
            setFieldErrors((fe) => ({ ...fe, ac: '' }));
          }}
          placeholder={defenseLabel}
          optional
        />
        <Field
          idPrefix={CHARACTER_EDIT_PREFIX}
          name={CHARACTER_FIELD.speed}
          label={CHARACTER_SPEED_LABEL}
          labelClassName={cardLabel}
          type="text"
          inputMode="numeric"
          min={0}
          value={speed}
          error={fieldErrors.speed || null}
          onChange={(e) => {
            setSpeed(e.target.value);
            setFieldErrors((fe) => ({ ...fe, speed: '' }));
          }}
          placeholder={CHARACTER_SPEED_LABEL}
          optional
        />
      </div>
      <div className="grid grid-cols-3 gap-2.5">
        <Field
          idPrefix={CHARACTER_EDIT_PREFIX}
          name={CHARACTER_FIELD.hpMax}
          label={CHARACTER_HP_MAX_LABEL}
          labelClassName={cardLabel}
          type="text"
          inputMode="numeric"
          min={1}
          value={hpMax}
          error={fieldErrors.hpMax || null}
          help={CHARACTER_HP_MAX_HELP}
          onChange={(e) => {
            setHpMax(e.target.value);
            setFieldErrors((fe) => ({ ...fe, hpMax: '' }));
          }}
          placeholder="Max HP"
        />
        <Field
          idPrefix={CHARACTER_EDIT_PREFIX}
          name={CHARACTER_FIELD.status}
          as="select"
          label={CHARACTER_STATUS_LABEL}
          labelClassName={cardLabel}
          className="field col-span-2"
          value={status}
          onChange={(e) => setStatus(e.target.value as CharacterStatus)}
          help={CHARACTER_STATUS_HELP}
        >
          {CHARACTER_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </Field>
      </div>
      <div className="grid grid-cols-3 gap-2.5">
        {statFields.map(({ key, label }) => (
          <Field
            key={key}
            idPrefix={CHARACTER_EDIT_PREFIX}
            name={key}
            label={label}
            labelClassName={cardLabel}
            type="text"
            inputMode="numeric"
            value={stats[key]}
            error={fieldErrors[key] || null}
            onChange={(e) => {
              setStats((s) => ({ ...s, [key]: e.target.value }));
              setFieldErrors((fe) => ({ ...fe, [key]: '' }));
            }}
          />
        ))}
      </div>
      <div className="flex gap-2 justify-end items-center">
        {protectedSheet.saveStatusLabel ? (
          <span className="text-xs text-slate-400 mr-auto" role="status" aria-live="polite">
            {protectedSheet.saveStatusLabel}
          </span>
        ) : null}
        <Btn
          ghost
          type="button"
          onClick={() => {
            protectedSheet.clearPersistedDraft();
            onCancel();
          }}
          disabled={saving}
        >
          Cancel
        </Btn>
        <Btn type="button" onClick={() => void save()} disabled={saving || !name.trim()}>
          {saving ? 'Saving…' : 'Save'}
        </Btn>
      </div>
    </div>
  );
}

/**
 * Experience card — XP total, optional progress toward the next threshold (when the
 * campaign's rule-system adapter models XP), a quick-award input, and the guided
 * level-up flow (issue #14). The threshold is advisory only: "Level up" always works
 * so milestone campaigns aren't blocked, but the card calls out when the XP qualifies.
 */
function XpCard({
  character,
  adapter,
  canEdit,
  onChange,
  onError,
}: {
  character: Character;
  adapter: RuleSystemAdapter;
  canEdit: boolean;
  onChange: () => void;
  onError: (msg: string | null) => void;
}) {
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const announce = useAnnounce();
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

  const progress = xpProgressForCharacter(adapter, character.level, character.xp);
  const { supported, atCap, nextThreshold, ready, pct } = progress;
  const capLabel =
    adapter.maxLevel === Infinity
      ? 'No level cap'
      : `Level ${adapter.maxLevel} — the summit. XP still accrues for bragging rights.`;

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
      announce(`Awarded ${parsed.value} XP to ${character.name}`);
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
      announce(`${character.name} reached level ${character.level + 1}`);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Couldn't level up.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-3" data-testid="character-xp">
      <div className="flex items-baseline gap-2.5 flex-wrap">
        <h2 id={`${characterSheetSectionId('xp')}-heading`} className="card-kicker mb-0">Experience</h2>
        {supported && ready && (
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
          {formatNumber(character.xp)}
          <span className="text-base text-secondary">
            {supported && nextThreshold != null ? ` / ${formatNumber(nextThreshold)} XP` : ' XP'}
          </span>
        </span>
        {supported && (
          <div className="flex-1 min-w-[120px] h-[7px] rounded bg-[var(--color-neutral-800)] overflow-hidden">
            <div className="h-full bg-[var(--color-accent)]" style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>
      <p className="text-xs text-secondary">
        {atCap
          ? capLabel
          : !supported
            ? 'XP tracked — level up when your DM says so.'
            : ready
              ? `Enough XP for level ${character.level + 1}!`
              : `${formatNumber(nextThreshold! - character.xp)} XP to level ${character.level + 1}.`}
      </p>
      {canEdit && (
        <div className="flex gap-2 flex-wrap items-end cf-print-hide">
          {/* Labeled XP award (issue #448): associated label/help/error so the
              control is not an unnamed spinbutton/textbox. type="text" +
              inputMode="numeric" (issue #633) preserves locale digits. */}
          <div className="space-y-1">
            <label htmlFor={xpFieldId} className="block text-[10px] font-bold uppercase tracking-wide text-secondary">
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
                if (e.key === 'Enter' && !isImeComposing(e)) void addXp();
              }}
              placeholder="XP…"
              className="cf-input !w-24 text-sm"
              style={{ minHeight: 44, padding: '4px 10px' }}
            />
            <p id={xpHelpId} className="text-[11px] text-secondary m-0 max-w-[16rem]">
              {XP_AWARD_HELP}
            </p>
            {amountError && (
              <p id={xpErrorId} role="alert" className="text-xs text-rose-400 m-0">
                {amountError}
              </p>
            )}
          </div>
          <Btn className="" style={{ minHeight: 44 }} disabled={busy || !amount.trim()} onClick={addXp}>
            + Award XP
          </Btn>
          {!atCap && !levellingUp && (
            <Btn
              ghost={!ready}
              className="ml-auto"
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
        <div className="cf-inset p-3 space-y-2.5 cf-print-hide">
          <p className="text-sm font-bold text-white">
            Level {character.level} → {character.level + 1}
          </p>
          <p className="text-xs text-secondary">
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
            <Btn density="xs" ghost className="text-xs" disabled={busy} onClick={() => setLevellingUp(false)}>
              Cancel
            </Btn>
            <Btn density="xs"
              className="text-xs"
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
  onClick: (mode: RollMode) => void;
  disabled: boolean;
}) {
  return (
    <RollContextMenu type="button" className="btn btn-ghost btn-xs text-xs" style={{ minHeight: 32 }} onRoll={onClick} disabled={disabled} title={title}>
      <GameIcon slug="rolling-dices" size={UI_ICON_SIZE.xs} className="inline align-text-bottom mr-1" />{label}
    </RollContextMenu>
  );
}

/**
 * Ability scores — click to roll (design template, "Ability scores — click to roll a
 * check"). The modifier and the roll both come from the campaign adapter's check catalog
 * via `roller.rollCheck`, exactly as Skills and Saving throws already do, so the sheet
 * never invents ability math client-side. An adapter whose catalog carries no `ability`
 * entry for a field still renders the score read-only rather than a dead button.
 */
function AbilityScoresCard({
  character,
  adapter,
  roller,
}: {
  character: Character;
  adapter: RuleSystemAdapter;
  roller: Roller;
}) {
  const abilityFields = useMemo(() => abilityFieldsForCharacter(adapter, character), [adapter, character]);
  const abilityChecks = useMemo(() => {
    const catalog = checkCatalogForAdapter(adapter, character).filter((c) => c.category === 'ability');
    const byAbility = new Map<string, RollCheckDefinition>();
    for (const def of catalog) {
      const key = (def.ability ?? def.id.replace('ability:', '')).toUpperCase();
      if (!byAbility.has(key)) byAbility.set(key, def);
    }
    return byAbility;
  }, [adapter, character]);

  return (
    <Card className="space-y-3">
      <div className="flex items-baseline gap-2 flex-wrap">
        <h2 id={`${characterSheetSectionId('abilities')}-heading`} className="card-kicker mb-0">Ability scores</h2>
        <span className="text-[11px] text-secondary cf-print-hide">tap a score to roll a check</span>
      </div>
      <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(84px, 1fr))' }}>
        {abilityFields.map(({ key, label }) => {
          const score = abilityScore(character, key);
          const def = abilityChecks.get(key.toUpperCase()) ?? null;
          const mod = def ? def.modifier : score === null ? null : adapter.abilityModifier(score);
          const body = (
            <>
              <p className="text-[length:var(--type-label)] tracking-wide text-secondary">{label}</p>
              <p className="text-xl font-heading my-0.5">{score ?? '—'}</p>
              <p className="text-[length:var(--type-meta)]" style={{ color: 'var(--color-accent-300)' }}>
                {mod === null ? '—' : signed(mod)}
              </p>
            </>
          );
          if (!def) {
            return (
              <div key={key} className="cf-inset text-center py-2.5 px-1.5">
                {body}
              </div>
            );
          }
          const breakdownStr = formatCheckBreakdown(def);
          return (
            <div key={key} className="cf-inset text-center py-2.5 px-1.5">
              <RollContextMenu
                className="w-full h-full block"
                onRoll={(m) =>
                  void roller.rollCheck(
                    character.id,
                    def.id,
                    toCheckRollMode(resolveRollMode(m, { shiftKey: m === 'advantage', altKey: m === 'disadvantage', ctrlKey: false, metaKey: false })),
                  )
                }
                disabled={roller.rolling}
                style={{ background: 'transparent', border: 0, padding: 0, font: 'inherit', color: 'inherit', cursor: roller.rolling ? 'default' : 'pointer' }}
                title={`Roll ${label} check (${signed(def.modifier)}) [${breakdownStr}]`}
                aria-label={`Roll ${label} check (${signed(def.modifier)})`}
              >
                {body}
              </RollContextMenu>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/**
 * The design template's left vitals rail. Everything a player reaches for mid-turn —
 * HP + temp HP, death saves, the defenses/initiative/speed/proficiency block, conditions
 * and rests — in one column that stays put while the centre pane switches between Play
 * and Build.
 *
 * The HP and Conditions sections keep their `character-section-*` ids and `<h2>` text so
 * `?focus=hp` / `?focus=conditions` deep links and the sheet's heading outline are
 * unchanged by the move out of the Play tabpanel.
 */
function CharacterVitalsRail({
  character,
  adapter,
  canEdit,
  onChange,
  onError,
  roller,
  leveledConditionTrack,
  defenseLabel,
  defenseTitle,
}: {
  character: Character;
  adapter: RuleSystemAdapter;
  canEdit: boolean;
  onChange: () => void;
  onError: (msg: string | null) => void;
  roller: Roller;
  leveledConditionTrack: LeveledConditionTrack | null | undefined;
  defenseLabel: string;
  defenseTitle: string;
}) {
  const initiative = useMemo(
    () => checkCatalogForAdapter(adapter, character).find((c) => c.category === 'initiative') ?? null,
    [adapter, character],
  );
  // Only a system that actually models death saves gets the tracker; PF2e (dying/wounded)
  // and the neutral adapters simply show "down" via HP 0 (see hasDeathSavesForAdapter).
  const showDeathSaves =
    hasDeathSavesForAdapter(adapter) &&
    (character.deathState !== 'none' || (character.hpMax > 0 && character.hpCurrent <= 0));

  return (
    <div
      className="cf-sheet-rail min-w-0 space-y-4 xl:sticky xl:max-h-[calc(100vh-var(--app-header-h,0px)-5rem)] xl:overflow-y-auto xl:overscroll-contain"
      style={{ top: 'calc(var(--app-header-h, 0px) + 4rem)' }}
      data-testid="character-vitals-rail"
    >
      <section
        id={characterSheetSectionId('hp')}
        aria-labelledby={`${characterSheetSectionId('hp')}-heading`}
        className="cf-sheet-section"
      >
        <Card className="space-y-3">
          <div className="flex items-baseline gap-2.5 flex-wrap justify-between">
            <h2 id={`${characterSheetSectionId('hp')}-heading`} className="card-kicker mb-0">Hit points &amp; Defenses</h2>
          </div>
          <div className="flex items-center gap-3.5 flex-wrap">
            <span className="font-heading text-[34px] leading-none">
              {character.hpMax > 0 ? (
                <>
                  {character.hpCurrent}
                  <span className="text-base text-secondary"> / {character.hpMax} HP</span>
                  {character.hpTemp > 0 && (
                    <span className="text-base" style={{ color: 'var(--color-accent-300)' }}> +{character.hpTemp}</span>
                  )}
                </>
              ) : (
                <span className="text-base text-secondary">HP not set</span>
              )}
            </span>
            {character.hpMax > 0 && (
              <div className="flex-1 min-w-[120px]">
                <HpBar current={character.hpCurrent} max={character.hpMax} />
              </div>
            )}
          </div>
          {(character.spMax > 0 || character.rpMax > 0) && (
            <div className="space-y-2 pt-2 border-t border-slate-800">
              {character.spMax > 0 && (
                <div className="space-y-1">
                  <div className="flex justify-between text-xs text-slate-400 font-medium">
                    <span>Stamina Points (SP)</span>
                    <span className="text-white">{character.spCurrent} / {character.spMax}</span>
                  </div>
                  <HpBar current={character.spCurrent} max={character.spMax} />
                </div>
              )}
              {character.rpMax > 0 && (
                <div className="flex items-center justify-between text-xs text-slate-400 font-medium">
                  <span>Resolve Points (RP)</span>
                  <span className="text-white font-semibold">{character.rpCurrent} / {character.rpMax}</span>
                </div>
              )}
            </div>
          )}
          {canEdit && (
            <div className="space-y-2 cf-print-hide">
              <HpEditor character={character} onChange={onChange} onError={onError} />
              <TempHpControl character={character} onChange={onChange} onError={onError} />
              <RestControls character={character} onChange={onChange} onError={onError} adapter={adapter} />
            </div>
          )}
          {showDeathSaves && (
            <DeathSavesPanel character={character} canEdit={canEdit} onChange={onChange} onError={onError} />
          )}
        </Card>
      </section>

      <VitalsBlock
        character={character}
        adapter={adapter}
        roller={roller}
        initiative={initiative}
        defenseLabel={defenseLabel}
        defenseTitle={defenseTitle}
      />

      <section
        id={characterSheetSectionId('conditions')}
        aria-labelledby={`${characterSheetSectionId('conditions')}-heading`}
        className="cf-sheet-section"
      >
        <Card className="space-y-2.5">
          <h2 id={`${characterSheetSectionId('conditions')}-heading`} className="card-kicker mb-0">Conditions</h2>
          {leveledConditionTrack && (
            <ConditionLevelRow
              character={character}
              canEdit={canEdit}
              onChange={onChange}
              onError={onError}
              track={leveledConditionTrack}
            />
          )}
          <ConditionsRow
            character={character}
            canEdit={canEdit}
            onChange={onChange}
            onError={onError}
            adapter={adapter}
            excludeName={leveledConditionTrack?.name}
          />
        </Card>
      </section>
    </div>
  );
}

/**
 * The template's 2×2 vitals tiles: defense, initiative, speed, proficiency. Initiative is
 * a catalog check like any other, so it rolls from here through the same server-resolved
 * path Skills/Saves use; the rest are read-only readouts of sheet fields (edited in
 * "Edit sheet"). Starfinder's EAC/KAC pair replaces the single defense tile when set.
 */
function VitalsBlock({
  character,
  adapter,
  roller,
  initiative,
  defenseLabel,
  defenseTitle,
}: {
  character: Character;
  adapter: RuleSystemAdapter;
  roller: Roller;
  initiative: RollCheckDefinition | null;
  defenseLabel: string;
  defenseTitle: string;
}) {
  const splitDefense = character.eac != null || character.kac != null;
  const tile = 'cf-inset text-center py-2 px-1.5';
  const tileLabel = 'text-[length:var(--type-label)] tracking-wide text-secondary';
  const tileValue = 'text-[17px] font-heading mt-0.5';
  return (
    <Card className="space-y-2.5" data-testid="character-vitals">
      <span className="card-kicker mb-0">Vitals</span>
      <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(84px, 1fr))' }}>
        {splitDefense ? (
          <>
            <div className={tile}>
              <p className={tileLabel}>EAC</p>
              <p className={tileValue}>{character.eac ?? '—'}</p>
            </div>
            <div className={tile}>
              <p className={tileLabel}>KAC</p>
              <p className={tileValue}>{character.kac ?? '—'}</p>
            </div>
          </>
        ) : (
          <div className={tile} title={defenseTitle}>
            <p className={tileLabel}>{defenseLabel}</p>
            <p className={tileValue}>{character.ac ?? '—'}</p>
          </div>
        )}
        {initiative ? (
          <div className={tile}>
            <RollContextMenu
              className="w-full h-full block"
              onRoll={(m) =>
                void roller.rollCheck(
                  character.id,
                  initiative.id,
                  toCheckRollMode(resolveRollMode(m, { shiftKey: m === 'advantage', altKey: m === 'disadvantage', ctrlKey: false, metaKey: false })),
                )
              }
              disabled={roller.rolling}
              style={{ background: 'transparent', border: 0, padding: 0, font: 'inherit', color: 'inherit', cursor: roller.rolling ? 'default' : 'pointer' }}
              title={`Roll initiative (${signed(initiative.modifier)}) [${formatCheckBreakdown(initiative)}]`}
              aria-label={`Roll initiative (${signed(initiative.modifier)})`}
            >
              <p className={tileLabel}>Initiative</p>
              <p className={tileValue}>{signed(initiative.modifier)}</p>
            </RollContextMenu>
          </div>
        ) : (
          <div className={tile}>
            <p className={tileLabel}>Initiative</p>
            <p className={tileValue}>—</p>
          </div>
        )}
        <div className={tile}>
          <p className={tileLabel}>Speed</p>
          <p className={tileValue}>{character.speed ?? '—'}</p>
        </div>
        <div className={tile}>
          <p className={tileLabel}>Proficiency</p>
          <p className={tileValue}>{signed(profBonus(character.level))}</p>
        </div>
      </div>
      <p className="text-[11px] text-secondary cf-print-hide">
        {adapter.presentation?.defense.full ?? 'Defense'} and speed are set in Edit sheet.
      </p>
    </Card>
  );
}

/**
 * Temp HP stepper (design template's "Temp HP − n +" row). `hpTemp` is a plain sheet
 * field, so this PATCHes the character rather than going through POST /hp — that endpoint
 * moves real hit points, and temporary hit points are a separate pool the damage path
 * spends first.
 */
function TempHpControl({
  character,
  onChange,
  onError,
}: {
  character: Character;
  onChange: () => void;
  onError: (msg: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const announce = useAnnounce();

  async function set(next: number) {
    if (busy || next === character.hpTemp || next < 0) return;
    setBusy(true);
    onError(null);
    try {
      await api.patch(`${API}/characters/${character.id}`, { hpTemp: next });
      onChange();
      announce(`${character.name} temporary hit points ${next}`);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Couldn't update temporary hit points.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2 cf-print-hide" role="group" aria-label={`${character.name} temporary hit points`} data-testid="character-temp-hp">
      <span className="flex-1 text-[length:var(--type-label)] text-secondary">Temp HP</span>
      <Btn
        density="xs"
        ghost
        style={{ minWidth: 44, minHeight: 44 }}
        disabled={busy || character.hpTemp <= 0}
        aria-label={`Remove 1 temporary hit point from ${character.name}`}
        onClick={() => void set(character.hpTemp - 1)}
      >
        −
      </Btn>
      <span className="min-w-[2.5rem] text-center font-heading text-[15px]" data-testid="character-temp-hp-value">
        {character.hpTemp}
      </span>
      <Btn
        density="xs"
        ghost
        style={{ minWidth: 44, minHeight: 44 }}
        disabled={busy}
        aria-label={`Add 1 temporary hit point to ${character.name}`}
        onClick={() => void set(character.hpTemp + 1)}
      >
        +
      </Btn>
    </div>
  );
}

/**
 * Death saves on the sheet (design template's "Death saves — you are dying" panel).
 * Reuses the encounter tracker so the pips look and announce identically in both places.
 *
 * `canRoll` is deliberately false here: the only authoritative death-save roll in the
 * product is POST /encounters/:id/combatants/:cid/death-save, where the SERVER rolls the
 * d20 and applies the same face to the 5e lifecycle. Rolling one from the sheet would
 * have to decide the outcome client-side, so the panel tracks and edits the counters and
 * points at the encounter for the roll itself.
 */
function DeathSavesPanel({
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
  const announce = useAnnounce();

  async function patch(body: { deathSaveSuccesses?: number; deathSaveFailures?: number }) {
    if (busy) return;
    setBusy(true);
    onError(null);
    try {
      await api.patch(`${API}/characters/${character.id}`, body);
      onChange();
      announce(`${character.name} death saves updated`);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Couldn't update death saves.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cf-inset px-3 py-2 space-y-1" data-testid="character-death-saves">
      <p className="text-[length:var(--type-label)] tracking-wide" style={{ color: 'var(--color-danger, #e5484d)' }}>
        {character.deathState === 'dead'
          ? 'Dead'
          : character.deathState === 'stable'
            ? 'Stable at 0 HP'
            : 'Death saves — you are dying'}
      </p>
      <DeathSaveTracker
        successes={character.deathSaveSuccesses}
        failures={character.deathSaveFailures}
        canEditPermission={canEdit}
        canRoll={false}
        busy={busy}
        syncBlocked={false}
        onSet={(next) => void patch(next)}
        onRoll={() => undefined}
      />
      <p className="text-[11px] text-secondary">The d20 itself is rolled in the encounter, where the server applies it.</p>
    </div>
  );
}

function SavingThrowsCard({ character, canEdit, onChange, onError, adapter, roller }: SheetCardProps & { adapter: RuleSystemAdapter; roller: Roller }) {
  const [busy, setBusy] = useState(false);
  const announce = useAnnounce();
  const [mode, setMode] = useState<RollMode>('normal');
  const pb = profBonus(character.level);
  const profs = new Set<string>(character.saveProficiencies);

  const catalog = useMemo(() => sortCheckCatalog(checkCatalogForAdapter(adapter, character)), [adapter, character]);
  const saves = useMemo(() => catalog.filter((c) => c.category === 'save'), [catalog]);

  async function toggle(k: Ability) {
    if (!canEdit || busy) return;
    setBusy(true);
    onError(null);
    try {
      const removing = profs.has(k);
      const next = removing
        ? character.saveProficiencies.filter((a) => a !== k)
        : [...character.saveProficiencies, k];
      await api.patch(`${API}/characters/${character.id}`, { saveProficiencies: next });
      onChange();
      announce(`${abilityLabelForAdapter(adapter, k)} save proficiency ${removing ? 'cleared' : 'gained'}`);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Couldn't update saving throws.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-2" data-testid="character-saving-throws">
      <div className="flex items-center gap-2 flex-wrap">
        <h2 id={`${characterSheetSectionId('saves')}-heading`} className="card-kicker mb-0">Saving throws</h2>
        <span className="text-[11px] text-secondary">proficiency {signed(pb)}</span>
        <span className="ml-auto cf-roll-mode-status cf-print-hide" role="status" aria-live="polite" style={{ fontSize: 11, color: 'var(--color-accent-300)' }}>
          {rollModeSummary(mode)}
        </span>
      </div>
      <div className="cf-print-hide">
        <RollModeChooser
          value={mode}
          onChange={setMode}
          disabled={roller.rolling}
          aria-label="Saving throw roll mode"
        />
      </div>
      <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(84px, 1fr))' }}>
        {saves.map((def) => {
          const k = (def.ability ?? def.id.replace('save:', '')) as Ability;
          const proficient = def.favorite || (def.proficiency != null && def.proficiency !== 'untrained') || profs.has(k);
          const mod = def.modifier;
          const breakdownStr = formatCheckBreakdown(def);
          return (
            <div key={def.id} className="cf-inset text-center py-2 px-1.5 relative">
              <RollContextMenu
                className="w-full h-full block"
                onRoll={(m) => void roller.rollCheck(character.id, def.id, toCheckRollMode(resolveRollMode(m, { shiftKey: m === 'advantage', altKey: m === 'disadvantage', ctrlKey: false, metaKey: false })))}
                disabled={roller.rolling}
                style={{ background: 'transparent', border: 0, padding: 0, font: 'inherit', color: 'inherit', cursor: roller.rolling ? 'default' : 'pointer' }}
                title={`Roll ${k ? `${k.toUpperCase()} ` : ''}save (${signed(mod)}) [${breakdownStr}]`}
                aria-label={`Roll ${k ? `${k.toUpperCase()} ` : ''}save (${signed(mod)})`}
              >
                <p className="text-[10px] tracking-wide text-secondary">{k || def.label}</p>
                <p className="text-[15px] mt-0.5 font-semibold">{signed(mod)}</p>
              </RollContextMenu>
              {canEdit ? (
                <>
                  <button
                    type="button"
                    onClick={() => void toggle(k)}
                    disabled={busy}
                    aria-pressed={proficient}
                    aria-label={saveProficiencyLabel(k, proficient)}
                    className="cf-target-44 absolute top-0.5 right-0.5 cf-print-hide"
                    style={{ background: 'transparent', border: 0, padding: 0, lineHeight: 1, fontSize: 10, cursor: busy ? 'default' : 'pointer', color: proficient ? 'var(--color-accent-300)' : 'var(--color-text-disabled)' }}
                    title={proficient ? `Remove ${k} save proficiency` : `Add ${k} save proficiency`}
                  >
                    <span aria-hidden="true">{proficient ? '●' : '○'}</span>
                  </button>
                  {proficient && (
                    <span className="cf-print-only absolute top-1 right-1" aria-hidden style={{ fontSize: 10, color: 'var(--color-accent-300)' }}>
                      ●
                    </span>
                  )}
                </>
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
      <p className="text-[11px] text-secondary">
        Tap a save to roll a d20{canEdit ? <span className="cf-print-hide">; tap the ● to toggle proficiency</span> : ''}.
      </p>
    </Card>
  );
}

function SkillsCard({ character, canEdit, onChange, onError, adapter, roller }: SheetCardProps & { adapter: RuleSystemAdapter; roller: Roller }) {
  const [busy, setBusy] = useState(false);
  const announce = useAnnounce();

  const catalog = useMemo(() => sortCheckCatalog(checkCatalogForAdapter(adapter, character)), [adapter, character]);
  const skillChecks = useMemo(() => catalog.filter((c) => c.category === 'skill'), [catalog]);

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
      const nextRank = next[name];
      await api.patch(`${API}/characters/${character.id}`, { skills: next });
      onChange();
      announce(`${name} proficiency ${nextRank === undefined ? 'removed' : skillRankLabel(nextRank)}`);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Couldn't update skills.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-2" data-testid="character-skills">
      <div className="flex items-center gap-2 flex-wrap">
        <h2 id={`${characterSheetSectionId('skills')}-heading`} className="card-kicker mb-0">Skills</h2>
        <span className="text-[11px] text-secondary">
          tap a skill to roll{canEdit ? <span className="cf-print-hide">; tap the ○/●/★ to cycle proficiency</span> : ''}
        </span>
      </div>
      <div className="grid gap-x-4 gap-y-0.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
        {skillChecks.map((def) => {
          const name = def.label;
          const ability = def.ability;
          const rank = character.skills[name] ?? (def.proficiency as SkillRank | null);
          const mod = def.modifier;
          const breakdownStr = formatCheckBreakdown(def);
          const isProf = rank != null && rank !== ('untrained' as any);
          const marker = rank === 'expertise' ? '★' : isProf ? '●' : '○';
          return (
            <div key={def.id} className="flex items-center gap-1.5 text-[13px] min-h-11">
              {canEdit ? (
                <>
                  <button
                    type="button"
                    onClick={() => void cycle(name)}
                    disabled={busy}
                    aria-label={skillProficiencyLabel(name, (character.skills[name] as SkillProficiencyRank) ?? (rank as SkillProficiencyRank) ?? 'none')}
                    aria-pressed={isProf}
                    className="cf-target-44 shrink-0 text-center cf-print-hide"
                    style={{ background: 'transparent', border: 0, padding: 0, font: 'inherit', cursor: busy ? 'default' : 'pointer', color: isProf ? 'var(--color-accent-300)' : 'var(--color-text-disabled)' }}
                    title={rank === undefined ? `Mark ${name} proficient` : rank === 'proficient' ? `Mark ${name} expertise` : `Clear ${name} proficiency`}
                  >
                    <span aria-hidden="true">{marker}</span>
                  </button>
                  <span
                    className="w-4 shrink-0 text-center cf-print-only"
                    style={{ color: isProf ? 'var(--color-accent-300)' : 'var(--color-text-disabled)' }}
                    aria-hidden
                  >
                    {marker}
                  </span>
                </>
              ) : (
                <span
                  className="w-4 shrink-0 text-center"
                  style={{ color: isProf ? 'var(--color-accent-300)' : 'var(--color-text-disabled)' }}
                  aria-hidden
                >
                  {marker}
                </span>
              )}
              <RollContextMenu
                className="flex-1 flex items-center gap-1.5 min-w-0"
                onRoll={(m) => void roller.rollCheck(character.id, def.id, toCheckRollMode(resolveRollMode(m, { shiftKey: m === 'advantage', altKey: m === 'disadvantage', ctrlKey: false, metaKey: false })))}
                disabled={roller.rolling}
                style={{ background: 'transparent', border: 0, padding: 0, font: 'inherit', color: 'inherit', cursor: roller.rolling ? 'default' : 'pointer' }}
                title={`Roll ${name} (${signed(mod)}) [${breakdownStr}]`}
                aria-label={`Roll ${name} (${signed(mod)})`}
              >
                <span className="flex-1 text-left truncate">{name}</span>
                {ability && <span className="text-[10px] text-secondary">{ability}</span>}
                <span className="w-8 text-right font-semibold">{signed(mod)}</span>
              </RollContextMenu>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function ActionsCard({
  character,
  canEdit,
  onChange,
  onError,
  roller,
  packItems,
  onShowInventory,
}: SheetCardProps & { roller: Roller; packItems: InventoryItem[]; onShowInventory: () => void }) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  // Which row's details disclosure is open (design template's "Details ▾ / Hide ▴").
  // A sheet action is keyed by index, an equipped-gear action by `item:<id>`.
  const [openDetails, setOpenDetails] = useState<string | null>(null);
  // Every pack item that authored an action, equipped or not: an unequipped one still
  // renders, locked, so "why can't I use this?" is answerable without leaving the tab —
  // the same reason the encounter only merges the EQUIPPED ones into a turn's options.
  const grantedActions = useMemo(
    () => packItems.filter((item) => item.equippedAction != null),
    [packItems],
  );
  const [busy, setBusy] = useState(false);
  const announce = useAnnounce();
  const [name, setName] = useState('');
  const [kind, setKind] = useState('');
  const [toHit, setToHit] = useState('');
  const [damage, setDamage] = useState('');
  const [targetAc, setTargetAc] = useState('');
  const [notes, setNotes] = useState('');
  // Roll-mode chooser (issue #713): the attack "to hit" roll mode. Applies to
  // every action's attack roll in this card; a shift/alt-click still overrides
  // once (resolveRollMode) so the desktop shortcut keeps working.
  const [mode, setMode] = useState<RollMode>('normal');
  // In-place edit (issue #718): editingIndex is the position in character.actions
  // being edited, or null when not editing an existing row. The row collapses into
  // the same form Add uses, so order is preserved by writing back to the same index.
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

  async function saveActions(next: CharacterAction[], failMsg: string, successMsg?: string) {
    if (busy) return;
    setBusy(true);
    onError(null);
    try {
      await api.patch(`${API}/characters/${character.id}`, { actions: next });
      onChange();
      if (successMsg) announce(successMsg);
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
    setTargetAc('');
    setNotes('');
    setEditingIndex(null);
  }

  async function add() {
    if (!name.trim()) return;
    const inferredSpec = inferActionSpecFromText(toHit.trim(), damage.trim(), kind.trim());
    const action: CharacterAction = {
      name: name.trim(),
      kind: kind.trim(),
      toHit: toHit.trim(),
      damage: damage.trim(),
      targetAc: targetAc.trim(),
      notes: notes.trim(),
      ...(inferredSpec ? { spec: inferredSpec } : {}),
    };
    const ok = await saveActions([...character.actions, action], "Couldn't add the action.", `Added action ${action.name}`);
    if (ok) {
      resetForm();
      setAdding(false);
    }
  }

  async function saveEdit() {
    if (editingIndex == null || !name.trim()) return;
    const existingAction = character.actions[editingIndex];
    const nextToHit = toHit.trim();
    const nextDamage = damage.trim();
    const nextKind = kind.trim();

    let nextSpec: ActionSpec | undefined = existingAction?.spec;

    if (!existingAction?.spec) {
      nextSpec = inferActionSpecFromText(nextToHit, nextDamage, nextKind);
    } else if (existingAction.spec.provenance?.source === 'sheet-inferred') {
      const toHitChanged = nextToHit !== (existingAction.toHit ?? '');
      const damageChanged = nextDamage !== (existingAction.damage ?? '');
      const kindChanged = nextKind !== (existingAction.kind ?? '');
      if (toHitChanged || damageChanged || kindChanged) {
        nextSpec = inferActionSpecFromText(nextToHit, nextDamage, nextKind);
      }
    } else {
      nextSpec = existingAction.spec;
    }

    const action: CharacterAction = {
      ...existingAction,
      name: name.trim(),
      kind: nextKind,
      toHit: nextToHit,
      damage: nextDamage,
      targetAc: targetAc.trim(),
      notes: notes.trim(),
      spec: nextSpec,
    };
    const next = character.actions.map((a, i) => (i === editingIndex ? action : a));
    const ok = await saveActions(next, "Couldn't save the action.", `Updated action ${action.name}`);
    if (ok) resetForm();
  }

  function startEdit(index: number) {
    const a = character.actions[index];
    if (!a) return;
    setName(a.name);
    setKind(a.kind);
    setToHit(a.toHit);
    setDamage(a.damage);
    setTargetAc(a.targetAc ?? '');
    setNotes(a.notes);
    setEditingIndex(index);
    setAdding(false);
  }

  function remove(index: number) {
    const action = character.actions[index];
    void saveActions(
      character.actions.filter((_, i) => i !== index),
      "Couldn't remove the action.",
      action ? `Removed action ${action.name}` : undefined,
    );
  }

  // Only surface the chooser when at least one action carries a "to hit" roll —
  // a list of feature-only actions has nothing to take with advantage.
  const hasAttackRoll = character.actions.some((a) => a.toHit && toHitExpr(a.toHit, 'flat'));

  return (
    <Card className="space-y-2.5">
      <div className="flex items-center gap-2 flex-wrap">
        <h2 id={`${characterSheetSectionId('actions')}-heading`} className="card-kicker mb-0">Actions</h2>
        {hasAttackRoll && (
          <span className="cf-roll-mode-status cf-print-hide" role="status" aria-live="polite" style={{ fontSize: 11, color: 'var(--color-accent-300)' }}>
            {rollModeSummary(mode)}
          </span>
        )}
        {canEdit && !adding && editingIndex == null && (
          <Btn density="xs" ghost className="text-xs ml-auto cf-print-hide" onClick={() => { resetForm(); setAdding(true); }}>
            + Add
          </Btn>
        )}
      </div>
      {hasAttackRoll && (
        <div className="cf-print-hide">
          <RollModeChooser
            value={mode}
            onChange={setMode}
            disabled={roller.rolling}
            aria-label="Attack roll mode"
          />
        </div>
      )}
      {/* "No actions yet" would be a lie once gear grants some — the "From your gear"
          group below is still a list of actions, authored on the items instead of here. */}
      {character.actions.length === 0 && !adding && grantedActions.length === 0 && (
        <p className="text-xs text-secondary">
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
              targetAc={targetAc}
              notes={notes}
              setName={setName}
              setKind={setKind}
              setToHit={setToHit}
              setDamage={setDamage}
              setTargetAc={setTargetAc}
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
        const isResolvable = action.spec != null && isResolvableSpec(action.spec);
        const detailsKey = `action-${i}`;
        return (
          <div key={`${action.name}-${i}`} className="cf-inset px-3 py-2 flex items-start gap-2.5 flex-wrap">
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-semibold flex items-center gap-1.5 flex-wrap">
                {action.name}
                {action.kind && (
                  <span className="tag tag-neutral">
                    {action.kind}
                  </span>
                )}
                {action.targetAc && (
                  <span className="tag tag-neutral text-[10px]" title="Target Armor Class">
                    vs {action.targetAc}
                  </span>
                )}
                {isResolvable ? (
                  <span className="tag tag-neutral text-[10px]" data-testid="action-one-tap-badge">
                    {t('characters.actions.oneTapReady')}
                  </span>
                ) : (
                  <span className="text-[10px] text-slate-400" data-testid="action-text-only-hint">
                    {t('characters.actions.textOnly')}
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
                        onClick={(m) => {
                          const resolvedMode = resolveRollMode(m, { shiftKey: m === 'advantage', altKey: m === 'disadvantage', ctrlKey: false, metaKey: false });
                          void roller.roll(toHitExpr(action.toHit, resolvedMode === 'advantage' ? 'adv' : resolvedMode === 'disadvantage' ? 'dis' : 'flat')! , `${character.name} · ${action.name} to hit${resolvedMode !== 'normal' ? ` (${resolvedMode})` : ''}`);
                        }}
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
                        onClick={(m) => void roller.roll(m === 'crit' ? critDamageExpr(dmgExpr) || dmgExpr : dmgExpr, `${character.name} · ${action.name} damage${m !== 'normal' ? ` (${m})` : ''}`)}
                      />
                    ) : (
                      <span className="text-xs text-slate-400" title="Flat or unparseable damage — no dice to roll">
                        {action.damage} (flat)
                      </span>
                    ))}
                </div>
              )}
              {action.notes && <p className="text-[11px] text-secondary mt-0.5">{action.notes}</p>}
              <ActionDetails
                action={action}
                open={openDetails === detailsKey}
                onToggle={() => setOpenDetails((prev) => (prev === detailsKey ? null : detailsKey))}
              />
            </div>
            {canEdit && (
              <div className="flex items-center gap-1 shrink-0 cf-print-hide">
                <button
                  type="button"
                  className="cf-target-44"
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
                  className="cf-target-44"
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
                  <UIIcon name="close" size="xs" />
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
          targetAc={targetAc}
          notes={notes}
          setName={setName}
          setKind={setKind}
          setToHit={setToHit}
          setDamage={setDamage}
          setTargetAc={setTargetAc}
          setNotes={setNotes}
          onCancel={() => { resetForm(); setAdding(false); }}
          onSave={add}
          saveLabel="Add action"
          autoFocusName
        />
      )}

      {grantedActions.length > 0 && (
        <div className="space-y-2.5 pt-1" data-testid="character-granted-actions">
          <p className="card-kicker mb-0">From your gear</p>
          {grantedActions.map((item) => {
            const granted = item.equippedAction!;
            const detailsKey = `item-${item.id}`;
            const attackExpr = granted.toHit ? toHitExpr(granted.toHit, 'flat') : null;
            const dmgExpr = granted.damage ? damageExpr(granted.damage) : null;
            return (
              <div key={detailsKey} className="cf-inset px-3 py-2 flex items-start gap-2.5 flex-wrap">
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-semibold flex items-center gap-1.5 flex-wrap">
                    {granted.name}
                    {granted.kind && <span className="tag tag-neutral">{granted.kind}</span>}
                  </p>
                  <button
                    type="button"
                    className="tag tag-accent text-[10px] mt-1 cf-print-hide"
                    onClick={onShowInventory}
                    style={{ cursor: 'pointer', border: 0, font: 'inherit', minHeight: 32 }}
                    title={`Show ${item.name} in this character's inventory`}
                  >
                    <GameIcon slug="backpack" size={UI_ICON_SIZE.xs} className="inline align-text-bottom mr-1" />
                    {item.name} →
                  </button>
                  {item.equipped ? (
                    (granted.toHit || granted.damage) && (
                      <div className="flex gap-2 flex-wrap items-center mt-1">
                        {attackExpr && (
                          <RollChip
                            label={`to hit ${granted.toHit}`}
                            title={`Roll ${granted.name} attack (${attackExpr})`}
                            disabled={roller.rolling}
                            onClick={(m) => {
                              const resolved = resolveRollMode(m, { shiftKey: m === 'advantage', altKey: m === 'disadvantage', ctrlKey: false, metaKey: false });
                              void roller.roll(
                                toHitExpr(granted.toHit, resolved === 'advantage' ? 'adv' : resolved === 'disadvantage' ? 'dis' : 'flat')!,
                                `${character.name} · ${granted.name} to hit${resolved !== 'normal' ? ` (${resolved})` : ''}`,
                              );
                            }}
                          />
                        )}
                        {dmgExpr && (
                          <RollChip
                            label={granted.damage}
                            title={`Roll ${granted.name} damage (${dmgExpr})`}
                            disabled={roller.rolling}
                            onClick={(m) => void roller.roll(m === 'crit' ? critDamageExpr(dmgExpr) || dmgExpr : dmgExpr, `${character.name} · ${granted.name} damage${m !== 'normal' ? ` (${m})` : ''}`)}
                          />
                        )}
                      </div>
                    )
                  ) : (
                    <p className="text-[11px] text-secondary mt-1">
                      🔒 {t('inventory.equip.equipToUse', { name: item.name })}
                    </p>
                  )}
                  {granted.notes && <p className="text-[11px] text-secondary mt-0.5">{granted.notes}</p>}
                  <ActionDetails
                    action={granted}
                    open={openDetails === detailsKey}
                    onToggle={() => setOpenDetails((prev) => (prev === detailsKey ? null : detailsKey))}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

/**
 * The design template's per-action disclosure: the facts, effects and citation the
 * structured `spec` carries, hidden until asked for so the Actions list stays scannable.
 * Renders nothing at all for a text-only action — no empty toggle to nowhere.
 */
function ActionDetails({
  action,
  open,
  onToggle,
}: {
  action: CharacterAction;
  open: boolean;
  onToggle: () => void;
}) {
  const facts = useMemo(() => actionSpecFacts(action.spec), [action.spec]);
  const effects = useMemo(() => actionSpecEffects(action.spec), [action.spec]);
  const source = actionSourceText(action.spec);
  if (facts.length === 0 && effects.length === 0 && !source) return null;
  return (
    <div className="mt-1.5">
      <button
        type="button"
        className="btn btn-ghost btn-xs text-[11px] cf-print-hide"
        aria-expanded={open}
        onClick={onToggle}
        style={{ minHeight: 32 }}
      >
        {open ? 'Hide details' : 'Details'}
      </button>
      {open && (
        <div className="mt-2 pt-2 border-t border-slate-800 space-y-2">
          {facts.length > 0 && (
            <div className="grid gap-1.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))' }}>
              {facts.map((fact) => (
                <div key={fact.label}>
                  <p className="text-[length:var(--type-label)] tracking-wide text-secondary">{fact.label}</p>
                  <p className="text-[11px]">{fact.value}</p>
                </div>
              ))}
            </div>
          )}
          {effects.length > 0 && (
            <div>
              <p className="text-[length:var(--type-label)] tracking-wide text-secondary">Effects</p>
              <ul className="text-[11px] space-y-0.5 mt-0.5">
                {effects.map((line) => (
                  <li key={line}>· {line}</li>
                ))}
              </ul>
            </div>
          )}
          {source && <p className="text-[10px] text-muted">{source}</p>}
        </div>
      )}
    </div>
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
  targetAc: _targetAc,
  notes,
  setName,
  setKind,
  setToHit,
  setDamage,
  setTargetAc: _setTargetAc,
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
  targetAc: string;
  notes: string;
  setName: (v: string) => void;
  setKind: (v: string) => void;
  setToHit: (v: string) => void;
  setDamage: (v: string) => void;
  setTargetAc: (v: string) => void;
  setNotes: (v: string) => void;
  onCancel: () => void;
  onSave: () => void;
  saveLabel: string;
  autoFocusName?: boolean;
}) {
  const preview = rollPreview(toHit, damage);
  const cardLabel = 'text-[10px] text-slate-300 font-bold uppercase tracking-wide';
  const toHitError =
    toHit.trim() !== '' && preview.hit == null
      ? 'No rollable dice recognized in this expression.'
      : null;
  return (
    <div className="cf-inset px-3 py-2.5 space-y-2" data-testid="character-action-edit">
      <div className="grid grid-cols-2 gap-2.5">
        <Field
          idPrefix={CHARACTER_ACTION_PREFIX}
          name={CHARACTER_ACTION_FIELD.name}
          label={CHARACTER_ACTION_NAME_LABEL}
          labelClassName={cardLabel}
          autoFocus={autoFocusName}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Longsword, Fire Bolt…"
          required
        />
        <Field
          idPrefix={CHARACTER_ACTION_PREFIX}
          name={CHARACTER_ACTION_FIELD.kind}
          label={CHARACTER_ACTION_KIND_LABEL}
          labelClassName={cardLabel}
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          placeholder="melee, ranged, spell…"
          optional
        />
      </div>
      <div className="grid grid-cols-2 gap-2.5">
        <Field
          idPrefix={CHARACTER_ACTION_PREFIX}
          name={CHARACTER_ACTION_FIELD.toHit}
          label={CHARACTER_ACTION_TO_HIT_LABEL}
          labelClassName={cardLabel}
          value={toHit}
          onChange={(e) => setToHit(e.target.value)}
          placeholder="+5 or 1d20+5"
          help={CHARACTER_ACTION_TO_HIT_HELP}
          error={toHitError}
          optional
        />
        <Field
          idPrefix={CHARACTER_ACTION_PREFIX}
          name={CHARACTER_ACTION_FIELD.damage}
          label={CHARACTER_ACTION_DAMAGE_LABEL}
          labelClassName={cardLabel}
          value={damage}
          onChange={(e) => setDamage(e.target.value)}
          placeholder="1d8+3 slashing, 5 fire"
          help={CHARACTER_ACTION_DAMAGE_HELP}
          optional
        />
      </div>
      <Field
        idPrefix={CHARACTER_ACTION_PREFIX}
        name={CHARACTER_ACTION_FIELD.notes}
        label={CHARACTER_ACTION_NOTES_LABEL}
        labelClassName={cardLabel}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="versatile, 60 ft range…"
        optional
      />
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
        <Btn density="xs" ghost className="text-xs" onClick={onCancel} disabled={busy}>
          Cancel
        </Btn>
        <Btn density="xs" className="text-xs" onClick={onSave} disabled={busy || !name.trim()}>
          {busy ? 'Saving…' : saveLabel}
        </Btn>
      </div>
    </div>
  );
}

function SpellSlotsCard({ character, canEdit, onChange, onError }: SheetCardProps) {
  const [busy, setBusy] = useState(false);
  const announce = useAnnounce();
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
      announce(`Level ${level} spell slot ${delta > 0 ? 'used' : 'restored'}`);
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
      announce('Spell slots updated');
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Couldn't save spell slots.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-2.5">
      <div className="flex items-center gap-2">
        <h2 id={`${characterSheetSectionId('slots')}-heading`} className="card-kicker mb-0">Spell slots</h2>
        {canEdit && !editing && (
          <Btn density="xs" ghost className="text-xs ml-auto cf-print-hide" onClick={startEdit}>
            ✎ Edit slots
          </Btn>
        )}
      </div>
      {editing ? (
        <div className="space-y-2">
          <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(64px, 1fr))' }}>
            {SPELL_LEVELS.map((lvl) => (
              <div key={lvl} className="space-y-1">
                <label className="text-[10px] text-secondary font-bold uppercase">Lv {lvl}</label>
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
            <Btn density="xs" ghost className="text-xs" onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </Btn>
            <Btn density="xs" className="text-xs" onClick={saveMaxima} disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </Btn>
          </div>
        </div>
      ) : levels.length === 0 ? (
        <p className="text-xs text-secondary">
          No spell slots configured{canEdit ? ' — set per-level maxima with “Edit slots”' : ''}.
        </p>
      ) : (
        <div className="space-y-1.5">
          {levels.map((lvl) => {
            const slot = character.spellSlots[lvl]!;
            const available = Math.max(0, slot.max - slot.used);
            return (
              <div key={lvl} className="flex items-center gap-2.5 flex-wrap">
                <span className="text-[11px] text-secondary font-bold uppercase w-9">Lv {lvl}</span>
                <span className="tracking-[3px] text-[15px] leading-none" aria-label={`${available} of ${slot.max} slots available`}>
                  {Array.from({ length: slot.max }, (_, i) => (
                    <span key={i} style={{ color: i < available ? 'var(--color-accent-300)' : 'var(--color-text-disabled)' }}>
                      {i < available ? '●' : '○'}
                    </span>
                  ))}
                </span>
                <span className="text-[11px] text-secondary">
                  {available}/{slot.max}
                </span>
                {canEdit && (
                  <span className="inline-flex gap-1 ml-auto cf-print-hide">
                    <Btn density="xs" ghost className="text-xs" disabled={busy || available === 0} onClick={() => adjust(lvl, 1)}>
                      Use
                    </Btn>
                    <Btn density="xs" ghost className="text-xs" disabled={busy || slot.used === 0} onClick={() => adjust(lvl, -1)}>
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

/**
 * Issue #1642 — surfaces ONE adapter-declared special counted resource (5e inspiration or
 * PF2e hero points; `def` is whichever one `CharacterPage` found, or the section isn't
 * rendered at all). Deliberately mirrors `SpellSlotsCard`'s pip UI (issue #422's own
 * "togglable or counted resource" language) rather than inventing a second widget style —
 * for `defaultMax: 1` (inspiration) a single pip reads as a toggle; for `defaultMax: 3`
 * (hero points) it reads as a counted pool. Both are the SAME component, driven entirely by
 * `def.name` / `def.defaultMax` / `def.recharge` — no 5e- or PF2e-shaped branch anywhere in
 * here, so a third adapter that declares a similarly-shaped `special`-recharge resource
 * would render correctly with no code change.
 */
function AdapterResourceCard({
  character,
  canEdit,
  onChange,
  onError,
  def,
}: SheetCardProps & { def: AdapterResourceDef }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const announce = useAnnounce();

  const { max, available } = resourceAvailability(def, character);
  // Issue #2053 — display only. `def.name` itself keeps flowing to the server (see the
  // POST below) unchanged: the stored resource record is domain data, not presentation.
  const resourceLabel = adapterResourceLabel(t, def);

  // Issue #1944: the payload shape (first-touch creation vs. plain delta) now lives in
  // `specialResourceAdjustBody` — shared with the encounter screen's DM-award and
  // player-spend controls so the two surfaces cannot fork on what "spend"/"award" means.
  // `canAdjustSpecialResource` mirrors the SAME gating the button `disabled` props below use.
  async function adjust(direction: 'spend' | 'award') {
    if (busy || !canAdjustSpecialResource(def, character, direction)) return;
    setBusy(true);
    onError(null);
    try {
      await api.post(`${API}/characters/${character.id}/resources`, specialResourceAdjustBody(def, character, direction));
      onChange();
      announce(
        direction === 'spend'
          ? t('characters.resources.announceSpent', { name: resourceLabel })
          : t('characters.resources.announceRestored', { name: resourceLabel }),
      );
    } catch (err) {
      onError(err instanceof ApiError ? err.message : t('characters.resources.updateError', { name: resourceLabel }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-2.5">
      <h3 id={`${characterSheetSectionId('resources')}-heading`} className="card-kicker mb-0">{resourceLabel}</h3>
      <div className="flex items-center gap-2.5 flex-wrap">
        <span
          className="tracking-[3px] text-[15px] leading-none"
          aria-label={t('characters.resources.available', { available, max, name: resourceLabel })}
        >
          {Array.from({ length: max }, (_, i) => (
            <span key={i} style={{ color: i < available ? 'var(--color-accent-300)' : 'var(--color-text-disabled)' }}>
              {i < available ? '●' : '○'}
            </span>
          ))}
        </span>
        <span className="text-[11px] text-secondary">{t('characters.resources.count', { available, max })}</span>
        {canEdit && (
          <span className="inline-flex gap-1 ml-auto cf-print-hide">
            <Btn density="xs" ghost className="text-xs" disabled={busy || !canAdjustSpecialResource(def, character, 'spend')} onClick={() => void adjust('spend')}>
              {t('characters.resources.spend')}
            </Btn>
            <Btn density="xs" ghost className="text-xs" disabled={busy || !canAdjustSpecialResource(def, character, 'award')} onClick={() => void adjust('award')}>
              {t('characters.resources.restore')}
            </Btn>
          </span>
        )}
      </div>
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
  const announce = useAnnounce();

  async function applyDelta(delta: number) {
    if (busy) return;
    setBusy(true);
    onError(null);
    try {
      await api.post(`${API}/characters/${character.id}/hp`, { delta });
      onChange();
      announce(hpDeltaLabel(character.name, delta, character.hpCurrent, character.hpMax));
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
      announce(hpFullHealLabel(character.name, character.hpMax));
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
      className="flex gap-2 flex-wrap cf-print-hide"
      role="group"
      aria-label={`${name} hit points`}
      data-testid="character-hp-editor"
    >
      {/* No density prop (issue #1683 review): a fixed 52×44 HP-delta control
          cluster, sized to match its sibling "Full heal" button below (also no
          density, also inline minHeight: 44) — deliberately NOT dense. xs would
          be a no-op (inline style governs) and misleadingly suggest a 24px floor. */}
      {([-5, -1, 1, 5] as const).map((step) => (
        <Btn
          key={step}
          className=""
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

/**
 * Issue #1643 — the campaign's leveled condition track (5e Exhaustion, levels 1-6), shown
 * as a level with +/- controls rather than a plain add/remove chip (`ConditionsRow` below,
 * which drops this name from its own list once this renders — see its `excludeName` doc
 * comment). Only rendered at all when `findLeveledConditionTrack` found one for this
 * campaign's adapter — a system with none (PF2e) never reaches this component.
 */
function ConditionLevelRow({
  character,
  canEdit,
  onChange,
  onError,
  track,
}: SheetCardProps & { track: LeveledConditionTrack }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const announce = useAnnounce();
  const level = conditionLevel(track, character);
  // Issue #2053 — display only. `track.name` itself keeps flowing to the server (see
  // the POST below) unchanged: it identifies which stored track to adjust.
  const conditionLabel = adapterConditionLabel(t, track.name);

  async function adjust(delta: number) {
    if (busy) return;
    setBusy(true);
    onError(null);
    try {
      await api.post(`${API}/characters/${character.id}/conditions/level`, { name: track.name, delta });
      onChange();
      announce(
        delta > 0
          ? t('characters.conditionLevel.announceRaised', { name: conditionLabel, level: level + delta })
          : t('characters.conditionLevel.announceLowered', { name: conditionLabel, level: level + delta }),
      );
    } catch (err) {
      onError(err instanceof ApiError ? err.message : t('characters.conditionLevel.updateError', { name: conditionLabel }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2.5 flex-wrap">
      <span className="text-[11px] text-secondary font-bold uppercase">{conditionLabel}</span>
      <span
        className="tracking-[3px] text-[15px] leading-none"
        aria-label={t('characters.conditionLevel.level', { level, max: track.max, name: conditionLabel })}
      >
        {Array.from({ length: track.max }, (_, i) => (
          <span key={i} style={{ color: i < level ? 'var(--color-accent-300)' : 'var(--color-text-disabled)' }}>
            {i < level ? '●' : '○'}
          </span>
        ))}
      </span>
      <span className="text-[11px] text-secondary">{t('characters.conditionLevel.count', { level, max: track.max })}</span>
      {canEdit && (
        <span className="inline-flex gap-1 ml-auto cf-print-hide">
          <Btn density="xs" ghost className="text-xs" disabled={busy || level === 0} onClick={() => void adjust(-1)}>
            {t('characters.conditionLevel.lower')}
          </Btn>
          <Btn density="xs" ghost className="text-xs" disabled={busy || level >= track.max} onClick={() => void adjust(1)}>
            {t('characters.conditionLevel.raise')}
          </Btn>
        </span>
      )}
    </div>
  );
}

function ConditionsRow({
  character,
  canEdit,
  onChange,
  onError,
  adapter,
  excludeName,
}: {
  character: Character;
  canEdit: boolean;
  onChange: () => void;
  onError: (msg: string | null) => void;
  adapter: RuleSystemAdapter;
  /**
   * Issue #1643: the campaign's leveled condition track's name (5e "Exhaustion"), if any —
   * it gets its OWN level widget (`ConditionLevelRow`) above this list, so it is dropped
   * from the plain add/remove chip row here to avoid showing it twice with two different,
   * disagreeing controls (a bare-name remove here would wipe the level with no warning).
   */
  excludeName?: string;
}) {
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const announce = useAnnounce();
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
      announce(`Added condition ${v}`);
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
      announce(`Removed condition ${cond}`);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Couldn't remove condition.");
    } finally {
      setBusy(false);
    }
  }

  const excludeKey = excludeName?.trim().toLowerCase();
  const visibleConditions = excludeKey ? character.conditions.filter((c) => c.trim().toLowerCase() !== excludeKey) : character.conditions;
  // Issue #1643 review (Codex): the leveled track (e.g. Exhaustion) is excluded from this
  // list because it has its own widget above, NOT because it isn't active — so when it's the
  // ONLY condition on the sheet, `visibleConditions` goes empty and this used to print "None
  // — feeling fine." directly under an active "Exhaustion 3", visibly contradicting itself.
  // Gate the empty state on whether the excluded track is ALSO inactive.
  const excludedTrackActive = excludeKey ? character.conditions.some((c) => c.trim().toLowerCase() === excludeKey) : false;

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {visibleConditions.map((cond) => (
        <span key={cond} className="tag tag-outline" style={{ gap: 6 }}>
          {cond}
          {canEdit && (
            <button
              type="button"
              className="cf-target-44 cf-print-hide"
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
              <UIIcon name="close" size="xs" />
            </button>
          )}
        </span>
      ))}
      {visibleConditions.length === 0 && !excludedTrackActive && (
        <span className="text-muted text-xs">None — feeling fine.</span>
      )}
      {canEdit &&
        (adding ? (
          <form
            className="inline-flex items-end gap-1 cf-print-hide"
            onSubmit={compositionSafeFormSubmit(compositionGate, () => {
              void addCondition();
            })}
          >
            <Field
              idPrefix={CHARACTER_CONDITION_PREFIX}
              name="name"
              label={CHARACTER_CONDITION_LABEL}
              labelClassName="text-[10px] text-slate-300 font-bold uppercase tracking-wide"
              className="field !mb-0"
              autoFocus
              list="cf-condition-vocab"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={compositionSafeEscapeHandler(compositionGate, () => {
                setAdding(false);
                setValue('');
              })}
              {...compositionGate.inputProps}
              density="xs"
              help={CHARACTER_CONDITION_HELP}
              placeholder="Condition…"
              style={{ width: '7rem' }}
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
            className="btn btn-ghost cf-density-xs cf-print-hide"
            style={{ border: '1px dashed var(--color-divider)', borderRadius: 'var(--radius-md)' }}
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
  const announce = useAnnounce();

  async function save() {
    setSaving(true);
    onError(null);
    try {
      await api.patch(`${API}/characters/${character.id}`, { notes });
      setEditing(false);
      onChange();
      announce('Story notes saved');
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Couldn't save the story.");
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <>
        <div className="space-y-2 cf-print-editor" data-testid="character-story-edit">
          <Field
            idPrefix={CHARACTER_STORY_PREFIX}
            name="notes"
            as="textarea"
            label={CHARACTER_STORY_LABEL}
            labelClassName="text-[10px] text-slate-300 font-bold uppercase tracking-wide"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Markdown supported…"
            help={CHARACTER_STORY_HELP}
            minHeight={140}
            optional
          />
          <div className="flex gap-2 justify-end">
            <Btn density="xs" ghost className="text-xs" onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </Btn>
            <Btn density="xs" className="text-xs" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Btn>
          </div>
        </div>
        <div className="space-y-2 cf-print-only">
          {notes.trim() ? (
            <Markdown>{notes}</Markdown>
          ) : (
            <p className="text-sm text-secondary italic">No story written yet.</p>
          )}
        </div>
      </>
    );
  }

  return (
    <div className="space-y-2">
      {character.notes ? (
        <Markdown>{character.notes}</Markdown>
      ) : (
        <p className="text-sm text-secondary italic">No story written yet.</p>
      )}
      {canEdit && (
        <Btn density="xs"
          ghost
          className="text-xs cf-print-hide"
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
  const announce = useAnnounce();

  async function save() {
    setSaving(true);
    onError(null);
    try {
      await api.patch(`${API}/characters/${character.id}`, { dmSecret: draft });
      setEditing(false);
      onChange();
      announce('DM secret notes saved');
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
        className="text-xs text-secondary hover:text-[var(--color-neutral-300)] text-left"
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
      <h3 id={`${characterSheetSectionId('dm-secret')}-heading`} className="card-kicker">DM only — hidden from players</h3>
      {editing ? (
        <div className="space-y-2">
          <TextArea style={{ minHeight: 100 }} value={draft} onChange={(e) => setDraft(e.target.value)} />
          <div className="flex gap-2 justify-end">
            <Btn density="xs" ghost onClick={() => setEditing(false)} className="text-xs">
              Cancel
            </Btn>
            <Btn density="xs" onClick={save} disabled={saving} className="text-xs">
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
            className="text-[10px] text-secondary hover:text-[var(--color-neutral-300)] shrink-0"
          >
            ✎ edit
          </button>
        </div>
      )}
    </div>
  );
}

function RestControls({
  character,
  onChange,
  onError,
  adapter,
}: {
  character: Character;
  onChange: () => void;
  onError: (msg: string | null) => void;
  adapter: RuleSystemAdapter;
}) {
  const [busy, setBusy] = useState(false);
  const announce = useAnnounce();
  const options = restOptionsForAdapter(adapter);

  async function takeRest(type: 'stamina' | 'night' | 'short' | 'long') {
    if (busy) return;
    setBusy(true);
    onError(null);
    try {
      await api.post(`${API}/characters/${character.id}/rest`, { type });
      onChange();
      const label = options.find((opt) => opt.type === type)?.label ?? 'Rest';
      announce(`${label} completed`);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Couldn't complete rest.");
    } finally {
      setBusy(false);
    }
  }

  if (options.length === 0) return null;

  return (
    <div className="flex gap-2 items-center flex-wrap pt-1 cf-print-hide" data-testid="rest-controls">
      {options.map((opt) => {
        const isDisabled = busy || (opt.type === 'stamina' && character.rpCurrent < 1);
        return (
          <Btn
            key={opt.type}
            density="xs"
            ghost
            className="text-xs"
            disabled={isDisabled}
            onClick={() => void takeRest(opt.type)}
            title={opt.description ?? opt.label}
          >
            {opt.label}
          </Btn>
        );
      })}
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
        <span className="text-right text-secondary">
          Created manually
          {canEdit && (
            <span className="block text-[11px] text-secondary cf-print-hide">
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
        <span className="block text-[11px] text-secondary">
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
                className="underline hover:text-[var(--color-neutral-300)]"
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
              className="underline hover:text-[var(--color-neutral-300)] ml-1 cf-print-hide"
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
