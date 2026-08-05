import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { DbHolder, type DrizzleDb } from '../../src/db/db.module';
import { campaignMembers, campaigns, users, auditLog } from '../../src/db/schema';
import { AuditService } from '../../src/modules/audit/audit.service';
import { SettingsService } from '../../src/modules/settings/settings.service';
import { UsersService } from '../../src/modules/users/users.service';
import { CampaignGovernanceDeniedError, CampaignGovernanceService } from '../../src/modules/campaigns/campaign-governance.service';
import { nowIso } from '../../src/common/time';
import type { RequestUser } from '../../src/common/user.types';

describe('CampaignGovernanceService (issue #851)', () => {
  let dataDir: string;
  let previousDataDir: string | undefined;
  let holder: DbHolder;
  let db: DrizzleDb;
  let audit: AuditService;
  let settings: SettingsService;
  let users2: UsersService;
  let governance: CampaignGovernanceService;

  beforeEach(() => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-governance-unit-'));
    process.env.DATA_DIR = dataDir;
    holder = new DbHolder();
    db = holder.proxy as DrizzleDb;
    audit = new AuditService(db);
    settings = new SettingsService(db);
    users2 = new UsersService(db, audit);
    governance = new CampaignGovernanceService(db, settings, audit);
  });

  afterEach(() => {
    holder.onApplicationShutdown();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  // Issue #851 — UsersService.create() now defaults every brand-new account to
  // canCreateCampaigns=false (an 'approved_organizers' policy would otherwise be
  // meaningless for anyone created/signed up after it is turned on). Explicitly
  // flip it here when a test needs an already-approved organizer.
  async function makeUser(username: string, canCreateCampaigns = true): Promise<number> {
    const created = await users2.create({ username, displayName: username, password: 'password123' });
    if (canCreateCampaigns) {
      await db.update(users).set({ canCreateCampaigns: true }).where(eq(users.id, created.id));
    }
    return created.id;
  }

  async function seedCampaign(status: 'active' | 'paused' | 'completed' = 'active', deletedAt: string | null = null): Promise<number> {
    const ts = nowIso();
    const [row] = await db
      .insert(campaigns)
      .values({ name: 'Seed', status, deletedAt, createdAt: ts, updatedAt: ts })
      .returning();
    return row.id;
  }

  async function seedOwnedCampaign(userId: number, status: 'active' | 'paused' | 'completed' = 'active'): Promise<number> {
    const campaignId = await seedCampaign(status);
    const ts = nowIso();
    await db.insert(campaignMembers).values({
      campaignId,
      userId,
      role: 'dm',
      primaryOwner: true,
      createdAt: ts,
      updatedAt: ts,
    });
    return campaignId;
  }

  function userActor(id: number, opts: Partial<RequestUser> = {}): RequestUser {
    return { id: String(id), name: 'Actor', serverRole: 'user', ...opts };
  }

  function adminActor(id: number, opts: Partial<RequestUser> = {}): RequestUser {
    return { id: String(id), name: 'Admin', serverRole: 'admin', ...opts };
  }

  /** Runs the exact CampaignsService.create() pattern: resolve, then enforce+insert in one sync tx. */
  async function attemptCreate(user: RequestUser): Promise<number> {
    const ctx = await governance.resolveContext(user);
    return db.transaction((tx) => {
      governance.enforceTx(tx, ctx);
      const ts = nowIso();
      const [row] = tx.insert(campaigns).values({ name: 'Attempt', status: 'active', createdAt: ts, updatedAt: ts }).returning().all();
      if (ctx.userId != null) {
        tx.insert(campaignMembers)
          .values({ campaignId: row.id, userId: ctx.userId, role: 'dm', primaryOwner: true, createdAt: ts, updatedAt: ts })
          .run();
      }
      return row.id;
    });
  }

  describe('creation policy', () => {
    it('everyone (default): any authenticated user may create', async () => {
      const uid = await makeUser('alice');
      const ctx = await governance.resolveContext(userActor(uid));
      expect(() => db.transaction((tx) => governance.enforceTx(tx, ctx))).not.toThrow();
    });

    it('admins_only: denies an ordinary user', async () => {
      await settings.update({ campaignCreationPolicy: 'admins_only' });
      const uid = await makeUser('bob');
      const ctx = await governance.resolveContext(userActor(uid));
      expect(() => db.transaction((tx) => governance.enforceTx(tx, ctx))).toThrow(CampaignGovernanceDeniedError);
      try {
        db.transaction((tx) => governance.enforceTx(tx, ctx));
      } catch (err) {
        expect((err as CampaignGovernanceDeniedError).code).toBe('policy_admins_only');
      }
    });

    it('admins_only: allows a real server admin (session, no token scope)', async () => {
      await settings.update({ campaignCreationPolicy: 'admins_only' });
      const uid = await makeUser('carol');
      const ctx = await governance.resolveContext(adminActor(uid));
      expect(() => db.transaction((tx) => governance.enforceTx(tx, ctx))).not.toThrow();
    });

    // AGENTS.md invariant: server-admin status does not imply authority — a PAT's
    // adminEnabled cap is authoritative, not the raw serverRole. This is the exact
    // boundary the coordinator called out to pin.
    it('admins_only: denies a PAT scoped from an admin WITHOUT adminEnabled', async () => {
      await settings.update({ campaignCreationPolicy: 'admins_only' });
      const uid = await makeUser('dave');
      const scopedToken = adminActor(uid, {
        tokenContext: { tokenId: 1, name: 'scoped-pat', scope: 'dm', writeScope: 'direct', campaignId: null, adminEnabled: false },
      });
      const ctx = await governance.resolveContext(scopedToken);
      expect(ctx.isServerAdmin).toBe(false);
      expect(() => db.transaction((tx) => governance.enforceTx(tx, ctx))).toThrow(CampaignGovernanceDeniedError);
    });

    it('admins_only: allows a PAT scoped from an admin WITH adminEnabled', async () => {
      await settings.update({ campaignCreationPolicy: 'admins_only' });
      const uid = await makeUser('erin');
      const adminToken = adminActor(uid, {
        tokenContext: { tokenId: 2, name: 'admin-pat', scope: 'dm', writeScope: 'direct', campaignId: null, adminEnabled: true },
      });
      const ctx = await governance.resolveContext(adminToken);
      expect(ctx.isServerAdmin).toBe(true);
      expect(() => db.transaction((tx) => governance.enforceTx(tx, ctx))).not.toThrow();
    });

    it('approved_organizers: denies a user without canCreateCampaigns, allows one with it', async () => {
      await settings.update({ campaignCreationPolicy: 'approved_organizers' });
      const blockedUid = await makeUser('frank', false);
      const orgUid = await makeUser('grace', true);

      const blockedCtx = await governance.resolveContext(userActor(blockedUid));
      expect(() => db.transaction((tx) => governance.enforceTx(tx, blockedCtx))).toThrow(CampaignGovernanceDeniedError);
      try {
        db.transaction((tx) => governance.enforceTx(tx, blockedCtx));
      } catch (err) {
        expect((err as CampaignGovernanceDeniedError).code).toBe('policy_requires_approval');
      }

      const orgCtx = await governance.resolveContext(userActor(orgUid));
      expect(() => db.transaction((tx) => governance.enforceTx(tx, orgCtx))).not.toThrow();
    });

    it('approved_organizers: a real admin bypasses even without canCreateCampaigns', async () => {
      await settings.update({ campaignCreationPolicy: 'approved_organizers' });
      const uid = await makeUser('henry', false);
      const ctx = await governance.resolveContext(adminActor(uid));
      expect(() => db.transaction((tx) => governance.enforceTx(tx, ctx))).not.toThrow();
    });

    it('dev-auth principals bypass governance entirely', async () => {
      await settings.update({ campaignCreationPolicy: 'admins_only' });
      const ctx = await governance.resolveContext({ id: 'dev:tester', name: 'Dev', serverRole: 'user', devRole: 'dm' });
      expect(ctx.bypass).toBe(true);
      expect(() => db.transaction((tx) => governance.enforceTx(tx, ctx))).not.toThrow();
    });
  });

  describe('active/total campaign limits', () => {
    it('per-user ACTIVE limit blocks the (limit+1)th active campaign', async () => {
      const uid = await makeUser('limituser1');
      await seedOwnedCampaign(uid, 'active');
      await settings.update({ maxActiveCampaignsPerUser: 1 });
      const ctx = await governance.resolveContext(userActor(uid));
      expect(() => db.transaction((tx) => governance.enforceTx(tx, ctx))).toThrow(CampaignGovernanceDeniedError);
      try {
        db.transaction((tx) => governance.enforceTx(tx, ctx));
      } catch (err) {
        expect((err as CampaignGovernanceDeniedError).code).toBe('limit_active_per_user');
      }
    });

    it('per-user ACTIVE limit does NOT count a paused/archived campaign', async () => {
      const uid = await makeUser('limitcount2');
      await seedOwnedCampaign(uid, 'paused');
      await settings.update({ maxActiveCampaignsPerUser: 1 });
      const ctx = await governance.resolveContext(userActor(uid));
      // 0 active owned so far — the paused one must not count against the ACTIVE cap.
      expect(() => db.transaction((tx) => governance.enforceTx(tx, ctx))).not.toThrow();
    });

    it('per-user TOTAL limit counts active + paused together (paused is not exempt)', async () => {
      const uid = await makeUser('limituser3');
      await seedOwnedCampaign(uid, 'active');
      await seedOwnedCampaign(uid, 'paused');
      // Real (non-trashed) total is exactly 2 — if paused were wrongly excluded, used
      // would read 1 and this would NOT throw.
      await settings.update({ maxTotalCampaignsPerUser: 2 });
      const ctx = await governance.resolveContext(userActor(uid));
      expect(() => db.transaction((tx) => governance.enforceTx(tx, ctx))).toThrow(CampaignGovernanceDeniedError);
      try {
        db.transaction((tx) => governance.enforceTx(tx, ctx));
      } catch (err) {
        expect((err as CampaignGovernanceDeniedError).code).toBe('limit_total_per_user');
      }
    });

    it('per-user TOTAL limit does NOT count a trashed campaign', async () => {
      const uid = await makeUser('limituser3trash');
      await seedOwnedCampaign(uid, 'active');
      const trashedId = await seedCampaign('active', nowIso());
      const ts = nowIso();
      await db.insert(campaignMembers).values({ campaignId: trashedId, userId: uid, role: 'dm', primaryOwner: true, createdAt: ts, updatedAt: ts });

      // Real (non-trashed) total is 1; if the trashed row were wrongly counted, used
      // would read 2 and this would incorrectly throw.
      await settings.update({ maxTotalCampaignsPerUser: 2 });
      const ctx = await governance.resolveContext(userActor(uid));
      expect(() => db.transaction((tx) => governance.enforceTx(tx, ctx))).not.toThrow();
    });

    it('server-wide ACTIVE limit counts every user\'s campaigns, not just the caller\'s', async () => {
      const owner1 = await makeUser('serverlimit1');
      const owner2 = await makeUser('serverlimit2');
      await seedOwnedCampaign(owner1, 'active');
      await seedOwnedCampaign(owner2, 'active');
      await settings.update({ maxActiveCampaignsServerWide: 2 });

      const ctx = await governance.resolveContext(userActor(owner1));
      // owner1 alone owns only 1 active campaign, but the SERVER already has 2.
      expect(() => db.transaction((tx) => governance.enforceTx(tx, ctx))).toThrow(CampaignGovernanceDeniedError);
      try {
        db.transaction((tx) => governance.enforceTx(tx, ctx));
      } catch (err) {
        expect((err as CampaignGovernanceDeniedError).code).toBe('limit_active_server_wide');
      }
    });

    it('limits do NOT exempt a server admin — a limit is disk/sprawl control, not a privilege boundary', async () => {
      const adminUid = await makeUser('adminlimited');
      await seedOwnedCampaign(adminUid, 'active');
      await settings.update({ maxActiveCampaignsPerUser: 1 });
      const ctx = await governance.resolveContext(adminActor(adminUid));
      expect(() => db.transaction((tx) => governance.enforceTx(tx, ctx))).toThrow(CampaignGovernanceDeniedError);
    });
  });

  describe('effective allowance (GET /campaigns/allowance)', () => {
    it('reports canCreate=true and correct used/max counters when under every limit', async () => {
      const uid = await makeUser('allowanceok');
      await seedOwnedCampaign(uid, 'active');
      await settings.update({ maxActiveCampaignsPerUser: 5, defaultCampaignStorageQuotaBytes: 999 });
      const allowance = await governance.getAllowance(userActor(uid));
      expect(allowance.canCreate).toBe(true);
      expect(allowance.reason).toBe('ok');
      expect(allowance.activePerUser).toEqual({ used: 1, max: 5 });
      expect(allowance.defaultStorageQuotaBytes).toBe(999);
      expect(allowance.hasPendingRequest).toBe(false);
    });

    it('reports canCreate=false with the specific limit reason once a cap is hit', async () => {
      const uid = await makeUser('allowanceblocked');
      await seedOwnedCampaign(uid, 'active');
      await settings.update({ maxActiveCampaignsPerUser: 1 });
      const allowance = await governance.getAllowance(userActor(uid));
      expect(allowance.canCreate).toBe(false);
      expect(allowance.reason).toBe('limit_active_per_user');
    });
  });

  describe('the request/approval flow', () => {
    it('files a pending request, rejects a second one, and lists it for an admin', async () => {
      const uid = await makeUser('requester1');
      const req = await governance.createRequest(userActor(uid), 'please let me DM');
      expect(req.status).toBe('pending');
      expect(req.userId).toBe(uid);

      await expect(governance.createRequest(userActor(uid))).rejects.toThrow();

      const pending = await governance.listPendingRequests();
      expect(pending.some((r) => r.id === req.id)).toBe(true);
    });

    it('approve flips canCreateCampaigns and is audited; a decided request cannot be re-decided', async () => {
      const uid = await makeUser('requester2', false);
      const req = await governance.createRequest(userActor(uid));
      const adminUid = await makeUser('approver1');

      const decided = await governance.decide(req.id, 'approved', adminActor(adminUid));
      expect(decided.status).toBe('approved');

      const [row] = await db.select({ canCreateCampaigns: users.canCreateCampaigns }).from(users).where(eq(users.id, uid));
      expect(row.canCreateCampaigns).toBe(true);

      const auditRows = await db.select().from(auditLog).where(eq(auditLog.action, 'campaign_creation_request.approve'));
      expect(auditRows.length).toBe(1);

      await expect(governance.decide(req.id, 'denied', adminActor(adminUid))).rejects.toThrow();
    });

    it('deny leaves canCreateCampaigns untouched and is audited', async () => {
      const uid = await makeUser('requester3', false);
      const req = await governance.createRequest(userActor(uid));
      const adminUid = await makeUser('denier1');

      const decided = await governance.decide(req.id, 'denied', adminActor(adminUid));
      expect(decided.status).toBe('denied');

      const [row] = await db.select({ canCreateCampaigns: users.canCreateCampaigns }).from(users).where(eq(users.id, uid));
      expect(row.canCreateCampaigns).toBe(false);

      const auditRows = await db.select().from(auditLog).where(eq(auditLog.action, 'campaign_creation_request.deny'));
      expect(auditRows.length).toBe(1);
    });
  });

  describe('concurrency (issue #851 acceptance criterion)', () => {
    it('exactly the configured number of concurrent creates succeed; the rest are denied and leave no orphan rows', async () => {
      const uid = await makeUser('racer');
      await settings.update({ maxActiveCampaignsPerUser: 2 });

      const attempts = Array.from({ length: 5 }, () => attemptCreate(userActor(uid)));
      const results = await Promise.allSettled(attempts);

      const succeeded = results.filter((r) => r.status === 'fulfilled');
      const denied = results.filter(
        (r) => r.status === 'rejected' && r.reason instanceof CampaignGovernanceDeniedError && r.reason.code === 'limit_active_per_user',
      );
      expect(succeeded.length).toBe(2);
      expect(denied.length).toBe(3);

      // No orphan rows: exactly 2 campaigns exist, and exactly 2 primaryOwner rows for this user.
      const campaignRows = await db.select().from(campaigns);
      expect(campaignRows.length).toBe(2);
      const memberRows = await db
        .select()
        .from(campaignMembers)
        .where(eq(campaignMembers.userId, uid));
      expect(memberRows.length).toBe(2);
      expect(memberRows.every((m) => m.primaryOwner)).toBe(true);
    });
  });
});
