export type DeathSavePatch = { deathSaveSuccesses?: number; deathSaveFailures?: number };
export const DEATH_STATE_LABEL: Record<string, string> = { dying: 'Dying', stable: 'Stable', dead: 'Dead' };

export type DeathSavePipsProps = {
  kind: 'deathSaveSuccesses' | 'deathSaveFailures';
  count: number;
  color: string;
  canEditPermission: boolean;
  busy: boolean;
  syncBlocked: boolean;
  syncBlockedReason?: string;
  syncBlockedDescribedBy?: string;
  onSet: (patch: DeathSavePatch) => void;
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
  syncBlockedDescribedBy,
  onSet,
}: DeathSavePipsProps) {
  return (
    <span style={{ display: 'inline-flex', gap: 4 }} data-testid={`death-save-${kind === 'deathSaveSuccesses' ? 'success' : 'failure'}-pips`}>
      {[0, 1, 2].map((i) => {
        const filled = i < count;
        const next = count === i + 1 ? i : i + 1;
        return (
          <button
            key={i}
            type="button"
            className="cf-death-save-pip"
            aria-label={`${kind === 'deathSaveSuccesses' ? 'Success' : 'Failure'} ${i + 1} of 3${filled ? ' (marked)' : ''}`}
            aria-pressed={filled}
            aria-describedby={syncBlockedDescribedBy}
            disabled={!canEditPermission || busy || syncBlocked}
            title={syncBlockedReason}
            onClick={() => onSet({ [kind]: next })}
            style={{
              ['--cf-death-save-pip-color' as string]: color,
              ['--cf-death-save-pip-fill' as string]: filled ? color : 'transparent',
              cursor: canEditPermission && !busy && !syncBlocked ? 'pointer' : 'default',
            }}
          />
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
  syncBlockedDescribedBy?: string;
  onSet: (patch: DeathSavePatch) => void;
  onRoll: () => void;
};

export function DeathSaveTracker({
  successes,
  failures,
  canEditPermission,
  canRoll,
  busy,
  syncBlocked,
  syncBlockedReason,
  syncBlockedDescribedBy,
  onSet,
  onRoll,
}: DeathSaveTrackerProps) {
  const { t } = useTranslation();

  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 5, fontSize: 'var(--type-label)', flexWrap: 'wrap' }} data-testid="death-save-tracker">
      <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
        <span className="text-muted" style={{ letterSpacing: 0.3 }}>Saves</span>
        <DeathSavePips kind="deathSaveSuccesses" count={successes} color="var(--color-accent)" canEditPermission={canEditPermission} busy={busy} syncBlocked={syncBlocked} syncBlockedReason={syncBlockedReason} syncBlockedDescribedBy={syncBlockedDescribedBy} onSet={onSet} />
      </span>
      <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
        <span className="text-muted" style={{ letterSpacing: 0.3 }}>Fails</span>
        <DeathSavePips kind="deathSaveFailures" count={failures} color="#e5484d" canEditPermission={canEditPermission} busy={busy} syncBlocked={syncBlocked} syncBlockedReason={syncBlockedReason} syncBlockedDescribedBy={syncBlockedDescribedBy} onSet={onSet} />
      </span>
      {canEditPermission && canRoll && (
        <button type="button" className="btn btn-ghost cf-target-44" aria-label="Roll a death save" aria-describedby={syncBlockedDescribedBy} title={syncBlockedReason ?? 'Roll a death save (nat 1 = two fails, nat 20 = revive at 1 HP)'} disabled={busy || syncBlocked} onClick={onRoll} style={{ fontSize: 'var(--type-label)', padding: '0 12px', border: '1px dashed var(--color-divider)', borderRadius: 'var(--radius-md)' }}>
          {t('dice.roll')}
        </button>
      )}
    </div>
  );
}
import { useTranslation } from 'react-i18next';
