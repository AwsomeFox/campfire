/**
 * Battle-map rendered bounds (issue #464).
 *
 * The VTT surface is a fixed 16:9 box while the map image uses object-contain,
 * so non-16:9 maps letterbox. All grid / snap / ruler / fog / token / AoE math
 * must use the contained image rect — never the full surface — and letterbox
 * bands must reject new interactions.
 */

import { DEFAULT_MAP_OBJECT_SIZE } from '@campfire/schema';

export type Size = { w: number; h: number };

export type Rect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

/** Map-normalized point: percentages of the rendered map image (0–100). */
export type MapPercent = { x: number; y: number };

export type ClientRectLike = {
  left: number;
  top: number;
  width: number;
  height: number;
};

const EPS = 1e-6;

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

/**
 * object-contain letterboxed rect of an intrinsic image inside a surface.
 * When intrinsic size is unknown, falls back to the full surface (no clip).
 */
export function computeContainedRect(surface: Size, intrinsic: Size | null | undefined): Rect | null {
  if (!(surface.w > 0) || !(surface.h > 0)) return null;
  if (!intrinsic || !(intrinsic.w > 0) || !(intrinsic.h > 0)) {
    return { left: 0, top: 0, width: surface.w, height: surface.h };
  }
  const scale = Math.min(surface.w / intrinsic.w, surface.h / intrinsic.h);
  const width = intrinsic.w * scale;
  const height = intrinsic.h * scale;
  return {
    left: (surface.w - width) / 2,
    top: (surface.h - height) / 2,
    width,
    height,
  };
}

/** One grid cell edge in rendered pixels — `% of map width`, not surface width. */
export function cellSizePx(gridSizePct: number | null | undefined, mapWidthPx: number): number {
  if (gridSizePct == null || !(gridSizePct > 0) || !(mapWidthPx > 0)) return 0;
  return (gridSizePct / 100) * mapWidthPx;
}

/** True when a surface-local pixel lies inside the rendered map (not letterbox). */
export function isInsideMapRect(localX: number, localY: number, mapRect: Rect): boolean {
  return (
    localX >= mapRect.left - EPS &&
    localY >= mapRect.top - EPS &&
    localX <= mapRect.left + mapRect.width + EPS &&
    localY <= mapRect.top + mapRect.height + EPS
  );
}

/**
 * Convert a pointer event into map-image percentages.
 * Returns null when the pointer is in a letterbox band (or the surface is empty).
 * Pass `clamp: true` to keep an in-progress drag pinned to the map edge.
 */
export function pointerToMapPercent(
  clientX: number,
  clientY: number,
  surfaceRect: ClientRectLike,
  mapRect: Rect,
  opts?: { clamp?: boolean },
): MapPercent | null {
  if (!(surfaceRect.width > 0) || !(surfaceRect.height > 0)) return null;
  if (!(mapRect.width > 0) || !(mapRect.height > 0)) return null;

  const localX = clientX - surfaceRect.left;
  const localY = clientY - surfaceRect.top;

  if (!opts?.clamp && !isInsideMapRect(localX, localY, mapRect)) return null;

  const xInMap = localX - mapRect.left;
  const yInMap = localY - mapRect.top;
  const x = (xInMap / mapRect.width) * 100;
  const y = (yInMap / mapRect.height) * 100;
  return { x: clampPercent(x), y: clampPercent(y) };
}

/** Snap a map-percent point to the nearest cell centre when snap is on. */
export function snapMapPercent(
  pt: MapPercent,
  cellPx: number,
  mapRect: Rect,
  snap: boolean,
): MapPercent {
  if (!snap || !(cellPx > 0) || !(mapRect.width > 0) || !(mapRect.height > 0)) {
    return { x: clampPercent(pt.x), y: clampPercent(pt.y) };
  }
  const px = (pt.x / 100) * mapRect.width;
  const py = (pt.y / 100) * mapRect.height;
  const sx = (Math.floor(px / cellPx) + 0.5) * cellPx;
  const sy = (Math.floor(py / cellPx) + 0.5) * cellPx;
  return {
    x: clampPercent((sx / mapRect.width) * 100),
    y: clampPercent((sy / mapRect.height) * 100),
  };
}

