/**
 * Encounter accessibility source contracts (issue #476).
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const RUN_SESSION_PAGE = resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx');
const GENERATE_WIZARD = resolve(__dirname, '../../src/features/encounters/GenerateEncounterWizard.tsx');
const INDEX_CSS = resolve(__dirname, '../../src/index.css');

test.describe('encounter accessibility (#476)', () => {
  const runSession = readFileSync(RUN_SESSION_PAGE, 'utf8');
  const wizard = readFileSync(GENERATE_WIZARD, 'utf8');
  const css = readFileSync(INDEX_CSS, 'utf8');

  test('map toolbar uses toolbar semantics, aria-pressed, and focus rings', () => {
    expect(runSession).toMatch(/data-testid="map-toolbar"[\s\S]*role="toolbar"/);
    expect(runSession).toMatch(/aria-label="Map tools"/);
    expect(runSession).toMatch(/aria-pressed=\{tool === value\}/);
    expect(runSession).toMatch(/className="cf-map-tool cf-map-focusable"/);
    expect(css).toMatch(/\.cf-map-tool:focus-visible/);
  });

  test('Add Combatant panel uses WAI-ARIA tabs with roving tabindex', () => {
    expect(runSession).toMatch(/data-testid="add-combatant-tabs"/);
    expect(runSession).toMatch(/role="tablist"[\s\S]*aria-label=\{t\('run.addCombatant'\)\}/);
    expect(runSession).toMatch(/role="tab"/);
    expect(runSession).toMatch(/aria-selected=\{selectedTab\}/);
    expect(runSession).toMatch(/aria-controls=\{`add-combatant-panel-\$\{t\}`\}/);
    expect(runSession).toMatch(/tabIndex=\{selectedTab \? 0 : -1\}/);
    expect(runSession).toMatch(/onAddTabKeyDown/);
    expect(runSession).toMatch(/role="tabpanel"/);
  });

  test('remove controls hide decorative glyphs from assistive tech', () => {
    // Issue #1715: the raw ✕/× glyphs these controls used to render inline
    // (manually wrapped in `aria-hidden`) migrated to `<UIIcon name="close">`,
    // which is aria-hidden by construction (GameIcon sets aria-hidden={true}
    // whenever no `title` is passed — see GameIcon.tsx). The accessible name
    // still comes entirely from each button's own `aria-label`, unchanged.
    expect(runSession).toMatch(/aria-label=\{`Remove \$\{combatant\.name\}`\}[\s\S]*<UIIcon name="close"/);
    expect(runSession).toMatch(/aria-label=\{`Remove \$\{inst\.name\}`\}[\s\S]*<UIIcon name="close"/);
    expect(runSession).toMatch(/aria-label=\{`Dismiss apply \$\{amount\} \$\{label\} bar`\}/);
    expect(wizard).toMatch(/aria-label=\{`Remove \$\{slot\.name\}`\}[\s\S]*<UIIcon name="close"/);
  });

  test('difficulty badge exposes visible focusable help instead of title-only tooltips', () => {
    expect(runSession).toMatch(/buildDifficultyExplanation/);
    expect(runSession).toMatch(/data-testid="difficulty-help-toggle"/);
    expect(runSession).toMatch(/data-testid="difficulty-help-panel"/);
    expect(runSession).not.toMatch(/function DifficultyBadge[\s\S]*title=\{title\}/);
  });
});
