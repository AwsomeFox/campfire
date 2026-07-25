import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DbHolder, type DrizzleDb } from '../../src/db/db.module';
import { SettingsService } from '../../src/modules/settings/settings.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { BackupService, RESTORE_CONFIRM_TOKEN } from '../../src/modules/backup/backup.service';
import { AiProviderConfigService } from '../../src/modules/ai-provider-config/ai-provider-config.service';
import { AttachmentsService } from '../../src/modules/attachments/attachments.service';
import { FsDeletionService } from '../../src/modules/attachments/fs-deletion.service';
import {
  __setRestoreApplyFaultInjector,
  type RestoreApplyFaultPoint,
} from '../../src/modules/backup/backup-restore-apply';
import type { RequestUser } from '../../src/common/user.types';

/**
 * Issue #497 — whole-server restore must stage + validate first, then atomically
 * swap DB/uploads with a retained rollback snapshot. Fault injection at every I/O
 * boundary must leave the live instance intact (automatic rollback).
 */

const PASSPHRASE = 'correct-horse-battery-staple';
const LIVE_KEY = 'cafebabe'.repeat(8);
const ARCHIVE_KEY = 'feedface'.repeat(8);

const testUser: RequestUser = {
  id: '1',
  name: 'admin',
  serverRole: 'admin',
};

const MARKER_CAMPAIGN = 'restore-atomicity-marker-campaign';
const ARCHIVE_CAMPAIGN = 'restore-atomicity-archive-campaign';

describe('backup restore atomicity (#497, real SQLite + filesystem)', () => {
  let dataDir: string;
  let holder: DbHolder;
  let prevDataDir: string | undefined;

  beforeEach(() => {
    prevDataDir = process.env.DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-restore-atomic-'));
    process.env.DATA_DIR = dataDir;
    delete process.env.AI_CONFIG_KEY;
    holder = new DbHolder();
    seedLiveState();
  });

  afterEach(() => {
    __setRestoreApplyFaultInjector(null);
    holder?.onApplicationShutdown();
    if (prevDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prevDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function seedLiveState(): void {
    const now = new Date().toISOString();
    holder.raw
      .prepare('INSERT INTO campaigns (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(1, MARKER_CAMPAIGN, now, now);
    fs.writeFileSync(path.join(dataDir, 'ai-config.key'), LIVE_KEY, { mode: 0o600 });
  }

  function liveMarkerCampaign(): string | undefined {
    const row = holder.raw
      .prepare('SELECT name FROM campaigns WHERE id = 1')
      .get() as { name: string } | undefined;
    return row?.name;
  }

  function liveKeyfile(): string {
    return fs.readFileSync(path.join(dataDir, 'ai-config.key'), 'utf8').trim();
  }

  function makeService(): BackupService {
    const db = holder.proxy as DrizzleDb;
    const audit = new AuditService(db);
    const aiProviderConfig = { invalidateCachedKey: jest.fn() } as unknown as AiProviderConfigService;
    return new BackupService(
      holder,
      audit,
      new SettingsService(db),
      new AttachmentsService(db, audit, new FsDeletionService(db, audit)),
      aiProviderConfig,
    );
  }

  async function buildAlternateArchive(): Promise<Buffer> {
    holder.raw.prepare('UPDATE campaigns SET name = ? WHERE id = 1').run(ARCHIVE_CAMPAIGN);
    fs.writeFileSync(path.join(dataDir, 'ai-config.key'), ARCHIVE_KEY, { mode: 0o600 });
    const archive = await makeService().buildBackup({ keyPassphrase: PASSPHRASE });
    holder.raw.prepare('UPDATE campaigns SET name = ? WHERE id = 1').run(MARKER_CAMPAIGN);
    fs.writeFileSync(path.join(dataDir, 'ai-config.key'), LIVE_KEY, { mode: 0o600 });
    return archive;
  }

  async function restoreArchive(
    service: BackupService,
    archive: Buffer,
    options?: { onProgress?: (phase: string) => void },
  ) {
    return service.restore(archive, RESTORE_CONFIRM_TOKEN, testUser, {
      keyPassphrase: PASSPHRASE,
      ...options,
    });
  }

  it('restores successfully and reports progress phases', async () => {
    const service = makeService();
    const archive = await buildAlternateArchive();
    const phases: string[] = [];
    const result = await restoreArchive(service, archive, {
      onProgress: (phase) => phases.push(phase),
    });
    expect(result.ok).toBe(true);
    expect(result.phases).toContain('cleanup');
    expect(phases).toContain('swapping-database');
    expect(liveMarkerCampaign()).toBe(ARCHIVE_CAMPAIGN);
    expect(liveKeyfile()).toBe(ARCHIVE_KEY);
  });

  const faultPoints: RestoreApplyFaultPoint[] = [
    'after-rollback-snapshot',
    'after-stage-incoming-db',
    'after-stage-incoming-uploads',
    'after-db-swap',
    'after-uploads-swap',
    'after-keyfile-swap',
    'during-health-check',
  ];

  it.each(faultPoints)(
    'rolls back automatically when apply fails at %s',
    async (point) => {
      const service = makeService();
      const archive = await buildAlternateArchive();
      __setRestoreApplyFaultInjector((p) => {
        if (p === point) throw new Error(`injected restore failure at ${p}`);
      });

      await expect(restoreArchive(service, archive)).rejects.toThrow(
        `injected restore failure at ${point}`,
      );

      expect(liveMarkerCampaign()).toBe(MARKER_CAMPAIGN);
      expect(liveKeyfile()).toBe(LIVE_KEY);
    },
  );
});
