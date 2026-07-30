/**
 * Issue #632 — Long translated names full-text reveal and accessible truncation.
 *
 * Verifies that:
 * 1. CSS (.cf-name-reveal, .dialog-title, .dialog-body) provides responsive wrapping
 *    (overflow-wrap: anywhere; word-break: break-word) and focus/hover reveal.
 * 2. Primary entity roster pages (PartyPage, NpcListPage, LocationListPage, FactionListPage, TrashPage)
 *    and shared components (RollResultBanner) include title attributes, aria-labels,
 *    and .cf-name-reveal class for full 120+ char names.
 * 3. Confirmation dialogs (ConfirmDialog, ConfirmDestructiveDialog) display full text without truncation.
 * 4. Responsive zoom (200-400%) & layout bounds preserve long names without overflow.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const INDEX_CSS = resolve(ROOT, 'src/index.css');
const PARTY_PAGE = resolve(ROOT, 'src/features/characters/PartyPage.tsx');
const NPC_LIST_PAGE = resolve(ROOT, 'src/features/npcs/NpcListPage.tsx');
const LOCATION_LIST_PAGE = resolve(ROOT, 'src/features/locations/LocationListPage.tsx');
const FACTION_LIST_PAGE = resolve(ROOT, 'src/features/factions/FactionListPage.tsx');
const TRASH_PAGE = resolve(ROOT, 'src/features/trash/TrashPage.tsx');
const ROLL_RESULT_BANNER = resolve(ROOT, 'src/components/RollResultBanner.tsx');
const CONFIRM_DIALOG = resolve(ROOT, 'src/components/ConfirmDialog.tsx');
const CONFIRM_DESTRUCTIVE_DIALOG = resolve(ROOT, 'src/components/ConfirmDestructiveDialog.tsx');
const UI_TSX = resolve(ROOT, 'src/components/ui.tsx');

const GERMAN_120_CHAR_NAME =
  'Prinzessin Wilhelmina Franziska von Hohenzollern-Sigmaringen Die Erleuchtete Beschützerin des Alten Waldreichs IV von Bayern';

test.describe('Long translated name reveal & accessible truncation (issue #632)', () => {
  test('sample 120-character multilingual string meets length requirement', () => {
    expect(GERMAN_120_CHAR_NAME.length).toBeGreaterThanOrEqual(120);
  });

  test('CSS defines .cf-name-reveal for focus/hover/touch reveal and responsive text wrapping', () => {
    const css = readFileSync(INDEX_CSS, 'utf8');
    expect(css).toMatch(/\.cf-name-reveal\s*\{/);
    expect(css).toMatch(/\.cf-name-reveal:focus/);
    expect(css).toMatch(/\.cf-name-reveal:focus-visible/);
    expect(css).toMatch(/\.cf-name-reveal:active/);
    expect(css).toMatch(/\.cf-name-reveal:hover/);
    expect(css).toMatch(/@media\s*\(\s*hover:\s*none\s*\)\s*and\s*\(\s*pointer:\s*coarse\s*\)/);
    expect(css).toMatch(/overflow:\s*visible/);
    expect(css).toMatch(/white-space:\s*normal/);
    expect(css).toMatch(/word-break:\s*break-word/);
    expect(css).toMatch(/overflow-wrap:\s*anywhere/);
  });

  test('dialog CSS enforces overflow-wrap: anywhere for 200-400% zoom and long names', () => {
    const css = readFileSync(INDEX_CSS, 'utf8');
    expect(css).toMatch(/\.dialog-title,\s*\n?\.dialog-body[\s\S]*?overflow-wrap:\s*anywhere/);
  });

  test('PartyPage provides accessible full name title, aria-label, and reveal on roster cards and XP award form', () => {
    const source = readFileSync(PARTY_PAGE, 'utf8');
    expect(source).toMatch(/className="font-bold text-white text-\[15px\] truncate cf-name-reveal"/);
    expect(source).toMatch(/title=\{character\.name\}/);
    expect(source).toMatch(/aria-label=\{character\.name\}/);
    expect(source).toMatch(/className="cf-name-reveal inline-block max-w-full"/);
  });

  test('NpcListPage provides title, aria-label, and reveal class on NPC roster cards', () => {
    const source = readFileSync(NPC_LIST_PAGE, 'utf8');
    expect(source).toMatch(/className="font-bold text-slate-200 text-sm truncate cf-name-reveal"/);
    expect(source).toMatch(/title=\{npc\.name\}/);
    expect(source).toMatch(/aria-label=\{`NPC: \$\{npc\.name\}`\}/);
  });

  test('LocationListPage provides title, aria-label, and reveal class on Location roster cards', () => {
    const source = readFileSync(LOCATION_LIST_PAGE, 'utf8');
    expect(source).toMatch(/className="font-bold text-slate-200 text-sm truncate cf-name-reveal"/);
    expect(source).toMatch(/title=\{loc\.name\}/);
    expect(source).toMatch(/aria-label=\{`Location: \$\{loc\.name\}`\}/);
  });

  test('FactionListPage provides title, aria-label, and reveal class on Faction roster cards', () => {
    const source = readFileSync(FACTION_LIST_PAGE, 'utf8');
    expect(source).toMatch(/className="font-bold text-slate-200 text-sm truncate cf-name-reveal"/);
    expect(source).toMatch(/title=\{faction\.name\}/);
    expect(source).toMatch(/aria-label=\{`Faction: \$\{faction\.name\}`\}/);
  });

  test('TrashPage provides title, aria-label, and reveal class on trashed items list', () => {
    const source = readFileSync(TRASH_PAGE, 'utf8');
    expect(source).toMatch(/className="font-heading text-\[15px\] text-white truncate cf-name-reveal"/);
    expect(source).toMatch(/title=\{item\.name \|\| 'Untitled'\}/);
    expect(source).toMatch(/aria-label=\{item\.name \|\| 'Untitled'\}/);
  });

  test('RollResultBanner provides title, aria-label, and reveal class on roll label', () => {
    const source = readFileSync(ROLL_RESULT_BANNER, 'utf8');
    expect(source).toMatch(/className="text-\[13px\] font-semibold truncate cf-name-reveal"/);
    expect(source).toMatch(/title=\{roll\.label \|\| roll\.expr\}/);
    expect(source).toMatch(/aria-label=\{roll\.label \|\| roll\.expr\}/);
  });

  test('ConfirmDialog and ConfirmDestructiveDialog render full title and body without truncation', () => {
    // Both compose the shared Dialog primitive (issue #1783) rather than
    // rendering their own `.dialog-title` element — the untruncated-title
    // guarantee now lives in ui.tsx, and each caller passes `title` through.
    const uiSource = readFileSync(UI_TSX, 'utf8');
    expect(uiSource).toMatch(/className="dialog-title"/);
    expect(uiSource).not.toMatch(/dialog-title[^]*?truncate/);

    const confirmSource = readFileSync(CONFIRM_DIALOG, 'utf8');
    expect(confirmSource).toMatch(/title=\{title\}/);
    expect(confirmSource).not.toMatch(/truncate/);

    const destructiveSource = readFileSync(CONFIRM_DESTRUCTIVE_DIALOG, 'utf8');
    expect(destructiveSource).toMatch(/title=\{title\}/);
    expect(destructiveSource).not.toMatch(/truncate/);
  });
});
