import request from 'supertest';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';

/**
 * Issue #41 fix pinning tests — see tokens.service.ts (create()).
 *
 * VERIFIED finding this closes: a token's `scope` is supposed to be the cap on
 * what that credential can do (the whole point of handing an AI agent a
 * read-only PAT). But POST /tokens only capped a NEW token against the owner's
 * membership role, never against the CALLING token's own scope — so a
 * viewer-scoped PAT owned by a DM member could mint itself a sibling dm-scoped
 * PAT and then rewrite canon or drive combat. Same escalation class as the
 * adminEnabled cap (admin-token-cap.e2e-spec.ts), on the role-scope dimension.
 *
 * Fix: a token minted BY a token is capped to the minting token —
 * scope = min(requested, calling token's scope) (silent downgrade, matching
 * the adminEnabled convention), and a campaign-bound calling token can only
 * mint tokens bound to that same campaign. Session-cookie minting is unchanged.
 */
describe('Issue #41: a PAT can never mint a broader PAT (e2e)', () => {
  let ctx: TestAppContext;
  let adminAgent: ReturnType<typeof request.agent>;
  let daisyAgent: ReturnType<typeof request.agent>;
  let campaignId: number;
  let otherCampaignId: number;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    adminAgent = request.agent(server);
    await adminAgent.post('/api/v1/auth/setup').send({ username: 'scope-cap-admin', password: 'admin-password-1' });

    // daisy: an ordinary user who is a DM member of one campaign and a player in another.
    const createDaisyRes = await adminAgent
      .post('/api/v1/users')
      .send({ username: 'daisy', password: 'daisy-password-1', serverRole: 'user' });
    const daisyId = createDaisyRes.body.id;

    daisyAgent = request.agent(server);
    await daisyAgent.post('/api/v1/auth/login').send({ username: 'daisy', password: 'daisy-password-1' });

    const campRes = await adminAgent.post('/api/v1/campaigns').send({ name: 'Scope Cap Campaign' });
    campaignId = campRes.body.id;
    const otherCampRes = await adminAgent.post('/api/v1/campaigns').send({ name: 'Other Scope Cap Campaign' });
    otherCampaignId = otherCampRes.body.id;

    await adminAgent.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: daisyId, role: 'dm' });
    await adminAgent.post(`/api/v1/campaigns/${otherCampaignId}/members`).send({ userId: daisyId, role: 'player' });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  describe('scope escalation via POST /tokens (the exact adversarial repro)', () => {
    it("daisy's viewer PAT cannot promote itself to a dm PAT and create a quest", async () => {
      const server = ctx.app.getHttpServer();

      // daisy (a DM member) mints herself a read-only viewer PAT via her cookie session.
      // writeScope: 'direct' explicit (issue #575 default is 'propose') — the
      // sanity check below asserts viewer scope BLOCKS a direct write (403); under
      // the propose default the same call would route to the DM queue (202).
      const viewerMint = await daisyAgent.post('/api/v1/tokens').send({ name: 'daisy-viewer', scope: 'viewer', writeScope: 'direct' });
      expect(viewerMint.status).toBe(201);
      expect(viewerMint.body.apiToken.scope).toBe('viewer');
      const viewerToken = viewerMint.body.token;

      // Sanity (matches the issue report): the viewer PAT is refused a direct quest create.
      const directQuestRes = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/quests`)
        .set('Authorization', `Bearer ${viewerToken}`)
        .send({ title: 'Should Not Exist' });
      expect(directQuestRes.status).toBe(403);

      // Exact repro: the viewer PAT mints a dm-scoped sibling PAT. Previously the
      // request stored scope:'dm' verbatim (capped only by daisy's dm membership).
      // Now the minted token's scope must be silently downgraded to 'viewer'.
      // writeScope: 'direct' explicit on the child (issue #575 default is
      // 'propose') so the closure assertion below exercises a DIRECT write blocked
      // by viewer scope (403), not a propose-routed 202.
      const escalateMint = await request(server)
        .post('/api/v1/tokens')
        .set('Authorization', `Bearer ${viewerToken}`)
        .send({ name: 'daisy-escalated-dm', scope: 'dm', writeScope: 'direct' });
      expect(escalateMint.status).toBe(201); // request succeeds, but...
      expect(escalateMint.body.apiToken.scope).toBe('viewer'); // ...capped to the minting token's scope.

      // Exact repro closure: the minted token must NOT be able to create a quest (was 201).
      const questRes = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/quests`)
        .set('Authorization', `Bearer ${escalateMint.body.token}`)
        .send({ title: 'Escalated Quest' });
      expect(questRes.status).toBe(403);
    });

    it('the cap chains: a capped child token cannot re-escalate through a grandchild', async () => {
      const server = ctx.app.getHttpServer();

      const playerMint = await daisyAgent.post('/api/v1/tokens').send({ name: 'daisy-player', scope: 'player' });
      expect(playerMint.body.apiToken.scope).toBe('player');

      // player token mints "dm" -> capped to player...
      const childMint = await request(server)
        .post('/api/v1/tokens')
        .set('Authorization', `Bearer ${playerMint.body.token}`)
        .send({ name: 'daisy-player-child', scope: 'dm' });
      expect(childMint.status).toBe(201);
      expect(childMint.body.apiToken.scope).toBe('player');

      // ...and the capped child minting "dm" again is still capped to player.
      const grandchildMint = await request(server)
        .post('/api/v1/tokens')
        .set('Authorization', `Bearer ${childMint.body.token}`)
        .send({ name: 'daisy-player-grandchild', scope: 'dm' });
      expect(grandchildMint.status).toBe(201);
      expect(grandchildMint.body.apiToken.scope).toBe('player');
    });

    it('a narrower-than-the-calling-token request is honored as-is (min, not overwrite)', async () => {
      const server = ctx.app.getHttpServer();
      const dmMint = await daisyAgent.post('/api/v1/tokens').send({ name: 'daisy-dm', scope: 'dm' });
      expect(dmMint.body.apiToken.scope).toBe('dm');

      const narrowerMint = await request(server)
        .post('/api/v1/tokens')
        .set('Authorization', `Bearer ${dmMint.body.token}`)
        .send({ name: 'daisy-dm-narrower', scope: 'viewer' });
      expect(narrowerMint.status).toBe(201);
      expect(narrowerMint.body.apiToken.scope).toBe('viewer');
    });
  });

  describe('campaign-binding escalation via POST /tokens', () => {
    it('a campaign-bound token cannot mint a token for a DIFFERENT campaign the owner belongs to (403)', async () => {
      const server = ctx.app.getHttpServer();

      const boundMint = await daisyAgent
        .post('/api/v1/tokens')
        .send({ name: 'daisy-bound', scope: 'dm', campaignId });
      expect(boundMint.status).toBe(201);
      expect(boundMint.body.apiToken.campaignId).toBe(campaignId);

      // daisy IS a member of otherCampaignId, so the old membership-only check passed —
      // but the calling token is bound to campaignId, so this must now 403.
      const crossCampaignMint = await request(server)
        .post('/api/v1/tokens')
        .set('Authorization', `Bearer ${boundMint.body.token}`)
        .send({ name: 'daisy-cross-campaign', scope: 'player', campaignId: otherCampaignId });
      expect(crossCampaignMint.status).toBe(403);
    });

    it('a campaign-bound token minting an UNBOUND token gets silently narrowed to its own campaign', async () => {
      const server = ctx.app.getHttpServer();

      const boundMint = await daisyAgent
        .post('/api/v1/tokens')
        .send({ name: 'daisy-bound-2', scope: 'player', campaignId });
      const boundToken = boundMint.body.token;

      // Requesting no campaignId ("all my campaigns") through a bound token must not widen.
      const unboundRequestMint = await request(server)
        .post('/api/v1/tokens')
        .set('Authorization', `Bearer ${boundToken}`)
        .send({ name: 'daisy-unbound-request', scope: 'player' });
      expect(unboundRequestMint.status).toBe(201);
      expect(unboundRequestMint.body.apiToken.campaignId).toBe(campaignId);

      // The minted token must not see the other campaign (still bound).
      const otherCampaignRes = await request(server)
        .get(`/api/v1/campaigns/${otherCampaignId}`)
        .set('Authorization', `Bearer ${unboundRequestMint.body.token}`);
      expect([403, 404]).toContain(otherCampaignRes.status);
    });

    it('a campaign-bound token minting for its OWN campaign still works', async () => {
      const server = ctx.app.getHttpServer();

      const boundMint = await daisyAgent
        .post('/api/v1/tokens')
        .send({ name: 'daisy-bound-3', scope: 'dm', campaignId });

      const sameCampaignMint = await request(server)
        .post('/api/v1/tokens')
        .set('Authorization', `Bearer ${boundMint.body.token}`)
        .send({ name: 'daisy-same-campaign', scope: 'dm', campaignId });
      expect(sameCampaignMint.status).toBe(201);
      expect(sameCampaignMint.body.apiToken.campaignId).toBe(campaignId);
      expect(sameCampaignMint.body.apiToken.scope).toBe('dm');
    });

    it('an UNBOUND token can still mint a campaign-bound token (narrowing is fine)', async () => {
      const server = ctx.app.getHttpServer();
      const unboundMint = await daisyAgent.post('/api/v1/tokens').send({ name: 'daisy-unbound', scope: 'dm' });

      const narrowMint = await request(server)
        .post('/api/v1/tokens')
        .set('Authorization', `Bearer ${unboundMint.body.token}`)
        .send({ name: 'daisy-narrowed', scope: 'dm', campaignId });
      expect(narrowMint.status).toBe(201);
      expect(narrowMint.body.apiToken.campaignId).toBe(campaignId);
    });
  });

  describe('non-token paths are unchanged', () => {
    it('cookie-session minting still honors the requested scope up to membership semantics (no cap applied)', async () => {
      const server = ctx.app.getHttpServer();
      // writeScope: 'direct' is explicit — the safe default is 'propose' now
      // (issue #575), but this test asserts a DIRECT quest create (201), so we
      // opt in rather than rely on the default.
      const dmMint = await daisyAgent.post('/api/v1/tokens').send({ name: 'daisy-cookie-dm', scope: 'dm', campaignId, writeScope: 'direct' });
      expect(dmMint.status).toBe(201);
      expect(dmMint.body.apiToken.scope).toBe('dm');

      // And it really is a working dm token: quest create succeeds.
      const questRes = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/quests`)
        .set('Authorization', `Bearer ${dmMint.body.token}`)
        .send({ title: 'Legit DM Quest' });
      expect(questRes.status).toBe(201);
    });

    it('POST /auth/token (fresh credentials, no calling token) still honors the requested scope', async () => {
      const res = await request(ctx.app.getHttpServer())
        .post('/api/v1/auth/token')
        .send({ username: 'daisy', password: 'daisy-password-1', tokenName: 'daisy-headless-dm', scope: 'dm', campaignId });
      expect(res.status).toBe(201);
      expect(res.body.apiToken.scope).toBe('dm');
    });
  });
});
