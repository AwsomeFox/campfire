/**
 * Broadcast-scene model for the Cast / Player Display (issue #823).
 *
 * Issue #60 shipped Player Display as one unbounded vertical document: every
 * combatant, party member, quest, and NPC stacked below a `min-height: 100vh`
 * root. On a passive TV / projector / OBS source that never scrolls, anything
 * past the fold is simply lost.
 *
 * This module turns Cast into a FIXED presentation surface driven by a producer
 * (the DM). It owns the *pure* pieces that a screen-free unit suite can exercise
 * without mounting React or a browser:
 *   - the set of producer-selectable scenes + their labels;
 *   - persistence/validation of the active scene (so a private DM cockpit tab and
 *     a public display tab stay in lockstep via a `storage` event — no server
 *     round-trip, no schema change);
 *   - deterministic paging / rotation math for large initiative orders and long
 *     lists, so off-screen actors are surfaced by paging rather than silently
 *     truncated.
 *
 * Everything here is tick-driven and side-effect free: pass a monotonically
 * advancing `tick` (a rotation timer in the page, an incrementing number in a
 * test) and the same inputs always produce the same window.
 */

/** The producer-selectable broadcast scenes (issue #823). Order = cockpit order. */
export const SCENE_IDS = [
  'map',
  'initiative',
  'party',
  'quests',
  'intermission',
  'blackout',
] as const;

export type SceneId = (typeof SCENE_IDS)[number];

/** Human labels for the DM cockpit scene picker. */
export const SCENE_LABEL: Record<SceneId, string> = {
  map: 'Map',
  initiative: 'Initiative',
  party: 'Party',
  quests: 'Quests',
  intermission: 'Intermission',
  blackout: 'Blackout',
};

/** The scene shown before a producer picks one (and when a stored value is invalid). */
export const DEFAULT_SCENE: SceneId = 'initiative';

const SCENE_ID_SET: ReadonlySet<string> = new Set<string>(SCENE_IDS);

/** Runtime guard for a persisted / cross-tab scene value. */
export function isSceneId(value: unknown): value is SceneId {
  return typeof value === 'string' && SCENE_ID_SET.has(value);
}

// ---------------------------------------------------------------------------
// Cross-tab scene selection.
//
// The DM's cockpit writes the active scene to localStorage under a
// campaign-scoped key; a separate public display tab (a mirrored TV, an OBS
// browser source at the same origin) picks it up through the standard `storage`
// event. This keeps "DM selects → public follows" near-real-time with no server
// changes, while a single tab (DM laptop mirrored to a TV) simply reads its own
// React state.

/** Minimal Storage surface so unit tests can pass a fake without a DOM. */
export interface SceneStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function sceneStorageKey(campaignId: number): string {
  return `cf.screen.scene.${campaignId}`;
}

function defaultStorage(): SceneStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Access can throw in sandboxed / privacy-mode contexts.
    return null;
  }
}

/** Read a persisted scene for a campaign, or null when absent/invalid/unavailable. */
export function readStoredScene(
  campaignId: number,
  storage: SceneStorage | null = defaultStorage(),
): SceneId | null {
  if (!storage || !Number.isFinite(campaignId)) return null;
  try {
    const raw = storage.getItem(sceneStorageKey(campaignId));
    return isSceneId(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** Persist the active scene for a campaign so other tabs and reloads follow it. */
export function writeStoredScene(
  campaignId: number,
  scene: SceneId,
  storage: SceneStorage | null = defaultStorage(),
): void {
  if (!storage || !Number.isFinite(campaignId)) return;
  try {
    storage.setItem(sceneStorageKey(campaignId), scene);
  } catch {
    /* storage full / denied — the in-tab React state still drives this display */
  }
}

// ---------------------------------------------------------------------------
// Paging / rotation math.

function normalizeSize(size: number): number {
  return Number.isFinite(size) && size >= 1 ? Math.floor(size) : 1;
}

/** Non-negative wrapped tick — tolerates negative "previous page" presses. */
function wrap(value: number, modulo: number): number {
  if (modulo <= 0) return 0;
  return ((Math.floor(value) % modulo) + modulo) % modulo;
}

/** Number of pages needed to show `count` items `pageSize` at a time. */
export function pageCount(count: number, pageSize: number): number {
  const size = normalizeSize(pageSize);
  if (count <= 0) return 0;
  return Math.ceil(count / size);
}

/** The turn that follows `currentIndex` in a cyclic initiative order (-1 if none). */
export function nextActorIndex(count: number, currentIndex: number): number {
  if (count <= 0 || currentIndex < 0 || currentIndex >= count) return -1;
  return (currentIndex + 1) % count;
}

export interface InitiativeWindow {
  /** Which page (0-based) is shown for this tick. */
  pageIndex: number;
  /** Total number of pages across the whole order. */
  pageCount: number;
  /** Inclusive start index into the sorted combatant list. */
  start: number;
  /** Exclusive end index into the sorted combatant list. */
  end: number;
  /** True when the shown page contains the current actor (the anchor page). */
  isAnchorPage: boolean;
}

/**
 * Windowed view of a (possibly large) initiative order.
 *
 * The page holding the current actor is the ANCHOR — at `tick` 0 it is shown, so
 * the active turn plus its neighbours are always the first thing on screen. Each
 * further tick rotates forward one page (wrapping), so every off-screen actor is
 * surfaced in turn rather than silently truncated. A negative tick (a producer
 * pressing "previous") rotates backward. When everything fits on one page the
 * window is the whole list and rotation is a no-op.
 */
export function initiativeWindow(
  count: number,
  pageSize: number,
  currentIndex: number,
  tick: number,
): InitiativeWindow {
  const size = normalizeSize(pageSize);
  const pages = pageCount(count, size);
  if (pages <= 1) {
    return { pageIndex: 0, pageCount: Math.max(pages, count > 0 ? 1 : 0), start: 0, end: count, isAnchorPage: true };
  }
  const anchorPage = currentIndex >= 0 && currentIndex < count ? Math.floor(currentIndex / size) : 0;
  const pageIndex = wrap(anchorPage + tick, pages);
  const start = pageIndex * size;
  const end = Math.min(start + size, count);
  return { pageIndex, pageCount: pages, start, end, isAnchorPage: pageIndex === anchorPage };
}

/**
 * A rotating fixed-size slice of `items`. When the list fits within `size` the
 * whole list is returned unchanged; otherwise a `size`-length window starting at
 * `tick` (wrapping around the end) is returned, so over successive ticks every
 * item is shown at least once — an ellipsis/"+N" clamp that never hides for good.
 */
export function rotateWindow<T>(items: readonly T[], size: number, tick: number): T[] {
  const s = normalizeSize(size);
  if (items.length <= s) return [...items];
  const startAt = wrap(tick, items.length);
  const out: T[] = [];
  for (let i = 0; i < s; i += 1) {
    out.push(items[(startAt + i) % items.length]!);
  }
  return out;
}

/** How many items a rotating window hides at a glance (for a "+N more" affordance). */
export function hiddenCount(total: number, size: number): number {
  const s = normalizeSize(size);
  return Math.max(0, total - s);
}
