import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expandDiceSidesFromExpr, parseDiceGroupsFromExpr } from '../../src/lib/parseDiceSidesFromExpr';
import { buildOverlayDice } from '../../src/components/DiceRollOverlay';

const ROOT = resolve(__dirname, '../..');

test.describe('parseDiceSidesFromExpr (issue #1352)', () => {
  test('expands dice groups in expression order', () => {
    expect(parseDiceGroupsFromExpr('2d6+1d20')).toEqual([
      { count: 2, sides: 6 },
      { count: 1, sides: 20 },
    ]);
    expect(expandDiceSidesFromExpr('2d6+1d20')).toEqual([6, 6, 20]);
    expect(expandDiceSidesFromExpr('2d20kh1+3')).toEqual([20, 20]);
    expect(expandDiceSidesFromExpr('+5')).toEqual([]);
  });

  test('implicit die counts match server-accepted grammar', () => {
    expect(expandDiceSidesFromExpr('d20')).toEqual([20]);
    expect(expandDiceSidesFromExpr('d6+2')).toEqual([6]);
    expect(expandDiceSidesFromExpr('2d6+d8')).toEqual([6, 6, 8]);
  });
});

test.describe('buildOverlayDice (issue #1352)', () => {
  test('marks dropped dice on advantage settle', () => {
    const dice = buildOverlayDice([20, 20], [14, 18], [18]);
    expect(dice).toHaveLength(2);
    expect(dice[0].kept).toBe(false);
    expect(dice[1].kept).toBe(true);
    expect(dice[1].value).toBe(18);
  });
});

test.describe('Dice roll overlay contracts (issue #1352)', () => {
  const overlaySource = readFileSync(resolve(ROOT, 'src/components/DiceRollOverlay.tsx'), 'utf8');
  const contextSource = readFileSync(resolve(ROOT, 'src/components/RollResultToastContext.tsx'), 'utf8');
  const cssSource = readFileSync(resolve(ROOT, 'src/index.css'), 'utf8');
  const rollerSource = readFileSync(resolve(ROOT, 'src/lib/useRoller.ts'), 'utf8');
  const logSource = readFileSync(resolve(ROOT, 'src/features/dice/SharedDiceLog.tsx'), 'utf8');

  test('overlay exposes stable test id and tumble/land phases', () => {
    expect(overlaySource).toMatch(/data-testid="dice-roll-overlay"/);
    expect(overlaySource).toMatch(/data-phase=\{phase\}/);
    expect(overlaySource).toMatch(/cf-dice-roll-overlay__inner--tumble/);
    expect(overlaySource).toMatch(/cf-dice-roll-overlay__inner--land/);
    expect(cssSource).toMatch(/\.cf-dice-roll-overlay/);
    expect(cssSource).toMatch(/cf-die-overlay-tumble/);
    expect(cssSource).toMatch(/cf-die-overlay-land/);
  });

  test('3D roll is dynamically imported so three never lands in the entry chunk', () => {
    const viteSource = readFileSync(resolve(ROOT, 'vite.config.ts'), 'utf8');
    // A static `import ... from 'three'` anywhere the overlay is statically
    // reachable from would pull ~600KB into the first paint for every table,
    // including ones that never roll.
    expect(overlaySource).toMatch(/import\('\.\.\/features\/dice\/dice3d'\)/);
    expect(overlaySource).not.toMatch(/^import .* from 'three'/m);
    expect(readFileSync(resolve(ROOT, 'src/components/RollResultToastContext.tsx'), 'utf8'))
      .not.toMatch(/from 'three'/);
    expect(viteSource).toMatch(/vendor-three/);
  });

  test('overlay tears the 3D roll down and falls back without WebGL', () => {
    // startDiceRoll returns null when no WebGL context can be created; without
    // the fallback the roll would show an empty tray and never settle.
    expect(overlaySource).toMatch(/setCssFallback\(true\)/);
    expect(overlaySource).toMatch(/data-renderer=/);
    // Every mount allocates a WebGL context; leaking one per roll exhausts the
    // browser's context budget within a session.
    expect(overlaySource).toMatch(/handle\?\.dispose\(\)/);
    expect(cssSource).toMatch(/\.cf-dice-roll-overlay__canvas/);
  });

  test('a backgrounded tab still reaches the result toast', () => {
    // requestAnimationFrame is throttled to zero in a background tab, so the
    // 3D settle callback can never arrive; the toast must not be lost with it.
    expect(overlaySource).toMatch(/DICE_ROLL_MAX_SETTLE_MS/);
    expect(overlaySource).toMatch(/settledRef/);
  });

  test('provider gates overlay with prefersReducedMotion and wires begin/cancel/show', () => {
    expect(contextSource).toMatch(/prefersReducedMotion/);
    expect(contextSource).toMatch(/beginRollAnimation/);
    expect(contextSource).toMatch(/cancelRollAnimation/);
    expect(contextSource).toMatch(/DiceRollOverlay/);
    expect(contextSource).toMatch(/expandDiceSidesFromExpr/);
  });

  test('local roll paths call beginRollAnimation before POST', () => {
    expect(rollerSource).toMatch(/beginRollAnimation\(expr\)/);
    expect(rollerSource).toMatch(/cancelRollAnimation\(\)/);
    expect(logSource).toMatch(/beginRollAnimation\(cleaned\)/);
    expect(logSource).toMatch(/cancelRollAnimation\(\)/);
  });
});
