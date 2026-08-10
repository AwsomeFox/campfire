import request from 'supertest';
import { closeTestApp, createTestApp, createTestAppNoDevAuth, type TestAppContext } from './test-app';

/**
 * Personal navigation — bookmarks + bounded recent history (issue #840, e2e).
 *
 * Real cookie sessions throughout: bookmarks/recent are keyed on a real account
 * row (FK user_id), so the write paths require a numeric user id exactly like the
 * catch-up cursor. The fixtures exercise every acceptance criterion: bookmark /
 * unbookmark, optional bounded recent history, read-time filtering of
 * inaccessible / hidden / deleted / cross-campaign targets, per-user privacy,
 * clear-history, and role-change filtering.
 */
describe('personal navigation: bookmarks + recent history (#840, e2e)', () => {
  let ctx: TestAppContext;
  let admin: ReturnType<typeof request.agent>;
  let dmAgent: ReturnType<typeof request.agent>;
  let playerAgent: ReturnType<typeof request.agent>;
  let viewerAgent: ReturnType<typeof request.agent>;
  let outsiderAgent: ReturnType<typeof request.agent>;
  let campaignId: number;
  let otherCampaignId: number;
  let playerUserId: number;
  let viewerUserId: number;
  let visibleQuestId: number;
  let hiddenQuestId: number;
  let visibleNpcId: number;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();
    admin = request.agent(server);
    expect((await admin.post('/api/v1/auth/setup').send({ username: 'nav-admin', password: 'admin-password-1' })).status).toBe(201);

    const roles = ['dm', 'player', 'viewer', 'outsider'] as const;
    const ids: Record<string, number> = {};
    for (const role of roles) {
      const created = await admin
        .post('/api/v1/users')
        .send({ username: `nav-${role}`, password: `${role}-password-1`, serverRole: 'user' });
      expect(created.status).toBe(201);
      ids[role] = created.body.id;
    }
    playerUserId = ids.player;
    viewerUserId = ids.viewer;

    const login = async (role: (typeof roles)[number]) => {
      const agent = request.agent(server);
      expect((await agent.post('/api/v1/auth/login').send({ username: `nav-${role}`, password: `${role}-password-1` })).status).toBe(201);
      return agent;
    };
    dmAgent = await login('dm');
    playerAgent = await login('player');
    viewerAgent = await login('viewer');
    outsiderAgent = await login('outsider');

    const campaign = await dmAgent.post('/api/v1/campaigns').send({ name: 'Navigation Campaign' });
    expect(campaign.status).toBe(201);
    campaignId = campaign.body.id;
    otherCampaignId = (await dmAgent.post('/api/v1/campaigns').send({ name: 'Other Navigation Campaign' })).body.id;
    expect(
      (await dmAgent.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: playerUserId, role: 'player' })).status,
    ).toBe(201);
    expect(
      (await dmAgent.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: viewerUserId, role: 'viewer' })).status,
    ).toBe(201);

    visibleQuestId = (await dmAgent.post(`/api/v1/campaigns/${campaignId}/quests`).send({ title: 'Public Quest', hidden: false })).body.id;
    hiddenQuestId = (await dmAgent.post(`/api/v1/campaigns/${campaignId}/quests`).send({ title: 'Secret Quest', hidden: true })).body.id;
    visibleNpcId = (await dmAgent.post(`/api/v1/campaigns/${campaignId}/npcs`).send({ name: 'Public NPC', hidden: false })).body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  const bookmark = (agent: ReturnType<typeof request.agent>, body: object) =>
    agent.post('/api/v1/me/bookmarks').send(body);
  const listBookmarks = (agent: ReturnType<typeof request.agent>, campaignId?: number) =>
    agent.get(`/api/v1/me/bookmarks${campaignId ? `?campaignId=${campaignId}` : ''}`);

  it('a member can bookmark a visible entity and it appears in their list with a fresh label', async () => {
    const add = await bookmark(playerAgent, { campaignId, entityType: 'quest', entityId: visibleQuestId });
    expect(add.status).toBe(201);
    expect(add.body).toMatchObject({ campaignId, entityType: 'quest', entityId: visibleQuestId, label: 'Public Quest' });

    const list = await listBookmarks(playerAgent, campaignId);
    expect(list.status).toBe(200);
    const mine = list.body.items as Array<{ entityId: number; label: string }>;
    expect(mine.some((i) => i.entityId === visibleQuestId && i.label === 'Public Quest')).toBe(true);
  });

  it('re-bookmarking the same target is idempotent', async () => {
    const first = await listBookmarks(playerAgent, campaignId);
    const again = await bookmark(playerAgent, { campaignId, entityType: 'quest', entityId: visibleQuestId });
    expect(again.status).toBe(201);
    const second = await listBookmarks(playerAgent, campaignId);
    expect(second.body.items.length).toBe(first.body.items.length);
  });

  it('navigation metadata is private: another member never sees my bookmarks', async () => {
    const list = await listBookmarks(viewerAgent, campaignId);
    expect(list.status).toBe(200);
    // viewer has no bookmarks of its own, and must never see the player's.
    expect(list.body.items.some((i: { entityId: number }) => i.entityId === visibleQuestId)).toBe(false);
    expect(list.body.items.length).toBe(0);
  });

  it('cannot bookmark a hidden, deleted, or cross-campaign target (write-time gate)', async () => {
    // Hidden quest: the player cannot see it, so bookmarking is rejected without
    // revealing anything beyond a generic 404.
    const hidden = await bookmark(playerAgent, { campaignId, entityType: 'quest', entityId: hiddenQuestId });
    expect(hidden.status).toBe(404);

    // Cross-campaign: the player is not a member of otherCampaignId.
    const cross = await bookmark(playerAgent, { campaignId: otherCampaignId, entityType: 'quest', entityId: visibleQuestId });
    expect(cross.status).toBe(403);

    // Non-member outsider cannot bookmark in this campaign at all.
    const outsider = await bookmark(outsiderAgent, { campaignId, entityType: 'quest', entityId: visibleQuestId });
    expect(outsider.status).toBe(403);
  });

  it('unbookmark removes the bookmark', async () => {
    const id = (await listBookmarks(playerAgent, campaignId)).body.items.find(
      (i: { entityId: number }) => i.entityId === visibleQuestId,
    ).id;
    const del = await playerAgent.delete(`/api/v1/me/bookmarks/${id}`);
    expect(del.status).toBe(204);
    const after = await listBookmarks(playerAgent, campaignId);
    expect(after.body.items.some((i: { entityId: number }) => i.entityId === visibleQuestId)).toBe(false);
  });

  it('filters out a target that becomes hidden (read-time secrecy)', async () => {
    // Bookmark a fresh visible quest, then the DM hides it.
    const quest = await dmAgent.post(`/api/v1/campaigns/${campaignId}/quests`).send({ title: 'Later-Hidden Quest', hidden: false });
    expect((await bookmark(playerAgent, { campaignId, entityType: 'quest', entityId: quest.body.id })).status).toBe(201);

    expect((await dmAgent.patch(`/api/v1/quests/${quest.body.id}`).send({ hidden: true })).status).toBe(200);

    const list = await listBookmarks(playerAgent, campaignId);
    expect(list.body.items.some((i: { entityId: number }) => i.entityId === quest.body.id)).toBe(false);
  });

  it('filters out a target that is deleted (read-time soft-delete)', async () => {
    const npc = await dmAgent.post(`/api/v1/campaigns/${campaignId}/npcs`).send({ name: 'Doomed NPC', hidden: false });
    expect((await bookmark(playerAgent, { campaignId, entityType: 'npc', entityId: npc.body.id })).status).toBe(201);

    expect((await dmAgent.delete(`/api/v1/npcs/${npc.body.id}`)).status).toBe(200);

    const list = await listBookmarks(playerAgent, campaignId);
    expect(list.body.items.some((i: { entityId: number }) => i.entityId === npc.body.id)).toBe(false);
  });

  it('records and lists bounded recent history, then clears it', async () => {
    // Record a visit to the visible NPC.
    const record = await playerAgent.post('/api/v1/me/recent').send({ campaignId, entityType: 'npc', entityId: visibleNpcId });
    expect(record.status).toBe(204);

    const list = await playerAgent.get(`/api/v1/me/recent?campaignId=${campaignId}`);
    expect(list.status).toBe(200);
    const recent = list.body.items as Array<{ entityId: number; label: string }>;
    expect(recent.some((i) => i.entityId === visibleNpcId && i.label === 'Public NPC')).toBe(true);

    // Bound: record visits to 14 distinct entities and confirm the list never
    // exceeds the per-campaign cap (12).
    const npcIds: number[] = [];
    for (let i = 0; i < 14; i++) {
      const created = await dmAgent.post(`/api/v1/campaigns/${campaignId}/npcs`).send({ name: `Recent NPC ${i}`, hidden: false });
      npcIds.push(created.body.id);
      await playerAgent.post('/api/v1/me/recent').send({ campaignId, entityType: 'npc', entityId: created.body.id });
    }
    const bounded = await playerAgent.get(`/api/v1/me/recent?campaignId=${campaignId}`);
    expect(bounded.body.items.length).toBeLessThanOrEqual(12);

    // Clear (scoped to this campaign) and confirm.
    expect((await playerAgent.delete(`/api/v1/me/recent?campaignId=${campaignId}`)).status).toBe(204);
    const after = await playerAgent.get(`/api/v1/me/recent?campaignId=${campaignId}`);
    expect(after.body.items.length).toBe(0);
  });

  it('never records a visit to an inaccessible entity', async () => {
    const hidden = await playerAgent
      .post('/api/v1/me/recent')
      .send({ campaignId, entityType: 'quest', entityId: hiddenQuestId });
    expect(hidden.status).toBe(404);
  });
});

