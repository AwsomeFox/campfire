import request from 'supertest';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';

describe('membership + effective roles (e2e, real cookie sessions)', () => {
  let ctx: TestAppContext;
  let adminAgent: ReturnType<typeof request.agent>;
  let userA: ReturnType<typeof request.agent>;
  let userB: ReturnType<typeof request.agent>;
  let userBId: number;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    adminAgent = request.agent(server);
    await adminAgent.post('/api/v1/auth/setup').send({ username: 'root-admin', password: 'admin-password-1' });

    await adminAgent.post('/api/v1/users').send({ username: 'user-a', password: 'password-a-1', serverRole: 'user' });
    const createB = await adminAgent.post('/api/v1/users').send({ username: 'user-b', password: 'password-b-1', serverRole: 'user' });
    userBId = createB.body.id;

    userA = request.agent(server);
    await userA.post('/api/v1/auth/login').send({ username: 'user-a', password: 'password-a-1' });

    userB = request.agent(server);
    await userB.post('/api/v1/auth/login').send({ username: 'user-b', password: 'password-b-1' });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('user A creates a campaign and is auto-inserted as dm', async () => {
    const createRes = await userA.post('/api/v1/campaigns').send({ name: 'The Sunken Keep' });
    expect(createRes.status).toBe(201);
    campaignId = createRes.body.id;

    const meRes = await userA.get('/api/v1/me');
    expect(meRes.body.memberships.some((m: { campaignId: number; role: string }) => m.campaignId === campaignId && m.role === 'dm')).toBe(true);
  });

  it('user B (not a member) gets 403 on GET campaign', async () => {
    const res = await userB.get(`/api/v1/campaigns/${campaignId}`);
    expect(res.status).toBe(403);
  });

  it('A adds B as player; B can then read the campaign', async () => {
    const addRes = await userA.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: userBId, role: 'player' });
    expect(addRes.status).toBe(201);
    expect(addRes.body.role).toBe('player');
    expect(addRes.body.username).toBe('user-b');

    const getRes = await userB.get(`/api/v1/campaigns/${campaignId}`);
    expect(getRes.status).toBe(200);
  });

  it('B (player) cannot create a quest (403)', async () => {
    const res = await userB.post(`/api/v1/campaigns/${campaignId}/quests`).send({ title: 'Should fail' });
    expect(res.status).toBe(403);
  });

  it('B can tick an objective on a quest A creates', async () => {
    const questRes = await userA.post(`/api/v1/campaigns/${campaignId}/quests`).send({ title: 'Clear the cellar' });
    expect(questRes.status).toBe(201);
    const questId = questRes.body.id;

    const objRes = await userA.post(`/api/v1/quests/${questId}/objectives`).send({ text: 'Find the trapdoor' });
    expect(objRes.status).toBe(201);
    const objectiveId = objRes.body.id;

    const tickRes = await userB.patch(`/api/v1/quests/${questId}/objectives/${objectiveId}`).send({ done: true });
    expect(tickRes.status).toBe(200);
    expect(tickRes.body.done).toBe(true);
  });

  it('members list shows both A (dm) and B (player)', async () => {
    const res = await userA.get(`/api/v1/campaigns/${campaignId}/members`);
    expect(res.status).toBe(200);
    const roles = res.body.map((m: { role: string }) => m.role).sort();
    expect(roles).toEqual(['dm', 'player']);
  });

  it('removing the last dm is refused (409)', async () => {
    const membersRes = await userA.get(`/api/v1/campaigns/${campaignId}/members`);
    const dmMember = membersRes.body.find((m: { role: string }) => m.role === 'dm');
    expect(dmMember).toBeDefined();

    const removeRes = await userA.delete(`/api/v1/campaigns/${campaignId}/members/${dmMember.id}`);
    expect(removeRes.status).toBe(409);

    const demoteRes = await userA.patch(`/api/v1/campaigns/${campaignId}/members/${dmMember.id}`).send({ role: 'player' });
    expect(demoteRes.status).toBe(409);
  });

  it('GET /campaigns scoping: everyone — the server admin included — sees only campaigns they are a member of', async () => {
    // A second campaign created by admin — the admin is auto-dm of THIS one (creator),
    // but holds no role at all in user A's campaign (admin ≠ auto-DM, issue #9).
    const otherCampaign = await adminAgent.post('/api/v1/campaigns').send({ name: 'Admin-only campaign' });
    expect(otherCampaign.status).toBe(201);

    const adminList = await adminAgent.get('/api/v1/campaigns');
    expect(adminList.body.some((c: { id: number }) => c.id === campaignId)).toBe(false);
    expect(adminList.body.some((c: { id: number }) => c.id === otherCampaign.body.id)).toBe(true);

    const bList = await userB.get('/api/v1/campaigns');
    expect(bList.body.some((c: { id: number }) => c.id === campaignId)).toBe(true);
    expect(bList.body.some((c: { id: number }) => c.id === otherCampaign.body.id)).toBe(false);
  });

  // P2 fix pinning tests — member.characterId must resolve to a real character IN THE
  // SAME campaign, or 400.
  describe('FK validation: member.characterId', () => {
    it('POST member with a nonexistent characterId -> 400', async () => {
      await adminAgent.post('/api/v1/users').send({ username: 'user-c1', password: 'password-c1-1', serverRole: 'user' });
      const meRes = await adminAgent.get('/api/v1/users');
      const userC = meRes.body.find((u: { username: string }) => u.username === 'user-c1');

      const res = await userA.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: userC.id, role: 'player', characterId: 999999 });
      expect(res.status).toBe(400);
    });

    it('POST member with a cross-campaign characterId -> 400', async () => {
      const otherCampRes = await userA.post('/api/v1/campaigns').send({ name: 'Member FK Other Campaign' });
      const otherCampaignId = otherCampRes.body.id;
      const charRes = await userA
        .post(`/api/v1/campaigns/${otherCampaignId}/characters`)
        .send({ name: 'Character in other campaign' });
      expect(charRes.status).toBe(201);

      await adminAgent.post('/api/v1/users').send({ username: 'user-c2', password: 'password-c2-1', serverRole: 'user' });
      const usersRes = await adminAgent.get('/api/v1/users');
      const userC2 = usersRes.body.find((u: { username: string }) => u.username === 'user-c2');

      const res = await userA
        .post(`/api/v1/campaigns/${campaignId}/members`)
        .send({ userId: userC2.id, role: 'player', characterId: charRes.body.id });
      expect(res.status).toBe(400);
    });

    it('POST/PATCH member with a valid same-campaign characterId -> 200/201', async () => {
      const charRes = await userA.post(`/api/v1/campaigns/${campaignId}/characters`).send({ name: 'Valid Member Character' });
      expect(charRes.status).toBe(201);

      await adminAgent.post('/api/v1/users').send({ username: 'user-c3', password: 'password-c3-1', serverRole: 'user' });
      const usersRes = await adminAgent.get('/api/v1/users');
      const userC3 = usersRes.body.find((u: { username: string }) => u.username === 'user-c3');

      const addRes = await userA
        .post(`/api/v1/campaigns/${campaignId}/members`)
        .send({ userId: userC3.id, role: 'player', characterId: charRes.body.id });
      expect(addRes.status).toBe(201);
      expect(addRes.body.characterId).toBe(charRes.body.id);

      const otherCharRes = await userA.post(`/api/v1/campaigns/${campaignId}/characters`).send({ name: 'Second Valid Character' });
      const patchRes = await userA
        .patch(`/api/v1/campaigns/${campaignId}/members/${addRes.body.id}`)
        .send({ characterId: otherCharRes.body.id });
      expect(patchRes.status).toBe(200);
      expect(patchRes.body.characterId).toBe(otherCharRes.body.id);
    });

    it('PATCH member with a nonexistent characterId -> 400', async () => {
      const membersRes = await userA.get(`/api/v1/campaigns/${campaignId}/members`);
      const playerMember = membersRes.body.find((m: { role: string }) => m.role === 'player');
      expect(playerMember).toBeDefined();

      const res = await userA.patch(`/api/v1/campaigns/${campaignId}/members/${playerMember.id}`).send({ characterId: 999999 });
      expect(res.status).toBe(400);
    });
  });

  // Issue #32: linking a member to a character must grant that player edit rights by
  // syncing characters.ownerUserId (string form of the integer users.id) — previously the
  // DM had to also PATCH the character's ownerUserId by hand.
  describe('Issue #32: member↔character link grants ownership', () => {
    let memberBId: number;
    let heroId: number;
    let altId: number;

    beforeAll(async () => {
      const membersRes = await userA.get(`/api/v1/campaigns/${campaignId}/members`);
      memberBId = membersRes.body.find((m: { userId: number }) => m.userId === userBId).id;

      const heroRes = await userA.post(`/api/v1/campaigns/${campaignId}/characters`).send({ name: 'Linked Hero' });
      heroId = heroRes.body.id;
      const altRes = await userA.post(`/api/v1/campaigns/${campaignId}/characters`).send({ name: 'Alt Hero' });
      altId = altRes.body.id;
    });

    it('unlinked character: player B cannot edit (403), ownerUserId is null', async () => {
      const getRes = await userB.get(`/api/v1/characters/${heroId}`);
      expect(getRes.body.ownerUserId).toBeNull();

      const patchRes = await userB.patch(`/api/v1/characters/${heroId}`).send({ notes: 'should fail' });
      expect(patchRes.status).toBe(403);
    });

    it('PATCH member {characterId} sets ownerUserId and lets the player edit', async () => {
      const linkRes = await userA.patch(`/api/v1/campaigns/${campaignId}/members/${memberBId}`).send({ characterId: heroId });
      expect(linkRes.status).toBe(200);

      const getRes = await userB.get(`/api/v1/characters/${heroId}`);
      expect(getRes.body.ownerUserId).toBe(String(userBId));

      const patchRes = await userB.patch(`/api/v1/characters/${heroId}`).send({ notes: 'my character now' });
      expect(patchRes.status).toBe(200);
      expect(patchRes.body.notes).toBe('my character now');
    });

    it('re-linking to another character transfers ownership (old cleared, new granted)', async () => {
      const relinkRes = await userA.patch(`/api/v1/campaigns/${campaignId}/members/${memberBId}`).send({ characterId: altId });
      expect(relinkRes.status).toBe(200);

      const oldChar = await userA.get(`/api/v1/characters/${heroId}`);
      expect(oldChar.body.ownerUserId).toBeNull();
      const newChar = await userA.get(`/api/v1/characters/${altId}`);
      expect(newChar.body.ownerUserId).toBe(String(userBId));

      expect((await userB.patch(`/api/v1/characters/${heroId}`).send({ notes: 'no longer mine' })).status).toBe(403);
      expect((await userB.patch(`/api/v1/characters/${altId}`).send({ notes: 'mine now' })).status).toBe(200);
    });

    it('unlinking (characterId: null) revokes ownership', async () => {
      const unlinkRes = await userA.patch(`/api/v1/campaigns/${campaignId}/members/${memberBId}`).send({ characterId: null });
      expect(unlinkRes.status).toBe(200);

      const charRes = await userA.get(`/api/v1/characters/${altId}`);
      expect(charRes.body.ownerUserId).toBeNull();

      expect((await userB.patch(`/api/v1/characters/${altId}`).send({ notes: 'revoked' })).status).toBe(403);
    });

    it('POST member with characterId (create path) also grants ownership', async () => {
      const createD = await adminAgent.post('/api/v1/users').send({ username: 'user-d', password: 'password-d-1', serverRole: 'user' });
      const userDId = createD.body.id;
      const userD = request.agent(ctx.app.getHttpServer());
      await userD.post('/api/v1/auth/login').send({ username: 'user-d', password: 'password-d-1' });

      const charRes = await userA.post(`/api/v1/campaigns/${campaignId}/characters`).send({ name: 'Preseated Hero' });
      const addRes = await userA
        .post(`/api/v1/campaigns/${campaignId}/members`)
        .send({ userId: userDId, role: 'player', characterId: charRes.body.id });
      expect(addRes.status).toBe(201);

      const getRes = await userD.get(`/api/v1/characters/${charRes.body.id}`);
      expect(getRes.body.ownerUserId).toBe(String(userDId));

      expect((await userD.patch(`/api/v1/characters/${charRes.body.id}`).send({ notes: 'seated and owned' })).status).toBe(200);
    });

    it('id-type reconciliation: DM may set ownerUserId with a numeric userId (coerced to string); an explicit reassignment is not clobbered by unlink', async () => {
      // Link B to hero, then DM explicitly reassigns ownership passing the RAW NUMBER
      // (CampaignMember.userId shape) — the schema now coerces it to the canonical string.
      await userA.patch(`/api/v1/campaigns/${campaignId}/members/${memberBId}`).send({ characterId: heroId });

      const usersRes = await adminAgent.get('/api/v1/users');
      const userD = usersRes.body.find((u: { username: string }) => u.username === 'user-d');
      const reassignRes = await userA.patch(`/api/v1/characters/${heroId}`).send({ ownerUserId: userD.id });
      expect(reassignRes.status).toBe(200);
      expect(reassignRes.body.ownerUserId).toBe(String(userD.id));

      // Unlinking B must NOT clear D's ownership — the character is no longer B's.
      const unlinkRes = await userA.patch(`/api/v1/campaigns/${campaignId}/members/${memberBId}`).send({ characterId: null });
      expect(unlinkRes.status).toBe(200);
      const charRes = await userA.get(`/api/v1/characters/${heroId}`);
      expect(charRes.body.ownerUserId).toBe(String(userD.id));
    });
  });

  // Issue #88: GET /users/lookup used to expose the entire server user table to ANY
  // authenticated principal (a directory-enumeration oracle feeding the login/timing
  // attack). It now only serves the flow it exists for — a dm resolving a username to
  // add someone to their campaign — so it is gated to a dm-of-any-campaign or a server
  // admin. userA is a dm (created a campaign); userB is only a player; adminAgent is a
  // server admin who dms no campaign userA/B share.
  describe('Issue #88: /users/lookup is not a server-wide enumeration oracle', () => {
    it('a plain player cannot enumerate the user directory (403)', async () => {
      const res = await userB.get('/api/v1/users/lookup').query({ query: 'user' });
      expect(res.status).toBe(403);
    });

    it("a player cannot enumerate accounts they share no campaign with — e.g. the admin (403)", async () => {
      const res = await userB.get('/api/v1/users/lookup').query({ query: 'root-admin' });
      expect(res.status).toBe(403);
    });

    it('a dm (add-member flow) resolves a username to an id — the flow still works', async () => {
      const res = await userA.get('/api/v1/users/lookup').query({ query: 'user-b' });
      expect(res.status).toBe(200);
      const hit = res.body.find((u: { username: string }) => u.username === 'user-b');
      expect(hit).toBeDefined();
      expect(hit.id).toBe(userBId);

      // ...and the resolved id feeds the dm-gated add-member endpoint (Nest POST=201).
      const other = await userA.post('/api/v1/campaigns').send({ name: 'Lookup add-member target' });
      const addRes = await userA.post(`/api/v1/campaigns/${other.body.id}/members`).send({ userId: hit.id, role: 'player' });
      expect(addRes.status).toBe(201);
    });

    it('a server admin may use the lookup (user management)', async () => {
      const res = await adminAgent.get('/api/v1/users/lookup').query({ query: 'user-a' });
      expect(res.status).toBe(200);
      expect(res.body.some((u: { username: string }) => u.username === 'user-a')).toBe(true);
    });

    it('a dm with too-short a query still gets the 400 (authz passes first, then validation)', async () => {
      const res = await userA.get('/api/v1/users/lookup').query({ query: 'a' });
      expect(res.status).toBe(400);
    });
  });
});

