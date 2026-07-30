import type { FogRect } from '@campfire/schema';
import {
  calibrationToPx,
  clampPercent,
  layerPxToMapPercent,
  mapPercentToLayerPx,
  type GridCalibration,
  type MapPercent,
  type Rect,
} from './mapRenderedBounds';

export type GridRevealResult = FogRect | { reason: string };

/**
 * Reveal one calibrated grid cell at a map-percent point (issue #472 — room/cell reveal
 * when a grid is configured). Returns an axis-aligned map-percent rect for unrotated grids;
 * for rotated grids returns the axis-aligned bounding box of the cell.
 *
 * Invalid or degenerate inputs surface a `reason` instead of returning a bare `null`, so
 * callers can explain why a shift-click reveal was a no-op.
 */
export function gridCellRevealRect(
  pt: MapPercent,
  cal: GridCalibration | null,
  mapRect: Rect,
): GridRevealResult {
  if (!(mapRect.width > 0) || !(mapRect.height > 0)) {
    return { reason: 'Map has zero rendered size' };
  }
  if (!cal) {
    return { reason: 'Grid calibration is missing' };
  }
  if (pt.x < 0 || pt.y < 0 || pt.x > 100 || pt.y > 100) {
    return { reason: 'Reveal point is outside the map' };
  }

  const calPx = calibrationToPx(cal, mapRect.width);
  if (!(calPx.cellWpx > 0) || !(calPx.cellHpx > 0)) {
    return { reason: 'Grid cell has zero rendered size' };
  }

  const px = mapPercentToLayerPx(pt, mapRect);
  const cos = Math.cos(calPx.rotationRad);
  const sin = Math.sin(calPx.rotationRad);
  const dx = px.x - calPx.originXpx;
  const dy = px.y - calPx.originYpx;
  const gx = dx * cos + dy * sin;
  const gy = -dx * sin + dy * cos;

  const col = Math.floor(gx / calPx.cellWpx);
  const row = Math.floor(gy / calPx.cellHpx);
  const gx0 = col * calPx.cellWpx;
  const gy0 = row * calPx.cellHpx;

  const corners = [
    { gx: gx0, gy: gy0 },
    { gx: gx0 + calPx.cellWpx, gy: gy0 },
    { gx: gx0 + calPx.cellWpx, gy: gy0 + calPx.cellHpx },
    { gx: gx0, gy: gy0 + calPx.cellHpx },
  ];

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of corners) {
    const lx = c.gx * cos - c.gy * sin + calPx.originXpx;
    const ly = c.gx * sin + c.gy * cos + calPx.originYpx;
    const pct = layerPxToMapPercent({ x: lx, y: ly }, mapRect);
    minX = Math.min(minX, pct.x);
    minY = Math.min(minY, pct.y);
    maxX = Math.max(maxX, pct.x);
    maxY = Math.max(maxY, pct.y);
  }

  const x = clampPercent(minX);
  const y = clampPercent(minY);
  const w = clampPercent(maxX) - x;
  const h = clampPercent(maxY) - y;
  if (w <= 0 || h <= 0) {
    return { reason: 'Revealed cell has zero size' };
  }
  return { x, y, w, h };
}
