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
    expect(panel).toMatch(/return \(\) => \{ narrationOwnerRef\.current = ''; \}/);
    expect(panel).toMatch(/composerOwnerRef/);
    expect(panel).toMatch(/return \(\) => \{ composerOwnerRef\.current = ''; \}/);
    expect(panel).toMatch(/const submissionOwner = composerOwnerRef\.current/);
    expect(panel).toMatch(/const submissionGeneration = liveActivity\.getTranscriptGeneration\(\)/);
    expect(panel).toMatch(/composerOwnerRef\.current !== submissionOwner/);
    expect(panel).toMatch(/liveActivity\.getTranscriptGeneration\(\) !== submissionGeneration/);
    expect(panel).toMatch(/composerOwnerRef\.current === submissionOwner/);
    expect(panel).toMatch(/composerOwnerRef\.current = owner;[\s\S]{0,500}\}, \[campaignId, isDm, liveActivity\.mode, me\?\.user\.id, myMembership\?\.role\]\);/);
    expect(panel).toMatch(/catch \(err\) \{\s*if \(composerOwnerRef\.current === submissionOwner\)/);
    expect(panel).toMatch(/finally \{\s*if \(composerOwnerRef\.current === submissionOwner\) setSubmitting\(false\);/);
    expect(panel).toMatch(/setInput\(''\);[\s\S]{0,120}setSceneField\(''\);[\s\S]{0,120}setSubmitting\(false\);[\s\S]{0,120}setSubmitError\(null\);[\s\S]{0,120}setPauseBusy\(false\);[\s\S]{0,120}setPauseError\(null\);[\s\S]{0,120}setLifecycleBusy\(false\);[\s\S]{0,120}setLifecycleError\(null\);[\s\S]{0,120}setUndoBusy\(false\);[\s\S]{0,120}setUndoError\(null\);/);
    expect(panel).toMatch(/const owner = composerOwnerRef\.current/);
    expect(panel).toMatch(/if \(composerOwnerRef\.current === owner\) invalidateAiDm/);
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
    expect(hook).toMatch(/preHydrationLiveEntryIdsRef/);
    expect(hook).toMatch(/type: 'reconcileInitialAuthoritative'/);
    expect(hook).toMatch(/if \(watermark === undefined\) \{[\s\S]{0,700}clearTranscript\(viewerId, campaignId, 'activity'\);[\s\S]{0,400}type: 'reconcileInitialAuthoritative'/);
    expect(hook).toMatch(/const getTranscriptGeneration = useCallback\(\(\) => transcriptGenerationRef\.current, \[\]\)/);
    expect(hook).toMatch(/event\.type === 'transcript\.reset'[\s\S]{0,700}advanceTranscriptGeneration\(\);/);
    expect(hook).toMatch(/err instanceof ApiError/);
    expect(hook).toMatch(/err\.status === 403 \|\| err\.status === 404/);
    expect(hook).toMatch(/clearTranscript\(viewerId, campaignId\);/);
    expect(hook).toMatch(/clearTranscript\(viewerId, campaignId, 'activity'\);/);
    expect(hook).toMatch(/\+\+transcriptRequestGenerationRef\.current/);
    expect(hook).toMatch(/event\.type === 'transcript\.reset'[\s\S]{0,700}clearTranscript\(viewerId, campaignId\);[\s\S]{0,200}clearTranscript\(viewerId, campaignId, 'activity'\);/);
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

test.describe('encounter AI driver panel parity with /table (issue #2193)', () => {
  // #2193 — the driver cockpit tab must offer the SAME two capabilities /table does, reusing the
  // existing implementations rather than reimplementing them: the UndoSnackbar commit-undo lever
  // (the one-click reversal of an AI-driven world change the moment it lands) and the transcript
  // privacy toggle (the per-user device grant). A DM who never leaves the cockpit tab must not
  // silently lose either. These guards pin the wiring to the shared helpers so neither capability
  // can quietly regress, and so a future "consolidate the two surfaces" change cannot delete the
  // shared seam without turning this red.
  test('EncounterAiDriverPanel wires the UndoSnackbar commit-undo lever on the same path as /table', () => {
    const panel = readFileSync(PANEL, 'utf8');
    // The same shared lever helper AiTablePage uses — not a reimplementation.
    expect(panel).toMatch(/nextUndoLeverState/);
    // The snackbar is gated on a freshly-armed commit, rendered for a DM, and wired to the same
    // /ai-dm/undo POST path (onUndoAiAction) the persistent header button uses.
    expect(panel).toMatch(/DriverLastUndoableCommit/);
    expect(panel).toMatch(/isDm && undoSnackbar && \(/);
    expect(panel).toMatch(/<UndoSnackbar[\s\S]*onUndo=\{onUndoAiAction\}/);
    expect(panel).toMatch(/onExpire=\{\(\) => setUndoSnackbar\(null\)\}/);
    // Dismiss on success and on a 404 (already reversed) — the authority is the server.
    expect(panel).toMatch(/outcome\.dismissSnackbar\) setUndoSnackbar\(null\)/);
  });

  test('EncounterAiDriverPanel wires the transcript privacy toggle on the same device grant as /table', () => {
    const panel = readFileSync(PANEL, 'utf8');
    // The grant is per-user-per-device and shared with /table: read and written through the same
    // helpers, so flipping it here governs both surfaces' caches identically.
    expect(panel).toMatch(/isTranscriptRememberEnabled/);
    expect(panel).toMatch(/setTranscriptRemember\(viewerId, next\)/);
    // The toggle is rendered (disabled only before /me resolves, not by role), mirroring /table.
    expect(panel).toMatch(/checked=\{rememberTranscript\}/);
    expect(panel).toMatch(/disabled=\{viewerId === null\}/);
    expect(panel).toMatch(/onChange=\{onToggleRememberTranscript\}/);
    // Turning it ON writes what is on screen at once, under the activity scope + role projection
    // the shared provider persists on every change — not a separate table-scope write.
    expect(panel).toMatch(/saveTranscript\(viewerId, campaignId, transcript, 'activity', effectiveRole\)/);
    // The viewer identity comes from the same latch /table uses, so nothing hydrates before /me.
    expect(panel).toMatch(/usePendingHydrate\(\{ ready: authReady, userId: me\?\.user\.id \?\? null \}\)/);
  });
});
