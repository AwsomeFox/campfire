/**
 * Pointer-driven drag reordering (issue #1923), shared by InitiativeStrip and the
 * roster (CombatantRow list). Mirrors the token-drag pointer conventions on the battle
 * map (BattleMap.tsx's `onTokenPointerDown`/`onSurfacePointerMove`): `e.isPrimary` gates
 * out secondary/palm contacts, `setPointerCapture`/`releasePointerCapture` keep the
 * gesture bound to its origin element through scrolling and cross-element moves, and a
 * small pixel-distance slop distinguishes an accidental jiggle (or a plain tap on the
 * handle) from a genuine drag before anything visually commits.
 *
 * Hit-testing reads `elementsRef` — the SAME per-combatant DOM ref map the caller
 * already keeps for other purposes (InitiativeStrip's FLIP-animation `combatantRefs`,
 * RunSessionPage's `combatantRowRefs`) — so this hook owns no element registration of
 * its own and cannot drift out of sync with what is actually rendered.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { afterCombatantIdForDrop } from '../combatantReorder';

/** Pixels of pointer travel before a press on the handle commits to a drag. */
const DRAG_START_SLOP_PX = 6;

/**
 * `releasePointerCapture` can throw `NotFoundError` when the browser already released
 * capture itself — one way that happens is the SAME mid-gesture `enabled` flip the
 * issue #2084 finding 4 effect below exists to recover from: the handle element
 * unmounting releases capture as a side effect, and then this call, made moments later
 * against a `pointerId` the browser no longer considers captured, throws. Every call
 * site here must go through this wrapper — a throw from a bare `releasePointerCapture`
 * call would abort the surrounding handler BEFORE it reaches `reset()`, leaving
 * `gestureRef` populated on exactly the path meant to clear it (issue #2095 review).
 */
function safeReleasePointerCapture(target: HTMLElement, pointerId: number): void {
  try {
    target.releasePointerCapture?.(pointerId);
  } catch {
    // Already released (or never captured) — nothing left to clean up here. The
    // caller's own `reset()` (never skipped, never gated on this succeeding) is what
    // actually matters.
  }
}

type Axis = 'x' | 'y';

type Gesture = {
  pointerId: number;
  combatantId: number;
  startX: number;
  startY: number;
  moved: boolean;
  captureTarget: HTMLElement;
};

export type CombatantDragReorderState = {
  /** The combatant currently being dragged, or null when idle. */
  draggingId: number | null;
  /** The combatant the pointer is currently over, or null. */
  overId: number | null;
  /** Whether the pending drop lands AFTER `overId` (vs. before it). */
  overAfter: boolean;
  /** Spread onto the drag-handle element for the given combatant. */
  handleProps: (combatantId: number) => {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void;
  };
};

