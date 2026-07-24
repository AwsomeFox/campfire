import { expect, test } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * Issue #845 — ImageUpload dropzone drag-active must not flicker when the
 * pointer crosses child boundaries (label text, nested flex wrappers).
 *
 * Dispatches the native enter/leave sequence the browser emits when moving
 * from the dropzone into a child, then asserts `data-drag-active` never
 * briefly leaves `"true"`. Also covers clear-on-drop, clear-on-blur, and
 * keyboard activation of the click-to-upload control.
 */
test.describe('image upload drag affordance (issue #845)', () => {
  test.use({ storageState: stateFor('dm') });

  test('stays drag-active while crossing child boundaries; clears on drop and blur', async ({
    page,
  }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}`);

    const dropzone = page.getByRole('button', {
      name: /Drop a handout image, or click to choose/i,
    });
    await expect(dropzone).toBeVisible();
    await expect(dropzone).toHaveAttribute('data-drag-active', 'false');

    const child = dropzone.locator('span').first();
    await expect(child).toBeVisible();

    // Record every data-drag-active mutation while we synthesize the
    // parent→child boundary crossing that used to flicker.
    await dropzone.evaluate((zone) => {
      const samples: string[] = [];
      (window as unknown as { __cfDragSamples: string[] }).__cfDragSamples = samples;
      samples.push(zone.getAttribute('data-drag-active') ?? '');
      const obs = new MutationObserver(() => {
        samples.push(zone.getAttribute('data-drag-active') ?? '');
      });
      obs.observe(zone, { attributes: true, attributeFilter: ['data-drag-active'] });
      (window as unknown as { __cfDragObs: MutationObserver }).__cfDragObs = obs;
    });

    await dropzone.evaluate((zone, childSelector) => {
      const childEl = zone.querySelector(childSelector);
      if (!childEl) throw new Error('dropzone child missing');

      const fire = (type: string, target: EventTarget, related: EventTarget | null) => {
        const ev = new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          relatedTarget: related as EventTarget,
        });
        target.dispatchEvent(ev);
      };

      // Enter the dropzone.
      fire('dragenter', zone, null);
      fire('dragover', zone, null);
      // Cross into the label child — the classic leave/enter flicker pair.
      fire('dragleave', zone, childEl);
      fire('dragenter', childEl, zone);
      fire('dragover', childEl, null);
    }, 'span');

    // Let React commit; then read the sample stream.
    await expect(dropzone).toHaveAttribute('data-drag-active', 'true');
    const samples = await page.evaluate(() => {
      const w = window as unknown as {
        __cfDragSamples: string[];
        __cfDragObs: MutationObserver;
      };
      w.__cfDragObs.disconnect();
      return w.__cfDragSamples;
    });

    // After the initial "false", every observed value must stay "true"
    // through the child-boundary crossing — never a false dip (flicker).
    expect(samples[0]).toBe('false');
    const afterEnter = samples.slice(1);
    expect(afterEnter.length).toBeGreaterThan(0);
    expect(afterEnter.every((v) => v === 'true')).toBe(true);

    // Drop clears the affordance.
    await dropzone.evaluate((zone) => {
      zone.dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }),
      );
    });
    await expect(dropzone).toHaveAttribute('data-drag-active', 'false');

    // Re-enter, then window blur must clear (stuck-highlight guard).
    await dropzone.evaluate((zone) => {
      zone.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true }));
    });
    await expect(dropzone).toHaveAttribute('data-drag-active', 'true');
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect(dropzone).toHaveAttribute('data-drag-active', 'false');
  });

  test('preserves click-to-upload and keyboard activation', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}`);

    const dropzone = page.getByRole('button', {
      name: /Drop a handout image, or click to choose/i,
    });
    await expect(dropzone).toBeVisible();
    await expect(dropzone.locator('input[type="file"]')).toBeAttached();

    const [viaClick] = await Promise.all([
      page.waitForEvent('filechooser'),
      dropzone.click(),
    ]);
    expect(viaClick.isMultiple()).toBe(false);

    await dropzone.focus();
    const [viaEnter] = await Promise.all([
      page.waitForEvent('filechooser'),
      dropzone.press('Enter'),
    ]);
    expect(viaEnter).toBeTruthy();

    await dropzone.focus();
    const [viaSpace] = await Promise.all([
      page.waitForEvent('filechooser'),
      dropzone.press(' '),
    ]);
    expect(viaSpace).toBeTruthy();
  });
});
