/**
 * Issue #775 — pure helpers for typed destructive confirmation matching.
 */
import { expect, test } from '@playwright/test';
import {
  confirmValuesMatch,
  normalizeConfirmValue,
} from '../../src/components/ConfirmDestructiveDialog';

test.describe('normalizeConfirmValue (#775)', () => {
  test('trims and collapses whitespace', () => {
    expect(normalizeConfirmValue('  E2E  —   Cinderhaven  ')).toBe('e2e — cinderhaven');
  });

  test('is case-insensitive', () => {
    expect(normalizeConfirmValue('Cinderhaven')).toBe('cinderhaven');
  });

  test('confirmValuesMatch accepts normalized equivalents', () => {
    expect(confirmValuesMatch('  e2e — cinderhaven', 'E2E — Cinderhaven')).toBe(true);
    expect(confirmValuesMatch('wrong', 'E2E — Cinderhaven')).toBe(false);
  });
});
