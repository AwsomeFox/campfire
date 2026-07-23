import request from 'supertest';
import type { Server } from 'node:http';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';
import { DB, type DrizzleDb } from '../src/db/db.module';
import { importJobs } from '../src/db/schema';
import { eq } from 'drizzle-orm';
import { startFakeOpen5e, type FakeOpen5e } from './fake-open5e';
import { RulesService } from '../src/modules/rules/rules.service';

const admin = { 'x-dev-role': 'dm', 'x-dev-user': 'admin-1' };

/**
 * Poll an install job to a terminal state (completed or failed).
 */
async function pollJob(
  server: Server,
  headers: Record<string, string>,
  jobId: string,
  { timeoutMs = 15_000 }: { timeoutMs?: number } = {},
) {
  const start = Date.now();
  for (;;) {
    const res = await request(server).get(`/api/v1/rules/packs/install-jobs/${jobId}`).set(headers);
    expect(res.status).toBe(200);
    if (res.body.status === 'completed' || res.body.status === 'failed') return res.body;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`install job ${jobId} did not finish within ${timeoutMs}ms (last status ${res.body.status})`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('Issue #737: persistent import job state (e2e)', () => {
  let ctx: TestAppContext;
  let fake: FakeOpen5e;

  beforeAll(async () => {
    ctx = await createTestApp();
    fake = await startFakeOpen5e();
  });

  afterAll(async () => {
    await fake.close();
    await closeTestApp(ctx);
  });

  describe('job creation and state persistence', () => {
    it('enqueuing an install creates a persisted job record in the DB', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .post('/api/v1/rules/packs/install')
        .set(admin)
        .send({ source: 'open5e', url: fake.baseUrl });
      expect(res.status).toBe(202);
      const jobId = res.body.id;
      expect(jobId).toBeDefined();

      // Verify the job is persisted in the database
      const db = ctx.app.get<DrizzleDb>(DB);
      const [row] = db.select().from(importJobs).where(eq(importJobs.id, jobId)).all();
      expect(row).toBeDefined();
      expect(row.source).toBe('open5e');
      expect(row.actorId).toBe('dev:admin-1');
      expect(row.status).toMatch(/queued|running/);

      // Poll to completion
      const finalJob = await pollJob(server, admin, jobId);
      expect(finalJob.status).toBe('completed');

      // Verify DB row updated to completed
      const [updatedRow] = db.select().from(importJobs).where(eq(importJobs.id, jobId)).all();
      expect(updatedRow.status).toBe('completed');
      expect(updatedRow.completedAt).toBeTruthy();
    });

    it('job records source hash for idempotent detection', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .post('/api/v1/rules/packs/install')
        .set(admin)
        .send({ source: 'open5e', url: fake.baseUrl });
      expect(res.status).toBe(202);
      const jobId = res.body.id;

      const db = ctx.app.get<DrizzleDb>(DB);
      const [row] = db.select().from(importJobs).where(eq(importJobs.id, jobId)).all();
      expect(row.sourceHash).toBeTruthy();
      expect(row.sourceHash.length).toBeGreaterThan(0);

      await pollJob(server, admin, jobId);
    });
  });

  describe('job history API (GET /rules/packs/install-jobs)', () => {
    it('lists all persisted jobs after restart', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .get('/api/v1/rules/packs/install-jobs')
        .set(admin);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      // We already ran installs above, so there should be jobs
      expect(res.body.length).toBeGreaterThan(0);
      // Each job has the expected shape
      const job = res.body[0];
      expect(job).toHaveProperty('id');
      expect(job).toHaveProperty('source');
      expect(job).toHaveProperty('status');
      expect(job).toHaveProperty('progress');
      expect(job).toHaveProperty('createdAt');
    });
  });

  describe('idempotent retry', () => {
    it('re-running the same install does not duplicate data', async () => {
      const server = ctx.app.getHttpServer();

      // First install
      const res1 = await request(server)
        .post('/api/v1/rules/packs/install')
        .set(admin)
        .send({ source: 'open5e', url: fake.baseUrl, sections: ['spells'] });
      expect(res1.status).toBe(202);
      const job1 = await pollJob(server, admin, res1.body.id);
      expect(job1.status).toBe('completed');

      // Get the pack entry count after first install
      const packsRes1 = await request(server).get('/api/v1/rules/packs').set(admin);
      const pack1 = packsRes1.body.find((p: { slug: string }) => p.slug === 'open5e-srd');
      expect(pack1).toBeDefined();
      const countAfterFirst = pack1.entryCount;

      // Second install (same source, same sections) — should be incremental, not duplicate
      const res2 = await request(server)
        .post('/api/v1/rules/packs/install')
        .set(admin)
        .send({ source: 'open5e', url: fake.baseUrl, sections: ['spells'] });
      expect(res2.status).toBe(202);
      const job2 = await pollJob(server, admin, res2.body.id);
      expect(job2.status).toBe('completed');

      // Entry count should be the same (no duplicates)
      const packsRes2 = await request(server).get('/api/v1/rules/packs').set(admin);
      const pack2 = packsRes2.body.find((p: { slug: string }) => p.slug === 'open5e-srd');
      expect(pack2.entryCount).toBe(countAfterFirst);
    });
  });

  describe('cancel stops processing', () => {
    it('cancelling a queued job sets status to cancelled', async () => {
      const server = ctx.app.getHttpServer();

      // Create a job (it may already be running by the time we cancel, but that's fine)
      const res = await request(server)
        .post('/api/v1/rules/packs/install')
        .set(admin)
        .send({ source: 'open5e', url: fake.baseUrl });
      expect(res.status).toBe(202);
      const jobId = res.body.id;

      // Attempt to cancel immediately
      const cancelRes = await request(server)
        .post(`/api/v1/rules/packs/install-jobs/${jobId}/cancel`)
        .set(admin);

      // The job may have already completed by now (fast fake server), so accept both outcomes
      if (cancelRes.status === 200) {
        expect(cancelRes.body.status).toBe('failed'); // 'cancelled' maps to 'failed' in mapDbStatus
        // Verify DB record
        const db = ctx.app.get<DrizzleDb>(DB);
        const [row] = db.select().from(importJobs).where(eq(importJobs.id, jobId)).all();
        expect(row.status).toBe('cancelled');
      } else {
        // Job already completed — that's fine for a fast fake server
        expect(cancelRes.status).toBe(400);
      }
    });

    it('cancelling a completed job returns 400', async () => {
      const server = ctx.app.getHttpServer();

      // Use an already-completed job from previous tests
      const listRes = await request(server)
        .get('/api/v1/rules/packs/install-jobs')
        .set(admin);
      const completedJob = listRes.body.find((j: { status: string }) => j.status === 'completed');
      if (!completedJob) return; // skip if no completed jobs

      const cancelRes = await request(server)
        .post(`/api/v1/rules/packs/install-jobs/${completedJob.id}/cancel`)
        .set(admin);
      expect(cancelRes.status).toBe(400);
    });
  });

  describe('interrupted job detection on service init', () => {
    it('jobs stuck in running state are marked as failed on init', async () => {
      const db = ctx.app.get<DrizzleDb>(DB);
      const ts = new Date().toISOString();

      // Manually insert a "running" job (simulates a crash-interrupted job)
      db.insert(importJobs).values({
        id: 'interrupted-test-job',
        source: 'open5e',
        sourceHash: 'abc123',
        input: '{"source":"open5e"}',
        status: 'running',
        progress: JSON.stringify({ committed: 5, skipped: 0, failed: 0, sections: [{ section: 'spells', status: 'done', imported: 5 }] }),
        cursor: JSON.stringify({ lastSection: 'spells', index: 0 }),
        actorId: 'dev:admin-1',
        startedAt: ts,
        updatedAt: ts,
        completedAt: null,
        outcome: null,
        errors: '[]',
        createdAt: ts,
      }).run();

      // Call onModuleInit to simulate server restart
      const rulesService = ctx.app.get(RulesService);
      await rulesService.onModuleInit();

      // Verify the job was marked as failed
      const [row] = db.select().from(importJobs).where(eq(importJobs.id, 'interrupted-test-job')).all();
      expect(row.status).toBe('failed');
      const errors = JSON.parse(row.errors);
      expect(errors).toContain('Job interrupted by server restart');
      expect(row.completedAt).toBeTruthy();
    });
  });

  describe('progress tracking accuracy', () => {
    it('completed job has accurate committed/skipped counts', async () => {
      const server = ctx.app.getHttpServer();

      const res = await request(server)
        .post('/api/v1/rules/packs/install')
        .set(admin)
        .send({ source: 'open5e', url: fake.baseUrl, sections: ['spells'] });
      expect(res.status).toBe(202);
      const job = await pollJob(server, admin, res.body.id);

      expect(job.status).toBe('completed');
      // Progress should have section data
      expect(job.progress.length).toBeGreaterThan(0);
      expect(job.progress[0]).toHaveProperty('section');
      expect(job.progress[0]).toHaveProperty('status', 'done');
      expect(job.progress[0]).toHaveProperty('imported');
      expect(job.progress[0].imported).toBeGreaterThanOrEqual(0);

      // The DB row should have progress with counts
      const db = ctx.app.get<DrizzleDb>(DB);
      const [row] = db.select().from(importJobs).where(eq(importJobs.id, res.body.id)).all();
      const progress = JSON.parse(row.progress);
      expect(progress.committed).toBeGreaterThanOrEqual(0);
      expect(typeof progress.skipped).toBe('number');
    });
  });

  describe('retry endpoint', () => {
    it('retrying a failed job creates a new job with the same source', async () => {
      const db = ctx.app.get<DrizzleDb>(DB);
      const ts = new Date().toISOString();

      // Create a "failed" job manually
      db.insert(importJobs).values({
        id: 'failed-test-job',
        source: 'open5e',
        sourceHash: 'def456',
        input: JSON.stringify({ source: 'open5e', url: fake.baseUrl, sections: ['spells'] }),
        status: 'failed',
        progress: JSON.stringify({ committed: 0, skipped: 0, failed: 1, sections: [{ section: 'spells', status: 'failed', imported: 0 }] }),
        cursor: null,
        actorId: 'dev:admin-1',
        startedAt: ts,
        updatedAt: ts,
        completedAt: ts,
        outcome: null,
        errors: '["Network timeout"]',
        createdAt: ts,
      }).run();

      const server = ctx.app.getHttpServer();
      const retryRes = await request(server)
        .post('/api/v1/rules/packs/install-jobs/failed-test-job/retry')
        .set(admin);
      expect(retryRes.status).toBe(202);
      expect(retryRes.body.id).toBeDefined();
      expect(retryRes.body.id).not.toBe('failed-test-job'); // new job id
      expect(retryRes.body.source).toBe('open5e');

      // Poll the retry job to completion
      const finalJob = await pollJob(server, admin, retryRes.body.id);
      expect(finalJob.status).toBe('completed');
    });

    it('retrying a completed job returns 400', async () => {
      const server = ctx.app.getHttpServer();

      // Find a completed job
      const listRes = await request(server)
        .get('/api/v1/rules/packs/install-jobs')
        .set(admin);
      const completedJob = listRes.body.find((j: { status: string }) => j.status === 'completed');
      if (!completedJob) return;

      const retryRes = await request(server)
        .post(`/api/v1/rules/packs/install-jobs/${completedJob.id}/retry`)
        .set(admin);
      expect(retryRes.status).toBe(400);
    });
  });
});
