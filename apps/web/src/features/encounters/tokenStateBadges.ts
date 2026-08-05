/**
 * Presentation-only token state calculations (issue #1905).
 *
 * This module deliberately has no React or DOM dependency. BattleMap can lift it
 * unchanged when its token layer is extracted, while the renderer continues to
 * consume the role-shaped Combatant it was handed by the server.
 */
import type { Combatant, HpBand } from '@campfire/schema';

export type TokenDetailMode = 'full' | 'minimal' | 'off';

export const TOKEN_DETAIL_STORAGE_KEY = 'cf.encounters.tokenDetail';

/** The exact four visual fractions already used by the redacted roster bar. */
export const HP_BAND_FRACTION: Record<HpBand, number> = {
  healthy: 1,
  bloodied: 0.5,
  critical: 0.2,
  down: 0,
};

export type TokenHpState = Pick<Combatant, 'hpCurrent' | 'hpMax' | 'hpBand'>;

/**
 * Exact HP is safe only when present in the role-shaped combatant. A redacted
 * value therefore never gets inferred or interpolated: it is one of precisely
 * the four server-provided bands.
 */
export function tokenHpFraction({ hpCurrent, hpMax, hpBand }: TokenHpState): number | null {
  if (hpCurrent != null && hpMax != null) {
    return hpMax > 0 ? Math.max(0, Math.min(1, hpCurrent / hpMax)) : 0;
  }
  return hpBand == null ? null : HP_BAND_FRACTION[hpBand] ?? null;
}

export function tokenHpTone(fraction: number | null): 'healthy' | 'bloodied' | 'critical' | 'down' | null {
  if (fraction == null) return null;
  if (fraction <= 0) return 'down';
  if (fraction <= 0.25) return 'critical';
  if (fraction <= 0.5) return 'bloodied';
  return 'healthy';
}

export function tokenArcGeometry(sizePx: number): { radius: number; circumference: number; strokeWidth: number } {
  const strokeWidth = Math.max(2, Math.min(4, sizePx * 0.11));
  const radius = Math.max(1, sizePx / 2 - strokeWidth / 2 - 1);
  return { radius, circumference: 2 * Math.PI * radius, strokeWidth };
}

/** Normalized condition names map to dependable game-icons.net glyphs. */
const CONDITION_GLYPHS: Record<string, string> = {
  blinded: 'blindfold',
  charmed: 'heart-inside',
  deafened: 'earbuds',
  frightened: 'terror',
  grappled: 'grab',
  incapacitated: 'daze',
  invisible: 'invisible',
  paralyzed: 'body-balance',
  petrified: 'stone-block',
  poisoned: 'poison-bottle',
  prone: 'foot-trip',
  restrained: 'rope-coil',
  stunned: 'stun-grenade',
  unconscious: 'sleepy',
  exhaustion: 'sprint',
  bleeding: 'bleeding-wound',
  burning: 'fire',
  frozen: 'frozen-body',
};

export function tokenConditionGlyph(condition: string): string | null {
  return CONDITION_GLYPHS[condition.trim().toLowerCase()] ?? null;
}

export function tokenConditionFallback(condition: string): string {
  const first = [...condition.trim()][0];
  return first ? first.toLocaleUpperCase() : '?';
}

export type TokenConditionBadge = {
  condition: string;
  glyph: string | null;
  fallback: string;
};

/**
 * `maxControls` includes the overflow control when one is needed. This keeps
 * compact token footprints from overlapping condition controls or a neighbor.
 */
export function tokenConditionBadges(
  conditions: readonly string[],
  maxControls = 4,
): { visible: TokenConditionBadge[]; overflow: number } {
  const normalized = conditions.filter((condition) => condition.trim().length > 0);
  const capacity = Math.max(1, Math.min(4, Math.floor(maxControls)));
  const needsOverflow = normalized.length > Math.min(3, capacity);
  const visibleCapacity = needsOverflow ? capacity - 1 : capacity;
  const visibleCount = Math.min(3, normalized.length, visibleCapacity);
  return {
    visible: normalized.slice(0, visibleCount).map((condition) => ({
      condition,
      glyph: tokenConditionGlyph(condition),
      fallback: tokenConditionFallback(condition),
    })),
    overflow: Math.max(0, normalized.length - visibleCount),
  };
}

export type TokenBadgePlacement = {
  left: number;
  top: number;
  visualSize: number;
  targetSize: number;
};

/**
 * Badge targets live along the lower edge, clear of the top-right unplace
 * control. The visual chip may be compact, while its hit target never falls
 * below 18px.
 */
export function tokenBadgePlacements(sizePx: number, count: number): TokenBadgePlacement[] {
  // A small token cannot host an 18px control below its centre without covering
  // the primary drag zone. Keep its marker visible but compact/decorative; a
  // full target is enabled only where it fits below the centre line.
  const maxTargetBelowCentre = Math.max(8, sizePx / 2 - 1);
  const targetSize = Math.min(18, maxTargetBelowCentre);
  const visualSize = Math.min(Math.max(8, Math.min(18, Math.round(sizePx * 0.38))), targetSize);
  const inset = Math.min(50, (targetSize / sizePx) * 50);
  const slots = Math.max(0, Math.min(4, Math.floor(count)));
  if (slots === 0) return [];
  const anchors = slots === 1
    ? [50]
    : Array.from({ length: slots }, (_, index) => inset + ((100 - 2 * inset) * index) / (slots - 1));
  return anchors.map((left) => ({
    left,
    // Controls remain inside the lower part of the token, never over a token
    // in the neighboring map cell.
    top: 100 - inset,
    visualSize,
    targetSize,
  }));
}

export function tokenDeathMarker(combatant: Pick<Combatant, 'kind' | 'hpCurrent' | 'hpBand' | 'deathState'>): 'dying' | 'dead' | null {
  if (combatant.deathState === 'dying') return 'dying';
  if (combatant.deathState === 'dead') return 'dead';
  if (combatant.kind !== 'character' && (combatant.hpCurrent != null ? combatant.hpCurrent <= 0 : combatant.hpBand === 'down')) {
    return 'dead';
  }
  return null;
}

export function parseTokenDetailMode(value: string | null | undefined): TokenDetailMode {
  return value === 'minimal' || value === 'off' || value === 'full' ? value : 'full';
}

export function readTokenDetailMode(storage: Pick<Storage, 'getItem'> | null | undefined): TokenDetailMode {
  try {
    return parseTokenDetailMode(storage?.getItem(TOKEN_DETAIL_STORAGE_KEY));
  } catch {
    return 'full';
  }
}

export function writeTokenDetailMode(
  mode: TokenDetailMode,
  storage: Pick<Storage, 'setItem'> | null | undefined,
): boolean {
  try {
    storage?.setItem(TOKEN_DETAIL_STORAGE_KEY, mode);
    return storage != null;
  } catch {
    return false;
  }
}
