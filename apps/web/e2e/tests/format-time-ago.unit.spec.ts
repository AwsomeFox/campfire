/**
 * Unit tests for consolidated timeAgo and locale formatters (issue #1531).
 */
import { expect, test } from '@playwright/test';
import { timeAgo, formatNumber, formatDateTime } from '../../src/lib/format';

test.describe('timeAgo formatting (#1531)', () => {
  test('clamps future timestamps / negative time skew to "just now"', () => {
    const future = Date.now() + 10_000;
    expect(timeAgo(future)).toBe('just now');
  });

  test('formats timestamps under 60 seconds as "just now"', () => {
    const justNow = Date.now() - 10_000;
    expect(timeAgo(justNow)).toBe('just now');
  });

  test('formats minutes relative time', () => {
    const fiveMins = Date.now() - 5 * 60 * 1000;
    expect(timeAgo(fiveMins)).toBe('5m ago');
  });

  test('formats hours relative time', () => {
    const twoHours = Date.now() - 2 * 3600 * 1000;
    expect(timeAgo(twoHours)).toBe('2h ago');
  });

  test('formats days relative time', () => {
    const threeDays = Date.now() - 3 * 86400 * 1000;
    expect(timeAgo(threeDays)).toBe('3d ago');
  });

  test('falls back to formatDate for timestamps older than 30 days', () => {
    const fortyDaysAgo = new Date('2025-01-01T12:00:00.000Z');
    const result = timeAgo(fortyDaysAgo);
    expect(result).not.toContain('ago');
    expect(result).toMatch(/2025/);
  });
});

test.describe('formatNumber and formatDateTime (#1531)', () => {
  test('formats numbers with grouping', () => {
    expect(formatNumber(1234567)).toMatch(/1[,\s.]234[,\s.]567/);
  });

  test('formats ISO date time string', () => {
    const dt = formatDateTime('2026-07-21T20:00:00.000Z');
    expect(dt).toMatch(/2026/);
  });
});
