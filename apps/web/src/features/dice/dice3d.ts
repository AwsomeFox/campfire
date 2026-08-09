/**
 * Physical 3D dice for the roll overlay — the design project's `CFDice3D`
 * (its `dice3d.js` template support module) ported to TypeScript.
 *
 * Dice fall, bounce and tumble under gravity, then settle with the rolled face
 * UP. A natural 20 or natural 1 on a d20 gets its own flourish.
 *
 * The throw is a REPLAY, not a live simulation: `startDiceRoll` runs the physics
 * headlessly first and records the frames, so the die comes to rest on a face
 * that is already known and the rolled number is painted onto that face —
 * nothing has to rotate into place at the end.
 *
 * Two things differ from the design module, both forced by the real roll flow:
 *
 *  - The design's `play(canvas, dice, theme, onSettled)` takes the rolled values
 *    up front, because a template mockup already knows them. Here the values
 *    only arrive when the server answers. So the throw is split: `startDiceRoll`
 *    records the trajectories (which do not depend on the values at all) and
 *    holds the dice spinning in the air, and `settle()` paints the real numbers
 *    onto the landing faces and releases them. Repainting is two texture swaps
 *    per die, so it is invisible under a ~1200°/s spin.
 *  - Everything is disposed on unmount. The overlay mounts a fresh canvas per
 *    roll, and a leaked WebGL context per roll would exhaust the browser's
 *    context budget within a session.
 */
import * as THREE from 'three';
import type { DiceTheme } from '@campfire/schema';
import { d6Values, faceValues } from './dice3dFaces';
import {
  ALIGN_MS,
  ALIGN_MS_REDUCED,
  dieDelayMs,
  LINGER_MS,
  LINGER_MS_FLOURISH,
} from './dice3dTiming';

interface ThemeSpec {
  body: number;
  deep: number;
  edge: number;
  num: string;
  glow: number;
}

/** Mirrors the swatches in ./diceThemes.ts, as solid colours rather than CSS. */
const THEMES: Record<DiceTheme, ThemeSpec> = {
  nocturne: { body: 0x312e81, deep: 0x1e1b4b, edge: 0x6366f1, num: '#e0e7ff', glow: 0x6366f1 },
  obsidian_gold: { body: 0x18181b, deep: 0x09090b, edge: 0xf59e0b, num: '#fbbf24', glow: 0xf59e0b },
  arcane_amethyst: { body: 0x581c87, deep: 0x3b0764, edge: 0xc084fc, num: '#f0abfc', glow: 0xc084fc },
  dragon_ruby: { body: 0x7f1d1d, deep: 0x450a0a, edge: 0xef4444, num: '#fca5a5', glow: 0xef4444 },
  celestial_pearl: { body: 0x1e293b, deep: 0x0f172a, edge: 0x38bdf8, num: '#e0f2fe', glow: 0x38bdf8 },
  cyberpunk_neon: { body: 0x111827, deep: 0x030712, edge: 0x06b6d4, num: '#22d3ee', glow: 0x06b6d4 },
  eldritch_void: { body: 0x064e3b, deep: 0x022c22, edge: 0x10b981, num: '#6ee7b7', glow: 0x10b981 },
  mahogany_wood: { body: 0x451a03, deep: 0x27120a, edge: 0xd97706, num: '#fde68a', glow: 0xd97706 },
};

const GRAVITY = -19;
const FLOOR_BOUNCE = 0.42;
const FLOOR_FRICTION = 0.74;
const WALL_X = 3.3;
const WALL_Z = 1.5;

const DROPPED_OPACITY = 0.3;

/** Resting radius of each solid before the roll's scale is applied. */
const DIE_RADIUS = 0.96;
const D6_RADIUS = 0.86;
/** How far apart two resting dice must sit, as a multiple of their radii. */
const SEPARATION = 1.15;
/**
 * Relaxation passes. Generous because it runs ONCE per roll, off the animation
 * frame, before anything is drawn: at the 60-die ceiling that is ~1770 pairs a
 * pass, still well under a millisecond, and dice wedged against a wall need room
 * to shuffle along it.
 */
const RELAX_PASSES = 400;
/**
 * Relax to a hair BEYOND the required gap. Correcting to exactly the gap only
 * reaches it in the limit — each pass halves what is left — so a pair would sit
 * a few ten-thousandths short of clear however many passes it ran.
 */
const SEPARATION_EPS = 0.002;

/**
 * How big the dice are drawn, given how many are in flight.
 *
 * The first three steps are the design's own sizes. Past that, the tray floor
 * physically runs out: a fixed 0.66 fits maybe five dice, and the server accepts
 * up to 20 per term with no cap on terms, so `20d6+20d6+20d6` is a legal 60-die
 * roll. Asking `separateRestingPlaces` to open out more dice than the floor can
 * hold has no answer — it can only pick the least-bad pile. So the dice shrink
 * until the floor CAN hold them, and separation becomes solvable again.
 *
 * Capacity is counted as a GRID of rows and columns, not as bare area. The tray
 * is much shallower than it is wide, so once dice are large enough that two will
 * not sit side by side in z, area over-states what fits by a wide margin — it
 * would shrink a three-die roll that comfortably lines up in a single row.
 * Counts of three and under keep the design's sizes untouched.
 */