/** Pixel distance (in map space) between two map-percent points, in cells. */
export function mapPercentDistanceCells(
  a: MapPercent,
  b: MapPercent,
  mapRect: Rect,
  cellPx: number,
): number {
  if (!(cellPx > 0) || !(mapRect.width > 0) || !(mapRect.height > 0)) return 0;
  const dpxX = ((b.x - a.x) / 100) * mapRect.width;
  const dpxY = ((b.y - a.y) / 100) * mapRect.height;
  return Math.hypot(dpxX, dpxY) / cellPx;
}

/** Map-percent → pixel offset inside the map layer (origin at mapRect top-left). */
export function mapPercentToLayerPx(pt: MapPercent, mapRect: Rect): { x: number; y: number } {
  return {
    x: (pt.x / 100) * mapRect.width,
    y: (pt.y / 100) * mapRect.height,
  };
}

/** Layer pixel offset → map-percent (inverse of mapPercentToLayerPx). */
export function layerPxToMapPercent(px: { x: number; y: number }, mapRect: Rect): MapPercent {
  if (!(mapRect.width > 0) || !(mapRect.height > 0)) return { x: 0, y: 0 };
  return {
    x: clampPercent((px.x / mapRect.width) * 100),
    y: clampPercent((px.y / mapRect.height) * 100),
  };
}

// ---------------------------------------------------------------------------
// Grid calibration (issue #417)
//
// A single shared transform for aligning the overlay to a map's OWN printed grid.
// Every consumer — the overlay lines, token snapping, and the measurement ruler —
// reads the grid geometry through THIS module, and every viewport (the DM cockpit
// and each player's read of the same encounter) renders it identically because the
// calibration is server-persisted encounter state, not per-surface UI.
//
// All calibration values are expressed in ONE isotropic unit: percent of the rendered
// map WIDTH. That keeps a printed square grid square in pixels (a rotation is a true
// rotation, not a shear) and matches the historical `gridSize` unit exactly, so the
// pre-#417 defaults (origin 0,0; square cells; no rotation) reproduce the old overlay.
// ---------------------------------------------------------------------------

/** Historical hardcoded overlay-line alpha; the default when an encounter has no explicit opacity. */
export const DEFAULT_GRID_OPACITY = 0.35;

/** Resolved, normalized calibration in percent-of-map-width units. */
export type GridCalibration = {
  /** Cell width (percent of map width). */
  cellW: number;
  /** Cell height (percent of map width); equals cellW for a square grid. */
  cellH: number;
  /** Grid origin X offset from the map's top-left (percent of map width). */
  offsetX: number;
  /** Grid origin Y offset from the map's top-left (percent of map width). */
  offsetY: number;
  /** Overlay rotation in degrees. */
  rotationDeg: number;
  /** Overlay line opacity, 0–1. */
  opacity: number;
};

/** Raw encounter grid fields consumed by the calibration resolver (loose so callers can pass an Encounter). */
export type GridCalibrationInput = {
  gridSize?: number | null;
  gridCellHeight?: number | null;
  gridOffsetX?: number | null;
  gridOffsetY?: number | null;
  gridRotation?: number | null;
  gridOpacity?: number | null;
};

/**
 * Resolve an encounter's grid fields into a normalized calibration, or null when the
 * grid is off (no positive `gridSize`). A null/absent `gridCellHeight` means square
 * cells; a null/absent offset/rotation is the classic top-left, unrotated grid; a
 * null/absent opacity falls back to {@link DEFAULT_GRID_OPACITY}.
 */
export function resolveGridCalibration(input: GridCalibrationInput): GridCalibration | null {
  const cellW = input.gridSize;
  if (cellW == null || !(cellW > 0)) return null;
  const cellH = input.gridCellHeight != null && input.gridCellHeight > 0 ? input.gridCellHeight : cellW;
  const opacity = input.gridOpacity == null ? DEFAULT_GRID_OPACITY : Math.max(0, Math.min(1, input.gridOpacity));
  return {
    cellW,
    cellH,
    offsetX: input.gridOffsetX ?? 0,
    offsetY: input.gridOffsetY ?? 0,
    rotationDeg: input.gridRotation ?? 0,
    opacity,
  };
}

