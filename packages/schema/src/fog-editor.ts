import type { FogRect, FogState } from './index';

/** Minimum width/height (map percent) for a fog rectangle to be kept after edits. */
export const FOG_RECT_MIN_SIZE = 0.5;

/** Max revealed rectangles (matches FogState schema cap). */
export const FOG_REVEALED_MAX = 500;

export type FogRectWithId = FogRect & { id: string };

function rectsIntersect(a: FogRect, b: FogRect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function clampRect(r: FogRect): FogRect | null {
  const x = Math.max(0, Math.min(100, r.x));
  const y = Math.max(0, Math.min(100, r.y));
  const w = Math.max(0, Math.min(100 - x, r.w));
  const h = Math.max(0, Math.min(100 - y, r.h));
  if (w < FOG_RECT_MIN_SIZE || h < FOG_RECT_MIN_SIZE) return null;
  return { ...r, x, y, w, h };
}

/** Subtract erase rectangle `sub` from `rect`, returning zero or more surviving pieces. */
export function subtractFogRect(rect: FogRect, sub: FogRect): FogRect[] {
  if (!rectsIntersect(rect, sub)) return [rect];

  const out: FogRect[] = [];
  const rx2 = rect.x + rect.w;
  const ry2 = rect.y + rect.h;
  const sx2 = sub.x + sub.w;
  const sy2 = sub.y + sub.h;

  if (rect.y < sub.y) {
    const piece = clampRect({ ...rect, y: rect.y, h: sub.y - rect.y });
    if (piece) out.push(piece);
  }
  if (ry2 > sy2) {
    const piece = clampRect({ ...rect, y: sy2, h: ry2 - sy2 });
    if (piece) out.push(piece);
  }

  const midTop = Math.max(rect.y, sub.y);
  const midBot = Math.min(ry2, sy2);
  const midH = midBot - midTop;
  if (midH >= FOG_RECT_MIN_SIZE) {
    if (rect.x < sub.x) {
      const piece = clampRect({ ...rect, x: rect.x, y: midTop, w: sub.x - rect.x, h: midH });
      if (piece) out.push(piece);
    }
    if (rx2 > sx2) {
      const piece = clampRect({ ...rect, x: sx2, y: midTop, w: rx2 - sx2, h: midH });
      if (piece) out.push(piece);
    }
  }

  return out;
}

/** Assign stable ids to any rects missing them (for per-region editing, issue #472). */
export function ensureFogRectIds(revealed: readonly FogRect[]): FogRectWithId[] {
  return revealed.map((r, i) => ({
    ...r,
    id: r.id ?? `fog-${i}-${Math.round(r.x * 10)}-${Math.round(r.y * 10)}`,
  }));
}

/** Append a reveal rectangle, enabling fog and capping the list. */
export function appendFogReveal(fog: FogState | null | undefined, rect: FogRect): FogState {
  const withId = { ...rect, id: rect.id ?? newFogRectId() };
  const revealed = [...ensureFogRectIds(fog?.revealed ?? []), withId].slice(-FOG_REVEALED_MAX);
  return { enabled: true, revealed };
}

/** Erase (hide) a brush rectangle from the union of revealed regions. */
export function eraseFogRegion(fog: FogState | null | undefined, eraseRect: FogRect): FogState {
  const current = fog ?? { enabled: true, revealed: [] };
  const next: FogRect[] = [];
  for (const r of ensureFogRectIds(current.revealed)) {
    for (const piece of subtractFogRect(r, eraseRect)) {
      next.push({ ...piece, id: piece.id ?? r.id });
    }
  }
  return { enabled: true, revealed: next.slice(-FOG_REVEALED_MAX) };
}

/** Move one region by a map-percent delta. */
export function moveFogRegion(
  fog: FogState | null | undefined,
  regionId: string,
  dx: number,
  dy: number,
): FogState {
  const current = fog ?? { enabled: true, revealed: [] };
  const revealed = ensureFogRectIds(current.revealed).map((r) =>
    r.id === regionId
      ? clampRect({ ...r, x: r.x + dx, y: r.y + dy }) ?? r
      : r,
  );
  return { ...current, enabled: true, revealed };
}

/** Remove one region by id. */
export function deleteFogRegion(fog: FogState | null | undefined, regionId: string): FogState {
  const current = fog ?? { enabled: true, revealed: [] };
  return {
    ...current,
    enabled: true,
    revealed: ensureFogRectIds(current.revealed).filter((r) => r.id !== regionId),
  };
}

/** Hit-test revealed regions; returns the topmost (last in array) region id at a point. */
export function hitTestFogRegion(revealed: readonly FogRect[], x: number, y: number): string | null {
  const withIds = ensureFogRectIds(revealed);
  for (let i = withIds.length - 1; i >= 0; i--) {
    const r = withIds[i];
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r.id;
  }
  return null;
}

/** Deep-enough equality for undo-stack deduplication. */
export function fogStatesEqual(a: FogState | null | undefined, b: FogState | null | undefined): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (a.enabled !== b.enabled) return false;
  if (a.revealed.length !== b.revealed.length) return false;
  for (let i = 0; i < a.revealed.length; i++) {
    const ra = a.revealed[i];
    const rb = b.revealed[i];
    if (ra.x !== rb.x || ra.y !== rb.y || ra.w !== rb.w || ra.h !== rb.h) return false;
    if ((ra.id ?? '') !== (rb.id ?? '')) return false;
  }
  return true;
}

export function newFogRectId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `fog-${crypto.randomUUID().slice(0, 8)}`;
  }
  return `fog-${Date.now().toString(36)}`;
}

/** Normalize drag corners into a positive-size rectangle. */
export function fogRectFromCorners(
  a: { x: number; y: number },
  b: { x: number; y: number },
): FogRect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

/**
 * Local undo/redo stack for fog edits (issue #472). Each `commit` snapshots the prior
 * state; undo/redo replays without touching the server until the caller applies the result.
 */
export class FogUndoStack {
  private past: Array<FogState | null> = [];
  private future: Array<FogState | null> = [];

  reset(): void {
    this.past = [];
    this.future = [];
  }

  /** Record `next` as the new head; `previous` is pushed for undo. */
  commit(previous: FogState | null, next: FogState | null): void {
    if (fogStatesEqual(previous, next)) return;
    this.past.push(previous);
    if (this.past.length > 50) this.past.shift();
    this.future = [];
  }

  canUndo(): boolean {
    return this.past.length > 0;
  }

  canRedo(): boolean {
    return this.future.length > 0;
  }

  undo(current: FogState | null): FogState | null {
    if (!this.canUndo()) return null;
    const prev = this.past.pop()!;
    this.future.push(current);
    return prev;
  }

  redo(current: FogState | null): FogState | null {
    if (!this.canRedo()) return null;
    const next = this.future.pop()!;
    this.past.push(current);
    return next;
  }
}
