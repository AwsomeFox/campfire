import { expect, test } from '@playwright/test';
import * as THREE from 'three';
import { DICE_ROLL_MAX_SETTLE_MS } from '../../src/components/DiceRollOverlay';
import {
  dieFaceNormals,
  dieScaleFor,
  dieFootprintRadius,
  dieSupportRadius,
  dieVertices,
  separateRestingPlaces,
  separationGap,
  simulate,
  upFaceIndex,
} from '../../src/features/dice/dice3d';
import { faceValues } from '../../src/features/dice/dice3dFaces';
import { MAX_RENDERED_DICE } from '../../src/features/dice/renderedDice';
import {
  dieDelayMs,
  LINGER_MS_FLOURISH,
  MAX_ANIMATION_MS,
  MAX_TOTAL_STAGGER_MS,
  MAX_TRAJECTORY_MS,
  STAGGER_MS,
} from '../../src/features/dice/dice3dTiming';

/**
 * The throw and the numbering meet here. `simulate` decides where the die comes
 * to rest, `upFaceIndex` reads which face that leaves pointing up, and
 * `faceValues` paints the rolled number onto exactly that face. If the three
 * ever disagree, the player watches a d20 settle on a number the server did not
 * roll — the animation still looks fine, and the result is silently wrong.
 *
 * Physics-shaped assertions live here too: a throw that never comes to rest, or
 * one that ends outside the tray walls, is a die the player watches jitter or
 * never sees at all.
 */

const REST = 0.96;
/** Matches the walls the roller integrates against. */
const WALL_X = 3.3;
const WALL_Z = 1.5;

/** Every side count the server's dice grammar accepts. */
const SERVER_SIDES = [2, 4, 6, 8, 10, 12, 20, 100];

/** Deterministic stand-ins for the roller's randomized throws. */
function throwN(i: number) {
  const f = (k: number) => ((Math.sin(i * 12.9898 + k * 78.233) * 43758.5453) % 1 + 1) % 1;
  return {
    pos: new THREE.Vector3((f(1) - 0.5) * 4, 3.6 + f(2) * 0.9, -0.9 + f(3) * 0.5),
    quat: new THREE.Quaternion().setFromEuler(
      new THREE.Euler(f(4) * 6.3, f(5) * 6.3, f(6) * 6.3),
    ),
    vel: new THREE.Vector3((f(7) - 0.5) * 3.4, -1.4 - f(8), 2.2 + f(9) * 1.4),
    spin: new THREE.Vector3((f(10) - 0.5) * 22, (f(11) - 0.5) * 22, (f(12) - 0.5) * 22),
  };
}

test.describe('recorded throw', () => {
  test('always comes to rest on the floor, inside the tray walls', () => {
    for (let i = 0; i < 200; i++) {
      const frames = simulate(throwN(i), REST);
      const last = frames[frames.length - 1];
      expect(frames.length, `throw ${i} produced no frames`).toBeGreaterThan(0);
      expect(last.p.y, `throw ${i} ended above the floor`).toBeLessThanOrEqual(REST + 0.02);
      expect(Math.abs(last.p.x), `throw ${i} ended past the side wall`).toBeLessThanOrEqual(WALL_X);
      expect(Math.abs(last.p.z), `throw ${i} ended past the end wall`).toBeLessThanOrEqual(WALL_Z);
      // 420 frames is the integrator's hard cap; hitting it means the die never
      // settled and the overlay would hand off mid-tumble.
      expect(frames.length, `throw ${i} never settled`).toBeLessThan(420);
    }
  });

  test('the rolled value ends on the face that lands up, for every die the server allows', () => {
    for (const sides of SERVER_SIDES) {
      const normals = dieFaceNormals(sides);
      expect(normals.length, `d${sides} has no faces`).toBeGreaterThan(0);
      for (let i = 0; i < 60; i++) {
        const frames = simulate(throwN(i), REST);
        const landed = frames[frames.length - 1].q;
        const upIdx = upFaceIndex(normals, landed);
        const value = (i % sides) + 1;
        const painted = faceValues(sides, value, upIdx, normals.length);

        expect(painted[upIdx], `d${sides} throw ${i} rolling ${value}`).toBe(value);
        // upFaceIndex must genuinely pick the highest face, not merely a valid one:
        // the alignment step rotates THIS face flat, so picking a side face would
        // tip the die onto a number nobody rolled.
        const ys = normals.map((n) => n.clone().applyQuaternion(landed).y);
        expect(ys[upIdx]).toBe(Math.max(...ys));
      }
    }
  });

  test('a d100 is thrown on the ten-face percentile solid', () => {
    expect(dieFaceNormals(100)).toHaveLength(10);
    expect(dieFaceNormals(10)).toHaveLength(10);
    expect(dieFaceNormals(20)).toHaveLength(20);
    expect(dieFaceNormals(12)).toHaveLength(12);
    expect(dieFaceNormals(8)).toHaveLength(8);
    expect(dieFaceNormals(6)).toHaveLength(6);
    expect(dieFaceNormals(4)).toHaveLength(4);
  });
});

