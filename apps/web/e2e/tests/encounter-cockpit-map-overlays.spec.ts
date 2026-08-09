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
import { openCockpitDiceTray } from '../lib/encounterCockpit';

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

test.describe('encounter cockpit — setup canvas on a phone', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test('the dice tray stays closable when the canvas is showing setup', async ({ page }) => {
    await restoreSeedEncounter(page);
    const { campaignId } = seed();
    const created = await page.request.post(`/api/v1/campaigns/${campaignId}/encounters`, {
      data: { name: 'Phone setup drill', hidden: false },
    });
    expect(created.ok()).toBe(true);
    const id = ((await created.json()) as { id: number }).id;

    try {
      // No map, so the canvas stacks its chrome instead of floating it — and on a phone
      // that column is taller than the ~140px canvas. Unbounded, the tray pushed the Roll
      // toggle past a clipped edge, leaving the tray open with no way to dismiss it.
      await page.goto(`/c/${campaignId}/encounters/${id}`);
      await expect(page.getByTestId('encounter-vtt-canvas')).toBeVisible();

      const roll = page.getByTestId('encounter-vtt-roll');
      await roll.click();
      const tray = page.getByTestId('encounter-vtt-dice-tray');
      await expect(tray).toBeVisible();

      const bounded = await page.evaluate(() => {
        const el = document.querySelector('.cf-vtt-tray') as HTMLElement;
        const canvas = document.querySelector('.cf-vtt-main') as HTMLElement;
        return el.getBoundingClientRect().height <= canvas.getBoundingClientRect().height;
      });
      expect(bounded, 'the tray must never be taller than the canvas it sits in').toBe(true);

      // Reachable again — scrolling the setup column is allowed, being clipped away is not.
      await roll.scrollIntoViewIfNeeded();
      await roll.click();
      await expect(tray).not.toBeVisible();
    } finally {
      await page.request.delete(`/api/v1/encounters/${id}`).catch(() => undefined);
      await restoreSeedEncounter(page);
    }
  });
});

test.describe('encounter cockpit — gated tool hints', () => {
  test('a rail gate reason is readable, not clipped and not behind the cockpit', async ({ page }) => {
    await restoreSeedEncounter(page);
    const { campaignId } = seed();
    const created = await page.request.post(`/api/v1/campaigns/${campaignId}/encounters`, {
      data: { name: 'Rail hint drill', hidden: false },
    });
    expect(created.ok()).toBe(true);
    const id = ((await created.json()) as { id: number }).id;
    const up = await page.request.post(`/api/v1/campaigns/${campaignId}/attachments`, {
      multipart: { kind: 'map', file: { name: 'hint.png', mimeType: 'image/png', buffer: PNG } },
    });
    expect(up.ok()).toBe(true);
    const mapAttachmentId = ((await up.json()) as { id: number }).id;
    // A map with NO grid scale: Measure is gated, which is the reason bubble under test.
    await page.request.patch(`/api/v1/encounters/${id}`, { data: { mapAttachmentId } });

    try {
      await page.goto(`/c/${campaignId}/encounters/${id}`);
      const gatedTool = page.getByTestId('map-tool-measure');
      await expect(gatedTool).toBeVisible();
      await gatedTool.focus();

      const hint = page.getByTestId('gated-control-hint').first();
      await expect(hint).toBeVisible();

      // `toBeVisible()` is not enough here, and that is the whole point: it passed while
      // the bubble was sliced to the 58px rail, and passed again while it was portaled to
      // <body> UNDERNEATH the opaque cockpit. Hit-testing cannot help either — the bubble
      // is `pointer-events: none`, so `elementFromPoint` never returns it. So: measure the
      // geometry, and sample the pixel actually painted at its centre.
      const box = await hint.boundingBox();
      expect(box).not.toBeNull();
      const railWidth = await page.evaluate(
        () => document.querySelector('.cf-vtt-rail')?.getBoundingClientRect().width ?? 0,
      );
      // Wider than the rail it lives in — i.e. it escaped the clip rather than being sliced.
      expect(Math.round(box!.width)).toBeGreaterThan(Math.round(railWidth));

      const shot = await page.screenshot({
        clip: { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2, width: 2, height: 2 },
      });
      // The bubble's own ground (`--color-neutral-900`, #292b31) must be what is on screen
      // there. Caveat worth knowing before trusting this line: Measure sits high in the
      // rail, so its bubble lands ABOVE the cockpit's top edge — this sample therefore
      // proves the bubble is painted and unclipped, but does NOT exercise the stacking fix
      // (`.cf-gated-hint--escaped`) that a bubble anchored lower down would need.
      const pixel = await page.evaluate(
        (data) =>
          new Promise<number[]>((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
              const canvas = document.createElement('canvas');
              canvas.width = img.width;
              canvas.height = img.height;
              const ctx = canvas.getContext('2d');
              if (!ctx) return reject(new Error('no 2d context'));
              ctx.drawImage(img, 0, 0);
              const data2 = ctx.getImageData(0, 0, 1, 1).data;
              resolve([data2[0], data2[1], data2[2]]);
            };
            img.onerror = () => reject(new Error('decode failed'));
            img.src = `data:image/png;base64,${data}`;
          }),
        shot.toString('base64'),
      );
      const distance = Math.hypot(pixel[0] - 0x29, pixel[1] - 0x2b, pixel[2] - 0x31);
      expect(distance, `painted ${JSON.stringify(pixel)} where the hint should be`).toBeLessThan(24);
    } finally {
      await page.request.delete(`/api/v1/encounters/${id}`).catch(() => undefined);
      await restoreSeedEncounter(page);
    }
  });

  test('a hint on a header control stays on screen instead of escaping off the top', async ({ page }) => {
    const { campaignId, encounterId } = seed();
    // Stub the campaign event stream with a body that never delivers a sync event: that
    // is what the encounter's write gate treats as a degraded connection, which is how a
    // real safety hold or outage disables these lifecycle actions.
    await page.route(`**/api/v1/campaigns/${campaignId}/events`, async (route) => {
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': keepalive\n\n' });
    });

    try {
      await page.goto(`/c/${campaignId}/encounters/${encounterId}`);
      await expect(page.getByTestId('encounter-vtt-header')).toBeVisible();

      const gated = page.getByTestId('encounter-vtt-header').locator('.cf-gated-disabled').first();
      await expect(gated).toBeVisible({ timeout: 15_000 });
      await gated.focus();

      const hint = page.getByTestId('gated-control-hint').first();
      await expect(hint).toBeVisible();

      // The header is itself a clipping ancestor AND starts at the top of the viewport,
      // so a hint anchored above its trigger went off-screen — during exactly the outage
      // that made it worth reading. Every edge must be inside the viewport.
      const placement = await hint.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return {
          top: Math.round(r.top),
          left: Math.round(r.left),
          right: Math.round(r.right),
          bottom: Math.round(r.bottom),
          vw: window.innerWidth,
          vh: window.innerHeight,
        };
      });
      expect(placement.top, 'hint must not run off the top').toBeGreaterThanOrEqual(0);
      expect(placement.left, 'hint must not run off the left').toBeGreaterThanOrEqual(0);
      expect(placement.right).toBeLessThanOrEqual(placement.vw);
      expect(placement.bottom).toBeLessThanOrEqual(placement.vh);
    } finally {
      await page.unroute(`**/api/v1/campaigns/${campaignId}/events`).catch(() => undefined);
      await restoreSeedEncounter(page);
    }
  });
});

