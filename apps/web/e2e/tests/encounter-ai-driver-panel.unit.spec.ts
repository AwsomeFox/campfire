/**
 * Encounter AI driver dock wiring (issue #427).
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const RUN_SESSION = resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx');
const PANEL = resolve(__dirname, '../../src/features/ai-dm/EncounterAiDriverPanel.tsx');
const LIVE_ACTIVITY = resolve(__dirname, '../../src/features/ai-dm/useAiDmLiveActivity.tsx');

test.describe('encounter AI driver panel (issue #427)', () => {
  test('RunSessionPage mounts the collapsible driver dock in driver mode', () => {
    const run = readFileSync(RUN_SESSION, 'utf8');
    expect(run).toMatch(/EncounterAiDriverPanel/);
    expect(run).toMatch(/liveActivity\.mode === 'driver'/);
    expect(run).toMatch(/canCompose=\{canPlayerWrite\}/);
  });

  test('EncounterAiDriverPanel exposes transcript, composer, pause, and recovery', () => {
    const panel = readFileSync(PANEL, 'utf8');
    expect(panel).toMatch(/useDisclosure/);
    expect(panel).toMatch(/encounter-ai-driver-toggle/);
    expect(panel).toMatch(/encounter-ai-driver-composer/);
    expect(panel).toMatch(/StuckLadder/);
    expect(panel).toMatch(/useAiDmLiveActivity/);
    expect(panel).toMatch(/onTogglePause/);
    expect(panel).toMatch(/openTable/);
  });

  test('shared live activity carries transcript for the dock', () => {
    const hook = readFileSync(LIVE_ACTIVITY, 'utf8');
    expect(hook).toMatch(/transcript/);
    expect(hook).toMatch(/dispatchTranscript/);
    expect(hook).toMatch(/transcriptReducer/);
  });
});
