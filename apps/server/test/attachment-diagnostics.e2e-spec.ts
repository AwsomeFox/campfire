import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';

/**
 * Issue #733 — Attachment diagnostics: validate canonical owner, path, extension,
 * duplicates, and thumbnails.
 *
 * POST /api/v1/admin/attachments/diagnostics  — run a full scan
 * POST /api/v1/admin/attachments/diagnostics/fix — apply relink or quarantine
 *
 * Both endpoints are server-admin only (@ServerRoles('admin')).
 */

// Minimal valid 1x1 PNG (same fixture the attachments/storage suites use).
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108020000009077' +
    '53de0000000c4944415408d763f8ffff3f0005fe02fea1399e1e0000000049454e44ae426082',
  'hex',
);

// Minimal valid 1x1 JPEG.
const TINY_JPEG = Buffer.from(
  'ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707' +
    '070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c' +
    '30313434341f27393d38323c2e333432ffdb004301090909090c0b0c180d0d1832211c21323232' +
    '32323232323232323232323232323232323232323232323232323232323232323232323232323232' +
    '3232323232ffc00011080001000103012200021101031101ffc4001f0000010501010101010100' +
    '000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d' +
    '01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a' +
    '161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768' +
    '696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4' +
    'b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4' +
    'f5f6f7f8f9faffc4001f01000301010101010101010100000000000001020304050607080' +
    '90a0bffc400b511000201020404030407050404000102770001020311040521310612415107' +
    '6171132232810814423291a1b1c109233352f0156272d10a162434e125f11718191a262728292a35' +
    '3637383' +
    '93a434445464748494a535455565758595a636465666768696a737475767778797a82838485868788' +
    '898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2' +
    'd3d4d5d6d7d8d9dae2e3e4e5e6e7e8e9eaf2f3f4f5f6f7f8f9faffda000c03010002110311003f' +
    '00fbdd2800a002800a002800a0fffd9',
  'hex',
);

