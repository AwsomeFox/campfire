/**
 * Map objects overlay (issue #1308) — read-only rendering of persistent icons/set pieces
 * (chests, traps, doors, quest markers) at their placed percent coordinates. Sibling to
 * `GridOverlay`: extracted into its own memoized component (same issue #1917 stage-2
 * pattern) so BattleMap's own render — tokens, AoE, fog, drag state — never re-renders this
 * subtree, and vice versa.
 *
 * Deliberately non-interactive (`pointer-events: none` on every element, matching the map
 * layer's own "surface owns pointer gestures; children opt in" contract): placement, move,
 * label, and delete all happen through `MapObjectsPanel`'s form fields, not by dragging this
 * overlay. See that panel's own doc comment for why click-to-place/drag-on-canvas is
 * deliberately deferred rather than added to BattleMap's pointer-gesture state machine.
 *
 * Visibility itself needs no client-side gating: a `dmOnly` object is already dropped
 * wholesale by the server (`filterMapObjectsForViewer`) before it ever reaches a non-DM
 * `encounter.mapObjects` — this component renders exactly the list it's handed.
 */
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import type { MapObject } from '@campfire/schema';
import { GameIcon } from '../../../components/GameIcon';
import { UI_ICON_SIZE } from '../../../lib/uiIcons';
import { mapPercentToLayerPx, type Rect } from '../mapRenderedBounds';

export type MapObjectsOverlayProps = {
  mapObjects: readonly MapObject[];
  /** The object-contain map layer rect in surface px; no output while the map hasn't loaded. */
  mapRect: Rect | null;
};

export const MapObjectsOverlay = memo(function MapObjectsOverlay({ mapObjects, mapRect }: MapObjectsOverlayProps) {
  const { t } = useTranslation();
  if (!mapRect || mapObjects.length === 0) return null;
  return (
    <>
      {mapObjects.map((obj) => {
        const px = mapPercentToLayerPx({ x: obj.x, y: obj.y }, mapRect);
        return (
          <div
            key={obj.id}
            data-testid={`map-object-${obj.id}`}
            title={obj.label || t('encounters.map.objects.title')}
            style={{
              position: 'absolute',
              left: px.x,
              top: px.y,
              transform: 'translate(-50%, -50%)',
              pointerEvents: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 28,
              height: 28,
              borderRadius: '50%',
              background: 'color-mix(in srgb, var(--color-surface) 80%, transparent)',
              border: '1px solid var(--color-divider)',
            }}
          >
            <GameIcon slug={obj.iconSlug} size={UI_ICON_SIZE.sm} />
          </div>
        );
      })}
    </>
  );
});
