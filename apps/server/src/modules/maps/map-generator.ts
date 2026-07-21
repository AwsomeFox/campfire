import type { MapGridConfig, MapKind, MapSize, MapTheme } from '@campfire/schema';

/**
 * First-party procedural battle-map generator (issue #306).
 *
 * License-clean and AI-drivable: there is no bundle-able open battle-map dataset (#303 —
 * the "free" packs are NC/ND), so Campfire generates maps ITSELF. The output is a
 * grid-aligned, dependency-free SVG (crisp, tiny, no binary-asset bloat) that the VTT
 * renders as an encounter's battle-map background, plus the grid metadata so the #40 grid
 * overlay lines up exactly.
 *
 * Everything here is PURE + DETERMINISTIC: the same seed + params always produces
 * byte-identical SVG. No `Math.random()` — the RNG is an explicit seeded mulberry32 (the
 * caller supplies the seed; MapsService defaults it from crypto when omitted). This is
 * what makes generation reproducible and unit-testable.
 */

// One grid cell's edge length, in SVG user units. The image's pixel size is
// widthCells*CELL × heightCells*CELL; the VTT reads the grid off gridSize (percent of
// width) so the exact px size is immaterial beyond keeping the SVG crisp.
const CELL = 40;

/** Bounded cell dimensions per size (guardrail: caps the generated surface, #306). */
const SIZE_DIMS: Record<MapSize, { w: number; h: number }> = {
  small: { w: 20, h: 15 },
  medium: { w: 30, h: 22 },
  large: { w: 40, h: 30 },
};

interface Palette {
  bg: string; // wall / rock — the negative space
  floor: string; // walkable floor
  floorAlt: string; // subtle per-room shading
  wallLine: string; // floor↔wall edge stroke
  grid: string; // grid overlay lines
  feature: string; // terrain blobs / rubble
}

const THEMES: Record<MapTheme, Palette> = {
  stone: { bg: '#2b2b33', floor: '#c9c2b4', floorAlt: '#bcb4a4', wallLine: '#3a3a44', grid: '#00000022', feature: '#8a8172' },
  cavern: { bg: '#221c1a', floor: '#5c6b70', floorAlt: '#52605f', wallLine: '#171210', grid: '#00000030', feature: '#3f4a4c' },
  forest: { bg: '#243024', floor: '#7d8c5a', floorAlt: '#71804f', wallLine: '#1b241b', grid: '#00000022', feature: '#3f5a2f' },
  crypt: { bg: '#1c1b22', floor: '#8a8798', floorAlt: '#7d7a8b', wallLine: '#0f0e13', grid: '#00000033', feature: '#54506a' },
};

/** Default theme per map kind when the caller doesn't pick one. */
const DEFAULT_THEME: Record<MapKind, MapTheme> = {
  dungeon: 'stone',
  cave: 'cavern',
  wilderness: 'forest',
};

// ---------- deterministic RNG ----------

