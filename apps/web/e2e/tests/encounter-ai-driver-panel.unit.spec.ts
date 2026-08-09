/**
 * Encounter AI driver dock wiring (issue #427).
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const RUN_SESSION = resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx');
const ENCOUNTER_LIST = resolve(__dirname, '../../src/features/encounters/EncounterListPage.tsx');
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
    expect(panel).toMatch(/AiPathGuide/);
    expect(panel).toMatch(/onLifecycle\('start-session'\)/);
    expect(panel).toMatch(/onLifecycle\('wrap-up'\)/);
    expect(panel).toMatch(/composerLockedEnded/);
    expect(panel).toMatch(/newClientRef/);
    expect(panel).toMatch(/onUndoAiAction/);
    expect(panel).toMatch(/lastUndoableCommit/);
    expect(panel).toMatch(/characterName,/);
    expect(panel).toMatch(/displayText: text/);
    expect(panel).toMatch(/role="alert"/);
    expect(panel).toMatch(/narrationOwnerRef/);
    expect(panel).toMatch(/liveActivity\.transcriptFetched/);
    expect(panel).toMatch(/beginNarrationLogLive/);
    expect(panel).toMatch(/preHydrationLiveEntryIds/);
    expect(panel).toMatch(/transcriptGeneration/);
    expect(panel).toMatch(/resolveToolActivity/);
    expect(panel).toMatch(/formatSystem: \(systemAddition\) => systemText/);
    expect(panel).toMatch(/setNarrationStatus\(''\)/);
    expect(panel).toMatch(/charactersQuery\.isError/);
    expect(panel).toMatch(/myMembership\?\.characterId != null/);
    expect(panel).toMatch(/disabled=\{locked \|\| submitting \|\| playerAttributionPending\}/);
  });

  test('shared live activity carries transcript for the dock', () => {
    const hook = readFileSync(LIVE_ACTIVITY, 'utf8');
    expect(hook).toMatch(/transcript/);
    expect(hook).toMatch(/transcriptFetched/);
    expect(hook).toMatch(/dispatchTranscript/);
    expect(hook).toMatch(/transcriptReducer/);
    expect(hook).toMatch(/type: 'authoritative'/);
    expect(hook).toMatch(/ai-dm\/transcript\?limit=/);
    expect(hook).toMatch(/transcriptOwnerRef\.current !== ownerKey/);
    expect(hook).toMatch(/fetchTranscript\(key, lastSeqRef\.current \|\| undefined\)/);
    expect(hook).toMatch(/const effectiveRole = campaignId === undefined \? null : roleIn\(campaignId\)/);
    expect(hook).toMatch(/loadTranscript\(viewerId, campaignId, 'activity', effectiveRole\)/);
    expect(hook).toMatch(/clearTranscript\(viewerId, campaignId, 'activity'\)/);
    expect(hook).toMatch(/transcriptRequestGenerationRef/);
    expect(hook).toMatch(/transcriptOwnerRef\.current === key \? transcript : emptyTranscript/);
    expect(hook).toMatch(/transcriptEntryId\(event\.event\)/);
    expect(hook).toMatch(/\},\s*effectiveRole,/);
  });

  test('the empty encounter list retains a Driver session entry', () => {
    const list = readFileSync(ENCOUNTER_LIST, 'utf8');
    expect(list).toMatch(/liveActivity\.mode === 'driver'/);
    expect(list).toMatch(/encounter-list-live-session/);
    expect(list).toMatch(/navigate\(`\/c\/\$\{id\}\/table`\)/);
  });
});

test.describe('encounter AI driver panel surfaces tool confirmations (issue #1494)', () => {
  // #1494 — the confirm-policy mechanism (begin_encounter / end_encounter / award_xp / …)
  // already shipped server-side and already mounts a panel on AiTablePage (#1558). The residual
  // gap was the in-encounter dock: a DM mid-combat is on the encounter page, not the Table, so a
  // confirmation queued there was invisible — the exact silent stall the issue reports. These
  // assertions are the standing guard that the panel is mounted HERE too, not only on the Table.
  test('EncounterAiDriverPanel mounts ToolConfirmationsPanel inside the disclosure region', () => {
    const panel = readFileSync(PANEL, 'utf8');
    // Match the import and mount individually so a formatting change (line break, prop reorder)
    // does not break the guard — what matters is that the panel is imported and wired with these
    // props, not the exact single-line spelling.
    expect(panel).toMatch(/ToolConfirmationsPanel/);
    expect(panel).toMatch(/<ToolConfirmationsPanel[\s\S]*campaignId=\{campaignId\}/);
    expect(panel).toMatch(/isDm=\{isDm\}/);
    expect(panel).toMatch(/knownEntities=\{confirmationEntities\}/);
    // The id -> name lookup is assembled from data THIS panel already holds (the encounter's
    // combatants + the roster it fetches), mirroring AiTablePage — no extra, authority-broadening
    // fetch is added to make summaries prettier.
    expect(panel).toMatch(/confirmationEntities/);
    expect(panel).toMatch(/\.\.\.encounter\.combatants/);
  });
});
