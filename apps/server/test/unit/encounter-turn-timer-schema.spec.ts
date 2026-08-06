/**
 * Turn timer (issue #1935) — schema contract for the two new Encounter fields.
 *
 * `turnStartedAt` is server-managed only: it lives on `Encounter` (every read) but is
 * deliberately absent from `EncounterUpdate`, so it can never be set via PATCH — the
 * DTO layer (`EncounterUpdateDto`, encounters.dto.ts) additionally applies `.strict()`,
 * turning an attempted `turnStartedAt` in a PATCH body into a 400 rather than a
 * silent no-op. `turnTimerSeconds` is the one DM-editable field (0 = off).
 */
import { Encounter, EncounterUpdate } from '@campfire/schema';

const baseEncounter = {
  id: 1,
  campaignId: 1,
  name: 'Ambush',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('Encounter / EncounterUpdate — turn timer fields (issue #1935)', () => {
  it('Encounter parses a null turnStartedAt (not running) and defaults turnTimerSeconds to 0', () => {
    const parsed = Encounter.parse(baseEncounter);
    expect(parsed.turnStartedAt).toBeNull();
    expect(parsed.turnTimerSeconds).toBe(0);
  });

  it('Encounter parses an ISO turnStartedAt and a positive turnTimerSeconds', () => {
    const parsed = Encounter.parse({
      ...baseEncounter,
      turnStartedAt: '2026-01-01T00:03:40.000Z',
      turnTimerSeconds: 90,
    });
    expect(parsed.turnStartedAt).toBe('2026-01-01T00:03:40.000Z');
    expect(parsed.turnTimerSeconds).toBe(90);
  });

  it('EncounterUpdate accepts turnTimerSeconds >= 0, including 0 (off)', () => {
    expect(EncounterUpdate.safeParse({ turnTimerSeconds: 0 }).success).toBe(true);
    expect(EncounterUpdate.safeParse({ turnTimerSeconds: 90 }).success).toBe(true);
  });

  it('EncounterUpdate rejects a negative turnTimerSeconds', () => {
    expect(EncounterUpdate.safeParse({ turnTimerSeconds: -1 }).success).toBe(false);
  });

  it('EncounterUpdate rejects a non-integer turnTimerSeconds', () => {
    expect(EncounterUpdate.safeParse({ turnTimerSeconds: 12.5 }).success).toBe(false);
  });

  it('EncounterUpdate has no turnStartedAt field at all — it cannot be part of a DM PATCH', () => {
    expect((EncounterUpdate as unknown as { shape: Record<string, unknown> }).shape.turnStartedAt).toBeUndefined();
  });
});
