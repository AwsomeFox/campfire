/**
 * Publish the CSS variables the undo snackbar uses to clear mobile chrome
 * (issue #794): `--cf-tabbar-content-height` and `--cf-keyboard-inset`.
 *
 * Measurements:
 *  - `.cf-tabbar` via ResizeObserver (0 when `display: none` / absent)
 *  - safe-area via a cached padding probe reading `env(safe-area-inset-bottom)`
 *  - keyboard via `visualViewport` height / offsetTop
 *
 * Vars are published in `useLayoutEffect` (before paint) so the first visible
 * frame already clears the tab bar instead of sitting at the `0px` defaults.
 */
import { useLayoutEffect } from 'react';
import {
  keyboardInsetFromVisualViewport,
  tabBarContentHeightPx,
} from './undoSnackbarLayout';

const TABBAR_VAR = '--cf-tabbar-content-height';
const KEYBOARD_VAR = '--cf-keyboard-inset';

/** Reused probe — create once, read via getComputedStyle on each publish. */
let safeAreaProbe: HTMLDivElement | null = null;

function ensureSafeAreaProbe(): HTMLDivElement {
  if (safeAreaProbe?.isConnected) return safeAreaProbe;
  const probe = document.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.setAttribute('data-cf-safe-area-probe', '');
  probe.style.cssText =
    'position:fixed;left:0;bottom:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
    'padding-bottom:env(safe-area-inset-bottom,0px)';
  document.documentElement.appendChild(probe);
  safeAreaProbe = probe;
  return probe;
}

function readSafeAreaBottomPx(): number {
  const probe = ensureSafeAreaProbe();
  return Number.parseFloat(getComputedStyle(probe).paddingBottom) || 0;
}

function measureTabBarHeightPx(): number {
  const tabbar = document.querySelector('.cf-tabbar');
  if (!(tabbar instanceof HTMLElement)) return 0;
  const style = getComputedStyle(tabbar);
  if (style.display === 'none' || style.visibility === 'hidden') return 0;
  return tabbar.getBoundingClientRect().height;
}

function publishChromeVars(): void {
  const safeArea = readSafeAreaBottomPx();
  const content = tabBarContentHeightPx(measureTabBarHeightPx(), safeArea);
  const vv = window.visualViewport;
  const keyboard = vv
    ? keyboardInsetFromVisualViewport({
        layoutViewportHeightPx: window.innerHeight,
        visualViewportHeightPx: vv.height,
        visualViewportOffsetTopPx: vv.offsetTop,
      })
    : 0;
  const root = document.documentElement.style;
  root.setProperty(TABBAR_VAR, `${content}px`);
  root.setProperty(KEYBOARD_VAR, `${keyboard}px`);
}

/** Keep snackbar chrome CSS variables in sync while the bar is mounted. */
export function useUndoSnackbarChrome(): void {
  useLayoutEffect(() => {
    // Measure + publish before the browser paints so the first frame already
    // clears the tab bar / keyboard instead of using the 0px CSS defaults.
    publishChromeVars();

    const tabbar = document.querySelector('.cf-tabbar');
    const ro =
      typeof ResizeObserver !== 'undefined' && tabbar instanceof HTMLElement
        ? new ResizeObserver(() => publishChromeVars())
        : null;
    if (ro && tabbar instanceof HTMLElement) ro.observe(tabbar);

    const vv = window.visualViewport;
    const onViewport = () => publishChromeVars();
    window.addEventListener('resize', onViewport);
    vv?.addEventListener('resize', onViewport);
    vv?.addEventListener('scroll', onViewport);

    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', onViewport);
      vv?.removeEventListener('resize', onViewport);
      vv?.removeEventListener('scroll', onViewport);
      const root = document.documentElement.style;
      root.removeProperty(TABBAR_VAR);
      root.removeProperty(KEYBOARD_VAR);
      // Leave the cached probe in the document — safe-area rarely changes and
      // recreating it on every snackbar mount would reintroduce DOM thrash.
    };
  }, []);
}
