/**
 * Map objects overlay (issue #1308, extended #2175) — renders persistent icons/set pieces
 * (chests, traps, doors, quest markers) at their placed percent coordinates. Sibling to
 * `GridOverlay`: extracted into its own memoized component (the issue #1917 stage-2 pattern)
 * so BattleMap's own render — tokens, AoE, fog, drag state — never re-renders this subtree,
 * and vice versa.
 *
 * Issue #2175 makes this layer interactive for a DM in the Move tool: each icon becomes a
 * drag handle (mirrors BattleMap's own `AoeTemplate` handle pattern — the persisted overlay
 * object owns its drag/resize UI rather than routing through a separate handle div), and the
 * selected object grows a corner resize grip. Non-DM viewers, the cast projection, and any
 * non-Move tool see the same icons read-only (`pointer-events: none`), so placement/move/resize
 * stay DM-gated and the layer stays inert for players. Live `dragOverride`/`resizeOverride`
 * apply an in-progress gesture's position/size without waiting for a server PATCH on every
 * pointermove — BattleMap clears them on release, then the cache refetch lands the committed
 * value. The memo boundary holds: those overrides (and the selected id) are the only props
 * that change during a map-object gesture, so a token drag elsewhere — which changes none of
 * them — never re-renders this subtree.
 *
 * Visibility itself needs no client-side gating: a `dmOnly` object is already dropped wholesale
 * by the server (`filterMapObjectsForViewer`) before it ever reaches a non-DM
 * `encounter.mapObjects` — this component renders exactly the list it's handed.
 */
import { memo } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { MapObject } from '@campfire/schema';
import { GameIcon } from '../../../components/GameIcon';
import { mapPercentToLayerPx, type Rect } from '../mapRenderedBounds';

export type MapObjectsOverlayProps = {
  mapObjects: readonly MapObject[];
  /** The object-contain map layer rect in surface px; no output while the map hasn't loaded. */
  mapRect: Rect | null;
  /**
   * DM Move-tool interactivity. When true, each icon is a draggable handle and the selected
   * object shows a resize grip; when false (players, cast, or any non-Move tool) the whole
   * layer is `pointer-events: none` and decorative.
   */
  interactive?: boolean;
  /** The DM's currently-selected object (shows the resize grip + selection ring), or null. */
  selectedId?: string | null;
  /** Live position override during a move gesture (cleared on release). */
  dragOverride?: { id: string; x: number; y: number } | null;
  /** Live size override during a resize gesture (cleared on release). */
  resizeOverride?: { id: string; size: number } | null;
  onObjectPointerDown?: (e: ReactPointerEvent<HTMLDivElement>, obj: MapObject) => void;
  // The resize grip renders as a <button>, so its event carries HTMLButtonElement.
  onResizeHandlePointerDown?: (e: ReactPointerEvent<HTMLButtonElement>, obj: MapObject) => void;
  onObjectKeyDown?: (e: ReactKeyboardEvent<HTMLDivElement>, obj: MapObject) => void;
};

export const MapObjectsOverlay = memo(function MapObjectsOverlay({
  mapObjects,
  mapRect,
  interactive = false,
  selectedId = null,
  dragOverride = null,
  resizeOverride = null,
  onObjectPointerDown,
  onResizeHandlePointerDown,
  onObjectKeyDown,
}: MapObjectsOverlayProps) {
  const { t } = useTranslation();
  if (!mapRect || mapObjects.length === 0) return null;
  return (
    <>
      {mapObjects.map((obj) => {
        const px = mapPercentToLayerPx(
          {
            x: dragOverride && dragOverride.id === obj.id ? dragOverride.x : obj.x,
            y: dragOverride && dragOverride.id === obj.id ? dragOverride.y : obj.y,
          },
          mapRect,
        );
        const effectiveSize = resizeOverride && resizeOverride.id === obj.id ? resizeOverride.size : obj.size;
        // `size` is percent of the rendered map WIDTH (isotropic — matches the grid/calibration
        // unit in mapRenderedBounds), so a resized icon stays circular on every aspect ratio.
        const diameterPx = (effectiveSize / 100) * mapRect.width;
        const iconPx = Math.max(12, Math.round(diameterPx * 0.6));
        const selected = interactive && selectedId === obj.id;
        const label = obj.label || t('encounters.map.objects.title');
        return (
          <div
            key={obj.id}
            data-testid={`map-object-${obj.id}`}
            role={interactive ? 'button' : undefined}
            tabIndex={interactive ? 0 : undefined}
            aria-label={label}
            aria-keyshortcuts={interactive ? 'ArrowUp ArrowDown ArrowLeft ArrowRight' : undefined}
            title={interactive ? `${label} — ${t('encounters.map.objects.dragHint')}` : label}
            style={{
              position: 'absolute',
              left: px.x,
              top: px.y,
              transform: 'translate(-50%, -50%)',
              pointerEvents: interactive ? 'auto' : 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: diameterPx,
              height: diameterPx,
              borderRadius: '50%',
              background: 'color-mix(in srgb, var(--color-surface) 80%, transparent)',
              border: selected ? '2px solid var(--color-accent)' : '1px solid var(--color-divider)',
              boxShadow: selected ? '0 0 0 1px rgba(15,23,42,.35)' : undefined,
              cursor: interactive ? 'grab' : 'default',
              touchAction: interactive ? 'none' : undefined,
              zIndex: selected ? 6 : 5,
            }}
            onPointerDown={interactive ? (e) => onObjectPointerDown?.(e, obj) : undefined}
            onKeyDown={interactive ? (e) => onObjectKeyDown?.(e, obj) : undefined}
          >
            <GameIcon slug={obj.iconSlug} size={iconPx} />
            {selected && (
              <button
                type="button"
                data-testid={`map-object-resize-${obj.id}`}
                aria-label={t('encounters.map.objects.resizeHandle')}
                // Stop propagation so the grip's press starts the resize gesture, not the
                // enclosing move gesture (mirrors AoeTemplate's own handle-vs-shape split).
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onResizeHandlePointerDown?.(e, obj);
                }}
                style={{
                  position: 'absolute',
                  right: -6,
                  bottom: -6,
                  width: 12,
                  height: 12,
                  borderRadius: 3,
                  padding: 0,
                  background: 'var(--color-accent)',
                  border: '1px solid rgba(15,23,42,.7)',
                  cursor: 'nwse-resize',
                  touchAction: 'none',
                  zIndex: 7,
                }}
              />
            )}
          </div>
        );
      })}
    </>
  );
});
