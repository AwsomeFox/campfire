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
import { useKeyedMutation } from '../../lib/keyedMutation';
import { api, API, translateApiError } from '../../lib/api';
import { queryKeys, invalidateEncounter } from '../../lib/query';
import { useAnnounce } from '../../components/Announcer';
import { Card, Btn } from '../../components/ui';

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
  onRollDeathSave?: (combatant: { id: number; name: string }) => void;
  onPatchCombatant?: (combatantId: number, patch: Record<string, unknown>) => void;
  /** Issue #425: DM uses a suggested monster action from the turn workspace. */
  onUseSuggestedAction?: (actionIndex: number, actionName: string, spec: ActionSpec) => void;
}

/** A single action-economy slot chip with usage + a use/release control for the owner/DM. */
function SlotChip({
  slot,
  onUse,
  onRelease,
  disabled,
}: {
  slot: TurnWorkspaceData['actionEconomy'][number];
  onUse: () => void;
  onRelease: () => void;
  disabled: boolean;
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
          {isMovement ? `${slot.used}/${slot.max} ft` : `${remaining}/${slot.max}`}
        </span>
      </div>
      <p className="text-[11px] text-muted m-0 leading-tight">{slot.help}</p>
      <div className="flex gap-1">
        <button type="button" className="btn btn-ghost text-[11px] cf-density-xs" disabled={disabled} onClick={onUse}>
          {isMovement ? '+5 ft' : 'Use'}
        </button>
        <button type="button" className="btn btn-ghost text-[11px] cf-density-xs" disabled={disabled || slot.used <= 0} onClick={onRelease}>
          {isMovement ? '-5 ft' : 'Undo'}
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
  onRollDeathSave,
  onPatchCombatant,
  onUseSuggestedAction,
}: TurnWorkspaceProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const announce = useAnnounce();
  const [actionFilter, setActionFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [readiedDraft, setReadiedDraft] = useState(currentTurnState?.readied ?? '');

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

  // Issue #580: the workspace's "End turn" is the same non-idempotent advance as the
  // tracker's, so it takes the same protection — one operation id per click, carried
  // unchanged through the automatic retry, alongside the existing expected-combatant CAS.
  const endTurn = useKeyedMutation({
    mutationFn: ({ idempotencyKey }: { idempotencyKey: string }) => {
      // Use the combatant id from the SAME response the UI is rendering (not the parent
      // prop, which can be briefly stale/null). Hard-fail rather than POST to /null or send
      // a null guard (which would disable the server's double-advance protection).
      const cid = turn?.current?.combatantId;
      if (cid == null) throw new Error('No current combatant to end the turn for — refresh and try again.');
      return api.post(`${API}/encounters/${encounterId}/end-turn`, {
        expectedCurrentCombatantId: cid,
        idempotencyKey,
      });
    },
    onMutate: () => setError(null),
    onError: (err) => setError(translateApiError(err, t, { fallbackKey: 'encounters.errors.actionFailed' })),
    onSettled: settle,
  });

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

  const filteredActions = useMemo(() => {
    const list = turn?.suggestedActions ?? [];
    const needle = actionFilter.trim().toLowerCase();
    if (!needle) return list;
    return list.filter((a) => a.name.toLowerCase().includes(needle) || a.summary.toLowerCase().includes(needle));
  }, [turn?.suggestedActions, actionFilter]);

  if (!turn || turn.status !== 'running' || !turn.current) return null;
  const busy = endTurn.isPending || turnState.isPending;
  const controlsDisabled = busy || actionsDisabled;
  const isDying = turn.current.deathState === 'dying';

  return (
    <Card className="space-y-3" data-testid="turn-workspace">
      {/* Prominent actor / round / next actor. */}
      <div className="flex items-center gap-2.5 flex-wrap">
        <span className="text-xs uppercase tracking-wide text-muted">Round {turn.round}</span>
        <h2 className="text-lg font-extrabold text-white m-0">{turn.current.name}</h2>
        <span className="tag tag-neutral">now</span>
        {turn.next && <span className="text-sm text-muted">Next: {turn.next.name}</span>}
      </div>

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
              disabled={controlsDisabled}
              onClick={() => {
                if (onRollDeathSave && turn.current) {
                  onRollDeathSave({ id: turn.current.combatantId, name: turn.current.name });
                } else if (onPatchCombatant && turn.current) {
                  const face = 1 + Math.floor(Math.random() * 20);
                  onPatchCombatant(turn.current.combatantId, { deathSaveRoll: face });
                }
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
            {turn.actionEconomy.map((slot) => (
              <SlotChip
                key={slot.key}
                slot={slot}
                disabled={controlsDisabled}
                onUse={() => turnState.mutate(slot.kind === 'movement' ? { moveFt: 5 } : { useSlot: slot.key })}
                onRelease={() => turnState.mutate(slot.kind === 'movement' ? { moveFt: -5 } : { releaseSlot: slot.key })}
              />
            ))}
          </div>
        </section>
      )}

      {/* Reaction + concentration summary. */}
      <div className="flex gap-4 flex-wrap text-sm">
        {turn.movement && (
          <span className="text-muted">
            Movement: <span className="text-white">{turn.movement.usedFt}/{turn.movement.maxFt} ft</span>
          </span>
        )}
        <span className="text-muted">
          Reaction: <span className="text-white">{turn.reactionAvailable ? 'available' : 'used'}</span>
        </span>
        <span className="text-muted">
          Concentration:{' '}
          <span className="text-white">{turn.concentration ?? 'none'}</span>
          {turn.concentration && (
            <button type="button" className="btn btn-ghost text-[11px] ml-1 cf-density-xs" disabled={controlsDisabled} onClick={() => turnState.mutate({ concentration: null })}>
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
              className="btn btn-ghost"
              disabled={controlsDisabled}
              data-testid="workspace-delay-toggle"
              onClick={() => turnState.mutate({ delaying: !currentTurnState?.delaying })}
            >
              {currentTurnState?.delaying ? 'Resume turn' : 'Delay turn'}
            </button>
            <input
              type="text"
              className="input"
              placeholder="Ready action trigger…"
              aria-label="Readied action trigger"
              value={readiedDraft}
              disabled={controlsDisabled}
              maxLength={200}
              onChange={(e) => setReadiedDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  const trimmed = readiedDraft.trim();
                  turnState.mutate({ readied: trimmed || null });
                }
              }}
              style={{ maxWidth: 260 }}
            />
            <button
              type="button"
              className="btn btn-ghost"
              disabled={controlsDisabled}
              data-testid="workspace-readied-set"
              onClick={() => {
                const trimmed = readiedDraft.trim();
                turnState.mutate({ readied: trimmed || null });
              }}
            >
              Set ready
            </button>
            {currentTurnState?.readied && (
              <button
                type="button"
                className="btn btn-ghost"
                disabled={controlsDisabled}
                data-testid="workspace-readied-clear"
                onClick={() => {
                  setReadiedDraft('');
                  turnState.mutate({ readied: null });
                }}
              >
                Clear ready
              </button>
            )}
          </div>
          {currentTurnState?.readied && (
            <p className="text-xs text-muted m-0 mt-1">Readied: {currentTurnState.readied}</p>
          )}
        </section>
      )}

      {/* Active effects (duration + save timing). */}
      {turn.activeEffects.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-white mb-1.5">Active effects</h3>
          <ul className="list-none p-0 m-0 space-y-1">
            {turn.activeEffects.map((e) => (
              <li key={e.id} className="text-sm text-muted flex items-center gap-2">
                <span className="text-white">{e.name}</span>
                {e.roundsRemaining != null && <span className="tag tag-neutral text-[11px]">{e.roundsRemaining} rd</span>}
                {e.saveAbility && <span className="text-[11px]">save: {e.saveAbility}{e.saveDc != null ? ` DC ${e.saveDc}` : ''}</span>}
                <button type="button" className="btn btn-ghost text-[11px] cf-density-xs" disabled={controlsDisabled} onClick={() => turnState.mutate({ removeEffectId: e.id })}>
                  remove
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
              <h3 className="text-sm font-semibold text-white mb-1">Start of turn</h3>
              <ul className="list-none p-0 m-0 space-y-1">
                {turn.startPrompts.map((p) => (
                  <li key={p.id} className="text-sm text-muted">• {p.message}</li>
                ))}
              </ul>
            </div>
          )}
          {turn.endPrompts.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-white mb-1">Before you end</h3>
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
          <h3 className="text-sm font-semibold text-white mb-1.5">Suggested actions</h3>
          <input
            type="search"
            className="input mb-2 w-full"
            placeholder="Search actions…"
            aria-label="Search suggested actions"
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
          />
          <ul className="list-none p-0 m-0 space-y-1 max-h-48 overflow-auto">
            {filteredActions.map((a, i) => (
              <li key={`${a.name}-${i}`} className="text-sm flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <span className="text-white font-medium">{a.name}</span>
                  <span className="text-muted"> · {a.source}</span>
                  {a.summary && <span className="text-muted"> — {a.summary}</span>}
                </div>
                {a.resolvable && onUseSuggestedAction && a.actionIndex != null && a.spec && (
                  <button
                    type="button"
                    className="btn btn-secondary !min-h-8 text-xs shrink-0"
                    disabled={actionsDisabled}
                    data-testid="suggested-action-use"
                    onClick={() => onUseSuggestedAction(a.actionIndex!, a.name, a.spec!)}
                  >
                    Use
                  </button>
                )}
              </li>
            ))}
            {filteredActions.length === 0 && <li className="text-sm text-muted">No matching actions.</li>}
          </ul>
        </section>
      )}

      {/* End turn — a player may end their own turn when allowed; the DM always may. */}
      <div className="flex items-center gap-2 flex-wrap">
        {turn.canEndTurn ? (
          <Btn disabled={controlsDisabled} onClick={() => endTurn.mutate({})} data-testid="workspace-end-turn">
            {turn.isYourTurn ? 'End my turn →' : 'End turn →'}
          </Btn>
        ) : turn.isYourTurn && turn.dmControlsTurns ? (
          <span className="text-sm text-muted">The DM advances turns in this campaign.</span>
        ) : null}
        {turn.isYourTurn && turn.requireDmTurnConfirmation && !isDm && (
          <span className="text-sm text-muted">Ending your turn will ask the DM to confirm.</span>
        )}
      </div>
    </Card>
  );
}
