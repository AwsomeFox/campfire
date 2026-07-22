import request from 'supertest';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';

/**
 * Issue #158 — server-enforced token WRITE-MODE, orthogonal to read scope.
 *
 * Before this fix a token's `scope` (dm/player/viewer) capped read AND write
 * together, and the proposal path was purely voluntary: a write controller only
 * created a proposal when the CALLER set `?proposed=true`. So an AI-DM token with
 * dm scope — needed just to READ the campaign (secrets, hidden context) — could
 * silently omit the flag and rewrite or DELETE canon directly. The "proposal
 * queue" safety valve was a per-request flag the AI chose to set, not a server
 * guarantee.
 *
 * Fix: an independent `writeScope` on the token:
 *  - 'direct'  — writes apply immediately (default, back-compat).
 *  - 'propose' — every mutation is COERCED into a pending proposal server-side,
 *                regardless of the `?proposed=` flag; direct canon writes are
 *                impossible, and write endpoints with no proposal path are 403.
 *  - 'none'    — read-only: every write is rejected; reads are unaffected.
 */
describe('Issue #158: server-enforced token write-mode (e2e)', () => {
  let ctx: TestAppContext;
  let dmAgent: ReturnType<typeof request.agent>;
  let campaignId: number;
  let npcId: number;
  let questId: number;

  // dm read scope in every case — the whole point is that read authority (dm) and
  // write authority (direct/propose/none) are independent dimensions.
  let directToken: string;
  let proposeToken: string;
  let noneToken: string;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    dmAgent = request.agent(server);
    await dmAgent.post('/api/v1/auth/setup').send({ username: 'wm-dm', password: 'dm-password-1' });

    const campRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'Write-Mode Campaign' });
    campaignId = campRes.body.id;

    const npcRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/npcs`).send({ name: 'Original NPC' });
    npcId = npcRes.body.id;

    const questRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/quests`).send({ title: 'Original Quest' });
    questId = questRes.body.id;

    // Mint three dm-scoped tokens differing ONLY in write authority.
    const directMint = await dmAgent.post('/api/v1/tokens').send({ name: 'wm-direct', scope: 'dm', writeScope: 'direct' });
    directToken = directMint.body.token;
    const proposeMint = await dmAgent.post('/api/v1/tokens').send({ name: 'wm-propose', scope: 'dm', writeScope: 'propose' });
    proposeToken = proposeMint.body.token;
    const noneMint = await dmAgent.post('/api/v1/tokens').send({ name: 'wm-none', scope: 'dm', writeScope: 'none' });
    noneToken = noneMint.body.token;

    expect(directMint.body.apiToken.writeScope).toBe('direct');
    expect(proposeMint.body.apiToken.writeScope).toBe('propose');
    expect(noneMint.body.apiToken.writeScope).toBe('none');
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  const authed = (token: string) => request(ctx.app.getHttpServer()).set('Authorization', `Bearer ${token}`) as never;

  describe('propose-mode token is FORCED down the proposal path', () => {
    it('CREATE without ?proposed=true is coerced into a pending proposal, not a direct write', async () => {
      const server = ctx.app.getHttpServer();
      const before = await dmAgent.get(`/api/v1/campaigns/${campaignId}/npcs`);
      const beforeCount = before.body.length;

      // No ?proposed flag — a pre-#158 dm token would have written directly (201).
      const res = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/npcs`)
        .set('Authorization', `Bearer ${proposeToken}`)
        .send({ name: 'Injected NPC' });
      expect(res.status).toBe(202);
      expect(res.body.proposal.status).toBe('pending');
      expect(res.body.proposal.action).toBe('create');
      expect(res.body.proposal.entityType).toBe('npc');

      // The NPC was NOT created directly — the canon is untouched until the DM approves.
      const after = await dmAgent.get(`/api/v1/campaigns/${campaignId}/npcs`);
      expect(after.body.length).toBe(beforeCount);
      expect(after.body.some((n: { name: string }) => n.name === 'Injected NPC')).toBe(false);
    });

    it('UPDATE without ?proposed=true is coerced into a proposal; the entity is unchanged', async () => {
      const res = await request(ctx.app.getHttpServer())
        .patch(`/api/v1/npcs/${npcId}`)
        .set('Authorization', `Bearer ${proposeToken}`)
        .send({ name: 'Rewritten NPC' });
      expect(res.status).toBe(202);
      expect(res.body.proposal.action).toBe('update');
      expect(res.body.proposal.entityId).toBe(npcId);

      const npc = await dmAgent.get(`/api/v1/npcs/${npcId}`);
      expect(npc.body.name).toBe('Original NPC');
    });

    it('DELETE without ?proposed=true is coerced into a proposal; the entity still exists', async () => {
      const res = await request(ctx.app.getHttpServer())
        .delete(`/api/v1/npcs/${npcId}`)
        .set('Authorization', `Bearer ${proposeToken}`);
      expect(res.status).toBe(202);
      expect(res.body.proposal.action).toBe('delete');

      const npc = await dmAgent.get(`/api/v1/npcs/${npcId}`);
      expect(npc.status).toBe(200);
      expect(npc.body.name).toBe('Original NPC');
    });

    it('an explicit ?proposed=true still yields a proposal (idempotent with the forced mode)', async () => {
      const res = await request(ctx.app.getHttpServer())
        .post(`/api/v1/campaigns/${campaignId}/npcs?proposed=true`)
        .set('Authorization', `Bearer ${proposeToken}`)
        .send({ name: 'Explicitly Proposed NPC' });
      expect(res.status).toBe(202);
      expect(res.body.proposal.status).toBe('pending');
    });

    it('is rejected (403) on a write endpoint that has NO proposal path (quest status)', async () => {
      // POST /quests/:id/status is a direct-only mutation — a propose token can't
      // route it through review, so the safe answer is to block it, not write it.
      const res = await request(ctx.app.getHttpServer())
        .post(`/api/v1/quests/${questId}/status`)
        .set('Authorization', `Bearer ${proposeToken}`)
        .send({ status: 'active' });
      expect(res.status).toBe(403);

      const quest = await dmAgent.get(`/api/v1/quests/${questId}`);
      expect(quest.body.status).not.toBe('active');
    });

    it('reads are UNAFFECTED — dm read scope still sees the campaign (incl. dm-only list)', async () => {
      const res = await request(ctx.app.getHttpServer())
        .get(`/api/v1/campaigns/${campaignId}/npcs`)
        .set('Authorization', `Bearer ${proposeToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe('none-mode (read-only) token', () => {
    it('is rejected (403) on a direct write', async () => {
      const res = await request(ctx.app.getHttpServer())
        .post(`/api/v1/campaigns/${campaignId}/npcs`)
        .set('Authorization', `Bearer ${noneToken}`)
        .send({ name: 'Should Not Exist' });
      expect(res.status).toBe(403);
    });

    it('is rejected (403) even WITH ?proposed=true — read-only means no writes at all', async () => {
      const res = await request(ctx.app.getHttpServer())
        .post(`/api/v1/campaigns/${campaignId}/npcs?proposed=true`)
        .set('Authorization', `Bearer ${noneToken}`)
        .send({ name: 'Should Not Propose Either' });
      expect(res.status).toBe(403);
    });

    it('can still READ (scope is dm) — write-mode does not touch read authority', async () => {
      const res = await request(ctx.app.getHttpServer())
        .get(`/api/v1/campaigns/${campaignId}/npcs`)
        .set('Authorization', `Bearer ${noneToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe('direct-mode (default) token is unchanged', () => {
    it('writes DIRECTLY without a flag (201, real entity)', async () => {
      const res = await request(ctx.app.getHttpServer())
        .post(`/api/v1/campaigns/${campaignId}/npcs`)
        .set('Authorization', `Bearer ${directToken}`)
        .send({ name: 'Direct NPC' });
      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
      expect(res.body.name).toBe('Direct NPC');
    });

    it('still honors the opt-in ?proposed=true flag (202 proposal)', async () => {
      const res = await request(ctx.app.getHttpServer())
        .post(`/api/v1/campaigns/${campaignId}/npcs?proposed=true`)
        .set('Authorization', `Bearer ${directToken}`)
        .send({ name: 'Opted-in Proposal NPC' });
      expect(res.status).toBe(202);
      expect(res.body.proposal.status).toBe('pending');
    });

    it('can drive a direct-only endpoint (quest status) — no proposal path needed', async () => {
      const res = await request(ctx.app.getHttpServer())
        .post(`/api/v1/quests/${questId}/status`)
        .set('Authorization', `Bearer ${directToken}`)
        .send({ status: 'active' });
      expect(res.status).toBe(201);
    });

    it('a token minted with no writeScope defaults to propose (safe, issue #575)', async () => {
      // Issue #575: newly-issued tokens default to 'propose' so AI/agent writes
      // land in the DM approval queue rather than touching canon directly. An
      // admin who wants direct writes must opt in explicitly at mint time.
      const mint = await dmAgent.post('/api/v1/tokens').send({ name: 'wm-default', scope: 'dm' });
      expect(mint.body.apiToken.writeScope).toBe('propose');
    });
  });

  // Issue #575 regression: EVERY mint path defaults omitted writeScope to
  // 'propose', and the safe default really routes a canon write into the DM
  // proposal queue (not direct to canon). If the default flips back to 'direct',
  // every assertion in this block fails — that is the regression guard.
  describe('Issue #575: newly-issued tokens default to propose across every mint path', () => {
    it('self-service POST /tokens defaults writeScope to propose', async () => {
      const mint = await dmAgent.post('/api/v1/tokens').send({ name: 'wm575-self', scope: 'dm' });
      expect(mint.status).toBe(201);
      expect(mint.body.apiToken.writeScope).toBe('propose');
    });

    it('admin POST /users/:id/tokens defaults writeScope to propose', async () => {
      // wm-dm (the setup user) is the server admin; mint on behalf of themself.
      const dmMe = await dmAgent.get('/api/v1/me');
      const dmId = dmMe.body.user.id;
      const mint = await dmAgent
        .post(`/api/v1/users/${dmId}/tokens`)
        .send({ tokenName: 'wm575-admin-provisioned', scope: 'dm' });
      expect(mint.status).toBe(201);
      expect(mint.body.apiToken.writeScope).toBe('propose');
    });

    it('headless POST /auth/token defaults writeScope to propose', async () => {
      const mint = await request(ctx.app.getHttpServer())
        .post('/api/v1/auth/token')
        .send({ username: 'wm-dm', password: 'dm-password-1', tokenName: 'wm575-headless', scope: 'dm' });
      expect(mint.status).toBe(201);
      expect(mint.body.apiToken.writeScope).toBe('propose');
    });

    it('a propose-default token routes a canon write into the DM queue (202), never direct (201)', async () => {
      // The point of the safe default: an AI minting a token with no writeScope
      // and immediately writing must NOT touch canon — its mutation lands as a
      // pending proposal. This is the user-visible safety guarantee of #575.
      const mint = await dmAgent.post('/api/v1/tokens').send({ name: 'wm575-canary', scope: 'dm' });
      expect(mint.body.apiToken.writeScope).toBe('propose');
      const rawToken = mint.body.token;

      const before = await dmAgent.get(`/api/v1/campaigns/${campaignId}/npcs`);
      const beforeCount = before.body.length;

      const write = await request(ctx.app.getHttpServer())
        .post(`/api/v1/campaigns/${campaignId}/npcs`)
        .set('Authorization', `Bearer ${rawToken}`)
        .send({ name: 'wm575 should be proposed, not written' });
      expect(write.status).toBe(202); // proposed, NOT 201 direct
      expect(write.body.proposal.status).toBe('pending');
      expect(write.body.proposal.action).toBe('create');

      // Canon is untouched — the NPC does not exist until a DM approves.
      const after = await dmAgent.get(`/api/v1/campaigns/${campaignId}/npcs`);
      expect(after.body.length).toBe(beforeCount);
      expect(after.body.some((n: { name: string }) => n.name === 'wm575 should be proposed, not written')).toBe(false);
    });

    it('opting into writeScope: direct still works (the default is safe, not mandatory)', async () => {
      // The flip is in the DEFAULT — an admin who explicitly asks for direct
      // still gets it. This proves the change is "safe default", not "direct
      // removed".
      const mint = await dmAgent.post('/api/v1/tokens').send({ name: 'wm575-explicit-direct', scope: 'dm', writeScope: 'direct' });
      expect(mint.body.apiToken.writeScope).toBe('direct');
    });
  });

  describe('/me surfaces the token write-mode', () => {
    it('reports writeScope for the authenticating token', async () => {
      const res = await request(ctx.app.getHttpServer())
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${proposeToken}`);
      expect(res.status).toBe(200);
      expect(res.body.token.writeScope).toBe('propose');
    });
  });

  describe('write-mode is capped when a token mints a child token (no escalation)', () => {
    it('a propose-only token cannot mint a direct-write sibling — capped to propose', async () => {
      const res = await request(ctx.app.getHttpServer())
        .post('/api/v1/tokens')
        .set('Authorization', `Bearer ${proposeToken}`)
        .send({ name: 'wm-propose-child', scope: 'dm', writeScope: 'direct' });
      expect(res.status).toBe(201);
      expect(res.body.apiToken.writeScope).toBe('propose'); // silently downgraded, like scope/adminEnabled

      // And the child really can't write directly either.
      const write = await request(ctx.app.getHttpServer())
        .post(`/api/v1/campaigns/${campaignId}/npcs`)
        .set('Authorization', `Bearer ${res.body.token}`)
        .send({ name: 'Child Direct Write' });
      expect(write.status).toBe(202); // forced to propose, not 201
    });

    it('a read-only token cannot mint a writable sibling — capped to none (still no writes)', async () => {
      const res = await request(ctx.app.getHttpServer())
        .post('/api/v1/tokens')
        .set('Authorization', `Bearer ${noneToken}`)
        .send({ name: 'wm-none-child', scope: 'dm', writeScope: 'direct' });
      expect(res.status).toBe(201);
      expect(res.body.apiToken.writeScope).toBe('none');
    });
  });
});
