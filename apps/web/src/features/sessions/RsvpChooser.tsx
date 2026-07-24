/**
 * Session RSVP segmented radiogroup (issue #645).
 *
 * Replaces ghost buttons with a WAI-ARIA radiogroup so touch, keyboard, and
 * screen-reader users get a named group, selected state, and arrow-key
 * navigation matching RollModeChooser / NotesRail segmented controls.
 */
import { useCallback, useRef, type KeyboardEvent } from 'react';
import { rsvpOptions, type RsvpOption } from './schedulePanelA11y';
import type { RsvpStatus } from '@campfire/schema';

export type RsvpChooserProps = {
  value: RsvpStatus | null;
  onChange: (status: RsvpStatus) => void;
  disabled?: boolean;
  /** id of the visible legend element (`RSVP_GROUP_LEGEND`). */
  'aria-labelledby': string;
};

const ORDER = rsvpOptions();

export function RsvpChooser({ value, onChange, disabled = false, ...rest }: RsvpChooserProps) {
  const labelledBy = rest['aria-labelledby'];
  const refs = useRef<Partial<Record<RsvpStatus, HTMLButtonElement | null>>>({});

  const focusStatus = useCallback((status: RsvpStatus) => {
    refs.current[status]?.focus();
  }, []);

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, opt: RsvpOption) {
    const idx = ORDER.findIndex((o) => o.status === opt.status);
    let nextIdx: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') nextIdx = (idx + 1) % ORDER.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') nextIdx = (idx - 1 + ORDER.length) % ORDER.length;
    else if (e.key === 'Home') nextIdx = 0;
    else if (e.key === 'End') nextIdx = ORDER.length - 1;
    if (nextIdx == null) return;
    e.preventDefault();
    const next = ORDER[nextIdx]!;
    onChange(next.status);
    focusStatus(next.status);
  }

  return (
    <div
      className="seg seg-wrap cf-schedule-rsvp"
      role="radiogroup"
      aria-labelledby={labelledBy}
      aria-disabled={disabled || undefined}
      data-testid="schedule-rsvp-chooser"
      style={{ minWidth: 0 }}
    >
      {ORDER.map((opt) => {
        const checked = value === opt.status;
        const tabbable =
          value != null ? checked : opt.status === 'yes';
        return (
          <button
            key={opt.status}
            ref={(el) => {
              refs.current[opt.status] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={opt.description}
            tabIndex={tabbable ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(opt.status)}
            onKeyDown={(e) => onKeyDown(e, opt)}
            className="seg-opt cf-schedule-rsvp-opt !min-h-0 !py-1 !px-2.5 text-xs"
            style={
              checked
                ? { color: 'var(--color-accent)', boxShadow: 'inset 0 0 0 1px var(--color-accent)' }
                : undefined
            }
            title={opt.description}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
