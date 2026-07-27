import { BadRequestException } from '@nestjs/common';
import {
  BACKUP_APP,
  BACKUP_FORMAT_VERSION,
  BACKUP_KIND,
  DB_ENTRY_V1,
  assertBackupManifestBytes,
  manifestToInspectView,
  parseBackupManifest,
  serializeBackupManifest,
} from '../../src/modules/backup/backup-manifest';
import { MAX_ARCHIVE_ENTRIES, MAX_MANIFEST_BYTES } from '../../src/modules/backup/backup-archive-reader';

const baseV3 = {
  app: BACKUP_APP,
  kind: BACKUP_KIND,
  version: BACKUP_FORMAT_VERSION,
  createdAt: '2026-07-20T12:00:00.000Z',
  db: DB_ENTRY_V1,
  dbBytes: 12345,
  uploadCount: 0,
  appVersion: '0.14.1',
  schemaVersion: 55,
  aiKeySource: 'env',
  aiKeyIncluded: false,
  attachments: [],
  reconciliation: {
    generation: 'test-generation', totalAttachments: 0, missing: 0, changed: 0,
    orphans: [], orphanCount: 0, clean: true,
  },
};

describe('parseBackupManifest (v3 only)', () => {
  it('accepts the complete current-format manifest', () => {
    expect(parseBackupManifest(baseV3)).toMatchObject({
      version: BACKUP_FORMAT_VERSION, dbBytes: 12345, uploadCount: 0,
      aiKeySource: 'env', aiKeyIncluded: false, attachments: [],
    });
  });

  it.each([undefined, 0, 1, 2, 4, 99])('rejects legacy or unsupported version %s', (version) => {
    const manifest = version === undefined
      ? Object.fromEntries(Object.entries(baseV3).filter(([key]) => key !== 'version'))
      : { ...baseV3, version };
    expect(() => parseBackupManifest(manifest)).toThrow(/format version/i);
  });

  it.each([
    ['attachments', undefined, /attachments must be an array/i],
    ['reconciliation', undefined, /requires reconciliation metadata/i],
    ['aiKeySource', undefined, /requires aiKeySource/i],
    ['aiKeyIncluded', undefined, /requires aiKeyIncluded/i],
  ])('rejects a v3 manifest missing required %s', (field, value, message) => {
    expect(() => parseBackupManifest({ ...baseV3, [field]: value })).toThrow(message);
  });

  it('rejects invalid db paths and invalid reconciliation invariants', () => {
    expect(() => parseBackupManifest({ ...baseV3, db: '../escape.db' })).toThrow(DB_ENTRY_V1);
    expect(() => parseBackupManifest({
      ...baseV3,
      reconciliation: { ...baseV3.reconciliation, totalAttachments: 1 },
    })).toThrow(/reconciliation is invalid/i);
    expect(() => parseBackupManifest({
      ...baseV3,
      reconciliation: { ...baseV3.reconciliation, clean: false },
    })).toThrow(/reconciliation is invalid/i);
  });

  it('requires a keyfile envelope posture to be represented by the archive payload', () => {
    const parsed = parseBackupManifest({
      ...baseV3, aiKeySource: 'keyfile', aiKeyIncluded: true,
    });
    expect(parsed.aiKeyIncluded).toBe(true);
    expect(() => parseBackupManifest({ ...baseV3, aiKeyIncluded: true })).toThrow(/requires aiKeySource/i);
  });

  it('rejects malformed and foreign manifests', () => {
    expect(() => parseBackupManifest({ kind: BACKUP_KIND, version: BACKUP_FORMAT_VERSION })).toThrow(BadRequestException);
    expect(() => parseBackupManifest({ ...baseV3, version: 3.5 })).toThrow(BadRequestException);
    expect(() => parseBackupManifest(null)).toThrow(BadRequestException);
  });
});

describe('backup manifest size contract', () => {
  it('serializes and parses a near-entry-limit checksum manifest', () => {
    // This exceeds the former 4 MiB ceiling while staying just under the
    // 100k archive-entry limit after db + manifest overhead.
    const count = MAX_ARCHIVE_ENTRIES - 1_000;
    const attachments = Array.from({ length: count }, (_, index) => ({
      id: index + 1,
      campaignId: 1,
      path: `1/${index + 1}.bin`,
      size: index,
      mime: 'application/octet-stream',
      hidden: false,
      sha256: 'a'.repeat(64),
    }));
    const manifest = parseBackupManifest({
      ...baseV3,
      uploadCount: count,
      attachments,
      reconciliation: {
        ...baseV3.reconciliation,
        totalAttachments: count,
      },
    });

    const json = serializeBackupManifest(manifest);
    expect(Buffer.byteLength(json)).toBeGreaterThan(4 * 1024 * 1024);
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(MAX_MANIFEST_BYTES);
    expect(parseBackupManifest(JSON.parse(json)).attachments).toHaveLength(count);
  });

  it('rejects manifest byte counts above the shared reader/writer ceiling', () => {
    expect(() => assertBackupManifestBytes(MAX_MANIFEST_BYTES + 1)).toThrow(/manifest exceeds/i);
  });
});

describe('manifestToInspectView', () => {
  it('returns the single native format version without a legacy source field', () => {
    const view = manifestToInspectView(parseBackupManifest(baseV3), []);
    expect(view.formatVersion).toBe(BACKUP_FORMAT_VERSION);
    expect(view).not.toHaveProperty('sourceFormatVersion');
  });

  it('surfaces strict checksum and reconciliation metadata', () => {
    const manifest = parseBackupManifest({
      ...baseV3,
      uploadCount: 1,
      attachments: [{
        id: 1, campaignId: 3, path: '3/1.png', size: 100, mime: 'image/png',
        hidden: false, sha256: 'a'.repeat(64),
      }],
      reconciliation: {
        generation: 'gen-test', totalAttachments: 1, missing: 0, changed: 0,
        orphans: [], orphanCount: 0, clean: true,
      },
    });
    const view = manifestToInspectView(manifest, ['3/1.png']);
    expect(view.attachmentChecksums).toEqual([{ path: '3/1.png', size: 100, sha256: 'a'.repeat(64) }]);
    expect(view.reconciliation).toMatchObject({ generation: 'gen-test', clean: true });
  });
});
