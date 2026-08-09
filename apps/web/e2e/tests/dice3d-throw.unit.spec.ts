import { expect, test } from '@playwright/test';
import * as THREE from 'three';
import { dieFaceNormals, nudgeApart, simulate, upFaceIndex } from '../../src/features/dice/dice3d';
import { faceValues } from '../../src/features/dice/dice3dFaces';

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

test.describe('separation nudge', () => {
  /** A throw whose recorded frames already graze both walls. */
  function grazingThrow() {
    return {
      traj: [
        { p: new THREE.Vector3(WALL_X, 2.4, WALL_Z), q: new THREE.Quaternion() },
        { p: new THREE.Vector3(-WALL_X, 1.6, -WALL_Z), q: new THREE.Quaternion() },
        { p: new THREE.Vector3(3.0, REST, 1.2), q: new THREE.Quaternion() },
      ],
      rest: REST,
    };
  }

  test('keeps every frame inside the walls, not just the resting one', () => {
    const subject = grazingThrow();
    // A die resting almost on top of the subject's, so the push is at full strength.
    const placed = [
      { traj: [{ p: new THREE.Vector3(3.05, REST, 1.25), q: new THREE.Quaternion() }], rest: REST },
    ];

    nudgeApart(subject.traj, placed, REST);

    for (const [i, fr] of subject.traj.entries()) {
      expect(Math.abs(fr.p.x), `frame ${i} shifted past the side wall`).toBeLessThanOrEqual(WALL_X);
      expect(Math.abs(fr.p.z), `frame ${i} shifted past the end wall`).toBeLessThanOrEqual(WALL_Z);
    }
    const landed = subject.traj[subject.traj.length - 1].p;
    // The resting die must sit FULLY inside, not merely have its centre in bounds.
    expect(Math.abs(landed.x)).toBeLessThanOrEqual(WALL_X - REST + 1e-9);
    expect(Math.abs(landed.z)).toBeLessThanOrEqual(WALL_Z - REST + 1e-9);
  });

  test('leaves a throw alone when nothing is resting near it', () => {
    const subject = grazingThrow();
    const before = subject.traj.map((f) => f.p.clone());
    nudgeApart(subject.traj, [
      { traj: [{ p: new THREE.Vector3(-3.0, REST, -1.2), q: new THREE.Quaternion() }], rest: REST },
    ], REST);
    subject.traj.forEach((f, i) => {
      expect(f.p.x).toBeCloseTo(before[i].x, 10);
      expect(f.p.z).toBeCloseTo(before[i].z, 10);
    });
  });

  test('separates dice that would otherwise rest inside each other', () => {
    const a = {
      traj: [{ p: new THREE.Vector3(0, REST, 0), q: new THREE.Quaternion() }],
      rest: REST,
    };
    const b = {
      traj: [{ p: new THREE.Vector3(0.2, REST, 0), q: new THREE.Quaternion() }],
      rest: REST,
    };
    nudgeApart(b.traj, [a], REST);
    const gap = Math.hypot(b.traj[0].p.x - a.traj[0].p.x, b.traj[0].p.z - a.traj[0].p.z);
    expect(gap).toBeGreaterThan(0.2);
  });
});
