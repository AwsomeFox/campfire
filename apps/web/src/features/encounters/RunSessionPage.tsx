import { CombatLog } from './CombatLog';
import { ApplyDamageBar, BattleMap, type EncounterGridPatch } from './map/BattleMap';
import { AddCombatantPanel } from './combat/AddCombatantPanel';
import { CombatantRow, hpDisplay, type CombatantRowProps } from './combat/CombatantRow';
import { combatantPatchUrl } from './combat/combatantPatchUrl';
import { useCombatantDragReorder } from './combat/useCombatantDragReorder';
import { afterCombatantIdForMoveDown, afterCombatantIdForMoveUp, isAwaitingReorderResync, reorderMenuTargets, shouldArmReorderResyncLatch } from './combatantReorder';
import { duplicateCombatantName } from './duplicateCombatantName';
import { CombatantStatblock } from './combat/CombatantStatblock';
import { dismissKillPrompt, shouldShowKillPrompt } from './combat/statblockReveal';
import { DmLifecycleHeader, EncounterSyncBanner } from './DmLifecycleHeader';
import { GatedControl } from '../../components/GatedControl';
import { actionApplyGateReason, gateReasonText, nextTurnGateReason } from './lifecycleGate';
import { DEATH_STATE_LABEL } from './combat/DeathSaves';
import { classifyDeathSaveOutcome, deathSaveSpectatorToastInfo, type DeathSaveOutcome } from './combat/deathSaveOutcome';
import { useTranslation } from 'react-i18next';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { DetailPageWayfinding } from '../../components/DetailPageWayfinding';
import { PrintControl } from '../../components/PrintControl';
import { PrintOnly } from '../../components/PrintOnly';
import { useKeyboardCommandHint, useKeyboardGuardedAction } from '../../components/KeyboardCommandProvider';
import type { ActionSpec, ActionUndoToken, AoeTemplate, CampaignMember, CastSessionCreated, Character, Combatant, CombatantRemoveResult, DiceRoll, DifficultyBand, EncounterDifficulty, EncounterEvent, EncounterWithCombatants, TurnWorkspace as TurnWorkspaceData, FogState, GenerateMapParams, GeneratedMapResult, HpResyncDirection, HpSyncConflict, MapPing, RulePack, TokenSize, UsableAction } from '@campfire/schema';
import { actionEconomyForAdapter, ARCHMAGE_ADAPTER_ID, STARFINDER_ADAPTER_ID, buildDifficultyExplanation, fogStatesEqual, hasCriticalHitsForAdapter, hasInitiativeRollForAdapter, LAIR_INITIATIVE_COUNT, LEGENDARY_ACTION_SLOT, ruleSystemAdapter } from '@campfire/schema';
import { entityTargetProps, entityHref } from '../../lib/entityLinks';
import { rulesetCapabilitiesForSelection } from '../../lib/rules';
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, API, ApiError, isAmbiguousMutation, isReadTimeout, isStaleWrite, isTransientError, translateApiError } from '../../lib/api';
import { formatDateTime, formatTime, useFormattingLocale, useTimeFormat } from '../../lib/format';
import { queryKeys, invalidateCampaignCharacters, invalidateCampaignCheckRequests, invalidateEncounter, invalidateEncounterActions, invalidateTableSafety, useTableSafety } from '../../lib/query';
import { newOperationId, useKeyedMutation } from '../../lib/keyedMutation';
import { beginReconcile, blocksFurtherActions, clearReconcile, completeReconcile, IDLE_RECONCILE, isAmbiguousOutcome, type ReconcileState } from '../../lib/ambiguousMutation';
import { useCampaignEvents, type CampaignEventsStatus } from '../../lib/useCampaignEvents';
import { inlineCharacterSheetsInteractive, inlineCharacterSheetsStatusLabel, shouldInvalidateInlineCharacters } from './inlineCharacterCards';
import { endedSummaryTallies } from './encounterEndedSummary';
import { filterPlayerSafeCombatants } from '../screen/playerSafe';
import {
  applyOptimisticHpDelta,
  mergeOptimisticHpTargets,
  replayOptimisticHpDeltas,
  rollbackOptimisticHpTargets,
  type OptimisticHpDelta,
} from './optimisticHp';
import { applyOptimisticSpellSlotDelta } from './optimisticSpellSlots';
import { FloatingNumbers } from './FloatingNumbers';
import { diffHpFeedback, hpFeedbackSnapshot, sameHpFeedbackSnapshot, withOptimisticHpFeedbackTargets, type HpFeedbackEvent, type HpFeedbackSnapshot } from './hpFeedback';
import { hasRestoredTrashedEncounter, isCurrentCombatantUndoEncounter, REMOVE_COMBATANT_CONFIRM_BODY } from './combatantLifecycle';
import { isAdjacentDuplicateEncounterPatch, observedEncounterPatchRevision, preferNewerEncounterSnapshot, reconcileEncounterPatchResponse, rollbackEncounterPatchError, type QueuedEncounterPatch } from './encounterPatchQueue';
import { pendingFogForEncounter, type ScopedPendingFog } from './fogSyncState';
import { EncounterAftermathPanel } from './EncounterAftermathPanel';
import { TurnWorkspace } from './TurnWorkspace';
import { PlayerVitalsHeader } from './PlayerVitalsHeader';
import { TurnElapsedChip } from './TurnElapsedChip';
import { TurnChangeBeat, type TurnChangeBeatEvent } from './TurnChangeBeat';
import { detectSseTurnBeat, isStaleTurnBeatFrame, previousTurnBeatForFrame, shouldReconcileTurnBeatRead, type PendingPolledTurnBeat, type TurnBeatSnapshot } from './turnBeat';
import { initials as tokenInitials } from '../../lib/avatarText';
import { useAuth } from '../../app/auth';
import { useCampaignAccess } from '../../app/CampaignAccessContext';
import { useCampaign, useCampaigns } from '../../app/CampaignContext';
import { SharedDiceLog } from '../dice/SharedDiceLog';
import { RulesLookupPanel } from './RulesLookupPanel';
import { EntityDiscussion } from '../comments/EntityDiscussion';
import { ResourceTrackerPanel } from "./ResourceTrackerPanel";
import { MapObjectsPanel } from './MapObjectsPanel';
import { shouldRevealInitiative } from './initiativeReveal';
import { CheckRequestPanel, GroupCheckBoard } from './CheckRequests';
import { EncounterQuickWhisperPanel } from './EncounterQuickWhisperPanel';
import { ActionUsePanel, legalTargets } from './ActionUseFlow';
import { revealCockpitPanel } from './vtt/revealCockpitPanel';
import { waitingPromptsKey } from './vtt/attentionKey';
import { EncounterVttShell, VttPanelSection } from './vtt/EncounterVttShell';
import { GroupActionRunner } from './GroupActionRunner.tsx';
import { Card, Btn, TextInput, Skeleton, ErrorNote, EmptyState } from '../../components/ui';
import { type MapReplaceAlignment } from '../../components/MapReplaceDialog';
import { NotFoundState } from '../../components/NotFoundState';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { UndoSnackbar } from '../../components/UndoSnackbar';
import { VisibleToPlayersBar } from '../../components/VisibleToPlayersBar';
import { MonsterHpDisplayControl } from './MonsterHpDisplayControl';
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
import { type DirectDamageMetadata, type TargetDamageApplication } from './directDamage';
import { resolveGridCalibration } from './mapRenderedBounds';
import { prefersReducedMotion, scrollBehavior } from '../../lib/prefersReducedMotion';
import { deleteConfirmCopy, dmLifecycleActions, isLifecycleConfirmValid } from './encounterLifecycleActions';
import { CONNECTING_GRACE_MS, confirmEncounterOverride, deriveEncounterSyncState, ENCOUNTER_OVERRIDE_INACTIVE, encounterActionsBlocked, encounterOverrideAuthorized, encounterOverrideOfferable, encounterSyncBannerMessage, encounterSyncChipClass, encounterSyncChipLabel, encounterSyncOverrideBannerKey, encounterSyncRevisionFromUpdatedAt, ENCOUNTER_SYNC_CHIP_TESTID, gateForWrite, isConnectingGraceElapsed, revokeEncounterOverrideIfUnauthorized, settleEncounterOverride, type EncounterOverrideAuthority, type EncounterOverrideState, type EncounterSyncRevision } from './encounterSyncState';
import { activeLifecycleStepId, encounterLifecycleSteps, playerGuidance, preparingGuidance } from './postCreateGuidance';
import { tokenIdentityBackground, tokenIdentityColor, tokenIdentityShape, TOKEN_IDENTITY_SHAPE_CLIP_PATH, pingIdentityColor } from './tokenIdentity';
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

const EMPTY_PACK_SLUGS: string[] = [];
const EMPTY_RULE_PACKS: RulePack[] = [];

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

