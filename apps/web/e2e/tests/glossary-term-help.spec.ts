import { test, expect } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * Issue #518 — first-use jargon help must be a real, non-hover affordance.
 *
 * The unit spec next to this file only greps sources; these are the behavioural
 * checks the acceptance criteria actually name:
 *   - reachable and operable from the keyboard alone (Tab/Enter/Escape),
 *   - exposed to assistive tech as a disclosure (aria-expanded + a named region),
 *   - never clipped by its host container (the desktop sidebar is 230px wide and
 *     `overflow-x-hidden`, which used to cut the panel in half),
 *   - dismissible, and the dismissal sticks across a reload,
 *   - deep-links into the glossary destination.
 */

function dashboardUrl(): string {
  return `/c/${seed().campaignId}`;
}

test.describe('glossary term help (#518) — DM', () => {
  test.use({ storageState: stateFor('dm') });

  test('sidebar help opens by keyboard, is announced, fits the viewport, and deep-links', async ({ page }) => {
    await page.goto(dashboardUrl());

    // Issue #591 — RouteChangeFocus moves keyboard focus once per initial navigation,
    // asynchronously (two animation frames after mount, via focusMainDestination in
    // routeFocus.ts). It prefers the page's h1, but on a hard `page.goto` the campaign
    // name/h1 can still be loading when that window closes, so it falls back to the
    // `<main>` landmark instead — either way, this is the ONE-TIME settle for this
    // navigation. The sidebar's term-help trigger sits outside `<main>`, so
    // `shouldPreserveFocusInsideMain` does not protect it: focusing the trigger before
    // that settle fires just gets clobbered a moment later when the effect runs.
    // Nothing on the Dashboard route autofocuses anything else, so waiting for focus
    // to leave the initial `document.body` awaits that real settle instead of racing
    // it — regardless of whether it lands on the h1 or the `<main>` fallback.
    await page.waitForFunction(() => document.activeElement !== document.body);

    const trigger = page.getByTestId('term-help-trigger-compendium');
    await expect(trigger).toBeVisible();
    // Not hover-only: it is a button with a real accessible name, and it does
    // not rely on a `title` tooltip (unreachable on touch and by most SRs).
    await expect(trigger).toHaveAttribute('aria-label', 'What does Compendium mean?');
    await expect(trigger).not.toHaveAttribute('title', /.*/);
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');

    // Keyboard only: focus the trigger and activate it with Enter.
    await trigger.focus();
    await expect(trigger).toBeFocused();
    await page.keyboard.press('Enter');

    const panel = page.getByTestId('term-help-panel-compendium');
    await expect(panel).toBeVisible();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    // The trigger points at the region it controls, and the region is named —
    // this is what makes the disclosure discoverable to a screen reader.
    const controls = await trigger.getAttribute('aria-controls');
    expect(controls).toBeTruthy();
    await expect(panel).toHaveAttribute('id', controls!);
    await expect(panel).toHaveAttribute('role', 'region');
    await expect(panel).toHaveAttribute('aria-label', 'Compendium help');
    // Role visibility / canon impact are spelled out, per the issue.
    await expect(panel).toContainText('Visible to');
    await expect(panel).toContainText('Canon and privacy');

    // Regression guard: the sidebar is `w-[230px] overflow-x-hidden`, so an
    // absolutely-positioned 280px panel was clipped off the left edge.
    const box = await panel.boundingBox();
    expect(box, 'term help panel bounding box').not.toBeNull();
    const viewport = page.viewportSize()!;
    expect(box!.width, 'panel width').toBeGreaterThanOrEqual(240);
    expect(box!.x, 'panel left edge inside viewport').toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, 'panel right edge inside viewport').toBeLessThanOrEqual(viewport.width);
    expect(box!.y, 'panel top edge inside viewport').toBeGreaterThanOrEqual(0);

    // Focus stays on the trigger (textbook disclosure), and the panel's own
    // controls are the very next tab stops — so the whole affordance is
    // operable without a pointer and without hover.
    await expect(trigger).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(panel.getByRole('link', { name: 'Open glossary' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(panel.getByRole('button', { name: 'Dismiss' })).toBeFocused();
    await trigger.focus();

    // Escape pressed while focus is INSIDE the panel must still return focus to the
    // trigger — otherwise the panel unmounts under the focused control and the user is
    // dropped at document.body. Asserting this only after re-focusing the trigger would
    // mask the real keyboard flow (Devin review on #1431).
    await page.keyboard.press('Tab');
    await expect(panel.getByRole('link', { name: 'Open glossary' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(trigger).toBeFocused();

    // And again from the trigger itself, the common case.
    await trigger.press('Enter');
    await expect(panel).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger).toBeFocused();

    // The panel deep-links into the glossary destination and focuses the term.
    await trigger.press('Enter');
    await expect(panel).toBeVisible();
    await panel.getByRole('link', { name: 'Open glossary' }).click();
    await expect(page).toHaveURL(/\/glossary#glossary-compendium$/);
    await expect(page.getByRole('heading', { name: 'Compendium', exact: true })).toBeVisible();
    await expect(page.locator('#glossary-compendium')).toBeFocused();
  });

  test('dismissing one marker hides every other marker for the same term immediately', async ({ page }) => {
    // The inbox renders a `scribe` marker in its header while the always-mounted
    // sidebar nav item renders one too, so both are on screen at once. Each instance
    // seeds `dismissed` from localStorage only at mount, so without a cross-instance
    // signal the sidebar copy would survive every route change and only vanish on a
    // full reload — i.e. "Dismiss" would visibly fail to dismiss (issue #518).
    await page.goto(`/c/${seed().campaignId}/inbox`);

    const scribeTriggers = page.getByTestId('term-help-trigger-scribe');
    await expect.poll(() => scribeTriggers.count()).toBeGreaterThan(1);

    await scribeTriggers.first().click();
    await expect(page.getByTestId('term-help-panel-scribe').first()).toBeVisible();
    await page.getByTestId('term-help-panel-scribe').first().getByRole('button', { name: 'Dismiss' }).click();

    // No reload, no navigation: every sibling marker for this term goes at once.
    await expect(scribeTriggers).toHaveCount(0);

    // A different term is unaffected — dismissal is per-term, not global.
    await expect(page.getByTestId('term-help-trigger-compendium')).toBeVisible();
  });

  test('dismissing the first-use help hides it and the dismissal persists', async ({ page }) => {
    await page.goto(dashboardUrl());

    const trigger = page.getByTestId('term-help-trigger-sessionZero');
    await expect(trigger).toBeVisible();
    await trigger.click();

    const panel = page.getByTestId('term-help-panel-sessionZero');
    await expect(panel).toBeVisible();
    await panel.getByRole('button', { name: 'Dismiss' }).click();
    await expect(trigger).toHaveCount(0);

    await page.reload();
    await expect(page.getByTestId('term-help-trigger-compendium')).toBeVisible();
    await expect(page.getByTestId('term-help-trigger-sessionZero')).toHaveCount(0);
  });
});
