import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const ENTITY_REVEAL_DIALOG = resolve(ROOT, 'src/components/EntityRevealDialog.tsx');
const ENTITY_SECRECY_CONTROLS = resolve(ROOT, 'src/components/EntitySecrecyControls.tsx');
const QUEST_PAGE = resolve(ROOT, 'src/features/quests/QuestPage.tsx');
const NPC_PAGE = resolve(ROOT, 'src/features/npcs/NpcPage.tsx');
const FACTION_PAGE = resolve(ROOT, 'src/features/factions/FactionPage.tsx');
const LOCATION_PAGE = resolve(ROOT, 'src/features/locations/LocationPage.tsx');

test.describe('entity reveal safety wiring (issue #710)', () => {
  test('EntityRevealDialog confirms audience, preview, and irreversible disclosure', () => {
    const source = readFileSync(ENTITY_REVEAL_DIALOG, 'utf8');
    expect(source).toMatch(/EntityRevealDialog/);
    expect(source).toMatch(/revealAudience/);
    expect(source).toMatch(/entity-reveal-preview/);
    expect(source).toMatch(/revealIrreversible/);
    expect(source).toMatch(/ConfirmDialog/);
  });

  test('EntitySecrecyControls gates reveal behind dialog and offers Undo', () => {
    const source = readFileSync(ENTITY_SECRECY_CONTROLS, 'utf8');
    expect(source).toMatch(/EntityRevealDialog/);
    expect(source).toMatch(/UndoSnackbar/);
    expect(source).toMatch(/entity-reveal-trigger/);
    expect(source).toMatch(/secrecyGroupLabel/);
  });

  for (const [pageName, path] of [
    ['QuestPage', QUEST_PAGE],
    ['NpcPage', NPC_PAGE],
    ['FactionPage', FACTION_PAGE],
    ['LocationPage', LOCATION_PAGE],
  ] as const) {
    test(`${pageName} uses EntitySecrecyControls instead of immediate reveal`, () => {
      const source = readFileSync(path, 'utf8');
      expect(source).toMatch(/EntitySecrecyControls/);
      expect(source).not.toMatch(/toggleHidden/);
    });
  }
});
