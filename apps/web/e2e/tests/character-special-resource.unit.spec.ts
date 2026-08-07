import { expect, test } from '@playwright/test';
import { Dnd5eAdapter, OpenLegendAdapter, Pf2eAdapter } from '@campfire/schema';
import {
  canAdjustSpecialResource,
  findSpecialResource,
  resourceAvailability,
  specialResourceAdjustBody,
  SPECIAL_RESOURCE_KEYS,
} from '../../src/features/characters/specialCharacterResource';

/**
 * Issue #1642 — the character sheet surfaces inspiration (5e) / hero points (PF2e) as a
 * togglable/counted resource, using whichever the campaign's adapter actually declares —
 * never a hardcoded name, and never an empty or 5e-shaped widget for a system that
 * declares neither. These are the pure helpers CharacterPage.tsx renders from
 * (specialCharacterResource.ts); see mcp.e2e-spec.ts's three "#1642:" tests for the
 * server-side proof that adjust_character_resource actually works end-to-end with these
 * two keys against real 5e/PF2e/Open Legend campaigns.
 */
test.describe('findSpecialResource — adapter-driven, never hardcoded (#1642)', () => {
  test('5e declares inspiration, not hero points', () => {
    const def = findSpecialResource(Dnd5eAdapter);
    expect(def).toMatchObject({ key: 'inspiration', name: 'Inspiration', recharge: 'special', defaultMax: 1 });
  });

  test('PF2e declares hero points, not inspiration — a different economy (defaultMax 3, not 1)', () => {
    const def = findSpecialResource(Pf2eAdapter);
    expect(def).toMatchObject({ key: 'heroPoints', name: 'Hero Points', recharge: 'special', defaultMax: 3 });
  });

  // The case "most likely to be skipped" per the issue: a system whose adapter declares
  // neither resource must not fall back to an empty or 5e-shaped widget. Open Legend
  // declares no `resources` at all (packages/schema/src/index.ts's OpenLegendAdapter).
  test('a system declaring neither resource (Open Legend) returns undefined — CharacterPage renders nothing', () => {
    expect(findSpecialResource(OpenLegendAdapter)).toBeUndefined();
  });

  test('SPECIAL_RESOURCE_KEYS is exactly the two named resources, not a general vocabulary browser', () => {
    expect([...SPECIAL_RESOURCE_KEYS].sort()).toEqual(['heroPoints', 'inspiration']);
  });
});

test.describe('resourceAvailability — pip math, DM-awarded economy (#1642)', () => {
  const inspirationDef = { key: 'inspiration', defaultMax: 1 };
  const heroPointsDef = { key: 'heroPoints', defaultMax: 3 };

  // Inspiration / hero points are DM-awarded (resources.spec.ts #1073). Absence of the
  // sparse key must not look like a full pool — otherwise Spend consumes a reroll that
  // was never awarded. Show adapter capacity with nothing available until first award.
  test('a character that has never had this resource touched shows adapter capacity with nothing available', () => {
    expect(resourceAvailability(inspirationDef, { resources: {} })).toEqual({ max: 1, used: 1, available: 0 });
    expect(resourceAvailability(heroPointsDef, { resources: {} })).toEqual({ max: 3, used: 3, available: 0 });
  });

  test('a spent (used) resource reduces availability, capped at 0', () => {
    expect(
      resourceAvailability(inspirationDef, { resources: { inspiration: { max: 1, used: 1 } } }),
    ).toEqual({ max: 1, used: 1, available: 0 });
    expect(
      resourceAvailability(heroPointsDef, { resources: { heroPoints: { max: 3, used: 2 } } }),
    ).toEqual({ max: 3, used: 2, available: 1 });
  });

  test('an already-stored max on the character (a DM-configured override) wins over the adapter default', () => {
    expect(
      resourceAvailability(heroPointsDef, { resources: { heroPoints: { max: 5, used: 0 } } }),
    ).toEqual({ max: 5, used: 0, available: 5 });
  });

  test('a used value the server would reject (used > max) still reports 0 available, never negative — defensive display only', () => {
    expect(
      resourceAvailability(inspirationDef, { resources: { inspiration: { max: 1, used: 3 } } }),
    ).toEqual({ max: 1, used: 3, available: 0 });
  });
});

/**
 * Issue #1944 — the encounter screen's DM-award (`CombatantRow`) and player-spend
 * (`PlayerVitalsHeader`) controls call these two helpers instead of re-deriving the
 * `AdapterResourceCard.adjust` semantics a second time. Same fixtures as the
 * `resourceAvailability` suite above so the two suites stay easy to cross-reference.
 */
