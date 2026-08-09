import { expect, test, type Page } from '@playwright/test';
import { restoreSeedEncounter, seed, stateFor } from './seed';

test.use({ storageState: stateFor('dm') });

async function endLiveEncounters(page: Page, campaignId: number) {
  const live = await page.request.get(`/api/v1/campaigns/${campaignId}/encounters?status=running`);
  if (!live.ok()) return;
  for (const encounter of (await live.json()) as { id: number }[]) {
    await page.request.post(`/api/v1/encounters/${encounter.id}/end`);
  }
}

async function createRunningEncounter(page: Page) {
  const { campaignId } = seed();
  await endLiveEncounters(page, campaignId);

  const created = await page.request.post(`/api/v1/campaigns/${campaignId}/encounters`, {
    data: { name: 'Cockpit layout drill', hidden: false },
  });
  expect(created.ok()).toBe(true);
  const encounter = (await created.json()) as { id: number };

  const added = await page.request.post(`/api/v1/encounters/${encounter.id}/combatants`, {
    data: { kind: 'monster', name: 'Cockpit sentinel', hpMax: 10 },
  });
  expect(added.ok()).toBe(true);
  const combatant = (await added.json()) as { id: number };

  const initiative = await page.request.patch(
    `/api/v1/encounters/${encounter.id}/combatants/${combatant.id}`,
    { data: { initiative: 18 } },
  );
  expect(initiative.ok()).toBe(true);
  expect((await page.request.post(`/api/v1/encounters/${encounter.id}/roll-initiative`)).ok()).toBe(true);
  expect((await page.request.post(`/api/v1/encounters/${encounter.id}/start`)).ok()).toBe(true);

  return { campaignId, encounterId: encounter.id };
}

