import { useTranslation } from 'react-i18next';
/**
 * Current-turn workspace (issue #413) — the focused "what can I do now?" panel for the
 * active combatant during a running encounter. Renders the prominent actor / round / next
 * actor, an assertive "your turn" announcement for the owning player, the adapter-defined
 * action-economy slots with plain-language help + live usage, movement / reaction /
 * concentration / active effects, searchable suggested actions, the start/end-of-turn
 * prompts to resolve, and the End-turn control (player self-serve when allowed, DM always).
 *
 * The detailed workspace is server-gated: only the DM or the current combatant's owner
 * receives action economy / prompts / suggestions (a monster's abilities never leak), so
 * this component simply renders whatever the server chose to disclose.
 *
 * Accessibility: the "your turn" banner is an aria-live=assertive region so a screen reader
 * announces it the moment the turn lands; the End-turn button is a plain focusable button,
 * and the suggested-action search is a labelled text input. Keyboard/mobile flows reuse the
 * app's standard focusable controls (no custom key handling that would trap focus).
 */
import { useEffect, useMemo, useState } from 'react';
import type { CombatantTurnState, TurnWorkspace as TurnWorkspaceData, ActionSpec, CustomMechanicsProfile } from '@campfire/schema';
import { hasDeathSavesForAdapter, ruleSystemAdapter } from '@campfire/schema';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, API, translateApiError } from '../../lib/api';
import { queryKeys, invalidateEncounter } from '../../lib/query';
import { isImeComposing } from '../../lib/compositionSafeSubmit';
import { useAnnounce } from '../../components/Announcer';
import { Card, Btn } from '../../components/ui';
import { GatedControl } from '../../components/GatedControl';
import { SpellbookPanel, hasSpellbookContent, type SpellItem, type SpellSlotMap, type SpellCastContext } from './SpellbookPanel';
import { GameIcon } from '../../components/GameIcon';
import { QuickRollButtons } from './QuickRollButtons';
import { turnEndGateReason, turnEndStandingReason } from './turnEndGate';

/** Ties the End-turn button to its standing dmControlsTurns line for assistive tech. */
const TURN_END_STANDING_ID = 'turn-end-standing-reason';

const STANDARD_ACTIONS = [
  { id: 'attack', label: 'Attack', icon: 'crossed-swords', desc: 'Attack a target' },
  { id: 'dash', label: 'Dash', icon: 'running-shoe', desc: 'Move your speed again' },
  { id: 'dodge', label: 'Dodge', icon: 'shield', desc: 'Focus on avoiding attacks' },
  { id: 'disengage', label: 'Disengage', icon: 'evasion', desc: 'Move without provoking opportunity attacks' },
  { id: 'help', label: 'Help', icon: 'help', desc: 'Grant advantage to an ally' },
  { id: 'hide', label: 'Hide', icon: 'hood', desc: 'Attempt to hide from enemies' },
  { id: 'ready', label: 'Ready', icon: 'stopwatch', desc: 'Prepare an action for a specific trigger' },
  { id: 'search', label: 'Search', icon: 'magnifying-glass', desc: 'Devote your attention to finding something' },
  { id: 'use', label: 'Use Object', icon: 'grab', desc: 'Interact with a complex object' }
];

