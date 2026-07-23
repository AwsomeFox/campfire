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

/** Body string on the End ConfirmDialog (not Delete / Reopen). */
function endConfirmBody(source: string): string {
  const match = source.match(
    /title="End this encounter\?"\s*body="([^"]+)"/,
  );
  expect(match, 'End ConfirmDialog body string').toBeTruthy();
  return match![1];
}

test.describe('End encounter confirmation copy (issue #475)', () => {
  test('explains write-back, Reopen, and re-end conflict — not irreversible', () => {
    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');
    const body = endConfirmBody(source);

    expect(body.toLowerCase()).not.toMatch(/cannot be undone|irreversible/);
    expect(body).toMatch(/writes? .*HP/i);
    expect(body).toMatch(/temp HP/i);
    expect(body).toMatch(/death state/i);
    expect(body).toMatch(/Reopen/);
    expect(body).toMatch(/resume/i);
    expect(body).toMatch(/overwrite/i);
  });
});
