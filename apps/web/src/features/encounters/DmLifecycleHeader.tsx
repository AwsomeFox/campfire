import { useTranslation } from 'react-i18next';
import { Btn } from '../../components/ui';
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
  undoTurnGateReason,
} from './lifecycleGate';

/** Ties the Start button to its standing roster instruction for assistive tech. */
const START_ROSTER_HINT_ID = 'start-roster-hint';

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
}: Props) {
  const { t } = useTranslation();

  if (!canDmWrite) return null;

  return (
    <div className="flex gap-2 flex-wrap">
      {lifecycle.rollInitiative && lifecycle.start && (
        <>
          {/* Issue #702: the server treats a fully-rolled roster as a no-op (no
              write, no audit), so the button must reflect that — disabled when
              nobody needs initiative, and labeled "Roll remaining (N)" when the
              roster is partial (e.g. a manually-set combatant alongside unrolled
              ones). Hidden entirely rather than dead weight once Start is live. */}
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
          {(() => {
            const startReasonKey = startGateReason({
              safetyHoldActive,
              riskyBlocked,
              hasNoCombatants,
              needsInitiativeCount,
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
            const standingHintKey = startRosterHintReason({ hasNoCombatants, needsInitiativeCount });
            const standingHint = gateReasonText(standingHintKey, t);
            return (
              <div className="flex flex-col gap-0.5 items-stretch">
                {/* `w-full` on the WRAPPER, not the Btn: the wrapper is the flex item of
                    this `items-stretch` column, and it is `inline-flex`, so without this
                    it shrinks to the button's content and Start stops matching the hint
                    paragraph's width (issue #1933 review). */}
                <GatedControl reason={startReason} className="w-full">
                  <Btn
                    disabled={headerBusy || riskyBlocked || hasNoCombatants || needsInitiativeCount > 0}
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
              roll (issue #702), and surface how many still need rolling. */}
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