interface TurnWorkspaceProps {
  encounterId: number;
  /** Issue #1900: fetched ONCE by the parent (RunSessionPage) and passed down — the workspace
   *  no longer runs its own duplicate `/turn` query. `undefined` while the parent's read is
   *  still loading, which renders nothing (same as the old not-yet-fetched state). */
  turn: TurnWorkspaceData | undefined;
  isDm: boolean;
  ruleSystem?: string | null;
  customMechanicsProfile?: CustomMechanicsProfile | null;
  /** Current combatant turn state (delay / ready) from the encounter roster. */
  currentTurnState?: CombatantTurnState;
  /**
   * When true, conflict-prone OWN-COMBATANT turn controls stay disabled (issue #471,
   * scoped by #1914): action-economy slots, the standard-action bar, spellbook, delay/ready,
   * active-effect removal, and the in-workspace death-save roll. These are all
   * server-redacted to the DM or the current combatant's OWNER, so whenever a non-DM viewer
   * sees any of them it is already their own turn — the parent may relax this below the
   * table-wide sync gate via a same-outage 'own-combatant' override without touching
   * anything beyond that. Deliberately NOT used for End-turn — see {@link endTurnBlocked}.
   */
  actionsDisabled?: boolean;
  /**
   * Issue #1914: the End-turn control's OWN gate — end/next/undo turn is a turn-topology
   * write, unblockable only by the table-wide DM-grade override, never by the
   * 'own-combatant' scope `actionsDisabled` above may be relaxed by. Falls back to
   * `actionsDisabled` when omitted so an un-migrated caller keeps its prior (single-flag)
   * behavior.
   */
  endTurnBlocked?: boolean;
  /** Keeps the death-save action single-flight while its authoritative request is in flight. */
  deathSavePending?: boolean;
  /** Resolves the in-flight state for the actor returned by the turn query. */
  isCombatantPending?: (combatantId: number) => boolean;
  onRollDeathSave?: (combatant: { id: number; name: string }) => void;
  /** Issue #425: DM uses a suggested monster action from the turn workspace. */
  onUseSuggestedAction?: (actionIndex: number, actionName: string, spec: ActionSpec) => void;
  /** Issue #1456: the parent owns the single end-turn mutation so errors surface once.
   *  The workspace passes the combatant id from the /turn response it is rendering, which
   *  is authoritative when the parent's encounter cache is briefly stale. */
  onEndTurn?: (expectedCurrentCombatantId: number) => void;
  endTurnBusy?: boolean;
  /** #599: mirrors the server's assertNoSafetyHold rejection on endTurn — no server change,
   *  just surfacing the same table-wide safety-hold state (already visible via SafetyHoldBar)
   *  as a reason on the control it actually blocks. */
  safetyHoldActive?: boolean;
  gridUnit?: string | null;
  gridScale?: number | null;
  /** Issue #1900: spend (+1) or restore (-1) one spell-slot level for the current combatant's
   *  character, via the parent's POST :id/spell-slots mutation. Undefined when the viewer
   *  isn't authorized to cast for this actor right now (mirrors onUseSuggestedAction's gate). */
  onUpdateSpellSlot?: (level: number | undefined, delta: number, castContext?: SpellCastContext) => void;
}

