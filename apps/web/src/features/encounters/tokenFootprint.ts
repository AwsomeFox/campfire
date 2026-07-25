/**
 * Battle-map token footprint sizing (issue #468).
 *
 * Token diameters derive from calibrated grid cell size × creature footprint
 * (Medium = 1 cell, Large = 2 cells, etc.), not fixed CSS pixels. Tokens live
 * inside the viewport transform layer, so sizes track zoom and grid calibration.
 */

import type { GridType, TokenSize } from '@campfire/schema';

/** Default grid cell width (% of map width) when the grid is off — matches the DM UI default. */
export const DEFAULT_FALLBACK_GRID_SIZE_PCT = 8;

/**
 * Creature footprint in grid cells (D&D 5e space). Medium occupies 1×1; Large 2×2;
 * Huge 3×3; Gargantuan 4×4. Tiny/Small render smaller within a single cell.
 */
export const TOKEN_FOOTPRINT_CELLS: Record<TokenSize, number> = {
  tiny: 0.5,
  small: 0.75,
  medium: 1,
  large: 2,
  huge: 3,
  gargantuan: 4,
};

/** Minimum rendered diameter so tiny tokens stay tappable (issue #40). */
export const MIN_TOKEN_DIAMETER_PX = 18;

export function tokenFootprintCells(tokenSize: TokenSize): number {
  return TOKEN_FOOTPRINT_CELLS[tokenSize] ?? 1;
}

export type TokenDiameterInput = {
  tokenSize: TokenSize;
  /** Calibrated cell width in layer pixels (0 when grid is off). */
  cellPx: number;
  /** Map layer width — used to infer a cell when `cellPx` is 0. */
  mapWidthPx?: number;
  gridType?: GridType;
};

/**
 * Rendered token diameter in layer pixels. Square and hex grids both use the
 * calibrated cell width as the unit; hex treats `cellPx` as the hex width.
 */
export function tokenDiameterPx(input: TokenDiameterInput): number {
  const cells = tokenFootprintCells(input.tokenSize);
  let cellPx = input.cellPx;
  if (!(cellPx > 0) && input.mapWidthPx != null && input.mapWidthPx > 0) {
    cellPx = (DEFAULT_FALLBACK_GRID_SIZE_PCT / 100) * input.mapWidthPx;
  }
  if (!(cellPx > 0)) return MIN_TOKEN_DIAMETER_PX;
  // Hex and square share the same cell-width unit; gridType is accepted for callers
  // that may specialize later.
  void input.gridType;
  return Math.max(MIN_TOKEN_DIAMETER_PX, Math.round(cellPx * cells));
}
