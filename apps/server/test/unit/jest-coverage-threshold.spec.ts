/**
 * Guards the #562 coverage floor: CI's `coverage` job runs `npm run test:cov`,
 * which only fails on regression when `coverageThreshold` is present and sane.
 */
const config = require('../../jest.config.js') as {
  coverageThreshold?: Record<string, Record<string, number>>;
};

describe('jest coverageThreshold (#562)', () => {
  it('defines a global floor slightly below observed CI suite levels', () => {
    const global = config.coverageThreshold?.global;
    expect(global).toBeDefined();
    if (global === undefined) {
      throw new Error('coverageThreshold.global must be defined');
    }
    expect(global.statements).toBeGreaterThanOrEqual(85);
    expect(global.branches).toBeGreaterThanOrEqual(66);
    expect(global.functions).toBeGreaterThanOrEqual(86);
    expect(global.lines).toBeGreaterThanOrEqual(87);
  });

  it('keeps function floor within ~4 points of observed ~89.5% (parity with other metrics)', () => {
    const global = config.coverageThreshold?.global;
    expect(global).toBeDefined();
    if (global === undefined) {
      throw new Error('coverageThreshold.global must be defined');
    }
    // Observed funcs ~89.5%; a 5+ point gap was called out in review.
    expect(89.5 - global.functions).toBeLessThanOrEqual(4);
  });

  it('includes per-module carve-outs for known-low branch areas', () => {
    const threshold = config.coverageThreshold;
    expect(threshold).toBeDefined();
    if (threshold === undefined) {
      throw new Error('coverageThreshold must be defined');
    }
    const global = threshold.global;
    expect(global).toBeDefined();
    if (global === undefined) {
      throw new Error('coverageThreshold.global must be defined');
    }
    const carveOuts = [
      './src/modules/auth/',
      './src/modules/rules/',
      './src/modules/ai-dm/',
      './src/modules/mcp/',
      './src/modules/scribe/',
    ];
    for (const path of carveOuts) {
      const entry = threshold[path];
      expect(entry).toBeDefined();
      if (entry === undefined) {
        throw new Error(`coverageThreshold carve-out for ${path} must be defined`);
      }
      expect(entry.branches).toBeGreaterThan(0);
      expect(entry.statements).toBeGreaterThan(0);
      expect(entry.functions).toBeGreaterThan(0);
      expect(entry.lines).toBeGreaterThan(0);
      // Carve-outs must be below the global floor (otherwise they are not carve-outs).
      expect(entry.branches).toBeLessThan(global.branches);
    }
  });
});
