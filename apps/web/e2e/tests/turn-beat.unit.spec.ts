import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { formatDocumentTitle, setDocumentTitlePrefix } from '../../src/app/routeFocus';
import { isCampaignEvent } from '../../src/lib/useCampaignEvents';
import { detectSseTurnBeat, detectTurnBeat, shouldConsumeTurnBeatResync, turnBeatKey, type TurnBeatSnapshot } from '../../src/features/encounters/turnBeat';

const initial: TurnBeatSnapshot = {
  encounterId: 8,
  combatantId: 12,
  round: 1,
  isYourTurn: false,
};

test.describe('turn-change beat (issue #1906)', () => {
  test('uses an initial snapshot as a silent baseline and does not replay refetches', () => {
    expect(detectTurnBeat(null, initial)).toBeNull();
    expect(detectTurnBeat(initial, initial)).toBeNull();
    expect(turnBeatKey(initial)).toBe('8:12:1');
  });

  test('preserves an SSE edge that precedes the initial encounter baseline', () => {
    expect(detectSseTurnBeat(null, initial)).toBe('turn');
    expect(detectSseTurnBeat(initial, initial)).toBeNull();
  });

  test('clears a previous encounter baseline on encounter switch, and only resyncs it from a REST refetch on load or reconnect (issue #2092)', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/features/encounters/RunSessionPage.tsx'), 'utf8');
    expect(source).toMatch(/previousTurnBeatRef\.current = null;\s*awaitingTurnBeatResyncRef\.current = turnBeatLoadWatermark\.readRevision;\s*ownedTurnFeedbackRef\.current = null;\s*setTurnOwnerFromEvent\(null\);\s*setTurnOwnerPendingCombatantId\(null\);\s*setTurnBeat\(null\);\s*setTurnPulse\(false\);/);
    expect(source).toMatch(/const previous = previousTurnBeatRef\.current\?\.encounterId === eid\s*\? previousTurnBeatRef\.current\s*:\s*null;/);
    expect(source).toMatch(/const completedRead = latestEncounterReadRef\.current;\s*if \(!completedRead \|\| completedRead\.encounterId !== eid\) return;\s*if \(!shouldConsumeTurnBeatResync\(\s*awaitingTurnBeatResyncRef\.current,\s*completedRead\.revision,\s*\)\) return;\s*awaitingTurnBeatResyncRef\.current = null;[\s\S]*previousTurnBeatRef\.current = \{/);
    expect(source).not.toContain('previousTurnBeatRef.current?.encounterId === eid ||');
  });

  test('captures the actual-read watermark before useQuery can finish the mount refetch', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/features/encounters/RunSessionPage.tsx'), 'utf8');
    const watermarkCapture = source.indexOf('const [turnBeatLoadWatermark, setTurnBeatLoadWatermark] = useState');
    const encounterQuery = source.indexOf('const encounterQuery = useQuery({');

    expect(watermarkCapture).toBeGreaterThan(-1);
    expect(watermarkCapture).toBeLessThan(encounterQuery);
    expect(source).toMatch(/const \[turnBeatLoadWatermark, setTurnBeatLoadWatermark\] = useState\(\(\) => \(\{\s*encounterId: eid,\s*readRevision: encounterReadRevisionRef\.current,\s*\}\)\);/);
    expect(source).toMatch(/if \(turnBeatLoadWatermark\.encounterId !== eid\) \{\s*setTurnBeatLoadWatermark\(\{\s*encounterId: eid,\s*readRevision: encounterReadRevisionRef\.current,\s*\}\);\s*\}/);
  });

  test('consumes a resync only after a newer successful encounter query function completes', () => {
    expect(shouldConsumeTurnBeatResync(null, 20)).toBe(false);
    expect(shouldConsumeTurnBeatResync(20, 20)).toBe(false);
    expect(shouldConsumeTurnBeatResync(20, 21)).toBe(true);
  });

  test('does not let an optimistic cache write impersonate the catch-up encounter read', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/features/encounters/RunSessionPage.tsx'), 'utf8');
    const encounterQueryStart = source.indexOf('const encounterQuery = useQuery({');
    const encounterQueryEnd = source.indexOf('const encounter = encounterQuery.data ?? null;', encounterQueryStart);
    const encounterQueryBody = source.slice(encounterQueryStart, encounterQueryEnd);

    expect(encounterQueryBody).toMatch(/const reconciled = reconcileEncounterPatchResponse\([\s\S]*?await api\.get<EncounterWithCombatants>/);
    expect(encounterQueryBody).toMatch(/encounterReadRevisionRef\.current = revision;\s*latestEncounterReadRef\.current = \{ revision, encounterId: eid, encounter: reconciled \};\s*setEncounterReadRevision\(revision\);\s*return reconciled;/);
    expect(source.match(/encounterReadRevisionRef\.current = revision;/g)).toHaveLength(1);
    expect(source).not.toContain('shouldConsumeTurnBeatResync(\n      awaitingTurnBeatResyncRef.current,\n      encounterQuery.dataUpdatedAt');
  });

  // Issue #2092: `dataUpdatedAt` records when a response LANDED, not when the server
  // captured it. So a catch-up GET issued at reconnect can still land AFTER the live
  // `encounter.turn_changed` frame it raced, and would then overwrite the newer
  // SSE-established baseline with pre-turn state — leaving the next edge compared against
  // a stale baseline (misread as a round wrap, or dropped as a no-op). The SSE handler
  // therefore disarms the pending resync at the same point it establishes the baseline: a
  // live turn frame is by construction at least as fresh as any GET already in flight.
  //
  // (A window this PR left partly open rather than introduced — on main the resync effect
  // re-ran on EVERY refetch, so the same overwrite could happen far more often.)
  test('an SSE turn edge disarms a pending REST resync so a late catch-up read cannot overwrite it', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/features/encounters/RunSessionPage.tsx'), 'utf8');
    // The disarm must sit with the SSE baseline write itself, not somewhere it can be skipped.
    expect(source).toMatch(/previousTurnBeatRef\.current = next;[\s\S]{0,700}?awaitingTurnBeatResyncRef\.current = null;/);

    // And once disarmed, the gate refuses every completed-fetch shape — including a fetch
    // strictly newer than the one that armed it, which is precisely the late catch-up read.
    expect(shouldConsumeTurnBeatResync(null, 21)).toBe(false);
    expect(shouldConsumeTurnBeatResync(null, Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  // Issue #2092: this REST-driven baseline resync used to re-run on EVERY `encounter`
  // change, including the ordinary refetch that `encounter.updated` triggers alongside
  // (and always before) the very `encounter.turn_changed` frame that updates the SAME ref
  // directly. Whichever settled first won the race — a fast local GET could "catch up" to
  // the new turn before the SSE frame's own handler ran, making `detectTurnBeat` see
  // `previous === next` and silently drop the takeover/ticker beat. Gating the resync
  // behind a one-shot ref (consumed on load, re-armed only by reconnect/stream-recovery)
  // removes the race: an ordinary `encounter.updated`-triggered refetch no longer touches
  // the baseline at all.
  test('only re-arms the REST turn-beat baseline resync after a reconnect or stream recovery', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/features/encounters/RunSessionPage.tsx'), 'utf8');
    expect(source).toMatch(/const awaitingTurnBeatResyncRef = useRef<number \| null>\(0\);/);
    const reconnectStart = source.indexOf('onReconnect: useCallback');
    const reconnectBranch = source.slice(reconnectStart, source.indexOf('onStreamRecovery: useCallback', reconnectStart));
    expect(reconnectBranch).toContain('awaitingTurnBeatResyncRef.current = encounterReadRevisionRef.current;');
    const recoveryStart = source.indexOf('onStreamRecovery: useCallback');
    const recoveryBranch = source.slice(recoveryStart, source.indexOf('onStatusChange: useCallback', recoveryStart));
    expect(recoveryBranch).toContain('awaitingTurnBeatResyncRef.current = encounterReadRevisionRef.current;');
  });

  // Issue #2092: the Next Turn button re-enables (`headerBusy` tracks only
  // `nextTurnMut.isPending`) the instant the mutation's own POST resolves — well before
  // `onSettled`'s invalidate-triggered GET has round-tripped. A second next-turn click in
  // that window built `expectedCurrentCombatantId` from the still-stale cached
  // `encounter.currentCombatantId`, so the server's own CAS guard rejected the DM's own very
  // next legitimate click with 409 TURN_ALREADY_ADVANCED — no `encounter.turn_changed` frame
  // was ever emitted for the rejected click, which is what actually made the OTHER client's
  // takeover/ticker look like it "never updated". The mutation response IS the advanced
  // encounter (same shape as GET) — seed the cache with it synchronously in `onSuccess`.
  test('seeds the encounter cache with the next-turn response before the button can re-fire (issue #2092)', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/features/encounters/RunSessionPage.tsx'), 'utf8');
    const nextTurnMutStart = source.indexOf('const nextTurnMut = useKeyedMutation({');
    const nextTurnMutBody = source.slice(nextTurnMutStart, source.indexOf('const undoTurnMut', nextTurnMutStart));
    expect(nextTurnMutBody).toMatch(/api\.post<EncounterWithCombatants>\(`\$\{API\}\/encounters\/\$\{eid\}\/next-turn`/);
    expect(nextTurnMutBody).toMatch(/onSuccess: \(data\) => \{\s*const seeded = queryClient\.setQueryData<EncounterWithCombatants>\(\s*queryKeys\.encounter\(eid\),\s*\(current: EncounterWithCombatants \| undefined\) => preferNewerEncounterSnapshot\(\s*current,\s*reconcileEncounterPatchResponse\(data, pendingEncounterPatches\.current\.values\(\), '', eid\),\s*\),\s*\);/);
  });

  test('orders a delayed encounter PATCH response against the seeded turn before replacing the cache', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/features/encounters/RunSessionPage.tsx'), 'utf8');
    const setMapStart = source.indexOf('const setMap = useMutation({');
    const setMapBody = source.slice(setMapStart, source.indexOf('const mutateQueuedPatch', setMapStart));

    expect(setMapBody).toMatch(/onSuccess: \(updated, variables\) => \{[\s\S]*?setQueryData<EncounterWithCombatants>\(queryKeys\.encounter\(variables\.encounterId\), \(current\) =>\s*preferNewerEncounterSnapshot\(\s*current,\s*reconcileEncounterPatchResponse\(updated, pendingEncounterPatches\.current\.values\(\), variables\.queueId, variables\.encounterId\),\s*\),\s*\);/);
  });

  test('emits an undo edge after a silent refetch baseline advances past a missed frame', () => {
    const missed = { ...initial, combatantId: 13 };
    expect(detectTurnBeat(initial, missed)).toBe('turn');
    expect(detectSseTurnBeat(missed, initial)).toBe('turn');
  });

  test('detects an owned edge once per combatant and round', () => {
    const yours = { ...initial, combatantId: 15, isYourTurn: true };
    expect(detectTurnBeat(initial, yours)).toBe('your-turn');
    expect(detectTurnBeat(yours, yours)).toBeNull();
    expect(detectTurnBeat(yours, { ...yours, round: 2 })).toBe('your-turn');
  });

  test('renders an active-removal successor frame as a fresh owned turn', () => {
    const successor = { ...initial, combatantId: 15, isYourTurn: true };
    expect(detectSseTurnBeat(initial, successor)).toBe('your-turn');
  });

  test('classifies ordinary changes and round wraps for the viewer-safe ticker', () => {
    expect(detectTurnBeat(initial, { ...initial, combatantId: 13 })).toBe('turn');
    expect(detectTurnBeat(initial, { ...initial, combatantId: 13, round: 2 })).toBe('round-wrap');
    expect(detectTurnBeat(initial, { ...initial, combatantId: null, round: 2 })).toBe('round-wrap');
    expect(detectTurnBeat({ ...initial, combatantId: null }, { ...initial, combatantId: null, round: 2 })).toBe('round-wrap');
  });

  test('clears a prior beat for an unnamed same-round lair action', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/features/encounters/RunSessionPage.tsx'), 'utf8');
    expect(detectSseTurnBeat(initial, { ...initial, combatantId: null })).toBe('turn');
    expect(source).toMatch(/if \(kind && \(combatant \|\| event\.currentCombatantId != null \|\| tickerKind === 'round-wrap'\)\) \{[\s\S]*\} else if \(kind\) \{[\s\S]*setTurnBeat\(null\);/);
  });

  test('clears owned state and refreshes /turn when the poll observes no active combatant', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/features/encounters/RunSessionPage.tsx'), 'utf8');
    expect(source).toMatch(/if \(currentCombatantId === undefined\) \{[\s\S]*setTurnOwnerFromEvent\(null\);[\s\S]*setTurnOwnerPendingCombatantId\(null\);[\s\S]*void queryClient\.invalidateQueries\(\{ queryKey: queryKeys\.encounterTurn\(eid\) \}\);/);
  });

  test('does not use a prior combatant\'s /turn result as the hidden-tab fallback', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/features/encounters/RunSessionPage.tsx'), 'utf8');
    expect(source).toMatch(/turnWorkspace\?\.current\?\.combatantId === currentCombatantId\s*&&\s*turnWorkspace\?\.isYourTurn === true/);
    expect(source).toMatch(/turnOwnerFromEvent != null && turnOwnerFromEvent\.combatantId === turnBeat\?\.combatantId\s*\? turnOwnerFromEvent\.isYourTurn/);
  });

  test('releases a pending owner marker when the workspace confirms a polled actor change', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/features/encounters/RunSessionPage.tsx'), 'utf8');
    expect(source).toMatch(/turnWorkspace\.current\?\.combatantId !== turnOwnerPendingCombatantId\) \{\s*if \(turnWorkspace\.current\?\.combatantId === currentCombatantId\) \{\s*setTurnOwnerPendingCombatantId\(null\);/);
  });

  test('relies on the paired encounter update while refreshing only /turn for a turn edge', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/features/encounters/RunSessionPage.tsx'), 'utf8');
    const start = source.indexOf("if (event.type === 'encounter.turn_changed')");
    const turnChangedBranch = source.slice(
      start,
      source.indexOf('return;\n        }', start),
    );
    expect(turnChangedBranch).toContain('queryKeys.encounterTurn(eid)');
    expect(turnChangedBranch).not.toContain('invalidateEncounter(queryClient, eid);');
  });

  test('accepts the optional turn_changed frame fields and rejects malformed values', () => {
    expect(isCampaignEvent({
      type: 'encounter.turn_changed', campaignId: 2, encounterId: 8, at: '2026-08-05T00:00:00.000Z',
      round: 2, currentCombatantId: 15, combatantKind: 'character',
    })).toBe(true);
    expect(isCampaignEvent({
      type: 'encounter.turn_changed', campaignId: 2, encounterId: 8, at: '2026-08-05T00:00:00.000Z',
      round: 2, currentCombatantId: 15, combatantKind: 'monster', turnReverted: true,
    })).toBe(true);
    expect(isCampaignEvent({
      type: 'encounter.turn_changed', campaignId: 2, encounterId: 8, at: '2026-08-05T00:00:00.000Z',
      round: -1,
    })).toBe(false);
    expect(isCampaignEvent({
      type: 'encounter.turn_changed', campaignId: 2, encounterId: 8, at: '2026-08-05T00:00:00.000Z',
      turnReverted: false,
    })).toBe(false);
  });

  test('title prefix is retained when RouteChangeFocus formats a replacement title', () => {
    setDocumentTitlePrefix('● Your turn — ');
    expect(formatDocumentTitle({ page: 'Encounters', campaignName: 'Cinderhaven' }))
      .toBe('● Your turn — Encounters · Cinderhaven · Campfire');
    setDocumentTitlePrefix(null);
    expect(formatDocumentTitle({ page: 'Encounters', campaignName: 'Cinderhaven' }))
      .toBe('Encounters · Cinderhaven · Campfire');
  });

  test('clears a takeover when the following beat is not owned', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/features/encounters/TurnChangeBeat.tsx'), 'utf8');
    expect(source).toMatch(/if \(!beat\) \{\s*setShowTakeover\(false\);\s*setShowTicker\(false\);/);
    expect(source).toMatch(/if \(!beat \|\| beat\.pending \|\| beat\.kind !== 'your-turn' \|\| !isYourTurn\) \{\s*setShowTakeover\(false\);/);
  });

  test('skips owned-turn vibration when reduced motion is preferred', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/features/encounters/TurnChangeBeat.tsx'), 'utf8');
    expect(source).toMatch(/if \(!reducedMotion && typeof navigator !== 'undefined' && typeof navigator\.vibrate === 'function'\)/);
  });

  test('keeps the transient takeover click-through and pulses only its active vitals card', () => {
    const takeover = readFileSync(resolve(process.cwd(), 'src/features/encounters/TurnChangeBeat.tsx'), 'utf8');
    const vitals = readFileSync(resolve(process.cwd(), 'src/features/encounters/PlayerVitalsHeader.tsx'), 'utf8');
    expect(takeover).not.toMatch(/data-testid="turn-takeover"[\s\S]*pointer-events-auto/);
    expect(takeover).not.toMatch(/data-testid="turn-takeover"[\s\S]*onClick/);
    expect(vitals).toMatch(/turnPulse && c\.id === currentCombatantId \? 'cf-turn-beat-pulse'/);
  });

  test('clears turn ownership and transient cues when combat stops', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/features/encounters/RunSessionPage.tsx'), 'utf8');
    expect(source).toMatch(/if \(encounter\?\.status === 'running'\) return;\s*ownedTurnFeedbackRef\.current = null;\s*setTurnOwnerFromEvent\(null\);\s*setTurnOwnerPendingCombatantId\(null\);\s*setTurnBeat\(null\);/);
    expect(source).toMatch(/isYourTurn=\{encounter\?\.status === 'running'\s*&&/);
  });

  test('keeps ownership unknown until an SSE combatant is present in the cached roster', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/features/encounters/RunSessionPage.tsx'), 'utf8');
    expect(source).toMatch(/const rosterCombatantKnown = event\.currentCombatantId == null \|\| combatant != null;/);
    expect(source).toMatch(/const ownerKnown = rosterCombatantKnown && \(ownerDataReady \|\| combatant\?\.characterId == null\);/);
    expect(source).toMatch(/setTurnOwnerPendingCombatantId\(ownerKnown \? null : event\.currentCombatantId \?\? null\);/);
    expect(source).toMatch(/pending: combatant == null && event\.currentCombatantId != null,/);
  });

  test('does not promote a turn from character ownership data pending refresh', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/features/encounters/RunSessionPage.tsx'), 'utf8');
    expect(source).toMatch(/const characterOwnershipPendingDataUpdatedAtRef = useRef<number \| null>\(null\);/);
    expect(source).toMatch(/const invalidateCampaignCharactersForOwnership = useCallback\(\(\) => \{\s*characterOwnershipPendingDataUpdatedAtRef\.current = charactersQuery\.dataUpdatedAt;[\s\S]*?invalidateCampaignCharacters\(queryClient, cid\);/);
    expect(source).toMatch(/charactersQuery\.dataUpdatedAt <= pendingDataUpdatedAt/);
    expect(source).toMatch(/!charactersQuery\.isFetching\s*&&\s*characterOwnershipPendingDataUpdatedAtRef\.current == null/);
    expect(source).toMatch(/if \(characterOwnershipPendingDataUpdatedAtRef\.current != null\) return;/);
  });

  test('uses the ownership freshness watermark for reconnect, recovery, and membership revocation', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/features/encounters/RunSessionPage.tsx'), 'utf8');
    const inlineCharactersStart = source.indexOf('if (shouldInvalidateInlineCharacters(event))');
    const inlineCharactersBranch = source.slice(inlineCharactersStart, source.indexOf('// Issue #415:', inlineCharactersStart));
    expect(inlineCharactersBranch).toContain('invalidateCampaignCharactersForOwnership();');
    expect(inlineCharactersBranch).not.toContain('invalidateCampaignCharacters(queryClient, cid);');

    const reconnectBranch = source.slice(source.indexOf('onReconnect: useCallback'), source.indexOf('onReconnect: useCallback') + 600);
    expect(reconnectBranch).toContain('invalidateCampaignCharactersForOwnership();');

    const recoveryBranch = source.slice(source.indexOf('onStreamRecovery: useCallback'), source.indexOf('onStreamRecovery: useCallback') + 500);
    expect(recoveryBranch).toContain('invalidateCampaignCharactersForOwnership();');
  });

  test('immediately gates existing ownership cues while the roster refreshes', () => {
    const page = readFileSync(resolve(process.cwd(), 'src/features/encounters/RunSessionPage.tsx'), 'utf8');
    const beat = readFileSync(resolve(process.cwd(), 'src/features/encounters/TurnChangeBeat.tsx'), 'utf8');
    expect(page).toMatch(/const \[characterOwnershipRefreshPending, setCharacterOwnershipRefreshPending\] = useState\(false\);/);
    expect(page).toMatch(/setCharacterOwnershipRefreshPending\(true\);\s*setTurnOwnerFromEvent\(null\);\s*setTurnOwnerPendingCombatantId\(null\);\s*setTurnPulse\(false\);/);
    expect(page).toMatch(/isYourTurn=\{encounter\?\.status === 'running'\s*&&\s*!characterOwnershipRefreshPending/);
    expect(page).toMatch(/!turnBeat\s*\|\| characterOwnershipPendingDataUpdatedAtRef\.current != null\s*\|\| turnWorkspace\.isYourTurn !== true/);
    expect(beat).toMatch(/if \(!beat \|\| beat\.pending \|\| beat\.kind !== 'your-turn' \|\| !isYourTurn\) \{\s*setShowTakeover\(false\);/);
  });

  test('promotes ownership only once for a beat after a roster refresh', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/features/encounters/TurnChangeBeat.tsx'), 'utf8');
    expect(source).toMatch(/const takeoverPlayedForBeatRef = useRef<number \| null>\(null\);/);
    expect(source).toMatch(/if \(takeoverPlayedForBeatRef\.current === beat\.key\) return;/);
    expect(source).toMatch(/takeoverPlayedForBeatRef\.current = beat\.key;\s*setShowTakeover\(true\);/);
    expect(source).toMatch(/\}, \[beat\]\);\s*\/\/ Ownership can settle after the edge/);
  });

  test('keeps Player Display to the paired encounter update load', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/features/screen/PlayerDisplayPage.tsx'), 'utf8');
    expect(source).toMatch(/if \(event\.type === 'encounter\.turn_changed'\) return;/);
  });

  test('replays the owned pulse and safe workspace scroll when a pending beat promotes', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/features/encounters/RunSessionPage.tsx'), 'utf8');
    expect(source).toMatch(/const triggerOwnedTurnFeedback = useCallback\(\(beatKey: number\) => \{\s*if \(ownedTurnFeedbackRef\.current === beatKey\) return;/);
    expect(source).toMatch(/if \(!prefersReducedMotion\(\)\) \{\s*setTurnPulse\(true\);/);
    expect(source).toMatch(/querySelector<HTMLElement>\('\[data-testid="turn-workspace"\]'\)\?\.scrollIntoView\(\{/);
    expect(source).toMatch(/if \(kind === 'your-turn' && combatant\) \{\s*triggerOwnedTurnFeedback\(beatKey\);/);
    expect(source).toMatch(/turnBeat\.kind === 'your-turn'\s*\) return;\s*const nextBeatKey = \+\+turnBeatSequence\.current;\s*triggerOwnedTurnFeedback\(nextBeatKey\);/);
    expect(source).not.toMatch(/setTurnBeat\(\(previous\) =>[\s\S]*key: \+\+turnBeatSequence\.current/);
  });
});