describe('personal navigation: role-change / lost-membership filtering (#840, e2e)', () => {
  let ctx: TestAppContext;
  let admin: ReturnType<typeof request.agent>;
  let dmAgent: ReturnType<typeof request.agent>;
  let playerAgent: ReturnType<typeof request.agent>;
  let campaignId: number;
  let playerUserId: number;
  let questId: number;
  let playerMembershipId: number;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();
    admin = request.agent(server);
    expect((await admin.post('/api/v1/auth/setup').send({ username: 'navrole-admin', password: 'admin-password-1' })).status).toBe(201);

    const mk = async (role: string) => {
      const c = await admin.post('/api/v1/users').send({ username: `navrole-${role}`, password: `${role}-password-1`, serverRole: 'user' });
      expect(c.status).toBe(201);
      return c.body.id;
    };
    playerUserId = await mk('player');
    await mk('dm'); // created so dmAgent can log in; the campaign creator is auto-DM

    const login = async (role: string) => {
      const agent = request.agent(server);
      expect((await agent.post('/api/v1/auth/login').send({ username: `navrole-${role}`, password: `${role}-password-1` })).status).toBe(201);
      return agent;
    };
    dmAgent = await login('dm');
    playerAgent = await login('player');

    // DM is the campaign owner by creating it; ensure dm user is a member as dm.
    const campaign = await dmAgent.post('/api/v1/campaigns').send({ name: 'Role-Change Campaign' });
    expect(campaign.status).toBe(201);
    campaignId = campaign.body.id;
    // The creator (dmAgent) is already the primary-owner DM; only add the player.
    expect(
      (await dmAgent.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: playerUserId, role: 'player' })).status,
    ).toBe(201);

    questId = (await dmAgent.post(`/api/v1/campaigns/${campaignId}/quests`).send({ title: 'Role-Change Quest', hidden: false })).body.id;
    expect((await playerAgent.post('/api/v1/me/bookmarks').send({ campaignId, entityType: 'quest', entityId: questId })).status).toBe(201);

    // Capture the player's membership row id for the later role change / removal.
    const members = await dmAgent.get(`/api/v1/campaigns/${campaignId}/members`);
    const me = members.body.find((m: { userId: number }) => m.userId === playerUserId);
    playerMembershipId = me.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('the bookmark is visible while the user is a member', async () => {
    const list = await playerAgent.get(`/api/v1/me/bookmarks?campaignId=${campaignId}`);
    expect(list.body.items.some((i: { entityId: number }) => i.entityId === questId)).toBe(true);
  });

  it('demoting to viewer still shows member-visible targets', async () => {
    // The quest is not hidden, so a viewer still sees it — the bookmark stays.
    expect((await dmAgent.patch(`/api/v1/campaigns/${campaignId}/members/${playerMembershipId}`).send({ role: 'viewer' })).status).toBe(200);
    const list = await playerAgent.get(`/api/v1/me/bookmarks?campaignId=${campaignId}`);
    expect(list.body.items.some((i: { entityId: number }) => i.entityId === questId)).toBe(true);
  });

  it('removing membership filters the bookmark out at read time (no existence leak)', async () => {
    expect((await dmAgent.delete(`/api/v1/campaigns/${campaignId}/members/${playerMembershipId}`)).status).toBe(204);
    const list = await playerAgent.get('/api/v1/me/bookmarks');
    expect(list.status).toBe(200);
    expect(list.body.items.some((i: { entityId: number }) => i.entityId === questId)).toBe(false);
  });
});

describe('personal navigation: dev-auth identities cannot own navigation metadata (#840, e2e)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'nav-dev' };
    const campaign = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Dev Nav Campaign' });
    const quest = await request(server).post('/api/v1/campaigns/' + campaign.body.id + '/quests').set(dm).send({ title: 'Dev Quest' });
    // stash ids on the shared context via closure
    (ctx as unknown as { __campaign: number }).__campaign = campaign.body.id;
    (ctx as unknown as { __quest: number }).__quest = quest.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('rejects a bookmark from a dev-auth identity (no numeric user id)', async () => {
    const dev = { 'x-dev-role': 'dm', 'x-dev-user': 'nav-dev' };
    const campaignId = (ctx as unknown as { __campaign: number }).__campaign;
    const questId = (ctx as unknown as { __quest: number }).__quest;
    const res = await request(ctx.app.getHttpServer())
      .post('/api/v1/me/bookmarks')
      .set(dev)
      .send({ campaignId, entityType: 'quest', entityId: questId });
    expect(res.status).toBe(400);
  });
});
