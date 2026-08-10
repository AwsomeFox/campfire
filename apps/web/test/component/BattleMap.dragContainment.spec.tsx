/**
 * Behavioural render-containment guard for a token drag (issue #1917 stage 3).
 *
 * Before this stage, `dragPos` was `BattleMap`'s own `useState`, set on every pointermove of a
 * token drag. A component's own state update re-runs its OWN render function regardless of
 * `memo()` — memo only guards re-renders triggered by a PARENT — so that re-ran BattleMap's
 * entire multi-thousand-line render body once per pointer-move frame: every token, every AoE
 * shape, every fog rect recomputed and reconciled, not just the dragged token. Stage 2's
 * `GridOverlay` memo boundary (see `GridOverlay.memoBoundary.spec.tsx`) stopped GridOverlay's own
 * render function from being re-invoked when BattleMap re-rendered, but never stopped BattleMap
 * itself from re-rendering on every drag frame in the first place — this is the containment
 * layer stage 2 didn't (and by design couldn't) provide.
 *
 * Per issue #2079 (which this issue's acceptance criteria were corrected to account for): a
 * MutationObserver on the DOM cannot distinguish "BattleMap's render function ran and produced
 * byte-identical output" from "BattleMap's render function did not run" — both commit the same
 * DOM. And a source-scan assertion can confirm `dragPos` isn't literally read inside BattleMap's
 * JSX, but not that the drag path actually stopped triggering a re-render at runtime. This test
 * instead spies on RENDER-FUNCTION INVOCATION COUNT (the same technique
 * `GridOverlay.memoBoundary.spec.tsx` uses for its own boundary), mounts the real `BattleMap`
 * with a real placed token, and drives a real pointer-drag sequence.
 *
 * What this proves: dragging a placed token — pointerdown then several pointermoves — invokes
 * BattleMap's render function at most once (for the pointerdown-driven `draggingId` state change,
 * which is expected and cheap: it only happens twice per drag, at start and end), and NOT once
 * per pointermove. It additionally asserts the dragged token's on-screen position actually
 * updates across those pointermoves, so a containment change that broke live positioning (e.g.
 * a stale snapshot never delivered to `MapTokenSlot`) would also fail this test, not just a
 * skipped-render count.
 * What this does NOT prove: pixel-perfect drag math, snapping, or the server-side move
 * mutation's payload — those are covered by `e2e/tests/drag-distance.unit.spec.ts` and the
 * encounter e2e suites; this test's synthetic surface geometry exists only to drive a
 * realistic pointer sequence, not to assert on distance/snap values.
 */
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, test, expect, vi, afterEach, beforeAll } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Combatant, EncounterWithCombatants } from '@campfire/schema';
import '../../src/i18n';

// vi.mock is hoisted above every top-level statement in this file, so BattleMap's
// `useDerivativeManifest` (via `api.get` on the manifest URL) and its DM-only
// token-formations query never reach a real `fetch` under jsdom — same stub
// `BattleMapPingIntentKeyboard.spec.tsx` uses.
vi.mock('../../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      get: vi.fn().mockRejectedValue(new Error('network disabled in component test')),
      post: vi.fn().mockRejectedValue(new Error('network disabled in component test')),
    },
  };
});

import { BattleMap, type BattleMapProps } from '../../src/features/encounters/map/BattleMap';

afterEach(() => cleanup());

if (typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// jsdom lays out nothing, so `BattleMap`'s surface would otherwise report a 0×0 box and every
// pointer/percent computation would bail out before a drag ever starts (`mapRect` stays null).
// A flat 1000×600 box for every element is a deliberately crude stand-in — precise geometry is
// not this test's concern (see file header) — it only needs to be big enough and consistent
// enough that a pointerdown at the token's own rendered position, followed by pointermoves to
// other points inside the box, produces real, distinct map-percent coordinates.
//
// jsdom also has no `PointerEvent` constructor (only `MouseEvent`), so without this polyfill
// Testing Library's `fireEvent.pointerDown`/`pointerMove` silently fall back to a bare `Event`
// that drops every init field this test passes (`pointerId`, `isPrimary`, `clientX`, `clientY`)
// — the drag would then never start at all, for a reason that has nothing to do with the
// containment this test exists to guard. And jsdom has no `scrollIntoView` — a real gap versus a
// browser, unrelated to this issue, hit here only because a token's real `onFocus` handler
// (`RunSessionPage.tsx`'s map token) calls it on every pointerdown-driven focus.
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 1000 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 600 });
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600, x: 0, y: 0, toJSON() {} }) as DOMRect;
  if (typeof Element.prototype.scrollIntoView !== 'function') {
    Element.prototype.scrollIntoView = () => {};
  }
  if (typeof window.PointerEvent !== 'function') {
    class PointerEventPolyfill extends MouseEvent {
      readonly pointerId: number;
      readonly isPrimary: boolean;
      readonly pointerType: string;
      constructor(type: string, params: PointerEventInit = {}) {
        super(type, params);
        this.pointerId = params.pointerId ?? 0;
        this.isPrimary = params.isPrimary ?? false;
        this.pointerType = params.pointerType ?? 'mouse';
      }
    }
    window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
  }
});

