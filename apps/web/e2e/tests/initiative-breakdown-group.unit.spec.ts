import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const COMBATANT_ROW = resolve(ROOT, 'src/features/encounters/combat/CombatantRow.tsx');

test.describe('Initiative breakdown and group selector (#1476)', () => {
  test('combatant row renders initiative breakdown formula title and group selector', () => {
    const source = readFileSync(COMBATANT_ROW, 'utf8');

    // Asserts initiative element carries breakdown.formula title.
    expect(source).toMatch(/title=\{combatant\.initiativeBreakdown\?\.formula/);

    // Asserts initiative group select element exists with accessible label.
    expect(source).toMatch(/aria-label=\{`Initiative group for \$\{combatant\.name\}`\}/);
    expect(source).toMatch(/value=\{combatant\.initiativeGroup \?\?/);
    expect(source).toMatch(/<option value="party">Party<\/option>/);
    expect(source).toMatch(/<option value="monsters">Monsters<\/option>/);
  });
});
