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

  it('a non-dm member CAN list their own proposals (self-view), but not approve/reject (#124)', async () => {
    // The player filed the quest-update proposal above — they can now see it.
    const listRes = await playerAgent.get(`/api/v1/campaigns/${campaignId}/proposals`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.length).toBeGreaterThanOrEqual(1);
    expect(listRes.body.every((p: { proposerUserId: string }) => p.proposerUserId === String(playerId))).toBe(true);

    const pendingRes = await dmAgent.get(`/api/v1/campaigns/${campaignId}/proposals?status=pending`);
    const proposalId = pendingRes.body[0].id;

    // Reviewing (approve/reject) is still DM-only.
    const approveRes = await playerAgent.post(`/api/v1/proposals/${proposalId}/approve`).send({});
    expect(approveRes.status).toBe(403);
    const rejectRes = await playerAgent.post(`/api/v1/proposals/${proposalId}/reject`).send({});
    expect(rejectRes.status).toBe(403);
  });

  it('the self-view is scoped: a member sees only their OWN proposals, not another member\'s (#124)', async () => {
    // The player has proposals; the viewer proposed a create earlier too. Each sees
    // only their own; neither sees the other's.
    const playerList = await playerAgent.get(`/api/v1/campaigns/${campaignId}/proposals`);
    const viewerList = await viewerAgent.get(`/api/v1/campaigns/${campaignId}/proposals`);
    expect(playerList.status).toBe(200);
    expect(viewerList.status).toBe(200);
    expect(playerList.body.every((p: { proposerUserId: string }) => p.proposerUserId === String(playerId))).toBe(true);
    expect(viewerList.body.every((p: { proposerUserId: string }) => p.proposerUserId === String(viewerId))).toBe(true);
    // No cross-contamination: none of the player's ids appear in the viewer's list.
    const playerIds = new Set(playerList.body.map((p: { id: number }) => p.id));
    expect(viewerList.body.some((p: { id: number }) => playerIds.has(p.id))).toBe(false);
    // The DM sees a superset (everyone's).
    const dmList = await dmAgent.get(`/api/v1/campaigns/${campaignId}/proposals`);
    expect(dmList.body.length).toBeGreaterThan(playerList.body.length);
  });

  it('proposer is attributed to the USER (display name + user id), not a token name (#124)', async () => {
    const proposeRes = await playerAgent
      .post(`/api/v1/campaigns/${campaignId}/quests?proposed=true`)
      .send({ title: 'Attribution Quest' });
    expect(proposeRes.status).toBe(202);
    const p = proposeRes.body.proposal;
    // Human-readable proposer is the user's display name — never a `token:...` string.
    expect(p.proposer).toBe('prop-player');
    expect(p.proposer.startsWith('token:')).toBe(false);
    expect(p.proposerUserId).toBe(String(playerId));
    // Submitted over a cookie session, so no token provenance.
    expect(p.proposerToken).toBeNull();
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

    // re-approving an already-resolved proposal is a 409 (atomic CAS, issue #85)
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

  // ---------- #98: delete proposal action ----------

  it('member proposes a delete -> 202 pending, entity untouched; dm approves -> entity removed', async () => {
    const questRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/quests`).send({ title: 'Doomed Quest', reward: '3gp' });
    const doomedId = questRes.body.id;

    const proposeRes = await playerAgent.delete(`/api/v1/quests/${doomedId}?proposed=true`);
    expect(proposeRes.status).toBe(202);
    expect(proposeRes.body.proposal.action).toBe('delete');
    expect(proposeRes.body.proposal.entityType).toBe('quest');
    expect(proposeRes.body.proposal.entityId).toBe(doomedId);
    // Delete proposals snapshot the target so the DM sees what would be removed.
    expect(proposeRes.body.proposal.snapshot).toBeDefined();
    expect(proposeRes.body.proposal.snapshot.title).toBe('Doomed Quest');
    const proposalId = proposeRes.body.proposal.id;

    // Entity is still there until approved.
    expect((await dmAgent.get(`/api/v1/quests/${doomedId}`)).status).toBe(200);

    const approveRes = await dmAgent.post(`/api/v1/proposals/${proposalId}/approve`).send({});
    expect(approveRes.status).toBe(201);
    expect(approveRes.body.status).toBe('approved');

    // The delete was applied through the normal remove path.
    expect((await dmAgent.get(`/api/v1/quests/${doomedId}`)).status).toBe(404);
  });

  // ---------- #98: character proposals (create + update) ----------

  it('member proposes a character create -> 202; dm approves -> character exists', async () => {
    const proposeRes = await playerAgent
      .post(`/api/v1/campaigns/${campaignId}/characters?proposed=true`)
      .send({ name: 'Proposed Hero' });
    expect(proposeRes.status).toBe(202);
    expect(proposeRes.body.proposal.action).toBe('create');
    expect(proposeRes.body.proposal.entityType).toBe('character');
    expect(proposeRes.body.proposal.snapshot).toBeNull();
    const proposalId = proposeRes.body.proposal.id;

    // Not created yet.
    let listRes = await dmAgent.get(`/api/v1/campaigns/${campaignId}/characters`);
    expect(listRes.body.some((c: { name: string }) => c.name === 'Proposed Hero')).toBe(false);

    const approveRes = await dmAgent.post(`/api/v1/proposals/${proposalId}/approve`).send({});
    expect(approveRes.status).toBe(201);

    listRes = await dmAgent.get(`/api/v1/campaigns/${campaignId}/characters`);
    expect(listRes.body.some((c: { name: string }) => c.name === 'Proposed Hero')).toBe(true);
  });

  it('member proposes a character update -> 202 with before-snapshot; dm approves applies it', async () => {
    const created = await dmAgent.post(`/api/v1/campaigns/${campaignId}/characters`).send({ name: 'Update Me' });
    const characterId = created.body.id;

    const proposeRes = await playerAgent
      .patch(`/api/v1/characters/${characterId}?proposed=true`)
      .send({ name: 'Renamed Hero' });
    expect(proposeRes.status).toBe(202);
    expect(proposeRes.body.proposal.action).toBe('update');
    expect(proposeRes.body.proposal.entityType).toBe('character');
    expect(proposeRes.body.proposal.snapshot.name).toBe('Update Me');
    const proposalId = proposeRes.body.proposal.id;

    // Unchanged until approved.
    expect((await dmAgent.get(`/api/v1/characters/${characterId}`)).body.name).toBe('Update Me');

    await dmAgent.post(`/api/v1/proposals/${proposalId}/approve`).send({});
    expect((await dmAgent.get(`/api/v1/characters/${characterId}`)).body.name).toBe('Renamed Hero');
  });

  // ---------- #98: edit-before-approve ----------

  it('dm approves with an amended payload -> the edited values are applied, not the proposed ones', async () => {
    const proposeRes = await playerAgent
      .post(`/api/v1/campaigns/${campaignId}/quests?proposed=true`)
      .send({ title: '90% Right Quest', reward: '1gp' });
    expect(proposeRes.status).toBe(202);
    const proposalId = proposeRes.body.proposal.id;

    const approveRes = await dmAgent
      .post(`/api/v1/proposals/${proposalId}/approve`)
      .send({ payload: { title: 'Fixed By DM', reward: '100gp' }, note: 'tweaked before approving' });
    expect(approveRes.status).toBe(201);
    expect(approveRes.body.status).toBe('approved');
    // The stored proposal payload reflects the amendment.
    expect(approveRes.body.payload.title).toBe('Fixed By DM');

    const questsRes = await dmAgent.get(`/api/v1/campaigns/${campaignId}/quests`);
    expect(questsRes.body.some((q: { title: string; reward: string }) => q.title === 'Fixed By DM' && q.reward === '100gp')).toBe(true);
    // The original proposed title was never written.
    expect(questsRes.body.some((q: { title: string }) => q.title === '90% Right Quest')).toBe(false);
  });

  it('an invalid amended payload is rejected (400) and nothing is applied', async () => {
    const proposeRes = await playerAgent
      .post(`/api/v1/campaigns/${campaignId}/quests?proposed=true`)
      .send({ title: 'Guard Rail Quest' });
    const proposalId = proposeRes.body.proposal.id;

    // title must be a non-empty string — an amended payload with an empty title fails schema validation.
    const approveRes = await dmAgent
      .post(`/api/v1/proposals/${proposalId}/approve`)
      .send({ payload: { title: '' } });
    expect(approveRes.status).toBe(400);

    // Still pending — the failed approve did not resolve it.
    const pendingRes = await dmAgent.get(`/api/v1/campaigns/${campaignId}/proposals?status=pending`);
    expect(pendingRes.body.some((p: { id: number }) => p.id === proposalId)).toBe(true);
  });

  // ---------- #98: batch resolve ----------

  it('dm batch-approves multiple proposals in one call', async () => {
    const a = await playerAgent.post(`/api/v1/campaigns/${campaignId}/quests?proposed=true`).send({ title: 'Batch A' });
    const b = await playerAgent.post(`/api/v1/campaigns/${campaignId}/quests?proposed=true`).send({ title: 'Batch B' });
    const ids = [a.body.proposal.id, b.body.proposal.id];

    const batchRes = await dmAgent.post(`/api/v1/proposals/batch/approve`).send({ ids, note: 'bulk ok' });
    expect(batchRes.status).toBe(201);
    expect(batchRes.body.results).toHaveLength(2);
    expect(batchRes.body.results.every((r: { ok: boolean }) => r.ok)).toBe(true);

    const questsRes = await dmAgent.get(`/api/v1/campaigns/${campaignId}/quests`);
    expect(questsRes.body.some((q: { title: string }) => q.title === 'Batch A')).toBe(true);
    expect(questsRes.body.some((q: { title: string }) => q.title === 'Batch B')).toBe(true);
  });

  it('dm batch-rejects multiple proposals in one call', async () => {
    const a = await playerAgent.post(`/api/v1/campaigns/${campaignId}/quests?proposed=true`).send({ title: 'Reject A' });
    const b = await playerAgent.post(`/api/v1/campaigns/${campaignId}/quests?proposed=true`).send({ title: 'Reject B' });
    const ids = [a.body.proposal.id, b.body.proposal.id];

    const batchRes = await dmAgent.post(`/api/v1/proposals/batch/reject`).send({ ids });
    expect(batchRes.status).toBe(201);
    expect(batchRes.body.results.every((r: { ok: boolean }) => r.ok)).toBe(true);

    const rejectedRes = await dmAgent.get(`/api/v1/campaigns/${campaignId}/proposals?status=rejected`);
    expect(ids.every((id) => rejectedRes.body.some((p: { id: number }) => p.id === id))).toBe(true);

    const questsRes = await dmAgent.get(`/api/v1/campaigns/${campaignId}/quests`);
    expect(questsRes.body.some((q: { title: string }) => q.title === 'Reject A')).toBe(false);
  });

  it('batch approve reports per-id failure without aborting the rest', async () => {
    const good = await playerAgent.post(`/api/v1/campaigns/${campaignId}/quests?proposed=true`).send({ title: 'Partial OK' });
    const goodId = good.body.proposal.id;
    const missingId = 9_999_999;

    const batchRes = await dmAgent.post(`/api/v1/proposals/batch/approve`).send({ ids: [goodId, missingId] });
    expect(batchRes.status).toBe(201);
    const byId = Object.fromEntries(batchRes.body.results.map((r: { id: number }) => [r.id, r]));
    expect(byId[goodId].ok).toBe(true);
    expect(byId[missingId].ok).toBe(false);
    expect(byId[missingId].status).toBe(404);

    // The good one still applied.
    const questsRes = await dmAgent.get(`/api/v1/campaigns/${campaignId}/quests`);
    expect(questsRes.body.some((q: { title: string }) => q.title === 'Partial OK')).toBe(true);
  });

  it('non-dm cannot batch-approve (per-item access is enforced)', async () => {
    const p = await playerAgent.post(`/api/v1/campaigns/${campaignId}/quests?proposed=true`).send({ title: 'Player Batch Attempt' });
    const proposalId = p.body.proposal.id;

    const batchRes = await playerAgent.post(`/api/v1/proposals/batch/approve`).send({ ids: [proposalId] });
    expect(batchRes.status).toBe(201);
    expect(batchRes.body.results[0].ok).toBe(false);
    expect(batchRes.body.results[0].status).toBe(403);

    // Untouched.
    const pendingRes = await dmAgent.get(`/api/v1/campaigns/${campaignId}/proposals?status=pending`);
    expect(pendingRes.body.some((pp: { id: number }) => pp.id === proposalId)).toBe(true);
  });

  // ---------- #124: entityId backfill on create-approve ----------

  it('approving a CREATE proposal backfills the created entityId onto the proposal (#124)', async () => {
    const proposeRes = await playerAgent
      .post(`/api/v1/campaigns/${campaignId}/quests?proposed=true`)
      .send({ title: 'Backfill Quest', reward: '7gp' });
    expect(proposeRes.status).toBe(202);
    const proposalId = proposeRes.body.proposal.id;
    // A create proposal has no target yet.
    expect(proposeRes.body.proposal.entityId).toBeNull();

    const approveRes = await dmAgent.post(`/api/v1/proposals/${proposalId}/approve`).send({});
    expect(approveRes.status).toBe(201);
    // The approve response reflects the backfilled id...
    expect(typeof approveRes.body.entityId).toBe('number');
    const createdId = approveRes.body.entityId;

    // ...and it points at the actual created quest.
    const questRes = await dmAgent.get(`/api/v1/quests/${createdId}`);
    expect(questRes.status).toBe(200);
    expect(questRes.body.title).toBe('Backfill Quest');

    // The persisted proposal record also carries the backfilled entityId.
    const listRes = await dmAgent.get(`/api/v1/campaigns/${campaignId}/proposals?status=approved`);
    const row = listRes.body.find((p: { id: number }) => p.id === proposalId);
    expect(row.entityId).toBe(createdId);
  });

  // ---------- #124: proposer attribution over a PAT resolves to the owning user ----------

  it('a proposal submitted over a PAT is attributed to the owning USER, with the token as secondary provenance (#124)', async () => {
    // The player mints their own PAT and submits a proposal with it.
    const tokenRes = await playerAgent.post(`/api/v1/tokens`).send({ name: 'r4verify', scope: 'player' });
    expect(tokenRes.status).toBe(201);
    const token = tokenRes.body.token;

    const proposeRes = await request(ctx.app.getHttpServer())
      .post(`/api/v1/campaigns/${campaignId}/quests?proposed=true`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Token-Submitted Quest' });
    expect(proposeRes.status).toBe(202);
    const p = proposeRes.body.proposal;
    // Attributed to the human user, NOT `token:r4verify`.
    expect(p.proposer).toBe('prop-player');
    expect(p.proposerUserId).toBe(String(playerId));
    // Token name kept as secondary provenance.
    expect(p.proposerToken).toBe('r4verify');

    // And it lands in the owning user's self-view (submitted via their token).
    const selfView = await playerAgent.get(`/api/v1/campaigns/${campaignId}/proposals`);
    expect(selfView.body.some((row: { id: number }) => row.id === p.id)).toBe(true);
  });

  // ---------- #124: revise + withdraw loop ----------

  it('a proposer can revise their own pending proposal; a non-proposer cannot (#124)', async () => {
    const proposeRes = await playerAgent
      .post(`/api/v1/campaigns/${campaignId}/quests?proposed=true`)
      .send({ title: 'Draft Title', reward: '1gp' });
    const proposalId = proposeRes.body.proposal.id;

    // Another member (the viewer) cannot revise someone else's proposal.
    const forbidden = await viewerAgent.patch(`/api/v1/proposals/${proposalId}`).send({ payload: { title: 'Hijacked' } });
    expect(forbidden.status).toBe(403);

    // The proposer revises the payload.
    const reviseRes = await playerAgent.patch(`/api/v1/proposals/${proposalId}`).send({ payload: { title: 'Revised Title', reward: '2gp' } });
    expect(reviseRes.status).toBe(200);
    expect(reviseRes.body.payload.title).toBe('Revised Title');
    expect(reviseRes.body.status).toBe('pending');

    // An invalid revision is rejected (400) and nothing is stored.
    const badRevise = await playerAgent.patch(`/api/v1/proposals/${proposalId}`).send({ payload: { title: '' } });
    expect(badRevise.status).toBe(400);

    // When the DM approves, the REVISED payload is what applies.
    const approveRes = await dmAgent.post(`/api/v1/proposals/${proposalId}/approve`).send({});
    expect(approveRes.status).toBe(201);
    const questsRes = await dmAgent.get(`/api/v1/campaigns/${campaignId}/quests`);
    expect(questsRes.body.some((q: { title: string }) => q.title === 'Revised Title')).toBe(true);
    expect(questsRes.body.some((q: { title: string }) => q.title === 'Draft Title')).toBe(false);
  });

  it('a proposer can withdraw their own pending proposal; a non-proposer cannot, and it no longer applies (#124)', async () => {
    const proposeRes = await playerAgent
      .post(`/api/v1/campaigns/${campaignId}/quests?proposed=true`)
      .send({ title: 'Withdraw Me' });
    const proposalId = proposeRes.body.proposal.id;

    // A non-proposer cannot withdraw it.
    const forbidden = await viewerAgent.post(`/api/v1/proposals/${proposalId}/withdraw`).send({});
    expect(forbidden.status).toBe(403);

    // The proposer withdraws it.
    const withdrawRes = await playerAgent.post(`/api/v1/proposals/${proposalId}/withdraw`).send({});
    expect(withdrawRes.status).toBe(201);
    expect(withdrawRes.body.status).toBe('withdrawn');

    // It is now terminal — a DM approve is a 409 no-op and no quest is created.
    const approveRes = await dmAgent.post(`/api/v1/proposals/${proposalId}/approve`).send({});
    expect(approveRes.status).toBe(409);
    const questsRes = await dmAgent.get(`/api/v1/campaigns/${campaignId}/quests`);
    expect(questsRes.body.some((q: { title: string }) => q.title === 'Withdraw Me')).toBe(false);

    // Withdrawing again (already terminal) is a 409.
    const again = await playerAgent.post(`/api/v1/proposals/${proposalId}/withdraw`).send({});
    expect(again.status).toBe(409);

    // The withdrawn proposal shows up in the proposer's own status filter.
    const withdrawnList = await playerAgent.get(`/api/v1/campaigns/${campaignId}/proposals?status=withdrawn`);
    expect(withdrawnList.body.some((p: { id: number }) => p.id === proposalId)).toBe(true);
  });

  // ---------- #85: atomicity (preserved on merge with main) ----------

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
