/**
 * Component-render coverage for RulesHintPopover (issue #1939) — the accessible info
 * disclosure standard-action chips and condition tags mount instead of a hover-only
 * `title=` tooltip.
 *
 * A source scan can confirm `aria-expanded`/`aria-describedby` strings appear somewhere in
 * the file; it cannot tell whether the trigger is actually wired to a real toggle, whether
 * the popover text matches the resolved i18n key, whether Escape/outside-click actually
 * close it, or whether the "Full rule" link renders only when a compendium href is passed.
 * This test mounts the real component and drives it.
 */
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, test, expect, afterEach, beforeAll } from 'vitest';
import type { ComponentProps } from 'react';
import { MemoryRouter } from 'react-router-dom';
import '../../src/i18n';
import { RulesHintPopover } from '../../src/components/RulesHintPopover';

// jsdom has no ResizeObserver; the popover only uses it to re-run its viewport-clamped
// positioning math (fitTermHelpPanel), which this test does not assert on.
beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => cleanup());

// A real catalog key so the rendered body text is deterministic and not the raw key.
const HINT_KEY = 'encounters.rulesHints.dnd5e.conditions.restrained';

function renderPopover(overrides: Partial<ComponentProps<typeof RulesHintPopover>> = {}) {
  return render(
    <MemoryRouter>
      <RulesHintPopover termId="restrained" termLabel="Restrained" hintKey={HINT_KEY} {...overrides} />
    </MemoryRouter>,
  );
}

describe('RulesHintPopover (issue #1939)', () => {
  test('renders a trigger button, collapsed, with no panel in the DOM', () => {
    renderPopover();
    const trigger = screen.getByTestId('rules-hint-trigger-restrained');
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.getAttribute('aria-describedby')).toBeNull();
    expect(screen.queryByTestId('rules-hint-panel-restrained')).toBeNull();
  });

  test('clicking the trigger opens the panel with the resolved hint text, and flips aria-expanded/aria-describedby', () => {
    renderPopover();
    const trigger = screen.getByTestId('rules-hint-trigger-restrained');
    fireEvent.click(trigger);

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const describedBy = trigger.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();

    const panel = screen.getByTestId('rules-hint-panel-restrained');
    expect(panel.id).toBe(describedBy);
    expect(panel.textContent).toContain('Restrained');
    // The actual English catalog string for this key — proves the panel renders the
    // RESOLVED i18n text, not the raw key.
    expect(panel.textContent).toContain('Speed becomes 0');
  });

  test('a second click on the trigger closes the panel again (toggle)', () => {
    renderPopover();
    const trigger = screen.getByTestId('rules-hint-trigger-restrained');
    fireEvent.click(trigger);
    expect(screen.getByTestId('rules-hint-panel-restrained')).toBeTruthy();
    fireEvent.click(trigger);
    expect(screen.queryByTestId('rules-hint-panel-restrained')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  test('Escape closes the open panel and returns focus to the trigger', () => {
    renderPopover();
    const trigger = screen.getByTestId('rules-hint-trigger-restrained');
    fireEvent.click(trigger);
    expect(screen.getByTestId('rules-hint-panel-restrained')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByTestId('rules-hint-panel-restrained')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  test('a pointerdown outside the trigger/panel closes it', () => {
    renderPopover();
    const trigger = screen.getByTestId('rules-hint-trigger-restrained');
    fireEvent.click(trigger);
    expect(screen.getByTestId('rules-hint-panel-restrained')).toBeTruthy();

    fireEvent.pointerDown(document.body);

    expect(screen.queryByTestId('rules-hint-panel-restrained')).toBeNull();
  });

  test('omitting compendiumHref renders no "Full rule" link', () => {
    renderPopover();
    fireEvent.click(screen.getByTestId('rules-hint-trigger-restrained'));
    expect(screen.queryByRole('link')).toBeNull();
  });

  test('passing compendiumHref renders a "Full rule" link pointed at it', () => {
    renderPopover({ compendiumHref: '/c/42/compendium?q=Restrained' });
    fireEvent.click(screen.getByTestId('rules-hint-trigger-restrained'));
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('/c/42/compendium?q=Restrained');
  });
});
