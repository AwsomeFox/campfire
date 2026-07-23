/**
 * Reduced-motion computed-style coverage (issue #594).
 *
 * Emulates `prefers-reduced-motion: reduce`, loads the real SPA CSS, and probes
 * loading pulses, AI-active inline keyframes, cast HP transitions, dice / HP /
 * level-up decorative classes, and Tailwind animate-pulse.
 */
import { expect, test, type Page } from '@playwright/test';
import { seed, stateFor } from './seed';

type MotionProbe = {
  id: string;
  animationName: string;
  animationDuration: string;
  animationIterationCount: string;
  transitionDuration: string;
  transitionProperty: string;
};

async function probeMotion(page: Page): Promise<Record<string, MotionProbe>> {
  return page.evaluate(() => {
    const host = document.createElement('div');
    host.id = 'cf-reduced-motion-probes';
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'position:fixed;left:-9999px;top:0;pointer-events:none;';

    const style = document.createElement('style');
    style.textContent = `
      @keyframes cf-ai-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
      @keyframes cfPing { 0% { transform: scale(.4); opacity: .9; } 100% { transform: scale(3); opacity: 0; } }
      .cf-probe-cast-hp > div { height: 100%; width: 40%; transition: width 0.4s ease; background: #5bd18b; }
      .cf-probe-cast-stack { transition: opacity 0.4s ease; opacity: 1; }
    `;
    host.appendChild(style);

    const specs: Array<{ id: string; className?: string; style?: string; html?: string }> = [
      { id: 'tailwind-pulse', className: 'animate-pulse' },
      { id: 'cf-anim-roll', className: 'cf-anim-roll' },
      { id: 'cf-anim-ready', className: 'cf-anim-ready' },
      { id: 'cf-hp-flash-damage', className: 'cf-hp-flash-damage' },
      { id: 'cf-anim-levelup', className: 'cf-anim-levelup' },
      { id: 'cf-btn', className: 'cf-btn' },
      {
        id: 'ai-inline-pulse',
        style: 'width:6px;height:6px;animation:cf-ai-pulse 1.1s ease-in-out infinite;background:currentColor;',
      },
      {
        id: 'map-ping',
        style: 'width:20px;height:20px;border:3px solid red;animation:cfPing 2.4s ease-out forwards;',
      },
      {
        id: 'cast-control-stack',
        className: 'cf-probe-cast-stack',
      },
      {
        id: 'cast-hp-fill',
        className: 'cf-probe-cast-hp',
        html: '<div data-probe-child="cast-hp-fill"></div>',
      },
      {
        id: 'shared-hp',
        className: 'cf-hp',
        html: '<div data-probe-child="shared-hp" style="width:40%"></div>',
      },
    ];

    for (const spec of specs) {
      const el = document.createElement('div');
      el.dataset.probe = spec.id;
      if (spec.className) el.className = spec.className;
      if (spec.style) el.setAttribute('style', spec.style);
      if (spec.html) el.innerHTML = spec.html;
      host.appendChild(el);
    }
    document.body.appendChild(host);

    const read = (el: Element): MotionProbe => {
      const style = getComputedStyle(el);
      return {
        id: (el as HTMLElement).dataset.probe || (el as HTMLElement).dataset.probeChild || 'unknown',
        animationName: style.animationName,
        animationDuration: style.animationDuration,
        animationIterationCount: style.animationIterationCount,
        transitionDuration: style.transitionDuration,
        transitionProperty: style.transitionProperty,
      };
    };

    const out: Record<string, MotionProbe> = {};
    for (const el of Array.from(host.querySelectorAll('[data-probe]'))) {
      const id = (el as HTMLElement).dataset.probe!;
      out[id] = read(el);
    }
    const castFill = host.querySelector('[data-probe-child="cast-hp-fill"]');
    if (castFill) out['cast-hp-fill'] = { ...read(castFill), id: 'cast-hp-fill' };
    const sharedHpFill = host.querySelector('[data-probe-child="shared-hp"]');
    if (sharedHpFill) out['shared-hp'] = { ...read(sharedHpFill), id: 'shared-hp' };
    return out;
  });
}

function expectNoMotion(probe: MotionProbe, label: string) {
  const name = probe.animationName.toLowerCase();
  expect(name === 'none' || name === '', `${label} animationName`).toBeTruthy();
  // Browsers report 0s (or empty) once the global reduce policy wins.
  expect(probe.animationDuration === '0s' || probe.animationDuration === '', `${label} animationDuration`).toBeTruthy();
  const durations = probe.transitionDuration.split(',').map((part) => part.trim());
  for (const duration of durations) {
    expect(duration === '0s' || duration === '', `${label} transitionDuration (${duration})`).toBeTruthy();
  }
}

