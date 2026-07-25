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
