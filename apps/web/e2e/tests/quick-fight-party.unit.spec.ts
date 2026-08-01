/**
 * Cold start to "roll for initiative" friction reduction (issue #1477).
 *
 * Asserts source contracts for default encounter name, "Add whole party" bulk control,
 * and "Quick fight" direct action path.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ENCOUNTER_LIST_PAGE = resolve(__dirname, '../../src/features/encounters/EncounterListPage.tsx');
const RUN_SESSION_PAGE = resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx');
const EN_LOCALE = resolve(__dirname, '../../src/i18n/locales/en/encounters.json');

test.describe('cold start to roll for initiative optimization (issue #1477)', () => {
  const encounterList = readFileSync(ENCOUNTER_LIST_PAGE, 'utf8');
  const runSession = readFileSync(RUN_SESSION_PAGE, 'utf8');
  const locale = JSON.parse(readFileSync(EN_LOCALE, 'utf8')) as { encounters?: Record<string, string> };

  test('EncounterListPage provides default name and single-tap creation', () => {
    expect(encounterList).toMatch(/defaultEncounterName/);
    expect(encounterList).toMatch(/Untitled encounter/);
    expect(encounterList).toMatch(/data-testid="encounter-create-form"/);
    // Create button is no longer disabled on empty name input because of prefilled default.
    expect(encounterList).toMatch(/<Btn type="submit" disabled=\{saving\}>/);
  });

  test('EncounterListPage provides a Quick fight option for one-tap fight setup', () => {
    expect(encounterList).toMatch(/handleQuickFight/);
    expect(encounterList).toMatch(/data-testid="quick-fight-button"/);
    expect(encounterList).toMatch(/Quick fight -/);
    expect(locale.encounters?.quickFight).toBe('Quick fight');
  });

  test('RunSessionPage provides an Add whole party bulk button in the Party tab', () => {
    expect(runSession).toMatch(/addAllFromParty/);
    expect(runSession).toMatch(/data-testid="add-whole-party-button"/);
    expect(locale.encounters?.addWholeParty).toBe('Add whole party ({{count}})');
  });
});