describe('Issue #733: attachment diagnostics (e2e)', () => {
  let ctx: TestAppContext;
  let adminAgent: ReturnType<typeof request.agent>;
  let userAgent: ReturnType<typeof request.agent>;
  let campaignId: number;
  let campaign2Id: number;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    // First user -> server admin.
    adminAgent = request.agent(server);
    await adminAgent.post('/api/v1/auth/setup').send({ username: 'diag-admin', password: 'admin-password-1' });

    // Ordinary user.
    await adminAgent.post('/api/v1/users').send({ username: 'diag-user', password: 'user-password-1', serverRole: 'user' });
    userAgent = request.agent(server);
    await userAgent.post('/api/v1/auth/login').send({ username: 'diag-user', password: 'user-password-1' });

    // Two campaigns for cross-campaign testing.
    const camp1 = await adminAgent.post('/api/v1/campaigns').send({ name: 'Diagnostics Camp 1' });
    campaignId = camp1.body.id;
    const camp2 = await adminAgent.post('/api/v1/campaigns').send({ name: 'Diagnostics Camp 2' });
    campaign2Id = camp2.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  describe('access control', () => {
    it('unauthenticated -> 401', async () => {
      const res = await request(ctx.app.getHttpServer()).post('/api/v1/admin/attachments/diagnostics');
      expect(res.status).toBe(401);
    });

    it('non-admin user -> 403', async () => {
      const res = await userAgent.post('/api/v1/admin/attachments/diagnostics');
      expect(res.status).toBe(403);
    });

    it('admin -> 201', async () => {
      const res = await adminAgent.post('/api/v1/admin/attachments/diagnostics');
      expect(res.status).toBe(201);
    });
  });

  describe('clean state', () => {
    it('reports zero issues when all attachments are healthy', async () => {
      // Upload a good file.
      const up = await adminAgent
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .field('kind', 'map')
        .attach('file', TINY_PNG, { filename: 'healthy.png', contentType: 'image/png' });
      expect(up.status).toBe(201);

      const res = await adminAgent.post('/api/v1/admin/attachments/diagnostics');
      expect(res.status).toBe(201);
      expect(res.body.scannedAt).toBeDefined();
      expect(res.body.totalDbRows).toBeGreaterThanOrEqual(1);
      expect(res.body.totalDiskFiles).toBeGreaterThanOrEqual(1);
      // No issues for any of the files we just uploaded.
      const issueIds = res.body.issues
        .filter((i: { attachmentId: number | null }) => i.attachmentId === up.body.id)
        .filter((i: { type: string }) => i.type !== 'duplicate');
      expect(issueIds).toHaveLength(0);
    });
  });

  describe('cross-campaign path detection (misplaced)', () => {
    it('detects a file physically in the wrong campaign directory', async () => {
      // Upload into campaign1.
      const up = await adminAgent
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .field('kind', 'map')
        .attach('file', TINY_PNG, { filename: 'will-move.png', contentType: 'image/png' });
      expect(up.status).toBe(201);
      const attachId = up.body.id;

      // Physically move the file to campaign2's directory.
      const srcDir = path.join(ctx.dataDir, 'uploads', String(campaignId));
      const destDir = path.join(ctx.dataDir, 'uploads', String(campaign2Id));
      fs.mkdirSync(destDir, { recursive: true });
      const srcFile = path.join(srcDir, `${attachId}.png`);
      const destFile = path.join(destDir, `${attachId}.png`);
      fs.renameSync(srcFile, destFile);

      const res = await adminAgent.post('/api/v1/admin/attachments/diagnostics');
      expect(res.status).toBe(201);

      // Should have a 'misplaced' issue for this attachment.
      const misplaced = res.body.issues.find(
        (i: { type: string; attachmentId: number }) => i.type === 'misplaced' && i.attachmentId === attachId,
      );
      expect(misplaced).toBeDefined();
      expect(misplaced.campaignId).toBe(campaignId);
      expect(misplaced.path).toContain(String(campaign2Id));
      expect(misplaced.canonicalPath).toContain(String(campaignId));
      expect(misplaced.owner).toBeDefined();

      // Clean up: move back.
      fs.renameSync(destFile, srcFile);
    });
  });

  describe('wrong-extension detection', () => {
    it('detects a file whose extension mismatches its MIME type in DB', async () => {
      // Upload a PNG.
      const up = await adminAgent
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .field('kind', 'image')
        .attach('file', TINY_PNG, { filename: 'ext-test.png', contentType: 'image/png' });
      expect(up.status).toBe(201);
      const attachId = up.body.id;

      // Rename on disk from .png to .jpg (simulating a wrong extension).
      const dir = path.join(ctx.dataDir, 'uploads', String(campaignId));
      const correctFile = path.join(dir, `${attachId}.png`);
      const wrongFile = path.join(dir, `${attachId}.jpg`);
      fs.renameSync(correctFile, wrongFile);

      const res = await adminAgent.post('/api/v1/admin/attachments/diagnostics');
      expect(res.status).toBe(201);

      // The scanner should see the .jpg file for this id and flag wrong-extension.
      const wrongExt = res.body.issues.find(
        (i: { type: string; attachmentId: number }) => i.type === 'wrong-extension' && i.attachmentId === attachId,
      );
      expect(wrongExt).toBeDefined();
      expect(wrongExt.detail).toContain('.jpg');
      expect(wrongExt.detail).toContain('.png');

      // Clean up.
      fs.renameSync(wrongFile, correctFile);
    });
  });

  describe('malformed filename detection', () => {
    it('flags a file that does not match the <id>.<ext> pattern', async () => {
      const dir = path.join(ctx.dataDir, 'uploads', String(campaignId));
      fs.mkdirSync(dir, { recursive: true });
      const malformed = path.join(dir, 'not-a-valid-name.png');
      fs.writeFileSync(malformed, TINY_PNG);

      const res = await adminAgent.post('/api/v1/admin/attachments/diagnostics');
      expect(res.status).toBe(201);

      const found = res.body.issues.find(
        (i: { type: string; path: string }) => i.type === 'malformed' && i.path.includes('not-a-valid-name'),
      );
      expect(found).toBeDefined();
      expect(found.detail).toContain('not-a-valid-name');

      // Clean up.
      fs.rmSync(malformed, { force: true });
    });
  });

  describe('unexpected-thumbnail detection', () => {
    it('flags a .thumb.png file whose parent attachment row does not exist', async () => {
      const dir = path.join(ctx.dataDir, 'uploads', String(campaignId));
      fs.mkdirSync(dir, { recursive: true });
      // Write a thumbnail for a nonexistent attachment id.
      const thumbFile = path.join(dir, '8888888.thumb.png');
      fs.writeFileSync(thumbFile, TINY_PNG);

      const res = await adminAgent.post('/api/v1/admin/attachments/diagnostics');
      expect(res.status).toBe(201);

      const found = res.body.issues.find(
        (i: { type: string; path: string }) => i.type === 'unexpected-thumbnail' && i.path.includes('8888888.thumb.png'),
      );
      expect(found).toBeDefined();
      expect(found.detail).toContain('no parent attachment row');

      // Clean up.
      fs.rmSync(thumbFile, { force: true });
    });
  });

  describe('orphan detection', () => {
    it('detects a file on disk with no matching DB row', async () => {
      const dir = path.join(ctx.dataDir, 'uploads', String(campaignId));
      fs.mkdirSync(dir, { recursive: true });
      const stray = path.join(dir, '7777777.png');
      fs.writeFileSync(stray, TINY_PNG);

      const res = await adminAgent.post('/api/v1/admin/attachments/diagnostics');
      expect(res.status).toBe(201);

      const found = res.body.issues.find(
        (i: { type: string; path: string }) => i.type === 'orphan' && i.path.includes('7777777.png'),
      );
      expect(found).toBeDefined();
      expect(found.checksum).toBeTruthy();
      expect(found.size).toBeGreaterThan(0);

      // Clean up.
      fs.rmSync(stray, { force: true });
    });
  });

  describe('missing detection', () => {
    it('detects a DB row whose file is absent from disk', async () => {
      // Upload then delete the file.
      const up = await adminAgent
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .field('kind', 'image')
        .attach('file', TINY_PNG, { filename: 'will-vanish.png', contentType: 'image/png' });
      expect(up.status).toBe(201);
      const attachId = up.body.id;
      const diskPath = path.join(ctx.dataDir, 'uploads', String(campaignId), `${attachId}.png`);
      fs.rmSync(diskPath, { force: true });

      const res = await adminAgent.post('/api/v1/admin/attachments/diagnostics');
      expect(res.status).toBe(201);

      const found = res.body.issues.find(
        (i: { type: string; attachmentId: number }) => i.type === 'missing' && i.attachmentId === attachId,
      );
      expect(found).toBeDefined();
      expect(found.size).toBe(0);
      expect(found.checksum).toBe('');
    });
  });

  describe('duplicate detection', () => {
    it('flags files with identical content hashes', async () => {
      // Upload the same file twice to get two distinct attachment ids with identical bytes.
      const up1 = await adminAgent
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .field('kind', 'image')
        .attach('file', TINY_PNG, { filename: 'dup1.png', contentType: 'image/png' });
      expect(up1.status).toBe(201);
      const up2 = await adminAgent
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .field('kind', 'image')
        .attach('file', TINY_PNG, { filename: 'dup2.png', contentType: 'image/png' });
      expect(up2.status).toBe(201);

      const res = await adminAgent.post('/api/v1/admin/attachments/diagnostics');
      expect(res.status).toBe(201);

      const dups = res.body.issues.filter((i: { type: string }) => i.type === 'duplicate');
      // There should be at least 2 entries with the same checksum.
      expect(dups.length).toBeGreaterThanOrEqual(2);
      // They should share a checksum.
      const checksums = dups.map((d: { checksum: string }) => d.checksum);
      const uniqueChecksums = new Set(checksums);
      expect(uniqueChecksums.size).toBeLessThan(checksums.length);
    });
  });

  describe('fix: relink', () => {
    it('updates DB row campaignId to match the file\'s actual campaign directory', async () => {
      // Upload into campaign1.
      const up = await adminAgent
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .field('kind', 'map')
        .attach('file', TINY_PNG, { filename: 'relink-me.png', contentType: 'image/png' });
      expect(up.status).toBe(201);
      const attachId = up.body.id;

      // Physically move to campaign2's directory.
      const srcDir = path.join(ctx.dataDir, 'uploads', String(campaignId));
      const destDir = path.join(ctx.dataDir, 'uploads', String(campaign2Id));
      fs.mkdirSync(destDir, { recursive: true });
      fs.renameSync(
        path.join(srcDir, `${attachId}.png`),
        path.join(destDir, `${attachId}.png`),
      );

      // Run relink.
      const fixRes = await adminAgent
        .post('/api/v1/admin/attachments/diagnostics/fix')
        .send({ attachmentId: attachId, action: 'relink' });
      expect(fixRes.status).toBe(201);
      expect(fixRes.body.success).toBe(true);
      expect(fixRes.body.action).toBe('relink');
      expect(fixRes.body.detail).toContain(String(campaign2Id));

      // Verify the scan is now clean for this attachment (no misplaced).
      const scan = await adminAgent.post('/api/v1/admin/attachments/diagnostics');
      const misplaced = scan.body.issues.find(
        (i: { type: string; attachmentId: number }) => i.type === 'misplaced' && i.attachmentId === attachId,
      );
      expect(misplaced).toBeUndefined();
    });
  });

  describe('fix: quarantine', () => {
    it('moves a file to the quarantine directory', async () => {
      // Create an orphan file.
      const dir = path.join(ctx.dataDir, 'uploads', String(campaignId));
      fs.mkdirSync(dir, { recursive: true });
      const orphanPath = path.join(dir, '6666666.png');
      fs.writeFileSync(orphanPath, TINY_PNG);
      expect(fs.existsSync(orphanPath)).toBe(true);

      const relPath = `${campaignId}/6666666.png`;

      const fixRes = await adminAgent
        .post('/api/v1/admin/attachments/diagnostics/fix')
        .send({ diskPath: relPath, action: 'quarantine' });
      expect(fixRes.status).toBe(201);
      expect(fixRes.body.success).toBe(true);
      expect(fixRes.body.action).toBe('quarantine');

      // File should no longer be in uploads.
      expect(fs.existsSync(orphanPath)).toBe(false);

      // File should now be in quarantine.
      const qPath = path.join(ctx.dataDir, 'quarantine', relPath);
      expect(fs.existsSync(qPath)).toBe(true);
    });

    it('quarantine with attachmentId moves the canonical file', async () => {
      // Upload a legitimate file then quarantine via its attachmentId.
      const up = await adminAgent
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .field('kind', 'image')
        .attach('file', TINY_PNG, { filename: 'quarantine-me.png', contentType: 'image/png' });
      expect(up.status).toBe(201);
      const attachId = up.body.id;
      const filePath = path.join(ctx.dataDir, 'uploads', String(campaignId), `${attachId}.png`);
      expect(fs.existsSync(filePath)).toBe(true);

      const fixRes = await adminAgent
        .post('/api/v1/admin/attachments/diagnostics/fix')
        .send({ attachmentId: attachId, action: 'quarantine' });
      expect(fixRes.status).toBe(201);
      expect(fixRes.body.success).toBe(true);

      // Original gone.
      expect(fs.existsSync(filePath)).toBe(false);
      // In quarantine.
      const qPath = path.join(ctx.dataDir, 'quarantine', String(campaignId), `${attachId}.png`);
      expect(fs.existsSync(qPath)).toBe(true);
    });
  });

  describe('fix: validation', () => {
    it('400 when neither attachmentId nor diskPath is provided', async () => {
      const res = await adminAgent
        .post('/api/v1/admin/attachments/diagnostics/fix')
        .send({ action: 'relink' });
      expect(res.status).toBe(400);
    });

    it('400 when diskPath is blank/whitespace and attachmentId is missing', async () => {
      const res = await adminAgent
        .post('/api/v1/admin/attachments/diagnostics/fix')
        .send({ action: 'quarantine', diskPath: '   ' });
      expect(res.status).toBe(400);
    });

    it('rejects diskPath traversal outside uploads root', async () => {
      const res = await adminAgent
        .post('/api/v1/admin/attachments/diagnostics/fix')
        .send({ action: 'quarantine', diskPath: '../outside.txt' });
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(false);
      expect(res.body.detail).toContain('uploads root');
    });
  });
});
