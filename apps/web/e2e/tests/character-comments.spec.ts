import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { seed, stateFor } from './seed';

test.use({ storageState: stateFor('player') });

test('posts as an owned character from the keyboard and renders mobile-safe accessible attribution', async ({ page }) => {
  const { campaignId, navigation } = seed();
  await page.setViewportSize({ width: 375, height: 812 });
  const portrait = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  const upload = await page.request.post(`/api/v1/campaigns/${campaignId}/attachments`, {
    multipart: {
      kind: 'portrait',
      file: { name: 'comment-speaker.png', mimeType: 'image/png', buffer: portrait },
    },
  });
  expect(upload.ok()).toBe(true);
  const attachment = await upload.json();
  const portraitUrl = `/api/v1/attachments/${attachment.id}/file`;

  const first = await page.request.post(`/api/v1/campaigns/${campaignId}/characters`, {
    data: { name: 'Keyboard Scout' },
  });
  expect(first.ok()).toBe(true);
  const firstCharacter = await first.json();
  const second = await page.request.post(`/api/v1/campaigns/${campaignId}/characters`, {
    data: { name: 'Mobile Bard', portraitUrl },
  });
  expect(second.ok()).toBe(true);
  const speaker = await second.json();

  await page.goto(`/c/${campaignId}/sessions?session=${navigation.sessionId}`);
  const discussion = page.getByRole('region', { name: 'Discussion' });
  await expect(discussion).toBeVisible();

  const inCharacter = discussion.getByRole('checkbox', { name: 'In character' }).last();
  await expect(inCharacter).toBeEnabled();
  await inCharacter.focus();
  await page.keyboard.press('Space');
  await expect(inCharacter).toBeChecked();

  const characterSelect = discussion.getByRole('combobox', { name: 'Speaking character' }).last();
  await expect(characterSelect).toBeVisible();
  await characterSelect.focus();
  // Native-select typeahead is keyboard-only and behaves consistently across
  // desktop Chromium and its narrow/mobile viewport emulation.
  await page.keyboard.type('Mobile Bard');
  await expect(characterSelect).toHaveValue(String(speaker.id));

  await discussion.getByPlaceholder('Add to the discussion…').fill('A song for everyone at the table.');
  const post = discussion.getByRole('button', { name: 'Post' }).last();
  await post.focus();
  await page.keyboard.press('Enter');

  await expect(discussion.getByText('A song for everyone at the table.')).toBeVisible();
  await expect(discussion.getByText('Mobile Bard', { exact: true })).toBeVisible();
  await expect(discussion.getByText('Posted by player', { exact: true })).toBeVisible();
  await expect(discussion.locator(`img[src="${portraitUrl}"]`)).toBeVisible();

  const horizontalOverflow = await discussion.evaluate((node) => node.scrollWidth > node.clientWidth + 1);
  expect(horizontalOverflow).toBe(false);

  const results = await new AxeBuilder({ page }).include(`#discussion-session-${navigation.sessionId}`).analyze();
  expect(results.violations).toEqual([]);

  // The seeded browser suite shares one database across specs. Remove every row
  // created here so party-size and ownership assertions in later journeys remain
  // independent of test ordering.
  const thread = await page.request.get(
    `/api/v1/campaigns/${campaignId}/comments?entityType=session&entityId=${navigation.sessionId}`,
  );
  if (thread.ok()) {
    const comments = (await thread.json()) as Array<{ id: number; body: string }>;
    const posted = comments.find((comment) => comment.body === 'A song for everyone at the table.');
    if (posted) await page.request.delete(`/api/v1/comments/${posted.id}`);
  }
  await page.request.delete(`/api/v1/characters/${firstCharacter.id}`);
  await page.request.delete(`/api/v1/characters/${speaker.id}`);
  await page.request.delete(`/api/v1/attachments/${attachment.id}`);
});

test('disables in-character posting when the selected character leaves the owned roster', async ({ page }) => {
  const { campaignId, navigation } = seed();
  const created = await page.request.post(`/api/v1/campaigns/${campaignId}/characters`, {
    data: { name: 'Fleeting Speaker' },
  });
  expect(created.ok()).toBe(true);
  const character = await created.json();

  await page.goto(`/c/${campaignId}/sessions?session=${navigation.sessionId}`);
  const discussion = page.getByRole('region', { name: 'Discussion' });
  await expect(discussion).toBeVisible();

  const inCharacter = discussion.getByRole('checkbox', { name: 'In character' }).last();
  await inCharacter.check();
  await expect(discussion.getByRole('combobox', { name: 'Speaking character' }).last()).toHaveValue(String(character.id));
  await discussion.getByPlaceholder('Add to the discussion…').fill('Should not post with a stale speaker.');
  await expect(discussion.getByRole('button', { name: 'Post' }).last()).toBeEnabled();

  // Ownership changes under the open compose box; a reload refreshes ownedCharacters.
  expect((await page.request.delete(`/api/v1/characters/${character.id}`)).ok()).toBe(true);
  await page.reload();
  await expect(discussion).toBeVisible();
  await expect(discussion.getByRole('checkbox', { name: 'In character' }).last()).toBeDisabled();
  await discussion.getByPlaceholder('Add to the discussion…').fill('Stale character id must not enable Post.');
  // With no owned characters, in-character cannot be selected and Post stays body-gated only.
  await expect(discussion.getByRole('checkbox', { name: 'In character' }).last()).not.toBeChecked();
});
