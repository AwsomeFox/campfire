/**
 * Hex grid geometry for the VTT (issue #467).
 *
 * Shared hex-center snapping, axial/cube coordinates, hex-aware distance,
 * footprints, overlay polygons, and fog snapping. Every consumer — overlay,
 * token snap, ruler, AoE, fog — reads geometry through THIS module so DM and
 * player viewports stay identical (same pattern as mapRenderedBounds #417).
 */

import type { GridDistanceRule, HexOrientation, TokenSize } from '@campfire/schema';
import {
  calibrationToPx,
  layerPxToMapPercent,
  mapPercentToLayerPx,
  clampPercent,
  type GridCalibration,
  type GridCalibrationPx,
  type MapPercent,
  type Rect,
} from './mapRenderedBounds';

export type { HexOrientation };

/** Axial hex coordinates (q, r). Cube s = -q - r. */
export type AxialCoord = { q: number; r: number };

const SQRT3 = Math.sqrt(3);

/** Hex circumradius from the calibrated cell width (percent-of-map-width → px). */
export function hexSizeFromCellPx(cellPx: number, orientation: HexOrientation): number {
  // cellPx is the hex width (flat-to-flat for pointy-top, vertex-to-vertex for flat-top).
  return orientation === 'pointy' ? cellPx / SQRT3 : cellPx / 2;
}

/** Row height in layer pixels for tiling overlays. */
export function hexRowHeightPx(cellPx: number, orientation: HexOrientation): number {
  const size = hexSizeFromCellPx(cellPx, orientation);
  return orientation === 'pointy' ? 1.5 * size : SQRT3 * size;
}

/** Rotate a point by -θ into the unrotated grid frame. */
function toGridFrame(
  px: { x: number; y: number },
  cal: GridCalibrationPx,
): { x: number; y: number } {
  const dx = px.x - cal.originXpx;
  const dy = px.y - cal.originYpx;
  const cos = Math.cos(cal.rotationRad);
  const sin = Math.sin(cal.rotationRad);
  return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos };
}

/** Rotate a grid-frame point by +θ back to layer pixels. */
export function fromGridFrame(
  gx: { x: number; y: number },
  cal: GridCalibrationPx,
): { x: number; y: number } {
  const cos = Math.cos(cal.rotationRad);
  const sin = Math.sin(cal.rotationRad);
  return {
    x: gx.x * cos - gx.y * sin + cal.originXpx,
    y: gx.x * sin + gx.y * cos + cal.originYpx,
  };
}

/** Fractional axial coords from a grid-frame pixel point. */
export function layerPxToAxialFrac(
  gx: { x: number; y: number },
  cellPx: number,
  orientation: HexOrientation,
): AxialCoord {
  const size = hexSizeFromCellPx(cellPx, orientation);
  if (!(size > 0)) return { q: 0, r: 0 };
  if (orientation === 'pointy') {
    return {
      q: (SQRT3 / 3) * (gx.x / size) - (1 / 3) * (gx.y / size),
      r: (2 / 3) * (gx.y / size),
    };
  }
  return {
    q: (2 / 3) * (gx.x / size),
    r: (-1 / 3) * (gx.x / size) + (SQRT3 / 3) * (gx.y / size),
  };
}

/** Hex centre in grid-frame pixels from axial coords. */
export function axialToLayerPxFrac(
  axial: AxialCoord,
  cellPx: number,
  orientation: HexOrientation,
): { x: number; y: number } {
  const size = hexSizeFromCellPx(cellPx, orientation);
  const { q, r } = axial;
  if (orientation === 'pointy') {
    return { x: size * (SQRT3 * q + (SQRT3 / 2) * r), y: size * ((3 / 2) * r) };
  }
  return { x: size * ((3 / 2) * q), y: size * ((SQRT3 / 2) * q + SQRT3 * r) };
}

/** Cube-round fractional axial coords to the nearest hex. */
export function axialRound(frac: AxialCoord): AxialCoord {
  const s = -frac.q - frac.r;
  let rq = Math.round(frac.q);
  let rr = Math.round(frac.r);
  const rs = Math.round(s);
  const dq = Math.abs(rq - frac.q);
  const dr = Math.abs(rr - frac.r);
  const ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  return { q: rq, r: rr };
}

/** Snap a layer-pixel point to the nearest hex centre. */
export function snapLayerPxToHex(
  px: { x: number; y: number },
  cal: GridCalibrationPx,
  orientation: HexOrientation,
): { x: number; y: number } {
  const cellPx = cal.cellWpx;
  if (!(cellPx > 0)) return px;
  const grid = toGridFrame(px, cal);
  const axial = axialRound(layerPxToAxialFrac(grid, cellPx, orientation));
  return fromGridFrame(axialToLayerPxFrac(axial, cellPx, orientation), cal);
}

