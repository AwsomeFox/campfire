/**
 * End-encounter ConfirmDialog copy (issue #475).
 *
 * The ended screen offers Reopen, so the End confirmation must not claim the
 * action is irreversible. It should spell out write-back, what Reopen resumes,
 * and the re-end overwrite hazard (#466). Pure source-level suite (pw-unit).
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const RUN_SESSION_PAGE = resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx');
const EN_ENCOUNTERS = resolve(__dirname, '../../src/i18n/locales/en/encounters.json');

/** Body string on the End ConfirmDialog (not Delete / Reopen). */
function endConfirmBody(): string {
  const catalog = JSON.parse(readFileSync(EN_ENCOUNTERS, 'utf8'));
  return catalog.encounters.runner.confirmEndBody;
}

test.describe('End encounter confirmation copy (issue #475)', () => {
  test('explains write-back, Reopen, and re-end conflict — not irreversible', () => {
    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');
    expect(source).toMatch(/confirmEndTitle/);
    expect(source).toMatch(/confirmEndBody/);

    const body = endConfirmBody();

    expect(body.toLowerCase()).not.toMatch(/cannot be undone|irreversible/);
    expect(body).toMatch(/writes? .*HP/i);
    expect(body).toMatch(/temp HP/i);
    expect(body).toMatch(/death state/i);
    expect(body).toMatch(/Reopen/);
    expect(body).toMatch(/resume/i);
    // #466: End copy must say conflicts are resolved on Reopen, not silently overwritten.
    expect(body).toMatch(/conflict/i);
    expect(body).toMatch(/not silently overwrite/i);
  });
});
