import { expect, test } from '@playwright/test';
import {
  DEFAULT_SCENE,
  hiddenCount,
  initiativeWindow,
  isSceneId,
  nextActorIndex,
  pageCount,
  readStoredScene,
  rotateWindow,
  SCENE_IDS,
  SCENE_LABEL,
  sceneStorageKey,
  writeStoredScene,
  type SceneId,
  type SceneStorage,
} from '../../src/features/screen/playerDisplayScene';

/**
 * Issue #823 — pure scene / paging model for the Cast broadcast stage. Exercised
 * without a browser so the deterministic paging/rotation and cross-tab scene
 * persistence are pinned in isolation.
 */

/** In-memory Storage stand-in for the cross-tab scene selection helpers. */
function fakeStorage(seed: Record<string, string> = {}): SceneStorage & { data: Map<string, string> } {
  const data = new Map<string, string>(Object.entries(seed));
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key)! : null),
    setItem: (key, value) => void data.set(key, value),
  };
}

test.describe('scene identity + labels', () => {
  test('every producer scene has a label and is a valid id', () => {
    for (const id of SCENE_IDS) {
      expect(isSceneId(id)).toBe(true);
      expect(SCENE_LABEL[id]).toBeTruthy();
    }
    expect(SCENE_IDS).toEqual(['map', 'initiative', 'party', 'quests', 'intermission', 'blackout']);
    expect(isSceneId(DEFAULT_SCENE)).toBe(true);
  });

  test('rejects unknown / malformed scene values', () => {
    expect(isSceneId('lobby')).toBe(false);
    expect(isSceneId('')).toBe(false);
    expect(isSceneId(null)).toBe(false);
    expect(isSceneId(3)).toBe(false);
  });
});

test.describe('cross-tab scene persistence', () => {
  test('round-trips a scene under a campaign-scoped key', () => {
    const storage = fakeStorage();
    expect(readStoredScene(7, storage)).toBeNull();
    writeStoredScene(7, 'party', storage);
    expect(storage.data.get(sceneStorageKey(7))).toBe('party');
    expect(readStoredScene(7, storage)).toBe('party');
  });

  test('keeps campaigns isolated and ignores invalid stored values', () => {
    const storage = fakeStorage({
      [sceneStorageKey(1)]: 'quests',
      [sceneStorageKey(2)]: 'not-a-scene',
    });
    expect(readStoredScene(1, storage)).toBe('quests');
    expect(readStoredScene(2, storage)).toBeNull();
    expect(readStoredScene(Number.NaN, storage)).toBeNull();
  });
});

test.describe('nextActorIndex', () => {
  test('wraps to the top of the order and guards empty / out-of-range input', () => {
    expect(nextActorIndex(4, 0)).toBe(1);
    expect(nextActorIndex(4, 3)).toBe(0);
    expect(nextActorIndex(0, -1)).toBe(-1);
    expect(nextActorIndex(4, -1)).toBe(-1);
    expect(nextActorIndex(4, 9)).toBe(-1);
  });
});

test.describe('initiativeWindow paging + rotation', () => {
  test('shows the whole order on one page when it fits (rotation is a no-op)', () => {
    const win = initiativeWindow(6, 8, 2, 5);
    expect(win).toEqual({ pageIndex: 0, pageCount: 1, start: 0, end: 6, isAnchorPage: true });
  });

  test('anchors tick 0 on the page holding the current actor', () => {
    // 20 combatants, 8 per page → 3 pages. Current actor at index 12 → page 1.
    const win = initiativeWindow(20, 8, 12, 0);
    expect(win.pageCount).toBe(3);
    expect(win.pageIndex).toBe(1);
    expect(win.isAnchorPage).toBe(true);
    expect([win.start, win.end]).toEqual([8, 16]);
  });

  test('each tick rotates forward one page and surfaces every off-screen actor', () => {
    const count = 20;
    const seen = new Set<number>();
    for (let tick = 0; tick < 3; tick += 1) {
      const win = initiativeWindow(count, 8, 12, tick);
      for (let i = win.start; i < win.end; i += 1) seen.add(i);
    }
    // Rotating through pageCount ticks reveals all 20 actors — nothing truncated.
    expect(seen.size).toBe(count);
    // tick === pageCount returns to the anchor page.
    expect(initiativeWindow(count, 8, 12, 3)).toMatchObject({ pageIndex: 1, isAnchorPage: true });
  });

  test('a negative tick (a producer stepping back) rotates backward without NaN', () => {
    const win = initiativeWindow(20, 8, 0, -1);
    expect(win.pageIndex).toBe(2); // one page before the anchor (page 0), wrapped
    expect(win.start).toBe(16);
    expect(win.end).toBe(20);
  });

  test('clamps a pathological pageSize to at least one row per page', () => {
    const win = initiativeWindow(3, 0, 0, 0);
    expect(win.pageCount).toBe(3);
    expect(win.end - win.start).toBe(1);
  });
});

test.describe('rotateWindow + hiddenCount', () => {
  test('returns the whole list untouched when it fits', () => {
    expect(rotateWindow([1, 2, 3], 4, 9)).toEqual([1, 2, 3]);
    expect(hiddenCount(3, 4)).toBe(0);
  });

  test('rotates a fixed-size window across ticks so nothing hides for good', () => {
    const items = ['a', 'b', 'c', 'd', 'e'];
    expect(rotateWindow(items, 3, 0)).toEqual(['a', 'b', 'c']);
    expect(rotateWindow(items, 3, 1)).toEqual(['b', 'c', 'd']);
    expect(rotateWindow(items, 3, 4)).toEqual(['e', 'a', 'b']); // wraps
    expect(hiddenCount(items.length, 3)).toBe(2);

    const shownAcrossFullCycle = new Set<string>();
    for (let tick = 0; tick < items.length; tick += 1) {
      for (const item of rotateWindow(items, 3, tick)) shownAcrossFullCycle.add(item);
    }
    expect(shownAcrossFullCycle.size).toBe(items.length);
  });
});

test.describe('pageCount', () => {
  test('counts pages and treats an empty list as zero pages', () => {
    expect(pageCount(0, 8)).toBe(0);
    expect(pageCount(8, 8)).toBe(1);
    expect(pageCount(9, 8)).toBe(2);
    expect(pageCount(20, 8)).toBe(3);
  });
});

// Type-only guard that SceneId narrowing stays in sync with SCENE_IDS.
const _typeCheck: SceneId = SCENE_IDS[0];
void _typeCheck;
