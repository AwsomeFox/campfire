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
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
} from 'react';
import { createPortal } from 'react-dom';
import { sanitizeFieldPrefix } from './Field';
import {
  applyGatedHintEvent,
  clearTapHint,
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

/**
 * Whether the CURRENT device is a coarse pointer, checked live (not memoized) so it reflects
 * reality at the moment of each event rather than whatever it was on first render.
 *
 * This gates the hover/focus handlers below: a tap on real touch hardware also fires
 * compatibility mouse events (`mouseenter`/`mouseover`) and moves focus to the element, so
 * without this check `hovered`/`focused` would latch `true` on tap and never clear (nothing
 * on a touch device naturally fires `mouseleave`/`blur` afterward) — the reason bubble would
 * stay visible forever instead of hiding again after {@link GATED_HINT_MS}. On a coarse
 * pointer, hover/focus are not meaningful signals at all (that is the entire premise of the
 * `(hover: none)` media feature), so this component treats them as no-ops there and lets only
 * the tap-hint timer (`onPointerUp` below) drive visibility.
 */
/**
 * Whether this focus is the kind a browser would style with `:focus-visible` — keyboard and
 * assistive-tech focus, but not the focus a tap or click synthesises. Guarded because
 * `matches` is absent on non-element targets and `:focus-visible` throws on browsers that
 * do not know the selector; both fall back to "treat it as visible", which errs toward
 * SHOWING the reason rather than silently withholding it.
 */
function isFocusVisible(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true;
  try {
    return target.matches(':focus-visible');
  } catch {
    return true;
  }
}

function isCoarsePointerNow(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && isCoarsePointerQuery(window.matchMedia(COARSE_POINTER_QUERY));
}

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
  /**
   * Extra classes for the WRAPPER span, not the child.
   *
   * Because the wrapper is unconditional (see the module doc comment), it — not the child —
   * is the flex/grid item of whatever contains this control. Any utility that only means
   * something to a flex item (`ml-auto`, a full-width stretch) therefore has to live here,
   * or it silently stops applying the moment a control adopts `GatedControl`. That is a
   * layout regression with no error and no failing test, so it is worth the extra prop
   * rather than asking every call site to notice (issue #1933 review).
   */
  className?: string;
  /** The single interactive element to gate — typically a `<button>` or `<Btn>`. */
  children: ReactElement<GatableProps>;
};

/** Shared gating-reason affordance — see the module doc comment above. */
/** Matches `.cf-gated-hint`'s own `max-width`; the clamp has to know how wide it can get. */
const GATED_HINT_MAX_WIDTH_PX = 220;
/** Three lines at the hint's line-height plus its padding — the tallest it realistically gets. */
const GATED_HINT_ESTIMATED_HEIGHT_PX = 72;
/** Breathing room from the viewport edges, so a clamped bubble never sits flush against one. */
const GATED_HINT_VIEWPORT_MARGIN_PX = 8;