/**
 * Issue #128 (player data rights): a member may remove their OWN seat (self-leave)
 * without the dm role — but only their own, and a sole dm still can't leave without
 * handing dm off. Owned character sheets are de-linked (kept in the campaign, but
 * ownerUserId cleared), never hard-deleted.
 */
describe('self-leave a campaign (e2e, issue #128)', () => {
  let ctx: TestAppContext;
  let dmAgent: ReturnType<typeof request.agent>;
  let playerAgent: ReturnType<typeof request.agent>;
  let otherPlayerAgent: ReturnType<typeof request.agent>;
  let playerId: number;
  let otherPlayerId: number;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    dmAgent = request.agent(server);
    await dmAgent.post('/api/v1/auth/setup').send({ username: 'leave-dm', password: 'dm-password-1' });

    const createPlayer = await dmAgent.post('/api/v1/users').send({ username: 'leave-player', password: 'player-password-1', serverRole: 'user' });
    playerId = createPlayer.body.id;
    playerAgent = request.agent(server);
    await playerAgent.post('/api/v1/auth/login').send({ username: 'leave-player', password: 'player-password-1' });

    const createOther = await dmAgent.post('/api/v1/users').send({ username: 'leave-other', password: 'other-password-1', serverRole: 'user' });
    otherPlayerId = createOther.body.id;
    otherPlayerAgent = request.agent(server);
    await otherPlayerAgent.post('/api/v1/auth/login').send({ username: 'leave-other', password: 'other-password-1' });

    const campRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'Leave Me Campaign' });
    campaignId = campRes.body.id;
    await dmAgent.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: playerId, role: 'player' });
    await dmAgent.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: otherPlayerId, role: 'player' });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('a player cannot remove ANOTHER member (403)', async () => {
    const members = await dmAgent.get(`/api/v1/campaigns/${campaignId}/members`);
    const otherMember = members.body.find((m: { userId: number }) => m.userId === otherPlayerId);
    const res = await playerAgent.delete(`/api/v1/campaigns/${campaignId}/members/${otherMember.id}`);
    expect(res.status).toBe(403);
  });

  it('a player CAN remove their own membership — self-leave (204), and owned character is de-linked but kept', async () => {
    // DM gives the player a character and links it (grants ownership).
    const charRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/characters`).send({ name: 'Departing Hero' });
    const charId = charRes.body.id;
    const members = await dmAgent.get(`/api/v1/campaigns/${campaignId}/members`);
    const myMember = members.body.find((m: { userId: number }) => m.userId === playerId);
    await dmAgent.patch(`/api/v1/campaigns/${campaignId}/members/${myMember.id}`).send({ characterId: charId });

    // Player leaves their own seat.
    const leaveRes = await playerAgent.delete(`/api/v1/campaigns/${campaignId}/members/${myMember.id}`);
    expect(leaveRes.status).toBe(204);

    // They are no longer a member (403 on read).
    const afterRead = await playerAgent.get(`/api/v1/campaigns/${campaignId}`);
    expect(afterRead.status).toBe(403);

    // Character SHEET survives (not hard-deleted) but is un-owned now.
    const charAfter = await dmAgent.get(`/api/v1/characters/${charId}`);
    expect(charAfter.status).toBe(200);
    expect(charAfter.body.ownerUserId).toBeNull();

    // The member seat is gone from the roster.
    const rosterAfter = await dmAgent.get(`/api/v1/campaigns/${campaignId}/members`);
    expect(rosterAfter.body.some((m: { userId: number }) => m.userId === playerId)).toBe(false);
  });

  it('the sole dm cannot self-leave without handing dm off (409)', async () => {
    const members = await dmAgent.get(`/api/v1/campaigns/${campaignId}/members`);
    const dmMember = members.body.find((m: { role: string }) => m.role === 'dm');
    const res = await dmAgent.delete(`/api/v1/campaigns/${campaignId}/members/${dmMember.id}`);
    expect(res.status).toBe(409);
  });
});

/**
 * Punch list item 2: deleting a user (admin-only DELETE /users/:id) used to cascade
 * campaign_members without the same last-dm guard MembersService's own DELETE endpoint
 * enforces (see the "removing the last dm is refused (409)" test above) — so deleting the
 * user row was a silent bypass that could orphan a campaign with zero dms. UsersService.remove()
 * now runs the same check across every campaign the target user dms.
 */
describe('user delete last-dm guard (e2e, real cookie sessions)', () => {
  let ctx: TestAppContext;
  let adminAgent: ReturnType<typeof request.agent>;
  let soleDmAgent: ReturnType<typeof request.agent>;
  let soleDmId: number;
  let sharedDmAgent: ReturnType<typeof request.agent>;
  let sharedDmId: number;
  let coDmAgent: ReturnType<typeof request.agent>;
  let coDmId: number;
  let soleDmCampaignId: number;
  let sharedCampaignId: number;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    adminAgent = request.agent(server);
    await adminAgent.post('/api/v1/auth/setup').send({ username: 'del-admin', password: 'admin-password-1' });

    const soleDmCreate = await adminAgent.post('/api/v1/users').send({ username: 'sole-dm', password: 'sole-dm-password', serverRole: 'user' });
    soleDmId = soleDmCreate.body.id;
    soleDmAgent = request.agent(server);
    await soleDmAgent.post('/api/v1/auth/login').send({ username: 'sole-dm', password: 'sole-dm-password' });

    const sharedDmCreate = await adminAgent.post('/api/v1/users').send({ username: 'shared-dm', password: 'shared-dm-password', serverRole: 'user' });
    sharedDmId = sharedDmCreate.body.id;
    sharedDmAgent = request.agent(server);
    await sharedDmAgent.post('/api/v1/auth/login').send({ username: 'shared-dm', password: 'shared-dm-password' });

    const coDmCreate = await adminAgent.post('/api/v1/users').send({ username: 'co-dm', password: 'co-dm-password', serverRole: 'user' });
    coDmId = coDmCreate.body.id;
    coDmAgent = request.agent(server);
    await coDmAgent.post('/api/v1/auth/login').send({ username: 'co-dm', password: 'co-dm-password' });

    // sole-dm is the ONLY dm of this campaign — deleting them should be refused.
    const soleCampRes = await soleDmAgent.post('/api/v1/campaigns').send({ name: 'Sole DM Campaign' });
    soleDmCampaignId = soleCampRes.body.id;

    // shared-dm campaign has a second dm (co-dm) — deleting shared-dm should be allowed.
    const sharedCampRes = await sharedDmAgent.post('/api/v1/campaigns').send({ name: 'Shared DM Campaign' });
    sharedCampaignId = sharedCampRes.body.id;
    const membersRes = await sharedDmAgent.get(`/api/v1/campaigns/${sharedCampaignId}/members`);
    const sharedDmMemberRow = membersRes.body.find((m: { role: string }) => m.role === 'dm');
    const promoteRes = await sharedDmAgent
      .post(`/api/v1/campaigns/${sharedCampaignId}/members`)
      .send({ userId: coDmId, role: 'dm' });
    expect(promoteRes.status).toBe(201);
    expect(sharedDmMemberRow.role).toBe('dm');
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('deleting the sole dm of a campaign is refused (409, names the campaign)', async () => {
    const res = await adminAgent.delete(`/api/v1/users/${soleDmId}`);
    expect(res.status).toBe(409);
    expect(res.body.message).toContain('Sole DM Campaign');

    // user still exists and can still log in
    const stillThere = await adminAgent.get('/api/v1/users');
    expect(stillThere.body.some((u: { id: number }) => u.id === soleDmId)).toBe(true);
  });

  it('deleting a dm who shares dm duties with another dm succeeds (204)', async () => {
    const res = await adminAgent.delete(`/api/v1/users/${sharedDmId}`);
    expect(res.status).toBe(204);

    const listRes = await adminAgent.get('/api/v1/users');
    expect(listRes.body.some((u: { id: number }) => u.id === sharedDmId)).toBe(false);

    // co-dm remains the sole dm now, campaign still reachable
    const campRes = await coDmAgent.get(`/api/v1/campaigns/${sharedCampaignId}`);
    expect(campRes.status).toBe(200);
  });

  it('after reassigning a co-dm, deleting the original sole dm now succeeds', async () => {
    const membersRes = await soleDmAgent.get(`/api/v1/campaigns/${soleDmCampaignId}/members`);
    const soleDmMemberRow = membersRes.body.find((m: { role: string }) => m.role === 'dm');
    expect(soleDmMemberRow).toBeDefined();

    const addCoDm = await soleDmAgent.post(`/api/v1/campaigns/${soleDmCampaignId}/members`).send({ userId: coDmId, role: 'dm' });
    expect(addCoDm.status).toBe(201);

    const res = await adminAgent.delete(`/api/v1/users/${soleDmId}`);
    expect(res.status).toBe(204);
  });
});

/**
 * Issue #96: deleting a character must unlink any member that references it, so
 * campaignMembers.characterId never dangles on a deleted character (the denormalized
 * members list would otherwise join against a ghost id). Needs real users (member.userId
 * is a users.id integer), so this uses cookie-session auth like the suites above.
 */
describe('character delete unlinks member (e2e, real cookie sessions, issue #96)', () => {
  let ctx: TestAppContext;
  let adminAgent: ReturnType<typeof request.agent>;
  let dmAgent: ReturnType<typeof request.agent>;
  let playerId: number;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    adminAgent = request.agent(server);
    await adminAgent.post('/api/v1/auth/setup').send({ username: 'del-char-admin', password: 'admin-password-1' });

    await adminAgent.post('/api/v1/users').send({ username: 'char-dm', password: 'char-dm-password', serverRole: 'user' });
    const createPlayer = await adminAgent.post('/api/v1/users').send({ username: 'char-player', password: 'char-player-password', serverRole: 'user' });
    playerId = createPlayer.body.id;

    dmAgent = request.agent(server);
    await dmAgent.post('/api/v1/auth/login').send({ username: 'char-dm', password: 'char-dm-password' });

    const campRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'Character Unlink Campaign' });
    campaignId = campRes.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('deleting a linked character nulls the member.characterId link', async () => {
    const charRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/characters`).send({ name: 'Linked-then-deleted' });
    expect(charRes.status).toBe(201);
    const charId = charRes.body.id;

    const addRes = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/members`)
      .send({ userId: playerId, role: 'player', characterId: charId });
    expect(addRes.status).toBe(201);
    expect(addRes.body.characterId).toBe(charId);
    const memberId = addRes.body.id;

    const delRes = await dmAgent.delete(`/api/v1/characters/${charId}`);
    expect(delRes.status).toBe(200);

    const membersAfter = await dmAgent.get(`/api/v1/campaigns/${campaignId}/members`);
    const memberAfter = membersAfter.body.find((m: { id: number }) => m.id === memberId);
    expect(memberAfter).toBeDefined();
    expect(memberAfter.characterId).toBeNull();
  });
});
