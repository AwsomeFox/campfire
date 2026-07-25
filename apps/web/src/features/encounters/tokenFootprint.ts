/**
 * Battle-map token footprint sizing (issue #468).
 *
 * Token diameters derive from calibrated grid cell size × creature footprint
 * (Medium = 1 cell, Large = 2 cells, etc.), not fixed CSS pixels. Tokens live
 * inside the viewport transform layer, so sizes track zoom and grid calibration.
 */

import type { GridType, TokenSize } from '@campfire/schema';

/**
 * Nominal cell width when the grid is off — preserves pre-#468 medium = 32px sizing.
 * Grid-on encounters always pass calibrated `cellPx` instead.
 */
export const GRID_OFF_FALLBACK_CELL_PX = 32;

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
  gridType?: GridType;
};

/**
 * Rendered token diameter in layer pixels. Square and hex grids both use the
 * calibrated cell width as the unit; hex treats `cellPx` as the hex width.
 * When the grid is off, falls back to {@link GRID_OFF_FALLBACK_CELL_PX}.
 */
export function tokenDiameterPx(input: TokenDiameterInput): number {
  const cells = tokenFootprintCells(input.tokenSize);
  const cellPx = input.cellPx > 0 ? input.cellPx : GRID_OFF_FALLBACK_CELL_PX;
  // Hex and square share the same cell-width unit; gridType is accepted for callers
  // that may specialize later.
  void input.gridType;
  return Math.max(MIN_TOKEN_DIAMETER_PX, cellPx * cells);
}
