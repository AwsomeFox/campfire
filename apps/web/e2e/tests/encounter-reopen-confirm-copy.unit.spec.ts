/**
 * Reopen-encounter ConfirmDialog copy (issue #493).
 *
 * The body must warn that the *next* End overwrites intervening sheet HP
 * (healing/rest), not merely restate that write-back happens again (#466).
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const RUN_SESSION_PAGE = resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx');

/** Body string on the Reopen ConfirmDialog (not End / Delete). */
function reopenConfirmBody(source: string): string {
  const match = source.match(/title="Reopen this encounter\?"\s*body="([^"]+)"/);
  expect(match, 'Reopen ConfirmDialog body string').toBeTruthy();
  return match![1];
}

test.describe('Reopen encounter confirmation copy (issue #493)', () => {
  test('warns that re-ending overwrites intervening sheet HP / healing', () => {
    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');
    const body = reopenConfirmBody(source);

    expect(body).toMatch(/Running/i);
    expect(body).toMatch(/character sheets/i);
    expect(body).toMatch(/overwrit/i);
    expect(body).toMatch(/heal/i);
    expect(body).toMatch(/#466/);
    // Must not stop at the mechanism-only wording from before the fix.
    expect(body.toLowerCase()).not.toBe(
      'it returns to running where combat left off. hp was written back to character sheets when it ended; it will write back again the next time you end.',
    );
  });
});
