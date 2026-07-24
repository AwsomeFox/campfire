import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DiceRoll } from '@campfire/schema';
import { looksLikeDamageRoll } from '../../src/lib/looksLikeDamageRoll';

const ROOT = resolve(__dirname, '../..');

function roll(partial: Partial<DiceRoll> & Pick<DiceRoll, 'expr' | 'total'>): Pick<DiceRoll, 'expr' | 'total' | 'label'> {
  return partial;
}

test.describe('looksLikeDamageRoll (issue #1315)', () => {
  test('positive non-d20 dice expression is damage-suitable', () => {
    expect(looksLikeDamageRoll(roll({ expr: '2d6+4', total: 11 }))).toBe(true);
    expect(looksLikeDamageRoll(roll({ expr: '1d8', total: 5 }))).toBe(true);
  });

  test('d20 expressions are not damage-suitable', () => {
    expect(looksLikeDamageRoll(roll({ expr: '1d20+5', total: 18 }))).toBe(false);
    expect(looksLikeDamageRoll(roll({ expr: '2d20kh1+3', total: 22 }))).toBe(false);
  });

  test('zero or negative totals are not damage-suitable', () => {
    expect(looksLikeDamageRoll(roll({ expr: '1d4-1', total: 0 }))).toBe(false);
    expect(looksLikeDamageRoll(roll({ expr: '2d6', total: -1 }))).toBe(false);
  });

  test('explicit damage label qualifies even when expr is ambiguous', () => {
    expect(
      looksLikeDamageRoll(
        roll({ expr: '2d6+4', total: 9, label: 'Brixi · Greatsword damage' }),
      ),
    ).toBe(true);
  });

  test('flat modifier-only expressions are not damage-suitable', () => {
    expect(looksLikeDamageRoll(roll({ expr: '+3', total: 3 }))).toBe(false);
  });
});

test.describe('RollResultToast component contract (issue #1315)', () => {
  const toastSource = readFileSync(resolve(ROOT, 'src/components/RollResultToast.tsx'), 'utf8');
  const contextSource = readFileSync(resolve(ROOT, 'src/components/RollResultToastContext.tsx'), 'utf8');
  const cssSource = readFileSync(resolve(ROOT, 'src/index.css'), 'utf8');

  test('toast exposes stable test ids and corner positioning', () => {
    expect(toastSource).toMatch(/data-testid="roll-result-toast"/);
    expect(toastSource).toMatch(/data-testid="roll-result-apply"/);
    expect(toastSource).toMatch(/data-testid="roll-result-toast-dismiss"/);
    expect(toastSource).toMatch(/cf-roll-result-toast/);
    expect(cssSource).toMatch(/\.cf-roll-result-toast/);
    expect(cssSource).toMatch(/var\(--cf-layer-snackbar\)/);
  });

  test('toast reuses shared roll flourish classes', () => {
    expect(toastSource).toMatch(/d20TotalClasses/);
    expect(toastSource).toMatch(/d20Flavor/);
  });

  test('provider wires apply shortcut through looksLikeDamageRoll', () => {
    expect(contextSource).toMatch(/looksLikeDamageRoll/);
    expect(contextSource).toMatch(/useRollApplyDamageBridge/);
  });

  test('useRoller and SharedDiceLog call showRoll after a local roll', () => {
    const rollerSource = readFileSync(resolve(ROOT, 'src/lib/useRoller.ts'), 'utf8');
    const logSource = readFileSync(resolve(ROOT, 'src/features/dice/SharedDiceLog.tsx'), 'utf8');
    expect(rollerSource).toMatch(/showRoll\(result\)/);
    expect(rollerSource).toMatch(/showRoll\(res\.roll\)/);
    expect(logSource).toMatch(/showRoll\(result\)/);
  });
});
