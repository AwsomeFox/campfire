import path from 'node:path';
import Database from 'better-sqlite3';
import request from 'supertest';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';
import { AuditService } from '../src/modules/audit/audit.service';
import { AdminCatalogService } from '../src/modules/admin-catalog/admin-catalog.service';
import type { RequestUser } from '../src/common/user.types';

/**
 * Issue #587 — catalog paging/filtering (criterion 2) and bulk lifecycle (criterion 3).
 *
 * The isolation suite next door proves the catalog cannot READ a campaign. This one
 * proves it is actually useful for the job it exists to do, and that the two properties
 * the issue calls out specifically really hold:
 *
 *  - Pagination and filtering are SERVER-side. The finding names
 *    `campaigns.service.ts` loading every campaign and filtering in memory; a catalog
 *    that did the same thing behind a nicer URL would have fixed nothing. `total` must
 *    therefore be a real count over the filtered set, not `items.length`, and a page
 *    must not be a slice of a fully-materialised list.
 *  - Bulk operations dry-run by default and are atomic PER ITEM. A batch containing one
 *    bad campaign must apply the good ones, report the bad one, and still return 200 —
 *    a bulk archive that half-applies behind a 500 leaves an operator with no idea what
 *    happened.
 */
describe('Issue #587: campaign catalog paging, filtering and bulk lifecycle (e2e)', () => {
  let ctx: TestAppContext;
  let server: import('http').Server;
  let admin: ReturnType<typeof request.agent>;
  let dmA: ReturnType<typeof request.agent>;
  let dmB: ReturnType<typeof request.agent>;
  let dmAId: number;
  let dmBId: number;
  /** Campaigns owned by dmA, in creation order. */
  const aIds: number[] = [];
  let bId: number;

  async function newUser(username: string, password: string) {
    const created = await admin.post('/api/v1/users').send({ username, password, serverRole: 'user' });
    expect(created.status).toBe(201);
    const agent = request.agent(server);
    const login = await agent.post('/api/v1/auth/login').send({ username, password });
    expect(login.status).toBe(201);
    return { agent, id: created.body.id as number };
  }

  async function catalog(query: Record<string, string | number> = {}) {
    const res = await admin.get('/api/v1/admin/campaigns').query(query);
    expect(res.status).toBe(200);
    return res.body as {
      items: Array<Record<string, unknown>>;
      total: number;
      hasMore: boolean;
      limit: number;
      offset: number;
      sort: string;
      order: string;
    };
  }

  async function bulk(body: Record<string, unknown>) {
    const res = await admin.post('/api/v1/admin/campaigns/bulk').send(body);
    return res;
  }

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    server = ctx.app.getHttpServer();

    admin = request.agent(server);
    const setup = await admin.post('/api/v1/auth/setup').send({ username: 'cat2-admin', password: 'admin-password-1' });
    expect(setup.status).toBe(201);

    const a = await newUser('cat2-dm-a', 'dm-password-1');
    dmA = a.agent;
    dmAId = a.id;
    const b = await newUser('cat2-dm-b', 'dm-password-2');
    dmB = b.agent;
    dmBId = b.id;

    for (let i = 0; i < 6; i += 1) {
      const res = await dmA.post('/api/v1/campaigns').send({ name: `Table A${i}` });
      expect(res.status).toBe(201);
      aIds.push(res.body.id);
    }
    const bCamp = await dmB.post('/api/v1/campaigns').send({ name: 'Table B0' });
    expect(bCamp.status).toBe(201);
    bId = bCamp.body.id;

    // Pin B0 to a rule pack that is NOT installed, out of band.
    //
    // The DM-facing create/update route validates that `ruleSystem` names an installed
    // pack, so this state cannot be reached through the API — but it is reached in the
    // real world the other way round: the campaign is created while the pack is
    // installed, and the pack is later uninstalled (or the campaign is imported from a
    // server that had it). That orphaned-module condition is precisely what the
    // catalog's `moduleInstalled=false` filter and the `update_module` bulk operation
    // exist to find and fix, so the fixture has to create it directly.
    const db = new Database(path.join(ctx.dataDir, 'campfire.db'));
    try {
      db.prepare('UPDATE campaigns SET rule_system = ? WHERE id = ?').run('srd-5e', bId);
    } finally {
      db.close();
    }
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  // -------------------------------------------------------------------------
  // Criterion 1 + 2: the catalog spans campaigns the admin is not a member of,
  // and pages/filters in SQL.
  // -------------------------------------------------------------------------

  describe('scoped catalog with server-side paging', () => {
    it('lists campaigns the admin is not a member of, which the member-scoped list does not', async () => {
      const member = await admin.get('/api/v1/campaigns');
      expect(member.status).toBe(200);
      expect(member.body).toHaveLength(0);

      const page = await catalog({ limit: 100 });
      expect(page.total).toBe(7);
      expect(page.items).toHaveLength(7);
    });

    it('reports a real total over the whole filtered set, not the size of the page', async () => {
      const page = await catalog({ limit: 2 });
      expect(page.items).toHaveLength(2);
      expect(page.total).toBe(7); // the count is over all matching rows, not this slice
      expect(page.hasMore).toBe(true);
      expect(page.limit).toBe(2);
      expect(page.offset).toBe(0);
    });

    it('pages without repeating or skipping a row', async () => {
      const seen: number[] = [];
      for (let offset = 0; offset < 8; offset += 3) {
        const page = await catalog({ limit: 3, offset, sort: 'id', order: 'asc' });
        seen.push(...page.items.map((i) => i.id as number));
      }
      expect(seen).toHaveLength(7);
      expect(new Set(seen).size).toBe(7);
      expect([...seen].sort((x, y) => x - y)).toEqual([...aIds, bId].sort((x, y) => x - y));
    });

    it('reports hasMore=false on the terminal page', async () => {
      const page = await catalog({ limit: 3, offset: 6, sort: 'id', order: 'asc' });
      expect(page.items).toHaveLength(1);
      expect(page.hasMore).toBe(false);
    });

    it('clamps an oversized limit rather than letting the catalog be bulk-dumped', async () => {
      const page = await catalog({ limit: 5000 });
      expect(page.limit).toBe(100);
    });

    it('rejects nonsense query values instead of silently ignoring them', async () => {
      for (const query of [{ overQuota: 'banana' }, { sort: 'colour' }, { order: 'sideways' }, { limit: 'x' }]) {
        const res = await admin.get('/api/v1/admin/campaigns').query(query);
        expect(res.status).toBe(400);
      }
    });

    it('is refused entirely to a non-admin', async () => {
      const res = await dmA.get('/api/v1/admin/campaigns');
      expect(res.status).toBe(403);
    });
  });

  describe('filters are real predicates', () => {
    it('filters by primary DM, returning only that DM\'s campaigns', async () => {
      const page = await catalog({ primaryDmUserId: dmBId, limit: 100 });
      expect(page.total).toBe(1);
      expect(page.items[0].id).toBe(bId);
      expect((page.items[0].primaryDm as { userId: number }).userId).toBe(dmBId);

      // The other half of the predicate. Asserting only dmB's single row would also pass
      // for a filter that ignored the parameter and happened to return one campaign, so
      // check that the two filters PARTITION the catalog: dmA gets all of hers and none
      // of dmB's, and the two totals sum to the unfiltered total.
      const mine = await catalog({ primaryDmUserId: dmAId, limit: 100 });
      expect(mine.total).toBe(aIds.length);
      expect((mine.items.map((c) => c.id) as number[]).slice().sort((x, y) => x - y)).toEqual(
        aIds.slice().sort((x, y) => x - y),
      );
      expect(mine.items.every((c) => (c.primaryDm as { userId: number }).userId === dmAId)).toBe(true);
      expect(mine.items.some((c) => c.id === bId)).toBe(false);

      const all = await catalog({ limit: 100 });
      expect(all.total).toBe(mine.total + page.total);
    });

    it('filters on the SAME primary DM the row displays, not merely any DM', async () => {
      // `resolvePrimaryDms` picks exactly ONE seat per campaign for the `primaryDm`
      // column (primary_owner first, then oldest seat). The filter used to test
      // membership instead — "is this user any dm here" — so filtering by a SECONDARY DM
      // returned rows whose displayed primary DM was somebody else. One parameter name
      // answering two different questions, agreeing only on single-DM campaigns.
      const target = aIds[0];
      const db = new Database(path.join(ctx.dataDir, 'campfire.db'));
      try {
        // dmB becomes a co-DM on one of dmA's campaigns, WITHOUT the primary-owner seat.
        db.prepare(
          `INSERT INTO campaign_members (campaign_id, user_id, role, is_primary_owner, created_at, updated_at)
           VALUES (?, ?, 'dm', 0, ?, ?)`,
        ).run(target, dmBId, new Date().toISOString(), new Date().toISOString());
      } finally {
        db.close();
      }

      try {
        // dmB is a DM here but NOT the primary one, so this campaign must not appear.
        const asSecondary = await catalog({ primaryDmUserId: dmBId, limit: 100 });
        expect(asSecondary.items.map((i) => i.id)).not.toContain(target);
        // `total` runs the same predicate, so it must agree with the page.
        expect(asSecondary.total).toBe(asSecondary.items.length);

        // dmA still holds the primary seat, so it still appears under her.
        const asPrimary = await catalog({ primaryDmUserId: dmAId, limit: 100 });
        expect(asPrimary.items.map((i) => i.id)).toContain(target);

        // The invariant that actually matters, stated directly: every row returned by
        // this filter displays the DM that was filtered on.
        for (const dmId of [dmAId, dmBId]) {
          const page = await catalog({ primaryDmUserId: dmId, limit: 100 });
          for (const item of page.items) {
            expect((item.primaryDm as { userId: number }).userId).toBe(dmId);
          }
        }
      } finally {
        const cleanup = new Database(path.join(ctx.dataDir, 'campfire.db'));
        try {
          cleanup
            .prepare(`DELETE FROM campaign_members WHERE campaign_id = ? AND user_id = ? AND is_primary_owner = 0`)
            .run(target, dmBId);
        } finally {
          cleanup.close();
        }
      }
    });

    it('filters by rule system, and distinguishes "unset" from "not filtering"', async () => {
      const withPack = await catalog({ ruleSystem: 'srd-5e', limit: 100 });
      expect(withPack.total).toBe(1);
      expect(withPack.items[0].id).toBe(bId);

      const unset = await catalog({ ruleSystem: '', limit: 100 });
      expect(unset.total).toBe(6);
    });

    it('surfaces campaigns pinned to a module this server cannot serve', async () => {
      // 'srd-5e' was never installed as a rule pack in this test server, so B0 is
      // exactly the "pinned to a missing module" condition the filter exists to find.
      const missing = await catalog({ moduleInstalled: 'false', limit: 100 });
      expect(missing.items.map((i) => i.id)).toEqual([bId]);
      expect((missing.items[0].module as { installed: boolean; slug: string })).toMatchObject({
        installed: false,
        slug: 'srd-5e',
      });
    });

    it('filters by status, and the filter follows a bulk status change', async () => {
      expect((await catalog({ status: 'active', limit: 100 })).total).toBe(7);

      const res = await bulk({ operation: 'pause', campaignIds: [aIds[0]], dryRun: false, reason: 'filter test' });
      expect(res.status).toBe(201);

      expect((await catalog({ status: 'active', limit: 100 })).total).toBe(6);
      const paused = await catalog({ status: 'paused', limit: 100 });
      expect(paused.items.map((i) => i.id)).toEqual([aIds[0]]);
      expect(paused.items[0].archived).toBe(true);

      await bulk({ operation: 'activate', campaignIds: [aIds[0]], dryRun: false, reason: 'filter test undo' });
    });

    it('excludes trashed campaigns unless they are explicitly asked for', async () => {
      const trashTarget = aIds[5];
      const del = await dmA.delete(`/api/v1/campaigns/${trashTarget}`);
      expect([200, 204]).toContain(del.status);

      const live = await catalog({ limit: 100 });
      expect(live.items.map((i) => i.id)).not.toContain(trashTarget);
      expect(live.total).toBe(6);

      const trashed = await catalog({ trashed: 'true', limit: 100 });
      expect(trashed.items.map((i) => i.id)).toEqual([trashTarget]);
      expect(trashed.items[0].trashed).toBe(true);
    });

    it('does not let a search term smuggle a trashed campaign past the trash filter', async () => {
      // REGRESSION (operator precedence). The search predicate is an OR-chain and the
      // trash/status filters are ANDed alongside it. `AND` binds tighter than `OR`, so
      // an unparenthesised chain degrades the whole WHERE to
      //   (deleted_at IS NULL AND status = ? AND <name match>) OR <rule_system match> OR <id match>
      // and any row matching a trailing branch comes back regardless of the filters the
      // operator actually set. A soft-deleted campaign surfacing in an admin search is a
      // disclosure bug, not a cosmetic one, so it is pinned here.
      const trashTarget = aIds[5]; // trashed by the preceding test
      const db = new Database(path.join(ctx.dataDir, 'campfire.db'));
      try {
        db.prepare('UPDATE campaigns SET rule_system = ? WHERE id = ?').run('trash-probe-system', trashTarget);
      } finally {
        db.close();
      }

      // The rule-system branch of the OR-chain matches this row, and only this row.
      const search = await catalog({ q: 'trash-probe-system', limit: 100 });
      expect(search.items.map((i) => i.id)).not.toContain(trashTarget);
      // `total` is a COUNT over the same predicate, so it leaks the row even when the
      // page happens not to show it. Both have to hold.
      expect(search.total).toBe(0);

      // Same again with a status filter present: the shape that makes the precedence
      // bug reachable with more than one ANDed clause.
      const filtered = await catalog({ q: 'trash-probe-system', status: 'active', limit: 100 });
      expect(filtered.items.map((i) => i.id)).not.toContain(trashTarget);
      expect(filtered.total).toBe(0);

      // …and the numeric-id branch must not become a trash bypass either.
      const byId = await catalog({ q: String(trashTarget), limit: 100 });
      expect(byId.items.map((i) => i.id)).not.toContain(trashTarget);
      expect(byId.total).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Criterion 3: bulk lifecycle with a dry run.
  // -------------------------------------------------------------------------

  describe('bulk operations', () => {
    it('dry-runs by DEFAULT when the flag is omitted, and changes nothing', async () => {
      const res = await bulk({ operation: 'archive', campaignIds: [aIds[1]] });
      expect(res.status).toBe(201);
      expect(res.body.dryRun).toBe(true);
      expect(res.body.wouldApply).toBe(1);
      expect(res.body.applied).toBe(0);
      expect(res.body.results[0]).toMatchObject({
        campaignId: aIds[1],
        outcome: 'would_apply',
        field: 'status',
        before: 'active',
        after: 'completed',
      });

      const entry = await admin.get(`/api/v1/admin/campaigns/${aIds[1]}`);
      expect(entry.body.status).toBe('active'); // untouched
    });

    it('applies for real only when dryRun is explicitly false', async () => {
      const res = await bulk({
        operation: 'archive',
        campaignIds: [aIds[1]],
        dryRun: false,
        reason: 'season over',
      });
      expect(res.status).toBe(201);
      expect(res.body.applied).toBe(1);
      expect(res.body.results[0].outcome).toBe('applied');

      const entry = await admin.get(`/api/v1/admin/campaigns/${aIds[1]}`);
      expect(entry.body.status).toBe('completed');
      expect(entry.body.archived).toBe(true);
      // Archiving also closes public invites — an archived campaign that still accepts
      // joiners through a live link is the inconsistency migration 0059 exists to fix.
      expect(entry.body.publicInvitesEnabled).toBe(false);
    });

    it('is idempotent: re-running reports skipped rather than churning rows', async () => {
      const res = await bulk({ operation: 'archive', campaignIds: [aIds[1]], dryRun: false, reason: 'again' });
      expect(res.status).toBe(201);
      expect(res.body.applied).toBe(0);
      expect(res.body.skipped).toBe(1);
      expect(res.body.results[0].reason).toContain('already in the requested state');
    });

    it('applies the good items and reports the bad one, without failing the batch', async () => {
      // THE atomicity contract: one nonexistent campaign in a batch of three must not
      // cost the other two their change, and must not surface as a 500.
      const missingId = 999_999;
      const res = await bulk({
        operation: 'pause',
        campaignIds: [aIds[2], missingId, aIds[3]],
        dryRun: false,
        reason: 'partial batch',
      });
      expect(res.status).toBe(201);
      expect(res.body.applied).toBe(2);
      expect(res.body.skipped).toBe(1);
      expect(res.body.failed).toBe(0);

      const byId = Object.fromEntries(
        (res.body.results as Array<{ campaignId: number; outcome: string; reason: string }>).map((r) => [
          r.campaignId,
          r,
        ]),
      );
      expect(byId[aIds[2]].outcome).toBe('applied');
      expect(byId[aIds[3]].outcome).toBe('applied');
      expect(byId[missingId].outcome).toBe('skipped');
      expect(byId[missingId].reason).toContain('not found');

      for (const id of [aIds[2], aIds[3]]) {
        const entry = await admin.get(`/api/v1/admin/campaigns/${id}`);
        expect(entry.body.status).toBe('paused');
      }
    });

    it('skips a trashed campaign rather than resurrecting it into a lifecycle change', async () => {
      const res = await bulk({ operation: 'pause', campaignIds: [aIds[5]], dryRun: false, reason: 'trashed' });
      expect(res.status).toBe(201);
      expect(res.body.skipped).toBe(1);
      expect(res.body.results[0].reason).toContain('trash');
    });

    it('de-duplicates repeated ids in one batch', async () => {
      const res = await bulk({ operation: 'pause', campaignIds: [aIds[2], aIds[2]], dryRun: true });
      expect(res.status).toBe(201);
      expect(res.body.requested).toBe(1);
    });

    it('reassigns ownership, moving the primary-owner seat atomically', async () => {
      const target = aIds[4];
      const res = await bulk({
        operation: 'reassign_owner',
        campaignIds: [target],
        toUserId: dmBId,
        dryRun: false,
        reason: 'DM stepped down',
      });
      expect(res.status).toBe(201);
      expect(res.body.applied).toBe(1);

      const entry = await admin.get(`/api/v1/admin/campaigns/${target}`);
      expect((entry.body.primaryDm as { userId: number; primaryOwner: boolean })).toMatchObject({
        userId: dmBId,
        primaryOwner: true,
      });
      // Exactly one primary owner survives the move.
      const members = await dmB.get(`/api/v1/campaigns/${target}/members`);
      expect(members.status).toBe(200);
      const owners = (members.body as Array<{ userId: number; primaryOwner?: boolean }>).filter(
        (m) => m.primaryOwner,
      );
      expect(owners).toHaveLength(1);
      expect(owners[0].userId).toBe(dmBId);
    });

    it('sets and clears a storage quota, and reports overQuota', async () => {
      const target = aIds[0];
      const set = await bulk({
        operation: 'set_quota',
        campaignIds: [target],
        storageQuotaBytes: 1024,
        dryRun: false,
        reason: 'quota',
      });
      expect(set.status).toBe(201);
      expect(set.body.applied).toBe(1);
      let entry = await admin.get(`/api/v1/admin/campaigns/${target}`);
      expect(entry.body.storageQuotaBytes).toBe(1024);
      expect(entry.body.overQuota).toBe(false);

      const clear = await bulk({
        operation: 'set_quota',
        campaignIds: [target],
        storageQuotaBytes: null,
        dryRun: false,
        reason: 'clear quota',
      });
      expect(clear.status).toBe(201);
      entry = await admin.get(`/api/v1/admin/campaigns/${target}`);
      expect(entry.body.storageQuotaBytes).toBeNull();
    });

    it('sets invite and AI policy', async () => {
      const target = aIds[0];
      const res = await bulk({
        operation: 'set_policy',
        campaignIds: [target],
        publicInvitesEnabled: false,
        aiExternalContentPolicy: 'disabled',
        dryRun: false,
        reason: 'policy sweep',
      });
      expect(res.status).toBe(201);
      expect(res.body.applied).toBe(1);
      const entry = await admin.get(`/api/v1/admin/campaigns/${target}`);
      expect(entry.body.publicInvitesEnabled).toBe(false);
      expect(entry.body.aiExternalContentPolicy).toBe('disabled');
    });

    it('still reports what applied when the audit write fails after the change committed', async () => {
      // Every campaign in a batch commits in its OWN transaction, and the per-item
      // results are the operator's only record of which ones did. The audit writes all
      // happen AFTER those commits, so letting one propagate would turn a batch that
      // really did apply into a 500 with no body: the operator cannot tell what landed,
      // and retrying is unsafe precisely because some of it already has.
      const audit = ctx.app.get(AuditService);
      const spy = jest.spyOn(audit, 'log').mockRejectedValue(new Error('audit table is unavailable'));
      const target = aIds[2]; // left `paused` by the partial-batch test above
      try {
        const res = await bulk({
          operation: 'activate',
          campaignIds: [target],
          dryRun: false,
          reason: 'audit failure drill',
        });
        // Not a 500, and the per-item verdict survived.
        expect(res.status).toBe(201);
        expect(res.body.applied).toBe(1);
        expect(res.body.failed).toBe(0);
        expect(res.body.results[0]).toMatchObject({ campaignId: target, outcome: 'applied' });
        // The operator is told the trail is incomplete rather than left to assume it.
        expect(res.body.results[0].reason).toContain('audit');
      } finally {
        spy.mockRestore();
      }

      // And the change genuinely committed — `applied` was the truthful verdict.
      const entry = await admin.get(`/api/v1/admin/campaigns/${target}`);
      expect(entry.body.status).toBe('active');
      await bulk({ operation: 'pause', campaignIds: [target], dryRun: false, reason: 'audit drill undo' });
    });

    it('refuses to ENABLE public invites, which would bypass the invite reactivation gate', async () => {
      // `InvitesService.setPolicy` refuses to enable public invites unless the campaign
      // is active and untrashed, so that restoring or unarchiving cannot silently
      // revive retained links. Writing the column from the bulk path would sidestep
      // that entirely: arm the flag on a paused campaign, then `activate` — whose
      // status change deliberately preserves the flag — and every link goes live.
      const target = aIds[1];
      const paused = await bulk({ operation: 'pause', campaignIds: [target], dryRun: false, reason: 'arm test' });
      expect(paused.status).toBe(201);

      const armed = await bulk({
        operation: 'set_policy',
        campaignIds: [target],
        publicInvitesEnabled: true,
        dryRun: false,
        reason: 'attempt to pre-arm invites',
      });
      expect(armed.status).toBe(400);

      // A dry run must not be a way to sneak the same request past the check either.
      const dry = await bulk({
        operation: 'set_policy',
        campaignIds: [target],
        publicInvitesEnabled: true,
        dryRun: true,
        reason: 'attempt to pre-arm invites',
      });
      expect(dry.status).toBe(400);

      // The flag really is still off, so a later activate cannot revive anything.
      await bulk({ operation: 'activate', campaignIds: [target], dryRun: false, reason: 'arm test undo' });
      const entry = await admin.get(`/api/v1/admin/campaigns/${target}`);
      expect(entry.body.publicInvitesEnabled).toBe(false);

      // Disabling — the containment action an operator actually needs — still works.
      const closed = await bulk({
        operation: 'set_policy',
        campaignIds: [target],
        publicInvitesEnabled: false,
        dryRun: false,
        reason: 'close invites',
      });
      expect(closed.status).toBe(201);
    });

    it('refuses to pin a campaign to a rule pack this server does not have', async () => {
      const res = await bulk({
        operation: 'update_module',
        campaignIds: [aIds[0]],
        ruleSystem: 'not-installed-anywhere',
        dryRun: false,
        reason: 'module update',
      });
      expect(res.status).toBe(201);
      expect(res.body.applied).toBe(0);
      expect(res.body.skipped).toBe(1);
      expect(res.body.results[0].reason).toContain('not installed');
    });

    it('demands the argument each operation actually needs', async () => {
      const cases: Array<Record<string, unknown>> = [
        { operation: 'reassign_owner', campaignIds: [aIds[0]], dryRun: false },
        { operation: 'set_quota', campaignIds: [aIds[0]], dryRun: false },
        { operation: 'set_policy', campaignIds: [aIds[0]], dryRun: false },
        { operation: 'update_module', campaignIds: [aIds[0]], dryRun: false },
        { operation: 'request_export', campaignIds: [aIds[0]], dryRun: false },
      ];
      for (const body of cases) {
        const res = await bulk(body);
        expect(res.status).toBe(400);
      }
    });

    it('rejects an unrecognized body key instead of silently dropping it', async () => {
      const res = await bulk({ operation: 'pause', campaignIds: [aIds[0]], dryrun: false });
      expect(res.status).toBe(400);
    });

    it('caps the batch size', async () => {
      const res = await bulk({ operation: 'pause', campaignIds: Array.from({ length: 201 }, (_, i) => i + 1) });
      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // Export requests: an ask, answered by the DM.
  // -------------------------------------------------------------------------

  describe('export requests are asks, not grants', () => {
    it('raises a request the DM can see, and refuses a second while one is pending', async () => {
      const target = aIds[3];
      const first = await bulk({
        operation: 'request_export',
        campaignIds: [target],
        exportProfile: 'backup',
        dryRun: false,
        reason: 'archiving the season for the group',
      });
      expect(first.status).toBe(201);
      expect(first.body.applied).toBe(1);

      const second = await bulk({
        operation: 'request_export',
        campaignIds: [target],
        exportProfile: 'backup',
        dryRun: false,
        reason: 'archiving the season for the group',
      });
      expect(second.status).toBe(201);
      expect(second.body.skipped).toBe(1);
      expect(second.body.results[0].reason).toContain('already pending');

      const inbox = await dmA.get(`/api/v1/campaigns/${target}/catalog/export-requests`);
      expect(inbox.status).toBe(200);
      expect(inbox.body).toHaveLength(1);
      expect(inbox.body[0]).toMatchObject({ status: 'pending', profile: 'backup' });
      expect(inbox.body[0].justification).toContain('archiving the season');
    });

    it('refuses a profile the export module cannot build', async () => {
      // A free-string profile reaches the DM as a request for something that cannot be
      // produced: they approve it and then have no way to satisfy it. The operator is
      // corrected at request time instead.
      const res = await bulk({
        operation: 'request_export',
        campaignIds: [aIds[3]],
        exportProfile: 'foo',
        dryRun: false,
        reason: 'asking for a profile that does not exist',
      });
      expect(res.status).toBe(400);
    });

    it('lets the DM decide, and records the decision without producing an artifact', async () => {
      const target = aIds[3];
      const inbox = await dmA.get(`/api/v1/campaigns/${target}/catalog/export-requests`);
      const requestId = inbox.body[0].id;

      const decide = await dmA
        .post(`/api/v1/campaigns/${target}/catalog/export-requests/${requestId}/decision`)
        .send({ decision: 'denied', note: 'players have not consented' });
      expect(decide.status).toBe(201);
      expect(decide.body.status).toBe('denied');
      expect(decide.body.decisionNote).toBe('players have not consented');
      // Nothing resembling an export bundle came back.
      expect(Object.keys(decide.body)).not.toContain('data');

      const again = await dmA
        .post(`/api/v1/campaigns/${target}/catalog/export-requests/${requestId}/decision`)
        .send({ decision: 'approved', note: 'changed my mind' });
      expect(again.status).toBe(400); // already decided
    });

    it('returns the truthful decision when the audit write fails after it committed', async () => {
      // The decision commits before either audit mirror is written. A failure there used
      // to surface as a 500 while the request really was approved — so the DM's client
      // still showed `pending`, retrying got "already decided", and they were left unable
      // to tell whether their campaign's data was now exportable. For a CONSENT decision
      // that ambiguity is exactly what the workflow exists to prevent.
      const target = aIds[2];
      const raise = await bulk({
        operation: 'request_export',
        campaignIds: [target],
        exportProfile: 'backup',
        dryRun: false,
        reason: 'audit failure drill for the decision path',
      });
      expect(raise.status).toBe(201);

      const inbox = await dmA.get(`/api/v1/campaigns/${target}/catalog/export-requests`);
      const pending = (inbox.body as Array<{ id: number; status: string }>).find((r) => r.status === 'pending');
      expect(pending).toBeDefined();

      const audit = ctx.app.get(AuditService);
      const spy = jest.spyOn(audit, 'log').mockRejectedValue(new Error('audit table is unavailable'));
      try {
        const decide = await dmA
          .post(`/api/v1/campaigns/${target}/catalog/export-requests/${pending!.id}/decision`)
          .send({ decision: 'approved', note: 'consent recorded despite the audit outage' });
        // Not a 500, and the answer is the decision that actually landed.
        expect(decide.status).toBe(201);
        expect(decide.body.status).toBe('approved');
      } finally {
        spy.mockRestore();
      }

      // The decision genuinely persisted, so `approved` was the truthful reply.
      const after = await dmA.get(`/api/v1/campaigns/${target}/catalog/export-requests`);
      const stored = (after.body as Array<{ id: number; status: string }>).find((r) => r.id === pending!.id);
      expect(stored!.status).toBe('approved');
    });

    it('lets exactly one of two concurrent decisions win', async () => {
      // The status pre-check is a read with an await before the write. Without the
      // precondition in the UPDATE predicate both callers pass that check, both update,
      // both write audit rows, and the last write silently decides whether consent was
      // granted — behind a trail that contradicts itself. Consent must not be settled by
      // write ordering.
      const target = aIds[4];
      const raise = await bulk({
        operation: 'request_export',
        campaignIds: [target],
        exportProfile: 'handoff',
        dryRun: false,
        reason: 'concurrency drill for the export request',
      });
      expect(raise.status).toBe(201);

      const inbox = await dmA.get(`/api/v1/campaigns/${target}/catalog/export-requests`);
      const pending = (inbox.body as Array<{ id: number; status: string }>).find((r) => r.status === 'pending');
      expect(pending).toBeDefined();
      const requestId = pending!.id;

      // DRIVEN AT THE SERVICE LAYER ON PURPOSE. Two overlapping HTTP requests do NOT
      // reproduce this: supertest serialises them on one agent and better-sqlite3 is
      // synchronous, so the second handler's pre-check runs after the first has already
      // committed and catches it. That makes an HTTP-level version of this test pass
      // whether or not the bug is fixed — a green test proving nothing.
      //
      // Calling the service twice WITHOUT awaiting the first starts both before either
      // reaches its write: call A runs to its `await select` and yields, call B then
      // performs its own select and sees the same `pending` row. Both pre-checks pass,
      // and both proceed to update — which is precisely the interleaving the predicate
      // has to survive.
      const svc = ctx.app.get(AdminCatalogService);
      const actingDm = { id: String(dmAId), name: 'cat2-dm-a', serverRole: 'user' } as RequestUser;
      const settled = await Promise.allSettled([
        svc.decideExportRequest(requestId, { decision: 'approved', note: 'first writer' }, actingDm, target),
        svc.decideExportRequest(requestId, { decision: 'denied', note: 'second writer' }, actingDm, target),
      ]);

      // Exactly one wins; the loser is told, never silently handed the other's verdict.
      const winners = settled.filter((r) => r.status === 'fulfilled');
      const losers = settled.filter((r) => r.status === 'rejected');
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);

      // And the stored row agrees with whichever call reported success, so the audit
      // trail and the persisted consent cannot disagree.
      const winner = (winners[0] as PromiseFulfilledResult<{ status: string; decisionNote: string }>).value;
      const after = await dmA.get(`/api/v1/campaigns/${target}/catalog/export-requests`);
      const stored = (after.body as Array<{ id: number; status: string; decisionNote: string }>).find(
        (r) => r.id === requestId,
      );
      expect(stored!.status).toBe(winner.status);
      expect(stored!.decisionNote).toBe(winner.decisionNote);
    });

    it('creates only one pending request when two are raised concurrently', async () => {
      // The one-pending-request rule was checked in an awaited read and enforced nowhere
      // else, so two overlapping `request_export` calls both saw no pending row and both
      // inserted — leaving duplicate pending asks and both batches reporting `applied`.
      //
      // Driven at the service layer for the same reason as the decision race: two
      // overlapping HTTP requests do NOT reproduce it, because supertest serialises them
      // on one agent and better-sqlite3 is synchronous, so the second pre-check runs
      // after the first insert has committed and catches it. Starting both service calls
      // before awaiting either interleaves them at the pre-check, which is the state the
      // INSERT … WHERE NOT EXISTS has to survive.
      const target = bId; // untouched by the other export-request tests
      const svc = ctx.app.get(AdminCatalogService);
      const operator = { id: '1', name: 'cat2-admin', serverRole: 'admin' } as RequestUser;
      const req = {
        operation: 'request_export' as const,
        campaignIds: [target],
        dryRun: false,
        reason: 'concurrency drill for raising an export request',
        exportProfile: 'backup' as const,
      };

      const [a, b] = await Promise.all([svc.bulk(operator, req), svc.bulk(operator, req)]);

      // Exactly one batch may claim it applied; the other must not report success for a
      // row it never wrote.
      const applied = [a, b].filter((r) => r.applied === 1);
      expect(applied).toHaveLength(1);

      // And the campaign has exactly ONE pending request, which is the actual invariant.
      const inbox = await dmB.get(`/api/v1/campaigns/${target}/catalog/export-requests`);
      expect(inbox.status).toBe(200);
      const stillPending = (inbox.body as Array<{ status: string }>).filter((r) => r.status === 'pending');
      expect(stillPending).toHaveLength(1);
    });

    it('pages the cross-campaign queue and audits the read', async () => {
      // This listing is the ONLY view that spans campaigns. Capped at 100 with no offset
      // and no total, it silently truncated: requests on other campaigns pushed older
      // pending ones out, and an operator could not enumerate the queue without already
      // knowing every affected campaign id — the exact thing the view exists to avoid.
      // A pending approval nobody can see is an approval that never happens.
      const first = await admin.get('/api/v1/admin/campaigns/export-requests').query({ limit: 1, offset: 0 });
      expect(first.status).toBe(200);
      expect(Array.isArray(first.body.items)).toBe(true);
      expect(first.body.items).toHaveLength(1);
      expect(first.body.limit).toBe(1);
      expect(first.body.offset).toBe(0);
      // A real COUNT over the same predicate, not `items.length`.
      expect(first.body.total).toBeGreaterThan(1);
      expect(first.body.hasMore).toBe(true);

      // The second page is a different row, so paging actually advances.
      const second = await admin.get('/api/v1/admin/campaigns/export-requests').query({ limit: 1, offset: 1 });
      expect(second.status).toBe(200);
      expect(second.body.items[0].id).not.toBe(first.body.items[0].id);
      expect(second.body.total).toBe(first.body.total);

      // Walking the offsets reaches every row and terminates.
      const seen: number[] = [];
      for (let offset = 0; offset < first.body.total; offset += 2) {
        const page = await admin.get('/api/v1/admin/campaigns/export-requests').query({ limit: 2, offset });
        seen.push(...(page.body.items as Array<{ id: number }>).map((r) => r.id));
      }
      expect(new Set(seen).size).toBe(first.body.total);

      // Scoping to one campaign still pages, and `total` follows the filter.
      const scoped = await admin
        .get('/api/v1/admin/campaigns/export-requests')
        .query({ campaignId: aIds[3], limit: 100 });
      expect(scoped.status).toBe(200);
      expect(scoped.body.total).toBe(scoped.body.items.length);
      expect((scoped.body.items as Array<{ campaignId: number }>).every((r) => r.campaignId === aIds[3])).toBe(true);

      // AUDITED. The module's docblock promises catalog BROWSING is audited, not just
      // mutations, and this read discloses requester justifications and DM decision
      // notes — other people's stated reasons, which is what that promise is for.
      const trail = await admin.get('/api/v1/admin/audit').query({ limit: 100 });
      expect(trail.status).toBe(200);
      const entries = (Array.isArray(trail.body) ? trail.body : trail.body.items) as Array<{
        action: string;
        detail: string;
      }>;
      const read = entries.filter((e) => e.action === 'campaign.catalog.export_requests.list');
      expect(read.length).toBeGreaterThan(0);
      // The slice is recorded, so a reviewer can reconstruct what was actually seen
      // rather than merely that somebody looked.
      expect(read[0].detail).toMatch(/returned=\d+/);
      expect(read[0].detail).toMatch(/total=\d+/);
    });

    it('does not let a non-DM member or an outsider decide', async () => {
      const target = aIds[3];
      const raise = await bulk({
        operation: 'request_export',
        campaignIds: [target],
        exportProfile: 'publish',
        dryRun: false,
        reason: 'second ask for the publishable module',
      });
      expect(raise.status).toBe(201);
      const inbox = await dmA.get(`/api/v1/campaigns/${target}/catalog/export-requests`);
      const pending = (inbox.body as Array<{ id: number; status: string }>).find((r) => r.status === 'pending');
      expect(pending).toBeDefined();

      // The requesting admin is not a member, so cannot answer their own ask.
      const selfApprove = await admin
        .post(`/api/v1/campaigns/${target}/catalog/export-requests/${pending!.id}/decision`)
        .send({ decision: 'approved', note: 'approving my own request' });
      expect(selfApprove.status).toBe(403);

      // And an unrelated DM cannot answer for someone else's campaign.
      const otherDm = await dmB
        .post(`/api/v1/campaigns/${target}/catalog/export-requests/${pending!.id}/decision`)
        .send({ decision: 'approved', note: 'not my table' });
      expect(otherDm.status).toBe(403);
    });
  });
});
