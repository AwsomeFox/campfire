import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  TIMELINE_BODY_HELP,
  TIMELINE_DATE_HELP,
  TIMELINE_DM_SECRET_HELP,
  TIMELINE_EDIT_FORM_PREFIX,
  TIMELINE_NEW_FORM_PREFIX,
  TIMELINE_ORDER_HELP,
  TIMELINE_ORDER_INTEGER_ERROR,
  TIMELINE_TITLE_REQUIRED_ERROR,
  timelineFieldId,
} from '../../src/features/timeline/timelineFormA11y';
import { seed, stateFor } from './seed';

async function openCreateForm(page: Page) {
  const { campaignId } = seed();
  await page.goto(`/c/${campaignId}/timeline`);
  const trigger = page.getByRole('button', { name: '+ New event' });
  await expect(trigger).toBeVisible();
  await trigger.click();
  const form = page.getByTestId('timeline-event-create-form');
  await expect(form).toBeVisible();
  return { campaignId, trigger, form };
}

async function openEditForm(page: Page) {
  const { campaignId, navigation } = seed();
  await page.goto(`/c/${campaignId}/timeline`);
  const event = page.locator(
    `[data-entity-type="timeline"][data-entity-id="${navigation.timelineId}"]`,
  );
  const trigger = event.getByRole('button', { name: 'Edit' });
  await expect(trigger).toBeVisible();
  await trigger.click();
  const form = page.getByTestId('timeline-event-edit-form');
  await expect(form).toBeVisible();
  return { campaignId, navigation, trigger, form, event };
}

