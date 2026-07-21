/**
 * Shared location exploration-status label — used by both the world list
 * (LocationListPage) and the location detail page. Kept here so the wording and
 * the "current" map-marker icon can't drift between the two views.
 */
import type { Location } from '@campfire/schema';
import { GameIcon } from './GameIcon';

/** Display text per location exploration status. */
export const LOCATION_STATUS_LABEL: Record<Location['status'], string> = {
  unexplored: 'Unexplored',
  explored: 'Explored',
  current: 'Current',
};

/**
 * Status text with a map-marker glyph on the "current" status — the only status
 * that carries an icon (explored/unexplored are text-only, as before).
 */
export function LocationStatusLabel({ status }: { status: Location['status'] }) {
  return (
    <span className="inline-flex items-center gap-1">
      {status === 'current' && <GameIcon slug="position-marker" size={11} />}
      {LOCATION_STATUS_LABEL[status]}
    </span>
  );
}
