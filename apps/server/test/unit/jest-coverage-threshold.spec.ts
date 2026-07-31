/**
 * Guards the #562 coverage floor: CI's `coverage` job runs `npm run test:cov`,
 * which only fails on regression when `coverageThreshold` is present and sane.
 */
const config = require('../../jest.unit.config.js') as {
  testMatch?: string[];
  collectCoverageFrom?: string[];
  coveragePathIgnorePatterns?: string[];
  coverageThreshold?: Record<string, Record<string, number>>;
};

describe('jest coverageThreshold (#562)', () => {
  it('limits coverage to unit specs while measuring every production source file', () => {
    expect(config.testMatch).toEqual(['<rootDir>/test/unit/**/*.spec.ts']);
    expect(config.collectCoverageFrom).toContain('<rootDir>/src/**/*.ts');
    expect(config.coveragePathIgnorePatterns).toContain('/test/');
  });

  it('defines a global floor slightly below the observed unit-only baseline', () => {
    const global = config.coverageThreshold?.global;
    expect(global).toBeDefined();
    if (global === undefined) {
      throw new Error('coverageThreshold.global must be defined');
    }
    expect(global.statements).toBeGreaterThanOrEqual(40);
    expect(global.branches).toBeGreaterThanOrEqual(30);
    expect(global.functions).toBeGreaterThanOrEqual(35);
    expect(global.lines).toBeGreaterThanOrEqual(40);
  });

  it('keeps each floor below its measured baseline so normal variance has headroom', () => {
    const global = config.coverageThreshold?.global;
    expect(global).toBeDefined();
    if (global === undefined) {
      throw new Error('coverageThreshold.global must be defined');
    }
    expect(global.statements).toBeLessThan(40.8);
    expect(global.branches).toBeLessThan(32.13);
    expect(global.functions).toBeLessThan(41.44);
    expect(global.lines).toBeLessThan(42.52);
  });
});
