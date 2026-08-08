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
import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { afterCombatantIdForDrop } from '../combatantReorder';

/** Pixels of pointer travel before a press on the handle commits to a drag. */
const DRAG_START_SLOP_PX = 6;

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
      gesture.captureTarget.releasePointerCapture?.(e.pointerId);
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
      gesture.captureTarget.releasePointerCapture?.(e.pointerId);
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

  return { draggingId, overId: over?.id ?? null, overAfter: over?.after ?? false, handleProps };
}