test.describe('encounter cockpit — short narrow canvas', () => {
  test('the dice tray keeps a usable scroller in a short landscape phone canvas', async ({ page }) => {
    await restoreSeedEncounter(page);
    const { campaignId } = seed();
    const created = await page.request.post(`/api/v1/campaigns/${campaignId}/encounters`, {
      data: { name: 'Short landscape drill', hidden: false },
    });
    expect(created.ok()).toBe(true);
    const id = ((await created.json()) as { id: number }).id;
    const up = await page.request.post(`/api/v1/campaigns/${campaignId}/attachments`, {
      multipart: { kind: 'map', file: { name: 'landscape.png', mimeType: 'image/png', buffer: PNG } },
    });
    expect(up.ok()).toBe(true);
    const mapAttachmentId = ((await up.json()) as { id: number }).id;
    await page.request.patch(`/api/v1/encounters/${id}`, { data: { mapAttachmentId, gridSize: 8, gridScale: 5 } });

    try {
      // Under the 900px branch, where the tray is pinned to both canvas edges instead of
      // sized. The panel stacks below the map here, so this leaves a ~150px canvas —
      // measured — against a top inset plus a 150px reserve that consumed all of it.
      await page.setViewportSize({ width: 720, height: 600 });
      await page.goto(`/c/${campaignId}/encounters/${id}`);
      await expect(page.getByTestId('battle-map-surface')).toBeVisible();

      await openCockpitDiceTray(page);
      const tray = await page.evaluate(() => {
        const el = document.querySelector('.cf-vtt-tray') as HTMLElement | null;
        const canvas = document.querySelector('.cf-vtt-main') as HTMLElement | null;
        if (!el || !canvas) return null;
        const a = el.getBoundingClientRect();
        const b = canvas.getBoundingClientRect();
        return {
          height: Math.round(a.height),
          overhang: Math.round(Math.max(0, a.bottom - b.bottom, b.top - a.top)),
          canvasHeight: Math.round(b.height),
        };
      });
      expect(tray, 'the dice tray must exist once opened').not.toBeNull();
      // A scroller, not a sliver — and entirely inside the canvas that clips it.
      expect(tray!.height).toBeGreaterThan(40);
      expect(tray!.overhang, 'the tray must not hang past the canvas edge').toBeLessThanOrEqual(1);
    } finally {
      await page.request.delete(`/api/v1/encounters/${id}`).catch(() => undefined);
      await restoreSeedEncounter(page);
    }
  });
});