/** Calibration expressed in rendered-layer pixels, ready for drawing / snapping. */
export type GridCalibrationPx = {
  cellWpx: number;
  cellHpx: number;
  originXpx: number;
  originYpx: number;
  rotationDeg: number;
  rotationRad: number;
  opacity: number;
};

/** Project a calibration into layer pixels using the map WIDTH (isotropic). */
export function calibrationToPx(cal: GridCalibration, mapWidthPx: number): GridCalibrationPx {
  const scale = mapWidthPx / 100;
  return {
    cellWpx: cal.cellW * scale,
    cellHpx: cal.cellH * scale,
    originXpx: cal.offsetX * scale,
    originYpx: cal.offsetY * scale,
    rotationDeg: cal.rotationDeg,
    rotationRad: (cal.rotationDeg * Math.PI) / 180,
    opacity: cal.opacity,
  };
}

/**
 * Snap a layer-pixel point to the nearest calibrated cell centre. Handles the grid's
 * origin offset, independent cell width/height, and rotation by transforming the point
 * into the (unrotated, origin-relative) grid frame, snapping to a half-cell there, then
 * transforming back. Returns the point unchanged when the cell size is degenerate.
 */
export function snapLayerPxToGrid(px: { x: number; y: number }, cal: GridCalibrationPx): { x: number; y: number } {
  if (!(cal.cellWpx > 0) || !(cal.cellHpx > 0)) return px;
  const cos = Math.cos(cal.rotationRad);
  const sin = Math.sin(cal.rotationRad);
  const dx = px.x - cal.originXpx;
  const dy = px.y - cal.originYpx;
  // Rotate by -θ into the grid frame.
  const gx = dx * cos + dy * sin;
  const gy = -dx * sin + dy * cos;
  const cx = (Math.floor(gx / cal.cellWpx) + 0.5) * cal.cellWpx;
  const cy = (Math.floor(gy / cal.cellHpx) + 0.5) * cal.cellHpx;
  // Rotate back by +θ and re-anchor at the origin.
  return {
    x: cx * cos - cy * sin + cal.originXpx,
    y: cx * sin + cy * cos + cal.originYpx,
  };
}

/**
 * Snap a map-percent point to the calibrated grid (issue #417). When `snap` is off, or
 * the grid is degenerate, the point is returned clamped but unsnapped. Supersedes the
 * origin-locked {@link snapMapPercent} for calibrated grids.
 */
export function snapMapPercentCalibrated(
  pt: MapPercent,
  cal: GridCalibration | null,
  mapRect: Rect,
  snap: boolean,
): MapPercent {
  if (!snap || !cal || !(mapRect.width > 0) || !(mapRect.height > 0)) {
    return { x: clampPercent(pt.x), y: clampPercent(pt.y) };
  }
  const calPx = calibrationToPx(cal, mapRect.width);
  const px = mapPercentToLayerPx(pt, mapRect);
  const snapped = snapLayerPxToGrid(px, calPx);
  return layerPxToMapPercent(snapped, mapRect);
}

/**
 * Compute a map object's `size` (diameter, percent of the rendered map WIDTH — issue #2175) from
 * a resize-grip drag: twice the pointer's distance from the object's fixed centre, in the same
 * isotropic layer-px space the grid uses. Clamped to the schema's [1, 100] bounds and rounded to
 * one decimal so the live preview and the committed PATCH read identically. Returns the schema
 * default (`DEFAULT_MAP_OBJECT_SIZE`) when the map rect is degenerate rather than a NaN.
 */
export function mapObjectSizeFromDrag(center: MapPercent, pointer: MapPercent, mapRect: Rect | null): number {
  if (!mapRect || !(mapRect.width > 0)) return DEFAULT_MAP_OBJECT_SIZE;
  const c = mapPercentToLayerPx(center, mapRect);
  const p = mapPercentToLayerPx(pointer, mapRect);
  const radiusPx = Math.hypot(p.x - c.x, p.y - c.y);
  const sizePercent = ((2 * radiusPx) / mapRect.width) * 100;
  if (!Number.isFinite(sizePercent)) return DEFAULT_MAP_OBJECT_SIZE;
  return Math.max(1, Math.min(100, Math.round(sizePercent * 10) / 10));
}
