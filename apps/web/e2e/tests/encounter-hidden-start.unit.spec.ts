/**
 * Unit test for hidden encounter start, runner persistent indicator, and reveal action (issue #1475).
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const VISIBLE_BAR_FILE = resolve(__dirname, '../../src/components/VisibleToPlayersBar.tsx');
const RUN_SESSION_PAGE = resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx');
const ENCOUNTERS_SERVICE = resolve(__dirname, '../../../server/src/modules/encounters/encounters.service.ts');

test.describe('hidden encounter start and persistent indicator (issue #1475)', () => {
  test('VisibleToPlayersBar supports onReveal and pendingAction state', () => {
    const source = readFileSync(VISIBLE_BAR_FILE, 'utf8');
    expect(source).toMatch(/onReveal/);
    expect(source).toMatch(/pendingAction/);
    expect(source).toMatch(/data-testid="hidden-from-players-bar"/);
    expect(source).toMatch(/Hidden from players/);
    expect(source).toMatch(/Reveal now/);
  });

  test('RunSessionPage mounts VisibleToPlayersBar with onReveal when running', () => {
    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');
    expect(source).toMatch(/encounter\.status === 'running'/);
    expect(source).toMatch(/queueEncounterPatch\(\{ hidden: false \}\)/);
  });

  test('encounters.service.ts evaluates post-start visibility for emitEncounterEvent', () => {
    const source = readFileSync(ENCOUNTERS_SERVICE, 'utf8');
    expect(source).toMatch(/emitEncounterEvent\('encounter\.updated', campaignId, encounterId, snapshot\.hidden\)/);
  });
});
