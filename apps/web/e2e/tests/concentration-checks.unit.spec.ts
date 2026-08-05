import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect } from '@playwright/test';

const RUN_SESSION_PAGE = resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx');
const COMBATANT_ROW = resolve(__dirname, '../../src/features/encounters/combat/CombatantRow.tsx');

function encounterSources(): string {
  return [readFileSync(RUN_SESSION_PAGE, 'utf8'), readFileSync(COMBATANT_ROW, 'utf8')].join('\n');
}

test.describe('concentration checks (issue #606)', () => {
  test('derives the prompt from persisted combatant turn state', () => {
    const source = encounterSources();
    expect(source).toContain('combatant.turnState.pendingConcentrationChecks');
    expect(source).toContain('pendingConcentrationCheck.dc');
    expect(source).toContain('pendingConcentrationCheck.damage');
    expect(source).not.toContain('setPendingConcentrationChecks');
    expect(source).not.toContain('response.concentrationCheck');
  });

  test('only exposes resolution controls through existing DM/owner permission', () => {
    const source = encounterSources();
    expect(source).toContain('canEditCombatantPermission(combatant)');
    expect(source).toContain('canResolveConcentrationCheck');
    expect(source).toContain('Waiting for the DM or this combatant');
    expect(source).toContain("combatant.kind === 'character'");
  });

  test('submits explicit first-request pass and fail resolutions', () => {
    const source = encounterSources();
    expect(source).toContain('resolveConcentrationCheck');
    expect(source).toContain("outcome: 'pass'");
    expect(source).toContain("outcome: 'fail'");
    expect(source).toContain('id: pendingConcentrationCheck.id');
    expect(source).toContain('disabled={combatantTurnState.isPending}');
  });
});
