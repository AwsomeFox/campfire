/**
 * Faction standing labels (issue #753).
 *
 * Cards/chips used to render raw lowercase enums while the Party standing
 * detail row title-cased via CSS. These specs pin the shared localization-ready
 * label map for every standing state, and the helpers that keep raw enums on
 * the wire while every user-facing surface (chip, select/filter option, detail
 * fact) shows the human label.
 *
 * Pure unit test — no backend, no browser — runs under the Playwright runner
 * alongside the other `.unit.spec.ts` files.
 */
import { expect, test } from '@playwright/test';
import { FactionStanding } from '@campfire/schema';
import {
  FACTION_STANDING_LABEL,
  FACTION_STANDINGS,
  formatStandingChip,
  standingLabel,
  standingOptions,
  standingVariant,
} from '../../src/features/factions/standing';

/** Expected human labels for every schema standing — the snapshot under test. */
const STANDING_LABEL_SNAPSHOT: Record<FactionStanding, string> = {
  hostile: 'Hostile',
  unfriendly: 'Unfriendly',
  neutral: 'Neutral',
  friendly: 'Friendly',
  allied: 'Allied',
};

test.describe('faction standing labels (issue #753)', () => {
  test('map covers every schema standing exactly once, in hostile→allied order', () => {
    expect(FACTION_STANDINGS).toEqual(FactionStanding.options);
    expect(Object.keys(FACTION_STANDING_LABEL).sort()).toEqual([...FactionStanding.options].sort());
    expect(FACTION_STANDINGS).toEqual(['hostile', 'unfriendly', 'neutral', 'friendly', 'allied']);
  });

  test('snapshots the localization-ready label for every standing state', () => {
    expect(FACTION_STANDING_LABEL).toEqual(STANDING_LABEL_SNAPSHOT);
    for (const standing of FactionStanding.options) {
      expect(standingLabel(standing)).toBe(STANDING_LABEL_SNAPSHOT[standing]);
      // Humanized: not the raw lowercase enum, and title-cased.
      expect(standingLabel(standing)).not.toBe(standing);
      expect(standingLabel(standing)[0]).toBe(standingLabel(standing)[0].toUpperCase());
    }
  });

  test('select/filter options keep raw enums as values and human labels as text', () => {
    const opts = standingOptions();
    expect(opts.map((o) => o.value)).toEqual(FACTION_STANDINGS);
    expect(opts.map((o) => o.label)).toEqual(FACTION_STANDINGS.map((s) => STANDING_LABEL_SNAPSHOT[s]));
    for (const opt of opts) {
      expect(opt.value).not.toBe(opt.label);
      expect(opt.value).toMatch(/^[a-z]+$/);
    }
  });

  test('chip formatter humanizes standing and signs positive reputation', () => {
    expect(formatStandingChip('friendly', 10)).toBe('Friendly · +10');
    expect(formatStandingChip('hostile', -25)).toBe('Hostile · -25');
    expect(formatStandingChip('neutral', 0)).toBe('Neutral · 0');
    expect(formatStandingChip('allied', 100)).toBe('Allied · +100');
    expect(formatStandingChip('unfriendly', -1)).toBe('Unfriendly · -1');
  });

  test('chip variant ramp stays aligned with the hostile→allied scale', () => {
    expect(standingVariant('hostile')).toBe('failed');
    expect(standingVariant('unfriendly')).toBe('failed');
    expect(standingVariant('neutral')).toBe('active');
    expect(standingVariant('friendly')).toBe('completed');
    expect(standingVariant('allied')).toBe('completed');
  });

  test('unknown runtime standing falls back to the raw string (never invents a label)', () => {
    expect(standingLabel('trusted ally')).toBe('trusted ally');
  });
});
