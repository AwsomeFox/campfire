import { describe, it, expect } from '@jest/globals';
import {
  BACKUP_FORMAT_VERSION,
  BACKUP_ORPHAN_LIST_CAP,
  parseBackupManifest,
  type BackupAttachmentRecord,
  type BackupReconciliation,
} from '../../src/modules/backup/backup-manifest';

const attachment: BackupAttachmentRecord = {
  id: 1, campaignId: 42, path: '42/1.png', size: 1024, mime: 'image/png', hidden: false, sha256: 'a'.repeat(64),
};
const base = {
  app: 'campfire', kind: 'server-backup', version: BACKUP_FORMAT_VERSION,
  createdAt: '2026-07-23T10:00:00Z', db: 'db/campfire.db', dbBytes: 4096,
  uploadCount: 0, aiKeySource: 'env', aiKeyIncluded: false, attachments: [],
  reconciliation: { generation: 'g', totalAttachments: 0, missing: 0, changed: 0, orphans: [], orphanCount: 0, clean: true },
};

describe('Backup manifest reconciliation (v3)', () => {
  it('parses a fully reconciled manifest', () => {
    const reconciliation: BackupReconciliation = { generation: 'gen-uuid-abc', totalAttachments: 1, missing: 0, changed: 0, orphans: [], orphanCount: 0, clean: true };
    const manifest = parseBackupManifest({ ...base, uploadCount: 1, attachments: [attachment], reconciliation });
    expect(manifest.attachments).toEqual([attachment]);
    expect(manifest.reconciliation).toEqual(reconciliation);
  });

  it('rejects missing reconciliation or checksum metadata instead of accepting a legacy archive', () => {
    expect(() => parseBackupManifest({ ...base, attachments: undefined })).toThrow(/attachments must be an array/i);
    expect(() => parseBackupManifest({ ...base, reconciliation: undefined })).toThrow(/requires reconciliation metadata/i);
  });

  it('rejects malformed attachment records and duplicate paths', () => {
    expect(() => parseBackupManifest({ ...base, uploadCount: 1, attachments: [{ ...attachment, path: '../outside.jpg' }], reconciliation: { ...base.reconciliation, totalAttachments: 1 } })).toThrow(/attachment record is invalid/i);
    expect(() => parseBackupManifest({ ...base, uploadCount: 2, attachments: [attachment, { ...attachment, id: 2 }], reconciliation: { ...base.reconciliation, totalAttachments: 2 } })).toThrow(/paths must be unique/i);
  });

  it('requires counts, clean flag, and upload count to agree with captured attachments', () => {
    const one = { ...base, uploadCount: 1, attachments: [attachment], reconciliation: { ...base.reconciliation, totalAttachments: 1 } };
    expect(parseBackupManifest(one).reconciliation.clean).toBe(true);
    expect(() => parseBackupManifest({ ...one, uploadCount: 0 })).toThrow(/reconciliation is invalid/i);
    expect(() => parseBackupManifest({ ...one, reconciliation: { ...one.reconciliation, totalAttachments: 2 } })).toThrow(/reconciliation is invalid/i);
    expect(() => parseBackupManifest({ ...one, reconciliation: { ...one.reconciliation, changed: 1, clean: true } })).toThrow(/reconciliation is invalid/i);
    expect(() => parseBackupManifest({ ...one, reconciliation: { ...one.reconciliation, changed: 1, clean: false } })).toThrow(/reconciliation is invalid/i);
  });

  it('accepts missing files recorded by a completed backup, but still rejects changed captures', () => {
    const partial = parseBackupManifest({
      ...base,
      reconciliation: { ...base.reconciliation, totalAttachments: 1, missing: 1, clean: false },
    });
    expect(partial.reconciliation).toMatchObject({ totalAttachments: 1, missing: 1, changed: 0, clean: false });
    expect(() => parseBackupManifest({
      ...base,
      reconciliation: { ...base.reconciliation, totalAttachments: 1, changed: 1, clean: false },
    })).toThrow(/reconciliation is invalid/i);
  });

  it('BACKUP_ORPHAN_LIST_CAP is a positive integer', () => {
    expect(BACKUP_ORPHAN_LIST_CAP).toBeGreaterThan(0);
    expect(Number.isInteger(BACKUP_ORPHAN_LIST_CAP)).toBe(true);
  });
});
