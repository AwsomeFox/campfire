/**
 * Battle-map viewport transform (issue #712).
 *
 * Local UI state only — zoom/pan never syncs to the server. The 16:9 surface keeps
 * object-contain letterboxing; this layer scales/translates the rendered map content
 * (image + grid + tokens + fog + rulers + pings + AoE) together.
 */

export type MapViewportState = {
  /** 1 = default fit; >1 zooms in. */
  scale: number;
  /** Translation in surface CSS pixels (applied before scale). */
  panX: number;
  panY: number;
};

export type Size = { w: number; h: number };

export const DEFAULT_MAP_VIEWPORT: MapViewportState = { scale: 1, panX: 0, panY: 0 };

export const MAP_VIEWPORT_MIN_SCALE = 1;
export const MAP_VIEWPORT_MAX_SCALE = 4;
export const MAP_VIEWPORT_ZOOM_STEP = 1.2;
export const MAP_VIEWPORT_PAN_STEP_PX = 48;
export const MAP_VIEWPORT_WHEEL_ZOOM_SENSITIVITY = 0.0015;

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return MAP_VIEWPORT_MIN_SCALE;
  return Math.max(MAP_VIEWPORT_MIN_SCALE, Math.min(MAP_VIEWPORT_MAX_SCALE, scale));
}

/** CSS transform for the viewport content wrapper (origin top-left). */
export function viewportTransformStyle(viewport: MapViewportState): string {
  return `translate(${viewport.panX}px, ${viewport.panY}px) scale(${viewport.scale})`;
}

/** Surface-local pointer → content-local (pre-transform) coordinates. */
export function surfaceToContentPoint(
  surfaceX: number,
  surfaceY: number,
  viewport: MapViewportState,
): { x: number; y: number } {
  const scale = viewport.scale || 1;
  return {
    x: (surfaceX - viewport.panX) / scale,
    y: (surfaceY - viewport.panY) / scale,
  };
}

/** Zoom toward a focal point in surface-local coordinates. */
export function zoomAtPoint(
  viewport: MapViewportState,
  focalX: number,
  focalY: number,
  nextScale: number,
  surface: Size,
): MapViewportState {
  const scale = clampScale(nextScale);
  const content = surfaceToContentPoint(focalX, focalY, viewport);
  const next: MapViewportState = {
    scale,
    panX: focalX - content.x * scale,
    panY: focalY - content.y * scale,
  };
  return clampPan(next, surface);
}

export function zoomByFactor(
  viewport: MapViewportState,
  factor: number,
  focalX: number,
  focalY: number,
  surface: Size,
): MapViewportState {
  return zoomAtPoint(viewport, focalX, focalY, viewport.scale * factor, surface);
}

export function panBy(
  viewport: MapViewportState,
  deltaX: number,
  deltaY: number,
  surface: Size,
): MapViewportState {
  return clampPan(
    {
      ...viewport,
      panX: viewport.panX + deltaX,
      panY: viewport.panY + deltaY,
    },
    surface,
  );
}

/** Fit and reset both return the default view (object-contain already fits the map). */
export function fitViewport(): MapViewportState {
  return { ...DEFAULT_MAP_VIEWPORT };
}

export function resetViewport(): MapViewportState {
  return { ...DEFAULT_MAP_VIEWPORT };
}

/**
 * Keep at least part of the scaled content visible. At scale ≤ 1, pan is locked to origin
 * so the letterboxed map stays centred.
 */
export function clampPan(viewport: MapViewportState, surface: Size): MapViewportState {
  if (!(surface.w > 0) || !(surface.h > 0)) return viewport;
  if (viewport.scale <= 1 + 1e-6) {
    return { scale: viewport.scale, panX: 0, panY: 0 };
  }
  const scaledW = surface.w * viewport.scale;
  const scaledH = surface.h * viewport.scale;
  const minPanX = surface.w - scaledW;
  const minPanY = surface.h - scaledH;
  return {
    scale: viewport.scale,
    panX: Math.min(0, Math.max(minPanX, viewport.panX)),
    panY: Math.min(0, Math.max(minPanY, viewport.panY)),
  };
}

/** Wheel / trackpad delta → next viewport (zoom toward cursor). */
export function applyWheelZoom(
  viewport: MapViewportState,
  deltaY: number,
  focalX: number,
  focalY: number,
  surface: Size,
): MapViewportState {
  const factor = Math.exp(-deltaY * MAP_VIEWPORT_WHEEL_ZOOM_SENSITIVITY);
  return zoomByFactor(viewport, factor, focalX, focalY, surface);
}

export type PinchGesture = {
  startViewport: MapViewportState;
  startDistance: number;
  startCenterX: number;
  startCenterY: number;
};

/** Two-finger pinch: scale around the gesture centre and pan with the centre drift. */
export function applyPinch(
  gesture: PinchGesture,
  centerX: number,
  centerY: number,
  distance: number,
  surface: Size,
): MapViewportState {
  if (!(gesture.startDistance > 0) || !(distance > 0)) return gesture.startViewport;
  const nextScale = clampScale(gesture.startViewport.scale * (distance / gesture.startDistance));
  const zoomed = zoomAtPoint(
    gesture.startViewport,
    gesture.startCenterX,
    gesture.startCenterY,
    nextScale,
    surface,
  );
  const driftX = centerX - gesture.startCenterX;
  const driftY = centerY - gesture.startCenterY;
  return clampPan(
    {
      ...zoomed,
      panX: zoomed.panX + driftX,
      panY: zoomed.panY + driftY,
    },
    surface,
  );
}

export function formatViewportZoomPercent(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}
