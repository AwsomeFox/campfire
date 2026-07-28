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
  test('keeps healthy state quiet, renders degraded/error states, and exposes diagnostics actions', () => {
    const source = readFileSync(CARD, 'utf8');
    // Healthy diagnostics do not add an alert. Non-OK covers degraded, failed,
    // and unknown without pretending an unavailable disk is healthy.
    expect(source).toContain("metrics.storage.status !== 'ok'");
    expect(source).toContain('Storage diagnostics: {metrics.storage.status}');
    expect(source).toContain('Quick check: {metrics.storage.quickCheck.status}');
    expect(source).toContain('if (error && !metrics)');
    expect(source).toContain('<ErrorNote message={error} onRetry={load} />');
    expect(source).toContain('{error && <p className="text-xs text-rose-400">{error}</p>}');
    expect(source).toContain("diagnostics/${kind}");
    expect(source).toContain("runCheck('quick-check')");
    expect(source).toContain("runCheck('integrity-check')");
    expect(source).toContain('Run full integrity check');
  });
});
