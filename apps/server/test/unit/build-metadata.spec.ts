import { APP_COMMIT, APP_VERSION, buildMetadata } from '../../src/common/build-metadata';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkgVersion: string = require('../../package.json').version;

describe('build-metadata (issue #432)', () => {
  it('APP_VERSION matches apps/server/package.json', () => {
    expect(APP_VERSION).toBe(pkgVersion);
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('buildMetadata always carries the package version', () => {
    const meta = buildMetadata();
    expect(meta.version).toBe(APP_VERSION);
    if (APP_COMMIT) {
      expect(meta.commit).toBe(APP_COMMIT);
    } else {
      expect(meta).toEqual({ version: APP_VERSION });
    }
  });
});