test.describe('timing budget', () => {
  test('no flight outruns MAX_TRAJECTORY_MS', () => {
    // MAX_ANIMATION_MS is built on this number, and the overlay's settle backstop
    // is built on that — so a change to gravity, bounce or the settle threshold
    // that lengthens flights would push the animation under its own guard and
    // strand dice in mid-air. Sampled across the scales the roller actually uses.
    let worst = 0;
    for (let i = 0; i < 400; i++) {
      for (const rest of [0.86 * 0.66, 0.96 * 0.82, 0.96 * 1.05]) {
        worst = Math.max(worst, (simulate(throwN(i), rest).length / 60) * 1000);
      }
    }
    expect(worst).toBeLessThanOrEqual(MAX_TRAJECTORY_MS);
  });

  test('the stagger stays inside its budget however many dice are thrown', () => {
    // The server caps dice per TERM at 20 but does not cap terms, so 20d6+20d6+20d6
    // is a legal 60-die roll. At a flat 70ms each the last die began falling 4.1s
    // in — past the old fixed backstop, so it was cut off having never landed.
    for (const count of [1, 2, 3, 8, 20, 60, 200]) {
      const last = dieDelayMs(count - 1, count);
      expect(last, `${count} dice`).toBeLessThanOrEqual(MAX_TOTAL_STAGGER_MS);
      expect(dieDelayMs(0, count), `${count} dice: first die waits`).toBe(0);
      for (let i = 1; i < count; i++) {
        expect(dieDelayMs(i, count), `${count} dice: die ${i} out of order`)
          .toBeGreaterThan(dieDelayMs(i - 1, count));
      }
    }
    // Small rolls keep the full, unhurried gap.
    expect(dieDelayMs(1, 2)).toBe(STAGGER_MS);
    expect(dieDelayMs(7, 8)).toBe(7 * STAGGER_MS);
  });

  test('the overlay backstop outlasts the longest legitimate roll', () => {
    expect(DICE_ROLL_MAX_SETTLE_MS).toBeGreaterThan(MAX_ANIMATION_MS);
    expect(MAX_ANIMATION_MS).toBeGreaterThanOrEqual(
      MAX_TOTAL_STAGGER_MS + MAX_TRAJECTORY_MS + LINGER_MS_FLOURISH,
    );
  });
});

test.describe('resting height', () => {
  test('every solid rests ON the tray, not above or through it', () => {
    // The support distance is NOT the footprint radius — they are only equal for a
    // sphere. Sharing one number floated the d8 a quarter of a radius off the tray
    // and sank the d4, whose numbered face up leaves a VERTEX down.
    for (const sides of SERVER_SIDES) {
      const support = dieSupportRadius(sides);
      expect(support, `d${sides} support`).toBeGreaterThan(0);
      const normals = dieFaceNormals(sides);
      // With the landing face rotated flat, the die's lowest point must touch the
      // floor exactly: no gap to hover over, no overlap to sink into.
      for (const [i, n] of normals.entries()) {
        const q = new THREE.Quaternion().setFromUnitVectors(n, new THREE.Vector3(0, 1, 0));
        let lowest = Infinity;
        for (const v of dieVertices(sides)) {
          lowest = Math.min(lowest, v.clone().applyQuaternion(q).y);
        }
        expect(support + lowest, `d${sides} on face ${i}`).toBeCloseTo(0, 6);
      }
    }
  });
});

