import { expect, test } from '@playwright/test';
import { validateHeadingOutline } from '../../src/lib/headingOutline';

test.describe('heading outline validation (issue #457)', () => {
  test('accepts a single h1 page title', () => {
    expect(validateHeadingOutline([{ level: 1, text: 'Quests' }])).toEqual([]);
  });

  test('accepts ordered section headings under one h1', () => {
    expect(
      validateHeadingOutline([
        { level: 1, text: 'Timeline' },
        { level: 2, text: 'Current in-world date' },
        { level: 2, text: 'DLRNAV Sundering' },
        { level: 2, text: 'Another event' },
      ]),
    ).toEqual([]);
  });

  test('accepts nested record headings', () => {
    expect(
      validateHeadingOutline([
        { level: 1, text: 'Storylines' },
        { level: 2, text: 'DLRNAV Ember Arc' },
        { level: 3, text: 'DLRNAV Broken Oath' },
      ]),
    ).toEqual([]);
  });

  test('rejects missing h1', () => {
    expect(validateHeadingOutline([{ level: 2, text: 'Users' }])).toContain('expected exactly one h1, got 0');
  });

  test('rejects multiple h1 headings', () => {
    expect(
      validateHeadingOutline([
        { level: 1, text: 'Users' },
        { level: 1, text: 'Users' },
      ]),
    ).toContain('expected exactly one h1, got 2');
  });

  test('rejects skipped heading levels', () => {
    const errors = validateHeadingOutline([
      { level: 1, text: 'Timeline' },
      { level: 3, text: 'Event title' },
    ]);
    expect(errors.some((error) => error.includes('heading level skips'))).toBe(true);
  });

  test('rejects duplicate adjacent titles at the same level', () => {
    expect(
      validateHeadingOutline([
        { level: 1, text: 'Users' },
        { level: 2, text: 'Users' },
      ]),
    ).toContain('duplicate adjacent heading "Users" (h1 then h2)');
  });
});
