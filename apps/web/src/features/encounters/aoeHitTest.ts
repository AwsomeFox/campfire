/**
 * AoE template hit-testing for apply-damage multi-target (issue #626).
 *
 * Mirrors the pixel-space geometry used when rendering AoE overlays in RunSessionPage
 * (`aoePolygonPoints` + circle radius). Token and template origins are map-percent;
 * sizes convert through gridScale (feet per cell) and gridSize (% of map width per cell).
 * Hex grids use cube-distance circle hit tests (issue #467). Token footprints, not just
 * centre points, are tested against the template so Large+ creatures on the edge are
 * included and tiny tokens whose centre barely pokes inside are only included when their
 * actual footprint overlaps (issue #1460).
 */
import type { AoeShape, AoeTemplate, GridDistanceRule, GridType, HexOrientation, TokenSize } from '@campfire/schema';
import {
  calibrationToPx,
  cellSizePx,
  mapPercentToLayerPx,
  resolveGridCalibration,
  type GridCalibration,
  type MapPercent,
  type Rect,
} from './mapRenderedBounds';
import {
  fromGridFrame,
  hexDistance,
  hexVerticesGridFrac,
  mapPercentToAxial,
  tokenFootprintHexes,
} from './hexGeometry';
import { tokenFootprintCells } from './tokenFootprint';

/** Canonical reference map when viewport size is unknown (square, 1000px wide). */
export const DEFAULT_AOE_MAP_RECT: Rect = { left: 0, top: 0, width: 1000, height: 1000 };

const EPS = 1e-9;

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
  /** Grid type — hex circles use cube distance (issue #467). */
  gridType?: GridType;
  /** Hex orientation when gridType is hex. */
  hexOrientation?: HexOrientation;
  /** Resolved calibration for hex hit tests. */
  calibration?: GridCalibration | null;
  /** Adapter distance rule (unused for hit tests; reserved for parity). */
  distanceRule?: GridDistanceRule;
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
    // D&D 5e cone: 90° quadrant; widthPx applies to line shape only.
    void widthPx;
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

function resolveCalibration(ctx: AoeHitTestContext): GridCalibration | null {
  return ctx.calibration ?? resolveGridCalibration({ gridSize: ctx.gridSize });
}

function polygonProjection(poly: readonly Point[], axis: Point): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const v of poly) {
    const d = v.x * axis.x + v.y * axis.y;
    min = Math.min(min, d);
    max = Math.max(max, d);
  }
  return { min, max };
}

function intervalsOverlap(a: { min: number; max: number }, b: { min: number; max: number }): boolean {
  return a.max > b.min + EPS && b.max > a.min + EPS;
}

function normalAxis(a: Point, b: Point): Point | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (!(len > EPS)) return null;
  return { x: -dy / len, y: dx / len };
}

/** Separating Axis Theorem test for two convex polygons. */
function convexPolygonsIntersect(a: readonly Point[], b: readonly Point[]): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const j = (i + 1) % poly.length;
      const axis = normalAxis(poly[i]!, poly[j]!);
      if (!axis) continue;
      const pa = polygonProjection(a, axis);
      const pb = polygonProjection(b, axis);
      if (!intervalsOverlap(pa, pb)) return false;
    }
  }
  return true;
}

/** Distance from a circle centre to the closest point in an axis-aligned square. */
function circleToSquareDistance(ox: number, oy: number, sx: number, sy: number, half: number): number {
  const dx = Math.max(0, Math.abs(ox - sx) - half);
  const dy = Math.max(0, Math.abs(oy - sy) - half);
  return Math.hypot(dx, dy);
}

function squareFootprintVertices(tx: number, ty: number, half: number): Point[] {
  return [
    { x: tx - half, y: ty - half },
    { x: tx + half, y: ty - half },
    { x: tx + half, y: ty + half },
    { x: tx - half, y: ty + half },
  ];
}

function tokenInCircleSquare(
  ox: number,
  oy: number,
  lengthPx: number,
  tx: number,
  ty: number,
  tokenSize: TokenSize,
  cellPx: number,
): boolean {
  const footprintCells = tokenFootprintCells(tokenSize);
  const half = (footprintCells * cellPx) / 2;
  return circleToSquareDistance(ox, oy, tx, ty, half) < lengthPx - EPS;
}

