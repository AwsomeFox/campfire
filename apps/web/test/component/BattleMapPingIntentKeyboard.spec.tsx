/**
 * Component-render coverage for the map-ping intent menu's keyboard path
 * (issue #2047, follow-up to #1937 / PR #2046).
 *
 * PR #2046 added a Look/Danger/Move-here intent menu to map pings, opened
 * only by a long-press (touch) or a right-click (mouse) — neither has any
 * keyboard equivalent, so a keyboard-only user could send a plain ping but
 * never reach the labeled-intent menu at all. This renders the real
 * `BattleMap` component with the Ping tool active and drives Shift+Enter on
 * the map surface (the chosen keyboard affordance), asserting the intent
 * menu actually appears in the DOM and that choosing an item calls `onPing`
 * with the right label — a source scan could confirm the branch exists but
 * not that it is wired to the right condition (`&&` vs a stray `||`) or that
 * the menu that opens is the SAME real, translated menu the pointer paths
 * reach, with focus actually landing inside it.
 */
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, test, expect, vi, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EncounterWithCombatants } from '@campfire/schema';
import '../../src/i18n';

// vi.mock is hoisted above every top-level statement in this file, so BattleMap's
// `useDerivativeManifest` (via `api.get` on the manifest URL) and its DM-only
// token-formations query never reach a real `fetch` under jsdom.
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

// jsdom does not implement matchMedia; BattleMap reads it (prefersReducedMotion)
// on every render. Stubbed globally here rather than per-test, matching how a
// real browser always has SOME answer for this query.
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

// jsdom does not implement ResizeObserver either; BattleMap uses one to track its
// surface size. A no-op stub is enough — this suite never depends on layout
// dimensions, only on the ping tool + intent menu's own React state.
if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

function baseEncounter(): EncounterWithCombatants {
  return EncounterWithCombatants.parse({
    id: 1,
    campaignId: 1,
    name: 'Goblin ambush',
    combatants: [],
    // A non-null map attachment is required for the map surface (and therefore the
    // ping tool + intent menu) to render at all — BattleMap shows an upload prompt
    // instead when there is no map.
    mapAttachmentId: 42,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
}

function renderBattleMap(overrides: Partial<BattleMapProps> = {}) {
  const props: BattleMapProps = {
    encounter: baseEncounter(),
    campaignId: 1,
    isDm: false,
    viewerUserId: 'user-1',
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
    ...overrides,
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

/** Arms the Ping tool via the real toolbar button, exactly as a user would. */
function armPingTool() {
  fireEvent.click(screen.getByTestId('map-tool-ping'));
}

describe('BattleMap ping intent menu keyboard path (issue #2047)', () => {
  test('Shift+Enter on the map surface, with Ping armed, opens the intent menu', () => {
    renderBattleMap();
    armPingTool();

    expect(screen.queryByTestId('map-ping-intent-menu')).toBeNull();
    const surface = screen.getByTestId('battle-map-surface');
    fireEvent.keyDown(surface, { key: 'Enter', shiftKey: true });

    expect(screen.getByTestId('map-ping-intent-menu')).toBeTruthy();
  });

  test('Shift+Space on the map surface also opens the intent menu', () => {
    renderBattleMap();
    armPingTool();

    const surface = screen.getByTestId('battle-map-surface');
    fireEvent.keyDown(surface, { key: ' ', shiftKey: true });

    expect(screen.getByTestId('map-ping-intent-menu')).toBeTruthy();
  });

  test('plain Enter (no Shift) still sends an unlabeled ping and does NOT open the intent menu', () => {
    const { props } = renderBattleMap();
    armPingTool();

    const surface = screen.getByTestId('battle-map-surface');
    fireEvent.keyDown(surface, { key: 'Enter' });

    expect(screen.queryByTestId('map-ping-intent-menu')).toBeNull();
    expect(props.onPing).toHaveBeenCalledWith(50, 50);
  });

  test('opening the menu via keyboard moves focus onto the first menu item', () => {
    renderBattleMap();
    armPingTool();

    const surface = screen.getByTestId('battle-map-surface');
    fireEvent.keyDown(surface, { key: 'Enter', shiftKey: true });

    const firstItem = screen.getByTestId('map-ping-intent-look');
    expect(document.activeElement).toBe(firstItem);
  });

  test('choosing Danger from a keyboard-opened menu sends a labeled ping at the map center', () => {
    const { props } = renderBattleMap();
    armPingTool();

    const surface = screen.getByTestId('battle-map-surface');
    fireEvent.keyDown(surface, { key: 'Enter', shiftKey: true });
    fireEvent.click(screen.getByTestId('map-ping-intent-danger'));

    expect(props.onPing).toHaveBeenCalledWith(50, 50, 'Danger');
    expect(screen.queryByTestId('map-ping-intent-menu')).toBeNull();
  });

  test('Escape closes a keyboard-opened menu without sending any ping, and returns focus to the surface', () => {
    const { props } = renderBattleMap();
    armPingTool();

    const surface = screen.getByTestId('battle-map-surface');
    fireEvent.keyDown(surface, { key: 'Enter', shiftKey: true });
    expect(screen.getByTestId('map-ping-intent-menu')).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.queryByTestId('map-ping-intent-menu')).toBeNull();
    expect(props.onPing).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(surface);
  });

  test('Shift+Enter is a no-op outside the Ping tool (e.g. Move, the default tool)', () => {
    const { props } = renderBattleMap();
    // No armPingTool() call — the map stays on its default 'move' tool.
    const surface = screen.getByTestId('battle-map-surface');
    fireEvent.keyDown(surface, { key: 'Enter', shiftKey: true });

    expect(screen.queryByTestId('map-ping-intent-menu')).toBeNull();
    expect(props.onPing).not.toHaveBeenCalled();
  });
});
