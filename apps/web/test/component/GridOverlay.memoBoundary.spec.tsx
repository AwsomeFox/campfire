/**
 * Behavioural guard for GridOverlay's memo boundary (issue #1917 stage 2 / issue #2079).
 *
 * Issue #2079 measured that #1917's two MutationObserver e2e probes
 * (`e2e/tests/encounter-render-containment.spec.ts`) still pass with `memo()` removed
 * from `GridOverlay` entirely. The reason is structural, not a bug in those probes: on
 * the interactions they script (an HP change, a token drag), none of GridOverlay's own
 * prop VALUES change, so a memoized render (skipped) and an unmemoized render (runs,
 * reconciles, produces byte-identical DOM) commit the exact same DOM either way. A
 * MutationObserver watches the DOM, so it cannot tell those two cases apart. The unit-tier
 * source assertion in `e2e/tests/encounter-render-containment.unit.spec.ts` catches
 * "memo() deleted from the source", but is equally blind to memo() staying in the source
 * while failing to actually bail — which is exactly what shipped on `main` for the whole
 * life of PR #2078, fixed only in the #2083 follow-up (an unstable `calibrationPx`
 * reference defeated the shallow comparator on every encounter refetch).
 *
 * This test asserts on RENDER-FUNCTION INVOCATION COUNT instead of DOM output, which is
 * the one thing a memo boundary actually controls. It has no framework support in this
 * repo's e2e-browser or unit(-source-scan) tiers, but the vitest+jsdom `test:component`
 * tier (issue #2025) mounts a real React tree, and `React.memo(Component)` returns a
 * plain, mutable `{ $$typeof, type, compare }` object whose `.type` is the exact inner
 * render function React calls when it does NOT bail out. That is not documented public
 * API, but it has been the stable shape of `React.memo`'s return value since React 16.6
 * and is the same shape debugging tools like why-did-you-render patch into. Swapping
 * `.type` for a spy — then restoring it — needs no changes to GridOverlay.tsx itself, so
 * it adds no render-counting instrumentation to production code (the "production
 * pollution" option #2079 flagged and did not want to pay for).
 *
 * What this proves: an unrelated parent re-render, with GridOverlay's own props held
 * referentially stable (the contract `BattleMap`'s `hexCells`/calibration useMemos exist
 * to uphold), does not re-invoke GridOverlay's render function.
 * What this does NOT prove: that BattleMap's real call site actually keeps those props
 * stable in production — that remains the job of the source assertion's
 * "BattleMap call site stabilizes the props..." case and of BattleMap's own useMemo
 * hooks; this test's harness constructs its own props and does not render BattleMap.
 */
import { render, fireEvent, cleanup } from '@testing-library/react';
import { describe, test, expect, vi, afterEach } from 'vitest';
import { useState } from 'react';
import { GridOverlay, type GridOverlayProps } from '../../src/features/encounters/map/GridOverlay';

afterEach(() => cleanup());

describe('GridOverlay memo boundary (issue #1917 stage 2, issue #2079)', () => {
  test('the render function is not invoked by an unrelated parent re-render when geometry props are unchanged', () => {
    // A memo()-wrapped component exposes its inner function as `.type` — see the
    // file-level comment above. A plain, unmemoized function component has no `.type`,
    // so this precondition alone already fails the exact mutation #2079 measured
    // (`memo()` removed from GridOverlay).
    const memoWrapper = GridOverlay as unknown as { type?: unknown };
    expect(typeof memoWrapper.type).toBe('function');

    const originalRender = memoWrapper.type as (props: GridOverlayProps) => unknown;
    const renderSpy = vi.fn((props: GridOverlayProps) => originalRender(props));
    memoWrapper.type = renderSpy;

    // Constructed once, outside the component, so every render of `Harness` passes the
    // SAME references for every geometry prop — mirroring the stability BattleMap's
    // `hexCells` useMemo and calibration derivation are meant to guarantee.
    const stableHexCells: string[] = ['0,0 1,0 1,1'];
    const stableMapRect = { left: 0, top: 0, width: 100, height: 100 };
    const stableCalibrationPx = {
      cellWpx: 10,
      cellHpx: 10,
      originXpx: 0,
      originYpx: 0,
      rotationDeg: 0,
      rotationRad: 0,
      opacity: 1,
    };

    function Harness() {
      // Unrelated page-level state (e.g. an HP change to a different combatant, or drag
      // position) — bumping it re-renders Harness and, if the memo boundary is broken,
      // GridOverlay too, WITHOUT any of GridOverlay's own props changing value.
      const [tick, setTick] = useState(0);
      return (
        <div>
          <button type="button" onClick={() => setTick((t) => t + 1)}>
            bump {tick}
          </button>
          <GridOverlay
            gridOn
            gridType="square"
            mapRect={stableMapRect}
            calibrationPx={stableCalibrationPx}
            hexOrientation="pointy"
            hexCells={stableHexCells}
            opacity={1}
            encounterId={1}
          />
        </div>
      );
    }

    try {
      render(<Harness />);
      expect(renderSpy).toHaveBeenCalledTimes(1);

      const button = document.querySelector('button')!;
      fireEvent.click(button);
      fireEvent.click(button);
      expect(button.textContent).toBe('bump 2'); // sanity: Harness really did re-render twice

      // The memo boundary's entire job: two unrelated parent re-renders with
      // byte-identical geometry props must not invoke the render function again.
      expect(renderSpy).toHaveBeenCalledTimes(1);
    } finally {
      // Restore the real render function so no other test in this process ever sees the
      // spy, whether this assertion passed or threw.
      memoWrapper.type = originalRender;
    }
  });
});
