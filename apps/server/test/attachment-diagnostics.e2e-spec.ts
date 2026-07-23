import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';
import { DB, type DrizzleDb } from '../src/db/db.module';
import { attachments } from '../src/db/schema';

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

    it('also flags "missing" for a row whose canonical file is absent, even if a misplaced copy exists elsewhere', async () => {
      // Regression test for the fix where `seenOnDisk` was set for *any* file
      // matching the id, even one in the wrong campaign dir. That masked the
      // "missing" classification for rows whose canonical path had no file,
      // even though the "missing" detail explicitly says "no file on disk at
      // expected path". `seenOnDisk` is now only set when the file is at the
      // canonical dir + extension, so "missing" and "misplaced" are reported
      // together and each issue's own `detail` stays accurate.
      const up = await adminAgent
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .field('kind', 'map')
        .attach('file', TINY_PNG, { filename: 'missing-vs-misplaced.png', contentType: 'image/png' });
      expect(up.status).toBe(201);
      const attachId = up.body.id;

      const srcDir = path.join(ctx.dataDir, 'uploads', String(campaignId));
      const destDir = path.join(ctx.dataDir, 'uploads', String(campaign2Id));
      fs.mkdirSync(destDir, { recursive: true });
      fs.renameSync(
        path.join(srcDir, `${attachId}.png`),
        path.join(destDir, `${attachId}.png`),
      );

      const res = await adminAgent.post('/api/v1/admin/attachments/diagnostics');
      expect(res.status).toBe(201);

      const missing = res.body.issues.find(
        (i: { type: string; attachmentId: number }) => i.type === 'missing' && i.attachmentId === attachId,
      );
      const misplaced = res.body.issues.find(
        (i: { type: string; attachmentId: number }) => i.type === 'misplaced' && i.attachmentId === attachId,
      );
      expect(misplaced).toBeDefined();
      expect(missing).toBeDefined();
      expect(missing.detail).toContain('no file on disk at expected path');

      // Clean up: move back.
      fs.renameSync(path.join(destDir, `${attachId}.png`), path.join(srcDir, `${attachId}.png`));
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

    it('reports the actual on-disk file size, not a stale DB row size', async () => {
      const up1 = await adminAgent
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .field('kind', 'image')
        .attach('file', TINY_PNG, { filename: 'dup-size-1.png', contentType: 'image/png' });
      expect(up1.status).toBe(201);
      const up2 = await adminAgent
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .field('kind', 'image')
        .attach('file', TINY_PNG, { filename: 'dup-size-2.png', contentType: 'image/png' });
      expect(up2.status).toBe(201);
      const attachId1 = up1.body.id;

      // Simulate stale/incorrect DB metadata: overwrite the stored `size` for
      // one of the two rows so it no longer matches what's actually on disk.
      const db = ctx.app.get<DrizzleDb>(DB);
      await db.update(attachments).set({ size: 999_999 }).where(eq(attachments.id, attachId1));

      const res = await adminAgent.post('/api/v1/admin/attachments/diagnostics');
      expect(res.status).toBe(201);

      const dupForRow1 = res.body.issues.find(
        (i: { type: string; attachmentId: number }) => i.type === 'duplicate' && i.attachmentId === attachId1,
      );
      expect(dupForRow1).toBeDefined();
      // Must reflect the real on-disk size (TINY_PNG's byte length), not the
      // tampered DB row value of 999_999.
      expect(dupForRow1.size).toBe(TINY_PNG.length);
      expect(dupForRow1.size).not.toBe(999_999);
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

    it('relinks when the on-disk extension differs from the MIME-derived extension', async () => {
      const up = await adminAgent
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .field('kind', 'image')
        .attach('file', TINY_PNG, { filename: 'relink-wrong-ext.png', contentType: 'image/png' });
      expect(up.status).toBe(201);
      const attachId = up.body.id;

      const srcDir = path.join(ctx.dataDir, 'uploads', String(campaignId));
      const destDir = path.join(ctx.dataDir, 'uploads', String(campaign2Id));
      fs.mkdirSync(destDir, { recursive: true });
      fs.renameSync(
        path.join(srcDir, `${attachId}.png`),
        path.join(destDir, `${attachId}.jpg`),
      );

      const fixRes = await adminAgent
        .post('/api/v1/admin/attachments/diagnostics/fix')
        .send({ attachmentId: attachId, action: 'relink' });
      expect(fixRes.status).toBe(201);
      expect(fixRes.body.success).toBe(true);
      expect(fixRes.body.detail).toContain(String(campaign2Id));
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

    it('quarantine with attachmentId finds a misplaced on-disk file', async () => {
      const up = await adminAgent
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .field('kind', 'image')
        .attach('file', TINY_PNG, { filename: 'quarantine-misplaced.png', contentType: 'image/png' });
      expect(up.status).toBe(201);
      const attachId = up.body.id;

      const srcFile = path.join(ctx.dataDir, 'uploads', String(campaignId), `${attachId}.png`);
      const destDir = path.join(ctx.dataDir, 'uploads', String(campaign2Id));
      fs.mkdirSync(destDir, { recursive: true });
      const destFile = path.join(destDir, `${attachId}.png`);
      fs.renameSync(srcFile, destFile);

      const fixRes = await adminAgent
        .post('/api/v1/admin/attachments/diagnostics/fix')
        .send({ attachmentId: attachId, action: 'quarantine' });
      expect(fixRes.status).toBe(201);
      expect(fixRes.body.success).toBe(true);
      expect(fs.existsSync(destFile)).toBe(false);
      expect(fs.existsSync(path.join(ctx.dataDir, 'quarantine', String(campaign2Id), `${attachId}.png`))).toBe(true);
    });
  });

  describe('non-canonical campaign directory (parseInt hardening)', () => {
    it('does not treat a directory whose name only starts with the campaign id as canonical', async () => {
      // Regression: `Number.parseInt('<id>extra')` used to return `<id>`, so a
      // stray directory like `3extra` was mistaken for campaign 3. That marked
      // the file "canonical" (seenOnDisk) and masked the row's real "missing"
      // state, even though AttachmentsService only reads `<id>/<file>`.
      const up = await adminAgent
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .field('kind', 'map')
        .attach('file', TINY_PNG, { filename: 'non-canonical-dir.png', contentType: 'image/png' });
      expect(up.status).toBe(201);
      const attachId = up.body.id;

      const srcFile = path.join(ctx.dataDir, 'uploads', String(campaignId), `${attachId}.png`);
      const bogusDir = path.join(ctx.dataDir, 'uploads', `${campaignId}extra`);
      fs.mkdirSync(bogusDir, { recursive: true });
      const bogusFile = path.join(bogusDir, `${attachId}.png`);
      fs.renameSync(srcFile, bogusFile);

      const res = await adminAgent.post('/api/v1/admin/attachments/diagnostics');
      expect(res.status).toBe(201);

      // The row's canonical file is absent, so it must be flagged "missing"
      // rather than silently considered healthy.
      const missing = res.body.issues.find(
        (i: { type: string; attachmentId: number }) => i.type === 'missing' && i.attachmentId === attachId,
      );
      expect(missing).toBeDefined();

      // …and the file that actually exists under the non-canonical directory must
      // still be surfaced as "misplaced" (pointing at its real location) so the
      // operator can find the bytes, not just learn the row is missing.
      const misplaced = res.body.issues.find(
        (i: { type: string; attachmentId: number }) => i.type === 'misplaced' && i.attachmentId === attachId,
      );
      expect(misplaced).toBeDefined();
      expect(misplaced.path).toContain(`${campaignId}extra`);
      expect(misplaced.detail).toContain('non-canonical dir');

      // Clean up.
      fs.renameSync(bogusFile, srcFile);
      fs.rmSync(bogusDir, { recursive: true, force: true });
    });

    it('relink refuses to "succeed" for a file living under a non-canonical directory name', async () => {
      const up = await adminAgent
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .field('kind', 'map')
        .attach('file', TINY_PNG, { filename: 'non-canonical-relink.png', contentType: 'image/png' });
      expect(up.status).toBe(201);
      const attachId = up.body.id;

      const srcFile = path.join(ctx.dataDir, 'uploads', String(campaignId), `${attachId}.png`);
      const bogusDir = path.join(ctx.dataDir, 'uploads', `${campaignId}extra`);
      fs.mkdirSync(bogusDir, { recursive: true });
      const bogusFile = path.join(bogusDir, `${attachId}.png`);
      fs.renameSync(srcFile, bogusFile);

      const fixRes = await adminAgent
        .post('/api/v1/admin/attachments/diagnostics/fix')
        .send({ attachmentId: attachId, action: 'relink' });
      expect(fixRes.status).toBe(201);
      expect(fixRes.body.success).toBe(false);
      expect(fixRes.body.detail).toContain('Non-numeric campaign directory');

      // Clean up.
      fs.renameSync(bogusFile, srcFile);
      fs.rmSync(bogusDir, { recursive: true, force: true });
    });
  });

  describe('ambiguous attachmentId (multiple on-disk files)', () => {
    it('relink refuses to act when the same id exists in multiple campaign dirs', async () => {
      const up = await adminAgent
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .field('kind', 'map')
        .attach('file', TINY_PNG, { filename: 'ambiguous-relink.png', contentType: 'image/png' });
      expect(up.status).toBe(201);
      const attachId = up.body.id;

      // Duplicate the same-id file into campaign2's directory so two primaries exist.
      const srcFile = path.join(ctx.dataDir, 'uploads', String(campaignId), `${attachId}.png`);
      const destDir = path.join(ctx.dataDir, 'uploads', String(campaign2Id));
      fs.mkdirSync(destDir, { recursive: true });
      const destFile = path.join(destDir, `${attachId}.png`);
      fs.copyFileSync(srcFile, destFile);

      const fixRes = await adminAgent
        .post('/api/v1/admin/attachments/diagnostics/fix')
        .send({ attachmentId: attachId, action: 'relink' });
      expect(fixRes.status).toBe(201);
      expect(fixRes.body.success).toBe(false);
      expect(fixRes.body.detail).toContain('Multiple on-disk files');

      // Clean up the duplicate.
      fs.rmSync(destFile, { force: true });
    });

    it('quarantine by attachmentId refuses to act when multiple files share the id', async () => {
      const up = await adminAgent
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .field('kind', 'map')
        .attach('file', TINY_PNG, { filename: 'ambiguous-quarantine.png', contentType: 'image/png' });
      expect(up.status).toBe(201);
      const attachId = up.body.id;

      const srcFile = path.join(ctx.dataDir, 'uploads', String(campaignId), `${attachId}.png`);
      const destDir = path.join(ctx.dataDir, 'uploads', String(campaign2Id));
      fs.mkdirSync(destDir, { recursive: true });
      const destFile = path.join(destDir, `${attachId}.png`);
      fs.copyFileSync(srcFile, destFile);

      const fixRes = await adminAgent
        .post('/api/v1/admin/attachments/diagnostics/fix')
        .send({ attachmentId: attachId, action: 'quarantine' });
      expect(fixRes.status).toBe(201);
      expect(fixRes.body.success).toBe(false);
      expect(fixRes.body.detail).toContain('Multiple on-disk files');
      // Neither copy should have been moved.
      expect(fs.existsSync(srcFile)).toBe(true);
      expect(fs.existsSync(destFile)).toBe(true);

      // Clean up the duplicate.
      fs.rmSync(destFile, { force: true });
    });
  });

  describe('path containment (leading-dot names)', () => {
    it('accepts a legitimate relative diskPath whose first segment merely starts with dots', async () => {
      // Regression: `startsWith('..')` used to reject valid names like `..foo`.
      const bogusDir = path.join(ctx.dataDir, 'uploads', '..foo');
      fs.mkdirSync(bogusDir, { recursive: true });
      const filePath = path.join(bogusDir, 'bar.png');
      fs.writeFileSync(filePath, TINY_PNG);

      const res = await adminAgent
        .post('/api/v1/admin/attachments/diagnostics/fix')
        .send({ diskPath: '..foo/bar.png', action: 'quarantine' });
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(fs.existsSync(filePath)).toBe(false);
      expect(fs.existsSync(path.join(ctx.dataDir, 'quarantine', '..foo', 'bar.png'))).toBe(true);

      // Clean up.
      fs.rmSync(bogusDir, { recursive: true, force: true });
      fs.rmSync(path.join(ctx.dataDir, 'quarantine', '..foo'), { recursive: true, force: true });
    });

    it('still rejects real parent traversal', async () => {
      const res = await adminAgent
        .post('/api/v1/admin/attachments/diagnostics/fix')
        .send({ action: 'quarantine', diskPath: '../outside.txt' });
      expect(res.status).toBe(400);
      expect(String(res.body.message)).toContain('uploads root');
    });

    it('rejects diskPath that escapes uploads via a directory symlink', async () => {
      const uploadsRoot = path.join(ctx.dataDir, 'uploads');
      const outsideDir = path.join(ctx.dataDir, 'outside-of-uploads');
      fs.mkdirSync(outsideDir, { recursive: true });
      const outsideFile = path.join(outsideDir, 'secret.png');
      fs.writeFileSync(outsideFile, TINY_PNG);

      const linkPath = path.join(uploadsRoot, 'symlink-escape');
      fs.rmSync(linkPath, { recursive: true, force: true });
      fs.symlinkSync(outsideDir, linkPath, 'dir');

      const res = await adminAgent
        .post('/api/v1/admin/attachments/diagnostics/fix')
        .send({ action: 'quarantine', diskPath: 'symlink-escape/secret.png' });
      expect(res.status).toBe(400);
      expect(String(res.body.message)).toContain('uploads root');
      // Outside file must remain untouched.
      expect(fs.existsSync(outsideFile)).toBe(true);

      fs.rmSync(linkPath, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    });
  });


  describe('unreadable campaign subdirectory during fix', () => {
    it('maps an unreadable campaign dir to 503 for relink (not a false not-found)', async () => {
      // chmod-based permission revocation is unreliable on Windows.
      if (process.platform === 'win32') return;

      // Use a dedicated campaign (not the shared fixtures) so that a chmod
      // left in a bad state can't leak into unrelated tests.
      const camp = await adminAgent.post('/api/v1/campaigns').send({ name: 'Diagnostics Unreadable Subdir' });
      expect(camp.status).toBe(201);
      const isolatedCampaignId = camp.body.id;

      const up = await adminAgent
        .post(`/api/v1/campaigns/${isolatedCampaignId}/attachments`)
        .field('kind', 'map')
        .attach('file', TINY_PNG, { filename: 'unreadable-subdir-relink.png', contentType: 'image/png' });
      expect(up.status).toBe(201);
      const attachId = up.body.id;

      // Make the attachment's own campaign directory unreadable. Without
      // fail-closed lookup, readdir would skip it and report a false not-found;
      // with the fix it must map to 503 when EACCES is observable.
      const campaignDir = path.join(ctx.dataDir, 'uploads', String(isolatedCampaignId));
      const previousMode = fs.statSync(campaignDir).mode & 0o7777;
      try {
        fs.chmodSync(campaignDir, 0);
      } catch {
        // Restricted filesystems may refuse chmod — skip rather than fail the suite.
        return;
      }

      try {
        const fixRes = await adminAgent
          .post('/api/v1/admin/attachments/diagnostics/fix')
          .send({ attachmentId: attachId, action: 'relink' });
        // If the process can still read the dir (e.g. running as root), chmod
        // is ineffective — assert the fix succeeds rather than masking a
        // success:false "not found".
        if (fixRes.status === 503) {
          expect(String(fixRes.body.message)).toMatch(/unreadable/i);
        } else {
          expect(fixRes.status).toBe(201);
          expect(fixRes.body.success).toBe(true);
        }
      } finally {
        try {
          fs.chmodSync(campaignDir, previousMode);
        } catch (restoreErr) {
          // Isolated to `isolatedCampaignId` above, so a failed restore here
          // can't leave shared fixtures unreadable for other tests — but log
          // it with a clear cause instead of swallowing it silently.
          // eslint-disable-next-line no-console
          console.error(`Failed to restore mode on ${campaignDir} after test:`, restoreErr);
        }
      }
    });
  });

  describe('relink with missing uploads root', () => {
    it('returns success:false (not 503) when the uploads directory is absent', async () => {
      // Create a DB row without relying on an on-disk file, then remove the
      // entire uploads tree so relink sees the same empty-storage case the
      // scan tolerates (issues reported as missing, not 503).
      const up = await adminAgent
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .field('kind', 'map')
        .attach('file', TINY_PNG, { filename: 'missing-root-relink.png', contentType: 'image/png' });
      expect(up.status).toBe(201);
      const attachId = up.body.id;

      const uploadsRoot = path.join(ctx.dataDir, 'uploads');
      fs.rmSync(uploadsRoot, { recursive: true, force: true });
      expect(fs.existsSync(uploadsRoot)).toBe(false);

      const fixRes = await adminAgent
        .post('/api/v1/admin/attachments/diagnostics/fix')
        .send({ attachmentId: attachId, action: 'relink' });
      expect(fixRes.status).toBe(201);
      expect(fixRes.body.success).toBe(false);
      expect(fixRes.body.detail).toMatch(/not found/i);

      // Restore an empty uploads root so later tests can recreate dirs.
      fs.mkdirSync(uploadsRoot, { recursive: true });
    });
  });

  describe('quarantine move failure -> 503', () => {
    it('maps an unwritable quarantine destination to 503 instead of 500', async () => {
      // Create an orphan file to quarantine under a made-up campaign dir.
      const uploadsDir = path.join(ctx.dataDir, 'uploads', '9091');
      fs.mkdirSync(uploadsDir, { recursive: true });
      const orphanPath = path.join(uploadsDir, '5550001.png');
      fs.writeFileSync(orphanPath, TINY_PNG);

      // Pre-create the quarantine campaign path as a *file* so mkdirSync of the
      // destination directory fails with ENOTDIR/EEXIST — a stand-in for any
      // storage-level move failure.
      const quarantineDir = path.join(ctx.dataDir, 'quarantine');
      fs.mkdirSync(quarantineDir, { recursive: true });
      const blocker = path.join(quarantineDir, '9091');
      fs.rmSync(blocker, { recursive: true, force: true });
      fs.writeFileSync(blocker, 'not a directory');

      const res = await adminAgent
        .post('/api/v1/admin/attachments/diagnostics/fix')
        .send({ diskPath: '9091/5550001.png', action: 'quarantine' });
      expect(res.status).toBe(503);

      // The source file should still be present (move did not partially apply).
      expect(fs.existsSync(orphanPath)).toBe(true);

      // Clean up.
      fs.rmSync(blocker, { recursive: true, force: true });
      fs.rmSync(uploadsDir, { recursive: true, force: true });
    });
  });

  describe('fix: validation', () => {
    it('400 when neither attachmentId nor diskPath is provided', async () => {
      const res = await adminAgent
        .post('/api/v1/admin/attachments/diagnostics/fix')
        .send({ action: 'relink' });
      expect(res.status).toBe(400);
    });

    it('400 when relink is requested with only a diskPath (no attachmentId)', async () => {
      // relink resolves the target from its DB row, so a diskPath-only relink is
      // an invalid request shape and must be rejected up front rather than
      // returning 201 with success:false.
      const res = await adminAgent
        .post('/api/v1/admin/attachments/diagnostics/fix')
        .send({ action: 'relink', diskPath: `${campaignId}/1.png` });
      expect(res.status).toBe(400);
      expect(String(res.body.message)).toContain('attachmentId');
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
      expect(res.status).toBe(400);
      expect(String(res.body.message)).toContain('uploads root');
    });
  });
});