test.describe('encounter cockpit layout', () => {
  test('is a fixed, non-scrolling shell: map canvas plus a tabbed side panel', async ({ page }) => {
    const fixture = await createRunningEncounter(page);
    try {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(`/c/${fixture.campaignId}/encounters/${fixture.encounterId}`);
      await expect(page.getByRole('heading', { name: 'Cockpit layout drill' })).toBeVisible();

      const shell = page.locator('.cf-vtt');
      const canvas = page.getByTestId('encounter-vtt-canvas');
      const panel = page.getByTestId('encounter-vtt-panel');
      await expect(canvas).toBeVisible();
      await expect(panel).toBeVisible();

      const desktop = await shell.evaluate((node) => {
        const canvasEl = node.querySelector('[data-testid="encounter-vtt-canvas"]')!;
        const panelEl = node.querySelector('[data-testid="encounter-vtt-panel"]')!;
        const shellRect = node.getBoundingClientRect();
        return {
          position: getComputedStyle(node).position,
          // The shell owns everything below Layout's campaign-wide chrome (the safety
          // hold bar, and a player's check-request prompts when they have any) — see
          // encounter-cockpit-campaign-chrome.spec.ts for why it starts below rather
          // than on top of it — and the page itself never scrolls.
          fillsViewport:
            Math.round(shellRect.width) === window.innerWidth
            && Math.round(shellRect.bottom) === window.innerHeight,
          startsBelowChrome: Math.round(shellRect.top) >= 0,
          documentScrolls: document.documentElement.scrollHeight > window.innerHeight + 1,
          // Canvas and panel sit side by side, with the panel on the trailing edge.
          sideBySide:
            canvasEl.getBoundingClientRect().right <= panelEl.getBoundingClientRect().left + 1,
          canvasHeight: Math.round(canvasEl.getBoundingClientRect().height),
          panelWidth: Math.round(panelEl.getBoundingClientRect().width),
        };
      });
      expect(desktop.position).toBe('fixed');
      expect(desktop.fillsViewport).toBe(true);
      expect(desktop.startsBelowChrome).toBe(true);
      expect(desktop.documentScrolls).toBe(false);
      expect(desktop.sideBySide).toBe(true);
      // Starts at the template's 356px and grows with the viewport (clamped at 460).
      expect(desktop.panelWidth).toBeGreaterThanOrEqual(356);
      expect(desktop.panelWidth).toBeLessThanOrEqual(460);
      // The canvas gets the height left over under the header, not a 16:9 reservation.
      expect(desktop.canvasHeight).toBeGreaterThan(400);

      // Every panel stays MOUNTED and is hidden when another tab shows — panels hold
      // state that must survive a tab click (an in-flight write's reconciliation guard, a
      // half-typed rename), so layout does not get to decide what is still alive.
      await expect(page.getByTestId('encounter-vtt-tab-party')).toHaveAttribute('aria-selected', 'true');
      for (const tab of ['turn', 'party', 'log', 'table']) {
        await expect(page.getByTestId(`encounter-vtt-tabpanel-${tab}`)).toHaveCount(1);
      }
      await expect(page.getByTestId('encounter-vtt-tabpanel-log')).not.toBeVisible();
      await page.getByTestId('encounter-vtt-tab-log').click();
      await expect(page.getByTestId('encounter-vtt-tabpanel-log')).toBeVisible();
      await expect(page.getByRole('log', { name: 'Combat log' })).toBeVisible();

      // …so every tab can point at a panel that really is in the document.
      const tabWiring = await page
        .locator('.cf-vtt-panel-tabs [role="tab"]')
        .evaluateAll((tabs) =>
          tabs.map((tab) => {
            const controls = tab.getAttribute('aria-controls');
            return {
              controls,
              targetExists: Boolean(controls && document.getElementById(controls)),
            };
          }),
        );
      expect(tabWiring.length).toBeGreaterThan(1);
      for (const tab of tabWiring) {
        expect(tab.controls).not.toBeNull();
        expect(tab.targetExists).toBe(true);
      }

      // Collapsing the panel hands the whole canvas to the map, and the reopen tab returns it.
      await page.getByTestId('encounter-vtt-panel-close').click();
      await expect(panel).not.toBeVisible();
      // Hidden, not unmounted — collapsing must not discard panel state either.
      await expect(panel).toHaveCount(1);
      await page.getByTestId('encounter-vtt-panel-open').click();
      await expect(panel).toBeVisible();

      // Below the two-column width the panel stacks under the canvas rather than
      // covering it — both stay on screen.
      await page.setViewportSize({ width: 390, height: 844 });
      const mobile = await shell.evaluate((node) => {
        const canvasEl = node.querySelector('[data-testid="encounter-vtt-canvas"]')!;
        const panelEl = node.querySelector('[data-testid="encounter-vtt-panel"]')!;
        return {
          stacked: canvasEl.getBoundingClientRect().bottom <= panelEl.getBoundingClientRect().top + 1,
          canvasHeight: Math.round(canvasEl.getBoundingClientRect().height),
          panelHeight: Math.round(panelEl.getBoundingClientRect().height),
        };
      });
      expect(mobile.stacked).toBe(true);
      expect(mobile.canvasHeight).toBeGreaterThan(100);
      expect(mobile.panelHeight).toBeGreaterThan(100);
    } finally {
      await page.request.delete(`/api/v1/encounters/${fixture.encounterId}`);
      await restoreSeedEncounter(page);
    }
  });
});

