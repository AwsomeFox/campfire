import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };

/**
 * Genuine AI map generation REST flow (issue #410), end-to-end and OFFLINE. With no AI
 * provider configured (the default test app), generation routes honestly to the first-party
 * procedural-blueprint renderer — deterministic, no network. Covers create → status →
 * attach (hidden), readiness, idempotency, moderation, and cancel. Also validates that the
 * new AiMapModule wires cleanly into the Nest DI graph (the app boots).
 */
describe('AI map generation (e2e, issue #410)', () => {
  let ctx: TestAppContext;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    const res = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'AI Map Campaign' });
    campaignId = res.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('reports readiness (procedural-blueprint, grid likely) without spending', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/ai-maps/readiness`)
      .set(dm)
      .send({ prompt: 'a ruined dwarven hall', mode: 'battle-map', kind: 'dungeon', count: 2 });
    expect(res.status).toBe(201);
    expect(res.body.method).toBe('procedural-blueprint');
    expect(res.body.gridLikely).toBe(true);
    expect(res.body.doorsLikely).toBe(true);
    expect(res.body.cost.imageCount).toBe(0);
  });

  it('generates candidates, exposes status, and attaches a hidden map', async () => {
    const server = ctx.app.getHttpServer();
    const gen = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/ai-maps`)
      .set(dm)
      .send({ prompt: 'a flooded crypt with two corridors', mode: 'battle-map', kind: 'dungeon', theme: 'volcanic', count: 2 });
    expect(gen.status).toBe(201);
    expect(gen.body.status).toBe('succeeded');
    expect(gen.body.method).toBe('procedural-blueprint');
    expect(gen.body.previews).toHaveLength(2);
    expect(gen.body.previews[0].svg).toContain('<svg');
    // Honest provenance: never claims a text model drew it.
    expect(gen.body.previews[0].provenance.label).toMatch(/procedural renderer/i);

    const jobId = gen.body.id;
    const status = await request(server).get(`/api/v1/campaigns/${campaignId}/ai-maps/${jobId}`).set(dm);
    expect(status.status).toBe(200);
    expect(status.body.id).toBe(jobId);

    const attach = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/ai-maps/${jobId}/attach`)
      .set(dm)
      .send({ previewId: gen.body.previews[0].id });
    expect(attach.status).toBe(201);
    expect(attach.body.attachment.id).toBeGreaterThan(0);
    expect(attach.body.provenance.method).toBe('procedural-blueprint');

    // The stored attachment is a hidden SVG map.
    const meta = await request(server).get(`/api/v1/campaigns/${campaignId}/attachments`).set(dm);
    const row = meta.body.find((a: { id: number }) => a.id === attach.body.attachment.id);
    expect(row.kind).toBe('map');
    expect(row.mime).toBe('image/svg+xml');
    expect(row.hidden).toBe(true);
    expect(row).toMatchObject({
      title: expect.stringMatching(/^AI map/),
      altText: 'AI-generated battle map',
      license: 'AI-generated output',
      attribution: expect.stringMatching(/procedural renderer/i),
    });
  });

  it('is idempotent on the Idempotency-Key header', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Idem Campaign' });
    const cid = res.body.id;
    const a = await request(server)
      .post(`/api/v1/campaigns/${cid}/ai-maps`)
      .set(dm)
      .set('Idempotency-Key', 'abc123')
      .send({ prompt: 'a keep', mode: 'battle-map', count: 1 });
    const b = await request(server)
      .post(`/api/v1/campaigns/${cid}/ai-maps`)
      .set(dm)
      .set('Idempotency-Key', 'abc123')
      .send({ prompt: 'a totally different keep', mode: 'battle-map', count: 3 });
    expect(a.body.id).toBe(b.body.id);
    expect(b.body.previews).toHaveLength(1);
  });

  it('blocks a moderated prompt and persists nothing', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Mod Campaign' });
    const cid = res.body.id;
    const gen = await request(server)
      .post(`/api/v1/campaigns/${cid}/ai-maps`)
      .set(dm)
      .send({ prompt: 'explicit sexual imagery of a child', mode: 'battle-map', count: 1 });
    expect(gen.status).toBe(201);
    expect(gen.body.status).toBe('failed');
    expect(gen.body.moderation.flagged).toBe(true);
    expect(gen.body.previews).toHaveLength(0);
  });

  it('cancels a job', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Cancel Campaign' });
    const cid = res.body.id;
    const gen = await request(server)
      .post(`/api/v1/campaigns/${cid}/ai-maps`)
      .set(dm)
      .send({ prompt: 'a cave', mode: 'battle-map', kind: 'cave', count: 1 });
    const cancel = await request(server).post(`/api/v1/campaigns/${cid}/ai-maps/${gen.body.id}/cancel`).set(dm);
    expect(cancel.status).toBe(201);
    expect(['succeeded', 'cancelled']).toContain(cancel.body.status);
  });
});
