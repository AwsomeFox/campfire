/**
 * GatedControl — Measure without a grid scale (issue #1933).
 *
 * Before this change the Measure tool just went `disabled` with a hardcoded English
 * `title="Set a grid scale first"` (desktop-hover-only, no `aria-describedby`, no keyboard
 * reachability, nothing on tap). This pins the GatedControl affordance end to end in a real
 * browser: `aria-disabled` + a screen-reader-reachable reason while no scale is set, a
 * visible hint on keyboard focus, and the gate clearing the moment a grid scale lands.
 */
import { expect, test } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * A real, decodable 16x9 PNG — see grid-calibration.spec.ts's identical fixture doc comment
 * for why this (and not `seed.ts`'s `PNG_16_9`) is required: the attachment endpoint decodes
 * uploads to derive dimensions, and only this buffer survives that decode.
 */
const MEASURE_GATE_MAP_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAJCAIAAAC0SDtlAAAA/klEQVR42gXBMQFAERRA0RdBAIMIRuOPYBBAhBfhBjCIYDSKYBBAhBdBhH+OiOCEIEThE7JQBRUQujCEJWzhCiY8QcTjPMETPZ8ne6pHPXi6Z3iWZ3uuxzzPI5JwiZCIiS+REzWhCRI9MRIrsRM3YYmXECm4QijEwlfIhVrQAoVeGIVV2IVbsMIriChOCUpUPiUrVVEFpStDWcpWrmLKU0QarhEasfE1cqM2tEGjN0ZjNXbjNqzxGiITNwmTOPkmeVInOmHSJ2OyJntyJzZ5E5GDO4RDPHyHfKgHPXDoh3FYh324Bzu8g4jhjGBE4zOyUQ01MLoxjGVs4xpmPOMHGqHKgaBDFtMAAAAASUVORK5CYII=',
  'base64',
);

test.describe('GatedControl — Measure gate (issue #1933)', () => {
  test.use({ storageState: stateFor('dm') });

  test('aria-disabled with a reachable reason until a grid scale is set, then clears', async ({ page }) => {
    const { campaignId } = seed();

    const created = await page.request.post(`/api/v1/campaigns/${campaignId}/encounters`, {
      data: { name: 'Measure gate', hidden: false },
    });
    expect(created.ok()).toBe(true);
    const id = ((await created.json()) as { id: number }).id;

    const upload = await page.request.post(`/api/v1/campaigns/${campaignId}/attachments`, {
      multipart: {
        kind: 'map',
        file: { name: 'measure-gate-map.png', mimeType: 'image/png', buffer: MEASURE_GATE_MAP_PNG },
      },
    });
    expect(upload.ok()).toBe(true);
    const mapAttachmentId = ((await upload.json()) as { id: number }).id;
    const attached = await page.request.patch(`/api/v1/encounters/${id}`, { data: { mapAttachmentId } });
    expect(attached.ok()).toBe(true);

    await page.goto(`/c/${campaignId}/encounters/${id}`);
    const measureBtn = page.getByTestId('map-tool-measure');
    await expect(measureBtn).toBeVisible();

    // No grid scale yet: gated. Playwright's own enabled/disabled check treats
    // aria-disabled="true" the same as the native attribute, so this also proves the
    // control is genuinely inert, not merely LOOKING disabled.
    await expect(measureBtn).toHaveAttribute('aria-disabled', 'true');
    await expect(measureBtn).toBeDisabled();

    const describedBy = await measureBtn.getAttribute('aria-describedby');
    expect(describedBy, 'Measure must carry an aria-describedby reason while gated').toBeTruthy();
    await expect(page.locator(`#${describedBy}`)).toHaveText('Set a grid scale first to measure distances.');

    // Keyboard focus reveals a visible hint bubble (issue #1933's desktop acceptance
    // criterion) — not just the screen-reader-only text above.
    await measureBtn.focus();
    await expect(page.getByTestId('gated-control-hint').first()).toBeVisible();
    await measureBtn.blur();
    await expect(page.getByTestId('gated-control-hint')).toHaveCount(0);

    // Setting a grid scale clears the gate — the same reason must not survive.
    const scaled = await page.request.patch(`/api/v1/encounters/${id}`, {
      data: { gridSize: 8, gridScale: 5 },
    });
    expect(scaled.ok()).toBe(true);
    await page.reload();

    const measureBtnAfter = page.getByTestId('map-tool-measure');
    await expect(measureBtnAfter).toBeVisible();
    await expect(measureBtnAfter).toBeEnabled();
    await expect(measureBtnAfter).not.toHaveAttribute('aria-disabled', 'true');
  });

  // Issue #1933 review finding: `modeBtn` used to wrap Measure in GatedControl only when
  // `gateReason` was truthy (`gateReason ? <GatedControl>… : <button/>`), which changes the
  // tree shape the instant the reason clears — forcing React to unmount and remount the
  // button at exactly the false→true transition this affordance exists to explain. The
  // reload-based test above cannot catch that (a fresh mount looks identical to a
  // preserved one after a reload). This one never reloads: it marks the live DOM node,
  // focuses it, flips the gate via a real PATCH (propagated over the page's own SSE
  // connection, not a reload), and asserts the SAME node — with focus intact — is what
  // ends up enabled.
  test('setting the grid scale in place (no reload) does not remount the button or steal focus', async ({ page }) => {
    const { campaignId } = seed();

    const created = await page.request.post(`/api/v1/campaigns/${campaignId}/encounters`, {
      data: { name: 'Measure gate in-place', hidden: false },
    });
    expect(created.ok()).toBe(true);
    const id = ((await created.json()) as { id: number }).id;

    const upload = await page.request.post(`/api/v1/campaigns/${campaignId}/attachments`, {
      multipart: {
        kind: 'map',
        file: { name: 'measure-gate-inplace-map.png', mimeType: 'image/png', buffer: MEASURE_GATE_MAP_PNG },
      },
    });
    expect(upload.ok()).toBe(true);
    const mapAttachmentId = ((await upload.json()) as { id: number }).id;
    const attached = await page.request.patch(`/api/v1/encounters/${id}`, { data: { mapAttachmentId } });
    expect(attached.ok()).toBe(true);

    await page.goto(`/c/${campaignId}/encounters/${id}`);
    const measureBtn = page.getByTestId('map-tool-measure');
    await expect(measureBtn).toHaveAttribute('aria-disabled', 'true');

    await measureBtn.focus();
    await expect(measureBtn).toBeFocused();
    await measureBtn.evaluate((el) => el.setAttribute('data-stable-probe', '1'));

    const scaled = await page.request.patch(`/api/v1/encounters/${id}`, {
      data: { gridSize: 8, gridScale: 5 },
    });
    expect(scaled.ok()).toBe(true);

    // No reload: the gate must clear via the page's own live encounter read.
    await expect(measureBtn).toBeEnabled({ timeout: 15_000 });
    await expect(measureBtn).not.toHaveAttribute('aria-disabled', 'true');
    // Same node (probe survived) and focus never left it.
    await expect(measureBtn).toHaveAttribute('data-stable-probe', '1');
    await expect(measureBtn).toBeFocused();
  });
});
