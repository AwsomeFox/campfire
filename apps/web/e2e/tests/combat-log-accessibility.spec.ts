import AxeBuilder from '@axe-core/playwright';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import type { EncounterEvent } from '@campfire/schema';
import { seed, stateFor } from './seed';

test.use({ storageState: stateFor('dm') });

interface TestWindow extends Window {
  __combatLogAnnouncements?: string[];
  __combatLogObserver?: MutationObserver;
}

async function createRunningEncounter(page: Page, name: string, hpMax = 10) {
  const { campaignId } = seed();
  const created = await page.request.post(`/api/v1/campaigns/${campaignId}/encounters`, { data: { name } });
  expect(created.ok()).toBe(true);
  const encounter = (await created.json()) as { id: number };

  const added = await page.request.post(`/api/v1/encounters/${encounter.id}/combatants`, {
    data: { kind: 'monster', name: 'Secret Ash Hound', hpMax },
  });
  expect(added.ok()).toBe(true);
  const combatant = (await added.json()) as { id: number };

  const initiative = await page.request.patch(`/api/v1/encounters/${encounter.id}/combatants/${combatant.id}`, {
    data: { initiative: 18 },
  });
  expect(initiative.ok()).toBe(true);
  // Campaign creation includes active party characters; roll any remaining null
  // initiatives before start, while preserving the monster's explicit value.
  const rolled = await page.request.post(`/api/v1/encounters/${encounter.id}/roll-initiative`);
  expect(rolled.ok()).toBe(true);
  const started = await page.request.post(`/api/v1/encounters/${encounter.id}/start`);
  expect(started.ok()).toBe(true);
  return { campaignId, encounterId: encounter.id, combatantId: combatant.id };
}

async function openEncounter(page: Page, campaignId: number, encounterId: number, heading: string) {
  await page.goto(`/c/${campaignId}/encounters/${encounterId}`);
  await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  await expect(page.getByRole('log', { name: 'Combat log' })).toBeVisible();
}

async function watchAnnouncements(page: Page) {
  await page.evaluate(() => {
    const live = document.querySelector<HTMLElement>('.sr-only[aria-live="polite"]');
    if (!live) throw new Error('Polite app announcer was not found');
    const target = window as TestWindow;
    target.__combatLogObserver?.disconnect();
    target.__combatLogAnnouncements = [];
    target.__combatLogObserver = new MutationObserver(() => {
      const message = live.textContent?.trim();
      if (message) target.__combatLogAnnouncements?.push(message);
    });
    target.__combatLogObserver.observe(live, { childList: true, characterData: true, subtree: true });
  });
}

async function announcements(page: Page): Promise<string[]> {
  return page.evaluate(() => [...((window as TestWindow).__combatLogAnnouncements ?? [])]);
}

async function waitForAnnouncement(page: Page, text: string) {
  await expect.poll(async () => (await announcements(page)).some((message) => message.includes(text))).toBe(true);
}

