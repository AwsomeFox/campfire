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
    // Update proposals snapshot the target's current state at propose time,
    // so the DM review UI can render a real before/after diff.
    expect(res.body.proposal.snapshot).toBeDefined();
    expect(res.body.proposal.snapshot.title).toBe('Original Title');
    expect(res.body.proposal.snapshot.reward).toBe('10gp');

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
    // Creates have no "before" state to snapshot.
    expect(res.body.proposal.snapshot).toBeNull();
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

    // re-approving is refused — the proposal is already resolved (409 conflict),
    // and re-approving must NOT re-apply the write.
    const reapproveRes = await dmAgent.post(`/api/v1/proposals/${updateProposal.id}/approve`).send({});
    expect(reapproveRes.status).toBe(409);
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

  it('snapshot is frozen at propose time, even if the entity changes before review', async () => {
    const questRes = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/quests`)
      .send({ title: 'Snapshot Quest', reward: '5gp' });
    const snapshotQuestId = questRes.body.id;

    const proposeRes = await playerAgent
      .patch(`/api/v1/quests/${snapshotQuestId}?proposed=true`)
      .send({ title: 'Snapshot Quest (proposed)', reward: '50gp' });
    expect(proposeRes.status).toBe(202);
    const proposalId = proposeRes.body.proposal.id;

    // DM edits the quest directly AFTER the proposal was filed.
    await dmAgent.patch(`/api/v1/quests/${snapshotQuestId}`).send({ title: 'Snapshot Quest (dm edited)' });

    // The proposal still shows the state as it was at propose time.
    const listRes = await dmAgent.get(`/api/v1/campaigns/${campaignId}/proposals?status=pending`);
    const proposal = listRes.body.find((p: { id: number }) => p.id === proposalId);
    expect(proposal).toBeDefined();
    expect(proposal.snapshot.title).toBe('Snapshot Quest');
    expect(proposal.snapshot.reward).toBe('5gp');
    expect(proposal.payload.title).toBe('Snapshot Quest (proposed)');
    expect(proposal.payload.reward).toBe('50gp');
  });

  // --- issue #85: atomic approve/reject ---

  it('concurrent double-approve of a CREATE proposal applies the write exactly once', async () => {
    // Baseline count of quests with this unique title (should be 0).
    const uniqueTitle = `Atomic Create ${Date.now()}`;
    const proposeRes = await playerAgent
      .post(`/api/v1/campaigns/${campaignId}/quests?proposed=true`)
      .send({ title: uniqueTitle, reward: '1gp' });
    expect(proposeRes.status).toBe(202);
    const proposalId = proposeRes.body.proposal.id;

    // Fire two approvals concurrently (DM double-click / web + MCP agent race).
    const [a, b] = await Promise.all([
      dmAgent.post(`/api/v1/proposals/${proposalId}/approve`).send({}),
      dmAgent.post(`/api/v1/proposals/${proposalId}/approve`).send({}),
    ]);

    // Exactly one wins (201), the other loses the CAS (409). Never two 201s.
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);

    // The create applied exactly once — no duplicate quest.
    const questsRes = await dmAgent.get(`/api/v1/campaigns/${campaignId}/quests`);
    const matches = questsRes.body.filter((q: { title: string }) => q.title === uniqueTitle);
    expect(matches.length).toBe(1);

    // Proposal is settled as approved.
    const settled = await dmAgent.get(`/api/v1/campaigns/${campaignId}/proposals`);
    const row = settled.body.find((p: { id: number }) => p.id === proposalId);
    expect(row.status).toBe('approved');
  });

  it('concurrent double-approve of an UPDATE proposal applies the write once (no double-apply)', async () => {
    const questRes = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/quests`)
      .send({ title: 'Update Race Quest', reward: '0gp' });
    const raceQuestId = questRes.body.id;

    const proposeRes = await playerAgent
      .patch(`/api/v1/quests/${raceQuestId}?proposed=true`)
      .send({ title: 'Update Race Quest (approved)' });
    const proposalId = proposeRes.body.proposal.id;

    const [a, b] = await Promise.all([
      dmAgent.post(`/api/v1/proposals/${proposalId}/approve`).send({}),
      dmAgent.post(`/api/v1/proposals/${proposalId}/approve`).send({}),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);

    const after = await dmAgent.get(`/api/v1/quests/${raceQuestId}`);
    expect(after.body.title).toBe('Update Race Quest (approved)');
  });

  it('concurrent approve vs reject resolves to a single outcome consistently', async () => {
    const questRes = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/quests`)
      .send({ title: 'Approve-Reject Race', reward: '0gp' });
    const raceQuestId = questRes.body.id;

    const proposeRes = await playerAgent
      .patch(`/api/v1/quests/${raceQuestId}?proposed=true`)
      .send({ title: 'Approve-Reject Race (applied)' });
    const proposalId = proposeRes.body.proposal.id;

    const [approveRes, rejectRes] = await Promise.all([
      dmAgent.post(`/api/v1/proposals/${proposalId}/approve`).send({}),
      dmAgent.post(`/api/v1/proposals/${proposalId}/reject`).send({}),
    ]);

    // Exactly one of the two wins the CAS (201); the other sees the resolved
    // state and gets 409. They must not both succeed.
    const statuses = [approveRes.status, rejectRes.status].sort();
    expect(statuses).toEqual([201, 409]);

    // The proposal ends in a single terminal state, and the entity reflects it:
    // approved -> the update landed; rejected -> the quest is unchanged. No
    // "rejected in the DB but the write landed anyway" split-brain.
    const settled = await dmAgent.get(`/api/v1/campaigns/${campaignId}/proposals`);
    const row = settled.body.find((p: { id: number }) => p.id === proposalId);
    const quest = await dmAgent.get(`/api/v1/quests/${raceQuestId}`);
    if (row.status === 'approved') {
      expect(quest.body.title).toBe('Approve-Reject Race (applied)');
    } else {
      expect(row.status).toBe('rejected');
      expect(quest.body.title).toBe('Approve-Reject Race');
    }
  });

  it('approve then reject (sequential): reject of an already-approved proposal is a 409 no-op', async () => {
    const questRes = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/quests`)
      .send({ title: 'Seq Approve Then Reject', reward: '0gp' });
    const seqQuestId = questRes.body.id;

    const proposeRes = await playerAgent
      .patch(`/api/v1/quests/${seqQuestId}?proposed=true`)
      .send({ title: 'Seq Approve Then Reject (applied)' });
    const proposalId = proposeRes.body.proposal.id;

    const approveRes = await dmAgent.post(`/api/v1/proposals/${proposalId}/approve`).send({});
    expect(approveRes.status).toBe(201);

    const rejectRes = await dmAgent.post(`/api/v1/proposals/${proposalId}/reject`).send({});
    expect(rejectRes.status).toBe(409);

    // Still approved, write still applied — reject did not overwrite the status.
    const settled = await dmAgent.get(`/api/v1/campaigns/${campaignId}/proposals`);
    const row = settled.body.find((p: { id: number }) => p.id === proposalId);
    expect(row.status).toBe('approved');
    const quest = await dmAgent.get(`/api/v1/quests/${seqQuestId}`);
    expect(quest.body.title).toBe('Seq Approve Then Reject (applied)');
  });
});