test.describe('reduced-motion global policy (issue #594)', () => {
  test.use({ storageState: stateFor('dm') });

  test('zeros Tailwind pulses, AI/inline keyframes, cast transitions, and #67 cues while keeping feedback', async ({ page }) => {
    const { campaignId, navigation, encounterId } = seed();
    await page.emulateMedia({ reducedMotion: 'reduce' });

    await page.goto(`/c/${campaignId}`);
    await expect(page.getByRole('heading').first()).toBeVisible();

    const probes = await probeMotion(page);
    for (const id of [
      'tailwind-pulse',
      'cf-anim-roll',
      'cf-anim-ready',
      'cf-hp-flash-damage',
      'cf-anim-levelup',
      'cf-btn',
      'ai-inline-pulse',
      'map-ping',
      'cast-control-stack',
      'cast-hp-fill',
      'shared-hp',
    ]) {
      expect(probes[id], `missing probe ${id}`).toBeTruthy();
      expectNoMotion(probes[id]!, id);
    }

    // Mount AI presence (Driver mode seat) via evaluate — text status must remain
    // even when the infinite pulse style is omitted / CSS-frozen.
    const aiFeedback = await page.evaluate(() => {
      const root = document.createElement('div');
      root.innerHTML = `
        <span class="tag tag-accent" data-ai-dm-active="true" data-testid="ai-dm-probe">
          <span data-testid="ai-dm-presence-dot" style="width:6px;height:6px;border-radius:50%;background:currentColor;animation:cf-ai-pulse 1.1s ease-in-out infinite"></span>
          AI DM is acting…
        </span>`;
      document.body.appendChild(root);
      const dot = root.querySelector('[data-testid="ai-dm-presence-dot"]')!;
      const style = getComputedStyle(dot);
      return {
        text: root.textContent?.trim() ?? '',
        animationName: style.animationName,
        animationDuration: style.animationDuration,
      };
    });
    expect(aiFeedback.text).toContain('AI DM is acting…');
    expect(aiFeedback.animationName.toLowerCase() === 'none' || aiFeedback.animationName === '').toBeTruthy();
    expect(aiFeedback.animationDuration === '0s' || aiFeedback.animationDuration === '').toBeTruthy();

    // Cast / player display: loading title stays; control + HP transitions are 0s.
    await page.goto(`/c/${campaignId}/screen`);
    await expect(page.getByText(/Loading display|Party|No scene|Cast/i).first()).toBeVisible({ timeout: 15_000 });
    const castMotion = await page.evaluate(() => {
      const stack = document.querySelector('.cf-screen-control-stack');
      const hpFill = document.querySelector('.cf-hp > div');
      const read = (el: Element | null) => {
        if (!el) return null;
        const style = getComputedStyle(el);
        return {
          transitionDuration: style.transitionDuration,
          animationName: style.animationName,
        };
      };
      return { stack: read(stack), hpFill: read(hpFill) };
    });
    if (castMotion.stack) {
      expect(castMotion.stack.transitionDuration.split(',')[0]?.trim()).toBe('0s');
    }
    if (castMotion.hpFill) {
      expect(castMotion.hpFill.transitionDuration.split(',')[0]?.trim()).toBe('0s');
    }

    // Encounter HP + dice surfaces: classes present stay motion-free; HP numbers remain.
    await page.goto(`/c/${campaignId}/encounters/${encounterId}`);
    await expect(page.getByText(/Ambush|Round|Initiative|Combat/i).first()).toBeVisible({ timeout: 15_000 });
    const encounterProbe = await page.evaluate(() => {
      const roll = document.createElement('span');
      roll.className = 'cf-anim-roll';
      roll.textContent = '20';
      document.body.appendChild(roll);
      const hp = document.querySelector('.cf-hp');
      const style = getComputedStyle(roll);
      return {
        rollAnimation: style.animationName,
        rollDuration: style.animationDuration,
        hasHp: Boolean(hp),
      };
    });
    expect(encounterProbe.rollAnimation.toLowerCase() === 'none' || encounterProbe.rollAnimation === '').toBeTruthy();
    expect(encounterProbe.rollDuration === '0s' || encounterProbe.rollDuration === '').toBeTruthy();

    // Character sheet: ready/level-up decorative classes settle; page chrome still reads.
    await page.goto(`/c/${campaignId}/characters/${navigation.characterId}`);
    await expect(page.getByRole('heading').first()).toBeVisible({ timeout: 15_000 });
    const characterProbe = await page.evaluate(() => {
      const ready = document.createElement('span');
      ready.className = 'cf-anim-ready tag';
      ready.textContent = 'Ready to level up';
      const level = document.createElement('div');
      level.className = 'cf-anim-levelup';
      level.textContent = 'Level up!';
      document.body.appendChild(ready);
      document.body.appendChild(level);
      return {
        readyText: ready.textContent,
        levelText: level.textContent,
        readyAnim: getComputedStyle(ready).animationName,
        levelAnim: getComputedStyle(level).animationName,
      };
    });
    expect(characterProbe.readyText).toBe('Ready to level up');
    expect(characterProbe.levelText).toBe('Level up!');
    expect(characterProbe.readyAnim.toLowerCase() === 'none' || characterProbe.readyAnim === '').toBeTruthy();
    expect(characterProbe.levelAnim.toLowerCase() === 'none' || characterProbe.levelAnim === '').toBeTruthy();
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
