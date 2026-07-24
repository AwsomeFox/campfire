/**
 * Corner toast for a local dice roll result (issue #1315). Surfaces expression,
 * dice breakdown, total (with the same tumble/crit/fumble flourish as the shared
 * log), and an optional one-tap Apply action when rolling in an active encounter.
 * Non-blocking, dismissible, and respects prefers-reduced-motion via cf-anim-*.
 */
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { DiceRoll } from '@campfire/schema';
import { RolledDice } from '../features/dice/RolledDice';
import { RolledTerms } from '../features/dice/RolledTerms';
import { d20Flavor, d20TotalClasses } from '../lib/d20Flavor';

const AUTO_DISMISS_MS = 8000;

export function RollResultToast({
  roll,
  onDismiss,
  onApply,
}: {
  roll: DiceRoll;
  onDismiss: () => void;
  /** When set, shows an Apply button (encounter apply-damage shortcut). */
  onApply?: () => void;
}) {
  const { t } = useTranslation();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flavor = d20Flavor(roll);
  const crit = flavor === 'crit';
  const fumble = flavor === 'fumble';
  const totalColor = crit ? 'var(--cf-crit, #fbbf24)' : fumble ? 'var(--color-danger, #f87171)' : 'var(--color-accent)';
  const totalClass = d20TotalClasses(flavor, true);
  const assertive = crit || fumble;

  useEffect(() => {
    timerRef.current = setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => {
      if (timerRef.current != null) clearTimeout(timerRef.current);
    };
  }, [onDismiss, roll.id]);

  function dismiss() {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    onDismiss();
  }

  function apply() {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    onApply?.();
  }

  return (
    <div
      role="status"
      aria-live={assertive ? 'assertive' : 'polite'}
      aria-atomic="true"
      data-testid="roll-result-toast"
      className="cf-roll-result-toast"
    >
      <div className="cf-roll-result-toast__body">
        <p
          className="cf-roll-result-toast__label cf-name-reveal"
          title={roll.label || roll.expr}
          aria-label={roll.label || roll.expr}
        >
          {roll.label || roll.expr}
        </p>
        <p className="cf-roll-result-toast__meta">
          <span>{roll.expr}</span>
          <RolledDice rolls={roll.rolls} kept={roll.kept} fontSize={11} />
          {roll.terms && <RolledTerms terms={roll.terms} fontSize={11} />}
          {crit && <span style={{ color: totalColor }}>nat 20!</span>}
          {fumble && <span style={{ color: totalColor }}>nat 1</span>}
        </p>
      </div>
      <span
        className={totalClass || undefined}
        style={{ fontFamily: 'var(--font-heading)', fontSize: 28, lineHeight: 1, color: totalColor, flex: 'none' }}
      >
        {roll.total}
      </span>
      {onApply && (
        <button
          type="button"
          className="cf-btn cf-btn-ghost cf-roll-result-toast__apply"
          onClick={apply}
          data-testid="roll-result-apply"
        >
          {t('dice.applyDamage')}
        </button>
      )}
      <button
        type="button"
        aria-label={t('dice.dismissRollToast')}
        onClick={dismiss}
        className="cf-dismiss-target cf-roll-result-toast__dismiss"
        data-testid="roll-result-toast-dismiss"
      >
        ✕
      </button>
    </div>
  );
}