function placedCombatant(): Combatant {
  return Combatant.parse({
    id: 501,
    encounterId: 1,
    kind: 'monster',
    name: 'Ogre',
    initiative: 3,
    hpCurrent: 30,
    hpMax: 30,
    conditions: [],
    sortOrder: 0,
    // Placed at the map's center (50%, 50%) — see `isTokenPlacedOnMap`.
    tokenX: 50,
    tokenY: 50,
    tokenSize: 'medium',
    turnState: { used: {}, movementUsedFt: 0, concentration: null, pendingConcentrationChecks: [], delaying: false, readied: null },
  });
}

function baseEncounter(): EncounterWithCombatants {
  return EncounterWithCombatants.parse({
    id: 1,
    campaignId: 1,
    name: 'Ogre den',
    combatants: [placedCombatant()],
    mapAttachmentId: 42,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
}

function renderBattleMap() {
  const props: BattleMapProps = {
    encounter: baseEncounter(),
    campaignId: 1,
    isDm: true,
    viewerUserId: 'dm-1',
    canDmWrite: true,
    busy: false,
    canMoveToken: () => true,
    onSetMap: vi.fn(),
    onMoveToken: vi.fn(),
    onUnplaceToken: vi.fn(),
    onSetGrid: vi.fn(),
    onSetFog: vi.fn(),
    onSetAoe: vi.fn(),
    onPing: vi.fn(),
    pings: [],
    onDismissPing: vi.fn(),
    onError: vi.fn(),
    ruleSystem: null,
  };
  const queryClient = new QueryClient();
  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <BattleMap {...props} />
      </QueryClientProvider>,
    ),
    props,
  };
}

describe('BattleMap token-drag render containment (issue #1917 stage 3)', () => {
  test('a token drag re-renders BattleMap only for the drag-start/end draggingId transition, never per pointermove — and the token still visibly moves', () => {
    // Same spy technique `GridOverlay.memoBoundary.spec.tsx` uses for its own memo boundary: a
    // plain (unmemoized) component has no `.type`, so this precondition alone would already fail
    // under the exact mutation this test guards against (`dragPos` reintroduced as BattleMap's
    // own `useState`, still routed through the same `memo()` wrapper).
    const memoWrapper = BattleMap as unknown as { type?: unknown };
    expect(typeof memoWrapper.type).toBe('function');
    const originalRender = memoWrapper.type as (props: BattleMapProps) => unknown;
    const renderSpy = vi.fn((props: BattleMapProps) => originalRender(props));
    memoWrapper.type = renderSpy;

    try {
      renderBattleMap();
      const afterMount = renderSpy.mock.calls.length;
      expect(afterMount).toBeGreaterThan(0);

      const token = screen.getByTestId('map-token-501');
      const surface = screen.getByTestId('battle-map-surface');
      const startLeft = token.style.left;
      expect(startLeft).toBe('50%');

      // Pointerdown on the token starts the drag — this DOES legitimately update `draggingId`
      // (BattleMap's own, rare-frequency state), so BattleMap's render function may run once
      // more here. That is the expected, bounded cost this test allows for.
      fireEvent.pointerDown(token, { pointerId: 1, isPrimary: true, clientX: 500, clientY: 300 });
      const afterPointerDown = renderSpy.mock.calls.length;
      expect(afterPointerDown).toBeGreaterThanOrEqual(afterMount);

      // Several pointermove frames, as a real drag gesture would deliver. The regression this
      // test exists to catch: before stage 3, EACH of these called `setDragPos`, a `BattleMap`
      // `useState` update, and therefore re-ran BattleMap's entire render function once per call.
      fireEvent.pointerMove(surface, { pointerId: 1, isPrimary: true, clientX: 550, clientY: 300 });
      fireEvent.pointerMove(surface, { pointerId: 1, isPrimary: true, clientX: 620, clientY: 300 });
      fireEvent.pointerMove(surface, { pointerId: 1, isPrimary: true, clientX: 700, clientY: 300 });
      fireEvent.pointerMove(surface, { pointerId: 1, isPrimary: true, clientX: 780, clientY: 300 });

      // The whole point: none of those four pointermoves invoked BattleMap's render function.
      expect(renderSpy.mock.calls.length).toBe(afterPointerDown);

      // And containment did not come at the cost of the drag actually working: the dragged
      // token's own rendered position moved, via `MapTokenSlot`'s independent subscription to
      // the drag-position store, not via any of the (absent) BattleMap re-renders above.
      const endLeft = token.style.left;
      expect(endLeft).not.toBe(startLeft);
      expect(parseFloat(endLeft)).toBeGreaterThan(parseFloat(startLeft));

      fireEvent.pointerUp(surface, { pointerId: 1, isPrimary: true, clientX: 780, clientY: 300 });
    } finally {
      // Restore the real render function so no other test in this process sees the spy.
      memoWrapper.type = originalRender;
    }
  });
});
