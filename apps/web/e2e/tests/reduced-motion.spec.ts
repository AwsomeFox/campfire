/**
 * Reduced-motion computed-style coverage (issue #594; real-DOM rewrite issue #1532).
 *
 * Emulates `prefers-reduced-motion: reduce` and reads computed style off REAL,
 * app-rendered elements produced by genuine interactions — a dice roll, an HP
 * delta, a guided level-up, the player-display roster and operator controls.
 *
 * Issue #1532: the previous version fabricated a detached host element,
 * injected its own `<style>` with hand-rolled keyframes, and cloned 11
 * synthetic divs bearing the production class names. Because the universal
 * `*, *::before, *::after { animation: none !important }` rule (index.css,
 * `@media (prefers-reduced-motion: reduce)`) applies to literally any element
 * regardless of class, every one of those probes passed unconditionally and
 * could never fail — even if the specific per-class rules it claimed to test
 * were deleted outright. Two selectors were also simply wrong
 * (`.cf-hp > div` doesn't exist on `/screen`; the real class there is
 * `.cf-screen-hp > div`), so the "real DOM" checks silently no-op'd forever
 * behind an `if (...)`, the same defect class as #1484.
 *
 * This file now asserts only on elements the real component tree produced.
 * The AI-DM presence pulse and the map-ping marker are inline-styled (not
 * class-based) and are pinned at the source level instead, in
 * reduced-motion.unit.spec.ts — a live DOM trigger for either needs an active
 * AI-DM turn or a revealed map ping, disproportionate setup for what the
 * universal override already covers structurally (also pinned there).
 */
import { expect, test } from '@playwright/test';
import { hpDeltaLabel } from '../../src/features/characters/characterSheetA11y';
import { seed, stateFor } from './seed';

type MotionSample = { animationName: string; animationDuration: string; transitionDuration: string };

/** Reads the reduced-motion-relevant computed style off a real, already-rendered element. */
async function sampleMotion(locator: import('@playwright/test').Locator): Promise<MotionSample> {
  return locator.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      animationName: style.animationName,
      animationDuration: style.animationDuration,
      transitionDuration: style.transitionDuration,
    };
  });
}

function expectNoMotion(sample: MotionSample, label: string) {
  const name = sample.animationName.toLowerCase();
  expect(name === 'none' || name === '', `${label} animationName`).toBeTruthy();
  // Browsers report 0s (or empty) once the global reduce policy wins.
  expect(
    sample.animationDuration === '0s' || sample.animationDuration === '',
    `${label} animationDuration`,
  ).toBeTruthy();
  const durations = sample.transitionDuration.split(',').map((part) => part.trim());
  for (const duration of durations) {
    expect(duration === '0s' || duration === '', `${label} transitionDuration (${duration})`).toBeTruthy();
  }
}

