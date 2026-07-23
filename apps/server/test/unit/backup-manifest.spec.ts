import { BadRequestException } from '@nestjs/common';
import {
  BACKUP_APP,
  BACKUP_FORMAT_VERSION,
  BACKUP_KIND,
  DB_ENTRY_V1,
  manifestToInspectView,
  parseBackupManifest,
} from '../../src/modules/backup/backup-manifest';

describe('parseBackupManifest (issue #514)', () => {
  const baseV1 = {
    app: BACKUP_APP,
    kind: BACKUP_KIND,
    version: 1,
    createdAt: '2026-07-20T12:00:00.000Z',
    db: 'db/campfire.db',
    dbBytes: 12345,
    uploadCount: 2,
    appVersion: '0.14.1',
    schemaVersion: 55,
  };

  it('accepts a current-format manifest', () => {
    expect(parseBackupManifest(baseV1)).toMatchObject({
      version: BACKUP_FORMAT_VERSION,
      dbBytes: 12345,
      uploadCount: 2,
      appVersion: '0.14.1',
      schemaVersion: 55,
    });
  });

  it('migrates a pre-version manifest (format 0) to the current shape', () => {
    const { version: _v, ...withoutVersion } = baseV1;
    expect(parseBackupManifest(withoutVersion)).toMatchObject({
      version: BACKUP_FORMAT_VERSION,
      dbBytes: 12345,
    });
  });

  it('rejects an unsupported future format before restore would touch data', () => {
    expect(() =>
      parseBackupManifest({
        ...baseV1,
        version: 99,
        minCampfireVersion: '9.9.0',
      }),
    ).toThrow(BadRequestException);
    try {
      parseBackupManifest({ ...baseV1, version: 99, minCampfireVersion: '9.9.0' });
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).message).toContain('format version 99');
      expect((err as BadRequestException).message).toContain('v9.9.0');
    }
  });

  it('rejects foreign or malformed manifests', () => {
    expect(() => parseBackupManifest({ kind: BACKUP_KIND, version: 1 })).toThrow(BadRequestException);
    expect(() => parseBackupManifest({ ...baseV1, version: 1.5 })).toThrow(BadRequestException);
    expect(() => parseBackupManifest(null)).toThrow(BadRequestException);
  });

  // Issue #997 fix 2: validate manifest.db against expected entry name
  describe('manifest.db validation (issue #997)', () => {
    it('rejects a manifest with unexpected db entry for format 1', () => {
      expect(() =>
        parseBackupManifest({ ...baseV1, db: 'malicious/path.db' }),
      ).toThrow(BadRequestException);
      try {
        parseBackupManifest({ ...baseV1, db: 'malicious/path.db' });
      } catch (err) {
        expect((err as BadRequestException).message).toContain(DB_ENTRY_V1);
        expect((err as BadRequestException).message).toContain('malicious/path.db');
      }
    });

    it('rejects a format-0 manifest with unexpected db entry', () => {
      const { version: _v, ...withoutVersion } = baseV1;
      expect(() =>
        parseBackupManifest({ ...withoutVersion, db: '../escape.db' }),
      ).toThrow(BadRequestException);
    });

    it('accepts a manifest with the canonical db entry', () => {
      expect(parseBackupManifest(baseV1).db).toBe(DB_ENTRY_V1);
    });
  });
});

// Issue #997 fix 3: manifestToInspectView preserves sourceFormatVersion
describe('manifestToInspectView (issue #997)', () => {
  const manifest = {
    app: BACKUP_APP,
    kind: BACKUP_KIND,
    version: BACKUP_FORMAT_VERSION,
    createdAt: '2026-07-20T12:00:00.000Z',
    db: 'db/campfire.db',
    dbBytes: 12345,
    uploadCount: 2,
    appVersion: '0.14.1',
    schemaVersion: 55,
  };

  it('reports sourceFormatVersion distinct from normalized formatVersion', () => {
    const result = manifestToInspectView(manifest, ['a.png'], 0);
    expect(result.formatVersion).toBe(BACKUP_FORMAT_VERSION);
    expect(result.sourceFormatVersion).toBe(0);
  });

  it('reports matching versions for a native format-1 archive', () => {
    const result = manifestToInspectView(manifest, [], 1);
    expect(result.formatVersion).toBe(1);
    expect(result.sourceFormatVersion).toBe(1);
  });
});