export function dieScaleFor(count: number, radius: number = DIE_RADIUS): number {
  let scale = count > 3 ? 0.66 : count > 1 ? 0.82 : 1.05;
  if (count <= 3) return scale;
  for (let i = 0; i < 60; i++) {
    const r = radius * scale;
    const d = 2 * r * SEPARATION;
    const cols = Math.floor(Math.max(0, 2 * WALL_X - 2 * r) / d) + 1;
    const rows = Math.floor(Math.max(0, 2 * WALL_Z - 2 * r) / d) + 1;
    // Generous headroom over a perfect grid. The dice relax from wherever the
    // physics dropped them, which is nothing like a grid, and the last few
    // percent of packing is exactly where relaxation stalls — the tray is cheap
    // to give away, a die still overlapping is not.
    if (cols * rows >= count * 1.6) break;
    scale *= 0.95;
  }
  return scale;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export interface Dice3dSettleDie {
  /** Server-returned face for this die. */
  value: number;
  /** False for a die discarded by keep-highest/lowest — rendered faded. */
  kept: boolean;
}

export interface Dice3dOptions {
  /** Sides per die, in the order the expression lists them. */
  sides: number[];
  theme: DiceTheme;
  /** Shortens the alignment and skips the crit/fumble flourish. */
  reducedMotion?: boolean;
  /** Fired once the dice are at rest and the flourish has had its linger. */
  onSettled: () => void;
}

export interface Dice3dHandle {
  /** Paint the rolled faces and release the held dice into the recorded throw. */
  settle: (dice: Dice3dSettleDie[]) => void;
  /** Cancel the loop and release every GPU resource this roll allocated. */
  dispose: () => void;
}

/* ------------------------------------------------------------------ geometry */

/**
 * A d100 is thrown on the ten-face percentile solid, the way a real table rolls
 * percentiles — not on a hundred-face die nobody owns. Its landing face carries
 * the whole 1..100 result rather than a tens digit, so one die still reads as
 * one result.
 */
function usesPercentileSolid(sides: number): boolean {
  return sides === 10 || sides === 100;
}

function geometryFor(sides: number): THREE.BufferGeometry {
  if (sides === 4) return new THREE.TetrahedronGeometry(1.15);
  if (usesPercentileSolid(sides)) return d10Geometry(1.12);
  if (sides === 8) return new THREE.OctahedronGeometry(1.2);
  if (sides === 12) return new THREE.DodecahedronGeometry(1.15);
  return new THREE.IcosahedronGeometry(1.15);
}

interface Face {
  normal: THREE.Vector3;
  center: THREE.Vector3;
  /** In-plane "up" direction, only known for the d10's kite faces. */
  up?: THREE.Vector3;
}

/** Triangles that share a normal are one real die face. */
function facesOf(geo: THREE.BufferGeometry): Face[] {
  const pos = geo.getAttribute('position');
  const groups: { normal: THREE.Vector3; sum: THREE.Vector3; n: number }[] = [];
  for (let i = 0; i < pos.count; i += 3) {
    const a = new THREE.Vector3().fromBufferAttribute(pos, i);
    const b = new THREE.Vector3().fromBufferAttribute(pos, i + 1);
    const c = new THREE.Vector3().fromBufferAttribute(pos, i + 2);
    const n = new THREE.Vector3()
      .subVectors(b, a)
      .cross(new THREE.Vector3().subVectors(c, a))
      .normalize();
    const mid = new THREE.Vector3().add(a).add(b).add(c).multiplyScalar(1 / 3);
    // Cluster by ANGLE, not by a rounded string key: two triangles of the same
    // pentagon differ in the last float digits, and a string key split them into
    // two "faces" — which put two numbers on one face of the d12.
    let hit: (typeof groups)[number] | null = null;
    for (const g of groups) {
      if (g.normal.dot(n) > 0.995) {
        hit = g;
        break;
      }
    }
    if (!hit) {
      hit = { normal: n.clone(), sum: new THREE.Vector3(), n: 0 };
      groups.push(hit);
    }
    hit.sum.add(mid);
    hit.n++;
  }
  return groups.map((f) => ({
    normal: f.normal,
    center: f.sum.clone().multiplyScalar(1 / f.n),
  }));
}

/**
 * Real d10: pentagonal trapezohedron. The first ten triangles are the numbered
 * kite faces; the ten that follow fill the band between them and stay blank.
 */
function d10Geometry(radius: number): THREE.PolyhedronGeometry {
  const a = (Math.PI * 2) / 10;
  const h = 0.105;
  const verts: number[] = [];
  for (let i = 0; i < 10; i++) verts.push(Math.cos(i * a), Math.sin(i * a), h * (i % 2 ? 1 : -1));
  verts.push(0, 0, -1, 0, 0, 1);
  const idx = [
    5, 7, 11, 4, 2, 10, 1, 3, 11, 0, 8, 10, 7, 9, 11, 8, 6, 10, 9, 1, 11, 2, 0, 10, 3, 5, 11, 6, 4, 10,
    1, 0, 2, 1, 2, 3, 3, 2, 4, 3, 4, 5, 5, 4, 6, 5, 6, 7, 7, 6, 8, 7, 8, 9, 9, 8, 0, 9, 0, 1,
  ];
  return new THREE.PolyhedronGeometry(verts, idx, radius, 0);
}

/** The ten numbered faces of a d10, in triangle order (no normal clustering). */
function d10Faces(geo: THREE.BufferGeometry): Face[] {
  const pos = geo.getAttribute('position');
  const out: Face[] = [];
  for (let i = 0; i < 30; i += 3) {
    const a = new THREE.Vector3().fromBufferAttribute(pos, i);
    const b = new THREE.Vector3().fromBufferAttribute(pos, i + 1);
    const c = new THREE.Vector3().fromBufferAttribute(pos, i + 2);
    const normal = new THREE.Vector3()
      .subVectors(b, a)
      .cross(new THREE.Vector3().subVectors(c, a))
      .normalize();
    const center = new THREE.Vector3().add(a).add(b).add(c).multiplyScalar(1 / 3);
    const apex = [a, b, c].reduce((m, v) => (Math.abs(v.z) > Math.abs(m.z) ? v : m), a);
    const up = new THREE.Vector3().subVectors(apex, center).projectOnPlane(normal).normalize();
    out.push({ normal, center: center.addScaledVector(up, -0.14), up });
  }
  return out;
}

function facesFor(sides: number, geo: THREE.BufferGeometry): Face[] {
  return usesPercentileSolid(sides) ? d10Faces(geo) : facesOf(geo);
}

const BOX_NORMALS = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/**
 * Local-space normals of a die's numbered faces, indexed the same way as the
 * numbers `faceValues`/`d6Values` hand out. Builds and disposes its own geometry,
 * so a caller only has to know the side count.
 */
export function dieFaceNormals(sides: number): THREE.Vector3[] {
  if (sides === 6) return BOX_NORMALS.map((a) => new THREE.Vector3().fromArray(a));
  const geo = geometryFor(sides);
  const normals = facesFor(sides, geo).map((f) => f.normal.clone());
  geo.dispose();
  return normals;
}

/* ------------------------------------------------------------------ textures */

/**
 * Textures are shared across the dice of one roll and disposed together with it.
 * A roll of 8d6 would otherwise allocate 48 canvases for six distinct pip faces.
 */
class TextureCache {
  private readonly cache = new Map<string, THREE.CanvasTexture>();

  number(text: string, color: string, underline: boolean): THREE.CanvasTexture {
    return this.get(`n:${text}:${color}:${underline}`, () => {
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const g = c.getContext('2d');
      if (!g) return null;
      g.clearRect(0, 0, 128, 128);
      g.fillStyle = color;
      // Three digits only happens on a d100's "100"; it needs the extra step down
      // to stay inside the 128px face texture.
      const px = text.length > 2 ? 46 : text.length > 1 ? 62 : 76;
      g.font = `bold ${px}px ui-monospace, Menlo, monospace`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(text, 64, 66);
      // 6 and 9 are the same glyph upside down; the underline is what a real die uses.
      if (underline) g.fillRect(40, 104, 48, 6);
      return c;
    });
  }

  pip(n: number, th: ThemeSpec): THREE.CanvasTexture {
    return this.get(`p:${n}:${th.body}`, () => {
      const c = document.createElement('canvas');
      c.width = c.height = 160;
      const g = c.getContext('2d');
      if (!g) return null;
      g.fillStyle = `#${`000000${th.body.toString(16)}`.slice(-6)}`;
      g.fillRect(0, 0, 160, 160);
      const grad = g.createRadialGradient(60, 50, 10, 80, 80, 120);
      grad.addColorStop(0, 'rgba(255,255,255,.14)');
      grad.addColorStop(1, 'rgba(0,0,0,.28)');
      g.fillStyle = grad;
      g.fillRect(0, 0, 160, 160);
      g.strokeStyle = `#${`000000${th.edge.toString(16)}`.slice(-6)}`;
      g.globalAlpha = 0.5;
      g.lineWidth = 8;
      g.strokeRect(4, 4, 152, 152);
      g.globalAlpha = 1;
      const L = 44;
      const M = 80;
      const R = 116;
      const layout: Record<number, number[][]> = {
        1: [[M, M]],
        2: [[L, L], [R, R]],
        3: [[L, L], [M, M], [R, R]],
        4: [[L, L], [R, L], [L, R], [R, R]],
        5: [[L, L], [R, L], [M, M], [L, R], [R, R]],
        6: [[L, L], [R, L], [L, M], [R, M], [L, R], [R, R]],
      };
      const pips = layout[n] || layout[1];
      for (const [px, py] of pips) {
        g.beginPath();
        g.arc(px, py, 15, 0, Math.PI * 2);
        g.fillStyle = 'rgba(0,0,0,.45)';
        g.fill();
        g.beginPath();
        g.arc(px - 1.5, py - 1.5, 13, 0, Math.PI * 2);
        g.fillStyle = th.num;
        g.fill();
      }
      return c;
    });
  }

  shadow(): THREE.CanvasTexture {
    return this.get('shadow', () => {
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const g = c.getContext('2d');
      if (!g) return null;
      const grad = g.createRadialGradient(64, 64, 4, 64, 64, 62);
      grad.addColorStop(0, 'rgba(0,0,0,.55)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, 128, 128);
      return c;
    });
  }

  dispose(): void {
    for (const tex of this.cache.values()) tex.dispose();
    this.cache.clear();
  }

  private get(key: string, draw: () => HTMLCanvasElement | null): THREE.CanvasTexture {
    const hit = this.cache.get(key);
    if (hit) return hit;
    const canvas = draw() ?? document.createElement('canvas');
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    this.cache.set(key, tex);
    return tex;
  }
}

/* --------------------------------------------------------------------- dice */

interface DieRig {
  group: THREE.Group;
  sides: number;
  /** Material index / plane index per face, so settle() can repaint one face. */
  paint: (faceIdx: number, value: number) => void;
  /** Face normals in local space, indexed the same way as `paint`. */
  normals: THREE.Vector3[];
  /** Local normal of the face the recorded throw lands on. */
  faceNormal: THREE.Vector3;
  materials: THREE.Material[];
  fade: () => void;
  radius: number;
}

function buildD6(th: ThemeSpec, upIdx: number, tex: TextureCache): DieRig {
  const order = d6Values(1, upIdx);
  const mats = order.map(
    (n) =>
      new THREE.MeshPhongMaterial({
        map: tex.pip(n, th),
        emissive: new THREE.Color(th.deep),
        emissiveIntensity: 0.35,
        shininess: 22,
        specular: new THREE.Color(th.edge),
      }),
  );
  const geo = new THREE.BoxGeometry(1.62, 1.62, 1.62);
  const edges = new THREE.EdgesGeometry(geo);
  const lineMat = new THREE.LineBasicMaterial({ color: th.edge, transparent: true, opacity: 0.55 });
  const group = new THREE.Group();
  group.add(new THREE.Mesh(geo, mats));
  group.add(new THREE.LineSegments(edges, lineMat));
  return {
    group,
    sides: 6,
    normals: BOX_NORMALS.map((a) => new THREE.Vector3().fromArray(a)),
    faceNormal: new THREE.Vector3().fromArray(BOX_NORMALS[upIdx]),
    materials: [...mats, lineMat],
    radius: 0.86,
    paint: (faceIdx, value) => {
      for (const [i, n] of d6Values(value, faceIdx).entries()) {
        mats[i].map = tex.pip(n, th);
        mats[i].needsUpdate = true;
      }
    },
    fade: () => {
      for (const m of mats) {
        m.transparent = true;
        m.opacity = DROPPED_OPACITY;
      }
      lineMat.opacity = DROPPED_OPACITY * 0.6;
    },
  };
}

function buildDie(sides: number, theme: DiceTheme, upIdx: number, tex: TextureCache): DieRig {
  const th = THEMES[theme] ?? THEMES.nocturne;
  if (sides === 6) return buildD6(th, upIdx, tex);

  const geo = geometryFor(sides);
  const faces = facesFor(sides, geo);
  const vals = faceValues(sides, 1, upIdx, faces.length);
  const group = new THREE.Group();
  const mat = new THREE.MeshPhongMaterial({
    color: th.body,
    emissive: new THREE.Color(th.deep),
    emissiveIntensity: 0.3,
    shininess: 46,
    specular: new THREE.Color(th.edge),
    flatShading: true,
  });
  const edges = new THREE.EdgesGeometry(geo, 12);
  const lineMat = new THREE.LineBasicMaterial({ color: th.edge, transparent: true, opacity: 0.85 });
  group.add(new THREE.Mesh(geo, mat));
  group.add(new THREE.LineSegments(edges, lineMat));

  const planeMats: THREE.MeshBasicMaterial[] = [];
  const size = usesPercentileSolid(sides) ? 0.6 : 0.78;
  for (const [i, face] of faces.entries()) {
    const n = vals[i];
    const planeMat = new THREE.MeshBasicMaterial({
      map: tex.number(String(n), th.num, n === 6 || n === 9),
      transparent: true,
      depthWrite: false,
    });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(size, size), planeMat);
    plane.position.copy(face.center).addScaledVector(face.normal, 0.015);
    if (face.up) {
      const fz = face.normal.clone();
      const fy = face.up.clone();
      const fx = new THREE.Vector3().crossVectors(fy, fz).normalize();
      plane.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(fx, fy, fz));
    } else {
      plane.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), face.normal);
    }
    group.add(plane);
    planeMats.push(planeMat);
  }

  return {
    group,
    sides,
    normals: faces.map((f) => f.normal.clone()),
    faceNormal: (faces[upIdx] ?? faces[0]).normal.clone(),
    materials: [mat, lineMat, ...planeMats],
    radius: 0.96,
    paint: (faceIdx, value) => {
      for (const [i, n] of faceValues(sides, value, faceIdx, faces.length).entries()) {
        planeMats[i].map = tex.number(String(n), th.num, n === 6 || n === 9);
        planeMats[i].needsUpdate = true;
      }
    },
    fade: () => {
      mat.transparent = true;
      mat.opacity = DROPPED_OPACITY;
      lineMat.opacity = DROPPED_OPACITY * 0.6;
      for (const m of planeMats) m.opacity = DROPPED_OPACITY;
    },
  };
}

