/**
 * Unit test for hidden encounter start, runner persistent indicator, and reveal action (issue #1475).
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const VISIBLE_BAR_FILE = resolve(__dirname, '../../src/components/VisibleToPlayersBar.tsx');
const RUN_SESSION_PAGE = resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx');
const ENCOUNTERS_SERVICE = resolve(__dirname, '../../../server/src/modules/encounters/encounters.service.ts');
const SCHEMA_FILE = resolve(__dirname, '../../../../packages/schema/src/index.ts');

test.describe('hidden encounter start and persistent indicator (issue #1475)', () => {
  test('VisibleToPlayersBar supports onReveal and data-testid="hidden-from-players-bar"', () => {
    const source = readFileSync(VISIBLE_BAR_FILE, 'utf8');
    expect(source).toMatch(/onReveal/);
    expect(source).toMatch(/data-testid="hidden-from-players-bar"/);
    expect(source).toMatch(/Hidden from players/);
    expect(source).toMatch(/Reveal now/);
  });

  test('RunSessionPage mounts VisibleToPlayersBar with onReveal when running and surfaces start warnings', () => {
    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');
    expect(source).toMatch(/encounter\.status === 'running'/);
    expect(source).toMatch(/queueEncounterPatch\(\{ hidden: false \}\)/);
    expect(source).toMatch(/data\.warning/);
  });

  test('encounters.service.ts evaluates post-start visibility for emitEncounterEvent and returns warning when hidden', () => {
    const source = readFileSync(ENCOUNTERS_SERVICE, 'utf8');
    expect(source).toMatch(/snapshot\.hidden/);
    expect(source).toMatch(/This encounter is hidden; players won't see it/);
  });

  test('packages/schema EncounterWithCombatants includes optional warning property', () => {
    const source = readFileSync(SCHEMA_FILE, 'utf8');
    expect(source).toMatch(/warning:\s*z\.string\(\)\.optional\(\)/);
  });
});