export function useCombatantDragReorder<E extends HTMLElement = HTMLElement>({
  axis,
  orderedIds,
  enabled,
  elementsRef,
  onDrop,
}: {
  axis: Axis;
  orderedIds: readonly number[];
  enabled: boolean;
  /**
   * A minimal structural ref shape (not React's nullable `RefObject`) — every caller
   * initializes it via `useRef(new Map())`, so `.current` is never actually null.
   * Generic over the concrete element type so this hook can reuse whichever per-combatant
   * DOM ref map the caller already keeps for its own purposes (InitiativeStrip's
   * `Map<number, HTMLDivElement>` FLIP-animation refs, RunSessionPage's
   * `Map<number, HTMLElement>` roster row refs) without a cast at either call site.
   */
  elementsRef: { current: Map<number, E> };
  onDrop: (combatantId: number, afterCombatantId: number | 'top') => void;
}): CombatantDragReorderState {
  const gestureRef = useRef<Gesture | null>(null);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [over, setOver] = useState<{ id: number; after: boolean } | null>(null);
  // Issue #2074 review finding 5: `over` (React state) is only guaranteed current after
  // a render commits. A pointerup that arrives in the same task as the pointermove just
  // before it — a fast release — can fire against the PREVIOUS render's onPointerUp
  // closure, whose `over` predates that final pointermove's setOver call. `overRef` is
  // written synchronously in the same handler that computes the value, so onPointerUp
  // always reads the value drop resolution actually intends, independent of whether
  // React has re-rendered yet.
  const overRef = useRef<{ id: number; after: boolean } | null>(null);

  const resolveOver = useCallback(
    (clientX: number, clientY: number, excludeId: number): { id: number; after: boolean } | null => {
      let found: { id: number; after: boolean } | null = null;
      elementsRef.current.forEach((el, id) => {
        if (id === excludeId || found) return;
        const rect = el.getBoundingClientRect();
        if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return;
        const after = axis === 'x' ? clientX > rect.left + rect.width / 2 : clientY > rect.top + rect.height / 2;
        found = { id, after };
      });
      return found;
    },
    [axis, elementsRef],
  );

  const reset = useCallback(() => {
    gestureRef.current = null;
    overRef.current = null;
    setDraggingId(null);
    setOver(null);
  }, []);

  // Issue #2084 finding 4: a mid-gesture `enabled` flip must not strand `gestureRef`.
  // `onPointerDown`'s own `enabled` check only ever gates the START of a NEW gesture —
  // nothing previously reacted to `enabled` going false while a gesture was already
  // under way. Two different call sites hit that gap in two different ways: the
  // roster's `CombatantRow` withholds `handleProps` (via `{...(reorder.busy ? {} :
  // reorder.dragHandleProps)}`) without unmounting the handle, which drops the
  // `onPointerUp`/`onPointerCancel` listeners the browser would otherwise fire;
  // `InitiativeStrip` instead stops RENDERING the handle element outright, which
  // unmounts those same listeners along with it. Either way `gestureRef.current` is
  // never cleared, and `onPointerDown`'s `if (!enabled || !e.isPrimary ||
  // gestureRef.current) return;` then refuses every later drag — for the whole roster
  // or strip, since this hook has one instance per caller — until a reload.
  //
  // Fixed at the SOURCE both call sites share: reset (and release pointer capture)
  // here, in the hook itself, the moment `enabled` goes false — independent of whether
  // the caller keeps the handle mounted-but-inert or unmounts it. A gesture can only
  // exist here if it started while `enabled` was true (that is `onPointerDown`'s own
  // gate), so no "was this a true→false transition" bookkeeping is needed: if `enabled`
  // is false and a gesture is still recorded, it must have survived a flip.
  useEffect(() => {
    if (enabled) return;
    const gesture = gestureRef.current;
    if (!gesture) return;
    // Order matters (issue #2095 review): the release attempt goes through the
    // never-throwing wrapper, and `reset()` runs unconditionally after it — NOT inside
    // a `try` whose `catch` might be the only path back to it. A throwing release must
    // never prevent the state clear this effect exists to guarantee.
    safeReleasePointerCapture(gesture.captureTarget, gesture.pointerId);
    reset();
  }, [enabled, reset]);

  const onPointerDown = useCallback(
    (combatantId: number, e: ReactPointerEvent<HTMLElement>) => {
      if (!enabled || !e.isPrimary || gestureRef.current) return;
      const target = e.currentTarget;
      target.setPointerCapture?.(e.pointerId);
      gestureRef.current = { pointerId: e.pointerId, combatantId, startX: e.clientX, startY: e.clientY, moved: false, captureTarget: target };
    },
    [enabled],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== e.pointerId) return;
      if (!gesture.moved) {
        const distance = Math.hypot(e.clientX - gesture.startX, e.clientY - gesture.startY);
        if (distance < DRAG_START_SLOP_PX) return;
        gesture.moved = true;
        setDraggingId(gesture.combatantId);
      }
      const next = resolveOver(e.clientX, e.clientY, gesture.combatantId);
      overRef.current = next;
      setOver(next);
    },
    [resolveOver],
  );

  const onPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== e.pointerId) return;
      // issue #2095 review: same never-throwing wrapper as the enabled-transition
      // effect above — an already-released capture (e.g. this pointerup arriving after
      // the browser released capture on its own) must not stop the drop resolution or
      // `reset()` below from running.
      safeReleasePointerCapture(gesture.captureTarget, e.pointerId);
      const resolvedOver = overRef.current;
      if (gesture.moved && resolvedOver) {
        const afterId = afterCombatantIdForDrop(orderedIds, gesture.combatantId, resolvedOver.id, resolvedOver.after);
        if (afterId !== null) onDrop(gesture.combatantId, afterId);
      }
      reset();
    },
    [orderedIds, onDrop, reset],
  );

  const onPointerCancel = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== e.pointerId) return;
      safeReleasePointerCapture(gesture.captureTarget, e.pointerId);
      reset();
    },
    [reset],
  );

  const handleProps = useCallback(
    (combatantId: number) => ({
      onPointerDown: (e: ReactPointerEvent<HTMLElement>) => onPointerDown(combatantId, e),
      onPointerMove,
      onPointerUp,
      onPointerCancel,
    }),
    [onPointerDown, onPointerMove, onPointerUp, onPointerCancel],
  );

  // Issue #2084 finding 3: `handleProps` just above is properly memoized, but the WRAPPER
  // object returning it was not — a fresh object literal every render gives
  // `rosterDragReorder` a new identity every render, which invalidates
  // `buildReorderControls`'s `useCallback` (it is in that hook's dependency array), which
  // hands every roster row a brand-new `reorder` object, which defeats `CombatantRow`'s
  // `React.memo` for the ENTIRE roster on every SSE tick, timer tick, and HP feedback
  // event. `useMemo` here restores the boundary `handleProps`'s own memoization already
  // intended.
  return useMemo(
    () => ({ draggingId, overId: over?.id ?? null, overAfter: over?.after ?? false, handleProps }),
    [draggingId, over, handleProps],
  );
}
