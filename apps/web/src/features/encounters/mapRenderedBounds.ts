/**
 * Battle-map rendered bounds (issue #464).
 *
 * The VTT surface is a fixed 16:9 box while the map image uses object-contain,
 * so non-16:9 maps letterbox. All grid / snap / ruler / fog / token / AoE math
 * must use the contained image rect — never the full surface — and letterbox
 * bands must reject new interactions.
 */

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
