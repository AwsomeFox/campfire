/**
 * Post-create encounter guidance + accessible naming (issue #431).
 *
 * New encounters auto-add the active party; the preparing banner must say so
 * and never ask the DM to "Add the party" again. The create form needs a real
 * Encounter name label (not placeholder-only).
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ENCOUNTER_LIFECYCLE_STEPS,
  ENCOUNTER_NAME_HELP,
  ENCOUNTER_NAME_ID,
  ENCOUNTER_NAME_LABEL,
  preparingGuidance,
} from '../../src/features/encounters/postCreateGuidance';

const RUN_SESSION = resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx');
const LIST_PAGE = resolve(__dirname, '../../src/features/encounters/EncounterListPage.tsx');

test.describe('post-create encounter guidance (issue #431)', () => {
  test('auto-added party lead never asks to add the party again', () => {
    const g = preparingGuidance({
      partyCombatantCount: 3,
      enemyCombatantCount: 0,
      hasMap: false,
      campaignHasActiveParty: true,
      campaignHasCompendium: true,
    });
    expect(g.lead).toMatch(/active party was added automatically/i);
    expect(g.lead).toMatch(/enemies or reinforcements/i);
    expect(g.lead.toLowerCase()).not.toMatch(/add the party/);
    expect(g.nextSteps.some((s) => /Compendium/i.test(s))).toBe(true);
    expect(g.nextSteps.some((s) => /battle map/i.test(s))).toBe(true);
    expect(g.nextSteps.some((s) => /Preparing → Initiative → Running → Ended/i.test(s))).toBe(true);
  });

  test('tailors empty/next-step copy to party/compendium/map state', () => {
    const noParty = preparingGuidance({
      partyCombatantCount: 0,
      enemyCombatantCount: 0,
      hasMap: true,
      campaignHasActiveParty: false,
      campaignHasCompendium: false,
    });
    expect(noParty.lead).toMatch(/no active party/i);
    expect(noParty.nextSteps.some((s) => /Manual or NPC/i.test(s))).toBe(true);
    expect(noParty.nextSteps.some((s) => /Place tokens/i.test(s))).toBe(true);

    const withEnemies = preparingGuidance({
      partyCombatantCount: 2,
      enemyCombatantCount: 1,
      hasMap: true,
      campaignHasActiveParty: true,
      campaignHasCompendium: true,
    });
    expect(withEnemies.nextSteps.some((s) => /roll initiative/i.test(s))).toBe(true);
  });

  test('lifecycle checklist covers preparing → initiative → running → ended', () => {
    expect(ENCOUNTER_LIFECYCLE_STEPS.map((s) => s.id)).toEqual([
      'preparing',
      'initiative',
      'running',
      'ended',
    ]);
  });

  test('encounter name has a durable label and validation help', () => {
    expect(ENCOUNTER_NAME_LABEL).toBe('Encounter name');
    expect(ENCOUNTER_NAME_ID).toBe('encounter-name');
    expect(ENCOUNTER_NAME_HELP.toLowerCase()).toMatch(/required/);
  });

  test('RunSessionPage and EncounterListPage wire the guidance helpers', () => {
    const run = readFileSync(RUN_SESSION, 'utf8');
    expect(run).toMatch(/preparingGuidance/);
    expect(run).toMatch(/encounter-preparing-guidance/);
    expect(run).toMatch(/encounter-lifecycle-checklist/);
    expect(run).not.toMatch(/Add the party &amp; monsters below/);

    const list = readFileSync(LIST_PAGE, 'utf8');
    expect(list).toMatch(/ENCOUNTER_NAME_LABEL/);
    expect(list).toMatch(/ENCOUNTER_CREATE_PREFIX/);
    expect(list).toMatch(/<Field[\s\S]*name=\{ENCOUNTER_FIELD\.name\}/);
    expect(list).toMatch(/ENCOUNTER_NAME_HELP/);
  });
});