test.describe('encounter cockpit deep links', () => {
  test('a comment deep link reveals the panel that owns it', async ({ page }) => {
    const { campaignId, encounterId } = seed();

    // Comment-reply notifications link to `#entity-comment-<id>`, and the discussion for
    // an encounter lives in the cockpit's Table tab. `EntityDeepLinkFocus` focuses and
    // scrolls the target but cannot reveal a hidden ancestor, so without the shell
    // selecting the owning panel the notification arrives with its comment invisible.
    const created = await page.request.post(`/api/v1/campaigns/${campaignId}/comments`, {
      data: { entityType: 'encounter', entityId: encounterId, body: 'Deep-linked reply probe' },
    });
    expect(created.ok(), `create comment: ${await created.text()}`).toBe(true);
    const commentId = ((await created.json()) as { id: number }).id;

    try {
      await page.goto(
        `/c/${campaignId}/encounters/${encounterId}?comment=${commentId}#entity-comment-${commentId}`,
      );
      await expect(page.getByTestId('encounter-vtt-canvas')).toBeVisible();

      // The Table tab takes over from the audience default, and the comment is on screen.
      await expect(page.getByTestId('encounter-vtt-tab-table')).toHaveAttribute(
        'aria-selected',
        'true',
        { timeout: 15_000 },
      );
      await expect(page.locator(`#entity-comment-${commentId}`)).toBeVisible();
    } finally {
      await page.request.delete(`/api/v1/comments/${commentId}`).catch(() => undefined);
    }
  });

  test('a tab picked during the retry window wins over the pending deep link', async ({ page }) => {
    const { campaignId, encounterId } = seed();
    const created = await page.request.post(`/api/v1/campaigns/${campaignId}/comments`, {
      data: { entityType: 'encounter', entityId: encounterId, body: 'Retry-window probe' },
    });
    expect(created.ok(), `create comment: ${await created.text()}`).toBe(true);
    const commentId = ((await created.json()) as { id: number }).id;

    try {
      // Hold the comment list from the FIRST load, or the discussion has already rendered
      // by the time we navigate and the resolver succeeds immediately — never entering the
      // retry window this test is about.
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route(`**/api/v1/campaigns/${campaignId}/comments**`, async (route) => {
        await held;
        await route.continue();
      });

      await page.goto(`/c/${campaignId}/encounters/${encounterId}`);
      await expect(page.getByTestId('encounter-vtt-canvas')).toBeVisible();
      await expect(page.locator(`#entity-comment-${commentId}`)).toHaveCount(0);

      await page.evaluate(
        ([c, e, id]) => {
          window.history.pushState({}, '', `/c/${c}/encounters/${e}?comment=${id}#entity-comment-${id}`);
          window.dispatchEvent(new PopStateEvent('popstate'));
        },
        [campaignId, encounterId, commentId] as const,
      );

      // The viewer answers the question themselves while the target is still loading.
      await page.getByTestId('encounter-vtt-tab-log').click();
      await expect(page.getByTestId('encounter-vtt-tab-log')).toHaveAttribute('aria-selected', 'true');

      release();
      // The comment arriving late must not yank them off the tab they just chose.
      await page.waitForTimeout(3_000);
      await expect(page.getByTestId('encounter-vtt-tab-log')).toHaveAttribute('aria-selected', 'true');
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await page.request.delete(`/api/v1/comments/${commentId}`).catch(() => undefined);
    }
  });

  test('a deep link reopens a collapsed panel, not just its tab', async ({ page }) => {
    const { campaignId, encounterId } = seed();
    const created = await page.request.post(`/api/v1/campaigns/${campaignId}/comments`, {
      data: { entityType: 'encounter', entityId: encounterId, body: 'Collapsed-panel probe' },
    });
    expect(created.ok(), `create comment: ${await created.text()}`).toBe(true);
    const commentId = ((await created.json()) as { id: number }).id;

    try {
      await page.goto(`/c/${campaignId}/encounters/${encounterId}`);
      await expect(page.getByTestId('encounter-vtt-canvas')).toBeVisible();

      // Collapsing is independent of which tab is selected, so selecting the owning tab
      // alone still leaves the comment invisible inside a hidden aside.
      await page.getByTestId('encounter-vtt-panel-close').click();
      await expect(page.getByTestId('encounter-vtt-panel')).not.toBeVisible();

      await page.evaluate(
        ([c, e, id]) => {
          window.history.pushState({}, '', `/c/${c}/encounters/${e}?comment=${id}#entity-comment-${id}`);
          window.dispatchEvent(new PopStateEvent('popstate'));
        },
        [campaignId, encounterId, commentId] as const,
      );

      await expect(page.getByTestId('encounter-vtt-panel')).toBeVisible({ timeout: 15_000 });
      await expect(page.locator(`#entity-comment-${commentId}`)).toBeVisible();
    } finally {
      await page.request.delete(`/api/v1/comments/${commentId}`).catch(() => undefined);
    }
  });
});

