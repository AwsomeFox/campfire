export const TOKEN_COLOR_RAMP = [
  '#ef4444', // red-500
  '#f97316', // orange-500
  '#eab308', // yellow-500
  '#84cc16', // lime-500
  '#22c55e', // green-500
  '#10b981', // emerald-500
  '#06b6d4', // cyan-500
  '#3b82f6', // blue-500
  '#6366f1', // indigo-500
  '#8b5cf6', // violet-500
  '#d946ef', // fuchsia-500
  '#f43f5e', // rose-500
];

export function tokenIdentityColor(combatantId: number): string {
  const index = Math.abs(combatantId) % TOKEN_COLOR_RAMP.length;
  return TOKEN_COLOR_RAMP[index] ?? TOKEN_COLOR_RAMP[0];
}

export function tokenIdentityBackground(combatant: { id: number; characterId?: number | null }): string {
  if (combatant.characterId != null) {
    return 'var(--color-accent)';
  }
  return tokenIdentityColor(combatant.id);
}
