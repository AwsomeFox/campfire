/**
 * Map-object write helpers (issue #2175). Issue #1308 placed/moved/labeled/deleted set pieces
 * through `MapObjectsPanel`'s own inline api calls; #2175 adds canvas interactions
 * (click-to-place, drag, resize) driven from `BattleMap`, so two callers now need the same
 * scoped `/encounters/:id/map-objects/:id` endpoints. Centralizing them here keeps the URL
 * shapes and the `invalidateEncounter` cache-bust in one place rather than duplicating them
 * across the panel and `RunSessionPage`'s BattleMap callbacks.
 *
 * Each function is the raw write + cache invalidation; callers own announce/error UI around
 * them (the panel surfaces a busy spinner and an error banner; BattleMap routes failures
 * through `onError`). The inner functions are `useCallback`-stable so a parent can thread them
 * through its own `useCallback` (e.g. RunSessionPage's `handleUpdateMapObject`) without churning
 * `BattleMap`'s `React.memo` boundary.
 */
import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { MapObject, MapObjectCreate, MapObjectUpdate } from '@campfire/schema';
import { api, API } from '../../lib/api';
import { invalidateEncounter } from '../../lib/query';

/**
 * A click-to-place arming (issue #2175): the icon/label a DM picked in the "Set pieces" panel,
 * held in page state between the panel (which arms) and `BattleMap` (which consumes the next
 * map press and places the object at the snapped point). `dmOnly` is part of the arm so a future
 * "place hidden" toggle could ride the same channel; today the panel always arms `dmOnly: false`.
 */
export type MapObjectPlacementArm = { iconSlug: string; label: string; dmOnly: boolean };

export type MapObjectsApi = {
  place: (create: MapObjectCreate) => Promise<MapObject>;
  update: (objectId: string, patch: MapObjectUpdate) => Promise<MapObject>;
  remove: (objectId: string) => Promise<void>;
};

export function useMapObjectsApi(encounterId: number): MapObjectsApi {
  const queryClient = useQueryClient();
  const place = useCallback(
    async (create: MapObjectCreate): Promise<MapObject> => {
      const result = await api.post<MapObject>(`${API}/encounters/${encounterId}/map-objects`, create);
      invalidateEncounter(queryClient, encounterId);
      return result;
    },
    [encounterId, queryClient],
  );
  const update = useCallback(
    async (objectId: string, patch: MapObjectUpdate): Promise<MapObject> => {
      const result = await api.patch<MapObject>(
        `${API}/encounters/${encounterId}/map-objects/${encodeURIComponent(objectId)}`,
        patch,
      );
      invalidateEncounter(queryClient, encounterId);
      return result;
    },
    [encounterId, queryClient],
  );
  const remove = useCallback(
    async (objectId: string): Promise<void> => {
      await api.delete(`${API}/encounters/${encounterId}/map-objects/${encodeURIComponent(objectId)}`);
      invalidateEncounter(queryClient, encounterId);
    },
    [encounterId, queryClient],
  );
  return { place, update, remove };
}
