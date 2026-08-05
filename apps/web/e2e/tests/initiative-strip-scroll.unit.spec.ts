/**
 * Initiative-strip auto-scroll contracts (issue #1956).
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const RUN_SESSION_PAGE = resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx');

test.describe('initiative strip scroll (issue #1956)', () => {
  test('scrolls from a current-combatant transition, not the callback ref on same-current rerenders', () => {
    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');
    const initiativeStrip = source.slice(source.indexOf('function InitiativeStrip'), source.indexOf('function hpLogActorId'));

    expect(initiativeStrip).toMatch(/const combatantRefs = useRef\(new Map<number, HTMLDivElement>\(\)\)/);
    expect(initiativeStrip).toMatch(/useLayoutEffect\(\(\) => \{[\s\S]*currentCombatantId[\s\S]*scrollIntoView[\s\S]*\}, \[currentCombatantId\]\)/);
    expect(initiativeStrip).toMatch(/behavior: scrollBehavior\(\)/);
    expect(initiativeStrip).not.toMatch(/if \(isCurrent && el\)[\s\S]*scrollIntoView/);
  });
});
