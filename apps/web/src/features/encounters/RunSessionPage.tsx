import { CombatLog } from './CombatLog';
import { ApplyDamageBar, BattleMap, type EncounterGridPatch } from './map/BattleMap';
import { AddCombatantPanel } from './combat/AddCombatantPanel';
import { CombatantRow, hpDisplay } from './combat/CombatantRow';
import { CombatantStatblock } from './combat/CombatantStatblock';
import { DmLifecycleHeader, EncounterSyncBanner } from './DmLifecycleHeader';
import { DEATH_STATE_LABEL } from './combat/DeathSaves';
import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { DetailPageWayfinding } from '../../components/DetailPageWayfinding';
import { PrintControl } from '../../components/PrintControl';
import { PrintOnly } from '../../components/PrintOnly';
import { useKeyboardCommandHint, useKeyboardGuardedAction } from '../../components/KeyboardCommandProvider';
import type { ActionSpec, ActionUndoToken, AoeTemplate, CastSessionCreated, Character, Combatant, CombatantRemoveResult, DiceRoll, DifficultyBand, EncounterDifficulty, EncounterEvent, EncounterWithCombatants, TurnWorkspace as TurnWorkspaceData, FogState, GenerateMapParams, GeneratedMapResult, HpResyncDirection, HpSyncConflict, MapPing, RulePack, TokenSize } from '@campfire/schema';
import { ARCHMAGE_ADAPTER_ID, STARFINDER_ADAPTER_ID, buildDifficultyExplanation, fogStatesEqual, LAIR_INITIATIVE_COUNT, LEGENDARY_ACTION_SLOT, ruleSystemAdapter } from '@campfire/schema';
import { entityTargetProps, entityHref } from '../../lib/entityLinks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, API, ApiError, isAmbiguousMutation, isReadTimeout, isStaleWrite, isTransientError, translateApiError } from '../../lib/api';
import { formatDateTime, formatTime, useFormattingLocale, useTimeFormat } from '../../lib/format';
import { queryKeys, invalidateCampaignCharacters, invalidateCampaignCheckRequests, invalidateEncounter, invalidateEncounterActions } from '../../lib/query';
import { newOperationId, useKeyedMutation } from '../../lib/keyedMutation';
import { beginReconcile, blocksFurtherActions, clearReconcile, completeReconcile, IDLE_RECONCILE, isAmbiguousOutcome, type ReconcileState } from '../../lib/ambiguousMutation';
import { useCampaignEvents, type CampaignEventsStatus } from '../../lib/useCampaignEvents';
import { inlineCharacterSheetsInteractive, inlineCharacterSheetsStatusLabel, shouldInvalidateInlineCharacters } from './inlineCharacterCards';
import { endedSummaryTallies } from './encounterEndedSummary';
import { filterPlayerSafeCombatants } from '../screen/playerSafe';
import { applyOptimisticHpDelta, replayOptimisticHpDeltas, type OptimisticHpDelta } from './optimisticHp';
import { applyOptimisticSpellSlotDelta } from './optimisticSpellSlots';
import { FloatingNumbers } from './FloatingNumbers';
import { diffHpFeedback, hpFeedbackSnapshot, sameHpFeedbackSnapshot, withOptimisticHpFeedbackTargets, type HpFeedbackEvent, type HpFeedbackSnapshot } from './hpFeedback';
import { hasRestoredTrashedEncounter, isCurrentCombatantUndoEncounter, REMOVE_COMBATANT_CONFIRM_BODY } from './combatantLifecycle';
import { isAdjacentDuplicateEncounterPatch, observedEncounterPatchRevision, reconcileEncounterPatchResponse, rollbackEncounterPatchError, type QueuedEncounterPatch } from './encounterPatchQueue';
import { pendingFogForEncounter, type ScopedPendingFog } from './fogSyncState';
import { EncounterAftermathPanel } from './EncounterAftermathPanel';
import { TurnWorkspace } from './TurnWorkspace';
import { PlayerVitalsHeader } from './PlayerVitalsHeader';
import { TurnChangeBeat, type TurnChangeBeatEvent } from './TurnChangeBeat';
import { detectSseTurnBeat, type TurnBeatSnapshot } from './turnBeat';
import { initials as tokenInitials } from '../../lib/avatarText';
import { useAuth } from '../../app/auth';
import { useCampaignAccess } from '../../app/CampaignAccessContext';
import { useCampaign } from '../../app/CampaignContext';
import { SharedDiceLog } from '../dice/SharedDiceLog';
import { EntityDiscussion } from '../comments/EntityDiscussion';
import { ResourceTrackerPanel } from "./ResourceTrackerPanel";
import { CheckRequestPanel } from './CheckRequests';
import { ActionUsePanel } from './ActionUseFlow';
import { Card, Btn, TextInput, Skeleton, ErrorNote, EmptyState } from '../../components/ui';
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
import { prefersReducedMotion, scrollBehavior } from '../../lib/prefersReducedMotion';
import { deleteConfirmCopy, dmLifecycleActions, isLifecycleConfirmValid } from './encounterLifecycleActions';
import { CONNECTING_GRACE_MS, confirmEncounterOverride, deriveEncounterSyncState, ENCOUNTER_OVERRIDE_INACTIVE, encounterActionsBlocked, encounterOverrideAuthorized, encounterOverrideOfferable, encounterSyncBannerMessage, encounterSyncChipClass, encounterSyncChipLabel, encounterSyncOverrideBannerKey, encounterSyncRevisionFromUpdatedAt, ENCOUNTER_SYNC_CHIP_TESTID, isConnectingGraceElapsed, revokeEncounterOverrideIfUnauthorized, settleEncounterOverride, type EncounterOverrideAuthority, type EncounterOverrideState, type EncounterSyncRevision } from './encounterSyncState';
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

