import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const HOOK = readFileSync(
  resolve(__dirname, '../../src/features/encounters/vtt/useImmersiveChromeInset.ts'),
  'utf8',
);
const SHELL = readFileSync(
  resolve(__dirname, '../../src/features/encounters/vtt/EncounterVttShell.tsx'),
  'utf8',
);
const DEEP_LINK_FOCUS = readFileSync(resolve(__dirname, '../../src/app/EntityDeepLinkFocus.tsx'), 'utf8');

/**
 * Two invariants of the immersive cockpit that a rendering test cannot cheaply reach: one
 * needs a viewport where Layout's chrome already fills half the screen, the other a
 * comment list that takes eight seconds to arrive. Both are guarded here at the source,
 * next to the arithmetic and the constant that carry them.
 */
test.describe('the immersive chrome cap', () => {
  test('is whatever remains under the cockpit clamp, with no floor added past it', () => {
    // `.cf-vtt` pins its `top` at `min(inset, 50vh)` no matter what this hook publishes,
    // so a floor here is a floor the cockpit will not honour — a check prompt sized by it
    // extends under a scroll-locked overlay and loses its lower controls.
    expect(HOOK).toContain('return Math.max(0, Math.floor(budget - above));');
    expect(HOOK, 'no minimum may be added on top of the remaining budget').not.toContain(
      'MIN_CHROME_CAP_PX',
    );
  });

  test('both measurements baseline on <main>, not on the optional chrome', () => {
    // Both selectors are optional — the safety bar is absent outside a campaign and the
    // prompts unmount with an empty queue — so anchoring only on them measured zero.
    const anchors = HOOK.match(/document\.getElementById\(MAIN_CONTENT_ID\)/g) ?? [];
    expect(anchors.length).toBeGreaterThanOrEqual(2);
  });
});

test.describe('the cockpit deep-link resolver', () => {
  test('waits exactly as long as EntityDeepLinkFocus observes', () => {
    // That observer takes its ONE focus attempt the moment the target mounts. If this
    // resolver has already stopped polling by then, the attempt lands on an element still
    // inside a hidden panel, where focus() is refused, and nothing retries it.
    expect(DEEP_LINK_FOCUS).toContain('export const ENTITY_DEEP_LINK_WINDOW_MS = 10_000;');
    expect(DEEP_LINK_FOCUS).toContain('window.setTimeout(() => observer?.disconnect(), ENTITY_DEEP_LINK_WINDOW_MS)');
    expect(SHELL).toContain('const maxAttempts = Math.ceil(ENTITY_DEEP_LINK_WINDOW_MS / 250);');
    expect(SHELL).toContain('attempts > maxAttempts');
  });

  test('retries focus across frames rather than once', () => {
    // A reveal is a React state change; one frame later the panel can still be laying out
    // and `focus()` is silently refused inside a `hidden` ancestor.
    expect(SHELL).toContain('if (document.activeElement === target) {');
    expect(SHELL).toContain('if (attemptsLeft-- > 0) frame = requestAnimationFrame(settle);');
  });
});
