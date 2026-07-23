/**
 * Shared initials-avatar coloring for the party roster + character sheet.
 *
 * Audit note (issue #644): this palette is POLYCHROMATIC BY DESIGN — six
 * maximally distinct hues so two same-name PCs still read as different
 * people. Amber is kept here on purpose, the way `--cf-crit` deliberately
 * keeps amber for the natural-20 flourish: these are closed semantic hue
 * slots, not the app "primary" the design-system accent replaced. The
 * accent/hover drift the issue files is about CLICKABLE CARDS, not avatar
 * identity hues, so this palette is intentionally NOT migrated to
 * --color-accent (collapsing six hues into the blurple family would erase
 * the distinguishability the palette exists to provide).
 *
 * The {@link initials} function re-exports the grapheme-aware helper from
 * `lib/avatarText` (issue #631) so legacy imports keep working while all
 * surfaces converge on the same Unicode-safe implementation.
 */
export { initials } from '../../lib/avatarText';

export const AVATAR_PALETTE = [
  { bg: 'bg-purple-500/15', border: 'border-purple-500/60', text: 'text-purple-400' },
  { bg: 'bg-sky-500/15', border: 'border-sky-500/60', text: 'text-sky-400' },
  { bg: 'bg-emerald-500/15', border: 'border-emerald-500/60', text: 'text-emerald-400' },
  { bg: 'bg-amber-500/15', border: 'border-amber-500/60', text: 'text-amber-400' },
  { bg: 'bg-rose-500/15', border: 'border-rose-500/60', text: 'text-rose-400' },
  { bg: 'bg-cyan-500/15', border: 'border-cyan-500/60', text: 'text-cyan-400' },
];

export function avatarTone(index: number) {
  return AVATAR_PALETTE[index % AVATAR_PALETTE.length];
}
