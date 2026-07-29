import { snapMapPercentCalibrated, type GridCalibration, type Rect } from './mapRenderedBounds';

/**
 * Pure planning helpers for battle-map multi-selection and placement.  Coordinates
 * are percentages so a plan remains valid while the rendered image letterboxes.
 */
export type BatchPoint = { x: number; y: number };
export type BatchToken = {
  id: number;
  name: string;
  kind: 'character' | 'monster' | 'npc' | string;
  tokenX: number | null;
  tokenY: number | null;
  tokenSize?: string;
  initiativeGroup?: string | null;
  tokenHiddenByFog?: boolean;
};
export type FormationKind = 'line' | 'cluster' | 'sides' | 'saved';

/** Convert percentage coordinates to an isotropic planning plane. `aspect` is
 * rendered height / width, so equal distances remain equal on rectangular maps. */
export const isotropicPoint = (point: BatchPoint, aspect = 1): BatchPoint => ({ x: point.x, y: point.y * aspect });

const SIZE_CELLS: Record<string, number> = { tiny: .5, small: 1, medium: 1, large: 2, huge: 3, gargantuan: 4 };
const clamp = (n: number) => Math.max(0, Math.min(100, n));
export const tokenRadiusPercent = (token: Pick<BatchToken, 'tokenSize'>, cell = 5) => (SIZE_CELLS[token.tokenSize ?? 'medium'] ?? 1) * cell / 2;
// A partial coordinate is not renderable and belongs in the tray; treating it as
// unplaced also lets the batch repair an interrupted one-axis token PATCH.
export const isTrulyUnplaced = (token: BatchToken) => (token.tokenX == null || token.tokenY == null) && !token.tokenHiddenByFog;

export function toggleTokenSelection(selected: ReadonlySet<number>, id: number, additive: boolean): Set<number> {
  if (!additive) return new Set([id]);
  const next = new Set(selected);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}

export function selectBy(tokens: readonly BatchToken[], predicate: (token: BatchToken) => boolean): Set<number> {
  return new Set(tokens.filter(predicate).map((token) => token.id));
}

export function tokensInRectangle(tokens: readonly BatchToken[], a: BatchPoint, b: BatchPoint): Set<number> {
  const left = Math.min(a.x, b.x), right = Math.max(a.x, b.x), top = Math.min(a.y, b.y), bottom = Math.max(a.y, b.y);
  return selectBy(tokens, t => t.tokenX != null && t.tokenY != null && t.tokenX >= left && t.tokenX <= right && t.tokenY >= top && t.tokenY <= bottom);
}

/** Standard ray-cast; a boundary point is deliberately included for touch usability. */
export function tokensInLasso(tokens: readonly BatchToken[], polygon: readonly BatchPoint[]): Set<number> {
  if (polygon.length < 3) return new Set();
  const inside = (p: BatchPoint) => {
    let hit = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const a = polygon[i], b = polygon[j];
      if (((a.y > p.y) !== (b.y > p.y)) && p.x <= ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
    }
    return hit;
  };
  return selectBy(tokens, t => t.tokenX != null && t.tokenY != null && inside({ x: t.tokenX, y: t.tokenY }));
}

export function snapBatchPoint(point: BatchPoint, cell = 5, aspect = 1, calibration?: GridCalibration | null, mapRect?: Rect | null): BatchPoint {
  if (calibration && mapRect && mapRect.width > 0 && mapRect.height > 0) {
    return snapMapPercentCalibrated(point, calibration, mapRect, true);
  }
  return { x: clamp(Math.round(point.x / cell) * cell), y: clamp(Math.round(point.y / (cell / aspect)) * (cell / aspect)) };
}

function overlaps(a: BatchPoint, ar: number, b: BatchPoint, br: number, aspect = 1) {
  const ai = isotropicPoint(a, aspect), bi = isotropicPoint(b, aspect);
  return Math.hypot(ai.x - bi.x, ai.y - bi.y) < ar + br - .001;
}

/** Finds a deterministic nearest free grid position. Existing placed tokens are obstacles. */
export function planCollisionFreePlacement(tokens: readonly BatchToken[], anchor: BatchPoint, cell = 5, gridType: 'square' | 'hex' = 'square', aspect = 1, calibration?: GridCalibration | null, mapRect?: Rect | null): Array<{ id: number; x: number; y: number }> {
  const cellW = calibration?.cellW ?? cell;
  const cellH = calibration?.cellH ?? cell;
  const occupied = tokens.filter(t => t.tokenX != null && t.tokenY != null).map(t => ({ point: { x: t.tokenX!, y: t.tokenY! }, radius: tokenRadiusPercent(t, cellW) }));
  const plan: Array<{ id: number; x: number; y: number }> = [];
  for (const token of tokens.filter(isTrulyUnplaced)) {
    const radius = tokenRadiusPercent(token, cellW);
    let chosen: BatchPoint | undefined;
    for (let ring = 0; ring <= 40 && !chosen; ring++) for (let dx = -ring; dx <= ring && !chosen; dx++) for (let dy = -ring; dy <= ring && !chosen; dy++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
      const raw = gridType === 'hex'
        ? { x: anchor.x + dx * cellW + (Math.abs(dy) % 2 ? cellW / 2 : 0), y: anchor.y + dy * cellW * .8660254 / aspect }
        : { x: anchor.x + dx * cellW, y: anchor.y + dy * cellH / aspect };
      const point = gridType === 'hex'
        ? { x: clamp(Math.round(raw.x * 1000) / 1000), y: clamp(Math.round(raw.y * 1000) / 1000) }
        : snapBatchPoint(raw, cellW, aspect, calibration, mapRect);
      if (point.x - radius < 0 || point.x + radius > 100 || point.y - radius / aspect < 0 || point.y + radius / aspect > 100) continue;
      if (!occupied.some(o => overlaps(point, radius, o.point, o.radius, aspect))) chosen = point;
    }
    if (!chosen) throw new Error(`No collision-free map position for ${token.name}`);
    occupied.push({ point: chosen, radius }); plan.push({ id: token.id, ...chosen });
  }
  return plan;
}

