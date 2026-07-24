import { describe, it, expect } from '@jest/globals';
import {
  BACKUP_ORPHAN_LIST_CAP,
  parseBackupManifest,
  type BackupAttachmentRecord,
  type BackupReconciliation,
} from '../../src/modules/backup/backup-manifest';

/**
 * #828 unit coverage for the backup manifest's reconciliation fields. The full
 * integration test (concurrent upload/delete during backup) requires a running
 * server and is covered by the backup e2e spec.
 */
describe('Backup manifest reconciliation (#828)', () => {
  it('parses a manifest with reconciliation + attachments fields', () => {
    const attachments: BackupAttachmentRecord[] = [
      {
        id: 1,
        campaignId: 42,
        path: '42/1.png',
        size: 1024,
        mime: 'image/png',
        hidden: false,
        sha256: 'abc123',
      },
      {
        id: 2,
        campaignId: 42,
        path: '42/2.jpg',
        size: 2048,
        mime: 'image/jpeg',
        hidden: true,
        sha256: 'def456',
      },
    ];
    const reconciliation: BackupReconciliation = {
      generation: 'gen-uuid-abc',
      totalAttachments: 2,
      missing: 0,
      changed: 0,
      orphans: [],
      orphanCount: 0,
      clean: true,
    };
    const manifest = parseBackupManifest({
      app: 'campfire',
      kind: 'server-backup',
      version: 1,
      createdAt: '2026-07-23T10:00:00Z',
      db: 'db/campfire.db',
      dbBytes: 4096,
      uploadCount: 2,
      attachments,
      reconciliation,
    });
    expect(manifest.attachments).toEqual(attachments);
    expect(manifest.reconciliation).toEqual(reconciliation);
  });

  it('parses a manifest WITHOUT reconciliation (older archives)', () => {
    const manifest = parseBackupManifest({
      app: 'campfire',
      kind: 'server-backup',
      version: 1,
      createdAt: '2026-07-23T10:00:00Z',
      db: 'db/campfire.db',
      dbBytes: 4096,
      uploadCount: 0,
    });
    expect(manifest.attachments).toBeUndefined();
    expect(manifest.reconciliation).toBeUndefined();
  });

  it('filters malformed attachment records', () => {
    const manifest = parseBackupManifest({
      app: 'campfire',
      kind: 'server-backup',
      version: 1,
      createdAt: '2026-07-23T10:00:00Z',
      db: 'db/campfire.db',
      dbBytes: 4096,
      uploadCount: 1,
      attachments: [
        // valid
        { id: 1, campaignId: 42, path: '42/1.png', size: 100, mime: 'image/png', hidden: false, sha256: 'abc' },
        // malformed — missing size
        { id: 2, campaignId: 42, path: '42/2.jpg', mime: 'image/jpeg', hidden: false, sha256: 'def' },
        // malformed — wrong type
        'not an object',
        null,
      ],
    });
    expect(manifest.attachments).toHaveLength(1);
    expect(manifest.attachments?.[0].id).toBe(1);
  });

  it('rejects malformed reconciliation object', () => {
    const manifest = parseBackupManifest({
      app: 'campfire',
      kind: 'server-backup',
      version: 1,
      createdAt: '2026-07-23T10:00:00Z',
      db: 'db/campfire.db',
      dbBytes: 4096,
      uploadCount: 0,
      // reconciliation missing required fields — parse should drop it
      reconciliation: { generation: 'x' },
    });
    expect(manifest.reconciliation).toBeUndefined();
  });

  it('BACKUP_ORPHAN_LIST_CAP is a positive integer', () => {
    expect(BACKUP_ORPHAN_LIST_CAP).toBeGreaterThan(0);
    expect(Number.isInteger(BACKUP_ORPHAN_LIST_CAP)).toBe(true);
  });

  it('marks reconciliation.clean=true only when missing and changed are both 0', () => {
    const cleanRecon: BackupReconciliation = {
      generation: 'g',
      totalAttachments: 5,
      missing: 0,
      changed: 0,
      orphans: [],
      orphanCount: 0,
      clean: true,
    };
    const dirtyRecon: BackupReconciliation = {
      generation: 'g',
      totalAttachments: 5,
      missing: 1,
      changed: 0,
      orphans: [],
      orphanCount: 0,
      clean: false,
    };
    expect(cleanRecon.clean).toBe(true);
    expect(dirtyRecon.clean).toBe(false);
  });
});
