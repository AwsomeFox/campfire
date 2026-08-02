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
import type { CombatantTurnState, TurnWorkspace as TurnWorkspaceData, ActionSpec } from '@campfire/schema';
import { hasDeathSavesForAdapter, ruleSystemAdapter } from '@campfire/schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, API, translateApiError } from '../../lib/api';
import { queryKeys, invalidateEncounter } from '../../lib/query';
import { isImeComposing } from '../../lib/compositionSafeSubmit';
import { useAnnounce } from '../../components/Announcer';
import { Card, Btn } from '../../components/ui';
import { SpellbookPanel, type SpellItem, type SpellSlotMap, type PactSlotPool, type SpellcastingStats } from './SpellbookPanel';
import { GameIcon } from '../../components/GameIcon';
import { QuickRollButtons } from './QuickRollButtons';

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
  /** Round + current-combatant id drive the query key so the workspace refetches on advance. */
  round: number;
  currentCombatantId: number | null;
  isDm: boolean;
  ruleSystem?: string | null;
  /** Current combatant turn state (delay / ready) from the encounter roster. */
  currentTurnState?: CombatantTurnState;
  /** When true, conflict-prone turn controls stay disabled (issue #471). */
  actionsDisabled?: boolean;
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
  gridUnit?: string | null;
  gridScale?: number | null;
  /** Issue #1851: In-combat spellbook panel integration */
  spells?: SpellItem[];
  spellSlots?: SpellSlotMap;
  pactSlots?: PactSlotPool | null;
  spellStats?: SpellcastingStats;
  onUpdateSpellSlot?: (level: number | 'pact', delta: number) => void;
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
  round,
  currentCombatantId,
  isDm,
  ruleSystem,
  currentTurnState,
  actionsDisabled = false,
  deathSavePending = false,
  isCombatantPending,
  onRollDeathSave,
  onUseSuggestedAction,
  onEndTurn,
  endTurnBusy = false,
  gridUnit,
  gridScale,
  spells,
  spellSlots,
  pactSlots,
  spellStats,
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

  const adapter = useMemo(() => ruleSystemAdapter(ruleSystem), [ruleSystem]);
  const hasDeathSaves = hasDeathSavesForAdapter(adapter);

  const { data: turn } = useQuery({
    // Keying on round + current combatant makes the workspace refetch the instant the turn
    // advances (the parent's SSE/poll invalidation flips these), without its own poller.
    queryKey: [...queryKeys.encounterTurn(encounterId), round, currentCombatantId ?? 0],
    queryFn: () => api.get<TurnWorkspaceData>(`${API}/encounters/${encounterId}/turn`),
    staleTime: 2_000,
  });

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

  const effectiveSpells = useMemo<SpellItem[]>(() => {
    if (spells && spells.length > 0) return spells;
    if (!turn?.suggestedActions) return [];
    return turn.suggestedActions
      .filter((a) => a.source?.toLowerCase().includes('spell') || a.name.toLowerCase().includes('spell'))
      .map((a, idx) => ({
        id: `suggested-spell-${idx}`,
        name: a.name,
        level: 1,
        castingTime: '1A',
        range: '60 ft',
        school: 'Evocation',
        spec: a.spec,
        actionIndex: a.actionIndex,
      }));
  }, [spells, turn?.suggestedActions]);

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
      </div>

      {showSpellbook && (
        <SpellbookPanel
          combatantName={turn.current.name}
          stats={spellStats}
          spells={effectiveSpells}
          spellSlots={spellSlots}
          pactSlots={pactSlots}
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
          It’s your turn.
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
              placeholder="Ready action trigger…"
              aria-label="Readied action trigger"
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
              {t('workspace.setReady')}
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
                {t('workspace.clearReady')}
              </button>
            )}
          </div>
          {currentTurnState?.readied && (
            <p className="text-xs text-muted m-0 mt-1">{t('workspace.readiedLabel')}: {currentTurnState.readied}</p>
          )}
        </section>
      )}

      {/* Active effects (duration + save timing). */}
      {turn.activeEffects.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-white mb-1.5">{t('workspace.activeEffects')}</h3>
          <ul className="list-none p-0 m-0 space-y-1">
            {turn.activeEffects.map((e) => (
              <li key={e.id} className="text-sm text-muted flex items-center gap-2">
                <span className="text-white">{e.name}</span>
                {e.roundsRemaining != null && <span className="tag tag-neutral text-[11px]">{e.roundsRemaining} {t('workspace.rd')}</span>}
                {e.saveAbility && <span className="text-[11px]">{t('workspace.save')}: {e.saveAbility}{e.saveDc != null ? ` DC ${e.saveDc}` : ''}</span>}
                <button type="button" className="btn btn-ghost text-[11px] cf-target-44" disabled={controlsDisabled} onClick={() => turnState.mutate({ removeEffectId: e.id })}>
                  {t('workspace.remove')}
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
              <h3 className="text-sm font-semibold text-white mb-1">{t('workspace.startOfTurn')}</h3>
              <ul className="list-none p-0 m-0 space-y-1">
                {turn.startPrompts.map((p) => (
                  <li key={p.id} className="text-sm text-muted">• {p.message}</li>
                ))}
              </ul>
            </div>
          )}
          {turn.endPrompts.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-white mb-1">{t('workspace.beforeYouEnd')}</h3>
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
          <h3 className="text-sm font-semibold text-white mb-1.5">{t('workspace.suggestedActions')}</h3>
          <input
            id="turn-suggested-actions-search"
            type="search"
            className="input mb-2 w-full"
            placeholder={t('workspace.searchActions')}
            aria-label={t('workspace.searchActionsAria')}
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
                targetText = targetCount > 0 ? t('workspace.targets', { count: targetCount }) : t('workspace.aoe');
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
                      {t('workspace.use')}
                    </button>
                  )}
                </div>
              );
            })}
            {actionItems[activeTab].length === 0 && <p className="text-sm text-muted py-2 m-0">{t('workspace.noMatchingActions')}</p>}
          </div>
        </section>
      )}

      {/* End turn — a player may end their own turn when allowed; the DM always may. */}
      <div className="flex items-center gap-2 flex-wrap">
        {turn.canEndTurn ? (
          <Btn
            disabled={controlsDisabled}
            onClick={() => onEndTurn?.(turn.current!.combatantId)}
            data-testid="workspace-end-turn"
          >
            {turn.isYourTurn ? t('encounters.workspace.endMyTurn') : t('encounters.workspace.endTurn')}
          </Btn>
        ) : turn.isYourTurn && turn.dmControlsTurns ? (
          <span className="text-sm text-muted">{t('encounters.workspace.dmAdvancesTurns')}</span>
        ) : null}
        {turn.isYourTurn && turn.requireDmTurnConfirmation && !isDm && (
          <span className="text-sm text-muted">{t('encounters.workspace.endingTurnAsksDm')}</span>
        )}
      </div>
    </Card>
  );
}
