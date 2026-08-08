/**
 * Regression coverage for PR #2074 review finding 5: drop resolution in
 * `useCombatantDragReorder` used to read the React state `over` closed into
 * `onPointerUp` at the render it was created, rather than the value the FINAL
 * `onPointerMove` before release actually computed.
 *
 * A fast release fires `onPointerUp` in the same task as the `onPointerMove` right
 * before it — before React has had a chance to commit that move's `setOver` and hand
 * out a fresh `onPointerUp` closure with the new value baked in. This test reproduces
 * that shape directly: it captures `handleProps(id)` ONCE, before any interaction (so
 * `onPointerUp` is whatever closure existed at that first render), then drives
 * onPointerDown -> onPointerMove -> onPointerUp through that SAME captured reference.
 * Any closure-captured `over` would still be pinned to its value from that first
 * render (null); only a ref, dereferenced at call time, sees the move's result.
 */
import { act, renderHook } from '@testing-library/react';
import { describe, test, expect, vi } from 'vitest';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useCombatantDragReorder } from '../../src/features/encounters/combat/useCombatantDragReorder';

function rect(overrides: Partial<DOMRect>): DOMRect {
  return {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    toJSON: () => ({}),
    ...overrides,
  } as DOMRect;
}

function fakePointerEvent(clientX: number, clientY: number): ReactPointerEvent<HTMLElement> {
  return {
    pointerId: 1,
    isPrimary: true,
    clientX,
    clientY,
    currentTarget: {
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
    } as unknown as HTMLElement,
  } as unknown as ReactPointerEvent<HTMLElement>;
}

describe('useCombatantDragReorder drop resolution (issue #2074 review finding 5)', () => {
  test('a captured onPointerUp closure from BEFORE the final move still resolves the drop the move computed', () => {
    const elA = { getBoundingClientRect: () => rect({ left: 0, right: 100, top: 0, bottom: 40 }) } as HTMLElement;
    const elB = { getBoundingClientRect: () => rect({ left: 100, right: 200, top: 0, bottom: 40 }) } as HTMLElement;
    const elementsRef = { current: new Map<number, HTMLElement>([[1, elA], [2, elB]]) };
    const onDrop = vi.fn();

    const { result } = renderHook(() =>
      useCombatantDragReorder({
        axis: 'x',
        orderedIds: [1, 2],
        enabled: true,
        elementsRef,
        onDrop,
      }),
    );

    // Captured from the VERY FIRST render, before any pointer interaction — this is
    // the closure a pre-fix onPointerUp would be permanently pinned to.
    const handlers = result.current.handleProps(1);

    act(() => {
      handlers.onPointerDown(fakePointerEvent(0, 20));
    });
    act(() => {
      // Past the drag-start slop, and in the RIGHT half of elB (100..200, midpoint
      // 150) so the drop resolves to "after combatant 2" specifically.
      handlers.onPointerMove(fakePointerEvent(180, 20));
    });
    act(() => {
      // Same captured reference as above — not re-read from `result.current` after
      // the move's re-render.
      handlers.onPointerUp(fakePointerEvent(180, 20));
    });

    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith(1, 2);
  });
});

/**
 * Issue #2084 finding 4 (originally reported as PR #2074 review finding 2, and
 * reintroduced a second way by PR #2088's `InitiativeStrip` gating): `onPointerDown`'s
 * `if (!enabled || !e.isPrimary || gestureRef.current) return;` only ever gates the
 * START of a NEW gesture — nothing reacted to `enabled` going false mid-gesture, so
 * `gestureRef` stayed populated and every later drag was refused. Two different callers
 * hit that gap two different ways (withholding handler props vs. unmounting the handle
 * element outright), so the fix lives in the hook itself: reset the gesture — and
 * release pointer capture — the moment `enabled` transitions to false, regardless of
 * which shape the caller's own gating takes.
 */