/** A single action-economy slot chip with usage + a use/release control for the owner/DM. */
function SlotChip({
  slot,
  onUse,
  onRelease,
  disabled,
  unit = 'ft',
  step = 5,
}: {
  slot: TurnWorkspaceData['actionEconomy'][number];
  onUse: () => void;
  onRelease: () => void;
  disabled: boolean;
  unit?: string;
  step?: number;
}) {
  const isMovement = slot.kind === 'movement';
  const remaining = Math.max(0, slot.max - slot.used);
  const spent = slot.used >= slot.max && slot.max > 0;
  return (
    <div
      className="rounded-md border border-neutral-700 px-2.5 py-1.5 flex flex-col gap-1 min-w-[9rem]"
      style={{ background: spent ? 'var(--color-neutral-800)' : 'transparent' }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-white" title={slot.help}>
          {slot.label}
        </span>
        <span className="text-xs text-muted">
          {isMovement ? `${slot.used}/${slot.max} ${unit}` : `${remaining}/${slot.max}`}
        </span>
      </div>
      <p className="text-[11px] text-muted m-0 leading-tight">{slot.help}</p>
      <div className="flex gap-1">
        <button type="button" className="btn btn-ghost text-[11px] cf-target-44" disabled={disabled} onClick={onUse}>
          {isMovement ? `+${step} ${unit}` : 'Use'}
        </button>
        <button type="button" className="btn btn-ghost text-[11px] cf-target-44" disabled={disabled || slot.used <= 0} onClick={onRelease}>
          {isMovement ? `-${step} ${unit}` : 'Undo'}
        </button>
      </div>
    </div>
  );
}

export function TurnWorkspace({
  encounterId,
  turn,
  isDm,
  ruleSystem,
  customMechanicsProfile,
  currentTurnState,
  actionsDisabled = false,
  endTurnBlocked = actionsDisabled,
  deathSavePending = false,
  isCombatantPending,
  onRollDeathSave,
  onUseSuggestedAction,
  onEndTurn,
  endTurnBusy = false,
  safetyHoldActive = false,
  gridUnit,
  gridScale,
  onUpdateSpellSlot,
}: TurnWorkspaceProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const announce = useAnnounce();
  const [actionFilter, setActionFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [readiedDraft, setReadiedDraft] = useState(currentTurnState?.readied ?? '');
  const [activeTab, setActiveTab] = useState<'action' | 'bonus' | 'reaction' | 'other'>('action');
  const [showSpellbook, setShowSpellbook] = useState(false);

  const adapter = useMemo(
    () => ruleSystemAdapter(ruleSystem, customMechanicsProfile),
    [ruleSystem, customMechanicsProfile],
  );
  const hasDeathSaves = hasDeathSavesForAdapter(adapter);

  const settle = () => {
    invalidateEncounter(queryClient, encounterId);
    void queryClient.invalidateQueries({ queryKey: queryKeys.encounterTurn(encounterId) });
  };

  const turnState = useMutation({
    mutationFn: (patch: Record<string, unknown>) => {
      const cid = turn?.current?.combatantId;
      if (cid == null) throw new Error('No current combatant to update — refresh and try again.');
      return api.post(`${API}/encounters/${encounterId}/combatants/${cid}/turn-state`, patch);
    },
    onMutate: () => setError(null),
    onError: (err) => setError(translateApiError(err, t, { fallbackKey: 'encounters.errors.actionFailed' })),
    onSettled: settle,
  });

  // Announce "your turn" through the single app-root assertive live region (Announcer),
  // rather than rendering a second aria-live region here (which would duplicate the app's
  // canonical assertive region). dedupeKey keys on the actor+round so a refetch doesn't
  // re-announce the same turn.
  const isYourTurn = turn?.isYourTurn ?? false;
  const currentName = turn?.current?.name ?? '';
  const currentId = turn?.current?.combatantId ?? null;
  const turnRound = turn?.round ?? 0;
  useEffect(() => {
    if (isYourTurn && currentId != null) {
      announce(`Your turn — round ${turnRound}, ${currentName}.`, {
        assertive: true,
        dedupeKey: `your-turn:${encounterId}:${currentId}:${turnRound}`,
      });
    }
  }, [announce, encounterId, isYourTurn, currentId, currentName, turnRound]);

  useEffect(() => {
    setReadiedDraft(currentTurnState?.readied ?? '');
  }, [currentTurnState?.readied]);

  const actionItems = useMemo(() => {
    const list = turn?.suggestedActions ?? [];
    const needle = actionFilter.trim().toLowerCase();
    const filtered = needle ? list.filter((a) => a.name.toLowerCase().includes(needle) || a.summary.toLowerCase().includes(needle)) : list;

    const grouped = {
      action: [] as typeof list,
      bonus: [] as typeof list,
      reaction: [] as typeof list,
      other: [] as typeof list,
    };

    filtered.forEach(a => {
      const slot = a.spec?.cost?.slot?.toLowerCase();
      const source = a.source?.toLowerCase();

      let cat: keyof typeof grouped = 'other';
      if (slot === 'bonus' || source === 'bonus' || source === 'bonus action' || source === 'bonus-action') {
        cat = 'bonus';
      } else if (slot === 'reaction' || source === 'reaction') {
        cat = 'reaction';
      } else if (slot === 'action' || slot === 'actions' || source === 'action') {
        cat = 'action';
      }

      grouped[cat].push(a);
    });

    return grouped;
  }, [turn?.suggestedActions, actionFilter]);

  const tabs = useMemo(() => [
    { id: 'action', label: 'Actions' },
    { id: 'bonus', label: 'Bonus Actions' },
    { id: 'reaction', label: 'Reactions' },
    { id: 'other', label: 'Other / Limited Use' },
  ] as const, []);

  useEffect(() => {
    if (actionItems[activeTab].length === 0) {
      if (actionItems.action.length > 0) setActiveTab('action');
      else if (actionItems.bonus.length > 0) setActiveTab('bonus');
      else if (actionItems.reaction.length > 0) setActiveTab('reaction');
      else if (actionItems.other.length > 0) setActiveTab('other');
    }
  }, [actionItems, activeTab]);

  // Issue #1900: real data only — `turn.spells`/`turn.spellSlots` are server-derived from the
  // character's actual actions/persisted slots (see `deriveTurnSpells` in @campfire/schema).
  // No client-side invention of level/school/range/casting-time; a spell with no cost-slot
  // data simply renders without a Time badge (SpellbookPanel), and an actor with neither
  // spells nor slots gets no toggle at all (below) rather than an empty/fake panel.
  const spellItems = useMemo<SpellItem[]>(
    () =>
      (turn?.spells ?? []).map((s, idx) => ({
        id: `spell-${s.actionIndex ?? idx}-${s.name}`,
        name: s.name,
        level: s.level,
        castingTime: s.castingSlot || undefined,
        isConcentration: s.concentration,
        spec: s.spec,
        actionIndex: s.actionIndex,
      })),
    [turn?.spells],
  );
  const spellSlotsMap: SpellSlotMap | undefined = turn?.spellSlots ?? undefined;
  // Review fix: a persisted slots map can legitimately contain a level entry with `max: 0`
  // (e.g. a class that hasn't reached that slot tier yet) — that pool has nothing to spend,
  // so it must not count as "has slots" for the toggle-visibility acceptance criterion
  // (hidden when the actor has no spells and no *usable* slots). See `hasSpellbookContent`.
  const hasSpellbookData = hasSpellbookContent(spellItems, spellSlotsMap);

  if (!turn || turn.status !== 'running' || !turn.current) return null;
  const busy = endTurnBusy || turnState.isPending;
  const controlsDisabled = busy || actionsDisabled;
  const isDying = turn.current.deathState === 'dying';

  const actionSlot = turn.actionEconomy.find(s => s.key === 'action');
  const actionSpent = actionSlot ? actionSlot.used >= actionSlot.max : true;
  const actionDisabled = controlsDisabled || actionSpent;

  return (
    <Card className="space-y-3" data-testid="turn-workspace">
      {/* Prominent actor / round / next actor + Spellbook toggle. */}
      <div className="flex items-center justify-between gap-2.5 flex-wrap">
        <div className="flex items-center gap-2.5 flex-wrap">
          <span className="text-xs uppercase tracking-wide text-muted">Round {turn.round}</span>
          <h2 className="text-lg font-extrabold text-white m-0">{turn.current.name}</h2>
          <span className="tag tag-neutral">now</span>
          {turn.next && <span className="text-sm text-muted">Next: {turn.next.name}</span>}
        </div>
        {hasSpellbookData && (
          <button
            type="button"
            className="btn btn-secondary text-xs cf-target-44 flex items-center gap-1.5 min-h-[44px]"
            data-testid="toggle-spellbook-btn"
            aria-expanded={showSpellbook}
            aria-label="Toggle spellbook panel"
            onClick={() => setShowSpellbook((prev) => !prev)}
          >
            <span>🔮 Spellbook</span>
          </button>
        )}
      </div>

      {showSpellbook && hasSpellbookData && (
        <SpellbookPanel
          combatantName={turn.current.name}
          spells={spellItems}
          spellSlots={spellSlotsMap}
          activeConcentration={turn.concentration}
          disabled={controlsDisabled}
          onUpdateSlot={onUpdateSpellSlot}
          onUseActionRequested={onUseSuggestedAction}
        />
      )}

      {/* "Your turn" is announced via the app-root Announcer (see the effect above); the
          banner below is a purely visual cue and is intentionally not its own live region. */}
      {turn.isYourTurn && (
        <div className="rounded-md px-3 py-2 font-semibold" style={{ background: 'var(--cf-difficulty-easy-bg)', color: 'var(--cf-difficulty-easy-fg)' }}>
          {t('encounters.workspace.yourTurn')}
        </div>
      )}

      {error && <p className="text-sm m-0" style={{ color: 'var(--color-danger, #f87171)' }}>{error}</p>}

      {/* Prominent Death Save turn action card (issue #424). */}
      {isDying && hasDeathSaves && (
        <div className="rounded-lg border border-red-500/40 bg-red-950/30 p-3 space-y-2" data-testid="turn-death-save-card">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div>
              <span className="tag tag-danger font-semibold">Unconscious & Dying (0 HP)</span>
              <p className="text-xs text-muted m-0 mt-1">Roll a d20 death saving throw to stabilize or revive.</p>
            </div>
            <button
              type="button"
              className="btn btn-primary min-h-[44px] min-w-[44px] px-4 py-2 font-bold text-sm flex items-center gap-1.5"
              data-testid="turn-roll-death-save"
              aria-label={`Roll a death save for ${turn.current.name}`}
              disabled={controlsDisabled || deathSavePending || isCombatantPending?.(turn.current.combatantId) || !onRollDeathSave}
              onClick={() => {
                if (onRollDeathSave && turn.current) onRollDeathSave({ id: turn.current.combatantId, name: turn.current.name });
              }}
            >
              🎲 Roll Death Save
            </button>
          </div>
          <div className="flex items-center gap-4 text-xs text-muted pt-1 flex-wrap">
            <span>Successes: <strong className="text-white">{turn.current.deathSaveSuccesses ?? 0}/3</strong></span>
            <span>Failures: <strong className="text-red-400">{turn.current.deathSaveFailures ?? 0}/3</strong></span>
          </div>
        </div>
      )}

      {isDying && (
        <p className="text-xs text-amber-400 m-0 italic">
          Character is unconscious — normal actions and movement are suppressed while dying.
        </p>
      )}

      {/* Action economy — adapter-defined slots with plain-language help + usage. */}
      {turn.actionEconomy.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-white mb-1.5">Action economy</h3>
          <div className="flex gap-2 flex-wrap">
            {(() => {
              const isFeet = !gridUnit || gridUnit === 'ft' || gridUnit === 'feet';
              const unit = isFeet ? (gridUnit || 'ft') : 'ft';
              const step = isFeet ? (gridScale || 5) : 5;
              return turn.actionEconomy.map((slot) => (
                <SlotChip
                  key={slot.key}
                  slot={slot}
                  // Deliberately NOT gated on `turn.canEndTurn` (issue #1933 review). Under
                  // `dmControlsTurns` a player cannot ADVANCE the turn, but the server still
                  // accepts their own `/turn-state` writes — movement, action slots — and the
                  // standard-action bar, spell slots and concentration controls beside these
                  // chips stay usable. Keying them to the end-turn permission would disable
                  // half the workspace for exactly the players it belongs to.
                  disabled={controlsDisabled}
                  unit={unit}
                  step={step}
                  onUse={() => turnState.mutate(slot.kind === 'movement' ? { moveFt: step } : { useSlot: slot.key })}
                  onRelease={() => turnState.mutate(slot.kind === 'movement' ? { moveFt: -step } : { releaseSlot: slot.key })}
                />
              ));
            })()}
          </div>
          <div className="flex gap-1.5 mt-3 overflow-x-auto py-1 max-w-full flex-wrap sm:flex-nowrap" data-testid="standard-actions-bar">
            {STANDARD_ACTIONS.map((act) => (
              <button
                key={act.id}
                type="button"
                title={act.desc}
                aria-label={act.label}
                disabled={actionDisabled}
                className="btn btn-ghost flex flex-col items-center justify-center gap-1 min-h-[44px] min-w-[44px] sm:min-w-[56px] p-2"
                onClick={() => {
                  const currentName = turn.current?.name ?? 'Combatant';
                  if (act.id === 'attack') {
                    announce(`${currentName} action: Attack`);
                    const el = document.getElementById('turn-suggested-actions-search');
                    if (el) {
                      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                      el.focus();
                    }
                  } else if (act.id === 'ready') {
                    announce(`${currentName} action: Ready`);
                    const el = document.getElementById('turn-readied-input');
                    if (el) {
                      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                      el.focus();
                    }
                  } else {
                    announce(`${currentName} action: ${act.label}`);
                    turnState.mutate({ useSlot: 'action' });
                  }
                }}
              >
                <GameIcon slug={act.icon} size={20} />
                <span className="text-[10px] hidden sm:block">{act.label}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Reaction + concentration summary. */}
      <div className="flex gap-4 flex-wrap text-sm">
        {turn.movement && (
          <span className="text-muted">
            Movement: <span className="text-white">{turn.movement.usedFt}/{turn.movement.maxFt} {!gridUnit || gridUnit === 'ft' || gridUnit === 'feet' ? (gridUnit || 'ft') : 'ft'}</span>
          </span>
        )}
        <span className="text-muted">
          Reaction: <span className="text-white">{turn.reactionAvailable ? 'available' : 'used'}</span>
        </span>
        <span className="text-muted">
          Concentration:{' '}
          <span className="text-white">{turn.concentration ?? 'none'}</span>
          {turn.concentration && (
            <button type="button" className="btn btn-ghost text-[11px] ml-1 cf-target-44" disabled={controlsDisabled} onClick={() => turnState.mutate({ concentration: null })}>
              clear
            </button>
          )}
        </span>
      </div>

      {/* Delay / ready (issue #487) — MVP flags on the current turn. */}
      {(turn.isYourTurn || isDm) && (
        <section data-testid="turn-delay-ready">
          <h3 className="text-sm font-semibold text-white mb-1.5">Delay &amp; ready</h3>
          <div className="flex gap-2 flex-wrap items-center">
            <button
              type="button"
              className="btn btn-ghost cf-target-44"
              disabled={controlsDisabled}
              data-testid="workspace-delay-toggle"
              onClick={() => turnState.mutate({ delaying: !currentTurnState?.delaying })}
            >
              {currentTurnState?.delaying ? 'Resume turn' : 'Delay turn'}
            </button>
            <input
              id="turn-readied-input"
              type="text"
              className="input cf-target-44"
              placeholder={t('encounters.workspace.readiedPlaceholder')}
              aria-label={t('encounters.workspace.readiedAria')}
              value={readiedDraft}
              disabled={controlsDisabled}
              maxLength={200}
              onChange={(e) => setReadiedDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !isImeComposing(e)) {
                  e.preventDefault();
                  const trimmed = readiedDraft.trim();
                  turnState.mutate({ readied: trimmed || null });
                }
              }}
              style={{ maxWidth: 260 }}
            />
            <button
              type="button"
              className="btn btn-ghost cf-target-44"
              disabled={controlsDisabled}
              data-testid="workspace-readied-set"
              onClick={() => {
                const trimmed = readiedDraft.trim();
                turnState.mutate({ readied: trimmed || null });
              }}
            >
              {t('encounters.workspace.setReady')}
            </button>
            {currentTurnState?.readied && (
              <button
                type="button"
                className="btn btn-ghost cf-target-44"
                disabled={controlsDisabled}
                data-testid="workspace-readied-clear"
                onClick={() => {
                  setReadiedDraft('');
                  turnState.mutate({ readied: null });
                }}
              >
                {t('encounters.workspace.clearReady')}
              </button>
            )}
          </div>
          {currentTurnState?.readied && (
            <p className="text-xs text-muted m-0 mt-1">{t('encounters.workspace.readiedLabel')}: {currentTurnState.readied}</p>
          )}
        </section>
      )}

      {/* Active effects (duration + save timing). */}
      {turn.activeEffects.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-white mb-1.5">{t('encounters.workspace.activeEffects')}</h3>
          <ul className="list-none p-0 m-0 space-y-1">
            {turn.activeEffects.map((e) => (
              <li key={e.id} className="text-sm text-muted flex items-center gap-2">
                <span className="text-white">{e.name}</span>
                {e.roundsRemaining != null && <span className="tag tag-neutral text-[11px]">{e.roundsRemaining} {t('encounters.workspace.rd')}</span>}
                {e.saveAbility && <span className="text-[11px]">{t('encounters.workspace.save')}: {e.saveAbility}{e.saveDc != null ? ` DC ${e.saveDc}` : ''}</span>}
                <button type="button" className="btn btn-ghost text-[11px] cf-target-44" disabled={controlsDisabled} onClick={() => turnState.mutate({ removeEffectId: e.id })}>
                  {t('encounters.workspace.remove')}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Start / end-of-turn prompts. */}
      {(turn.startPrompts.length > 0 || turn.endPrompts.length > 0) && (
        <section className="grid gap-3 sm:grid-cols-2">
          {turn.startPrompts.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-white mb-1">{t('encounters.workspace.startOfTurn')}</h3>
              <ul className="list-none p-0 m-0 space-y-1">
                {turn.startPrompts.map((p) => (
                  <li key={p.id} className="text-sm text-muted">• {p.message}</li>
                ))}
              </ul>
            </div>
          )}
          {turn.endPrompts.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-white mb-1">{t('encounters.workspace.beforeYouEnd')}</h3>
              <ul className="list-none p-0 m-0 space-y-1">
                {turn.endPrompts.map((p) => (
                  <li key={p.id} className="text-sm text-muted">• {p.message}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {/* Suggested actions, searchable inline. */}
      {turn.suggestedActions.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-white mb-1.5">{t('encounters.workspace.suggestedActions')}</h3>
          <input
            id="turn-suggested-actions-search"
            type="search"
            className="input mb-2 w-full"
            placeholder={t('encounters.workspace.searchActions')}
            aria-label={t('encounters.workspace.searchActionsAria')}
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
          />
          <div role="tablist" className="flex border-b border-neutral-700 mb-3 overflow-x-auto hide-scrollbar">
            {tabs.map((tab) => {
              const count = actionItems[tab.id].length;
              const isSelected = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  role="tab"
                  aria-selected={isSelected}
                  type="button"
                  className={`cf-target-44 px-3 flex items-center gap-2 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${
                    isSelected ? 'border-primary text-white' : 'border-transparent text-muted hover:text-white hover:border-neutral-500'
                  }`}
                  onClick={() => setActiveTab(tab.id)}
                >
                  {tab.label}
                  {count > 0 && (
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${isSelected ? 'bg-primary text-white' : 'bg-neutral-800 text-muted'}`}>
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div role="tabpanel" className="space-y-1 max-h-64 overflow-auto px-1">
            {actionItems[activeTab].map((a, i) => {
              const range = a.spec?.range?.range;
              const size = a.spec?.range?.size;
              const targetCount = a.spec?.targets?.count;
              let rangeText = '';
              if (range) rangeText = range;
              if (size) rangeText += rangeText ? ` (${size})` : size;
              let targetText = '';
              if (targetCount !== undefined) {
                targetText = targetCount > 0 ? t('encounters.workspace.targets', { count: targetCount }) : t('encounters.workspace.aoe');
              }
              
              return (
                <div key={`${a.name}-${i}`} className="flex items-center justify-between gap-2 border-b border-neutral-700/50 py-2 last:border-0 text-sm">
                  <div className="flex flex-col min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-white font-medium">{a.name}</span>
                      <QuickRollButtons
                        encounterId={encounterId}
                        combatantId={turn.current?.combatantId}
                        actorName={turn.current?.name}
                        actionName={a.name}
                        toHit={(a as Record<string, any>).toHit}
                        damage={(a as Record<string, any>).damage}
                        spec={a.spec}
                        disabled={controlsDisabled}
                      />
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted flex-wrap mt-0.5">
                      <span className="tag tag-neutral">{a.source}</span>
                      {/* Issue #1901 review (devin-ai-integration): the equipping item's name
                          used to overwrite `source` itself, breaking tab bucketing and the
                          spell-list heuristic above. It's carried in its own field now — still
                          shown here, just no longer masquerading as the action-economy hint. */}
                      {a.equippedItemName && <span className="tag tag-neutral">{`equipped: ${a.equippedItemName}`}</span>}
                      {rangeText && <span>{rangeText}</span>}
                      {targetText && <span>{targetText}</span>}
                    </div>
                    {a.summary && <span className="text-xs text-muted truncate mt-0.5">{a.summary}</span>}
                  </div>
                  {a.resolvable && onUseSuggestedAction && a.actionIndex != null && a.spec && (
                    <button
                      type="button"
                      className="btn btn-secondary cf-target-44 text-xs shrink-0"
                      disabled={actionsDisabled}
                      data-testid="suggested-action-use"
                      onClick={() => onUseSuggestedAction(a.actionIndex!, a.name, a.spec!)}
                    >
                      {t('encounters.workspace.use')}
                    </button>
                  )}
                </div>
              );
            })}
            {actionItems[activeTab].length === 0 && <p className="text-sm text-muted py-2 m-0">{t('encounters.workspace.noMatchingActions')}</p>}
          </div>
        </section>
      )}

      {/* End turn — a player may end their own turn when allowed; the DM always may.
          Issue #1933: this used to unmount the button entirely and swap in static hint
          text whenever `dmControlsTurns` blocked a player, and never accounted for a
          safety hold at all (the server rejects it — assertNoSafetyHold — but the button
          stayed live and just failed on click). Both are now surfaced as a mounted,
          disabled button with a GatedControl reason instead: the control a player would
          reach for stays in the same place, explaining itself, rather than disappearing.
          `turnEndGateReason` decides APPLICABILITY (is this viewer's control at all — DM
          or the turn's owner) before layering on any reason, so a plain onlooker still
          gets nothing, hold or no hold — see that function's doc comment. */}
      {(() => {
        // Issue #1914: End-turn is a turn-topology write — it uses `endTurnBlocked` (the
        // unrelaxed DM-grade gate), NOT `actionsDisabled` (which a same-outage
        // 'own-combatant' override may have already relaxed for the OTHER controls in this
        // workspace). Reusing `actionsDisabled` here would have let a player's own-combatant
        // confirmation silently unblock ending their own turn too — exactly the "guard
        // applied to one branch but not its mirror" shape this issue calls out.
        const endTurnControlsDisabled = busy || endTurnBlocked;
        const gateReasonKey = turnEndGateReason({
          canEndTurn: turn.canEndTurn,
          isYourTurn: turn.isYourTurn,
          dmControlsTurns: turn.dmControlsTurns,
          safetyHoldActive,
          syncBlocked: endTurnBlocked,
        });
        // Suppressed while this player's own end-turn is in flight (issue #1933 review):
        // GatedControl strips the native `disabled` whenever a reason is present, so the
        // button would announce "the table is paused" during the moment the truth is "your
        // click is still going". Same rule as `gateReasonText`'s busy argument.
        //
        // Deliberately `endTurnBusy`, NOT the broader `busy` (= endTurnBusy ||
        // turnState.isPending). `turnState` covers every action-economy toggle,
        // concentration clear and readied/delay edit, so suppressing on it would blank the
        // reason during unrelated saves — leaving a player under `dmControlsTurns` with a
        // mounted, disabled, unexplained button, which is the exact state this issue exists
        // to eliminate. A viewer who cannot end the turn can never have an end-turn request
        // in flight, so the narrow flag loses nothing.
        const gateReason = gateReasonKey && !endTurnBusy ? t(`run.gate.${gateReasonKey}`) : undefined;
        // Applicability still keys off the UNsuppressed reason, so an in-flight request
        // never makes the button vanish for a player who had one.
        const showButton = turn.canEndTurn || gateReasonKey != null;
        // `dmControlsTurns` is a campaign SETTING, not a passing condition — it holds for the
        // whole fight and is the answer to "why can I never end my own turn here". Before
        // GatedControl it had a permanently visible line; folding it into the priority-ranked
        // resolver put it behind hover/focus/tap, leaving a sighted mouse user with a dead
        // control and no explanation (issue #1933 review). Same category as the Start
        // button's roster hints, so it gets the same standing treatment.
        const standingKey = turnEndStandingReason({
          canEndTurn: turn.canEndTurn,
          isYourTurn: turn.isYourTurn,
          dmControlsTurns: turn.dmControlsTurns,
        });
        const standingReason = standingKey ? t(`run.gate.${standingKey}`) : undefined;
        // Don't let GatedControl emit a second, visually-hidden copy of a sentence the line
        // below is already showing — that double-announces to a screen reader and makes
        // getByText resolve to two nodes (the same trap the header hit).
        const tooltipReason = gateReasonKey === standingKey ? undefined : gateReason;
        return (
          <div className="flex items-center gap-2 flex-wrap">
            {showButton && (
              <GatedControl reason={tooltipReason}>
                <Btn
                  // `|| !turn.canEndTurn` is load-bearing, not belt-and-braces: `GatedControl`
                  // only swallows the click while a `reason` is present, and the dedupe just
                  // above deliberately passes `undefined` when the standing line already says
                  // it — which takes GatedControl's passthrough branch and leaves the child
                  // fully live. `endTurnControlsDisabled` is `busy || endTurnBlocked` and knows
                  // nothing about permission, so without this a player under `dmControlsTurns`
                  // could press End turn and get a bare server rejection (issue #1933 review).
                  //
                  // The general rule this cost us: the wrapper is an AFFORDANCE, not an
                  // authorization. A control's own `disabled` has to be correct on its own.
                  // Scope it to this button only — the action-economy chips above are a
                  // different permission and must stay live for this same player.
                  disabled={endTurnControlsDisabled || !turn.canEndTurn}
                  onClick={() => onEndTurn?.(turn.current!.combatantId)}
                  aria-describedby={standingReason ? TURN_END_STANDING_ID : undefined}
                  data-testid="workspace-end-turn"
                >
                  {turn.isYourTurn ? t('encounters.workspace.endMyTurn') : t('encounters.workspace.endTurn')}
                </Btn>
              </GatedControl>
            )}
            {standingReason && (
              <span id={TURN_END_STANDING_ID} className="text-sm text-muted">{standingReason}</span>
            )}
            {turn.isYourTurn && turn.requireDmTurnConfirmation && !isDm && (
              <span className="text-sm text-muted">{t('encounters.workspace.endingTurnAsksDm')}</span>
            )}
          </div>
        );
      })()}
    </Card>
  );
}
