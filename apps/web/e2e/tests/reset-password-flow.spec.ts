import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function mockSignedOut(page: Page): Promise<void> {
  await page.route("**/api/v1/auth/status", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        setupRequired: false,
        localLoginEnabled: true,
        signupEnabled: true,
        oidcEnabled: false,
        oidcProviderName: null,
      }),
    }),
  );
  await page.route("**/api/v1/me", (route) =>
    route.fulfill({
      status: 401,
      body: JSON.stringify({ message: "Unauthorized" }),
    }),
  );
}

test.describe("password recovery browser flow (issue #757)", () => {
  test.use({ serviceWorkers: "block" });

  test("keeps request and redemption explicit, accessible, and manually completed", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await mockSignedOut(page);
    let requestCalls = 0;
    let confirmCalls = 0;
    await page.route("**/api/v1/auth/reset-request", async (route) => {
      requestCalls += 1;
      await route.fulfill({ status: 201, body: "{}" });
    });
    await page.route("**/api/v1/auth/reset-confirm", async (route) => {
      confirmCalls += 1;
      await route.fulfill(
        confirmCalls === 1
          ? { status: 400, body: JSON.stringify({ message: "expired" }) }
          : { status: 201, body: "{}" },
      );
    });

    await page.goto("/reset-password");
    await expect(
      page.getByRole("heading", { name: "Request a reset code" }),
    ).toBeVisible();
    await expect(page.getByLabel("Reset code")).toHaveCount(0);
    await page.getByRole("tab", { name: "Request code" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "Use code" })).toBeFocused();
    await expect(
      page.getByRole("heading", { name: "Use a reset code" }),
    ).toBeVisible();

    await page.goto("/reset-password?code=cf_reset_pasted");
    await expect(
      page.getByRole("heading", { name: "Use a reset code" }),
    ).toBeVisible();
    await expect(page.getByLabel("Reset code")).toHaveValue("cf_reset_pasted");

    await page.getByRole("tab", { name: "Request code" }).click();
    await page.getByLabel("Username").fill("player-one");
    await page.getByRole("button", { name: "Request a reset" }).click();
    await expect(
      page.getByText(/Ask your server admin to approve it/i),
    ).toBeVisible();
    expect(requestCalls).toBe(1);
    await page.getByRole("button", { name: "Use a reset code" }).click();

    const code = page.getByLabel("Reset code");
    const password = page.getByLabel("New password", { exact: true });
    const confirmation = page.getByLabel("Confirm new password");
    await code.fill("cf_reset_pasted");
    await password.fill("long-enough-password");
    await confirmation.fill("different-password");
    await page.getByRole("button", { name: "Set new password" }).click();
    expect(confirmCalls).toBe(0);
    await expect(confirmation).toBeFocused();
    await expect(confirmation).toHaveAttribute("aria-invalid", "true");

    await confirmation.fill("long-enough-password");
    await page.getByRole("button", { name: "Set new password" }).click();
    await expect(page.getByText(/invalid or has expired/i)).toBeVisible();
    await expect(code).toHaveValue("cf_reset_pasted");
    await expect(password).toHaveValue("long-enough-password");
    await expect(confirmation).toHaveValue("long-enough-password");

    await page.getByRole("button", { name: "Set new password" }).click();
    await expect(page.getByRole("status")).toHaveText(/Password updated/i);
    await expect(page).toHaveURL(/\/reset-password\?code=/);
    await expect(
      page.getByRole("link", { name: "Sign in", exact: true }),
    ).toBeFocused();

    const scan = await new AxeBuilder({ page }).include("main").analyze();
    expect(scan.violations).toEqual([]);
  });
});
