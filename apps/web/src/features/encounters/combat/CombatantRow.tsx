import { useEffect, useMemo, useReducer, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ActionSpec, Character, Combatant, TokenSize, CustomMechanicsProfile, UsableAction } from '@campfire/schema';
import { defaultCombatantStatblock, hasDeathSavesForAdapter, ruleSystemAdapter, STARFINDER_ADAPTER_ID } from '@campfire/schema';
import { UIIcon } from '../../../components/UIIcon';
import { GameIcon } from '../../../components/GameIcon';
import { CharacterStatCard } from '../../../components/CharacterStatCard';
import { Btn, HpBar, TextInput } from '../../../components/ui';
import { GatedControl } from '../../../components/GatedControl';
import { isImeComposing } from '../../../lib/compositionSafeSubmit';
import { NOTE_VISIBILITY_ICON, UI_ICON_SIZE } from '../../../lib/uiIcons';
import { CombatantActionsList } from '../CombatantActionsList';
import { EncounterWhisperComposer } from '../EncounterWhisperComposer';
import { CombatantStatblockEditor } from '../CombatantStatblockEditor';
import { isDown } from '../encounterEndedSummary';
import { canStabilizeCombatant } from '../combatantLifecycle';
import { TOKEN_SIZE_OPTIONS } from '../map/BattleMap';
import { FloatingNumbers } from '../FloatingNumbers';
import type { HpFeedbackEvent } from '../hpFeedback';
import { DEATH_STATE_LABEL, DeathSaveTracker } from './DeathSaves';
import type { DeathSaveOutcome } from './deathSaveOutcome';
import { CONDITION_TIMING_OPTIONS, SAVE_TIMING_OPTIONS, buildConditionInstance, conditionDraftFromInstance, conditionSourceLabel, emptyConditionDraft, type ConditionDraft, type ConditionSourceOption, type ConditionTiming } from './conditionDraft';
import { initialStatblockDraftState, statblockDraftReducer, statblockPatchForCommit } from './combatantStatblockDraft';
import { RulesHintPopover } from '../../../components/RulesHintPopover';
import { conditionHintKey, rulesHintCompendiumHref } from '../../../lib/rulesHints';

const HP_BAND_LABEL: Record<string, string> = { healthy: 'Healthy', bloodied: 'Bloodied', critical: 'Critical', down: 'Down' };
const HP_BAND_PCT: Record<string, number> = { healthy: 100, bloodied: 50, critical: 20, down: 0 };
const HP_BAND_TONE: Record<string, string> = { healthy: '', bloodied: 'low', critical: 'crit', down: 'crit' };

function HpBandBar({ band }: { band: string | null }) {
  const pct = band ? (HP_BAND_PCT[band] ?? 0) : 0;
  const tone = band ? (HP_BAND_TONE[band] ?? '') : '';
  return <div className={`cf-hp ${tone}`}><div style={{ width: `${pct}%` }} /></div>;
}

export function hpDisplay(combatant: Pick<Combatant, 'hpCurrent' | 'hpMax' | 'hpBand'>): string {
  if (combatant.hpCurrent != null && combatant.hpMax != null) return `${combatant.hpCurrent} / ${combatant.hpMax}`;
  return combatant.hpBand ? (HP_BAND_LABEL[combatant.hpBand] ?? '—') : '—';
}

type StatblockPatch = Record<string, unknown>;

