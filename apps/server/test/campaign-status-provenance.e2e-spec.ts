import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };
const player = { 'x-dev-role': 'player', 'x-dev-user': 'p-1' };

/**
 * Issue #846 — campaign archive provenance: every lifecycle-status change
 * (active ↔ paused ↔ completed) records a durable, append-only transition
 * (actor / time / from→to / optional DM-only reason). Reactivation keeps the
 * full history; the reason is redacted for non-DM viewers; transitions
 * round-trip through export/import.
 *
 * These assertions are the invariant's guard: each one fails if the
 * persistence write in CampaignsService.update() / recordStatusTransition()
 * is reverted, which is the evidence the issue's acceptance criteria require.
 */
describe('campaign status-transition provenance (e2e)', () => {
  let ctx: TestAppContext;
  let server: ReturnType<TestAppContext['app']['getHttpServer']>;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer();

    const campRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Provenance Saga' });
    expect(campRes.status).toBe(201);
    campaignId = campRes.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('records a transition when archiving active → paused (with a DM-only reason)', async () => {
    const res = await request(server)
      .patch(`/api/v1/campaigns/${campaignId}`)
      .set(dm)
      .send({ status: 'paused', statusChangeReason: 'Pausing for the holidays.' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('paused');

    const listRes = await request(server).get(`/api/v1/campaigns/${campaignId}/status-transitions`).set(dm);
    expect(listRes.status).toBe(200);
    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0]).toMatchObject({
      fromStatus: 'active',
      toStatus: 'paused',
      reason: 'Pausing for the holidays.',
    });
    expect(listRes.body[0].actorName).toBeTruthy();
    expect(listRes.body[0].createdAt).toBeTruthy();
  });

  it('records a transition when reshuffling paused → completed', async () => {
    const res = await request(server).patch(`/api/v1/campaigns/${campaignId}`).set(dm).send({ status: 'completed' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');

    const listRes = await request(server).get(`/api/v1/campaigns/${campaignId}/status-transitions`).set(dm);
    expect(listRes.status).toBe(200);
    expect(listRes.body).toHaveLength(2);
    expect(listRes.body[0]).toMatchObject({ fromStatus: 'paused', toStatus: 'completed', reason: '' });
  });

  it('keeps the full history after reactivation (completed → active)', async () => {
    const res = await request(server).patch(`/api/v1/campaigns/${campaignId}`).set(dm).send({ status: 'active' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');

    const listRes = await request(server).get(`/api/v1/campaigns/${campaignId}/status-transitions`).set(dm);
    expect(listRes.status).toBe(200);
    // Three transitions, newest first: the reactivation is on top.
    expect(listRes.body).toHaveLength(3);
    expect(listRes.body[0]).toMatchObject({ fromStatus: 'completed', toStatus: 'active' });
    expect(listRes.body[2]).toMatchObject({ fromStatus: 'active', toStatus: 'paused' });
  });

  it('redacts the DM-only reason for non-DM viewers (player sees actor + status + time only)', async () => {
    const listRes = await request(server).get(`/api/v1/campaigns/${campaignId}/status-transitions`).set(player);
    expect(listRes.status).toBe(200);
    expect(listRes.body).toHaveLength(3);
    // The pause transition (the one with a reason) must arrive reason-less to a player.
    const pauseRow = listRes.body.find((t: { fromStatus: string; toStatus: string }) => t.fromStatus === 'active' && t.toStatus === 'paused');
    expect(pauseRow).toBeDefined();
    expect(pauseRow.reason).toBe('');
    // Player-visible fields are intact.
    expect(pauseRow.actorName).toBeTruthy();
    expect(pauseRow.createdAt).toBeTruthy();
  });

  it('ignores statusChangeReason when status is unchanged (no spurious transition)', async () => {
    const before = await request(server).get(`/api/v1/campaigns/${campaignId}/status-transitions`).set(dm);
    // A metadata-only PATCH re-sending the same status + a reason must not record a transition.
    const res = await request(server)
      .patch(`/api/v1/campaigns/${campaignId}`)
      .set(dm)
      .send({ name: 'Provenance Saga Renamed', status: 'active', statusChangeReason: 'should be ignored' });
    expect(res.status).toBe(200);
    const after = await request(server).get(`/api/v1/campaigns/${campaignId}/status-transitions`).set(dm);
    expect(after.body).toHaveLength(before.body.length);
  });

  it('re-inserts transition history on import (legacy/ported campaigns keep their provenance)', async () => {
    const importRes = await request(server)
      .post('/api/v1/campaigns/import')
      .set(dm)
      .send({
        campaign: { name: 'Imported With History' },
        statusTransitions: [
          { actorUserId: 'legacy:dm', actorName: 'Old DM', fromStatus: 'active', toStatus: 'paused', reason: 'pre-export pause', createdAt: '2026-01-01T00:00:00.000Z' },
          { actorUserId: 'legacy:dm', actorName: 'Old DM', fromStatus: 'paused', toStatus: 'completed', reason: '', createdAt: '2026-02-01T00:00:00.000Z' },
        ],
      });
    expect(importRes.status).toBe(201);
    const newId = importRes.body.id;

    const listRes = await request(server).get(`/api/v1/campaigns/${newId}/status-transitions`).set(dm);
    expect(listRes.status).toBe(200);
    expect(listRes.body).toHaveLength(2);
    expect(listRes.body[0]).toMatchObject({ fromStatus: 'paused', toStatus: 'completed' });
    expect(listRes.body[1]).toMatchObject({ fromStatus: 'active', toStatus: 'paused', reason: 'pre-export pause' });
  });
});
