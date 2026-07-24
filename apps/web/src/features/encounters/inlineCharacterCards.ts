/**
 * Run-session inline character card freshness (issue #421).
 *
 * Sheet edits (stats/actions/saves/skills/slots) used to leave the expanded
 * encounter card stale because the SSE handler only accepted frames that carried
 * the current encounter id. Character writes emit `character.updated` without an
 * encounter id — this helper decides when to invalidate the campaign character
 * list, and surfaces reconnect/stale copy so obsolete roll modifiers are not
 * trusted while the stream is down.
 */

import type { CampaignEvent } from '@campfire/schema';
import type { CampaignEventsStatus } from '../../lib/useCampaignEvents';

/** Events that should refetch linked character sheets on the run-session page. */
export function shouldInvalidateInlineCharacters(event: CampaignEvent): boolean {
  // character.updated — sheet / member-resource writes (no encounterId by design).
  // membership.revoked — ownership/roster may change for remaining viewers.
  return event.type === 'character.updated' || event.type === 'membership.revoked';
}

/**
 * Whether click-to-roll should stay enabled. Offline/reconnecting means modifiers
 * on screen may be obsolete — disable rolls until the stream is healthy again.
 * A brief refetch while connected keeps rolls enabled; React Query swaps in the
 * fresh character object without remounting the card (local expand state survives).
 */
export function inlineCharacterSheetsInteractive(status: CampaignEventsStatus | null): boolean {
  if (status === 'offline' || status === 'reconnecting' || status === 'stopped') return false;
  return true;
}

/** Short status line for the combatant list; null when sheets are considered live. */
export function inlineCharacterSheetsStatusLabel(
  status: CampaignEventsStatus | null,
  charactersFetching: boolean,
): string | null {
  if (status === 'offline') return 'Character sheets offline — reconnecting…';
  if (status === 'reconnecting' || status === 'stopped') {
    return 'Character sheets may be out of date — reconnecting…';
  }
  if (charactersFetching) return 'Refreshing character sheets…';
  return null;
}
