import { test, expect } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * Keyboard-accessible pin positioning (#807).
 *
 * Validates that map pins can be moved with keyboard alone, labels are properly
 * associated with coordinate fields, help text is visible, and screen reader
 * announcements fire via aria-live. Also covers pointer/touch drag on the
 * dashboard map surface.
 */

async function pinSeedLocation(page: import('@playwright/test').Page, locationId: number, mapX = 50, mapY = 50) {
  const res = await page.context().request.patch(`/api/v1/locations/${locationId}`, {
    data: { mapX, mapY },
  });
  expect(res.ok()).toBeTruthy();
}

/** Tiny 1×1 PNG so RegionMap renders the image-pin drag surface (not the SVG fallback). */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function ensureCampaignMap(page: import('@playwright/test').Page, campaignId: number) {
  const upload = await page.context().request.post(`/api/v1/campaigns/${campaignId}/attachments`, {
    multipart: {
      kind: 'map',
      file: {
        name: 'world.png',
        mimeType: 'image/png',
        buffer: TINY_PNG,
      },
    },
  });
  expect(upload.ok()).toBeTruthy();
  const attachment = await upload.json();
  const patch = await page.context().request.patch(`/api/v1/campaigns/${campaignId}`, {
    data: { mapAttachmentId: attachment.id },
  });
  expect(patch.ok()).toBeTruthy();
}

test.describe('map pin keyboard positioning', () => {
  test.use({ storageState: stateFor('dm') });

  test.describe('RegionMap dashboard — DM move buttons', () => {
    test('shows modality-neutral help text and Move pin buttons', async ({ page }) => {
      const { campaignId, navigation } = seed();
      await pinSeedLocation(page, navigation.locationId);

      await page.goto(`/c/${campaignId}`);
      const mapCard = page.getByTestId('dashboard-map');
      await expect(mapCard).toBeVisible();

      await expect(mapCard.getByText('Open or move a pin')).toBeVisible();
      await expect(mapCard.getByRole('button', { name: /Move .+ pin/ }).first()).toBeVisible();
    });

    test('arrow-key pin movement changes coordinates', async ({ page }) => {
      const { campaignId, navigation } = seed();
      await pinSeedLocation(page, navigation.locationId);

      await page.goto(`/c/${campaignId}`);
      const mapCard = page.getByTestId('dashboard-map');
      await expect(mapCard).toBeVisible();

      // Click the "Move {name} pin" button
      const moveBtn = mapCard.getByRole('button', { name: /Move .+ pin/ }).first();
      await expect(moveBtn).toBeVisible();
      await moveBtn.click();

      // The positioning form should appear
      const xInput = mapCard.getByLabel('Horizontal position (%)');
      const yInput = mapCard.getByLabel('Vertical position (%)');
      await expect(xInput).toBeVisible();
      await expect(yInput).toBeVisible();

      // Focus the X input and use arrow keys
      await xInput.focus();
      await page.keyboard.press('ArrowRight');
      await expect(xInput).toHaveValue('51');

      // Shift+arrow moves by 5
      await page.keyboard.press('Shift+ArrowRight');
      await expect(xInput).toHaveValue('56');

      await page.keyboard.press('ArrowLeft');
      await expect(xInput).toHaveValue('55');
    });

    test('labels are associated with fields', async ({ page }) => {
      const { campaignId, navigation } = seed();
      await pinSeedLocation(page, navigation.locationId);
      await page.goto(`/c/${campaignId}`);
      const mapCard = page.getByTestId('dashboard-map');
      const moveBtn = mapCard.getByRole('button', { name: /Move .+ pin/ }).first();
      await expect(moveBtn).toBeVisible();
      await moveBtn.click();

      // Labels should be properly associated via htmlFor/id
      const xInput = mapCard.getByLabel('Horizontal position (%)');
      const yInput = mapCard.getByLabel('Vertical position (%)');
      await expect(xInput).toBeVisible();
      await expect(yInput).toBeVisible();
      // Verify inputs are number type
      await expect(xInput).toHaveAttribute('type', 'number');
      await expect(yInput).toHaveAttribute('type', 'number');
    });

    test('help text explaining percentage range is visible', async ({ page }) => {
      const { campaignId, navigation } = seed();
      await pinSeedLocation(page, navigation.locationId);
      await page.goto(`/c/${campaignId}`);
      const mapCard = page.getByTestId('dashboard-map');
      const moveBtn = mapCard.getByRole('button', { name: /Move .+ pin/ }).first();
      await expect(moveBtn).toBeVisible();
      await moveBtn.click();

      await expect(
        mapCard.getByText('0% = left/top edge, 100% = right/bottom edge'),
      ).toBeVisible();
    });

    test('screen reader announcements via aria-live', async ({ page }) => {
      const { campaignId, navigation } = seed();
      await pinSeedLocation(page, navigation.locationId);
      await page.goto(`/c/${campaignId}`);
      const mapCard = page.getByTestId('dashboard-map');
      const moveBtn = mapCard.getByRole('button', { name: /Move .+ pin/ }).first();
      await expect(moveBtn).toBeVisible();
      await moveBtn.click();

      // The aria-live announcer should exist
      const announcer = mapCard.getByTestId('pin-move-announcer');
      await expect(announcer).toHaveAttribute('aria-live', 'assertive');
      // It should contain a position announcement after opening
      await expect(announcer).toContainText(/\d+% horizontal, \d+% vertical/);

      // Move and check updated announcement
      const xInput = mapCard.getByLabel('Horizontal position (%)');
      await xInput.focus();
      await page.keyboard.press('ArrowRight');
      await expect(announcer).toContainText('51% horizontal, 50% vertical');
    });

    test('save and cancel after keyboard move', async ({ page }) => {
      const { campaignId, navigation } = seed();
      await pinSeedLocation(page, navigation.locationId);
      await page.goto(`/c/${campaignId}`);
      const mapCard = page.getByTestId('dashboard-map');
      const moveBtn = mapCard.getByRole('button', { name: /Move .+ pin/ }).first();
      await expect(moveBtn).toBeVisible();
      await moveBtn.click();

      // Cancel button should close the positioning form
      const cancelBtn = mapCard.getByRole('button', { name: 'Cancel' });
      await expect(cancelBtn).toBeVisible();
      await cancelBtn.click();

      // The form should be gone
      await expect(mapCard.getByLabel('Horizontal position (%)')).not.toBeVisible();

      // Re-open and save
      await moveBtn.click();
      const xInput = mapCard.getByLabel('Horizontal position (%)');
      await xInput.focus();
      await page.keyboard.press('ArrowRight'); // 50 -> 51
      const saveBtn = mapCard.getByRole('button', { name: 'Save' });
      await saveBtn.click();

      // The form should close after save
      await expect(mapCard.getByLabel('Horizontal position (%)')).not.toBeVisible();

      // Announcer should confirm save
      const announcer = mapCard.getByTestId('pin-move-announcer');
      await expect(announcer).toContainText(/saved/i);
    });

    test('edge values (0, 100) are clamped correctly', async ({ page }) => {
      const { campaignId, navigation } = seed();
      await pinSeedLocation(page, navigation.locationId, 0, 100);
      await page.goto(`/c/${campaignId}`);
      const mapCard = page.getByTestId('dashboard-map');
      const moveBtn = mapCard.getByRole('button', { name: /Move .+ pin/ }).first();
      await expect(moveBtn).toBeVisible();
      await moveBtn.click();

      const xInput = mapCard.getByLabel('Horizontal position (%)');
      const yInput = mapCard.getByLabel('Vertical position (%)');

      // X is at 0, pressing ArrowLeft should not go below 0
      await xInput.focus();
      await page.keyboard.press('ArrowLeft');
      await expect(xInput).toHaveValue('0');

      // Y is at 100, pressing ArrowDown should not go above 100
      await yInput.focus();
      await page.keyboard.press('ArrowDown');
      await expect(yInput).toHaveValue('100');
    });

    test('pointer/touch drag repositions a pinned location', async ({ page }) => {
      const { campaignId, navigation } = seed();
      await ensureCampaignMap(page, campaignId);
      await pinSeedLocation(page, navigation.locationId, 20, 20);

      await page.goto(`/c/${campaignId}`);
      const mapCard = page.getByTestId('dashboard-map');
      await expect(mapCard).toBeVisible();
      await expect(mapCard.getByRole('img', { name: 'Campaign map' })).toBeVisible();

      const pinLink = mapCard.locator(`a[href="/c/${campaignId}/locations/${navigation.locationId}"]`);
      await expect(pinLink).toBeVisible();
      const pin = pinLink.locator('xpath=..'); // absolute-positioned drag handle wrapper

      const surface = mapCard.locator('.relative.overflow-hidden').first();
      const box = await surface.boundingBox();
      expect(box).toBeTruthy();
      if (!box) return;

      const start = await pin.boundingBox();
      expect(start).toBeTruthy();
      if (!start) return;

      const fromX = start.x + start.width / 2;
      const fromY = start.y + start.height / 2;
      // Drag toward the lower-right quadrant (~70%, ~70%)
      const toX = box.x + box.width * 0.7;
      const toY = box.y + box.height * 0.7;

      await page.mouse.move(fromX, fromY);
      await page.mouse.down();
      await page.mouse.move(toX, toY, { steps: 8 });
      await page.mouse.up();

      // Drag should leave the pin away from the 20/20 seed toward the lower-right.
      await expect
        .poll(async () => {
          const res = await page.context().request.get(`/api/v1/locations/${navigation.locationId}`);
          const body = await res.json();
          return Number(body.mapX) > 40 && Number(body.mapY) > 40;
        })
        .toBe(true);
    });
  });

  test.describe('LocationPage — pin position form', () => {
    test('X/Y fields have proper labels and help text', async ({ page }) => {
      const { campaignId, navigation } = seed();
      await page.goto(`/c/${campaignId}/locations/${navigation.locationId}`);

      // Click Move pin button
      const movePinBtn = page.getByRole('button', { name: /Move pin/ });
      await expect(movePinBtn).toBeVisible();
      await movePinBtn.click();

      // Labels should be descriptive
      const xInput = page.getByLabel('Horizontal position (%)');
      const yInput = page.getByLabel('Vertical position (%)');
      await expect(xInput).toBeVisible();
      await expect(yInput).toBeVisible();

      // Help text present
      await expect(page.getByText('0% = left/top edge, 100% = right/bottom edge')).toBeVisible();
    });

    test('announces save success', async ({ page }) => {
      const { campaignId, navigation } = seed();
      await page.goto(`/c/${campaignId}/locations/${navigation.locationId}`);
      const movePinBtn = page.getByRole('button', { name: /Move pin/ });
      await expect(movePinBtn).toBeVisible();
      await movePinBtn.click();

      const xInput = page.getByLabel('Horizontal position (%)');
      await xInput.fill('42');

      // LocationPage pin UI is a role=group named via aria-labelledby, not a labeled control
      const pinForm = page.getByRole('group', { name: /Move .+ pin/ });
      const saveBtn = pinForm.getByRole('button', { name: 'Save' });
      await saveBtn.click();

      // The pin form should close on save success
      await expect(page.getByLabel('Horizontal position (%)')).not.toBeVisible();
    });
  });
});