export type CombatantRowProps = {
  rowRef?: (el: HTMLDivElement | null) => void;
  encounterId: number;
  combatant: Combatant;
  hpFeedbackEvents: readonly (HpFeedbackEvent & { id: number })[];
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
  /** Issue #1914: turn-topology writes stay gated by riskyBlocked, not own-combatant syncBlocked. */
  turnTopologyBlocked?: boolean;
  canEditIdentity: boolean;
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
  /** Route campaign id — stable ID for operations like whisper notes not tied to sheet staleness. */
  routeCampaignId?: number;
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
  /** Issue #1922: open the group action runner for a monster/NPC action row — same DM-only
   *  gating as `onUseMonsterAction`, plus the fetched `UsableAction` row itself. */
  onUseGroupAction?: (actionIndex: number, actionName: string, spec: ActionSpec, action: UsableAction) => void;
  busy: boolean;
  /** Condition chips offered by the active campaign's rule-system adapter (issue #234). */
  conditionSuggestions: readonly string[];
  /** Visible combatants that may be recorded as the source/caster of a condition (issue #423). */
  conditionSourceOptions: readonly ConditionSourceOption[];
  /** Best default source for new conditions: usually the current turn actor. */
  defaultConditionSourceCombatantId: number | null;
  /** Active campaign's rule system — selects the statblock adapter (issue #234). */
  ruleSystem: string | null;
  customMechanicsProfile?: CustomMechanicsProfile | null;
  onHpDelta: (delta: number) => void;
  onSetTempHp: (value: number) => void;
  onSetDeathSaves: (patch: { deathSaveSuccesses?: number; deathSaveFailures?: number }) => void;
  /** Roll a death save through the server-authoritative d20 + shared dice-log action. */
  onRollDeathSave: () => void;
  /** Issue #1919: this combatant's just-settled death-save outcome, or null once faded. */
  deathSaveOutcome?: DeathSaveOutcome | null;
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
  /**
   * Returns whether the write actually landed (issue #1992 review) — never rejects, both
   * outcomes RESOLVE `{ ok }` — so the statblock editor's save-on-blur can await it and keep
   * its draft on a rejected write instead of discarding it. Every other call site here still
   * ignores the return value, unaffected.
   *
   * `encounterId` (issue #1992 round 7, Devin): every call site passes THIS row's own
   * `encounterId` prop explicitly, rather than letting the parent resolve it implicitly at
   * send time. This matters specifically for the statblock save-on-blur's unmount-triggered
   * flush (`commitStatblock`): a route change to a DIFFERENT encounter does not remount
   * `RunSessionPage` (only its children, this row included, unmount while it renders `null`
   * for the new encounter's loading state) — and because `useMutation`'s returned
   * `mutate`/`mutateAsync` all delegate to ONE observer instance that persists across the
   * page's own renders, a call made from this row's STALE unmount-cleanup closure would
   * otherwise resolve the PARENT's now-changed `eid`, not the encounter this combatant
   * actually belongs to — PATCHing the new encounter with an id it never had (404), and
   * silently losing the draft (a rejected write leaves `dirty` alone by design, but the
   * component is mid-unmount and never gets to retry). Passing this row's OWN prop, read
   * normally rather than resolved through that shared, mutable-in-place observer, closes it.
   */
  onPatchCombatant?: (
    patch: StatblockPatch,
    encounterId: number,
  ) =>
    Promise<{ ok: boolean }> | void;
  onPatchSourceTurnState?: (combatantId: number, patch: Record<string, unknown>) => void;
  legendaryActions?: Combatant['legendaryActions'];
  onUseLegendary?: () => void;
  onReleaseLegendary?: () => void;
  onDuplicate?: () => void;
  onRemove: () => void;
  /** Existing Stage 3 statblock loader rendered by the parent without moving it early. */
  statblock?: ReactNode;
  targeting?: { legal: boolean; selected: boolean; declared: boolean; atCapacity: boolean; onToggle: () => void } | null;
  /**
   * Color-vision-assist mode (issue #1942): adds a current-turn chevron beside the
   * accent border/tint, and an HP danger glyph beside the color-only bar tone.
   */
  colorVisionAssist?: boolean;
  /**
   * Issue #1926: a monster/npc just dropped to 0 HP with its statblock still hidden — show
   * the one-tap "reveal to players?" prompt on this (DM) row. Never shown for a non-DM;
   * the parent derives this from `shouldShowKillPrompt` + its own per-session dismissed set.
   */
  showKillPrompt?: boolean;
  /** Dismiss the kill prompt for this combatant for the rest of the session (client-local only). */
  onDismissKillPrompt?: () => void;
  isDm?: boolean;
  myUserId?: string | number;
  /**
   * Issue #1939: campaign id for condition-tag rules-hint popovers' "Full rule" link.
   * Deliberately separate from `campaignId` above, which goes `undefined` whenever the
   * viewer lacks edit permission or sheets are stale — the rules-hint popover is public
   * rules text identical for DM and players (criterion 4) and must not depend on that.
   */
  rulesHintCampaignId?: number;
  /** Issue #1939: whether the campaign's resolved rule pack has searchable compendium
   *  entries — gates the "Full rule" link on condition-tag rules-hint popovers. */
  rulesHintCompendiumAvailable?: boolean;
};