test.describe('combat log accessibility — remote clients', () => {
  test('announces remote HP, condition, turn, and death events once without leaking monster totals', async ({ page: dmPage, browser }) => {
    const fixture = await createRunningEncounter(dmPage, 'Accessible remote fight');
    const viewerContext = await browser.newContext({ storageState: stateFor('viewer') });
    const viewerPage = await viewerContext.newPage();

    try {
      await openEncounter(viewerPage, fixture.campaignId, fixture.encounterId, 'Accessible remote fight');
      const log = viewerPage.getByRole('log', { name: 'Combat log' });
      await expect(log).toHaveAttribute('aria-live', 'off');
      await watchAnnouncements(viewerPage);

      const damaged = await dmPage.request.patch(
        `/api/v1/encounters/${fixture.encounterId}/combatants/${fixture.combatantId}`,
        { data: { hpDelta: -1 } },
      );
      expect(damaged.ok()).toBe(true);
      await waitForAnnouncement(viewerPage, 'Outcome: took 1 damage');
      await expect(log).toContainText('Secret Ash Hound: took 1 damage');

      const afterDamage = await announcements(viewerPage);
      expect(afterDamage.filter((message) => message.includes('Outcome: took 1 damage'))).toHaveLength(1);
      expect(afterDamage.join(' ')).not.toContain('9 of 10');
      expect(afterDamage.join(' ')).not.toContain('hit points');

      // An unrelated encounter update refetches the same event list. The event ID cursor
      // must suppress both duplicate combat-log speech and the former HP-diff speech.
      let eventReads = 0;
      viewerPage.on('request', (request) => {
        if (request.method() === 'GET' && request.url().endsWith(`/encounters/${fixture.encounterId}/events`)) eventReads += 1;
      });
      const readsBefore = eventReads;
      const refreshed = await dmPage.request.patch(`/api/v1/encounters/${fixture.encounterId}`, { data: { gridSnap: false } });
      expect(refreshed.ok()).toBe(true);
      await expect.poll(() => eventReads).toBeGreaterThan(readsBefore);
      await viewerPage.waitForTimeout(100);
      expect((await announcements(viewerPage)).filter((message) => message.includes('Outcome: took 1 damage'))).toHaveLength(1);

      const conditioned = await dmPage.request.patch(
        `/api/v1/encounters/${fixture.encounterId}/combatants/${fixture.combatantId}`,
        { data: { addConditions: ['Prone'] } },
      );
      expect(conditioned.ok()).toBe(true);
      await waitForAnnouncement(viewerPage, 'Outcome: gained Prone');

      const announcementCountBeforeTurn = (await announcements(viewerPage)).length;
      const turned = await dmPage.request.post(`/api/v1/encounters/${fixture.encounterId}/next-turn`);
      expect(turned.ok()).toBe(true);
      await expect
        .poll(async () => (await announcements(viewerPage)).slice(announcementCountBeforeTurn).some((message) => message.includes("'s turn (round")))
        .toBe(true);

      const defeated = await dmPage.request.patch(
        `/api/v1/encounters/${fixture.encounterId}/combatants/${fixture.combatantId}`,
        { data: { hpSet: 0 } },
      );
      expect(defeated.ok()).toBe(true);
      await waitForAnnouncement(viewerPage, 'Outcome: dropped to 0 HP');
      await expect(log).toContainText('Secret Ash Hound: dropped to 0 HP');
    } finally {
      await viewerContext.close();
    }
  });

  test('announces events missed during a reconnect as one ordered burst', async ({ page: dmPage, browser }) => {
    const fixture = await createRunningEncounter(dmPage, 'Reconnect burst fight');
    const viewerContext = await browser.newContext({ storageState: stateFor('viewer') });
    const viewerPage = await viewerContext.newPage();

    try {
      await openEncounter(viewerPage, fixture.campaignId, fixture.encounterId, 'Reconnect burst fight');
      await watchAnnouncements(viewerPage);
      await viewerContext.setOffline(true);

      const damaged = await dmPage.request.patch(
        `/api/v1/encounters/${fixture.encounterId}/combatants/${fixture.combatantId}`,
        { data: { hpDelta: -2 } },
      );
      expect(damaged.ok()).toBe(true);
      const conditioned = await dmPage.request.patch(
        `/api/v1/encounters/${fixture.encounterId}/combatants/${fixture.combatantId}`,
        { data: { addConditions: ['Restrained'] } },
      );
      expect(conditioned.ok()).toBe(true);

      await viewerContext.setOffline(false);
      await waitForAnnouncement(viewerPage, '2 new combat log events');
      const burst = (await announcements(viewerPage)).find((message) => message.includes('2 new combat log events')) ?? '';
      expect(burst).toContain('Outcome: took 2 damage');
      expect(burst).toContain('Outcome: gained Restrained');
      expect(burst.indexOf('took 2 damage')).toBeLessThan(burst.indexOf('gained Restrained'));
    } finally {
      await viewerContext.setOffline(false);
      await viewerContext.close();
    }
  });

  test('announces remote note, override, and correction entries without stealing history focus or scroll', async ({ page: dmPage, browser }) => {
    const { campaignId, encounterId } = seed();
    const viewerContext = await browser.newContext({ storageState: stateFor('viewer') });
    const viewerPage = await viewerContext.newPage();
    const historicalEvents: EncounterEvent[] = Array.from({ length: 30 }, (_, index) => ({
      id: 900_000 + index,
      encounterId,
      round: 1,
      type: 'note',
      actor: 'Historian',
      target: null,
      detail: `Earlier combat note ${index + 1} with enough detail to keep the history independently scrollable`,
      createdAt: `2026-07-22T10:${String(index).padStart(2, '0')}:00.000Z`,
    }));
    let remoteEvents: EncounterEvent[] = [];

    await viewerPage.route(`**/api/v1/encounters/${encounterId}/events`, async (route) => {
      const response = await route.fetch();
      const persisted = (await response.json()) as EncounterEvent[];
      await route.fulfill({ response, json: [...persisted, ...historicalEvents, ...remoteEvents] });
    });

    try {
      await openEncounter(viewerPage, campaignId, encounterId, 'Ambush at the Ember Hearth');
      const log = viewerPage.getByRole('log', { name: 'Combat log' });
      await log.focus();
      await expect(log).toBeFocused();
      await viewerPage.keyboard.press('End');
      await expect
        .poll(() => log.evaluate((node) => ({ top: node.scrollTop, max: node.scrollHeight - node.clientHeight })))
        .toEqual(await log.evaluate((node) => ({ top: node.scrollHeight - node.clientHeight, max: node.scrollHeight - node.clientHeight })));
      // End proves the focused history is keyboard-scrollable. Use a stable mid-history
      // position for the append assertion after the key scroll has fully settled.
      await log.evaluate((node) => {
        node.scrollTop = Math.floor((node.scrollHeight - node.clientHeight) / 2);
      });
      await viewerPage.waitForTimeout(100);
      const scrollBefore = await log.evaluate((node) => node.scrollTop);
      await watchAnnouncements(viewerPage);

      remoteEvents = [
        {
          id: 900_100,
          encounterId,
          round: 2,
          type: 'note',
          actor: 'Mira',
          target: null,
          detail: 'The bridge is unstable',
          createdAt: '2026-07-22T12:01:00.000Z',
        },
        {
          id: 900_101,
          encounterId,
          round: 2,
          type: 'override',
          actor: 'Game Master',
          target: 'Goblin Boss',
          detail: 'set initiative to 12',
          createdAt: '2026-07-22T12:02:00.000Z',
        },
        {
          id: 900_102,
          encounterId,
          round: 2,
          type: 'correction',
          actor: 'Game Master',
          target: 'Goblin Boss',
          detail: 'corrected damage to 4',
          createdAt: '2026-07-22T12:03:00.000Z',
        },
      ];

      // The second authenticated browser emits a real encounter SSE invalidation; its
      // event response is extended with future event families not yet authored by an API.
      const refreshed = await dmPage.request.patch(`/api/v1/encounters/${encounterId}`, { data: { gridSnap: false } });
      expect(refreshed.ok()).toBe(true);
      await waitForAnnouncement(viewerPage, '3 new combat log events');

      const message = (await announcements(viewerPage)).find((value) => value.includes('3 new combat log events')) ?? '';
      expect(message).toContain('Actor: Mira. Outcome: The bridge is unstable');
      expect(message).toContain('Actor: Game Master. Target: Goblin Boss. Outcome: set initiative to 12');
      expect(message).toContain('Actor: Game Master. Target: Goblin Boss. Outcome: corrected damage to 4');
      await expect(log).toBeFocused();
      expect(await log.evaluate((node) => node.scrollTop)).toBe(scrollBefore);
    } finally {
      await viewerContext.close();
    }
  });
});

test('combat log remains named, reflow-safe, keyboard reachable, and axe-clean on mobile', async ({ browser }) => {
  const { campaignId, encounterId } = seed();
  const context: BrowserContext = await browser.newContext({
    storageState: stateFor('viewer'),
    viewport: { width: 320, height: 568 },
  });
  const page = await context.newPage();

  try {
    await openEncounter(page, campaignId, encounterId, 'Ambush at the Ember Hearth');
    const heading = page.getByRole('heading', { level: 2, name: 'Combat log' });
    const log = page.getByRole('log', { name: 'Combat log' });
    await expect(heading).toBeVisible();
    await expect(log).toHaveAttribute('tabindex', '0');
    await log.focus();
    await expect(log).toBeFocused();

    const bounds = await log.boundingBox();
    expect(bounds).not.toBeNull();
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(320);
    expect(await log.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);

    const results = await new AxeBuilder({ page }).include('[role="log"]').analyze();
    expect(results.violations).toEqual([]);
  } finally {
    await context.close();
  }
});
