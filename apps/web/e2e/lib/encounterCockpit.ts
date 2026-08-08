/**
 * Encounter cockpit navigation helpers.
 *
 * The run page is the full-viewport VTT cockpit: the map owns the canvas and
 * everything else lives in one of the side panel's tabs (Turn / Party / Log /
 * Table). The panel opens on Turn while combat is running and on Party
 * otherwise, so a spec that drives the roster, the log, or the table-wide setup
 * has to say which tab it wants rather than assuming one long scrolling page.
 *
 * Both helpers are idempotent — calling them when the target is already open is
 * a no-op, so they are safe to call defensively at the top of a flow.
 */
import { expect, type Page } from '@playwright/test';

export type CockpitTab = 'turn' | 'party' | 'log' | 'table';

/** Bring one of the cockpit side-panel tabs to the front. */
export async function openCockpitTab(page: Page, tab: CockpitTab): Promise<void> {
  // The panel can be collapsed to give the map the full width; re-open it first.
  const reopen = page.getByTestId('encounter-vtt-panel-open');
  if (await reopen.isVisible().catch(() => false)) await reopen.click();

  const button = page.getByTestId(`encounter-vtt-tab-${tab}`);
  await expect(button).toBeVisible();
  if ((await button.getAttribute('aria-selected')) === 'true') return;
  await button.click();
  await expect(button).toHaveAttribute('aria-selected', 'true');
}

/** Open the floating dice tray behind the cockpit's Roll button. */
export async function openCockpitDiceTray(page: Page): Promise<void> {
  const roll = page.getByTestId('encounter-vtt-roll');
  await expect(roll).toBeVisible();
  if ((await roll.getAttribute('aria-expanded')) !== 'true') await roll.click();
  await expect(page.getByTestId('encounter-vtt-dice-tray')).toBeVisible();
}
