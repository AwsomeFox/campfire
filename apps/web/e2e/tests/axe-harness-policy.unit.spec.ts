/**
 * Unit tests for the accessibility harness and incomplete policy (issue #1778).
 */
import { expect, test } from '@playwright/test';
import { assertAxeClean, createAxeBuilder } from '../lib/axe';

test.describe('accessibility harness and incomplete policy (#1778)', () => {
  test('createAxeBuilder configures target-size rule as enabled by default', () => {
    const dummyPage = {} as any;
    const builder = createAxeBuilder(dummyPage);
    const rules = (builder as any).options?.rules ?? (builder as any).ruleParams;
    expect(rules?.['target-size']?.enabled).toBe(true);
  });

  test('assertAxeClean passes when violations is empty and incomplete is within allowed policy', () => {
    const cleanResults = {
      violations: [],
      incomplete: [
        {
          id: 'color-contrast',
          nodes: [{ html: '<span>test</span>', target: ['.nav'] }],
        },
      ],
    };

    expect(() => assertAxeClean(cleanResults, { maxIncompleteNodes: 10 })).not.toThrow();
  });

  test('assertAxeClean fails when violations are present', () => {
    const violationResults = {
      violations: [
        {
          id: 'target-size',
          nodes: [{ html: '<button>small</button>' }],
        },
      ],
      incomplete: [],
    };

    expect(() => assertAxeClean(violationResults)).toThrow();
  });

  test('assertAxeClean fails when an un-allowed rule appears in incomplete', () => {
    const unexpectedIncompleteResults = {
      violations: [],
      incomplete: [
        {
          id: 'label',
          nodes: [{ html: '<input />' }],
        },
      ],
    };

    expect(() => assertAxeClean(unexpectedIncompleteResults)).toThrow(/Unexpected axe incomplete rule/);
  });

  test('assertAxeClean fails when incomplete node count exceeds maxIncompleteNodes bound', () => {
    const highIncompleteCountResults = {
      violations: [],
      incomplete: [
        {
          id: 'color-contrast',
          nodes: Array.from({ length: 15 }, (_, i) => ({ html: `<span>${i}</span>` })),
        },
      ],
    };

    expect(() => assertAxeClean(highIncompleteCountResults, { maxIncompleteNodes: 10 })).toThrow(
      /Incomplete node count \(15\) exceeded threshold \(10\)/,
    );
  });
});
