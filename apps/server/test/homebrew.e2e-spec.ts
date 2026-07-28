import request from 'supertest';
import type { Server } from 'node:http';
import { closeTestApp, createTestApp, type TestAppContext } from './test-app';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'homebrew-dm' };

describe('campaign homebrew (e2e)', () => {
  let ctx: TestAppContext; let server: Server; let campaignId: number;
  beforeAll(async () => { ctx = await createTestApp(); server = ctx.app.getHttpServer() as Server; const campaign = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Homebrew test' }); campaignId = campaign.body.id; });
  afterAll(async () => closeTestApp(ctx));

  it('creates, isolates from global routes, revisions, CAS, archive and import conflict strategies', async () => {
    const body = { slug: 'spark', name: 'Spark', type: 'spell', summary: '', body: '', data: { level: 1, school: 'evocation' }, rightsStatus: 'private_original' };
    const created = await request(server).post(`/api/v1/campaigns/${campaignId}/homebrew`).set(dm).send(body); expect(created.status).toBe(201);
    expect((await request(server).get(`/api/v1/rules/entries/${created.body.id}`).set(dm)).status).toBe(404);
    const revision = await request(server).get(`/api/v1/campaigns/${campaignId}/homebrew/${created.body.id}/revisions`).set(dm); expect(revision.body).toHaveLength(1);
    const stale = await request(server).patch(`/api/v1/campaigns/${campaignId}/homebrew/${created.body.id}`).set(dm).send({ body: 'one', expectedUpdatedAt: 'stale' }); expect(stale.status).toBe(409);
    const preview = await request(server).post(`/api/v1/campaigns/${campaignId}/homebrew/import/preview`).set(dm).send({ entries: [body] }); expect(preview.body.entries[0].conflict.id).toBe(created.body.id);
    const skipped = await request(server).post(`/api/v1/campaigns/${campaignId}/homebrew/import/apply`).set(dm).send({ entries: [body], strategy: 'skip' }); expect(skipped.body.skipped).toBe(1);
    const staleReplace = await request(server).post(`/api/v1/campaigns/${campaignId}/homebrew/import/apply`).set(dm).send({ entries: [{ ...body, body: 'replace' }], strategy: 'replace', expectedUpdatedAt: { spark: 'stale' } }); expect(staleReplace.status).toBe(409);
    const duplicated = await request(server).post(`/api/v1/campaigns/${campaignId}/homebrew/import/apply`).set(dm).send({ entries: [body], strategy: 'duplicate' }); expect(duplicated.body.created).toBe(1);
    const beforeRollback = await request(server).get(`/api/v1/campaigns/${campaignId}/homebrew`).set(dm);
    const rollback = await request(server).post(`/api/v1/campaigns/${campaignId}/homebrew/import/apply`).set(dm).send({ entries: [{ ...body, slug: 'would-rollback' }, { ...body, slug: 'bad-raw', dataJson: '[]' }], strategy: 'duplicate' }); expect(rollback.status).toBe(400);
    const afterRollback = await request(server).get(`/api/v1/campaigns/${campaignId}/homebrew`).set(dm); expect(afterRollback.body).toHaveLength(beforeRollback.body.length);
    const proposal = await request(server).post(`/api/v1/campaigns/${campaignId}/homebrew?proposed=true`).set({ 'x-dev-role': 'player', 'x-dev-user': 'homebrew-player' }).send({ ...body, slug: 'proposed-spark' }); expect(proposal.status).toBe(201); expect(proposal.body.status).toBe('pending');
    const approved = await request(server).post(`/api/v1/proposals/${proposal.body.id}/approve`).set(dm).send({}); expect(approved.status).toBe(201);
    const proposedEntry = await request(server).get(`/api/v1/campaigns/${campaignId}/homebrew`).set(dm); expect(proposedEntry.body.some((entry: { slug: string }) => entry.slug === 'proposed-spark')).toBe(true);
    const archived = await request(server).post(`/api/v1/campaigns/${campaignId}/homebrew/${created.body.id}/archive`).set(dm).send({}); expect(archived.status).toBe(201);
    const listed = await request(server).get(`/api/v1/campaigns/${campaignId}/homebrew`).set(dm); expect(listed.body.some((entry: { id: number }) => entry.id === created.body.id)).toBe(false);
  });
});