export function CombatantRow({
  rowRef,
  encounterId,
  combatant,
  hpFeedbackEvents,
  isCurrentTurn,
  canEditPermission,
  syncBlocked,
  turnTopologyBlocked,
  canEditIdentity,
  statblock,
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
  onUseGroupAction,
  busy,
  conditionSuggestions,
  conditionSourceOptions,
  defaultConditionSourceCombatantId,
  ruleSystem,
  customMechanicsProfile,
  onHpDelta,
  onSetTempHp,
  onSetDeathSaves,
  onRollDeathSave,
  deathSaveOutcome,
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
  onDuplicate,
  onRemove,
  targeting = null,
  colorVisionAssist = false,
  showKillPrompt = false,
  onDismissKillPrompt,
  isDm = false,
  myUserId,
  rulesHintCampaignId,
  rulesHintCompendiumAvailable = false,
}: CombatantRowProps) {
  const { t } = useTranslation();
  const [showWhisper, setShowWhisper] = useState(false);
  // Issue #1746: one shared reason string for every write control this row disables while
  // the sync gate blocks — kept as a single computed value so every site stays in agreement
  // rather than re-deriving (and risking drift on) the same condition. Exposed to assistive
  // tech via `aria-describedby` (below) rather than `title` alone, which screen readers
  // announce inconsistently and keyboard-only users cannot reach at all.
  const effectiveTurnTopologyBlocked = turnTopologyBlocked ?? syncBlocked;
  const syncBlockedReason = syncBlocked ? t('run.gate.syncBlocked') : undefined;
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

  const adapter = useMemo(
    () => ruleSystemAdapter(ruleSystem, customMechanicsProfile),
    [ruleSystem, customMechanicsProfile],
  );
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
      onPatchCombatant(editingConditionId ? { updateConditionInstance: instance } : { addConditionInstance: instance }, encounterId);
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

  // Issue #1992 — whole-statblock combatant PATCH concurrency guard. Same "local draft,
  // committed on blur" shape as initDraft/nameDraft above, but the draft is a whole
  // CombatantStatblock object and the commit carries `expectedStatblock` (paired with the
  // draft's base, never refreshed at send time — see combatantStatblockDraft.ts for why).
  // Guards against the statblock's OWN prior CONTENT, not a row/encounter revision proxy —
  // an earlier round tried a per-combatant revision token and found it still too coarse
  // (an hp/condition/position write to this same combatant advanced it without touching
  // the statblock, making an edit session un-savable from unrelated activity); see the
  // module doc for the full story.
  const [statblockDraftState, dispatchStatblockDraft] = useReducer(
    statblockDraftReducer,
    undefined,
    () => initialStatblockDraftState(combatant.statblock ?? defaultCombatantStatblock()),
  );
  useEffect(() => {
    if (combatant.statblock) {
      dispatchStatblockDraft({ type: 'external', statblock: combatant.statblock });
    }
  }, [combatant.statblock]);

  // Issue #1992 review (Devin, round 9): a commit can be triggered by a genuine user
  // action (the blur handler below) or by one of TWO fully automatic paths (the unmount
  // flush, the sync-gate-lift flush) — every caller states which, explicitly, so
  // `commitStatblock` itself is the ONE place that enforces "an automatic flush must not
  // resend a draft that is only pending because of a round-8 rebase" (see
  // `awaitingReedit`'s doc in combatantStatblockDraft.ts). Enforcing this here, once,
  // rather than duplicating the check at each of the three call sites, is the fix: the
  // round-9 bug was exactly that the rule lived only in a comment plus one guard.
  function commitStatblock(trigger: 'explicit' | 'automatic') {
    const patch = statblockPatchForCommit(statblockDraftState);
    if (!patch) return;
    // Issue #1992 review (Copilot): gate this write by the sync gate too, matching every
    // OTHER write control in this file (see the `syncBlocked` prop doc above). Skip rather
    // than drop the draft — same choice this round's other findings converge on. Once the
    // gate lifts, the effect below flushes it automatically.
    if (syncBlocked) return;
    // Issue #1992 review (Devin, round 8): at most ONE statblock write in flight per row —
    // not merely a dedupe of the SAME revision (the round-2 shape this replaces). A blur
    // immediately followed by an unmount, OR a blur followed by refocus-edit-blur inside
    // one round-trip, both land here; the prior "skip only if THIS exact revision is
    // in-flight" rule let a genuinely NEWER edit send immediately, carrying the SAME stale
    // `expectedStatblock` as the write still outstanding — the server's content-compare
    // then rejected the user's OWN second save as a conflict with their first. Deferring
    // instead of dropping: the draft stays `dirty`, and the accepted-triggered effect below
    // resends it the moment the outstanding write is CONFIRMED ACCEPTED, rebased on the
    // base that acceptance just confirmed — never on the stale one this call started from.
    if (inFlightRef.current) return;
    // Issue #1992 review (Devin, round 9): after a rejected write's base is re-seeded by
    // `external` (`awaitingReedit`), only an EXPLICIT trigger (the user actually blurring
    // the field) may send — an AUTOMATIC one (unmount, sync-gate-lift) must not, because
    // the draft is still the user's untouched, already-rejected content and the base now
    // matches a genuine OTHER writer's change: sending it would silently overwrite that
    // writer, exactly the bug this whole guard exists to prevent. A further `edit` clears
    // `awaitingReedit` itself (see the reducer), so this only ever blocks the two
    // automatic paths, never a real subsequent edit-then-blur.
    if (statblockDraftState.awaitingReedit && trigger !== 'explicit') return;
    // Issue #1992: expectedStatblock is a CONTENT compare against the row's own stored
    // statblock — separate from expectedUpdatedAt (the encounter-wide token). An earlier
    // round tried a per-combatant REVISION token instead and found it still too coarse: it
    // advanced on an hp/condition/position write to this same combatant, none of which
    // touch the statblock, so it falsely invalidated an in-progress edit.
    const result = onPatchCombatant?.({ statblock: patch.statblock, expectedStatblock: patch.expectedStatblock }, encounterId);
    // Issue #1992 review (Devin, round 9, finding 2): only claim the in-flight slot when
    // there is actually a promise that will release it. `onPatchCombatant`'s type permits
    // an absent callback or a `void` return; claiming the slot unconditionally (as before)
    // left `inFlightRef.current` stuck `true` for the row's remaining lifetime in that
    // case, since an optional-chained `then` call is then a no-op and nothing ever clears it — every
    // later commit attempt would silently no-op via the in-flight guard above. Latent
    // today (`RunSessionPage` always returns a promise), fixed anyway since it's cheap and
    // this exact shape (a flag set unconditionally, cleared only inside a callback that
    // might never run) is the recurring failure pattern across every round of this issue.
    if (!result) return;
    inFlightRef.current = true;
    // Issue #1992 review (coordinator): only mark this REVISION accepted once the write is
    // CONFIRMED to have landed. `onPatchCombatant` never rejects (it resolves { ok: false }
    // on a failed write, e.g. STALE_WRITE), so this never throws.
    result.then((outcome) => {
      inFlightRef.current = false;
      // Issue #1992 review (Devin + Kilo, generalized in round 5): the reducer itself
      // decides whether `dirty` clears (only if `patch.revision` still matches — a newer
      // edit made WHILE this write was in flight must not be marked done by it) and always
      // adopts `patch.statblock` (what THIS write actually sent, now confirmed stored) as
      // the fresh base, regardless of whether a newer edit is now pending. See the
      // reducer's `accepted` case and combatantStatblockDraft.ts's module doc for the full
      // reasoning.
      if (outcome.ok) dispatchStatblockDraft({ type: 'accepted', revision: patch.revision, statblock: patch.statblock });
      // Issue #1992 review (Devin, round 8): dispatch `rejected` rather than nothing —
      // `dirty` stays true (whatever the CURRENT revision is) so the draft survives the
      // settle-triggered refetch exactly as before, but this also flags the base as stale
      // so the settle-triggered `external` (see combatantPatch.onSettled, which invalidates
      // unconditionally on both outcomes) is allowed to refresh `baseStatblock` — the
      // recovery path that keeps a genuine conflict from becoming unsavable without a
      // reload. The generic error toast (`combatantPatch.onError`) already tells the user
      // their save was rejected; this just makes it possible to save again afterward.
      else dispatchStatblockDraft({ type: 'rejected', revision: patch.revision });
    });
  }
  // True while a statblock write for this row is awaiting its server response (issue #1992
  // review, Devin's double-send finding; round 8 widened this from a per-revision token to
  // a plain in-flight flag — see commitStatblock's doc for why).
  const inFlightRef = useRef(false);
  // Always-latest ref so the unmount effect below calls the CURRENT commitStatblock (current
  // draft/base-token/callback), not the one closed over when the component first mounted.
  const commitStatblockRef = useRef(commitStatblock);
  commitStatblockRef.current = commitStatblock;
  // Issue #1992 review (Devin, round 8): once an outstanding write is CONFIRMED ACCEPTED —
  // `baseRevision` only ever advances via `accepted`, never via `rejected` or a routine
  // `external` — flush a newer edit that was queued behind it while it was in flight,
  // rebased on the base that acceptance just confirmed. Deliberately NOT triggered by a
  // rejection: auto-resending the SAME (now stale) draft the instant the base is re-seeded
  // would silently overwrite a genuine concurrent writer's change with no new decision from
  // the user — exactly the bug this whole guard exists to prevent. A rejected save instead
  // waits for an explicit new user action (another edit, or simply blurring the field again).
  useEffect(() => {
    if (statblockDraftState.dirty && !inFlightRef.current) {
      // Issue #1992 review (Devin, round 9): this is an AUTOMATIC flush — see
      // commitStatblock's `awaitingReedit` gate for why that distinction matters here.
      commitStatblockRef.current('automatic');
    }
    // Dependency array is deliberately just `baseRevision`, not `dirty` — this must fire
    // only on a write's OWN acceptance, never on every draft change; see the comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statblockDraftState.baseRevision]);
  // Issue #1992 review: flush one last save attempt on unmount. `RunSessionPage` is reused
  // across an `eid` change (no remount of the page itself), but every CombatantRow for the
  // OLD encounter's combatants DOES unmount then (their `key`s vanish from the new roster) —
  // this is the scenario the issue's third acceptance criterion (an edit queued just before
  // switching away must not be silently lost) actually exercises, since save-on-blur has no
  // timer/queue to leak across that switch in the first place (see module doc). Not a
  // guarantee against a hard tab close/crash — no client-side mechanism can promise that;
  // this matches the same, already-accepted exposure of the sibling nameDraft/initDraft
  // blur-commit fields in this file. Round 9: this is an AUTOMATIC flush — see
  // commitStatblock's `awaitingReedit` gate.
  useEffect(() => {
    return () => {
      commitStatblockRef.current('automatic');
    };
  }, []);
  // Issue #1992 review (Copilot): once the sync gate LIFTS, flush a draft that arrived while
  // it was up, rather than leaving it stranded until the user happens to touch the field
  // again. Only fires on the true -> false transition (not on mount, and not while it stays
  // blocked or stays clear). Round 9: this is an AUTOMATIC flush — see commitStatblock's
  // `awaitingReedit` gate.
  const wasSyncBlockedRef = useRef(syncBlocked);
  useEffect(() => {
    if (wasSyncBlockedRef.current && !syncBlocked) {
      commitStatblockRef.current('automatic');
    }
    wasSyncBlockedRef.current = syncBlocked;
  }, [syncBlocked]);

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
  const feedbackClass = hpFeedbackEvents.some((event) => event.kind === 'down')
    ? ' cf-hp-feedback-anchor--down'
    : hpFeedbackEvents.some((event) => event.kind === 'revive')
      ? ' cf-hp-feedback-anchor--revive'
      : hpFeedbackEvents.some((event) => event.crit)
        ? ' cf-hp-feedback-anchor--crit'
        : '';
  const targetSelectionUnavailable = targeting?.legal && targeting.atCapacity && !targeting.selected;

  return (
    <div
      ref={rowRef}
      data-testid={`combatant-row-${combatant.id}`}
      data-current-turn={isCurrentTurn ? 'true' : undefined}
      data-target-legal={targeting?.legal ? 'true' : undefined}
      data-target-selected={targeting?.selected ? 'true' : undefined}
      className={`cf-hp-feedback-anchor${feedbackClass}`}
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 10,
        padding: '9px 14px',
        borderLeft: `2px solid ${edgeColor}`,
        background: isCurrentTurn ? 'color-mix(in srgb, var(--color-accent) 8%, transparent)' : 'transparent',
        boxShadow: targeting?.selected ? '0 0 0 2px var(--color-accent)' : targeting?.legal && !targeting?.declared && !targetSelectionUnavailable ? '0 0 0 1px white' : isCurrentTurn ? '0 0 0 1px color-mix(in srgb, var(--color-accent) 35%, transparent)' : 'none',
        opacity: down ? 0.55 : targetSelectionUnavailable ? 0.65 : 1,
        filter: down ? 'grayscale(0.75)' : 'none',
      }}
      onClick={(event) => {
        if (!targeting?.legal || targeting.declared || targetSelectionUnavailable) return;
        const interactive = (event.target as HTMLElement).closest('button, input, select, textarea, a, label, summary, [role="button"], [data-combatant-statblock], [data-combatant-detail]');
        if (interactive && interactive !== event.currentTarget) return;
        targeting.onToggle();
      }}
    >
      <FloatingNumbers events={hpFeedbackEvents} />
      {targeting?.legal && (
        <button
          type="button"
          className="btn btn-ghost cf-target-44"
          data-testid={`combatant-target-toggle-${combatant.id}`}
          aria-label={targetSelectionUnavailable ? `Target limit reached; ${combatant.name} cannot be selected` : `${targeting.selected ? 'Remove' : 'Select'} ${combatant.name} as an action target`}
          aria-pressed={targeting.selected}
          disabled={targeting.declared || targetSelectionUnavailable}
          title={targetSelectionUnavailable ? 'Target limit reached' : undefined}
          onClick={targeting.onToggle}
          style={{ flex: 'none', padding: '0 8px', fontSize: 12 }}
        >
          {targeting.selected ? 'Targeted' : 'Target'}
        </button>
      )}
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
              aria-describedby={effectiveTurnTopologyBlocked ? syncBlockedReasonId : undefined}
              value={combatant.initiativeGroup ?? (combatant.kind === 'character' ? 'party' : 'monsters')}
              onChange={(e) => onPatchCombatant?.({ initiativeGroup: e.target.value }, encounterId)}
              disabled={busy || effectiveTurnTopologyBlocked || !canSetInitiative}
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
              disabled={busy || effectiveTurnTopologyBlocked}
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
              onChange={(e) => onPatchCombatant?.({ initiativeGroup: e.target.value }, encounterId)}
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
            {colorVisionAssist && isCurrentTurn && (
              <span
                data-testid={`combatant-row-turn-chevron-${combatant.id}`}
                aria-hidden="true"
                style={{ color: 'var(--color-accent)', fontSize: 12 }}
              >
                ▸
              </span>
            )}
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
        {/* Issue #1926: one-tap kill prompt — a monster/npc just dropped to 0 HP with its
            statblock still hidden. Never automatic: the DM must tap Reveal or Dismiss.
            Dismissing sticks for this combatant for the rest of the session (see
            `shouldShowKillPrompt`/`dismissKillPrompt`) and leaves the manual toggle below
            available regardless. */}
        {showKillPrompt && (
          <div
            role="status"
            data-testid={`kill-prompt-${combatant.id}`}
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              flexWrap: 'wrap',
              marginTop: 4,
              marginBottom: 4,
              padding: '6px 8px',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--color-divider)',
              fontSize: 12,
            }}
          >
            <span>{t('encounters.statblock.killPrompt', { name: combatant.name })}</span>
            <button
              type="button"
              className="btn btn-ghost !min-h-8 text-xs"
              disabled={busy || syncBlocked}
              aria-describedby={syncBlockedDescribedBy}
              title={syncBlockedReason}
              onClick={() => {
                onPatchCombatant?.({ statblockRevealed: true }, encounterId);
                onDismissKillPrompt?.();
              }}
            >
              {t('encounters.statblock.reveal')}
            </button>
            <button
              type="button"
              className="btn btn-ghost !min-h-8 text-xs"
              aria-label={t('encounters.statblock.dismissKillPrompt')}
              onClick={onDismissKillPrompt}
            >
              {t('encounters.statblock.dismiss')}
            </button>
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
              onSet={onSetDeathSaves}
              onRoll={onRollDeathSave}
              outcome={deathSaveOutcome}
            />
          )}
        {(combatant.conditionInstances?.length ?? 0) > 0 ? (
          <div id={`combatant-${combatant.id}-conditions`} tabIndex={-1} style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
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
                  {(() => {
                    // Issue #1939: undefined on any adapter without an authored hint
                    // (every non-5e system today) — no affordance renders.
                    const hintKey = conditionHintKey(adapter.id, inst.name);
                    if (!hintKey) return null;
                    return (
                      <RulesHintPopover
                        termId={inst.id || inst.name}
                        termLabel={inst.name}
                        hintKey={hintKey}
                        compendiumHref={
                          rulesHintCompendiumAvailable && rulesHintCampaignId != null
                            ? rulesHintCompendiumHref(rulesHintCampaignId, inst.name)
                            : undefined
                        }
                      />
                    );
                  })()}
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
                        onClick={() => onPatchCombatant ? onPatchCombatant({ removeConditionInstanceId: inst.id }, encounterId) : onRemoveCondition(inst.name)}
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
          <div id={`combatant-${combatant.id}-conditions`} tabIndex={-1} style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
            {combatant.conditions.map((cond) => {
              // Issue #1939: undefined on any adapter without an authored hint (every
              // non-5e system today) — no affordance renders.
              const hintKey = conditionHintKey(adapter.id, cond);
              return (
              <span key={cond} className="tag tag-outline" style={{ gap: 6 }}>
                {cond}
                {hintKey && (
                  <RulesHintPopover
                    termId={cond}
                    termLabel={cond}
                    hintKey={hintKey}
                    compendiumHref={
                      rulesHintCompendiumAvailable && rulesHintCampaignId != null
                        ? rulesHintCompendiumHref(rulesHintCampaignId, cond)
                        : undefined
                    }
                  />
                )}
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
              );
            })}
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
                          onPatchCombatant({ addConditionInstance: instance }, encounterId);
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
              <GatedControl reason={syncBlockedReason}>
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ fontSize: 'var(--type-label)', border: '1px dashed var(--color-divider)', borderRadius: 'var(--radius-md)' }}
                  disabled={syncBlocked}
                  data-testid={`add-condition-toggle-${combatant.id}`}
                  onClick={() => {
                    setEditingConditionId(null);
                    setConditionDraft(emptyConditionDraft(defaultConditionSourceCombatantId));
                    setAddingCondition(true);
                  }}
                >
                  + condition
                </button>
              </GatedControl>
            )}

            {/* Starfinder Stamina Rest Button */}
            {hasSfPools && combatant.spMax != null && combatant.spMax > 0 && onPatchCombatant && (
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busy || syncBlocked || (combatant.rpCurrent ?? 0) < 1 || (combatant.spCurrent ?? 0) >= combatant.spMax}
                title={syncBlockedReason ?? ((combatant.rpCurrent ?? 0) < 1 ? 'Requires at least 1 Resolve Point' : '10-minute Stamina Rest: spends 1 RP to restore full SP')}
                aria-describedby={syncBlockedDescribedBy}
                onClick={() => onPatchCombatant({ spSet: combatant.spMax, rpDelta: -1 }, encounterId)}
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
                  onClick={() => onPatchCombatant({ deathState: 'stable' }, encounterId)}
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
                      onClick={() => onPatchCombatant({ deathState: 'stable', rpDelta: -1 }, encounterId)}
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
                      onClick={() => onPatchCombatant({ hpSet: 1, deathState: 'none', rpDelta: -1 }, encounterId)}
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
        {statblock && <div data-combatant-statblock>{statblock}</div>}
        {onUseMonsterAction && (
          <div data-combatant-detail>
            <CombatantActionsList
              encounterId={encounterId}
              combatantId={combatant.id}
              combatantName={combatant.name}
              campaignId={campaignId}
              enabled
              disabledReason={syncBlockedReason}
              onUseAction={onUseMonsterAction}
              onUseGroupAction={onUseGroupAction}
            />
          </div>
        )}
        {canEditIdentity && combatant.statblock && combatant.kind === 'monster' && (
          <details
            className="mt-2"
            data-combatant-detail
            // Issue #1992: commit only when focus actually LEAVES this editor (not on every
            // inner blur/re-focus between its own fields) — matching how nameDraft/initDraft
            // commit on their own field's blur, generalized to a whole subtree of fields.
            // Round 9: this IS the genuine user action commitStatblock's `awaitingReedit`
            // gate carves out — passed as `'explicit'`, distinct from the automatic flushes.
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) commitStatblock('explicit');
            }}
          >
            <summary className="text-xs text-muted cursor-pointer">Edit statblock</summary>
            <CombatantStatblockEditor
              value={statblockDraftState.draft}
              onChange={(next) => dispatchStatblockDraft({ type: 'edit', statblock: next })}
              ruleSystem={ruleSystem}
              customMechanicsProfile={customMechanicsProfile}
            />
          </details>
        )}
        {/* Issue #1926: a revealed inline statblock, read-only, for a viewer without edit
            rights (a player, or the DM once the encounter has ended and identity edits are
            gone). Mutually exclusive with the editable form above (that one requires
            canEditIdentity); the compendium (ruleEntryId) case is handled by the parent's
            `statblock` prop instead — see RunSessionPage's reveal-aware condition. */}
        {!canEditIdentity &&
          combatant.statblockRevealed &&
          combatant.statblock &&
          (combatant.kind === 'monster' || combatant.kind === 'npc') && (
            <details className="mt-2" data-combatant-detail data-testid={`combatant-statblock-revealed-${combatant.id}`}>
              <summary className="text-xs text-muted cursor-pointer">{t('encounters.statblock.revealedSummary')}</summary>
              <CombatantStatblockEditor value={combatant.statblock} onChange={() => {}} disabled ruleSystem={ruleSystem} />
            </details>
          )}
        {/* Character card (in-encounter sheet): a player sees only their own combat stats,
            while the DM sees the whole party. */}
        {combatant.kind === 'character' && character && (
          <div data-combatant-detail>
            <CharacterStatCard
              character={character}
              ruleSystem={ruleSystem}
              customMechanicsProfile={customMechanicsProfile}
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
          </div>
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
              <HpBar current={combatant.hpCurrent} max={combatant.hpMax} colorVisionAssist={colorVisionAssist} />
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
                      onClick={() => onPatchCombatant({ rpDelta: -1 }, encounterId)}
                    >
                      −
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost !px-1 text-[10px] cf-density-xs"
                      disabled={busy || syncBlocked || (combatant.rpCurrent ?? 0) >= combatant.rpMax}
                      title={syncBlockedReason ?? 'Increase Resolve Points'}
                      aria-describedby={syncBlockedDescribedBy}
                      onClick={() => onPatchCombatant({ rpDelta: 1 }, encounterId)}
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
            <GatedControl key={step} reason={syncBlockedReason}>
              <button
                className="btn btn-icon btn-secondary cf-target-44"
                style={{ width: 44, height: 44, fontSize: step === 1 || step === -1 ? 16 : 13, fontFamily: 'var(--font-heading)' }}
                /* Optimistic: HP steppers stay live even mid-request (issue #73) — the click
                   lands instantly via setQueryData, so there's no round-trip to wait on.
                   `busy` intentionally does NOT disable this button; only the sync gate
                   (issue #1746) does, since a blocked write really cannot be trusted. */
                disabled={syncBlocked}
                aria-label={`${step < 0 ? 'Reduce' : 'Increase'} ${combatant.name}'s HP by ${Math.abs(step)} (hold Shift for ${Math.abs(step) * 5}; currently ${combatant.hpCurrent} of ${combatant.hpMax})`}
                onClick={(e) => onHpDelta(e.shiftKey ? step * 5 : step)}
              >
                {step > 0 ? `+${step}` : `−${Math.abs(step)}`}
              </button>
            </GatedControl>
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
      {canEditIdentity && (combatant.kind === 'monster' || combatant.kind === 'npc') && onPatchCombatant && (
        <button
          type="button"
          className="btn btn-ghost cf-target-44 text-xs"
          style={{ minWidth: 44, height: 44, flex: 'none' }}
          disabled={busy || syncBlocked}
          aria-pressed={combatant.statblockRevealed}
          aria-describedby={syncBlockedDescribedBy}
          data-testid={`statblock-reveal-toggle-${combatant.id}`}
          // The visible label is just "Reveal"/"Revealed" to fit the row, which on its own
          // says nothing about WHAT is revealed — and the battle map already has a fog
          // "Reveal" tool, so a bare accessible name of "Reveal" is ambiguous both to a
          // screen-reader user and to any role+name query.
          aria-label={
            combatant.statblockRevealed
              ? t('encounters.statblock.hideFromPlayers')
              : t('encounters.statblock.revealToPlayers')
          }
          title={
            syncBlockedReason ??
            (combatant.statblockRevealed ? t('encounters.statblock.hideFromPlayers') : t('encounters.statblock.revealToPlayers'))
          }
          onClick={() => onPatchCombatant({ statblockRevealed: !combatant.statblockRevealed }, encounterId)}
        >
          {combatant.statblockRevealed ? t('encounters.statblock.revealed') : t('encounters.statblock.reveal')}
        </button>
      )}
      {onDuplicate && (
        <button
          className="btn btn-icon btn-ghost cf-target-44"
          style={{ width: 44, height: 44, flex: 'none' }}
          disabled={busy || syncBlocked}
          onClick={onDuplicate}
          aria-label={t('encounters.duplicateCombatant', { name: combatant.name })}
          aria-describedby={syncBlockedDescribedBy}
          title={syncBlockedReason ?? t('encounters.duplicate')}
        >
          <UIIcon name="add" size="xs" />
        </button>
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
      {(() => {
        const whisperCid = routeCampaignId ?? campaignId;
        if (!whisperCid || !character?.ownerUserId || String(character.ownerUserId) === String(myUserId)) return null;
        return (
          <>
            {isDm && (
              <button
                type="button"
                className="btn btn-icon btn-ghost cf-target-44"
                style={{ width: 44, height: 44, flex: 'none' }}
                disabled={busy}
                onClick={() => setShowWhisper((w) => !w)}
                aria-label={t('encounters.whisper.buttonLabel', { name: combatant.name })}
                title={t('encounters.whisper.buttonLabel', { name: combatant.name })}
                data-testid={`whisper-button-${combatant.id}`}
              >
                <GameIcon slug={NOTE_VISIBILITY_ICON.whisper} size={UI_ICON_SIZE.xs} />
              </button>
            )}
            {showWhisper && (
              <div style={{ flexBasis: '100%', width: '100%' }}>
                <EncounterWhisperComposer
                  campaignId={whisperCid}
                  recipientUserId={String(character.ownerUserId)}
                  recipientName={combatant.name}
                  onClose={() => setShowWhisper(false)}
                />
              </div>
            )}
          </>
        );
      })()}
    </div>
  );
}
