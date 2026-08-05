/**
 * Run-session active-row scroll contracts (issue #636).
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const RUN_SESSION_PAGE = resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx');
const COMBATANT_ROW = resolve(__dirname, '../../src/features/encounters/combat/CombatantRow.tsx');

test.describe('run session active row scroll (issue #636)', () => {
  test('RunSessionPage tracks row refs and scrolls on currentCombatantId while running', () => {
    const source = [readFileSync(RUN_SESSION_PAGE, 'utf8'), readFileSync(COMBATANT_ROW, 'utf8')].join('\n');
    expect(source).toMatch(/combatantRowRefs/);
    expect(source).toMatch(/setCombatantRowRef/);
    expect(source).toMatch(/useLayoutEffect/);
    expect(source).toMatch(/encounter\?\.status !== 'running'/);
    expect(source).toMatch(/data-current-turn/);
    expect(source).toMatch(/combatant-row-\$\{combatant\.id\}/);
  });
});
