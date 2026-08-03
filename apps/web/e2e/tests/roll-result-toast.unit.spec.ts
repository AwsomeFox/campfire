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

  // Issue #1904 review finding (codex): a non-5e ruleset's individual initiative die (e.g.
  // Starforged's 1d6) is a positive, non-d20, non-"heal"/"cure"-labeled expression — exactly
  // what this heuristic treats as damage-suitable. This is NOT a bug in the heuristic to
  // patch with an "initiative" label check (that only moves the same guess one word along
  // for the next non-d20 roll kind); it is the reason ShowRollOptions.applyDisabled exists to
  // bypass this heuristic structurally at the call site instead. This test documents the gap
  // the structural fix protects against, not a desired outcome to "fix" here.
  test('a non-d20 initiative roll is misread as damage-suitable by the heuristic alone — this is exactly why callers that know better must bypass it via applyDisabled, not a smarter label match', () => {
    expect(looksLikeDamageRoll(roll({ expr: '1d6', total: 4, label: 'Zephyr · Initiative' }))).toBe(true);
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
    expect(cssSource).toMatch(/var\(--cf-keyboard-inset/);
  });

  test('toast reuses shared roll flourish classes', () => {
    expect(toastSource).toMatch(/d20TotalClasses/);
    expect(toastSource).toMatch(/d20Flavor/);
  });

  test('provider wires apply shortcut through looksLikeDamageRoll', () => {
    expect(contextSource).toMatch(/looksLikeDamageRoll/);
    expect(contextSource).toMatch(/useRollApplyDamageBridge/);
    expect(contextSource).toMatch(/rollApplyHandler/);
    expect(contextSource).toMatch(/useUndoSnackbarChrome/);
  });

  test('useRoller and SharedDiceLog call showRoll after a local roll', () => {
    const rollerSource = readFileSync(resolve(ROOT, 'src/lib/useRoller.ts'), 'utf8');
    const logSource = readFileSync(resolve(ROOT, 'src/features/dice/SharedDiceLog.tsx'), 'utf8');
    const cardSource = readFileSync(resolve(ROOT, 'src/components/CharacterStatCard.tsx'), 'utf8');
    expect(rollerSource).toMatch(/showRoll\(result/);
    expect(rollerSource).toMatch(/showRoll\(res\.roll\)/);
    expect(rollerSource).toMatch(/beginRollAnimation\(expr\)/);
    expect(logSource).toMatch(/showRoll\(result\)/);
    expect(logSource).toMatch(/beginRollAnimation\(cleaned\)/);
    expect(cardSource).toMatch(/onApply: onApplyDamage/);
  });

  // Issue #1904 review finding: the per-combatant initiative roll must structurally opt out
  // of the apply-damage bridge — not rely on looksLikeDamageRoll ever concluding "not damage"
  // for a non-d20 initiative die under some ruleset.
  test('applyDisabled bypasses the damage heuristic unconditionally, and the combatant-initiative roll call site sets it', () => {
    expect(contextSource).toMatch(/applyDisabled/);
    // canApply must gate on !rollApplyDisabled BEFORE consulting looksLikeDamageRoll/handler
    // presence — a structural veto, not one more heuristic input among several.
    expect(contextSource).toMatch(/!rollApplyDisabled\s*&&/);
    expect(contextSource).toMatch(/if \(rollApplyDisabled\) return;/);

    const runSessionSource = readFileSync(resolve(ROOT, 'src/features/encounters/RunSessionPage.tsx'), 'utf8');
    expect(runSessionSource).toMatch(/showRoll\(data\.roll, \{ applyDisabled: true \}\)/);
  });

  // Issue #1904 review finding (devin): `roll` is null specifically for a HIDDEN encounter
  // (the shared dice log deliberately gets no row for it) — the roll still happened, so
  // cancelling the animation into nothing left the DM (the only one who can reach it) with
  // no result at all. A local, never-persisted DiceRoll synthesized from the committed
  // breakdown must still reach showRoll instead.
  test('a hidden-encounter roll (null shared roll) still shows a result via a synthesized local DiceRoll, not cancelRollAnimation', () => {
    const runSessionSource = readFileSync(resolve(ROOT, 'src/features/encounters/RunSessionPage.tsx'), 'utf8');
    // The onSuccess handler must branch on data.roll and, in the null case, build a local
    // DiceRoll from data.combatant.initiativeBreakdown and route it through showRoll — a bare
    // cancelRollAnimation() with no substitute toast is exactly the bug this guards against.
    expect(runSessionSource).toMatch(/const breakdown = data\.combatant\.initiativeBreakdown;/);
    expect(runSessionSource).toMatch(/const localRoll: DiceRoll = \{/);
    expect(runSessionSource).toMatch(/showRoll\(localRoll, \{ applyDisabled: true \}\)/);
  });
});