/** Separating-axis test for two convex polygons on the tray floor. */
function polygonsOverlap(a: readonly number[][], b: readonly number[][]): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const j = (i + 1) % poly.length;
      const nx = -(poly[j][1] - poly[i][1]);
      const nz = poly[j][0] - poly[i][0];
      const project = (p: readonly number[][]) => p.map(([x, z]) => x * nx + z * nz);
      const A = project(a);
      const B = project(b);
      if (Math.max(...A) <= Math.min(...B) + 1e-9 || Math.max(...B) <= Math.min(...A) + 1e-9) {
        return false;
      }
    }
  }
  return true;
}

test.describe('footprint', () => {
  test('the footprint radius really does circumscribe the settled silhouette', () => {
    for (const sides of SERVER_SIDES) {
      const radius = dieFootprintRadius(sides);
      for (const normal of dieFaceNormals(sides)) {
        const flat = new THREE.Quaternion().setFromUnitVectors(normal, new THREE.Vector3(0, 1, 0));
        for (const v of dieVertices(sides)) {
          const settled = v.clone().applyQuaternion(flat);
          expect(Math.hypot(settled.x, settled.z), `d${sides} silhouette`)
            .toBeLessThanOrEqual(radius + 1e-9);
        }
      }
    }
  });

  test('settled d6 silhouettes never actually intersect', () => {
    // The property the separation gap is a PROXY for, tested directly. A cube
    // resting flat is a 1.62 square reaching 1.146 at the corners, so treating it
    // as radius 0.86 called dice clear that were visibly through each other
    // whenever their corners happened to face: 70 intersecting pairs across these
    // same counts, before the radius was measured rather than assumed.
    for (let count = 2; count <= MAX_RENDERED_DICE; count++) {
      const scale = dieScaleFor(count, dieFootprintRadius(6));
      const thrown = Array.from({ length: count }, (_, i) => ({
        traj: simulate(throwN(i * 7 + count), dieSupportRadius(6) * scale),
        radius: dieFootprintRadius(6) * scale,
      }));
      separateRestingPlaces(thrown);

      const half = 0.81 * scale;
      const silhouettes = thrown.map((t) => {
        const last = t.traj[t.traj.length - 1];
        const yaw = new THREE.Euler().setFromQuaternion(last.q, 'YXZ').y;
        const cos = Math.cos(yaw);
        const sin = Math.sin(yaw);
        return [[-half, -half], [half, -half], [half, half], [-half, half]].map(([x, z]) => [
          last.p.x + x * cos - z * sin,
          last.p.z + x * sin + z * cos,
        ]);
      });

      for (let i = 0; i < count; i++) {
        for (let j = i + 1; j < count; j++) {
          expect(
            polygonsOverlap(silhouettes[i], silhouettes[j]),
            `${count} d6: ${i} and ${j} intersect`,
          ).toBe(false);
        }
      }
    }
  });
});

