import { useTranslation } from 'react-i18next';
import { GatedControl } from '../../../components/GatedControl';
import type { DeathSaveOutcome } from './deathSaveOutcome';

export type DeathSavePatch = { deathSaveSuccesses?: number; deathSaveFailures?: number };

/**
 * The sync-outage reason, but only when the sync gate is the thing actually blocking
 * this control (issue #1933 review).
 *
 * `GatedControl` deliberately strips the native `disabled` attribute whenever a reason is
 * present, so the control stays focusable and can announce why it is off. That is right
 * for a transient gate the viewer can wait out, and wrong for a permanent one: a viewer
 * with no edit permission would get a focusable, `aria-disabled` pip announced as "paused
 * while reconnecting", when permission — not the outage — is what blocks them, and no
 * amount of waiting will change it. Same for an in-flight request (`busy`).
 *
 * Returning `undefined` in those cases leaves the control natively disabled, which is the
 * honest state: not yours / not right now, with no reason claimed.
 */
export function syncGateReason(input: {
  canEditPermission: boolean;
  busy: boolean;
  syncBlocked: boolean;
  syncBlockedReason?: string;
}): string | undefined {
  if (!input.canEditPermission || input.busy || !input.syncBlocked) return undefined;
  return input.syncBlockedReason;
}
export const DEATH_STATE_LABEL: Record<string, string> = { dying: 'Dying', stable: 'Stable', dead: 'Dead' };

/**
 * Issue #1919 — localized text + a style hook for the transient outcome banner shown
 * right after a death-save roll settles. Kept beside the classifier's `DeathSaveOutcomeKind`
 * so every renderer of an outcome (the roller's own tracker, and any future surface) agrees
 * on wording. `natural` feeds the `{{natural}}` interpolation for the plain success/failure
 * copy; the revive/dead/stabilized copy names the transition itself and ignores it.
 */
function deathSaveOutcomeText(
  t: (key: string, fallback: string, opts?: Record<string, unknown>) => string,
  outcome: DeathSaveOutcome,
): string {
  switch (outcome.kind) {
    case 'revive':
      return t('encounters.deathSave.outcome.revive', 'Natural 20 — back on your feet!');
    case 'dead':
      return t('encounters.deathSave.outcome.dead', 'Died.');
    case 'stabilized':
      return t('encounters.deathSave.outcome.stabilized', 'Stabilized.');
    case 'success':
      return t('encounters.deathSave.outcome.success', 'Success (rolled {{natural}}).', { natural: outcome.natural });
    case 'failure':
    default:
      return t('encounters.deathSave.outcome.failure', 'Failure (rolled {{natural}}).', { natural: outcome.natural });
  }
}

export type DeathSavePipsProps = {
  kind: 'deathSaveSuccesses' | 'deathSaveFailures';
  count: number;
  color: string;
  canEditPermission: boolean;
  busy: boolean;
  syncBlocked: boolean;
  syncBlockedReason?: string;
  onSet: (patch: DeathSavePatch) => void;
  /** Issue #1919: brief brightness flash on the pip group a just-settled roll changed. */
  flash?: boolean;
};

/** Death-save pips stay at module scope to retain stable React element identity. */
export function DeathSavePips({
  kind,
  count,
  color,
  canEditPermission,
  busy,
  syncBlocked,
  syncBlockedReason,
  onSet,
  flash = false,
}: DeathSavePipsProps) {
  const gateReason = syncGateReason({ canEditPermission, busy, syncBlocked, syncBlockedReason });
  return (
    <span
      className={flash ? 'cf-death-save-pips-flash' : undefined}
      style={{ display: 'inline-flex', gap: 4 }}
      data-testid={`death-save-${kind === 'deathSaveSuccesses' ? 'success' : 'failure'}-pips`}
    >
      {[0, 1, 2].map((i) => {
        const filled = i < count;
        const next = count === i + 1 ? i : i + 1;
        return (
          <GatedControl key={i} reason={gateReason}>
            <button
              type="button"
              className="cf-death-save-pip"
              aria-label={`${kind === 'deathSaveSuccesses' ? 'Success' : 'Failure'} ${i + 1} of 3${filled ? ' (marked)' : ''}`}
              aria-pressed={filled}
              disabled={!canEditPermission || busy || syncBlocked}
              onClick={() => onSet({ [kind]: next })}
              style={{
                ['--cf-death-save-pip-color' as string]: color,
                ['--cf-death-save-pip-fill' as string]: filled ? color : 'transparent',
                cursor: canEditPermission && !busy && !syncBlocked ? 'pointer' : 'default',
              }}
            />
          </GatedControl>
        );
      })}
    </span>
  );
}

