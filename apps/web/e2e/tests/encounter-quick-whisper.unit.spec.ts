/**
 * Quick whisper from encounter screen (issue #1936) unit test suite.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test.describe('Encounter quick whisper (issue #1936)', () => {
  test('i18n keys for whisper exist in English and Arabic locale files', () => {
    const enPath = resolve(__dirname, '../../src/i18n/locales/en/encounters.json');
    const arPath = resolve(__dirname, '../../src/i18n/locales/ar/encounters.json');

    const en = JSON.parse(readFileSync(enPath, 'utf8'));
    const ar = JSON.parse(readFileSync(arPath, 'utf8'));

    expect(en.encounters.whisper).toBeDefined();
    expect(en.encounters.whisper.button).toBe('Whisper');
    expect(en.encounters.whisper.panelTitle).toBe('Quick Whisper to Player');

    expect(ar.encounters.whisper).toBeDefined();
    expect(ar.encounters.whisper.button).toBe('همس');
    expect(ar.encounters.whisper.panelTitle).toBe('همسة سريعة للاعب');
  });

  test('whisper affordance visibility logic: DM on player-owned PC row vs monster/self/player viewer', () => {
    function shouldShowRowWhisper(opts: {
      isDm: boolean;
      campaignId?: number;
      ownerUserId?: string | null;
      myUserId?: string;
    }): boolean {
      const { isDm, campaignId, ownerUserId, myUserId } = opts;
      return (
        isDm &&
        campaignId != null &&
        ownerUserId != null &&
        String(ownerUserId) !== String(myUserId)
      );
    }

    // DM viewing player 2's character -> true
    expect(
      shouldShowRowWhisper({
        isDm: true,
        campaignId: 10,
        ownerUserId: 'user-2',
        myUserId: 'user-1',
      }),
    ).toBe(true);

    // DM viewing their own character -> false
    expect(
      shouldShowRowWhisper({
        isDm: true,
        campaignId: 10,
        ownerUserId: 'user-1',
        myUserId: 'user-1',
      }),
    ).toBe(false);

    // DM viewing a monster row (no ownerUserId) -> false
    expect(
      shouldShowRowWhisper({
        isDm: true,
        campaignId: 10,
        ownerUserId: null,
        myUserId: 'user-1',
      }),
    ).toBe(false);

    // Player viewer viewing another player's character -> false (DM only)
    expect(
      shouldShowRowWhisper({
        isDm: false,
        campaignId: 10,
        ownerUserId: 'user-2',
        myUserId: 'user-3',
      }),
    ).toBe(false);
  });

  test('recipient picker filters out current user (self)', () => {
    const members = [
      { userId: 'user-1', displayName: 'DM Alice' },
      { userId: 'user-2', displayName: 'Player Bob' },
      { userId: 'user-3', displayName: 'Player Charlie' },
    ];
    const myUserId = 'user-1';

    const available = members.filter((m) => String(m.userId) !== String(myUserId));
    expect(available).toHaveLength(2);
    expect(available.map((m) => m.userId)).toEqual(['user-2', 'user-3']);
  });
});