test.describe('resting-place separation', () => {
  const at = (x: number, z: number) => ({
    traj: [{ p: new THREE.Vector3(x, REST, z), q: new THREE.Quaternion() }],
    radius: REST,
  });

  test('keeps every frame inside the walls, not just the resting one', () => {
    // A throw whose recorded frames already graze both walls, resting on top of
    // another die so the correction is at full strength.
    const subject = {
      traj: [
        { p: new THREE.Vector3(WALL_X, 2.4, WALL_Z), q: new THREE.Quaternion() },
        { p: new THREE.Vector3(-WALL_X, 1.6, -WALL_Z), q: new THREE.Quaternion() },
        { p: new THREE.Vector3(3.0, REST, 1.2), q: new THREE.Quaternion() },
      ],
      radius: REST,
    };
    separateRestingPlaces([subject, at(3.05, 1.25)]);

    for (const [i, fr] of subject.traj.entries()) {
      expect(Math.abs(fr.p.x), `frame ${i} shifted past the side wall`).toBeLessThanOrEqual(WALL_X);
      expect(Math.abs(fr.p.z), `frame ${i} shifted past the end wall`).toBeLessThanOrEqual(WALL_Z);
    }
    const landed = subject.traj[subject.traj.length - 1].p;
    // The resting die must sit FULLY inside, not merely have its centre in bounds.
    expect(Math.abs(landed.x)).toBeLessThanOrEqual(WALL_X - REST + 1e-9);
    expect(Math.abs(landed.z)).toBeLessThanOrEqual(WALL_Z - REST + 1e-9);
  });

  test('leaves dice that already rest clear exactly where they landed', () => {
    const a = at(3.0, 1.2);
    const b = at(-3.0, -1.2);
    const before = [a, b].map((t) => t.traj[0].p.clone());
    separateRestingPlaces([a, b]);
    [a, b].forEach((t, i) => {
      expect(t.traj[0].p.x).toBeCloseTo(before[i].x, 10);
      expect(t.traj[0].p.z).toBeCloseTo(before[i].z, 10);
    });
  });

  test('separates dice that would otherwise rest inside each other', () => {
    const a = at(0, 0);
    const b = at(0.2, 0);
    separateRestingPlaces([a, b]);
    const dist = Math.hypot(a.traj[0].p.x - b.traj[0].p.x, a.traj[0].p.z - b.traj[0].p.z);
    expect(dist).toBeGreaterThanOrEqual(separationGap(REST, REST) - 1e-6);
  });

  test('unstacks dice dropped at exactly the same spot', () => {
    const a = at(0, 0);
    const b = at(0, 0);
    const c = at(0, 0);
    separateRestingPlaces([a, b, c]);
    const gap = separationGap(REST, REST);
    for (const [p, q] of [[a, b], [a, c], [b, c]]) {
      const dist = Math.hypot(p.traj[0].p.x - q.traj[0].p.x, p.traj[0].p.z - q.traj[0].p.z);
      expect(dist).toBeGreaterThanOrEqual(gap - 1e-6);
    }
  });

  test('no two dice settle intersecting, for any roll size the server accepts', () => {
    // The end-to-end placement invariant through the real pipeline: scale,
    // simulate, separate. Fitting each die around the ones already down could not
    // hold this — an early die takes a spot and nothing can later reopen it, so a
    // crowded roll dead-ended with dice inside each other.
    // 60 is the ceiling the grammar allows (20 per term, terms uncapped).
    // Every count the grammar can produce, not a sample: the wedges this has to
    // survive are specific to how many dice land where, and a sampled count sails
    // past the one that knots up.
    for (let count = 2; count <= 60; count++) {
      const radius = 0.96;
      const rest = radius * dieScaleFor(count, radius);
      const thrown = Array.from({ length: count }, (_, i) => ({
        traj: simulate(throwN(i * 7 + count), rest),
        radius: rest,
      }));
      separateRestingPlaces(thrown);

      const gap = separationGap(rest, rest);
      const resting = thrown.map((t) => t.traj[t.traj.length - 1].p);
      // Reduced to one assertion per count rather than one per pair: at 60 dice
      // that is 1770 pairs, and asserting each turns a millisecond of arithmetic
      // into seconds of matcher overhead. The worst offender carries the message.
      let worst = { gap: Infinity, at: '' };
      let strayed = { over: 0, at: '' };
      for (let i = 0; i < count; i++) {
        const over = Math.max(Math.abs(resting[i].x) - WALL_X, Math.abs(resting[i].z) - WALL_Z);
        if (over > strayed.over) strayed = { over, at: `die ${i}` };
        for (let j = i + 1; j < count; j++) {
          const dist = Math.hypot(resting[i].x - resting[j].x, resting[i].z - resting[j].z);
          if (dist < worst.gap) worst = { gap: dist, at: `${i} and ${j}` };
        }
      }
      expect(strayed.over, `${count} dice: ${strayed.at} past a wall`).toBeLessThanOrEqual(1e-9);
      expect(worst.gap, `${count} dice: ${worst.at} intersect`).toBeGreaterThanOrEqual(gap - 1e-6);
    }
  });

  test('dice shrink only as far as the tray actually demands', () => {
    // The design's own sizes for small rolls must survive untouched.
    expect(dieScaleFor(1)).toBe(1.05);
    expect(dieScaleFor(2)).toBe(0.82);
    expect(dieScaleFor(3)).toBe(0.82);
    // Monotonic: a bigger handful never draws bigger dice.
    let prev = Infinity;
    for (let n = 1; n <= 60; n++) {
      const s = dieScaleFor(n);
      expect(s, `${n} dice grew`).toBeLessThanOrEqual(prev);
      expect(s, `${n} dice vanished`).toBeGreaterThan(0.05);
      prev = s;
    }
  });
});