/* ------------------------------------------------------------------ physics */

export interface ThrowInit {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
}

export interface Frame {
  p: THREE.Vector3;
  q: THREE.Quaternion;
}

/**
 * Run the throw headlessly and record it, so the visual pass is a replay: the die
 * comes to rest on a face we already know.
 */
export function simulate(init: ThrowInit, rest: number): Frame[] {
  const dt = 1 / 60;
  const pos = init.pos.clone();
  const vel = init.vel.clone();
  const spin = init.spin.clone();
  const q = init.quat.clone();
  const out: Frame[] = [];
  for (let i = 0; i < 420; i++) {
    vel.y += GRAVITY * dt;
    pos.addScaledVector(vel, dt);
    q.multiply(
      new THREE.Quaternion().setFromEuler(new THREE.Euler(spin.x * dt, spin.y * dt, spin.z * dt)),
    );
    if (pos.y < rest) {
      pos.y = rest;
      vel.y = Math.abs(vel.y) * FLOOR_BOUNCE;
      vel.x *= FLOOR_FRICTION;
      vel.z *= FLOOR_FRICTION;
      spin.multiplyScalar(0.6);
    }
    if (Math.abs(pos.x) > WALL_X) {
      pos.x = Math.sign(pos.x) * WALL_X;
      vel.x *= -0.55;
      spin.multiplyScalar(0.8);
    }
    if (Math.abs(pos.z) > WALL_Z) {
      pos.z = Math.sign(pos.z) * WALL_Z;
      vel.z *= -0.55;
      spin.multiplyScalar(0.8);
    }
    out.push({ p: pos.clone(), q: q.clone() });
    if (vel.length() + spin.length() * 0.08 < 1.2 && pos.y <= rest + 0.02) break;
  }
  return out;
}

