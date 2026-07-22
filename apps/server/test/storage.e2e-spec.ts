import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';

/**
 * Issue #24 — Server-admin storage management.
 *
 * GET /admin/storage, PUT /admin/storage/campaigns/:id/quota, and POST
 * /admin/storage/cleanup are server-admin only (@ServerRoles('admin')). These
 * tests pin the gating (admin vs non-admin vs scope-capped PAT), the stats shape,
 * per-campaign quota enforcement on upload (413), and orphan detection + cleanup
 * (rows-without-file and files-without-row).
 */

// Minimal valid 1x1 PNG (same fixture the attachments suite uses).
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108020000009077' +
    '53de0000000c4944415408d763f8ffff3f0005fe02fea1399e1e0000000049454e44ae426082',
  'hex',
);

describe('Issue #24: admin storage management (e2e)', () => {
  let ctx: TestAppContext;
  let adminAgent: ReturnType<typeof request.agent>;
  let userAgent: ReturnType<typeof request.agent>;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    // First user via setup -> the server admin (also treated as dm on their own campaigns).
    adminAgent = request.agent(server);
    await adminAgent.post('/api/v1/auth/setup').send({ username: 'store-admin', password: 'admin-password-1' });

    // An ordinary (non-admin) user.
    await adminAgent.post('/api/v1/users').send({ username: 'store-user', password: 'user-password-1', serverRole: 'user' });
    userAgent = request.agent(server);
    await userAgent.post('/api/v1/auth/login').send({ username: 'store-user', password: 'user-password-1' });

    const campRes = await adminAgent.post('/api/v1/campaigns').send({ name: 'Storage Test Table' });
    expect(campRes.status).toBe(201);
    campaignId = campRes.body.id;

    // Seed one attachment so stats have something to report.
    const up = await adminAgent
      .post(`/api/v1/campaigns/${campaignId}/attachments`)
      .field('kind', 'map')
      .attach('file', TINY_PNG, { filename: 'seed.png', contentType: 'image/png' });
    expect(up.status).toBe(201);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  describe('gating', () => {
    it('unauthenticated -> 401', async () => {
      const res = await request(ctx.app.getHttpServer()).get('/api/v1/admin/storage');
      expect(res.status).toBe(401);
    });

    it('non-admin user -> 403', async () => {
      const res = await userAgent.get('/api/v1/admin/storage');
      expect(res.status).toBe(403);
    });

    it('server admin -> 200', async () => {
      const res = await adminAgent.get('/api/v1/admin/storage');
      expect(res.status).toBe(200);
    });

    it('a scope-capped (non-adminEnabled) PAT -> 403; an adminEnabled PAT -> 200', async () => {
      const server = ctx.app.getHttpServer();

      const capped = await adminAgent.post('/api/v1/tokens').send({ name: 'capped', scope: 'dm' });
      expect(capped.status).toBe(201);
      const cappedRes = await request(server).get('/api/v1/admin/storage').set('Authorization', `Bearer ${capped.body.token}`);
      expect(cappedRes.status).toBe(403);

      const admin = await adminAgent.post('/api/v1/tokens').send({ name: 'admin-enabled', scope: 'dm', adminEnabled: true });
      expect(admin.status).toBe(201);
      const adminRes = await request(server).get('/api/v1/admin/storage').set('Authorization', `Bearer ${admin.body.token}`);
      expect(adminRes.status).toBe(200);
    });
  });

  describe('stats shape', () => {
    it('returns totals, per-campaign breakdown, disk bytes, and an orphan summary', async () => {
      const res = await adminAgent.get('/api/v1/admin/storage');
      expect(res.status).toBe(200);
      const body = res.body;

      expect(typeof body.totalBytes).toBe('number');
      expect(body.totalBytes).toBeGreaterThanOrEqual(TINY_PNG.length);
      expect(typeof body.fileCount).toBe('number');
      expect(body.fileCount).toBeGreaterThanOrEqual(1);
      expect(typeof body.diskBytes).toBe('number');
      expect(body.diskBytes).toBeGreaterThanOrEqual(TINY_PNG.length);

      expect(Array.isArray(body.campaigns)).toBe(true);
      const mine = body.campaigns.find((c: { campaignId: number }) => c.campaignId === campaignId);
      expect(mine).toBeDefined();
      expect(mine.name).toBe('Storage Test Table');
      expect(mine.fileCount).toBeGreaterThanOrEqual(1);
      expect(mine.totalBytes).toBeGreaterThanOrEqual(TINY_PNG.length);
      expect(mine.quotaBytes).toBeNull();
      expect(mine.overQuota).toBe(false);

      expect(body.orphans).toBeDefined();
      expect(typeof body.orphans.rowsWithoutFile).toBe('number');
      expect(typeof body.orphans.filesWithoutRow).toBe('number');
      expect(typeof body.orphans.orphanBytes).toBe('number');
    });
  });

  describe('per-campaign quota enforcement', () => {
    let quotaCampaignId: number;

    beforeAll(async () => {
      const res = await adminAgent.post('/api/v1/campaigns').send({ name: 'Quota Campaign' });
      quotaCampaignId = res.body.id;
    });

    it('setting a quota below the incoming file size rejects the upload (413)', async () => {
      const server = ctx.app.getHttpServer();

      const setRes = await adminAgent.put(`/api/v1/admin/storage/campaigns/${quotaCampaignId}/quota`).send({ quotaBytes: 10 });
      expect(setRes.status).toBe(200);
      expect(setRes.body.quotaBytes).toBe(10);

      // GET /campaigns/:id reflects the quota (contract carries storageQuotaBytes).
      const camp = await adminAgent.get(`/api/v1/campaigns/${quotaCampaignId}`);
      expect(camp.body.storageQuotaBytes).toBe(10);

      const up = await adminAgent
        .post(`/api/v1/campaigns/${quotaCampaignId}/attachments`)
        .field('kind', 'map')
        .attach('file', TINY_PNG, { filename: 'over.png', contentType: 'image/png' });
      expect(up.status).toBe(413);
    });

    it('a quota with room admits the upload (201)', async () => {
      const setRes = await adminAgent
        .put(`/api/v1/admin/storage/campaigns/${quotaCampaignId}/quota`)
        .send({ quotaBytes: 5 * 1024 * 1024 });
      expect(setRes.status).toBe(200);

      const up = await adminAgent
        .post(`/api/v1/campaigns/${quotaCampaignId}/attachments`)
        .field('kind', 'map')
        .attach('file', TINY_PNG, { filename: 'fits.png', contentType: 'image/png' });
      expect(up.status).toBe(201);

      const stats = await adminAgent.get('/api/v1/admin/storage');
      const row = stats.body.campaigns.find((c: { campaignId: number }) => c.campaignId === quotaCampaignId);
      expect(row.quotaBytes).toBe(5 * 1024 * 1024);
      expect(row.overQuota).toBe(false);
    });

    it('clearing the quota (null) lifts the cap', async () => {
      const setRes = await adminAgent.put(`/api/v1/admin/storage/campaigns/${quotaCampaignId}/quota`).send({ quotaBytes: null });
      expect(setRes.status).toBe(200);
      expect(setRes.body.quotaBytes).toBeNull();

      const camp = await adminAgent.get(`/api/v1/campaigns/${quotaCampaignId}`);
      expect(camp.body.storageQuotaBytes).toBeNull();
    });

    it('setting a quota on a nonexistent campaign -> 404', async () => {
      const res = await adminAgent.put('/api/v1/admin/storage/campaigns/999999/quota').send({ quotaBytes: 100 });
      expect(res.status).toBe(404);
    });
  });

  describe('orphan cleanup', () => {
    it('detects and cleans a row-without-file (bytes deleted from disk under the row)', async () => {
      const server = ctx.app.getHttpServer();
      const up = await adminAgent
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .field('kind', 'image')
        .attach('file', TINY_PNG, { filename: 'willorphan.png', contentType: 'image/png' });
      const orphanId = up.body.id;

      const diskPath = path.join(ctx.dataDir, 'uploads', String(campaignId), `${orphanId}.png`);
      expect(fs.existsSync(diskPath)).toBe(true);
      fs.rmSync(diskPath); // manufacture a row-without-file

      // Dry-run reports it but deletes nothing.
      const dry = await adminAgent.post('/api/v1/admin/storage/cleanup?dryRun=true');
      expect(dry.status).toBe(201);
      expect(dry.body.dryRun).toBe(true);
      expect(dry.body.rowsWithoutFile).toBeGreaterThanOrEqual(1);
      expect(dry.body.rowsDeleted).toBe(0);

      // The row is still fetchable-as-metadata (404 on file, row present) before cleanup.
      const beforeList = await adminAgent.get(`/api/v1/campaigns/${campaignId}/attachments`);
      expect(beforeList.body.some((a: { id: number }) => a.id === orphanId)).toBe(true);

      // Real cleanup removes the row.
      const run = await adminAgent.post('/api/v1/admin/storage/cleanup');
      expect(run.status).toBe(201);
      expect(run.body.dryRun).toBe(false);
      expect(run.body.rowsDeleted).toBeGreaterThanOrEqual(1);

      const afterList = await adminAgent.get(`/api/v1/campaigns/${campaignId}/attachments`);
      expect(afterList.body.some((a: { id: number }) => a.id === orphanId)).toBe(false);
    });

    it('detects and cleans a file-without-row', async () => {
      const dir = path.join(ctx.dataDir, 'uploads', String(campaignId));
      fs.mkdirSync(dir, { recursive: true });
      const strayPath = path.join(dir, '9999999.png'); // no attachment row has this id
      fs.writeFileSync(strayPath, TINY_PNG);

      const dry = await adminAgent.post('/api/v1/admin/storage/cleanup?dryRun=true');
      expect(dry.body.filesWithoutRow).toBeGreaterThanOrEqual(1);
      expect(fs.existsSync(strayPath)).toBe(true); // dry-run left it in place

      const run = await adminAgent.post('/api/v1/admin/storage/cleanup');
      expect(run.body.filesDeleted).toBeGreaterThanOrEqual(1);
      expect(run.body.bytesReclaimed).toBeGreaterThanOrEqual(TINY_PNG.length);
      expect(fs.existsSync(strayPath)).toBe(false); // gone
    });

    // Issue #695 — orphan cleanup must clear encounter.mapAttachmentId references for
    // the orphan rows it drops, mirroring remove(). Otherwise the encounter keeps
    // pointing at a deleted row and renders a broken battle map.
    it('clears encounter.mapAttachmentId when cleaning an orphaned battle map row', async () => {
      const server = ctx.app.getHttpServer();
      const up = await adminAgent
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .field('kind', 'map')
        .attach('file', TINY_PNG, { filename: 'orphan-encounter-map.png', contentType: 'image/png' });
      const orphanId = up.body.id;

      const enc = await adminAgent.post(`/api/v1/campaigns/${campaignId}/encounters`).send({ name: 'Orphan Cleanup Fight' });
      const encounterId = enc.body.id;
      const patch = await adminAgent.patch(`/api/v1/encounters/${encounterId}`).send({ mapAttachmentId: orphanId });
      expect(patch.body.mapAttachmentId).toBe(orphanId);

      // Manufacture a row-without-file so cleanupOrphans targets it.
      const diskPath = path.join(ctx.dataDir, 'uploads', String(campaignId), `${orphanId}.png`);
      expect(fs.existsSync(diskPath)).toBe(true);
      fs.rmSync(diskPath);

      const run = await adminAgent.post('/api/v1/admin/storage/cleanup');
      expect(run.status).toBe(201);
      expect(run.body.rowsDeleted).toBeGreaterThanOrEqual(1);

      const getRes = await adminAgent.get(`/api/v1/encounters/${encounterId}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.mapAttachmentId).toBeNull();
    });
  });

  // Issue #722 — FAIL CLOSED regression. The orphan-cleanup path used to treat a
  // missing/unreadable upload root as an empty directory, which made EVERY
  // attachment row look orphaned (its file lives under that very volume). A real
  // cleanup run would then hard-delete all that metadata AND clear the campaign
  // map / encounter map / character portrait references — destroying good data
  // behind what was merely a transiently unmounted volume.
  //
  // The fix: refuse to mark rows as orphans when the storage root is unavailable
  // (missing or unreadable). cleanupOrphans throws 503 and leaves every DB row
  // intact, so the admin can restore the volume and retry. These tests pin both
  // halves (refusal + data preservation) for the two infra failure modes
  // (vanished volume, perms flip), and confirm cleanup resumes once storage is
  // healthy again.
  describe('orphan cleanup fails closed when storage is unavailable (issue #722)', () => {
    let keepId: number;
    let keepDiskPath: string;
    const uploadsPath = () => path.join(ctx.dataDir, 'uploads');

    beforeEach(async () => {
      // Seed a healthy attachment whose bytes live on disk. During the outage
      // below its file will (correctly) be unreachable, but its DB row MUST
      // survive cleanup — that is the whole point of fail-closed.
      const up = await adminAgent
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .field('kind', 'image')
        .attach('file', TINY_PNG, { filename: 'keep-during-outage.png', contentType: 'image/png' });
      expect(up.status).toBe(201);
      keepId = up.body.id;
      keepDiskPath = path.join(ctx.dataDir, 'uploads', String(campaignId), `${keepId}.png`);
      expect(fs.existsSync(keepDiskPath)).toBe(true);
    });

    async function expectRowSurvives(): Promise<void> {
      const list = await adminAgent.get(`/api/v1/campaigns/${campaignId}/attachments`);
      expect(list.status).toBe(200);
      expect(list.body.some((a: { id: number }) => a.id === keepId)).toBe(true);
    }

    it('refuses to clean up (503) when the upload volume is MISSING, and preserves every row', async () => {
      // Simulate a vanished/unmounted volume: move the uploads dir out of the way.
      const moved = `${uploadsPath()}.quarantined-missing`;
      fs.rmSync(moved, { recursive: true, force: true });
      fs.renameSync(uploadsPath(), moved);
      expect(fs.existsSync(uploadsPath())).toBe(false);

      try {
        // Dry-run must also refuse: a preview that reports "all rows are orphans"
        // while the disk is gone is itself dangerous (the admin could act on it).
        const dry = await adminAgent.post('/api/v1/admin/storage/cleanup?dryRun=true');
        expect(dry.status).toBe(503);

        const run = await adminAgent.post('/api/v1/admin/storage/cleanup');
        expect(run.status).toBe(503);

        // The DB row — whose file is now unreachable because the VOLUME is gone,
        // not because the file was deleted — must still be present.
        await expectRowSurvives();
      } finally {
        // Restore the volume so subsequent tests have a healthy root.
        fs.rmSync(uploadsPath(), { recursive: true, force: true });
        fs.renameSync(moved, uploadsPath());
        expect(fs.existsSync(keepDiskPath)).toBe(true);
      }
    });

    it('refuses to clean up (503) when the upload volume is UNREADABLE (EACCES), and preserves every row', async () => {
      // Skip when the test process can read anything regardless of mode bits
      // (root bypasses POSIX perms, so an EACCES test would be a false pass).
      if (process.getuid && process.getuid() === 0) {
        // eslint-disable-next-line no-console
        console.warn('skipping EACCES fail-closed test under root');
        return;
      }

      fs.chmodSync(uploadsPath(), 0o000);
      try {
        expect(fs.existsSync(uploadsPath())).toBe(true); // present, but unreadable

        const dry = await adminAgent.post('/api/v1/admin/storage/cleanup?dryRun=true');
        expect(dry.status).toBe(503);

        const run = await adminAgent.post('/api/v1/admin/storage/cleanup');
        expect(run.status).toBe(503);

        await expectRowSurvives();
      } finally {
        // Always restore perms so the cleanup below (and other suites) can run.
        fs.chmodSync(uploadsPath(), 0o755);
      }
    });

    it('cleanup resumes normally once the volume is healthy again (no permanent lockout)', async () => {
      // Sanity that the fail-closed guard doesn't leave cleanup wedged: with a
      // present + readable root, a genuine row-without-file is still cleaned.
      expect(fs.existsSync(uploadsPath())).toBe(true);
      fs.rmSync(keepDiskPath, { force: true });
      expect(fs.existsSync(keepDiskPath)).toBe(false);

      const run = await adminAgent.post('/api/v1/admin/storage/cleanup');
      expect(run.status).toBe(201);
      expect(run.body.rowsDeleted).toBeGreaterThanOrEqual(1);

      const list = await adminAgent.get(`/api/v1/campaigns/${campaignId}/attachments`);
      expect(list.body.some((a: { id: number }) => a.id === keepId)).toBe(false);
    });
  });
});
