import { CombatLog } from './CombatLog';
import { ApplyDamageBar, BattleMap, TOKEN_SIZE_OPTIONS, type EncounterGridPatch } from './map/BattleMap';
import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { DetailPageWayfinding } from '../../components/DetailPageWayfinding';
import { PrintControl } from '../../components/PrintControl';
import { PrintOnly } from '../../components/PrintOnly';
import { useKeyboardCommandHint, useKeyboardGuardedAction } from '../../components/KeyboardCommandProvider';
import { isImeComposing } from '../../lib/compositionSafeSubmit';
import { UIIcon } from '../../components/UIIcon';
import type { ActionSpec, ActionUndoToken, AoeTemplate, CampaignLibraryMonster, CastSessionCreated, Character, Combatant, CombatantRemoveResult, CombatantKind, ConditionInstance, CombatantStatblock as CombatantStatblockData, DiceRoll, DifficultyBand, EncounterDifficulty, EncounterEvent, EncounterWithCombatants, TurnWorkspace as TurnWorkspaceData, FogState, GenerateMapParams, GeneratedMapResult, HpResyncDirection, HpSyncConflict, MapPing, Npc, RuleEntry, RulePack, TokenSize } from '@campfire/schema';
import { ARCHMAGE_ADAPTER_ID, COMBATANT_STATBLOCK_HELP, STARFINDER_ADAPTER_ID, buildDifficultyExplanation, defaultCombatantStatblock, fogStatesEqual, hasDeathSavesForAdapter, LAIR_INITIATIVE_COUNT, LEGENDARY_ACTION_SLOT, ruleSystemAdapter } from '@campfire/schema';
import { entityTargetProps, entityHref } from '../../lib/entityLinks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, API, ApiError, isAmbiguousMutation, isReadTimeout, isStaleWrite, isTransientError, translateApiError } from '../../lib/api';
import { formatDateTime, formatTime, useFormattingLocale, useTimeFormat } from '../../lib/format';
import { queryKeys, invalidateCampaignCharacters, invalidateCampaignCheckRequests, invalidateEncounter, invalidateEncounterActions } from '../../lib/query';
import { newOperationId, useKeyedMutation } from '../../lib/keyedMutation';
import { beginReconcile, blocksFurtherActions, clearReconcile, completeReconcile, IDLE_RECONCILE, isAmbiguousOutcome, type ReconcileState } from '../../lib/ambiguousMutation';
import { useCampaignEvents, type CampaignEventsStatus } from '../../lib/useCampaignEvents';
import { inlineCharacterSheetsInteractive, inlineCharacterSheetsStatusLabel, shouldInvalidateInlineCharacters } from './inlineCharacterCards';
import { isDown, endedSummaryTallies } from './encounterEndedSummary';
import { filterPlayerSafeCombatants } from '../screen/playerSafe';
import { applyOptimisticHpDelta, replayOptimisticHpDeltas, type OptimisticHpDelta } from './optimisticHp';
import { applyOptimisticSpellSlotDelta } from './optimisticSpellSlots';
import { canStabilizeCombatant, hasRestoredTrashedEncounter, isCurrentCombatantUndoEncounter, REMOVE_COMBATANT_CONFIRM_BODY } from './combatantLifecycle';
import { isAdjacentDuplicateEncounterPatch, observedEncounterPatchRevision, reconcileEncounterPatchResponse, rollbackEncounterPatchError, type QueuedEncounterPatch } from './encounterPatchQueue';
import { pendingFogForEncounter, type ScopedPendingFog } from './fogSyncState';
import { EncounterAftermathPanel } from './EncounterAftermathPanel';
import { TurnWorkspace } from './TurnWorkspace';
import { PlayerVitalsHeader } from './PlayerVitalsHeader';
import { initials as tokenInitials } from '../../lib/avatarText';
import { useAuth } from '../../app/auth';
import { useCampaignAccess } from '../../app/CampaignAccessContext';
import { useCampaign } from '../../app/CampaignContext';
import { SharedDiceLog } from '../dice/SharedDiceLog';
import { EntityDiscussion } from '../comments/EntityDiscussion';
import { ResourceTrackerPanel } from "./ResourceTrackerPanel";
import { CheckRequestPanel } from './CheckRequests';
import { ActionUsePanel } from './ActionUseFlow';
import { CombatantActionsList } from './CombatantActionsList';
import { CombatantStatblockEditor } from './CombatantStatblockEditor';
import { StatBlock, hasMonsterStatblock } from '../../components/StatBlock';
import { CharacterStatCard } from '../../components/CharacterStatCard';
import { Card, Btn, TextInput, HpBar, Skeleton, ErrorNote, EmptyState } from '../../components/ui';
import { type MapReplaceAlignment } from '../../components/MapReplaceDialog';
import { NotFoundState } from '../../components/NotFoundState';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { UndoSnackbar } from '../../components/UndoSnackbar';
import { VisibleToPlayersBar } from '../../components/VisibleToPlayersBar';
import { useAnnounce } from '../../components/Announcer';
import { useRollApplyDamageBridge, useRollResultToast } from '../../components/RollResultToastContext';
import { useAiDmLiveActivity } from '../ai-dm/useAiDmLiveActivity';
import { EncounterAiDriverPanel } from '../ai-dm/EncounterAiDriverPanel';
import { AiDmPresenceTag, AiDmToolActivityRow } from '../ai-dm/AiDmActivityChip';
import { resolveToolActivity, toolResource } from '../ai-dm/toolActivity';
import { GameIcon } from '../../components/GameIcon';
import { TermHelp } from '../../components/TermHelp';
import { useWakeLock } from '../screen/useWakeLock';
import { CAST_DISPLAY_CHANNEL, type CastDisplayStatus, displayStatusLabel, focusCastWindow, isCastDisplayStatusForCampaign, navigateCastWindow, openCastWindow, type CastWindowState } from '../screen/castWindow';
import { useDisclosure } from '../../components/useDisclosure';
import { advanceCombatLogAnnouncements, formatCombatLogAnnouncementBatch, type CombatLogAnnouncementCursor } from './combatLogAccessibility';
import { makeActionError, type ActionErrorState } from './encounterActionError';
import { type AoeHitLayout } from './aoeHitTest';
import { type TargetDamageApplication } from './directDamage';
import { resolveGridCalibration } from './mapRenderedBounds';
import { scrollBehavior } from '../../lib/prefersReducedMotion';
import { deleteConfirmCopy, dmLifecycleActions, isLifecycleConfirmValid } from './encounterLifecycleActions';
import { CONNECTING_GRACE_MS, confirmEncounterOverride, deriveEncounterSyncState, ENCOUNTER_OVERRIDE_INACTIVE, encounterActionsBlocked, encounterOverrideAuthorized, encounterOverrideOfferable, encounterSyncBannerMessage, encounterSyncChipClass, encounterSyncChipLabel, encounterSyncOverrideBannerKey, encounterSyncRevisionFromUpdatedAt, ENCOUNTER_SYNC_BANNER_TESTID, ENCOUNTER_SYNC_CHIP_TESTID, isConnectingGraceElapsed, revokeEncounterOverrideIfUnauthorized, settleEncounterOverride, type EncounterOverrideAuthority, type EncounterOverrideState, type EncounterSyncRevision } from './encounterSyncState';
import { ENCOUNTER_LIFECYCLE_STEPS, activeLifecycleStepId, playerGuidance, preparingGuidance } from './postCreateGuidance';
import { tokenIdentityBackground } from './tokenIdentity';
import { UI_ICON_SIZE } from '../../lib/uiIcons';

export { BattleMap } from './map/BattleMap';

/**
 * Run session — live combat tracker. /c/:campaignId/encounters/:encounterId.
 * Mirrors design/claude-design/Campfire.dc.html "Run session" live state
 * (~L1389-1503) and "Encounter" initiative list (~L991-1024): header with
 * status chip + round + DM controls, initiative-sorted combatant rows
 * (current turn = accent left-border + glow), HP −/+ steppers, condition
 * chips, DM add-combatant panel (manual / compendium / party tabs), and a
 * dice log widget (expr input + roll history) per "Dice log" (~L1479-1499).
 *
 * Permissions: DM can edit any combatant, add/remove combatants, and drive
 * turn/round/status. Players may only adjust HP/conditions on the combatant
 * that maps to their own character (via campaign characters' ownerUserId).
 */

const STATUS_LABEL: Record<string, string> = {
  preparing: 'Preparing',
  running: 'Running',
  ended: 'Ended',
};

const STATUS_TAG_CLASS: Record<string, string> = {
  preparing: 'tag tag-neutral',
  running: 'tag tag-accent',
  ended: 'tag tag-outline',
};

type ConditionSourceOption = { id: number; name: string };
type ConditionTiming = ConditionInstance['timing'];

const CONDITION_TIMING_OPTIONS: Array<{ value: ConditionTiming; label: string }> = [
  { value: 'none', label: 'Manual / until removed' },
  { value: 'start-of-turn', label: 'Start of affected turn' },
  { value: 'end-of-turn', label: 'End of affected turn' },
];

const SAVE_TIMING_OPTIONS: Array<{ value: ConditionTiming; label: string }> = [
  { value: 'none', label: 'No repeat save' },
  { value: 'start-of-turn', label: 'Start of affected turn' },
  { value: 'end-of-turn', label: 'End of affected turn' },
];

type ConditionDraft = {
  name: string;
  source: string;
  sourceCombatantId: string;
  ruleEntryId: string;
  durationRounds: string;
  timing: ConditionTiming;
  saveTiming: ConditionTiming;
  saveAbility: string;
  saveDc: string;
  isConcentration: boolean;
  syncConcentration: boolean;
  stacks: string;
  notes: string;
};

function emptyConditionDraft(sourceCombatantId: number | null): ConditionDraft {
  return {
    name: '',
    source: '',
    sourceCombatantId: sourceCombatantId == null ? '' : String(sourceCombatantId),
    ruleEntryId: '',
    durationRounds: '',
    timing: 'end-of-turn',
    saveTiming: 'none',
    saveAbility: '',
    saveDc: '',
    isConcentration: false,
    syncConcentration: true,
    stacks: '1',
    notes: '',
  };
}

function conditionDraftFromInstance(instance: ConditionInstance): ConditionDraft {
  return {
    name: instance.name,
    source: instance.source ?? '',
    sourceCombatantId: instance.sourceCombatantId == null ? '' : String(instance.sourceCombatantId),
    ruleEntryId: instance.ruleEntryId == null ? '' : String(instance.ruleEntryId),
    durationRounds: instance.durationRounds == null ? '' : String(instance.durationRounds),
    timing: instance.timing,
    saveTiming: instance.saveTiming,
    saveAbility: instance.saveAbility ?? '',
    saveDc: instance.saveDc == null ? '' : String(instance.saveDc),
    isConcentration: instance.isConcentration,
    syncConcentration: false,
    stacks: String(instance.stacks),
    notes: instance.notes,
  };
}

function parseOptionalPositiveInt(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isInteger(value) && value >= 1 ? value : null;
}

function makeConditionInstanceId(name: string, existingIds: ReadonlySet<string>): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 18) || 'condition';
  const stamp = Date.now().toString(36).slice(-6);
  for (let i = 0; i < 100; i += 1) {
    const suffix = i === 0 ? stamp : `${stamp}_${i}`;
    const id = `ci_${slug}_${suffix}`.slice(0, 40);
    if (!existingIds.has(id)) return id;
  }
  return `ci_${slug}_${Math.random().toString(36).slice(2, 8)}`.slice(0, 40);
}

function buildConditionInstance(
  draft: ConditionDraft,
  conditionSuggestions: readonly string[],
  existingInstances: readonly ConditionInstance[],
  existingId?: string,
): ConditionInstance | null {
  const name = draft.name.trim().slice(0, 40);
  if (!name) return null;
  const durationRounds = parseOptionalPositiveInt(draft.durationRounds);
  const sourceCombatantValue = Number(draft.sourceCombatantId);
  const ruleEntryValue = Number(draft.ruleEntryId);
  const saveDcValue = Number(draft.saveDc);
  const stacksValue = Number(draft.stacks);
  return {
    id: existingId ?? makeConditionInstanceId(name, new Set(existingInstances.map((i) => i.id))),
    name,
    ruleEntryId: Number.isInteger(ruleEntryValue) && ruleEntryValue > 0 ? ruleEntryValue : null,
    source: draft.source.trim() ? draft.source.trim().slice(0, 160) : null,
    sourceCombatantId: Number.isInteger(sourceCombatantValue) && sourceCombatantValue > 0 ? sourceCombatantValue : null,
    durationRounds,
    roundsRemaining: durationRounds,
    timing: durationRounds == null ? 'none' : draft.timing,
    saveTiming: draft.saveTiming,
    saveDc: Number.isInteger(saveDcValue) && saveDcValue > 0 ? saveDcValue : null,
    saveAbility: draft.saveAbility.trim() ? draft.saveAbility.trim().toUpperCase().slice(0, 24) : null,
    isConcentration: draft.isConcentration,
    stacks: Number.isInteger(stacksValue) ? Math.max(1, Math.min(99, stacksValue)) : 1,
    notes: draft.notes.trim().slice(0, 300),
    custom: !conditionSuggestions.some((s) => s.toLowerCase() === name.toLowerCase()),
  };
}

function conditionSourceLabel(sourceCombatantId: number | null, options: readonly ConditionSourceOption[]): string | null {
  if (sourceCombatantId == null) return null;
  return options.find((o) => o.id === sourceCombatantId)?.name ?? `Combatant #${sourceCombatantId}`;
}

