import { expect, test } from '@playwright/test';
import type { Npc } from '@campfire/schema';
import { safeNpcs, type SafeNpc } from '../../src/features/screen/playerSafe';

/**
 * Issue #1320 — NPC portraits are a first-class field on the Npc schema and must
 * round-trip through the player-safe projection used by the Cast / Player Display.
 */

function npc(partial: Partial<Npc> & Pick<Npc, 'id' | 'name'>): Npc {
  return {
    campaignId: 1,
    role: '',
    disposition: 'neutral',
    locationId: null,
    factionId: null,
    body: '',
    dmSecret: 'never leak',
    portraitUrl: null,
    iconSlug: '',
    hidden: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

test.describe('safeNpcs — player-safe projection (issue #1320)', () => {
  test('keeps portraitUrl on the player-safe NPC shape', () => {
    const n = npc({ id: 1, name: 'Elda', portraitUrl: '/api/v1/attachments/7/file' });
    const [projected] = safeNpcs([n]) as [SafeNpc];
    expect(projected.portraitUrl).toBe('/api/v1/attachments/7/file');
  });

  test('drops hidden NPCs entirely, including their portraits', () => {
    const visible = npc({ id: 1, name: 'Elda', portraitUrl: '/api/v1/attachments/7/file' });
    const hidden = npc({ id: 2, name: 'Shadow', portraitUrl: '/api/v1/attachments/8/file', hidden: true });
    const result = safeNpcs([visible, hidden]);
    expect(result.map((n) => n.id)).toEqual([1]);
    expect(result[0]!.portraitUrl).toBe('/api/v1/attachments/7/file');
  });

  test('omits DM-only fields from the player-safe projection', () => {
    const n = npc({ id: 1, name: 'Elda', portraitUrl: '/api/v1/attachments/7/file' });
    const [projected] = safeNpcs([n]) as [SafeNpc];
    expect(projected).not.toHaveProperty('dmSecret');
    expect(projected).not.toHaveProperty('body');
  });

  test('treats a null portraitUrl as a valid player-safe value', () => {
    const n = npc({ id: 1, name: 'Elda' });
    const [projected] = safeNpcs([n]) as [SafeNpc];
    expect(projected.portraitUrl).toBeNull();
  });
});
