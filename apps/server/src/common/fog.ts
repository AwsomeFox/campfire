import { FogState } from '@campfire/schema';
import type { FogState as FogStateType } from '@campfire/schema';
import { fromJsonText } from './json';

/**
 * Parse persisted fog JSON defensively. Invalid legacy data degrades to no fog so
 * ordinary encounter reads remain available; callers that expose map pixels must
 * still fail closed when a valid, enabled fog mask exists.
 */
export function parseFogState(text: string | null): FogStateType | null {
  if (text == null) return null;
  const parsed = FogState.safeParse(fromJsonText<unknown>(text, null));
  return parsed.success ? parsed.data : null;
}

/**
 * Whether an enabled fog state still conceals any source pixels.
 *
 * A single full-board rectangle is the canonical "Reveal all" shape emitted by
 * the web and MCP clients. More complicated unions are intentionally treated as
 * protected: denying a raw-source shortcut is harmless, while incorrectly
 * deciding a many-rectangle union covers every pixel would disclose the map.
 */
export function fogConcealsPixels(fog: FogStateType | null | undefined): boolean {
  if (!fog?.enabled) return false;
  return !fog.revealed.some((rect) => rect.x <= 0 && rect.y <= 0 && rect.x + rect.w >= 100 && rect.y + rect.h >= 100);
}

/**
 * Security-sensitive interpretation of persisted fog.
 *
 * Encounter reads keep tolerating malformed legacy JSON by exposing `fog: null`,
 * but byte-serving paths cannot interpret malformed state as "reveal everything".
 * Any non-null value that no longer validates is therefore protected with an
 * all-concealed raster until a DM saves a valid fog state.
 */
export function persistedFogConcealsPixels(text: string | null): boolean {
  if (text == null) return false;
  const fog = parseFogState(text);
  return fog === null || fogConcealsPixels(fog);
}
