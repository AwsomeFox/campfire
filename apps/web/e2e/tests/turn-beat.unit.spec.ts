import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { formatDocumentTitle, setDocumentTitlePrefix } from '../../src/app/routeFocus';
import { isCampaignEvent } from '../../src/lib/useCampaignEvents';
import { detectSseTurnBeat, detectTurnBeat, turnBeatKey, type TurnBeatSnapshot } from '../../src/features/encounters/turnBeat';

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

  test('clears a previous encounter baseline and silently updates it from an encounter refetch', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/features/encounters/RunSessionPage.tsx'), 'utf8');
    expect(source).toMatch(/previousTurnBeatRef\.current = null;\s*ownedTurnFeedbackRef\.current = null;\s*setTurnOwnerFromEvent\(null\);\s*setTurnOwnerPendingCombatantId\(null\);\s*setTurnBeat\(null\);\s*setTurnPulse\(false\);/);
    expect(source).toMatch(/const previous = previousTurnBeatRef\.current\?\.encounterId === eid\s*\? previousTurnBeatRef\.current\s*:\s*null;/);
    expect(source).toMatch(/if \(!encounter \|\| encounter\.id !== eid\) return;[\s\S]*previousTurnBeatRef\.current = \{/);
    expect(source).not.toContain('previousTurnBeatRef.current?.encounterId === eid ||');
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
