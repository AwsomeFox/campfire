import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { formatDocumentTitle, setDocumentTitlePrefix } from '../../src/app/routeFocus';
import { isCampaignEvent } from '../../src/lib/useCampaignEvents';
import { detectTurnBeat, turnBeatKey, type TurnBeatSnapshot } from '../../src/features/encounters/turnBeat';

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

  test('detects an owned edge once per combatant and round', () => {
    const yours = { ...initial, combatantId: 15, isYourTurn: true };
    expect(detectTurnBeat(initial, yours)).toBe('your-turn');
    expect(detectTurnBeat(yours, yours)).toBeNull();
    expect(detectTurnBeat(yours, { ...yours, round: 2 })).toBe('your-turn');
  });

  test('classifies ordinary changes and round wraps for the viewer-safe ticker', () => {
    expect(detectTurnBeat(initial, { ...initial, combatantId: 13 })).toBe('turn');
    expect(detectTurnBeat(initial, { ...initial, combatantId: 13, round: 2 })).toBe('round-wrap');
    expect(detectTurnBeat(initial, { ...initial, combatantId: null, round: 2 })).toBe('round-wrap');
  });

  test('accepts the optional turn_changed frame fields and rejects malformed values', () => {
    expect(isCampaignEvent({
      type: 'encounter.turn_changed', campaignId: 2, encounterId: 8, at: '2026-08-05T00:00:00.000Z',
      round: 2, currentCombatantId: 15, combatantKind: 'character',
    })).toBe(true);
    expect(isCampaignEvent({
      type: 'encounter.turn_changed', campaignId: 2, encounterId: 8, at: '2026-08-05T00:00:00.000Z',
      round: 2, currentCombatantId: 15, combatantKind: 'monster',
    })).toBe(true);
    expect(isCampaignEvent({
      type: 'encounter.turn_changed', campaignId: 2, encounterId: 8, at: '2026-08-05T00:00:00.000Z',
      round: -1,
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
    expect(source).toMatch(/if \(beat\.kind !== 'your-turn'\) \{\s*setShowTakeover\(false\);/);
  });
});
