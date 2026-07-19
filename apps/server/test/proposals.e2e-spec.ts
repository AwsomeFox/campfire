import request from 'supertest';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';

describe('proposals (e2e, real cookie sessions)', () => {
  let ctx: TestAppContext;
  let dmAgent: ReturnType<typeof request.agent>;
  let playerAgent: ReturnType<typeof request.agent>;
  let viewerAgent: ReturnType<typeof request.agent>;
  let playerId: number;
  let viewerId: number;
  let campaignId: number;
  let questId: number;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    dmAgent = request.agent(server);
    await dmAgent.post('/api/v1/auth/setup').send({ username: 'prop-dm', password: 'dm-password-1' });

    const createPlayer = await dmAgent.post('/api/v1/users').send({ username: 'prop-player', password: 'player-password-1', serverRole: 'user' });
    playerId = createPlayer.body.id;
    const createViewer = await dmAgent.post('/api/v1/users').send({ username: 'prop-viewer', password: 'viewer-password-1', serverRole: 'user' });
    viewerId = createViewer.body.id;

    playerAgent = request.agent(server);
    await playerAgent.post('/api/v1/auth/login').send({ username: 'prop-player', password: 'player-password-1' });
    viewerAgent = request.agent(server);
    await viewerAgent.post('/api/v1/auth/login').send({ username: 'prop-viewer', password: 'viewer-password-1' });

    const campRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'Proposal Campaign' });
    campaignId = campRes.body.id;

    await dmAgent.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: playerId, role: 'player' });
    await dmAgent.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: viewerId, role: 'viewer' });

    const questRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/quests`).send({ title: 'Original Title', reward: '10gp' });
    questId = questRes.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('player proposes a quest update -> 202 + pending proposal, entity unchanged', async () => {
    const res = await playerAgent
      .patch(`/api/v1/quests/${questId}?proposed=true`)
      .send({ title: 'Player Suggested Title' });
    expect(res.status).toBe(202);
    expect(res.body.proposal.status).toBe('pending');
    expect(res.body.proposal.action).toBe('update');
    expect(res.body.proposal.entityType).toBe('quest');
    expect(res.body.proposal.entityId).toBe(questId);
    expect(res.body.proposal.payload.title).toBe('Player Suggested Title');

    const questRes = await dmAgent.get(`/api/v1/quests/${questId}`);
    expect(questRes.body.title).toBe('Original Title');
  });

  it('viewer can propose too (create)', async () => {
    const res = await viewerAgent
      .post(`/api/v1/campaigns/${campaignId}/quests?proposed=true`)
      .send({ title: 'Viewer Proposed Quest' });
    expect(res.status).toBe(202);
    expect(res.body.proposal.action).toBe('create');
    expect(res.body.proposal.entityType).toBe('quest');
  });

  it('non-dm cannot list or approve/reject proposals', async () => {
    const listRes = await playerAgent.get(`/api/v1/campaigns/${campaignId}/proposals`);
    expect(listRes.status).toBe(403);

    const pendingRes = await dmAgent.get(`/api/v1/campaigns/${campaignId}/proposals?status=pending`);
    const proposalId = pendingRes.body[0].id;

    const approveRes = await playerAgent.post(`/api/v1/proposals/${proposalId}/approve`).send({});
    expect(approveRes.status).toBe(403);
    const rejectRes = await playerAgent.post(`/api/v1/proposals/${proposalId}/reject`).send({});
    expect(rejectRes.status).toBe(403);
  });

  it('dm lists pending proposals', async () => {
    const res = await dmAgent.get(`/api/v1/campaigns/${campaignId}/proposals?status=pending`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(2);
  });

  it('dm approves the update proposal -> applies change + audit', async () => {
    const pendingRes = await dmAgent.get(`/api/v1/campaigns/${campaignId}/proposals?status=pending`);
    const updateProposal = pendingRes.body.find((p: { action: string; entityType: string }) => p.action === 'update' && p.entityType === 'quest');
    expect(updateProposal).toBeDefined();

    const approveRes = await dmAgent.post(`/api/v1/proposals/${updateProposal.id}/approve`).send({ note: 'looks good' });
    expect(approveRes.status).toBe(201);
    expect(approveRes.body.status).toBe('approved');
    expect(approveRes.body.note).toBe('looks good');

    const questRes = await dmAgent.get(`/api/v1/quests/${questId}`);
    expect(questRes.body.title).toBe('Player Suggested Title');

    const auditRes = await dmAgent.get(`/api/v1/campaigns/${campaignId}/audit`);
    expect(auditRes.body.some((a: { action: string }) => a.action === 'proposal.approve')).toBe(true);

    // re-approving is refused
    const reapproveRes = await dmAgent.post(`/api/v1/proposals/${updateProposal.id}/approve`).send({});
    expect(reapproveRes.status).toBe(403);
  });

  it('dm rejects the create proposal -> leaves entity unchanged, marks rejected', async () => {
    const pendingRes = await dmAgent.get(`/api/v1/campaigns/${campaignId}/proposals?status=pending`);
    const createProposal = pendingRes.body.find((p: { action: string; entityType: string }) => p.action === 'create' && p.entityType === 'quest');
    expect(createProposal).toBeDefined();

    const rejectRes = await dmAgent.post(`/api/v1/proposals/${createProposal.id}/reject`).send({ note: 'not needed' });
    expect(rejectRes.status).toBe(201);
    expect(rejectRes.body.status).toBe('rejected');

    const questsRes = await dmAgent.get(`/api/v1/campaigns/${campaignId}/quests`);
    expect(questsRes.body.some((q: { title: string }) => q.title === 'Viewer Proposed Quest')).toBe(false);
  });

  it('dm submitting with proposed=true still creates a proposal (does not apply directly)', async () => {
    const res = await dmAgent
      .patch(`/api/v1/quests/${questId}?proposed=true`)
      .send({ title: 'DM Proposed Title' });
    expect(res.status).toBe(202);
    expect(res.body.proposal.status).toBe('pending');

    const questRes = await dmAgent.get(`/api/v1/quests/${questId}`);
    expect(questRes.body.title).toBe('Player Suggested Title'); // unchanged until approved
  });
});
