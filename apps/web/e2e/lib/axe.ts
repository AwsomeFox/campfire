import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

export interface AxeCleanOptions {
  /** Rules allowed to produce incomplete results on translucent/blurred backgrounds. Defaults to ['color-contrast']. */
  allowIncompleteRules?: string[];
  /** Maximum number of incomplete nodes allowed across all incomplete rules. Defaults to 80. */
  maxIncompleteNodes?: number;
}

/**
 * Creates an AxeBuilder configured with repository-wide a11y defaults,
 * including WCAG 2.2 target-size checks enabled.
 */
export function createAxeBuilder(page: Page): AxeBuilder {
  return new AxeBuilder({ page }).options({
    rules: {
      'target-size': { enabled: true },
    },
  });
}

/**
 * Asserts that an axe scan produced 0 violations and respects the repository
 * policy for `incomplete` results (no un-triaged rules, node count bounded).
 */
export function assertAxeClean(
  results: { violations: any[]; incomplete: any[] },
  options: AxeCleanOptions = {},
): void {
  const allowIncompleteRules = new Set(options.allowIncompleteRules ?? ['color-contrast']);
  const maxIncompleteNodes = options.maxIncompleteNodes ?? 80;

  // 1. Hard violations must be zero.
  expect(
    results.violations,
    results.violations
      .map((v) => `${v.id}: ${v.nodes.map((n: any) => n.html).join(' | ')}`)
      .join('\n'),
  ).toEqual([]);

  // 2. Policy for incomplete results:
  // Silently discarding incomplete hid Gap 2 (chrome contrast on translucent backgrounds).
  // Require that only triaged rules (color-contrast on translucent chrome) appear,
  // and enforce node-count bounds so regressions are visible.
  const unexpectedIncompleteRules = results.incomplete.filter(
    (inc) => !allowIncompleteRules.has(inc.id),
  );
  expect(
    unexpectedIncompleteRules,
    `Unexpected axe incomplete rule(s): ${unexpectedIncompleteRules.map((inc) => inc.id).join(', ')}`,
  ).toEqual([]);

  const totalIncompleteNodes = results.incomplete.reduce(
    (sum, inc) => sum + (inc.nodes?.length ?? 0),
    0,
  );
  expect(
    totalIncompleteNodes,
    `Incomplete node count (${totalIncompleteNodes}) exceeded threshold (${maxIncompleteNodes})`,
  ).toBeLessThanOrEqual(maxIncompleteNodes);
}
