/**
 * Encounter cockpit layout contracts.
 *
 * Issue #669 gave the run page a two-column sticky activity rail inside the
 * normal reading flow. The `encounter-vtt` design import replaced that with the
 * full-viewport cockpit: one fixed shell, a map canvas that owns the remaining
 * space, and a tabbed side panel. These assertions pin the parts of that
 * arrangement that are easy to regress by accident — the shell being the page's
 * only root, the map running in cockpit layout, and the panel's tab set.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = resolve(__dirname, '../../src');
const RUN_SESSION_PAGE = resolve(SRC, 'features/encounters/RunSessionPage.tsx');
const SHELL = resolve(SRC, 'features/encounters/vtt/EncounterVttShell.tsx');
const STYLES = resolve(SRC, 'index.css');

test.describe('encounter cockpit layout', () => {
  test('the run page renders the VTT shell as its only root', () => {
    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');

    expect(source).toMatch(/return \(\s*<EncounterVttShell/);
    expect(source).toMatch(/<\/EncounterVttShell>\s*\);/);
    // The pre-redesign reading-flow container must not come back alongside it.
    expect(source).not.toMatch(/max-w-4xl lg:max-w-6xl/);
    expect(source).not.toMatch(/data-testid="encounter-cockpit"/);
  });

  test('the map fills the canvas in cockpit layout', () => {
    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');

    expect(source).toMatch(/<BattleMap\s*\n\s*layout="vtt"/);
  });

  test('the side panel exposes turn, party, log and table tabs', () => {
    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');

    for (const [id, key] of [
      ['turn', 'tabTurn'],
      ['party', 'tabParty'],
      ['log', 'tabLog'],
      ['table', 'tabTable'],
    ]) {
      expect(source).toContain(`id: '${id}', label: t('encounters.vtt.${key}')`);
      expect(source).toMatch(new RegExp(`<VttPanelSection id="${id}" activeTabId=\\{panelTab\\}`));
    }

    // The combat log lives in the Log tab; the shared dice tray moved to the
    // floating Roll control, so it must not be duplicated back into the panel.
    expect(source).toMatch(/<VttPanelSection id="log"[\s\S]{0,120}<CombatLog/);
    // Every panel keeps its mount — see VttPanelSection for the three separate pieces of
    // state that a tab-change unmount used to destroy.
    const shell = readFileSync(SHELL, 'utf8');
    expect(shell).not.toContain('keepMounted');
    expect(shell).toMatch(/hidden=\{!active\}/);
    // The side panel hides when collapsed rather than unmounting, for the same reason.
    expect(shell).toMatch(/className="cf-vtt-panel"[\s\S]{0,220}hidden=\{!panelOpen\}/);
    expect(source).toMatch(/className="cf-vtt-tray"[\s\S]{0,400}<SharedDiceLog/);
    // The tray hides; it never unmounts, or the app loses its only dice.rolled subscriber.
    expect(source).toMatch(/className="cf-vtt-tray"[\s\S]{0,300}hidden=\{!diceTrayOpen\}/);
  });

  test('the shell is a fixed full-viewport grid that never scrolls the page', () => {
    const shell = readFileSync(SHELL, 'utf8');
    const styles = readFileSync(STYLES, 'utf8');

    expect(shell).toMatch(/className=\{`cf-vtt\$\{/);
    expect(shell).toMatch(/role="tablist"/);
    expect(shell).toMatch(/role="tabpanel"/);

    const block = styles.slice(styles.indexOf('.cf-vtt {'), styles.indexOf('.cf-vtt-header {'));
    expect(block).toMatch(/position: fixed;/);
    expect(block).toMatch(/inset: 0;/);
    // Header and banners are `auto`; the body keeps a floor so a tall wrapped header plus
    // stacked banners can never squeeze the map and panel to nothing.
    expect(block).toMatch(/grid-template-rows: auto auto minmax\(96px, 1fr\);/);
    expect(block).toMatch(/overflow: hidden;/);
    // Above the mobile tab bar it replaces, below dialogs.
    expect(styles).toMatch(/--cf-layer-immersive: 41;/);
  });
});
