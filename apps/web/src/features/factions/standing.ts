/**
 * Shared faction standing labels (issue #753).
 *
 * Cards, chips, forms, filters, and detail views must render these humanized
 * labels — never the raw lowercase enum. The English map is the source of
 * truth today; each key is also mirrored under `factions.standing.*` in the
 * i18n catalog so a translator can drop in another locale without touching
 * call sites that pass `t`.
 */
import { FACTION_STANDINGS, type FactionStanding } from '@campfire/schema';
import type { ChipVariant } from '../../components/chipVariants';

export { FACTION_STANDINGS };
export type { FactionStanding };

/** Localization-ready English display labels for every standing enum. */
export const FACTION_STANDING_LABEL: Record<FactionStanding, string> = {
  hostile: 'Hostile',
  unfriendly: 'Unfriendly',
  neutral: 'Neutral',
  friendly: 'Friendly',
  allied: 'Allied',
};

/** i18n key under the `factions` domain for a standing enum. */
export function factionStandingLabelKey(standing: FactionStanding): `factions.standing.${FactionStanding}` {
  return `factions.standing.${standing}`;
}

/**
 * Minimal `t` shape for react-i18next call sites without coupling this module.
 * Only `defaultValue` is used today — keep the options bag intentional.
 */
type Translate = (key: string, options?: { defaultValue?: string }) => string | undefined;

/** Humanized standing label. Pass `t` to resolve through the i18n catalog. */
export function factionStandingLabel(standing: FactionStanding, t?: Translate): string {
  const fallback = FACTION_STANDING_LABEL[standing] ?? standing;
  if (!t) return fallback;
  // Nullish-aware: an intentional empty translation (`""`) must not be replaced.
  return t(factionStandingLabelKey(standing), { defaultValue: fallback }) ?? fallback;
}

/**
 * Chip / badge copy: "Friendly · +12". Raw enums stay on the wire, not here.
 *
 * i18n scope: only the standing label is localization-ready (via `t`). The
 * middle-dot separator and signed reputation formatting remain fixed English
 * punctuation/order for now — not a full chip-format catalog key.
 */
export function formatStandingChip(
  standing: FactionStanding,
  reputation: number,
  t?: Translate,
): string {
  const rep = reputation > 0 ? `+${reputation}` : String(reputation);
  return `${factionStandingLabel(standing, t)} · ${rep}`;
}

/** Chip color treatment for party standing (hostile→allied scale). */
export function standingVariant(standing: FactionStanding): ChipVariant {
  switch (standing) {
    case 'allied':
    case 'friendly':
      return 'completed';
    case 'hostile':
    case 'unfriendly':
      return 'failed';
    default:
      return 'active';
  }
}

/** Select / filter options: raw enum as `value`, humanized label as display. */
export function factionStandingOptions(t?: Translate): ReadonlyArray<{ value: FactionStanding; label: string }> {
  return FACTION_STANDINGS.map((standing) => ({
    value: standing,
    label: factionStandingLabel(standing, t),
  }));
}