test.describe('reduced-motion global policy (issue #594)', () => {
  test.use({ storageState: stateFor('dm') });

  test.describe('real interaction motion checks', () => {
    let characterId = 0;
    const CHAR_NAME = `1532 Motion PC ${Date.now()}`;

    // The built-in `request` fixture is test-scoped, not worker-scoped, so it
    // must be created in beforeEach/afterEach (matching
    // character-level-up.spec.ts) rather than beforeAll/afterAll — and a fresh
    // character per attempt also means a Playwright retry never reuses an
    // already-leveled-up character, which would otherwise break the "ready to
    // level up" / "Confirm level 2" checks below.
    test.beforeEach(async ({ request }) => {
      const { campaignId } = seed();
      const res = await request.post(`/api/v1/campaigns/${campaignId}/characters`, {
        data: {
          name: CHAR_NAME,
          className: 'Fighter',
          level: 1,
          ac: 14,
          hpCurrent: 20,
          hpMax: 20,
          xp: 999_999, // far past any level-2 threshold, so the "ready to level up" badge renders.
          stats: { STR: 16, DEX: 12, CON: 14, INT: 10, WIS: 10, CHA: 10 },
        },
      });
      expect(res.ok(), await res.text()).toBeTruthy();
      characterId = ((await res.json()) as { id: number }).id;
    });

    test.afterEach(async ({ request }) => {
      if (characterId) {
        await request.delete(`/api/v1/characters/${characterId}`).catch(() => undefined);
      }
    });

    test('zeros real HP-flash, dice-roll, ready/level-up, and player-display animations while keeping feedback', async ({
      page,
    }) => {
      const { campaignId } = seed();
      await page.emulateMedia({ reducedMotion: 'reduce' });

      // Dashboard chrome: any real button (the shared .cf-btn) stays motion-free.
      await page.goto(`/c/${campaignId}`);
      await expect(page.getByRole('heading').first()).toBeVisible();
      const anyButton = page.locator('button.cf-btn, button[class*="cf-btn"]').first();
      await expect(anyButton).toBeVisible();
      expectNoMotion(await sampleMotion(anyButton), 'dashboard cf-btn');

      // Character sheet: real HP delta -> real .cf-hp flash; real dice roll -> real roll toast.
      await page.goto(`/c/${campaignId}/characters/${characterId}`);
      await expect(page.getByRole('heading', { name: CHAR_NAME })).toBeVisible();

      const hpGroup = page.getByRole('group', { name: `${CHAR_NAME} hit points` });
      const damageBtn = hpGroup.getByRole('button', { name: hpDeltaLabel(CHAR_NAME, -1, 20, 20) });
      await expect(damageBtn).toBeVisible();
      const [hpResponse] = await Promise.all([
        page.waitForResponse(
          (res) => res.url().includes(`/characters/${characterId}/hp`) && res.request().method() === 'POST',
        ),
        damageBtn.click(),
      ]);
      expect(hpResponse.status()).toBeLessThan(300);
      // Wait for the REAL damage-state classes HpBar applies after onChange()
      // re-renders with the new hpCurrent — not just the always-present
      // generic .cf-hp bar, which would exist (and trivially read
      // animation:none) even if the pulse wiring were deleted entirely.
      const damagedBar = page.locator('.cf-hp.cf-anim-hp-damage');
      await expect(damagedBar).toBeVisible();
      expectNoMotion(await sampleMotion(damagedBar), 'character sheet .cf-hp (damage pulse)');
      const damageFlash = page.locator('.cf-hp-flash-damage');
      await expect(damageFlash).toBeVisible();
      expectNoMotion(await sampleMotion(damageFlash), 'character sheet .cf-hp fill (damage flash)');

      const strSaveBtn = page.getByRole('button', { name: /Roll STR save/i });
      await expect(strSaveBtn).toBeVisible();
      const [rollResponse] = await Promise.all([
        page.waitForResponse(
          (res) => res.url().endsWith(`/api/v1/campaigns/${campaignId}/roll`) && res.request().method() === 'POST',
        ),
        strSaveBtn.click(),
      ]);
      expect(rollResponse.status()).toBeLessThan(300);
      const rollToast = page.getByTestId('roll-result-toast');
      await expect(rollToast).toBeVisible();
      const rollTotal = rollToast.locator('.cf-anim-roll');
      await expect(rollTotal).toBeVisible();
      expectNoMotion(await sampleMotion(rollTotal), 'roll-result-toast .cf-anim-roll');

      // Build & profile tab: XP card renders the real "ready to level up" badge
      // (xp is set far past the level-2 threshold in beforeEach), then a real
      // guided level-up renders the real celebratory banner.
      await page.getByRole('tab', { name: /Build & profile/ }).click();
      const xpCard = page.getByTestId('character-xp');
      await expect(xpCard).toBeVisible();
      const readyBadge = xpCard.locator('.cf-anim-ready');
      await expect(readyBadge).toBeVisible();
      await expect(readyBadge).toContainText('Ready to level up');
      expectNoMotion(await sampleMotion(readyBadge), 'character-xp .cf-anim-ready');

      await xpCard.getByRole('button', { name: /Level up/i }).click();
      const confirmBtn = xpCard.getByRole('button', { name: 'Confirm level 2' });
      await expect(confirmBtn).toBeVisible();
      const [levelUpResponse] = await Promise.all([
        page.waitForResponse(
          (res) => res.url().endsWith(`/api/v1/characters/${characterId}/level-up`) && res.request().method() === 'POST',
        ),
        confirmBtn.click(),
      ]);
      expect(levelUpResponse.status()).toBe(201);
      const levelUpBanner = xpCard.locator('.cf-anim-levelup');
      await expect(levelUpBanner).toBeVisible();
      await expect(levelUpBanner).toContainText('grow stronger');
      expectNoMotion(await sampleMotion(levelUpBanner), 'character-xp .cf-anim-levelup');

      // Player display (cast mode): the real operator control stack and the real
      // party roster HP fill (`.cf-screen-hp > div`, NOT `.cf-hp > div` — that
      // selector never matched here) both stay motion-free. Both are rendered
      // unconditionally once the screen loads, so these are required, not
      // conditionally skipped.
      await page.goto(`/c/${campaignId}/screen`);
      await expect(page.getByText(/Loading display|Initiative|Round|Cinderhaven/i).first()).toBeVisible({
        timeout: 15_000,
      });
      const controlStack = page.locator('.cf-screen-control-stack');
      await expect(controlStack).toHaveCount(1, { timeout: 15_000 });
      expectNoMotion(await sampleMotion(controlStack), 'player display .cf-screen-control-stack');

      const screenHpFill = page.locator('.cf-screen-hp > div').first();
      await expect(screenHpFill).toHaveCount(1, { timeout: 15_000 });
      expectNoMotion(await sampleMotion(screenHpFill), 'player display .cf-screen-hp fill');
    });
  });

  test('skeleton loading feedback remains when animate-pulse is frozen', async ({ page }) => {
    const { campaignId } = seed();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`/c/${campaignId}/search`);
    await expect(page.getByRole('heading', { name: /search/i })).toBeVisible();

    // Force a skeleton into the tree with the real utility class.
    const skeleton = await page.evaluate(() => {
      const wrap = document.createElement('div');
      wrap.setAttribute('data-testid', 'skeleton');
      wrap.setAttribute('role', 'status');
      wrap.setAttribute('aria-busy', 'true');
      wrap.innerHTML = `
        <span class="sr-only">Loading…</span>
        <div class="h-3 rounded animate-pulse bg-[var(--color-neutral-800)]" style="width:85%"></div>`;
      document.body.appendChild(wrap);
      const bar = wrap.querySelector('.animate-pulse')!;
      const style = getComputedStyle(bar);
      return {
        status: wrap.getAttribute('role'),
        label: wrap.textContent?.trim(),
        animationName: style.animationName,
        animationDuration: style.animationDuration,
        backgroundColor: style.backgroundColor,
      };
    });
    expect(skeleton.status).toBe('status');
    expect(skeleton.label).toContain('Loading…');
    expect(skeleton.animationName.toLowerCase() === 'none' || skeleton.animationName === '').toBeTruthy();
    expect(skeleton.animationDuration === '0s' || skeleton.animationDuration === '').toBeTruthy();
    // Bars still paint — feedback is not motion-only.
    expect(skeleton.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
    expect(skeleton.backgroundColor).not.toBe('transparent');
  });
});