/** Snap a map-percent point to the nearest hex centre when snap is on. */
export function snapMapPercentToHex(
  pt: MapPercent,
  cal: GridCalibration | null,
  mapRect: Rect,
  orientation: HexOrientation,
  snap: boolean,
): MapPercent {
  if (!snap || !cal || !(mapRect.width > 0) || !(mapRect.height > 0)) {
    return { x: clampPercent(pt.x), y: clampPercent(pt.y) };
  }
  const calPx = calibrationToPx(cal, mapRect.width);
  const px = mapPercentToLayerPx(pt, mapRect);
  const snapped = snapLayerPxToHex(px, calPx, orientation);
  return layerPxToMapPercent(snapped, mapRect);
}

/** Cube/axial distance between two hex cells (integer steps). */
export function hexDistance(a: AxialCoord, b: AxialCoord): number {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  const ds = -dq - dr;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(ds)) / 2;
}

/** Map two map-percent points to axial coords via the calibrated hex grid. */
export function mapPercentToAxial(
  pt: MapPercent,
  cal: GridCalibration,
  mapRect: Rect,
  orientation: HexOrientation,
): AxialCoord {
  const calPx = calibrationToPx(cal, mapRect.width);
  const px = mapPercentToLayerPx(pt, mapRect);
  const grid = toGridFrame(px, calPx);
  return axialRound(layerPxToAxialFrac(grid, calPx.cellWpx, orientation));
}

/**
 * Distance between two map-percent points in grid cells, honouring the adapter's
 * distance rule for the active grid type.
 */
export function mapPercentGridDistance(
  a: MapPercent,
  b: MapPercent,
  mapRect: Rect,
  cellPx: number,
  gridType: 'square' | 'hex',
  cal: GridCalibration | null,
  orientation: HexOrientation,
  rule: GridDistanceRule,
): number {
  if (!(cellPx > 0) || !(mapRect.width > 0) || !(mapRect.height > 0)) return 0;

  if (gridType === 'hex' && cal && rule.hex === 'hex') {
    const aq = mapPercentToAxial(a, cal, mapRect, orientation);
    const bq = mapPercentToAxial(b, cal, mapRect, orientation);
    return hexDistance(aq, bq);
  }

  const dpxX = ((b.x - a.x) / 100) * mapRect.width;
  const dpxY = ((b.y - a.y) / 100) * mapRect.height;
  const euclidean = Math.hypot(dpxX, dpxY) / cellPx;

  if (gridType === 'square' && rule.square === 'alternating-diagonal') {
    const dx = Math.abs(dpxX) / cellPx;
    const dy = Math.abs(dpxY) / cellPx;
    const orth = Math.abs(dx - dy);
    const diag = Math.min(dx, dy);
    return orth + diag + Math.floor(diag / 2);
  }

  return euclidean;
}

/** Label for ruler readout ("sq" / "hex"). */
export function gridCellLabel(gridType: 'square' | 'hex'): string {
  return gridType === 'hex' ? 'hex' : 'sq';
}

/** Plural label for screen-reader announcements. */
export function gridCellLabelPlural(gridType: 'square' | 'hex'): string {
  return gridType === 'hex' ? 'hexes' : 'squares';
}

/** Hex radius (in hex steps) occupied by a token size. */
export function tokenHexRadius(size: TokenSize): number {
  switch (size) {
    case 'tiny':
    case 'small':
    case 'medium':
      return 0;
    case 'large':
      return 1;
    case 'huge':
      return 2;
    case 'gargantuan':
      return 3;
    default:
      return 0;
  }
}

/** All axial hex cells within `radius` steps of `center`. */
export function hexesInRadius(center: AxialCoord, radius: number): AxialCoord[] {
  const out: AxialCoord[] = [];
  for (let dq = -radius; dq <= radius; dq++) {
    for (let dr = Math.max(-radius, -dq - radius); dr <= Math.min(radius, -dq + radius); dr++) {
      out.push({ q: center.q + dq, r: center.r + dr });
    }
  }
  return out;
}

/** Token footprint hex cells for a placed token. */
export function tokenFootprintHexes(
  center: MapPercent,
  tokenSize: TokenSize,
  cal: GridCalibration,
  mapRect: Rect,
  orientation: HexOrientation,
): AxialCoord[] {
  const axial = mapPercentToAxial(center, cal, mapRect, orientation);
  return hexesInRadius(axial, tokenHexRadius(tokenSize));
}

/** Rendered token diameter in layer pixels for hex footprints. */
export function tokenFootprintDiameterPx(
  tokenSize: TokenSize,
  cellPx: number,
  orientation: HexOrientation,
): number {
  const radius = tokenHexRadius(tokenSize);
  if (radius === 0) return Math.max(18, cellPx * 0.85);
  const size = hexSizeFromCellPx(cellPx, orientation);
  // Span across opposite flat edges for the occupied hex cluster.
  const span = radius * 2 + 1;
  return Math.max(18, orientation === 'pointy' ? span * SQRT3 * size : span * 2 * size);
}