test.describe('encounter cockpit panel collapse', () => {
  test('hands keyboard focus between the collapse controls', async ({ page }) => {
    const fixture = await createRunningEncounter(page);
    try {
      await page.goto(`/c/${fixture.campaignId}/encounters/${fixture.encounterId}`);
      await expect(page.getByTestId('encounter-vtt-panel')).toBeVisible();

      // Activating Hide removes the focused control's ancestor from the layout. Without a
      // transfer, focus falls to the document and the reopen tab — earlier in DOM order —
      // is only reachable by traversing the whole cockpit again.
      const close = page.getByTestId('encounter-vtt-panel-close');
      await close.focus();
      await page.keyboard.press('Enter');
      const reopen = page.getByTestId('encounter-vtt-panel-open');
      await expect(reopen).toBeFocused();

      await page.keyboard.press('Enter');
      await expect(page.getByTestId('encounter-vtt-panel-close')).toBeFocused();
    } finally {
      await page.request.delete(`/api/v1/encounters/${fixture.encounterId}`);
      await restoreSeedEncounter(page);
    }
  });

  test('reopens itself when a prompt starts waiting on the viewer', async ({ page }) => {
    const fixture = await createRunningEncounter(page);
    try {
      await page.goto(`/c/${fixture.campaignId}/encounters/${fixture.encounterId}`);
      await expect(page.getByTestId('encounter-vtt-panel')).toBeVisible();
      await page.getByTestId('encounter-vtt-panel-close').click();
      await expect(page.getByTestId('encounter-vtt-panel')).not.toBeVisible();

      // Damage from elsewhere (a co-DM, an MCP action) raises a concentration save. The
      // viewer has no reason to be looking and the reopen tab carries no badge, so a
      // collapsed panel would hide a decision the fight is waiting on.
      const combatants = (await (
        await page.request.get(`/api/v1/encounters/${fixture.encounterId}`)
      ).json()) as { combatants: Array<{ id: number }> };
      const target = combatants.combatants[0];
      expect(target, 'fixture needs a combatant').toBeTruthy();
      const concentrating = await page.request.post(
        `/api/v1/encounters/${fixture.encounterId}/combatants/${target.id}/turn-state`,
        { data: { concentration: 'Bless' } },
      );
      expect(concentrating.ok(), `set concentration: ${await concentrating.text()}`).toBe(true);
      const damaged = await page.request.patch(
        `/api/v1/encounters/${fixture.encounterId}/combatants/${target.id}`,
        { data: { hpDelta: -6 } },
      );
      expect(damaged.ok(), `apply damage: ${await damaged.text()}`).toBe(true);

      await expect(page.getByTestId('concentration-check-prompt')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId('encounter-vtt-panel')).toBeVisible();
    } finally {
      await page.request.delete(`/api/v1/encounters/${fixture.encounterId}`);
      await restoreSeedEncounter(page);
    }
  });
});