/** FNV-1a 32-bit hash of a string → a stable numeric seed for mulberry32. */
function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — a tiny, fast, well-distributed seeded PRNG. Deterministic per seed. */
function mulberry32(seedNum: number): () => number {
  let a = seedNum >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private next: () => number;
  constructor(seed: string) {
    this.next = mulberry32(hashSeed(seed));
  }
  /** Float in [0, 1). */
  float(): number {
    return this.next();
  }
  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

// ---------- grid model ----------

type Cell = 0 | 1 | 2; // 0 = wall/rock, 1 = floor, 2 = feature (blocking terrain on floor)

interface Grid {
  w: number;
  h: number;
  cells: Cell[]; // row-major, length w*h
}

interface Room {
  x: number;
  y: number;
  w: number;
  h: number;
}

function makeGrid(w: number, h: number, fill: Cell): Grid {
  return { w, h, cells: new Array<Cell>(w * h).fill(fill) };
}
function idx(g: Grid, x: number, y: number): number {
  return y * g.w + x;
}
function get(g: Grid, x: number, y: number): Cell {
  if (x < 0 || y < 0 || x >= g.w || y >= g.h) return 0;
  return g.cells[idx(g, x, y)];
}
function set(g: Grid, x: number, y: number, v: Cell): void {
  if (x < 0 || y < 0 || x >= g.w || y >= g.h) return;
  g.cells[idx(g, x, y)] = v;
}

// ---------- generators ----------

interface GenResult {
  grid: Grid;
  rooms: Room[];
}

/** Classic room-and-corridor dungeon (v1 primary). Non-overlapping rooms, L-corridors. */
function genDungeon(rng: Rng, w: number, h: number, complexity: number): GenResult {
  const g = makeGrid(w, h, 0);
  const rooms: Room[] = [];

  // Room budget scales with area and complexity. More complexity → more, smaller rooms.
  const area = w * h;
  const targetRooms = Math.max(3, Math.round((area / 90) * (0.6 + complexity * 0.9)));
  const attempts = targetRooms * 6;

  for (let i = 0; i < attempts && rooms.length < targetRooms; i++) {
    const rw = rng.int(3, Math.max(3, Math.min(8, Math.floor(w / 4))));
    const rh = rng.int(3, Math.max(3, Math.min(7, Math.floor(h / 4))));
    // Keep a 1-cell wall margin all around so rooms never touch the edge.
    const rx = rng.int(1, w - rw - 1);
    const ry = rng.int(1, h - rh - 1);
    const candidate: Room = { x: rx, y: ry, w: rw, h: rh };
    // Reject if it (or its 1-cell buffer) overlaps an existing room.
    const overlaps = rooms.some(
      (r) => rx <= r.x + r.w && rx + rw >= r.x - 1 && ry <= r.y + r.h && ry + rh >= r.y - 1,
    );
    if (overlaps) continue;
    rooms.push(candidate);
    for (let y = ry; y < ry + rh; y++) for (let x = rx; x < rx + rw; x++) set(g, x, y, 1);
  }

  // Connect rooms in placement order with L-shaped corridors between centres.
  const centre = (r: Room) => ({ cx: Math.floor(r.x + r.w / 2), cy: Math.floor(r.y + r.h / 2) });
  for (let i = 1; i < rooms.length; i++) {
    const a = centre(rooms[i - 1]);
    const b = centre(rooms[i]);
    const horizontalFirst = rng.chance(0.5);
    if (horizontalFirst) {
      carveH(g, a.cx, b.cx, a.cy);
      carveV(g, a.cy, b.cy, b.cx);
    } else {
      carveV(g, a.cy, b.cy, a.cx);
      carveH(g, a.cx, b.cx, b.cy);
    }
  }
  return { grid: g, rooms };
}

function carveH(g: Grid, x0: number, x1: number, y: number): void {
  for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) if (get(g, x, y) === 0) set(g, x, y, 1);
}
function carveV(g: Grid, y0: number, y1: number, x: number): void {
  for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) if (get(g, x, y) === 0) set(g, x, y, 1);
}

/** Organic cavern via cellular-automata smoothing of random noise. */
function genCave(rng: Rng, w: number, h: number, complexity: number): GenResult {
  let g = makeGrid(w, h, 0);
  // Denser initial fill → more wall → tighter cave. complexity opens it up.
  const wallProb = 0.5 - complexity * 0.12;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Force the border to wall so the cave never bleeds off the edge.
      const border = x === 0 || y === 0 || x === w - 1 || y === h - 1;
      set(g, x, y, border || rng.chance(wallProb) ? 0 : 1);
    }
  }
  for (let step = 0; step < 5; step++) g = caStep(g);
  return { grid: g, rooms: [] };
}

/** One CA smoothing pass: a cell becomes wall if ≥5 of its 8 neighbours are walls. */
function caStep(g: Grid): Grid {
  const next = makeGrid(g.w, g.h, 0);
  for (let y = 0; y < g.h; y++) {
    for (let x = 0; x < g.w; x++) {
      let walls = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        if (get(g, x + dx, y + dy) === 0) walls++;
      }
      const border = x === 0 || y === 0 || x === g.w - 1 || y === g.h - 1;
      set(next, x, y, border || walls >= 5 ? 0 : 1);
    }
  }
  return next;
}

/** Open ground scattered with blocking terrain blobs (rocks/thickets). */
function genWilderness(rng: Rng, w: number, h: number, complexity: number): GenResult {
  const g = makeGrid(w, h, 1); // all open
  const blobs = Math.round((w * h) / 40) + Math.round(complexity * 12);
  for (let i = 0; i < blobs; i++) {
    const bx = rng.int(1, w - 2);
    const by = rng.int(1, h - 2);
    const r = rng.int(1, 3);
    for (let y = by - r; y <= by + r; y++) {
      for (let x = bx - r; x <= bx + r; x++) {
        const dist = Math.abs(x - bx) + Math.abs(y - by);
        if (dist <= r && rng.chance(0.7)) set(g, x, y, 2); // feature (blocking) on floor
      }
    }
  }
  return { grid: g, rooms: [] };
}

// ---------- SVG rendering ----------

