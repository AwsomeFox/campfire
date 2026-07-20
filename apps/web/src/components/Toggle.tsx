/**
 * Accessible checkbox-style toggle — a real interactive control (button +
 * role="checkbox") replacing span-based "checkbox" affordances that only
 * responded to onClick (no keyboard support, no a11y semantics).
 * Visually renders as the existing square check glyph used across quest
 * objective rows; callers control exact sizing via style overrides if needed.
 */
import type { CSSProperties, KeyboardEvent } from 'react';

export function Toggle({
  checked,
  onChange,
  disabled = false,
  label,
  title,
  size = 17,
  className,
  style,
}: {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  label?: string;
  /** Native tooltip — handy for explaining why the control is disabled. */
  title?: string;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      onChange();
    }
  }

  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      title={title}
      tabIndex={disabled ? -1 : 0}
      disabled={disabled}
      onClick={() => !disabled && onChange()}
      onKeyDown={onKeyDown}
      className={className}
      style={{
        width: size,
        height: size,
        flex: 'none',
        borderRadius: 4,
        border: '1.5px solid var(--color-neutral-600)',
        display: 'grid',
        placeItems: 'center',
        fontSize: Math.round(size * 0.65),
        color: 'var(--color-accent-100)',
        cursor: disabled ? 'default' : 'pointer',
        background: checked ? 'var(--color-accent)' : 'transparent',
        borderColor: checked ? 'var(--color-accent)' : 'var(--color-neutral-600)',
        padding: 0,
        ...style,
      }}
    >
      {checked ? '✓' : ''}
    </button>
  );
}
