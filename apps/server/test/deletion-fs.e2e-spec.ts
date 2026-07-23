import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { closeTestApp, createTestApp, type TestAppContext } from './test-app';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function restoreDirMode(dir: string): void {
  try {
    fs.chmodSync(dir, 0o755);
  } catch {
    /* ignore — dir may already be gone */
  }
}

/**
 * Issue #727 — permanent deletion must not claim erasure when filesystem cleanup failed.
 */
describe('permanent deletion filesystem cleanup (issue #727, e2e)', () => {
  let ctx: TestAppContext;
  let campaignId: number;
  const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'fs-del-dm' };
  const admin = { 'x-dev-role': 'admin', 'x-dev-user': 'fs-del-admin' };

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    const camp = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'FS deletion camp' });
    expect(camp.status).toBe(201);
    campaignId = camp.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('attachment delete returns filesPending when the upload directory is not writable (EACCES)', async () => {
    if (process.getuid && process.getuid() === 0) {
      // eslint-disable-next-line no-console
      console.warn('skipping EACCES attachment delete test under root');
      return;
    }

    const server = ctx.app.getHttpServer();
    const up = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/attachments`)
      .set(dm)
      .field('kind', 'image')
      .attach('file', TINY_PNG, { filename: 'locked.png', contentType: 'image/png' });
    expect(up.status).toBe(201);
    const id = up.body.id;
    const uploadDir = path.join(ctx.dataDir, 'uploads', String(campaignId));
    const diskPath = path.join(uploadDir, `${id}.png`);
    expect(fs.existsSync(diskPath)).toBe(true);

    fs.chmodSync(uploadDir, 0o555);
    try {
      const del = await request(server).delete(`/api/v1/attachments/${id}`).set(dm);
      expect(del.status).toBe(200);
      expect(del.body.filesPending).toBe(true);
      expect(fs.existsSync(diskPath)).toBe(true);

      const storage = await request(server).get('/api/v1/admin/storage').set(admin);
      expect(storage.status).toBe(200);
      expect(storage.body.fsCleanup.pendingCount + storage.body.fsCleanup.failedCount).toBeGreaterThan(0);
    } finally {
      restoreDirMode(uploadDir);
      fs.rmSync(diskPath, { force: true });
    }
  });

  it('campaign purge returns filesPending when the upload directory cannot be removed', async () => {
    if (process.getuid && process.getuid() === 0) {
      // eslint-disable-next-line no-console
      console.warn('skipping EACCES campaign purge test under root');
      return;
    }

    const server = ctx.app.getHttpServer();
    const camp = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Purge locked dir' });
    expect(camp.status).toBe(201);
    const id = camp.body.id;
    const uploadDir = path.join(ctx.dataDir, 'uploads', String(id));
    fs.mkdirSync(uploadDir, { recursive: true });
    fs.writeFileSync(path.join(uploadDir, 'keep.bin'), 'x');

    await request(server).delete(`/api/v1/campaigns/${id}`).set(dm);
    fs.chmodSync(uploadDir, 0o555);
    try {
      const purge = await request(server).delete(`/api/v1/campaigns/${id}/purge`).set(dm);
      expect(purge.status).toBe(200);
      expect(purge.body.filesPending).toBe(true);
      expect(fs.existsSync(uploadDir)).toBe(true);
    } finally {
      restoreDirMode(uploadDir);
      fs.rmSync(uploadDir, { recursive: true, force: true });
    }
  });

  it('retry sweep clears the queue once the volume is writable again', async () => {
    if (process.getuid && process.getuid() === 0) {
      return;
    }

    const server = ctx.app.getHttpServer();
    const camp = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Retry sweep' });
    const cid = camp.body.id;
    const uploadDir = path.join(ctx.dataDir, 'uploads', String(cid));
    const up = await request(server)
      .post(`/api/v1/campaigns/${cid}/attachments`)
      .set(dm)
      .field('kind', 'image')
      .attach('file', TINY_PNG, { filename: 'retry.png', contentType: 'image/png' });
    const attId = up.body.id;
    const diskPath = path.join(uploadDir, `${attId}.png`);

    fs.chmodSync(uploadDir, 0o555);
    await request(server).delete(`/api/v1/attachments/${attId}`).set(dm);
    restoreDirMode(uploadDir);

    const retry = await request(server).post('/api/v1/admin/storage/fs-cleanup/retry').set(admin);
    expect(retry.status).toBe(201);
    expect(retry.body.cleared).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(diskPath)).toBe(false);
  });
});
