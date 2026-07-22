import { expect, test } from '@playwright/test';

const ADMIN = {
  username: 'first-run-admin',
  displayName: 'First Run Admin',
  password: 'campfire-first-run-admin-1',
} as const;

test('first admin reaches the campaign hub without reload or stale auth routes', async ({ page, browser }) => {
  let setupStarted = false;
  const postSetupAuthReads = new Set<string>();
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() === 'POST' && url.pathname === '/api/v1/auth/setup') {
      setupStarted = true;
    } else if (
      setupStarted &&
      request.method() === 'GET' &&
      (url.pathname === '/api/v1/me' || url.pathname === '/api/v1/auth/status')
    ) {
      postSetupAuthReads.add(url.pathname);
    }
  });

  // A known previous history entry lets us prove setup completion replaces
  // /setup instead of leaving the sensitive bootstrap form on the Back stack.
  await page.goto('/healthz');
  await page.goto('/login');
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole('heading', { name: 'Campfire' })).toBeVisible();

  await page.getByLabel('Username').fill(ADMIN.username);
  await page.getByLabel('Display name').fill(ADMIN.displayName);
  await page.getByLabel('Password', { exact: true }).fill(ADMIN.password);
  await page.getByLabel('Confirm password').fill(ADMIN.password);

  const setupResponse = page.waitForResponse(
    (response) => response.url().endsWith('/api/v1/auth/setup') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Light the fire' }).click();
  expect((await setupResponse).ok()).toBe(true);

  // No page.reload(): both auth contexts must refresh in-app before the router
  // can render the authenticated campaign hub.
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Your campaigns' })).toBeVisible();
  await expect(page.getByText('No campaigns yet — light the first fire.')).toBeVisible();
  expect(postSetupAuthReads).toEqual(new Set(['/api/v1/me', '/api/v1/auth/status']));

  await page.goBack();
  await expect(page).toHaveURL(/\/healthz$/);

  // An authenticated admin cannot reopen either public auth form. Both guards
  // replace the auth route with the campaign hub.
  await page.goto('/setup');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Your campaigns' })).toBeVisible();

  await page.goto('/login');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Your campaigns' })).toBeVisible();

  // Once configured, a signed-out visitor who guesses /setup is sent to the
  // ordinary login screen rather than seeing the first-admin form.
  const signedOut = await browser.newContext();
  const signedOutPage = await signedOut.newPage();
  await signedOutPage.goto('/setup');
  await expect(signedOutPage).toHaveURL(/\/login$/);
  await expect(signedOutPage.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await signedOut.close();
});
