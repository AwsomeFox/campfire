import { useTranslation } from 'react-i18next';
import { Btn } from '../../components/ui';
import type { EncounterLifecycleActions } from './encounterLifecycleActions';
import { ENCOUNTER_SYNC_BANNER_TESTID } from './encounterSyncState';

export type Props = {
  canDmWrite: boolean;
  lifecycle: EncounterLifecycleActions;
  headerBusy: boolean;
  riskyBlocked: boolean;
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
          <Btn
            ghost
            disabled={headerBusy || riskyBlocked || needsInitiativeCount === 0}
            onClick={onRollInitiative}
            title={needsInitiativeCount === 0 ? 'All combatants already have initiative' : undefined}
          >
            {needsInitiativeCount > 0
              ? t('encounters.run.rollRemaining', { count: needsInitiativeCount })
              : t('encounters.run.rollInitiative')}
          </Btn>
          <div className="flex flex-col gap-0.5 items-stretch">
            <Btn
              disabled={headerBusy || riskyBlocked || hasNoCombatants || needsInitiativeCount > 0}
              onClick={onStart}
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
          disabled={headerBusy || riskyBlocked || undoTurnDisabled}
          onClick={onUndoTurn}
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
            onClick={onRollInitiative}
            title={needsInitiativeCount === 0 ? 'All combatants already have initiative' : undefined}
          >
            {needsInitiativeCount > 0
              ? t('encounters.run.rollRemaining', { count: needsInitiativeCount })
              : t('encounters.run.rollInitiative')}
          </Btn>
          <Btn
            data-testid="encounter-header-next-turn"
            disabled={headerBusy || riskyBlocked}
            onClick={onNextTurn}
            aria-keyshortcuts={nextTurnAriaKeyshortcuts}
            title={nextTurnTitle}
          >
            {t('encounters.run.nextTurn')}
          </Btn>
        </>
      )}
      {lifecycle.end && (
        // Issue #1446: End writes an HP/condition/death-state snapshot back to each
        // linked character sheet (cross-entity, no CAS guard) — genuinely conflict-prone,
        // so it stays gated (confirmable via the override, not ungated outright).
        <Btn ghost danger disabled={headerBusy || riskyBlocked} onClick={onRequestEnd}>
          {t('encounters.run.end')}
        </Btn>
      )}
      {lifecycle.reopen && (
        <Btn ghost disabled={headerBusy || riskyBlocked} onClick={onRequestReopen}>
          {t('encounters.run.reopen')}
        </Btn>
      )}
      {lifecycle.delete && (
        // Issue #1446: delete has no revision/CAS guard server-side and clears the
        // campaign's active-encounter pointer — a stale tab can trash an encounter
        // another DM/the AI driver is actively updating. Racing a destructive,
        // effectively unrecoverable action is worse than racing a turn advance, so
        // this stays gated (confirmable via the override, not ungated outright).
        <Btn ghost danger disabled={headerBusy || riskyBlocked} onClick={onRequestDelete}>
          {deleteLabel}
        </Btn>
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
