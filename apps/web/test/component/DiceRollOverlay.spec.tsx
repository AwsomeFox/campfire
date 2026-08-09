/**
 * Component-render coverage for the dice overlay's no-WebGL fallback.
 *
 * jsdom has no WebGL context, so mounting the real overlay here exercises
 * exactly the path a locked-down browser or a software-rendering VM takes:
 * `startDiceRoll` fails to construct a renderer, returns null, and the overlay
 * must degrade to the CSS dice AND still reach `onSettled`. That last part is
 * what a source scan cannot check — if the fallback rendered but never settled,
 * the roll result toast would never appear and the player would simply never
 * learn what they rolled.
 */
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { describe, test, expect, vi, afterEach } from 'vitest';
import { DiceRollOverlay, buildOverlayDice } from '../../src/components/DiceRollOverlay';

afterEach(cleanup);

/** Which rendering path the overlay settled on. */
function renderer(): string | null {
  return screen.getByTestId('dice-roll-overlay').getAttribute('data-renderer');
}

describe('DiceRollOverlay without WebGL', () => {
  test('falls back to the CSS dice and still settles', async () => {
    const onSettled = vi.fn();
    render(
      <DiceRollOverlay
        dice={buildOverlayDice([20], [20], [20])}
        phase="settling"
        theme="nocturne"
        onSettled={onSettled}
      />,
    );

    // Starts on the 3D path — the fallback is only chosen once the dynamic
    // import has resolved and the renderer has actually failed.
    expect(renderer()).toBe('3d');

    await waitFor(() => expect(renderer()).toBe('css'), { timeout: 10_000 });
    expect(screen.queryByTestId('dice-roll-overlay-canvas')).toBeNull();
    expect(screen.getByText('20')).toBeTruthy();

    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1), { timeout: 10_000 });
  }, 20_000);

  test('shows the crit glyph only when colour-vision assist is on', async () => {
    const { rerender } = render(
      <DiceRollOverlay
        dice={buildOverlayDice([20], [20], [20])}
        phase="settling"
        onSettled={() => {}}
      />,
    );
    await waitFor(() => expect(renderer()).toBe('css'), { timeout: 10_000 });
    expect(screen.queryByTestId('dice-roll-overlay-assist-glyph')).toBeNull();

    rerender(
      <DiceRollOverlay
        dice={buildOverlayDice([20], [20], [20])}
        phase="settling"
        colorVisionAssist
        onSettled={() => {}}
      />,
    );
    expect(
      screen.getByTestId('dice-roll-overlay-assist-glyph').getAttribute('data-result'),
    ).toBe('crit');
  }, 20_000);
});
