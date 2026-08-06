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

/**
 * Per-user map-ping identity color (issue #1937).
 *
 * Deliberately separate from `tokenIdentityColor` (keyed off `combatantId`,
 * a per-encounter numeric row id): a ping's identity is the sending USER —
 * the same person keeps the same ping color across every encounter and
 * every combatant they might be playing, which a combatant-keyed hash
 * cannot express. A simple string hash onto the shared ramp keeps every
 * ping-vs-token color drawn from one consistent palette without coupling
 * the two identity systems together.
 */
export function pingIdentityColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i += 1) {
    // `| 0` keeps the accumulator a 32-bit int so the hash never grows
    // unbounded for a long id and stays deterministic across engines.
    hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  }
  const index = Math.abs(hash) % TOKEN_COLOR_RAMP.length;
  return TOKEN_COLOR_RAMP[index] ?? TOKEN_COLOR_RAMP[0];
}

/**
 * Color-vision-assist secondary identity channel (issue #1942).
 *
 * Small fixed set of shapes, keyed off `combatantId` exactly like
 * `tokenIdentityColor` — same combatant → same shape on every token surface
 * (initiative strip + battle map). Four shapes with a 12-hue ramp guarantees
 * every adjacent ramp entry gets a different shape (12 and 4 share no common
 * divisor with step 1), so identity never collapses to color alone even when
 * two neighbouring hues simulate to the same color under a color-vision
 * deficiency (see `accent-palette.unit.spec.ts`'s CVD guard pattern).
 */
export const TOKEN_IDENTITY_SHAPES = ['circle', 'square', 'triangle', 'diamond'] as const;
export type TokenIdentityShape = (typeof TOKEN_IDENTITY_SHAPES)[number];

export function tokenIdentityShape(combatantId: number): TokenIdentityShape {
  const index = Math.abs(combatantId) % TOKEN_IDENTITY_SHAPES.length;
  return TOKEN_IDENTITY_SHAPES[index] ?? TOKEN_IDENTITY_SHAPES[0];
}

/** CSS `clip-path` for each identity shape's corner badge — pure decoration, no color. */
export const TOKEN_IDENTITY_SHAPE_CLIP_PATH: Record<TokenIdentityShape, string> = {
  circle: 'circle(50% at 50% 50%)',
  square: 'inset(12%)',
  triangle: 'polygon(50% 6%, 6% 94%, 94% 94%)',
  diamond: 'polygon(50% 2%, 98% 50%, 50% 98%, 2% 50%)',
};
