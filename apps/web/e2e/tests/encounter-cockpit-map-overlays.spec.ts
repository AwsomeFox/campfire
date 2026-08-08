/**
 * The cockpit's two floating map panels must never sit on top of each other.
 *
 * The secondary map chrome floats over the canvas in two columns: `cf-vtt-map-aside`
 * (grid & fog, token editor, load status) anchored left of the board, and
 * `cf-vtt-map-tray` (token tray, tool help) anchored right. They were each sized to the
 * FULL usable width, so between roughly 960px and 1240px they overlapped — and because
 * the tray comes later in the DOM at the same z-index, it silently swallowed clicks
 * meant for the aside's controls. Each is now capped at half the free canvas.
 *
 * Sweeping the widths matters: the bug is invisible at 1440 (where both fit) and at
 * phone widths (where neither floats), so a single-viewport check would have missed it.
 */
import { expect, test } from '@playwright/test';
import { restoreSeedEncounter, seed, stateFor } from './seed';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAJCAIAAAC0SDtlAAAA/klEQVR42gXBMQFAERRA0RdBAIMIRuOPYBBAhBfhBjCIYDSKYBBAhBdBhH+OiOCEIEThE7JQBRUQujCEJWzhCiY8QcTjPMETPZ8ne6pHPXi6Z3iWZ3uuxzzPI5JwiZCIiS+REzWhCRI9MRIrsRM3YYmXECm4QijEwlfIhVrQAoVeGIVV2IVbsMIriChOCUpUPiUrVVEFpStDWcpWrmLKU0QarhEasfE1cqM2tEGjN0ZjNXbjNqzxGiITNwmTOPkmeVInOmHSJ2OyJntyJzZ5E5GDO4RDPHyHfKgHPXDoh3FYh324Bzu8g4jhjGBE4zOyUQ01MLoxjGVs4xpmPOMHGqHKgaBDFtMAAAAASUVORK5CYII=',
  'base64',
);

test.use({ storageState: stateFor('dm') });

test('the floating map panels never overlap at any cockpit width', async ({ page }) => {
  await restoreSeedEncounter(page);
  const { campaignId } = seed();
  const created = await page.request.post(`/api/v1/campaigns/${campaignId}/encounters`, { data: { name: 'Overlap drill', hidden: false } });
  const id = ((await created.json()) as { id: number }).id;
  const up = await page.request.post(`/api/v1/campaigns/${campaignId}/attachments`, {
    multipart: { kind: 'map', file: { name: 'm.png', mimeType: 'image/png', buffer: PNG } },
  });
  const mapAttachmentId = ((await up.json()) as { id: number }).id;
  await page.request.patch(`/api/v1/encounters/${id}`, { data: { mapAttachmentId, gridSize: 8, gridScale: 5 } });

  try {
    for (const width of [960, 1024, 1100, 1200, 1280, 1440]) {
      await page.setViewportSize({ width, height: 850 });
      await page.goto(`/c/${campaignId}/encounters/${id}`);
      await expect(page.getByTestId('battle-map-surface')).toBeVisible();
      await page.waitForTimeout(300);
      const r = await page.evaluate(() => {
        const a = document.querySelector('.cf-vtt-map-aside') as HTMLElement | null;
        const t = document.querySelector('.cf-vtt-map-tray') as HTMLElement | null;
        if (!a || !t) return null;
        const ar = a.getBoundingClientRect();
        const tr = t.getBoundingClientRect();
        return { aside: [Math.round(ar.left), Math.round(ar.right)], tray: [Math.round(tr.left), Math.round(tr.right)], overlapPx: Math.round(Math.max(0, Math.min(ar.right, tr.right) - Math.max(ar.left, tr.left))) };
      });
      // Both must actually be on screen, or a "no overlap" pass would be vacuous.
      expect(r, `map overlays missing at ${width}px`).not.toBeNull();
      expect(r!.overlapPx, `overlap at ${width}px: ${JSON.stringify(r)}`).toBe(0);
    }
  } finally {
    await page.request.delete(`/api/v1/encounters/${id}`);
    await restoreSeedEncounter(page);
  }
});