test.describe('timeline authoring form accessibility (issue #453)', () => {
  test.use({ storageState: stateFor('dm') });

  test('create form associates labels, help, keyboard order, field errors, and passes axe', async ({
    page,
  }) => {
    const { trigger, form } = await openCreateForm(page);

    const title = form.getByRole('textbox', { name: 'Title' });
    const order = form.getByRole('spinbutton', { name: 'Order' });
    const description = form.getByRole('textbox', { name: /Description/ });
    const dmSecret = form.getByRole('textbox', { name: 'DM secret' });
    const inWorldDate = form.getByRole('textbox', { name: 'In-world date' });

    await expect(title).toBeFocused();
    await expect(title).toHaveAttribute('id', timelineFieldId(TIMELINE_NEW_FORM_PREFIX, 'title'));
    await expect(order).toHaveAttribute('id', timelineFieldId(TIMELINE_NEW_FORM_PREFIX, 'order'));
    await expect(description).toHaveAttribute('id', timelineFieldId(TIMELINE_NEW_FORM_PREFIX, 'body'));
    await expect(dmSecret).toHaveAttribute('id', timelineFieldId(TIMELINE_NEW_FORM_PREFIX, 'dmSecret'));

    await expect(order).toHaveAccessibleDescription(TIMELINE_ORDER_HELP);
    await expect(inWorldDate).toHaveAccessibleDescription(TIMELINE_DATE_HELP);
    await expect(description).toHaveAccessibleDescription(TIMELINE_BODY_HELP);
    await expect(dmSecret).toHaveAccessibleDescription(TIMELINE_DM_SECRET_HELP);

    const createFormScan = await new AxeBuilder({ page })
      .include('[data-testid="timeline-event-create-form"]')
      .analyze();
    expect(createFormScan.violations).toEqual([]);

    await page.keyboard.press('Tab');
    await expect(inWorldDate).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(form.getByRole('textbox', { name: /Era/ })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(order).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(description).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dmSecret).toBeFocused();
    await page.keyboard.press('Tab');
    // Create form uses Audience radios (DM-only default) instead of a hidden checkbox (#754).
    await expect(form.getByRole('radio', { name: /DM only/ })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(form.getByRole('radio', { name: /Visible to players/ })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(form.getByRole('button', { name: 'Create event' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(form.getByRole('button', { name: 'Cancel' })).toBeFocused();

    await form.getByRole('button', { name: 'Create event' }).click();
    await expect(title).toHaveAttribute('aria-invalid', 'true');
    await expect(title).toHaveAccessibleDescription(TIMELINE_TITLE_REQUIRED_ERROR);
    await expect(title).toBeFocused();
    await expect(form.getByRole('alert').filter({ hasText: TIMELINE_TITLE_REQUIRED_ERROR })).toBeVisible();

    await title.fill('Labeled create event');
    // type="number" rejects non-numeric strings; clear to an empty value so
    // client validation surfaces the integer error instead.
    await order.fill('');
    await form.getByRole('button', { name: 'Create event' }).click();
    await expect(order).toHaveAttribute('aria-invalid', 'true');
    await expect(order).toHaveAccessibleDescription(new RegExp(TIMELINE_ORDER_INTEGER_ERROR));
    await expect(order).toBeFocused();

    await order.fill('42');
    await description.fill('Public markdown body');
    await dmSecret.fill('Only the DM should see this prep note');

    const createResponse = page.waitForResponse(
      (response) =>
        response.url().includes('/timeline') &&
        response.request().method() === 'POST' &&
        response.status() === 201,
    );
    await form.getByRole('button', { name: 'Create event' }).click();
    await createResponse;
    await expect(page.getByTestId('timeline-event-create-form')).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(page.getByText('Labeled create event')).toBeVisible();
  });

  test('edit form associates labels, help, field errors, restores focus, and passes axe', async ({
    page,
  }) => {
    const { form, trigger } = await openEditForm(page);

    const title = form.getByRole('textbox', { name: 'Title' });
    const order = form.getByRole('spinbutton', { name: 'Order' });
    const description = form.getByRole('textbox', { name: /Description/ });
    const dmSecret = form.getByRole('textbox', { name: 'DM secret' });

    await expect(title).toBeFocused();
    await expect(title).toHaveAttribute('id', timelineFieldId(TIMELINE_EDIT_FORM_PREFIX, 'title'));
    await expect(order).toHaveAttribute('id', timelineFieldId(TIMELINE_EDIT_FORM_PREFIX, 'order'));
    await expect(description).toHaveAttribute('id', timelineFieldId(TIMELINE_EDIT_FORM_PREFIX, 'body'));
    await expect(dmSecret).toHaveAttribute('id', timelineFieldId(TIMELINE_EDIT_FORM_PREFIX, 'dmSecret'));
    await expect(order).toHaveAccessibleDescription(TIMELINE_ORDER_HELP);
    await expect(description).toHaveAccessibleDescription(TIMELINE_BODY_HELP);
    await expect(dmSecret).toHaveAccessibleDescription(TIMELINE_DM_SECRET_HELP);

    await title.fill('');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(title).toHaveAttribute('aria-invalid', 'true');
    await expect(title).toHaveAccessibleDescription(TIMELINE_TITLE_REQUIRED_ERROR);
    await expect(title).toBeFocused();

    const accessibilityScan = await new AxeBuilder({ page })
      .include('[data-testid="timeline-event-edit-form"]')
      .analyze();
    expect(accessibilityScan.violations).toEqual([]);

    await form.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByTestId('timeline-event-edit-form')).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test('delete while create form is open focuses the create title, not a missing New event control', async ({
    page,
  }) => {
    const { navigation } = seed();
    const { form: createForm } = await openCreateForm(page);
    const createTitle = createForm.getByRole('textbox', { name: 'Title' });
    await expect(createTitle).toBeFocused();
    await expect(page.getByRole('button', { name: '+ New event' })).toHaveCount(0);

    // Keep the create form mounted: open edit on the seeded event without navigating away.
    const event = page.locator(
      `[data-entity-type="timeline"][data-entity-id="${navigation.timelineId}"]`,
    );
    await event.getByRole('button', { name: 'Edit' }).click();
    const editForm = page.getByTestId('timeline-event-edit-form');
    await expect(editForm).toBeVisible();
    await expect(page.getByTestId('timeline-event-create-form')).toBeVisible();

    const deleteResponse = page.waitForResponse(
      (response) =>
        response.url().includes('/timeline/') &&
        response.request().method() === 'DELETE' &&
        response.ok(),
    );
    await editForm.getByRole('button', { name: 'Delete' }).click();
    await deleteResponse;

    await expect(page.getByTestId('timeline-event-edit-form')).toHaveCount(0);
    await expect(page.getByTestId('timeline-event-create-form')).toBeVisible();
    await expect(page.getByRole('button', { name: '+ New event' })).toHaveCount(0);
    await expect(createTitle).toBeFocused();
  });
});
