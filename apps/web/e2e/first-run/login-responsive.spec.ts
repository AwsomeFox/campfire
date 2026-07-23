import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';

type AuthVariant = {
  localLoginEnabled: boolean;
  oidcEnabled: boolean;
  signupEnabled?: boolean;
  oidcProviderName?: string | null;
  loginStatus?: number;
};

const HANDSETS = [
  { width: 320, height: 568 },
  { width: 375, height: 667 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
] as const;

async function mockSignedOutLogin(page: Page, variant: AuthVariant): Promise<void> {
  await page.route('**/api/v1/auth/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        setupRequired: false,
        localLoginEnabled: variant.localLoginEnabled,
        signupEnabled: variant.signupEnabled ?? false,
        oidcEnabled: variant.oidcEnabled,
        oidcProviderName: variant.oidcProviderName ?? null,
        version: 'responsive-test',
      }),
    });
  });
  await page.route('**/api/v1/me', async (route) => {
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'Unauthorized' }),
    });
  });
  await page.route('**/api/v1/auth/login', async (route) => {
    const status = variant.loginStatus ?? 401;
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify({ message: status === 401 ? 'Invalid username or password' : 'Local login disabled' }),
    });
  });
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const widths = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(widths.content).toBeLessThanOrEqual(widths.viewport);
}

async function expectInInitialViewport(page: Page, target: ReturnType<Page['getByRole']>): Promise<void> {
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(await page.evaluate(() => window.innerHeight));
}

async function expectMobileSemanticAndVisualOrder(page: Page): Promise<void> {
  expect(await page.locator('.login-shell > *').evaluateAll((elements) => elements.map((element) => element.className)))
    .toEqual(['login-intro', 'login-auth', 'login-pitch']);

  // One atomic layout read after fonts settle — sequential boundingBox() calls
  // race webfont reflow and can report a false overlap between stacked regions.
  await page.evaluate(() => (document as Document & { fonts?: { ready?: Promise<unknown> } }).fonts?.ready ?? Promise.resolve());
  const order = await page.evaluate(() => {
    const intro = document.querySelector('.login-intro')?.getBoundingClientRect();
    const auth = document.querySelector('.login-auth')?.getBoundingClientRect();
    const pitch = document.querySelector('.login-pitch')?.getBoundingClientRect();
    if (!intro || !auth || !pitch) return null;
    return {
      authAfterIntro: auth.y + 0.5 >= intro.y + intro.height,
      pitchAfterAuth: pitch.y + 0.5 >= auth.y + auth.height,
    };
  });
  expect(order).not.toBeNull();
  expect(order!.authAfterIntro).toBe(true);
  expect(order!.pitchAfterAuth).toBe(true);
}

async function newMobilePage(browser: Browser, baseURL: string | undefined): Promise<{ page: Page; close(): Promise<void> }> {
  const context = await browser.newContext({
    baseURL,
    serviceWorkers: 'block',
    viewport: { width: 430, height: 932 },
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/125 Mobile Safari/537.36',
  });
  return { page: await context.newPage(), close: () => context.close() };
}

