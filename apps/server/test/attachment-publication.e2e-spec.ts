import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { DB_HOLDER, DbHolder } from '../src/db/db.module';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'atomic-dm' };
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108020000009077' +
    '53de0000000c4944415408d763f8ffff3f0005fe02fea1399e1e0000000049454e44ae426082',
  'hex',
);

function injectedFsError(code: 'EACCES' | 'ENOSPC'): NodeJS.ErrnoException {
  return Object.assign(new Error(`injected ${code}`), { code });
}

describe('issue #728: atomic attachment reservation and publication (real SQLite/filesystem)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  async function createCampaign(name: string): Promise<number> {
    const res = await request(ctx.app.getHttpServer()).post('/api/v1/campaigns').set(dm).send({ name });
    expect(res.status).toBe(201);
    return res.body.id as number;
  }

  function rawDb() {
    return ctx.app.get<DbHolder>(DB_HOLDER).raw;
  }

  function rowsFor(campaignId: number): Array<{ id: number; size: number; state: string }> {
    return rawDb()
      .prepare('SELECT id, size, state FROM attachments WHERE campaign_id = ? ORDER BY id')
      .all(campaignId) as Array<{ id: number; size: number; state: string }>;
  }

  function campaignFiles(campaignId: number): string[] {
    const dir = path.join(ctx.dataDir, 'uploads', String(campaignId));
    return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
  }

  async function upload(campaignId: number, filename: string) {
    return request(ctx.app.getHttpServer())
      .post(`/api/v1/campaigns/${campaignId}/attachments`)
      .set(dm)
      .field('kind', 'image')
      .attach('file', TINY_PNG, { filename, contentType: 'image/png' });
  }

  it('admits exactly one of two concurrent uploads at the quota boundary', async () => {
    const campaignId = await createCampaign('Atomic quota boundary');
    const quota = await request(ctx.app.getHttpServer())
      .put(`/api/v1/admin/storage/campaigns/${campaignId}/quota`)
      .set(dm)
      .send({ quotaBytes: TINY_PNG.length });
    expect(quota.status).toBe(200);

    const [a, b] = await Promise.all([upload(campaignId, 'boundary-a.png'), upload(campaignId, 'boundary-b.png')]);
    expect([a.status, b.status].sort()).toEqual([201, 413]);

    expect(rowsFor(campaignId)).toEqual([
      expect.objectContaining({ size: TINY_PNG.length, state: 'committed' }),
    ]);
    expect(campaignFiles(campaignId)).toHaveLength(1);

    const stats = await request(ctx.app.getHttpServer()).get('/api/v1/admin/storage').set(dm);
    const usage = stats.body.campaigns.find((row: { campaignId: number }) => row.campaignId === campaignId);
    expect(usage).toMatchObject({
      committedBytes: TINY_PNG.length,
      reservedBytes: 0,
      fileCount: 1,
      reservedFileCount: 0,
    });
  });

  it.each(['EACCES', 'ENOSPC'] as const)(
    'releases multipart reservations and removes partial artifacts after an injected %s write failure, then retries',
    async (code) => {
      const campaignId = await createCampaign(`Multipart ${code}`);
      const write = jest
        .spyOn(fs, 'writeFileSync')
        .mockImplementationOnce((() => {
          throw injectedFsError(code);
        }) as typeof fs.writeFileSync);

      const failed = await upload(campaignId, `${code.toLowerCase()}.png`);
      write.mockRestore();
      expect(failed.status).toBe(500);
      expect(rowsFor(campaignId)).toEqual([]);
      expect(campaignFiles(campaignId)).toEqual([]);

      const retried = await upload(campaignId, `${code.toLowerCase()}-retry.png`);
      expect(retried.status).toBe(201);
      expect(rowsFor(campaignId)).toEqual([
        expect.objectContaining({ size: TINY_PNG.length, state: 'committed' }),
      ]);
    },
  );

  it('uses the same reservation cleanup protocol for generated attachments', async () => {
    const campaignId = await createCampaign('Generated write failure');
    const write = jest
      .spyOn(fs, 'writeFileSync')
      .mockImplementationOnce((() => {
        throw injectedFsError('ENOSPC');
      }) as typeof fs.writeFileSync);

    const failed = await request(ctx.app.getHttpServer())
      .post(`/api/v1/campaigns/${campaignId}/maps/generate`)
      .set(dm)
      .send({ kind: 'dungeon', seed: 'no-space' });
    write.mockRestore();

    expect(failed.status).toBe(500);
    expect(rowsFor(campaignId)).toEqual([]);
    expect(campaignFiles(campaignId)).toEqual([]);

    const retried = await request(ctx.app.getHttpServer())
      .post(`/api/v1/campaigns/${campaignId}/maps/generate`)
      .set(dm)
      .send({ kind: 'dungeon', seed: 'space-restored' });
    expect(retried.status).toBe(201);
    expect(rowsFor(campaignId)).toEqual([
      expect.objectContaining({ state: 'committed' }),
    ]);
  });

  it('rolls back final bytes and metadata when the transactional audit insert fails, then retries', async () => {
    const campaignId = await createCampaign('Audit failure');
    rawDb().exec(`
      CREATE TRIGGER fail_attachment_upload_audit
      BEFORE INSERT ON audit_log
      WHEN NEW.action = 'attachment.upload'
      BEGIN
        SELECT RAISE(ABORT, 'injected attachment audit failure');
      END;
    `);

    const failed = await upload(campaignId, 'audit-failure.png');
    expect(failed.status).toBe(500);
    expect(rowsFor(campaignId)).toEqual([]);
    expect(campaignFiles(campaignId)).toEqual([]);
    expect(
      rawDb().prepare("SELECT count(*) AS n FROM audit_log WHERE campaign_id = ? AND action = 'attachment.upload'").get(
        campaignId,
      ),
    ).toEqual({ n: 0 });

    rawDb().exec('DROP TRIGGER fail_attachment_upload_audit');
    const retried = await upload(campaignId, 'audit-retry.png');
    expect(retried.status).toBe(201);
    expect(
      rawDb().prepare("SELECT count(*) AS n FROM audit_log WHERE campaign_id = ? AND action = 'attachment.upload'").get(
        campaignId,
      ),
    ).toEqual({ n: 1 });
  });

  it('fsyncs staged bytes and the publication directory before exposing metadata', async () => {
    const campaignId = await createCampaign('Fsync publication');
    const fsync = jest.spyOn(fs, 'fsyncSync');
    const uploaded = await upload(campaignId, 'durable.png');
    const fsyncCalls = fsync.mock.calls.length;
    fsync.mockRestore();

    expect(uploaded.status).toBe(201);
    // Staged-file fsync always runs. Directory fsync is a no-op on win32.
    const minFsync = process.platform === 'win32' ? 1 : 2;
    expect(fsyncCalls).toBeGreaterThanOrEqual(minFsync);
    expect(campaignFiles(campaignId)).toEqual([`${uploaded.body.id}.png`]);
  });

  it('returns the committed updatedAt (not the reservation timestamp) on upload', async () => {
    const campaignId = await createCampaign('Committed response timestamps');
    const uploaded = await upload(campaignId, 'fresh-updated-at.png');
    expect(uploaded.status).toBe(201);

    const dbRow = rawDb()
      .prepare('SELECT state, updated_at AS updatedAt FROM attachments WHERE id = ?')
      .get(uploaded.body.id) as { state: string; updatedAt: string };
    expect(dbRow.state).toBe('committed');
    expect(uploaded.body.updatedAt).toBe(dbRow.updatedAt);

    const listed = await request(ctx.app.getHttpServer())
      .get(`/api/v1/campaigns/${campaignId}/attachments`)
      .set(dm);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([
      expect.objectContaining({ id: uploaded.body.id, updatedAt: uploaded.body.updatedAt }),
    ]);
  });

  it('creates the campaign upload directory safely when mkdir races with an existing path', async () => {
    const campaignId = await createCampaign('Mkdir race');
    const dir = path.join(ctx.dataDir, 'uploads', String(campaignId));
    const realMkdir = fs.mkdirSync.bind(fs);
    const mkdir = jest.spyOn(fs, 'mkdirSync').mockImplementation(((target, options) => {
      // Simulate another request creating the directory between our existence
      // check and mkdir — recursive mkdir must tolerate the already-present path.
      if (target === dir) realMkdir(dir, { recursive: true });
      return realMkdir(target, options as fs.MakeDirectoryOptions | undefined);
    }) as typeof fs.mkdirSync);

    const uploaded = await upload(campaignId, 'mkdir-race.png');
    mkdir.mockRestore();
    expect(uploaded.status).toBe(201);
    expect(campaignFiles(campaignId)).toEqual([`${uploaded.body.id}.png`]);
  });

  it('hides interrupted metadata, reports reserved usage, and rolls staged/final windows back on restart', async () => {
    const campaignId = await createCampaign('Interrupted publication');
    const now = new Date().toISOString();
    const insert = rawDb().prepare(`
      INSERT INTO attachments (
        campaign_id, uploader_user_id, kind, filename, mime, size, hidden, state, created_at, updated_at
      ) VALUES (?, 'dev:atomic-dm', 'image', ?, 'image/png', ?, 1, 'reserved', ?, ?)
    `);
    const stagedId = Number(insert.run(campaignId, 'staged-window.png', TINY_PNG.length, now, now).lastInsertRowid);
    const finalId = Number(insert.run(campaignId, 'renamed-window.png', TINY_PNG.length, now, now).lastInsertRowid);

    const dir = path.join(ctx.dataDir, 'uploads', String(campaignId));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${stagedId}.png.stage`), TINY_PNG);
    fs.writeFileSync(path.join(dir, `${finalId}.png`), TINY_PNG);

    const listBefore = await request(ctx.app.getHttpServer())
      .get(`/api/v1/campaigns/${campaignId}/attachments`)
      .set(dm);
    expect(listBefore.body).toEqual([]);
    expect(
      (await request(ctx.app.getHttpServer()).get(`/api/v1/attachments/${finalId}/file`).set(dm)).status,
    ).toBe(404);

    const statsBefore = await request(ctx.app.getHttpServer()).get('/api/v1/admin/storage').set(dm);
    const beforeUsage = statsBefore.body.campaigns.find(
      (row: { campaignId: number }) => row.campaignId === campaignId,
    );
    expect(beforeUsage).toMatchObject({
      committedBytes: 0,
      reservedBytes: TINY_PNG.length * 2,
      fileCount: 0,
      reservedFileCount: 2,
    });

    const dataDir = ctx.dataDir;
    await ctx.app.close();
    ctx = await createTestApp({ dataDir });

    expect(rowsFor(campaignId)).toEqual([]);
    expect(campaignFiles(campaignId)).toEqual([]);
    const statsAfter = await request(ctx.app.getHttpServer()).get('/api/v1/admin/storage').set(dm);
    const afterUsage = statsAfter.body.campaigns.find(
      (row: { campaignId: number }) => row.campaignId === campaignId,
    );
    expect(afterUsage).toMatchObject({ committedBytes: 0, reservedBytes: 0, reservedFileCount: 0 });

    const retried = await upload(campaignId, 'after-recovery.png');
    expect(retried.status).toBe(201);
  });

  it('does not scan every upload directory for dangling stages when no reservations remain', async () => {
    const campaignId = await createCampaign('Skip dangling scan');
    const uploaded = await upload(campaignId, 'committed-only.png');
    expect(uploaded.status).toBe(201);

    const { AttachmentsService } = await import('../src/modules/attachments/attachments.service');
    const service = ctx.app.get(AttachmentsService);
    const readdir = jest.spyOn(fs, 'readdirSync');
    const recovered = service.recoverPendingPublications();
    const scannedUploadsRoot = readdir.mock.calls.some(
      ([target]) => typeof target === 'string' && target === path.join(ctx.dataDir, 'uploads'),
    );
    readdir.mockRestore();

    expect(recovered).toBe(0);
    expect(scannedUploadsRoot).toBe(false);
    expect(campaignFiles(campaignId)).toEqual([`${uploaded.body.id}.png`]);
  });

  it('scopes non-restore dangling stage scans to campaigns with reservations', async () => {
    const withReservation = await createCampaign('Scoped scan reserved');
    const untouched = await createCampaign('Scoped scan untouched');
    const now = new Date().toISOString();
    const reservedId = Number(
      rawDb()
        .prepare(`
          INSERT INTO attachments (
            campaign_id, uploader_user_id, kind, filename, mime, size, hidden, state, created_at, updated_at
          ) VALUES (?, 'dev:atomic-dm', 'image', 'scoped.png', 'image/png', ?, 1, 'reserved', ?, ?)
        `)
        .run(withReservation, TINY_PNG.length, now, now).lastInsertRowid,
    );
    const reservedDir = path.join(ctx.dataDir, 'uploads', String(withReservation));
    const untouchedDir = path.join(ctx.dataDir, 'uploads', String(untouched));
    fs.mkdirSync(reservedDir, { recursive: true });
    fs.mkdirSync(untouchedDir, { recursive: true });
    fs.writeFileSync(path.join(reservedDir, `${reservedId}.png.stage`), TINY_PNG);
    fs.writeFileSync(path.join(untouchedDir, '999999.png.stage'), TINY_PNG);

    const { AttachmentsService } = await import('../src/modules/attachments/attachments.service');
    const service = ctx.app.get(AttachmentsService);
    const readdir = jest.spyOn(fs, 'readdirSync');
    const recovered = service.recoverPendingPublications();
    const scannedUntouched = readdir.mock.calls.some(
      ([target]) => typeof target === 'string' && target === untouchedDir,
    );
    readdir.mockRestore();

    expect(recovered).toBe(1);
    expect(scannedUntouched).toBe(false);
    expect(campaignFiles(withReservation)).toEqual([]);
    // Untouched campaign stage is outside the scoped scan and remains.
    expect(campaignFiles(untouched)).toEqual(['999999.png.stage']);
  });

  it('restore-style scrub removes orphan stages but preserves in-flight reserved stages', async () => {
    const campaignId = await createCampaign('Restore scrub safety');
    const now = new Date().toISOString();
    const insert = rawDb().prepare(`
      INSERT INTO attachments (
        campaign_id, uploader_user_id, kind, filename, mime, size, hidden, state, created_at, updated_at
      ) VALUES (?, 'dev:atomic-dm', 'image', ?, 'image/png', ?, 1, 'reserved', ?, ?)
    `);
    const liveId = Number(insert.run(campaignId, 'live.png', TINY_PNG.length, now, now).lastInsertRowid);
    const orphanId = liveId + 1000;
    const dir = path.join(ctx.dataDir, 'uploads', String(campaignId));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${liveId}.png.stage`), TINY_PNG);
    fs.writeFileSync(path.join(dir, `${orphanId}.png.stage`), TINY_PNG);

    const { AttachmentsService } = await import('../src/modules/attachments/attachments.service');
    const service = ctx.app.get(AttachmentsService);
    // Simulate a reservation that could not be rolled back (keep the reserved row)
    // while still asking for a full-root scrub as restore does.
    const rollback = jest
      .spyOn(
        service as unknown as { rollbackReservation: (row: unknown) => void },
        'rollbackReservation',
      )
      .mockImplementation(() => {
        throw new Error('injected rollback failure');
      });
    const error = jest.spyOn(
      (service as unknown as { logger: { error: (...args: unknown[]) => void } }).logger,
      'error',
    );

    const recovered = service.recoverPendingPublications({ scrubDanglingStages: true });
    rollback.mockRestore();
    error.mockRestore();

    expect(recovered).toBe(0);
    expect(campaignFiles(campaignId).sort()).toEqual([`${liveId}.png.stage`]);
    expect(rowsFor(campaignId)).toEqual([expect.objectContaining({ id: liveId, state: 'reserved' })]);
  });

  it('does not retain a stray stage just because the same id is reserved in another campaign', async () => {
    const reservedCampaign = await createCampaign('Cross-campaign reserved');
    const strayCampaign = await createCampaign('Cross-campaign stray');
    const now = new Date().toISOString();
    const reservedId = Number(
      rawDb()
        .prepare(`
          INSERT INTO attachments (
            campaign_id, uploader_user_id, kind, filename, mime, size, hidden, state, created_at, updated_at
          ) VALUES (?, 'dev:atomic-dm', 'image', 'live.png', 'image/png', ?, 1, 'reserved', ?, ?)
        `)
        .run(reservedCampaign, TINY_PNG.length, now, now).lastInsertRowid,
    );
    const reservedDir = path.join(ctx.dataDir, 'uploads', String(reservedCampaign));
    const strayDir = path.join(ctx.dataDir, 'uploads', String(strayCampaign));
    fs.mkdirSync(reservedDir, { recursive: true });
    fs.mkdirSync(strayDir, { recursive: true });
    fs.writeFileSync(path.join(reservedDir, `${reservedId}.png.stage`), TINY_PNG);
    fs.writeFileSync(path.join(strayDir, `${reservedId}.png.stage`), TINY_PNG);

    const { AttachmentsService } = await import('../src/modules/attachments/attachments.service');
    const service = ctx.app.get(AttachmentsService);
    const rollback = jest
      .spyOn(
        service as unknown as { rollbackReservation: (row: unknown) => void },
        'rollbackReservation',
      )
      .mockImplementation(() => {
        throw new Error('injected rollback failure');
      });
    const error = jest.spyOn(
      (service as unknown as { logger: { error: (...args: unknown[]) => void } }).logger,
      'error',
    );

    service.recoverPendingPublications({ scrubDanglingStages: true });
    rollback.mockRestore();
    error.mockRestore();

    expect(campaignFiles(reservedCampaign)).toEqual([`${reservedId}.png.stage`]);
    expect(campaignFiles(strayCampaign)).toEqual([]);
  });

  it('continues bootstrap when publication recovery throws a top-level filesystem error', async () => {
    const { AttachmentsService } = await import('../src/modules/attachments/attachments.service');
    const service = ctx.app.get(AttachmentsService);
    const recover = jest.spyOn(service, 'recoverPendingPublications').mockImplementation(() => {
      throw injectedFsError('EACCES');
    });
    const error = jest.spyOn((service as unknown as { logger: { error: (...args: unknown[]) => void } }).logger, 'error');

    expect(() => service.onApplicationBootstrap()).not.toThrow();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Attachment publication recovery failed during startup'));
    recover.mockRestore();
    error.mockRestore();
  });

  it('does not delete a restored committed file when publication rollback races with DB reopen', async () => {
    const campaignId = await createCampaign('Rollback restore race');
    const uploaded = await upload(campaignId, 'committed-restored.png');
    expect(uploaded.status).toBe(201);
    const id = uploaded.body.id as number;
    const finalPath = path.join(ctx.dataDir, 'uploads', String(campaignId), `${id}.png`);
    expect(fs.existsSync(finalPath)).toBe(true);

    const { AttachmentsService } = await import('../src/modules/attachments/attachments.service');
    const service = ctx.app.get(AttachmentsService);
    const warn = jest.spyOn(
      (service as unknown as { logger: { warn: (...args: unknown[]) => void } }).logger,
      'warn',
    );

    // Simulate createAndPublish's catch path after a restore replaced the reserved
    // row with a committed attachment at the same id.
    (
      service as unknown as {
        rollbackReservation: (row: { id: number; campaignId: number; mime: string }) => void;
      }
    ).rollbackReservation({ id, campaignId, mime: 'image/png' });

    expect(fs.existsSync(finalPath)).toBe(true);
    expect(rowsFor(campaignId)).toEqual([expect.objectContaining({ id, state: 'committed' })]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`Skipping attachment reservation rollback for ${id}`),
    );
    warn.mockRestore();
  });
});
