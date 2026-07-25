import {
  clampTimelineListLimit,
  decodeTimelineCursor,
  encodeTimelineCursor,
} from '../../src/modules/timeline/timeline-pagination';
import { buildCursorListPage, encodeCursor } from '../../src/common/cursor-pagination';

describe('timeline-pagination helpers (issue #615)', () => {
  it('clamps page size to default 50 and max 200', () => {
    expect(clampTimelineListLimit(undefined)).toBe(50);
    expect(clampTimelineListLimit(1)).toBe(1);
    expect(clampTimelineListLimit(200)).toBe(200);
    expect(clampTimelineListLimit(500)).toBe(200);
    expect(clampTimelineListLimit(0)).toBe(50);
    expect(clampTimelineListLimit(-3)).toBe(50);
  });

  it('round-trips sort cursors and rejects invalid payloads', () => {
    const cursor = encodeTimelineCursor({ v: 1, m: 'sort', s: 20, i: 42 });
    expect(decodeTimelineCursor(cursor)).toEqual({ v: 1, m: 'sort', s: 20, i: 42 });
    expect(decodeTimelineCursor(undefined)).toBeUndefined();
    expect(() => decodeTimelineCursor('%%%not-base64%%%')).toThrow(/cursor/i);

    const wrongMode = encodeCursor({ v: 1, m: 'id', i: 1 });
    expect(() => decodeTimelineCursor(wrongMode)).toThrow(/cursor/i);
  });
});

describe('cursor-pagination shared helpers (issue #615)', () => {
  it('buildCursorListPage slices limit+1 probe and encodes nextCursor', () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const page = buildCursorListPage(rows, 2, 10, (last) => ({ v: 1, m: 'sort', s: 0, i: last.id }));
    expect(page.items).toEqual([{ id: 1 }, { id: 2 }]);
    expect(page.hasMore).toBe(true);
    expect(page.total).toBe(10);
    expect(page.limit).toBe(2);
    expect(decodeTimelineCursor(page.nextCursor!)).toEqual({ v: 1, m: 'sort', s: 0, i: 2 });
  });

  it('returns null nextCursor on the terminal page', () => {
    const page = buildCursorListPage([{ id: 1 }], 2, 1, (last) => ({ v: 1, m: 'sort', s: 0, i: last.id }));
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });
});
