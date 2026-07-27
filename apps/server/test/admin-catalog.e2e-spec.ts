import path from 'node:path';
import Database from 'better-sqlite3';
import request from 'supertest';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';

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
