/**
 * Offline mutations + Large text-size wiring (issue #1534).
 *
 * Source-level guards for the two regression classes in #1534:
 *
 *  Part 1 — TanStack Query v5 defaults mutations to networkMode 'online',
 *  which PAUSES them offline (the promise never settles), so onError
 *  rollback paths never fire and optimistic UI stays stuck. The queryClient
 *  mutation default must be networkMode 'always' so the existing rollback
 *  paths run. Same-family callers that announce success must make the
 *  announcement conditional on the write actually landing.
 *
 *  Part 2 — The "Large" text-size preference's CSS rule
 *  `:root[data-text-size='large'] body { zoom: 1.15; }` never matched
 *  because applyReadingPreference only set data-reading-mode. The attribute
 *  must now be set alongside data-reading-mode.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const QUERY = resolve(__dirname, '../../src/lib/query.ts');
const READING_PREFS = resolve(__dirname, '../../src/app/readingPreferences.ts');
const NOTIF_PAGE = resolve(__dirname, '../../src/features/notifications/NotificationsPage.tsx');
const PREFS_PAGE = resolve(__dirname, '../../src/features/preferences/PreferencesPage.tsx');
const INDEX_CSS = resolve(__dirname, '../../src/index.css');

const QUERY_SOURCE = readFileSync(QUERY, 'utf8');
const READING_PREFS_SOURCE = readFileSync(READING_PREFS, 'utf8');
const NOTIF_PAGE_SOURCE = readFileSync(NOTIF_PAGE, 'utf8');
const PREFS_PAGE_SOURCE = readFileSync(PREFS_PAGE, 'utf8');
const INDEX_CSS_SOURCE = readFileSync(INDEX_CSS, 'utf8');

test.describe('Offline mutations fail fast (#1534 part 1)', () => {
  test('queryClient mutation defaults set networkMode always', () => {
    // Must be inside the mutations defaultOptions block, not the queries block.
    const mutationsStart = QUERY_SOURCE.indexOf('mutations:');
    expect(mutationsStart).toBeGreaterThan(-1);
    const mutationsBlock = QUERY_SOURCE.slice(mutationsStart);
    expect(mutationsBlock).toContain("networkMode: 'always'");
  });

  test('does not regress to the pausing online default', () => {
    const mutationsStart = QUERY_SOURCE.indexOf('mutations:');
    const mutationsBlock = QUERY_SOURCE.slice(mutationsStart);
    expect(mutationsBlock).not.toContain("networkMode: 'online'");
  });
});

test.describe('Error-swallowing callers announce success only on real success (#1534 part 1)', () => {
  test('NotificationsPage handleUndo announces conditionally on the write result', () => {
    // The undo handler must branch on the bulk-result, not announce
    // "Restored unread status." unconditionally — markUnreadBulk swallows
    // network/server failures and returns { updated: 0 } offline.
    const handleUndoStart = NOTIF_PAGE_SOURCE.indexOf('const handleUndo');
    expect(handleUndoStart).toBeGreaterThan(-1);
    const handleUndoBlock = NOTIF_PAGE_SOURCE.slice(handleUndoStart, handleUndoStart + 900);
    expect(handleUndoBlock).toContain('markUnreadBulk');
    expect(handleUndoBlock).toMatch(/res\.updated\s*>\s*0|updated\s*>\s*0/);
    // The success message is reached only inside the success branch.
    expect(handleUndoBlock).toContain("Could not restore unread status.");
  });

  test('PreferencesPage selectDiceTheme reverts optimistic state on failure, but not over a newer selection', () => {
    // The dice-theme picker optimistically sets local state before the await;
    // on failure it must roll the control back to the prior theme rather than
    // leaving the UI on a theme the server rejected — BUT only if no newer
    // selection has superseded this request, otherwise a stale failure would
    // clobber a newer, successfully persisted choice (#1534 review).
    const fnStart = PREFS_PAGE_SOURCE.indexOf('async function selectDiceTheme');
    expect(fnStart).toBeGreaterThan(-1);
    const fnBlock = PREFS_PAGE_SOURCE.slice(fnStart, fnStart + 1000);
    expect(fnBlock).toContain('previous');
    expect(fnBlock).toMatch(/setSelectedDiceTheme\(previous\)/);
    // The latest-request guard that prevents a stale rollback.
    expect(fnBlock).toMatch(/latestDiceThemeRequest/);
  });
});

test.describe('Large text-size preference stays scoped to reading surfaces (#1534 part 2)', () => {
  test('applyReadingPreference drives data-reading-mode only, never a body-zoom attribute', () => {
    // The TextSize contract (packages/schema) scopes the preference to prose
    // and reading surfaces ONLY — never controls, maps, or VTT geometry. It
    // drives the single data-reading-mode attribute consumed by the
    // .reading-surface token rules. The executable attribute calls must
    // reference ONLY READING_MODE_ATTRIBUTE — never a separate text-size
    // attribute that would activate a whole-body zoom. (Asserting on the
    // executable setAttribute/removeAttribute calls, not on bare substrings
    // that may appear in explanatory comments.)
    expect(READING_PREFS_SOURCE).toContain('READING_MODE_ATTRIBUTE');
    // No executable attribute write references a text-size attribute.
    expect(READING_PREFS_SOURCE).not.toMatch(/(set|remove)Attribute\([^)]*text-size/i);
  });

  test('the contract-violating body-zoom rule has been removed from index.css', () => {
    // The dead whole-body zoom rule contradicted the TextSize contract (it
    // scaled the whole chrome like browser zoom, instead of only reading
    // surfaces). The executable selector must stay gone; "Large" is delivered
    // by the data-reading-mode reading tokens, not by body zoom. The regex
    // targets an executable rule, not explanatory prose.
    expect(INDEX_CSS_SOURCE).not.toMatch(/^\s*:root\[data-text-size=/m);
    // No executable CSS rule applies a numeric zoom to the body element.
    expect(INDEX_CSS_SOURCE).not.toMatch(/(^|\})[^\n}]*\bbody\b[^\n{]*\{[^}]*zoom:\s*[\d.]+/);
    // The reading tokens that actually deliver Large are still present.
    expect(INDEX_CSS_SOURCE).toContain(":root[data-reading-mode='large']");
  });
});
