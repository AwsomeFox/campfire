import { test, expect } from '@playwright/test';
import { seed, stateFor } from './seed';

function paths() {
  const { campaignId: c, navigation: n } = seed();
  return {
    quest: `/c/${c}/quests/${n.questId}#entity-quest-${n.questId}`,
    npc: `/c/${c}/npcs/${n.npcId}#entity-npc-${n.npcId}`,
    faction: `/c/${c}/factions/${n.factionId}#entity-faction-${n.factionId}`,
    location: `/c/${c}/locations/${n.locationId}#entity-location-${n.locationId}`,
    character: `/c/${c}/characters/${n.characterId}#entity-character-${n.characterId}`,
    session: `/c/${c}/sessions?session=${n.sessionId}#entity-session-${n.sessionId}`,
    note: `/c/${c}/notes?note=${n.noteId}#entity-note-${n.noteId}`,
    timeline: `/c/${c}/timeline?event=${n.timelineId}#entity-timeline-${n.timelineId}`,
    item: `/c/${c}/inventory?item=${n.itemId}#entity-item-${n.itemId}`,
    comment: `/c/${c}/sessions?session=${n.sessionId}&comment=${n.commentId}#entity-comment-${n.commentId}`,
    arc: `/c/${c}/storylines?arc=${n.arcId}#entity-arc-${n.arcId}`,
    beat: `/c/${c}/storylines?beat=${n.beatId}#entity-beat-${n.beatId}`,
  };
}

async function expectFocused(page: import('@playwright/test').Page, id: string) {
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe(id);
}

test.describe('cross-entity deep links', () => {
  test.use({ storageState: stateFor('dm') });

  test('search emits a stable destination for every result type', async ({ page }) => {
    const { campaignId } = seed();
    const hrefs = paths();
    await page.goto(`/c/${campaignId}/search?q=DLRNAV`);
    await expect(page.getByText(/\d+ results? for “DLRNAV”/)).toBeVisible();

    for (const href of Object.values(hrefs)) {
      await expect(page.locator(`a[href="${href}"]`).first()).toBeVisible();
    }
  });

  test('session, timeline, arc, and beat links open and focus across back/forward', async ({ page }) => {
    const { campaignId, navigation } = seed();
    const hrefs = paths();
    await page.goto(`/c/${campaignId}/search?q=DLRNAV`);

    for (const [type, id] of [
      ['session', navigation.sessionId],
      ['timeline', navigation.timelineId],
      ['arc', navigation.arcId],
      ['beat', navigation.beatId],
    ] as const) {
      const href = hrefs[type];
      await page.locator(`a[href="${href}"]`).first().click();
      await expect(page).toHaveURL(new RegExp(href.replace(/[?]/g, '\\?')));
      await expectFocused(page, `entity-${type}-${id}`);
      await page.goBack();
      await expect(page).toHaveURL(new RegExp(`/search\\?q=DLRNAV`));
      await page.goForward();
      await expectFocused(page, `entity-${type}-${id}`);
      await page.goBack();
    }
  });

  test('markdown mentions use the same URLs for every mentionable entity', async ({ page }) => {
    const { campaignId, navigation: n } = seed();
    const hrefs = paths();
    await page.goto(`/c/${campaignId}/quests/${n.questId}`);

    const mentionTargets = {
      quest: hrefs.quest,
      npc: hrefs.npc,
      faction: hrefs.faction,
      location: hrefs.location,
      character: hrefs.character,
      session: hrefs.session,
      timeline: hrefs.timeline,
      arc: hrefs.arc,
      beat: hrefs.beat,
    };
    for (const [type, href] of Object.entries(mentionTargets)) {
      await expect(page.locator(`a[data-mention="${type}:${n[`${type}Id` as keyof typeof n]}"]`)).toHaveAttribute('href', href);
    }
  });

  test('notes and proposals open their session target instead of /sessions/:id', async ({ page }) => {
    const { campaignId, navigation: n } = seed();
    const hrefs = paths();

    await page.goto(`/c/${campaignId}/notes`);
    await page.locator(`#entity-note-${n.noteId} a[href="${hrefs.session}"]`).click();
    await expectFocused(page, `entity-session-${n.sessionId}`);

    await page.goto(`/c/${campaignId}/proposals`);
    const proposal = page.getByLabel(`Select proposal ${n.proposalId}`).locator('xpath=ancestor::*[self::div or self::article][1]');
    await proposal.getByRole('link', { name: 'view target' }).click();
    await expectFocused(page, `entity-session-${n.sessionId}`);
  });

  test('list deep links focus correctly on a mobile direct load', async ({ browser }) => {
    const { navigation } = seed();
    const context = await browser.newContext({ storageState: stateFor('dm'), viewport: { width: 375, height: 812 } });
    const page = await context.newPage();
    await page.goto(paths().session);
    await expect(page.getByRole('heading', { name: 'DLRNAV First Crossing' })).toBeVisible();
    await expectFocused(page, `entity-session-${navigation.sessionId}`);
    await context.close();
  });
});