/** Stable serialization for suppressing an equivalent encounter PATCH while it is in flight. */
function encounterPatchKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(encounterPatchKey).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${encounterPatchKey(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/** Defaults shown by the grid panel must become real encounter state once the grid is enabled. */
function missingGridDefaults(encounter: EncounterWithCombatants): EncounterGridPatch | null {
  if (encounter.gridSize == null || encounter.gridSize <= 0) return null;
  const patch: EncounterGridPatch = {};
  if (encounter.gridScale == null) patch.gridScale = 5;
  if (encounter.gridUnit == null) patch.gridUnit = 'ft';
  return Object.keys(patch).length > 0 ? patch : null;
}

function gridDefaultAttemptKey(encounterId: number, patch: EncounterGridPatch): string {
  return `${encounterId}:${Object.keys(patch).sort().join(',')}`;
}

// Band colors live as --cf-difficulty-* tokens in index.css (issue #668) so a
// theme or dark/light swap can reach them; difficulty wants a green→red ramp
// distinct from the accent-colored status chips and from the destructive family.
const DIFFICULTY_STYLE: Record<DifficultyBand, { background: string; color: string }> = {
  trivial: { background: 'var(--cf-difficulty-trivial-bg)', color: 'var(--cf-difficulty-trivial-fg)' },
  easy: { background: 'var(--cf-difficulty-easy-bg)', color: 'var(--cf-difficulty-easy-fg)' },
  medium: { background: 'var(--cf-difficulty-medium-bg)', color: 'var(--cf-difficulty-medium-fg)' },
  hard: { background: 'var(--cf-difficulty-hard-bg)', color: 'var(--cf-difficulty-hard-fg)' },
  deadly: { background: 'var(--cf-difficulty-deadly-bg)', color: 'var(--cf-difficulty-deadly-fg)' },
};
const DIFFICULTY_NEUTRAL_STYLE = {
  background: 'var(--color-neutral-800)',
  color: 'var(--color-neutral-200)',
};

/**
 * Difficulty badge shown in the encounter header (issues #58 + #429, #476). Reads
 * GET /encounters/:id/difficulty. Hidden when there are no monsters. Zero-data
 * fights show the adapter's "Unknown—add XP/CR" label (never a fake Trivial);
 * unsupported rulesets explain the limitation. A focusable details control exposes
 * the XP math and warnings visibly (not hover-title-only).
 */
function DifficultyBadge({ difficulty }: { difficulty: EncounterDifficulty | null }) {
  const { open, buttonProps, regionProps } = useDisclosure({
    focusManagement: true,
    regionLabel: 'Encounter difficulty details',
  });

  if (!difficulty) return null;
  if (difficulty.monsterCount === 0) return null;

  const explanation = buildDifficultyExplanation(difficulty);
  const style =
    difficulty.status === 'unsupported' || difficulty.status === 'unknown' || difficulty.band === null
      ? DIFFICULTY_NEUTRAL_STYLE
      : DIFFICULTY_STYLE[difficulty.band];
  const { onClick: toggleDetails, ...detailsButtonProps } = buttonProps;

  return (
    <div
      className="inline-flex flex-col items-start gap-1"
      data-testid="difficulty-badge"
      style={{ maxWidth: 'min(100%, 24rem)' }}
    >
      <div className="inline-flex items-center gap-1">
        <span className="tag" style={style}>
          <GameIcon slug="crossed-swords" size={UI_ICON_SIZE.xs} className="inline align-text-bottom mr-1" />
          {difficulty.label}
        </span>
        <button
          type="button"
          className="btn btn-ghost cf-target-24"
          style={{ fontSize: 11, padding: '0 4px', lineHeight: 1 }}
          data-testid="difficulty-help-toggle"
          aria-label="Show encounter difficulty details"
          {...detailsButtonProps}
          onClick={(e) => toggleDetails?.(e)}
        >
          <GameIcon slug="info" size={UI_ICON_SIZE.xs} aria-hidden="true" />
        </button>
      </div>
      {open && (
        <div
          {...regionProps}
          className="cf-inset"
          data-testid="difficulty-help-panel"
          style={{ padding: '8px 12px', fontSize: 12, width: '100%' }}
        >
          <p style={{ margin: 0, fontWeight: 600 }}>{explanation.headline}</p>
          {explanation.detail.length > 0 && (
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {explanation.detail.map((line, i) => (
                <li key={i} className="text-muted" style={{ fontSize: 11 }}>
                  {line}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

type LinkRow = { id: number; name?: string; title?: string; number?: number };
function linkLabel(kind: 'location' | 'quest' | 'session', row: LinkRow): string {
  if (kind === 'session') return row.title || `Session ${row.number ?? row.id}`;
  return row.title ?? row.name ?? `#${row.id}`;
}

/**
 * Encounter location/quest/session links (issue #126, #480). Shows the current attachments as
 * chips with server-resolved labels so every role sees navigable names in read mode; the DM can
 * expand an inline editor to (re)attach or clear each link, persisted via PATCH /encounters/:id.
 */
function EncounterLinks({
  campaignId,
  encounter,
  canEdit,
  onSave,
}: {
  campaignId: number;
  encounter: EncounterWithCombatants;
  canEdit: boolean;
  onSave: (patch: Record<string, number | null>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { open: editing, buttonProps, regionProps } = useDisclosure({
    focusManagement: false,
    regionLabel: 'Encounter links',
  });
  const [locations, setLocations] = useState<LinkRow[]>([]);
  const [quests, setQuests] = useState<LinkRow[]>([]);
  const [sessions, setSessions] = useState<LinkRow[]>([]);
  const [linkListsLoaded, setLinkListsLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasLink = encounter.locationId != null || encounter.questId != null || encounter.sessionId != null;

  useEffect(() => {
    if (!editing || linkListsLoaded) return;
    let cancelled = false;
    void Promise.all([
      api.get<LinkRow[]>(`${API}/campaigns/${campaignId}/locations`).catch(() => []),
      api.get<LinkRow[]>(`${API}/campaigns/${campaignId}/quests`).catch(() => []),
      api.get<LinkRow[]>(`${API}/campaigns/${campaignId}/sessions`).catch(() => []),
    ]).then(([locs, qs, sess]) => {
      if (cancelled) return;
      setLocations(locs);
      setQuests(qs);
      setSessions(sess);
      setLinkListsLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [editing, campaignId, linkListsLoaded]);

  const locLabel =
    encounter.locationLink?.label ??
    (editing ? locations.find((l) => l.id === encounter.locationId) : undefined);
  const questLabelResolved =
    encounter.questLink?.label ??
    (editing ? quests.find((q) => q.id === encounter.questId) : undefined);
  const sessLabelResolved =
    encounter.sessionLink?.label ??
    (editing ? sessions.find((s) => s.id === encounter.sessionId) : undefined);

  const locDisplay =
    typeof locLabel === 'string'
      ? locLabel
      : locLabel
        ? linkLabel('location', locLabel)
        : null;
  const questDisplay =
    typeof questLabelResolved === 'string'
      ? questLabelResolved
      : questLabelResolved
        ? linkLabel('quest', questLabelResolved)
        : null;
  const sessDisplay =
    typeof sessLabelResolved === 'string'
      ? sessLabelResolved
      : sessLabelResolved
        ? linkLabel('session', sessLabelResolved)
        : null;

  async function save(patch: Record<string, number | null>) {
    setSaving(true);
    setError(null);
    try {
      await onSave(patch);
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'encounters.errors.updateLinks' }));
    } finally {
      setSaving(false);
    }
  }

  const showLoc = encounter.locationId != null && (canEdit || locDisplay != null);
  const showQuest = encounter.questId != null && (canEdit || questDisplay != null);
  const showSess = encounter.sessionId != null && (canEdit || sessDisplay != null);
  const hasVisibleLink = showLoc || showQuest || showSess;

  if (!canEdit && !hasVisibleLink) return null;

  return (
    <div className="flex items-center gap-2 flex-wrap" style={{ fontSize: 'var(--type-meta)' }}>
      {showLoc && (
        locDisplay ? <Link
          to={entityHref(campaignId, { type: 'location', id: encounter.locationId })}
          className="tag tag-outline hover:border-accent"
        >
          <GameIcon slug="treasure-map" size={UI_ICON_SIZE.xs} className="inline align-text-bottom mr-1" />
          {locDisplay}
        </Link> : <span className="tag tag-outline text-muted">
          <GameIcon slug="treasure-map" size={UI_ICON_SIZE.xs} className="inline align-text-bottom mr-1" />
          Location #{encounter.locationId} (unavailable)
        </span>
      )}
      {showQuest && (
        questDisplay ? <Link
          to={entityHref(campaignId, { type: 'quest', id: encounter.questId })}
          className="tag tag-outline hover:border-accent"
        >
          <GameIcon slug="scroll-unfurled" size={UI_ICON_SIZE.xs} className="inline align-text-bottom mr-1" />
          {questDisplay}
        </Link> : <span className="tag tag-outline text-muted">
          <GameIcon slug="scroll-unfurled" size={UI_ICON_SIZE.xs} className="inline align-text-bottom mr-1" />
          Quest #{encounter.questId} (unavailable)
        </span>
      )}
      {showSess && (
        sessDisplay ? <Link
          to={entityHref(campaignId, { type: 'session', id: encounter.sessionId })}
          className="tag tag-outline hover:border-accent"
        >
          <GameIcon slug="book-cover" size={UI_ICON_SIZE.xs} className="inline align-text-bottom mr-1" />
          {sessDisplay}
        </Link> : <span className="tag tag-outline text-muted">
          <GameIcon slug="book-cover" size={UI_ICON_SIZE.xs} className="inline align-text-bottom mr-1" />
          Session #{encounter.sessionId} (unavailable)
        </span>
      )}
      {!hasLink && canEdit && !editing && <span className="text-muted">No location / quest / session linked.</span>}
      {canEdit && (
        <button
          type="button"
          className="btn btn-ghost"
          style={{ fontSize: 'var(--type-label)' }}
          {...buttonProps}
        >
          {editing ? 'Done' : hasLink ? 'Edit links' : '+ Link'}
        </button>
      )}
      {error && <span className="text-rose-400">{error}</span>}
      {editing && canEdit && (
        <div {...regionProps} className="flex gap-2 flex-wrap w-full mt-1">
          <select
            className="cf-select text-xs cf-density-xs"
            aria-label="Location"
            value={encounter.locationId ?? ''}
            disabled={saving}
            onChange={(e) => void save({ locationId: e.target.value ? Number(e.target.value) : null })}
          >
            <option value="">— no location —</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {linkLabel('location', l)}
              </option>
            ))}
          </select>
          <select
            className="cf-select text-xs cf-density-xs"
            aria-label="Quest"
            value={encounter.questId ?? ''}
            disabled={saving}
            onChange={(e) => void save({ questId: e.target.value ? Number(e.target.value) : null })}
          >
            <option value="">— no quest —</option>
            {quests.map((q) => (
              <option key={q.id} value={q.id}>
                {linkLabel('quest', q)}
              </option>
            ))}
          </select>
          <select
            className="cf-select text-xs cf-density-xs"
            aria-label="Session"
            value={encounter.sessionId ?? ''}
            disabled={saving}
            onChange={(e) => void save({ sessionId: e.target.value ? Number(e.target.value) : null })}
          >
            <option value="">— no session —</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {linkLabel('session', s)}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

// Non-DM viewers see a monster's HP as a coarse status band, never exact numbers
// (issue #43 — the server redacts hpCurrent/hpMax to null and sends hpBand instead).
const HP_BAND_LABEL: Record<string, string> = {
  healthy: 'Healthy',
  bloodied: 'Bloodied',
  critical: 'Critical',
  down: 'Down',
};
const HP_BAND_PCT: Record<string, number> = { healthy: 100, bloodied: 50, critical: 20, down: 0 };
const HP_BAND_TONE: Record<string, string> = { healthy: '', bloodied: 'low', critical: 'crit', down: 'crit' };

/** Fuzzy HP indicator for redacted monster rows — mirrors HpBar's look off a band. */
function HpBandBar({ band }: { band: string | null }) {
  const pct = band ? (HP_BAND_PCT[band] ?? 0) : 0;
  const tone = band ? (HP_BAND_TONE[band] ?? '') : '';
  return (
    <div className={`cf-hp ${tone}`}>
      <div style={{ width: `${pct}%` }} />
    </div>
  );
}

export function hpDisplay(combatant: Pick<Combatant, 'hpCurrent' | 'hpMax' | 'hpBand'>): string {
  if (combatant.hpCurrent != null && combatant.hpMax != null) {
    return `${combatant.hpCurrent} / ${combatant.hpMax}`;
  }
  if (combatant.hpBand) {
    return HP_BAND_LABEL[combatant.hpBand] ?? '—';
  }
  return '—';
}

function InitiativeStrip({
  combatants,
  currentCombatantId,
  charactersById,
}: {
  combatants: readonly Combatant[];
  currentCombatantId: number | null;
  charactersById: Map<number, Character>;
}) {
  return (
    <div
      className="flex gap-2 overflow-x-auto pb-4 pt-2 px-2"
      style={{
        scrollSnapType: 'x mandatory',
        scrollbarWidth: 'none',
      }}
      data-testid="initiative-strip"
    >
      {combatants.map((c) => {
        const isCurrent = c.id === currentCombatantId;
        const character = c.characterId ? charactersById.get(c.characterId) : null;
        const isSilhouette = c.kind === 'npc' && c.npcId == null;

        return (
          <div
            key={c.id}
            className="flex flex-col items-center gap-1 flex-none"
            style={{ scrollSnapAlign: 'center' }}
            ref={(el) => {
              if (isCurrent && el) {
                el.scrollIntoView({ behavior: scrollBehavior(), block: 'nearest', inline: 'center' });
              }
            }}
          >
            <div
              aria-current={isCurrent ? 'true' : undefined}
              className="flex items-center justify-center overflow-hidden bg-surface"
              style={{
                width: isCurrent ? 48 : 40,
                height: isCurrent ? 48 : 40,
                transition: 'all 0.2s ease',
                border: isCurrent ? '2px solid var(--color-accent)' : '2px solid transparent',
                background: tokenIdentityBackground(c),
                borderRadius: 6,
              }}
              title={c.name}
            >
              {character?.portraitUrl ? (
                <img src={character.portraitUrl} alt={c.name} className="w-full h-full object-cover" />
              ) : isSilhouette ? (
                <span style={{ color: '#fff', display: 'flex' }}><GameIcon slug="hooded-figure" size={UI_ICON_SIZE.sm} /></span>
              ) : (
                <span style={{ color: '#fff', fontSize: isCurrent ? 16 : 14, fontWeight: 700, pointerEvents: 'none' }}>
                  {tokenInitials(c.name)}
                </span>
              )}
            </div>
            <span className="text-muted" style={{ fontSize: 10, lineHeight: 1 }}>
              {hpDisplay(c)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

const DEATH_STATE_LABEL: Record<string, string> = { dying: 'Dying', stable: 'Stable', dead: 'Dead' };

/**
 * 5e death-save tracker (issue #57): three success pips + three failure pips for a
 * character at 0 HP. Clicking a pip sets the count to that position (clicking the
 * highest-lit pip clears it back down), committing via onSet. Read-only unless
 * `canEditPermission`; also disabled (not unmounted) while `syncBlocked` (issue #1746).
 *
 * Roll button (issue #1462): requests one server-authoritative d20, which drives both
 * the 5e outcome and the matching shared dice-log entry.
 */
/**
 * Death-save pips (issue #428 hit area, #1478 stability).
 *
 * MUST stay at module scope. This used to be declared inside `DeathSaveTracker`'s body,
 * which minted a NEW component type on every render of the tracker. React compares
 * element types by identity, so a fresh type meant the whole pip subtree was unmounted
 * and remounted on every re-render instead of being updated in place — the DOM nodes were
 * destroyed and rebuilt several times per second while the encounter polled.
 *
 * That cost more than churn: it dropped keyboard focus from a pip mid-interaction, and it
 * made the buttons intermittently unmeasurable — an element could pass a visibility check
 * and then be detached before its box could be read a moment later. That is exactly what
 * made `combat-mobile-target-size.spec.ts` "flaky" at phone widths (worst at 430px, where
 * the larger viewport renders more and widens the window). Hoisting the component gives it
 * a stable identity, so React reconciles the existing nodes and the pips stop churning.
 */
function DeathSavePips({
  kind,
  count,
  color,
  canEditPermission,
  busy,
  syncBlocked,
  syncBlockedReason,
  syncBlockedDescribedBy,
  onSet,
}: {
  kind: 'deathSaveSuccesses' | 'deathSaveFailures';
  count: number;
  color: string;
  /** Permission alone (issue #1746) — see {@link DeathSaveTracker}'s `canEditPermission` doc. */
  canEditPermission: boolean;
  busy: boolean;
  /** Issue #1746: the encounter sync gate is blocking conflict-prone writes right now. */
  syncBlocked: boolean;
  syncBlockedReason?: string;
  syncBlockedDescribedBy?: string;
  onSet: (patch: { deathSaveSuccesses?: number; deathSaveFailures?: number }) => void;
}) {
  return (
    <span style={{ display: 'inline-flex', gap: 4 }} data-testid={`death-save-${kind === 'deathSaveSuccesses' ? 'success' : 'failure'}-pips`}>
      {[0, 1, 2].map((i) => {
        const filled = i < count;
        const next = count === i + 1 ? i : i + 1; // click the highest-lit pip to clear it
        return (
          <button
            key={i}
            type="button"
            className="cf-death-save-pip"
            aria-label={`${kind === 'deathSaveSuccesses' ? 'Success' : 'Failure'} ${i + 1} of 3${filled ? ' (marked)' : ''}`}
            aria-pressed={filled}
            aria-describedby={syncBlockedDescribedBy}
            disabled={!canEditPermission || busy || syncBlocked}
            title={syncBlockedReason}
            onClick={() => onSet({ [kind]: next })}
            style={{
              // Visual pip color via CSS variables; hit area is the 44×44 class (issue #428).
              ['--cf-death-save-pip-color' as string]: color,
              ['--cf-death-save-pip-fill' as string]: filled ? color : 'transparent',
              cursor: canEditPermission && !busy && !syncBlocked ? 'pointer' : 'default',
            }}
          />
        );
      })}
    </span>
  );
}

function DeathSaveTracker({
  successes,
  failures,
  canEditPermission,
  canRoll,
  busy,
  syncBlocked,
  syncBlockedReason,
  syncBlockedDescribedBy,
  onSet,
  onRoll,
}: {
  successes: number;
  failures: number;
  /**
   * Permission alone (issue #1746 fix — Devin review finding): this used to be a
   * combined "permitted AND not sync-blocked" value, which meant marking/clearing a
   * death save and the Roll button silently went from "blocked during an outage" to
   * "always live" when the mount/disable split landed elsewhere in this file. Two
   * clients disagreeing about whether a character died is exactly the corruption the
   * sync gate exists to prevent, so this tracker now takes its OWN `syncBlocked` and
   * disables (not unmounts) on it, same as every other write control in the row.
   */
  canEditPermission: boolean;
  /** Terminal states retain their pips but cannot make another authoritative roll. */
  canRoll: boolean;
  busy: boolean;
  /** Issue #1746: the encounter sync gate is blocking conflict-prone writes right now. */
  syncBlocked: boolean;
  syncBlockedReason?: string;
  syncBlockedDescribedBy?: string;
  onSet: (patch: { deathSaveSuccesses?: number; deathSaveFailures?: number }) => void;
  onRoll: () => void;
}) {
  return (
    <div
      style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 5, fontSize: 'var(--type-label)', flexWrap: 'wrap' }}
      data-testid="death-save-tracker"
    >
      <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
        <span className="text-muted" style={{ letterSpacing: 0.3 }}>Saves</span>
        <DeathSavePips
          kind="deathSaveSuccesses"
          count={successes}
          color="var(--color-accent)"
          canEditPermission={canEditPermission}
          busy={busy}
          syncBlocked={syncBlocked}
          syncBlockedReason={syncBlockedReason}
          syncBlockedDescribedBy={syncBlockedDescribedBy}
          onSet={onSet}
        />
      </span>
      <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
        <span className="text-muted" style={{ letterSpacing: 0.3 }}>Fails</span>
        <DeathSavePips
          kind="deathSaveFailures"
          count={failures}
          color="#e5484d"
          canEditPermission={canEditPermission}
          busy={busy}
          syncBlocked={syncBlocked}
          syncBlockedReason={syncBlockedReason}
          syncBlockedDescribedBy={syncBlockedDescribedBy}
          onSet={onSet}
        />
      </span>
      {canEditPermission && canRoll && (
        <button
          type="button"
          className="btn btn-ghost cf-target-44"
          aria-label="Roll a death save"
          aria-describedby={syncBlockedDescribedBy}
          title={syncBlockedReason ?? 'Roll a death save (nat 1 = two fails, nat 20 = revive at 1 HP)'}
          disabled={busy || syncBlocked}
          onClick={onRoll}
          style={{ fontSize: 'var(--type-label)', padding: '0 12px', border: '1px dashed var(--color-divider)', borderRadius: 'var(--radius-md)' }}
        >
          Roll
        </button>
      )}
    </div>
  );
}

/** Combat-log actor for HP/death patches (issues #620, #494). Omit self-attribution. */
function hpLogActorId(actorCombatantId: number | undefined | null, targetCombatantId: number): number | undefined {
  if (actorCombatantId == null || actorCombatantId === targetCombatantId) return undefined;
  return actorCombatantId;
}

/**
 * Attach the combat-log actor to an HP patch — but only for a DM (issue #1478).
 *
 * `actorId` is a DM-authored field: the server 403s ANY non-DM patch that carries it, so
 * that a player cannot spoof who dealt the damage. Sending it as a player was therefore
 * fatal — and it fired whenever the current-turn combatant differed from the target, i.e.
 * a player applying damage to their own character on anyone else's turn (~half the time,
 * depending on initiative).
 *
 * Dropping the field costs nothing, because it is redundant on the player path: the
 * server's tri-state `actorId` contract (encounters.service.ts `resolveCombatLogActor`)
 * falls back to the current-turn combatant when `actorId` is OMITTED — the identical
 * attribution the client was trying to send. So the log line is unchanged; only the 403
 * goes away.
 *
 * Deliberately gated client-side rather than having the server ignore a redundant value:
 * the client's `currentCombatantId` is a cached read, so an "actorId === current turn"
 * leniency rule on the server would still 403 whenever the turn advanced between render
 * and request — trading a deterministic bug for a rare, racy one.
 */
function hpPatchWithActor(
  patch: Record<string, unknown>,
  actorCombatantId: number | undefined | null,
  targetCombatantId: number,
  canAttributeActor: boolean,
): Record<string, unknown> {
  if (!canAttributeActor) return patch;
  const actorId = hpLogActorId(actorCombatantId, targetCombatantId);
  return actorId != null ? { ...patch, actorId } : patch;
}

const HP_LOG_PATCH_KEYS = new Set(['hpDelta', 'hpSet', 'hpTemp']);

type OptimisticHpQueue = {
  encounterId: number;
  base: EncounterWithCombatants | undefined;
  nextSequence: number;
  operations: Map<string, OptimisticHpDelta & { sequence: number }>;
};

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(handle);
  }, [value, delayMs]);
  return debounced;
}

export default function RunSessionPage() {
  const { t } = useTranslation();
  const { campaignId, encounterId } = useParams<{ campaignId: string; encounterId: string }>();
  const cid = Number(campaignId);
  const eid = Number(encounterId);
  const navigate = useNavigate();
  const { me, staleIdentity } = useAuth();
  const formattingLocale = useFormattingLocale();
  const timeFormat = useTimeFormat();
  const { isDm, canDmWrite, canPlayerWrite } = useCampaignAccess();
  // Issue #1904: the per-combatant "Roll initiative" action animates through the same
  // shared dice overlay/toast as every other campaign roll.
  const { beginRollAnimation, cancelRollAnimation, showRoll } = useRollResultToast();
  // #1589 — read from `attemptGridDefaults`, which can run from inside a mutation's
  // `onSettled` callback (see `gridDefaultRetryOnFree`) rather than only from render, so it
  // needs the CURRENT permission rather than whatever was in scope when that callback closure
  // was created.
  const canDmWriteRef = useRef(canDmWrite);
  canDmWriteRef.current = canDmWrite;
  const campaign = useCampaign(Number.isFinite(cid) ? cid : undefined);
  const announce = useAnnounce();

  // Resolve the rule-system adapter FROM THE ACTIVE CAMPAIGN (issue #234) rather than at
  // module scope with no argument — so a future non-5e adapter's condition vocabulary and
  // statblock mapping actually take effect. Default (5e) is unchanged.
  const ruleSystem = campaign?.ruleSystem ?? null;
  const activeAdapter = useMemo(() => ruleSystemAdapter(ruleSystem), [ruleSystem]);
  const isStarfinder = activeAdapter.id === STARFINDER_ADAPTER_ID || ruleSystem?.startsWith('starfinder') || false;
  const isArchmage = activeAdapter.id === ARCHMAGE_ADAPTER_ID;
  const conditionSuggestions = useMemo(() => [...activeAdapter.conditions], [activeAdapter]);

  const queryClient = useQueryClient();

  // AI-DM live-state relay (#344): the presence chip + activity toast read off the
  // single app-wide stream subscription mounted in app/Layout.tsx — this page does
  // NOT open its own /ai-dm/stream connection. The underlying tool/HP/turn data still
  // arrives via the existing encounter SSE channel + refetch above, unchanged; this
  // only adds the "why did this just change" signal for whoever's watching.
  const liveActivity = useAiDmLiveActivity();
  const [aiToasts, setAiToasts] = useState<Array<{ key: number; chip: ReturnType<typeof resolveToolActivity>; at: number }>>([]);
  const lastToastEventRef = useRef<string | null>(null);
  const toastSeq = useRef(0);
  useEffect(() => {
    const activity = liveActivity.encounterActivity;
    if (!activity) return;
    // Issue #825: only attribute encounter-class AI activity to THIS open fight when the
    // server-derived encounterId matches. Cross-encounter tools (prep B while watching A)
    // must not toast here as if they hit A. Party/campaign tools still surface here.
    const event = activity.event;
    const activityEncounterId = activity.encounterId ?? event.encounterId;
    if (toolResource(event.name) === 'encounter') {
      if (activityEncounterId === undefined || !Number.isFinite(eid) || activityEncounterId !== eid) {
        return;
      }
    }
    const eventKey = `${event.type}:${event.name}:${event.at}:${event.isError}:${event.proposed}:${event.encounterId ?? ''}`;
    if (eventKey === lastToastEventRef.current) return;
    lastToastEventRef.current = eventKey;
    const chip = resolveToolActivity(event, { campaignId: cid, encounterId: eid });
    const key = ++toastSeq.current;
    setAiToasts((prev) => [...prev, { key, chip, at: activity.at }].slice(-3));
    announce(`The AI DM ${chip.label.toLowerCase()}.`, {
      dedupeKey: `ai-dm-tool:${cid}:${eventKey}`,
    });
    const timer = setTimeout(() => setAiToasts((prev) => prev.filter((t) => t.key !== key)), 8000);
    return () => clearTimeout(timer);
  }, [liveActivity.encounterActivity, cid, eid, announce]);

  // Issue #430: structured so Refresh/dismiss/navigation can clear stale banners
  // without relying solely on the Retry path. Passive SSE/poll must not wipe it.
  const [actionError, setActionError] = useState<ActionErrorState>(null);
  const [encounterPatchConflict, setEncounterPatchConflict] = useState<string | null>(null);
  const [pendingFog, setPendingFog] = useState<ScopedPendingFog | undefined>(undefined);
  const pendingEncounterPatches = useRef(new Map<string, QueuedEncounterPatch>());
  const lastLocalEncounterRevision = useRef(new Map<number, string>());
  // A damage/heal amount just rolled from a character card, awaiting a one-tap target
  // pick (issue: wire actions → dice → damage). Cleared on apply or dismiss.
  const [pendingApply, setPendingApply] = useState<{
    id: number;
    amount: number;
    label: string;
    diceTotal?: number;
    /** Combatant whose card rolled the damage — attributed as the combat-log actor when set. */
    actorCombatantId?: number;
  } | null>(null);
  const pendingApplySequence = useRef(0);
  /** Live map layout from BattleMap for AoE hit-testing (issue #626). */
  const [aoeHitLayout, setAoeHitLayout] = useState<AoeHitLayout | null>(null);
  // Issue #414: structured action Use flow — pick targets, preview, apply, undo.
  const [pendingActionUse, setPendingActionUse] = useState<{
    combatantId: number;
    actorName: string;
    actionIndex: number;
    actionName: string;
    spec: ActionSpec;
  } | null>(null);
  const [actionUndo, setActionUndo] = useState<{ token: ActionUndoToken; label: string } | null>(null);
  const [escalationOverrideDraft, setEscalationOverrideDraft] = useState('');
  // Live battle-map pings (issue #238) — transient markers pushed over SSE, each auto-expires
  // after a short lifetime. A monotonic key disambiguates simultaneous pings at the same spot.
  const [pings, setPings] = useState<Array<{ key: number; x: number; y: number; senderName: string | null; color: string | null }>>([]);
  const pingSeq = useRef(0);
  const addPing = useCallback((ping: { x: number; y: number; senderName?: string | null; color?: string | null }) => {
    const key = ++pingSeq.current;
    if (ping.senderName) {
      announce(`${ping.senderName} pinged the map`);
    } else {
      announce('A map ping arrived');
    }
    setPings((prev) => {
      const next = [...prev, { key, x: ping.x, y: ping.y, senderName: ping.senderName || null, color: ping.color || null }];
      return next.slice(-10);
    });
    setTimeout(() => setPings((prev) => prev.filter((p) => p.key !== key)), 10000);
  }, [announce]);
  const dismissPing = useCallback((key: number) => {
    setPings((prev) => prev.filter((p) => p.key !== key));
  }, []);
  // Per-combatant in-flight tracking (issue #73) — replaces the single global `busy`
  // flag so one combatant's slower edit (rename, condition, initiative…) disables only
  // that row, never the whole tracker. HP steppers bypass this entirely: they're
  // optimistic and stay live even while a request is in flight.
  const [pendingCombatantIds, setPendingCombatantIds] = useState<ReadonlySet<number>>(() => new Set());
  const markCombatantPending = useCallback((combatantId: number, on: boolean) => {
    setPendingCombatantIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(combatantId);
      else next.delete(combatantId);
      return next;
    });
  }, []);

  const [confirmEnd, setConfirmEnd] = useState(false);
  const [confirmReopen, setConfirmReopen] = useState(false);
  /** Issue #466: per-conflict resync direction chosen in the Reopen dialog. */
  const [hpResyncChoices, setHpResyncChoices] = useState<Record<number, HpResyncDirection>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pendingTrashUndo, setPendingTrashUndo] = useState<{ encounterId: number } | null>(null);
  const trashedEncounterIdsRef = useRef(new Set<number>());
  const trashedEncounterRevisionsRef = useRef(new Map<number, string>());
  // Keep one key for a remove intent until a definite response. If its success
  // response is lost, pressing Remove again must replay the same receipt rather
  // than turn the retry into a 404 after the original delete committed.
  const combatantRemovalKeys = useRef(new Map<string, string>());
  const [pendingCombatantUndo, setPendingCombatantUndo] = useState<{ name: string; undoToken: string; encounterId: number } | null>(null);
  const [dismissTokenUndoNonce, setDismissTokenUndoNonce] = useState(0);
  const [confirmRemoveCombatantId, setConfirmRemoveCombatantId] = useState<number | null>(null);
  const [eventStatus, setEventStatus] = useState<CampaignEventsStatus | null>(null);
  const [encounterReadStale, setEncounterReadStale] = useState(false);
  const [resyncPending, setResyncPending] = useState(false);
  const [syncRevision, setSyncRevision] = useState<EncounterSyncRevision | null>(null);
  // Issue #1446: session-scoped "continue anyway" override for the stale-sync gate, and
  // the first-load `connecting` grace timer that lets a genuine SSE outage (never
  // connects at all) become overridable instead of blocking forever.
  const [encounterSyncOverride, setEncounterSyncOverride] = useState<EncounterOverrideState>(ENCOUNTER_OVERRIDE_INACTIVE);
  const connectingSinceRef = useRef<number | null>(null);
  const [connectingGraceElapsed, setConnectingGraceElapsed] = useState(false);
  // Issue #1446 review fix (round 5) — one level up from the encounter-switch fix below:
  // `eventStatus`, the connecting-grace timer, and `encounterSyncOverride` all belong to
  // the CAMPAIGN's SSE stream (or, for the override, the identity that granted it) — they
  // outlive an encounter switch but NOT a campaign switch or a signed-in-identity change.
  // `RunSessionPage` is reused across BOTH: a cross-campaign SPA navigation (e.g.
  // following a notification link — NotificationsBell.tsx — into a different campaign's
  // encounter) keeps this component mounted with a new `cid`, exactly like an encounter
  // switch keeps it mounted with a new `eid`. Without this, a DM's override confirmed in
  // campaign A would silently authorize stale-state writes in campaign B — a cross-
  // campaign leak of a trust decision, strictly worse than the ergonomic bug it started
  // as. A user-identity change (re-auth as someone else without an intervening route
  // change/remount) is the same class of leak one level further up and is covered by the
  // same key. Rather than another special-cased reset effect (the failure mode behind the
  // last two review rounds — an effect with the wrong dependency array, or a second effect
  // whose reset the first effect's timer didn't expect), this state is explicitly KEYED to
  // `(campaignId, userId)`: the key is compared during render (React's documented
  // "adjust state while rendering" pattern), and a mismatch is corrected in the SAME
  // render that detects it, before any effect below ever observes stream state that
  // belongs to a different campaign or identity. Both behaviors (persist across an
  // encounter switch, reset across a campaign/identity switch) fall out of this one
  // comparison — no per-transition special case to keep re-discovering.
  const campaignStreamKey = `${cid}:${me?.user.id ?? ''}`;
  const [ownedCampaignStreamKey, setOwnedCampaignStreamKey] = useState(campaignStreamKey);
  if (ownedCampaignStreamKey !== campaignStreamKey) {
    setOwnedCampaignStreamKey(campaignStreamKey);
    setEventStatus(null);
    connectingSinceRef.current = null;
    setConnectingGraceElapsed(false);
    setEncounterSyncOverride(ENCOUNTER_OVERRIDE_INACTIVE);
  }
  // The player display is deliberately a separate browsing context: navigating this
  // cockpit to `/screen` used to strand the DM without initiative or turn controls.
  // Keep only the window handle and non-secret status here; cast capabilities never
  // cross BroadcastChannel/postMessage (issue #762 / #547).
  const castWindowRef = useRef<Window | null>(null);
  const castConnectionSequenceRef = useRef(0);
  const [castWindowState, setCastWindowState] = useState<CastWindowState>('idle');
  const [castFollowedEncounter, setCastFollowedEncounter] = useState<{ id: number | null; name: string | null }>({ id: null, name: null });
  const [castDisplayNotice, setCastDisplayNotice] = useState<string | null>(null);

  // Navigating between campaigns reuses this component, so any display state from
  // the previous campaign must be discarded (issue #762 review).
  useEffect(() => {
    castWindowRef.current = null;
    castConnectionSequenceRef.current = 0;
    setCastWindowState('idle');
    setCastFollowedEncounter({ id: null, name: null });
    setCastDisplayNotice(null);
  }, [cid]);

  const receiveCastDisplayStatus = useCallback((status: CastDisplayStatus) => {
    if (status.campaignId !== cid) return;
    if (status.type === 'ready') {
      setCastWindowState('ready');
      setCastFollowedEncounter({ id: status.encounterId, name: status.encounterName });
      return;
    }
    setCastWindowState('window-closed');
  }, [cid]);

  useEffect(() => {
    if (!Number.isFinite(cid)) return;
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.origin !== window.location.origin || !event.data || typeof event.data !== 'object') return;
      if (isCastDisplayStatusForCampaign(event.data, cid)) receiveCastDisplayStatus(event.data);
    };
    window.addEventListener('message', onMessage);
    // BroadcastChannel is an enhancement, not the only protocol: opener postMessage
    // keeps named-window focus/status functional in older embedded/tablet browsers.
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CAST_DISPLAY_CHANNEL);
    if (channel) channel.onmessage = (event: MessageEvent<unknown>) => {
      if (isCastDisplayStatusForCampaign(event.data, cid)) receiveCastDisplayStatus(event.data);
    };
    return () => {
      window.removeEventListener('message', onMessage);
      channel?.close();
    };
  }, [cid, receiveCastDisplayStatus]);

  const mintCastLink = useCallback(async (): Promise<string> => {
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
    const created = await api.post<CastSessionCreated>(`${API}/campaigns/${cid}/cast-sessions`, {
      label: 'Player display',
      expiresAt,
    });
    return new URL(created.url, window.location.origin).href;
  }, [cid]);

  const connectPlayerDisplay = useCallback((target: Window) => {
    const sequence = ++castConnectionSequenceRef.current;
    setCastWindowState('opening');
    setCastDisplayNotice(null);
    void mintCastLink()
      .then((url) => {
        if (sequence !== castConnectionSequenceRef.current) return;
        if (!navigateCastWindow(target, url)) {
          setCastWindowState('window-closed');
          setCastDisplayNotice('The display window closed before it could connect. Open display to try again.');
        }
      })
      .catch((error: unknown) => {
        if (sequence !== castConnectionSequenceRef.current) return;
        setCastWindowState('idle');
        const prefix = t('encounters.errors.actionFailed');
        setCastDisplayNotice(error instanceof Error ? `${prefix}: ${error.message}` : prefix);
      });
  }, [mintCastLink, t]);

  const openPlayerDisplay = useCallback(() => {
    // `openCastWindow` intentionally happens before any await: this is the user
    // gesture that prevents popup blockers from stealing the display workflow.
    const target = openCastWindow();
    if (!target) {
      setCastWindowState('popup-blocked');
      setCastDisplayNotice('The browser blocked the player display. Allow popups for Campfire, then try Open display again.');
      return;
    }
    castWindowRef.current = target;
    connectPlayerDisplay(target);
  }, [connectPlayerDisplay]);

  const copyPlayerDisplayLink = useCallback(() => {
    setCastDisplayNotice(null);
    // Preserve the click's user activation by handing `clipboard.write` a Promise
    // that resolves to the link text once the server mints it (Safari/WebKit).
    const textPromise = mintCastLink().then((url) => new Blob([url], { type: 'text/plain' }));
    const ClipboardItemCtor = (typeof window !== 'undefined' && (window as unknown as { ClipboardItem: typeof ClipboardItem }).ClipboardItem) as typeof ClipboardItem | undefined;
    const writePromise =
      ClipboardItemCtor && navigator.clipboard?.write
        ? navigator.clipboard.write([new ClipboardItemCtor({ 'text/plain': textPromise })])
        : textPromise
            .then((blob) => blob.text())
            .then((url) => {
              if (!navigator.clipboard?.writeText) {
                throw new Error('Clipboard access is unavailable; open the display and copy its address instead.');
              }
              return navigator.clipboard.writeText(url);
            });
    void writePromise
      .then(() => setCastDisplayNotice('A safe player-display link was copied. It expires in 8 hours.'))
      .catch((error: unknown) => {
        setCastDisplayNotice(error instanceof Error ? error.message : t('encounters.errors.actionFailed'));
      });
  }, [mintCastLink, t]);

  const reconnectPlayerDisplay = useCallback(() => {
    const target = castWindowRef.current;
    if (castWindowState === 'ready' && focusCastWindow(target)) {
      setCastDisplayNotice('Focused the existing player display.');
      return;
    }
    // A live blank/expired/error page cannot be healed by focus alone. Re-mint a
    // capability and navigate that same named handle; only a truly closed handle
    // needs a fresh popup (which happens synchronously in openPlayerDisplay).
    if (target && !target.closed) {
      focusCastWindow(target);
      connectPlayerDisplay(target);
      return;
    }
    setCastWindowState('window-closed');
    openPlayerDisplay();
  }, [castWindowState, connectPlayerDisplay, openPlayerDisplay]);

  // Reads via TanStack Query (issue #73). Each is polled while the tab is visible
  // (refetchInterval pauses in the background by default) as a backstop to the SSE
  // push below; SSE remains the fast path (invalidate-on-event), the poll only catches
  // anything a dropped stream missed. The ~5s cadence matches the pre-SSE poll.
  const encounterQuery = useQuery({
    queryKey: queryKeys.encounter(eid),
    queryFn: async () =>
      reconcileEncounterPatchResponse(
        await api.get<EncounterWithCombatants>(`${API}/encounters/${eid}`),
        pendingEncounterPatches.current.values(),
        '',
        eid,
      ),
    enabled: Number.isFinite(eid),
    refetchInterval: 5_000,
  });
  const encounter = encounterQuery.data ?? null;
  useWakeLock(encounter?.status === 'running');

  // An encounter can be restored by another client or API caller. A newer authoritative
  // revision clears only that old local-trash marker, not the still-cached pre-trash row.
  useEffect(() => {
    if (!encounter) return;
    const trashedRevision = trashedEncounterRevisionsRef.current.get(encounter.id);
    if (hasRestoredTrashedEncounter(
      trashedRevision,
      encounter.updatedAt,
    )) {
      trashedEncounterIdsRef.current.delete(encounter.id);
      trashedEncounterRevisionsRef.current.delete(encounter.id);
    }
  }, [encounter?.id, encounter?.updatedAt]);

  useEffect(() => {
    setEscalationOverrideDraft(encounter?.escalationDieOverride == null ? '' : String(encounter.escalationDieOverride));
  }, [encounter?.id, encounter?.escalationDieOverride]);

  useEffect(() => {
    if (!encounterQuery.isSuccess || encounterQuery.isFetching || encounterQuery.dataUpdatedAt === 0) return;
    setEncounterReadStale(false);
    setResyncPending(false);
    if (encounter?.updatedAt) {
      setSyncRevision(encounterSyncRevisionFromUpdatedAt(encounter.updatedAt, encounterQuery.dataUpdatedAt));
    }
  }, [encounter?.updatedAt, encounterQuery.dataUpdatedAt, encounterQuery.isFetching, encounterQuery.isSuccess]);

  useEffect(() => {
    if (!encounterQuery.error || encounter == null) return;
    if (encounterQuery.error instanceof ApiError && encounterQuery.error.status >= 400 && encounterQuery.error.status < 500) {
      return;
    }
    if (isTransientError(encounterQuery.error) || isReadTimeout(encounterQuery.error)) {
      setEncounterReadStale(true);
    }
  }, [encounterQuery.error, encounter]);

  // Difficulty is a separate read-only derivation (issue #58) — never let its failure
  // block the encounter view; the badge just stays hidden (retry off, error ignored).
  const difficultyQuery = useQuery({
    queryKey: queryKeys.encounterDifficulty(eid),
    queryFn: () => api.get<EncounterDifficulty>(`${API}/encounters/${eid}/difficulty`),
    enabled: Number.isFinite(eid),
    refetchInterval: 5_000,
    retry: false,
  });
  const difficulty = difficultyQuery.data ?? null;

  // Persistent combat log (issue #61) — 5s backstop poll; the server still
  // supports ?afterId for future incremental log fetching, but the UI currently
  // refreshes the full history on invalidation.
  const eventsQuery = useQuery({
    queryKey: queryKeys.encounterEvents(eid),
    queryFn: () => {
      const last = queryClient.getQueryData<EncounterEvent[]>(queryKeys.encounterEvents(eid));
      const headId = last && last.length > 0 ? last[last.length - 1].id : null;
      return api.get<EncounterEvent[]>(`${API}/encounters/${eid}/events`, {
        headers: headId ? { 'If-None-Match': `"${headId}"` } : undefined,
      }).catch(e => {
        if (e.status === 304 && last) return last;
        throw e;
      });
    },
    enabled: Number.isFinite(eid),
    refetchInterval: 5_000,
  });
  const events = eventsQuery.data ?? [];

  // Campaign characters — maps a combatant.characterId -> ownerUserId so a player is
  // scoped to only their own character's combatant, and feeds inline CharacterStatCards.
  // Issue #421: invalidate on character.updated SSE; poll is a dropped-stream backstop.
  const charactersQuery = useQuery({
    queryKey: queryKeys.campaignCharacters(cid),
    queryFn: () => api.get<Character[]>(`${API}/campaigns/${cid}/characters`),
    enabled: Number.isFinite(cid),
    refetchInterval: 10_000,
  });
  const characters = useMemo(() => charactersQuery.data ?? [], [charactersQuery.data]);
  const sheetsInteractive = inlineCharacterSheetsInteractive(eventStatus);
  const sheetsStatusLabel = inlineCharacterSheetsStatusLabel(
    eventStatus,
    charactersQuery.isFetching && !charactersQuery.isLoading,
  );
  // Issue #1446: track how long the CURRENT first-load `connecting` attempt has run so a
  // genuine "SSE never connects" outage degrades to overridable after a bounded grace
  // period rather than blocking forever. The effect body only re-fires when `eventStatus`
  // itself changes, so the `setTimeout` set here still fires later even though nothing
  // else re-renders while the stream stays stuck connecting.
  useEffect(() => {
    const isConnectingLike = eventStatus === null || eventStatus === 'connecting';
    if (!isConnectingLike) {
      connectingSinceRef.current = null;
      setConnectingGraceElapsed(false);
      return;
    }
    if (connectingSinceRef.current == null) connectingSinceRef.current = Date.now();
    if (isConnectingGraceElapsed(connectingSinceRef.current, Date.now())) {
      setConnectingGraceElapsed(true);
      return;
    }
    const remaining = CONNECTING_GRACE_MS - (Date.now() - connectingSinceRef.current);
    const timer = setTimeout(() => setConnectingGraceElapsed(true), remaining);
    return () => clearTimeout(timer);
  }, [eventStatus]);

  const encounterSync = deriveEncounterSyncState({
    eventStatus,
    readStale: encounterReadStale,
    resyncPending,
    staleIdentity,
    connectingGraceElapsed,
  });
  // Issue #1446, final review round: every precondition the "continue anyway" override
  // needs to authorize anything, named once — see `encounterOverrideAuthorized`'s doc for
  // the full enumeration and why each one is there. Five prior review rounds each found a
  // different transition that silently satisfied some of these and bypassed one:
  // canDmWrite alone (a demoted player kept acting), then campaign/identity match (a
  // cross-campaign or cross-identity carry-over), and now staleIdentity — AuthProvider's
  // documented contract for a cached-identity restore is that membership may be obsolete,
  // so the override must be neither offerable nor valid while it is true, however long
  // the outage has lasted or who confirmed it.
  const overrideAuthority: EncounterOverrideAuthority = {
    canDmWrite,
    staleIdentity,
    campaignId: cid,
    userId: me?.user.id ?? null,
  };
  // A confirmed override is scoped to ONE outage — consumed the moment the stream is live
  // again, so a later, separate outage prompts again rather than silently sailing through
  // on a stale confirmation. ALSO revoked the instant it is no longer authorized (lost DM
  // authority, or the identity went stale) — regaining authority requires a fresh
  // confirmation rather than silently resuming the earlier one.
  useEffect(() => {
    setEncounterSyncOverride((prev) =>
      revokeEncounterOverrideIfUnauthorized(
        settleEncounterOverride(prev, encounterSync),
        overrideAuthority.canDmWrite && !overrideAuthority.staleIdentity,
      ),
    );
  }, [encounterSync, overrideAuthority.canDmWrite, overrideAuthority.staleIdentity]);
  // Belt-and-braces alongside the effect above: `encounterOverrideAuthorized` is THE
  // single gate (every precondition, including the campaign/identity tag match),
  // re-evaluated synchronously at render time too — so there is no one-render gap between
  // any precondition changing and the stored flag actually being treated as inactive,
  // where a disqualified viewer's mutations could still slip through.
  const effectiveEncounterSyncOverride: EncounterOverrideState = encounterOverrideAuthorized(
    encounterSyncOverride,
    overrideAuthority,
  )
    ? encounterSyncOverride
    : ENCOUNTER_OVERRIDE_INACTIVE;
  const riskyBlocked = encounterActionsBlocked(encounterSync, effectiveEncounterSyncOverride);
  // Issue #1446 fix: the "continue anyway" acknowledgement is a DM decision (per the
  // issue text) — a player confirming it would re-enable their own owned-combatant HP /
  // death-save / action mutations against possibly-stale data, and a stale-identity
  // viewer confirming it would authorize mutations against a membership snapshot that may
  // no longer be true (final review round). Neither has a path to ever set
  // encounterSyncOverride.active; they stay blocked (with the informational banner) for
  // the duration.
  const encounterSyncOverrideOfferable =
    overrideAuthority.canDmWrite
    && !overrideAuthority.staleIdentity
    && encounterOverrideOfferable(encounterSync)
    && !effectiveEncounterSyncOverride.active;
  // Issue #1446 review fix: once the override is active, controls ARE actionable again —
  // the base banner's "combat actions are paused" copy would be actively false (and
  // contradict the enabled controls for both screen-reader and sighted users). Swap to an
  // override-aware i18n variant that keeps the stale-data warning without that claim.
  const overrideBannerKey = effectiveEncounterSyncOverride.active ? encounterSyncOverrideBannerKey(encounterSync) : null;
  const encounterSyncBanner = overrideBannerKey ? t(overrideBannerKey) : encounterSyncBannerMessage(encounterSync);
  const encounterSyncChip = encounterSyncChipLabel(encounterSync);
  const encounterSyncLastSyncTitle = useMemo(() => {
    if (syncRevision?.lastSyncAt == null) return undefined;
    return `Last synced ${formatDateTime(syncRevision.lastSyncAt, {
      dateStyle: 'medium',
      timeStyle: 'short',
    })}`;
  }, [syncRevision?.lastSyncAt, formattingLocale, timeFormat]);

  // Issue #431: tailor preparing next-steps to whether a monster pack is installed.
  const packsQuery = useQuery({
    queryKey: ['rules', 'packs'],
    queryFn: () => api.get<RulePack[]>(`${API}/rules/packs`),
    enabled: Number.isFinite(cid) && isDm,
    staleTime: 60_000,
  });
  const campaignHasCompendium = (packsQuery.data?.length ?? 0) > 0;

  const notFound = encounterQuery.error instanceof ApiError && encounterQuery.error.status === 404;
  const loadError =
    encounterQuery.error && !notFound
      ? translateApiError(encounterQuery.error, t, { fallbackKey: 'encounters.errors.loadEncounter' })
      : null;
  const refetchEncounter = useCallback(() => invalidateEncounter(queryClient, eid), [queryClient, eid]);
  // Ordinary Refresh clears a stale action banner (#430) — distinct from passive
  // poll/SSE invalidation, which must leave an actionable failure visible.
  const refreshEncounter = useCallback(() => {
    setActionError(null);
    refetchEncounter();
  }, [refetchEncounter]);
  // Post-attach map-setup guidance (issue #409) — shown right after a generated map is
  // attached, dismissible, and reset when navigating to a different encounter.
  const [showMapGuidance, setShowMapGuidance] = useState(false);
  // Drop action errors (and any lingering map-attach guidance) when navigating to a
  // different encounter.
  // Issue #1446 review fix (round 3) — the encounter-switch lifecycle, considered as a
  // whole rather than one symptom at a time. `RunSessionPage` is reused across encounters
  // within the SAME campaign, so every piece of sync state here has to be deliberately
  // classified as ENCOUNTER-scoped (this encounter's own history — reset on `eid` change)
  // or STREAM/SESSION-scoped (belongs to the campaign SSE connection or the DM's outage
  // acknowledgement, which both outlive any one encounter — must NOT reset here):
  //
  //   ENCOUNTER-scoped (reset below):
  //     - actionError / showMapGuidance: this encounter's own action-error and
  //       post-map-attach UI state.
  //     - encounterReadStale / resyncPending: this encounter's own REST-read staleness.
  //     - syncRevision: this encounter's own updatedAt/lastSyncAt watermark.
  //
  //   STREAM/SESSION-scoped (deliberately left untouched here):
  //     - eventStatus: tracks `useCampaignEvents(cid, …)` below, keyed on `cid` — the
  //       SAME connection survives an encounter switch, and the reconnect loop only calls
  //       onStatusChange when the status actually CHANGES, so a still-`connected` stream
  //       never re-announces itself. Nulling this here used to strand the derived sync
  //       state on a stale `connecting` (review round 2 regression).
  //     - connectingSinceRef / connectingGraceElapsed: how long the CURRENT connecting
  //       attempt has run is a stream-level fact, computed entirely inside the
  //       `[eventStatus]`-keyed effect below. Resetting these two HERE, on a dependency
  //       array that does not include `eventStatus`, used to leave that other effect
  //       never re-firing (its own dependency hadn't changed) — so the grace timer could
  //       never be re-armed for the new encounter and it sat on `Connecting` forever with
  //       no override offered (review round 3 regression: the exact permanent block this
  //       issue exists to remove). They now live ENTIRELY in that other effect.
  //     - encounterSyncOverride: a "continue anyway" acknowledgement about the STREAM's
  //       health, not about any one encounter's data — an outage that started while
  //       viewing encounter A is still the same outage after switching to encounter B, so
  //       clearing it here would reintroduce exactly the "confirm on every click" friction
  //       the issue asks to eliminate. Settled only by `settleEncounterOverride` (stream
  //       back to `live`), by losing DM authority, or by a campaign/identity change (see
  //       `campaignStreamKey` above) — never by an encounter switch.
  useEffect(() => {
    setActionError(null);
    setShowMapGuidance(false);
    setEncounterReadStale(false);
    setResyncPending(false);
    setSyncRevision(null);
  }, [eid]);

  // Live updates over SSE (issue #4) — players waiting for the DM to hit "Start" (or
  // take a turn, adjust HP, …) see it pushed instantly. Rather than a manual reload, an
  // event just invalidates the encounter's reads and Query refetches. On a remote delete,
  // bounce back to the encounters list rather than surfacing a 404.
  // Issue #421: character.updated (and membership.revoked) have no encounterId — handle
  // them BEFORE the encounterId filter so inline sheet cards refresh on sheet edits.
  useCampaignEvents(Number.isFinite(cid) ? cid : undefined, {
    onEvent: useCallback(
      (event) => {
        if (event.type === 'party.rest.updated') {
          // This one event represents the whole atomic recovery batch. Linked
          // encounter rows emit their own post-commit encounter.updated frame.
          invalidateCampaignCharacters(queryClient, cid);
          return;
        }
        // Sheet / membership frames have no encounterId — must not fall into the
        // encounterId filter below (that was the #421 bug: character events ignored).
        if (shouldInvalidateInlineCharacters(event)) {
          invalidateCampaignCharacters(queryClient, cid);
          // Issue #1901 & #1900 review: an inventory equip/unequip or slot/spell edit emits
          // character.updated — invalidate derived encounter actions AND the turn workspace query.
          invalidateEncounterActions(queryClient, eid);
          if (event.type === 'character.updated' && Number.isFinite(eid)) {
            void queryClient.invalidateQueries({ queryKey: queryKeys.encounterTurn(eid) });
          }
          return;
        }
        // Issue #415: a DM check request landed (or was answered) — refetch the campaign
        // check-request feed so the targeted player's prompt appears / the DM's panel updates.
        if (event.type === 'check.requested' || event.type === 'check.resolved') {
          invalidateCampaignCheckRequests(queryClient, cid);
          return;
        }
        if (event.type !== 'encounter.updated' && event.type !== 'encounter.deleted' && event.type !== 'encounter.ping') return;
        if (event.encounterId !== eid) return;
        if (event.type === 'encounter.deleted') {
          navigate(`/c/${cid}/encounters`);
          return;
        }
        // A ping is a one-shot transient marker — render it, don't refetch the encounter.
        if (event.type === 'encounter.ping') {
          if (event.ping) addPing(event.ping);
          return;
        }
        invalidateEncounter(queryClient, eid);
        // Issue #1902 rework (round 12, devin; narrowed round 19, codex P2): several
        // in-combat writes mirror HP/conditions or a spell-slot/resource spend onto the
        // linked character SHEET (action-resolver's apply path, `adjustCombatantResource`)
        // while emitting only `encounter.updated` — no `character.updated` frame, so
        // `shouldInvalidateInlineCharacters` above never fires for them. With
        // `campaignCharacters` left stale, `ResourceTrackerPanel`'s cached `char.updatedAt`
        // (the `expectedUpdatedAt` CAS token it sends on a spell-slot spend) goes stale
        // too — a player just healed or damaged mid-combat could get a spurious 409 on
        // their VERY NEXT, otherwise-valid slot spend, for up to the 10s poll interval.
        // Round 12 invalidated on EVERY `encounter.updated` frame to close this, but most
        // frames (an ordinary roll, a token move) mirror no sheet at all — refetching the
        // whole campaign character list on each one is wasted work during a busy fight.
        // The server now tags exactly the frames that mirrored a sheet with
        // `sheetMirrored`, so this only piggybacks the invalidation when it's actually
        // needed.
        if (event.sheetMirrored) invalidateCampaignCharacters(queryClient, cid);
      },
      [eid, cid, navigate, queryClient, addPing],
    ),
    // The stream was down for a while — refetch encounter + character sheets.
    onReconnect: useCallback(() => {
      setResyncPending(true);
      invalidateEncounter(queryClient, eid);
      invalidateCampaignCharacters(queryClient, cid);
      invalidateCampaignCheckRequests(queryClient, cid);
      // Same staleness the character.updated SSE branch above fixes (issue #1900
      // review): a dropped-then-recovered stream must not leave the Spellbook's
      // /turn-sourced slots/spells stale either.
      void queryClient.invalidateQueries({ queryKey: queryKeys.encounterTurn(eid) });
    }, [queryClient, eid, cid]),
    // Parser recovery (connection stayed up) — same catch-up refetch.
    onStreamRecovery: useCallback(() => {
      setResyncPending(true);
      invalidateEncounter(queryClient, eid);
      invalidateCampaignCharacters(queryClient, cid);
      invalidateCampaignCheckRequests(queryClient, cid);
      void queryClient.invalidateQueries({ queryKey: queryKeys.encounterTurn(eid) });
    }, [queryClient, eid, cid]),
    onStatusChange: useCallback((status: CampaignEventsStatus) => setEventStatus(status), []),
  });

  // The persisted event stream is the single announcement source for turn, HP,
  // condition, death, note, override, and correction updates. ID-based tracking
  // suppresses duplicate SSE/mutation/poll refetches; initial history is a silent
  // baseline, while reconnect bursts are announced together so no entry is lost.
  const combatLogAnnouncementRef = useRef<{
    encounterId: number;
    cursor: CombatLogAnnouncementCursor;
  } | null>(null);
  useEffect(() => {
    if (!eventsQuery.data) return;

    const previous = combatLogAnnouncementRef.current;
    const cursor = previous?.encounterId === eid ? previous.cursor : null;
    const advanced = advanceCombatLogAnnouncements(eventsQuery.data, cursor);
    combatLogAnnouncementRef.current = { encounterId: eid, cursor: advanced.cursor };

    const message = formatCombatLogAnnouncementBatch(advanced.appendedEvents);
    if (message) {
      // ID-based cursor already skips known events; dedupeKey is a belt-and-braces
      // guard if the same append batch is announced twice after a reconnect race.
      // Compact: count + first/last id (not a joined list of every event id).
      const appended = advanced.appendedEvents;
      const firstId = appended[0]!.id;
      const lastId = appended[appended.length - 1]!.id;
      announce(message, {
        dedupeKey: `combat-log:${eid}:${appended.length}:${firstId}:${lastId}`,
      });
    }
  }, [eid, eventsQuery.data, announce]);

  // Ending an encounter does not currently append a combat-log row. Retain that
  // useful status announcement without restoring the old turn/HP diff path, which
  // would duplicate the persisted-event announcements above.
  const previousEncounterStatusRef = useRef<{ encounterId: number; status: EncounterWithCombatants['status'] } | null>(null);
  useEffect(() => {
    if (!encounter) return;
    const previous = previousEncounterStatusRef.current;
    if (previous?.encounterId === eid && previous.status !== encounter.status && encounter.status === 'ended') {
      announce('Encounter ended');
    }
    previousEncounterStatusRef.current = { encounterId: eid, status: encounter.status };
  }, [eid, encounter, announce]);

  const myUserId = me?.user.id;
  const ownedCharacterIds = useMemo(
    () =>
      new Set(
        characters.filter((c) => c.ownerUserId != null && myUserId != null && c.ownerUserId === String(myUserId)).map((c) => c.id),
      ),
    [characters, myUserId],
  );
  // Precomputed id→character map so the combatant list's per-row card lookup is O(1)
  // rather than a `.find` over all characters on every render (issue: large encounters).
  const charactersById = useMemo(() => new Map(characters.map((c) => [c.id, c])), [characters]);

  function canEditCombatantPermission(c: Combatant): boolean {
    // An ended encounter is immutable server-side (assertMutable, #163/#470): the interactive
    // card + ApplyDamageBar would only fire a PATCH the server always rejects. Gate on
    // status like canSetInitiative so an ended encounter renders read-only (#368).
    if (encounter?.status === 'ended') return false;
    if (canDmWrite) return true;
    if (!canPlayerWrite) return false;
    return c.characterId != null && ownedCharacterIds.has(c.characterId);
  }

  function canEditCombatant(c: Combatant): boolean {
    if (riskyBlocked) return false;
    return canEditCombatantPermission(c);
  }

  // A character card rolled damage — surface the one-tap "apply to target" bar. A
  // non-positive total (a 0/negative damage expr) has nothing to apply, so clear any
  // prior pending amount rather than leaving a stale bar from an earlier roll.
  const onApplyDamageRolled = useCallback((amount: number, label: string, diceTotal: number | undefined, actorCombatantId?: number) => {
    setPendingApply(amount > 0 ? { id: ++pendingApplySequence.current, amount, label, diceTotal, actorCombatantId } : null);
  }, []);

  useRollApplyDamageBridge(encounter?.status === 'running' ? onApplyDamageRolled : undefined);

  const onUseActionRequested = useCallback(
    (combatantId: number, actorName: string, actionIndex: number, actionName: string, spec: ActionSpec) => {
      setPendingApply(null);
      setPendingActionUse({ combatantId, actorName, actionIndex, actionName, spec });
    },
    [],
  );

  const onAoeHitLayoutChange = useCallback((layout: AoeHitLayout | null) => {
    setAoeHitLayout(layout);
  }, []);

  const reportError = useCallback((err: unknown) => {
    setActionError(makeActionError(translateApiError(err, t, { fallbackKey: 'encounters.errors.actionFailed' })));
  }, [t]);
  const surfaceActionError = useCallback((message: string | null) => {
    setActionError(message ? makeActionError(message) : null);
  }, []);
  const reportTurnAdvanceError = useCallback((err: unknown) => {
    // Issue #1446 review fix: this used to hardcode its own English string here, so the
    // errors.json TURN_ALREADY_ADVANCED catalog entry — including the "someone else
    // already advanced the turn" wording this issue asked for — was dead code; nothing
    // ever rendered it. Route through the same i18n seam every other server error uses.
    if (err instanceof ApiError && err.code === 'TURN_ALREADY_ADVANCED') {
      surfaceActionError(t('errors.TURN_ALREADY_ADVANCED'));
      return;
    }
    reportError(err);
  }, [reportError, surfaceActionError, t]);

  // Issue #580 — the ambiguous-outcome gate. When a combat write times out or its socket
  // drops, the outcome is genuinely unknown: the server may have committed. Showing a
  // plain "failed" would invite a re-click, which is a NEW intent (new key) and really
  // would double the damage. So we say we're checking, re-read committed state, and
  // refuse further non-idempotent actions until that read lands.
  const [reconcile, setReconcile] = useState<ReconcileState>(IDLE_RECONCILE);
  const enterReconciling = useCallback(() => {
    setReconcile((prev) => beginReconcile(prev, Date.now()));
    setActionError(null);
  }, []);
  const reconcileBlocks = blocksFurtherActions(reconcile);

  const undoAction = useMutation({
    mutationFn: (token: ActionUndoToken) => api.post(`${API}/encounters/${eid}/actions/undo`, token),
    onSuccess: () => {
      void invalidateEncounter(queryClient, eid);
      setActionUndo(null);
    },
    onError: reportError,
  });

  const dismissCompetingRecoveryUndos = useCallback(() => {
    setActionUndo(null);
    setPendingCombatantUndo(null);
    setDismissTokenUndoNonce((nonce) => nonce + 1);
  }, []);
  const dismissRecoveryUndosForTokenBatch = useCallback(() => {
    if (!isCurrentCombatantUndoEncounter(eid, activeEncounterIdRef.current) || trashedEncounterIdsRef.current.has(eid)) return false;
    setActionUndo(null);
    setPendingCombatantUndo(null);
    return true;
  }, [eid]);

  // Encounter-level run controls (roll-initiative / start / next-turn / end / reopen).
  // These are mutually exclusive DM header actions, so one shared pending flag gating
  // just the header group is correct — unlike the old global lock, it never touches the
  // combatant rows. Each settles by invalidating the encounter's reads.
  // Issue #466: reopen may carry `hpResync` decisions when sheets diverged after End.
  const runControl = useMutation({
    mutationFn: ({
      action,
      body,
    }: {
      action: 'roll-initiative' | 'start' | 'next-turn' | 'end' | 'reopen';
      body?: { hpResync?: Array<{ combatantId: number; direction: HpResyncDirection }> };
    }) => api.post(`${API}/encounters/${eid}/${action}`, body),
    onMutate: () => setActionError(null),
    onError: reportError,
    onSettled: () => invalidateEncounter(queryClient, eid),
  });

  const deleteEncounterMut = useMutation({
    mutationFn: ({ encounterId }: { encounterId: number; updatedAt?: string }) => api.delete(`${API}/encounters/${encounterId}`),
    onMutate: () => setActionError(null),
    onError: reportError,
    onSuccess: (_result, { encounterId, updatedAt }) => {
      trashedEncounterIdsRef.current.add(encounterId);
      if (updatedAt) trashedEncounterRevisionsRef.current.set(encounterId, updatedAt);
      if (encounterId === activeEncounterIdRef.current) {
        setConfirmDelete(false);
        dismissCompetingRecoveryUndos();
        setPendingTrashUndo({ encounterId });
      }
    },
  });

  // General per-combatant patch (conditions, death saves, initiative, rename, max/temp HP,
  // token position). Non-optimistic but per-combatant: onMutate flags just this row as
  // pending, onSettled clears it and reconciles. Concurrent edits to different combatants
  // don't block each other.
  const combatantPatch = useMutation({
    mutationFn: ({ combatantId, patch }: { combatantId: number; patch: Record<string, unknown> }) =>
      api.patch(`${API}/encounters/${eid}/combatants/${combatantId}`, patch),
    onMutate: ({ combatantId }) => {
      setActionError(null);
      markCombatantPending(combatantId, true);
    },
    onError: reportError,
    onSettled: (_data, _err, { combatantId }) => {
      markCombatantPending(combatantId, false);
      invalidateEncounter(queryClient, eid);
    },
  });

  const combatantTurnState = useMutation({
    mutationFn: ({ combatantId, patch }: { combatantId: number; patch: Record<string, unknown> }) =>
      api.post(`${API}/encounters/${eid}/combatants/${combatantId}/turn-state`, patch),
    onMutate: () => setActionError(null),
    onError: reportError,
    onSettled: () => {
      invalidateEncounter(queryClient, eid);
      void queryClient.invalidateQueries({ queryKey: queryKeys.encounterTurn(eid) });
    },
  });

  // Issue #1900: the in-combat Spellbook's slot spend/restore. Optimistically flips the
  // affected pip in the SHARED /turn cache entry (the same `queryKeys.encounterTurn(eid)`
  // TurnWorkspace itself now reads, since the duplicate child query was removed) so a click
  // feels instant; a 4xx/5xx rolls the cache back to its pre-click snapshot and surfaces a
  // toast, rather than leaving a pip showing a spend that never happened server-side.
  const updateSpellSlot = useMutation({
    mutationFn: ({ characterId, level, delta }: { characterId: number; level: number; delta: number }) =>
      api.post<Character>(`${API}/characters/${characterId}/spell-slots`, { level, delta }),
    onMutate: async ({ level, delta }) => {
      setActionError(null);
      await queryClient.cancelQueries({ queryKey: queryKeys.encounterTurn(eid) });
      const previous = queryClient.getQueryData<TurnWorkspaceData>(queryKeys.encounterTurn(eid));
      if (previous) {
        queryClient.setQueryData<TurnWorkspaceData>(queryKeys.encounterTurn(eid), {
          ...previous,
          spellSlots: applyOptimisticSpellSlotDelta(previous.spellSlots, level, delta),
        });
      }
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(queryKeys.encounterTurn(eid), context.previous);
      setActionError(makeActionError(translateApiError(err, t, { fallbackKey: 'encounters.errors.spellSlot' })));
    },
    onSettled: () => {
      invalidateEncounter(queryClient, eid);
      invalidateCampaignCharacters(queryClient, cid);
    },
  });

  // Turn advancement (issue #580). Both directions of protection travel together: the
  // operation id makes a RETRY replay, and expectedCurrentCombatantId makes a RACE with
  // another device a 409 rather than a second advance.
  const endTurn = useKeyedMutation({
    mutationFn: ({
      expectedCurrentCombatantId,
      idempotencyKey,
    }: {
      expectedCurrentCombatantId: number;
      idempotencyKey: string;
    }) => api.post(`${API}/encounters/${eid}/end-turn`, { expectedCurrentCombatantId, idempotencyKey }),
    onMutate: () => setActionError(null),
    onError: (err) => {
      if (isAmbiguousOutcome(err)) enterReconciling();
      else reportTurnAdvanceError(err);
    },
    onSettled: () => {
      invalidateEncounter(queryClient, eid);
      void queryClient.invalidateQueries({ queryKey: queryKeys.encounterTurn(eid) });
    },
  });

  const nextTurnMut = useKeyedMutation({
    mutationFn: ({
      expectedCurrentCombatantId,
      idempotencyKey,
    }: {
      expectedCurrentCombatantId: number | null;
      idempotencyKey: string;
    }) => api.post(`${API}/encounters/${eid}/next-turn`, { expectedCurrentCombatantId, idempotencyKey }),
    onMutate: () => setActionError(null),
    onError: (err) => {
      if (isAmbiguousOutcome(err)) enterReconciling();
      else reportTurnAdvanceError(err);
    },
    onSettled: () => {
      invalidateEncounter(queryClient, eid);
      void queryClient.invalidateQueries({ queryKey: queryKeys.encounterTurn(eid) });
    },
  });

  const undoTurnMut = useMutation({
    mutationFn: () => api.post(`${API}/encounters/${eid}/undo-turn`),
    onMutate: () => setActionError(null),
    onError: (err) => {
      if (isAmbiguousOutcome(err)) enterReconciling();
      else reportTurnAdvanceError(err);
    },
    onSettled: () => {
      invalidateEncounter(queryClient, eid);
      void queryClient.invalidateQueries({ queryKey: queryKeys.encounterTurn(eid) });
    },
  });

  // Drive the gate: on entering `checking`, force a fresh read of committed server state,
  // then release. Deliberately a refetch rather than a cache invalidation — the point is
  // to have actually observed server truth before the DM is allowed to act again, and an
  // invalidation only marks the data stale.
  useEffect(() => {
    if (reconcile.phase !== 'checking') return;
    let cancelled = false;
    void encounterQuery
      .refetch()
      .catch(() => undefined)
      .then(() => {
        if (!cancelled) setReconcile((prev) => completeReconcile(prev, Date.now()));
      });
    return () => {
      cancelled = true;
    };
    // encounterQuery identity changes every render; the phase transition is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reconcile.phase]);

  // Clear the "we checked" acknowledgement once the DM has seen it for a moment, so the
  // banner does not become permanent furniture on a flaky connection.
  useEffect(() => {
    if (reconcile.phase !== 'reconciled') return;
    const timer = setTimeout(() => setReconcile(clearReconcile()), 6_000);
    return () => clearTimeout(timer);
  }, [reconcile.phase, reconcile]);

  const escalationControl = useMutation({
    mutationFn: (body: { held?: boolean; override?: number | null }) =>
      api.post(`${API}/encounters/${eid}/escalation`, body),
    onMutate: () => setActionError(null),
    onError: reportError,
    onSettled: () => invalidateEncounter(queryClient, eid),
  });

  // Optimistic HP steppers (issue #73) — the headline fix. onMutate writes the guessed HP
  // straight into the query cache so the click lands instantly (no round-trip wait, no
  // disabled control); onError rebuilds from committed state plus the recorded clicks;
  // onSettled reconciles
  // against server truth, but only once the *last* of a rapid burst settles so spamming
  // ±1 doesn't trigger a refetch storm.
  //
  // Issue #580: this is the mutation the double-damage bug lived in. `useKeyedMutation`
  // mints ONE operation id per click and reuses it across the automatic retry, so a
  // committed-but-lost response is replayed by the server rather than re-applied. Retry
  // is enabled only because the key is present — the two arrive together by construction.
  const HP_MUTATION_KEY = useMemo(() => ['encounter', eid, 'hpDelta'] as const, [eid]);
  const optimisticHpQueueRef = useRef<OptimisticHpQueue>({
    encounterId: eid,
    base: undefined,
    nextSequence: 0,
    operations: new Map(),
  });
  if (optimisticHpQueueRef.current.encounterId !== eid) {
    optimisticHpQueueRef.current = {
      encounterId: eid,
      base: undefined,
      nextSequence: 0,
      operations: new Map(),
    };
  }
  const replayPendingOptimisticHpDeltas = useCallback(() => {
    const queue = optimisticHpQueueRef.current;
    if (queue.encounterId !== eid) return;
    const { base } = queue;
    if (!base) return;
    queryClient.setQueryData<EncounterWithCombatants>(queryKeys.encounter(eid), {
      ...base,
      combatants: replayOptimisticHpDeltas(
        base.combatants,
        [...queue.operations.values()]
          .sort((a, b) => a.sequence - b.sequence)
          .map(({ combatantId, delta }) => ({ combatantId, delta })),
        ruleSystem,
      ),
    });
  }, [eid, queryClient, ruleSystem]);
  const hpDelta = useKeyedMutation({
    mutationKey: HP_MUTATION_KEY,
    mutationFn: ({
      combatantId,
      delta,
      actorId,
      damageType,
      saveOutcome,
      isCrit,
      damageDice,
      idempotencyKey,
    }: {
      combatantId: number;
      delta: number;
      actorId?: number;
      damageType?: string;
      saveOutcome?: 'full' | 'half';
      isCrit?: boolean;
      damageDice?: number;
      idempotencyKey: string;
    }) =>
      api.patch<Combatant>(
        `${API}/encounters/${eid}/combatants/${combatantId}`,
        hpPatchWithActor({ hpDelta: delta, damageType, saveOutcome, isCrit, damageDice, idempotencyKey }, actorId, combatantId, isDm),
      ),
    onMutate: async ({ combatantId, delta, damageType, saveOutcome, isCrit, damageDice, idempotencyKey }) => {
      setActionError(null);
      const queue = optimisticHpQueueRef.current;
      const optimisticOperation =
        damageType === undefined &&
        saveOutcome === undefined &&
        isCrit === undefined &&
        damageDice === undefined
          ? { combatantId, delta, sequence: queue.nextSequence++ }
          : undefined;
      await queryClient.cancelQueries({ queryKey: queryKeys.encounter(eid) });
      const previous = queryClient.getQueryData<EncounterWithCombatants>(queryKeys.encounter(eid));
      // Defence data lives in the server's authoritative statblock.  Do not briefly
      // show an incorrect local HP total when damage rules are active; refetch settles it.
      if (
        previous &&
        optimisticOperation
      ) {
        if (queue.encounterId !== eid) return {};
        if (!queue.base) queue.base = previous;
        queue.operations.set(idempotencyKey, optimisticOperation);
        replayPendingOptimisticHpDeltas();
        return { encounterId: eid, optimisticOperationId: idempotencyKey };
      }
      return {};
    },
    onError: (err, _vars, ctx) => {
      const queue = optimisticHpQueueRef.current;
      if (
        ctx?.encounterId === eid &&
        queue.encounterId === eid &&
        ctx.optimisticOperationId &&
        queue.operations.delete(ctx.optimisticOperationId)
      ) {
        replayPendingOptimisticHpDeltas();
      }
      // An ambiguous failure must NOT be reported as a plain error: the optimistic HP was
      // just rolled back, but the server may in fact have applied it. Telling the DM "that
      // failed" invites a re-click that is a fresh intent and really would double the
      // damage. Hold the controls and re-read committed state instead.
      if (isAmbiguousOutcome(err)) enterReconciling();
      else reportError(err);
    },
    onSettled: () => {
      // A response can already include a later write, so successful operations stay in
      // the replay ledger until the whole burst settles instead of promoting response data.
      // Only reconcile after the last in-flight HP write of a burst settles.
      if (queryClient.isMutating({ mutationKey: HP_MUTATION_KEY }) === 1) {
        const queue = optimisticHpQueueRef.current;
        if (queue.encounterId === eid) {
          queue.base = undefined;
          queue.nextSequence = 0;
          queue.operations.clear();
        }
        invalidateEncounter(queryClient, eid);
      }
    },
  });

  const applyHpDeltaBulk = useCallback(
    async (
      applications: readonly TargetDamageApplication[],
      delta: number,
      actorId?: number,
    ) => {
      if (applications.length === 0) return;
      setActionError(null);
      await queryClient.cancelQueries({ queryKey: queryKeys.encounter(eid) });
      const previous = queryClient.getQueryData<EncounterWithCombatants>(queryKeys.encounter(eid));
      const targets = new Set(applications.map(({ combatantId }) => combatantId));
      const hasDamageMetadata = applications.some(({ damage }) =>
        damage.damageType !== undefined ||
        damage.saveOutcome !== undefined ||
        damage.isCrit !== undefined ||
        damage.damageDice !== undefined
      );
      if (
        previous &&
        !hasDamageMetadata
      ) {
        queryClient.setQueryData<EncounterWithCombatants>(queryKeys.encounter(eid), {
          ...previous,
          combatants: previous.combatants.map((c) =>
            targets.has(c.id) ? applyOptimisticHpDelta(c, delta, ruleSystem) : c,
          ),
        });
      }
      // Issue #580: one id for this apply-to-all, extended per target so each PATCH gets a
      // distinct key (the server fingerprints the payload, so one key cannot cover two
      // different combatants). This loop is a plain async function, not a TanStack
      // mutation, so it is not auto-retried and the retry hazard the keys guard does not
      // arise here — their value is that every resulting combat-log line carries the
      // operation id, so an AoE burst is identifiable as one action in the audit trail.
      // A DM manually re-running a half-failed apply-to-all still double-applies to the
      // targets that succeeded; making that safe needs a stable id on the pending-apply
      // itself and is deliberately left out of this change.
      const bulkOperationId = newOperationId();
      try {
        for (const { combatantId, damage } of applications) {
          await api.patch<Combatant>(
            `${API}/encounters/${eid}/combatants/${combatantId}`,
            hpPatchWithActor(
              { hpDelta: delta, ...damage, idempotencyKey: `${bulkOperationId}:${combatantId}` },
              actorId,
              combatantId,
              isDm,
            ),
          );
        }
        await invalidateEncounter(queryClient, eid);
      } catch (err) {
        if (previous) queryClient.setQueryData(queryKeys.encounter(eid), previous);
        // Same rule as the single-target stepper: an unknown outcome is not a failure.
        if (isAmbiguousOutcome(err)) enterReconciling();
        else reportError(err);
        throw err;
      }
    },
    [eid, queryClient, reportError, ruleSystem, enterReconciling, isDm],
  );

  const patchCombatant = useCallback(
    (combatantId: number, patch: Record<string, unknown>) => {
      const needsActor = Object.keys(patch).some((key) => HP_LOG_PATCH_KEYS.has(key));
      const actorCombatantId =
        needsActor && encounter?.status === 'running' ? (encounter.currentCombatantId ?? undefined) : undefined;
      const enriched = needsActor ? hpPatchWithActor(patch, actorCombatantId, combatantId, isDm) : patch;
      combatantPatch.mutate({ combatantId, patch: enriched });
    },
    [combatantPatch, encounter?.status, encounter?.currentCombatantId, isDm],
  );

  const deathSaveRoll = useKeyedMutation({
    mutationFn: ({ combatantId, idempotencyKey }: { combatantId: number; idempotencyKey: string }) =>
      api.post(`${API}/encounters/${eid}/combatants/${combatantId}/death-save`, { idempotencyKey }),
    onMutate: ({ combatantId }) => {
      setActionError(null);
      markCombatantPending(combatantId, true);
    },
    onError: (err) => {
      if (isAmbiguousOutcome(err)) enterReconciling();
      else reportError(err);
    },
    onSettled: (_data, _err, { combatantId }) => {
      markCombatantPending(combatantId, false);
      invalidateEncounter(queryClient, eid);
    },
  });

  // Issue #1904: server-authoritative "Roll initiative" for one combatant (the DM's own
  // bulk roll is the `rollInitiative` mutation below). The result animates through the
  // shared DiceRollOverlay/toast, same as any other campaign roll.
  const combatantInitiativeRoll = useKeyedMutation({
    mutationFn: ({ combatantId, idempotencyKey }: { combatantId: number; idempotencyKey: string }) =>
      api.post<{ combatant: Combatant; roll: DiceRoll | null }>(
        `${API}/encounters/${eid}/combatants/${combatantId}/roll-initiative`,
        { idempotencyKey },
      ),
    onMutate: ({ combatantId }) => {
      setActionError(null);
      markCombatantPending(combatantId, true);
      beginRollAnimation(`1d${activeAdapter.initiativeDie}`);
    },
    onSuccess: (data) => {
      // Issue #1904 review finding: applyDisabled, not a label heuristic — an initiative
      // roll under a non-d20 ruleset (e.g. Starforged's 1d6) otherwise passes
      // looksLikeDamageRoll's "positive, non-d20, not heal/cure-labeled" test and would
      // offer to apply the initiative value as HP damage while the apply-damage bridge is
      // active (any running encounter). This is never damage, structurally, regardless of
      // die size or label wording.
      if (data.roll) {
        showRoll(data.roll, { applyDisabled: true });
        return;
      }
      // Issue #1904 review finding: `roll` is null specifically because THIS encounter is
      // hidden (DM prep) — only the DM can even reach a hidden encounter's roll-initiative
      // action, and the shared campaign-wide dice log deliberately gets no row for it. The
      // roll still happened (data.combatant.initiative/initiativeBreakdown are committed);
      // cancelling the animation into nothing left the roller watching dice tumble and then
      // vanish with no result. Synthesize a LOCAL, never-persisted DiceRoll from the
      // committed breakdown so the one person entitled to see it still gets the same toast
      // every other roll shows, rather than silence.
      const breakdown = data.combatant.initiativeBreakdown;
      if (breakdown == null || breakdown.roll == null || breakdown.total == null) {
        cancelRollAnimation();
        return;
      }
      const expr = breakdown.modifier === 0 ? `1d${breakdown.die}` : `1d${breakdown.die}${breakdown.modifier > 0 ? '+' : ''}${breakdown.modifier}`;
      const localRoll: DiceRoll = {
        id: -data.combatant.id, // synthetic, negative so it can never collide with a real row id
        campaignId: cid,
        rollerUserId: me?.user.id !== undefined ? String(me.user.id) : '',
        rollerName: me?.user.displayName || me?.user.username || '',
        expr,
        rolls: [breakdown.roll],
        total: breakdown.total,
        label: `${data.combatant.name} · Initiative`,
        source: 'rolled',
        createdAt: new Date().toISOString(),
      };
      showRoll(localRoll, { applyDisabled: true });
    },
    onError: (err) => {
      cancelRollAnimation();
      if (isAmbiguousOutcome(err)) enterReconciling();
      else reportError(err);
    },
    onSettled: (_data, _err, { combatantId }) => {
      markCombatantPending(combatantId, false);
      invalidateEncounter(queryClient, eid);
    },
  });

  const patchCombatantTurnState = useCallback(
    (combatantId: number, patch: Record<string, unknown>) => combatantTurnState.mutate({ combatantId, patch }),
    [combatantTurnState],
  );

  /** One server roll drives both the death-save outcome and its shared dice-log entry. */
  const rollDeathSave = useCallback(
    (combatant: Pick<Combatant, 'id'>) => deathSaveRoll.mutate({ combatantId: combatant.id }),
    [deathSaveRoll],
  );

  /** One server roll drives the combatant's initiative and (unless hidden) its shared dice-log entry. */
  const rollCombatantInitiative = useCallback(
    (combatant: Pick<Combatant, 'id'>) => combatantInitiativeRoll.mutate({ combatantId: combatant.id }),
    [combatantInitiativeRoll],
  );

  const rollInitiative = () => runControl.mutate({ action: 'roll-initiative' });
  const startEncounter = () => runControl.mutate({ action: 'start' });
  // Issue #580: next-turn no longer rides the generic (unkeyed) runControl mutation. It
  // carries an operation id AND the combatant the DM believes holds the turn, so a lost
  // response replays and a co-DM's simultaneous advance conflicts instead of skipping.
  const nextTurn = () =>
    nextTurnMut.mutate({
      expectedCurrentCombatantId: encounter?.status === 'running' ? (encounter.currentCombatantId ?? null) : null,
    });
  const undoTurn = () => undoTurnMut.mutate();
  const toggleEscalationHold = (held: boolean) => escalationControl.mutate({ held });
  const clearEscalationOverride = () => escalationControl.mutate({ override: null });
  const applyEscalationOverride = () => {
    const value = Number(escalationOverrideDraft);
    if (!Number.isInteger(value) || value < 0 || value > 6) {
      surfaceActionError('Escalation override must be a whole number from 0 to 6.');
      return;
    }
    escalationControl.mutate({ override: value });
  };
  // Close the confirm on success *or* failure so a rejected End (e.g. stale
  // preparing status) does not leave the modal parked over the error banner (#420).
  const endEncounter = () =>
    runControl.mutate(
      { action: 'end' },
      {
        onSuccess: () => setConfirmEnd(false),
        onError: () => setConfirmEnd(false),
      },
    );
  const hpSyncConflicts: HpSyncConflict[] = encounter?.hpSyncConflicts ?? [];
  const reopenEncounter = () => {
    const hpResync =
      hpSyncConflicts.length > 0
        ? hpSyncConflicts.map((c) => ({
            combatantId: c.combatantId,
            direction: hpResyncChoices[c.combatantId] ?? ('pull_sheet' as HpResyncDirection),
          }))
        : undefined;
    runControl.mutate(
      { action: 'reopen', body: hpResync ? { hpResync } : undefined },
      {
        onSuccess: () => {
          setConfirmReopen(false);
          setHpResyncChoices({});
        },
        onError: () => setConfirmReopen(false),
      },
    );
  };
  const deleteEncounter = () => deleteEncounterMut.mutate({ encounterId: eid, updatedAt: encounter?.updatedAt });
  async function undoTrashEncounter() {
    const sourceEncounterId = pendingTrashUndo?.encounterId;
    if (sourceEncounterId == null) return;
    await api.post(`${API}/encounters/${sourceEncounterId}/restore`);
    trashedEncounterIdsRef.current.delete(sourceEncounterId);
    trashedEncounterRevisionsRef.current.delete(sourceEncounterId);
    setPendingTrashUndo(null);
    await invalidateEncounter(queryClient, sourceEncounterId);
  }
  const reopenChoicesComplete =
    hpSyncConflicts.length === 0 || hpSyncConflicts.every((c) => hpResyncChoices[c.combatantId] != null);

  // Issue #702: how many combatants still need an initiative roll. Used to keep the
  // Roll-initiative button honest — disabled (rather than a silent no-op server call)
  // once everyone has a value, and relabeled to "Roll remaining (N)" for a partial
  // roster (e.g. reinforcements landing at null initiative mid-fight).
  const needsInitiativeCount = encounter
    ? encounter.combatants.filter((c) => c.initiative === null || c.initiative === undefined).length
    : 0;

  // Issue #469: the server rejects Start on an empty roster (it would otherwise flip
  // to 'running' with nobody in the turn order). Mirror that here so the DM sees a
  // disabled control with an explanation instead of a round-trip 400.
  const hasNoCombatants = encounter ? encounter.combatants.length === 0 : true;

  // Issue #431: preparing banner tailored to auto-added party / enemies / map / packs.
  const preparingSetupGuidance = useMemo(() => {
    if (!encounter || encounter.status !== 'preparing') return null;
    return preparingGuidance({
      partyCombatantCount: encounter.combatants.filter((c) => c.kind === 'character').length,
      enemyCombatantCount: encounter.combatants.filter((c) => c.kind === 'monster' || c.kind === 'npc').length,
      hasMap: encounter.mapAttachmentId != null,
      campaignHasActiveParty: characters.some((c) => c.status === 'active'),
      campaignHasCompendium,
    });
  }, [encounter, characters, campaignHasCompendium]);

  // Issue #420: drop confirm dialogs that the current status no longer allows
  // (e.g. End left open after a peer/SSE transition out of running).
  const encounterStatus = encounter?.status;
  useEffect(() => {
    if (!encounterStatus) return;
    if (!isLifecycleConfirmValid('end', encounterStatus)) setConfirmEnd(false);
    if (!isLifecycleConfirmValid('reopen', encounterStatus)) setConfirmReopen(false);
    if (!isLifecycleConfirmValid('delete', encounterStatus)) setConfirmDelete(false);
  }, [encounterStatus]);

  const removeCombatant = (combatantId: number) => {
    const snapshot = encounter?.combatants.find((combatant) => combatant.id === combatantId);
    const requestEncounterId = eid;
    const removalKey = `${requestEncounterId}:${combatantId}`;
    const idempotencyKey = combatantRemovalKeys.current.get(removalKey) ?? newOperationId();
    combatantRemovalKeys.current.set(removalKey, idempotencyKey);
    setActionError(null);
    markCombatantPending(combatantId, true);
    api
      .delete<CombatantRemoveResult>(`${API}/encounters/${requestEncounterId}/combatants/${combatantId}`, { json: { idempotencyKey } })
      .then(({ undoToken }) => {
        combatantRemovalKeys.current.delete(removalKey);
        if (
          !isCurrentCombatantUndoEncounter(requestEncounterId, activeEncounterIdRef.current) ||
          trashedEncounterIdsRef.current.has(requestEncounterId)
        ) return;
        setConfirmRemoveCombatantId(null);
        dismissCompetingRecoveryUndos();
        setPendingCombatantUndo({ name: snapshot?.name ?? 'Combatant', undoToken, encounterId: requestEncounterId });
        invalidateEncounter(queryClient, requestEncounterId);
      })
      .catch((error) => {
        // A response from the application conclusively rejected the intent. Keep
        // the key for transient failures (including retryable HTTP 408/425/429) and
        // ambiguous mutation timeouts, so Retry remains a safe replay even when the
        // server committed first.
        if (!isTransientError(error) && !isAmbiguousMutation(error)) combatantRemovalKeys.current.delete(removalKey);
        if (isCurrentCombatantUndoEncounter(requestEncounterId, activeEncounterIdRef.current)) reportError(error);
      })
      .finally(() => {
        if (isCurrentCombatantUndoEncounter(requestEncounterId, activeEncounterIdRef.current)) markCombatantPending(combatantId, false);
      });
  };

  async function undoRemoveCombatant() {
    if (!pendingCombatantUndo) return;
    if (pendingCombatantUndo.encounterId !== eid) {
      setPendingCombatantUndo(null);
      return;
    }
    const requestEncounterId = pendingCombatantUndo.encounterId;
    const undoToken = pendingCombatantUndo.undoToken;
    try {
      await api.post(`${API}/encounters/${requestEncounterId}/combatants/undo-remove`, { undoToken });
      setPendingCombatantUndo((pending) => pending?.undoToken === undoToken ? null : pending);
      await invalidateEncounter(queryClient, requestEncounterId);
    } catch (err) {
      if (isCurrentCombatantUndoEncounter(requestEncounterId, activeEncounterIdRef.current)) reportError(err);
      throw err;
    }
  }

  useEffect(() => {
    activeEncounterIdRef.current = eid;
    setPendingCombatantUndo(null);
    setPendingCombatantIds(new Set());
  }, [eid]);

  // Battle map (issue #39): attach/clear the encounter's map image (DM only). Also the seam
  // for the VTT grid config + fog of war writes (issue #40) — all DM-only PATCHes to the
  // encounter; the SSE `encounter.updated` signal then propagates them to every other client.
  const encounterPatchQueue = useRef<Promise<void>>(Promise.resolve());
  const encounterPatchSequence = useRef(0);
  const activeEncounterIdRef = useRef(eid);
  activeEncounterIdRef.current = eid;
  const gridDefaultAttempts = useRef(new Set<string>());
  // #1589 — a default-normalization attempt that DEDUPES against another in-flight PATCH
  // owning the same pending key (see `queueEncounterPatch` below) registers a wake-up here,
  // keyed by that pending key. The bug this fixes: the dedup branch returns before recording
  // any default-attempt intent, so nothing marked that a retry was still owed. The retry used
  // to happen to work anyway, but only because the OWNING request's optimistic write (when it
  // was itself a default attempt) diverged the query cache, and the eventual failure-driven
  // refetch — differing from that diverged cache — changed `encounter`'s object reference and
  // re-ran the effect below. When the owning request is a plain user edit instead (no
  // optimistic write) and fresh server truth already arrived showing the same missing fields
  // before that edit settles, the settle's own refetch reports THE SAME missing fields the
  // effect already saw: React Query's structural sharing keeps the same reference, the effect
  // never re-runs, and the retry is lost — permanently, for the life of the page. See
  // `attemptGridDefaults` below: it is invoked BOTH by the effect (on a real reference change)
  // and by this wake-up (the instant the pending key frees), so the retry no longer depends on
  // which of those two things happens to occur.
  const gridDefaultRetryOnFree = useRef(new Map<string, () => void>());
  const setMap = useMutation({
    mutationFn: ({
      encounterId,
      patch,
      expectedUpdatedAt,
    }: {
      encounterId: number;
      patch: Record<string, unknown>;
      queueId: string;
      pendingKey: string;
      defaultAttemptKey?: string;
      expectedUpdatedAt?: string;
    }) => api.patch<EncounterWithCombatants>(`${API}/encounters/${encounterId}`, { ...patch, expectedUpdatedAt }),
    onMutate: (variables) => {
      if (variables.encounterId !== activeEncounterIdRef.current) return;
      setActionError(null);
      setEncounterPatchConflict(null);
    },
    onError: (error, variables) => {
      if (variables.defaultAttemptKey) gridDefaultAttempts.current.delete(variables.defaultAttemptKey);
      if (variables.encounterId !== activeEncounterIdRef.current) return;
      if (isStaleWrite(error)) {
        if (!variables.defaultAttemptKey) {
          setEncounterPatchConflict('Another device saved a newer encounter version. Your edit was not applied; the latest encounter has been reloaded.');
        }
      } else reportError(error);
    },
    onSuccess: (updated, variables) => {
      lastLocalEncounterRevision.current.set(variables.encounterId, updated.updatedAt);
      queryClient.setQueryData<EncounterWithCombatants>(queryKeys.encounter(variables.encounterId), () =>
        reconcileEncounterPatchResponse(updated, pendingEncounterPatches.current.values(), variables.queueId, variables.encounterId),
      );
    },
    onSettled: (_data, error, variables) => {
      const failedEntry = pendingEncounterPatches.current.get(variables.queueId);
      pendingEncounterPatches.current.delete(variables.queueId);
      if (error && failedEntry && !variables.defaultAttemptKey) {
        queryClient.setQueryData<EncounterWithCombatants>(queryKeys.encounter(variables.encounterId), (current) =>
          current
            ? rollbackEncounterPatchError(current, failedEntry, pendingEncounterPatches.current.values(), variables.encounterId)
            : current,
        );
      }
      if (!Array.from(pendingEncounterPatches.current.values()).some((entry) => entry.encounterId === variables.encounterId)) {
        lastLocalEncounterRevision.current.delete(variables.encounterId);
      }
      const hasLaterPendingFog = Array.from(pendingEncounterPatches.current.values()).some(
        (entry) => entry.encounterId === variables.encounterId && Object.prototype.hasOwnProperty.call(entry.patch, 'fog'),
      );
      // #1589 — wake a default attempt that deduped against this exact pending key, but ONLY
      // when the request that just settled was NOT itself a default attempt.
      //
      // A default attempt routinely dedupes against ITS OWN prior dispatch: its optimistic
      // write (below) changes the cached encounter, which re-runs the normalization effect
      // with data that now looks complete, which clears `gridDefaultAttempts`, so the NEXT
      // refetch showing the (still genuinely pending) real fields computes the identical
      // patch/attemptKey again and calls back in here — deduping against itself via the exact
      // pendingKey it is still occupying. If this settle-hook fired the wake unconditionally,
      // that self-dedup registration would fire the instant the original attempt succeeds,
      // racing ahead of the success invalidate below and its refetch: `attemptGridDefaults`
      // would run against cache that has not yet caught up with the write that just landed,
      // see the fields as still missing, and dispatch a genuine duplicate PATCH.
      //
      // A default attempt's own settle is already handled correctly without this hook: success
      // invalidates unconditionally (below) and the resulting fresh data drives the effect;
      // failure deliberately withholds invalidate so the retry waits for real server truth
      // (see the comment below). Restricting the wake to `error && !variables.defaultAttemptKey`
      // targets exactly the case #1589 is about: another, non-default write owned the key and
      // failed, leaving the retry dependent on this wake-up rather than a success refetch.
      const wake = gridDefaultRetryOnFree.current.get(variables.pendingKey);
      if (wake) gridDefaultRetryOnFree.current.delete(variables.pendingKey);
      if (wake && error && !variables.defaultAttemptKey) wake();
      if (!hasLaterPendingFog && Object.prototype.hasOwnProperty.call(variables.patch, 'fog')) {
        const settledFog = variables.patch.fog as FogState | null;
        setPendingFog((current) =>
          current?.encounterId === variables.encounterId && fogStatesEqual(current.fog, settledFog) ? undefined : current,
        );
      }
      // A failed default write keeps its optimistic intent until a poll/SSE refresh supplies
      // server truth. That fresh missing-field snapshot is what permits the next retry, rather
      // than mutation-render churn immediately creating an unbounded failure loop.
      if (!variables.defaultAttemptKey || !error) invalidateEncounter(queryClient, variables.encounterId);
    },
  });

  const attemptGridDefaultsRef = useRef<() => void>(() => {});

  const queueEncounterPatch = useCallback(
    (patch: Record<string, unknown>, defaultAttemptKey?: string): Promise<void> | false => {
      const pendingKey = `${eid}:${encounterPatchKey(patch)}`;
      if (isAdjacentDuplicateEncounterPatch(pendingEncounterPatches.current.values(), eid, pendingKey)) {
        // #1589 — dedup against the in-flight request that already owns this exact body. A
        // default-normalization attempt (`defaultAttemptKey` set) that loses this race must
        // still get its retry once the owning request frees the key — see the ref's doc
        // comment above for why the effect's own re-run cannot be trusted to do that alone.
        if (defaultAttemptKey) {
          gridDefaultRetryOnFree.current.set(pendingKey, () => attemptGridDefaultsRef.current());
        }
        return false;
      }
      const queueId = `${pendingKey}:${++encounterPatchSequence.current}`;
      const currentEncounter = queryClient.getQueryData<EncounterWithCombatants>(queryKeys.encounter(eid));
      const observedUpdatedAt = observedEncounterPatchRevision(
        pendingEncounterPatches.current.values(),
        eid,
        currentEncounter?.updatedAt,
      );
      const previousValues: Record<string, unknown> = {};
      if (currentEncounter) {
        for (const key of Object.keys(patch)) {
          previousValues[key] = (currentEncounter as Record<string, unknown>)[key];
        }
      }
      pendingEncounterPatches.current.set(queueId, { encounterId: eid, queueId, pendingKey, observedUpdatedAt, patch, previousValues });
      if (defaultAttemptKey) gridDefaultAttempts.current.add(defaultAttemptKey);

      // Make every encounter patch optimistic. Fog edits in particular need their cache value
      // to survive the next poll while the write is in flight; the version token below turns a
      // real remote collision into an explicit conflict rather than last-writer-wins.
      queryClient.setQueryData<EncounterWithCombatants>(queryKeys.encounter(eid), (current) =>
        current ? { ...current, ...patch } : current,
      );

      // Serialize local writes. Each queued patch reads the version only when it is about
      // to dispatch, after the preceding success has installed its returned revision in
      // the cache. Different fog bodies therefore cannot race each other with the same CAS
      // token and discard the later local edit as a false stale-write conflict.
      const queuedEncounterId = eid;
      const mutateQueuedPatch = setMap.mutateAsync;
      const queued = encounterPatchQueue.current
        .catch(() => undefined)
        .then(async () => {
          const expectedUpdatedAt = lastLocalEncounterRevision.current.get(queuedEncounterId) ?? observedUpdatedAt;
          await mutateQueuedPatch({ encounterId: queuedEncounterId, queueId, patch, pendingKey, defaultAttemptKey, expectedUpdatedAt });
        });
      encounterPatchQueue.current = queued.catch(() => undefined);
      return queued;
    },
    [eid, queryClient, setMap.mutateAsync],
  );

  // #1589 — the single place that decides "is a grid default still missing, and have we not
  // already attempted it". Reads the QUERY CLIENT directly rather than a closed-over
  // `encounter` value, so it gives the same answer whether it runs from the effect below (on a
  // real data change) or from the `gridDefaultRetryOnFree` wake-up above (fired from inside a
  // mutation callback, where the component's own render-scoped `encounter` may be stale).
  const attemptGridDefaults = useCallback(() => {
    const current = queryClient.getQueryData<EncounterWithCombatants>(queryKeys.encounter(eid));
    if (!canDmWriteRef.current || !current || current.status === 'ended') return;
    const patch = missingGridDefaults(current);
    const encounterPrefix = `${current.id}:`;
    if (!patch) {
      for (const key of gridDefaultAttempts.current) {
        if (key.startsWith(encounterPrefix)) gridDefaultAttempts.current.delete(key);
      }
      return;
    }
    const attemptKey = gridDefaultAttemptKey(current.id, patch);
    if (gridDefaultAttempts.current.has(attemptKey)) return;
    queueEncounterPatch(patch, attemptKey);
  }, [eid, queryClient, queueEncounterPatch]);
  attemptGridDefaultsRef.current = attemptGridDefaults;

  const setEncounterMap = useCallback(
    (attachmentId: number | null, alignment: MapReplaceAlignment = 'preserve') =>
      queueEncounterPatch({ mapAttachmentId: attachmentId, mapAlignment: alignment }),
    [queueEncounterPatch],
  );
  // Grid config (issue #40, phase 2) — any subset of gridSize/gridScale/gridUnit/gridSnap.
  const setEncounterGrid = useCallback((patch: EncounterGridPatch) => queueEncounterPatch(patch), [queueEncounterPatch]);
  // Fog of war (issue #40, phase 3) — replace the whole fog state (null clears it).
  const setEncounterFog = useCallback((fog: FogState | null) => {
    if (queueEncounterPatch({ fog })) setPendingFog({ encounterId: eid, fog });
  }, [eid, queueEncounterPatch]);
  // Shared AoE templates (issue #238) — replace the whole template list (DM only, server-enforced).
  const setEncounterAoe = useCallback((aoe: AoeTemplate[]) => queueEncounterPatch({ aoe }), [queueEncounterPatch]);

  // First-party map-generation wizard (issue #409). "Use this map" replays the previewed
  // seed through POST /encounters/:id/generate-map, which ATOMICALLY generates the map,
  // saves it hidden (never on the player Handouts card), sets it as the encounter's battle
  // map, and aligns the VTT grid/scale — all server-side, in one call. We then refresh and
  // guide the DM through grid check → fog → token placement. (`showMapGuidance` state is
  // declared earlier, beside the other transient encounter UI state.)
  const generateAndAttachMap = useCallback(
    async (params: GenerateMapParams) => {
      setActionError(null);
      await api.post<GeneratedMapResult>(`${API}/encounters/${eid}/generate-map`, params);
      invalidateEncounter(queryClient, eid);
      setShowMapGuidance(true);
      announce('Generated map attached. Check the grid, set fog, then place tokens.');
    },
    [eid, queryClient, announce],
  );

  // Issue #865: normalize placeholder grid defaults once per encounter + missing-field set.
  // This lives beside the mutation/cache boundary instead of inside BattleMap's render tree.
  //
  // #1589 — this is now ONE of two triggers for `attemptGridDefaults`, not the only one. This
  // effect catches a genuine data change (the common case); `gridDefaultRetryOnFree` (declared
  // above, by `queueEncounterPatch`) catches the case where the previous attempt deduped
  // against another in-flight request and the settle of THAT request is the only signal a
  // retry is owed — which does not always also produce a new `encounter` reference for this
  // effect to react to. See that ref's doc comment for the full mechanism.
  useEffect(() => {
    if (!canDmWrite || !encounter || encounter.status === 'ended') return;
    attemptGridDefaults();
  }, [encounter, canDmWrite, attemptGridDefaults]);

  // Transient battle-map ping (issue #238). Fire-and-forget POST; the server broadcasts an
  // `encounter.ping` SSE signal that every client — including this one — renders and fades, so
  // there's no optimistic local echo to manage. Any writing member may ping (a live gesture).
  const pingMap = useMutation({
    mutationFn: (ping: MapPing) => api.post(`${API}/encounters/${eid}/ping`, ping),
    onError: reportError,
  });
  const sendPing = (x: number, y: number) => pingMap.mutate({ x, y, color: null, label: null, senderId: null, senderName: null } as unknown as MapPing);

  // Move a combatant's token on the battle map. The server clamps to 0–100 and gates on
  // role (DM moves any; a player only their own character's token).
  const moveToken = (combatantId: number, x: number, y: number) => patchCombatant(combatantId, { tokenX: x, tokenY: y });
  const tokenUndoKeys = useRef(new Map<string, string>());
  const tokenBatchApplyIntents = useRef(new Map<string, { previewToken: string; idempotencyKey: string }>());
  // Batch map changes deliberately use the preview/apply protocol rather than a loop of
  // individual PATCHes: either every token lands or the roster remains unchanged.
  const batchMoveTokens = useCallback(async (placements: Array<{ combatantId: number; x: number; y: number }>, mapAspect: number) => {
    const intentKey = JSON.stringify({ placements, mapAspect });
    let intent = tokenBatchApplyIntents.current.get(intentKey);
    if (!intent) {
      const preview = await api.post<{ previewToken: string }>(`${API}/encounters/${eid}/token-batches/preview`, { placements, mapAspect });
      intent = { previewToken: preview.previewToken, idempotencyKey: newOperationId() };
      tokenBatchApplyIntents.current.set(intentKey, intent);
    }
    try {
      const applied = await api.post<{ undoToken: string }>(`${API}/encounters/${eid}/token-batches/apply`, {
        previewToken: intent.previewToken,
        idempotencyKey: intent.idempotencyKey,
      });
      tokenBatchApplyIntents.current.delete(intentKey);
      await invalidateEncounter(queryClient, eid);
      return applied;
    } catch (err) {
      // A definitive 4xx means the preview is stale; drop the intent so the next
      // attempt creates a fresh preview. Keep it for ambiguous network failures.
      if (err instanceof ApiError) tokenBatchApplyIntents.current.delete(intentKey);
      throw err;
    }
  }, [eid, queryClient]);
  const undoTokenBatch = useCallback(async (undoToken: string) => {
    const idempotencyKey = tokenUndoKeys.current.get(undoToken) ?? newOperationId();
    tokenUndoKeys.current.set(undoToken, idempotencyKey);
    await api.post(`${API}/encounters/${eid}/token-batches/undo`, { undoToken, idempotencyKey });
    tokenUndoKeys.current.delete(undoToken);
    await invalidateEncounter(queryClient, eid);
  }, [eid, queryClient]);
  // Unplace a token (issue #271): clear its position back to null so it returns to the
  // "Unplaced" tray WITHOUT deleting the combatant (its HP/conditions/initiative survive).
  // An explicit null is required — `undefined` would be a no-op patch server-side.
  const unplaceToken = (combatantId: number) => patchCombatant(combatantId, { tokenX: null, tokenY: null });
  // Token size category (issue #40, phase 2) — DM-only, server-enforced.
  const setTokenSize = (combatantId: number, size: TokenSize) => patchCombatant(combatantId, { tokenSize: size });

  // Header run-control group shares one pending flag (see runControl above).
  // `reconcileBlocks` folds into the same busy flag the header already honors (issue
  // #580): while the client is checking committed state, every non-idempotent DM control
  // is unavailable, which is the "reconcile before another action is allowed" rule.
  const headerBusy =
    runControl.isPending || nextTurnMut.isPending || undoTurnMut.isPending || deleteEncounterMut.isPending || escalationControl.isPending || reconcileBlocks;
  const nextTurnShortcut = useKeyboardCommandHint('encounterNextTurn');

  useKeyboardGuardedAction(
    'encounterNextTurn',
    canDmWrite && encounter
      ? {
          canExecute: () => {
            if (!encounter || headerBusy || riskyBlocked) return false;
            if (confirmEnd || confirmReopen || confirmDelete) return false;
            return dmLifecycleActions(encounter.status).nextTurn;
          },
          execute: nextTurn,
        }
      : null,
  );

  // Issue #636: scroll the active combatant row into view when the turn advances.
  const currentCombatantId = useMemo(
    () => (encounter?.status === 'running' ? (encounter.currentCombatantId ?? undefined) : undefined),
    [encounter],
  );

  const { data: turnWorkspace } = useQuery({
    queryKey: queryKeys.encounterTurn(eid),
    queryFn: () => api.get<TurnWorkspaceData>(`${API}/encounters/${eid}/turn`),
    enabled: encounter?.status === 'running',
    staleTime: 2_000,
  });

  const currentCombatant = useMemo(
    () => (currentCombatantId != null ? encounter?.combatants.find((c) => c.id === currentCombatantId) : undefined),
    [encounter?.combatants, currentCombatantId],
  );

  const combatantRowRefs = useRef(new Map<number, HTMLElement>());
  const setCombatantRowRef = useCallback((combatantId: number, el: HTMLElement | null) => {
    if (el) combatantRowRefs.current.set(combatantId, el);
    else combatantRowRefs.current.delete(combatantId);
  }, []);
  const autoScrollSkipped = useRef(false);
  // `RunSessionPage` is reused across encounters; reset the first-load latch so
  // each new encounter starts with the header controls visible.
  useEffect(() => {
    autoScrollSkipped.current = false;
  }, [eid]);
  useLayoutEffect(() => {
    if (encounter?.status !== 'running' || currentCombatantId == null) return;
    // The first time the current combatant resolves we are still at the top of the
    // encounter page; auto-scrolling now would hide the header controls on phones
    // and tablets. Only auto-scroll on subsequent turn changes.
    if (!autoScrollSkipped.current) {
      autoScrollSkipped.current = true;
      return;
    }
    const frame = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el =
          combatantRowRefs.current.get(currentCombatantId) ??
          document.querySelector<HTMLElement>(
            `[data-testid="combatant-row-${currentCombatantId}"][data-current-turn="true"]`,
          );
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const inView = rect.bottom > 0 && rect.top < window.innerHeight;
        if (inView) return;
        const targetTop = window.scrollY + rect.top - (window.innerHeight - rect.height) / 2;
        window.scrollTo({ top: Math.max(0, targetTop), behavior: 'auto' });
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [encounter?.status, currentCombatantId]);

  if (!Number.isFinite(cid) || !Number.isFinite(eid)) {
    return (
      <div className="max-w-5xl mx-auto px-4 mt-5">
        <ErrorNote message={t('encounters.notFoundDetail')} />
      </div>
    );
  }

  if (encounterQuery.isPending && !encounter) {
    return (
      <div className="max-w-4xl mx-auto px-4 mt-5 space-y-4">
        <Card>
          <Skeleton lines={5} />
        </Card>
      </div>
    );
  }

  if (notFound && !encounter) {
    return (
      <div className="max-w-4xl mx-auto px-4 mt-5">
        <NotFoundState title={t('encounters.notFound')} backTo={`/c/${cid}/encounters`} backLabel={t('encounters.backToList')} />
      </div>
    );
  }

  if (loadError && !encounter) {
    return (
      <div className="max-w-4xl mx-auto px-4 mt-5">
        <ErrorNote message={loadError} onRetry={refetchEncounter} />
      </div>
    );
  }

  if (!encounter) return null;

  const canEditEncounter = canDmWrite && encounter.status !== 'ended';

  // The server returns combatants already in initiative order and names the current
  // actor by id (issue #49) — no client-side re-sort, and no positional
  // `turnIndex % length` guesswork that desyncs the moment a combatant is added or
  // removed mid-fight.
  const orderedCombatants = encounter.combatants;
  const myCombatants = orderedCombatants.filter(c => c.characterId != null && ownedCharacterIds.has(c.characterId));
  // Prefer a combatant the viewer can resolve. Fall back only to character combatants
  // (party HP is shared table knowledge); never surface monster/NPC concentration
  // queues to non-resolvers — those embed secret exact damage/DC (#43 / #606).
  const concentrationCheckCombatant =
    orderedCombatants.find(
      (combatant) =>
        combatant.turnState.pendingConcentrationChecks.length > 0 &&
        canEditCombatantPermission(combatant),
    ) ??
    orderedCombatants.find(
      (combatant) =>
        combatant.kind === 'character' &&
        combatant.turnState.pendingConcentrationChecks.length > 0,
    );
  const pendingConcentrationCheck = concentrationCheckCombatant?.turnState.pendingConcentrationChecks[0] ?? null;
  const canResolveConcentrationCheck =
    concentrationCheckCombatant != null && canEditCombatantPermission(concentrationCheckCombatant);
  // Issue #420: DM header actions come from an explicit lifecycle matrix (not
  // ad-hoc status !== 'ended' checks) so Preparing never offers the invalid End.
  const lifecycle = dmLifecycleActions(encounter.status);
  const deleteCopy = deleteConfirmCopy(encounter.status);

  return (
    <div
      className={`cf-print-root reading-surface max-w-4xl lg:max-w-6xl mx-auto px-4 mt-5 space-y-4 pb-20 md:pb-10${isDm ? ' cf-print-encounter' : ''}`}
      {...entityTargetProps('encounter', encounter.id)}
    >
      {isDm && (
        <PrintOnly>
          <section className="cf-print-only cf-print-paper" aria-label="Encounter reference sheet">
            <h1>{encounter.name}</h1>
            <p><strong>Status:</strong> {STATUS_LABEL[encounter.status]} · <strong>Round:</strong> {encounter.round}</p>
            <table className="cf-print-roster">
              <thead><tr><th>Initiative / order</th><th>Combatant</th><th>Type</th><th>AC</th><th>Current / max / temp HP</th><th>Conditions / status</th><th>Notes / tracking</th></tr></thead>
              <tbody>{orderedCombatants.map((combatant, index) => (
                <tr key={combatant.id}>
                  <td>{combatant.initiative ?? '—'} / {index + 1}</td>
                  <td>{combatant.name}</td>
                  <td>{combatant.kind}</td>
                  <td>{combatant.eac != null || combatant.kac != null
                    ? [combatant.eac != null ? `EAC ${combatant.eac}` : null, combatant.kac != null ? `KAC ${combatant.kac}` : null].filter(Boolean).join(' / ')
                    : combatant.statblock?.ac ?? '—'}</td>
                  <td>{combatant.hpCurrent == null || combatant.hpMax == null ? '—' : `${combatant.hpCurrent} / ${combatant.hpMax} / ${combatant.hpTemp ?? 0}`}</td>
                  <td>{[
                    ...combatant.conditions,
                    combatant.deathState !== 'none'
                      ? (DEATH_STATE_LABEL[combatant.deathState] ?? combatant.deathState)
                      : '',
                  ].filter(Boolean).join(', ') || '—'}</td>
                  <td aria-label={`Notes for ${combatant.name}`} />
                </tr>
              ))}</tbody>
            </table>
          </section>
        </PrintOnly>
      )}
      <DetailPageWayfinding
        campaignId={cid}
        defaultPath={`/c/${cid}/encounters`}
        defaultLabel="← Back to encounters"
      />

      {(loadError || actionError) && (
        <ErrorNote
          message={actionError?.message ?? loadError ?? ''}
          context={
            actionError
              ? `at ${formatTime(actionError.at)}`
              : undefined
          }
          onRetry={() => {
            setActionError(null);
            refetchEncounter();
          }}
          onDismiss={actionError ? () => setActionError(null) : undefined}
        />
      )}
      {encounterPatchConflict && (
        <ErrorNote
          message={encounterPatchConflict}
          onRetry={() => {
            setEncounterPatchConflict(null);
            refetchEncounter();
          }}
          onDismiss={() => setEncounterPatchConflict(null)}
        />
      )}

      {/* Issue #580 — ambiguous outcome. NOT an error banner: the write may well have
          succeeded, and calling it a failure is what pushes a DM into re-clicking (a new
          intent, new key, real double damage). While `checking`, the HP steppers and turn
          controls below are disabled; the message flips to a short acknowledgement once
          committed state has actually been re-read. */}
      {reconcile.phase !== 'idle' && (
        <div
          role="status"
          aria-live="polite"
          data-testid="mutation-reconcile-banner"
          data-phase={reconcile.phase}
          className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
        >
          {reconcile.phase === 'checking'
            ? t('encounters.reconcile.checking')
            : t('encounters.reconcile.done')}
        </div>
      )}

      {canEditEncounter && (
        <VisibleToPlayersBar
          visible={!encounter.hidden}
          onHide={async () => {
            await queueEncounterPatch({ hidden: true });
          }}
          onUndoHide={async () => {
            await queueEncounterPatch({ hidden: false });
          }}
          onReveal={
            encounter.status === 'running'
              ? async () => {
                  await queueEncounterPatch({ hidden: false });
                }
              : undefined
          }
        />
      )}

      <div className="flex items-center gap-2.5 flex-wrap">
        <h1 className="text-2xl font-extrabold text-white m-0 min-w-0 break-words">{encounter.name}</h1>
        <span className={STATUS_TAG_CLASS[encounter.status]}>
          {STATUS_LABEL[encounter.status]}
        </span>
        {encounter.status === 'running' && (
          <span className="tag tag-neutral">
            Round {encounter.round}
            {encounter.turnPhase === 'lair' ? ` · Lair (init ${LAIR_INITIATIVE_COUNT})` : ''}
          </span>
        )}
        <DifficultyBadge difficulty={difficulty} />
        {isDm && <PrintControl resetKey={encounter.id} className="ml-auto" />}
        <span
          className={`cf-chip ${encounterSyncChipClass(encounterSync)}`}
          data-testid={ENCOUNTER_SYNC_CHIP_TESTID}
          title={encounterSyncLastSyncTitle}
        >
          {encounterSyncChip}
        </span>
        {/* AI-DM presence chip (#344) — the seat is in Driver mode, so it may act on
            this encounter from the Table page without anyone here having it open. */}
        {liveActivity.mode === 'driver' && <AiDmPresenceTag turnActive={liveActivity.turnActive} />}
        <button
          type="button"
          className="btn btn-ghost"
          style={{ fontSize: 11.5 }}
          onClick={refreshEncounter}
          title="Refresh"
        >
          ↻ Refresh
        </button>
        <div className="flex-1" />
        {isDm && (
          <>
            <div className="order-first flex basis-full lg:order-none lg:basis-auto w-full lg:w-auto items-center gap-1.5 flex-wrap" role="group" aria-label="Player display">
              {/* Open synchronously from this button's click stack. The newly minted
                  #547 capability navigates only that separate window, never the DM cockpit. */}
              <Btn density="xs" ghost className="text-xs" onClick={openPlayerDisplay}>
                <GameIcon slug="tv" size={UI_ICON_SIZE.xs} className="inline align-text-bottom mr-1" />Open display
              </Btn>
              <Btn density="xs" ghost className="text-xs" onClick={copyPlayerDisplayLink}>
                Copy link
              </Btn>
              <Btn density="xs" ghost className="text-xs" onClick={reconnectPlayerDisplay}>
                Reconnect/focus
              </Btn>
              <span
                className={`tag ${castWindowState === 'ready' ? 'tag-accent' : 'tag-neutral'}`}
                role="status"
                data-testid="player-display-status"
                title={castDisplayNotice ?? undefined}
              >
                {displayStatusLabel(
                  castWindowState,
                  castWindowState === 'ready'
                    ? {
                        encounterId: castFollowedEncounter.id,
                        encounterName: castFollowedEncounter.name,
                        isCurrentEncounter: castFollowedEncounter.id === encounter?.id,
                      }
                    : null,
                )}
              </span>
            </div>
            <TermHelp termId="cast" />
            {castDisplayNotice && (
              <p className="text-xs text-muted m-0 basis-full" role="status" data-testid="player-display-notice">
                {castDisplayNotice}
              </p>
            )}
          </>
        )}
        {canDmWrite && (
          <div className="flex gap-2 flex-wrap">
            {lifecycle.rollInitiative && lifecycle.start && (
              <>
                {/* Issue #702: the server treats a fully-rolled roster as a no-op (no
                    write, no audit), so the button must reflect that — disabled when
                    nobody needs initiative, and labeled "Roll remaining (N)" when the
                    roster is partial (e.g. a manually-set combatant alongside unrolled
                    ones). Hidden entirely rather than dead weight once Start is live. */}
                <Btn
                  ghost
                  disabled={headerBusy || riskyBlocked || needsInitiativeCount === 0}
                  onClick={rollInitiative}
                  title={needsInitiativeCount === 0 ? 'All combatants already have initiative' : undefined}
                >
                  {needsInitiativeCount > 0
                    ? t('encounters.run.rollRemaining', { count: needsInitiativeCount })
                    : t('encounters.run.rollInitiative')}
                </Btn>
                <div className="flex flex-col gap-0.5 items-stretch">
                  <Btn
                    disabled={headerBusy || riskyBlocked || hasNoCombatants || needsInitiativeCount > 0}
                    onClick={startEncounter}
                    aria-describedby={hasNoCombatants || needsInitiativeCount > 0 ? 'start-roster-hint' : undefined}
                  >
                    {t('encounters.run.start')}
                  </Btn>
                  {(hasNoCombatants || needsInitiativeCount > 0) && (
                    <p id="start-roster-hint" className="text-muted text-xs m-0 max-w-[14rem]">
                      {hasNoCombatants
                        ? 'Add at least one combatant before starting'
                        : 'Roll initiative for all combatants before starting'}
                    </p>
                  )}
                </div>
              </>
            )}
            {lifecycle.undoTurn && (
              <Btn
                ghost
                disabled={
                  headerBusy ||
                  riskyBlocked ||
                  (encounter.round <= 1 &&
                    (encounter.turnPhase ?? 'combatant') === 'combatant' &&
                    orderedCombatants.length > 0 &&
                    encounter.currentCombatantId === orderedCombatants[0].id)
                }
                onClick={undoTurn}
                title="Undo turn"
              >
                ← Undo turn
              </Btn>
            )}
            {lifecycle.rollInitiative && lifecycle.nextTurn && (
              <>
                {/* Reinforcements added mid-fight land at null initiative and sort last —
                    keep Roll initiative reachable so the DM can fill them (issue #54).
                    Already-set initiatives are left untouched server-side. Once every
                    combatant has a value, disable the control rather than firing a no-op
                    roll (issue #702), and surface how many still need rolling. */}
                <Btn
                  ghost
                  disabled={headerBusy || riskyBlocked || needsInitiativeCount === 0}
                  onClick={rollInitiative}
                  title={needsInitiativeCount === 0 ? 'All combatants already have initiative' : undefined}
                >
                  {needsInitiativeCount > 0
                    ? t('encounters.run.rollRemaining', { count: needsInitiativeCount })
                    : t('encounters.run.rollInitiative')}
                </Btn>
                <Btn
                  data-testid="encounter-header-next-turn"
                  disabled={headerBusy || riskyBlocked}
                  onClick={nextTurn}
                  aria-keyshortcuts={nextTurnShortcut.ariaKeyshortcuts}
                  title={`Next turn${nextTurnShortcut.titleSuffix}`}
                >
                  {t('encounters.run.nextTurn')}
                </Btn>
              </>
            )}
            {lifecycle.end && (
              // Issue #1446: End writes an HP/condition/death-state snapshot back to each
              // linked character sheet (cross-entity, no CAS guard) — genuinely conflict-prone,
              // so it stays gated (confirmable via the override, not ungated outright).
              <Btn ghost danger disabled={headerBusy || riskyBlocked} onClick={() => setConfirmEnd(true)}>
                {t('encounters.run.end')}
              </Btn>
            )}
            {lifecycle.reopen && (
              <Btn
                ghost
                disabled={headerBusy || riskyBlocked}
                onClick={() => {
                  // Default each conflict to pull_sheet (preserve intervening healing/rest).
                  const initial: Record<number, HpResyncDirection> = {};
                  for (const c of encounter?.hpSyncConflicts ?? []) initial[c.combatantId] = 'pull_sheet';
                  setHpResyncChoices(initial);
                  setConfirmReopen(true);
                }}
              >
                {t('encounters.run.reopen')}
              </Btn>
            )}
            {lifecycle.delete && (
              // Issue #1446: delete has no revision/CAS guard server-side and clears the
              // campaign's active-encounter pointer — a stale tab can trash an encounter
              // another DM/the AI driver is actively updating. Racing a destructive,
              // effectively unrecoverable action is worse than racing a turn advance, so
              // this stays gated (confirmable via the override, not ungated outright).
              <Btn ghost danger disabled={headerBusy || riskyBlocked} onClick={() => setConfirmDelete(true)}>
                {encounter.status === 'preparing' ? 'Cancel' : 'Delete'}
              </Btn>
            )}
          </div>
        )}
      </div>

      {encounterSyncBanner && (
        <p
          className="text-muted"
          data-testid={ENCOUNTER_SYNC_BANNER_TESTID}
          style={{ fontSize: 12, margin: 0 }}
          role="status"
          aria-live="polite"
          title={encounterSyncLastSyncTitle}
        >
          {encounterSyncBanner}
        </p>
      )}

      {/* Issue #1446: while not live, conflict-prone actions are blocked but confirmable —
          a stuck stream (proxy buffering, a terminated long-lived connection, …) must not
          brick combat permanently. Granting the override does not touch the banner above,
          which stays visible for as long as the stream is unhealthy so the DM never loses
          track of which mode they're in. DM-only (canDmWrite): the issue frames "continue
          anyway" as a DM decision — a player has no path to grant it, so a player's own
          combatant mutations stay blocked for the whole outage. */}
      {encounterSyncOverrideOfferable && (
        <div
          role="status"
          aria-live="polite"
          data-testid="encounter-sync-override-prompt"
          className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm flex items-center gap-2 flex-wrap"
        >
          <span>{t('encounters.sync.overridePrompt')}</span>
          <Btn
            density="xs"
            ghost
            className="text-xs"
            data-testid="encounter-sync-override-confirm"
            onClick={() => {
              // Defense in depth alongside the gate above — never let a non-DM or a
              // stale-identity viewer grant the override even if this handler is somehow
              // reachable; the tag is set from THIS context, satisfying the campaign/
              // identity preconditions by construction.
              if (!overrideAuthority.canDmWrite || overrideAuthority.staleIdentity) return;
              setEncounterSyncOverride(confirmEncounterOverride(overrideAuthority.campaignId, overrideAuthority.userId));
            }}
          >
            {t('encounters.sync.overrideConfirm')}
          </Btn>
        </div>
      )}
      {effectiveEncounterSyncOverride.active && encounterSync !== 'live' && (
        <span className="tag tag-accent" data-testid="encounter-sync-override-active" style={{ fontSize: 11 }}>
          {t('encounters.sync.overrideActive')}
        </span>
      )}

      {isArchmage && encounter.status === 'running' && (
        <Card
          density="compact" elev="sm"
          data-testid="archmage-escalation-panel"
          style={{
            padding: '12px 14px',
            borderLeft: '2px solid var(--color-accent)',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-white">Escalation die</span>
            <span className="tag tag-accent" aria-label={`Escalation die plus ${encounter.escalationDie}`}>
              +{encounter.escalationDie}
            </span>
            <span className="text-xs text-muted">
              Round {encounter.round} default +{Math.max(0, Math.min(6, encounter.round - 1))}
              {encounter.escalationDieHeld ? ' · held' : ''}
              {encounter.escalationDieOverride != null ? ` · override +${encounter.escalationDieOverride}` : ''}
            </span>
            {canDmWrite && (
              // Issue #1446 re-audit (2nd pass): `updateEscalationDie` has concurrent writers
              // beyond this one tab — the REST controller lets any campaign DM call it, and
              // `set_escalation_die` (mcp-tools.ts) exposes the same unconditional, no-CAS
              // service write over MCP. A stale tab can clobber a newer override/hold set by a
              // co-DM or an MCP caller — genuinely shared state, so these stay gated like the
              // other conflict-prone controls.
              <div className="flex items-center gap-2 flex-wrap ml-auto">
                <Btn density="xs"
                  ghost
                  className="text-xs"
                  disabled={headerBusy || riskyBlocked}
                  onClick={() => toggleEscalationHold(!encounter.escalationDieHeld)}
                >
                  {encounter.escalationDieHeld ? 'Resume auto' : 'Hold'}
                </Btn>
                <TextInput
                  aria-label="Escalation die override"
                  inputMode="numeric"
                  value={escalationOverrideDraft}
                  onChange={(e) => setEscalationOverrideDraft(e.target.value)}
                  placeholder="0–6"
                  style={{ width: 72, minHeight: 30, fontSize: 12 }}
                />
                <Btn density="xs"
                  ghost
                  className="text-xs"
                  disabled={headerBusy || riskyBlocked || escalationOverrideDraft.trim() === ''}
                  onClick={applyEscalationOverride}
                >
                  Override
                </Btn>
                {encounter.escalationDieOverride != null && (
                  <Btn density="xs"
                    ghost
                    className="text-xs"
                    disabled={headerBusy || riskyBlocked}
                    onClick={clearEscalationOverride}
                  >
                    Clear
                  </Btn>
                )}
              </div>
            )}
          </div>
          <details>
            <summary className="text-xs text-muted cursor-pointer">13th Age escalation rules and history</summary>
            <div className="text-xs text-muted mt-2 space-y-1">
              <p className="m-0">
                At the start of round 2 the escalation die is +1, then rises by +1 each round to +6.
                Player characters add it to attacks; monsters and NPCs do not. Fear prevents a PC from using it.
              </p>
              {encounter.escalationDieHistory.length > 0 && (
                <ol className="m-0 pl-4">
                  {encounter.escalationDieHistory.slice(-5).map((h, i) => (
                    <li key={`${h.at}-${i}`}>
                      Round {h.round}: +{h.value} ({h.note || h.source})
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </details>
        </Card>
      )}

      {/* Transient "the AI just acted" row(s) (#344 point 2) — sourced from live tool
          events touching encounter or party state (including loot/treasury grants). */}
      {aiToasts.length > 0 && (
        <div className="flex flex-col gap-1" style={{ paddingLeft: 2 }}>
          {aiToasts.map((toast) => (
            <AiDmToolActivityRow key={toast.key} chip={toast.chip} at={toast.at} />
          ))}
        </div>
      )}

      {/* AI-DM driver dock (#427): transcript + composer + recovery without leaving tracker. */}
      {liveActivity.mode === 'driver' && encounter && (
        <EncounterAiDriverPanel
          campaignId={cid}
          encounterId={eid}
          encounter={encounter}
          isDm={isDm}
          canCompose={canPlayerWrite}
        />
      )}

      {encounter.status === 'ended' && (() => {
        const visibleCombatants = isDm
          ? encounter.combatants
          : filterPlayerSafeCombatants(encounter.combatants);
        const { dead, downed, survivors } = endedSummaryTallies(visibleCombatants);
        return (
          <Card
            density="comfortable"
            className="space-y-2"
            role="region"
            aria-labelledby="encounter-ended-summary-heading"
            data-testid="encounter-ended-summary"
          >
            <h2 id="encounter-ended-summary-heading" className="text-sm font-bold text-white m-0">
              Combat Summary
            </h2>
            <div className="flex gap-4 flex-wrap text-[13px]" data-testid="encounter-ended-summary-tallies">
              <span>
                Rounds: <b>{encounter.round}</b>
              </span>
              <span>
                Dead: <b>{dead.length}</b>
                {dead.length > 0 && (
                  <span className="text-muted"> ({dead.map((c) => c.name).join(', ')})</span>
                )}
              </span>
              <span>
                Downed: <b>{downed.length}</b>
                {downed.length > 0 && (
                  <span className="text-muted"> ({downed.map((c) => c.name).join(', ')})</span>
                )}
              </span>
              <span>
                Survivors: <b>{survivors.length}</b>
                {survivors.length > 0 && (
                  <span className="text-muted"> ({survivors.map((c) => c.name).join(', ')})</span>
                )}
              </span>
            </div>
          </Card>
        );
      })()}

      {canDmWrite && encounter.status === 'ended' && (
        <EncounterAftermathPanel campaignId={cid} encounterId={eid} />
      )}

      <EncounterLinks
        campaignId={cid}
        encounter={encounter}
        canEdit={canEditEncounter}
        onSave={async (patch) => {
          await queueEncounterPatch(patch);
        }}
      />

      {(() => {
        const visibleGuidanceCombatants = isDm
          ? encounter.combatants
          : filterPlayerSafeCombatants(encounter.combatants);
        const partyCombatantCount = visibleGuidanceCombatants.filter((c) => c.kind === 'character').length;
        const enemyCombatantCount = visibleGuidanceCombatants.filter((c) => c.kind === 'monster' || c.kind === 'npc').length;
        const needsInitCount = visibleGuidanceCombatants.filter((c) => c.initiative === null || c.initiative === undefined).length;
        const activeStepId = activeLifecycleStepId(encounter.status, {
          partyCombatantCount,
          enemyCombatantCount,
          needsInitiativeCount: needsInitCount,
        });
        return (
          <div
            data-testid="encounter-preparing-guidance"
            data-lifecycle-orientation="true"
            className="text-muted"
            style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 6 }}
          >
            {canDmWrite && encounter.status === 'preparing' && preparingSetupGuidance ? (
              <>
                <p style={{ margin: 0 }}>{preparingSetupGuidance.lead}</p>
                <ol style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {preparingSetupGuidance.nextSteps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
              </>
            ) : (
              <p style={{ margin: 0 }} data-testid="encounter-status-guidance-lead">
                {playerGuidance({
                  status: encounter.status,
                  currentCombatantName: currentCombatant?.name,
                })}
              </p>
            )}
            <ol
              aria-label="Encounter lifecycle"
              data-testid="encounter-lifecycle-checklist"
              style={{
                margin: 0,
                padding: 0,
                listStyle: 'none',
                display: 'flex',
                flexWrap: 'wrap',
                gap: 6,
                alignItems: 'center',
              }}
            >
              {ENCOUNTER_LIFECYCLE_STEPS.map((step, i) => {
                const isActive = step.id === activeStepId;
                return (
                  <li
                    key={step.id}
                    className={`tag ${isActive ? 'tag-accent' : 'tag-neutral'}`}
                    style={{ fontSize: 10 }}
                    title={step.detail}
                    aria-current={isActive ? 'step' : undefined}
                    data-active={isActive ? 'true' : undefined}
                  >
                    {i + 1}. {step.label}
                  </li>
                );
              })}
            </ol>
          </div>
        );
      })()}

      {/* Optional battle map (issue #39) — a DM-uploaded image with draggable combatant
          tokens. Shown to the DM always (so they can attach one), and to players only once
          a map exists. Encounters without a map are unchanged. */}
      {(isDm || encounter.mapAttachmentId != null) && (
        <BattleMap
          encounter={encounter}
          campaignId={cid}
          isDm={isDm}
          viewerUserId={myUserId != null ? String(myUserId) : null}
          canDmWrite={canEditEncounter}
          busy={setMap.isPending}
          canMoveToken={canEditCombatant}
          onSetMap={setEncounterMap}
          onMoveToken={moveToken}
          onBatchTokens={batchMoveTokens}
          onUndoTokenBatch={undoTokenBatch}
          dismissTokenUndoNonce={dismissTokenUndoNonce}
          onBeginTokenBatchUndo={dismissRecoveryUndosForTokenBatch}
          onUnplaceToken={unplaceToken}
          onSetTokenSize={setTokenSize}
          onSetGrid={setEncounterGrid}
          onSetFog={setEncounterFog}
          pendingFog={pendingFogForEncounter(pendingFog, eid)}
          onSetAoe={setEncounterAoe}
          onGenerateMap={canEditEncounter ? generateAndAttachMap : undefined}
          onImportMap={
            canEditEncounter
              ? (id) => {
                  setEncounterMap(id);
                  setShowMapGuidance(true);
                  announce('Map imported. Check the grid, set fog, then place tokens.');
                }
              : undefined
          }
          showGuidance={showMapGuidance}
          onDismissGuidance={() => setShowMapGuidance(false)}
          onPing={sendPing}
          pings={pings}
          onDismissPing={dismissPing}
          onError={surfaceActionError}
          onAoeHitLayoutChange={onAoeHitLayoutChange}
          ruleSystem={ruleSystem}
        />
      )}

      {/* Sticky Player Vitals Header */}
      {!isDm && myCombatants.length > 0 && (
        <PlayerVitalsHeader 
          combatants={myCombatants} 
          charactersById={charactersById}
          onHpDelta={(id, delta) => {
            if (reconcileBlocks) return;
            const actorId = hpLogActorId(currentCombatantId, id);
            hpDelta.mutate({ combatantId: id, delta, actorId });
          }}
          onSetHpMax={(id, max) => patchCombatant(id, { hpMax: max })}
        />
      )}

      {/* Current-turn workspace (issue #413): "what can I do now?" + player End-turn. Only
          while running; the component self-hides when there's no current combatant. */}
      {encounter.status === 'running' && encounter.turnPhase === 'lair' && (
        <Card
          density="compact" elev="sm"
          data-testid="lair-action-slot"
          style={{
            padding: '12px 14px',
            borderLeft: '2px solid var(--color-accent)',
            background: 'color-mix(in srgb, var(--color-accent) 10%, transparent)',
          }}
        >
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-white">Lair action</span>
            <span className="tag tag-accent">initiative {LAIR_INITIATIVE_COUNT}</span>
            <span className="text-sm text-muted">Resolve the lair effect, then advance the turn.</span>
            {canDmWrite && (
              <Btn className="ml-auto" disabled={headerBusy || riskyBlocked} onClick={nextTurn}>
                Done →
              </Btn>
            )}
          </div>
        </Card>
      )}

      {encounter.status === 'running' && (
        <TurnWorkspace
          encounterId={eid}
          turn={turnWorkspace}
          isDm={isDm}
          ruleSystem={campaign?.ruleSystem}
          currentTurnState={currentCombatant?.turnState}
          actionsDisabled={riskyBlocked}
          deathSavePending={reconcileBlocks}
          isCombatantPending={(combatantId) => pendingCombatantIds.has(combatantId)}
          gridUnit={encounter.gridUnit}
          gridScale={encounter.gridScale}
          onRollDeathSave={rollDeathSave}
          onUpdateSpellSlot={
            // Review fix: derive the actor from turnWorkspace.current (the SAME data the
            // Spellbook itself renders), not the separately-fetched `currentCombatant` — the
            // encounter and /turn queries refetch independently, so right after a turn
            // advance one can briefly hold the new actor while the other still holds the
            // previous one. Binding to `currentCombatant.characterId` in that window could
            // debit a different character's slots than the one on screen. `canDmWrite`
            // (not just `isDm`) also gates the DM branch — an archived/ended campaign must
            // disable the control, not just have the server reject the write.
            turnWorkspace?.current?.characterId != null &&
            ((isDm && canDmWrite) || (canPlayerWrite && turnWorkspace?.isYourTurn === true))
              ? (level, delta, castContext) => {
                  const actor = turnWorkspace.current!;
                  const characterId = actor.characterId!;
                  // Review fix (P1, atomicity): a descriptive-but-structured spec has no
                  // resolver path, so this is the ONLY write for its action-economy cost and
                  // concentration — but two separate REST resources (character spell slots,
                  // combatant turn-state) can never be a single DB transaction without a new
                  // combined server endpoint. Spend the SLOT first — it rejects loudly with
                  // NOTHING else touched if there aren't enough left. Only on success apply
                  // the turn-state patch; if THAT rejects (e.g. the action was already used
                  // this turn), compensate by refunding the slot rather than leaving it spent
                  // with no action/concentration recorded. Either both land, or neither does.
                  const applyCastContext = () => {
                    if (!castContext) return;
                    const patch: Record<string, unknown> = {};
                    if (castContext.costSlot) patch.useSlot = castContext.costSlot;
                    if (castContext.concentrationName !== undefined) patch.concentration = castContext.concentrationName;
                    if (Object.keys(patch).length === 0) return;
                    combatantTurnState.mutate(
                      { combatantId: actor.combatantId, patch },
                      {
                        onError: () => {
                          if (level != null && delta !== 0) {
                            updateSpellSlot.mutate({ characterId, level, delta: -delta });
                          }
                        },
                      },
                    );
                  };
                  // A cantrip has no slot to spend (`level` undefined, `delta` 0) but may
                  // still carry a real castContext — apply it directly, nothing to sequence.
                  if (level != null && delta !== 0) {
                    updateSpellSlot.mutate({ characterId, level, delta }, { onSuccess: applyCastContext });
                    return;
                  }
                  applyCastContext();
                }
              : undefined
          }
          onUseSuggestedAction={
            // Review fix: bind to turnWorkspace.current — the SAME data the Spellbook and the
            // suggested-actions list render — instead of the encounter-query-derived
            // currentCombatantId/orderedCombatants. Same cross-query drift class as the
            // spell-slot fix above: after a turn advance, resolving the actor through the
            // separately-refetching encounter query could apply a resolved action (and its
            // slot/HP/effect writes) to whichever combatant that query still holds, not the
            // one actually on screen.
            turnWorkspace?.current != null && (isDm || (canPlayerWrite && turnWorkspace?.isYourTurn === true))
              ? (actionIndex, actionName, spec) => {
                  if (!spec) return;
                  const actor = turnWorkspace.current!;
                  onUseActionRequested(actor.combatantId, actor.name, actionIndex, actionName, spec);
                }
              : undefined
          }
          onEndTurn={(expectedCurrentCombatantId) =>
            endTurn.mutate({ expectedCurrentCombatantId })
          }
          endTurnBusy={endTurn.isPending}
        />
      )}

      {pendingApply && (
        <ApplyDamageBar
          key={pendingApply.id}
          amount={pendingApply.amount}
          label={pendingApply.label}
          diceTotal={pendingApply.diceTotal}
          ruleSystem={campaign?.ruleSystem}
          targets={orderedCombatants.filter((c) => canEditCombatantPermission(c) && c.hpCurrent != null)}
          applyDisabled={riskyBlocked}
          aoeTemplates={encounter.aoe ?? []}
          aoeHitContext={
            encounter.gridSize != null &&
            encounter.gridSize > 0 &&
            encounter.gridScale != null &&
            encounter.gridScale > 0 &&
            aoeHitLayout
              ? {
                  gridSize: encounter.gridSize,
                  gridScale: encounter.gridScale,
                  mapRect: aoeHitLayout.mapRect,
                  cellPx: aoeHitLayout.cellPx,
                  gridType: encounter.gridType ?? 'square',
                  hexOrientation: encounter.hexOrientation ?? 'pointy',
                  calibration: resolveGridCalibration(encounter),
                }
              : null
          }
          isStarfinder={isStarfinder}
          onApply={(combatantId, delta, damage) => {
            const actorId = hpLogActorId(pendingApply.actorCombatantId ?? currentCombatantId, combatantId);
            hpDelta.mutate({ combatantId, delta, actorId, ...damage });
            setPendingApply(null);
          }}
          onApplyToAll={(applications, delta) => {
            const actorId = pendingApply.actorCombatantId ?? currentCombatantId ?? undefined;
            void applyHpDeltaBulk(applications, delta, actorId)
              .then(() => setPendingApply(null))
              .catch(() => undefined);
          }}
          onDismiss={() => setPendingApply(null)}
        />
      )}

      {concentrationCheckCombatant && pendingConcentrationCheck && (
        <Card density="compact" className="border border-warning" role="alert" aria-live="assertive" style={{ padding: 12 }} data-testid="concentration-check-prompt">
          <strong>{concentrationCheckCombatant.name} must make a Constitution saving throw.</strong>
          <p className="text-muted" style={{ margin: '4px 0 10px' }}>
            Concentration check: DC {pendingConcentrationCheck.dc} ({pendingConcentrationCheck.damage} damage).
          </p>
          {canResolveConcentrationCheck ? (
            <div className="flex gap-2">
              <button
                type="button"
                className="btn btn-ghost"
                disabled={combatantTurnState.isPending}
                onClick={() =>
                  combatantTurnState.mutate({
                    combatantId: concentrationCheckCombatant.id,
                    patch: {
                      resolveConcentrationCheck: {
                        id: pendingConcentrationCheck.id,
                        outcome: 'pass',
                      },
                    },
                  })
                }
              >
                Passed
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={combatantTurnState.isPending}
                onClick={() =>
                  combatantTurnState.mutate({
                    combatantId: concentrationCheckCombatant.id,
                    patch: {
                      resolveConcentrationCheck: {
                        id: pendingConcentrationCheck.id,
                        outcome: 'fail',
                      },
                    },
                  })
                }
              >
                Failed — end concentration
              </button>
            </div>
          ) : (
            <p className="text-muted" style={{ margin: 0 }}>
              Waiting for the DM or this combatant&apos;s owner to resolve the save.
            </p>
          )}
        </Card>
      )}

      {pendingActionUse && (
        <ActionUsePanel
          encounterId={eid}
          actorCombatantId={pendingActionUse.combatantId}
          actorName={pendingActionUse.actorName}
          actionIndex={pendingActionUse.actionIndex}
          actionName={pendingActionUse.actionName}
          spec={pendingActionUse.spec}
          combatants={orderedCombatants}
          isDm={isDm}
          applyDisabled={riskyBlocked}
          onDismiss={() => setPendingActionUse(null)}
          onError={surfaceActionError}
          onApplied={(token, _policy, sourceEncounterId) => {
            if (!isCurrentCombatantUndoEncounter(sourceEncounterId, activeEncounterIdRef.current)) return;
            void invalidateEncounter(queryClient, sourceEncounterId);
            setPendingActionUse(null);
            if (trashedEncounterIdsRef.current.has(sourceEncounterId)) return;
            dismissCompetingRecoveryUndos();
            setActionUndo({ token, label: pendingActionUse.actionName });
          }}
        />
      )}

      {actionUndo && (
        <UndoSnackbar
          message={`${actionUndo.label} applied.`}
          successMessage="Action undone."
          onUndo={async () => {
            await undoAction.mutateAsync(actionUndo.token);
          }}
          onExpire={() => setActionUndo(null)}
        />
      )}

      {/*
          Keep the tracker and its live history in the same cockpit on large screens.
          The source order deliberately remains tracker → logs: on smaller viewports the
          grid collapses to the existing single-column reading flow, and keyboard users
          reach the turn order before its supporting history. `lg:sticky` keeps the
          right rail visible while a long roster (or expanded character cards) scrolls.
      */}
      <div
        data-testid="encounter-cockpit"
        className="grid gap-4 min-w-0 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start"
      >
        <div className="space-y-4 min-w-0">
          {orderedCombatants.length > 0 && (
            <InitiativeStrip
              combatants={orderedCombatants}
              currentCombatantId={encounter.currentCombatantId}
              charactersById={charactersById}
            />
          )}
          <Card density="compact" elev="sm" style={{ padding: '6px 0', gap: 0 }}>
            {sheetsStatusLabel && (
              <p
                className="text-muted"
                data-testid="inline-character-sheets-status"
                style={{ fontSize: 11, margin: 0, padding: '8px 14px 0' }}
                role="status"
                aria-live="polite"
              >
                {sheetsStatusLabel}
              </p>
            )}
            {orderedCombatants.length === 0 ? (
              <div style={{ padding: 16 }}>
                <EmptyState
                  icon="crossed-swords"
                  title={t('encounters.empty.noCombatants')}
                  hint={
                    isDm
                      ? characters.some((c) => c.status === 'active')
                        ? t('encounters.empty.noCombatantsHintDmActive')
                        : t('encounters.empty.noCombatantsHintDmNoParty')
                      : t('encounters.empty.noCombatantsHintPlayer')
                  }
                />
              </div>
            ) : (
              orderedCombatants.map((c) => (
                <CombatantRow
                  key={c.id}
                  rowRef={(el) => setCombatantRowRef(c.id, el)}
                  encounterId={eid}
                  combatant={c}
                  isCurrentTurn={c.id === currentCombatantId}
                  // Permission decides whether these controls MOUNT at all (issue #1746):
                  // a genuinely unauthorized viewer (wrong owner, ended encounter) never sees
                  // them. Whether the sync gate currently blocks writes is a separate, transient
                  // signal passed via `syncBlocked` so the row can render disabled instead of
                  // unmounting — see CombatantRow's `syncBlocked` prop. Named `canEditPermission`,
                  // not `canEdit` (Devin review finding): every write-control consumer inside
                  // CombatantRow must consult BOTH this and `syncBlocked`, and the old name read
                  // as if permission alone were sufficient.
                  canEditPermission={canEditCombatantPermission(c)}
                  syncBlocked={riskyBlocked}
                  canEditIdentity={canDmWrite && encounter.status !== 'ended'}
                  canViewStatblock={isDm}
                  canRemove={canDmWrite}
                  canSetInitiative={canDmWrite && encounter.status !== 'ended'}
                  running={encounter.status === 'running'}
                  character={
                    c.characterId != null && (isDm || ownedCharacterIds.has(c.characterId))
                      ? charactersById.get(c.characterId) ?? null
                      : null
                  }
                  openCardByDefault={
                    c.characterId != null &&
                    c.id === currentCombatantId &&
                    (isDm || ownedCharacterIds.has(c.characterId))
                  }
                  openCardOnActiveTurn={
                    c.characterId != null &&
                    c.id === currentCombatantId &&
                    (isDm || ownedCharacterIds.has(c.characterId))
                  }
                  // Omit campaignId while sheets are stale so click-to-roll cannot use obsolete mods (#421),
                  // and until a player's own character has the active turn. The DM may always override.
                  campaignId={
                    sheetsInteractive &&
                    canEditCombatant(c) &&
                    (canDmWrite || (encounter.status === 'running' && c.id === currentCombatantId))
                      ? cid
                      : undefined
                  }
                  // Issue #1898 review: the statblock read is a plain GET, not a write —
                  // it has none of the staleness/edit-permission concerns campaignId above
                  // guards against, so it must not go `undefined` (and 404 for homebrew) in
                  // exactly the read-only/offline states this prop exists to detect. Always
                  // the real route campaign id.
                  routeCampaignId={cid}
                  onRollError={surfaceActionError}
                  onApplyDamage={(amount, label, diceTotal) => onApplyDamageRolled(amount, label, diceTotal, c.id)}
                  onUseAction={
                    c.characterId != null &&
                    canEditCombatant(c) &&
                    (canDmWrite || (encounter.status === 'running' && c.id === currentCombatantId))
                      ? // Issue #1901: CharacterStatCard now hands back the SERVER's merged
                        // action index (sheet actions + equipped-item actions) plus its
                        // name/spec directly — no more re-deriving them from
                        // `ch.actions[actionIndex]`, which silently missed anything past
                        // the raw sheet's length.
                        (actionIndex, actionName, spec) => onUseActionRequested(c.id, c.name, actionIndex, actionName, spec)
                      : undefined
                  }
                  onUseMonsterAction={
                    // Permission-only mount (issue #1746): the sync gate disables the rendered
                    // "Use" buttons via `syncBlocked` below rather than unmounting the list.
                    canEditCombatantPermission(c) && c.characterId == null && (c.kind === 'monster' || c.kind === 'npc')
                      ? (actionIndex, actionName, spec) => onUseActionRequested(c.id, c.name, actionIndex, actionName, spec)
                      : undefined
                  }
                  busy={pendingCombatantIds.has(c.id) || reconcileBlocks}
                  conditionSuggestions={conditionSuggestions}
                  conditionSourceOptions={canDmWrite ? orderedCombatants.map((source) => ({ id: source.id, name: source.name })) : [{ id: c.id, name: c.name }]}
                  defaultConditionSourceCombatantId={currentCombatantId ?? c.id}
                  ruleSystem={ruleSystem}
                  onHpDelta={(delta) => {
                    // Belt-and-braces with the `busy` prop above: never let a second damage
                    // intent start while the outcome of the previous one is still unknown (#580).
                    if (reconcileBlocks) return;
                    const actorId = hpLogActorId(currentCombatantId, c.id);
                    hpDelta.mutate({ combatantId: c.id, delta, actorId });
                  }}
                  onSetTempHp={(value) => patchCombatant(c.id, { hpTemp: value })}
                  onSetDeathSaves={(patch) => patchCombatant(c.id, patch)}
                  onRollDeathSave={() => rollDeathSave(c)}
                  onRollInitiative={() => rollCombatantInitiative(c)}
                  onSetInitiative={(value) => patchCombatant(c.id, { initiative: value })}
                  onClearInitiative={() => patchCombatant(c.id, { initiative: null })}
                  onAddCondition={(cond) => patchCombatant(c.id, { addConditions: [cond] })}
                  onRemoveCondition={(cond) => patchCombatant(c.id, { removeConditions: [cond] })}
                  onRename={(name) => patchCombatant(c.id, { name })}
                  onSetHpMax={(value) => patchCombatant(c.id, { hpMax: value })}
                  onSetTokenSize={(size) => setTokenSize(c.id, size)}
                  onPatchCombatant={(patch) => patchCombatant(c.id, patch)}
                  onPatchSourceTurnState={
                    canDmWrite || c.id === currentCombatantId
                      ? (sourceCombatantId, patch) => patchCombatantTurnState(sourceCombatantId, patch)
                      : undefined
                  }
                  legendaryActions={c.legendaryActions}
                  onUseLegendary={
                    canDmWrite && c.legendaryActions
                      ? () => patchCombatantTurnState(c.id, { useSlot: LEGENDARY_ACTION_SLOT })
                      : undefined
                  }
                  onReleaseLegendary={
                    canDmWrite && c.legendaryActions && c.legendaryActions.used > 0
                      ? () => patchCombatantTurnState(c.id, { releaseSlot: LEGENDARY_ACTION_SLOT })
                      : undefined
                  }
                  onRemove={() => setConfirmRemoveCombatantId(c.id)}
                />
              ))
            )}
          </Card>

          {canDmWrite && encounter.status !== 'ended' && (
            <AddCombatantPanel
              encounterId={eid}
              campaignId={cid}
              characters={characters}
              existingCombatantCharacterIds={new Set(encounter.combatants.map((c) => c.characterId).filter((id): id is number => id != null))}
              rulePack={campaign?.ruleSystem || ''}
              onAdded={() => queryClient.invalidateQueries({ queryKey: queryKeys.encounter(eid) })}
            />
          )}
        </div>

        <aside
          className="min-w-0 space-y-4 lg:sticky lg:top-4 lg:max-h-[calc(100vh-1rem)] lg:overflow-y-auto lg:overscroll-contain"
          aria-label="Encounter activity"
        >
          <CombatLog events={events} />

          <SharedDiceLog campaignId={cid} />
        </aside>
      </div>

      {/* Issue #415: DM control to request a check/save from a character. DM-only; players see
          the resulting prompt above via CheckRequestPrompts. */}
      <ResourceTrackerPanel campaignId={cid} encounterId={eid} characters={characters} combatants={orderedCombatants} canDmWrite={canDmWrite} canPlayerWrite={canPlayerWrite} ownedCharacterIds={ownedCharacterIds} encounterWritable={encounter.status !== 'ended'} encounterUpdatedAt={encounter.updatedAt} />

      {canDmWrite && <CheckRequestPanel campaignId={cid} characters={characters} encounterId={eid} onError={surfaceActionError} />}

      <EntityDiscussion campaignId={cid} entityType="encounter" entityId={encounter.id} />

      {confirmEnd && (
        <ConfirmDialog
          title={t('encounters.run.endDialog.title')}
          body={t('encounters.run.endDialog.body')}
          confirmLabel={t('encounters.run.endDialog.confirm')}
          pendingLabel={t('encounters.run.endDialog.pending')}
          busy={runControl.isPending}
          onConfirm={endEncounter}
          onCancel={() => setConfirmEnd(false)}
        />
      )}
      {confirmReopen && (
        <ConfirmDialog
          title={t('encounters.run.reopenDialog.title')}
          body={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <p style={{ margin: 0 }}>
                {t('encounters.run.reopenDialog.body')}
              </p>
              {hpSyncConflicts.length === 0 ? (
                <p className="text-muted" style={{ margin: 0, fontSize: 13 }}>
                  {t('encounters.run.reopenDialog.noConflicts')}
                </p>
              ) : (
                <div data-testid="hp-resync-conflicts" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {hpSyncConflicts.map((c) => (
                    <fieldset
                      key={c.combatantId}
                      style={{
                        margin: 0,
                        padding: '10px 12px',
                        border: '1px solid var(--color-divider)',
                        borderRadius: 'var(--radius-md)',
                      }}
                    >
                      <legend style={{ fontWeight: 600, padding: '0 4px' }}>{c.name}</legend>
                      <p className="text-muted" style={{ margin: '0 0 8px', fontSize: 12.5 }}>
                        Combat snapshot {c.combatant.hpCurrent} HP
                        {c.combatant.hpTemp > 0 ? ` (+${c.combatant.hpTemp} temp)` : ''} · sheet{' '}
                        {c.sheet.hpCurrent} HP
                        {c.sheet.hpTemp > 0 ? ` (+${c.sheet.hpTemp} temp)` : ''}
                      </p>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {(
                          [
                            ['pull_sheet', 'Keep sheet HP (pull into combat)'],
                            ['keep_combatant', 'Keep combat snapshot (overwrite sheet on next End)'],
                          ] as const
                        ).map(([value, label]) => (
                          <label
                            key={value}
                            style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 44, cursor: 'pointer' }}
                          >
                            <input
                              type="radio"
                              name={`hp-resync-${c.combatantId}`}
                              value={value}
                              checked={hpResyncChoices[c.combatantId] === value}
                              onChange={() =>
                                setHpResyncChoices((prev) => ({ ...prev, [c.combatantId]: value }))
                              }
                            />
                            <span style={{ fontSize: 13 }}>{label}</span>
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  ))}
                </div>
              )}
            </div>
          }
          confirmLabel={t('encounters.run.reopenDialog.confirm')}
          pendingLabel={t('encounters.run.reopenDialog.pending')}

          busy={runControl.isPending}
          confirmDisabled={!reopenChoicesComplete}
          onConfirm={reopenEncounter}
          onCancel={() => {
            setConfirmReopen(false);
            setHpResyncChoices({});
          }}
        />
      )}
      {confirmDelete && (
        <ConfirmDialog
          title={deleteCopy.title}
          body={deleteCopy.body}
          confirmLabel={
            encounter.status === 'preparing' ? 'Cancel preparation' : 'Delete encounter'
          }
          pendingLabel={
            encounter.status === 'preparing' ? 'Cancelling preparation…' : 'Deleting encounter…'
          }
          busy={deleteEncounterMut.isPending}
          onConfirm={deleteEncounter}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
      {pendingTrashUndo && (
        <UndoSnackbar
          message="Encounter moved to Trash."
          onUndo={undoTrashEncounter}
          onExpire={() => navigate(`/c/${cid}/encounters`)}
        />
      )}
      {pendingCombatantUndo && (
        <UndoSnackbar
          key={pendingCombatantUndo.undoToken}
          message={`${pendingCombatantUndo.name} removed from the encounter.`}
          onUndo={undoRemoveCombatant}
          onExpire={() => setPendingCombatantUndo(null)}
          successMessage={`${pendingCombatantUndo.name} restored to the encounter.`}
        />
      )}
      {confirmRemoveCombatantId != null && (
        <ConfirmDialog
          title="Remove this combatant from the encounter?"
          body={REMOVE_COMBATANT_CONFIRM_BODY}
          confirmLabel="Remove"
          pendingLabel="Removing…"
          busy={pendingCombatantIds.has(confirmRemoveCombatantId)}
          onConfirm={() => removeCombatant(confirmRemoveCombatantId)}
          onCancel={() => setConfirmRemoveCombatantId(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

// `tokenInitials` is the shared grapheme-aware helper (issue #631): two-letter
// token labels from a combatant name ("Ashen cultist" -> "AC", "Goblin 1" -> "G1").

// Token footprint categories (issue #40 / #468) — diameters derive from calibrated grid cells.
function CombatantRow({
  rowRef,
  encounterId,
  combatant,
  isCurrentTurn,
  canEditPermission,
  syncBlocked,
  canEditIdentity,
  canViewStatblock,
  canRemove,
  canSetInitiative,
  running,
  character,
  openCardByDefault,
  openCardOnActiveTurn,
  campaignId,
  routeCampaignId,
  onRollError,
  onApplyDamage,
  onUseAction,
  onUseMonsterAction,
  busy,
  conditionSuggestions,
  conditionSourceOptions,
  defaultConditionSourceCombatantId,
  ruleSystem,
  onHpDelta,
  onSetTempHp,
  onSetDeathSaves,
  onRollDeathSave,
  onRollInitiative,
  onSetInitiative,
  onClearInitiative,
  onAddCondition,
  onRemoveCondition,
  onRename,
  onSetHpMax,
  onSetTokenSize,
  onPatchCombatant,
  onPatchSourceTurnState,
  legendaryActions,
  onUseLegendary,
  onReleaseLegendary,
  onRemove,
}: {
  rowRef?: (el: HTMLDivElement | null) => void;
  encounterId: number;
  combatant: Combatant;
  isCurrentTurn: boolean;
  /**
   * Permission to edit this combatant right now — PERMISSION ONLY (issue #1746 —
   * named explicitly, not `canEdit`, after a Devin review finding: a name that could
   * be misread as "permitted and not blocked" is exactly how the death-save tracker
   * silently lost its sync-gate disable when this prop was split out). This governs
   * whether editing controls MOUNT at all; it never implies the sync gate is clear —
   * check `syncBlocked` too for any control that writes conflict-prone state.
   */
  canEditPermission: boolean;
  /**
   * Issue #1746: the encounter sync gate is currently blocking conflict-prone writes
   * (`riskyBlocked` at the call site). Distinct from `canEditPermission`: a permitted
   * viewer's controls stay mounted and are rendered disabled with an accessible
   * reason instead of disappearing, so a reconnect never reflows the row. EVERY
   * control that performs a write must consult both — permission for mount, this for
   * disabled — never `canEditPermission` alone.
   */
  syncBlocked: boolean;
  canEditIdentity: boolean;
  canViewStatblock: boolean;
  canRemove: boolean;
  canSetInitiative: boolean;
  /** Encounter is running — clearing initiative re-sorts the live turn order (issue #715). */
  running: boolean;
  /** The linked player character (kind === 'character'), for the in-encounter stat card; null otherwise. */
  character: Character | null;
  /** Start the character card expanded — used for the viewer's own character. */
  openCardByDefault: boolean;
  /** Open the character card when this row becomes the active, visible character. */
  openCardOnActiveTurn: boolean;
  /**
   * Campaign id — enables click-to-roll for an active owned character, or any DM-visible character.
   * Undefined while SSE is offline/reconnecting so obsolete modifiers cannot be rolled (#421).
   */
  campaignId: number | undefined;
  /**
   * The real route campaign id, unconditionally (issue #1898 review) — for the plain
   * read-only statblock GET, which has none of `campaignId` above's staleness/edit
   * concerns and must not 404 for a homebrew-linked combatant just because sheets are
   * offline or this combatant isn't currently editable.
   */
  routeCampaignId: number;
  onRollError: (msg: string | null) => void;
  /** A damage total rolled from the card, to be applied to a target combatant. */
  onApplyDamage: (amount: number, label: string, diceTotal?: number) => void;
  /**
   * Issue #414 / #425 / #1901: open the structured action Use flow. Carries the action's
   * name/spec alongside the (server-merged, for a character) index — same shape as
   * `onUseMonsterAction` below.
   */
  onUseAction?: (actionIndex: number, actionName: string, spec: ActionSpec) => void;
  onUseMonsterAction?: (actionIndex: number, actionName: string, spec: ActionSpec) => void;
  busy: boolean;
  /** Condition chips offered by the active campaign's rule-system adapter (issue #234). */
  conditionSuggestions: readonly string[];
  /** Visible combatants that may be recorded as the source/caster of a condition (issue #423). */
  conditionSourceOptions: readonly ConditionSourceOption[];
  /** Best default source for new conditions: usually the current turn actor. */
  defaultConditionSourceCombatantId: number | null;
  /** Active campaign's rule system — selects the statblock adapter (issue #234). */
  ruleSystem: string | null;
  onHpDelta: (delta: number) => void;
  onSetTempHp: (value: number) => void;
  onSetDeathSaves: (patch: { deathSaveSuccesses?: number; deathSaveFailures?: number }) => void;
  /** Roll a death save through the server-authoritative d20 + shared dice-log action. */
  onRollDeathSave: () => void;
  /**
   * Roll this combatant's own initiative through the server-authoritative die + shared
   * dice-log action (issue #1904). Rendered only for a null-initiative combatant the
   * viewer may edit (their own owned combatant, or the DM); the ownership/already-set
   * checks are still enforced server-side.
   */
  onRollInitiative: () => void;
  onSetInitiative: (value: number) => void;
  /** Clear initiative back to the unrolled state (issue #715) — sends `initiative: null`. */
  onClearInitiative: () => void;
  onAddCondition: (cond: string) => void;
  onRemoveCondition: (cond: string) => void;
  onRename: (name: string) => void;
  onSetHpMax: (value: number) => void;
  onSetTokenSize: (size: TokenSize) => void;
  onPatchCombatant?: (patch: Record<string, unknown>) => void;
  onPatchSourceTurnState?: (combatantId: number, patch: Record<string, unknown>) => void;
  legendaryActions?: Combatant['legendaryActions'];
  onUseLegendary?: () => void;
  onReleaseLegendary?: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  // Issue #1746: one shared reason string for every write control this row disables while
  // the sync gate blocks — kept as a single computed value so every site stays in agreement
  // rather than re-deriving (and risking drift on) the same condition. Exposed to assistive
  // tech via `aria-describedby` (below) rather than `title` alone, which screen readers
  // announce inconsistently and keyboard-only users cannot reach at all.
  const syncBlockedReason = syncBlocked ? t('encounters.sync.controlsPaused') : undefined;
  const syncBlockedReasonId = `combatant-${combatant.id}-sync-blocked-reason`;
  const syncBlockedDescribedBy = syncBlocked ? syncBlockedReasonId : undefined;
  const [addingCondition, setAddingCondition] = useState(false);
  const [showFullCondition, setShowFullCondition] = useState(false);
  const [exactHp, setExactHp] = useState('');
  const [editingIdentity, setEditingIdentity] = useState(false);
  const [nameDraft, setNameDraft] = useState(combatant.name);
  const [hpMaxDraft, setHpMaxDraft] = useState(combatant.hpMax?.toString() ?? '');
  const [tempDraft, setTempDraft] = useState('');
  const [conditionDraft, setConditionDraft] = useState<ConditionDraft>(() => emptyConditionDraft(defaultConditionSourceCombatantId));
  const [editingConditionId, setEditingConditionId] = useState<string | null>(null);
  useEffect(() => {
    setNameDraft(combatant.name);
    setHpMaxDraft(combatant.hpMax?.toString() ?? '');
  }, [combatant.name, combatant.hpMax]);
  useEffect(() => {
    setConditionDraft((prev) =>
      prev.sourceCombatantId
        ? prev
        : { ...prev, sourceCombatantId: defaultConditionSourceCombatantId == null ? '' : String(defaultConditionSourceCombatantId) },
    );
  }, [defaultConditionSourceCombatantId]);

  const adapter = useMemo(() => ruleSystemAdapter(ruleSystem), [ruleSystem]);
  const isStarfinder = adapter.id === STARFINDER_ADAPTER_ID || ruleSystem?.startsWith('starfinder');
  const hasSfPools = isStarfinder || (combatant.spMax != null && combatant.spMax > 0) || (combatant.rpMax != null && combatant.rpMax > 0);

  function commitIdentity() {
    const trimmedName = nameDraft.trim();
    if (trimmedName && trimmedName !== combatant.name) onRename(trimmedName);
    const nextHpMax = Number(hpMaxDraft);
    if (Number.isInteger(nextHpMax) && nextHpMax >= 1 && nextHpMax !== combatant.hpMax) onSetHpMax(nextHpMax);
    setEditingIdentity(false);
  }

  function commitTempHp() {
    const trimmed = tempDraft.trim();
    if (trimmed === '') return;
    const value = Number(trimmed);
    if (!Number.isInteger(value) || value < 0) return;
    onSetTempHp(value);
    setTempDraft('');
  }

  function submitConditionDraft(event?: FormEvent) {
    event?.preventDefault();
    const instance = buildConditionInstance(conditionDraft, conditionSuggestions, combatant.conditionInstances ?? [], editingConditionId ?? undefined);
    if (!instance) return;
    if (onPatchCombatant) {
      onPatchCombatant(editingConditionId ? { updateConditionInstance: instance } : { addConditionInstance: instance });
      if (instance.isConcentration && instance.sourceCombatantId != null && conditionDraft.syncConcentration && onPatchSourceTurnState) {
        onPatchSourceTurnState(instance.sourceCombatantId, { concentration: instance.name });
      }
    } else {
      onAddCondition(instance.name);
    }
    setConditionDraft(emptyConditionDraft(defaultConditionSourceCombatantId));
    setEditingConditionId(null);
    setShowFullCondition(false);
    setAddingCondition(false);
  }
  // Draft of the initiative field (DM only). Kept local so typing doesn't fire a
  // PATCH per keystroke — committed on blur / Enter.
  const [initDraft, setInitDraft] = useState<string>(combatant.initiative?.toString() ?? '');
  useEffect(() => {
    setInitDraft(combatant.initiative?.toString() ?? '');
  }, [combatant.initiative]);

  function commitInitiative() {
    const trimmed = initDraft.trim();
    // Empty input now CLEARS initiative back to the unrolled state (issue #715),
    // instead of silently leaving it as-is. An explicit Clear control is also
    // rendered beside the input for discoverability + keyboard access.
    if (trimmed === '') {
      if (combatant.initiative !== null) onClearInitiative();
      return;
    }
    const value = Number(trimmed);
    if (!Number.isInteger(value) || value === combatant.initiative) return;
    onSetInitiative(value);
  }

  // Clear initiative back to null (issue #715). While combat is running this re-sorts
  // the order — the cleared combatant sinks below every rolled actor — so the title
  // warns the DM. The current-turn pointer is identity-based and stays stable; the
  // server reconciles the positional turnIndex after the write.
  const runningReorderNote =
    'Clear initiative back to unrolled' +
    (running ? ' — re-sorts the turn order while combat is running' : '');

  const edgeColor = isCurrentTurn ? 'var(--color-accent)' : 'transparent';
  const kindTagClass = combatant.kind === 'character' ? 'tag tag-accent' : combatant.kind === 'npc' ? 'tag tag-outline' : 'tag tag-neutral';
  const kindLabel = combatant.kind === 'npc' ? 'NPC' : combatant.kind;
  // Issue #107: a combatant at 0 HP got no visual treatment mid-fight — the row
  // looked identical bar an empty HP bar, so a "dead" creature was invisible in the
  // order (the end-of-combat summary counts dead/downed separately — issue #492). Dim + desaturate
  // the whole row and skull/strike-through the name. `isDown` works off the HP band
  // too, so a redacted monster (exact HP hidden, band 'down') gets the same treatment.
  const down = isDown(combatant);

  return (
    <div
      ref={rowRef}
      data-testid={`combatant-row-${combatant.id}`}
      data-current-turn={isCurrentTurn ? 'true' : undefined}
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 10,
        padding: '9px 14px',
        borderLeft: `2px solid ${edgeColor}`,
        background: isCurrentTurn ? 'color-mix(in srgb, var(--color-accent) 8%, transparent)' : 'transparent',
        boxShadow: isCurrentTurn ? '0 0 0 1px color-mix(in srgb, var(--color-accent) 35%, transparent)' : 'none',
        opacity: down ? 0.55 : 1,
        filter: down ? 'grayscale(0.75)' : 'none',
      }}
    >
      {/* Issue #1746: single accessible reason shared by every write control this row
          disables while the sync gate blocks, referenced via aria-describedby below. */}
      {syncBlocked && (
        <span id={syncBlockedReasonId} className="sr-only">
          {syncBlockedReason}
        </span>
      )}
      {canSetInitiative ? (
        <div className="flex items-center" style={{ gap: 2 }}>
          <input
            type="number"
            className="input cf-target-44"
            aria-label={`Initiative for ${combatant.name}`}
            title={combatant.initiativeBreakdown?.formula || "Set initiative"}
            value={initDraft}
            disabled={busy}
            placeholder="–"
            onChange={(e) => setInitDraft(e.target.value)}
            onBlur={commitInitiative}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !isImeComposing(e)) {
                e.preventDefault();
                (e.target as HTMLInputElement).blur();
              }
              // Backspace/Delete on an empty field clears initiative (issue #715) — a
              // keyboard-only path that mirrors the dedicated Clear button below.
              if ((e.key === 'Backspace' || e.key === 'Delete') && initDraft.trim() === '') {
                e.preventDefault();
                if (combatant.initiative !== null) onClearInitiative();
              }
            }}
            style={{
              width: 44,
              minWidth: 44,
              height: 44,
              minHeight: 44,
              flex: 'none',
              textAlign: 'center',
              fontSize: 13,
              fontFamily: 'var(--font-heading)',
              color: isCurrentTurn ? 'var(--color-accent)' : 'var(--color-text)',
            }}
          />
          {combatant.initiative !== null && (
            <button
              type="button"
              className="btn btn-ghost cf-target-44"
              aria-label={`Clear ${combatant.name} roll order`}
              title={runningReorderNote}
              disabled={busy}
              onClick={() => {
                setInitDraft('');
                onClearInitiative();
              }}
              style={{
                flex: 'none',
                padding: 0,
              }}
            >
              <UIIcon name="close" size="xs" />
            </button>
          )}
          {adapter.initiativeModel?.mode === 'group' && (
            <select
              className="input cf-target-44"
              aria-label={`Initiative group for ${combatant.name}`}
              aria-describedby={syncBlocked ? syncBlockedReasonId : undefined}
              value={combatant.initiativeGroup ?? (combatant.kind === 'character' ? 'party' : 'monsters')}
              onChange={(e) => onPatchCombatant?.({ initiativeGroup: e.target.value })}
              disabled={busy || syncBlocked || !canSetInitiative}
              title="Initiative group"
              style={{ width: 'auto', marginLeft: 4 }}
            >
              <option value="party">Party</option>
              <option value="monsters">Monsters</option>
            </select>
          )}
        </div>
      ) : (
        <div className="flex items-center" style={{ gap: 2 }}>
          {combatant.initiative === null && canEditPermission && adapter.initiativeModel?.mode !== 'group' ? (
            // Issue #1904: a server-authoritative roll (crypto RNG, breakdown, combat-log
            // event, and a labeled shared dice-log row), not a client-computed value pushed
            // through the manual PATCH — a player's own die roll is now real evidence, not
            // a trusted client claim. Hidden under group initiative (issue #765): a side
            // shares one roll, which only the DM's bulk "Roll remaining" can produce.
            <button
              type="button"
              className="btn btn-primary cf-target-44"
              data-testid={`roll-initiative-${combatant.id}`}
              aria-label={`Roll initiative for ${combatant.name}`}
              aria-describedby={syncBlocked ? syncBlockedReasonId : undefined}
              style={{ padding: '0 8px', height: 30, fontSize: 12, flex: 'none' }}
              disabled={busy || syncBlocked}
              title="Roll initiative"
              onClick={onRollInitiative}
            >
              Roll initiative
            </button>
          ) : (
            <span
              title={combatant.initiativeBreakdown?.formula}
              style={{
                width: 30,
                height: 30,
                flex: 'none',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--color-divider)',
                display: 'grid',
                placeItems: 'center',
                fontSize: 13,
                fontFamily: 'var(--font-heading)',
                color: isCurrentTurn ? 'var(--color-accent)' : 'var(--color-text)',
              }}
            >
              {combatant.initiative ?? '–'}
            </span>
          )}
          {adapter.initiativeModel?.mode === 'group' && (
            <select
              className="input cf-target-44"
              value={combatant.initiativeGroup ?? (combatant.kind === 'character' ? 'party' : 'monsters')}
              onChange={(e) => onPatchCombatant?.({ initiativeGroup: e.target.value })}
              disabled={busy || syncBlocked}
              title="Initiative group"
              style={{ width: 'auto', marginLeft: 4 }}
            >
              <option value="party">Party</option>
              <option value="monsters">Monsters</option>
            </select>
          )}
        </div>
      )}
      <div style={{ flex: 1, minWidth: 160 }}>
        {editingIdentity ? (
          <div className="flex gap-2 items-end flex-wrap" style={{ marginBottom: 4 }}>
            <div className="field" style={{ flex: 1, minWidth: 120 }}>
              <label htmlFor={`rename-${combatant.id}`}>Name</label>
              <TextInput
                id={`rename-${combatant.id}`}
                value={nameDraft}
                disabled={busy}
                autoFocus
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !isImeComposing(e)) { e.preventDefault(); commitIdentity(); }
                  if (e.key === 'Escape') { setEditingIdentity(false); setNameDraft(combatant.name); }
                }}
              />
            </div>
            <div className="field" style={{ width: 72 }}>
              <label htmlFor={`hpmax-${combatant.id}`}>Max HP</label>
              <TextInput
                id={`hpmax-${combatant.id}`}
                aria-label={`Max HP for ${combatant.name}`}
                value={hpMaxDraft}
                disabled={busy}
                onChange={(e) => setHpMaxDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !isImeComposing(e)) { e.preventDefault(); commitIdentity(); }
                  if (e.key === 'Escape') { setEditingIdentity(false); setHpMaxDraft(combatant.hpMax?.toString() ?? ''); }
                }}
              />
            </div>
            <div className="field" style={{ width: 108 }}>
              <label htmlFor={`tokensize-${combatant.id}`}>Token size</label>
              <select
                id={`tokensize-${combatant.id}`}
                aria-label={`Token size for ${combatant.name}`}
                value={combatant.tokenSize}
                disabled={busy}
                onChange={(e) => onSetTokenSize(e.target.value as TokenSize)}
                style={{ height: 32, borderRadius: 'var(--radius-md)', border: '1px solid var(--color-divider)', background: 'transparent', color: 'var(--color-text)', fontSize: 12, padding: '0 6px' }}
              >
                {TOKEN_SIZE_OPTIONS.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
            <Btn onClick={commitIdentity} disabled={busy}>Save</Btn>
            <button className="btn btn-ghost" style={{ fontSize: 'var(--type-label)' }} onClick={() => { setEditingIdentity(false); setNameDraft(combatant.name); setHpMaxDraft(combatant.hpMax?.toString() ?? ''); }}>Cancel</button>
          </div>
        ) : (
          <div style={{ fontSize: 14, display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <span style={down ? { textDecoration: 'line-through' } : undefined}>
              {down && <GameIcon slug="death-skull" size={UI_ICON_SIZE.xs} className="inline align-text-bottom mr-1.5" />}
              {combatant.name}
            </span>
            <span className={kindTagClass}>
              {kindLabel}
            </span>
            {legendaryActions && (
              <span
                className="tag tag-neutral"
                data-testid={`legendary-actions-${combatant.id}`}
                title="Legendary actions used this round"
              >
                Legendary {legendaryActions.max - legendaryActions.used}/{legendaryActions.max}
              </span>
            )}
            {legendaryActions && (onUseLegendary || onReleaseLegendary) && (
              <span className="flex gap-1 items-center">
                {onUseLegendary && (
                  <button
                    type="button"
                    className="btn btn-ghost text-[11px] cf-density-xs"
                    disabled={busy || legendaryActions.used >= legendaryActions.max}
                    onClick={onUseLegendary}
                  >
                    −1 leg
                  </button>
                )}
                {onReleaseLegendary && (
                  <button
                    type="button"
                    className="btn btn-ghost text-[11px] cf-density-xs"
                    disabled={busy}
                    onClick={onReleaseLegendary}
                  >
                    +1 leg
                  </button>
                )}
              </span>
            )}
            {(isStarfinder || combatant.eac != null || combatant.kac != null) && (
              <span className="tag tag-neutral" style={{ fontSize: 10 }} title="Energy AC (EAC) / Kinetic AC (KAC)" data-testid="starfinder-ac-tag">
                EAC {combatant.eac ?? '—'} · KAC {combatant.kac ?? '—'}
              </span>
            )}
            {combatant.deathState !== 'none' && combatant.deathState !== undefined ? (
              <span className="tag tag-outline">
                {DEATH_STATE_LABEL[combatant.deathState] ?? 'Down'}
              </span>
            ) : (
              down && (
                <span className="tag tag-outline">
                  Down
                </span>
              )
            )}
            {combatant.turnState?.delaying && (
              <span className="tag tag-neutral" data-testid={`delaying-${combatant.id}`} title="Delaying their turn">
                Delaying
              </span>
            )}
            {combatant.turnState?.readied && (
              <span
                className="tag tag-neutral"
                data-testid={`readied-${combatant.id}`}
                title={`Readied: ${combatant.turnState.readied}`}
              >
                Readied
              </span>
            )}
            {combatant.turnState?.concentration && (
              <span
                className="tag tag-outline"
                data-testid={`concentration-${combatant.id}`}
                title={`Concentrating on ${combatant.turnState.concentration}`}
                style={{ gap: 6 }}
              >
                Conc: {combatant.turnState.concentration}
                {canEditPermission && onPatchSourceTurnState && (
                  <button
                    type="button"
                    aria-label={`Clear ${combatant.name} concentration`}
                    aria-describedby={syncBlockedDescribedBy}
                    onClick={() => onPatchSourceTurnState(combatant.id, { concentration: null })}
                    disabled={busy || syncBlocked}
                    title={syncBlockedReason}
                    style={{
                      cursor: busy || syncBlocked ? 'default' : 'pointer',
                      opacity: 0.7,
                      background: 'transparent',
                      border: 0,
                      padding: 0,
                      font: 'inherit',
                      color: 'inherit',
                    }}
                  >
                    <span aria-hidden="true">x</span>
                  </button>
                )}
              </span>
            )}
            {canEditIdentity && (
              <button
                type="button"
                className="btn btn-ghost cf-target-44"
                aria-label={`Rename ${combatant.name} or edit its max HP`}
                title="Rename / edit max HP"
                disabled={busy}
                onClick={() => setEditingIdentity(true)}
                style={{ fontSize: 'var(--type-label)' }}
              >
                ✎
              </button>
            )}
          </div>
        )}
        {/* Death-save tracker (issue #57): shown for a character that is dying/stable/dead,
            or any character sitting at 0 HP. Monsters never roll death saves. */}
        {combatant.kind === 'character' &&
          hasDeathSavesForAdapter(adapter) &&
          (combatant.deathState === 'dying' ||
            combatant.deathState === 'stable' ||
            combatant.deathState === 'dead' ||
            (combatant.hpCurrent != null && combatant.hpCurrent <= 0)) && (
            <DeathSaveTracker
              successes={combatant.deathSaveSuccesses ?? 0}
              failures={combatant.deathSaveFailures ?? 0}
              canEditPermission={canEditPermission}
              canRoll={combatant.deathState === 'dying'}
              busy={busy}
              syncBlocked={syncBlocked}
              syncBlockedReason={syncBlockedReason}
              syncBlockedDescribedBy={syncBlockedDescribedBy}
              onSet={onSetDeathSaves}
              onRoll={onRollDeathSave}
            />
          )}
        {(combatant.conditionInstances?.length ?? 0) > 0 ? (
          <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
            {combatant.conditionInstances!.map((inst) => {
              const sourceCombatantName = conditionSourceLabel(inst.sourceCombatantId, conditionSourceOptions);
              const details = [
                inst.source ? `Source: ${inst.source}` : '',
                sourceCombatantName ? `Source combatant: ${sourceCombatantName}` : '',
                inst.ruleEntryId != null ? `Rule entry #${inst.ruleEntryId}` : '',
                inst.roundsRemaining != null ? `${inst.roundsRemaining} round${inst.roundsRemaining === 1 ? '' : 's'} remaining` : '',
                inst.timing !== 'none' ? `Expires: ${inst.timing}` : '',
                inst.saveTiming !== 'none' ? `Save timing: ${inst.saveTiming}` : '',
                inst.isConcentration ? 'Concentration-linked' : '',
                inst.custom ? 'Custom condition' : '',
                inst.notes ? `Notes: ${inst.notes}` : '',
                inst.saveAbility ? `Save: DC ${inst.saveDc ?? '?'} ${inst.saveAbility}` : '',
              ].filter(Boolean).join(' · ');
              return (
                <span
                  key={inst.id || inst.name}
                  className="tag tag-outline"
                  title={details || inst.name}
                  style={{ gap: 6, display: 'inline-flex', alignItems: 'center' }}
                >
                  <span>
                    {inst.name}
                    {inst.stacks > 1 && <strong style={{ marginLeft: 3 }}>×{inst.stacks}</strong>}
                    {inst.isConcentration && (
                      <span role="img" aria-label="Concentration linked" title="Concentration linked" style={{ marginLeft: 4 }}>
                        🔮
                      </span>
                    )}
                    {inst.roundsRemaining != null && (
                      <span className="tag tag-neutral text-[10px]" style={{ marginLeft: 4, padding: '0 4px' }}>
                        {inst.roundsRemaining}r
                      </span>
                    )}
                    {inst.saveAbility && (
                      <span className="text-[10px] text-muted" style={{ marginLeft: 4 }}>
                        [{inst.saveAbility}{inst.saveDc != null ? ` ${inst.saveDc}` : ''}]
                      </span>
                    )}
                  </span>
                  {canEditPermission && (
                    <>
                      <button
                        type="button"
                        className="cf-target-44"
                        aria-label={`Edit ${inst.name}`}
                        aria-describedby={syncBlockedDescribedBy}
                        onClick={() => {
                          setEditingConditionId(inst.id);
                          setConditionDraft(conditionDraftFromInstance(inst));
                          setShowFullCondition(true);
                          setAddingCondition(true);
                        }}
                        disabled={busy || syncBlocked}
                        title={syncBlockedReason}
                        style={{
                          cursor: busy || syncBlocked ? 'default' : 'pointer',
                          opacity: 0.7,
                          background: 'transparent',
                          border: 0,
                          padding: 0,
                          font: 'inherit',
                          color: 'inherit',
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <span aria-hidden="true">edit</span>
                      </button>
                      <button
                        type="button"
                        className="cf-target-44"
                        aria-label={`Remove ${inst.name}`}
                        aria-describedby={syncBlockedDescribedBy}
                        onClick={() => onPatchCombatant ? onPatchCombatant({ removeConditionInstanceId: inst.id }) : onRemoveCondition(inst.name)}
                        disabled={busy || syncBlocked}
                        title={syncBlockedReason}
                        style={{
                          cursor: busy || syncBlocked ? 'default' : 'pointer',
                          opacity: 0.7,
                          background: 'transparent',
                          border: 0,
                          padding: 0,
                          font: 'inherit',
                          color: 'inherit',
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <span aria-hidden="true">x</span>
                      </button>
                    </>
                  )}
                </span>
              );
            })}
          </div>
        ) : combatant.conditions.length > 0 ? (
          <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
            {combatant.conditions.map((cond) => (
              <span key={cond} className="tag tag-outline" style={{ gap: 6 }}>
                {cond}
                {canEditPermission && (
                  <button
                    type="button"
                    className="cf-target-44"
                    aria-label={`Remove ${cond}`}
                    aria-describedby={syncBlockedDescribedBy}
                    onClick={() => onRemoveCondition(cond)}
                    disabled={busy || syncBlocked}
                    title={syncBlockedReason}
                    style={{
                      cursor: busy || syncBlocked ? 'default' : 'pointer',
                      opacity: 0.7,
                      background: 'transparent',
                      border: 0,
                      padding: 0,
                      font: 'inherit',
                      color: 'inherit',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <UIIcon name="close" size="xs" />
                  </button>
                )}
              </span>
            ))}
          </div>
        ) : null}

        {canEditPermission && (
          <div style={{ marginTop: 4, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {addingCondition ? (
              (!showFullCondition && !editingConditionId) ? (
                <div
                  className="flex gap-2 flex-wrap items-center"
                  style={{
                    boxSizing: 'border-box',
                    width: '100%',
                    padding: 8,
                    border: '1px dashed var(--color-divider)',
                    borderRadius: 'var(--radius-lg)',
                    background: 'color-mix(in srgb, var(--color-surface) 96%, var(--color-accent) 4%)',
                  }}
                >
                  <p className="text-muted text-xs" style={{ flexBasis: '100%', margin: 0 }}>
                    Quick condition:
                  </p>
                  {conditionSuggestions.slice(0, 12).map((s) => (
                    <button
                      key={s}
                      type="button"
                      className="btn btn-ghost"
                      disabled={busy || syncBlocked}
                      style={{ fontSize: 'var(--type-label)' }}
                      onClick={() => {
                        const instance = buildConditionInstance({ ...emptyConditionDraft(defaultConditionSourceCombatantId), name: s }, conditionSuggestions, combatant.conditionInstances ?? [], undefined);
                        if (!instance) return;
                        if (onPatchCombatant) {
                          onPatchCombatant({ addConditionInstance: instance });
                        } else {
                          onAddCondition(instance.name);
                        }
                        setAddingCondition(false);
                      }}
                    >
                      {s}
                    </button>
                  ))}
                  <button type="button" className="btn btn-ghost" style={{ fontSize: 'var(--type-label)' }} onClick={() => setShowFullCondition(true)}>More options…</button>
                  <button type="button" className="btn btn-ghost" style={{ fontSize: 'var(--type-label)' }} onClick={() => setAddingCondition(false)}>Cancel</button>
                </div>
              ) : (
              <form
                onSubmit={submitConditionDraft}
                className="flex gap-2 flex-wrap items-end"
                style={{
                  boxSizing: 'border-box',
                  width: '100%',
                  padding: 8,
                  border: '1px dashed var(--color-divider)',
                  borderRadius: 'var(--radius-lg)',
                  background: 'color-mix(in srgb, var(--color-surface) 96%, var(--color-accent) 4%)',
                }}
              >
                <p className="text-muted text-xs" style={{ flexBasis: '100%', margin: 0 }}>
                  {editingConditionId ? 'Edit structured condition instance.' : 'Add a structured condition instance.'}
                </p>
                <div className="field" style={{ minWidth: 150, flex: '1 1 180px' }}>
                  <label htmlFor={`condition-name-${combatant.id}`}>Condition</label>
                  <input
                    id={`condition-name-${combatant.id}`}
                    className="input cf-target-44"
                    list={`condition-vocab-${combatant.id}`}
                    value={conditionDraft.name}
                    maxLength={40}
                    disabled={busy}
                    autoFocus
                    placeholder="Known or custom condition"
                    onChange={(e) => setConditionDraft((prev) => ({ ...prev, name: e.target.value }))}
                  />
                  <datalist id={`condition-vocab-${combatant.id}`}>
                    {conditionSuggestions.map((s) => (
                      <option key={s} value={s} />
                    ))}
                  </datalist>
                </div>
                <div className="field" style={{ minWidth: 130, flex: '1 1 150px' }}>
                  <label htmlFor={`condition-source-${combatant.id}`}>Source</label>
                  <input
                    id={`condition-source-${combatant.id}`}
                    className="input cf-target-44"
                    value={conditionDraft.source}
                    maxLength={160}
                    disabled={busy}
                    placeholder="Spell, trap, aura..."
                    onChange={(e) => setConditionDraft((prev) => ({ ...prev, source: e.target.value }))}
                  />
                </div>
                <div className="field" style={{ minWidth: 130, flex: '1 1 150px' }}>
                  <label htmlFor={`condition-source-combatant-${combatant.id}`}>Source combatant</label>
                  <select
                    id={`condition-source-combatant-${combatant.id}`}
                    value={conditionDraft.sourceCombatantId}
                    disabled={busy}
                    onChange={(e) => setConditionDraft((prev) => ({ ...prev, sourceCombatantId: e.target.value }))}
                    className="input cf-target-44"
                    style={{ borderRadius: 'var(--radius-md)', border: '1px solid var(--color-divider)', background: 'transparent', color: 'var(--color-text)', fontSize: 12, padding: '0 6px' }}
                  >
                    <option value="">None</option>
                    {conditionSourceOptions.map((source) => (
                      <option key={source.id} value={source.id}>
                        {source.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field" style={{ minWidth: 64, flex: '1 1 80px' }}>
                  <label htmlFor={`condition-rule-${combatant.id}`}>Rule ID</label>
                  <input
                    id={`condition-rule-${combatant.id}`}
                    className="input cf-target-44"
                    type="number"
                    min={1}
                    value={conditionDraft.ruleEntryId}
                    disabled={busy}
                    placeholder="#"
                    onChange={(e) => setConditionDraft((prev) => ({ ...prev, ruleEntryId: e.target.value }))}
                  />
                </div>
                <div className="field" style={{ minWidth: 64, flex: '1 1 80px' }}>
                  <label htmlFor={`condition-duration-${combatant.id}`}>Rounds</label>
                  <input
                    id={`condition-duration-${combatant.id}`}
                    className="input cf-target-44"
                    type="number"
                    min={1}
                    max={999}
                    value={conditionDraft.durationRounds}
                    disabled={busy}
                    placeholder="Until clear"
                    onChange={(e) => setConditionDraft((prev) => ({ ...prev, durationRounds: e.target.value }))}
                  />
                </div>
                <div className="field" style={{ minWidth: 142 }}>
                  <label htmlFor={`condition-expiry-${combatant.id}`}>Tick / expire</label>
                  <select
                    id={`condition-expiry-${combatant.id}`}
                    value={conditionDraft.timing}
                    disabled={busy || conditionDraft.durationRounds.trim() === ''}
                    onChange={(e) => setConditionDraft((prev) => ({ ...prev, timing: e.target.value as ConditionTiming }))}
                    className="input cf-target-44"
                    style={{ borderRadius: 'var(--radius-md)', border: '1px solid var(--color-divider)', background: 'transparent', color: 'var(--color-text)', fontSize: 12, padding: '0 6px' }}
                  >
                    {CONDITION_TIMING_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
                <div className="field" style={{ minWidth: 142 }}>
                  <label htmlFor={`condition-save-timing-${combatant.id}`}>Repeat save</label>
                  <select
                    id={`condition-save-timing-${combatant.id}`}
                    value={conditionDraft.saveTiming}
                    disabled={busy}
                    onChange={(e) => setConditionDraft((prev) => ({ ...prev, saveTiming: e.target.value as ConditionTiming }))}
                    className="input cf-target-44"
                    style={{ borderRadius: 'var(--radius-md)', border: '1px solid var(--color-divider)', background: 'transparent', color: 'var(--color-text)', fontSize: 12, padding: '0 6px' }}
                  >
                    {SAVE_TIMING_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
                <div className="field" style={{ minWidth: 56, flex: '1 1 64px' }}>
                  <label htmlFor={`condition-save-ability-${combatant.id}`}>Save</label>
                  <input
                    id={`condition-save-ability-${combatant.id}`}
                    className="input cf-target-44"
                    value={conditionDraft.saveAbility}
                    maxLength={24}
                    disabled={busy || conditionDraft.saveTiming === 'none'}
                    placeholder="CON"
                    onChange={(e) => setConditionDraft((prev) => ({ ...prev, saveAbility: e.target.value }))}
                  />
                </div>
                <div className="field" style={{ minWidth: 56, flex: '1 1 64px' }}>
                  <label htmlFor={`condition-save-dc-${combatant.id}`}>DC</label>
                  <input
                    id={`condition-save-dc-${combatant.id}`}
                    className="input cf-target-44"
                    type="number"
                    min={1}
                    value={conditionDraft.saveDc}
                    disabled={busy || conditionDraft.saveTiming === 'none'}
                    onChange={(e) => setConditionDraft((prev) => ({ ...prev, saveDc: e.target.value }))}
                  />
                </div>
                <div className="field" style={{ minWidth: 56, flex: '1 1 64px' }}>
                  <label htmlFor={`condition-stacks-${combatant.id}`}>Stacks</label>
                  <input
                    id={`condition-stacks-${combatant.id}`}
                    className="input cf-target-44"
                    type="number"
                    min={1}
                    max={99}
                    value={conditionDraft.stacks}
                    disabled={busy}
                    onChange={(e) => setConditionDraft((prev) => ({ ...prev, stacks: e.target.value }))}
                  />
                </div>
                <label className="flex items-center gap-1 text-xs" style={{ minHeight: 32 }}>
                  <input
                    type="checkbox"
                    checked={conditionDraft.isConcentration}
                    disabled={busy || conditionDraft.sourceCombatantId === ''}
                    onChange={(e) => setConditionDraft((prev) => ({ ...prev, isConcentration: e.target.checked }))}
                  />
                  Concentration link
                </label>
                {conditionDraft.isConcentration && (
                  <label className="flex items-center gap-1 text-xs" style={{ minHeight: 32 }}>
                    <input
                      type="checkbox"
                      checked={conditionDraft.syncConcentration}
                      disabled={busy || !onPatchSourceTurnState}
                      onChange={(e) => setConditionDraft((prev) => ({ ...prev, syncConcentration: e.target.checked }))}
                    />
                    Mark source concentrating
                  </label>
                )}
                <div className="field" style={{ minWidth: 180, flex: '2 1 240px' }}>
                  <label htmlFor={`condition-notes-${combatant.id}`}>Notes</label>
                  <input
                    id={`condition-notes-${combatant.id}`}
                    className="input cf-target-44"
                    value={conditionDraft.notes}
                    maxLength={300}
                    disabled={busy}
                    placeholder="Save ends, while in aura, stage 2..."
                    onChange={(e) => setConditionDraft((prev) => ({ ...prev, notes: e.target.value }))}
                  />
                </div>
                <div className="flex gap-1 flex-wrap" style={{ flexBasis: '100%' }}>
                  {conditionSuggestions.slice(0, 12).map((s) => (
                    <button
                      key={s}
                      type="button"
                      className="btn btn-ghost"
                      disabled={busy}
                      style={{ fontSize: 'var(--type-label)' }}
                      onClick={() => setConditionDraft((prev) => ({ ...prev, name: s }))}
                    >
                      {s}
                    </button>
                  ))}
                  {conditionSuggestions.length > 12 && (
                    <span className="text-muted text-xs" style={{ alignSelf: 'center' }}>
                      Type to pick from all {conditionSuggestions.length} known conditions, or enter a custom one.
                    </span>
                  )}
                </div>
                <Btn
                  type="submit"
                  disabled={busy || syncBlocked || conditionDraft.name.trim() === ''}
                  title={syncBlockedReason}
                  aria-describedby={syncBlockedDescribedBy}
                >
                  {editingConditionId ? 'Update condition' : 'Add condition'}
                </Btn>
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ fontSize: 'var(--type-label)' }}
                  onClick={() => {
                    setConditionDraft(emptyConditionDraft(defaultConditionSourceCombatantId));
                    setEditingConditionId(null);
                    setShowFullCondition(false);
                    setAddingCondition(false);
                  }}
                >
                  Cancel
                </button>
              </form>
              )
            ) : (
              <button
                type="button"
                className="btn btn-ghost"
                style={{ fontSize: 'var(--type-label)', border: '1px dashed var(--color-divider)', borderRadius: 'var(--radius-md)' }}
                disabled={syncBlocked}
                title={syncBlockedReason}
                aria-describedby={syncBlockedDescribedBy}
                data-testid={`add-condition-toggle-${combatant.id}`}
                onClick={() => {
                  setEditingConditionId(null);
                  setConditionDraft(emptyConditionDraft(defaultConditionSourceCombatantId));
                  setAddingCondition(true);
                }}
              >
                + condition
              </button>
            )}

            {/* Starfinder Stamina Rest Button */}
            {hasSfPools && combatant.spMax != null && combatant.spMax > 0 && onPatchCombatant && (
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busy || syncBlocked || (combatant.rpCurrent ?? 0) < 1 || (combatant.spCurrent ?? 0) >= combatant.spMax}
                title={syncBlockedReason ?? ((combatant.rpCurrent ?? 0) < 1 ? 'Requires at least 1 Resolve Point' : '10-minute Stamina Rest: spends 1 RP to restore full SP')}
                aria-describedby={syncBlockedDescribedBy}
                onClick={() => onPatchCombatant({ spSet: combatant.spMax, rpDelta: -1 })}
                style={{ fontSize: 'var(--type-label)', border: '1px dashed var(--color-divider)', borderRadius: 'var(--radius-md)' }}
                data-testid="stamina-rest-btn"
              >
                ⛺ Stamina Rest (1 RP → Full SP)
              </button>
            )}

            {/* Stabilization is a character-only recovery control; monsters/NPCs simply go down. */}
            {canStabilizeCombatant(combatant) && onPatchCombatant && (
              <>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={busy || syncBlocked}
                  title={syncBlockedReason ?? 'Stabilize combatant at 0 HP'}
                  aria-describedby={syncBlockedDescribedBy}
                  onClick={() => onPatchCombatant({ deathState: 'stable' })}
                  style={{ fontSize: 'var(--type-label)', border: '1px dashed var(--color-divider)', borderRadius: 'var(--radius-md)' }}
                >
                  Stabilize
                </button>
                {combatant.rpMax != null && combatant.rpMax > 0 && (
                  <>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={busy || syncBlocked || (combatant.rpCurrent ?? 0) < 1}
                      title={syncBlockedReason ?? 'Spend 1 RP to stabilize'}
                      aria-describedby={syncBlockedDescribedBy}
                      onClick={() => onPatchCombatant({ deathState: 'stable', rpDelta: -1 })}
                      style={{ fontSize: 'var(--type-label)', border: '1px dashed var(--color-divider)', borderRadius: 'var(--radius-md)' }}
                    >
                      Stabilize (1 RP)
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={busy || syncBlocked || (combatant.rpCurrent ?? 0) < 1}
                      title={syncBlockedReason ?? 'Spend 1 RP to revive at 1 HP'}
                      aria-describedby={syncBlockedDescribedBy}
                      onClick={() => onPatchCombatant({ hpSet: 1, deathState: 'none', rpDelta: -1 })}
                      style={{ fontSize: 'var(--type-label)', border: '1px dashed var(--color-divider)', borderRadius: 'var(--radius-md)' }}
                    >
                      Revive 1 HP (1 RP)
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        )}
        {/* Compendium statblock (issue #56): a monster combatant keeps its ruleEntryId —
            surface the linked entry's AC / attacks / ability scores inline so the DM can
            answer "does a 17 hit?" without leaving the tracker. Collapsible so the row
            stays scannable; lazily fetched on first expand. */}
        {canViewStatblock && combatant.ruleEntryId != null && (
          <CombatantStatblock ruleEntryId={combatant.ruleEntryId} ruleSystem={ruleSystem} campaignId={routeCampaignId} />
        )}
        {onUseMonsterAction && (
          <CombatantActionsList
            encounterId={encounterId}
            combatantId={combatant.id}
            combatantName={combatant.name}
            campaignId={campaignId}
            enabled
            disabledReason={syncBlockedReason}
            onUseAction={onUseMonsterAction}
          />
        )}
        {canEditIdentity && combatant.statblock && combatant.kind === 'monster' && (
          <details className="mt-2">
            <summary className="text-xs text-muted cursor-pointer">Edit statblock</summary>
            <CombatantStatblockEditor
              value={combatant.statblock}
              onChange={(next) => onPatchCombatant?.({ statblock: next })}
              ruleSystem={ruleSystem}
            />
          </details>
        )}
        {/* Character card (in-encounter sheet): a player sees only their own combat stats,
            while the DM sees the whole party. */}
        {combatant.kind === 'character' && character && (
          <CharacterStatCard
            character={character}
            ruleSystem={ruleSystem}
            defaultOpen={openCardByDefault}
            openOnActiveTurn={openCardOnActiveTurn}
            /* Click-to-roll only from an active owned card, or any card for the DM. */
            campaignId={campaignId}
            /* Issue #1901: fetch the server's merged action list (sheet + equipped-item
               actions) — mounting this card already implies DM-or-owner (see the `character`
               prop gate above), matching listUsableActions' own authorization. */
            encounterId={encounterId}
            combatantId={combatant.id}
            onError={onRollError}
            onApplyDamage={onApplyDamage}
            onUseAction={onUseAction}
          />
        )}
      </div>
      <div style={{ minWidth: 140, flex: 'none' }}>
        {combatant.hpCurrent != null && combatant.hpMax != null ? (
          <>
            {combatant.hpTemp != null && combatant.hpTemp > 0 && (
              <div style={{ textAlign: 'right', marginBottom: 2 }}>
                <span className="tag tag-accent" title="Temporary HP — absorbs damage first">
                  <GameIcon slug="shield" size={UI_ICON_SIZE.xs} className="inline align-text-bottom mr-1" />{combatant.hpTemp}
                </span>
              </div>
            )}
            {/* SP Bar & Status (if Starfinder / SP pool present) */}
            {combatant.spMax != null && combatant.spMax > 0 && (
              <div style={{ marginBottom: 4 }} data-testid="starfinder-sp-indicator">
                <div style={{ fontSize: 11.5, textAlign: 'right', marginBottom: 2, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span className="text-muted font-semibold" style={{ fontSize: 10, letterSpacing: '0.04em' }}>SP</span>
                  <span>{combatant.spCurrent ?? 0} / {combatant.spMax}</span>
                </div>
                <div className="cf-hp" style={{ background: 'var(--color-neutral-800)', height: 6, borderRadius: 'var(--radius-full)', overflow: 'hidden' }}>
                  <div
                    style={{
                      width: `${Math.max(0, Math.min(100, ((combatant.spCurrent ?? 0) / combatant.spMax) * 100))}%`,
                      background: '#38bdf8',
                      height: '100%',
                      borderRadius: 'var(--radius-full)',
                      transition: 'width 0.2s ease',
                    }}
                  />
                </div>
              </div>
            )}
            {/* HP Bar & Status */}
            <div>
              <div style={{ fontSize: 12.5, textAlign: 'right', marginBottom: 3, display: 'flex', gap: 6, justifyContent: 'flex-end', alignItems: 'baseline' }}>
                {combatant.spMax != null && combatant.spMax > 0 && (
                  <span className="text-muted font-semibold" style={{ fontSize: 10, letterSpacing: '0.04em', marginRight: 'auto' }}>HP</span>
                )}
                <span>
                  {hpDisplay(combatant)}
                </span>
              </div>
              <HpBar current={combatant.hpCurrent} max={combatant.hpMax} />
            </div>
            {/* RP (Resolve Points) indicator for Starfinder */}
            {combatant.rpMax != null && combatant.rpMax > 0 && (
              <div style={{ fontSize: 11, textAlign: 'right', marginTop: 4, display: 'flex', gap: 4, justifyContent: 'flex-end', alignItems: 'center' }} title="Resolve Points" data-testid="starfinder-rp-indicator">
                <span className="text-muted font-semibold" style={{ fontSize: 10, letterSpacing: '0.04em' }}>RP</span>
                <span style={{ fontSize: 11, fontWeight: 700 }}>{combatant.rpCurrent ?? 0} / {combatant.rpMax}</span>
                {canEditPermission && onPatchCombatant && (
                  <span style={{ display: 'inline-flex', gap: 2, marginLeft: 2 }}>
                    <button
                      type="button"
                      className="btn btn-ghost !px-1 text-[10px] cf-density-xs"
                      disabled={busy || syncBlocked || (combatant.rpCurrent ?? 0) <= 0}
                      title={syncBlockedReason ?? 'Decrease Resolve Points'}
                      aria-describedby={syncBlockedDescribedBy}
                      onClick={() => onPatchCombatant({ rpDelta: -1 })}
                    >
                      −
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost !px-1 text-[10px] cf-density-xs"
                      disabled={busy || syncBlocked || (combatant.rpCurrent ?? 0) >= combatant.rpMax}
                      title={syncBlockedReason ?? 'Increase Resolve Points'}
                      aria-describedby={syncBlockedDescribedBy}
                      onClick={() => onPatchCombatant({ rpDelta: 1 })}
                    >
                      +
                    </button>
                  </span>
                )}
              </div>
            )}
          </>
        ) : (
          <>
            <div style={{ fontSize: 12.5, textAlign: 'right', marginBottom: 3 }} title="Exact HP is hidden for monsters">
              {hpDisplay(combatant)}
            </div>
            <HpBandBar band={combatant.hpBand} />
          </>
        )}
        {/* Temp-HP setter (issue #57) — grant/clear temporary HP. Same edit gate as
            the HP steppers; hidden for redacted monster rows (hpCurrent null). */}
        {canEditPermission && combatant.hpCurrent != null && (
          <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end', marginTop: 4 }}>
            <input
              type="number"
              min={0}
              aria-label={`Set temporary HP for ${combatant.name}`}
              aria-describedby={syncBlockedDescribedBy}
              placeholder="temp"
              value={tempDraft}
              disabled={busy || syncBlocked}
              title={syncBlockedReason}
              data-testid={`temp-hp-input-${combatant.id}`}
              onChange={(e) => setTempDraft(e.target.value)}
              onBlur={commitTempHp}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !isImeComposing(e)) { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
              }}
              style={{
                width: 60,
                height: 26,
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--color-divider)',
                background: 'transparent',
                textAlign: 'center',
                fontSize: 'var(--type-label)',
                color: 'var(--color-text)',
              }}
            />
          </div>
        )}
      </div>
      {/* HP steppers — only where a concrete number exists to adjust. A redacted
          monster's HP is banded (hpCurrent null) for non-DM viewers (issue #43),
          so we never render steppers pointing at a null value. Mirrors the sheet's
          ±5 / ±1 controls, incl. shift-click ×5 (issue #68). */}
      {canEditPermission && combatant.hpCurrent != null && (
        <div style={{ display: 'flex', gap: 8, flex: 'none', flexWrap: 'wrap', alignItems: 'center', maxWidth: '100%' }} data-testid="hp-steppers">
          {([-5, -1, 1, 5] as const).map((step) => (
            <button
              key={step}
              className="btn btn-icon btn-secondary cf-target-44"
              style={{ width: 44, height: 44, fontSize: step === 1 || step === -1 ? 16 : 13, fontFamily: 'var(--font-heading)' }}
              /* Optimistic: HP steppers stay live even mid-request (issue #73) — the click
                 lands instantly via setQueryData, so there's no round-trip to wait on.
                 `busy` intentionally does NOT disable this button; only the sync gate
                 (issue #1746) does, since a blocked write really cannot be trusted. */
              disabled={syncBlocked}
              title={syncBlockedReason}
              aria-describedby={syncBlockedDescribedBy}
              aria-label={`${step < 0 ? 'Reduce' : 'Increase'} ${combatant.name}'s HP by ${Math.abs(step)} (hold Shift for ${Math.abs(step) * 5}; currently ${combatant.hpCurrent} of ${combatant.hpMax})`}
              onClick={(e) => onHpDelta(e.shiftKey ? step * 5 : step)}
            >
              {step > 0 ? `+${step}` : `−${Math.abs(step)}`}
            </button>
          ))}
          <div style={{ display: 'flex', gap: 4, marginLeft: 4, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              type="number"
              min="0"
              placeholder="Amt"
              value={exactHp}
              onChange={(e) => setExactHp(e.target.value)}
              className="input cf-target-44"
              style={{ width: 60, textAlign: 'center' }}
              aria-label="Exact HP amount"
              disabled={syncBlocked}
            />
            <button
              type="button"
              className="btn btn-secondary cf-target-44"
              style={{ padding: '0 8px', fontSize: 13 }}
              disabled={!exactHp || isNaN(parseInt(exactHp, 10)) || syncBlocked}
              aria-label="Apply exact damage"
              onClick={() => {
                const val = parseInt(exactHp, 10);
                if (!isNaN(val)) {
                  onHpDelta(-Math.abs(val));
                  setExactHp('');
                }
              }}
            >
              Dmg
            </button>
            <button
              type="button"
              className="btn btn-secondary cf-target-44"
              style={{ padding: '0 8px', fontSize: 13 }}
              disabled={!exactHp || isNaN(parseInt(exactHp, 10)) || syncBlocked}
              aria-label="Apply exact healing"
              onClick={() => {
                const val = parseInt(exactHp, 10);
                if (!isNaN(val)) {
                  onHpDelta(Math.abs(val));
                  setExactHp('');
                }
              }}
            >
              Heal
            </button>
          </div>
        </div>
      )}
      {canRemove && (
        <button
          className="btn btn-icon btn-ghost cf-target-44"
          style={{ width: 44, height: 44, flex: 'none' }}
          disabled={busy}
          onClick={onRemove}
          aria-label={`Remove ${combatant.name}`}
        >
          <UIIcon name="close" size="xs" />
        </button>
      )}
    </div>
  );
}

/**
 * Collapsible statblock for a compendium-linked monster combatant (issue #56). The
 * combatant only stores a `ruleEntryId`; the entry's AC / attacks / ability scores live
 * in its `dataJson`, fetched lazily from the existing rules read path on first expand
 * and rendered with the shared StatBlock component (added by #142). Kept collapsed by
 * default so the initiative row stays scannable mid-fight.
 */
function CombatantStatblock({ ruleEntryId, ruleSystem, campaignId }: { ruleEntryId: number; ruleSystem: string | null; campaignId?: number }) {
  const { open, setOpen, buttonProps, regionProps } = useDisclosure({
    focusManagement: false,
    // No regionLabel: StatBlock inside already exposes a labelled "Creature
    // statblock" region (see StatBlock.tsx). The wrapper stays a plain div so
    // we don't nest redundant landmarks.
  });
  const [entry, setEntry] = useState<RuleEntry | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && entry === null && !loading) {
      setLoading(true);
      setFailed(false);
      try {
        const url = `${API}/rules/entries/${ruleEntryId}${campaignId ? `?campaignId=${campaignId}` : ''}`;
        const e = await api.get<RuleEntry>(url);
        setEntry(e);
      } catch {
        setFailed(true);
      } finally {
        setLoading(false);
      }
    }
  }

  return (
    <div style={{ marginTop: 5 }}>
      <button
        type="button"
        className="btn btn-ghost"
        {...buttonProps}
        onClick={toggle}
        style={{ fontSize: 'var(--type-label)', border: '1px dashed var(--color-divider)', borderRadius: 'var(--radius-md)' }}
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span> Statblock
      </button>
      {open && (
        <div
          {...regionProps}
          style={{
            marginTop: 6,
            padding: '10px 12px',
            border: '1px solid var(--color-divider)',
            borderRadius: 'var(--radius-md)',
            background: 'color-mix(in srgb, var(--color-accent) 4%, transparent)',
            maxWidth: 460,
          }}
        >
          {loading ? (
            <Skeleton lines={3} />
          ) : failed ? (
            <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>
              Couldn&apos;t load the statblock.
            </p>
          ) : entry && hasMonsterStatblock(entry.dataJson, ruleSystem) ? (
            <StatBlock data={entry.dataJson} ruleSystem={ruleSystem} />
          ) : (
            <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>
              No statblock details for this entry.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Persistent per-encounter combat log (issue #61). Renders the server-stored event
 * trail (damage/heal, conditions, deaths, rolls, turns, notes, overrides, and
 * corrections) in chronological order — it survives reload and updates live with
 * the rest of the tracker. Scrollable so a long fight doesn't push the page down.
 */
// ---------------------------------------------------------------------------

type AddTab = 'manual' | 'compendium' | 'library' | 'party' | 'npc';
const ADD_TAB_ORDER: ReadonlyArray<AddTab> = ['manual', 'compendium', 'library', 'party', 'npc'];
const ADD_TAB_LABELS: Record<AddTab, string> = {
  manual: 'Manual',
  compendium: 'Compendium',
  library: 'Library',
  party: 'Party',
  npc: 'NPC',
};

function AddCombatantPanel({
  encounterId,
  campaignId: cid,
  characters,
  existingCombatantCharacterIds,
  rulePack,
  onAdded,
}: {
  encounterId: number;
  campaignId: number;
  characters: Character[];
  existingCombatantCharacterIds: Set<number>;
  rulePack: string;
  onAdded: () => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const announce = useAnnounce();
  const [tab, setTab] = useState<AddTab>('manual');
  const tabRefs = useRef<Record<AddTab, HTMLButtonElement | null>>({
    manual: null,
    compendium: null,
    library: null,
    party: null,
    npc: null,
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Manual
  const [name, setName] = useState('');
  const [hpMax, setHpMax] = useState('');
  const [initMod, setInitMod] = useState('');
  const [manualCount, setManualCount] = useState('1');
  const [manualStatblock, setManualStatblock] = useState<CombatantStatblockData>(() => defaultCombatantStatblock());

  // Campaign library (issue #425)
  const [library, setLibrary] = useState<CampaignLibraryMonster[]>([]);

  // Compendium
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounced(query, 300);
  const [results, setResults] = useState<RuleEntry[]>([]);
  const [searching, setSearching] = useState(false);
  // Quantity + optional name override applied to the next compendium add (issue #114).
  const [compCount, setCompCount] = useState('1');
  const [nameOverride, setNameOverride] = useState('');

  // NPC (issue: NPCs as combatants) — pick a campaign NPC for identity, then give it
  // HP manually or by linking a compendium statblock (the compendium search below).
  const [npcs, setNpcs] = useState<Npc[]>([]);
  const [selectedNpcId, setSelectedNpcId] = useState('');
  const [npcHp, setNpcHp] = useState('');
  const [npcInit, setNpcInit] = useState('');

  /** Clamp a free-text quantity field to a sane 1–50, defaulting to 1. */
  function parseCount(raw: string): number {
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n) || n < 1) return 1;
    return Math.min(50, n);
  }

  function selectAddTab(next: AddTab) {
    setTab(next);
    announce(`${ADD_TAB_LABELS[next]} tab selected.`);
  }

  function focusAddTab(which: AddTab) {
    tabRefs.current[which]?.focus();
  }

  function onAddTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    const idx = ADD_TAB_ORDER.indexOf(tab);
    if (idx < 0) return;
    let next: AddTab | null = null;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = ADD_TAB_ORDER[(idx + 1) % ADD_TAB_ORDER.length];
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = ADD_TAB_ORDER[(idx - 1 + ADD_TAB_ORDER.length) % ADD_TAB_ORDER.length];
        break;
      case 'Home':
        next = ADD_TAB_ORDER[0];
        break;
      case 'End':
        next = ADD_TAB_ORDER[ADD_TAB_ORDER.length - 1];
        break;
      default:
        return;
    }
    if (next && next !== tab) {
      event.preventDefault();
      selectAddTab(next);
      requestAnimationFrame(() => focusAddTab(next));
    } else if (next) {
      event.preventDefault();
      focusAddTab(next);
    }
  }

  // Campaign NPCs for the NPC tab's picker. Low-churn, fetched once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await api.get<Npc[]>(`${API}/campaigns/${cid}/npcs`);
        if (!cancelled) setNpcs(list);
      } catch {
        /* leave empty — the tab shows an empty-state hint */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cid]);

  useEffect(() => {
    if (tab !== 'library') return;
    let cancelled = false;
    (async () => {
      try {
        const list = await api.get<CampaignLibraryMonster[]>(`${API}/campaigns/${cid}/library/monsters`);
        if (!cancelled) setLibrary(list);
      } catch {
        if (!cancelled) setLibrary([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cid, tab]);

  useEffect(() => {
    if ((tab !== 'compendium' && tab !== 'npc') || !debouncedQuery.trim()) {
      setResults([]);
      return;
    }
    let cancelled = false;
    (async () => {
      setSearching(true);
      try {
        const baseParams = new URLSearchParams({ q: debouncedQuery.trim() });
        if (rulePack) baseParams.set('pack', rulePack);
        if (cid) baseParams.set('campaignId', String(cid));
        // Hazards belong to the Compendium add/drag-drop flow only. The NPC tab's picker is
        // monster-focused and its UI doesn't surface entry type, so keep it to monsters.
        const types = tab === 'compendium' ? (['monster', 'hazard'] as const) : (['monster'] as const);
        const pages = await Promise.all(
          types.map((type) => {
            const params = new URLSearchParams(baseParams);
            params.set('type', type);
            return api.get<{ items: RuleEntry[] }>(`${API}/rules/search?${params.toString()}`);
          }),
        );
        // Merging two independently-sorted result sets (monsters + hazards) would leave the
        // combined list ungrouped; re-sort by name (id tie-break) so the picker stays stable.
        if (!cancelled) {
          const merged = pages
            .flatMap((page) => page.items)
            .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
          setResults(merged);
        }
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `cid` (issue #1898 review): the encounter route renders the same component tree
    // across campaigns, so navigating to another campaign's encounter can update this
    // prop without remounting AddCombatantPanel. Without cid in the dependency list the
    // effect kept a stale closed-over campaign id until tab/query/rulePack happened to
    // change too, scoping the search (and any add) to the PREVIOUS campaign.
  }, [tab, debouncedQuery, rulePack, cid]);

  async function addManual(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    // A manual combatant has no rule-entry/character to derive HP from, so the server requires
    // hpMax explicitly. Mirror that here with a readable message instead of the round-trip's
    // dev-jargon "Unable to resolve hpMax…" (issue #146).
    if (!hpMax.trim() || !Number.isFinite(Number(hpMax)) || Number(hpMax) < 1) {
      setError('Enter max HP (a number of 1 or more) for a manual combatant.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.post(`${API}/encounters/${encounterId}/combatants`, {
        kind: 'monster' as CombatantKind,
        name: name.trim(),
        hpMax: hpMax ? Math.max(1, Number(hpMax)) : undefined,
        initMod: initMod ? Number(initMod) : undefined,
        count: parseCount(manualCount),
        statblock: manualStatblock,
      });
      setName('');
      setHpMax('');
      setInitMod('');
      setManualCount('1');
      setManualStatblock(defaultCombatantStatblock());
      await onAdded();
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'encounters.errors.addCombatant' }));
    } finally {
      setSaving(false);
    }
  }

  async function addFromLibrary(entry: CampaignLibraryMonster) {
    setSaving(true);
    setError(null);
    try {
      const resolvedHp = hpMax.trim() && Number.isFinite(Number(hpMax)) ? Math.max(1, Number(hpMax)) : 10;
      await api.post(`${API}/encounters/${encounterId}/combatants`, {
        kind: 'monster' as CombatantKind,
        name: entry.name,
        libraryMonsterId: entry.id,
        hpMax: resolvedHp,
        count: parseCount(manualCount),
      });
      await onAdded();
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'encounters.errors.addCombatant' }));
    } finally {
      setSaving(false);
    }
  }

  async function saveManualToLibrary() {
    if (!name.trim()) {
      setError('Enter a name before saving to the campaign library.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.post(`${API}/campaigns/${cid}/library/monsters`, {
        name: name.trim(),
        statblock: manualStatblock,
      });
      const list = await api.get<CampaignLibraryMonster[]>(`${API}/campaigns/${cid}/library/monsters`);
      setLibrary(list);
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'encounters.errors.addCombatant' }));
    } finally {
      setSaving(false);
    }
  }

  async function addFromCompendium(entry: RuleEntry) {
    setSaving(true);
    setError(null);
    try {
      await api.post(`${API}/encounters/${encounterId}/combatants`, {
        kind: 'monster' as CombatantKind,
        // Optional override lets the DM rename ("Goblin" -> "Goblin archer") at add time;
        // otherwise the statblock name is used. count>1 auto-suffixes 1..N server-side.
        name: nameOverride.trim() || entry.name,
        ruleEntryId: entry.id,
        count: parseCount(compCount),
      });
      setNameOverride('');
      setCompCount('1');
      await onAdded();
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'encounters.errors.addCombatant' }));
    } finally {
      setSaving(false);
    }
  }

  async function addDroppedRuleEntry(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    if (saving) return;
    let payload: { id?: unknown; name?: unknown; type?: unknown };
    try {
      payload = JSON.parse(event.dataTransfer.getData('application/x-campfire-rule-entry'));
    } catch {
      // Ignore unrelated/invalid drags; the drop zone accepts only Campfire rule entries.
      return;
    }
    if (
      typeof payload.id !== 'number' ||
      typeof payload.name !== 'string' ||
      (payload.type !== 'monster' && payload.type !== 'hazard')
    ) return;
    const droppedType = payload.type;
    const droppedId = payload.id;
    setSaving(true);
    setError(null);
    try {
      // Resolve the FULL entry from the rules read path (the drag payload only carries
      // id/name/type, but RuleEntry requires many more fields — trusting a cast would
      // mask bugs). Confirm the resolved type still matches what was dragged before adding.
      const url = `${API}/rules/entries/${droppedId}${cid ? `?campaignId=${cid}` : ''}`;
      const entry = await api.get<RuleEntry>(url);
      if (entry.type !== droppedType) {
        setError("That compendium entry doesn't match the dragged monster/hazard anymore.");
        return;
      }
      await addFromCompendium(entry);
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'encounters.errors.addCombatant' }));
    } finally {
      setSaving(false);
    }
  }

  async function addAllFromParty() {
    const available = characters.filter((c) => !existingCombatantCharacterIds.has(c.id));
    if (available.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      await Promise.all(
        available.map((character) =>
          api.post(`${API}/encounters/${encounterId}/combatants`, {
            kind: 'character' as CombatantKind,
            characterId: character.id,
            name: character.name,
            hpMax: character.hpMax,
          }),
        ),
      );
      await onAdded();
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'encounters.errors.addCombatant' }));
    } finally {
      setSaving(false);
    }
  }

  async function addFromParty(character: Character) {
    setSaving(true);
    setError(null);
    try {
      await api.post(`${API}/encounters/${encounterId}/combatants`, {
        kind: 'character' as CombatantKind,
        characterId: character.id,
        name: character.name,
        hpMax: character.hpMax,
      });
      await onAdded();
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'encounters.errors.addCombatant' }));
    } finally {
      setSaving(false);
    }
  }

  // Add the selected NPC as a combatant. With a statblock `entry` it borrows that
  // statblock's HP (like a compendium add); otherwise it uses the manual HP field.
  async function addFromNpc(entry?: RuleEntry) {
    const npcIdNum = Number(selectedNpcId);
    if (!selectedNpcId || !Number.isFinite(npcIdNum)) {
      setError('Pick an NPC to add.');
      return;
    }
    if (!entry && (!npcHp.trim() || !Number.isFinite(Number(npcHp)) || Number(npcHp) < 1)) {
      setError('Enter max HP (1 or more), or pick a statblock, for this NPC.');
      return;
    }
    const npc = npcs.find((n) => n.id === npcIdNum);
    setSaving(true);
    setError(null);
    try {
      await api.post(`${API}/encounters/${encounterId}/combatants`, {
        kind: 'npc' as CombatantKind,
        npcId: npcIdNum,
        name: npc?.name,
        ruleEntryId: entry?.id,
        hpMax: entry ? undefined : Math.max(1, Number(npcHp)),
        initMod: npcInit ? Number(npcInit) : undefined,
      });
      setNpcHp('');
      setNpcInit('');
      await onAdded();
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'encounters.errors.addCombatant' }));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card
      className="space-y-3"
      data-testid="add-combatant-dropzone"
      onDragOver={(event: React.DragEvent) => {
        if (event.dataTransfer.types.includes('application/x-campfire-rule-entry')) {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDrop={(event: React.DragEvent<HTMLElement>) => void addDroppedRuleEntry(event)}
    >
      <span className="card-kicker">{t('encounters.run.addCombatant')}</span>
      <p className="text-muted" style={{ fontSize: 11, margin: 0 }}>
        {t('encounters.run.addCombatantHint')}
      </p>
      <div
        className="seg seg-wrap self-start inline-flex max-w-full"
        role="tablist"
        aria-label={t('encounters.run.addCombatant')}
        data-testid="add-combatant-tabs"
      >
        {ADD_TAB_ORDER.map((t) => {
          const selectedTab = tab === t;
          return (
            <button
              key={t}
              ref={(el) => {
                tabRefs.current[t] = el;
              }}
              type="button"
              role="tab"
              id={`add-combatant-tab-${t}`}
              aria-selected={selectedTab}
              aria-controls={`add-combatant-panel-${t}`}
              tabIndex={selectedTab ? 0 : -1}
              onClick={() => selectAddTab(t)}
              onKeyDown={onAddTabKeyDown}
              className="cf-target-44"
              style={{
                padding: '7px 13px',
                font: 'inherit',
                fontSize: 12,
                border: 0,
                background: 'transparent',
                cursor: 'pointer',
                color: selectedTab ? 'var(--color-accent)' : 'var(--color-text)',
                boxShadow: selectedTab ? 'inset 0 0 0 1px var(--color-accent)' : 'none',
              }}
            >
              {ADD_TAB_LABELS[t]}
            </button>
          );
        })}
      </div>

      {error && <p role="alert" className="text-sm text-rose-400">{error}</p>}

      <div
        id="add-combatant-panel-manual"
        role="tabpanel"
        aria-labelledby="add-combatant-tab-manual"
        tabIndex={0}
        hidden={tab !== 'manual'}
        className={tab === 'manual' ? 'space-y-3' : 'hidden'}
      >
        <form onSubmit={addManual} className="flex gap-2 flex-wrap items-end">
          <div className="field" style={{ flex: 1, minWidth: 140 }}>
            <label htmlFor="add-combatant-name">Name</label>
            <TextInput id="add-combatant-name" placeholder="Ashen cultist" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          </div>
          <div className="field" style={{ width: 80 }}>
            <label htmlFor="add-combatant-hp">HP</label>
            <TextInput id="add-combatant-hp" aria-label="Max HP" placeholder="22" value={hpMax} onChange={(e) => setHpMax(e.target.value)} />
          </div>
          <div className="field" style={{ width: 80 }}>
            <label htmlFor="add-combatant-init">Init mod</label>
            <TextInput id="add-combatant-init" aria-label="Initiative modifier" placeholder="2" value={initMod} onChange={(e) => setInitMod(e.target.value)} />
          </div>
          <div className="field" style={{ width: 70 }}>
            <label htmlFor="add-combatant-count">Qty</label>
            <TextInput id="add-combatant-count" type="number" min={1} max={50} aria-label="Quantity — adds this many, auto-numbered" value={manualCount} onChange={(e) => setManualCount(e.target.value)} />
          </div>
          <Btn type="submit" disabled={saving || !name.trim()}>
            {saving ? 'Adding…' : 'Add'}
          </Btn>
          <Btn type="button" ghost disabled={saving || !name.trim()} onClick={() => void saveManualToLibrary()}>
            Save to library
          </Btn>
        </form>
        <p className="text-[11px] text-muted m-0" title={COMBATANT_STATBLOCK_HELP.library}>
          {COMBATANT_STATBLOCK_HELP.library}
        </p>
        <CombatantStatblockEditor value={manualStatblock} onChange={setManualStatblock} disabled={saving} ruleSystem={rulePack} />
      </div>

      <div
        id="add-combatant-panel-library"
        role="tabpanel"
        aria-labelledby="add-combatant-tab-library"
        tabIndex={0}
        hidden={tab !== 'library'}
        className={tab === 'library' ? 'space-y-2' : 'hidden'}
      >
        {library.length === 0 ? (
          <p className="text-muted text-sm">No saved homebrew monsters yet. Build one on the Manual tab and save it to the library.</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {library.map((entry) => (
              <Card
                key={entry.id}
                type="button"
                density="compact" elev="sm" as="button" className="text-left"
                style={{ border: 0, font: 'inherit', color: 'var(--color-text)', cursor: 'pointer', padding: '8px 12px' }}
                disabled={saving}
                onClick={() => void addFromLibrary(entry)}
              >
                <span className="font-medium">{entry.name}</span>
                <span className="text-muted text-xs block">
                  {entry.statblock.actions.length} action{entry.statblock.actions.length === 1 ? '' : 's'}
                </span>
              </Card>
            ))}
          </div>
        )}
      </div>

      <div
        id="add-combatant-panel-compendium"
        role="tabpanel"
        aria-labelledby="add-combatant-tab-compendium"
        tabIndex={0}
        hidden={tab !== 'compendium'}
        className={tab === 'compendium' ? 'space-y-2' : 'hidden'}
      >
        <TextInput
            aria-label="Search monsters and hazards in the compendium"
            placeholder="Search monsters and hazards…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {/* Quantity + optional name override for the next pick (issue #114): adding
              N monsters auto-numbers them "Goblin 1".."Goblin N" so they're distinguishable. */}
          <div className="flex gap-2 flex-wrap items-end">
            <div className="field" style={{ width: 70 }}>
              <label htmlFor="comp-count">Qty</label>
              <TextInput id="comp-count" type="number" min={1} max={50} aria-label="Quantity to add" value={compCount} onChange={(e) => setCompCount(e.target.value)} />
            </div>
            <div className="field" style={{ flex: 1, minWidth: 140 }}>
              <label htmlFor="comp-name-override">Name override (optional)</label>
              <TextInput id="comp-name-override" placeholder="Leave blank to use statblock name" value={nameOverride} onChange={(e) => setNameOverride(e.target.value)} />
            </div>
          </div>
          {searching ? (
            <Skeleton lines={2} />
          ) : results.length === 0 ? (
            <p className="text-muted" style={{ fontSize: 12 }}>
              {query.trim() ? 'No matches.' : 'Start typing to search the compendium.'}
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {results.map((entry) => (
                <Card
                  key={entry.id}
                  density="compact" elev="sm" as="button"
                  style={{
                    border: 0,
                    font: 'inherit',
                    color: 'var(--color-text)',
                    cursor: 'pointer',
                    textAlign: 'left',
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 10,
                    padding: '8px 12px',
                  }}
                  disabled={saving}
                  onClick={() => addFromCompendium(entry)}
                >
                  <span style={{ flex: 1, minWidth: 0, fontSize: 13 }}>{entry.name}</span>
                  {entry.campaignId != null && (
                    <span className="tag tag-amber" data-testid="homebrew-badge">
                      {t('compendium.homebrew', 'Homebrew')}
                    </span>
                  )}
                  <span className="tag tag-neutral">
                    {entry.type}
                  </span>
                </Card>
              ))}
            </div>
          )}
      </div>

      <div
        id="add-combatant-panel-party"
        role="tabpanel"
        aria-labelledby="add-combatant-tab-party"
        tabIndex={0}
        hidden={tab !== 'party'}
        className={tab === 'party' ? 'space-y-1.5' : 'hidden'}
      >
        {(() => {
            const available = characters.filter((c) => !existingCombatantCharacterIds.has(c.id));
            if (characters.length === 0) {
              return (
                <p className="text-muted" style={{ fontSize: 12 }}>
                  No characters in this campaign yet.
                </p>
              );
            }
            if (available.length === 0) {
              return (
                <p className="text-muted" style={{ fontSize: 12 }}>
                  The whole party is already in this encounter.
                </p>
              );
            }
            return (
              <>
                <Btn
                  type="button"
                  ghost
                  data-testid="add-whole-party-button"
                  disabled={saving}
                  onClick={addAllFromParty}
                  className="w-full text-xs mb-2"
                >
                  {t('encounters.addWholeParty', { count: available.length })}
                </Btn>
                {available.map((c) => (
                  <Card
                    key={c.id}
                    density="compact" elev="sm" as="button"
                    style={{
                      border: 0,
                      font: 'inherit',
                      color: 'var(--color-text)',
                      cursor: 'pointer',
                      textAlign: 'left',
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 10,
                      padding: '8px 12px',
                      width: '100%',
                    }}
                    disabled={saving}
                    onClick={() => addFromParty(c)}
                  >
                    <span style={{ flex: 1, minWidth: 0, fontSize: 13 }}>{c.name}</span>
                    <span className="text-muted" style={{ fontSize: 'var(--type-meta)' }}>
                      {c.hpCurrent}/{c.hpMax}
                    </span>
                  </Card>
                ))}
              </>
            );
        })()}
      </div>

      <div
        id="add-combatant-panel-npc"
        role="tabpanel"
        aria-labelledby="add-combatant-tab-npc"
        tabIndex={0}
        hidden={tab !== 'npc'}
        className={tab === 'npc' ? 'space-y-2' : 'hidden'}
      >
        {npcs.length === 0 ? (
            <p className="text-muted" style={{ fontSize: 12 }}>
              No NPCs in this campaign yet — create one on the NPCs page.
            </p>
          ) : (
            <>
              <div className="field">
                <label htmlFor="npc-select">NPC</label>
                <select
                  id="npc-select"
                  className="cf-select"
                  value={selectedNpcId}
                  onChange={(e) => setSelectedNpcId(e.target.value)}
                >
                  <option value="">Choose an NPC…</option>
                  {npcs.map((n) => (
                    <option key={n.id} value={String(n.id)}>
                      {n.name}
                      {n.role ? ` — ${n.role}` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <form onSubmit={(e) => { e.preventDefault(); void addFromNpc(); }} className="flex gap-2 flex-wrap items-end">
                <div className="field" style={{ width: 80 }}>
                  <label htmlFor="npc-hp">HP</label>
                  <TextInput id="npc-hp" aria-label="Max HP" placeholder="22" value={npcHp} onChange={(e) => setNpcHp(e.target.value)} />
                </div>
                <div className="field" style={{ width: 80 }}>
                  <label htmlFor="npc-init">Init mod</label>
                  <TextInput id="npc-init" aria-label="Initiative modifier" placeholder="2" value={npcInit} onChange={(e) => setNpcInit(e.target.value)} />
                </div>
                <Btn type="submit" disabled={saving || !selectedNpcId}>
                  {saving ? 'Adding…' : 'Add NPC'}
                </Btn>
              </form>
              <div className="hr" style={{ margin: '4px 0' }} />
              <p className="text-muted reading-supporting">
                …or give it a statblock — search the compendium and pick one (its HP is used):
              </p>
              <TextInput
                aria-label="Search monster statblocks for this NPC"
                placeholder="Search statblocks…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {searching ? (
                <Skeleton lines={2} />
              ) : results.length === 0 ? (
                <p className="text-muted" style={{ fontSize: 12 }}>
                  {query.trim() ? 'No matches.' : 'Optional — leave blank to add with manual HP above.'}
                </p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {results.map((entry) => (
                    <Card
                      key={entry.id}
                      density="compact" elev="sm" as="button"
                      style={{
                        border: 0,
                        font: 'inherit',
                        color: 'var(--color-text)',
                        cursor: 'pointer',
                        textAlign: 'left',
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 10,
                        padding: '8px 12px',
                      }}
                      disabled={saving || !selectedNpcId}
                      title={!selectedNpcId ? 'Choose an NPC first' : `Add ${entry.name}'s statblock to the selected NPC`}
                      onClick={() => void addFromNpc(entry)}
                    >
                      <span style={{ flex: 1, minWidth: 0, fontSize: 13 }}>{entry.name}</span>
                      {entry.campaignId != null && (
                        <span className="tag tag-amber" data-testid="homebrew-badge">
                          {t('compendium.homebrew', 'Homebrew')}
                        </span>
                      )}
                      <span className="tag tag-neutral">
                        statblock
                      </span>
                    </Card>
                  ))}
                </div>
              )}
            </>
          )}
      </div>
    </Card>
  );
}

// DiceLog moved to features/dice/SharedDiceLog — rolls are now persisted
// server-side and shared by the whole table (issue #35).
