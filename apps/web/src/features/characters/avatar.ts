/** Shared initials-avatar coloring for the party roster + character sheet. */
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

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0] + parts[parts.length - 1]![0]).toUpperCase();
}
