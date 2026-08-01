/**
 * Live-combat encounter surface i18n & catalog completeness unit tests (issue #1464).
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const EN_ENCOUNTERS = resolve(__dirname, '../../src/i18n/locales/en/encounters.json');
const TURN_WORKSPACE = resolve(__dirname, '../../src/features/encounters/TurnWorkspace.tsx');
const RUN_SESSION_PAGE = resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx');
const ACTION_USE_FLOW = resolve(__dirname, '../../src/features/encounters/ActionUseFlow.tsx');
const CHECK_REQUESTS = resolve(__dirname, '../../src/features/encounters/CheckRequests.tsx');
const WIZARD = resolve(__dirname, '../../src/features/encounters/GenerateEncounterWizard.tsx');
const PLAYER_DISPLAY = resolve(__dirname, '../../src/features/screen/PlayerDisplayPage.tsx');

test.describe('Encounter runner surface i18n extraction (issue #1464)', () => {
  test('all encounter components import useTranslation hook', () => {
    const files = [TURN_WORKSPACE, RUN_SESSION_PAGE, ACTION_USE_FLOW, CHECK_REQUESTS, WIZARD];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(src).toMatch(/useTranslation/);
    }
  });

  test('encounter runner user-facing verbs and copy use t() keys instead of hardcoded English literals', () => {
    const turnSrc = readFileSync(TURN_WORKSPACE, 'utf8');
    expect(turnSrc).toMatch(/t\(['"]encounters\.turn\.yourTurn['"]\)/);
    expect(turnSrc).toMatch(/t\(['"]encounters\.turn\.rollDeathSave['"]\)/);
    expect(turnSrc).toMatch(/t\(['"]encounters\.turn\.dyingTitle['"]\)/);
    expect(turnSrc).toMatch(/t\(['"]encounters\.turn\.endTurn['"]\)/);

    const runSrc = readFileSync(RUN_SESSION_PAGE, 'utf8');
    expect(runSrc).toMatch(/t\(['"]encounters\.runner\.rollInitiative['"]\)/);
    expect(runSrc).toMatch(/t\(['"]encounters\.runner\.start['"]\)/);
    expect(runSrc).toMatch(/t\(['"]encounters\.runner\.nextTurn['"]\)/);
    expect(runSrc).toMatch(/t\(['"]encounters\.runner\.end['"]\)/);
    expect(runSrc).toMatch(/t\(['"]encounters\.runner\.reopen['"]\)/);

    const actionSrc = readFileSync(ACTION_USE_FLOW, 'utf8');
    expect(actionSrc).toMatch(/t\(['"]encounters\.actionUse\.preview['"]\)/);
    expect(actionSrc).toMatch(/t\(['"]encounters\.actionUse\.apply['"]\)/);

    const checkSrc = readFileSync(CHECK_REQUESTS, 'utf8');
    expect(checkSrc).toMatch(/t\(['"]encounters\.checkRequests\.requestCheckKicker['"]\)/);
    expect(checkSrc).toMatch(/t\(['"]encounters\.checkRequests\.roll['"]\)/);

    const wizardSrc = readFileSync(WIZARD, 'utf8');
    expect(wizardSrc).toMatch(/t\(['"]encounters\.wizard\.title['"]\)/);
    expect(wizardSrc).toMatch(/t\(['"]encounters\.wizard\.createEncounter['"]\)/);
  });

  test('encounters.json contains required runner, turn, actionUse, checkRequests, wizard, and playerDisplay keys', () => {
    const json = JSON.parse(readFileSync(EN_ENCOUNTERS, 'utf8'));
    const enc = json.encounters;
    expect(enc.runner.rollInitiative).toBe('Roll initiative');
    expect(enc.runner.start).toBe('Start');
    expect(enc.runner.nextTurn).toBe('Next turn →');
    expect(enc.runner.end).toBe('End');
    expect(enc.runner.reopen).toBe('Reopen');

    expect(enc.turn.yourTurn).toBe('It’s your turn.');
    expect(enc.turn.rollDeathSave).toBe('🎲 Roll Death Save');
    expect(enc.turn.endTurn).toBe('End turn →');

    expect(enc.actionUse.preview).toBe('Preview');
    expect(enc.actionUse.apply).toBe('Apply');

    expect(enc.checkRequests.requestCheckKicker).toBe('Request a check');
    expect(enc.checkRequests.roll).toBe('Roll');

    expect(enc.wizard.title).toBe('Generate encounter');
    expect(enc.wizard.createEncounter).toBe('Create encounter');

    expect(enc.playerDisplay.hpBands.healthy).toBe('Healthy');
  });
});
