import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  activeLifecycleStepId,
  encounterLifecycleSteps,
  ENCOUNTER_LIFECYCLE_STEPS,
  ENCOUNTER_NAME_HELP,
  ENCOUNTER_NAME_ID,
  ENCOUNTER_NAME_LABEL,
  playerGuidance,
  preparingGuidance,
} from '../../src/features/encounters/postCreateGuidance';

const RUN_SESSION = resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx');
const LIST_PAGE = resolve(__dirname, '../../src/features/encounters/EncounterListPage.tsx');

test.describe('post-create encounter guidance (issue #431 & #1470)', () => {
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

  test('playerGuidance provides status-specific copy for non-DM viewers (issue #1470)', () => {
    expect(playerGuidance({ status: 'preparing' })).toMatch(/waiting for the dm/i);
    expect(playerGuidance({ status: 'running', currentCombatantName: 'Ember' })).toBe("It's Ember's turn.");
    expect(playerGuidance({ status: 'running' })).toMatch(/combat in progress/i);
    expect(playerGuidance({ status: 'ended' })).toBe('Combat has ended.');
  });

  test('activeLifecycleStepId maps encounter status and roster state to step ids (issue #1470)', () => {
    expect(activeLifecycleStepId('preparing', { partyCombatantCount: 3, enemyCombatantCount: 0, needsInitiativeCount: 3 })).toBe('preparing');
    expect(activeLifecycleStepId('preparing', { partyCombatantCount: 3, enemyCombatantCount: 2, needsInitiativeCount: 5 })).toBe('initiative');
    expect(activeLifecycleStepId('running')).toBe('running');
    expect(activeLifecycleStepId('ended')).toBe('ended');
  });

  /**
   * Issue #2123: for a rule system with no initiative roll the DM cockpit renders no roll
   * control and the server refuses the write, so guidance that says "then roll initiative"
   * is an instruction that cannot be carried out. Same steps, renamed to what actually
   * establishes turn order on such a table.
   */
  test('guidance for a system with no initiative roll names the roster, not a roll', () => {
    const g = preparingGuidance({
      partyCombatantCount: 2,
      enemyCombatantCount: 1,
      hasMap: true,
      campaignHasActiveParty: true,
      campaignHasCompendium: true,
      initiativeRollSupported: false,
    });
    expect(g.nextSteps.some((s) => /roll initiative/i.test(s))).toBe(false);
    expect(g.nextSteps.some((s) => /turn order is the roster order/i.test(s))).toBe(true);
    expect(g.nextSteps.some((s) => /Preparing → Turn order → Running → Ended/i.test(s))).toBe(true);

    const noParty = preparingGuidance({
      partyCombatantCount: 0,
      enemyCombatantCount: 0,
      hasMap: false,
      campaignHasActiveParty: false,
      campaignHasCompendium: false,
      initiativeRollSupported: false,
    });
    expect(noParty.lead).toMatch(/turn order/i);
    expect(noParty.lead.toLowerCase()).not.toMatch(/roll initiative/);
  });

  test('the lifecycle checklist relabels only its middle step, keeping the same four step ids', () => {
    expect(encounterLifecycleSteps(true)).toEqual([...ENCOUNTER_LIFECYCLE_STEPS]);
    expect(encounterLifecycleSteps()).toEqual([...ENCOUNTER_LIFECYCLE_STEPS]);

    const noRoll = encounterLifecycleSteps(false);
    expect(noRoll.map((s) => s.id)).toEqual(ENCOUNTER_LIFECYCLE_STEPS.map((s) => s.id));
    const middle = noRoll.find((s) => s.id === 'initiative');
    expect(middle?.label).toBe('Turn order');
    expect(middle?.detail).toMatch(/roster/i);
    // Every other step is the same object content as the rolling variant.
    expect(noRoll.filter((s) => s.id !== 'initiative')).toEqual(
      ENCOUNTER_LIFECYCLE_STEPS.filter((s) => s.id !== 'initiative'),
    );
  });

  test('encounter name has a durable label and validation help', () => {
    expect(ENCOUNTER_NAME_LABEL).toBe('Encounter name');
    expect(ENCOUNTER_NAME_ID).toBe('encounter-name');
    expect(ENCOUNTER_NAME_HELP.toLowerCase()).toMatch(/required/);
  });

  test('RunSessionPage and EncounterListPage wire the guidance helpers and ended summary (issue #1470)', () => {
    const run = readFileSync(RUN_SESSION, 'utf8');
    expect(run).toMatch(/preparingGuidance/);
    expect(run).toMatch(/playerGuidance/);
    expect(run).toMatch(/activeLifecycleStepId/);
    expect(run).toMatch(/endedSummaryTallies/);
    expect(run).toMatch(/encounter-ended-summary/);
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

