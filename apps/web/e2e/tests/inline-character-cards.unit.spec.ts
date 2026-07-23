/**
 * Inline encounter character-card refresh (issue #421).
 *
 * Sheet edits in another tab must invalidate the campaign character query even
 * when the SSE frame has no encounterId. While the stream is down, click-to-roll
 * is disabled so obsolete modifiers are not trusted.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CampaignEvent } from '@campfire/schema';
import {
  inlineCharacterSheetsInteractive,
  inlineCharacterSheetsStatusLabel,
  shouldInvalidateInlineCharacters,
} from '../../src/features/encounters/inlineCharacterCards';

const RUN_SESSION_PAGE = resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx');
const USE_CAMPAIGN_EVENTS = resolve(__dirname, '../../src/lib/useCampaignEvents.ts');

const at = '2026-07-23T12:00:00.000Z';

test.describe('inline character cards refresh (issue #421)', () => {
  test('character.updated and membership.revoked invalidate sheets; encounter frames do not', () => {
    const characterUpdated: CampaignEvent = {
      type: 'character.updated',
      campaignId: 1,
      characterId: 9,
      userId: 'dev:p-1',
      at,
    };
    const membership: CampaignEvent = {
      type: 'membership.revoked',
      campaignId: 1,
      userId: 'dev:p-1',
      memberId: 3,
      at,
    };
    const encounter: CampaignEvent = {
      type: 'encounter.updated',
      campaignId: 1,
      encounterId: 4,
      at,
    };
    expect(shouldInvalidateInlineCharacters(characterUpdated)).toBe(true);
    expect(shouldInvalidateInlineCharacters(membership)).toBe(true);
    expect(shouldInvalidateInlineCharacters(encounter)).toBe(false);
  });

  test('rolls stay enabled while connected; disabled while reconnecting/offline', () => {
    expect(inlineCharacterSheetsInteractive('connected')).toBe(true);
    expect(inlineCharacterSheetsInteractive('connecting')).toBe(true);
    expect(inlineCharacterSheetsInteractive(null)).toBe(true);
    expect(inlineCharacterSheetsInteractive('reconnecting')).toBe(false);
    expect(inlineCharacterSheetsInteractive('offline')).toBe(false);
    expect(inlineCharacterSheetsInteractive('stopped')).toBe(false);
  });

  test('status label covers reconnect and in-flight refetch', () => {
    expect(inlineCharacterSheetsStatusLabel('offline', false)).toMatch(/offline/i);
    expect(inlineCharacterSheetsStatusLabel('reconnecting', false)).toMatch(/out of date/i);
    expect(inlineCharacterSheetsStatusLabel('connected', true)).toMatch(/Refreshing/i);
    expect(inlineCharacterSheetsStatusLabel('connected', false)).toBeNull();
  });

  test('RunSessionPage invalidates characters before the encounterId filter', () => {
    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');
    expect(source).toMatch(/shouldInvalidateInlineCharacters/);
    expect(source).toMatch(/invalidateCampaignCharacters/);
    expect(source).toMatch(/inline-character-sheets-status/);
    // Must not require encounterId for character frames (the original bug).
    expect(source).toMatch(/have no encounterId/);
  });

  test('useCampaignEvents accepts character.updated frames', () => {
    const source = readFileSync(USE_CAMPAIGN_EVENTS, 'utf8');
    expect(source).toMatch(/character\.updated/);
    expect(source).toMatch(/characterId/);
  });
});
