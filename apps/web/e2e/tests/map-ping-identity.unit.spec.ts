/**
 * Issue #1937: per-user map-ping color identity.
 *
 * Pure-logic coverage for `pingIdentityColor` follows the `tokenIdentity.ts`
 * convention already used in `color-vision-assist.unit.spec.ts` (issue #1942):
 * deterministic per-key hash onto the shared `TOKEN_COLOR_RAMP`.
 */
import { expect, test } from '@playwright/test';
import { TOKEN_COLOR_RAMP, pingIdentityColor } from '../../src/features/encounters/tokenIdentity';

test.describe('pingIdentityColor (issue #1937)', () => {
  test('is deterministic — the same user id always yields the same color', () => {
    const ids = ['user-1', 'user-2', 'a-very-long-uuid-like-identifier-0123456789', '', 'admin'];
    for (const id of ids) {
      const first = pingIdentityColor(id);
      const second = pingIdentityColor(id);
      expect(first).toBe(second);
      expect(TOKEN_COLOR_RAMP).toContain(first);
    }
  });

  test('distinct user ids spread across more than one ramp color', () => {
    // Not a claim of zero collisions (a 12-slot ramp over an open id space must
    // collide eventually) — just that a handful of realistic ids don't all
    // degenerate onto a single slot, which would defeat the entire point of a
    // per-sender identity color (two different senders would look the same).
    const ids = ['user-1', 'user-2', 'user-3', 'user-4', 'user-5', 'user-6', 'user-7', 'user-8'];
    const colors = new Set(ids.map((id) => pingIdentityColor(id)));
    expect(colors.size).toBeGreaterThan(1);
  });

  test('is independent of tokenIdentityColor — keyed off the user id string, not a combatant id', () => {
    // Regression guard for the issue's explicit boundary: pingIdentityColor must be
    // its own function, not a thin wrapper that happens to coerce the user id to a
    // number and delegate to the combatant-keyed helper.
    expect(pingIdentityColor('7')).not.toBe(undefined);
    // A user id that looks numeric must still hash as a STRING (character codes),
    // not get coerced into the combatant-keyed `tokenIdentityColor(7)` result by
    // accident — assert the two use different hash bases by comparing against a
    // manually computed string hash for '7' (a single character, hash = 55 = '7'.charCodeAt(0)).
    const expectedIndex = 55 % TOKEN_COLOR_RAMP.length;
    expect(pingIdentityColor('7')).toBe(TOKEN_COLOR_RAMP[expectedIndex]);
  });

  test('empty user id still resolves to a valid ramp color rather than throwing or returning undefined', () => {
    expect(TOKEN_COLOR_RAMP).toContain(pingIdentityColor(''));
  });
});
