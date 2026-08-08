import { expect, test } from '@playwright/test';
import { restoreSeedEncounter, seed, stateFor } from './seed';

test.use({ storageState: stateFor('player'), viewport: { width: 1280, height: 800 } });

test('safety bar reachability over the cockpit', async ({ page }) => {
  await restoreSeedEncounter(page);
  const { campaignId, encounterId } = seed();
  await page.goto(`/c/${campaignId}/encounters/${encounterId}`);
  await expect(page.getByTestId('encounter-vtt-canvas')).toBeVisible();
  const info = await page.evaluate(() => {
    const bar = document.querySelector('[data-testid="safety-bar"]') as HTMLElement | null;
    if (!bar) return { present: false };
    const r = bar.getBoundingClientRect();
    const cx = Math.round(r.left + r.width / 2);
    const cy = Math.round(r.top + r.height / 2);
    const hit = document.elementFromPoint(cx, cy);
    return {
      present: true,
      rect: { top: Math.round(r.top), height: Math.round(r.height) },
      hitTag: hit?.tagName,
      hitClass: (hit as HTMLElement | null)?.className?.toString().slice(0, 60),
      coveredByCockpit: Boolean(hit?.closest('.cf-vtt')),
    };
  });
  console.log('SAFETY', JSON.stringify(info));
  const shell = await page.evaluate(() => {
    const el = document.querySelector('.cf-vtt') as HTMLElement;
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), height: Math.round(r.height), inset: getComputedStyle(document.documentElement).getPropertyValue('--cf-immersive-chrome-inset') };
  });
  console.log('SHELL', JSON.stringify(shell));
  // The safety control must be genuinely clickable, not merely rendered.
  await page.getByTestId('safety-bar').getByRole('button').first().click({ trial: true });
  console.log('CLICKABLE ok');
});
