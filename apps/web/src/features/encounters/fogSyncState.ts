import type { FogState } from '@campfire/schema';
import { fogStatesEqual } from '@campfire/schema';

/**
 * Reconcile an incoming encounter snapshot with a local fog edit. While the PATCH is
 * pending, its optimistic fog remains authoritative so a stale poll cannot clear undo
 * history or interrupt an active region drag.
 */
export function reconcileFogSyncState({
  serverFog,
  localFog,
  pendingFog,
}: {
  serverFog: FogState | null;
  localFog: FogState | null;
  pendingFog: FogState | null | undefined;
}): { fog: FogState | null; resetLocalUi: boolean } {
  if (pendingFog !== undefined) return { fog: pendingFog, resetLocalUi: false };
  if (fogStatesEqual(serverFog, localFog)) return { fog: localFog, resetLocalUi: false };
  return { fog: serverFog, resetLocalUi: true };
}