// Issue #739: identity persistence + rename tolerance + same-name disambiguation.
// A typed mention token binds a link to a specific record by id; the renderer
// resolves it through the canonical entity URL, refreshes a stale label to the
// entity's current name, degrades to plain text when the target is gone, and
// refuses to silently pick one of two same-named targets.
test.describe('typed mention identity (issue #739)', () => {
  test.use({ storageState: stateFor('dm') });

  test('a typed mention resolves to the canonical entity URL by id', async ({ page }) => {
    const { campaignId, navigation } = seed();
    const { renamedNpcId } = navigation.identity;
    await page.goto(`/c/${campaignId}/quests/${navigation.identity.questId}`);
    const href = `/c/${campaignId}/npcs/${renamedNpcId}#entity-npc-${renamedNpcId}`;
    await expect(page.locator(`a[data-mention="npc:${renamedNpcId}"]`)).toHaveAttribute('href', href);
  });

  test('a stale typed-link label is refreshed to the entity current name (rename tolerance)', async ({ page }) => {
    const { campaignId, navigation } = seed();
    await page.goto(`/c/${campaignId}/quests/${navigation.identity.questId}`);
    // The authored label was "DLRNAV Twiceborn"; the NPC was renamed to
    // "DLRNAV Reborn" after seeding. The visible text must follow the rename.
    const anchor = page.locator(`a[data-mention="npc:${navigation.identity.renamedNpcId}"]`);
    await expect(anchor).toHaveText('DLRNAV Reborn');
    await expect(anchor).not.toHaveText('DLRNAV Twiceborn');
  });

  test('two same-named targets each resolve via their own typed token', async ({ page }) => {
    const { campaignId, navigation } = seed();
    const { twinAId, twinBId } = navigation.identity;
    await page.goto(`/c/${campaignId}/quests/${navigation.identity.questId}`);
    // Each typed token binds to its own id, so the two "Bob" links land on
    // different NPCs despite the shared name — no silent collapse.
    await expect(page.locator(`a[data-mention="npc:${twinAId}"]`)).toHaveAttribute(
      'href',
      `/c/${campaignId}/npcs/${twinAId}#entity-npc-${twinAId}`,
    );
    await expect(page.locator(`a[data-mention="npc:${twinBId}"]`)).toHaveAttribute(
      'href',
      `/c/${campaignId}/npcs/${twinBId}#entity-npc-${twinBId}`,
    );
  });

  test('plain-text mentions of a shared name are NOT auto-linked (disambiguation)', async ({ page }) => {
    const { campaignId, navigation } = seed();
    await page.goto(`/c/${campaignId}/quests/${navigation.identity.questId}`);
    // "DLRNAV Twin Bob" appears twice as plain text. The auto-linker must NOT
    // wrap either occurrence in a cf-mention anchor — silently picking the first
    // same-named NPC is exactly the collision the typed token exists to resolve.
    const autoLinks = page.locator('a.cf-mention:has-text("DLRNAV Twin Bob")');
    await expect(autoLinks).toHaveCount(0);
  });

  test('a typed token whose target was deleted degrades to plain text (no broken link)', async ({ page }) => {
    const { campaignId, navigation } = seed();
    const { deletedNpcId } = navigation.identity;
    await page.goto(`/c/${campaignId}/quests/${navigation.identity.questId}`);
    // The soft-deleted NPC is absent from the DM mention list, so its token
    // cannot resolve: the anchor is replaced by its authored plain-text label
    // and no cf-mention link to a missing record is emitted.
    await expect(page.locator(`a[data-mention="npc:${deletedNpcId}"]`)).toHaveCount(0);
    await expect(page.getByText('DLRNAV Ghosttarget')).toBeVisible();
  });
});

test.describe('notification deep links', () => {
  test.use({ storageState: stateFor('player') });

  test('a recap notification opens and focuses the selected session', async ({ page }) => {
    const { campaignId, navigation } = seed();
    await page.goto(`/c/${campaignId}`);
    await page.getByRole('button', { name: /Notifications/ }).click();
    await page.getByRole('button', { name: /Recap posted for Session 1/ }).click();
    await expectFocused(page, `entity-session-${navigation.sessionId}`);
  });
});
