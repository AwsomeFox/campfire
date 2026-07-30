import type { GridType } from '@campfire/schema';

/** Pointy-top vs flat-top hex overlay (issue #238 / #477). */
export type HexOrientation = 'pointy' | 'flat';

export type RulerReadoutInput = {
  cells: number;
  scale: number;
  gridUnit: string;
  gridType: GridType;
  /** Reserved for future hex geometry; labels are the same for both orientations today. */
  hexOrientation?: HexOrientation;
};

export type RulerReadoutStyle = 'display' | 'announce';

/** Abbreviated grid-cell unit for on-map ruler labels (e.g. "sq", "hex"). */
export function gridCellUnitAbbrev(gridType: GridType): string {
  return gridType === 'hex' ? 'hex' : 'sq';
}

/** Spoken / announced grid-cell unit (e.g. "squares", "hexes"). */
export function gridCellUnitPlural(gridType: GridType): string {
  return gridType === 'hex' ? 'hexes' : 'squares';
}

/** Real-world distance from fractional cell count and per-cell scale. */
export function rulerDistanceFeet(cells: number, scale: number): number {
  // Round to two decimals so fractional scales (e.g. 0.5 m/cell) are preserved
  // while whole-number scales still produce an integer in the readout.
  return Math.round(cells * scale * 100) / 100;
}

/**
 * Format a ruler readout using adapter-configured scale + unit (gridScale/gridUnit).
 * Display style uses abbreviated cell units; announce style uses plural words for SR.
 */
export function formatRulerReadout(
  input: RulerReadoutInput,
  style: RulerReadoutStyle = 'display',
): string {
  const { cells, scale, gridUnit, gridType } = input;
  const feet = rulerDistanceFeet(cells, scale);
  const cellUnit = style === 'announce' ? gridCellUnitPlural(gridType) : gridCellUnitAbbrev(gridType);
  return `${cells.toFixed(1)} ${cellUnit} · ${feet} ${gridUnit}`;
}

/** Tooltip / help copy for the measure tool. */
export function measureToolHelp(gridType: GridType): string {
  return `Click-drag to measure distance in ${gridCellUnitPlural(gridType)}`;
}
