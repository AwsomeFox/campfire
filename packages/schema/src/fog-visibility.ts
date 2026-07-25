import type { AoeTemplate, FogState } from './index';

/** True when a map-percent point lies inside any revealed fog rectangle (issue #40). */
export function pointInRevealedRegion(x: number, y: number, fog: FogState): boolean {
  return fog.revealed.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
}

export type AoeFogFilterOptions = {
  /** When set, templates declared by this user stay visible even in unrevealed fog (issue #465). */
  viewerUserId?: string | null;
};

/**
 * Issue #465: withhold AoE templates whose origin sits in unrevealed fog from non-DM viewers.
 * Player-declared templates (`declaredByUserId`) remain visible to their owner. When fog is
 * disabled, every template is returned unchanged.
 */
export function filterAoeTemplatesForViewer(
  aoe: readonly AoeTemplate[],
  fog: FogState | null | undefined,
  options?: AoeFogFilterOptions,
): AoeTemplate[] {
  if (!fog?.enabled) return [...aoe];
  const viewerUserId = options?.viewerUserId ?? null;
  return aoe.filter((t) => {
    if (viewerUserId != null && t.declaredByUserId === viewerUserId) return true;
    return pointInRevealedRegion(t.x, t.y, fog);
  });
}
