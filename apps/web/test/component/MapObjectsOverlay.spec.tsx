/**
 * MapObjectsOverlay component coverage (issue #2175). The overlay is the single renderer for
 * placed set pieces — players see it read-only, a DM in the Move tool gets grabbable icons and a
 * resize grip. These mount the real component (jsdom + Testing Library) and assert the four
 * issue-#2175 behaviours that live in this layer: size-driven rendering, the move drag handle,
 * the selected-object resize grip (and that the grip's press does not also start a move), and
 * that live drag/resize overrides apply during a gesture.
 */
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { describe, test, expect, vi, afterEach } from 'vitest';
import type { MapObject } from '@campfire/schema';
import '../../src/i18n';

import { MapObjectsOverlay } from '../../src/features/encounters/map/MapObjectsOverlay';

afterEach(() => cleanup());

const MAP_RECT = { left: 0, top: 0, width: 1000, height: 800 };

function object(overrides: Partial<MapObject> = {}): MapObject {
  return {
    id: 'chest-1',
    label: 'Trapped chest',
    iconSlug: 'chest',
    x: 25,
    y: 40,
    size: 10,
    dmOnly: false,
    ...overrides,
  };
}

describe('MapObjectsOverlay (issue #2175)', () => {
  test('renders each icon at its size (percent of map width) and stays read-only by default', () => {
    render(<MapObjectsOverlay mapObjects={[object({ size: 10 })]} mapRect={MAP_RECT} />);
    const el = screen.getByTestId('map-object-chest-1');
    // size 10 → 10% of a 1000px-wide map = 100px diameter.
    expect(el.style.width).toBe('100px');
    expect(el.style.height).toBe('100px');
    // Read-only: no role, pointer-events disabled (players / non-Move tools).
    expect(el.getAttribute('role')).toBeNull();
    expect(el.style.pointerEvents).toBe('none');
    // No resize grip in read-only mode.
    expect(screen.queryByTestId('map-object-resize-chest-1')).toBeNull();
  });

  test('interactive mode turns the icon into a draggable handle that selects + arms a move', () => {
    const onObjectPointerDown = vi.fn();
    render(
      <MapObjectsOverlay
        mapObjects={[object()]}
        mapRect={MAP_RECT}
        interactive
        onObjectPointerDown={onObjectPointerDown}
      />,
    );
    const el = screen.getByTestId('map-object-chest-1');
    expect(el.getAttribute('role')).toBe('button');
    expect(el.tabIndex).toBe(0);
    expect(el.style.pointerEvents).toBe('auto');
    fireEvent.pointerDown(el, { button: 0, pointerId: 1 });
    expect(onObjectPointerDown).toHaveBeenCalledTimes(1);
    expect(onObjectPointerDown.mock.calls[0][1]).toMatchObject({ id: 'chest-1' });
  });

  test('the selected object shows a resize grip whose press starts a resize, not a move', () => {
    const onObjectPointerDown = vi.fn();
    const onResizeHandlePointerDown = vi.fn();
    render(
      <MapObjectsOverlay
        mapObjects={[object()]}
        mapRect={MAP_RECT}
        interactive
        selectedId="chest-1"
        onObjectPointerDown={onObjectPointerDown}
        onResizeHandlePointerDown={onResizeHandlePointerDown}
      />,
    );
    const grip = screen.getByTestId('map-object-resize-chest-1');
    expect(grip.getAttribute('aria-label')).toBeTruthy();
    fireEvent.pointerDown(grip, { button: 0, pointerId: 2 });
    // The grip stops propagation so the enclosing move handler never fires.
    expect(onResizeHandlePointerDown).toHaveBeenCalledTimes(1);
    expect(onResizeHandlePointerDown.mock.calls[0][1]).toMatchObject({ id: 'chest-1' });
    expect(onObjectPointerDown).not.toHaveBeenCalled();
  });

  test('live drag/resize overrides apply without waiting for the server PATCH', () => {
    render(
      <MapObjectsOverlay
        mapObjects={[object({ x: 25, y: 40, size: 10 })]}
        mapRect={MAP_RECT}
        dragOverride={{ id: 'chest-1', x: 70, y: 80 }}
        resizeOverride={{ id: 'chest-1', size: 30 }}
      />,
    );
    const el = screen.getByTestId('map-object-chest-1');
    // x 70 → 700px, y 80 → 640px (percent of map width/height in layer px).
    expect(el.style.left).toBe('700px');
    expect(el.style.top).toBe('640px');
    // size override 30 → 30% of 1000px = 300px.
    expect(el.style.width).toBe('300px');
  });
});
