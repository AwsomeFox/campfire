/**
 * Battle-map token tray partitioning (issue #418).
 *
 * Fog redaction nulls tokenX/tokenY for non-DM viewers when a token sits outside
 * revealed regions. Without a separate signal, those combatants look "Unplaced"
 * and the owner is offered a place-at-center action that cannot produce visible
 * success. The server sets `tokenHiddenByFog` so we can show an owner-safe state
 * without leaking coordinates.
 */

export type MapTokenCoords = {
  tokenX: number | null;
  tokenY: number | null;
  /** Ephemeral fog-redaction flag from the encounter GET (false/undefined = not fog-hidden). */
  tokenHiddenByFog?: boolean;
};

export type MapTokenBuckets<T extends MapTokenCoords> = {
  /** Tokens with visible coordinates — render on the map. */
  placed: T[];
  /** Truly unplaced (null coords, not fog-hidden) — may offer place-at-center. */
  unplaced: T[];
  /** Placed in storage but coordinates withheld by fog — no place action. */
  hiddenByFog: T[];
};

export function isTokenHiddenByFog(c: MapTokenCoords): boolean {
  return c.tokenHiddenByFog === true;
}

export function isTokenPlacedOnMap(c: MapTokenCoords): boolean {
  return c.tokenX != null && c.tokenY != null;
}

export function isTokenTrulyUnplaced(c: MapTokenCoords): boolean {
  return !isTokenPlacedOnMap(c) && !isTokenHiddenByFog(c);
}

/** Partition combatants for the map surface + side trays. */
export function partitionMapTokens<T extends MapTokenCoords>(combatants: readonly T[]): MapTokenBuckets<T> {
  const placed: T[] = [];
  const unplaced: T[] = [];
  const hiddenByFog: T[] = [];
  for (const c of combatants) {
    if (isTokenPlacedOnMap(c)) placed.push(c);
    else if (isTokenHiddenByFog(c)) hiddenByFog.push(c);
    else unplaced.push(c);
  }
  return { placed, unplaced, hiddenByFog };
}

/** Owner-safe copy for tokens whose position is withheld by fog. */
export const FOG_HIDDEN_TOKEN_LABEL = 'Placed outside the revealed area';
