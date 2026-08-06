import Database from 'better-sqlite3';
import path from 'node:path';
import request from 'supertest';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';

/**
 * Issue #851 — shared-instance governance, exercised through the real HTTP routes
 * (not just the service layer — see test/unit/campaign-governance.spec.ts for the
 * exhaustive policy/limit unit coverage). This proves: route registration order
 * ('allowance'/'creation-requests' resolve before the generic ':id' campaign
 * routes), @ServerRoles('admin') gates the admin-only endpoints, and the full
 * request -> approve -> create round trip works end to end.
 */
describe('shared-instance governance (issue #851, e2e)', () => {
  let ctx: TestAppContext;
  let adminAgent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    adminAgent = request.agent(ctx.app.getHttpServer());
    await adminAgent.post('/api/v1/auth/setup').send({ username: 'admin', password: 'admin-password-1' });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  async function createUser(username: string): Promise<ReturnType<typeof request.agent>> {
    await adminAgent.post('/api/v1/users').send({ username, password: `${username}-password-1`, serverRole: 'user' });
    const agent = request.agent(ctx.app.getHttpServer());
    const login = await agent.post('/api/v1/auth/login').send({ username, password: `${username}-password-1` });
    expect(login.status).toBe(201);
    return agent;
  }

  afterEach(async () => {
    // Reset governance settings between tests so they don't leak into each other.
    await adminAgent.patch('/api/v1/settings').send({
      campaignCreationPolicy: 'everyone',
      maxActiveCampaignsPerUser: null,
      maxTotalCampaignsPerUser: null,
      maxActiveCampaignsServerWide: null,
      maxTotalCampaignsServerWide: null,
      defaultCampaignStorageQuotaBytes: null,
    });
  });

  it('GET /campaigns/allowance resolves before the generic :id route (route-ordering)', async () => {
    const user = await createUser('routecheck1');
    const res = await user.get('/api/v1/campaigns/allowance');
    expect(res.status).toBe(200);
    expect(res.body.policy).toBe('everyone');
    expect(res.body.canCreate).toBe(true);
  });

  it('derives the filed request\'s audit role from the actor instead of hard-coding it', async () => {
    // Review asked for the requester's real role here. Worth being precise about what that can
    // mean: `AuditActorRole` is only 'admin' | 'dm', and `auditActorRole` returns 'dm' for any
    // non-admin — so an ordinary user's request is recorded as 'dm' either way, and the review's
    // stated impact (restricted users appearing as game masters) is a property of that
    // vocabulary, not of the hard-coding. What the change does fix is the ADMIN case, which the
    // literal 'dm' got wrong, and it stops the value drifting from `decide()` in the same
    // service. This test pins the derivation, which is the part that is actually true.
    await adminAgent.patch('/api/v1/settings').send({ campaignCreationPolicy: 'approved_organizers' });
    const filed = await adminAgent.post('/api/v1/campaigns/creation-requests').send({ note: 'please' });
    expect(filed.status).toBe(201);

    // Read from storage: the audit REST surface is campaign-scoped (`/campaigns/:id/audit`)
    // and this row has no campaign, so there is no endpoint that can show it.
    const db = new Database(path.join(ctx.dataDir, 'campfire.db'), { readonly: true });
    let row: { actor_role: string } | undefined;
    try {
      row = db
        .prepare("SELECT actor_role FROM audit_log WHERE action = 'campaign_creation_request.create' ORDER BY id DESC LIMIT 1")
        .get() as { actor_role: string } | undefined;
    } finally {
      db.close();
    }
    expect(row).toBeDefined();
    expect(row?.actor_role).toBe('admin');
  });

  it('refuses a second pending request rather than filing a duplicate', async () => {
    await adminAgent.patch('/api/v1/settings').send({ campaignCreationPolicy: 'approved_organizers' });
    const user = await createUser('dupereq1');
    const first = await user.post('/api/v1/campaigns/creation-requests').send({ note: 'one' });
    expect(first.status).toBe(201);
    const second = await user.post('/api/v1/campaigns/creation-requests').send({ note: 'two' });
    expect(second.status).toBe(409);
  });

  it('refuses a zero default storage quota at the SERVER contract, not just in the admin card', async () => {
    // `null` already means unlimited, so 0 carries no useful meaning — and it is not inert:
    // AttachmentsService enforces any non-null quota, so a stored 0 refuses every upload in
    // every campaign created afterwards. The admin card rejects it, but a client-side guard
    // is not the contract; PATCH /settings validates against ServerSettings.partial(), so an
    // API or MCP caller could persist it.
    const res = await adminAgent.patch('/api/v1/settings').send({ defaultCampaignStorageQuotaBytes: 0 });
    expect(res.status).toBe(400);
  });

  it('withholds server-wide campaign counts from a non-admin caller', async () => {
    // Review: every other campaign read in this product is membership-scoped — GET /campaigns
    // is, even for a server admin — so returning an aggregate over campaigns the caller has no
    // membership relationship with widened that boundary. The per-user figures they DO have
    // standing to see are unaffected.
    await adminAgent.patch('/api/v1/settings').send({ maxActiveCampaignsServerWide: 50 });
    const user = await createUser('scopecheck1');
    const res = await user.get('/api/v1/campaigns/allowance');
    expect(res.status).toBe(200);
    expect(res.body.activeServerWide).toBeNull();
    expect(res.body.totalServerWide).toBeNull();
    expect(res.body.activePerUser).toMatchObject({ used: expect.any(Number) });
  });

  it('still reports server-wide counts to an admin, who configures them', async () => {
    await adminAgent.patch('/api/v1/settings').send({ maxActiveCampaignsServerWide: 50 });
    const res = await adminAgent.get('/api/v1/campaigns/allowance');
    expect(res.status).toBe(200);
    expect(res.body.activeServerWide).toMatchObject({ used: expect.any(Number), max: 50 });
    expect(res.body.totalServerWide).not.toBeNull();
  });

  it('deletes a user\'s pending creation requests along with the account', async () => {
    // The table is modelled on password_reset_requests, whose rows ARE cleaned up on delete.
    // listPendingRequests inner-joins users, so an orphan silently vanishes from the admin
    // queue while staying 'pending' in storage — handled by nobody, visible to nobody.
    await adminAgent.patch('/api/v1/settings').send({ campaignCreationPolicy: 'approved_organizers' });
    const user = await createUser('orphanreq1');
    const filed = await user.post('/api/v1/campaigns/creation-requests').send({ note: 'please' });
    expect(filed.status).toBe(201);

    // Observed in STORAGE, not through the admin queue. `listPendingRequests` inner-joins
    // `users`, so an orphaned row disappears from that endpoint whether or not it was
    // actually deleted — asserting against the queue would pass either way and guard nothing.
    const countRows = (): number => {
      const db = new Database(path.join(ctx.dataDir, 'campfire.db'), { readonly: true });
      try {
        const row = db
          .prepare('SELECT COUNT(*) AS n FROM campaign_creation_requests WHERE user_id = ?')
          .get(filed.body.userId) as { n: number };
        return row.n;
      } finally {
        db.close();
      }
    };
    expect(countRows()).toBe(1);

    const del = await adminAgent.delete(`/api/v1/users/${filed.body.userId}`);
    expect(del.status).toBe(204);

    expect(countRows()).toBe(0);
  });

  it('applies the operator default storage quota atomically to a newly created campaign', async () => {
    await adminAgent.patch('/api/v1/settings').send({ defaultCampaignStorageQuotaBytes: 5_000_000 });
    const user = await createUser('quotauser1');
    const created = await user.post('/api/v1/campaigns').send({ name: 'Quota Campaign' });
    expect(created.status).toBe(201);
    expect(created.body.storageQuotaBytes).toBe(5_000_000);
  });

  it("admins_only policy: 403 for an ordinary user's POST /campaigns, 201 for a real admin", async () => {
    await adminAgent.patch('/api/v1/settings').send({ campaignCreationPolicy: 'admins_only' });
    const user = await createUser('blockeduser1');

    const blocked = await user.post('/api/v1/campaigns').send({ name: 'Should be blocked' });
    expect(blocked.status).toBe(403);

    const allowed = await adminAgent.post('/api/v1/campaigns').send({ name: 'Admin campaign' });
    expect(allowed.status).toBe(201);
  });

  it('GET/POST creation-requests admin routes 403 for a non-admin', async () => {
    const user = await createUser('nonadmin1');
    const list = await user.get('/api/v1/campaigns/creation-requests');
    expect(list.status).toBe(403);

    const approve = await user.post('/api/v1/campaigns/creation-requests/1/approve');
    expect(approve.status).toBe(403);
  });

  it('the full request -> approve round trip: approved_organizers policy blocks, then a request + approval unblocks', async () => {
    await adminAgent.patch('/api/v1/settings').send({ campaignCreationPolicy: 'approved_organizers' });
    const user = await createUser('organizer1');

    const blocked = await user.post('/api/v1/campaigns').send({ name: 'Not yet' });
    expect(blocked.status).toBe(403);

    const filed = await user.post('/api/v1/campaigns/creation-requests').send({ note: 'please let me DM' });
    expect(filed.status).toBe(201);
    expect(filed.body.status).toBe('pending');

    // A second request while one is pending is rejected.
    const duplicate = await user.post('/api/v1/campaigns/creation-requests');
    expect(duplicate.status).toBe(409);

    const allowance = await user.get('/api/v1/campaigns/allowance');
    expect(allowance.body.hasPendingRequest).toBe(true);

    const pending = await adminAgent.get('/api/v1/campaigns/creation-requests');
    expect(pending.status).toBe(200);
    const row = pending.body.find((r: { id: number }) => r.id === filed.body.id);
    expect(row).toBeDefined();
    expect(row.username).toBe('organizer1');

    const approved = await adminAgent.post(`/api/v1/campaigns/creation-requests/${filed.body.id}/approve`);
    expect(approved.status).toBe(201);
    expect(approved.body.status).toBe('approved');

    const nowAllowed = await user.post('/api/v1/campaigns').send({ name: 'Now allowed' });
    expect(nowAllowed.status).toBe(201);
  });

  it('a denied request leaves the user blocked', async () => {
    await adminAgent.patch('/api/v1/settings').send({ campaignCreationPolicy: 'approved_organizers' });
    const user = await createUser('deniedorganizer1');

    const filed = await user.post('/api/v1/campaigns/creation-requests');
    expect(filed.status).toBe(201);

    const denied = await adminAgent.post(`/api/v1/campaigns/creation-requests/${filed.body.id}/deny`);
    expect(denied.status).toBe(201);
    expect(denied.body.status).toBe('denied');

    const stillBlocked = await user.post('/api/v1/campaigns').send({ name: 'Still blocked' });
    expect(stillBlocked.status).toBe(403);
  });

  it('per-user active campaign limit: the (limit+1)th POST /campaigns is rejected over real HTTP', async () => {
    await adminAgent.patch('/api/v1/settings').send({ maxActiveCampaignsPerUser: 1 });
    const user = await createUser('limithttp1');

    const first = await user.post('/api/v1/campaigns').send({ name: 'First' });
    expect(first.status).toBe(201);

    const second = await user.post('/api/v1/campaigns').send({ name: 'Second' });
    expect(second.status).toBe(403);

    const allowance = await user.get('/api/v1/campaigns/allowance');
    expect(allowance.body.canCreate).toBe(false);
    expect(allowance.body.reason).toBe('limit_active_per_user');
  });

  it('applies consistently to the JSON import path (POST /campaigns/import)', async () => {
    await adminAgent.patch('/api/v1/settings').send({ campaignCreationPolicy: 'admins_only' });
    const user = await createUser('jsonimporter1');

    const blocked = await user.post('/api/v1/campaigns/import').send({ campaign: { name: 'Imported' } });
    expect(blocked.status).toBe(403);

    const allowed = await adminAgent.post('/api/v1/campaigns/import').send({ campaign: { name: 'Imported' } });
    expect(allowed.status).toBe(201);
  });

  it('applies consistently to the ZIP import path (POST /campaigns/import/archive)', async () => {
    await adminAgent.patch('/api/v1/settings').send({ campaignCreationPolicy: 'admins_only' });
    const user = await createUser('zipimporter1');

    // A minimal well-formed Campfire mdzip export (campaign.json only, no attachments)
    // is enough to reach the governance gate — malformed archives never get that far.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const JSZip = require('jszip');
    const zip = new JSZip();
    zip.file('campaign.json', JSON.stringify({ campaign: { name: 'Zip import' } }));
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });

    const blocked = await user
      .post('/api/v1/campaigns/import/archive')
      .attach('file', buffer, { filename: 'export.zip', contentType: 'application/zip' });
    expect(blocked.status).toBe(403);

    const allowed = await adminAgent
      .post('/api/v1/campaigns/import/archive')
      .attach('file', buffer, { filename: 'export.zip', contentType: 'application/zip' });
    expect(allowed.status).toBe(201);
  });

  /**
   * Issue #2016 (split from the #851 review): the ceilings above are enforced only on
   * create/import/clone. Two further lifecycle transitions raise the counted ACTIVE total
   * without passing through any check at all — un-pausing an existing campaign (PATCH
   * {status:'active'}) and restoring one from the trash. Both are exercised here through
   * the real HTTP routes; see test/unit/campaign-governance.spec.ts for the underlying
   * enforceActiveLimitTx/getOwnerUserId unit coverage.
   */
  describe('reactivation ceilings (issue #2016)', () => {
    it('PATCH un-pause (status back to active) is denied once the active-per-user ceiling is full', async () => {
      await adminAgent.patch('/api/v1/settings').send({ maxActiveCampaignsPerUser: 1 });
      const user = await createUser('reactivateuser1');

      const a = await user.post('/api/v1/campaigns').send({ name: 'A' });
      expect(a.status).toBe(201);
      // Pause A to free the one active slot for B — un-pausing never needs a check.
      expect((await user.patch(`/api/v1/campaigns/${a.body.id}`).send({ status: 'paused' })).status).toBe(200);

      const b = await user.post('/api/v1/campaigns').send({ name: 'B' });
      expect(b.status).toBe(201);

      // A is paused, B is active — the ceiling (1) is already full. Un-pausing A would make 2.
      const denied = await user.patch(`/api/v1/campaigns/${a.body.id}`).send({ status: 'active' });
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe('limit_active_per_user');

      // Free the slot by pausing B instead, then A's un-pause succeeds.
      expect((await user.patch(`/api/v1/campaigns/${b.body.id}`).send({ status: 'paused' })).status).toBe(200);
      const allowed = await user.patch(`/api/v1/campaigns/${a.body.id}`).send({ status: 'active' });
      expect(allowed.status).toBe(200);
      expect(allowed.body.status).toBe('active');
    });

    it('PATCH un-pause does NOT double-count against the TOTAL ceiling — only ACTIVE applies to reactivation', async () => {
      await adminAgent.patch('/api/v1/settings').send({ maxTotalCampaignsPerUser: 2 });
      const user = await createUser('reactivatetotal1');

      const a = await user.post('/api/v1/campaigns').send({ name: 'Total A' });
      const b = await user.post('/api/v1/campaigns').send({ name: 'Total B' });
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      // Total (non-trashed, any status) is now exactly 2 — the configured ceiling.
      expect((await user.patch(`/api/v1/campaigns/${a.body.id}`).send({ status: 'paused' })).status).toBe(200);

      // Un-pausing A does not create a new campaign and does not touch the total count (A
      // was already inside it, paused or not) — if TOTAL were wrongly re-checked here, this
      // would 403 even though nothing new is being consumed.
      const reactivated = await user.patch(`/api/v1/campaigns/${a.body.id}`).send({ status: 'active' });
      expect(reactivated.status).toBe(200);
      expect(reactivated.body.status).toBe('active');
    });

    it('restore is denied when the trashed campaign was ACTIVE and the active-per-user ceiling is full', async () => {
      await adminAgent.patch('/api/v1/settings').send({ maxActiveCampaignsPerUser: 1 });
      const user = await createUser('restoreactive1');

      const a = await user.post('/api/v1/campaigns').send({ name: 'Restore A' });
      expect(a.status).toBe(201);
      // Trash A while it is still active — active/total counts both exclude a trashed row,
      // so this frees the slot (matching the issue's "excluded entirely" observation).
      expect((await user.delete(`/api/v1/campaigns/${a.body.id}`)).status).toBe(200);

      const b = await user.post('/api/v1/campaigns').send({ name: 'Restore B' });
      expect(b.status).toBe(201);

      // A's stored status is still 'active' from before it was trashed — restoring it would
      // make 2 active campaigns against a ceiling of 1.
      const denied = await user.post(`/api/v1/campaigns/${a.body.id}/restore`);
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe('limit_active_per_user');

      expect((await user.patch(`/api/v1/campaigns/${b.body.id}`).send({ status: 'paused' })).status).toBe(200);
      const allowed = await user.post(`/api/v1/campaigns/${a.body.id}/restore`);
      expect(allowed.status).toBe(201);
    });

    it('restore is NOT blocked by the active ceiling when the trashed campaign was already paused/completed', async () => {
      await adminAgent.patch('/api/v1/settings').send({ maxActiveCampaignsPerUser: 1 });
      const user = await createUser('restorepaused1');

      const a = await user.post('/api/v1/campaigns').send({ name: 'Paused Restore A' });
      expect(a.status).toBe(201);
      expect((await user.patch(`/api/v1/campaigns/${a.body.id}`).send({ status: 'paused' })).status).toBe(200);
      expect((await user.delete(`/api/v1/campaigns/${a.body.id}`)).status).toBe(200);

      const b = await user.post('/api/v1/campaigns').send({ name: 'Paused Restore B' });
      expect(b.status).toBe(201);
      // The ceiling (1) is now full via B alone. A was PAUSED when trashed, so restoring it
      // brings back a paused row — the active count does not change, and this must succeed.
      const allowed = await user.post(`/api/v1/campaigns/${a.body.id}/restore`);
      expect(allowed.status).toBe(201);
      expect(allowed.body.status).toBe('paused');
    });

    it('server-wide ACTIVE ceiling blocks un-pausing even when the caller\'s OWN per-user count is zero', async () => {
      // Other tests in this suite share one app/db and may leave their own active campaigns
      // behind, so anchor the ceiling to whatever is ALREADY active rather than a bare 1.
      const baseline = ((await adminAgent.get('/api/v1/campaigns/allowance')).body as {
        activeServerWide: { used: number };
      }).activeServerWide.used;
      await adminAgent.patch('/api/v1/settings').send({ maxActiveCampaignsServerWide: baseline + 1 });
      const owner1 = await createUser('serverreactivate1');
      const owner2 = await createUser('serverreactivate2');

      const a = await owner1.post('/api/v1/campaigns').send({ name: 'Owner1 Campaign' });
      expect(a.status).toBe(201); // baseline+1 — exactly at the ceiling
      expect((await owner1.patch(`/api/v1/campaigns/${a.body.id}`).send({ status: 'paused' })).status).toBe(200);

      const b = await owner2.post('/api/v1/campaigns').send({ name: 'Owner2 Campaign' });
      expect(b.status).toBe(201); // back to baseline+1 — A's pause freed the slot B just took

      // owner1 owns zero ACTIVE campaigns right now, but the server-wide ceiling is already
      // spent again by owner2's B.
      const denied = await owner1.patch(`/api/v1/campaigns/${a.body.id}`).send({ status: 'active' });
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe('limit_active_server_wide');
    });

    it('server-wide ACTIVE ceiling blocks restoring an active-when-trashed campaign for the same reason', async () => {
      const baseline = ((await adminAgent.get('/api/v1/campaigns/allowance')).body as {
        activeServerWide: { used: number };
      }).activeServerWide.used;
      await adminAgent.patch('/api/v1/settings').send({ maxActiveCampaignsServerWide: baseline + 1 });
      const owner1 = await createUser('serverrestore1');
      const owner2 = await createUser('serverrestore2');

      const a = await owner1.post('/api/v1/campaigns').send({ name: 'Owner1 Restore Campaign' });
      expect(a.status).toBe(201);
      expect((await owner1.delete(`/api/v1/campaigns/${a.body.id}`)).status).toBe(200);

      const b = await owner2.post('/api/v1/campaigns').send({ name: 'Owner2 Restore Campaign' });
      expect(b.status).toBe(201); // baseline+1 again — A's trash freed the slot B just took

      const denied = await owner1.post(`/api/v1/campaigns/${a.body.id}/restore`);
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe('limit_active_server_wide');
    });

    it('audits a reactivation denial with the real actor identity, for both update and restore', async () => {
      await adminAgent.patch('/api/v1/settings').send({ maxActiveCampaignsPerUser: 1 });

      // update() denial
      const updateUser = await createUser('reactivateauditupdate1');
      const a = await updateUser.post('/api/v1/campaigns').send({ name: 'Audit A' });
      expect((await updateUser.patch(`/api/v1/campaigns/${a.body.id}`).send({ status: 'paused' })).status).toBe(200);
      const b = await updateUser.post('/api/v1/campaigns').send({ name: 'Audit B' });
      expect(b.status).toBe(201);
      expect((await updateUser.patch(`/api/v1/campaigns/${a.body.id}`).send({ status: 'active' })).status).toBe(403);

      // restore() denial — a separate user so its own create/trash/create sequence doesn't
      // contend with updateUser's already-full per-user ceiling above.
      const restoreUser = await createUser('reactivateauditrestore1');
      const c = await restoreUser.post('/api/v1/campaigns').send({ name: 'Audit C' });
      expect(c.status).toBe(201);
      expect((await restoreUser.delete(`/api/v1/campaigns/${c.body.id}`)).status).toBe(200);
      const d = await restoreUser.post('/api/v1/campaigns').send({ name: 'Audit D' });
      expect(d.status).toBe(201);
      expect((await restoreUser.post(`/api/v1/campaigns/${c.body.id}/restore`)).status).toBe(403);

      const db = new Database(path.join(ctx.dataDir, 'campfire.db'), { readonly: true });
      try {
        const updateRow = db
          .prepare(
            "SELECT actor, actor_role, campaign_id FROM audit_log WHERE action = 'campaign.update.denied' AND campaign_id = ?",
          )
          .get(a.body.id) as { actor: string; actor_role: string; campaign_id: number } | undefined;
        expect(updateRow).toBeDefined();
        expect(updateRow?.actor_role).toBe('dm');

        const restoreRow = db
          .prepare(
            "SELECT actor, actor_role, campaign_id FROM audit_log WHERE action = 'campaign.restore.denied' AND campaign_id = ?",
          )
          .get(c.body.id) as { actor: string; actor_role: string; campaign_id: number } | undefined;
        expect(restoreRow).toBeDefined();
        expect(restoreRow?.actor_role).toBe('dm');
      } finally {
        db.close();
      }
    });
  });
});