export function GatedControl({ reason, className, children }: GatedControlProps): ReactElement {
  const wrapperClass = className ? `cf-gated-control ${className}` : 'cf-gated-control';
  // React's useId() returns colon-delimited values (e.g. ":r1:"), which are invalid inside a
  // CSS id selector (`#gated-control-reason-:r1:` throws) — sanitizeFieldPrefix strips them,
  // the same helper Field.tsx and its other callers already use for this exact purpose.
  const generatedId = useId();
  const reasonId = `gated-control-reason-${sanitizeFieldPrefix(generatedId)}`;
  const gated = reason != null && reason !== '';

  const [hint, setHint] = useState<GatedHintState>(GATED_HINT_STATE_IDLE);
  const tapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  /**
   * Where to paint the bubble when the wrapper sits inside something that clips.
   *
   * The hint is normally absolutely positioned against this wrapper, which is right until
   * an ancestor scrolls: the encounter cockpit's 58px tool rail has `overflow-y: auto`,
   * and that establishes a clip box in BOTH axes, so a 220px bubble is sliced to the rail
   * width in every viewport. Rather than change how the hint is positioned everywhere,
   * detect a clipping ancestor and, only then, portal the same element to `<body>` with
   * viewport coordinates measured from the trigger.
   */
  const [escapeAt, setEscapeAt] = useState<{ left: number; top: number | null; bottom: number | null } | null>(null);

  const clearTapTimer = () => {
    if (tapTimerRef.current != null) {
      clearTimeout(tapTimerRef.current);
      tapTimerRef.current = null;
    }
  };

  // Unmount-time cleanup only — the gated-clearing effect below handles every other case.
  useEffect(() => clearTapTimer, []);

  const tooltipVisible = gatedTooltipVisible(hint);

  useLayoutEffect(() => {
    if (!tooltipVisible) {
      setEscapeAt(null);
      return;
    }
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    let clipping: HTMLElement | null = wrapper.parentElement;
    while (clipping) {
      const overflow = getComputedStyle(clipping);
      if (overflow.overflowX !== 'visible' || overflow.overflowY !== 'visible') break;
      clipping = clipping.parentElement;
    }
    // `document.body`/`html` clip nothing that matters here — only a real inner scroller does.
    if (!clipping || clipping === document.body || clipping === document.documentElement) {
      setEscapeAt(null);
      return;
    }
    const rect = wrapper.getBoundingClientRect();
    // Above the trigger only when the bubble actually fits there. The cockpit header is
    // itself a clipping ancestor (`overflow-y: auto`) AND sits at the top of the viewport
    // with 8px of padding, so anchoring a gated lifecycle action's hint to `rect.top`
    // pushed it off the top of the screen — during exactly the safety hold or sync outage
    // that made it worth reading. Both axes are clamped for the same reason: a trigger
    // near the right edge would otherwise put a 220px bubble past it.
    const left = Math.round(
      Math.min(Math.max(GATED_HINT_VIEWPORT_MARGIN_PX, rect.left), Math.max(GATED_HINT_VIEWPORT_MARGIN_PX, window.innerWidth - GATED_HINT_MAX_WIDTH_PX - GATED_HINT_VIEWPORT_MARGIN_PX)),
    );
    const fitsAbove = rect.top >= GATED_HINT_ESTIMATED_HEIGHT_PX + GATED_HINT_VIEWPORT_MARGIN_PX;
    setEscapeAt(
      fitsAbove
        ? { left, top: null, bottom: Math.round(window.innerHeight - rect.top) }
        : { left, top: Math.round(rect.bottom), bottom: null },
    );
  }, [tooltipVisible, reason]);

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
    return <span className={wrapperClass}>{children}</span>;
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
      setHint((prev) => applyGatedHintEvent(prev, 'mouseEnter', isCoarsePointerNow()));
      existing.onMouseEnter?.(event);
    },
    onMouseLeave: (event: MouseEvent<HTMLElement>) => {
      setHint((prev) => applyGatedHintEvent(prev, 'mouseLeave', isCoarsePointerNow()));
      existing.onMouseLeave?.(event);
    },
    onFocus: (event: FocusEvent<HTMLElement>) => {
      // A coarse pointer alone must NOT suppress focus (issue #1933 review): a tablet or
      // 2-in-1 with a hardware keyboard reports `(hover: none) and (pointer: coarse)` AND
      // has genuine keyboard focus, so blanket-ignoring focus there would delete the
      // keyboard affordance this component exists to provide, on exactly the devices where
      // the tap hint is the only other route. What must be ignored is the COMPATIBILITY
      // focus a tap synthesises — which is precisely the distinction `:focus-visible`
      // encodes, so let the browser answer it rather than hand-rolling pointer tracking.
      setHint((prev) => applyGatedHintEvent(prev, 'focus', isCoarsePointerNow() && !isFocusVisible(event.target)));
      existing.onFocus?.(event);
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      // Blur stays unconditional: a latched focus hint must clear on ANY device, and
      // treating blur as a no-op on coarse pointers would strand a bubble opened by the
      // keyboard path above.
      setHint((prev) => applyGatedHintEvent(prev, 'blur', false));
      existing.onBlur?.(event);
    },
    onPointerUp: (event: PointerEvent<HTMLElement>) => {
      const coarse = isCoarsePointerNow();
      setHint((prev) => applyGatedHintEvent(prev, 'tapStart', coarse));
      if (coarse) {
        clearTapTimer();
        tapTimerRef.current = setTimeout(() => {
          setHint(clearTapHint);
        }, GATED_HINT_MS);
      }
      existing.onPointerUp?.(event);
    },
  } as Partial<GatableProps>);



  const hintNode = tooltipVisible ? (
    <span
      // The escaped copy needs its own tier: portaled to `<body>` it leaves the trigger's
      // stacking context, and the base `z-index: 30` sits UNDER an immersive surface like
      // the encounter cockpit (41) — so escaping the clip would have hidden it completely
      // instead. Note a visibility assertion cannot see that; only hit-testing can.
      className={escapeAt ? 'cf-gated-hint cf-gated-hint--escaped' : 'cf-gated-hint'}
      role="presentation"
      aria-hidden="true"
      data-testid="gated-control-hint"
      style={
        escapeAt
          ? escapeAt.bottom != null
            ? { position: 'fixed', left: escapeAt.left, top: 'auto', bottom: escapeAt.bottom, marginBottom: 6, marginTop: 0 }
            : { position: 'fixed', left: escapeAt.left, top: escapeAt.top ?? 0, bottom: 'auto', marginTop: 6, marginBottom: 0 }
          : undefined
      }
    >
      {reason}
    </span>
  ) : null;

  return (
    <span className={wrapperClass} data-gated="true" ref={wrapperRef}>
      {child}
      <span id={reasonId} className="sr-only">
        {reason}
      </span>
      {escapeAt && hintNode ? createPortal(hintNode, document.body) : hintNode}
    </span>
  );
}
