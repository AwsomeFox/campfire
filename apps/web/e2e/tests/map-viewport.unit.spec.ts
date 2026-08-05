/**
 * Battle-map viewport transform (issue #712).
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  applyPinch,
  applyWheelZoom,
  DEFAULT_MAP_VIEWPORT,
  fitViewport,
  formatViewportZoomPercent,
  MAP_VIEWPORT_MAX_SCALE,
  MAP_VIEWPORT_MIN_SCALE,
  MAP_VIEWPORT_ZOOM_STEP,
  panBy,
  resetViewport,
  surfaceToContentPoint,
  viewportTransformStyle,
  zoomAtPoint,
  zoomByFactor,
} from '../../src/features/encounters/mapViewport';

const BATTLE_MAP = resolve(__dirname, '../../src/features/encounters/map/BattleMap.tsx');
const VIEWPORT_MODULE = resolve(__dirname, '../../src/features/encounters/mapViewport.ts');

const SURFACE = { w: 800, h: 450 };

test.describe('mapViewport math (issue #712)', () => {
  test('default viewport is identity transform', () => {
    expect(DEFAULT_MAP_VIEWPORT).toEqual({ scale: 1, panX: 0, panY: 0 });
    expect(viewportTransformStyle(DEFAULT_MAP_VIEWPORT)).toBe('translate(0px, 0px) scale(1)');
    expect(fitViewport()).toEqual(DEFAULT_MAP_VIEWPORT);
    expect(resetViewport()).toEqual(DEFAULT_MAP_VIEWPORT);
  });

  test('zoomAtPoint keeps the focal content point fixed', () => {
    const start = { scale: 1, panX: 0, panY: 0 };
    const focalX = 400;
    const focalY = 225;
    const next = zoomAtPoint(start, focalX, focalY, 2, SURFACE);
    const before = surfaceToContentPoint(focalX, focalY, start);
    const after = surfaceToContentPoint(focalX, focalY, next);
    expect(after.x).toBeCloseTo(before.x, 5);
    expect(after.y).toBeCloseTo(before.y, 5);
    expect(next.scale).toBe(2);
  });

  test('zoomByFactor clamps to min/max scale', () => {
    const min = zoomByFactor({ scale: MAP_VIEWPORT_MIN_SCALE, panX: 0, panY: 0 }, 0.1, 100, 100, SURFACE);
    expect(min.scale).toBe(MAP_VIEWPORT_MIN_SCALE);
    const max = zoomByFactor({ scale: MAP_VIEWPORT_MAX_SCALE, panX: 0, panY: 0 }, 2, 100, 100, SURFACE);
    expect(max.scale).toBe(MAP_VIEWPORT_MAX_SCALE);
  });

  test('panBy moves content and clampPan locks pan at scale 1', () => {
    const panned = panBy(DEFAULT_MAP_VIEWPORT, 40, 20, SURFACE);
    expect(panned.panX).toBe(0);
    expect(panned.panY).toBe(0);
    const zoomed = zoomAtPoint(DEFAULT_MAP_VIEWPORT, 400, 225, 2, SURFACE);
    const moved = panBy(zoomed, 30, -15, SURFACE);
    expect(moved.panX).not.toBe(zoomed.panX);
    expect(moved.panY).not.toBe(zoomed.panY);
  });

  test('applyWheelZoom zooms in for negative deltaY (trackpad pinch-out / wheel up)', () => {
    const next = applyWheelZoom(DEFAULT_MAP_VIEWPORT, -120, 200, 150, SURFACE);
    expect(next.scale).toBeGreaterThan(1);
  });

  test('applyPinch scales around the gesture centre', () => {
    const gesture = {
      startViewport: DEFAULT_MAP_VIEWPORT,
      startDistance: 100,
      startCenterX: 400,
      startCenterY: 225,
    };
    const next = applyPinch(gesture, 400, 225, 200, SURFACE);
    expect(next.scale).toBeCloseTo(2, 5);
  });

  test('formatViewportZoomPercent rounds for assistive labels', () => {
    expect(formatViewportZoomPercent(1)).toBe('100%');
    expect(formatViewportZoomPercent(MAP_VIEWPORT_ZOOM_STEP)).toBe('120%');
  });
});

test.describe('RunSessionPage wires viewport navigation (issue #712)', () => {
  test('imports mapViewport helpers and exposes a separate viewport toolbar', () => {
    const source = readFileSync(BATTLE_MAP, 'utf8');
    expect(source).toMatch(/from ['"]\.\.\/mapViewport['"]/);
    expect(source).toMatch(/data-testid="map-viewport-toolbar"/);
    expect(source).toMatch(/data-testid="battle-map-viewport"/);
    expect(source).toMatch(/viewportTransformStyle/);
    expect(source).toMatch(/surfaceToContentPoint/);
    expect(readFileSync(VIEWPORT_MODULE, 'utf8')).toMatch(/#712/);
  });
});
