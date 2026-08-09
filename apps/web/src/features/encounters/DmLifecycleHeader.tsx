import { useTranslation } from 'react-i18next';
import { Btn } from '../../components/ui';
import { GameIcon } from '../../components/GameIcon';
import { GatedControl } from '../../components/GatedControl';
import type { EncounterLifecycleActions } from './encounterLifecycleActions';
import { ENCOUNTER_SYNC_BANNER_TESTID } from './encounterSyncState';
import {
  gateReasonText,
  nextTurnGateReason,
  rollInitiativeGateReason,
  startGateReason,
  startRosterHintReason,
  syncOnlyGateReason,
  turnTimerControlDisabled,
  turnTimerControlVisible,
  undoTurnGateReason,
} from './lifecycleGate';

/** Ties the Start button to its standing roster instruction for assistive tech. */
const START_ROSTER_HINT_ID = 'start-roster-hint';

/** Turn timer (issue #1935) preset choices — 0 = off (elapsed-only, DM-facing chip). */
const TURN_TIMER_PRESETS = [0, 60, 90, 120] as const;

/** Small inline stopwatch popover: DM sets the pacing-limit preset via the existing PATCH. */
function TurnTimerControl({
  turnTimerSeconds,
  onSetTurnTimerSeconds,
  disabled,
}: {
  turnTimerSeconds: number;
  onSetTurnTimerSeconds: (seconds: number) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  return (
    <details className="cf-turn-timer-control">
      <summary
        className="btn btn-ghost cf-target-44"
        aria-label={t('encounters.turnTimer.settingsLabel')}
        title={t('encounters.turnTimer.settingsTitle')}
      >
        <GameIcon slug="stopwatch" size={14} className="inline align-text-bottom" />
      </summary>
      <div className="cf-turn-timer-control-menu flex flex-col gap-1.5">
        <p className="text-muted text-xs m-0">{t('encounters.turnTimer.settingsHint')}</p>
        <div className="flex gap-1 flex-wrap">
          {TURN_TIMER_PRESETS.map((seconds) => (
            <Btn
              key={seconds}
              ghost
              density="xs"
              disabled={disabled}
              aria-pressed={turnTimerSeconds === seconds}
              className={turnTimerSeconds === seconds ? 'cf-turn-timer-preset-active' : ''}
              onClick={() => onSetTurnTimerSeconds(seconds)}
            >
              {seconds === 0 ? t('encounters.turnTimer.off') : t('encounters.turnTimer.presetSeconds', { seconds })}
            </Btn>
          ))}
        </div>
      </div>
    </details>
  );
}

export type Props = {
  canDmWrite: boolean;
  lifecycle: EncounterLifecycleActions;
  headerBusy: boolean;
  riskyBlocked: boolean;
  /** #599: mirrors the server's assertNoSafetyHold rejection on start/nextTurn/undoTurn —
   *  no server change, just surfacing the same table-wide safety-hold state (already
   *  visible via SafetyHoldBar) as a reason on the controls it actually blocks. */
  safetyHoldActive: boolean;
  needsInitiativeCount: number;
  /**
   * Whether this campaign's rule system rolls initiative at all (issue #2123,
   * `hasInitiativeRollForAdapter`). False hides both Roll-initiative buttons outright — the
   * server 400s that write, and turn order comes from the roster instead — and drops the
   * "roll initiative first" precondition from Start, which the server no longer applies
   * either. Not a `disabled`: a control for a roll the game does not have has nothing to
   * explain, the same reasoning that hides the per-combatant button under group initiative.
   */
  initiativeRollSupported: boolean;
  hasNoCombatants: boolean;
  undoTurnDisabled: boolean;
  nextTurnAriaKeyshortcuts: string | undefined;
  nextTurnTitle: string;
  deleteLabel: string;
  onRollInitiative: () => void;
  onStart: () => void;
  onUndoTurn: () => void;
  onNextTurn: () => void;
  onRequestEnd: () => void;
  onRequestReopen: () => void;
  onRequestDelete: () => void;
  /** Turn timer (issue #1935) — current DM-set pacing limit, and how to change it. */
  turnTimerSeconds: number;
  onSetTurnTimerSeconds: (seconds: number) => void;
};

export type EncounterSyncBannerProps = {
  encounterSyncBanner: string | null;
  encounterSyncLastSyncTitle: string | undefined;
};

/** DM-only lifecycle controls plus the encounter-sync status banner. */
export function DmLifecycleHeader({
  canDmWrite,
  lifecycle,
  headerBusy,
  riskyBlocked,
  safetyHoldActive,
  needsInitiativeCount,
  initiativeRollSupported,
  hasNoCombatants,
  undoTurnDisabled,
  nextTurnAriaKeyshortcuts,
  nextTurnTitle,
  deleteLabel,
  onRollInitiative,
  onStart,
  onUndoTurn,
  onNextTurn,
  onRequestEnd,
  onRequestReopen,
  onRequestDelete,
  turnTimerSeconds,
  onSetTurnTimerSeconds,
}: Props) {
  const { t } = useTranslation();

  if (!canDmWrite) return null;

  return (
    <div className="flex gap-2 flex-wrap">
      {/* Issue #1935 review: gated like every sibling control here — hidden once the
          encounter is 'ended' (PATCH would 409 via assertMutable, producing an
          unexplained error banner for a tap that can never succeed), and disabled
          alongside the other conflict-prone writes when the sync state is stale
          (riskyBlocked), not just while a request is already in flight. */}
      {turnTimerControlVisible(lifecycle.reopen) && (
        <TurnTimerControl
          turnTimerSeconds={turnTimerSeconds}
          onSetTurnTimerSeconds={onSetTurnTimerSeconds}
          disabled={turnTimerControlDisabled({ headerBusy, riskyBlocked })}
        />
      )}
      {lifecycle.rollInitiative && lifecycle.start && (
        <>
          {/* Issue #702: the server treats a fully-rolled roster as a no-op (no
              write, no audit), so the button must reflect that — disabled when
              nobody needs initiative, and labeled "Roll remaining (N)" when the
              roster is partial (e.g. a manually-set combatant alongside unrolled
              ones). Hidden entirely rather than dead weight once Start is live.
              Absent altogether for a system with no initiative roll (issue #2123) —
              `EncountersService.rollInitiative` 400s there, and the DM arranges the
              turn order by dragging the roster instead. */}
          {initiativeRollSupported && (
            <GatedControl
              reason={gateReasonText(rollInitiativeGateReason({ riskyBlocked, needsInitiativeCount }), t, headerBusy)}
            >
              <Btn
                ghost
                disabled={headerBusy || riskyBlocked || needsInitiativeCount === 0}
                onClick={onRollInitiative}
              >
                {needsInitiativeCount > 0
                  ? t('encounters.run.rollRemaining', { count: needsInitiativeCount })
                  : t('encounters.run.rollInitiative')}
              </Btn>
            </GatedControl>
          )}
          {(() => {
            const startReasonKey = startGateReason({
              safetyHoldActive,
              riskyBlocked,
              hasNoCombatants,
              needsInitiativeCount,
              initiativeRollSupported,
            });
            const startReason = gateReasonText(startReasonKey, t, headerBusy);
            // Issue #1933 review finding: the roster-state reasons (no combatants yet /
            // initiative incomplete) are a standing "what to do next" instruction, not a
            // transient one like the sync gate or a safety hold — this used to be a
            // permanently visible paragraph, and hiding it behind hover/focus/tap made a
            // sighted DM who never hovers, and a touch user who never taps a disabled
            // button, see an unexplained greyed-out Start. Keep the paragraph, source it
            // from the SAME run.gate.* string GatedControl uses so the two can never drift.
            //
            // Second review round: it must come from `startRosterHintReason`, NOT from
            // `startGateReason`'s single winning key. The gate resolver is a priority
            // question ("what would the server reject first"), so a safety hold or a sync
            // outage outranks the roster and the paragraph disappeared during exactly the
            // states where the DM most needs to know what setup step is still owed. The
            // roster condition is unchanged by either transient gate, so it is resolved
            // independently and rendered alongside whichever transient reason the tooltip
            // is showing.
            const standingHintKey = startRosterHintReason({ hasNoCombatants, needsInitiativeCount, initiativeRollSupported });
            const standingHint = gateReasonText(standingHintKey, t);
            // When the winning gate reason IS the roster reason, the paragraph below is
            // already saying it — and `GatedControl` would emit a second, visually-hidden
            // copy and merge it into the button's `aria-describedby`, so a screen reader
            // announces the same sentence twice and `getByText` resolves to two nodes
            // (issue #1933 review). The paragraph is the better single source: it is
            // visible to everyone, not only on hover/focus. So pass a tooltip reason only
            // when it is something the paragraph is NOT already carrying.
            const tooltipReason = startReasonKey === standingHintKey ? undefined : startReason;
            return (
              <div className="flex flex-col gap-0.5 items-stretch">
                {/* `w-full` on the WRAPPER, not the Btn: the wrapper is the flex item of
                    this `items-stretch` column, and it is `inline-flex`, so without this
                    it shrinks to the button's content and Start stops matching the hint
                    paragraph's width (issue #1933 review). */}
                <GatedControl reason={tooltipReason} className="w-full">
                  {/* `w-full` on BOTH: the wrapper stretches to the column, and the Btn —
                      a flex item of that inline-flex wrapper with default `flex: 0 1 auto`
                      — has to be told to fill it, or it sizes to its text and the fix is
                      only half a fix (issue #1933 review, second round on this line). */}
                  <Btn
                    className="w-full"
                    // `initiativeRollSupported &&` on the initiative term only (issue #2123):
                    // an empty roster still blocks Start for every system, but an unrolled one
                    // is the normal, expected state where there is no roll to make — and
                    // `EncountersService.start` skips the same precondition, so keeping it here
                    // would disable a button the server would have accepted.
                    disabled={headerBusy || riskyBlocked || hasNoCombatants || (initiativeRollSupported && needsInitiativeCount > 0)}
                    onClick={onStart}
                    aria-describedby={standingHint ? START_ROSTER_HINT_ID : undefined}
                  >
                    {t('encounters.run.start')}
                  </Btn>
                </GatedControl>
                {standingHint && (
                  <p id={START_ROSTER_HINT_ID} className="text-muted text-xs m-0 max-w-[14rem]">
                    {standingHint}
                  </p>
                )}
              </div>
            );
          })()}
        </>
      )}
      {lifecycle.undoTurn && (
        <GatedControl
          reason={gateReasonText(undoTurnGateReason({ safetyHoldActive, riskyBlocked, undoTurnDisabled }), t, headerBusy)}
        >
          <Btn
            ghost
            disabled={headerBusy || riskyBlocked || undoTurnDisabled}
            onClick={onUndoTurn}
            title="Undo turn"
          >
            ← Undo turn
          </Btn>
        </GatedControl>
      )}
      {lifecycle.rollInitiative && lifecycle.nextTurn && (
        <>
          {/* Reinforcements added mid-fight land at null initiative and sort last —
              keep Roll initiative reachable so the DM can fill them (issue #54).
              Already-set initiatives are left untouched server-side. Once every
              combatant has a value, disable the control rather than firing a no-op
              roll (issue #702), and surface how many still need rolling. Absent for a
              system with no initiative roll (issue #2123): a mid-fight arrival there is
              placed by dragging it, and "sort last" is already where the roster puts it. */}
          {initiativeRollSupported && (
            <GatedControl
              reason={gateReasonText(rollInitiativeGateReason({ riskyBlocked, needsInitiativeCount }), t, headerBusy)}
            >
              <Btn
                ghost
                disabled={headerBusy || riskyBlocked || needsInitiativeCount === 0}
                onClick={onRollInitiative}
              >
                {needsInitiativeCount > 0
                  ? t('encounters.run.rollRemaining', { count: needsInitiativeCount })
                  : t('encounters.run.rollInitiative')}
              </Btn>
            </GatedControl>
          )}
          <GatedControl reason={gateReasonText(nextTurnGateReason({ safetyHoldActive, riskyBlocked }), t, headerBusy)}>
            <Btn
              data-testid="encounter-header-next-turn"
              disabled={headerBusy || riskyBlocked}
              onClick={onNextTurn}
              aria-keyshortcuts={nextTurnAriaKeyshortcuts}
              title={nextTurnTitle}
            >
              {t('encounters.run.nextTurn')}
            </Btn>
          </GatedControl>
        </>
      )}
      {lifecycle.end && (
        // Issue #1446: End writes an HP/condition/death-state snapshot back to each
        // linked character sheet (cross-entity, no CAS guard) — genuinely conflict-prone,
        // so it stays gated (confirmable via the override, not ungated outright). Not
        // safety-hold guarded server-side (see lifecycleGate.ts), so only the sync gate
        // gets a GatedControl reason here.
        <GatedControl reason={gateReasonText(syncOnlyGateReason(riskyBlocked), t, headerBusy)}>
          <Btn ghost danger disabled={headerBusy || riskyBlocked} onClick={onRequestEnd}>
            {t('encounters.run.end')}
          </Btn>
        </GatedControl>
      )}
      {lifecycle.reopen && (
        <GatedControl reason={gateReasonText(syncOnlyGateReason(riskyBlocked), t, headerBusy)}>
          <Btn ghost disabled={headerBusy || riskyBlocked} onClick={onRequestReopen}>
            {t('encounters.run.reopen')}
          </Btn>
        </GatedControl>
      )}
      {lifecycle.delete && (
        // Issue #1446: delete has no revision/CAS guard server-side and clears the
        // campaign's active-encounter pointer — a stale tab can trash an encounter
        // another DM/the AI driver is actively updating. Racing a destructive,
        // effectively unrecoverable action is worse than racing a turn advance, so
        // this stays gated (confirmable via the override, not ungated outright).
        <GatedControl reason={gateReasonText(syncOnlyGateReason(riskyBlocked), t, headerBusy)}>
          <Btn ghost danger disabled={headerBusy || riskyBlocked} onClick={onRequestDelete}>
            {deleteLabel}
          </Btn>
        </GatedControl>
      )}
    </div>
  );
}

/** Informational sync state, deliberately rendered outside the header flex row. */
export function EncounterSyncBanner({ encounterSyncBanner, encounterSyncLastSyncTitle }: EncounterSyncBannerProps) {
  if (!encounterSyncBanner) return null;

  return (
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
  );
}