export type DeathSaveTrackerProps = {
  successes: number;
  failures: number;
  canEditPermission: boolean;
  canRoll: boolean;
  busy: boolean;
  syncBlocked: boolean;
  syncBlockedReason?: string;
  onSet: (patch: DeathSavePatch) => void;
  onRoll: () => void;
  /**
   * Issue #1919 — the just-settled roll's outcome, or null/undefined once the table-holds-
   * breath moment has faded. Drives which pip group flashes and the transient outcome
   * banner text; absent entirely between rolls (no persisted state, no schema change).
   */
  outcome?: DeathSaveOutcome | null;
};

export function DeathSaveTracker({
  successes,
  failures,
  canEditPermission,
  canRoll,
  busy,
  syncBlocked,
  syncBlockedReason,
  onSet,
  onRoll,
  outcome,
}: DeathSaveTrackerProps) {
  const { t } = useTranslation();
  // The Roll button only renders for a permitted viewer, so permission is never the
  // blocker here — but `busy` still is, and it is not a sync outage either.
  const rollGateReason = syncGateReason({ canEditPermission, busy, syncBlocked, syncBlockedReason });
  // Nat 20 resets both counters (revive), so there is no pip left to flash — the banner
  // alone (plus the dice overlay's own crit ring, issue #1352) carries that moment.
  const flashGroup: 'deathSaveSuccesses' | 'deathSaveFailures' | null =
    outcome == null || outcome.natural === 20 ? null : outcome.natural >= 10 ? 'deathSaveSuccesses' : 'deathSaveFailures';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 5 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', fontSize: 'var(--type-label)', flexWrap: 'wrap' }} data-testid="death-save-tracker">
        <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
          <span className="text-muted" style={{ letterSpacing: 0.3 }}>Saves</span>
          <DeathSavePips kind="deathSaveSuccesses" count={successes} color="var(--color-accent)" canEditPermission={canEditPermission} busy={busy} syncBlocked={syncBlocked} syncBlockedReason={syncBlockedReason} onSet={onSet} flash={flashGroup === 'deathSaveSuccesses'} />
        </span>
        <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
          <span className="text-muted" style={{ letterSpacing: 0.3 }}>Fails</span>
          <DeathSavePips kind="deathSaveFailures" count={failures} color="#e5484d" canEditPermission={canEditPermission} busy={busy} syncBlocked={syncBlocked} syncBlockedReason={syncBlockedReason} onSet={onSet} flash={flashGroup === 'deathSaveFailures'} />
        </span>
        {canEditPermission && canRoll && (
          <GatedControl reason={rollGateReason}>
            <button type="button" className="btn btn-ghost cf-target-44" aria-label="Roll a death save" title={rollGateReason ?? 'Roll a death save (nat 1 = two fails, nat 20 = revive at 1 HP)'} disabled={busy || syncBlocked} onClick={onRoll} style={{ fontSize: 'var(--type-label)', padding: '0 12px', border: '1px dashed var(--color-divider)', borderRadius: 'var(--radius-md)' }}>
              {t('dice.roll')}
            </button>
          </GatedControl>
        )}
      </div>
      {/* Visible-only (same convention as TurnChangeBeat, issue #1906): the existing
          combat-log Announcer remains the one and only screen-reader channel for this
          roll's outcome, so this banner carries no ARIA live role of its own — it would
          otherwise double-announce the same roll a moment later. */}
      {outcome != null && (
        <span
          className={`cf-death-save-outcome cf-death-save-outcome--${outcome.kind}`}
          data-testid="death-save-outcome"
          data-outcome-kind={outcome.kind}
        >
          {deathSaveOutcomeText(t, outcome)}
        </span>
      )}
    </div>
  );
}
