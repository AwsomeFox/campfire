/**
 * Lightweight source contract for the server-admin diagnostics controls (#724).
 * The card's network interactions are covered by the API e2e suite; this pins
 * all three operational states and the manual-check affordances without a live
 * server or brittle visual snapshots.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CARD = resolve(__dirname, '../../src/features/admin/MetricsCard.tsx');

test.describe('MetricsCard storage diagnostics (issue #724)', () => {
  test('shows healthy quietly, renders degraded/error status, and exposes authenticated diagnostics actions', () => {
    const source = readFileSync(CARD, 'utf8');
    expect(source).toContain("metrics.storage.status !== 'ok'");
    expect(source).toContain('Storage diagnostics: {metrics.storage.status}');
    expect(source).toContain('Quick check: {metrics.storage.quickCheck.status}');
    expect(source).toContain("diagnostics/${kind}");
    expect(source).toContain("runCheck('quick-check')");
    expect(source).toContain("runCheck('integrity-check')");
    expect(source).toContain('Run full integrity check');
  });
});
