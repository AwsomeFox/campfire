import request from 'supertest';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';

describe('membership + effective roles (e2e, real cookie sessions)', () => {
  let ctx: TestAppContext;
  let adminAgent: ReturnType<typeof request.agent>;
  let userA: ReturnType<typeof request.agent>;
  let userB: ReturnType<typeof request.agent>;
  let userAId: number;
  let userBId: number;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    adminAgent = request.agent(server);
    await adminAgent.post('/api/v1/auth/setup').send({ username: 'root-admin', password: 'admin-password-1' });

    const createA = await adminAgent.post('/api/v1/users').send({ username: 'user-a', password: 'password-a-1', serverRole: 'user' });
    const createB = await adminAgent.post('/api/v1/users').send({ username: 'user-b', password: 'password-b-1', serverRole: 'user' });
    userAId = createA.body.id;
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

  /**
   * Issue #1590 — a DM promoting/demoting an EXISTING member (issue #437's own-campaign
   * path, `MembersService.update`) is the common way a role actually changes day to day —
   * far more common than the admin bulk `reassign_owner` path #1546 already covered. Before
   * this, `update()` emitted only the campaign-scoped `membership.updated` SSE event, which
   * only reaches a browser that already has THIS campaign's stream open. Now it also sends
   * the same account-wide `added_to_campaign`-typed notification #1546 established for the
   * admin path, so the target's poller (which runs regardless of which campaign, or none,
   * they're currently viewing) has something to react to.
   */
  it("promoting an existing member notifies them account-wide and flags membershipChanged (#1590)", async () => {
    const membersBefore = await userA.get(`/api/v1/campaigns/${campaignId}/members`);
    const bMember = membersBefore.body.find((m: { userId: number }) => m.userId === userBId);
    expect(bMember).toBeDefined();

    const promote = await userA.patch(`/api/v1/campaigns/${campaignId}/members/${bMember.id}`).send({ role: 'dm' });
    expect(promote.status).toBe(200);
    expect(promote.body.role).toBe('dm');

    const bNotifications = await userB.get('/api/v1/notifications');
    const items = Array.isArray(bNotifications.body) ? bNotifications.body : bNotifications.body.items;
    const roleChange = items.find(
      (n: { type: string; campaignId: number }) => n.type === 'added_to_campaign' && n.campaignId === campaignId,
    );
    expect(roleChange).toBeDefined();
    expect(roleChange.title).toContain('DM');
    expect(roleChange.readAt).toBeNull();

    const bCount = await userB.get('/api/v1/notifications/unread-count');
    expect(bCount.body.membershipChanged).toBe(true);

    // The acting DM (A) is not the target and gets no self-notification.
    const aCount = await userA.get('/api/v1/notifications/unread-count');
    expect(aCount.body.membershipChanged).toBe(false);

    // Restore B to 'player' so the rest of this describe block's assumptions
    // (roles === ['dm', 'player'], B treated as an ordinary player member) still hold.
    const demote = await userA.patch(`/api/v1/campaigns/${campaignId}/members/${bMember.id}`).send({ role: 'player' });
    expect(demote.status).toBe(200);
    expect(demote.body.role).toBe('player');

    // The demotion is ALSO membership-shaped — same mechanism, either direction.
    const bCountAfterDemote = await userB.get('/api/v1/notifications/unread-count');
    expect(bCountAfterDemote.body.membershipChanged).toBe(true);
  });

  /**
   * Issue #501 — AI consent is a personal preference in a way a role is not, so the roster
   * discloses it only to the DM (who needs it to understand why a recap withheld material)
   * and to the member themselves (who needs it to render their own consent control).
   */
  it('discloses AI consent to the dm for every member', async () => {
    const res = await userA.get(`/api/v1/campaigns/${campaignId}/members`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(1);
    for (const member of res.body) {
      expect(typeof member.aiExternalUseConsent).toBe('boolean');
    }
  });

  it("hides other members' AI consent from a player, but not their own", async () => {
    // B opts in, so their own value is a distinguishable `true`, not the shared default.
    const consent = await userB
      .patch(`/api/v1/campaigns/${campaignId}/members/me/ai-consent`)
      .send({ aiExternalUseConsent: true });
    expect(consent.status).toBe(200);

    const res = await userB.get(`/api/v1/campaigns/${campaignId}/members`);
    expect(res.status).toBe(200);

    const self = res.body.find((m: { userId: number }) => m.userId === userBId);
    const other = res.body.find((m: { userId: number }) => m.userId === userAId);
    expect(self.aiExternalUseConsent).toBe(true);
    // `null` means "not disclosed to you" — deliberately not `false`, which would be a lie
    // that reads as an explicit opt-out by that member.
    expect(other.aiExternalUseConsent).toBeNull();
  });

  it('removing the last dm is refused (409)', async () => {
    const membersRes = await userA.get(`/api/v1/campaigns/${campaignId}/members`);
    const dmMember = membersRes.body.find((m: { role: string }) => m.role === 'dm');
    expect(dmMember).toBeDefined();

    const removeRes = await userA.delete(`/api/v1/campaigns/${campaignId}/members/${dmMember.id}`);
    expect(removeRes.status).toBe(409);

    const demoteRes = await userA.patch(`/api/v1/campaigns/${campaignId}/members/${dmMember.id}`).send({ role: 'player' });
    expect(demoteRes.status).toBe(409);

    const demoteWithBadCharacter = await userA
      .patch(`/api/v1/campaigns/${campaignId}/members/${dmMember.id}`)
      .send({ role: 'player', characterId: 999999 });
    expect(demoteWithBadCharacter.status).toBe(409);
    expect(demoteWithBadCharacter.body.message).toBe('Cannot demote the last dm of this campaign');
  });

  describe('Issue #545: protected owner and temporary guest DM handoff', () => {
    let ownerMemberId: number;

    it('marks the creator as protected owner and blocks ordinary co-DM demotion/removal', async () => {
      const createCoDm = await adminAgent
        .post('/api/v1/users')
        .send({ username: 'codm-545', password: 'password-codm-545', serverRole: 'user' });
      expect(createCoDm.status).toBe(201);
      const coDmId = createCoDm.body.id;
      const coDm = request.agent(ctx.app.getHttpServer());
      await coDm.post('/api/v1/auth/login').send({ username: 'codm-545', password: 'password-codm-545' });

      const addCoDm = await userA
        .post(`/api/v1/campaigns/${campaignId}/members`)
        .send({ userId: coDmId, role: 'dm' });
      expect(addCoDm.status).toBe(201);

      let membersRes = await userA.get(`/api/v1/campaigns/${campaignId}/members`);
      expect(membersRes.status).toBe(200);
      const owner = membersRes.body.find((m: { userId: number }) => m.userId === userAId);
      expect(owner).toMatchObject({ role: 'dm', primaryOwner: true });
      ownerMemberId = owner.id;

      const demoteOwner = await coDm
        .patch(`/api/v1/campaigns/${campaignId}/members/${ownerMemberId}`)
        .send({ role: 'player' });
      expect(demoteOwner.status).toBe(409);
      expect(demoteOwner.body.message).toBe('Cannot demote the protected campaign owner');

      const removeOwner = await coDm.delete(`/api/v1/campaigns/${campaignId}/members/${ownerMemberId}`);
      expect(removeOwner.status).toBe(409);
      expect(removeOwner.body.message).toBe('Cannot remove the protected campaign owner');

      membersRes = await userA.get(`/api/v1/campaigns/${campaignId}/members`);
      const stillOwner = membersRes.body.find((m: { id: number }) => m.id === ownerMemberId);
      expect(stillOwner).toMatchObject({ role: 'dm', primaryOwner: true });
    });

    it('default guest DM grant can run play, but cannot manage members or trash the campaign, and expires', async () => {
      const createGuest = await adminAgent
        .post('/api/v1/users')
        .send({ username: 'guest-545', password: 'password-guest-545', serverRole: 'user' });
      expect(createGuest.status).toBe(201);
      const guestId = createGuest.body.id;
      const guest = request.agent(ctx.app.getHttpServer());
      await guest.post('/api/v1/auth/login').send({ username: 'guest-545', password: 'password-guest-545' });

      const addGuest = await userA
        .post(`/api/v1/campaigns/${campaignId}/members`)
        .send({ userId: guestId, role: 'player' });
      expect(addGuest.status).toBe(201);

      const expiresAt = new Date(Date.now() + 750).toISOString();
      const grant = await userA
        .post(`/api/v1/campaigns/${campaignId}/members/grants`)
        .send({ granteeUserId: guestId, expiresAt });
      expect(grant.status).toBe(201);
      expect(grant.body.scopes).toEqual(['dm']);
      expect(grant.body.revokedAt).toBeNull();

      const meDuringGrant = await guest.get('/api/v1/me');
      expect(meDuringGrant.body.memberships.find((m: { campaignId: number }) => m.campaignId === campaignId).role).toBe('dm');

      const canRunPlay = await guest.post(`/api/v1/campaigns/${campaignId}/quests`).send({ title: 'Guest DM scene' });
      expect(canRunPlay.status).toBe(201);

      const cannotManageMembers = await guest
        .patch(`/api/v1/campaigns/${campaignId}/members/${ownerMemberId}`)
        .send({ role: 'player' });
      expect(cannotManageMembers.status).toBe(403);

      const cannotTrash = await guest.delete(`/api/v1/campaigns/${campaignId}`);
      expect(cannotTrash.status).toBe(403);

      await new Promise((resolve) => setTimeout(resolve, 900));

      const meAfterExpiry = await guest.get('/api/v1/me');
      expect(meAfterExpiry.body.memberships.find((m: { campaignId: number }) => m.campaignId === campaignId).role).toBe('player');
      const afterExpiry = await guest.post(`/api/v1/campaigns/${campaignId}/quests`).send({ title: 'Expired scene' });
      expect(afterExpiry.status).toBe(403);
    });

    /**
     * Issue #501 — the consent redaction keys off the role `requireMember` returns, which
     * is the EFFECTIVE role (`baseOrGrantedEffectiveRole`), not the base membership row.
     * A guest DM must therefore see everyone's consent while the grant is live, and lose
     * that visibility when it lapses — otherwise the redaction fires against exactly the
     * person who needs the data to explain a withheld recap.
     */
    it('a guest DM sees member AI consent while granted, and stops seeing it after handback', async () => {
      const createGuest = await adminAgent
        .post('/api/v1/users')
        .send({ username: 'guest-consent-501', password: 'password-guest-501', serverRole: 'user' });
      expect(createGuest.status).toBe(201);
      const guestId = createGuest.body.id;
      const guest = request.agent(ctx.app.getHttpServer());
      await guest.post('/api/v1/auth/login').send({ username: 'guest-consent-501', password: 'password-guest-501' });

      expect(
        (await userA.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: guestId, role: 'player' })).status,
      ).toBe(201);

      // As a plain player, other members' consent is withheld.
      const asPlayer = await guest.get(`/api/v1/campaigns/${campaignId}/members`);
      expect(asPlayer.status).toBe(200);
      expect(asPlayer.body.find((m: { userId: number }) => m.userId === userAId).aiExternalUseConsent).toBeNull();

      const grant = await userA
        .post(`/api/v1/campaigns/${campaignId}/members/grants`)
        .send({ granteeUserId: guestId, expiresAt: new Date(Date.now() + 60_000).toISOString() });
      expect(grant.status).toBe(201);

      // With DM authority the roster is fully disclosed.
      const asGuestDm = await guest.get(`/api/v1/campaigns/${campaignId}/members`);
      expect(asGuestDm.status).toBe(200);
      for (const member of asGuestDm.body) {
        expect(typeof member.aiExternalUseConsent).toBe('boolean');
      }

      // Handing the seat back drops the elevation, and the redaction returns.
      expect((await guest.post(`/api/v1/campaigns/${campaignId}/members/grants/${grant.body.id}/handback`).send({})).status).toBe(201);
      const afterHandback = await guest.get(`/api/v1/campaigns/${campaignId}/members`);
      expect(afterHandback.status).toBe(200);
      expect(afterHandback.body.find((m: { userId: number }) => m.userId === userAId).aiExternalUseConsent).toBeNull();
    });

    it('owner revoke and grantee handback end temporary authority early', async () => {
      const createTemp = await adminAgent
        .post('/api/v1/users')
        .send({ username: 'handback-545', password: 'password-handback-545', serverRole: 'user' });
      expect(createTemp.status).toBe(201);
      const tempId = createTemp.body.id;
      const temp = request.agent(ctx.app.getHttpServer());
      await temp.post('/api/v1/auth/login').send({ username: 'handback-545', password: 'password-handback-545' });

      const addTemp = await userA
        .post(`/api/v1/campaigns/${campaignId}/members`)
        .send({ userId: tempId, role: 'player' });
      expect(addTemp.status).toBe(201);

      const longExpiry = () => new Date(Date.now() + 60_000).toISOString();
      const revocable = await userA
        .post(`/api/v1/campaigns/${campaignId}/members/grants`)
        .send({ granteeUserId: tempId, expiresAt: longExpiry() });
      expect(revocable.status).toBe(201);
      expect((await temp.post(`/api/v1/campaigns/${campaignId}/quests`).send({ title: 'Before revoke' })).status).toBe(201);

      const revoked = await userA.post(`/api/v1/campaigns/${campaignId}/members/grants/${revocable.body.id}/revoke`);
      expect(revoked.status).toBe(201);
      expect(revoked.body.revokedAt).toEqual(expect.any(String));
      expect((await temp.post(`/api/v1/campaigns/${campaignId}/quests`).send({ title: 'After revoke' })).status).toBe(403);

      const handbackGrant = await userA
        .post(`/api/v1/campaigns/${campaignId}/members/grants`)
        .send({ granteeUserId: tempId, expiresAt: longExpiry() });
      expect(handbackGrant.status).toBe(201);
      expect((await temp.post(`/api/v1/campaigns/${campaignId}/quests`).send({ title: 'Before handback' })).status).toBe(201);

      const handedBack = await temp.post(`/api/v1/campaigns/${campaignId}/members/grants/${handbackGrant.body.id}/handback`);
      expect(handedBack.status).toBe(201);
      expect(handedBack.body.handedBackAt).toEqual(expect.any(String));
      expect((await temp.post(`/api/v1/campaigns/${campaignId}/quests`).send({ title: 'After handback' })).status).toBe(403);
    });
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

    it('unlinked character: player B cannot read or edit it (403)', async () => {
      const getRes = await userB.get(`/api/v1/characters/${heroId}`);
      expect(getRes.status).toBe(403);

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

  // Issue #819: exclusive character seat — a second member link must not silently
  // steal ownership. Transfer requires confirmTransfer and atomically unlinks the
  // previous seat while moving characters.ownerUserId.
  describe('Issue #819: exclusive character seat assignment', () => {
    let aliceId: number;
    let bobId: number;
    let carolId: number;
    let aliceMemberId: number;
    let bobMemberId: number;
    let carolMemberId: number;
    let aliceAgent: ReturnType<typeof request.agent>;
    let bobAgent: ReturnType<typeof request.agent>;
    let ariaId: number;
    let borinId: number;

    beforeAll(async () => {
      const createAlice = await adminAgent
        .post('/api/v1/users')
        .send({ username: 'alice-819', password: 'password-alice-819', serverRole: 'user' });
      const createBob = await adminAgent
        .post('/api/v1/users')
        .send({ username: 'bob-819', password: 'password-bob-819', serverRole: 'user' });
      const createCarol = await adminAgent
        .post('/api/v1/users')
        .send({ username: 'carol-819', password: 'password-carol-819', serverRole: 'user' });
      aliceId = createAlice.body.id;
      bobId = createBob.body.id;
      carolId = createCarol.body.id;

      aliceAgent = request.agent(ctx.app.getHttpServer());
      await aliceAgent.post('/api/v1/auth/login').send({ username: 'alice-819', password: 'password-alice-819' });
      bobAgent = request.agent(ctx.app.getHttpServer());
      await bobAgent.post('/api/v1/auth/login').send({ username: 'bob-819', password: 'password-bob-819' });

      const addAlice = await userA
        .post(`/api/v1/campaigns/${campaignId}/members`)
        .send({ userId: aliceId, role: 'player' });
      const addBob = await userA
        .post(`/api/v1/campaigns/${campaignId}/members`)
        .send({ userId: bobId, role: 'player' });
      const addCarol = await userA
        .post(`/api/v1/campaigns/${campaignId}/members`)
        .send({ userId: carolId, role: 'player' });
      expect(addAlice.status).toBe(201);
      expect(addBob.status).toBe(201);
      expect(addCarol.status).toBe(201);
      aliceMemberId = addAlice.body.id;
      bobMemberId = addBob.body.id;
      carolMemberId = addCarol.body.id;

      const aria = await userA.post(`/api/v1/campaigns/${campaignId}/characters`).send({ name: 'Aria 819' });
      const borin = await userA.post(`/api/v1/campaigns/${campaignId}/characters`).send({ name: 'Borin 819' });
      expect(aria.status).toBe(201);
      expect(borin.status).toBe(201);
      ariaId = aria.body.id;
      borinId = borin.body.id;
    });

    it('sequential assignment without confirmTransfer rejects and leaves the first seat intact', async () => {
      const linkAlice = await userA
        .patch(`/api/v1/campaigns/${campaignId}/members/${aliceMemberId}`)
        .send({ characterId: ariaId });
      expect(linkAlice.status).toBe(200);
      expect(linkAlice.body.characterId).toBe(ariaId);

      const steal = await userA
        .patch(`/api/v1/campaigns/${campaignId}/members/${bobMemberId}`)
        .send({ characterId: ariaId });
      expect(steal.status).toBe(409);
      expect(steal.body.code).toBe('CHARACTER_SEAT_TAKEN');
      expect(steal.body.holderUserId).toBe(aliceId);

      const roster = await userA.get(`/api/v1/campaigns/${campaignId}/members`);
      const aliceSeat = roster.body.find((m: { id: number }) => m.id === aliceMemberId);
      const bobSeat = roster.body.find((m: { id: number }) => m.id === bobMemberId);
      expect(aliceSeat.characterId).toBe(ariaId);
      expect(bobSeat.characterId).toBeNull();

      const sheet = await userA.get(`/api/v1/characters/${ariaId}`);
      expect(sheet.body.ownerUserId).toBe(String(aliceId));
      expect((await aliceAgent.patch(`/api/v1/characters/${ariaId}`).send({ notes: 'still mine' })).status).toBe(200);
      expect((await bobAgent.patch(`/api/v1/characters/${ariaId}`).send({ notes: 'stolen?' })).status).toBe(403);
    });

    it('confirmTransfer atomically moves the seat and ownership from Alice to Bob', async () => {
      const transfer = await userA
        .patch(`/api/v1/campaigns/${campaignId}/members/${bobMemberId}`)
        .send({ characterId: ariaId, confirmTransfer: true });
      expect(transfer.status).toBe(200);
      expect(transfer.body.characterId).toBe(ariaId);

      const roster = await userA.get(`/api/v1/campaigns/${campaignId}/members`);
      expect(roster.body.find((m: { id: number }) => m.id === aliceMemberId).characterId).toBeNull();
      expect(roster.body.find((m: { id: number }) => m.id === bobMemberId).characterId).toBe(ariaId);

      const sheet = await userA.get(`/api/v1/characters/${ariaId}`);
      expect(sheet.body.ownerUserId).toBe(String(bobId));
      expect((await bobAgent.patch(`/api/v1/characters/${ariaId}`).send({ notes: 'bob owns aria' })).status).toBe(200);
      expect((await aliceAgent.patch(`/api/v1/characters/${ariaId}`).send({ notes: 'alice lost' })).status).toBe(403);

      const aliceNotes = await aliceAgent.get('/api/v1/notifications');
      expect(aliceNotes.status).toBe(200);
      const aliceItems = Array.isArray(aliceNotes.body) ? aliceNotes.body : (aliceNotes.body.items ?? []);
      expect(
        aliceItems.some(
          (n: { type: string; entityId: number | null }) =>
            n.type === 'character_reassigned' && n.entityId === ariaId,
        ),
      ).toBe(true);
    });

    it('multi-character ownership: transferring Aria does not disturb Borin', async () => {
      const linkAliceBorin = await userA
        .patch(`/api/v1/campaigns/${campaignId}/members/${aliceMemberId}`)
        .send({ characterId: borinId });
      expect(linkAliceBorin.status).toBe(200);

      // Bob still holds Aria; transfer Aria to Carol without touching Borin.
      const transfer = await userA
        .patch(`/api/v1/campaigns/${campaignId}/members/${carolMemberId}`)
        .send({ characterId: ariaId, confirmTransfer: true });
      expect(transfer.status).toBe(200);

      const roster = await userA.get(`/api/v1/campaigns/${campaignId}/members`);
      expect(roster.body.find((m: { id: number }) => m.id === aliceMemberId).characterId).toBe(borinId);
      expect(roster.body.find((m: { id: number }) => m.id === carolMemberId).characterId).toBe(ariaId);
      expect(roster.body.find((m: { id: number }) => m.id === bobMemberId).characterId).toBeNull();

      expect((await userA.get(`/api/v1/characters/${borinId}`)).body.ownerUserId).toBe(String(aliceId));
      expect((await userA.get(`/api/v1/characters/${ariaId}`)).body.ownerUserId).toBe(String(carolId));
    });

    it('transfer during combat keeps the combatant and flips sheet controls', async () => {
      const encounter = await userA
        .post(`/api/v1/campaigns/${campaignId}/encounters`)
        .send({ name: '819 Transfer Fight' });
      expect(encounter.status).toBe(201);
      // Encounter create may auto-seat linked PCs; ensure Aria is on the board either way.
      const addCombatant = await userA
        .post(`/api/v1/encounters/${encounter.body.id}/combatants`)
        .send({ kind: 'character', characterId: ariaId });
      expect([201, 409]).toContain(addCombatant.status);

      const transfer = await userA
        .patch(`/api/v1/campaigns/${campaignId}/members/${bobMemberId}`)
        .send({ characterId: ariaId, confirmTransfer: true });
      expect(transfer.status).toBe(200);

      const fight = await userA.get(`/api/v1/encounters/${encounter.body.id}`);
      expect(fight.status).toBe(200);
      expect(fight.body.combatants.some((c: { characterId: number | null }) => c.characterId === ariaId)).toBe(true);

      expect((await bobAgent.patch(`/api/v1/characters/${ariaId}`).send({ notes: 'mid-combat owner' })).status).toBe(200);
      expect((await aliceAgent.patch(`/api/v1/characters/${ariaId}`).send({ notes: 'nope' })).status).toBe(403);
    });

    it('removing the seat holder clears ownership without resurrecting a stale dual claim', async () => {
      // Ensure Bob holds Aria (prior transfer), then remove that seat.
      expect(
        (
          await userA
            .patch(`/api/v1/campaigns/${campaignId}/members/${bobMemberId}`)
            .send({ characterId: ariaId, confirmTransfer: true })
        ).status,
      ).toBe(200);

      const removeBob = await userA.delete(`/api/v1/campaigns/${campaignId}/members/${bobMemberId}`);
      expect(removeBob.status).toBe(204);

      const roster = await userA.get(`/api/v1/campaigns/${campaignId}/members`);
      expect(roster.body.find((m: { id: number }) => m.id === bobMemberId)).toBeUndefined();
      expect(roster.body.filter((m: { characterId: number | null }) => m.characterId === ariaId)).toHaveLength(0);

      const sheet = await userA.get(`/api/v1/characters/${ariaId}`);
      expect(sheet.body.ownerUserId).toBeNull();
    });

    it('simultaneous confirmed transfers leave exactly one seat holder', async () => {
      // Re-add Bob (removed above) and park Aria on Alice so both racers must transfer.
      const readdBob = await userA
        .post(`/api/v1/campaigns/${campaignId}/members`)
        .send({ userId: bobId, role: 'player' });
      expect(readdBob.status).toBe(201);
      bobMemberId = readdBob.body.id;

      expect(
        (await userA
          .patch(`/api/v1/campaigns/${campaignId}/members/${aliceMemberId}`)
          .send({ characterId: ariaId, confirmTransfer: true })).status,
      ).toBe(200);

      const [r1, r2] = await Promise.all([
        userA
          .patch(`/api/v1/campaigns/${campaignId}/members/${bobMemberId}`)
          .send({ characterId: ariaId, confirmTransfer: true }),
        userA
          .patch(`/api/v1/campaigns/${campaignId}/members/${carolMemberId}`)
          .send({ characterId: ariaId, confirmTransfer: true }),
      ]);
      expect([r1.status, r2.status].filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
      expect([r1.status, r2.status].every((s) => s === 200 || s === 409)).toBe(true);

      const roster = await userA.get(`/api/v1/campaigns/${campaignId}/members`);
      const holders = roster.body.filter((m: { characterId: number | null }) => m.characterId === ariaId);
      expect(holders).toHaveLength(1);
      const sheet = await userA.get(`/api/v1/characters/${ariaId}`);
      expect(sheet.body.ownerUserId).toBe(String(holders[0].userId));
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
describe('character soft-delete keeps member link (e2e, real cookie sessions, issue #96 / #116)', () => {
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

  it('soft-deleting a linked character keeps the member.characterId link (reversible, issue #116)', async () => {
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

    // Character hidden from normal reads (soft-delete)...
    const charGone = await dmAgent.get(`/api/v1/characters/${charId}`);
    expect(charGone.status).toBe(404);

    // ...but the member's characterId link SURVIVES — the character row is trashed, not
    // destroyed, so nothing dangles and a restore relights the link.
    const membersAfter = await dmAgent.get(`/api/v1/campaigns/${campaignId}/members`);
    const memberAfter = membersAfter.body.find((m: { id: number }) => m.id === memberId);
    expect(memberAfter).toBeDefined();
    expect(memberAfter.characterId).toBe(charId);

    const restoreRes = await dmAgent.post(`/api/v1/characters/${charId}/restore`);
    expect(restoreRes.status).toBe(201);
  });
});

/**
 * Issue #1640 — the revocation half of the account-wide membership signal #1590/#1634
 * built for role changes. `MembersService.remove()` now also sends a `removed_from_campaign`
 * notification, so a removed member's OTHER open tabs (dashboard, a different campaign,
 * /admin — anywhere without this campaign's SSE stream open) learn their /me + campaign
 * list are stale, same mechanism the promote/demote test above asserts for `update()`.
 */
describe('membership revocation notifies account-wide (e2e, real cookie sessions, issue #1640)', () => {
  let ctx: TestAppContext;
  let adminAgent: ReturnType<typeof request.agent>;
  let dmAgent: ReturnType<typeof request.agent>;
  let playerAgent: ReturnType<typeof request.agent>;
  let dmId: number;
  let playerId: number;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    adminAgent = request.agent(server);
    await adminAgent.post('/api/v1/auth/setup').send({ username: 'revoke-admin', password: 'admin-password-1' });

    const createDm = await adminAgent.post('/api/v1/users').send({ username: 'revoke-dm', password: 'revoke-dm-password', serverRole: 'user' });
    dmId = createDm.body.id;
    dmAgent = request.agent(server);
    await dmAgent.post('/api/v1/auth/login').send({ username: 'revoke-dm', password: 'revoke-dm-password' });

    const createPlayer = await adminAgent
      .post('/api/v1/users')
      .send({ username: 'revoke-player', password: 'revoke-player-password', serverRole: 'user' });
    playerId = createPlayer.body.id;
    playerAgent = request.agent(server);
    await playerAgent.post('/api/v1/auth/login').send({ username: 'revoke-player', password: 'revoke-player-password' });

    const campRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'Revocation Campaign' });
    campaignId = campRes.body.id;
    const addRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: playerId, role: 'player' });
    expect(addRes.status).toBe(201);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('a dm removing a member notifies the removed member account-wide, and NOT the acting dm', async () => {
    const membersBefore = await dmAgent.get(`/api/v1/campaigns/${campaignId}/members`);
    const playerMember = membersBefore.body.find((m: { userId: number }) => m.userId === playerId);
    expect(playerMember).toBeDefined();

    const removeRes = await dmAgent.delete(`/api/v1/campaigns/${campaignId}/members/${playerMember.id}`);
    expect(removeRes.status).toBe(204);

    // The membership is really gone.
    const meRes = await playerAgent.get('/api/v1/me');
    expect(meRes.body.memberships.some((m: { campaignId: number }) => m.campaignId === campaignId)).toBe(false);

    const notes = await playerAgent.get('/api/v1/notifications');
    const items = Array.isArray(notes.body) ? notes.body : notes.body.items;
    const removed = items.find(
      (n: { type: string; campaignId: number }) => n.type === 'removed_from_campaign' && n.campaignId === campaignId,
    );
    expect(removed).toBeDefined();
    expect(removed.title).toContain('removed');
    expect(removed.title).not.toContain('left');
    expect(removed.readAt).toBeNull();

    const playerCount = await playerAgent.get('/api/v1/notifications/unread-count');
    expect(playerCount.body.membershipChanged).toBe(true);

    // The acting dm is not the target and gets no self-notification.
    const dmCount = await dmAgent.get('/api/v1/notifications/unread-count');
    expect(dmCount.body.membershipChanged).toBe(false);
  });

  it('a removed member who blocked the acting dm still receives the revocation signal (Codex/#597 review)', async () => {
    // #597's block-based suppression exists to stop an ABUSER'S content reaching someone who
    // blocked them; removed_from_campaign carries no actor content and exists purely so the
    // removed member's other tabs learn their access changed. Gating it on the block would
    // silently strand that member's cached membership stale in exactly the case that matters —
    // see the comment on the notifyUser(..., null, ...) call in members.service.ts#remove.
    const addRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: playerId, role: 'player' });
    expect(addRes.status).toBe(201);
    const memberId = addRes.body.id;

    const blockRes = await playerAgent.post(`/api/v1/campaigns/${campaignId}/safety/blocks`).send({ targetUserId: String(dmId) });
    expect(blockRes.status).toBe(201);
    expect(blockRes.body.kind).toBe('block');

    const removeRes = await dmAgent.delete(`/api/v1/campaigns/${campaignId}/members/${memberId}`);
    expect(removeRes.status).toBe(204);

    const notes = await playerAgent.get('/api/v1/notifications');
    const items = Array.isArray(notes.body) ? notes.body : notes.body.items;
    const removed = items.find(
      (n: { type: string; campaignId: number; title: string }) =>
        n.type === 'removed_from_campaign' && n.campaignId === campaignId && n.title.includes('removed'),
    );
    expect(removed).toBeDefined();

    const playerCount = await playerAgent.get('/api/v1/notifications/unread-count');
    expect(playerCount.body.membershipChanged).toBe(true);

    // Leaving the block in place is fine for the rest of this describe block: the fix under
    // test means removed_from_campaign no longer consults it at all, and no other notification
    // types pass between this player and this dm in the remaining tests below.
  });

  it('self-leave notifies the leaving user too (their OTHER open tabs, not this request) with distinct copy', async () => {
    const addRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: playerId, role: 'player' });
    expect(addRes.status).toBe(201);
    const memberId = addRes.body.id;

    const leaveRes = await playerAgent.delete(`/api/v1/campaigns/${campaignId}/members/${memberId}`);
    expect(leaveRes.status).toBe(204);

    // Unlike a dm-initiated removal, self-leave DOES self-notify (opts.allowSelf) — it is
    // the same person, but the point is reaching their OTHER tabs, which this request
    // cannot do directly.
    const notes = await playerAgent.get('/api/v1/notifications');
    const items = Array.isArray(notes.body) ? notes.body : notes.body.items;
    const left = items.find(
      (n: { type: string; campaignId: number; title: string }) =>
        n.type === 'removed_from_campaign' && n.campaignId === campaignId && n.title.includes('left'),
    );
    expect(left).toBeDefined();

    const playerCount = await playerAgent.get('/api/v1/notifications/unread-count');
    expect(playerCount.body.membershipChanged).toBe(true);
  });

  it('the last dm can neither be removed nor self-leave (409) — no revocation notification for a no-op removal', async () => {
    // dm is the sole dm of this campaign at this point (player left in the prior test).
    const membersRes = await dmAgent.get(`/api/v1/campaigns/${campaignId}/members`);
    const dmMember = membersRes.body.find((m: { role: string }) => m.role === 'dm');
    expect(dmMember).toBeDefined();

    const selfLeave = await dmAgent.delete(`/api/v1/campaigns/${campaignId}/members/${dmMember.id}`);
    expect(selfLeave.status).toBe(409);

    const meRes = await dmAgent.get('/api/v1/me');
    expect(meRes.body.memberships.some((m: { campaignId: number }) => m.campaignId === campaignId)).toBe(true);
  });
});
