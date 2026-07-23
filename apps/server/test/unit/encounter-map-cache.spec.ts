import { normalizeRevealedForCache } from '../../src/modules/encounters/encounter-map.service';

describe('normalizeRevealedForCache', () => {
  it('orders rectangles stably so equivalent masks share a cache key', () => {
    const a = [
      { x: 10, y: 20, w: 30, h: 40 },
      { x: 0, y: 0, w: 50, h: 50 },
    ];
    const b = [
      { x: 0, y: 0, w: 50, h: 50 },
      { x: 10, y: 20, w: 30, h: 40 },
    ];
    expect(JSON.stringify(normalizeRevealedForCache(a))).toBe(JSON.stringify(normalizeRevealedForCache(b)));
    expect(normalizeRevealedForCache(a)).toEqual([
      { x: 0, y: 0, w: 50, h: 50 },
      { x: 10, y: 20, w: 30, h: 40 },
    ]);
  });
});