test.describe('mobile login information architecture', () => {
  for (const viewport of HANDSETS) {
    test(`keeps local sign in visible before the pitch at ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await mockSignedOutLogin(page, { localLoginEnabled: true, oidcEnabled: false });
      await page.goto('/login');

      await expectInInitialViewport(page, page.getByRole('button', { name: 'Sign in', exact: true }));
      await expectMobileSemanticAndVisualOrder(page);
      await expectNoHorizontalOverflow(page);
      await expect(page).toHaveScreenshot(`login-local-${viewport.width}.png`, {
        animations: 'disabled',
        caret: 'hide',
        maxDiffPixelRatio: 0.04,
      });
    });
  }

  test('keeps OIDC-first and mixed authentication truthful, recoverable, and keyboard ordered', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockSignedOutLogin(page, {
      localLoginEnabled: false,
      oidcEnabled: true,
      oidcProviderName: 'Keycloak',
    });
    await page.goto('/login');

    const sso = page.getByRole('link', { name: 'Sign in with Keycloak' });
    const adminLocal = page.getByRole('button', { name: 'Administrator local sign-in' });
    await expectInInitialViewport(page, sso);
    await expect(page.getByLabel('Username')).toHaveCount(0);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Tab');
    await expect(sso).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(adminLocal).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Local sign-in is restricted to server administrators.')).toBeVisible();
    await expect(page.getByLabel('Username')).toBeFocused();

    await page.unrouteAll({ behavior: 'wait' });
    await mockSignedOutLogin(page, {
      localLoginEnabled: true,
      oidcEnabled: true,
      oidcProviderName: 'Keycloak',
    });
    await page.reload();

    const localDisclosure = page.getByRole('button', { name: 'Sign in with username & password instead' });
    await sso.focus();
    await expect(sso).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(localDisclosure).toBeFocused();
    await page.keyboard.press('Enter');

    const username = page.getByLabel('Username', { exact: true });
    const password = page.getByLabel('Password', { exact: true });
    const reveal = page.getByRole('button', { name: 'Show password' });
    const submit = page.getByRole('button', { name: 'Sign in', exact: true });
    await expect(username).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(password).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(reveal).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(submit).toBeFocused();

    const accessibilityScan = await new AxeBuilder({ page }).include('main').analyze();
    expect(accessibilityScan.violations).toEqual([]);
  });

  test('discloses administrator-only local authentication when OIDC is unavailable', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockSignedOutLogin(page, {
      localLoginEnabled: false,
      oidcEnabled: false,
      oidcProviderName: null,
    });
    await page.goto('/login');

    await expect(page.getByText('Local sign-in is restricted to server administrators.')).toBeVisible();
    await expect(page.getByLabel('Username', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Show password' })).toBeVisible();
    await expectInInitialViewport(page, page.getByRole('button', { name: 'Sign in', exact: true }));
    await expectNoHorizontalOverflow(page);
  });

  test('keeps signup, install guidance, password-manager fields, and validation feedback after applicable auth', async ({ browser, baseURL }) => {
    const mobile = await newMobilePage(browser, baseURL);
    const { page } = mobile;
    await mockSignedOutLogin(page, {
      localLoginEnabled: true,
      oidcEnabled: false,
      signupEnabled: true,
      loginStatus: 401,
    });
    await page.goto('/login');

    const username = page.getByLabel('Username', { exact: true });
    const password = page.getByLabel('Password', { exact: true });
    const reveal = page.getByRole('button', { name: 'Show password' });
    const submit = page.getByRole('button', { name: 'Sign in', exact: true });
    const signup = page.getByRole('link', { name: 'New here? Create an account' });
    const installHint = page.getByText(/Add to Home Screen/);
    await expect(username).toHaveAttribute('autocomplete', 'username');
    await expect(password).toHaveAttribute('autocomplete', 'current-password');
    await expect(reveal).toHaveAttribute('aria-controls', 'password');
    await expect(reveal).toHaveAttribute('aria-pressed', 'false');
    await expect(signup).toBeVisible();
    await expect(installHint).toBeVisible();
    await expectInInitialViewport(page, submit);
    const signupHandle = await signup.elementHandle();
    const installHintHandle = await installHint.elementHandle();
    expect(signupHandle).not.toBeNull();
    expect(installHintHandle).not.toBeNull();
    expect(await submit.evaluate((node, later) => Boolean(node.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING), signupHandle!)).toBe(true);
    expect(await signup.evaluate((node, later) => Boolean(node.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING), installHintHandle!)).toBe(true);

    await username.fill('returning-player');
    await password.fill('incorrect-password');
    await submit.click();
    const alert = page.locator('#login-error');
    await expect(alert).toHaveText('Wrong username or password.');
    await expect(username).toHaveAttribute('aria-invalid', 'true');
    await expect(password).toHaveAttribute('aria-invalid', 'true');
    await expect(username).toHaveAttribute('aria-describedby', 'login-error');
    await expect(password).toHaveAttribute('aria-describedby', 'login-error');
    await expect(page.locator('form')).not.toHaveAttribute('aria-describedby', /.+/);
    await expectInInitialViewport(page, submit);
    await expectNoHorizontalOverflow(page);

    const accessibilityScan = await new AxeBuilder({ page }).include('main').analyze();
    expect(accessibilityScan.violations).toEqual([]);
    await mobile.close();
  });

  test('keeps local authentication visible at the 200% browser-zoom reflow size', async ({ page }) => {
    // At 200% browser zoom, a 430x932 physical handset has a 215x466 CSS
    // viewport. Testing that reflow size exercises the layout browser zoom sees.
    await page.setViewportSize({ width: 215, height: 466 });
    await mockSignedOutLogin(page, { localLoginEnabled: true, oidcEnabled: false });
    await page.goto('/login');

    const submit = page.getByRole('button', { name: 'Sign in', exact: true });
    await expectInInitialViewport(page, submit);
    await expectMobileSemanticAndVisualOrder(page);
    await expectNoHorizontalOverflow(page);
    const box = await submit.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });

  test('keeps the complete local submit path visible in short landscape', async ({ page }) => {
    await page.setViewportSize({ width: 667, height: 320 });
    await mockSignedOutLogin(page, { localLoginEnabled: true, oidcEnabled: false });
    await page.goto('/login');

    await expectInInitialViewport(page, page.getByLabel('Username', { exact: true }));
    await expectInInitialViewport(page, page.getByLabel('Password', { exact: true }));
    await expectInInitialViewport(page, page.getByRole('button', { name: 'Show password' }));
    await expectInInitialViewport(page, page.getByRole('button', { name: 'Sign in', exact: true }));
    await expectMobileSemanticAndVisualOrder(page);
    await expectNoHorizontalOverflow(page);
    await expect(page).toHaveScreenshot('login-local-short-landscape.png', {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.04,
    });
  });
});