export interface RestingThrow {
  traj: Frame[];
  rest: number;
}

/** Centre distance two resting dice need before they stop intersecting. */
export function separationGap(restA: number, restB: number): number {
  return (restA + restB) * SEPARATION;
}

/**
 * Slide resting dice apart so none settle intersecting.
 *
 * Relaxes ALL of them together rather than fitting each new die around the ones
 * already down. Placing them one at a time cannot work in general: an early die
 * takes a spot, nothing can later reopen it, and a crowded roll dead-ends with
 * dice inside each other however hard the newcomer is pushed. Here every die
 * gives ground, so the pile opens out as a whole.
 *
 * Each pass moves an overlapping pair half the overlap apart each, then clamps
 * both inside the tray — `WALL - rest`, so a settled die sits fully within the
 * walls rather than merely having its centre in bounds. Passes stop as soon as
 * nothing overlaps. `dieScaleFor` sizes the dice so the floor can hold them, so
 * this has room to converge; were a roll ever denser than that, it still ends far
 * more open than it started.
 *
 * The whole recorded trajectory shifts with the resting place, so the throw still
 * arrives where it lands. Every frame is clamped to the wall the integrator
 * bounces off, so a throw that grazed a wall in flight cannot be shifted through
 * it.
 */
export function separateRestingPlaces(throws: readonly RestingThrow[]): void {
  const n = throws.length;
  if (n < 2) return;

  const startX = throws.map((t) => t.traj[t.traj.length - 1].p.x);
  const startZ = throws.map((t) => t.traj[t.traj.length - 1].p.z);
  const x = [...startX];
  const z = [...startZ];
  const limitX = throws.map((t) => Math.max(0, WALL_X - t.rest));
  const limitZ = throws.map((t) => Math.max(0, WALL_Z - t.rest));

  /** True while any pair is still closer than the gap they need. */
  function stillOverlapping(): boolean {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const gap = separationGap(throws[i].rest, throws[j].rest);
        if (Math.hypot(x[i] - x[j], z[i] - z[j]) < gap) return true;
      }
    }
    return false;
  }

  /**
   * One separation sweep. Corrections are applied to both dice AS WE GO rather
   * than accumulated and applied at the end: resolving each pair against
   * already-moved neighbours converges, while collecting every correction first
   * and applying them together leaves a crowded tray a hair short of clear no
   * matter how long it runs.
   */
  function relaxPass(pass: number): void {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const gap = separationGap(throws[i].rest, throws[j].rest);
        let dx = x[i] - x[j];
        let dz = z[i] - z[j];
        let dist = Math.hypot(dx, dz);
        if (dist >= gap + SEPARATION_EPS) continue;
        if (dist < 1e-6) {
          // Exactly stacked: any direction will do, but it must vary by pair and
          // pass, or two coincident dice would shove each other nowhere.
          const a = i * 2.399 + j * 0.777 + pass;
          dx = Math.cos(a);
          dz = Math.sin(a);
          dist = 1;
        }
        const k = (gap + SEPARATION_EPS - dist) / dist / 2;
        x[i] = clamp(x[i] + dx * k, -limitX[i], limitX[i]);
        z[i] = clamp(z[i] + dz * k, -limitZ[i], limitZ[i]);
        x[j] = clamp(x[j] - dx * k, -limitX[j], limitX[j]);
        z[j] = clamp(z[j] - dz * k, -limitZ[j], limitZ[j]);
      }
    }
  }

  for (let pass = 0; pass < RELAX_PASSES && stillOverlapping(); pass++) relaxPass(pass);

  if (stillOverlapping()) {
    // Relaxation can wedge: a knot of dice in a corner reaches a fixed point that
    // is still overlapping, and no number of further passes moves it, because
    // every pair's correction is cancelled by another's. Laying the dice out on a
    // grid is a placement that cannot fail — `dieScaleFor` has already guaranteed
    // the floor has slots for them — and relaxing from there rounds off the
    // regularity. Dice keep their left-to-right order, so the pile still broadly
    // reflects where the throw put them.
    const maxRest = Math.max(...throws.map((t) => t.rest));
    const gap = separationGap(maxRest, maxRest) + SEPARATION_EPS;
    const spanX = 2 * Math.max(0, WALL_X - maxRest);
    const spanZ = 2 * Math.max(0, WALL_Z - maxRest);
    const cols = Math.max(1, Math.floor(spanX / gap) + 1);
    const rows = Math.max(1, Math.ceil(n / cols));
    const stepX = cols > 1 ? spanX / (cols - 1) : 0;
    const stepZ = rows > 1 ? Math.min(spanZ / (rows - 1), gap * 1.5) : 0;

    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => x[a] - x[b]);
    for (const [slot, i] of order.entries()) {
      const col = slot % cols;
      const row = Math.floor(slot / cols);
      x[i] = clamp(-spanX / 2 + col * stepX, -limitX[i], limitX[i]);
      z[i] = clamp(-((rows - 1) * stepZ) / 2 + row * stepZ, -limitZ[i], limitZ[i]);
    }

    for (let pass = 0; pass < RELAX_PASSES && stillOverlapping(); pass++) relaxPass(pass);
  }

  for (let i = 0; i < n; i++) {
    const offX = x[i] - startX[i];
    const offZ = z[i] - startZ[i];
    if (offX === 0 && offZ === 0) continue;
    for (const fr of throws[i].traj) {
      fr.p.x = clamp(fr.p.x + offX, -WALL_X, WALL_X);
      fr.p.z = clamp(fr.p.z + offZ, -WALL_Z, WALL_Z);
    }
  }
}

