import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DbHolder, type DrizzleDb } from '../../src/db/db.module';
import { AuditService } from '../../src/modules/audit/audit.service';
import { UsersService } from '../../src/modules/users/users.service';
import { RosterImportService } from '../../src/modules/users/roster-import.service';
import type { RequestUser } from '../../src/common/user.types';
import type { RosterImportPreview } from '@campfire/schema';

describe('RosterImportService unit coverage tests', () => {
  let dataDir: string;
  let holder: DbHolder;
  let previousDataDir: string | undefined;
  let db: DrizzleDb;
  let rosterImportService: RosterImportService;

  const adminActor: RequestUser = {
    id: '1',
    name: 'Admin',
    serverRole: 'admin',
  };

  beforeEach(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-roster-unit-'));
    process.env.DATA_DIR = dataDir;
    holder = new DbHolder();
    db = holder.proxy as DrizzleDb;
    const audit = new AuditService(db);
    const usersService = new UsersService(db, audit);

    rosterImportService = new RosterImportService(db, audit, usersService);
  });

  afterEach(() => {
    holder.onApplicationShutdown();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('runs dry run and commit for roster imports', async () => {
    const csvContent = 'username,displayName\nuser_alice,Alice Smith\nuser_bob,Bob Jones';

    const preview = (await rosterImportService.run(
      {
        format: 'csv',
        content: csvContent,
        dryRun: true,
        activationExpiresInDays: 7,
      },
      adminActor,
    )) as RosterImportPreview;
    expect(preview.dryRun).toBe(true);

    const result = await rosterImportService.run(
      {
        format: 'csv',
        content: csvContent,
        dryRun: false,
        activationExpiresInDays: 7,
        batchId: preview.batchId,
        rows: (preview as any).commitRows,
      },
      adminActor,
    );
    expect(result).toBeDefined();
  });
});
