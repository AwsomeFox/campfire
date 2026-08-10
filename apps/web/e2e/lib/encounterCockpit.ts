/**
 * Encounter cockpit navigation helpers.
 *
 * The run page is the full-viewport VTT cockpit: the map owns the canvas and
 * everything else lives in one of the side panel's tabs (Turn / Party / Log /
 * Driver / Table). The panel opens on Turn while combat is running and on Party
 * otherwise, so a spec that drives the roster, the log, or the table-wide setup
 * has to say which tab it wants rather than assuming one long scrolling page.
 * Driver only exists while the campaign's AI-DM mode is 'driver' (issue #2158) —
 * a spec targeting it must first arrange for that mode, the same precondition
 * the AI driver dock itself already needed to render at all.
 *
 * Both helpers are idempotent — calling them when the target is already open is
 * a no-op, so they are safe to call defensively at the top of a flow.
 */
import { expect, type Locator, type Page } from '@playwright/test';

export type CockpitTab = 'turn' | 'party' | 'log' | 'driver' | 'table';

/** Bring one of the cockpit side-panel tabs to the front. */
export async function openCockpitTab(page: Page, tab: CockpitTab): Promise<void> {
  // The panel can be collapsed to give the map the full width; re-open it first.
  const reopen = page.getByTestId('encounter-vtt-panel-open');
  if (await reopen.isVisible().catch(() => false)) await reopen.click();

  const button = page.getByTestId(`encounter-vtt-tab-${tab}`);
  await expect(button).toBeVisible();
  // At phone widths the tab strip scrolls horizontally, so the target can be partly off
  // its own scroller — scroll it in first, and retry, because a click that lands on the
  // clipped edge is delivered without changing the selection.
  await expect(async () => {
    if ((await button.getAttribute('aria-selected')) === 'true') return;
    await button.scrollIntoViewIfNeeded();
    await button.click();
    await expect(button).toHaveAttribute('aria-selected', 'true', { timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
}

/** Open the floating dice tray behind the cockpit's Roll button. */
export async function openCockpitDiceTray(page: Page): Promise<void> {
  const roll = page.getByTestId('encounter-vtt-roll');
  await expect(roll).toBeVisible();
  if ((await roll.getAttribute('aria-expanded')) !== 'true') await roll.click();
  await expect(page.getByTestId('encounter-vtt-dice-tray')).toBeVisible();
}

/**
 * The panel section for one tab.
 *
 * Every section stays mounted and is merely hidden when another tab is showing (see
 * `VttPanelSection`), so a bare `getByText(...)`/`.first()` can resolve to a copy in a
 * hidden panel — the roster's combatant names also appear in the Turn panel's summary,
 * for instance. Scope through this when the text you want exists in more than one tab.
 */
export function cockpitPanel(page: Page, tab: CockpitTab): Locator {
  return page.getByTestId(`encounter-vtt-tabpanel-${tab}`);
}
