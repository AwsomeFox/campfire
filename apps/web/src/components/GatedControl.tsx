/**
 * Shared gating-reason affordance (issue #1933).
 *
 * The encounter run page has at least six distinct reasons a combat control can be
 * disabled (sync outage, not-your-turn/DM-controls-turns, no grid scale, an adv/dis pool
 * that isn't a lone d20, the lifecycle status matrix, a table safety hold) but most of them
 * just greyed the control out. A dead button is indistinguishable from a bug to a new
 * player mid-fight, and on a touch device a disabled button gives zero feedback on tap at
 * all. `GatedControl` is the one place that turns "disabled" into "disabled, and here is
 * why":
 *
 *  - the reason is reachable by screen reader via `aria-describedby` (issue #1746's
 *    CombatantRow pattern, generalized) — not `title` alone, which screen readers announce
 *    inconsistently and a keyboard-only user cannot reach at all;
 *  - hovering OR giving the control keyboard focus shows a small visible reason bubble;
 *  - on a coarse pointer (touch, no hover — `(hover: none) and (pointer: coarse)`, the same
 *    query already used for touch affordances elsewhere in this app) tapping the disabled
 *    control shows the same bubble inline for {@link GATED_HINT_MS};
 *  - passing `reason: undefined` renders the child completely unchanged (no wrapper
 *    added/removed across a gated <-> ungated transition — see below).
 *
 * WHY `aria-disabled` INSTEAD OF THE NATIVE `disabled` ATTRIBUTE: a genuinely
 * `disabled`-attributed element cannot receive focus at all in any browser, so it can never
 * satisfy "keyboard focus shows the reason." This component keeps the wrapped element
 * enabled at the DOM level (focusable, hoverable, tappable) and does the actual
 * gating itself — `aria-disabled="true"` communicates the state to assistive tech, the
 * gated visual class (`cf-gated-disabled`) supplies the disabled *look*, and the
 * overridden `onClick` swallows the interaction instead of forwarding it to whatever the
 * caller's `onClick` would otherwise have done. Playwright's own actionability checks (and
 * `toBeDisabled()`/`toBeEnabled()`) already treat `aria-disabled="true"` the same as the
 * native attribute, so existing specs asserting disabled/enabled state are unaffected.
 *
 * WHY THE WRAPPER `<span>` IS ALWAYS PRESENT, GATED OR NOT: several existing regression
 * specs (e.g. `combatant-row-sync-disable.spec.ts`) prove a control survives a
 * disabled<->enabled transition as the SAME DOM node (issue #1746's anti-reflow
 * guarantee) by tagging it and checking the tag survives. If this component only wrapped
 * the child while `reason` was set, that guarantee would break the moment a sync outage
 * clears (the tree shape at that position would change from `<span><button/></span>` to a
 * bare `<button/>`, forcing React to remount). The wrapper is therefore unconditional;
 * only the child's own props (and whether the hint bubble renders) change with `reason`.
 */
import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
} from 'react';
import {
  GATED_HINT_MS,
  GATED_HINT_STATE_IDLE,
  gatedTooltipVisible,
  isCoarsePointerQuery,
  mergeDescribedBy,
  mergeGatedClassName,
  type GatedHintState,
} from './gatedControlState';

/** Media query for "touch, no hover" — already used for touch-only affordances (index.css). */
const COARSE_POINTER_QUERY = '(hover: none) and (pointer: coarse)';

type GatableProps = {
  disabled?: boolean;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
  'aria-describedby'?: string;
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  onMouseEnter?: (event: MouseEvent<HTMLElement>) => void;
  onMouseLeave?: (event: MouseEvent<HTMLElement>) => void;
  onFocus?: (event: FocusEvent<HTMLElement>) => void;
  onBlur?: (event: FocusEvent<HTMLElement>) => void;
  onPointerUp?: (event: PointerEvent<HTMLElement>) => void;
};