test.describe('encounter cockpit — short canvas', () => {
  test('grid & fog stays usable when the canvas is barely taller than its own reserve', async ({ page }) => {
    await restoreSeedEncounter(page);
    const { campaignId } = seed();
    const created = await page.request.post(`/api/v1/campaigns/${campaignId}/encounters`, {
      data: { name: 'Short canvas drill', hidden: false },
    });
    expect(created.ok()).toBe(true);
    const id = ((await created.json()) as { id: number }).id;
    const up = await page.request.post(`/api/v1/campaigns/${campaignId}/attachments`, {
      multipart: { kind: 'map', file: { name: 'short.png', mimeType: 'image/png', buffer: PNG } },
    });
    expect(up.ok()).toBe(true);
    const mapAttachmentId = ((await up.json()) as { id: number }).id;
    await page.request.patch(`/api/v1/encounters/${id}`, { data: { mapAttachmentId, gridSize: 8, gridScale: 5 } });

    try {
      // Wide but very short: this leaves a ~132px canvas — measured, not guessed — which
      // is below both the overlays' 190px reserve (it goes negative and clamped to
      // nothing) and the 178px the Roll control needs for its fixed bottom offset plus
      // its own height. A 400px viewport still yields a 251px canvas and catches neither.
      await page.setViewportSize({ width: 1280, height: 260 });
      await page.goto(`/c/${campaignId}/encounters/${id}`);
      await expect(page.getByTestId('battle-map-surface')).toBeVisible();

      await page.getByRole('button', { name: /Grid & fog/i }).click();

      const usable = await page.evaluate(() => {
        const aside = document.querySelector('.cf-vtt-map-aside') as HTMLElement | null;
        const canvas = document.querySelector('.cf-vtt-main') as HTMLElement | null;
        if (!aside || !canvas) return null;
        const a = aside.getBoundingClientRect();
        const b = canvas.getBoundingClientRect();
        return {
          height: Math.round(a.height),
          canvasHeight: Math.round(b.height),
          overhang: Math.round(Math.max(0, a.bottom - b.bottom, b.top - a.top)),
        };
      });
      expect(usable, 'the map aside must exist').not.toBeNull();
      // Something rather than nothing, and every pixel of it inside the clipping canvas —
      // a box that overhangs the clipped edge sizes its scroller from the full box, so
      // the last Grid & fog controls cannot be scrolled into view at all.
      expect(usable!.height).toBeGreaterThan(24);
      expect(usable!.overhang, 'the aside must not hang past the canvas edge').toBeLessThanOrEqual(1);

      // The Roll control itself has to stay inside the clipping canvas — a fixed 132px
      // bottom offset plus its own 46px height put it above the top edge here, where it
      // cannot be clicked and the dice tray is unreachable no matter how well bounded.
      const fab = await page.evaluate(() => {
        const el = document.querySelector('.cf-vtt-fab') as HTMLElement | null;
        const canvas = document.querySelector('.cf-vtt-main') as HTMLElement | null;
        if (!el || !canvas) return null;
        const a = el.getBoundingClientRect();
        const b = canvas.getBoundingClientRect();
        return { overhang: Math.round(Math.max(0, a.bottom - b.bottom, b.top - a.top)), height: Math.round(a.height) };
      });
      expect(fab, 'the Roll control must exist').not.toBeNull();
      expect(fab!.height).toBeGreaterThan(20);
      expect(fab!.overhang, 'the Roll control must not be clipped out of the canvas').toBeLessThanOrEqual(1);

      // Close the aside so the Roll button is unobstructed, then check the tray it opens
      // is actually inside the canvas: a fixed 190px bottom offset on a canvas shorter
      // than that put the tray's own bottom edge above the canvas top, so a visible Roll
      // button opened something clipped out of existence.
      await page.getByRole('button', { name: /Grid & fog/i }).click();
      await openCockpitDiceTray(page);
      const tray = await page.evaluate(() => {
        const el = document.querySelector('.cf-vtt-tray') as HTMLElement | null;
        const canvas = document.querySelector('.cf-vtt-main') as HTMLElement | null;
        if (!el || !canvas) return null;
        const a = el.getBoundingClientRect();
        const b = canvas.getBoundingClientRect();
        return {
          visibleHeight: Math.round(Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)),
          height: Math.round(a.height),
        };
      });
      expect(tray, 'the dice tray must exist once opened').not.toBeNull();
      expect(tray!.height).toBeGreaterThan(40);
      // Essentially all of it on screen, not a sliver.
      expect(tray!.visibleHeight).toBeGreaterThanOrEqual(tray!.height - 2);
    } finally {
      await page.request.delete(`/api/v1/encounters/${id}`).catch(() => undefined);
      await restoreSeedEncounter(page);
    }
  });
});