test.describe('encounter cockpit across navigations', () => {
  test('the tab default follows the encounter you opened, not the one you left', async ({ page }) => {
    const running = await createRunningEncounter(page);
    const { campaignId } = seed();
    const preparing = await page.request.post(`/api/v1/campaigns/${campaignId}/encounters`, {
      data: { name: 'Preparing drill', hidden: false },
    });
    expect(preparing.ok()).toBe(true);
    const preparingId = ((await preparing.json()) as { id: number }).id;

    try {
      await page.goto(`/c/${campaignId}/encounters/${running.encounterId}`);
      await page.getByTestId('encounter-vtt-tab-log').click();
      await expect(page.getByTestId('encounter-vtt-tab-log')).toHaveAttribute('aria-selected', 'true');

      // Straight from one encounter to another — the route is the same, so React REUSES
      // this page and an unstamped choice follows you across, landing a DM on a Log they
      // did not ask for (or, for a player, on a Turn panel that is empty while preparing).
      // Going via the list would unmount the page and reset it, hiding the bug entirely.
      await page.evaluate(
        ([campaign, id]) => {
          window.history.pushState({}, '', `/c/${campaign}/encounters/${id}`);
          window.dispatchEvent(new PopStateEvent('popstate'));
        },
        [campaignId, preparingId] as const,
      );
      await expect(page.getByRole('heading', { name: 'Preparing drill' })).toBeVisible();
      await expect(page.getByTestId('encounter-vtt-tab-party')).toHaveAttribute('aria-selected', 'true');
    } finally {
      await page.request.delete(`/api/v1/encounters/${preparingId}`).catch(() => undefined);
      await page.request.delete(`/api/v1/encounters/${running.encounterId}`).catch(() => undefined);
      await restoreSeedEncounter(page);
    }
  });

  test('a deep link resolves its panel even when the cockpit is already mounted', async ({ page }) => {
    const { campaignId, encounterId } = seed();
    const created = await page.request.post(`/api/v1/campaigns/${campaignId}/comments`, {
      data: { entityType: 'encounter', entityId: encounterId, body: 'Second-navigation probe' },
    });
    expect(created.ok(), `create comment: ${await created.text()}`).toBe(true);
    const commentId = ((await created.json()) as { id: number }).id;

    try {
      // Arrive first WITHOUT the hash, so the cockpit is already mounted — the case where a
      // resolver keyed only on its tab list never runs again.
      await page.goto(`/c/${campaignId}/encounters/${encounterId}`);
      await expect(page.getByTestId('encounter-vtt-canvas')).toBeVisible();
      await expect(page.getByTestId('encounter-vtt-tab-table')).toHaveAttribute('aria-selected', 'false');

      await page.evaluate(
        ([c, e, id]) => {
          window.history.pushState({}, '', `/c/${c}/encounters/${e}?comment=${id}#entity-comment-${id}`);
          window.dispatchEvent(new PopStateEvent('popstate'));
        },
        [campaignId, encounterId, commentId] as const,
      );

      await expect(page.getByTestId('encounter-vtt-tab-table')).toHaveAttribute(
        'aria-selected',
        'true',
        { timeout: 15_000 },
      );
      await expect(page.locator(`#entity-comment-${commentId}`)).toBeVisible();
    } finally {
      await page.request.delete(`/api/v1/comments/${commentId}`).catch(() => undefined);
    }
  });
});

test.describe('encounter cockpit tablist keyboard', () => {
  test('arrow keys follow the reading direction, both ways', async ({ page }) => {
    const fixture = await createRunningEncounter(page);
    try {
      await page.goto(`/c/${fixture.campaignId}/encounters/${fixture.encounterId}`);
      const turn = page.getByTestId('encounter-vtt-tab-turn');
      const party = page.getByTestId('encounter-vtt-tab-party');
      await expect(party).toHaveAttribute('aria-selected', 'true');

      // LTR: ArrowLeft from Party (index 1) reaches Turn (index 0).
      await party.focus();
      await page.keyboard.press('ArrowLeft');
      await expect(turn).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press('ArrowRight');
      await expect(party).toHaveAttribute('aria-selected', 'true');

      // RTL: the tabs paint right-to-left, so the SAME visual movement needs the opposite
      // key. A fixed +1 for ArrowRight would walk focus visually leftwards in Arabic.
      await page.evaluate(() => document.documentElement.setAttribute('dir', 'rtl'));
      await party.focus();
      await page.keyboard.press('ArrowRight');
      await expect(turn).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press('ArrowLeft');
      await expect(party).toHaveAttribute('aria-selected', 'true');
    } finally {
      await page.evaluate(() => document.documentElement.removeAttribute('dir')).catch(() => undefined);
      await page.request.delete(`/api/v1/encounters/${fixture.encounterId}`);
      await restoreSeedEncounter(page);
    }
  });
});