export type GatedControlProps = {
  /**
   * Localized reason the child is disabled right now, or `undefined`/`null` when it is not
   * gated at all. Pass an already-`t()`-resolved string — this component has no i18n
   * namespace of its own; every adoption site owns its own `run.gate.*` key.
   */
  reason: string | null | undefined;
  /** The single interactive element to gate — typically a `<button>` or `<Btn>`. */
  children: ReactElement<GatableProps>;
};

/** Shared gating-reason affordance — see the module doc comment above. */
export function GatedControl({ reason, children }: GatedControlProps): ReactElement {
  const generatedId = useId();
  const reasonId = `gated-control-reason-${generatedId}`;
  const gated = reason != null && reason !== '';

  const [hint, setHint] = useState<GatedHintState>(GATED_HINT_STATE_IDLE);
  const tapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTapTimer = () => {
    if (tapTimerRef.current != null) {
      clearTimeout(tapTimerRef.current);
      tapTimerRef.current = null;
    }
  };

  // Unmount-time cleanup only — the gated-clearing effect below handles every other case.
  useEffect(() => clearTapTimer, []);

  // The moment the reason clears (e.g. sync recovers), drop any lingering hover/focus/tap
  // hint state so a stale bubble never survives past the control actually becoming enabled.
  useEffect(() => {
    if (!gated) {
      clearTapTimer();
      setHint(GATED_HINT_STATE_IDLE);
    }
    // clearTapTimer is stable (recreated per render but side-effect-free to recreate).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gated]);

  if (!isValidElement(children)) return children;

  if (!gated) {
    // Passthrough — no wrapper props changed, but the wrapper span itself stays mounted
    // (see the module doc comment on why) so the child's DOM node identity is preserved
    // across a later gated transition.
    return <span className="cf-gated-control">{children}</span>;
  }

  const existing = children.props;

  const child = cloneElement(children, {
    disabled: false,
    'aria-disabled': true,
    'aria-describedby': mergeDescribedBy(existing['aria-describedby'], reasonId) || undefined,
    className: mergeGatedClassName(existing.className, 'cf-gated-disabled'),
    title: reason,
    onClick: (event: MouseEvent<HTMLElement>) => {
      // Never forward to the caller's handler — that handler assumes the gate is clear.
      event.preventDefault();
      event.stopPropagation();
    },
    onMouseEnter: (event: MouseEvent<HTMLElement>) => {
      setHint((prev) => ({ ...prev, hovered: true }));
      existing.onMouseEnter?.(event);
    },
    onMouseLeave: (event: MouseEvent<HTMLElement>) => {
      setHint((prev) => ({ ...prev, hovered: false }));
      existing.onMouseLeave?.(event);
    },
    onFocus: (event: FocusEvent<HTMLElement>) => {
      setHint((prev) => ({ ...prev, focused: true }));
      existing.onFocus?.(event);
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      setHint((prev) => ({ ...prev, focused: false }));
      existing.onBlur?.(event);
    },
    onPointerUp: (event: PointerEvent<HTMLElement>) => {
      const coarse = typeof window !== 'undefined'
        && typeof window.matchMedia === 'function'
        && isCoarsePointerQuery(window.matchMedia(COARSE_POINTER_QUERY));
      if (coarse) {
        setHint((prev) => ({ ...prev, tapHintActive: true }));
        clearTapTimer();
        tapTimerRef.current = setTimeout(() => {
          setHint((prev) => ({ ...prev, tapHintActive: false }));
        }, GATED_HINT_MS);
      }
      existing.onPointerUp?.(event);
    },
  } as Partial<GatableProps>);

  const tooltipVisible = gatedTooltipVisible(hint);

  return (
    <span className="cf-gated-control" data-gated="true">
      {child}
      <span id={reasonId} className="sr-only">
        {reason}
      </span>
      {tooltipVisible && (
        <span className="cf-gated-hint" role="presentation" aria-hidden="true" data-testid="gated-control-hint">
          {reason}
        </span>
      )}
    </span>
  );
}