export function formationOffsets(tokens: readonly BatchToken[], kind: FormationKind, spacingX = 5, spacingY = spacingX): BatchPoint[] {
  const cols = Math.max(1, Math.ceil(Math.sqrt(tokens.length)));
  return tokens.map((token, index) => {
    if (kind === 'line') return { x: index * spacingX, y: 0 };
    if (kind === 'sides') return { x: (token.kind === 'character' ? -1 : 1) * Math.ceil(index / 2) * spacingX, y: (index % 2) * spacingY };
    return { x: (index % cols) * spacingX, y: Math.floor(index / cols) * spacingY };
  });
}

/** Size-aware formation placement. Desired offsets keep the formation's character,
 * then the same deterministic free-cell search used by Place all prevents a large
 * footprint from overlapping a neighbour or clipping an edge. */
export function planFormationPlacement(tokens: readonly BatchToken[], selected: ReadonlySet<number>, kind: Exclude<FormationKind, 'saved'>, anchor: BatchPoint, cell = 5, gridType: 'square' | 'hex' = 'square', aspect = 1, calibration?: GridCalibration | null, mapRect?: Rect | null): Array<{ id: number; x: number; y: number }> {
  const cellW = calibration?.cellW ?? cell;
  const cellH = calibration?.cellH ?? cell;
  const members = tokens.filter(t => selected.has(t.id));
  const offsets = formationOffsets(members, kind, cellW, cellH);
  return resolveDesiredFormation(tokens, members.map((token, i) => ({ token, desired: { x: anchor.x + offsets[i].x, y: anchor.y + offsets[i].y / aspect } })), cell, gridType, aspect, calibration, mapRect);
}

/** Resolves saved formation slot offsets without ever clamping a centre independently:
 * each desired point is nudged to the nearest valid footprint-aware grid position. */
export function resolveDesiredFormation(tokens: readonly BatchToken[], desired: ReadonlyArray<{ token: BatchToken; desired: BatchPoint }>, cell = 5, gridType: 'square' | 'hex' = 'square', aspect = 1, calibration?: GridCalibration | null, mapRect?: Rect | null): Array<{ id: number; x: number; y: number }> {
  const cellW = calibration?.cellW ?? cell;
  const cellH = calibration?.cellH ?? cell;
  const selected = new Set(desired.map(item => item.token.id));
  const occupied = tokens.filter(t => !selected.has(t.id) && t.tokenX != null && t.tokenY != null).map(t => ({ point: { x: t.tokenX!, y: t.tokenY! }, radius: tokenRadiusPercent(t, cellW) }));
  const output: Array<{ id: number; x: number; y: number }> = [];
  for (const item of desired) {
    const token = item.token, radius = tokenRadiusPercent(token, cellW), desiredPoint = item.desired;
    let chosen: BatchPoint | undefined;
    for (let ring = 0; ring <= 40 && !chosen; ring++) for (let dx = -ring; dx <= ring && !chosen; dx++) for (let dy = -ring; dy <= ring && !chosen; dy++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
      const raw = gridType === 'hex' ? { x: desiredPoint.x + dx * cellW + (Math.abs(dy) % 2 ? cellW / 2 : 0), y: desiredPoint.y + dy * cellW * .8660254 / aspect } : { x: desiredPoint.x + dx * cellW, y: desiredPoint.y + dy * cellH / aspect };
      const point = gridType === 'hex' ? { x: Math.round(raw.x * 1000) / 1000, y: Math.round(raw.y * 1000) / 1000 } : snapBatchPoint(raw, cellW, aspect, calibration, mapRect);
      if (point.x - radius < 0 || point.x + radius > 100 || point.y - radius / aspect < 0 || point.y + radius / aspect > 100) continue;
      if (!occupied.some(o => overlaps(point, radius, o.point, o.radius, aspect))) chosen = point;
    }
    if (!chosen) throw new Error(`No collision-free formation position for ${token.name}`);
    occupied.push({ point: chosen, radius }); output.push({ id: token.id, ...chosen });
  }
  return output;
}

/** Preserve group offsets, translating once and clamping as a group (never collapse tokens). */
export function translateGroup(tokens: readonly BatchToken[], selected: ReadonlySet<number>, leadId: number, target: BatchPoint, cell = 5, aspect = 1): Array<{ id: number; x: number; y: number }> {
  const lead = tokens.find(t => t.id === leadId);
  if (!lead || lead.tokenX == null || lead.tokenY == null) return [];
  const group = tokens.filter(t => selected.has(t.id) && t.tokenX != null && t.tokenY != null);
  let dx = target.x - lead.tokenX, dy = target.y - lead.tokenY;
  const minX = Math.min(...group.map(t => t.tokenX! - tokenRadiusPercent(t, cell))), maxX = Math.max(...group.map(t => t.tokenX! + tokenRadiusPercent(t, cell)));
  const minY = Math.min(...group.map(t => t.tokenY! * aspect - tokenRadiusPercent(t, cell))), maxY = Math.max(...group.map(t => t.tokenY! * aspect + tokenRadiusPercent(t, cell)));
  dx = Math.max(-minX, Math.min(100 - maxX, dx)); dy = Math.max(-minY, Math.min(100 * aspect - maxY, dy * aspect)) / aspect;
  return group.map(t => ({ id: t.id, x: clamp(t.tokenX! + dx), y: clamp(t.tokenY! + dy) }));
}
