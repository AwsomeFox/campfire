/**
 * AoE template hit-testing for apply-damage multi-target (issue #626).
 *
 * Mirrors the pixel-space geometry used when rendering AoE overlays in RunSessionPage
 * (`aoePolygonPoints` + circle radius). Token and template origins are map-percent;
 * sizes convert through gridScale (feet per cell) and gridSize (% of map width per cell).
 */
import type { AoeShape, AoeTemplate } from '@campfire/schema';
import { cellSizePx, mapPercentToLayerPx, type MapPercent, type Rect } from './mapRenderedBounds';

/** Canonical reference map when viewport size is unknown (square, 1000px wide). */
export const DEFAULT_AOE_MAP_RECT: Rect = { left: 0, top: 0, width: 1000, height: 1000 };

export type AoeHitLayout = {
  mapRect: Rect;
  /** Calibrated cell width in px — must match BattleMap AoE rendering. */
  cellPx: number;
};

export type AoeHitTestContext = {
  /** Cell edge as percent of map width. */
  gridSize: number;
  /** Feet represented by one grid cell. */
  gridScale: number;
  /** Rendered map rect; defaults to {@link DEFAULT_AOE_MAP_RECT}. */
  mapRect?: Rect;
  /** When set, overrides gridSize-derived cell size (calibrated grid). */
  cellPx?: number;
};

type Point = { x: number; y: number };

/** Ray-casting point-in-polygon test (even-odd rule). */
export function pointInPolygon(px: number, py: number, vertices: readonly Point[]): boolean {
  if (vertices.length < 3) return false;
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const xi = vertices[i]!.x;
    const yi = vertices[i]!.y;
    const xj = vertices[j]!.x;
    const yj = vertices[j]!.y;
    const intersects = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Polygon vertices for cone/line AoE in map-layer pixel space — same math as
 * `aoePolygonPoints` in RunSessionPage.tsx.
 */
export function aoePolygonVertices(
  shape: Exclude<AoeShape, 'circle'>,
  ox: number,
  oy: number,
  lengthPx: number,
  angleRad: number,
  widthPx: number,
): Point[] {
  const dx = Math.cos(angleRad);
  const dy = Math.sin(angleRad);
  const px = -dy;
  const py = dx;
  if (shape === 'cone') {
    // D&D 5e cone: 90° quadrant; widthPx is unused (line thickness only).
    const fx = ox + dx * lengthPx;
    const fy = oy + dy * lengthPx;
    const half = lengthPx / 2;
    return [
      { x: ox, y: oy },
      { x: fx + px * half, y: fy + py * half },
      { x: fx - px * half, y: fy - py * half },
    ];
  }
  const half = widthPx / 2;
  const fx = ox + dx * lengthPx;
  const fy = oy + dy * lengthPx;
  return [
    { x: ox + px * half, y: oy + py * half },
    { x: fx + px * half, y: fy + py * half },
    { x: fx - px * half, y: fy - py * half },
    { x: ox - px * half, y: oy - py * half },
  ];
}

function resolveMapRect(ctx: AoeHitTestContext): Rect {
  return ctx.mapRect ?? DEFAULT_AOE_MAP_RECT;
}

/** True when a map-percent token position lies inside the AoE template. */
export function tokenInAoe(tokenPos: MapPercent, aoe: AoeTemplate, ctx: AoeHitTestContext): boolean {
  if (!(ctx.gridSize > 0) || !(ctx.gridScale > 0)) return false;
  const mapRect = resolveMapRect(ctx);
  const cellPx = ctx.cellPx ?? cellSizePx(ctx.gridSize, mapRect.width);
  if (!(cellPx > 0)) return false;

  const { x: ox, y: oy } = mapPercentToLayerPx({ x: aoe.x, y: aoe.y }, mapRect);
  const { x: tx, y: ty } = mapPercentToLayerPx(tokenPos, mapRect);
  const lengthPx = (aoe.sizeFt / ctx.gridScale) * cellPx;
  if (!(lengthPx > 0)) return false;

  if (aoe.shape === 'circle') {
    return Math.hypot(tx - ox, ty - oy) <= lengthPx;
  }

  const angleRad = (aoe.angleDeg * Math.PI) / 180;
  const vertices = aoePolygonVertices(aoe.shape, ox, oy, lengthPx, angleRad, cellPx);
  return pointInPolygon(tx, ty, vertices);
}

/** Combatants with placed tokens that intersect the given AoE template. */
export function combatantsInAoe<T extends { tokenX: number | null; tokenY: number | null }>(
  combatants: readonly T[],
  aoe: AoeTemplate,
  ctx: AoeHitTestContext,
): T[] {
  return combatants.filter(
    (c) =>
      c.tokenX != null &&
      c.tokenY != null &&
      tokenInAoe({ x: c.tokenX, y: c.tokenY }, aoe, ctx),
  );
}
