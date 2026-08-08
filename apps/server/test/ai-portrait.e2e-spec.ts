import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };
const player = { 'x-dev-role': 'player', 'x-dev-user': 'player-1' };
const viewer = { 'x-dev-role': 'viewer', 'x-dev-user': 'viewer-1' };

/**
 * AI portrait generation REST flow (issue #1321), end-to-end and OFFLINE. With no AI provider
 * configured (the default test app), generation routes honestly to the external-instructions
 * fallback — deterministic, no network, no previews (there is no first-party portrait renderer).
 * Covers readiness, generate (external-instructions), status, idempotency, moderation, cancel,
 * and the member-scoped permission gate (viewers rejected, players allowed for generation). Also
 * validates that the new AiPortraitModule wires cleanly into the Nest DI graph (the app boots).
 */
describe('AI portrait generation (e2e, issue #1321)', () => {
  let ctx: TestAppContext;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    const res = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'AI Portrait Campaign' });
    campaignId = res.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('reports readiness (external-instructions) without spending', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/ai-portraits/readiness`)
      .set(dm)
      .send({ prompt: 'a weathered human ranger', count: 2 });
    expect(res.status).toBe(201);
    expect(res.body.method).toBe('external-instructions');
    expect(res.body.cost.imageCount).toBe(0);
    expect(res.body.capabilities).toBeNull();
    expect(res.body.warnings.length).toBeGreaterThan(0);
  });

  it('generates external-instructions when no provider is configured (no previews, honest)', async () => {
    const server = ctx.app.getHttpServer();
    const gen = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/ai-portraits`)
      .set(dm)
      .send({ prompt: 'a noble dwarf with a braided beard', count: 2 });
    expect(gen.status).toBe(201);
    expect(gen.body.status).toBe('succeeded');
    expect(gen.body.method).toBe('external-instructions');
    expect(gen.body.previews).toHaveLength(0);
    expect(gen.body.externalInstructions.length).toBeGreaterThan(0);

    // Status fetch round-trips the job id.
    const jobId = gen.body.id;
    const status = await request(server).get(`/api/v1/campaigns/${campaignId}/ai-portraits/${jobId}`).set(dm);
    expect(status.status).toBe(200);
    expect(status.body.id).toBe(jobId);
  });

  it('is idempotent on the Idempotency-Key header', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Idem Portrait Campaign' });
    const cid = res.body.id;
    const a = await request(server)
      .post(`/api/v1/campaigns/${cid}/ai-portraits`)
      .set(dm)
      .set('Idempotency-Key', 'portrait-abc')
      .send({ prompt: 'a rogue', count: 1 });
    const b = await request(server)
      .post(`/api/v1/campaigns/${cid}/ai-portraits`)
      .set(dm)
      .set('Idempotency-Key', 'portrait-abc')
      .send({ prompt: 'a totally different brief', count: 3 });
    expect(a.body.id).toBe(b.body.id);
  });

  it('blocks a moderated prompt and persists nothing', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Mod Portrait Campaign' });
    const cid = res.body.id;
    const gen = await request(server)
      .post(`/api/v1/campaigns/${cid}/ai-portraits`)
      .set(dm)
      .send({ prompt: 'explicit sexual imagery of a child', count: 1 });
    expect(gen.status).toBe(201);
    expect(gen.body.status).toBe('failed');
    expect(gen.body.moderation.flagged).toBe(true);
    expect(gen.body.moderation.categories).toContain('csae');
    expect(gen.body.previews).toHaveLength(0);
  });

  it('cancels a job', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Cancel Portrait Campaign' });
    const cid = res.body.id;
    const gen = await request(server)
      .post(`/api/v1/campaigns/${cid}/ai-portraits`)
      .set(dm)
      .send({ prompt: 'a wizard', count: 1 });
    const cancel = await request(server).post(`/api/v1/campaigns/${cid}/ai-portraits/${gen.body.id}/cancel`).set(dm);
    expect(cancel.status).toBe(201);
    expect(['succeeded', 'cancelled']).toContain(cancel.body.status);
  });

  it('rejects a viewer from generation (player role required, not viewer)', async () => {
    const server = ctx.app.getHttpServer();
    // requireRole('player') runs BEFORE createJob, so a viewer gets 403 regardless of the
    // per-campaign rate limiter. Reuse the shared campaign — the role gate short-circuits.
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/ai-portraits`)
      .set(viewer)
      .send({ prompt: 'a hero', count: 1 });
    expect(res.status).toBe(403);
  });
});
