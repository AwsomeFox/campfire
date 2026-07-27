import request from 'supertest';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';

/**
 * Issue #597 — Viewer is genuinely read-only, and personal safety controls.
 *
 * Real cookie sessions (not DEV_AUTH) throughout, for the same reason
 * moderation.e2e-spec.ts uses them: everything here turns on WHO somebody is. The
 * interactive-guest capability lives on a `campaign_members` row, and blocks are keyed
 * on the account identity across campaigns and rejoins — DEV_AUTH's synthetic
 * `dev:<name>` identities have neither.
 *
 * Cast:
 *   admin     — server admin (first user via /auth/setup); mints the others.
 *   dmUser    — DM of the main campaign.
 *   viewerUser— a viewer seat. The subject of the read-only half.
 *   blocker   — blocks somebody, and must never be observable as having done so.
 *   abuser    — the blocked party. Every assertion about them is "they cannot tell".
 *   alt       — a SECOND, unrelated account. The honest limit of block enforcement.
 */
describe('Issue #597: read-only viewers, interactive guests, blocks, mutes, silence (e2e)', () => {
  let ctx: TestAppContext;
  let server: import('http').Server;
  let admin: ReturnType<typeof request.agent>;
  let dmUser: ReturnType<typeof request.agent>;
  let viewerUser: ReturnType<typeof request.agent>;
  let blocker: ReturnType<typeof request.agent>;
  let abuser: ReturnType<typeof request.agent>;
  let alt: ReturnType<typeof request.agent>;
  let dmUserId: number;
  let viewerUserId: number;
  let blockerId: number;
  let abuserId: number;
  let altId: number;
  let campaignId: number;
  let sessionId: number;
  let viewerMemberId: number;

  async function newUser(username: string, password: string) {
    const created = await admin.post('/api/v1/users').send({ username, password, serverRole: 'user' });
    expect(created.status).toBe(201);
    const agent = request.agent(server);
    const login = await agent.post('/api/v1/auth/login').send({ username, password });
    expect(login.status).toBe(201);
    return { agent, id: created.body.id as number };
  }

  async function memberIdOf(userId: number, campaign = campaignId): Promise<number> {
    const roster = await dmUser.get(`/api/v1/campaigns/${campaign}/members`);
    expect(roster.status).toBe(200);
    const row = (roster.body as Array<{ id: number; userId: number }>).find((m) => m.userId === userId);
    expect(row).toBeDefined();
    return row!.id;
  }

  /** Grant/revoke the interactive-guest capability on a seat. */
  async function setInteractiveGuest(memberId: number, value: boolean, campaign = campaignId) {
    const res = await dmUser.patch(`/api/v1/campaigns/${campaign}/members/${memberId}`).send({ interactiveGuest: value });
    expect(res.status).toBe(200);
    return res;
  }

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    server = ctx.app.getHttpServer();

    admin = request.agent(server);
    const setup = await admin.post('/api/v1/auth/setup').send({ username: 'safety-admin', password: 'admin-password-1' });
    expect(setup.status).toBe(201);

    ({ agent: dmUser, id: dmUserId } = await newUser('safety-dm', 'dm-password-1'));
    ({ agent: viewerUser, id: viewerUserId } = await newUser('safety-viewer', 'viewer-password-1'));
    ({ agent: blocker, id: blockerId } = await newUser('safety-blocker', 'blocker-password-1'));
    ({ agent: abuser, id: abuserId } = await newUser('safety-abuser', 'abuser-password-1'));
    ({ agent: alt, id: altId } = await newUser('safety-alt', 'alt-password-1'));

    const camp = await dmUser.post('/api/v1/campaigns').send({ name: 'Safety Table' });
    expect(camp.status).toBe(201);
    campaignId = camp.body.id;

    for (const id of [blockerId, abuserId, altId]) {
      const add = await dmUser.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: id, role: 'player' });
      expect(add.status).toBe(201);
    }
    const addViewer = await dmUser
      .post(`/api/v1/campaigns/${campaignId}/members`)
      .send({ userId: viewerUserId, role: 'viewer' });
    expect(addViewer.status).toBe(201);
    viewerMemberId = await memberIdOf(viewerUserId);

    const sess = await dmUser.post(`/api/v1/campaigns/${campaignId}/sessions`).send({ title: 'Session One' });
    expect(sess.status).toBe(201);
    sessionId = sess.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  // -------------------------------------------------------------------------
  // Viewer is read-only (the core finding)
  // -------------------------------------------------------------------------

  describe('a viewer seat is genuinely read-only', () => {
    it('refuses comments, shared notes, whispers, and DM-inbox posts', async () => {
      const comment = await viewerUser
        .post(`/api/v1/campaigns/${campaignId}/comments`)
        .send({ entityType: 'session', entityId: sessionId, body: 'viewer comment' });
      expect(comment.status).toBe(403);
      // The refusal must be actionable, not a bare "forbidden": a viewer who could post
      // yesterday needs to know what changed and who can restore it.
      expect(String(comment.body.message)).toContain('interactive-guest');

      const shared = await viewerUser
        .post(`/api/v1/campaigns/${campaignId}/notes`)
        .send({ body: 'viewer broadcast', visibility: 'party_shared' });
      expect(shared.status).toBe(403);

      const whisper = await viewerUser
        .post(`/api/v1/campaigns/${campaignId}/notes`)
        .send({ body: 'viewer whisper', visibility: 'whisper', recipientUserId: String(blockerId) });
      expect(whisper.status).toBe(403);

      const dmShared = await viewerUser
        .post(`/api/v1/campaigns/${campaignId}/notes`)
        .send({ body: 'viewer note to dm', visibility: 'dm_shared' });
      expect(dmShared.status).toBe(403);

      const inbox = await viewerUser.post(`/api/v1/campaigns/${campaignId}/inbox`).send({ body: 'viewer inbox item' });
      expect(inbox.status).toBe(403);
    });

    /**
     * The whisper refusal must fire BEFORE recipient validation, or the read-only gate
     * would still leak roster membership: "recipient must be a member" vs "read-only"
     * would tell a viewer which ids are seated at the table.
     */
    it('refuses a whisper to a NON-member with the same read-only error, not a roster hint', async () => {
      const res = await viewerUser
        .post(`/api/v1/campaigns/${campaignId}/notes`)
        .send({ body: 'probe', visibility: 'whisper', recipientUserId: '99999' });
      expect(res.status).toBe(403);
      expect(String(res.body.message)).toContain('read-only');
      expect(String(res.body.message)).not.toContain('member of this campaign');
    });

    /**
     * The deliberate exception. A private note reaches nobody, and it is the entire
     * point of a Viewer seat — gating it would be a functional regression with no
     * observable safety benefit.
     */
    it('still allows a private note, which reaches nobody', async () => {
      const res = await viewerUser
        .post(`/api/v1/campaigns/${campaignId}/notes`)
        .send({ body: 'my own private note', visibility: 'private' });
      expect(res.status).toBe(201);
      expect(res.body.visibility).toBe('private');

      const edit = await viewerUser.patch(`/api/v1/notes/${res.body.id}`).send({ body: 'still private' });
      expect(edit.status).toBe(200);

      // ...but promoting that private note to an outbound visibility is the gated act.
      const promote = await viewerUser.patch(`/api/v1/notes/${res.body.id}`).send({ visibility: 'party_shared' });
      expect(promote.status).toBe(403);
    });

    it('a player seat is unaffected', async () => {
      const comment = await abuser
        .post(`/api/v1/campaigns/${campaignId}/comments`)
        .send({ entityType: 'session', entityId: sessionId, body: 'player comment' });
      expect(comment.status).toBe(201);
    });
  });

  // -------------------------------------------------------------------------
  // Interactive guest: the separate, explicit capability
  // -------------------------------------------------------------------------

  describe('interactive guest is a separate explicit capability', () => {
    it('a DM can grant it, which restores discussion without granting content authority', async () => {
      await setInteractiveGuest(viewerMemberId, true);

      const comment = await viewerUser
        .post(`/api/v1/campaigns/${campaignId}/comments`)
        .send({ entityType: 'session', entityId: sessionId, body: 'guest comment' });
      expect(comment.status).toBe(201);

      const whisper = await viewerUser
        .post(`/api/v1/campaigns/${campaignId}/notes`)
        .send({ body: 'guest whisper', visibility: 'whisper', recipientUserId: String(blockerId) });
      expect(whisper.status).toBe(201);

      // Still a viewer: no authority over campaign content.
      const quest = await viewerUser.post(`/api/v1/campaigns/${campaignId}/quests`).send({ title: 'Guest quest' });
      expect(quest.status).toBe(403);
    });

    it('the roster reports the capability, and revoking it takes effect immediately', async () => {
      const roster = await dmUser.get(`/api/v1/campaigns/${campaignId}/members`);
      const seat = (roster.body as Array<{ userId: number; interactiveGuest: boolean }>).find(
        (m) => m.userId === viewerUserId,
      );
      expect(seat?.interactiveGuest).toBe(true);

      await setInteractiveGuest(viewerMemberId, false);
      const comment = await viewerUser
        .post(`/api/v1/campaigns/${campaignId}/comments`)
        .send({ entityType: 'session', entityId: sessionId, body: 'after revoke' });
      expect(comment.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // Invite preview
  // -------------------------------------------------------------------------

  describe('invite preview shows effective permissions', () => {
    it('a viewer invite previews as read-only; a player invite does not', async () => {
      const viewerInvite = await dmUser.post(`/api/v1/campaigns/${campaignId}/invites`).send({ role: 'viewer' });
      expect(viewerInvite.status).toBe(201);
      const viewerPreview = await request(server).get(`/api/v1/invites/${viewerInvite.body.code}`);
      expect(viewerPreview.status).toBe(200);
      expect(viewerPreview.body.role).toBe('viewer');
      expect(viewerPreview.body.permissions).toMatchObject({
        role: 'viewer',
        readOnly: true,
        interactiveGuest: false,
        canComment: false,
        canWhisper: false,
        canShareNotes: false,
        canSubmitToDmInbox: false,
        canKeepPrivateNotes: true,
        canEditCampaignContent: false,
        canModerate: false,
      });

      const playerInvite = await dmUser.post(`/api/v1/campaigns/${campaignId}/invites`).send({ role: 'player' });
      const playerPreview = await request(server).get(`/api/v1/invites/${playerInvite.body.code}`);
      expect(playerPreview.status).toBe(200);
      expect(playerPreview.body.permissions).toMatchObject({
        role: 'player',
        readOnly: false,
        interactiveGuest: false,
        canComment: true,
        canWhisper: true,
        canEditCampaignContent: true,
        canModerate: false,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Block — and, above all, its non-disclosure
  // -------------------------------------------------------------------------

  describe('block prevents targeting and notification without revealing itself', () => {
    let blockId: number;
    let unblockedWhisper: request.Response;

    it('is created from a campaign the two share, and is account-wide', async () => {
      const res = await blocker
        .post(`/api/v1/campaigns/${campaignId}/safety/blocks`)
        .send({ targetUserId: String(abuserId), reason: 'repeated whispers' });
      expect(res.status).toBe(201);
      expect(res.body.kind).toBe('block');
      expect(res.body.targetUserId).toBe(String(abuserId));
      // campaignId null is the account-wide marker, not a bug.
      expect(res.body.campaignId).toBeNull();
      blockId = res.body.id;

      // Idempotent: a double-tap must not produce two rows to lift separately.
      const again = await blocker
        .post(`/api/v1/campaigns/${campaignId}/safety/blocks`)
        .send({ targetUserId: String(abuserId) });
      expect(again.status).toBe(201);
      expect(again.body.id).toBe(blockId);
    });

    it('you can only block someone you share a campaign with, and never yourself', async () => {
      const stranger = await blocker
        .post(`/api/v1/campaigns/${campaignId}/safety/blocks`)
        .send({ targetUserId: '424242' });
      expect(stranger.status).toBe(400);

      const self = await blocker
        .post(`/api/v1/campaigns/${campaignId}/safety/blocks`)
        .send({ targetUserId: String(blockerId) });
      expect(self.status).toBe(400);
    });

    /**
     * THE CENTRAL NON-DISCLOSURE ASSERTION.
     *
     * A whisper to somebody who blocks you must be byte-for-byte indistinguishable, from
     * the sender's side, from a whisper to somebody who does not. Same status, same
     * response shape, same visibility in their own reads. If any of these diverged, the
     * block would be an oracle and a harasser would learn exactly when they were blocked.
     */
    it('a blocked whisper returns the SAME 201 and the SAME shape as an unblocked one', async () => {
      unblockedWhisper = await abuser
        .post(`/api/v1/campaigns/${campaignId}/notes`)
        .send({ body: 'control whisper to alt', visibility: 'whisper', recipientUserId: String(altId) });
      expect(unblockedWhisper.status).toBe(201);

      const blocked = await abuser
        .post(`/api/v1/campaigns/${campaignId}/notes`)
        .send({ body: 'whisper into the void', visibility: 'whisper', recipientUserId: String(blockerId) });
      expect(blocked.status).toBe(201);
      expect(blocked.body.visibility).toBe('whisper');
      expect(blocked.body.recipientUserId).toBe(String(blockerId));
      // The response carries no delivery signal of ANY kind — so its absence leaks
      // nothing. Same keys as the control whisper, and none of them is a delivery,
      // suppression, or block indicator that a sender could diff against.
      expect(Object.keys(blocked.body).sort()).toEqual(Object.keys(unblockedWhisper.body).sort());
      for (const key of Object.keys(blocked.body)) {
        expect(key.toLowerCase()).not.toMatch(/block|deliver|suppress|read|seen/);
      }

      // And the sender still sees their own whisper in their own notes list, exactly as
      // they would if it had been delivered.
      const own = await abuser.get(`/api/v1/campaigns/${campaignId}/notes?mine=true`);
      expect(own.status).toBe(200);
      expect((own.body.items as Array<{ id: number }>).some((n) => n.id === blocked.body.id)).toBe(true);
    });

    it('the blocked whisper never reaches the blocker: not in their notes, not in their bell', async () => {
      const notes = await blocker.get(`/api/v1/campaigns/${campaignId}/notes`);
      expect(notes.status).toBe(200);
      expect(JSON.stringify(notes.body)).not.toContain('whisper into the void');

      const bell = await blocker.get('/api/v1/notifications');
      expect(bell.status).toBe(200);
      expect(JSON.stringify(bell.body)).not.toContain('whisper into the void');
      expect(
        (bell.body.items as Array<{ actorUserId?: string; title: string }>).some((n) =>
          n.title.includes('safety-abuser'),
        ),
      ).toBe(false);
    });

    it('the control whisper to an unblocked recipient DID arrive — so the difference is the block, not a broken path', async () => {
      const altNotes = await alt.get(`/api/v1/campaigns/${campaignId}/notes`);
      expect(altNotes.status).toBe(200);
      expect(JSON.stringify(altNotes.body)).toContain('control whisper to alt');
    });

    /**
     * The blocked content is HIDDEN, not destroyed. A DM keeps oversight and the
     * moderation evidence path still works, which is what a later safeguarding review
     * needs — the alternative (refusing the write) would leave nothing to review.
     */
    it('the DM still sees the blocked whisper, so oversight and reporting still work', async () => {
      const dmNotes = await dmUser.get(`/api/v1/campaigns/${campaignId}/notes`);
      expect(dmNotes.status).toBe(200);
      expect(JSON.stringify(dmNotes.body)).toContain('whisper into the void');
    });

    it('search does not surface a blocked member’s notes to the blocker', async () => {
      const mine = await blocker.get(`/api/v1/campaigns/${campaignId}/search?q=void`);
      expect(mine.status).toBe(200);
      expect(JSON.stringify(mine.body)).not.toContain('whisper into the void');
    });

    it('filters bell items that already existed when the block was filed', async () => {
      // A fresh pair so the "before" state is unambiguous.
      const before = await abuser
        .post(`/api/v1/campaigns/${campaignId}/notes`)
        .send({ body: 'earlier ping to alt', visibility: 'whisper', recipientUserId: String(altId) });
      expect(before.status).toBe(201);
      const altBell = await alt.get('/api/v1/notifications');
      expect(JSON.stringify(altBell.body)).toContain('earlier ping');

      const altBlock = await alt
        .post(`/api/v1/campaigns/${campaignId}/safety/blocks`)
        .send({ targetUserId: String(abuserId) });
      expect(altBlock.status).toBe(201);

      const after = await alt.get('/api/v1/notifications');
      expect(JSON.stringify(after.body)).not.toContain('earlier ping');

      // Lift it again so later cases start clean, and confirm the row was hidden, not deleted.
      const lift = await alt.delete(`/api/v1/campaigns/${campaignId}/safety/controls/${altBlock.body.id}`);
      expect(lift.status).toBe(200);
      const restored = await alt.get('/api/v1/notifications');
      expect(JSON.stringify(restored.body)).toContain('earlier ping');
    });

    it('lists only your own controls, and 404s an attempt to lift somebody else’s', async () => {
      const mine = await blocker.get(`/api/v1/campaigns/${campaignId}/safety/controls`);
      expect(mine.status).toBe(200);
      expect((mine.body as Array<{ id: number }>).some((c) => c.id === blockId)).toBe(true);

      // The blocked party must not be able to enumerate — or even confirm — the block.
      const theirs = await abuser.get(`/api/v1/campaigns/${campaignId}/safety/controls`);
      expect(theirs.status).toBe(200);
      expect(theirs.body).toEqual([]);

      const steal = await abuser.delete(`/api/v1/campaigns/${campaignId}/safety/controls/${blockId}`);
      expect(steal.status).toBe(404); // 404, not 403 — a 403 would confirm the id exists.
    });
  });

  // -------------------------------------------------------------------------
  // Multi-account abuse
  // -------------------------------------------------------------------------

  describe('multi-account abuse: what the block closes, and what it honestly cannot', () => {
    it('survives the blocked member leaving and being re-invited to the campaign', async () => {
      const memberId = await memberIdOf(abuserId);
      const remove = await dmUser.delete(`/api/v1/campaigns/${campaignId}/members/${memberId}`);
      expect(remove.status).toBe(204);
      const readd = await dmUser
        .post(`/api/v1/campaigns/${campaignId}/members`)
        .send({ userId: abuserId, role: 'player' });
      expect(readd.status).toBe(201);

      const whisper = await abuser
        .post(`/api/v1/campaigns/${campaignId}/notes`)
        .send({ body: 'rejoin evasion attempt', visibility: 'whisper', recipientUserId: String(blockerId) });
      expect(whisper.status).toBe(201);

      const bell = await blocker.get('/api/v1/notifications');
      expect(JSON.stringify(bell.body)).not.toContain('rejoin evasion attempt');
      const notes = await blocker.get(`/api/v1/campaigns/${campaignId}/notes`);
      expect(JSON.stringify(notes.body)).not.toContain('rejoin evasion attempt');
    });

    it('applies in a DIFFERENT campaign the two also share — the block is about a person, not a table', async () => {
      const camp = await dmUser.post('/api/v1/campaigns').send({ name: 'Second Table' });
      expect(camp.status).toBe(201);
      const second = camp.body.id as number;
      for (const id of [blockerId, abuserId]) {
        const add = await dmUser.post(`/api/v1/campaigns/${second}/members`).send({ userId: id, role: 'player' });
        expect(add.status).toBe(201);
      }

      const whisper = await abuser
        .post(`/api/v1/campaigns/${second}/notes`)
        .send({ body: 'cross-campaign evasion attempt', visibility: 'whisper', recipientUserId: String(blockerId) });
      expect(whisper.status).toBe(201);

      const bell = await blocker.get('/api/v1/notifications');
      expect(JSON.stringify(bell.body)).not.toContain('cross-campaign evasion attempt');
      const notes = await blocker.get(`/api/v1/campaigns/${second}/notes`);
      expect(JSON.stringify(notes.body)).not.toContain('cross-campaign evasion attempt');
    });

    it('is not routed around by a personal access token minted by the blocked account', async () => {
      const token = await abuser
        .post('/api/v1/tokens')
        .send({ name: 'evasion token', scope: 'player', writeScope: 'direct', campaignId });
      expect(token.status).toBe(201);
      const raw = token.body.token as string;

      const whisper = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/notes`)
        .set('Authorization', `Bearer ${raw}`)
        .send({ body: 'token evasion attempt', visibility: 'whisper', recipientUserId: String(blockerId) });
      expect(whisper.status).toBe(201);

      const bell = await blocker.get('/api/v1/notifications');
      expect(JSON.stringify(bell.body)).not.toContain('token evasion attempt');
    });

    /**
     * THE HONEST LIMIT, asserted rather than implied.
     *
     * A genuinely separate account IS delivered. This server stores no device, IP, or
     * session fingerprint (user_sessions holds a token hash, a user id and timestamps)
     * and no verified email, so there is no signal that could tie two accounts to one
     * human without guessing — and guessing would silence innocent members who happen to
     * share a display name. This test exists so the limit is a documented, reviewed
     * property rather than an unnoticed gap: the answer to a determined second account is
     * the DM's tools (conduct report, silence, removal, invite revocation), not a
     * fingerprint the server does not have.
     */
    it('does NOT extend to a second, unrelated account — and that limit is deliberate', async () => {
      const whisper = await alt
        .post(`/api/v1/campaigns/${campaignId}/notes`)
        .send({ body: 'a different account entirely', visibility: 'whisper', recipientUserId: String(blockerId) });
      expect(whisper.status).toBe(201);

      const notes = await blocker.get(`/api/v1/campaigns/${campaignId}/notes`);
      expect(JSON.stringify(notes.body)).toContain('a different account entirely');
    });
  });

  // -------------------------------------------------------------------------
  // Mute (personal, recipient-side) — distinct from block
  // -------------------------------------------------------------------------

  describe('sender and thread mutes are noise control, not protection', () => {
    it('a sender mute stops notifications but leaves the content fully visible', async () => {
      const mute = await blocker
        .post(`/api/v1/campaigns/${campaignId}/safety/mutes`)
        .send({ targetUserId: String(altId) });
      expect(mute.status).toBe(201);
      expect(mute.body.kind).toBe('mute_sender');
      expect(mute.body.campaignId).toBe(campaignId);

      const whisper = await alt
        .post(`/api/v1/campaigns/${campaignId}/notes`)
        .send({ body: 'muted-sender whisper', visibility: 'whisper', recipientUserId: String(blockerId) });
      expect(whisper.status).toBe(201);

      const bell = await blocker.get('/api/v1/notifications');
      expect(JSON.stringify(bell.body)).not.toContain('muted-sender whisper');
      // ...but unlike a block, the content itself is still there to read.
      const notes = await blocker.get(`/api/v1/campaigns/${campaignId}/notes`);
      expect(JSON.stringify(notes.body)).toContain('muted-sender whisper');

      const lift = await blocker.delete(`/api/v1/campaigns/${campaignId}/safety/controls/${mute.body.id}`);
      expect(lift.status).toBe(200);
    });

    it('a thread mute silences one anchored discussion', async () => {
      const mute = await blocker
        .post(`/api/v1/campaigns/${campaignId}/safety/mutes`)
        .send({ entityType: 'session', entityId: sessionId });
      expect(mute.status).toBe(201);
      expect(mute.body.kind).toBe('mute_thread');

      const note = await alt
        .post(`/api/v1/campaigns/${campaignId}/notes`)
        .send({ body: 'thread-muted party note', visibility: 'party_shared', entityType: 'session', entityId: sessionId });
      expect(note.status).toBe(201);

      const bell = await blocker.get('/api/v1/notifications');
      expect(JSON.stringify(bell.body)).not.toContain('thread-muted party note');

      const lift = await blocker.delete(`/api/v1/campaigns/${campaignId}/safety/controls/${mute.body.id}`);
      expect(lift.status).toBe(200);
    });

    it('rejects a mute that names neither or both targets', async () => {
      const neither = await blocker.post(`/api/v1/campaigns/${campaignId}/safety/mutes`).send({});
      expect(neither.status).toBe(400);
      const both = await blocker
        .post(`/api/v1/campaigns/${campaignId}/safety/mutes`)
        .send({ targetUserId: String(altId), entityType: 'session', entityId: sessionId });
      expect(both.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // Temporary silence — distinct from removal
  // -------------------------------------------------------------------------

  describe('temporary silence is distinct from removal', () => {
    it('stops the member posting while leaving their seat and their reads intact', async () => {
      const silence = await dmUser
        .post(`/api/v1/campaigns/${campaignId}/moderation/mutes`)
        .send({ userId: String(altId), hours: 2, reason: 'cool off' });
      expect(silence.status).toBe(201);
      expect(silence.body.userId).toBe(String(altId));
      expect(silence.body.expiresAt).toBeTruthy();

      const comment = await alt
        .post(`/api/v1/campaigns/${campaignId}/comments`)
        .send({ entityType: 'session', entityId: sessionId, body: 'silenced comment' });
      expect(comment.status).toBe(403);
      const note = await alt.post(`/api/v1/campaigns/${campaignId}/notes`).send({ body: 'silenced note' });
      expect(note.status).toBe(403);

      // NOT a removal: the seat, the roster row, and every read still work.
      const stillSeated = await dmUser.get(`/api/v1/campaigns/${campaignId}/members`);
      expect((stillSeated.body as Array<{ userId: number }>).some((m) => m.userId === altId)).toBe(true);
      const canStillRead = await alt.get(`/api/v1/campaigns/${campaignId}/notes`);
      expect(canStillRead.status).toBe(200);

      const listed = await dmUser.get(`/api/v1/campaigns/${campaignId}/moderation/mutes`);
      expect(listed.status).toBe(200);
      expect((listed.body as Array<{ userId: string }>).some((m) => m.userId === String(altId))).toBe(true);

      const lift = await dmUser.delete(`/api/v1/campaigns/${campaignId}/moderation/mutes/${silence.body.id}`);
      expect(lift.status).toBe(200);
      const after = await alt
        .post(`/api/v1/campaigns/${campaignId}/comments`)
        .send({ entityType: 'session', entityId: sessionId, body: 'unsilenced comment' });
      expect(after.status).toBe(201);
    });

    it('refuses to silence a DM (they could lift it themselves) or a non-member', async () => {
      const dmSilence = await dmUser
        .post(`/api/v1/campaigns/${campaignId}/moderation/mutes`)
        .send({ userId: String(dmUserId) });
      expect(dmSilence.status).toBe(400);

      const stranger = await dmUser
        .post(`/api/v1/campaigns/${campaignId}/moderation/mutes`)
        .send({ userId: '424242' });
      expect(stranger.status).toBe(400);
    });

    it('is DM-only — a player cannot silence anyone', async () => {
      const res = await alt.post(`/api/v1/campaigns/${campaignId}/moderation/mutes`).send({ userId: String(abuserId) });
      expect(res.status).toBe(403);
    });
  });
});
