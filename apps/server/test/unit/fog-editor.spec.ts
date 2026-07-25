import type { FogRect, FogState } from '@campfire/schema';
import {
  FogUndoStack,
  appendFogReveal,
  deleteFogRegion,
  eraseFogRegion,
  fogRectFromCorners,
  fogStatesEqual,
  hitTestFogRegion,
  moveFogRegion,
  subtractFogRect,
} from '@campfire/schema';

describe('fog editor (issue #472)', () => {
  const base: FogState = {
    enabled: true,
    revealed: [{ x: 10, y: 10, w: 40, h: 40 }],
  };

  it('appendFogReveal enables fog and adds a rectangle', () => {
    const next = appendFogReveal(null, { x: 0, y: 0, w: 20, h: 20 });
    expect(next.enabled).toBe(true);
    expect(next.revealed).toHaveLength(1);
    expect(next.revealed[0].id).toBeDefined();
  });

  it('eraseFogRegion subtracts a brush without clearing unrelated regions', () => {
    const fog: FogState = {
      enabled: true,
      revealed: [
        { id: 'a', x: 0, y: 0, w: 50, h: 50 },
        { id: 'b', x: 60, y: 60, w: 30, h: 30 },
      ],
    };
    const next = eraseFogRegion(fog, { x: 20, y: 20, w: 10, h: 10 });
    expect(next.revealed.some((r) => r.id === 'b')).toBe(true);
    expect(next.revealed.length).toBeGreaterThan(1);
    for (const r of next.revealed) {
      expect(r.x + r.w <= 20 || r.x >= 30 || r.y + r.h <= 20 || r.y >= 30 || r.id === 'b').toBe(true);
    }
  });

  it('subtractFogRect splits into up to four pieces', () => {
    const pieces = subtractFogRect({ x: 0, y: 0, w: 100, h: 100 }, { x: 40, y: 40, w: 20, h: 20 });
    expect(pieces.length).toBe(4);
  });

  it('moveFogRegion and deleteFogRegion target by id', () => {
    const fog: FogState = {
      enabled: true,
      revealed: [
        { id: 'keep', x: 0, y: 0, w: 10, h: 10 },
        { id: 'move', x: 20, y: 20, w: 10, h: 10 },
      ],
    };
    const moved = moveFogRegion(fog, 'move', 5, 5);
    expect(moved.revealed.find((r) => r.id === 'move')).toMatchObject({ x: 25, y: 25 });
    const deleted = deleteFogRegion(fog, 'move');
    expect(deleted.revealed.map((r) => r.id)).toEqual(['keep']);
  });

  it('hitTestFogRegion returns the topmost region', () => {
    const revealed: FogRect[] = [
      { id: 'bottom', x: 0, y: 0, w: 50, h: 50 },
      { id: 'top', x: 10, y: 10, w: 20, h: 20 },
    ];
    expect(hitTestFogRegion(revealed, 15, 15)).toBe('top');
    expect(hitTestFogRegion(revealed, 80, 80)).toBeNull();
  });

  it('fogRectFromCorners normalizes negative-size drags', () => {
    expect(fogRectFromCorners({ x: 60, y: 70 }, { x: 10, y: 20 })).toEqual({ x: 10, y: 20, w: 50, h: 50 });
  });

  it('FogUndoStack supports undo and redo', () => {
    const stack = new FogUndoStack();
    const s0: FogState = { enabled: true, revealed: [] };
    const s1: FogState = { enabled: true, revealed: [{ x: 0, y: 0, w: 10, h: 10 }] };
    const s2: FogState = { enabled: true, revealed: [{ x: 0, y: 0, w: 20, h: 20 }] };
    stack.commit(s0, s1);
    stack.commit(s1, s2);
    expect(fogStatesEqual(stack.undo(s2)!, s1)).toBe(true);
    expect(fogStatesEqual(stack.redo(s1)!, s2)).toBe(true);
    stack.commit(s1, null);
    expect(stack.undo(null)).toEqual(s1);
  });
});
