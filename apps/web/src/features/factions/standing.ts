/**
 * Faction party-standing labels (issue #753).
 *
 * Cards/chips used to render the raw lowercase enum (`hostile`, `allied`, …)
 * while the Party standing detail row title-cased via CSS — so the same value
 * looked different on adjacent surfaces. This module is the single,
 * localization-ready source of truth for human standing copy: keep the raw
 * enum on the wire / in form values, and route every user-facing surface
 * (cards, chips, selects/filters, detail facts) through these helpers.
 */
import type { FactionStanding } from '@campfire/schema';

/** Stable hostile→allied order used by selects/filters. */
export const FACTION_STANDINGS: readonly FactionStanding[] = [
  'hostile',
  'unfriendly',
  'neutral',
  'friendly',
  'allied',
];

/**
 * Default English display labels per standing enum.
 * Localization-ready: swap values (or wrap lookups) when a factions catalog lands;
 * keys stay the raw schema enums so form/filter values never change.
 */
export const FACTION_STANDING_LABEL: Record<FactionStanding, string> = {
  hostile: 'Hostile',
  unfriendly: 'Unfriendly',
  neutral: 'Neutral',
  friendly: 'Friendly',
  allied: 'Allied',
};

/** Human label for a standing enum. Unknown runtime values fall back to the raw string. */
export function standingLabel(standing: FactionStanding | string): string {
  if (Object.prototype.hasOwnProperty.call(FACTION_STANDING_LABEL, standing)) {
    return FACTION_STANDING_LABEL[standing as FactionStanding];
  }
  return standing;
}

/** Select/filter options: raw enum as `value`, human label as display text. */
export function standingOptions(): ReadonlyArray<{ value: FactionStanding; label: string }> {
  return FACTION_STANDINGS.map((value) => ({ value, label: FACTION_STANDING_LABEL[value] }));
}

/** Chip text: human standing + signed reputation, e.g. `Friendly · +10`. */
export function formatStandingChip(standing: FactionStanding, reputation: number): string {
  const rep = reputation > 0 ? `+${reputation}` : String(reputation);
  return `${standingLabel(standing)} · ${rep}`;
}

/** Chip color ramp for the hostile→allied scale. */
export function standingVariant(standing: FactionStanding) {
  switch (standing) {
    case 'allied':
    case 'friendly':
      return 'completed' as const;
    case 'hostile':
    case 'unfriendly':
      return 'failed' as const;
    default:
      return 'active' as const;
  }
}
