/**
 * Regression guard for issue #1308's review finding on PR #2174: `player-display-cast-
 * session.spec.ts` failed because `MapObjectsOverlay` (rendered inside `BattleMap`) read
 * `mapObjects.length` on a value that arrived `undefined`, throwing during render and
 * taking the whole map scene down with it — `cf-scene-map-body` went missing entirely,
 * not merely empty.
 *
 * `mapObjects` is a required field on `EncounterWithCombatants` (the schema backs it with
 * `.default([])`, so `EncounterWithCombatants.parse(...)` always fills it in) — but not
 * every `encounter` BattleMap receives has been through that parse. The Cast projection's
 * `safeEncounterForCast` (`apps/web/src/features/screen/playerSafe.ts`) spreads whatever
 * object it was handed; a hand-built object literal in a test, or any future caller that
 * skips schema validation, can arrive without the key at all. `BattleMap.tsx` already had
 * an established convention for exactly this: every read of the sibling `aoe` field (same
 * `.default([])` schema shape) is written `encounter.aoe ?? []`, not `encounter.aoe` bare.
 * The fix applies the same convention to `mapObjects`.
 *
 * This test mounts the REAL `BattleMap` with an encounter object that is missing
 * `mapObjects` at the type level via a deliberate cast — simulating exactly the
 * unvalidated-JSON path that broke the cast scene — and asserts the map surface still
 * renders instead of throwing.
 */
import { render, screen, cleanup } from '@testing-library/react';
import { describe, test, expect, vi, afterEach, beforeAll } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EncounterWithCombatants } from '@campfire/schema';
import '../../src/i18n';

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

// jsdom lays out nothing, so BattleMap's surface would report a 0x0 box and `mapRect` would
// stay null — and MapObjectsOverlay early-returns on a null mapRect, which would let this
// test pass for the WRONG reason (never actually reaching the `.length` read it exists to
// guard). A flat box makes `mapRect` real, so the overlay actually runs with the missing field.
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 1000 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 600 });
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600, x: 0, y: 0, toJSON() {} }) as DOMRect;
});

function renderBattleMap(encounter: EncounterWithCombatants) {
  const props: BattleMapProps = {
    encounter,
    campaignId: 1,
    isDm: false,
    viewerUserId: 'player-1',
    canDmWrite: false,
    busy: false,
    canMoveToken: () => false,
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
    projection: 'cast',
  };
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <BattleMap {...props} />
    </QueryClientProvider>,
  );
}

describe('BattleMap tolerates an encounter with no mapObjects field (issue #1308, PR #2174 review)', () => {
  test('renders the map surface instead of throwing when mapObjects is absent (unvalidated-JSON shape)', () => {
    // A validated encounter (mapObjects: [] filled in by the schema default), then the exact
    // shape that broke the cast scene: `mapObjects` deleted, simulating a hand-built or
    // pre-#1308 payload that was never run through EncounterWithCombatants.parse.
    const validated = EncounterWithCombatants.parse({
      id: 1,
      campaignId: 1,
      name: 'Cast Fight',
      combatants: [],
      mapAttachmentId: 42,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const { mapObjects: _omitted, ...withoutMapObjects } = validated;
    const unvalidated = withoutMapObjects as unknown as EncounterWithCombatants;
    expect('mapObjects' in unvalidated).toBe(false);

    expect(() => renderBattleMap(unvalidated)).not.toThrow();
    expect(screen.getByTestId('battle-map-surface')).toBeTruthy();
  });

  test('a real (schema-validated) encounter still renders normally, as a contrast case', () => {
    const encounter = EncounterWithCombatants.parse({
      id: 2,
      campaignId: 1,
      name: 'Validated Fight',
      combatants: [],
      mapAttachmentId: 42,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(encounter.mapObjects).toEqual([]);
    renderBattleMap(encounter);
    expect(screen.getByTestId('battle-map-surface')).toBeTruthy();
  });
});
