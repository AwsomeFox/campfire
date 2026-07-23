import { BadRequestException } from '@nestjs/common';
import {
  BACKUP_APP,
  BACKUP_FORMAT_VERSION,
  BACKUP_KIND,
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
});