const InitiativeStrip = memo(function InitiativeStrip({
  combatants,
  currentCombatantId,
  charactersById,
  memberNamesByUserId,
  turnPulse = false,
  hpFeedbackByCombatant,
  colorVisionAssist = false,
  revealTick = 0,
  canReorder = false,
  onReorderDrop,
}: {
  combatants: readonly Combatant[];
  currentCombatantId: number | null;
  charactersById: Map<number, Character>;
  memberNamesByUserId: ReadonlyMap<string, string>;
  turnPulse?: boolean;
  hpFeedbackByCombatant: ReadonlyMap<number, readonly (HpFeedbackEvent & { id: number })[]>;
  /** Issue #1942: adds a non-color identity shape + current-turn chevron alongside color. */
  colorVisionAssist?: boolean;
  /** Issue #1934: reveal animation trigger tick when transitioning preparing->running. */
  revealTick?: number;
  /** DM-only manual reorder (issue #1923) — drag a tile to a new slot. */
  canReorder?: boolean;
  onReorderDrop?: (combatantId: number, afterCombatantId: number | 'top') => void;
}) {
  const { t } = useTranslation();
  const combatantRefs = useRef(new Map<number, HTMLDivElement>());
  const prevPositionsRef = useRef<Map<number, number>>(new Map());
  const [staggeredVisibleIds, setStaggeredVisibleIds] = useState<Set<number> | null>(null);

  const staggerTimersRef = useRef<NodeJS.Timeout[]>([]);
  const consumedRevealTickRef = useRef(0);

  const orderedIds = useMemo(() => combatants.map((c) => c.id), [combatants]);
  const dragReorder = useCombatantDragReorder({
    axis: 'x',
    orderedIds,
    enabled: canReorder && !!onReorderDrop,
    elementsRef: combatantRefs,
    onDrop: useCallback((combatantId: number, afterCombatantId: number | 'top') => onReorderDrop?.(combatantId, afterCombatantId), [onReorderDrop]),
  });

  // A callback ref runs again for unrelated renders, which repeatedly stole the
  // DM's horizontal scroll position. Restrict the scroll to an actual turn
  // transition while retaining the user's reduced-motion preference (#1956).
  useLayoutEffect(() => {
    if (currentCombatantId == null) return;
    combatantRefs.current
      .get(currentCombatantId)
      ?.scrollIntoView({ behavior: scrollBehavior(), block: 'nearest', inline: 'center' });
  }, [currentCombatantId]);

  useEffect(() => {
    return () => {
      staggerTimersRef.current.forEach(clearTimeout);
      staggerTimersRef.current = [];
    };
  }, []);

  useLayoutEffect(() => {
    // Record current untransformed layout positions BEFORE applying FLIP transforms
    // (offsetLeft is transform- and scroll-independent)
    const currentPositions = new Map<number, number>();
    combatantRefs.current.forEach((el, id) => {
      if (el) {
        currentPositions.set(id, el.offsetLeft);
      }
    });

    const prevPositions = prevPositionsRef.current;

    const animateFlip = () => {
      combatantRefs.current.forEach((el, id) => {
        const prevLeft = prevPositions.get(id);
        if (prevLeft == null || !el) return;
        const currentLeft = currentPositions.get(id) ?? el.offsetLeft;
        const deltaX = prevLeft - currentLeft;
        if (Math.abs(deltaX) > 1) {
          el.style.transform = `translateX(${deltaX}px)`;
          el.style.transition = 'none';
          requestAnimationFrame(() => {
            el.style.transition = 'transform 500ms cubic-bezier(0.2, 0, 0, 1)';
            el.style.transform = '';
          });
        }
      });
    };

    if (revealTick > 0 && revealTick !== consumedRevealTickRef.current) {
      consumedRevealTickRef.current = revealTick;

      staggerTimersRef.current.forEach(clearTimeout);
      staggerTimersRef.current = [];

      if (prefersReducedMotion()) {
        setStaggeredVisibleIds(null);
        prevPositionsRef.current = currentPositions;
        return;
      }

      animateFlip();

      const sortedCombatantIds = [...combatants]
        .sort((a, b) => (b.initiative ?? -Infinity) - (a.initiative ?? -Infinity))
        .map((c) => c.id);

      setStaggeredVisibleIds(new Set());
      sortedCombatantIds.forEach((id, index) => {
        const timer = setTimeout(() => {
          setStaggeredVisibleIds((prev) => (prev ? new Set([...prev, id]) : null));
        }, index * 60);
        staggerTimersRef.current.push(timer);
      });

      const totalTime = sortedCombatantIds.length * 60 + 200;
      const endTimer = setTimeout(() => {
        setStaggeredVisibleIds(null);
        staggerTimersRef.current = [];
      }, totalTime);
      staggerTimersRef.current.push(endTimer);
    } else if (consumedRevealTickRef.current > 0) {
      animateFlip();
    }

    prevPositionsRef.current = currentPositions;
  }, [revealTick, combatants]);

  return (
    <div
      className="flex gap-2 overflow-x-auto pb-4 pt-2 px-2"
      style={{
        position: 'relative',
        scrollSnapType: 'x mandatory',
        scrollbarWidth: 'none',
      }}
      data-testid="initiative-strip"
    >
      {combatants.map((c) => {
        const isCurrent = c.id === currentCombatantId;
        const character = c.characterId ? charactersById.get(c.characterId) : null;
        const isSilhouette = c.kind === 'npc' && c.npcId == null;
        const feedback = hpFeedbackByCombatant.get(c.id) ?? [];
        const feedbackClass = feedback.some((event) => event.kind === 'down')
          ? ' cf-hp-feedback-anchor--down'
          : feedback.some((event) => event.kind === 'revive')
            ? ' cf-hp-feedback-anchor--revive'
            : feedback.some((event) => event.crit)
              ? ' cf-hp-feedback-anchor--crit'
              : '';
        const initiativeValue = c.initiative != null ? String(c.initiative) : '—';
        const isChipVisible = staggeredVisibleIds == null || staggeredVisibleIds.has(c.id);

        const isDragging = dragReorder.draggingId === c.id;
        const isDropTarget = dragReorder.overId === c.id;

        return (
          <div
            key={c.id}
            data-testid={`initiative-strip-tile-${c.id}`}
            className={`cf-hp-feedback-anchor flex flex-col items-center gap-1 flex-none${feedbackClass}`}
            style={{
              scrollSnapAlign: 'center',
              ...(canReorder
                ? {
                    opacity: isDragging ? 0.5 : 1,
                    outline: isDropTarget ? '2px solid var(--color-accent)' : undefined,
                    outlineOffset: 2,
                  }
                : {}),
            }}
            ref={(el) => {
              if (el) combatantRefs.current.set(c.id, el);
              else combatantRefs.current.delete(c.id);
            }}
          >
            {c.turnState.delaying && (
              <span
                className="tag tag-neutral"
                data-testid={`strip-delaying-${c.id}`}
                title={t('encounters.reorder.delayingBadge', 'Delaying')}
                style={{ fontSize: 9, lineHeight: 1, padding: '1px 4px' }}
              >
                {t('encounters.reorder.delayingBadge', 'Delaying')}
              </span>
            )}
            {colorVisionAssist && isCurrent && (
              <span
                data-testid="strip-token-turn-chevron"
                aria-hidden="true"
                style={{ fontSize: 11, lineHeight: 1, color: 'var(--color-accent)' }}
              >
                ▾
              </span>
            )}
            <div
              aria-current={isCurrent ? 'true' : undefined}
              className={`flex items-center justify-center bg-surface ${isCurrent && turnPulse ? 'cf-turn-beat-pulse' : ''}`}
              style={{
                position: 'relative',
                width: isCurrent ? 48 : 40,
                height: isCurrent ? 48 : 40,
                transition: 'all 0.2s ease',
                border: isCurrent ? '2px solid var(--color-accent)' : '2px solid transparent',
                background: tokenIdentityBackground(c),
                borderRadius: 6,
              }}
              title={c.name}
            >
              {canReorder && (
                // Issue #2074 review finding 2: `touchAction: 'none'` used to cover the
                // WHOLE tile, so a finger swipe anywhere on it dragged instead of scrolling
                // this horizontally-scrollable strip. Confine the drag surface to this small
                // handle — mirroring the roster's ⠿ handle (CombatantRow.tsx) — so the rest
                // of the tile keeps native touch scrolling and only a deliberate touch on the
                // handle starts a reorder gesture.
                <span
                  aria-hidden="true"
                  data-testid={`initiative-strip-drag-handle-${c.id}`}
                  style={{
                    position: 'absolute',
                    top: -4,
                    left: -4,
                    width: 16,
                    height: 16,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: 8,
                    background: 'var(--color-bg-surface-raised, #1e293b)',
                    border: '1px solid var(--color-border, #475569)',
                    color: 'var(--color-text-main, #f8fafc)',
                    fontSize: 9,
                    lineHeight: 1,
                    cursor: 'grab',
                    touchAction: 'none',
                    zIndex: 10,
                  }}
                  {...dragReorder.handleProps(c.id)}
                >
                  ⠿
                </span>
              )}
              <div className="w-full h-full flex items-center justify-center overflow-hidden" style={{ borderRadius: 4 }}>
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
              {/* Persistent initiative chip (issue #1934) */}
              <span
                data-testid="initiative-chip"
                data-combatant-id={c.id}
                aria-label={t('encounters.initiativeChipLabel', 'Initiative: {{value}}', { value: initiativeValue })}
                style={{
                  position: 'absolute',
                  top: -4,
                  right: -4,
                  minWidth: 18,
                  height: 18,
                  padding: '0 4px',
                  borderRadius: 9,
                  background: 'var(--color-bg-surface-raised, #1e293b)',
                  border: '1px solid var(--color-border, #475569)',
                  color: 'var(--color-text-main, #f8fafc)',
                  fontSize: 10,
                  fontWeight: 700,
                  lineHeight: '16px',
                  textAlign: 'center',
                  zIndex: 10,
                  pointerEvents: 'none',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.5)',
                  opacity: isChipVisible ? 1 : 0,
                  transform: isChipVisible ? 'scale(1)' : 'scale(0)',
                  transition: prefersReducedMotion() ? 'none' : 'opacity 0.2s ease, transform 0.2s ease',
                }}
              >
                {initiativeValue}
              </span>
              {colorVisionAssist && (
                <span
                  data-testid="strip-token-identity-shape"
                  data-token-shape={tokenIdentityShape(c.id)}
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    right: 2,
                    bottom: 2,
                    width: 9,
                    height: 9,
                    background: '#fff',
                    clipPath: TOKEN_IDENTITY_SHAPE_CLIP_PATH[tokenIdentityShape(c.id)],
                    boxShadow: '0 0 0 1px rgba(15,23,42,.7)',
                  }}
                />
              )}
              {c.controllerUserId != null && (
                <span
                  data-testid={`strip-controller-badge-${c.id}`}
                  title={t('encounters.controller.controlledBy', {
                    name:
                      memberNamesByUserId.get(String(c.controllerUserId)) ??
                      t('encounters.controller.unknownController'),
                  })}
                  style={{
                    position: 'absolute',
                    top: -3,
                    left: -3,
                    width: 16,
                    height: 16,
                    borderRadius: '50%',
                    background: tokenIdentityColor(c.controllerUserId),
                    border: '1.5px solid var(--color-surface)',
                    fontSize: 9,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#fff',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.5)',
                    zIndex: 2,
                  }}
                >
                  🎮
                </span>
              )}
            </div>
            <FloatingNumbers events={feedback} />
            <span className="text-muted" style={{ fontSize: 10, lineHeight: 1 }}>
              {hpDisplay(c)}
            </span>
          </div>
        );
      })}
    </div>
  );
});


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
  const { refresh: refreshCampaigns } = useCampaigns();
  const announce = useAnnounce();
  // #599/#1933: mirrors the server's assertNoSafetyHold rejection on start/nextTurn/
  // undoTurn/endTurn as a GatedControl reason — no server or authorization change, just
  // reading the same table-wide safety-hold state SafetyHoldBar already shows everyone.
  const { data: tableSafety } = useTableSafety(Number.isFinite(cid) ? cid : undefined);
  const safetyHoldActive = tableSafety?.active === true;

  // Resolve the rule-system adapter FROM THE ACTIVE CAMPAIGN (issue #234) rather than at
  // module scope with no argument — so a future non-5e adapter's condition vocabulary and
  // statblock mapping actually take effect. Default (5e) is unchanged.
  const ruleSystem = campaign?.ruleSystem ?? null;
  const activeAdapter = useMemo(() => ruleSystemAdapter(ruleSystem, campaign?.customMechanicsProfile), [ruleSystem, campaign?.customMechanicsProfile]);
  const isStarfinder = activeAdapter.id === STARFINDER_ADAPTER_ID || ruleSystem?.startsWith('starfinder') || false;
  const isArchmage = activeAdapter.id === ARCHMAGE_ADAPTER_ID;
  const conditionSuggestions = useMemo(() => {
    const seen = new Set<string>();
    return [...activeAdapter.conditions, ...(campaign?.conditionDefinitions ?? []).map((definition) => definition.name)].filter((name) => {
      const canonical = name.toLowerCase();
      if (seen.has(canonical)) return false;
      seen.add(canonical);
      return true;
    });
  }, [activeAdapter, campaign?.conditionDefinitions]);
  // Issue #1910 review: the vitals header's speed fallback must read the ACTIVE
  // campaign's own adapter default, not a hardcoded 30 — a system without a
  // movement slot at all (e.g. PF2e) has no adapter default to fall back to.
  const movementDefault = useMemo(
    () => actionEconomyForAdapter(activeAdapter).slots.find((s) => s.kind === 'movement')?.max,
    [activeAdapter],
  );

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
  // Issue #1917: hoisted out of BattleMap's `pendingFog` JSX prop, which called this at the
  // call site on every render. `pendingFogForEncounter` itself already returns a referentially
  // stable value (either `undefined` or the SAME `pendingFog.fog` object already held in
  // state) — the useMemo here is a belt-and-braces guard against that invariant silently
  // breaking later, and documents the prop as intentionally stabilized for BattleMap's memo.
  const battleMapPendingFog = useMemo(() => pendingFogForEncounter(pendingFog, eid), [pendingFog, eid]);
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
  const [bulkHpApplyPending, setBulkHpApplyPending] = useState(false);
  const bulkHpApplyPendingRef = useRef(false);
  const turnAdvancePendingRef = useRef(false);
  /** Live map layout from BattleMap for AoE hit-testing (issue #626). */
  const [aoeHitLayout, setAoeHitLayout] = useState<AoeHitLayout | null>(null);
  // Issue #414: structured action Use flow — pick targets, preview, apply, undo.
  const [pendingActionUse, setPendingActionUse] = useState<{
    id: number;
    combatantId: number;
    actorName: string;
    actionIndex: number;
    actionName: string;
    spec: ActionSpec;
  } | null>(null);
  const pendingActionUseSequence = useRef(0);
  const pendingActionUseIdRef = useRef<number | null>(null);
  const [actionTargetIds, setActionTargetIds] = useState<number[]>([]);
  const [actionTargetsDeclared, setActionTargetsDeclared] = useState(false);
  // Issue #1922: group action rolls — run one monster/NPC action for every selected identical
  // combatant in one pass. A separate pending slot from `pendingActionUse` above (mutually
  // exclusive in the UI; opening one dismisses the other) because the group flow's own step
  // machine (candidate + target selection -> sequential loop -> summary card) has nothing in
  // common with the single-actor preview/apply flow.
  const [pendingGroupActionUse, setPendingGroupActionUse] = useState<{
    id: number;
    combatantId: number;
    actorName: string;
    actionIndex: number;
    actionName: string;
    spec: ActionSpec;
    sourceAction: { name: string; toHit: string; damage: string };
  } | null>(null);
  const pendingGroupActionUseSequence = useRef(0);
  const [actionImpactTargetIds, setActionImpactTargetIds] = useState<number[]>([]);
  const actionImpactTimerRef = useRef<number | null>(null);
  const [actionUndo, setActionUndo] = useState<{ token: ActionUndoToken; label: string } | null>(null);
  const [escalationOverrideDraft, setEscalationOverrideDraft] = useState('');
  // Live battle-map pings (issue #238) — transient markers pushed over SSE, each auto-expires
  // after a short lifetime. A monotonic key disambiguates simultaneous pings at the same spot.
  const [pings, setPings] = useState<Array<{ key: number; x: number; y: number; senderName: string | null; color: string | null; label: string | null }>>([]);
  const pingSeq = useRef(0);
  const addPing = useCallback((ping: { x: number; y: number; senderName?: string | null; color?: string | null; label?: string | null }) => {
    const key = ++pingSeq.current;
    // Issue #1937: a labeled ping (an intent chosen from the long-press/right-click
    // menu) announces the intent alongside the sender; a plain tap keeps the original
    // wording unchanged. Issue #2048: this composes exactly as BattleMap's visible ping
    // log does — same two keys, same `unknownSender` fallback — so the announcement a
    // screen-reader user hears is the sentence that is on screen, in one language.
    // Composing the null-sender case separately is what previously left it as a bare
    // English literal that also silently dropped the intent label.
    const senderName = ping.senderName || t('encounters.map.ping.log.unknownSender');
    announce(
      ping.label
        ? t('encounters.map.ping.log.labeled', { name: senderName, label: ping.label })
        : t('encounters.map.ping.log.plain', { name: senderName }),
    );
    setPings((prev) => {
      const next = [...prev, { key, x: ping.x, y: ping.y, senderName: ping.senderName || null, color: ping.color || null, label: ping.label || null }];
      return next.slice(-10);
    });
    setTimeout(() => setPings((prev) => prev.filter((p) => p.key !== key)), 10000);
  }, [announce, t]);
  const dismissPing = useCallback((key: number) => {
    setPings((prev) => prev.filter((p) => p.key !== key));
  }, []);
  useEffect(() => () => {
    if (actionImpactTimerRef.current != null) window.clearTimeout(actionImpactTimerRef.current);
  }, []);
  // Per-combatant in-flight tracking (issue #73) — replaces the single global `busy`
  // flag so one combatant's slower edit (rename, condition, initiative…) disables only
  // that row, never the whole tracker. HP steppers bypass this entirely: they're
  // optimistic and stay live even while a request is in flight.
  const [pendingCombatantIds, setPendingCombatantIds] = useState<ReadonlySet<number>>(() => new Set());
  // Issue #1926: combatants for which the DM has resolved (revealed from, or dismissed)
  // the one-tap kill prompt this session. Client-local only — a page reload resets it,
  // same as every other transient run-session UI state; the server-persisted
  // `statblockRevealed` flag itself is the only thing that's actually authoritative.
  const [dismissedKillPromptIds, setDismissedKillPromptIds] = useState<ReadonlySet<number>>(() => new Set());
  // React state disables the source row after render; the ref closes the same-tick
  // double-click window before that render can happen.
  const pendingDuplicateCombatantIds = useRef(new Set<number>());
  const markCombatantPending = useCallback((combatantId: number, on: boolean) => {
    setPendingCombatantIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(combatantId);
      else next.delete(combatantId);
      return next;
    });
  }, []);

  /**
   * Cockpit chrome state (encounter-vtt design import). Presentation only — which
   * tab of the side panel is showing, whether the panel and dice tray are open,
   * and whether the initiative strip over the map is collapsed. Nothing here
   * affects what the viewer is allowed to see or write.
   */
  type PanelTab = 'turn' | 'party' | 'log' | 'table';
  /**
   * The viewer's explicit tab choice, and the default it overrides — both stamped with the
   * encounter they belong to. `RunSessionPage` is reused across encounter navigations, so
   * an unstamped value would carry a choice made in one fight into the next: a DM who
   * picked Turn mid-combat would land on an empty Turn panel when opening a preparing
   * encounter. Comparing the stamp resolves during render, so the wrong tab never paints.
   */
  // Stamped with the lifecycle as well as the encounter: an explicit choice has to expire
  // on exactly the transitions the default is re-derived on, or it outlives them. A player
  // who clicked Turn during combat (or merely re-clicked the already-selected tab) kept
  // `turn` after the fight ended, and the Turn section renders nothing once it is over —
  // so the recomputed `party` default was overridden by a choice for a tab that no longer
  // has any content.
  const [panelTabChoice, setPanelTabChoice] = useState<{ eid: number; running: boolean; tab: PanelTab } | null>(
    null,
  );
  const defaultPanelTabRef = useRef<{ eid: number; running: boolean; tab: PanelTab } | null>(null);
  // Chrome the viewer collapses or opens, stamped with the encounter for the same reason
  // the tab choice is: navigating between two CACHED encounters reuses this component
  // without an unmount, so a panel collapsed in one fight arrived hidden in the next —
  // as did an open dice tray and a collapsed initiative strip, none of which the viewer
  // asked for on the encounter they just opened.
  const [chrome, setChrome] = useState<{ eid: number; panelOpen: boolean; diceTrayOpen: boolean; turnBarCollapsed: boolean }>(
    () => ({ eid, panelOpen: true, diceTrayOpen: false, turnBarCollapsed: false }),
  );
  const activeChrome = chrome.eid === eid ? chrome : { eid, panelOpen: true, diceTrayOpen: false, turnBarCollapsed: false };
  const { panelOpen, diceTrayOpen, turnBarCollapsed } = activeChrome;
  const setPanelOpen = useCallback(
    (next: boolean) => setChrome((prev) => ({ ...(prev.eid === eid ? prev : { eid, panelOpen: true, diceTrayOpen: false, turnBarCollapsed: false }), eid, panelOpen: next })),
    [eid],
  );
  const setDiceTrayOpen = useCallback(
    (next: boolean | ((open: boolean) => boolean)) =>
      setChrome((prev) => {
        const base = prev.eid === eid ? prev : { eid, panelOpen: true, diceTrayOpen: false, turnBarCollapsed: false };
        return { ...base, eid, diceTrayOpen: typeof next === 'function' ? next(base.diceTrayOpen) : next };
      }),
    [eid],
  );
  const setTurnBarCollapsed = useCallback(
    (next: boolean | ((collapsed: boolean) => boolean)) =>
      setChrome((prev) => {
        const base = prev.eid === eid ? prev : { eid, panelOpen: true, diceTrayOpen: false, turnBarCollapsed: false };
        return { ...base, eid, turnBarCollapsed: typeof next === 'function' ? next(base.turnBarCollapsed) : next };
      }),
    [eid],
  );

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
  // Track successful query-function completions separately from TanStack's cache
  // timestamp. Local optimistic `setQueryData` writes advance `dataUpdatedAt`, so that
  // timestamp cannot prove that the reconnect/load catch-up GET actually completed.
  const encounterReadRevisionRef = useRef(0);
  const latestEncounterReadRef = useRef<{
    revision: number;
    encounterId: number;
    encounter: EncounterWithCombatants;
  } | null>(null);
  const [encounterReadRevision, setEncounterReadRevision] = useState(0);
  // Capture the last actual read revision before useQuery can start this encounter's
  // mount refetch. Reading the ref later from a passive effect can observe the completed
  // response instead, leaving the turn-beat resync gate armed until another read.
  const [turnBeatLoadWatermark, setTurnBeatLoadWatermark] = useState(() => ({
    encounterId: eid,
    readRevision: encounterReadRevisionRef.current,
  }));
  if (turnBeatLoadWatermark.encounterId !== eid) {
    setTurnBeatLoadWatermark({
      encounterId: eid,
      readRevision: encounterReadRevisionRef.current,
    });
  }
  const encounterQuery = useQuery({
    queryKey: queryKeys.encounter(eid),
    queryFn: async ({ signal }) => {
      const reconciled = reconcileEncounterPatchResponse(
        await api.get<EncounterWithCombatants>(`${API}/encounters/${eid}`, { signal }),
        pendingEncounterPatches.current.values(),
        '',
        eid,
      );
      // An invalidation can supersede an in-flight poll just before its response
      // publishes. Only the fetch TanStack still accepts may satisfy the one-shot
      // reconnect/load resync gate.
      signal.throwIfAborted();
      const revision = encounterReadRevisionRef.current + 1;
      encounterReadRevisionRef.current = revision;
      latestEncounterReadRef.current = { revision, encounterId: eid, encounter: reconciled };
      setEncounterReadRevision(revision);
      return reconciled;
    },
    enabled: Number.isFinite(eid),
    refetchInterval: 5_000,
  });
  const encounter = encounterQuery.data ?? null;

  // is the opposite: the Turn tab is their sheet and their End turn. Either way the
  // Turn tab only has content while combat is running, so a preparing or ended
  // encounter always opens on the roster rather than on an empty panel.
  // Resolved once, on the first render that has an encounter, and then frozen. Deriving it
  // every render meant the tab moved under the viewer whenever an input changed — a co-DM
  // demoted to player mid-session had the roster replaced by the turn workspace while they
  // were reading it. A default is for the first paint, not a rule the panel keeps enforcing.
  // Derived here rather than beside the markup: the turn-follow effect below needs to
  // know whether the roster is actually on screen, and it runs long before render.
  // Re-resolved when the encounter changes OR when combat starts or stops, and held
  // across everything else. Both halves matter: freezing on `eid` alone stranded a player
  // who was present through "Start" on the roster, and left someone who opened a running
  // fight on a Turn tab that renders nothing once it ends — while re-deriving on every
  // input is what moved the tab under a co-DM the moment they were demoted. Lifecycle is
  // the one input that changes what the tabs are FOR; the rest are not.
  const encounterRunning = encounter?.status === 'running';
  if (
    encounter
    && (defaultPanelTabRef.current?.eid !== eid || defaultPanelTabRef.current?.running !== encounterRunning)
  ) {
    defaultPanelTabRef.current = {
      eid,
      running: encounterRunning,
      tab: !isDm && encounterRunning ? 'turn' : 'party',
    };
  }
  const panelTab: PanelTab =
    (panelTabChoice?.eid === eid && panelTabChoice.running === encounterRunning ? panelTabChoice.tab : null)
    ?? defaultPanelTabRef.current?.tab
    ?? 'party';
  const hpFeedbackSnapshotRef = useRef<{ encounterId: number; combatants: Map<number, HpFeedbackSnapshot> } | null>(null);
  const bulkHpFeedbackOperationsRef = useRef(new Map<string, { targets: Set<number>; stale: Map<number, HpFeedbackSnapshot>; emitted: Set<number> }>());
  const nextHpFeedbackIdRef = useRef(0);
  const [hpFeedbackEvents, setHpFeedbackEvents] = useState<Array<HpFeedbackEvent & { id: number }>>([]);
  const appendHpFeedbackEvents = useCallback((events: readonly HpFeedbackEvent[]) => {
    if (events.length === 0) return;
    setHpFeedbackEvents((current) => [...current, ...events.map((event) => ({ ...event, id: nextHpFeedbackIdRef.current++ }))]);
  }, []);
  const appendOrUpgradeHpFeedbackCrit = useCallback((events: readonly HpFeedbackEvent[]) => {
    const criticalDamage = events.find((event) => event.kind === 'damage' && event.crit);
    if (!criticalDamage) {
      appendHpFeedbackEvents(events);
      return;
    }
    setHpFeedbackEvents((current) => {
      let index = -1;
      for (let candidate = current.length - 1; candidate >= 0; candidate -= 1) {
        const event = current[candidate];
        if (
          event.combatantId === criticalDamage.combatantId
          && event.kind === 'damage'
          && event.amount === criticalDamage.amount
        ) {
          index = candidate;
          break;
        }
      }
      if (index < 0) {
        return [...current, ...events.map((event) => ({ ...event, id: nextHpFeedbackIdRef.current++ }))];
      }
      return current.map((event, eventIndex) => eventIndex === index ? { ...event, crit: true } : event);
    });
  }, [appendHpFeedbackEvents]);
  useEffect(() => { setHpFeedbackEvents([]); hpFeedbackSnapshotRef.current = null; }, [eid]);
  useEffect(() => {
    if (!encounter) return;
    const previous = hpFeedbackSnapshotRef.current;
    if (previous?.encounterId !== encounter.id) {
      hpFeedbackSnapshotRef.current = { encounterId: encounter.id, combatants: hpFeedbackSnapshot(encounter.combatants) };
      return;
    }
    // A refetch can observe a committed earlier click while later plain-stepper clicks
    // remain in the optimistic ledger. The click emits its feedback at mutation time;
    // retain that predicted baseline for its targets so a 30 → 20 prediction followed
    // by a 25 server refetch does not look like +5 heal. Still diff non-targets so a
    // concurrent remote change remains visible while the local write is pending.
    const optimisticQueue = optimisticHpQueueRef.current;
    if (optimisticQueue.encounterId === eid && optimisticQueue.base && optimisticQueue.operations.size > 0) {
      const optimisticCombatants = replayOptimisticHpDeltas(
        optimisticQueue.base.combatants,
        [...optimisticQueue.operations.values()]
          .sort((a, b) => a.sequence - b.sequence)
          .map(({ combatantId, delta }) => ({ combatantId, delta })),
        ruleSystem,
        campaign?.customMechanicsProfile,
      );
      const pendingTargetIds = new Set([...optimisticQueue.operations.values()].map(({ combatantId }) => combatantId));
      const suppressedTargetIds = new Set([
        ...pendingTargetIds,
        ...[...bulkHpFeedbackOperationsRef.current.values()].flatMap((operation) => [...operation.targets]),
      ]);
      const events = diffHpFeedback(previous.combatants, encounter.combatants)
        .filter((event) => !suppressedTargetIds.has(event.combatantId));
      const nextSnapshot = withOptimisticHpFeedbackTargets(encounter.combatants, optimisticCombatants, pendingTargetIds);
      hpFeedbackSnapshotRef.current = { encounterId: encounter.id, combatants: nextSnapshot };
      appendHpFeedbackEvents(events);
      return;
    }
    if (bulkHpFeedbackOperationsRef.current.size > 0) {
      const pendingTargets = new Set([...bulkHpFeedbackOperationsRef.current.values()].flatMap((operation) => [...operation.targets]));
      for (const combatant of encounter.combatants) {
        const before = previous.combatants.get(combatant.id);
        if (pendingTargets.has(combatant.id) && before && !sameHpFeedbackSnapshot(before, combatant)) {
          for (const operation of bulkHpFeedbackOperationsRef.current.values()) if (operation.targets.has(combatant.id)) operation.stale.set(combatant.id, combatant);
        }
      }
      const events = diffHpFeedback(previous.combatants, encounter.combatants)
        .filter((event) => !pendingTargets.has(event.combatantId));
      const optimisticTargets = [...pendingTargets]
        .map((combatantId) => previous.combatants.get(combatantId))
        .filter((combatant): combatant is HpFeedbackSnapshot => combatant != null);
      hpFeedbackSnapshotRef.current = {
        encounterId: encounter.id,
        combatants: withOptimisticHpFeedbackTargets(encounter.combatants, optimisticTargets, pendingTargets),
      };
      appendHpFeedbackEvents(events);
      return;
    }
    const events = diffHpFeedback(previous.combatants, encounter.combatants);
    hpFeedbackSnapshotRef.current = { encounterId: encounter.id, combatants: hpFeedbackSnapshot(encounter.combatants) };
    appendHpFeedbackEvents(events);
  }, [appendHpFeedbackEvents, eid, encounter, ruleSystem]);
  useEffect(() => {
    if (hpFeedbackEvents.length === 0) return;
    const timeout = window.setTimeout(() => setHpFeedbackEvents([]), 1_080 + (hpFeedbackEvents.length - 1) * 120);
    return () => window.clearTimeout(timeout);
  }, [hpFeedbackEvents]);
  const hpFeedbackByCombatant = useMemo(() => {
    const byCombatant = new Map<number, Array<HpFeedbackEvent & { id: number }>>();
    for (const event of hpFeedbackEvents) {
      const events = byCombatant.get(event.combatantId) ?? [];
      events.push(event);
      byCombatant.set(event.combatantId, events);
    }
    return byCombatant;
  }, [hpFeedbackEvents]);
  const seedHpFeedbackSnapshot = useCallback((source: EncounterWithCombatants | undefined) => {
    if (source?.id !== eid) return;
    hpFeedbackSnapshotRef.current = { encounterId: eid, combatants: hpFeedbackSnapshot(source.combatants) };
  }, [eid]);
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
  const [turnBeat, setTurnBeat] = useState<TurnChangeBeatEvent | null>(null);
  const [turnPulse, setTurnPulse] = useState(false);
  const [turnOwnerFromEvent, setTurnOwnerFromEvent] = useState<{
    combatantId: number | null;
    isYourTurn: boolean;
  } | null>(null);
  const [turnOwnerPendingCombatantId, setTurnOwnerPendingCombatantId] = useState<number | null>(null);
  const [characterOwnershipRefreshPending, setCharacterOwnershipRefreshPending] = useState(false);
  const turnBeatSequence = useRef(0);
  const previousTurnBeatRef = useRef<TurnBeatSnapshot | null>(null);
  const pendingPolledTurnBeatRef = useRef<PendingPolledTurnBeat | null>(null);
  // Freshness revision for (re)deriving `previousTurnBeatRef` from the REST-fetched
  // `encounter` row (issue #2092). Starts at zero so the first successful load
  // establishes a silent baseline; the reconnect/stream-recovery handlers below
  // capture the last successful query-function revision before requesting a catch-up
  // read. The baseline only consumes a completed read newer than that revision,
  // including when TanStack Query structurally shares the same encounter object. Ordinary
  // polls may also repair an isolated missed frame, but only when their server-owned
  // `turnVersion` is strictly newer than this baseline. A paired refetch that races its
  // delivered SSE frame therefore cannot silently consume that frame or overwrite it later.
  const awaitingTurnBeatResyncRef = useRef<number | null>(0);
  const turnPulseTimerRef = useRef<number | null>(null);
  const ownedTurnFeedbackRef = useRef<number | null>(null);
  // A character.updated frame invalidates the ownership map, but React Query
  // deliberately retains its last successful data during the background fetch.
  // Keep a precise freshness watermark so an immediately following turn edge
  // cannot promote the previous owner from that stale map.
  const characterOwnershipPendingDataUpdatedAtRef = useRef<number | null>(null);

  useEffect(() => {
    const pendingDataUpdatedAt = characterOwnershipPendingDataUpdatedAtRef.current;
    if (
      pendingDataUpdatedAt == null
      || charactersQuery.isFetching
      || charactersQuery.dataUpdatedAt <= pendingDataUpdatedAt
    ) return;
    characterOwnershipPendingDataUpdatedAtRef.current = null;
    setCharacterOwnershipRefreshPending(false);
  }, [charactersQuery.dataUpdatedAt, charactersQuery.isFetching]);

  // Every campaign-character invalidation retains the previous successful
  // roster while its replacement loads. Mark that roster stale first so any
  // turn frame arriving in the gap cannot use a former owner's identity.
  const invalidateCampaignCharactersForOwnership = useCallback(() => {
    characterOwnershipPendingDataUpdatedAtRef.current = charactersQuery.dataUpdatedAt;
    // Neither the event-derived owner nor the retained /turn response is
    // authoritative while the roster that grants ownership is being replaced.
    // Gate their cues immediately; the completed roster read reauthorizes them.
    setCharacterOwnershipRefreshPending(true);
    setTurnOwnerFromEvent(null);
    setTurnOwnerPendingCombatantId(null);
    setTurnPulse(false);
    if (turnPulseTimerRef.current != null) window.clearTimeout(turnPulseTimerRef.current);
    invalidateCampaignCharacters(queryClient, cid);
  }, [charactersQuery.dataUpdatedAt, cid, queryClient]);

  // An owned turn can initially be a private pending beat, then promote once
  // the authorized roster and /turn workspace arrive. Keep the visual cues
  // tied to that one beat even if those reads cause several rerenders.
  const triggerOwnedTurnFeedback = useCallback((beatKey: number) => {
    if (ownedTurnFeedbackRef.current === beatKey) return;
    ownedTurnFeedbackRef.current = beatKey;
    if (!prefersReducedMotion()) {
      setTurnPulse(true);
      if (turnPulseTimerRef.current != null) window.clearTimeout(turnPulseTimerRef.current);
      turnPulseTimerRef.current = window.setTimeout(() => setTurnPulse(false), 700);
    }
    // A turn change must not pull a player away from an active form or dialog.
    const active = document.activeElement as HTMLElement | null;
    if (!active?.closest('form, [role="dialog"], input, textarea, select')) {
      // Reveal first. In the cockpit the workspace stays MOUNTED under whichever tab is
      // not showing, and the whole panel can be collapsed, so a bare `scrollIntoView()`
      // scrolled something invisible and left the player on an unrelated surface at the
      // exact moment their turn began.
      revealCockpitPanel('turn-workspace', () => {
        document.getElementById('turn-workspace')?.scrollIntoView({
          behavior: scrollBehavior(),
          block: 'nearest',
        });
      });
    }
  }, []);

  useEffect(() => {
    previousTurnBeatRef.current = null;
    pendingPolledTurnBeatRef.current = null;
    awaitingTurnBeatResyncRef.current = turnBeatLoadWatermark.readRevision;
    ownedTurnFeedbackRef.current = null;
    setTurnOwnerFromEvent(null);
    setTurnOwnerPendingCombatantId(null);
    setTurnBeat(null);
    setTurnPulse(false);
    if (turnPulseTimerRef.current != null) window.clearTimeout(turnPulseTimerRef.current);
  }, [eid, turnBeatLoadWatermark.readRevision]);

  // A loaded encounter is a silent baseline. This prevents opening an already
  // running encounter from replaying a turn-start beat, and (via
  // `awaitingTurnBeatResyncRef`, set by the reconnect/stream-recovery handlers
  // below) keeps the baseline current if the stream missed an intervening edge.
  // Ordinary polls can also update this silent baseline after a missed frame, but only
  // through the monotonic `turnVersion` check below (issue #2092).
  useEffect(() => {
    const completedRead = latestEncounterReadRef.current;
    if (!completedRead || completedRead.encounterId !== eid) return;
    const previous = previousTurnBeatRef.current?.encounterId === eid
      ? previousTurnBeatRef.current
      : null;
    const armedAfterReadRevision = awaitingTurnBeatResyncRef.current;
    if (!shouldReconcileTurnBeatRead(
      armedAfterReadRevision,
      completedRead.revision,
      previous?.turnVersion ?? null,
      completedRead.encounter.turnVersion,
    )) return;
    awaitingTurnBeatResyncRef.current = null;
    const readEncounter = completedRead.encounter;
    // Preserve the pre-poll comparison point for the one matching SSE revision. The
    // transaction commits before its post-commit event emission, so an ordinary poll can
    // legitimately observe the new turn first. Explicit load/reconnect resyncs remain
    // silent baselines and therefore do not create a pending visible edge.
    pendingPolledTurnBeatRef.current = armedAfterReadRevision == null && previous != null
      ? { turnVersion: readEncounter.turnVersion, previous }
      : null;
    const current = readEncounter.currentCombatantId == null
      ? undefined
      : readEncounter.combatants.find((combatant) => combatant.id === readEncounter.currentCombatantId);
    const isYourTurn = current?.characterId != null
      && characters.some((character) => character.id === current.characterId && character.ownerUserId === String(me?.user.id ?? ''));
    previousTurnBeatRef.current = {
      encounterId: eid,
      combatantId: readEncounter.currentCombatantId,
      round: readEncounter.status === 'running' ? readEncounter.round : null,
      turnVersion: readEncounter.turnVersion,
      isYourTurn,
    };
  }, [eid, encounterReadRevision, characters, me?.user.id]);
  useEffect(() => () => {
    if (turnPulseTimerRef.current != null) window.clearTimeout(turnPulseTimerRef.current);
  }, []);
  // Ending an encounter emits an encounter.updated frame rather than a turn edge.
  // Clear every transient turn signal here so a disabled /turn query cannot keep
  // a prior owned turn (including the hidden-tab title) alive after combat stops.
  useEffect(() => {
    if (encounter?.status === 'running') return;
    ownedTurnFeedbackRef.current = null;
    setTurnOwnerFromEvent(null);
    setTurnOwnerPendingCombatantId(null);
    setTurnBeat(null);
    setTurnPulse(false);
  }, [encounter?.status]);
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
  // Issue #1914: `canPlayerWrite` is the scope-specific authority for an 'own-combatant'
  // override, exactly parallel to `canDmWrite` for the 'dm' scope — see
  // `encounterOverrideAuthorized`'s doc for why each scope checks its own authority rather
  // than sharing one.
  const overrideAuthority: EncounterOverrideAuthority = {
    canDmWrite,
    canPlayerWrite,
    staleIdentity,
    campaignId: cid,
    userId: me?.user.id ?? null,
  };
  // A confirmed override is scoped to ONE outage — consumed the moment the stream is live
  // again, so a later, separate outage prompts again rather than silently sailing through
  // on a stale confirmation. ALSO revoked the instant it is no longer authorized (lost the
  // write authority its scope requires, or the identity went stale) — regaining authority
  // requires a fresh confirmation rather than silently resuming the earlier one. Routed
  // through `encounterOverrideAuthorized` itself (issue #1914) rather than a hand-rolled
  // boolean here, so the revoke condition and the render-time authorization check (below)
  // can never drift — the round-4 (#1446) failure mode this guarded against was exactly two
  // different moments computing "authorized" two different ways.
  useEffect(() => {
    setEncounterSyncOverride((prev) => {
      const settled = settleEncounterOverride(prev, encounterSync);
      return revokeEncounterOverrideIfUnauthorized(settled, encounterOverrideAuthorized(settled, overrideAuthority));
    });
  }, [encounterSync, overrideAuthority.canDmWrite, overrideAuthority.canPlayerWrite, overrideAuthority.staleIdentity, overrideAuthority.campaignId, overrideAuthority.userId]);
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
  // `riskyBlocked` stays the DM-grade gate exactly as before #1914 (`encounterActionsBlocked`
  // is now itself scope-gated to `'dm'`, so an active 'own-combatant' override never
  // satisfies it) — every existing consumer (next-turn, AoE declare, escalation die, apply
  // damage bar, …) keeps its pre-#1914 behavior unchanged. `gateForWrite` (below, and at the
  // per-combatant call sites) is the only place a same-outage 'own-combatant' override can
  // additionally relax anything, and only for the combatant it names by ownership.
  const riskyBlocked = encounterActionsBlocked(encounterSync, effectiveEncounterSyncOverride);
  // Issue #1446 fix: the DM's "continue anyway" acknowledgement re-enables every
  // conflict-prone control at once; a stale-identity viewer confirming it would authorize
  // mutations against a membership snapshot that may no longer be true (final review
  // round). Neither has a path to ever set a 'dm'-scoped `encounterSyncOverride.active`
  // without `canDmWrite`; they stay blocked (with the informational banner) for the
  // duration. This DM offer is distinct from `encounterSyncOwnOverrideOfferable` below
  // (issue #1914) — a player's own-combatant confirm never grants this scope.
  const encounterSyncOverrideOfferable =
    overrideAuthority.canDmWrite
    && !overrideAuthority.staleIdentity
    && encounterOverrideOfferable(encounterSync)
    && !(effectiveEncounterSyncOverride.active && effectiveEncounterSyncOverride.scope === 'dm');
  // Issue #1914: the scoped, player-facing counterpart — offered only to a non-DM viewer
  // with current player-write authority, gated by every other precondition
  // `encounterOverrideAuthorized` will itself require once granted (fresh identity,
  // past the connecting grace, nothing already active). `myCombatants.length > 0` is
  // ANDed in at the render site below (that array isn't computed yet at this point in the
  // component) — an offer with nothing owned to unblock would be a dead prompt.
  const encounterSyncOwnOverrideOfferable =
    overrideAuthority.canPlayerWrite
    && !overrideAuthority.canDmWrite
    && !overrideAuthority.staleIdentity
    && encounterOverrideOfferable(encounterSync)
    && !effectiveEncounterSyncOverride.active;
  // Issue #1446 review fix: once the override is active, controls ARE actionable again —
  // the base banner's "combat actions are paused" copy would be actively false (and
  // contradict the enabled controls for both screen-reader and sighted users). Swap to an
  // override-aware i18n variant that keeps the stale-data warning without that claim.
  // Issue #1914: the variant is itself scope-aware — an 'own-combatant' override must not
  // claim combat at large is unblocked, only the owning player's own combatant.
  const overrideBannerKey = effectiveEncounterSyncOverride.active
    ? encounterSyncOverrideBannerKey(encounterSync, effectiveEncounterSyncOverride.scope)
    : null;
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
  // Issue #1939: also open to non-DM players — the "Full rule" link on a rules-hint
  // popover needs the same installed-pack data DM prep already fetched, and the read
  // endpoint (GET /rules/packs) is any-authenticated-user already (rules.controller.ts).
  const packsQuery = useQuery({
    queryKey: ['rules', 'packs'],
    queryFn: () => api.get<RulePack[]>(`${API}/rules/packs`),
    enabled: Number.isFinite(cid),
    staleTime: 60_000,
  });
  const campaignHasCompendium = (packsQuery.data?.length ?? 0) > 0;
  // Issue #1939: whether the campaign's resolved rule pack has searchable compendium
  // entries — gates the rules-hint popovers' "Full rule" link. Identical for DM and
  // players (hints are public rules text; criterion 4), unlike `campaignHasCompendium`
  // above which only asks "is ANY pack installed server-wide".
  const rulesHintCompendiumAvailable = useMemo(
    () =>
      rulesetCapabilitiesForSelection(ruleSystem, packsQuery.data).capabilities.find(
        (c) => c.key === 'compendium',
      )?.status === 'available',
    [ruleSystem, packsQuery.data],
  );

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
        // Campaign-owned condition definitions are part of the context snapshot,
        // not the encounter read. A REST or MCP campaign update therefore needs
        // its own thin signal so an open picker receives the new vocabulary.
        if (event.type === 'campaign.updated') {
          void refreshCampaigns();
          return;
        }
        if (event.type === 'party.rest.updated') {
          // This one event represents the whole atomic recovery batch. Linked
          // encounter rows emit their own post-commit encounter.updated frame.
          invalidateCampaignCharactersForOwnership();
          return;
        }
        // Issue #1933 review finding: this event has no encounterId (it is campaign-wide,
        // like character/membership frames above) and was falling into the encounterId
        // filter below, which drops it — so another participant's hold activate/release
        // only reached this page via useTableSafety's own 20s poll. safetyHoldActive
        // gates real writes (start/nextTurn/undoTurn/endTurn), so a stale mirror meant the
        // exact failure this feature exists to prevent: the server rejects and the UI
        // cannot say why, for up to a poll interval. Refetch the safety row immediately
        // instead — the anonymity rules stay enforced there, this frame carries only
        // `active` (see useCampaignEvents' own doc comment on 'safety.hold').
        if (event.type === 'safety.hold') {
          invalidateTableSafety(queryClient, cid);
          return;
        }
        // Sheet / membership frames have no encounterId — must not fall into the
        // encounterId filter below (that was the #421 bug: character events ignored).
        if (shouldInvalidateInlineCharacters(event)) {
          invalidateCampaignCharactersForOwnership();
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
        if (event.type !== 'encounter.updated' && event.type !== 'encounter.deleted' && event.type !== 'encounter.ping' && event.type !== 'encounter.turn_changed') return;
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
        if (event.type === 'encounter.turn_changed') {
          const currentBaseline = previousTurnBeatRef.current?.encounterId === eid
            ? previousTurnBeatRef.current
            : null;
          // A backstop poll or a later stream frame may already have established a newer
          // server-owned revision. Ignore a delayed older frame before it can regress turn
          // ownership, title state, ticker feedback, or the comparison baseline.
          if (isStaleTurnBeatFrame(currentBaseline?.turnVersion ?? null, event.turnVersion)) return;
          const previous = previousTurnBeatForFrame(
            currentBaseline,
            pendingPolledTurnBeatRef.current,
            event.turnVersion,
          );
          // The SSE frame itself is the edge. It carries only viewer-safe ids;
          // the displayed name and identity colour come from this viewer's
          // already-authorized roster, never a new server payload.
          const combatant = event.currentCombatantId == null
            ? undefined
            : encounter?.combatants.find((candidate) => candidate.id === event.currentCombatantId);
          const ownerDataReady = charactersQuery.data !== undefined
            && !charactersQuery.isFetching
            && characterOwnershipPendingDataUpdatedAtRef.current == null;
          const rosterCombatantKnown = event.currentCombatantId == null || combatant != null;
          const isYourTurn = ownerDataReady && combatant?.characterId != null
            && characters.some((character) => character.id === combatant.characterId && character.ownerUserId === String(me?.user.id ?? ''));
          // Clear the hidden-tab prefix on the frame that ends an owned turn;
          // do not wait for the follow-up /turn refetch to settle. A character
          // frame received before its owner list or encounter roster is available
          // stays unknown so it cannot pin an incorrect negative result for the
          // rest of the turn.
          const ownerKnown = rosterCombatantKnown && (ownerDataReady || combatant?.characterId == null);
          setTurnOwnerFromEvent(ownerKnown ? {
            combatantId: event.currentCombatantId ?? null,
            isYourTurn,
          } : null);
          setTurnOwnerPendingCombatantId(ownerKnown ? null : event.currentCombatantId ?? null);
          const next: TurnBeatSnapshot = {
            encounterId: eid,
            combatantId: event.currentCombatantId ?? null,
            round: event.round ?? null,
            turnVersion: event.turnVersion ?? Math.max(previous?.turnVersion ?? 0, encounter?.turnVersion ?? 0),
            isYourTurn,
          };
          const kind = detectSseTurnBeat(previous, next);
          previousTurnBeatRef.current = next;
          pendingPolledTurnBeatRef.current = null;
          // Issue #2092: disarm any pending REST catch-up resync. A read revision records
          // when a response LANDED, not when the server captured it, so a catch-up GET
          // issued before this frame can still land after it and overwrite this newer
          // baseline with pre-turn state — after which the next edge is compared against a
          // stale baseline and is misread as a round wrap or dropped as a no-op. A live turn
          // frame is by construction at least as fresh as any GET already in flight, so once
          // one arrives there is nothing left for the catch-up read to establish.
          awaitingTurnBeatResyncRef.current = null;
          const tickerKind = previous?.round != null && next.round != null && next.round > previous.round
            ? 'round-wrap'
            : 'turn';
          // A lair action has no roster combatant, but a round-wrap still has
          // useful, non-secret feedback for every viewer.
          if (kind && (combatant || event.currentCombatantId != null || tickerKind === 'round-wrap')) {
            const beatKey = ++turnBeatSequence.current;
            setTurnBeat({
              key: beatKey,
              combatantId: event.currentCombatantId ?? null,
              pending: combatant == null && event.currentCombatantId != null,
              kind,
              tickerKind,
              name: combatant?.name ?? '',
              round: next.round,
              identityBackground: combatant ? tokenIdentityBackground(combatant) : 'var(--color-neutral-900)',
            });
            if (kind === 'your-turn' && combatant) {
              triggerOwnedTurnFeedback(beatKey);
            }
          } else if (kind) {
            // A same-round lair action has no viewer-safe name to announce.
            // Still replace the previous beat so an owned takeover cannot
            // outlive the turn that just ended.
            setTurnBeat(null);
          }
          // The paired encounter.updated frame has already invalidated the
          // encounter read; only the viewer-specific workspace needs refresh.
          void queryClient.invalidateQueries({ queryKey: queryKeys.encounterTurn(eid) });
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
        if (event.sheetMirrored) invalidateCampaignCharactersForOwnership();
        // Issue #1919 — a death-save roll (like any other combatant write) emits only
        // `encounter.updated`; the persisted combat-log/dice-log event it also wrote would
        // otherwise wait for the events feed's own 5s backstop poll before another viewer's
        // spectator toast (and CombatLog highlight) could appear. Piggybacking this cheap
        // refetch on the SAME frame that already invalidates the encounter itself is enough
        // to satisfy "after the encounter.updated-driven refetch (or within one poll cycle)".
        void queryClient.invalidateQueries({ queryKey: queryKeys.encounterEvents(eid) });
      },
      [eid, cid, navigate, queryClient, addPing, encounter?.combatants, encounter?.turnVersion, characters, charactersQuery.data, charactersQuery.isFetching, me?.user.id, triggerOwnedTurnFeedback, invalidateCampaignCharactersForOwnership, refreshCampaigns],
    ),
    // The stream was down for a while — refetch encounter + character sheets.
    onReconnect: useCallback(() => {
      setResyncPending(true);
      awaitingTurnBeatResyncRef.current = encounterReadRevisionRef.current;
      invalidateEncounter(queryClient, eid);
      invalidateCampaignCharactersForOwnership();
      invalidateCampaignCheckRequests(queryClient, cid);
      // Same staleness the character.updated SSE branch above fixes (issue #1900
      // review): a dropped-then-recovered stream must not leave the Spellbook's
      // /turn-sourced slots/spells stale either.
      void queryClient.invalidateQueries({ queryKey: queryKeys.encounterTurn(eid) });
      // Issue #1933 review: handling the delivered `safety.hold` frame is not enough on
      // its own — a hold activated or released WHILE the stream was down produces no
      // frame to deliver on reconnect. safetyHoldActive now gates Start/Next/Undo/End
      // turn, so without this the controls stay wrongly enabled (or wrongly gated) until
      // useTableSafety's 20s poll happens to land.
      invalidateTableSafety(queryClient, cid);
      void refreshCampaigns();
      // Issue #2092: a dropped connection may have swallowed an `encounter.turn_changed`
      // frame outright — re-arm the REST turn-beat baseline resync (see
      // `awaitingTurnBeatResyncRef`'s own comment) so the catch-up encounter read above
      // re-derives it.
    }, [queryClient, eid, cid, invalidateCampaignCharactersForOwnership, refreshCampaigns]),
    // Parser recovery (connection stayed up) — same catch-up refetch.
    onStreamRecovery: useCallback(() => {
      setResyncPending(true);
      awaitingTurnBeatResyncRef.current = encounterReadRevisionRef.current;
      invalidateEncounter(queryClient, eid);
      invalidateCampaignCharactersForOwnership();
      invalidateCampaignCheckRequests(queryClient, cid);
      void queryClient.invalidateQueries({ queryKey: queryKeys.encounterTurn(eid) });
      invalidateTableSafety(queryClient, cid);
      void refreshCampaigns();
    }, [queryClient, eid, cid, invalidateCampaignCharactersForOwnership, refreshCampaigns]),
    onStatusChange: useCallback((status: CampaignEventsStatus) => setEventStatus(status), []),
  });

  // Issue #1919 — the roller's own settled death-save outcome (nat 20 revive / fresh
  // death / fresh stabilization / plain success-or-failure), fed to the ONE combatant's
  // tracker whose roll it belongs to. `deathSaveBeforeStateRef` captures the pre-roll
  // deathState at the roll mutation's `onMutate` time (the classifier needs a before/after
  // pair; the server response only carries "after"). `recentDeathSaveSelfRollRef` marks
  // this client as the one that just rolled for a combatant, briefly, so the spectator-
  // toast diff below (which reads the same persisted event this roll produces) does not
  // also toast the roller their own roll a second time.
  const deathSaveBeforeStateRef = useRef(new Map<number, string>());
  const recentDeathSaveSelfRollRef = useRef(new Map<number, number>());
  const [deathSaveOutcome, setDeathSaveOutcome] = useState<{ combatantId: number; outcome: DeathSaveOutcome } | null>(null);
  const deathSaveOutcomeTimerRef = useRef<number | null>(null);
  const DEATH_SAVE_SELF_ROLL_WINDOW_MS = 8_000;

  // The persisted event stream is the single announcement source for turn, HP,
  // condition, death, note, override, and correction updates. ID-based tracking
  // suppresses duplicate SSE/mutation/poll refetches; initial history is a silent
  // baseline, while reconnect bursts are announced together so no entry is lost.
  const combatLogAnnouncementRef = useRef<{
    encounterId: number;
    cursor: CombatLogAnnouncementCursor;
  } | null>(null);
  // Issue #1919 — "table side": a compact toast for anyone OTHER than the roller when a
  // death-save roll appears in the same already role-projected event feed CombatLog reads
  // (never a new SSE type or a raw dice-log read — see `deathSaveOutcome.ts`'s doc comment).
  // `recentDeathSaveSelfRollRef` (set at the roll mutation's `onMutate`) suppresses the
  // roller's OWN roll here, since that client already got the full dice-overlay treatment.
  const deathSaveSpectatorToastSequence = useRef(0);
  const [deathSaveSpectatorToast, setDeathSaveSpectatorToast] = useState<{ id: number; message: string } | null>(null);
  const deathSaveSpectatorToastTimerRef = useRef<number | null>(null);
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

    // A null cursor is the initial-history baseline (same rule as the SR announcement
    // above) — a page freshly opened mid-encounter must not toast every past roll.
    if (!cursor) return;
    const now = Date.now();
    for (const event of advanced.appendedEvents) {
      // Issue #1919 secrecy boundary: `deathSaveSpectatorToastInfo` reads ONLY the
      // already role-projected `event.target`/`detail` — the same fields CombatLog
      // renders for every viewer via the server's `redactEncounterEventsForViewer`
      // (issue #869). A hidden combatant's name arrives already masked to the
      // "Unknown combatant" placeholder (never null); this never does its own lookup
      // that could bypass that redaction. See `deathSaveOutcome.unit.spec.ts` for the
      // pinned regression.
      const info = deathSaveSpectatorToastInfo(event);
      if (!info) continue;
      const selfRolledAt = event.targetId != null ? recentDeathSaveSelfRollRef.current.get(event.targetId) : undefined;
      if (selfRolledAt != null) {
        if (event.targetId != null) recentDeathSaveSelfRollRef.current.delete(event.targetId);
        if (now - selfRolledAt < DEATH_SAVE_SELF_ROLL_WINDOW_MS) continue;
      }
      const outcomeWord = info.outcomeKind === 'success'
        ? t('encounters.deathSave.spectatorOutcomeSuccess', 'success')
        : t('encounters.deathSave.spectatorOutcomeFailure', 'failure');
      const toastMessage = t(
        'encounters.deathSave.spectatorToast',
        '{{name}} death save: {{outcome}} (rolled {{natural}})',
        { name: info.name, outcome: outcomeWord, natural: info.natural },
      );
      if (deathSaveSpectatorToastTimerRef.current != null) window.clearTimeout(deathSaveSpectatorToastTimerRef.current);
      const toastId = ++deathSaveSpectatorToastSequence.current;
      setDeathSaveSpectatorToast({ id: toastId, message: toastMessage });
      deathSaveSpectatorToastTimerRef.current = window.setTimeout(() => {
        setDeathSaveSpectatorToast((current) => (current?.id === toastId ? null : current));
      }, 4_000);
    }
  }, [eid, eventsQuery.data, announce, t]);

  const revealedEncounterIdsRef = useRef<Set<number>>(new Set());
  const pendingRollInitiativeCountRef = useRef<number>(0);
  const [revealTick, setRevealTick] = useState(0);

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

    if (previous?.encounterId === eid && previous.status !== 'preparing' && encounter.status === 'preparing') {
      revealedEncounterIdsRef.current.delete(eid);
    }

    const prevStatus = previous?.encounterId === eid ? previous.status : null;
    const rolledCount = pendingRollInitiativeCountRef.current;
    if (
      shouldRevealInitiative({
        prevStatus,
        nextStatus: encounter.status,
        encounterId: eid,
        revealedEncounterIds: revealedEncounterIdsRef.current,
        rolledCount,
      })
    ) {
      if (encounter.status === 'running') {
        revealedEncounterIdsRef.current.add(eid);
      }
      setRevealTick((t) => t + 1);
    }
    pendingRollInitiativeCountRef.current = 0;

    previousEncounterStatusRef.current = { encounterId: eid, status: encounter.status };
  }, [eid, encounter, announce]);

  const myUserId = me?.user.id;
  const membersQuery = useQuery({
    queryKey: queryKeys.campaignMembers(cid),
    queryFn: () => api.get<CampaignMember[]>(`${API}/campaigns/${cid}/members`),
    enabled: Number.isFinite(cid),
  });
  const aoeDeclarerNames = useMemo(
    () => new Map((membersQuery.data ?? []).map((member) => [String(member.userId), member.displayName || member.username || String(member.userId)])),
    [membersQuery.data],
  );
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

  // Issue #1917: `useCallback`, not a plain function declaration — `canEditCombatant` is
  // passed BY REFERENCE as `BattleMap`'s `canMoveToken` prop (below), and `BattleMap` is now
  // React.memo-wrapped. A fresh function identity here every render would defeat that.
  const canEditCombatantPermission = useCallback(
    (c: Combatant): boolean => {
      // An ended encounter is immutable server-side (assertMutable, #163/#470): the interactive
      // card + ApplyDamageBar would only fire a PATCH the server always rejects. Gate on
      // status like canSetInitiative so an ended encounter renders read-only (#368).
      if (encounter?.status === 'ended') return false;
      if (canDmWrite) return true;
      if (!canPlayerWrite) return false;
      if (c.characterId != null && ownedCharacterIds.has(c.characterId)) return true;
      if (c.controllerUserId != null && myUserId != null && String(c.controllerUserId) === String(myUserId)) return true;
      return false;
    },
    [encounter?.status, canDmWrite, canPlayerWrite, ownedCharacterIds, myUserId],
  );

  const canEditCombatant = useCallback(
    (c: Combatant): boolean => {
      if (riskyBlocked) return false;
      return canEditCombatantPermission(c);
    },
    [riskyBlocked, canEditCombatantPermission],
  );

  /** Issue #1914: the combatant the ACTING viewer owns (a player's own character link). */
  function isOwnCombatant(c: Combatant): boolean {
    return c.characterId != null && ownedCharacterIds.has(c.characterId);
  }

  /**
   * Issue #1914: the row-level sync gate for a combatant's OWN-COMBATANT writes (HP/temp
   * HP, death saves, conditions, turn-state) — every DM-only control on the row (identity
   * edit, remove, initiative, duplicate) is mounted only for `canDmWrite` regardless of this
   * value, so relaxing it for an owned row never exposes a DM-only control to a player; it
   * only ever relaxes writes that were already permission-gated to this row's owner.
   */
  function combatantWriteBlocked(c: Combatant): boolean {
    return gateForWrite('own-combatant', { isOwnCombatant: isOwnCombatant(c) }, encounterSync, effectiveEncounterSyncOverride);
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
      const id = ++pendingActionUseSequence.current;
      pendingActionUseIdRef.current = id;
      setPendingApply(null);
      setActionTargetIds([]);
      setActionTargetsDeclared(false);
      setPendingGroupActionUse(null);
      setPendingActionUse({ id, combatantId, actorName, actionIndex, actionName, spec });
    },
    [],
  );

  // Issue #1922: same trigger shape as `onUseActionRequested` above, plus the fetched
  // `UsableAction` row so the group runner can derive its (name, toHit, damage) fingerprint.
  const onUseGroupActionRequested = useCallback(
    (combatantId: number, actorName: string, actionIndex: number, actionName: string, spec: ActionSpec, action: UsableAction) => {
      const id = ++pendingGroupActionUseSequence.current;
      pendingActionUseIdRef.current = null;
      setPendingApply(null);
      setPendingActionUse(null);
      setPendingGroupActionUse({
        id,
        combatantId,
        actorName,
        actionIndex,
        actionName,
        spec,
        sourceAction: { name: action.name, toHit: action.toHit, damage: action.damage },
      });
    },
    [],
  );

  const toggleActionTarget = useCallback((id: number) => {
    setActionTargetIds((previous) => {
      if (!pendingActionUse || actionTargetsDeclared) return previous;
      if (previous.includes(id)) return previous.filter((targetId) => targetId !== id);
      const max = pendingActionUse.spec.targets.count > 0 ? pendingActionUse.spec.targets.count : 50;
      return previous.length >= max ? previous : [...previous, id];
    });
  }, [pendingActionUse, actionTargetsDeclared]);
  const actionLegalTargetIds = useMemo(() => pendingActionUse && pendingActionUse.spec.targets.count > 0
    ? legalTargets(encounter?.combatants ?? [], pendingActionUse.combatantId, pendingActionUse.spec.targets.allow).map((combatant) => combatant.id)
    : [], [encounter?.combatants, pendingActionUse]);
  const actionTargetsAtCapacity = !!pendingActionUse
    && pendingActionUse.spec.targets.count > 0
    && actionTargetIds.length >= pendingActionUse.spec.targets.count;

  // Issue #1917: hoisted out of BattleMap's `targeting` JSX prop, which built a fresh object
  // literal on every render regardless of whether any of its fields actually changed.
  const battleMapTargeting = useMemo(
    () =>
      pendingActionUse && pendingActionUse.spec.targets.count > 0
        ? {
            actorId: pendingActionUse.combatantId,
            legalIds: actionLegalTargetIds,
            selectedIds: actionTargetIds,
            declared: actionTargetsDeclared,
            atCapacity: actionTargetsAtCapacity,
            onToggle: toggleActionTarget,
          }
        : null,
    [pendingActionUse, actionLegalTargetIds, actionTargetIds, actionTargetsDeclared, actionTargetsAtCapacity, toggleActionTarget],
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
    onSuccess: (data, variables) => {
      if (variables.action === 'roll-initiative') {
        const rolledCount = (data as { rolledCount?: number })?.rolledCount ?? 0;
        if (rolledCount > 0) {
          pendingRollInitiativeCountRef.current = rolledCount;
        }
      }
    },
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
    // Issue #1992 (round 7): the URL is built from `encounterId` — a per-call variable
    // supplied by the caller — never from the outer `eid` closure. See
    // `combatantPatchUrl`'s own doc comment for why that distinction is the entire fix.
    mutationFn: ({ combatantId, encounterId, patch }: { combatantId: number; encounterId: number; patch: Record<string, unknown> }) =>
      api.patch<Combatant>(combatantPatchUrl(API, encounterId, combatantId), patch),
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

  const duplicateCombatant = useMutation({
    mutationFn: ({ body }: { combatantId: number; body: Record<string, unknown> }) =>
      api.post<Combatant>(`${API}/encounters/${eid}/combatants`, body),
    onMutate: () => setActionError(null),
    onError: (err) => {
      if (isAmbiguousOutcome(err)) enterReconciling();
      else reportError(err);
    },
    onSettled: (_data, _err, { combatantId }) => {
      pendingDuplicateCombatantIds.current.delete(combatantId);
      markCombatantPending(combatantId, false);
      invalidateEncounter(queryClient, eid);
    },
  });

  const requestDuplicateCombatant = useCallback(
    (combatant: Combatant, rosterNames: readonly string[]) => {
      if (riskyBlocked || reconcileBlocks || pendingDuplicateCombatantIds.current.has(combatant.id)) return;
      pendingDuplicateCombatantIds.current.add(combatant.id);
      markCombatantPending(combatant.id, true);
      duplicateCombatant.mutate({
        combatantId: combatant.id,
        body: {
          kind: combatant.kind,
          duplicateOfCombatantId: combatant.id,
          name: duplicateCombatantName(combatant.name, rosterNames),
          ruleEntryId: combatant.ruleEntryId ?? undefined,
          statblock: combatant.statblock ?? undefined,
          hpMax: typeof combatant.hpMax === 'number' && combatant.hpMax > 0 ? combatant.hpMax : undefined,
          initMod: combatant.initMod,
          initiativeGroup: combatant.initiativeGroup ?? undefined,
          tokenSize: combatant.tokenSize,
        },
      });
    },
    [duplicateCombatant, markCombatantPending, reconcileBlocks, riskyBlocked],
  );

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

  /**
   * Issue #2116 — see `isAwaitingReorderResync`'s doc comment in `combatantReorder.ts` for
   * the full defect this gate closes, and why it is not gated on `encounterQuery.isFetching`
   * (true for any refetch, so it would silently swallow a completed drag).
   *
   * `reorderResyncArmedAt` is REACT STATE, not a ref (review round 2), so `isAwaitingReorderResyncNow`
   * below is reactive: `buildReorderControls`'s `busy` and `InitiativeStrip`'s `canReorder`
   * get a fresh value every render instead of silently swallowing an action on a control that
   * still LOOKED enabled.
   *
   * The clearing effect's dependency is `encounterDataUpdateCount` (defined below) — NOT
   * `encounterReadRevision` (round 5), NOT `encounter` itself (round 6), and NOT
   * `encounterQuery.dataUpdatedAt` (round 7, reopened as issue #2140). All three were tried and
   * all three failed:
   *
   * - Round 5's failure: `encounterReadRevisionRef`/`encounterReadRevision` are bumped by OUR
   *   OWN code, synchronously inside `queryFn`, BEFORE that function returns — strictly before
   *   TanStack's separate cache-update-and-notify step publishes the `encounter` a component
   *   renders. A render could see the bumped revision but the still-stale `encounter`.
   * - Round 6's failure: gating on `encounter`'s object REFERENCE changing gets stuck armed
   *   forever when a reorder fails without changing server state (the concrete case: the server
   *   rejects a move of the current combatant) — the follow-up GET returns a payload identical to
   *   what's cached, and `@tanstack/query-core`'s `replaceEqualDeep` (verified against its actual
   *   source: on a full deep-equal match it returns the OLD reference `a`, not the new one)
   *   preserves the OLD `encounter` reference, so an effect keyed on `encounter` never re-fires.
   * - Round 7's failure (issue #2140): `dataUpdatedAt` looked like it dodged both of the above —
   *   it advances on every completed fetch, independent of reference identity. But
   *   `@tanstack/query-core`'s `successState()` (verified against `query.js`) computes it as
   *   `dataUpdatedAt ?? Date.now()` — millisecond-resolution wall-clock time with NO uniqueness
   *   guarantee. Two accepted results landing in the same millisecond (this reorder's own
   *   `onSettled` invalidate-refetch racing an unrelated `encounter.updated` SSE refetch, for
   *   example) stamp an IDENTICAL value. React compares effect dependencies with `Object.is`; an
   *   unchanged dependency does not re-run the effect, so the gate stayed armed until some later,
   *   UNRELATED cache write happened to land in a different millisecond. Browsers that coarsen
   *   clock precision (Spectre mitigations) widen that collision window well past 1ms.
   *
   * (`replaceEqualDeep` also rules out comparing `encounter`'s reference against
   * `latestEncounterReadRef.current.encounter`, the raw pre-structural-sharing value `queryFn`
   * captured: on a genuine content change it returns neither the old reference nor that literal
   * new value, but a freshly reconstructed wrapper object, so that comparison would almost never
   * match even right after an authentic update.)
   *
   * `encounterDataUpdateCount` reads `queryClient.getQueryState(queryKeys.encounter(eid))
   * ?.dataUpdateCount` — `@tanstack/query-core`'s own per-query counter. Verified against
   * `query.js`'s `#dispatch` reducer: `dataUpdateCount: state.dataUpdateCount + 1` is applied
   * UNCONDITIONALLY inside the same `"success"` branch that publishes `data`/`dataUpdatedAt`, for
   * BOTH a real completed fetch (`Query#fetch`'s own `this.setData(data)`) and a local optimistic
   * `queryClient.setQueryData` write (`manual: true`, which skips only the `fetchStatus: "idle"`
   * reset a few lines down — the `dataUpdateCount` bump itself is not conditioned on `manual`).
   * Two properties follow directly from that reducer shape, and together they are exactly what
   * round 7 was missing:
   *
   * - It CANNOT collide: it is a plain integer incremented by exactly 1 on every accepted result,
   *   never re-derived from a clock. Two accepted results in the same millisecond still produce
   *   two DIFFERENT counter values, so `Object.is` always sees a change and the effect always
   *   re-runs — round 7's failure is structurally impossible here, not just less likely.
   * - It IS published atomically with `data`: `dataUpdateCount` and `data`/`dataUpdatedAt` are set
   *   by the SAME object spread inside the SAME reducer action, so they live on the identical
   *   `query.state` snapshot. `queryClient.getQueryState(...)` (below) reads that exact `state`
   *   object `useQuery`'s own observer builds `encounterQuery` from, so there is no path where one
   *   updates in an earlier render than the other — round 5's lead-the-render hazard cannot recur.
   *
   * `dataUpdateCount` is deliberately NOT read off `encounterQuery` itself: verified against
   * `queryObserver.js`'s `createResult`, it is used internally to derive `isFetchedAfterMount`
   * but is never copied into the `QueryObserverResult` `useQuery` returns. `queryClient.
   * getQueryState` is the only way to reach it, so that read happens once per render, right below,
   * and is passed into this effect's dependency array as a plain number.
   *
   * Like `dataUpdatedAt` before it, `encounterDataUpdateCount` ALSO advances on a local optimistic
   * write (see above) — so on its own it still does not distinguish a real GET from an optimistic
   * one. It doesn't need to: exactly as established at round 3, it is consulted here purely as a
   * "something in the query settled — go re-examine" WAKE-UP, never as the gating comparison
   * itself. The actual decision is still `encounterReadRevisionRef.current` (bumped ONLY by a
   * real, non-aborted GET inside `queryFn`, never by `setQueryData`) versus `reorderResyncArmedAt`,
   * unchanged since round 5. An optimistic write firing this effect still finds
   * `encounterReadRevisionRef` unchanged and leaves the gate armed — it just wakes the check, it
   * does not answer it.
   */
  const encounterDataUpdateCount = queryClient.getQueryState<EncounterWithCombatants>(queryKeys.encounter(eid))?.dataUpdateCount ?? 0;
  const [reorderResyncArmedAt, setReorderResyncArmedAt] = useState<number | null>(null);
  const isAwaitingReorderResyncNow = reorderResyncArmedAt !== null;
  useEffect(() => {
    if (reorderResyncArmedAt !== null && !isAwaitingReorderResync(reorderResyncArmedAt, encounterReadRevisionRef.current)) {
      setReorderResyncArmedAt(null);
    }
    // See the doc comment above for why `encounterDataUpdateCount` — not `encounterReadRevision`,
    // not `encounter`, and not `encounterQuery.dataUpdatedAt` — is the correct dependency here.
  }, [encounterDataUpdateCount, reorderResyncArmedAt]);

  /**
   * Manual initiative reorder (issue #1923) — drag (InitiativeStrip + roster) and the
   * accessible fallback menu both funnel through this one mutation. `expectedTurnVersion`
   * is passed explicitly at call time (not resolved from an outer closure) so a caller
   * that queued the request before a turn advance lands still sends the value IT last
   * rendered — the server's own CAS is what turns that into a 409, not a client guess.
   * A 409 (or any other failure) still refetches via `onSettled` below, so the roster
   * always re-renders server-authoritative order — the "refetch" half of "409 → refetch +
   * toast"; `reportError` below is the toast half.
   *
   * `encounterId` is threaded through the mutation variables for the same reason as
   * `expectedTurnVersion`, but the hazard it closes is sharper (issue #2116 review round 7):
   * this page is REUSED across encounters — the route has no `key={encounterId}`, so
   * navigating from encounter A to encounter B re-renders this same component instance
   * instead of remounting it. `useMutation`'s effect calls `observer.setOptions(options)` on
   * every render (`@tanstack/react-query`'s `useMutation.js`), and
   * `MutationObserver.setOptions` splices those newest options straight into the in-flight
   * `Mutation` instance whenever `state.status === 'pending'` (`@tanstack/query-core`'s
   * `mutationObserver.js`) — so `onSettled` below, if it closed over `eid`, would run with
   * whichever encounter happens to be on screen when the request FINISHES, not the one the
   * write actually belongs to. Reading `encounterId` from `variables` instead is safe: variables
   * are fixed as the argument to the mutation's one `execute()` call and are never subject to
   * that options swap (see `handleReorderDrop`'s call site, which passes the `eid` that was
   * active at the moment of the drag).
   */
  const reorderCombatant = useMutation({
    mutationFn: ({ combatantId, afterCombatantId, expectedTurnVersion, encounterId }: { combatantId: number; afterCombatantId: number | 'top'; expectedTurnVersion: number; encounterId: number }) =>
      api.post<Combatant>(`${API}/encounters/${encounterId}/combatants/${combatantId}/reorder`, { afterCombatantId, expectedTurnVersion }),
    onMutate: ({ combatantId }) => {
      setActionError(null);
      markCombatantPending(combatantId, true);
    },
    onSuccess: (updated) => {
      announce(t('encounters.reorder.announcement', 'Moved {{name}} in the initiative order.', { name: updated.name }));
    },
    onError: reportError,
    onSettled: (_data, _err, { combatantId, encounterId }) => {
      markCombatantPending(combatantId, false);
      // Only re-arm the resync latch when the write's encounter is STILL the one on screen —
      // see `shouldArmReorderResyncLatch`'s own doc comment (and this mutation's, above) for
      // why arming it for a write that belongs to an encounter the DM has since navigated away
      // from would spuriously disable the CURRENTLY DISPLAYED encounter's reorder affordances
      // for a drag it never made.
      if (shouldArmReorderResyncLatch(encounterId, activeEncounterIdRef.current)) {
        setReorderResyncArmedAt(encounterReadRevisionRef.current);
      }
      // Invalidate the encounter the write actually belongs to, not whatever `eid` this
      // callback's closure happens to carry — see the doc comment above. Invalidating a
      // currently-inactive query key just marks it stale for its next mount; it does not
      // force a refetch of an encounter the DM is no longer looking at.
      invalidateEncounter(queryClient, encounterId);
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
      invalidateCampaignCharactersForOwnership();
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
    }) => {
      // Block body deliberately: a concise arrow returning api.post with an explicit
      // generic type argument false-positives the i18n JSX-text-node scanner
      // (scripts/check-i18n-catalog.mjs's extractJsxTextNodes) — its naive regex treats
      // the arrow's closing angle bracket and the generic's opening one as a JSX text-node
      // pair and captures "api.post" in between as if it were hardcoded UI text. See the
      // filed scanner-defect issue for the reproduction; this shape avoids the false match
      // without touching the i18n-jsx-baseline.json ratchet.
      return api.post<EncounterWithCombatants>(`${API}/encounters/${eid}/next-turn`, { expectedCurrentCombatantId, idempotencyKey });
    },
    onMutate: () => {
      turnAdvancePendingRef.current = true;
      setActionError(null);
    },
    // Issue #2092: `headerBusy` (gating the Next Turn button) tracks only
    // `nextTurnMut.isPending`, which clears the instant this POST resolves — well
    // before `onSettled`'s invalidate-triggered GET has round-tripped. A DM who
    // clicks Next Turn again inside that window (a real 580ms-apart double-click,
    // or this issue's own two-context e2e spec) built its `expectedCurrentCombatantId`
    // from the STILL-STALE cached `encounter.currentCombatantId`, so the server's own
    // CAS guard rejected the DM's own very next legitimate click with 409
    // TURN_ALREADY_ADVANCED — the turn never actually advanced a second time, so no
    // `encounter.turn_changed` frame was ever emitted for it (the failure then SHOWS UP
    // as "the other client's takeover/ticker never updated", but that client had nothing
    // to receive). The response body IS the advanced encounter (same shape as GET) —
    // seed the cache with it immediately, through the same optimistic-patch
    // reconciliation the regular GET applies, so the next click already sees the turn
    // that just committed.
    onSuccess: (data) => {
      queryClient.setQueryData<EncounterWithCombatants>(
        queryKeys.encounter(eid),
        (current: EncounterWithCombatants | undefined) => preferNewerEncounterSnapshot(
          current,
          reconcileEncounterPatchResponse(data, pendingEncounterPatches.current.values(), '', eid),
        ),
      );
    },
    onError: (err) => {
      if (isAmbiguousOutcome(err)) enterReconciling();
      else reportTurnAdvanceError(err);
    },
    onSettled: () => {
      turnAdvancePendingRef.current = false;
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
  const hpMutationCount = useIsMutating({ mutationKey: HP_MUTATION_KEY });
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
  const replayPendingOptimisticHpDeltas = useCallback((rolledBackId?: number) => {
    const queue = optimisticHpQueueRef.current;
    if (queue.encounterId !== eid) return;
    const { base } = queue;
    if (!base) return;
    // `rolledBackId`, when given, is a combatant whose OWN operation was just
    // deleted from `queue.operations` (a failure) — it must still be merged so
    // its stale optimistic HP is rolled back, even though it is no longer a
    // live target. `replayOptimisticHpDeltas` above already recomputes it as a
    // pass-through of `base`'s untouched entry (no operation targets it after
    // the delete), which is the same value `ctx.previousCombatant` captured at
    // that operation's own onMutate — the authoritative pre-operation state,
    // not a re-derivation from a separately stale source.
    const targetIds = new Set([...queue.operations.values()].map(({ combatantId }) => combatantId));
    if (rolledBackId !== undefined) targetIds.add(rolledBackId);
    const recomputed = replayOptimisticHpDeltas(
      base.combatants,
      [...queue.operations.values()]
        .sort((a, b) => a.sequence - b.sequence)
        .map(({ combatantId, delta }) => ({ combatantId, delta })),
      ruleSystem,
      campaign?.customMechanicsProfile,
    );
    // Merge only the HP-owned fields for the targeted combatants onto the
    // freshest cached encounter. `base` can be older than a snapshot another
    // writer (next-turn seeding, an encounter PATCH response) has since
    // installed — not just at the encounter level (`turnVersion`,
    // `currentCombatantId`), but per combatant too (`turnState`, conditions,
    // ...). This replay has no business reverting either; only `hpCurrent`
    // and its siblings are its business.
    queryClient.setQueryData<EncounterWithCombatants>(queryKeys.encounter(eid), (current) =>
      current ? mergeOptimisticHpTargets(current, recomputed, targetIds) : current,
    );
  }, [eid, queryClient, ruleSystem, campaign?.customMechanicsProfile]);
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
      const queuedBase = optimisticHpQueueRef.current;
      const previousCombatant = queuedBase.encounterId === eid && queuedBase.base
        ? queuedBase.base.combatants.find((combatant) => combatant.id === combatantId)
        : previous?.combatants.find((combatant) => combatant.id === combatantId);
      // Defence data lives in the server's authoritative statblock.  Do not briefly
      // show an incorrect local HP total when damage rules are active; refetch settles it.
      if (
        previous &&
        optimisticOperation
      ) {
        if (queue.encounterId !== eid) return {};
        if (!queue.base) queue.base = previous;
        queue.operations.set(idempotencyKey, optimisticOperation);
        const optimisticCombatants = replayOptimisticHpDeltas(
          queue.base.combatants,
          [...queue.operations.values()]
            .sort((a, b) => a.sequence - b.sequence)
            .map(({ combatantId: pendingCombatantId, delta: pendingDelta }) => ({ combatantId: pendingCombatantId, delta: pendingDelta })),
          ruleSystem,
          campaign?.customMechanicsProfile,
        );
        const optimisticCombatant = optimisticCombatants.find((combatant) => combatant.id === combatantId);
        const feedbackBefore = hpFeedbackSnapshotRef.current?.encounterId === eid
          ? hpFeedbackSnapshotRef.current.combatants.get(combatantId)
          : previousCombatant;
        if (feedbackBefore && optimisticCombatant) {
          appendHpFeedbackEvents(diffHpFeedback(hpFeedbackSnapshot([feedbackBefore]), [optimisticCombatant]));
          const snapshot = hpFeedbackSnapshotRef.current;
          if (snapshot?.encounterId === eid) snapshot.combatants.set(combatantId, optimisticCombatant);
        }
        replayPendingOptimisticHpDeltas();
        return { encounterId: eid, optimisticOperationId: idempotencyKey, previousCombatant };
      }
      return { previousCombatant };
    },
    onSuccess: (combatant, vars, ctx) => {
      if (!vars.isCrit) return;
      if (!ctx?.previousCombatant) return;
      const before = ctx.previousCombatant;
      const observed = hpFeedbackSnapshotRef.current?.encounterId === eid
        ? hpFeedbackSnapshotRef.current.combatants.get(combatant.id)
        : undefined;
      const events = diffHpFeedback(hpFeedbackSnapshot([before]), [combatant], new Set([vars.combatantId]));
      // An own SSE/poll update can arrive before this mutation callback. In that case
      // normal feedback already rendered from the canonical diff; upgrade that exact
      // event instead of leaking a combatant-wide crit marker to another writer.
      if (observed && sameHpFeedbackSnapshot(observed, combatant)) {
        appendOrUpgradeHpFeedbackCrit(events);
        return;
      }
      if (observed && !sameHpFeedbackSnapshot(observed, before)) return;
      appendHpFeedbackEvents(events);
      if (observed) hpFeedbackSnapshotRef.current?.combatants.set(combatant.id, combatant);
    },
    onError: (err, vars, ctx) => {
      const queue = optimisticHpQueueRef.current;
      if (
        ctx?.encounterId === eid &&
        queue.encounterId === eid &&
        ctx.optimisticOperationId &&
        queue.operations.delete(ctx.optimisticOperationId)
      ) {
        // Pass the failed combatant's own id explicitly: it was just removed
        // from `queue.operations`, so it is no longer a live target, but its
        // now-invalid optimistic HP is still sitting in the cache and must be
        // merged back to its pre-operation value — not silently left stale.
        replayPendingOptimisticHpDeltas(vars.combatantId);
        seedHpFeedbackSnapshot(queryClient.getQueryData<EncounterWithCombatants>(queryKeys.encounter(eid)));
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
      // The ref changes synchronously before the first await, so a second Apply-to-all
      // cannot overlap this batch and clear the shared turn/HP gate prematurely.
      if (turnAdvancePendingRef.current || bulkHpApplyPendingRef.current) return;
      bulkHpApplyPendingRef.current = true;
      setBulkHpApplyPending(true);
      const targets = new Set(applications.map(({ combatantId }) => combatantId));
      const bulkOperationId = newOperationId();
      let previous: EncounterWithCombatants | undefined;
      try {
        setActionError(null);
        await queryClient.cancelQueries({ queryKey: queryKeys.encounter(eid) });
        previous = queryClient.getQueryData<EncounterWithCombatants>(queryKeys.encounter(eid));
        const hasDamageMetadata = applications.some(({ damage }) =>
          damage.damageType !== undefined ||
          damage.saveOutcome !== undefined ||
          damage.isCrit !== undefined ||
          damage.damageDice !== undefined
        );
        if (previous && !hasDamageMetadata) {
          const queue = optimisticHpQueueRef.current;
          const queuedCombatants = queue.encounterId === eid && queue.base && queue.operations.size > 0
            ? replayOptimisticHpDeltas(
                queue.base.combatants,
                [...queue.operations.values()].sort((a, b) => a.sequence - b.sequence).map(({ combatantId, delta: pendingDelta }) => ({ combatantId, delta: pendingDelta })),
                ruleSystem,
                campaign?.customMechanicsProfile,
              )
            : null;
          const queuedTargetIds = new Set([...queue.operations.values()].map(({ combatantId }) => combatantId));
          const pendingBaseline = queuedCombatants
            ? previous.combatants.map((combatant) => queuedTargetIds.has(combatant.id)
                ? queuedCombatants.find((queued) => queued.id === combatant.id) ?? combatant
                : combatant)
            : previous.combatants;
          const feedbackBaseline = hpFeedbackSnapshotRef.current?.encounterId === eid
            ? [...hpFeedbackSnapshotRef.current.combatants.values()]
            : pendingBaseline;
          const optimisticCombatants = pendingBaseline.map((c) =>
            targets.has(c.id) ? applyOptimisticHpDelta(c, delta, ruleSystem, campaign?.customMechanicsProfile) : c,
          );
          appendHpFeedbackEvents(diffHpFeedback(hpFeedbackSnapshot(feedbackBaseline), optimisticCombatants));
          const snapshot = hpFeedbackSnapshotRef.current;
          if (snapshot?.encounterId === eid) {
            for (const combatant of optimisticCombatants) {
              if (targets.has(combatant.id)) snapshot.combatants.set(combatant.id, combatant);
            }
          }
          // Merge only the HP-owned fields — for exactly the combatants this
          // write actually touched (this bulk apply's own targets, plus any
          // still-queued single-stepper targets folded into `pendingBaseline`
          // above) — onto the freshest cached encounter. `optimisticCombatants`
          // was built off the captured `previous`, so its non-HP fields (and
          // any OTHER combatant's fields) are stale; `current` wins for those.
          // See `mergeOptimisticHpTargets`. Apply-to-all is an HP mechanism and
          // has no business reverting turn fields, encounter-level or per-combatant.
          queryClient.setQueryData<EncounterWithCombatants>(queryKeys.encounter(eid), (current) =>
            current ? mergeOptimisticHpTargets(current, optimisticCombatants, new Set([...targets, ...queuedTargetIds])) : current,
          );
        }
        const feedbackOperation = { targets, stale: new Map<number, HpFeedbackSnapshot>(), emitted: new Set<number>() };
        bulkHpFeedbackOperationsRef.current.set(bulkOperationId, feedbackOperation);
        // Issue #580: one id for this apply-to-all, extended per target so each PATCH gets a
        // distinct key (the server fingerprints the payload, so one key cannot cover two
        // different combatants). This loop is a plain async function, not a TanStack
        // mutation, so it is not auto-retried and the retry hazard the keys guard does not
        // arise here — their value is that every resulting combat-log line carries the
        // operation id, so an AoE burst is identifiable as one action in the audit trail.
        // A DM manually re-running a half-failed apply-to-all still double-applies to the
        // targets that succeeded; making that safe needs a stable id on the pending-apply
        // itself and is deliberately left out of this change.
        const results = await Promise.all(applications.map(async ({ combatantId, damage }) => {
          const combatant = await api.patch<Combatant>(
            `${API}/encounters/${eid}/combatants/${combatantId}`,
            hpPatchWithActor(
              { hpDelta: delta, ...damage, idempotencyKey: `${bulkOperationId}:${combatantId}` },
              actorId,
              combatantId,
              isDm,
            ),
          );
          return { combatantId, damage, combatant };
        }));
        if (previous && hasDamageMetadata) {
          const snapshot = hpFeedbackSnapshotRef.current;
          if (snapshot?.encounterId === eid) {
            for (const { combatant, combatantId, damage } of results) {
              const before = previous.combatants.find((candidate) => candidate.id === combatant.id);
              const observed = snapshot.combatants.get(combatant.id);
              const staleObserved = feedbackOperation.stale.get(combatant.id);
              if (feedbackOperation.emitted.has(combatant.id)) continue;
              if (staleObserved && !sameHpFeedbackSnapshot(staleObserved, combatant)) continue;
              // A refetch may have already observed a different change to this target.
              // Do not fold that remote update into this local result (or label it crit).
              if (
                !before
                || !observed
                || (!sameHpFeedbackSnapshot(observed, before) && !sameHpFeedbackSnapshot(observed, combatant))
              ) continue;
              appendHpFeedbackEvents(diffHpFeedback(
                hpFeedbackSnapshot([before]),
                [combatant],
                damage.isCrit ? new Set([combatantId]) : new Set(),
              ));
              snapshot.combatants.set(combatant.id, combatant);
              feedbackOperation.emitted.add(combatant.id);
            }
          }
        }
        bulkHpFeedbackOperationsRef.current.delete(bulkOperationId);
        await invalidateEncounter(queryClient, eid);
      } catch (err) {
        bulkHpFeedbackOperationsRef.current.delete(bulkOperationId);
        const rollbackBaseline = previous;
        if (rollbackBaseline) {
          const restored = queryClient.setQueryData<EncounterWithCombatants>(
            queryKeys.encounter(eid),
            (current) => current
              ? rollbackOptimisticHpTargets(current, rollbackBaseline, targets)
              : rollbackBaseline,
          );
          seedHpFeedbackSnapshot(restored);
        }
        void invalidateEncounter(queryClient, eid);
        // Same rule as the single-target stepper: an unknown outcome is not a failure.
        if (isAmbiguousOutcome(err)) enterReconciling();
        else reportError(err);
        throw err;
      } finally {
        bulkHpApplyPendingRef.current = false;
        setBulkHpApplyPending(false);
      }
    },
    [eid, queryClient, reportError, ruleSystem, enterReconciling, isDm, seedHpFeedbackSnapshot, appendHpFeedbackEvents],
  );

  // Issue #1909 scope note: earlier rounds of this PR added a CAS token + debounce/
  // serialization queue to this whole-statblock PATCH (the in-app statblock editor's
  // onChange path), trying to close a pre-existing lost-update on a caller this issue
  // never named. That mechanism went through five review-caught regressions in a row (no
  // token → lost updates; token added → 409 on every keystroke; token re-read at send time
  // → guard defeated by a concurrent writer; token latched per-combatant → permanent
  // lockout after any other encounter write; draft leaked across an encounter-id change
  // mid-debounce) — a strong signal it was being built in the wrong place for this PR.
  // Reverted back to this endpoint's actual, and already-solved, scope: `patchCombatant`
  // sends every patch (including `statblock`) as a plain, immediate, token-less PATCH,
  // exactly as it did before this PR touched this file. This restores the PRE-EXISTING
  // whole-statblock-editor concurrency gap (a concurrent whole-statblock save can still
  // revert another writer's unrelated edit) rather than introducing a new one — that gap
  // predates this PR and is now tracked as its own follow-up issue rather than solved here.
  // What #1909 actually asked for — flipping ONE resource pip no longer clobbers the WHOLE
  // statblock — is unaffected: the pip path went through `adjustCombatantResource`'s
  // delta-based endpoint from the very first round and never depended on this mechanism.
  const patchCombatant = useCallback(
    // Issue #1992 review: returns whether the write actually landed (never rejects — both
    // outcomes RESOLVE) so a caller that needs to know (the statblock editor's save-on-blur,
    // which must not clear its local draft on a rejected write) can await it, while every
    // OTHER call site keeps ignoring the return value exactly as before. combatantPatch's own
    // onError still fires unconditionally (the generic error toast), so nothing here changes
    // what the user is told — only whether CombatantRow discards its draft afterward.
    //
    // Round 5: no longer resolves an `updatedAt` — the statblock draft (the only consumer
    // of that value) moved off a revision-token guard entirely in favor of a content
    // compare (`expectedStatblock`, see combatantStatblockDraft.ts), so there is nothing
    // left that needs this write's row-level token.
    //
    // Round 7 (Devin): `encounterId` is now a required, explicit parameter — every call
    // site passes it (usually the page's own `eid`, but `CombatantRow`'s statblock
    // save-on-blur passes ITS OWN `encounterId` prop instead) rather than this function
    // resolving it from the surrounding closure. See `combatantPatchUrl`'s doc comment for
    // why that distinction is what actually fixes the wrong-encounter-on-navigation defect.
    (encounterId: number, combatantId: number, patch: Record<string, unknown>) => {
      const needsActor = Object.keys(patch).some((key) => HP_LOG_PATCH_KEYS.has(key));
      const actorCombatantId =
        needsActor && encounter?.status === 'running' ? (encounter.currentCombatantId ?? undefined) : undefined;
      const enriched = needsActor ? hpPatchWithActor(patch, actorCombatantId, combatantId, isDm) : patch;
      return combatantPatch.mutateAsync({ combatantId, encounterId, patch: enriched }).then(
        () => ({ ok: true }),
        () => ({ ok: false }),
      );
    },
    [combatantPatch, encounter?.status, encounter?.currentCombatantId, isDm],
  );

  const deathSaveRoll = useKeyedMutation({
    mutationFn: ({ combatantId, idempotencyKey }: { combatantId: number; idempotencyKey: string }) =>
      api.post<{ combatant: Combatant; roll: DiceRoll }>(`${API}/encounters/${eid}/combatants/${combatantId}/death-save`, { idempotencyKey }),
    onMutate: ({ combatantId }) => {
      setActionError(null);
      markCombatantPending(combatantId, true);
      const before = encounter?.combatants.find((candidate) => candidate.id === combatantId);
      deathSaveBeforeStateRef.current.set(combatantId, before?.deathState ?? 'dying');
      recentDeathSaveSelfRollRef.current.set(combatantId, Date.now());
      // Issue #1919 — no client-supplied die face: this only starts the shared tumble
      // animation. The face it settles on always comes from `showRoll(data.roll)` below.
      beginRollAnimation('1d20');
    },
    onSuccess: (data) => {
      showRoll(data.roll);
      const before = deathSaveBeforeStateRef.current.get(data.combatant.id) ?? 'dying';
      const outcome: DeathSaveOutcome = {
        natural: data.roll.total,
        kind: classifyDeathSaveOutcome(data.roll.total, before, data.combatant.deathState),
      };
      if (deathSaveOutcomeTimerRef.current != null) window.clearTimeout(deathSaveOutcomeTimerRef.current);
      setDeathSaveOutcome({ combatantId: data.combatant.id, outcome });
      deathSaveOutcomeTimerRef.current = window.setTimeout(() => setDeathSaveOutcome(null), 2_600);
    },
    onError: (err) => {
      cancelRollAnimation();
      if (isAmbiguousOutcome(err)) enterReconciling();
      else reportError(err);
    },
    onSettled: (_data, _err, { combatantId }) => {
      markCombatantPending(combatantId, false);
      deathSaveBeforeStateRef.current.delete(combatantId);
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
        visibility: 'party_shared',
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
  // Issue #1917: hoisted out of BattleMap's `onMoveFt` JSX prop.
  const handleMoveFt = useCallback(
    (combatantId: number, moveFt: number) => patchCombatantTurnState(combatantId, { moveFt }),
    [patchCombatantTurnState],
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
  const nextTurn = () => {
    // Claim the synchronous ref before starting the mutation. React's pending render can
    // lag a rapid double activation/keyboard repeat, but only this call may own and clear
    // the shared turn/HP serialization gate.
    if (turnAdvancePendingRef.current || queryClient.isMutating({ mutationKey: HP_MUTATION_KEY }) > 0 || bulkHpApplyPendingRef.current) return;
    turnAdvancePendingRef.current = true;
    nextTurnMut.mutate({
      expectedCurrentCombatantId: encounter?.status === 'running' ? (encounter.currentCombatantId ?? null) : null,
    });
  };
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

  // Issue #2123: whether this campaign's rule system has an initiative roll at all. False
  // (Ironsworn: Starforged) means the count above is not a setup step the DM owes — an
  // unrolled roster IS the turn order there, read positionally — so the roll controls are
  // not rendered and Start does not wait on them. `EncountersService` enforces the same
  // rule: both roll endpoints 400, and `start` drops the initiative precondition.
  const initiativeRollSupported = hasInitiativeRollForAdapter(activeAdapter);

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
      initiativeRollSupported,
    });
  }, [encounter, characters, campaignHasCompendium, initiativeRollSupported]);

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
    // A stale baseline from the PREVIOUS encounter must not gate a drag on this one — see
    // `reorderResyncArmedAt`'s own doc comment.
    setReorderResyncArmedAt(null);
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
      queryClient.setQueryData<EncounterWithCombatants>(queryKeys.encounter(variables.encounterId), (current) =>
        preferNewerEncounterSnapshot(
          current,
          reconcileEncounterPatchResponse(updated, pendingEncounterPatches.current.values(), variables.queueId, variables.encounterId),
        ),
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
  // Issue #1917: hoisted out of BattleMap's `onImportMap`/`onDismissGuidance` JSX props —
  // both were freshly bound arrows every render, defeating BattleMap's new React.memo.
  const handleImportMap = useCallback(
    (id: number) => {
      setEncounterMap(id);
      setShowMapGuidance(true);
      announce('Map imported. Check the grid, set fog, then place tokens.');
    },
    [setEncounterMap, announce],
  );
  const handleDismissMapGuidance = useCallback(() => setShowMapGuidance(false), []);
  // Grid config (issue #40, phase 2) — any subset of gridSize/gridScale/gridUnit/gridSnap.
  const setEncounterGrid = useCallback((patch: EncounterGridPatch) => queueEncounterPatch(patch), [queueEncounterPatch]);
  // Fog of war (issue #40, phase 3) — replace the whole fog state (null clears it).
  const setEncounterFog = useCallback((fog: FogState | null) => {
    if (queueEncounterPatch({ fog })) setPendingFog({ encounterId: eid, fog });
  }, [eid, queueEncounterPatch]);
  // Shared AoE templates (issue #238) — replace the whole template list (DM only, server-enforced).
  const setEncounterAoe = useCallback((aoe: AoeTemplate[]) => queueEncounterPatch({ aoe }), [queueEncounterPatch]);
  // Player declarations use scoped routes so the server, not the browser, owns
  // declarer attribution and per-template authorization (#1913).
  const declareAoeTemplate = useCallback(async (template: Omit<AoeTemplate, 'declaredByUserId'>) => {
    setActionError(null);
    await api.post(`${API}/encounters/${eid}/aoe-templates`, template);
    invalidateEncounter(queryClient, eid);
  }, [eid, queryClient]);
  const updateAoeTemplate = useCallback(async (templateId: string, patch: Partial<Omit<AoeTemplate, 'id' | 'declaredByUserId'>>) => {
    setActionError(null);
    queryClient.setQueryData<EncounterWithCombatants>(queryKeys.encounter(eid), (current) =>
      current
        ? { ...current, aoe: current.aoe.map((template) => (template.id === templateId ? { ...template, ...patch } : template)) }
        : current,
    );
    try {
      await api.patch(`${API}/encounters/${eid}/aoe-templates/${encodeURIComponent(templateId)}`, patch);
    } catch (error) {
      // A refetch is a rollback that does not clobber a later local nudge that
      // may already have updated the same cache entry.
      invalidateEncounter(queryClient, eid);
      throw error;
    }
    invalidateEncounter(queryClient, eid);
  }, [eid, queryClient]);
  const removeAoeTemplate = useCallback(async (templateId: string) => {
    setActionError(null);
    await api.delete(`${API}/encounters/${eid}/aoe-templates/${encodeURIComponent(templateId)}`);
    invalidateEncounter(queryClient, eid);
  }, [eid, queryClient]);
  const clearPlayerAoeTemplates = useCallback(async () => {
    const playerTemplates = (encounter?.aoe ?? []).filter((template) => template.declaredByUserId != null);
    if (playerTemplates.length === 0) return;
    setActionError(null);
    const results = await Promise.allSettled(playerTemplates.map((template) => api.delete(`${API}/encounters/${eid}/aoe-templates/${encodeURIComponent(template.id)}`)));
    invalidateEncounter(queryClient, eid);
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
  }, [eid, encounter?.aoe, queryClient]);

  // Issue #1917: `BattleMap`'s `onDeclareAoe`/`onUpdateAoe`/`onRemoveAoe`/`onClearPlayerAoe`
  // props each wrapped an already-stable mutator (above) in a fresh inline arrow at the JSX
  // call site — hoisted here so BattleMap's React.memo boundary sees stable references.
  const handleDeclareAoe = useCallback(
    (template: Omit<AoeTemplate, 'declaredByUserId'>) => {
      void declareAoeTemplate(template).catch(reportError);
    },
    [declareAoeTemplate, reportError],
  );
  const handleUpdateAoe = useCallback(
    async (templateId: string, patch: Partial<Omit<AoeTemplate, 'id' | 'declaredByUserId'>>) => {
      try {
        await updateAoeTemplate(templateId, patch);
      } catch (error) {
        reportError(error);
        throw error;
      }
    },
    [updateAoeTemplate, reportError],
  );
  const handleRemoveAoe = useCallback(
    (templateId: string) => {
      void removeAoeTemplate(templateId).catch(reportError);
    },
    [removeAoeTemplate, reportError],
  );
  const handleClearPlayerAoe = useCallback(() => {
    void clearPlayerAoeTemplates().catch(reportError);
  }, [clearPlayerAoeTemplates, reportError]);

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
  // Issue #1937: color carries per-user identity (not per-combatant — the same person
  // keeps the same ping color across every combatant they might be playing). label is
  // set only when the caller chose an intent from the long-press/right-click menu; a
  // plain tap keeps sending null, byte-identical to before this issue. senderId/senderName
  // stay null — the server stamps the authenticated caller's identity (issue #869/#1636).
  // Issue #1917: hoisted from an inline JSX arrow into a stable useCallback — BattleMap is
  // now React.memo-wrapped, so a fresh function identity here on every render would defeat it.
  const sendPing = useCallback(
    (x: number, y: number, label: string | null = null) =>
      pingMap.mutate({ x, y, color: pingIdentityColor(String(myUserId ?? '')), label, senderId: null, senderName: null } as unknown as MapPing),
    [pingMap, myUserId],
  );

  // Move a combatant's token on the battle map. The server clamps to 0–100 and gates on
  // role (DM moves any; a player only their own character's token).
  const moveToken = useCallback(
    (combatantId: number, x: number, y: number) => patchCombatant(eid, combatantId, { tokenX: x, tokenY: y }),
    [patchCombatant, eid],
  );
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
  const unplaceToken = useCallback(
    (combatantId: number) => patchCombatant(eid, combatantId, { tokenX: null, tokenY: null }),
    [patchCombatant, eid],
  );
  // Token size category (issue #40, phase 2) — DM-only, server-enforced.
  const setTokenSize = useCallback(
    (combatantId: number, size: TokenSize) => patchCombatant(eid, combatantId, { tokenSize: size }),
    [patchCombatant, eid],
  );

  // Header run-control group shares one pending flag (see runControl above).
  // `reconcileBlocks` folds into the same busy flag the header already honors (issue
  // #580): while the client is checking committed state, every non-idempotent DM control
  // is unavailable, which is the "reconcile before another action is allowed" rule.
  const headerBusy =
    runControl.isPending || nextTurnMut.isPending || hpMutationCount > 0 || bulkHpApplyPending || undoTurnMut.isPending || deleteEncounterMut.isPending || escalationControl.isPending || reconcileBlocks;
  const nextTurnShortcut = useKeyboardCommandHint('encounterNextTurn');

  useKeyboardGuardedAction(
    'encounterNextTurn',
    canDmWrite && encounter
      ? {
          canExecute: () => {
            // #599/#1933: the keyboard path must honor the same safety-hold mirror as the
            // Next-turn button's GatedControl reason — otherwise the shortcut would still
            // fire (and get server-rejected) while the button next to it visibly explains
            // why it will not.
            if (!encounter || headerBusy || riskyBlocked || safetyHoldActive) return false;
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
  const currentCombatant = useMemo(
    () => (currentCombatantId != null ? encounter?.combatants.find((c) => c.id === currentCombatantId) : undefined),
    [encounter?.combatants, currentCombatantId],
  );

  const { data: turnWorkspace } = useQuery({
    queryKey: queryKeys.encounterTurn(eid),
    queryFn: () => api.get<TurnWorkspaceData>(`${API}/encounters/${eid}/turn`),
    enabled: encounter?.status === 'running',
    staleTime: 2_000,
  });

  // Refresh /turn when the encounter poll observes a change that an SSE frame
  // might have missed. This supplies an authoritative owner result for the
  // hidden-tab title after reconnects as well as ordinary stream delivery.
  useEffect(() => {
    if (currentCombatantId === undefined) {
      // A missed SSE edge can leave a stale owned /turn result behind while a
      // same-round lair action clears the current combatant in the poll.
      // Clear the optimistic owner immediately, then refetch the workspace.
      setTurnOwnerFromEvent(null);
      setTurnOwnerPendingCombatantId(null);
    }
    void queryClient.invalidateQueries({ queryKey: queryKeys.encounterTurn(eid) });
  }, [currentCombatantId, eid, queryClient]);

  // The event path wins immediately (especially when it clears an owned
  // hidden-tab title), while a matching, later authoritative /turn result
  // repairs an optimistic positive after a missed SSE frame or reconnect.
  useEffect(() => {
    if (!turnWorkspace) return;
    if (characterOwnershipPendingDataUpdatedAtRef.current != null) return;
    if (turnOwnerPendingCombatantId != null) {
      if (turnWorkspace.current?.combatantId !== turnOwnerPendingCombatantId) {
        if (turnWorkspace.current?.combatantId === currentCombatantId) {
          setTurnOwnerPendingCombatantId(null);
        }
        return;
      }
      setTurnOwnerFromEvent({
        combatantId: turnOwnerPendingCombatantId,
        isYourTurn: turnWorkspace.isYourTurn,
      });
      setTurnOwnerPendingCombatantId(null);
      return;
    }
    if (turnWorkspace.current?.combatantId !== currentCombatantId) return;
    setTurnOwnerFromEvent({
      combatantId: currentCombatantId ?? null,
      isYourTurn: turnWorkspace.isYourTurn,
    });
  }, [charactersQuery.dataUpdatedAt, currentCombatantId, turnOwnerPendingCombatantId, turnWorkspace?.current?.combatantId, turnWorkspace?.isYourTurn]);

  // If the character list was still loading when an owned frame arrived, the
  // authoritative workspace can safely promote its already-visible ticker to
  // the one owned takeover once both reads identify the same combatant.
  useEffect(() => {
    if (
      !turnBeat?.pending
      || turnBeat.combatantId !== currentCombatantId
      || !currentCombatant
    ) return;
    const nextBeatKey = ++turnBeatSequence.current;
    setTurnBeat((previous) => previous?.pending && previous.combatantId === currentCombatant.id
      ? {
          ...previous,
          key: nextBeatKey,
          pending: false,
          name: currentCombatant.name,
          identityBackground: tokenIdentityBackground(currentCombatant),
        }
      : previous);
  }, [currentCombatant, currentCombatantId, turnBeat?.combatantId, turnBeat?.pending]);

  useEffect(() => {
    if (
      !turnWorkspace
      || !turnBeat
      || characterOwnershipPendingDataUpdatedAtRef.current != null
      || turnWorkspace.isYourTurn !== true
      || turnWorkspace.current?.combatantId !== currentCombatantId
      || turnBeat.combatantId !== currentCombatantId
      || turnBeat.kind === 'your-turn'
    ) return;
    const nextBeatKey = ++turnBeatSequence.current;
    triggerOwnedTurnFeedback(nextBeatKey);
    setTurnBeat((previous) => previous && previous.combatantId === currentCombatantId
      ? {
          ...previous,
          key: nextBeatKey,
          kind: 'your-turn',
          pending: false,
          name: currentCombatant?.name ?? previous.name,
          identityBackground: currentCombatant ? tokenIdentityBackground(currentCombatant) : previous.identityBackground,
        }
      : previous);
  }, [charactersQuery.dataUpdatedAt, currentCombatant, currentCombatantId, triggerOwnedTurnFeedback, turnBeat?.combatantId, turnBeat?.key, turnBeat?.kind, turnWorkspace?.current?.combatantId, turnWorkspace?.isYourTurn]);

  const combatantRowRefs = useRef(new Map<number, HTMLElement>());
  const setCombatantRowRef = useCallback((combatantId: number, el: HTMLElement | null) => {
    if (el) combatantRowRefs.current.set(combatantId, el);
    else combatantRowRefs.current.delete(combatantId);
  }, []);
  // Issue #1917 stage 1: `CombatantRow` is now `React.memo`-wrapped, so a per-row `rowRef`
  // callback recreated inline in the roster `.map()` below (`(el) => setCombatantRowRef(c.id,
  // el)`) would be a fresh function identity every render and defeat the memo for that prop
  // alone. `setCombatantRowRef` itself is already a stable (`[]` deps) top-level callback, so
  // a cached per-combatant-id binding can never become *wrong* — the thing it closes over
  // never changes identity.
  //
  // It can still make the cache *grow*. `RunSessionPage` is reused across encounters, so with
  // no reset every combatant id the session has ever shown would accumulate here for the life
  // of the page. Correct-forever and bounded are separate properties, and only the first
  // follows from the stable closure; the effect below clears both maps on `eid`, matching the
  // other per-encounter resets in this file.
  const combatantRowRefCallbacks = useRef(new Map<number, (el: HTMLElement | null) => void>());
  const getCombatantRowRef = useCallback(
    (combatantId: number) => {
      const cache = combatantRowRefCallbacks.current;
      let bound = cache.get(combatantId);
      if (!bound) {
        bound = (el: HTMLElement | null) => setCombatantRowRef(combatantId, el);
        cache.set(combatantId, bound);
      }
      return bound;
    },
    [setCombatantRowRef],
  );

  // Manual initiative reorder (issue #1923). `handleReorderDrop` is the single write
  // path both InitiativeStrip's drag and the roster's drag-handle/menu funnel through —
  // `encounter.turnVersion` is read HERE, at call time, not memoized into a stale
  // closure, so the CAS token sent is always the one this render actually showed the DM.
  const rosterOrderedIds = useMemo(() => encounter?.combatants.map((c) => c.id) ?? [], [encounter]);
  const canReorderCombatants = canDmWrite && encounter != null && encounter.status !== 'ended';
  const handleReorderDrop = useCallback(
    (combatantId: number, afterCombatantId: number | 'top') => {
      if (!encounter) return;
      // The sync/in-flight gate lives HERE rather than only on each entry point's
      // enabled-ness (#2074 review finding 3). `buildReorderControls` below already
      // withholds the roster row's drag handle and menu on exactly these conditions, but
      // `InitiativeStrip` was handed `canReorder={canEditEncounter}` — the DM/not-ended
      // check alone — and funnels into this same mutation, so during an SSE outage that
      // disabled every other conflict-prone write on the page a strip drag still went to
      // the server, and a second drag could start before the first was confirmed.
      // Gating the two entry points separately is what let them drift; gating the single
      // write path they share makes them agree by construction.
      // `reorderCombatant.isPending`, NOT `pendingCombatantIds.has(combatantId)`. A reorder is a
      // TOPOLOGY-wide write: it renumbers the whole roster. The per-row pending set is the right
      // granularity for an HP tick, which is why `buildReorderControls` uses it — but copying
      // that shape here meant dragging combatant B while A's reorder was still in flight sailed
      // past the guard, and both requests carried the SAME rendered `turnVersion`, so one came
      // back TURN_VERSION_MISMATCH instead of being prevented.
      //
      // `isAwaitingReorderResyncNow` (issue #2116, see that value's own doc comment):
      // `reorderCombatant.isPending` alone still leaves a window open between this
      // mutation's `onSettled` and its triggered refetch actually landing, during which a drag
      // would be authored against the pre-reorder roster.
      if (reconcileBlocks || riskyBlocked || reorderCombatant.isPending || isAwaitingReorderResyncNow) return;
      reorderCombatant.mutate({ combatantId, afterCombatantId, expectedTurnVersion: encounter.turnVersion, encounterId: eid });
    },
    // `reorderCombatant` covers `.isPending` — the mutation object is a new reference on each
    // status change, so the closure re-forms when pending flips. `isAwaitingReorderResyncNow`
    // is plain state (not a ref), so it MUST be listed here too, or a stale closure would keep
    // authoring drags against it after it flips. `eid` is read directly at the moment of the
    // drag (not resolved later) — see `reorderCombatant`'s own doc comment for why `onSettled`
    // must consult this captured value instead of its own closure.
    [encounter, reorderCombatant, reconcileBlocks, riskyBlocked, isAwaitingReorderResyncNow, eid],
  );
  const rosterDragReorder = useCombatantDragReorder({
    axis: 'y',
    orderedIds: rosterOrderedIds,
    // Issue #2084 finding 4: `reconcileBlocks`/`riskyBlocked` were already folded into
    // `buildReorderControls`' `busy` below (issue #2074 review finding 3), which
    // withholds `dragHandleProps` on the row — but withholding props off an ELEMENT
    // THAT STAYS MOUNTED only drops the DOM listeners; it never told this hook a
    // gesture already in flight had gone stale, so `gestureRef` stayed populated and
    // every later drag on every row was refused until reload. Folding the same gate
    // into `enabled` here lets the hook's own enabled-transition effect reset (and
    // release pointer capture on) an in-progress gesture directly, independent of
    // whatever the caller's props end up doing with `busy`. `isAwaitingReorderResyncNow`
    // (issue #2116) joins the same gate for the same reason: if the roster's resync arms
    // mid-gesture, an in-progress drag must be reset rather than left to complete and
    // author itself against the pre-reorder topology.
    enabled: canReorderCombatants && !reconcileBlocks && !riskyBlocked && !isAwaitingReorderResyncNow,
    elementsRef: combatantRowRefs,
    onDrop: handleReorderDrop,
  });
  const buildReorderControls = useCallback(
    (combatant: Combatant): CombatantRowProps['reorder'] => {
      if (!canReorderCombatants || !encounter) return null;
      const ids = rosterOrderedIds;
      const moveUpTarget = afterCombatantIdForMoveUp(ids, combatant.id);
      const moveDownTarget = afterCombatantIdForMoveDown(ids, combatant.id);
      return {
        canMoveUp: moveUpTarget !== null,
        canMoveDown: moveDownTarget !== null,
        onMoveUp: () => { if (moveUpTarget !== null) handleReorderDrop(combatant.id, moveUpTarget); },
        onMoveDown: () => { if (moveDownTarget !== null) handleReorderDrop(combatant.id, moveDownTarget); },
        menuTargets: reorderMenuTargets(encounter.combatants, combatant.id).map((c) => ({ id: c.id, name: c.name })),
        onMoveAfter: (afterCombatantId) => handleReorderDrop(combatant.id, afterCombatantId),
        dragHandleProps: rosterDragReorder.handleProps(combatant.id),
        isDragging: rosterDragReorder.draggingId === combatant.id,
        isDropTarget: rosterDragReorder.overId === combatant.id,
        // Issue #2074 review finding 3: reorder performs a write (POST .../reorder), so
        // it must consult the live-sync gate (`riskyBlocked`) the same way every other
        // write control on this row does — see CombatantRowProps.syncBlocked's own doc
        // ("EVERY control that performs a write must consult both"). Omitting it left the
        // drag handle and ReorderMenu draggable/clickable during an SSE outage that blocks
        // every other conflict-prone write on the row.
        //
        // Issue #2116 review round 2: `isAwaitingReorderResyncNow` must ALSO be here, not
        // just in `handleReorderDrop`'s guard — otherwise the drag handle and ReorderMenu
        // (move up/down, move after) stay visibly enabled while `reorderCombatant.isPending`
        // has cleared but the resync is still outstanding, so a click or completed drag is
        // silently swallowed by that guard with no feedback at all: exactly the "recoverable,
        // visible 409 traded for a silent no-op" trade the issue rejects for
        // `encounterQuery.isFetching`.
        busy: pendingCombatantIds.has(combatant.id) || reconcileBlocks || riskyBlocked || isAwaitingReorderResyncNow,
      };
    },
    [canReorderCombatants, encounter, rosterOrderedIds, handleReorderDrop, rosterDragReorder, pendingCombatantIds, reconcileBlocks, riskyBlocked, isAwaitingReorderResyncNow],
  );
  // Drop the previous encounter's cached ref bindings on switch, so the cache stays bounded
  // across a long session.
  //
  // ONLY the callback cache. Clearing `combatantRowRefs` here too is actively wrong (#2083
  // review): with the target encounter already in the React Query cache, `encounter` is
  // non-null in the same render `eid` changes, so rows mount and attach their refs during that
  // commit — and this passive effect, running afterwards, would drop refs for rows that are
  // still mounted. React does not re-invoke a ref until its identity changes, so those entries
  // would stay missing until the next render and the turn auto-scroll would silently fall back
  // to a `querySelector`. React already clears that map on unmount by invoking each ref with
  // null, so the belt-and-braces line was not harmless.
  useEffect(() => {
    combatantRowRefCallbacks.current.clear();
  }, [eid]);
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
        // The roster scrolls inside the cockpit's panel, and the page itself is locked —
        // a `window.scrollTo` computed against the viewport moves nothing, leaving the new
        // actor off-screen. Ask the row to bring itself into view instead, which scrolls
        // whichever ancestor actually scrolls, and judge "already visible" against that
        // container rather than the window.
        const scroller = el.closest<HTMLElement>('.cf-vtt-panel-body');
        const rect = el.getBoundingClientRect();
        const bounds = scroller?.getBoundingClientRect();
        const top = bounds?.top ?? 0;
        const bottom = bounds?.bottom ?? window.innerHeight;
        if (rect.bottom > top && rect.top < bottom) return;
        el.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
      });
    });
    return () => cancelAnimationFrame(frame);
    // `panelTab`/`panelOpen` are dependencies because a turn can advance while the roster
    // is hidden — another tab, or the panel collapsed. `scrollIntoView` does nothing
    // through a `display: none` ancestor, so without re-running when the roster comes
    // back the new actor stays off-screen in a long list. The in-view check below makes
    // the extra runs free when it is already visible.
  }, [encounter?.status, currentCombatantId, panelTab, panelOpen]);

  // Issue #1917: `ApplyDamageBar` is now React.memo-wrapped, so its `targets`/`aoeHitContext`
  // array/object props and its `onApply`/`onApplyToAll`/`onDismiss` handlers are hoisted out
  // of the JSX call site (below) rather than rebuilt inline on every render. Placed above the
  // `!encounter` early returns (below) — like every other hook in this component — so hook
  // order stays identical across renders regardless of loading/not-found/error state.
  const applyDamageBarTargets = useMemo(
    () => (encounter?.combatants ?? []).filter((c) => canEditCombatantPermission(c) && c.hpCurrent != null),
    [encounter?.combatants, canEditCombatantPermission],
  );
  const applyDamageBarAoeHitContext = useMemo(
    () =>
      encounter &&
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
        : null,
    [encounter, aoeHitLayout],
  );
  const applyDamageBarOnApply = useCallback(
    (combatantId: number, delta: number, damage: DirectDamageMetadata) => {
      if (!pendingApply || turnAdvancePendingRef.current) return;
      const actorId = hpLogActorId(pendingApply.actorCombatantId ?? currentCombatantId, combatantId);
      hpDelta.mutate({ combatantId, delta, actorId, ...damage });
      setPendingApply(null);
    },
    [pendingApply, currentCombatantId, hpDelta],
  );
  const applyDamageBarOnApplyToAll = useCallback(
    (applications: TargetDamageApplication[], delta: number) => {
      if (turnAdvancePendingRef.current || bulkHpApplyPendingRef.current) return;
      const actorId = pendingApply?.actorCombatantId ?? currentCombatantId ?? undefined;
      void applyHpDeltaBulk(applications, delta, actorId)
        .then(() => setPendingApply(null))
        .catch(() => undefined);
    },
    [pendingApply, currentCombatantId, applyHpDeltaBulk],
  );
  const applyDamageBarOnDismiss = useCallback(() => setPendingApply(null), []);

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
  const myCombatants = orderedCombatants.filter(
    (c) =>
      (c.characterId != null && ownedCharacterIds.has(c.characterId)) ||
      (c.controllerUserId != null && myUserId != null && String(c.controllerUserId) === String(myUserId)),
  );
  // The Turn section holds exactly three things: the viewer's own vitals, and two blocks
  // gated on `status === 'running'`. Outside combat it is therefore empty for a DM, and
  // for any player with no combatant of their own — and the tab was still selectable, so
  // clicking it replaced the roster or the aftermath with a blank panel. The lifecycle
  // default only kept people from LANDING there. Drop the tab instead, and fall back to
  // Party if it disappears while selected.
  const turnTabAvailable = encounterRunning || (!isDm && myCombatants.length > 0);
  const activePanelTab: PanelTab = panelTab === 'turn' && !turnTabAvailable ? 'party' : panelTab;
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
  // Every check the viewer could be shown, not just the one on screen. These QUEUE: a
  // second hit while the first save is still up appends rather than replaces, and a check
  // can land on another eligible combatant entirely. Keying attention on the displayed
  // head alone meant the key never changed for either, so a panel the viewer had
  // collapsed stayed shut over a fight that was waiting on them. Same eligibility as the
  // two lookups above — never a monster/NPC queue for a non-resolver (#43 / #606).
  const waitingConcentrationChecks = orderedCombatants.flatMap((combatant) =>
    canEditCombatantPermission(combatant) || combatant.kind === 'character'
      ? combatant.turnState.pendingConcentrationChecks.map((check) => ({ id: `${combatant.id}:${check.id}` }))
      : [],
  );
  const canResolveConcentrationCheck =
    concentrationCheckCombatant != null && canEditCombatantPermission(concentrationCheckCombatant);

  // Issue #420: DM header actions come from an explicit lifecycle matrix (not
  // ad-hoc status !== 'ended' checks) so Preparing never offers the invalid End.
  // Default tab, when the viewer has not picked one. A DM's cockpit is the roster —
  // HP, conditions and statblocks are what they touch every round, and the turn
  // controls they drive live in the header, not in the Turn tab. A player's own turn

  // A prompt that demands a decision must not sit inside a collapsed panel. These arrive
  // unprompted — a co-DM's damage raises a concentration save, an MCP action resolves an
  // attack — so the viewer has no reason to look, and the reopen tab carries no badge.
  // Reopen for them and scroll the panel body back up (the prompts render above the tab
  // sections in the same scroller, so a scrolled-down panel hides them just as well as a
  // collapsed one); leave the viewer's tab choice alone, since each prompt renders above
  // the tab switch and is visible whichever section is showing.
  // Every waiting prompt, not just the first — see `waitingPromptsKey`.
  const attentionKey = waitingPromptsKey([
    ...waitingConcentrationChecks.map((check) => ['concentration', check] as const),
    ['apply', pendingApply],
    ['action', pendingActionUse],
    ['group', pendingGroupActionUse],
  ]);

  const lifecycle = dmLifecycleActions(encounter.status);
  const deleteCopy = deleteConfirmCopy(encounter.status);

  const encounterBanners = (
    <>
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
      <EncounterSyncBanner
        encounterSyncBanner={encounterSyncBanner}
        encounterSyncLastSyncTitle={encounterSyncLastSyncTitle}
      />
      {/* Issue #1446: while not live, conflict-prone actions are blocked but confirmable —
          a stuck stream (proxy buffering, a terminated long-lived connection, …) must not
          brick combat permanently. Granting the override does not touch the banner above,
          which stays visible for as long as the stream is unhealthy so the DM never loses
          track of which mode they're in. DM-only (canDmWrite): this is the table-wide
          override — unblocks every conflict-prone control. Issue #1914 adds a second,
          player-facing prompt just below, scoped to the confirming player's own combatant
          only; a player has no path to grant THIS one. */}
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
      {/* Issue #1914: the scoped, player-facing "continue anyway" — visible only to a
          non-DM viewer with at least one owned combatant in THIS encounter (an offer with
          nothing to unblock would be a dead prompt). Grants `scope: 'own-combatant'`
          explicitly; `gateForWrite` is what actually confines its effect to the confirming
          player's own combatant rows, not this handler. */}
      {encounterSyncOwnOverrideOfferable && myCombatants.length > 0 && (
        <div
          role="status"
          aria-live="polite"
          data-testid="encounter-sync-own-override-prompt"
          className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm flex items-center gap-2 flex-wrap"
        >
          <span>{t('encounters.sync.ownOverridePrompt')}</span>
          <Btn
            density="xs"
            ghost
            className="text-xs"
            data-testid="encounter-sync-own-override-confirm"
            onClick={() => {
              // Defense in depth alongside the gate above — never let a DM/staff-only or a
              // stale-identity viewer grant the scoped override even if this handler is
              // somehow reachable, and never grant it with `scope: 'dm'`.
              if (!overrideAuthority.canPlayerWrite || overrideAuthority.canDmWrite || overrideAuthority.staleIdentity) return;
              setEncounterSyncOverride(
                confirmEncounterOverride(overrideAuthority.campaignId, overrideAuthority.userId, 'own-combatant'),
              );
            }}
          >
            {t('encounters.sync.ownOverrideConfirm')}
          </Btn>
        </div>
      )}
      {effectiveEncounterSyncOverride.active && encounterSync !== 'live' && (
        <span className="tag tag-accent" data-testid="encounter-sync-override-active" style={{ fontSize: 11 }}>
          {effectiveEncounterSyncOverride.scope === 'own-combatant'
            ? t('encounters.sync.ownOverrideActive')
            : t('encounters.sync.overrideActive')}
        </span>
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
    </>
  );

  return (
    <EncounterVttShell
      // `reading-surface` opts the cockpit into the semantic reading scale, exactly as the
      // pre-cockpit root did — dropping it silently took the encounter page out of the
      // user's text-size preference (reading-preferences.spec.ts). BattleMap already marks
      // itself `reading-exempt` so map geometry does not scale with body text.
      className={`cf-print-root reading-surface${isDm ? ' cf-print-encounter' : ''}`}
      mapStacked={encounter.mapAttachmentId == null}
      rootProps={entityTargetProps('encounter', encounter.id)}
      backSlot={
        <div className="cf-vtt-back">
          <DetailPageWayfinding
            campaignId={cid}
            defaultPath={`/c/${cid}/encounters`}
            defaultLabel="← Back to encounters"
          />
        </div>
      }
      title={encounter.name}
      titleBadges={
        <>
          <span className={STATUS_TAG_CLASS[encounter.status]}>
            {STATUS_LABEL[encounter.status]}
          </span>
          <DifficultyBadge difficulty={difficulty} />
        </>
      }
      metaSlot={
        // The template's header pill. The round text stays one contiguous string —
        // splitting it into a kicker + numeral would read the same but break every
        // caller that looks for "Round 3".
        <div className="cf-vtt-meta">
          {encounter.status === 'running' && (
            <span className="tag tag-neutral">
              Round {encounter.round}
              {encounter.turnPhase === 'lair' ? ` · Lair (init ${LAIR_INITIATIVE_COUNT})` : ''}
            </span>
          )}
          {/* Turn timer (issue #1935): DM-cockpit elapsed chip next to the round tag. Players
              get the same information (only once a limit is set) via PlayerVitalsHeader below,
              not here — see TurnElapsedChip's audience doc. */}
          {isDm && (
            <TurnElapsedChip
              turnStartedAt={encounter.turnStartedAt}
              turnTimerSeconds={encounter.turnTimerSeconds}
              audience="dm"
            />
          )}
        </div>
      }
      statusSlot={
        <>
          <span
            className={`cf-chip ${encounterSyncChipClass(encounterSync)}`}
            data-testid={ENCOUNTER_SYNC_CHIP_TESTID}
            title={encounterSyncLastSyncTitle}
          >
            {encounterSyncChip}
          </span>
          {/* AI-DM presence chip (#344) — the Driver's live session chat is available
              on this running encounter. */}
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
          {/* `ml-auto` was the old card header's push-right; the cockpit header has its
              own spacer between the status chips and the turn controls. */}
          {isDm && <PrintControl resetKey={encounter.id} />}
        </>
      }
      actionsSlot={
        <>
          <DmLifecycleHeader
            canDmWrite={canDmWrite}
            lifecycle={lifecycle}
            headerBusy={headerBusy}
            riskyBlocked={riskyBlocked}
            safetyHoldActive={safetyHoldActive}
            needsInitiativeCount={needsInitiativeCount}
            initiativeRollSupported={initiativeRollSupported}
            hasNoCombatants={hasNoCombatants}
            undoTurnDisabled={
              encounter.round <= 1
              && (encounter.turnPhase ?? 'combatant') === 'combatant'
              && orderedCombatants.length > 0
              && encounter.currentCombatantId === orderedCombatants[0].id
            }
            nextTurnAriaKeyshortcuts={nextTurnShortcut.ariaKeyshortcuts}
            nextTurnTitle={`Next turn${nextTurnShortcut.titleSuffix}`}
            deleteLabel={encounter.status === 'preparing' ? 'Cancel' : 'Delete'}
            onRollInitiative={rollInitiative}
            onStart={startEncounter}
            onUndoTurn={undoTurn}
            onNextTurn={nextTurn}
            onRequestEnd={() => setConfirmEnd(true)}
            onRequestReopen={() => {
              // Default each conflict to pull_sheet (preserve intervening healing/rest).
              const initial: Record<number, HpResyncDirection> = {};
              for (const c of encounter.hpSyncConflicts ?? []) initial[c.combatantId] = 'pull_sheet';
              setHpResyncChoices(initial);
              setConfirmReopen(true);
            }}
            onRequestDelete={() => setConfirmDelete(true)}
            turnTimerSeconds={encounter.turnTimerSeconds}
            onSetTurnTimerSeconds={(seconds) => {
              void queueEncounterPatch({ turnTimerSeconds: seconds });
            }}
          />
        </>
      }
      bannerSlot={encounterBanners}
      mapSlot={
        (isDm || encounter.mapAttachmentId != null) ? (
          <BattleMap
            layout="vtt"
            encounter={encounter}
            campaignId={cid}
            isDm={isDm}
            viewerUserId={myUserId != null ? String(myUserId) : null}
            canDmWrite={canEditEncounter}
            busy={setMap.isPending}
            canMoveToken={canEditCombatant}
            colorVisionAssist={me?.user.colorVisionAssist ?? false}
            onSetMap={setEncounterMap}
            onMoveToken={moveToken}
            currentTurnCombatantId={encounter.status === 'running' ? turnWorkspace?.current?.combatantId ?? null : null}
            currentTurnMovementMaxFt={turnWorkspace?.movement?.maxFt ?? null}
            onMoveFt={handleMoveFt}
            onBatchTokens={batchMoveTokens}
            onUndoTokenBatch={undoTokenBatch}
            dismissTokenUndoNonce={dismissTokenUndoNonce}
            onBeginTokenBatchUndo={dismissRecoveryUndosForTokenBatch}
            onUnplaceToken={unplaceToken}
            onSetTokenSize={setTokenSize}
            onSetGrid={setEncounterGrid}
            onSetFog={setEncounterFog}
            pendingFog={battleMapPendingFog}
            onSetAoe={setEncounterAoe}
            aoeDeclarerNames={aoeDeclarerNames}
            canDeclareAoe={!riskyBlocked && encounter.status !== 'ended' && (canDmWrite || canPlayerWrite)}
            onDeclareAoe={handleDeclareAoe}
            onUpdateAoe={handleUpdateAoe}
            onRemoveAoe={handleRemoveAoe}
            onClearPlayerAoe={canEditEncounter ? handleClearPlayerAoe : undefined}
            hpFeedbackByCombatant={hpFeedbackByCombatant}
            onGenerateMap={canEditEncounter ? generateAndAttachMap : undefined}
            onImportMap={canEditEncounter ? handleImportMap : undefined}
            showGuidance={showMapGuidance}
            onDismissGuidance={handleDismissMapGuidance}
            onPing={sendPing}
            pings={pings}
            onDismissPing={dismissPing}
            onError={surfaceActionError}
            onAoeHitLayoutChange={onAoeHitLayoutChange}
            ruleSystem={ruleSystem}
            customMechanicsProfile={campaign?.customMechanicsProfile}
            targeting={battleMapTargeting}
            impactTargetIds={actionImpactTargetIds}
          />
        ) : (
          <div className="cf-vtt-canvas-empty">
            <EmptyState
              icon="treasure-map"
              title={t('encounters.vtt.noMapTitle')}
              hint={t('encounters.vtt.noMapHint')}
            />
          </div>
        )
      }
      mapOverlaySlot={
        <div className="cf-vtt-strip" data-testid="encounter-vtt-turn-bar">
          <button
            type="button"
            className="cf-vtt-strip-toggle"
            data-testid="encounter-vtt-turn-bar-toggle"
            aria-expanded={!turnBarCollapsed}
            title={t('encounters.vtt.turnBarToggle')}
            onClick={() => setTurnBarCollapsed((collapsed) => !collapsed)}
          >
            {t('encounters.vtt.turnBar')}
          </button>
          {!turnBarCollapsed && (
            <>
            {orderedCombatants.length > 0 && (
              <InitiativeStrip
                combatants={orderedCombatants}
                currentCombatantId={encounter.currentCombatantId}
                charactersById={charactersById}
                memberNamesByUserId={aoeDeclarerNames}
                turnPulse={turnPulse}
                hpFeedbackByCombatant={hpFeedbackByCombatant}
                colorVisionAssist={me?.user.colorVisionAssist ?? false}
                revealTick={revealTick}
                // Mirrors the roster row's gate (see `buildReorderControls`): a drag is a
                // write, so an outage, a blocking reconcile, or an outstanding reorder resync
                // (issue #2116) must withdraw the affordance, not just have the drop silently
                // swallowed by `handleReorderDrop`'s guard.
                canReorder={canEditEncounter && !reconcileBlocks && !riskyBlocked && !isAwaitingReorderResyncNow}
                onReorderDrop={handleReorderDrop}
              />
            )}
            </>
          )}
        </div>
      }
      fabSlot={
        <>
          {/* Hidden, never unmounted: SharedDiceLog owns the app's only live roll-event
              subscriber, so tearing it down with the tray would mean another player's roll
              produced no live feedback here — and reopening replays nothing, because the
              tray's initial load deliberately establishes a silent baseline.
              (Deliberately not naming the SSE type: death-save-table-moment.unit.spec.ts
              guards that this file never grows its own subscription to it.) */}
          <button
            type="button"
            className="cf-vtt-fab"
            data-testid="encounter-vtt-roll"
            aria-expanded={diceTrayOpen}
            aria-controls="encounter-vtt-dice-tray"
            title={t('encounters.vtt.roll')}
            onClick={() => setDiceTrayOpen((open) => !open)}
          >
            <span aria-hidden style={{ fontSize: 17, lineHeight: 1 }}>🎲</span>
            {t('dice.roll', 'Roll')}
          </button>
          {/* After its toggle, not before. Both are absolutely positioned so the order
              here costs nothing visually, but a keyboard user who opens the tray keeps
              focus on the button — and from a tray that PRECEDED it, Tab went on to the
              panel controls and skipped every dice control, reachable only by tabbing
              backwards through the whole tray. */}
          <div
            className="cf-vtt-tray"
            id="encounter-vtt-dice-tray"
            data-testid="encounter-vtt-dice-tray"
            hidden={!diceTrayOpen}
          >
            <SharedDiceLog campaignId={cid} compact />
          </div>

        </>
      }
      tabs={[
        ...(turnTabAvailable ? [{ id: 'turn', label: t('encounters.vtt.tabTurn') }] : []),
        { id: 'party', label: t('encounters.vtt.tabParty'), badge: orderedCombatants.length > 0 ? orderedCombatants.length : undefined },
        { id: 'log', label: t('encounters.vtt.tabLog') },
        { id: 'table', label: t('encounters.vtt.tabTable') },
      ]}
      activeTabId={activePanelTab}
      onSelectTab={(id) => setPanelTabChoice({ eid, running: encounterRunning, tab: id as PanelTab })}
      panelOpen={panelOpen}
      onPanelOpenChange={setPanelOpen}
      attentionKey={attentionKey}
      // Ending a fight re-composes the panel under an unchanged route — the aftermath
      // summary lands on top of Party — so the remembered offsets stop meaning anything.
      contentKey={`${eid}:${encounterRunning ? 'running' : encounter.status}`}
      panelSlot={
        <>
          {/* Transient, high-priority prompts. Deliberately outside the tab switch: an
              apply-damage bar or an action resolver opened from the roster must not
              disappear because the panel is showing Party rather than Turn. */}
          {pendingApply && (
            <ApplyDamageBar
              key={pendingApply.id}
              amount={pendingApply.amount}
              label={pendingApply.label}
              diceTotal={pendingApply.diceTotal}
              ruleSystem={campaign?.ruleSystem}
              customMechanicsProfile={campaign?.customMechanicsProfile}
              targets={applyDamageBarTargets}
              applyDisabled={riskyBlocked}
              aoeTemplates={encounter.aoe ?? []}
              aoeHitContext={applyDamageBarAoeHitContext}
              isStarfinder={isStarfinder}
              onApply={applyDamageBarOnApply}
              onApplyToAll={applyDamageBarOnApplyToAll}
              onDismiss={applyDamageBarOnDismiss}
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
              allowCrit={hasCriticalHitsForAdapter(activeAdapter)}
              key={pendingActionUse.id}
              encounterId={eid}
              actorCombatantId={pendingActionUse.combatantId}
              actorName={pendingActionUse.actorName}
              actionIndex={pendingActionUse.actionIndex}
              actionName={pendingActionUse.actionName}
              actionToken={pendingActionUse.id}
              spec={pendingActionUse.spec}
              combatants={orderedCombatants}
              targetIds={actionTargetIds}
              onToggleTarget={toggleActionTarget}
              onPreview={(actionToken) => { if (pendingActionUseIdRef.current === actionToken) setActionTargetsDeclared(true); }}
              onPreviewStart={(actionToken) => { if (pendingActionUseIdRef.current === actionToken) setActionTargetsDeclared(true); }}
              onPreviewError={(actionToken) => { if (pendingActionUseIdRef.current === actionToken) setActionTargetsDeclared(false); }}
              onBackToTargets={(actionToken) => { if (pendingActionUseIdRef.current === actionToken) setActionTargetsDeclared(false); }}
              isDm={isDm}
              // #599/#1933: `ActionResolverService.apply` has its own `assertNotHeld`, separate
              // from `EncountersService.assertNoSafetyHold`. Threading the hold only into the
              // lifecycle controls left this Apply enabled during a pause, so raising an X-Card
              // after a preview produced a bare server conflict instead of the gate reason.
              // Scoped to Apply: the server keeps `resolve` (the preview) open during a hold,
              // so the roll/preview controls in this panel stay as they were.
              // Deliberately NOT `|| safetyHoldActive`: this prop also feeds the panel's
              // QuickRollButtons, and `/quick-roll` carries no hold guard server-side (only
              // `apply` does). Folding the hold in here would disable a control the server
              // would have allowed. The hold reaches Apply alone, via `applyGateReason`.
              applyDisabled={riskyBlocked}
              applyGateReason={gateReasonText(actionApplyGateReason({ safetyHoldActive, riskyBlocked }), t)}
              onDismiss={() => { pendingActionUseIdRef.current = null; setPendingActionUse(null); setActionTargetIds([]); setActionTargetsDeclared(false); }}
              onError={surfaceActionError}
              onApplied={(token, _policy, sourceEncounterId) => {
                if (!isCurrentCombatantUndoEncounter(sourceEncounterId, activeEncounterIdRef.current)) return;
                void invalidateEncounter(queryClient, sourceEncounterId);
                pendingActionUseIdRef.current = null;
                setPendingActionUse(null);
                if (!prefersReducedMotion()) {
                  if (actionImpactTimerRef.current != null) window.clearTimeout(actionImpactTimerRef.current);
                  setActionImpactTargetIds(actionTargetIds);
                  actionImpactTimerRef.current = window.setTimeout(() => {
                    setActionImpactTargetIds([]);
                    actionImpactTimerRef.current = null;
                  }, 250);
                }
                setActionTargetIds([]);
                setActionTargetsDeclared(false);
                if (trashedEncounterIdsRef.current.has(sourceEncounterId)) return;
                dismissCompetingRecoveryUndos();
                setActionUndo({ token, label: pendingActionUse.actionName });
              }}
            />
          )}
          {pendingGroupActionUse && (
            <GroupActionRunner
              key={pendingGroupActionUse.id}
              encounterId={eid}
              actorCombatantId={pendingGroupActionUse.combatantId}
              actorName={pendingGroupActionUse.actorName}
              actionIndex={pendingGroupActionUse.actionIndex}
              actionName={pendingGroupActionUse.actionName}
              spec={pendingGroupActionUse.spec}
              sourceAction={pendingGroupActionUse.sourceAction}
              combatants={orderedCombatants}
              // Same gate as ActionUsePanel's own `applyDisabled`/`applyGateReason` above — the
              // group runner's "Roll for group" button applies (commits), so it is gated exactly
              // like a single Apply: sync-blocked always, safety-hold-blocked too (#599/#1933).
              applyDisabled={riskyBlocked}
              applyGateReason={gateReasonText(actionApplyGateReason({ safetyHoldActive, riskyBlocked }), t)}
              onDismiss={() => setPendingGroupActionUse(null)}
            />
          )}
          <VttPanelSection id="turn" activeTabId={activePanelTab}>
              {/* Sticky Player Vitals Header */}
              {!isDm && myCombatants.length > 0 && (
                <PlayerVitalsHeader
                  combatants={myCombatants}
                  charactersById={charactersById}
                  turnPulse={turnPulse}
                  currentCombatantId={currentCombatantId}
                  movementDefault={movementDefault}
                  colorVisionAssist={me?.user.colorVisionAssist ?? false}
                  turnStartedAt={encounter.turnStartedAt}
                  turnTimerSeconds={encounter.turnTimerSeconds}
                  ruleSystem={ruleSystem}
                  campaignId={cid}
                  rulesHintCompendiumAvailable={rulesHintCompendiumAvailable}
                  onHpDelta={(id, delta) => {
                    if (reconcileBlocks || turnAdvancePendingRef.current) return;
                    const actorId = hpLogActorId(currentCombatantId, id);
                    hpDelta.mutate({ combatantId: id, delta, actorId });
                  }}
                  onSetHpMax={(id, max) => {
                    if (reconcileBlocks) return;
                    patchCombatant(eid, id, { hpMax: max });
                  }}
                  onRollDeathSave={(id) => rollDeathSave({ id })}
                  isDeathSaveBusy={(id) => pendingCombatantIds.has(id) || reconcileBlocks}
                  // Issue #1914: every combatant here is, by construction, one `myCombatants`
                  // owns (the mount condition above) — so this is always an OWN-COMBATANT write,
                  // unblockable by the scoped player override without touching any other row.
                  syncBlocked={gateForWrite('own-combatant', { isOwnCombatant: true }, encounterSync, effectiveEncounterSyncOverride)}
                  deathSaveOutcome={deathSaveOutcome}
                  customMechanicsProfile={campaign?.customMechanicsProfile}
                  onSpecialResourceError={surfaceActionError}
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
                      // Issue #1933 review: this is the THIRD entry point to `nextTurn`, alongside
                      // the keyboard shortcut and DmLifecycleHeader's button. Both of those got the
                      // safety-hold mirror; this one did not, so a DM resolving a lair action while
                      // the table is paused fired a write `assertNoSafetyHold` rejects and got a
                      // bare error — the exact "server rejects and the UI cannot say why" outcome
                      // this issue exists to remove. Same shared resolver as the header, so all
                      // three agree by construction rather than by three people remembering.
                      // `ml-auto` moves to the WRAPPER: it is the flex item of this row now, so the
                      // button's own auto margin would push nothing (issue #1933 review).
                      <GatedControl
                        className="ml-auto"
                        reason={gateReasonText(nextTurnGateReason({ safetyHoldActive, riskyBlocked }), t, headerBusy)}
                      >
                        <Btn disabled={headerBusy || riskyBlocked} onClick={nextTurn}>
                          Done →
                        </Btn>
                      </GatedControl>
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
                  customMechanicsProfile={campaign?.customMechanicsProfile}
                  currentTurnState={currentCombatant?.turnState}
                  // Issue #1914: `actionsDisabled` now gates the workspace's OWN-COMBATANT writes
                  // (action-economy slots, death-save roll, spellbook, delay/ready, movement — all
                  // server-redacted to the DM or the current combatant's OWNER, so whenever a
                  // player sees any of this it is already their own turn) and can be relaxed by a
                  // same-outage 'own-combatant' override. `endTurnBlocked` stays the unrelaxed
                  // DM-grade gate for the End-turn button specifically — turn-topology writes are
                  // never unblocked by that scope, per the issue's acceptance criteria.
                  actionsDisabled={gateForWrite('own-combatant', { isOwnCombatant: turnWorkspace?.isYourTurn === true }, encounterSync, effectiveEncounterSyncOverride)}
                  endTurnBlocked={riskyBlocked}
                  deathSavePending={reconcileBlocks}
                  isCombatantPending={(combatantId) => pendingCombatantIds.has(combatantId)}
                  gridUnit={encounter.gridUnit}
                  gridScale={encounter.gridScale}
                  campaignId={cid}
                  rulesHintCompendiumAvailable={rulesHintCompendiumAvailable}
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
                  safetyHoldActive={safetyHoldActive}
                />
              )}
          </VttPanelSection>
          <VttPanelSection id="party" activeTabId={activePanelTab}>
              {/* The outcome belongs with the roster it describes — and this is the tab an
                  ended encounter opens on, whereas the Turn tab has no content once combat
                  is over, so a summary parked there was effectively hidden. */}
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
                      customMechanicsProfile={campaign?.customMechanicsProfile}
                      rowRef={getCombatantRowRef(c.id)}
                      encounterId={eid}
                      combatant={c}
                      hpFeedbackEvents={hpFeedbackByCombatant.get(c.id) ?? []}
                      isCurrentTurn={c.id === currentCombatantId}
                      colorVisionAssist={me?.user.colorVisionAssist ?? false}
                      // Permission decides whether these controls MOUNT at all (issue #1746):
                      // a genuinely unauthorized viewer (wrong owner, ended encounter) never sees
                      // them. Whether the sync gate currently blocks writes is a separate, transient
                      // signal passed via `syncBlocked` so the row can render disabled instead of
                      // unmounting — see CombatantRow's `syncBlocked` prop. Named `canEditPermission`,
                      // not `canEdit` (Devin review finding): every write-control consumer inside
                      // CombatantRow must consult BOTH this and `syncBlocked`, and the old name read
                      // as if permission alone were sufficient.
                      isDm={isDm}
                      myUserId={myUserId}
                      canEditPermission={canEditCombatantPermission(c)}
                      // Issue #1914: the DM-only controls on this row (identity edit, remove,
                      // initiative, duplicate) are mounted only for `canDmWrite` regardless of
                      // this value, so `combatantWriteBlocked` — which can relax below
                      // `riskyBlocked` for a player's OWNED row via a same-outage
                      // 'own-combatant' override — never exposes anything beyond that row's own
                      // HP/temp HP, death saves, and conditions. Every other row (not owned)
                      // and every DM row (unaffected — a 'dm' override already covers it) sees
                      // exactly `riskyBlocked`, unchanged.
                      syncBlocked={combatantWriteBlocked(c)}
                      turnTopologyBlocked={riskyBlocked}
                      canEditIdentity={canDmWrite && encounter.status !== 'ended'}
                      reorder={buildReorderControls(c)}
                      // Issue #1926: a non-DM viewer mounts the same compendium statblock viewer
                      // once the DM has revealed this combatant — the ruleEntryId link itself is
                      // not campaign-secret (unchanged by this issue; see /rules/entries/:id), so
                      // the server-enforced gate here is `statblockRevealed`, not `isDm`.
                      statblock={(isDm || c.statblockRevealed) && c.ruleEntryId != null ? <CombatantStatblock ruleEntryId={c.ruleEntryId} ruleSystem={ruleSystem} customMechanicsProfile={campaign?.customMechanicsProfile} campaignId={cid} /> : undefined}
                      showKillPrompt={isDm && shouldShowKillPrompt(c, dismissedKillPromptIds)}
                      onDismissKillPrompt={() => setDismissedKillPromptIds((prev) => dismissKillPrompt(prev, c.id))}
                      canRemove={canDmWrite}
                      // Issue #1944: DM-only Award for the adapter-declared special resource
                      // (5e inspiration / PF2e hero points). Same DM-write gate as canRemove —
                      // CombatantRow additionally requires a resolvable character and an
                      // adapter that declares one of SPECIAL_RESOURCE_KEYS before it mounts.
                      canAwardSpecialResource={canDmWrite}
                      // The catalog is a DM-readable GET even after archival. Its roll controls
                      // remain disabled whenever the campaign is not writable or combat ended.
                      canViewCreatureChecks={isDm}
                      canRollCreatureChecks={canDmWrite && encounter.status !== 'ended'}
                      onDuplicate={canDmWrite && encounter.status !== 'ended' && (c.kind === 'monster' || c.kind === 'npc')
                        ? () => requestDuplicateCombatant(c, encounter.combatants.map((combatant) => combatant.name))
                        : undefined}
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
                      routeCampaignId={cid}
                      // Issue #1898 review: the statblock read is a plain GET, not a write —
                      // it has none of the staleness/edit-permission concerns campaignId above
                      // guards against, so it must not go `undefined` (and 404 for homebrew) in
                      // exactly the read-only/offline states this prop exists to detect. Always
                      // the real route campaign id.
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
                      // Issue #1922: identical gating to `onUseMonsterAction` above — DM-only
                      // (`canEditCombatantPermission` reduces to `canDmWrite` once `characterId`
                      // is null), monster/npc rows only. The sync gate disables the rendered
                      // button the same way, via `disabledReason` inside `CombatantActionsList`.
                      onUseGroupAction={
                        canEditCombatantPermission(c) && c.characterId == null && (c.kind === 'monster' || c.kind === 'npc')
                          ? (actionIndex, actionName, spec, action) => onUseGroupActionRequested(c.id, c.name, actionIndex, actionName, spec, action)
                          : undefined
                      }
                      busy={pendingCombatantIds.has(c.id) || reconcileBlocks}
                      conditionSuggestions={conditionSuggestions}
                      conditionDefinitions={campaign?.conditionDefinitions}
                      conditionSourceOptions={canDmWrite ? orderedCombatants.map((source) => ({ id: source.id, name: source.name })) : [{ id: c.id, name: c.name }]}
                      defaultConditionSourceCombatantId={currentCombatantId ?? c.id}
                      ruleSystem={ruleSystem}
                      rulesHintCampaignId={cid}
                      rulesHintCompendiumAvailable={rulesHintCompendiumAvailable}
                      onHpDelta={(delta) => {
                        // Belt-and-braces with the `busy` prop above: never let a second damage
                        // intent start while the outcome of the previous one is still unknown (#580).
                        if (reconcileBlocks || turnAdvancePendingRef.current) return;
                        const actorId = hpLogActorId(currentCombatantId, c.id);
                        hpDelta.mutate({ combatantId: c.id, delta, actorId });
                      }}
                      onSetTempHp={(value) => patchCombatant(eid, c.id, { hpTemp: value })}
                      onSetDeathSaves={(patch) => patchCombatant(eid, c.id, patch)}
                      onRollDeathSave={() => rollDeathSave(c)}
                      deathSaveOutcome={deathSaveOutcome?.combatantId === c.id ? deathSaveOutcome.outcome : null}
                      onRollInitiative={() => rollCombatantInitiative(c)}
                      onSetInitiative={(value) => patchCombatant(eid, c.id, { initiative: value })}
                      onClearInitiative={() => patchCombatant(eid, c.id, { initiative: null })}
                      onAddCondition={(cond) => patchCombatant(eid, c.id, { addConditions: [cond] })}
                      onRemoveCondition={(cond) => patchCombatant(eid, c.id, { removeConditions: [cond] })}
                      onRename={(name) => patchCombatant(eid, c.id, { name })}
                      onSetHpMax={(value) => patchCombatant(eid, c.id, { hpMax: value })}
                      onSetTokenSize={(size) => setTokenSize(c.id, size)}
                      onPatchCombatant={(patch, targetEncounterId) => patchCombatant(targetEncounterId, c.id, patch)}
                      members={membersQuery.data}
                      onSetControllerUserId={canDmWrite ? (userId) => patchCombatant(eid, c.id, { controllerUserId: userId }) : undefined}
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
                      targeting={pendingActionUse && pendingActionUse.spec.targets.count > 0 ? { legal: actionLegalTargetIds.includes(c.id), selected: actionTargetIds.includes(c.id), declared: actionTargetsDeclared, atCapacity: actionTargetsAtCapacity, onToggle: () => toggleActionTarget(c.id) } : null}
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
                  enabledPackSlugs={campaign?.enabledPackSlugs ?? EMPTY_PACK_SLUGS}
                  installedPacks={packsQuery.data ?? EMPTY_RULE_PACKS}
                  customMechanicsProfile={campaign?.customMechanicsProfile}
                  onAdded={() => queryClient.invalidateQueries({ queryKey: queryKeys.encounter(eid) })}
                />
              )}
          </VttPanelSection>
          <VttPanelSection id="log" activeTabId={activePanelTab}>
              <CombatLog events={events} />
              <RulesLookupPanel
                campaignId={cid}
                ruleSystem={campaign?.ruleSystem || ''}
                enabledPackSlugs={campaign?.enabledPackSlugs ?? EMPTY_PACK_SLUGS}
                customMechanicsProfile={campaign?.customMechanicsProfile}
              />
          </VttPanelSection>
          <VttPanelSection id="table" activeTabId={activePanelTab}>
              {/* Player display / Cast controls (issue #547). In the cockpit these live
                  with the other table-wide setup rather than in the 54px header, which the
                  design reserves for identity, round state and the turn controls. */}
              {isDm && (
                <>
                  <div className="flex items-center gap-1.5 flex-wrap" role="group" aria-label="Player display">
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
                    <p className="text-xs text-muted m-0" role="status" data-testid="player-display-notice">
                      {castDisplayNotice}
                    </p>
                  )}
                </>
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
            {canEditEncounter && (
              <MonsterHpDisplayControl
                value={encounter.monsterHpDisplay}
                disabled={riskyBlocked}
                onChange={(mode) => {
                  void queueEncounterPatch({ monsterHpDisplay: mode });
                }}
              />
            )}
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
                    {encounterLifecycleSteps(initiativeRollSupported).map((step, i) => {
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
            {/* Issue #415: DM control to request a check/save from a character. DM-only; players see
                the resulting prompt above via CheckRequestPrompts. */}
            <ResourceTrackerPanel campaignId={cid} encounterId={eid} characters={characters} combatants={orderedCombatants} canDmWrite={canDmWrite} canPlayerWrite={canPlayerWrite} ownedCharacterIds={ownedCharacterIds} encounterWritable={encounter.status !== 'ended'} />
            {canDmWrite && (
              <>
                <CheckRequestPanel campaignId={cid} characters={characters} encounterId={eid} onError={surfaceActionError} />
                <EncounterQuickWhisperPanel campaignId={cid} myUserId={myUserId} onError={surfaceActionError} />
                {/* Issue #1308: place/move/label/delete persistent map icons (chests, traps,
                    doors, quest markers). DM-only mount gate; the objects themselves render
                    on the map for every role via MapObjectsOverlay, already server-redacted. */}
                <MapObjectsPanel encounterId={eid} objects={encounter.mapObjects} canDmWrite={canDmWrite} onError={surfaceActionError} />
              </>
            )}
            {canDmWrite && <GroupCheckBoard campaignId={cid} />}
            <EntityDiscussion campaignId={cid} entityType="encounter" entityId={encounter.id} />
          </VttPanelSection>
        </>
      }
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
      <TurnChangeBeat
        beat={turnBeat}
        isYourTurn={encounter?.status === 'running'
          && !characterOwnershipRefreshPending
          && turnOwnerPendingCombatantId == null
          && (turnOwnerFromEvent != null && turnOwnerFromEvent.combatantId === turnBeat?.combatantId
            ? turnOwnerFromEvent.isYourTurn
            : turnWorkspace?.current?.combatantId === currentCombatantId
              && turnWorkspace?.isYourTurn === true)}
      />
      {/* Issue #1919 "table side": visible-only, same convention as TurnChangeBeat above —
          the combat-log Announcer already covers this exact roll for every viewer via SR. */}
      {deathSaveSpectatorToast && (
        <div key={deathSaveSpectatorToast.id} className="cf-death-save-spectator-toast" data-testid="death-save-spectator-toast">
          {deathSaveSpectatorToast.message}
        </div>
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
    </EncounterVttShell>
  );
}

// ---------------------------------------------------------------------------

// `tokenInitials` is the shared grapheme-aware helper (issue #631): two-letter
// token labels from a combatant name ("Ashen cultist" -> "AC", "Goblin 1" -> "G1").

// DiceLog moved to features/dice/SharedDiceLog — rolls are now persisted
// server-side and shared by the whole table (issue #35).