function tokenInPolygonSquare(
  aoeVerts: Point[],
  tx: number,
  ty: number,
  tokenSize: TokenSize,
  cellPx: number,
): boolean {
  const footprintCells = tokenFootprintCells(tokenSize);
  const half = (footprintCells * cellPx) / 2;
  if (!(half > EPS)) return pointInPolygon(tx, ty, aoeVerts);
  const tokenSquare = squareFootprintVertices(tx, ty, half);
  return convexPolygonsIntersect(tokenSquare, aoeVerts);
}

function tokenInHexCircle(
  tokenPos: MapPercent,
  tokenSize: TokenSize,
  aoe: AoeTemplate,
  ctx: AoeHitTestContext,
  mapRect: Rect,
  cal: GridCalibration,
): boolean {
  const orientation = ctx.hexOrientation ?? 'pointy';
  const radiusCells = aoe.sizeFt / ctx.gridScale;
  const originAxial = mapPercentToAxial({ x: aoe.x, y: aoe.y }, cal, mapRect, orientation);
  const radius = Math.max(0, Math.ceil(radiusCells));
  const footprint = tokenFootprintHexes(tokenPos, tokenSize, cal, mapRect, orientation);
  for (const cell of footprint) {
    if (hexDistance(cell, originAxial) <= radius) return true;
  }
  return false;
}

function tokenInHexPolygon(
  tokenPos: MapPercent,
  tokenSize: TokenSize,
  aoeVerts: Point[],
  ctx: AoeHitTestContext,
  mapRect: Rect,
  cal: GridCalibration,
  cellPx: number,
): boolean {
  const orientation = ctx.hexOrientation ?? 'pointy';
  const calPx = calibrationToPx(cal, mapRect.width);
  const footprint = tokenFootprintHexes(tokenPos, tokenSize, cal, mapRect, orientation);
  for (const cell of footprint) {
    const hexVertsGrid = hexVerticesGridFrac(cell, cellPx, orientation);
    const hexVerts = hexVertsGrid.map(([gx, gy]) => fromGridFrame({ x: gx, y: gy }, calPx));
    if (convexPolygonsIntersect(hexVerts, aoeVerts)) return true;
  }
  return false;
}

/** True when a map-percent token position lies inside the AoE template. */
export function tokenInAoe(
  tokenPos: MapPercent,
  aoe: AoeTemplate,
  ctx: AoeHitTestContext,
  tokenSize?: TokenSize | null,
): boolean {
  if (!(ctx.gridSize > 0) || !(ctx.gridScale > 0)) return false;
  const mapRect = resolveMapRect(ctx);
  const cellPx = ctx.cellPx ?? cellSizePx(ctx.gridSize, mapRect.width);
  if (!(cellPx > 0)) return false;

  const { x: ox, y: oy } = mapPercentToLayerPx({ x: aoe.x, y: aoe.y }, mapRect);
  const { x: tx, y: ty } = mapPercentToLayerPx(tokenPos, mapRect);
  const lengthPx = (aoe.sizeFt / ctx.gridScale) * cellPx;
  if (!(lengthPx > 0)) return false;

  const size = tokenSize ?? 'medium';

  if (ctx.gridType === 'hex') {
    const cal = resolveCalibration(ctx);
    if (!cal) return false;
    if (aoe.shape === 'circle') {
      return tokenInHexCircle(tokenPos, size, aoe, ctx, mapRect, cal);
    }
    const angleRad = (aoe.angleDeg * Math.PI) / 180;
    const aoeVerts = aoePolygonVertices(aoe.shape, ox, oy, lengthPx, angleRad, cellPx);
    return tokenInHexPolygon(tokenPos, size, aoeVerts, ctx, mapRect, cal, cellPx);
  }

  if (aoe.shape === 'circle') {
    return tokenInCircleSquare(ox, oy, lengthPx, tx, ty, size, cellPx);
  }

  const angleRad = (aoe.angleDeg * Math.PI) / 180;
  const aoeVerts = aoePolygonVertices(aoe.shape, ox, oy, lengthPx, angleRad, cellPx);
  return tokenInPolygonSquare(aoeVerts, tx, ty, size, cellPx);
}

/** Combatants with placed tokens that intersect the given AoE template. */
export function combatantsInAoe<
  T extends { tokenX: number | null; tokenY: number | null; tokenSize?: TokenSize | null },
>(combatants: readonly T[], aoe: AoeTemplate, ctx: AoeHitTestContext): T[] {
  return combatants.filter(
    (c) =>
      c.tokenX != null &&
      c.tokenY != null &&
      tokenInAoe({ x: c.tokenX, y: c.tokenY }, aoe, ctx, c.tokenSize),
  );
}
