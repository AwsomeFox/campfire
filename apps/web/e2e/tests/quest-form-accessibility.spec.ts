import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import {
  NOTE_BODY_LABEL,
  NOTE_VISIBILITY_GROUP_LABEL,
  NOTE_VISIBILITY_HELP,
  noteVisibilityOptionLabel,
} from '../../src/components/noteVisibilityA11y';
import {
  QUEST_AUDIENCE_DM_HELP,
  QUEST_AUDIENCE_DM_LABEL,
  QUEST_AUDIENCE_GROUP_LABEL,
  QUEST_AUDIENCE_PLAYERS_LABEL,
  QUEST_BODY_LABEL,
  QUEST_GIVER_LABEL,
  QUEST_NEW_FORM_PREFIX,
  QUEST_PARENT_LABEL,
  QUEST_REWARD_LABEL,
  QUEST_TITLE_HELP,
  QUEST_TITLE_LABEL,
  QUEST_TITLE_REQUIRED_ERROR,
  questFieldId,
} from '../../src/features/quests/questFormA11y';
import { seed, stateFor } from './seed';

/**
 * Issue #452 — quest authoring complete form labels + note visibility semantics.
 */

test.describe('quest authoring and note visibility accessibility (issue #452)', () => {
  test.use({ storageState: stateFor('dm') });

  test('create form associates labels/help/errors for every field and is axe-clean', async ({
    page,
  }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/quests/new`);

    const form = page.getByTestId('quest-create-form');
    await expect(form).toBeVisible();

    const title = form.getByRole('textbox', { name: QUEST_TITLE_LABEL });
    const body = form.getByRole('textbox', { name: QUEST_BODY_LABEL });
    const reward = form.getByRole('textbox', { name: QUEST_REWARD_LABEL });
    const giver = form.getByLabel(QUEST_GIVER_LABEL);
    const parent = form.getByLabel(QUEST_PARENT_LABEL);
    const audience = form.getByRole('group', { name: QUEST_AUDIENCE_GROUP_LABEL });
    const dmOnly = audience.getByRole('radio', { name: QUEST_AUDIENCE_DM_LABEL });
    const visibleToPlayers = audience.getByRole('radio', { name: QUEST_AUDIENCE_PLAYERS_LABEL });

    await expect(title).toHaveAttribute('id', questFieldId(QUEST_NEW_FORM_PREFIX, 'title'));
    await expect(body).toHaveAttribute('id', questFieldId(QUEST_NEW_FORM_PREFIX, 'body'));
    await expect(reward).toHaveAttribute('id', questFieldId(QUEST_NEW_FORM_PREFIX, 'reward'));
    await expect(giver).toHaveAttribute('id', questFieldId(QUEST_NEW_FORM_PREFIX, 'giver'));
    await expect(parent).toHaveAttribute('id', questFieldId(QUEST_NEW_FORM_PREFIX, 'parent'));
    await expect(title).toHaveAccessibleDescription(QUEST_TITLE_HELP);
    await expect(dmOnly).toBeChecked();
    await expect(visibleToPlayers).not.toBeChecked();
    await expect(audience.getByText(QUEST_AUDIENCE_DM_HELP)).toBeVisible();

    await form.getByRole('button', { name: 'Create quest' }).click();
    await expect(title).toHaveAttribute('aria-invalid', 'true');
    await expect(title).toBeFocused();
    await expect(form.getByRole('alert').filter({ hasText: QUEST_TITLE_REQUIRED_ERROR })).toBeVisible();
    await expect(title).toHaveAccessibleDescription(new RegExp(QUEST_TITLE_REQUIRED_ERROR));

    const createScan = await new AxeBuilder({ page })
      .include('[data-testid="quest-create-form"]')
      .disableRules(['color-contrast'])
      .analyze();
    expect(createScan.violations).toEqual([]);

    await title.fill('Labeled quest a11y');
    await body.fill('Body with associated label');
    await reward.fill('50 GP');
    await Promise.all([
      page.waitForResponse(
        (res) =>
          res.url().includes(`/api/v1/campaigns/${campaignId}/quests`) &&
          res.request().method() === 'POST' &&
          res.status() === 201,
      ),
      form.getByRole('button', { name: 'Create quest' }).click(),
    ]);
    await expect(page.getByRole('heading', { name: 'Labeled quest a11y' })).toBeVisible();
  });

  test('note visibility uses radiogroup selected semantics with secret help', async ({ page }) => {
    const { campaignId, navigation } = seed();
    await page.goto(`/c/${campaignId}/quests/${navigation.questId}`);

    const rail = page.getByTestId('notes-rail');
    await expect(rail).toBeVisible();
    await expect(rail.getByLabel(NOTE_BODY_LABEL)).toBeVisible();

    const group = rail.getByRole('radiogroup', { name: NOTE_VISIBILITY_GROUP_LABEL });
    await expect(group).toBeVisible();

    const privateOpt = group.getByRole('radio', { name: noteVisibilityOptionLabel('private') });
    await expect(privateOpt).toHaveAttribute('aria-checked', 'true');
    await expect(rail.getByText(NOTE_VISIBILITY_HELP.private)).toBeVisible();

    const whisper = group.getByRole('radio', { name: noteVisibilityOptionLabel('whisper') });
    await whisper.click();
    await expect(whisper).toHaveAttribute('aria-checked', 'true');
    await expect(privateOpt).toHaveAttribute('aria-checked', 'false');
    await expect(rail.getByText(NOTE_VISIBILITY_HELP.whisper)).toBeVisible();
    await expect(rail.getByLabel(/Whisper to/)).toBeVisible();

    // Keyboard: arrows move the single selection.
    await whisper.focus();
    await page.keyboard.press('ArrowRight');
    await expect(
      group.getByRole('radio', { name: noteVisibilityOptionLabel('private') }),
    ).toHaveAttribute('aria-checked', 'true');

    const visScan = await new AxeBuilder({ page })
      .include('[data-testid="notes-compose"]')
      .disableRules(['color-contrast'])
      .analyze();
    expect(visScan.violations).toEqual([]);
  });
});