/** Index of the face pointing most nearly straight up under rotation `q`. */
export function upFaceIndex(normals: THREE.Vector3[], q: THREE.Quaternion): number {
  let best = 0;
  let bestY = -2;
  for (const [i, n] of normals.entries()) {
    const y = n.clone().applyQuaternion(q).y;
    if (y > bestY) {
      bestY = y;
      best = i;
    }
  }
  return best;
}

/* --------------------------------------------------------------------- play */

interface DieState {
  rig: DieRig;
  traj: Frame[];
  rest: number;
  delay: number;
  init: ThrowInit;
  shadow: THREE.Mesh;
  settleAt: number;
  from: THREE.Quaternion | null;
  target: THREE.Quaternion | null;
}

/**
 * Start a throw. Returns null when WebGL is unavailable, which is the caller's
 * signal to fall back to the CSS overlay.
 */
export function startDiceRoll(
  canvas: HTMLCanvasElement,
  { sides, theme, reducedMotion = false, onSettled }: Dice3dOptions,
): Dice3dHandle | null {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  } catch {
    return null;
  }
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));

  const th = THEMES[theme] ?? THEMES.nocturne;
  const tex = new TextureCache();
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 2, 0.1, 100);
  camera.position.set(0, 5.1, 5.4);
  camera.lookAt(0, 0.2, 0);
  scene.add(new THREE.AmbientLight(0xffffff, 0.72));
  const key = new THREE.DirectionalLight(0xffffff, 0.5);
  key.position.set(3, 6, 4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(th.glow, 0.4);
  rim.position.set(-5, 2, 3);
  scene.add(rim);
  const flash = new THREE.PointLight(0xffffff, 0, 22);
  flash.position.set(0, 2.2, 1.4);
  scene.add(flash);

  const group = new THREE.Group();
  const n = sides.length;
  const spread = n > 1 ? Math.min(2.5, 5.4 / n) : 0;
  // Sized against the widest solid in the roll, so a mixed 1d20+8d6 is judged by
  // the d20 it has to make room for rather than by the d6 average.
  const scale = dieScaleFor(n, sides.some((s) => s !== 6) ? DIE_RADIUS : D6_RADIUS);
  const shadowTex = tex.shadow();
  const shadowGeos: THREE.BufferGeometry[] = [];
  const shadowMats: THREE.Material[] = [];
  const dice: DieState[] = [];

  // Every throw is recorded first, then the whole set is slid apart, and only then
  // are the dice built. Separation has to see all the resting places at once — it
  // cannot be done while they arrive one at a time (see separateRestingPlaces).
  const thrown = sides.map((dieSides, i) => {
    const rest = (dieSides === 6 ? D6_RADIUS : DIE_RADIUS) * scale;
    const init: ThrowInit = {
      pos: new THREE.Vector3(
        (i - (n - 1) / 2) * spread + (Math.random() - 0.5) * 0.3,
        3.6 + Math.random() * 0.9,
        -0.9 + Math.random() * 0.5,
      ),
      quat: new THREE.Quaternion().setFromEuler(
        new THREE.Euler(Math.random() * 6.3, Math.random() * 6.3, Math.random() * 6.3),
      ),
      vel: new THREE.Vector3(
        (Math.random() - 0.5) * 3.4,
        -1.4 - Math.random(),
        2.2 + Math.random() * 1.4,
      ),
      spin: new THREE.Vector3(
        (Math.random() - 0.5) * 22,
        (Math.random() - 0.5) * 22,
        (Math.random() - 0.5) * 22,
      ),
    };
    return { sides: dieSides, init, rest, traj: simulate(init, rest) };
  });
  separateRestingPlaces(thrown);

  for (let i = 0; i < n; i++) {
    const { sides: dieSides, init, rest, traj } = thrown[i];

    // Which face lands up is fixed by the recorded throw, so the rig can be built
    // with its numbering already keyed to that face.
    const upIdx = upFaceIndex(dieFaceNormals(dieSides), traj[traj.length - 1].q);

    const rig = buildDie(dieSides, theme, upIdx, tex);
    rig.group.scale.setScalar(scale);
    rig.group.position.copy(traj[0].p);
    rig.group.quaternion.copy(init.quat);
    group.add(rig.group);

    const shadowGeo = new THREE.PlaneGeometry(2.5 * scale, 2.5 * scale);
    const shadowMat = new THREE.MeshBasicMaterial({
      map: shadowTex,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
    });
    const shadow = new THREE.Mesh(shadowGeo, shadowMat);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.01;
    group.add(shadow);
    shadowGeos.push(shadowGeo);
    shadowMats.push(shadowMat);

    dice.push({
      rig,
      traj,
      rest,
      init,
      shadow,
      delay: dieDelayMs(i, n),
      settleAt: 0,
      from: null,
      target: null,
    });
  }

  const ringGeo = new THREE.RingGeometry(0.72, 0.96, 72);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0xfbbf24,
    transparent: true,
    opacity: 0,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.03;
  group.add(ring);

  const sparkGeo = new THREE.TetrahedronGeometry(0.09);
  const sparks: THREE.Mesh[] = [];
  const sparkVels: THREE.Vector3[] = [];
  const sparkMats: THREE.MeshBasicMaterial[] = [];
  for (let s = 0; s < 14; s++) {
    const sparkMat = new THREE.MeshBasicMaterial({ color: 0xfde68a, transparent: true, opacity: 0 });
    const sp = new THREE.Mesh(sparkGeo, sparkMat);
    sp.visible = false;
    group.add(sp);
    sparks.push(sp);
    sparkMats.push(sparkMat);
    sparkVels.push(
      new THREE.Vector3((Math.random() - 0.5) * 5, 2.6 + Math.random() * 2.6, (Math.random() - 0.5) * 5),
    );
  }

  scene.add(group);

  const align = reducedMotion ? ALIGN_MS_REDUCED : ALIGN_MS;
  let released = false;
  let releasedAt = 0;
  let landedAt = 0;
  let handedOff = false;
  let hero: DieState | null = null;
  let flourish: 'crit' | 'fumble' | null = null;
  let raf = 0;
  let last = performance.now();
  const startedAt = last;
  let disposed = false;

  function resize(): void {
    const w = canvas.clientWidth || 480;
    const h = canvas.clientHeight || 260;
    const ratio = renderer.getPixelRatio();
    if (canvas.width !== Math.round(w * ratio) || camera.aspect !== w / h) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
  }

  /**
   * Only ever a few degrees: the die already came to rest on this face, so this
   * reads as it rocking flat rather than turning to reveal a number.
   */
  function beginAlign(d: DieState, now: number): void {
    d.settleAt = now;
    d.from = d.rig.group.quaternion.clone();
    const worldN = d.rig.faceNormal.clone().applyQuaternion(d.rig.group.quaternion).normalize();
    const flat = new THREE.Quaternion().setFromUnitVectors(worldN, new THREE.Vector3(0, 1, 0));
    d.target = flat.multiply(d.rig.group.quaternion.clone());
  }

  /**
   * Park the flourish ring under the hero die on BOTH floor axes. Dice are thrown
   * forwards and come to rest at a nonzero z far more often than not, so tracking
   * x alone leaves the ring visibly adrift of the die it is celebrating.
   */
  function centreRingOn(g: THREE.Object3D): void {
    ring.position.x = g.position.x;
    ring.position.z = g.position.z;
  }

  function playFlourish(now: number, dt: number): void {
    if (!hero || !flourish) return;
    const ft = (now - landedAt) / 1000;
    const g = hero.rig.group;
    if (flourish === 'crit') {
      g.position.y = hero.rest + Math.min(0.55, ft * 1.5) + Math.sin(ft * 2.4) * 0.05;
      g.rotateOnWorldAxis(new THREE.Vector3(0, 1, 0), dt * 0.85);
      for (const m of hero.rig.materials) {
        const phong = m as THREE.MeshPhongMaterial;
        if (phong.emissive) {
          phong.emissive
            .setHex(0xf59e0b)
            .multiplyScalar(Math.min(1, ft * 1.6) * (0.55 + Math.sin(ft * 5) * 0.18));
        }
      }
      flash.color.setHex(0xfbbf24);
      flash.intensity = Math.max(0, 2.4 - ft * 2.2);
      ringMat.color.setHex(0xfbbf24);
      centreRingOn(g);
      ring.scale.setScalar(0.4 + ft * 3.4);
      ringMat.opacity = Math.max(0, 0.85 - ft * 0.85);
      for (const [i, sp] of sparks.entries()) {
        sp.visible = true;
        if (ft < 0.02) sp.position.set(g.position.x, hero.rest, g.position.z);
        sparkVels[i].y += GRAVITY * dt * 0.55;
        sp.position.addScaledVector(sparkVels[i], dt);
        sp.rotation.x += dt * 6;
        sp.rotation.y += dt * 5;
        sparkMats[i].opacity = Math.max(0, 1 - ft * 0.75);
      }
    } else {
      if (ft < 0.5) g.rotateOnWorldAxis(new THREE.Vector3(1, 0, 0), dt * 1.3);
      g.position.y = hero.rest - Math.min(0.16, ft * 0.4);
      flash.color.setHex(0xf87171);
      flash.intensity = Math.max(0, 1.8 - ft * 3.2);
      const shake = Math.max(0, 0.16 - ft * 0.32);
      camera.position.x = Math.sin(ft * 46) * shake;
      camera.position.y = 5.1 + Math.cos(ft * 39) * shake * 0.6;
      camera.lookAt(0, 0.2, 0);
      ringMat.color.setHex(0xf87171);
      centreRingOn(g);
      ring.scale.setScalar(Math.max(0.35, 2.6 - ft * 3.4));
      ringMat.opacity = Math.max(0, 0.55 - ft * 0.8);
    }
  }

  function frame(now: number): void {
    if (disposed) return;
    resize();
    const dt = Math.min(0.032, (now - last) / 1000);
    last = now;
    let atRest = 0;

    for (const d of dice) {
      const g = d.rig.group;
      if (!released) {
        // Held: the dice hang at the throw's start point, spinning, until the
        // server's faces arrive. The trajectory is already recorded and does not
        // depend on them, so nothing here has to be re-simulated on release.
        // Hold at the recorded first frame rather than `init.pos`, so a die whose
        // trajectory was shifted by the separation nudge does not jump sideways
        // the instant it is released.
        const t = (now - startedAt) / 1000;
        g.position.copy(d.traj[0].p);
        g.position.y += Math.sin(t * 2.2 + d.delay * 0.01) * 0.12;
        g.quaternion.multiply(
          new THREE.Quaternion().setFromEuler(
            new THREE.Euler(d.init.spin.x * dt, d.init.spin.y * dt, d.init.spin.z * dt),
          ),
        );
      } else if (!d.target) {
        const fi = Math.max(0, Math.floor((now - releasedAt - d.delay) / (1000 / 60)));
        if (fi < d.traj.length) {
          g.position.copy(d.traj[fi].p);
          g.quaternion.copy(d.traj[fi].q);
        } else {
          beginAlign(d, now);
        }
      } else {
        const k = Math.min(1, (now - d.settleAt) / align);
        const e = 1 - Math.pow(1 - k, 3);
        g.quaternion.slerpQuaternions(d.from as THREE.Quaternion, d.target, e);
        g.position.y = d.rest;
        if (k >= 1) atRest++;
      }
      d.shadow.position.x = g.position.x;
      d.shadow.position.z = g.position.z;
      const lift = Math.max(0, g.position.y - d.rest);
      (d.shadow.material as THREE.MeshBasicMaterial).opacity = Math.max(0.06, 0.5 - lift * 0.16);
      d.shadow.scale.setScalar(1 + lift * 0.22);
    }

    if (released && !landedAt && atRest === dice.length) landedAt = now;

    if (landedAt) {
      playFlourish(now, dt);
      const linger = flourish ? LINGER_MS_FLOURISH : LINGER_MS;
      if (!handedOff && now - landedAt >= linger) {
        handedOff = true;
        onSettled();
      }
    }

    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }

  raf = requestAnimationFrame(frame);

  return {
    settle(results) {
      if (released || disposed) return;
      for (const [i, d] of dice.entries()) {
        const result = results[i];
        if (!result) continue;
        const upIdx = upFaceIndex(d.rig.normals, d.traj[d.traj.length - 1].q);
        d.rig.paint(upIdx, result.value);
        d.rig.faceNormal = d.rig.normals[upIdx].clone();
        if (!result.kept) d.rig.fade();
      }
      // The flourish belongs to the first KEPT natural 20 (or natural 1) on a
      // d20 — a discarded advantage die must not set off the crit.
      if (!reducedMotion) {
        const critAt = dice.findIndex(
          (d, i) => d.rig.sides === 20 && results[i]?.kept && results[i]?.value === 20,
        );
        const fumbleAt = dice.findIndex(
          (d, i) => d.rig.sides === 20 && results[i]?.kept && results[i]?.value === 1,
        );
        if (critAt >= 0) {
          hero = dice[critAt];
          flourish = 'crit';
        } else if (fumbleAt >= 0) {
          hero = dice[fumbleAt];
          flourish = 'fumble';
        }
      }
      released = true;
      releasedAt = performance.now();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      for (const d of dice) {
        d.rig.group.traverse((obj) => {
          const mesh = obj as THREE.Mesh;
          if (mesh.geometry) mesh.geometry.dispose();
        });
        for (const m of d.rig.materials) m.dispose();
      }
      for (const g of shadowGeos) g.dispose();
      for (const m of shadowMats) m.dispose();
      ringGeo.dispose();
      ringMat.dispose();
      sparkGeo.dispose();
      for (const m of sparkMats) m.dispose();
      tex.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