/** Six vertices of one hex polygon in grid-frame pixels (for SVG overlay). */
export function hexVerticesGridFrac(
  axial: AxialCoord,
  cellPx: number,
  orientation: HexOrientation,
): Array<[number, number]> {
  const center = axialToLayerPxFrac(axial, cellPx, orientation);
  const size = hexSizeFromCellPx(cellPx, orientation);
  const verts: Array<[number, number]> = [];
  const startAngle = orientation === 'pointy' ? -Math.PI / 2 : 0;
  for (let i = 0; i < 6; i++) {
    const angle = startAngle + (Math.PI / 3) * i;
    verts.push([center.x + size * Math.cos(angle), center.y + size * Math.sin(angle)]);
  }
  return verts;
}

/**
 * Hex overlay polygons as SVG `points` strings in map-layer pixel space.
 * Honours calibration origin + rotation (issue #467).
 */
export function hexPolygons(
  surfaceW: number,
  surfaceH: number,
  cal: GridCalibrationPx,
  orientation: HexOrientation,
): string[] {
  const cellPx = cal.cellWpx;
  if (cellPx <= 2 || surfaceW <= 0 || surfaceH <= 0) return [];

  const corners = [
    { x: 0, y: 0 },
    { x: surfaceW, y: 0 },
    { x: 0, y: surfaceH },
    { x: surfaceW, y: surfaceH },
  ].map((p) => {
    const grid = toGridFrame(p, cal);
    return axialRound(layerPxToAxialFrac(grid, cellPx, orientation));
  });
  const minQ = Math.min(...corners.map((c) => c.q)) - 1;
  const maxQ = Math.max(...corners.map((c) => c.q)) + 1;
  const minR = Math.min(...corners.map((c) => c.r)) - 1;
  const maxR = Math.max(...corners.map((c) => c.r)) + 1;
  if ((maxQ - minQ + 1) * (maxR - minR + 1) > 3000) return [];

  const out: string[] = [];
  for (let r = minR; r <= maxR; r++) {
    for (let q = minQ; q <= maxQ; q++) {
      const verts = hexVerticesGridFrac({ q, r }, cellPx, orientation);
      const layerVerts = verts.map(([gx, gy]) => fromGridFrame({ x: gx, y: gy }, cal));
      out.push(layerVerts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '));
    }
  }
  return out;
}

/** Snap fog-reveal rectangle corners to hex centres (hex grid mode). */
export function snapFogRectToHexGrid(
  rect: { x: number; y: number; w: number; h: number },
  cal: GridCalibration,
  mapRect: Rect,
  orientation: HexOrientation,
): { x: number; y: number; w: number; h: number } {
  const tl = snapMapPercentToHex({ x: rect.x, y: rect.y }, cal, mapRect, orientation, true);
  const br = snapMapPercentToHex(
    { x: rect.x + rect.w, y: rect.y + rect.h },
    cal,
    mapRect,
    orientation,
    true,
  );
  const x = Math.min(tl.x, br.x);
  const y = Math.min(tl.y, br.y);
  return { x, y, w: Math.abs(br.x - tl.x), h: Math.abs(br.y - tl.y) };
}

/** Keyboard nudge: one hex step in the arrow direction (layer pixels). */
export function hexKeyboardStepPx(
  key: string,
  cellPx: number,
  orientation: HexOrientation,
): { x: number; y: number } | null {
  const size = hexSizeFromCellPx(cellPx, orientation);
  if (!(size > 0)) return null;
  // Axial neighbour directions (pointy-top); flat-top uses the same axial deltas.
  const dirs: Record<string, AxialCoord> =
    orientation === 'pointy'
      ? {
          ArrowRight: { q: 1, r: 0 },
          ArrowLeft: { q: -1, r: 0 },
          ArrowUp: { q: 0, r: -1 },
          ArrowDown: { q: 0, r: 1 },
        }
      : {
          ArrowRight: { q: 1, r: 0 },
          ArrowLeft: { q: -1, r: 0 },
          ArrowUp: { q: 0, r: -1 },
          ArrowDown: { q: 0, r: 1 },
        };
  const dir = dirs[key];
  if (!dir) return null;
  const origin = axialToLayerPxFrac({ q: 0, r: 0 }, cellPx, orientation);
  const target = axialToLayerPxFrac(dir, cellPx, orientation);
  return { x: target.x - origin.x, y: target.y - origin.y };
}

/** SVG polygon `points` for each hex cell in a hex-radius circle AoE. */
export function hexAoeCirclePolygons(
  originLayerPx: { x: number; y: number },
  radiusCells: number,
  calPx: GridCalibrationPx,
  orientation: HexOrientation,
): string[] {
  const cellPx = calPx.cellWpx;
  if (!(cellPx > 0) || !(radiusCells > 0)) return [];
  const grid = toGridFrame(originLayerPx, calPx);
  const center = axialRound(layerPxToAxialFrac(grid, cellPx, orientation));
  return hexesInRadius(center, Math.ceil(radiusCells)).map((axial) => {
    const verts = hexVerticesGridFrac(axial, cellPx, orientation);
    const layerVerts = verts.map(([gx, gy]) => fromGridFrame({ x: gx, y: gy }, calPx));
    return layerVerts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  });
}