function InitiativeStrip({
  combatants,
  currentCombatantId,
  charactersById,
  turnPulse = false,
  hpFeedbackByCombatant,
}: {
  combatants: readonly Combatant[];
  currentCombatantId: number | null;
  charactersById: Map<number, Character>;
  turnPulse?: boolean;
  hpFeedbackByCombatant: ReadonlyMap<number, readonly (HpFeedbackEvent & { id: number })[]>;
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
        const feedback = hpFeedbackByCombatant.get(c.id) ?? [];
        const feedbackClass = feedback.some((event) => event.kind === 'down')
          ? ' cf-hp-feedback-anchor--down'
          : feedback.some((event) => event.kind === 'revive')
            ? ' cf-hp-feedback-anchor--revive'
            : feedback.some((event) => event.crit)
              ? ' cf-hp-feedback-anchor--crit'
              : '';

        return (
          <div
            key={c.id}
            className={`cf-hp-feedback-anchor flex flex-col items-center gap-1 flex-none${feedbackClass}`}
            style={{ scrollSnapAlign: 'center' }}
            ref={(el) => {
              if (isCurrent && el) {
                el.scrollIntoView({ behavior: scrollBehavior(), block: 'nearest', inline: 'center' });
              }
            }}
          >
            <div
              aria-current={isCurrent ? 'true' : undefined}
              className={`flex items-center justify-center overflow-hidden bg-surface ${isCurrent && turnPulse ? 'cf-turn-beat-pulse' : ''}`}
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
            <FloatingNumbers events={feedback} />
            <span className="text-muted" style={{ fontSize: 10, lineHeight: 1 }}>
              {hpDisplay(c)}
            </span>
          </div>
        );
      })}
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
      document.querySelector<HTMLElement>('[data-testid="turn-workspace"]')?.scrollIntoView({
        behavior: scrollBehavior(),
        block: 'nearest',
      });
    }
  }, []);

  useEffect(() => {
    previousTurnBeatRef.current = null;
    ownedTurnFeedbackRef.current = null;
    setTurnOwnerFromEvent(null);
    setTurnOwnerPendingCombatantId(null);
    setTurnBeat(null);
    setTurnPulse(false);
    if (turnPulseTimerRef.current != null) window.clearTimeout(turnPulseTimerRef.current);
  }, [eid]);

  // A loaded encounter is a silent baseline. This prevents opening an already
  // running encounter (or any ordinary refetch) from replaying a turn-start beat,
  // while keeping the baseline current if the stream missed an intervening edge.
  useEffect(() => {
    if (!encounter || encounter.id !== eid) return;
    const current = encounter.currentCombatantId == null
      ? undefined
      : encounter.combatants.find((combatant) => combatant.id === encounter.currentCombatantId);
    const isYourTurn = current?.characterId != null
      && characters.some((character) => character.id === current.characterId && character.ownerUserId === String(me?.user.id ?? ''));
    previousTurnBeatRef.current = {
      encounterId: eid,
      combatantId: encounter.currentCombatantId,
      round: encounter.status === 'running' ? encounter.round : null,
      isYourTurn,
    };
  }, [eid, encounter, characters, me?.user.id]);
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
          invalidateCampaignCharactersForOwnership();
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
            isYourTurn,
          };
          const previous = previousTurnBeatRef.current?.encounterId === eid
            ? previousTurnBeatRef.current
            : null;
          const kind = detectSseTurnBeat(previous, next);
          previousTurnBeatRef.current = next;
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
      },
      [eid, cid, navigate, queryClient, addPing, encounter?.combatants, characters, charactersQuery.data, charactersQuery.isFetching, me?.user.id, triggerOwnedTurnFeedback, invalidateCampaignCharactersForOwnership],
    ),
    // The stream was down for a while — refetch encounter + character sheets.
    onReconnect: useCallback(() => {
      setResyncPending(true);
      invalidateEncounter(queryClient, eid);
      invalidateCampaignCharactersForOwnership();
      invalidateCampaignCheckRequests(queryClient, cid);
      // Same staleness the character.updated SSE branch above fixes (issue #1900
      // review): a dropped-then-recovered stream must not leave the Spellbook's
      // /turn-sourced slots/spells stale either.
      void queryClient.invalidateQueries({ queryKey: queryKeys.encounterTurn(eid) });
    }, [queryClient, eid, cid, invalidateCampaignCharactersForOwnership]),
    // Parser recovery (connection stayed up) — same catch-up refetch.
    onStreamRecovery: useCallback(() => {
      setResyncPending(true);
      invalidateEncounter(queryClient, eid);
      invalidateCampaignCharactersForOwnership();
      invalidateCampaignCheckRequests(queryClient, cid);
      void queryClient.invalidateQueries({ queryKey: queryKeys.encounterTurn(eid) });
    }, [queryClient, eid, cid, invalidateCampaignCharactersForOwnership]),
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
    onError: (err, _vars, ctx) => {
      const queue = optimisticHpQueueRef.current;
      if (
        ctx?.encounterId === eid &&
        queue.encounterId === eid &&
        ctx.optimisticOperationId &&
        queue.operations.delete(ctx.optimisticOperationId)
      ) {
        replayPendingOptimisticHpDeltas();
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
        const queue = optimisticHpQueueRef.current;
        const queuedCombatants = queue.encounterId === eid && queue.base && queue.operations.size > 0
          ? replayOptimisticHpDeltas(
              queue.base.combatants,
              [...queue.operations.values()].sort((a, b) => a.sequence - b.sequence).map(({ combatantId, delta: pendingDelta }) => ({ combatantId, delta: pendingDelta })),
              ruleSystem,
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
          targets.has(c.id) ? applyOptimisticHpDelta(c, delta, ruleSystem) : c,
        );
        appendHpFeedbackEvents(diffHpFeedback(hpFeedbackSnapshot(feedbackBaseline), optimisticCombatants));
        const snapshot = hpFeedbackSnapshotRef.current;
        if (snapshot?.encounterId === eid) {
          for (const combatant of optimisticCombatants) {
            if (targets.has(combatant.id)) snapshot.combatants.set(combatant.id, combatant);
          }
        }
        queryClient.setQueryData<EncounterWithCombatants>(queryKeys.encounter(eid), {
          ...previous,
          combatants: optimisticCombatants,
        });
      }
      const bulkOperationId = newOperationId();
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
      try {
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
        if (previous) {
          queryClient.setQueryData(queryKeys.encounter(eid), previous);
          seedHpFeedbackSnapshot(previous);
        }
        // Same rule as the single-target stepper: an unknown outcome is not a failure.
        if (isAmbiguousOutcome(err)) enterReconciling();
        else reportError(err);
        throw err;
      }
    },
    [eid, queryClient, reportError, ruleSystem, enterReconciling, isDm, seedHpFeedbackSnapshot, appendHpFeedbackEvents],
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
        <DmLifecycleHeader
          canDmWrite={canDmWrite}
          lifecycle={lifecycle}
          headerBusy={headerBusy}
          riskyBlocked={riskyBlocked}
          needsInitiativeCount={needsInitiativeCount}
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
        />
      </div>

      <EncounterSyncBanner
        encounterSyncBanner={encounterSyncBanner}
        encounterSyncLastSyncTitle={encounterSyncLastSyncTitle}
      />

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
          hpFeedbackByCombatant={hpFeedbackByCombatant}
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
          turnPulse={turnPulse}
          currentCombatantId={currentCombatantId}
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
              turnPulse={turnPulse}
              hpFeedbackByCombatant={hpFeedbackByCombatant}
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
                  hpFeedbackEvents={hpFeedbackByCombatant.get(c.id) ?? []}
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
                  statblock={isDm && c.ruleEntryId != null ? <CombatantStatblock ruleEntryId={c.ruleEntryId} ruleSystem={ruleSystem} campaignId={cid} /> : undefined}
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
      <ResourceTrackerPanel campaignId={cid} encounterId={eid} characters={characters} combatants={orderedCombatants} canDmWrite={canDmWrite} canPlayerWrite={canPlayerWrite} ownedCharacterIds={ownedCharacterIds} encounterWritable={encounter.status !== 'ended'} />

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

// DiceLog moved to features/dice/SharedDiceLog — rolls are now persisted
// server-side and shared by the whole table (issue #35).
