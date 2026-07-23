import { expect, test } from '@playwright/test';
import { INVITE_COPY_SUCCESS, inviteLinkFieldLabel } from '../../src/features/admin/inviteRoleOptions';
import { seed, stateFor } from './seed';

function politeAnnouncement(page: import('@playwright/test').Page, message: string) {
  return page.locator('[aria-live="polite"]').filter({ hasText: message });
}

test.describe('invite form accessibility (issue #516)', () => {
  test.use({ storageState: stateFor('dm') });

  test('labels the role selector and generated links and announces copy without moving focus', async ({ page }) => {
    const { campaignId } = seed();
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(`/c/${campaignId}/members`);

    const card = page.getByTestId('invite-card');
    await expect(card).toBeVisible();

    const roleSelect = card.getByLabel('Joins as');
    await expect(roleSelect).toHaveAttribute('id', 'invite-join-role');
    await roleSelect.selectOption('viewer');

    const [createResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/v1/campaigns/${campaignId}/invites`) &&
          response.request().method() === 'POST',
      ),
      card.getByRole('button', { name: 'Generate invite link' }).click(),
    ]);
    expect(createResponse.status()).toBe(201);
    const created = (await createResponse.json()) as { id: number; role: 'viewer' };

    const linkField = card.getByRole('textbox', { name: inviteLinkFieldLabel('viewer', created.id) });
    await expect(linkField).toHaveAttribute('id', `invite-link-${created.id}`);
    await expect(linkField).toHaveAttribute('readonly', '');
    await expect(linkField).toHaveAttribute('aria-readonly', 'true');

    const copyButton = card.getByRole('button', {
      name: `Copy ${inviteLinkFieldLabel('viewer', created.id)}`,
    });
    await copyButton.click();
    await expect(copyButton).toBeFocused();
    await expect(politeAnnouncement(page, INVITE_COPY_SUCCESS)).toBeAttached();
  });
});
