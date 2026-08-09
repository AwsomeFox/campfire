import { expect, test } from '@playwright/test';
import * as THREE from 'three';
import { simulate, upFaceIndex } from '../../src/features/dice/dice3d';
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

/** Face normals of an icosahedral d20, clustered exactly as the roller does. */
function d20Normals(): THREE.Vector3[] {
  const geo = new THREE.IcosahedronGeometry(1.15);
  const pos = geo.getAttribute('position');
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < pos.count; i += 3) {
    const a = new THREE.Vector3().fromBufferAttribute(pos, i);
    const b = new THREE.Vector3().fromBufferAttribute(pos, i + 1);
    const c = new THREE.Vector3().fromBufferAttribute(pos, i + 2);
    out.push(
      new THREE.Vector3()
        .subVectors(b, a)
        .cross(new THREE.Vector3().subVectors(c, a))
        .normalize(),
    );
  }
  geo.dispose();
  return out;
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

  test('the rolled value ends on the face that lands up', () => {
    const normals = d20Normals();
    expect(normals).toHaveLength(20);
    for (let i = 0; i < 200; i++) {
      const frames = simulate(throwN(i), REST);
      const landed = frames[frames.length - 1].q;
      const upIdx = upFaceIndex(normals, landed);
      const value = (i % 20) + 1;
      const painted = faceValues(20, value, upIdx, normals.length);

      expect(painted[upIdx], `throw ${i} rolling ${value}`).toBe(value);
      // upFaceIndex must genuinely pick the highest face, not merely a valid one:
      // the alignment step rotates THIS face flat, so picking a side face would
      // tip the die onto a number nobody rolled.
      const ys = normals.map((n) => n.clone().applyQuaternion(landed).y);
      expect(ys[upIdx]).toBe(Math.max(...ys));
    }
  });
});