describe('useCombatantDragReorder — a mid-gesture `enabled` flip does not strand the tracker (issue #2084 finding 4)', () => {
  test('enabled flipping false mid-drag resets the gesture, and a later onPointerDown still starts a new drag', () => {
    const elA = { getBoundingClientRect: () => rect({ left: 0, right: 100, top: 0, bottom: 40 }) } as HTMLElement;
    const elB = { getBoundingClientRect: () => rect({ left: 100, right: 200, top: 0, bottom: 40 }) } as HTMLElement;
    const elementsRef = { current: new Map<number, HTMLElement>([[1, elA], [2, elB]]) };
    const onDrop = vi.fn();

    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useCombatantDragReorder({
          axis: 'x',
          orderedIds: [1, 2],
          enabled,
          elementsRef,
          onDrop,
        }),
      { initialProps: { enabled: true } },
    );

    const releaseCapture = vi.fn();
    const downEvent = {
      pointerId: 1,
      isPrimary: true,
      clientX: 0,
      clientY: 20,
      currentTarget: { setPointerCapture: vi.fn(), releasePointerCapture: releaseCapture } as unknown as HTMLElement,
    } as unknown as ReactPointerEvent<HTMLElement>;

    act(() => {
      result.current.handleProps(1).onPointerDown(downEvent);
    });
    act(() => {
      // Past the drag-start slop — a real gesture is now in progress.
      result.current.handleProps(1).onPointerMove(fakePointerEvent(80, 20));
    });
    expect(result.current.draggingId).toBe(1);

    // The sync gate (or whatever gates `canReorder`/`busy`) trips mid-drag. No
    // pointerup/pointercancel is ever delivered — that is exactly the failure this
    // finding describes, so this test must not simulate one.
    act(() => {
      rerender({ enabled: false });
    });

    // Pointer capture on the ORIGINAL target is released even though no pointerup fired.
    expect(releaseCapture).toHaveBeenCalledWith(1);
    // The stranded gesture is gone — draggingId resets to idle.
    expect(result.current.draggingId).toBeNull();

    // The gate reopens.
    act(() => {
      rerender({ enabled: true });
    });

    // A brand-new gesture on the SAME combatant starts cleanly — pre-fix, `gestureRef`
    // was still populated with the old (never-released) pointerId and this
    // `onPointerDown` would silently no-op.
    const secondDown = {
      pointerId: 2,
      isPrimary: true,
      clientX: 0,
      clientY: 20,
      currentTarget: { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() } as unknown as HTMLElement,
    } as unknown as ReactPointerEvent<HTMLElement>;
    act(() => {
      result.current.handleProps(1).onPointerDown(secondDown);
    });
    act(() => {
      result.current.handleProps(1).onPointerMove({ ...fakePointerEvent(180, 20), pointerId: 2 } as ReactPointerEvent<HTMLElement>);
    });
    expect(result.current.draggingId).toBe(1);
    act(() => {
      result.current.handleProps(1).onPointerUp({ ...fakePointerEvent(180, 20), pointerId: 2, currentTarget: secondDown.currentTarget } as ReactPointerEvent<HTMLElement>);
    });
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith(1, 2);
  });

  test('enabled flipping false while idle (no gesture in progress) is a no-op', () => {
    const elementsRef = { current: new Map<number, HTMLElement>() };
    const onDrop = vi.fn();
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useCombatantDragReorder({ axis: 'x', orderedIds: [1], enabled, elementsRef, onDrop }),
      { initialProps: { enabled: true } },
    );
    expect(() => act(() => rerender({ enabled: false }))).not.toThrow();
    expect(result.current.draggingId).toBeNull();
  });
});

/**
 * Issue #2084 finding 3: `handleProps` was already memoized, but the object WRAPPING it
 * (the hook's return value) was a fresh literal every render — giving every consumer
 * (`rosterDragReorder` in `RunSessionPage`) a new identity on every render regardless of
 * whether anything the hook tracks actually changed, which cascades through a
 * `useCallback` dependency array into a brand-new `reorder` prop per roster row and
 * defeats `CombatantRow`'s `React.memo` for the whole roster.
 */
describe('useCombatantDragReorder — the returned object is stable across unrelated re-renders (issue #2084 finding 3)', () => {
  test('re-rendering with the same inputs returns the SAME object and handleProps reference', () => {
    const elementsRef = { current: new Map<number, HTMLElement>() };
    const onDrop = vi.fn();
    const orderedIds = [1, 2];
    const { result, rerender } = renderHook(() => useCombatantDragReorder({ axis: 'x', orderedIds, enabled: true, elementsRef, onDrop }));

    const first = result.current;
    // Force a re-render with referentially-identical inputs (same `orderedIds` array,
    // same `onDrop`, same `elementsRef`) — nothing the hook tracks has changed.
    rerender();
    const second = result.current;

    expect(second).toBe(first);
    expect(second.handleProps).toBe(first.handleProps);
  });

  test('an unrelated state change inside the hook (dragging) still yields a NEW object once, not on every render after', () => {
    const elA = { getBoundingClientRect: () => rect({ left: 0, right: 100, top: 0, bottom: 40 }) } as HTMLElement;
    const elementsRef = { current: new Map<number, HTMLElement>([[1, elA]]) };
    const onDrop = vi.fn();
    const { result } = renderHook(() => useCombatantDragReorder({ axis: 'x', orderedIds: [1], enabled: true, elementsRef, onDrop }));

    const before = result.current;
    act(() => {
      result.current.handleProps(1).onPointerDown(fakePointerEvent(0, 20));
    });
    act(() => {
      result.current.handleProps(1).onPointerMove(fakePointerEvent(80, 20));
    });
    const duringDrag = result.current;
    // `draggingId` genuinely changed (null -> 1) — a new object is CORRECT here, not a
    // memoization failure. What finding 3 is about is a new object on renders where
    // NOTHING changed, which the previous test pins directly.
    expect(duringDrag).not.toBe(before);
    expect(duringDrag.draggingId).toBe(1);
  });
});
