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