test.describe('specialResourceAdjustBody — exact POST /characters/:id/resources body (#1944)', () => {
  const inspirationDef = { key: 'inspiration', defaultMax: 1, name: 'Inspiration', recharge: 'special' as const };
  const heroPointsDef = { key: 'heroPoints', defaultMax: 3, name: 'Hero Points', recharge: 'special' as const };
  const AT = '2026-01-01T00:00:00.000Z';

  test('award on a never-touched pool is the first-touch creation payload, not a delta', () => {
    expect(specialResourceAdjustBody(inspirationDef, { resources: {}, updatedAt: AT }, 'award')).toEqual({
      key: 'inspiration',
      max: 1,
      used: 0,
      name: 'Inspiration',
      recharge: 'special',
      expectedUpdatedAt: AT,
    });
    expect(specialResourceAdjustBody(heroPointsDef, { resources: {}, updatedAt: AT }, 'award')).toEqual({
      key: 'heroPoints',
      max: 3,
      used: 2,
      name: 'Hero Points',
      recharge: 'special',
      expectedUpdatedAt: AT,
    });
  });

  // Devin review on PR #2052: the creation arm is the only ABSOLUTE `used` write here, and the
  // absence of a stored record is what selects it — so a stale copy is self-perpetuating. A
  // second Award pressed before the first round-trips still sees no record, posts the same body,
  // and the server rewrites the same value while the caller reports success. The CAS token makes
  // that a 409 rather than a silent no-op. Asserted separately from the shape above so a refactor
  // that drops the field fails HERE, on a case whose name says why.
  test('only the absolute creation arm carries the concurrency token — a relative delta neither needs nor sends one', () => {
    const created = specialResourceAdjustBody(heroPointsDef, { resources: {}, updatedAt: AT }, 'award');
    expect(created).toHaveProperty('expectedUpdatedAt', AT);
    for (const body of [
      specialResourceAdjustBody(heroPointsDef, { resources: { heroPoints: { max: 5, used: 2 } }, updatedAt: AT }, 'award'),
      specialResourceAdjustBody(inspirationDef, { resources: { inspiration: { max: 1, used: 0 } }, updatedAt: AT }, 'spend'),
    ]) {
      expect(body).not.toHaveProperty('expectedUpdatedAt');
    }
  });

  test('award on an already-touched pool is a plain delta: -1 — never re-sends max/name/recharge (would clobber a DM override)', () => {
    expect(
      specialResourceAdjustBody(heroPointsDef, { resources: { heroPoints: { max: 5, used: 2 } }, updatedAt: AT }, 'award'),
    ).toEqual({ key: 'heroPoints', delta: -1 });
  });

  test('spend is always a plain delta: +1 — a spend is only ever legal once the pool has been touched', () => {
    expect(
      specialResourceAdjustBody(inspirationDef, { resources: { inspiration: { max: 1, used: 0 } }, updatedAt: AT }, 'spend'),
    ).toEqual({ key: 'inspiration', delta: 1 });
  });
});

test.describe('canAdjustSpecialResource — award-cap and spend-zero gating (#1944)', () => {
  const inspirationDef = { key: 'inspiration', defaultMax: 1 };
  const heroPointsDef = { key: 'heroPoints', defaultMax: 3 };

  test('spend is gated off at zero available (a never-touched pool cannot be spent)', () => {
    expect(canAdjustSpecialResource(inspirationDef, { resources: {} }, 'spend')).toBe(false);
    expect(
      canAdjustSpecialResource(inspirationDef, { resources: { inspiration: { max: 1, used: 1 } } }, 'spend'),
    ).toBe(false);
  });

  test('spend is allowed once available > 0', () => {
    expect(
      canAdjustSpecialResource(heroPointsDef, { resources: { heroPoints: { max: 3, used: 2 } } }, 'spend'),
    ).toBe(true);
  });

  test('award is gated off at the adapter cap (used === 0 — nothing left to top up)', () => {
    expect(
      canAdjustSpecialResource(heroPointsDef, { resources: { heroPoints: { max: 3, used: 0 } } }, 'award'),
    ).toBe(false);
  });

  test('award is allowed on a never-touched pool (used === max per resourceAvailability) and on a partially-used one', () => {
    expect(canAdjustSpecialResource(inspirationDef, { resources: {} }, 'award')).toBe(true);
    expect(
      canAdjustSpecialResource(heroPointsDef, { resources: { heroPoints: { max: 3, used: 1 } } }, 'award'),
    ).toBe(true);
  });
});
