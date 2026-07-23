/**
 * Faction standing labels (issue #753).
 *
 * Cards/chips/forms previously rendered raw lowercase enums (`hostile`) while
 * the detail Facts row CSS-capitalized the same value. This pins the shared
 * localization-ready label map so every standing state stays humanized and
 * consistent — and so a future locale can swap catalog strings without
 * inventing a second map.
 *
 * English strings live in `FACTION_STANDING_LABELS` (and the mirrored i18n
 * catalog). Tests derive expectations from those sources — no third copy.
 *
 * Pure helper coverage via `pw-unit.config.ts` (no browser / seeded server) —
 * kept next to sibling `*.unit.spec.ts` helpers under e2e/tests so one runner
 * exercises src/ imports without standing up the full Playwright e2e suite.
 */
import { expect, test } from '@playwright/test';
import { FACTION_STANDINGS } from '@campfire/schema';
import factionsCatalog from '../../src/i18n/locales/en/factions.json';
import {
  FACTION_STANDING_LABELS,
  factionStandingLabel,
  factionStandingLabelKey,
  factionStandingOptions,
  formatStandingChip,
  standingVariant,
} from '../../src/features/factions/standing';

const EXPECTED_VARIANTS = {
  hostile: 'failed',
  unfriendly: 'failed',
  neutral: 'active',
  friendly: 'completed',
  allied: 'completed',
} as const;

test.describe('faction standing labels (#753)', () => {
  test('shared map covers every standing enum with a humanized label', () => {
    // Iterate the schema tuple — don't rely on object key enumeration order.
    expect(Object.keys(FACTION_STANDING_LABELS)).toHaveLength(FACTION_STANDINGS.length);
    for (const standing of FACTION_STANDINGS) {
      expect(FACTION_STANDING_LABELS).toHaveProperty(standing);
      expect(FACTION_STANDING_LABELS[standing]).toBeTruthy();
      expect(FACTION_STANDING_LABELS[standing]).not.toBe(standing);
    }
  });

  test('i18n catalog mirrors the shared standing label map', () => {
    expect(factionsCatalog.factions.standing).toEqual(FACTION_STANDING_LABELS);
  });

  // One focused case per standing so a single-state regression names the culprit.
  for (const standing of FACTION_STANDINGS) {
    test(`standing state "${standing}" is humanized across chips, detail, and options`, () => {
      const label = FACTION_STANDING_LABELS[standing];

      expect(factionStandingLabel(standing)).toBe(label);
      expect(factionStandingLabelKey(standing)).toBe(`factions.standing.${standing}`);
      // Raw enum must never be the display string.
      expect(factionStandingLabel(standing)).not.toBe(standing);
      expect(standingVariant(standing)).toBe(EXPECTED_VARIANTS[standing]);
      // Chip / card copy
      expect(formatStandingChip(standing, 0)).toBe(`${label} · 0`);
      expect(formatStandingChip(standing, 12)).toBe(`${label} · +12`);
      expect(formatStandingChip(standing, -8)).toBe(`${label} · -8`);
      // Form / filter option: raw value, humanized label
      const option = factionStandingOptions().find((o) => o.value === standing);
      expect(option).toEqual({ value: standing, label });
    });
  }

  test('select/filter options keep raw enums as values and humanized labels as text', () => {
    const options = factionStandingOptions();
    expect(options).toHaveLength(FACTION_STANDINGS.length);
    expect(options.map((o) => o.value)).toEqual([...FACTION_STANDINGS]);
    expect(options.map((o) => o.label)).toEqual(FACTION_STANDINGS.map((s) => FACTION_STANDING_LABELS[s]));
  });

  test('optional t() resolves through the i18n key with English fallback', () => {
    const t = (key: string, opts?: { defaultValue?: string }) => {
      if (key === 'factions.standing.hostile') return 'Hostil';
      return opts?.defaultValue ?? key;
    };
    expect(factionStandingLabel('hostile', t)).toBe('Hostil');
    expect(factionStandingLabel('allied', t)).toBe('Allied');
    expect(formatStandingChip('friendly', 5, t)).toBe('Friendly · +5');
    expect(factionStandingOptions(t).find((o) => o.value === 'hostile')?.label).toBe('Hostil');
  });

  test('optional t() preserves an intentional empty translation', () => {
    const t = () => '';
    expect(factionStandingLabel('hostile', t)).toBe('');
  });
});
