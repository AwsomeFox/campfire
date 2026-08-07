import { memo } from 'react';
import type { GridType } from '@campfire/schema';
import { DEFAULT_GRID_OPACITY, type Rect } from '../mapRenderedBounds';
import type { GridCalibrationPx } from '../mapRenderedBounds';
import type { HexOrientation } from '../hexGeometry';

export type GridOverlayProps = {
  /** Whether the grid is enabled at all (issue #40) — no output when off. */
  gridOn: boolean;
  gridType: GridType;
  /** The object-contain map layer rect in surface px; no output while the map hasn't loaded. */
  mapRect: Rect | null;
  /** Calibrated cell geometry in layer px, or null before a grid has been calibrated. */
  calibrationPx: GridCalibrationPx | null;
  hexOrientation: HexOrientation;
  /** Pre-computed hex polygon point-strings (issue #238's existing `hexCells` useMemo in
   *  BattleMap) — kept as a prop rather than recomputed here so the expensive geometry math
   *  stays memoized exactly as before; this component only re-renders the SVG from it. */
  hexCells: readonly string[];
  opacity: number;
  /** Stable per-encounter id for the SVG `<pattern>` — must not change across renders for the
   *  same encounter, or the `url(#grid-...)` fill would break during a re-render. */
  encounterId: number;
};

/**
 * Grid overlay (issue #40 / #238 / #417 / #1917 stage 2) — a calibrated square grid (origin
 * offset, independent cell w/h, rotation, opacity via an SVG pattern) or a pointy/flat-top hex
 * SVG. Extracted out of `BattleMap` and memoized on geometry inputs ONLY (issue #1917): every
 * other piece of `BattleMap`'s render — tokens, AoE, fog, drag state — must be free to change
 * without re-rendering the (potentially thousand-plus-polygon) hex grid or recreating the square
 * grid's `<pattern>`. Callers must pass primitive/derived values here, never the raw `encounter`
 * object or anything else whose identity churns for reasons unrelated to grid geometry.
 */
// `hexOrientation` is intentionally part of `GridOverlayProps` (issue #1917's spec: gridType,
// mapRect, calibrationPx, hexOrientation, opacity) even though it is not read directly below —
// `hexCells` is already derived from it (BattleMap's existing `hexCells` useMemo), so including
// it here keeps the memo comparator honest about every geometry input this overlay depends on,
// without this component recomputing the hex point-string math a second time.
export const GridOverlay = memo(function GridOverlay({
  gridOn,
  gridType,
  mapRect,
  calibrationPx,
  hexCells,
  opacity,
  encounterId,
}: GridOverlayProps) {
  if (!mapRect) return null;

  if (gridType === 'square') {
    if (!gridOn || !calibrationPx || calibrationPx.cellWpx <= 1 || calibrationPx.cellHpx <= 1) return null;
    return (
      <svg
        data-testid="battle-map-grid"
        className="absolute inset-0"
        width={mapRect.width}
        height={mapRect.height}
        style={{ opacity }}
      >
        <defs>
          <pattern
            id={`grid-${encounterId}`}
            patternUnits="userSpaceOnUse"
            width={calibrationPx.cellWpx}
            height={calibrationPx.cellHpx}
            patternTransform={`translate(${calibrationPx.originXpx} ${calibrationPx.originYpx}) rotate(${calibrationPx.rotationDeg})`}
          >
            <path
              d={`M ${calibrationPx.cellWpx} 0 L 0 0 0 ${calibrationPx.cellHpx}`}
              fill="none"
              stroke="rgb(148,163,184)"
              strokeWidth={1}
            />
          </pattern>
        </defs>
        <rect width={mapRect.width} height={mapRect.height} fill={`url(#grid-${encounterId})`} />
      </svg>
    );
  }

  if (!gridOn || hexCells.length === 0) return null;
  return (
    <svg
      data-testid="battle-map-grid-hex"
      className="absolute inset-0"
      width={mapRect.width}
      height={mapRect.height}
      style={{ opacity }}
    >
      {hexCells.map((pts, i) => (
        <polygon key={i} points={pts} fill="none" stroke="rgb(148,163,184)" strokeWidth={1} />
      ))}
    </svg>
  );
});

export { DEFAULT_GRID_OPACITY };