/** Escape a value destined for an SVG/XML attribute or text node. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Render a grid to a self-contained SVG string. Floor cells are merged into per-row runs
 * to keep the rect count (and byte size) low; a <pattern> draws the crisp grid overlay.
 * The SVG is deterministic and contains NO scripts / external refs / user free-text — only
 * shapes and palette colours — so it is safe to serve inline (image/svg+xml).
 */
function renderSvg(g: Grid, palette: Palette, seed: string, roomsShaded: Room[]): string {
  const W = g.w * CELL;
  const H = g.h * CELL;
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" shape-rendering="crispEdges">`,
  );
  // Deterministic provenance marker (same seed ⇒ same bytes) — a comment, never executed.
  parts.push(`<!-- campfire procedural map seed=${esc(seed)} -->`);
  parts.push(
    `<defs><pattern id="grid" width="${CELL}" height="${CELL}" patternUnits="userSpaceOnUse">` +
      `<path d="M ${CELL} 0 L 0 0 0 ${CELL}" fill="none" stroke="${palette.grid}" stroke-width="1"/></pattern></defs>`,
  );
  // Background = wall/rock negative space.
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="${palette.bg}"/>`);

  // Optional per-room shading (dungeon): draw a faint alt-fill rect behind the floor runs.
  for (const r of roomsShaded) {
    parts.push(
      `<rect x="${r.x * CELL}" y="${r.y * CELL}" width="${r.w * CELL}" height="${r.h * CELL}" fill="${palette.floorAlt}"/>`,
    );
  }

  // Floor as merged horizontal runs.
  for (let y = 0; y < g.h; y++) {
    let runStart = -1;
    for (let x = 0; x <= g.w; x++) {
      const isFloor = x < g.w && get(g, x, y) !== 0; // floor OR feature sits on floor
      if (isFloor && runStart === -1) runStart = x;
      if (!isFloor && runStart !== -1) {
        parts.push(
          `<rect x="${runStart * CELL}" y="${y * CELL}" width="${(x - runStart) * CELL}" height="${CELL}" fill="${palette.floor}"/>`,
        );
        runStart = -1;
      }
    }
  }

  // Feature cells (blocking terrain) drawn as filled circles atop the floor.
  for (let y = 0; y < g.h; y++) {
    for (let x = 0; x < g.w; x++) {
      if (get(g, x, y) === 2) {
        parts.push(
          `<circle cx="${x * CELL + CELL / 2}" cy="${y * CELL + CELL / 2}" r="${CELL * 0.38}" fill="${palette.feature}"/>`,
        );
      }
    }
  }

  // Grid overlay on the whole surface.
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="url(#grid)"/>`);
  parts.push('</svg>');
  return parts.join('');
}

export interface GeneratedMap {
  svg: string;
  seed: string;
  kind: MapKind;
  widthCells: number;
  heightCells: number;
  roomCount: number;
  gridConfig: MapGridConfig;
}

export interface GenerateInput {
  kind: MapKind;
  size: MapSize;
  seed: string; // caller-resolved (never empty) so output is fully determined
  complexity?: number;
  theme?: MapTheme;
  gridScale?: number;
  gridUnit?: string;
}

/**
 * Deterministically generate a battle map. Given identical input (same seed + params) the
 * returned SVG bytes are identical — the reproducibility guarantee #306 requires.
 */
export function generateMap(input: GenerateInput): GeneratedMap {
  const { w, h } = SIZE_DIMS[input.size];
  const complexity = input.complexity ?? 0.5;
  const rng = new Rng(`${input.kind}:${input.size}:${complexity}:${input.seed}`);

  let result: GenResult;
  switch (input.kind) {
    case 'cave':
      result = genCave(rng, w, h, complexity);
      break;
    case 'wilderness':
      result = genWilderness(rng, w, h, complexity);
      break;
    case 'dungeon':
    default:
      result = genDungeon(rng, w, h, complexity);
      break;
  }

  const theme = input.theme ?? DEFAULT_THEME[input.kind];
  const palette = THEMES[theme];
  const svg = renderSvg(result.grid, palette, input.seed, input.kind === 'dungeon' ? result.rooms : []);

  const gridConfig: MapGridConfig = {
    // One cell as a percent of the map's rendered WIDTH (the VTT's convention, #40).
    gridSize: Math.max(1, Math.min(100, 100 / w)),
    gridScale: input.gridScale ?? 5,
    gridUnit: input.gridUnit ?? 'ft',
    gridType: 'square',
  };

  return {
    svg,
    seed: input.seed,
    kind: input.kind,
    widthCells: w,
    heightCells: h,
    roomCount: result.rooms.length,
    gridConfig,
  };
}
