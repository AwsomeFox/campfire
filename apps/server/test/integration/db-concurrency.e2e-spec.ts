import request from 'supertest';
import { DB_HOLDER, type DbHolder } from '../../src/db/db.module';
import { createTestApp, closeTestApp, type TestAppContext } from '../test-app';
import { dm, player } from './fixtures';
import { CharactersService } from '../../src/modules/characters/characters.service';
import { InventoryService } from '../../src/modules/inventory/inventory.service';
import { TimelineService } from '../../src/modules/timeline/timeline.service';

/**
 * Hold each pair of reads until both requests have fetched the real SQLite row.
 * The controller performs the first pair. Before #653 the service then performed a
 * second, stale pair before either update; the fixed service instead reads inside its
 * synchronous transaction. This makes the REST race deterministic without mocking DB
 * data or replacing the listening HTTP server.
 */
function synchronizeCharacterLookupPairs(service: CharactersService, characterId: number) {
  const original = service.getRowOrThrow.bind(service);
  const gates = Array.from({ length: 2 }, () => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { arrivals: 0, promise, release };
  });
  let matchingCalls = 0;

  return jest.spyOn(service, 'getRowOrThrow').mockImplementation(async (id, includeDeleted = false) => {
    const row = await original(id, includeDeleted);
    if (id !== characterId) return row;

    const gate = gates[Math.floor(matchingCalls / 2)];
    matchingCalls += 1;
    if (!gate) return row;
    gate.arrivals += 1;
    if (gate.arrivals === 2) gate.release();
    await gate.promise;
    return row;
  });
}

/**
 * Issue #658: better-sqlite3 is synchronous, so two concurrent HTTP requests never
 * naturally race at the SQL layer — the first request's SELECT-then-INSERT runs to
 * completion before the second request's handler starts. To prove the lazy-create
 * race deterministically we park both callers at the row-existence probe: each
 * caller's private `readLazyRow` runs first (both observe an empty table), then
 * both wait on a shared gate. When the second caller arrives the gate releases and
 * BOTH callers fall through to INSERT against an empty table — exactly the race
 * that, without `onConflictDoNothing`, throws SQLITE_CONSTRAINT_PRIMARYKEY and
 * surfaces as an unhandled 500. Mirrors `synchronizeCharacterLookupPairs`.
 */
function synchronizeLazyCreateProbe(
  service: { readLazyRow: (campaignId: number) => Promise<unknown> },
  campaignId: number,
) {
  const original = service.readLazyRow.bind(service);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrivals = 0;
  let armed = true;

  const spy = jest.spyOn(service, 'readLazyRow').mockImplementation(async (id: number) => {
    const row = await original(id);
    if (id !== campaignId || !armed) return row;
    arrivals += 1;
    if (arrivals === 2) {
      // Both probes have observed an empty table — release both, then race the INSERTs.
      armed = false;
      release();
    }
    await gate;
    return row;
  });
  return spy;
}

/**
 * Integration coverage for the atomic write paths under real concurrency (issue
 * #80). The HTTP mechanisms are exercised against a real, *listening* socket so the
 * requests are genuinely in flight at once (an un-listened in-memory handler
 * serialises them and proves nothing):
 *
 *   - Atomic HP writes (issue #86): N concurrent damage patches must all land —
 *     no lost updates. better-sqlite3 executes each statement synchronously, so
 *     a read-modify-write for one request completes before the next request's
 *     handler runs; this asserts that guarantee holds end-to-end.
 *   - Proposal resolution CAS (issue #85): the pending->approved/rejected
 *     transition is a single `UPDATE ... WHERE status='pending'`. Fire a burst of
 *     approves racing rejects at one pending proposal and exactly one must win;
 *     every loser gets a 409 and the entity is written at most once.
 *   - Current-location discovery (issue #656): demotion, promotion, and the
 *     campaign pointer must commit as one unit, even when two locations race.
 *
 * These need a real listening server (createTestApp only inits), so the suite
 * calls app.listen(0) in beforeAll and drives requests at the resolved URL.
 */
describe('concurrency (real SQLite, atomic writes)', () => {
  let ctx: TestAppContext;
  let baseUrl: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    await ctx.app.listen(0);
    baseUrl = await ctx.app.getUrl();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('composes two concurrent character HP deltas from 10 to 0 (#653)', async () => {
    const campaign = await request(baseUrl).post('/api/v1/campaigns').set(dm).send({ name: 'Exact HP Race' });
    const character = await request(baseUrl)
      .post(`/api/v1/campaigns/${campaign.body.id}/characters`)
      .set(dm)
      .send({ name: 'Two-Hit Target', hpMax: 10, hpCurrent: 10 });
    const characterId = character.body.id;
    const lookupSpy = synchronizeCharacterLookupPairs(ctx.app.get(CharactersService), characterId);

    let results: request.Response[];
    try {
      results = await Promise.all([
        request(baseUrl).post(`/api/v1/characters/${characterId}/hp`).set(dm).send({ delta: -5 }),
        request(baseUrl).post(`/api/v1/characters/${characterId}/hp`).set(dm).send({ delta: -5 }),
      ]);
    } finally {
      lookupSpy.mockRestore();
    }

    expect(results.every((r) => r.status === 201)).toBe(true);
    const finalRow = await request(baseUrl).get(`/api/v1/characters/${characterId}`).set(dm);
    expect(finalRow.body.hpCurrent).toBe(0);
  });

  it('composes concurrent character XP deltas (#653)', async () => {
    const campaign = await request(baseUrl).post('/api/v1/campaigns').set(dm).send({ name: 'XP Race' });
    const character = await request(baseUrl)
      .post(`/api/v1/campaigns/${campaign.body.id}/characters`)
      .set(dm)
      .send({ name: 'Fast Learner', xp: 0 });
    const characterId = character.body.id;
    const lookupSpy = synchronizeCharacterLookupPairs(ctx.app.get(CharactersService), characterId);

    let results: request.Response[];
    try {
      results = await Promise.all([
        request(baseUrl).post(`/api/v1/characters/${characterId}/xp`).set(dm).send({ delta: 5 }),
        request(baseUrl).post(`/api/v1/characters/${characterId}/xp`).set(dm).send({ delta: 7 }),
      ]);
    } finally {
      lookupSpy.mockRestore();
    }

    expect(results.every((r) => r.status === 201)).toBe(true);
    const finalRow = await request(baseUrl).get(`/api/v1/characters/${characterId}`).set(dm);
    expect(finalRow.body.xp).toBe(12);
  });

  it('applies every one of N concurrent HP damage patches — no lost updates (#86)', async () => {
    const campaign = await request(baseUrl).post('/api/v1/campaigns').set(dm).send({ name: 'HP Race' });
    const campaignId = campaign.body.id;
    const character = await request(baseUrl)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(dm)
      .send({ name: 'Punching Bag', hpMax: 100, hpCurrent: 100 });
    const characterId = character.body.id;

    const N = 40;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        request(baseUrl).post(`/api/v1/characters/${characterId}/hp`).set(dm).send({ delta: -1 }),
      ),
    );

    // Every request succeeded...
    expect(results.every((r) => r.status === 201)).toBe(true);
    // ...and every single -1 was applied: 100 - 40 = 60. A lost update would leave hp > 60.
    const finalRow = await request(baseUrl).get(`/api/v1/characters/${characterId}`).set(dm);
    expect(finalRow.body.hpCurrent).toBe(100 - N);
  });

  it('never drives HP out of [0, hpMax] under a mixed concurrent burst', async () => {
    const campaign = await request(baseUrl).post('/api/v1/campaigns').set(dm).send({ name: 'HP Clamp Race' });
    const character = await request(baseUrl)
      .post(`/api/v1/campaigns/${campaign.body.id}/characters`)
      .set(dm)
      .send({ name: 'Yo-yo', hpMax: 30, hpCurrent: 30 });
    const characterId = character.body.id;

    // Big heals and big hits racing each other; each write clamps independently.
    const patches = [
      ...Array.from({ length: 15 }, () => ({ delta: -25 })),
      ...Array.from({ length: 15 }, () => ({ set: 30 })),
    ];
    const results = await Promise.all(
      patches.map((p) => request(baseUrl).post(`/api/v1/characters/${characterId}/hp`).set(dm).send(p)),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    // No individual response — and the final row — may ever escape the clamp.
    for (const r of results) {
      expect(r.body.hpCurrent).toBeGreaterThanOrEqual(0);
      expect(r.body.hpCurrent).toBeLessThanOrEqual(30);
    }
    const finalRow = await request(baseUrl).get(`/api/v1/characters/${characterId}`).set(dm);
    expect(finalRow.body.hpCurrent).toBeGreaterThanOrEqual(0);
    expect(finalRow.body.hpCurrent).toBeLessThanOrEqual(30);
  });

  it('keeps exactly one current location and a matching campaign pointer when discoveries race (#656)', async () => {
    const campaign = await request(baseUrl).post('/api/v1/campaigns').set(dm).send({ name: 'Location Race' });
    const campaignId = campaign.body.id;
    const [locationA, locationB] = await Promise.all([
      request(baseUrl)
        .post(`/api/v1/campaigns/${campaignId}/locations`)
        .set(dm)
        .send({ name: 'North Gate' }),
      request(baseUrl)
        .post(`/api/v1/campaigns/${campaignId}/locations`)
        .set(dm)
        .send({ name: 'South Gate' }),
    ]);

    const results = await Promise.all(
      [locationA.body.id, locationB.body.id].map((locationId) =>
        request(baseUrl)
          .post(`/api/v1/locations/${locationId}/discover`)
          .set(dm)
          .send({ status: 'current' }),
      ),
    );
    expect(results.every((result) => result.status === 201)).toBe(true);

    const [locations, persistedCampaign] = await Promise.all([
      request(baseUrl).get(`/api/v1/campaigns/${campaignId}/locations`).set(dm),
      request(baseUrl).get(`/api/v1/campaigns/${campaignId}`).set(dm),
    ]);
    const currentRows = (locations.body as Array<{ id: number; status: string }>).filter(
      (location) => location.status === 'current',
    );
    expect(currentRows).toHaveLength(1);
    expect(persistedCampaign.body.currentLocationId).toBe(currentRows[0].id);
  });

  it('rolls back location demotion and promotion when the campaign pointer write fails (#656)', async () => {
    const campaign = await request(baseUrl).post('/api/v1/campaigns').set(dm).send({ name: 'Location Rollback' });
    const campaignId = campaign.body.id;
    const locationA = await request(baseUrl)
      .post(`/api/v1/campaigns/${campaignId}/locations`)
      .set(dm)
      .send({ name: 'Safe Harbor' });
    const locationB = await request(baseUrl)
      .post(`/api/v1/campaigns/${campaignId}/locations`)
      .set(dm)
      .send({ name: 'Broken Bridge' });
    await request(baseUrl).post(`/api/v1/locations/${locationA.body.id}/discover`).set(dm).send({ status: 'current' });

    const sqlite = ctx.app.get<DbHolder>(DB_HOLDER).raw;
    sqlite.exec(`
      CREATE TEMP TRIGGER fail_location_pointer_update
      BEFORE UPDATE OF current_location_id ON campaigns
      WHEN NEW.id = ${campaignId}
      BEGIN
        SELECT RAISE(ABORT, 'forced current-location pointer failure');
      END;
    `);
    try {
      const failed = await request(baseUrl)
        .post(`/api/v1/locations/${locationB.body.id}/discover`)
        .set(dm)
        .send({ status: 'current' });
      expect(failed.status).toBe(500);
    } finally {
      sqlite.exec('DROP TRIGGER fail_location_pointer_update');
    }

    const failedAudit = sqlite
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'location.discover' AND entity_id = ?")
      .get(locationB.body.id) as { n: number };
    expect(failedAudit.n).toBe(0);

    const [locations, persistedCampaign] = await Promise.all([
      request(baseUrl).get(`/api/v1/campaigns/${campaignId}/locations`).set(dm),
      request(baseUrl).get(`/api/v1/campaigns/${campaignId}`).set(dm),
    ]);
    const rows = locations.body as Array<{ id: number; status: string }>;
    expect(rows.find((location) => location.id === locationA.body.id)?.status).toBe('current');
    expect(rows.find((location) => location.id === locationB.body.id)?.status).toBe('unexplored');
    expect(persistedCampaign.body.currentLocationId).toBe(locationA.body.id);
  });

  it('resolves a proposal exactly once when approves race rejects (#85)', async () => {
    const campaign = await request(baseUrl).post('/api/v1/campaigns').set(dm).send({ name: 'CAS Race' });
    const campaignId = campaign.body.id;
    const quest = await request(baseUrl)
      .post(`/api/v1/campaigns/${campaignId}/quests`)
      .set(dm)
      .send({ title: 'Contested' });
    const questId = quest.body.id;

    // A player proposes an edit -> one pending proposal.
    const proposed = await request(baseUrl)
      .patch(`/api/v1/quests/${questId}?proposed=true`)
      .set(player)
      .send({ title: 'Player Title' });
    expect(proposed.status).toBe(202);
    const proposalId = proposed.body.proposal.id;

    // 5 approves and 5 rejects hit the same pending proposal simultaneously.
    const attempts = [
      ...Array.from({ length: 5 }, () => ({ kind: 'approve' as const })),
      ...Array.from({ length: 5 }, () => ({ kind: 'reject' as const })),
    ];
    const results = await Promise.all(
      attempts.map((a) =>
        request(baseUrl).post(`/api/v1/proposals/${proposalId}/${a.kind}`).set(dm).send({}).then((r) => ({ kind: a.kind, status: r.status })),
      ),
    );

    const winners = results.filter((r) => r.status < 300);
    const conflicts = results.filter((r) => r.status === 409);
    // The CAS serialises the transition: exactly one winner, everyone else 409.
    expect(winners).toHaveLength(1);
    expect(conflicts).toHaveLength(results.length - 1);

    // The persisted proposal reflects the single winner's outcome.
    const listed = await request(baseUrl)
      .get(`/api/v1/campaigns/${campaignId}/proposals`)
      .set(dm);
    const persisted = listed.body.find((p: { id: number }) => p.id === proposalId);
    const expectedStatus = winners[0].kind === 'approve' ? 'approved' : 'rejected';
    expect(persisted.status).toBe(expectedStatus);

    // If the winner was an approve, the entity was written exactly once (title applied);
    // if it was a reject, the entity is untouched. Either way it's internally consistent.
    const finalQuest = await request(baseUrl).get(`/api/v1/quests/${questId}`).set(dm);
    expect(finalQuest.body.title).toBe(winners[0].kind === 'approve' ? 'Player Title' : 'Contested');
  });

  /**
   * Issue #582: the treasury delta path is the primary fix for concurrent spends.
   * Each denomination is applied as a single atomic `UPDATE ... SET col = col + ?`,
   * so two players spending DIFFERENT coins at the same time can never clobber each
   * other — and even racing spends on the SAME coin compose. This fires a genuine
   * concurrent burst (real listening socket, requests in flight at once) at one
   * treasury and asserts every delta landed: a lost update would leave the totals
   * short. The CAS-on-set path is covered separately in inventory.e2e-spec.ts.
   */
  it('applies every concurrent treasury delta across different coins — no lost updates (#582)', async () => {
    const campaign = await request(baseUrl).post('/api/v1/campaigns').set(dm).send({ name: 'Treasury Race' });
    const campaignId = campaign.body.id;

    const N = 40;
    // Half the burst adds pp, the other half spends gp from a seeded balance, so the
    // two groups touch disjoint denominations. A stale-snapshot write would silently
    // restore the other coin; the atomic delta just composes.
    await request(baseUrl).patch(`/api/v1/campaigns/${campaignId}/treasury`).set(dm).send({ delta: { gp: N } });

    const results = await Promise.all([
      ...Array.from({ length: N }, () =>
        request(baseUrl).patch(`/api/v1/campaigns/${campaignId}/treasury`).set(dm).send({ delta: { pp: 1 } }),
      ),
      ...Array.from({ length: N }, () =>
        request(baseUrl).patch(`/api/v1/campaigns/${campaignId}/treasury`).set(player).send({ delta: { gp: -1 } }),
      ),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);

    // Every +1 pp and every -1 gp landed. A lost update on either column would leave
    // the total short of the expected 40 / 0.
    const finalRow = await request(baseUrl).get(`/api/v1/campaigns/${campaignId}/treasury`).set(dm);
    expect(finalRow.body.pp).toBe(N);
    expect(finalRow.body.gp).toBe(0);
  });

  it('racing spends on the SAME coin compose atomically and never go negative (#582)', async () => {
    const campaign = await request(baseUrl).post('/api/v1/campaigns').set(dm).send({ name: 'Same Coin Race' });
    const campaignId = campaign.body.id;

    // Seed 40gp, then 40 players each spend 1gp simultaneously. The atomic deltas must
    // compose to exactly 0 — none lost, none doubled, and no spend may push the balance
    // below 0 (a stale read-then-write would either lose updates or overspend).
    await request(baseUrl).patch(`/api/v1/campaigns/${campaignId}/treasury`).set(dm).send({ delta: { gp: 40 } });

    const N = 40;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        request(baseUrl).patch(`/api/v1/campaigns/${campaignId}/treasury`).set(player).send({ delta: { gp: -1 } }),
      ),
    );
    // Every spend landed (no race pushed a balance-check past 0); the 41st would 400.
    expect(results.filter((r) => r.status === 200)).toHaveLength(N);
    expect(results.filter((r) => r.status === 400)).toHaveLength(0);

    const finalRow = await request(baseUrl).get(`/api/v1/campaigns/${campaignId}/treasury`).set(dm);
    expect(finalRow.body.gp).toBe(0);
  });

  /**
   * Issue #782: inventory +/- must not send absolute quantities from a stale
   * snapshot. Concurrent qtyDelta (+1 / -1) compose via `qty = qty + ?`; a lost
   * update would leave the final count short. Concurrent move + qtyDelta must
   * both land. Identical idempotency-key retries must not double-apply.
   */
  it('applies every concurrent inventory qtyDelta — no lost updates (#782)', async () => {
    const campaign = await request(baseUrl).post('/api/v1/campaigns').set(dm).send({ name: 'Loot Race' });
    const campaignId = campaign.body.id;
    const created = await request(baseUrl)
      .post(`/api/v1/campaigns/${campaignId}/inventory`)
      .set(dm)
      .send({ name: 'Arrows', qty: 20 });
    const itemId = created.body.id;

    const N = 20;
    const results = await Promise.all([
      ...Array.from({ length: N }, (_, i) =>
        request(baseUrl)
          .patch(`/api/v1/inventory/${itemId}`)
          .set(dm)
          .send({ qtyDelta: 1, idempotencyKey: `loot-inc-${i}` }),
      ),
      ...Array.from({ length: N }, (_, i) =>
        request(baseUrl)
          .patch(`/api/v1/inventory/${itemId}`)
          .set(player)
          .send({ qtyDelta: -1, idempotencyKey: `loot-dec-${i}` }),
      ),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);

    const finalRow = await request(baseUrl).get(`/api/v1/inventory/${itemId}`).set(dm);
    // 20 start + 20 increments − 20 decrements = 20. A stale absolute write would lose updates.
    expect(finalRow.body.qty).toBe(20);
  });

  it('concurrent move and qtyDelta both land (#782)', async () => {
    const campaign = await request(baseUrl).post('/api/v1/campaigns').set(dm).send({ name: 'Move Race' });
    const campaignId = campaign.body.id;
    // DM-owned destination so whichever request wins the race, both actors retain
    // write access (party stash is player-writable; DM can always write the result).
    const character = await request(baseUrl)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(dm)
      .send({ name: 'Carrier' });
    const created = await request(baseUrl)
      .post(`/api/v1/campaigns/${campaignId}/inventory`)
      .set(dm)
      .send({ name: 'Relic', qty: 1 });
    const itemId = created.body.id;

    const [moved, bumped] = await Promise.all([
      request(baseUrl)
        .patch(`/api/v1/inventory/${itemId}`)
        .set(dm)
        .send({ ownerType: 'character', characterId: character.body.id }),
      request(baseUrl)
        .patch(`/api/v1/inventory/${itemId}`)
        .set(dm)
        .send({ qtyDelta: 1, idempotencyKey: 'move-race-bump' }),
    ]);
    expect(moved.status).toBe(200);
    expect(bumped.status).toBe(200);

    const finalRow = await request(baseUrl).get(`/api/v1/inventory/${itemId}`).set(dm);
    expect(finalRow.body.ownerType).toBe('character');
    expect(finalRow.body.characterId).toBe(character.body.id);
    expect(finalRow.body.qty).toBe(2);
  });

  it('identical concurrent idempotency-key retries apply once (#782)', async () => {
    const campaign = await request(baseUrl).post('/api/v1/campaigns').set(dm).send({ name: 'Idem Race' });
    const campaignId = campaign.body.id;
    const created = await request(baseUrl)
      .post(`/api/v1/campaigns/${campaignId}/inventory`)
      .set(dm)
      .send({ name: 'Coin purse', qty: 1 });
    const itemId = created.body.id;
    const key = 'shared-retry-key';

    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        request(baseUrl).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ qtyDelta: 1, idempotencyKey: key }),
      ),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect([...new Set(results.map((r) => r.body.qty))]).toEqual([2]);
    expect([...new Set(results.map((r) => r.body.updatedAt))]).toHaveLength(1);

    const finalRow = await request(baseUrl).get(`/api/v1/inventory/${itemId}`).set(dm);
    expect(finalRow.body.qty).toBe(2);
  });

  /**
   * Issue #658: a brand-new campaign has no treasury row yet. Two concurrent
   * first-accesses each pass the `if (!row)` check and race the INSERT — without
   * `onConflictDoNothing` the loser violates the `campaignId` PRIMARY KEY and
   * Nest surfaces the raw UNIQUE-constraint throw as an unhandled 500. The fixed
   * service's INSERT carries `.onConflictDoNothing({ target: campaignId })`: one
   * caller wins the insert, the other's conflict is silently ignored, and the
   * loser re-reads the winning row. Both calls return 200 and exactly one row
   * persists.
   *
   * `synchronizeLazyCreateProbe` parks both racers between their read (empty)
   * and INSERT so the race is deterministic — otherwise better-sqlite3's
   * synchronous execution serialises the two requests and the bug never triggers.
   */
  it('two concurrent treasury first-accesses both succeed and create one row (#658)', async () => {
    const campaign = await request(baseUrl).post('/api/v1/campaigns').set(dm).send({ name: 'Treasury Lazy Create Race' });
    const campaignId = campaign.body.id;

    const inventory = ctx.app.get(InventoryService);
    const probeSpy = synchronizeLazyCreateProbe(inventory, campaignId);

    let results: request.Response[];
    try {
      results = await Promise.all([
        request(baseUrl).get(`/api/v1/campaigns/${campaignId}/treasury`).set(dm),
        request(baseUrl).get(`/api/v1/campaigns/${campaignId}/treasury`).set(player),
      ]);
    } finally {
      probeSpy.mockRestore();
    }

    // No 500 — both callers observe the single zeroed row.
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      expect(r.body.campaignId).toBe(campaignId);
      expect(r.body.gp).toBe(0);
      expect(r.body.pp).toBe(0);
    }

    // Exactly one treasury row exists for the campaign (no UNIQUE violation,
    // no duplicate inserts). The raw handle proves the on-disk state directly.
    const sqlite = ctx.app.get<DbHolder>(DB_HOLDER).raw;
    const n = sqlite
      .prepare('SELECT COUNT(*) AS n FROM party_treasury WHERE campaign_id = ?')
      .get(campaignId) as { n: number };
    expect(n.n).toBe(1);
  });

  /**
   * Issue #658: the calendar lazy-create has the same read-then-insert shape as
   * the treasury. Two concurrent first writes to a fresh campaign's calendar
   * previously raced the INSERT and 500'd on the `campaignId` PRIMARY KEY.
   * `onConflictDoNothing` lets the loser's insert be ignored; the loser then
   * UPDATEs the winner's row with its own patch. Both calls return 200 and only
   * one calendar row is created.
   */
  it('two concurrent calendar first-accesses both succeed and create one row (#658)', async () => {
    const campaign = await request(baseUrl).post('/api/v1/campaigns').set(dm).send({ name: 'Calendar Lazy Create Race' });
    const campaignId = campaign.body.id;

    const timeline = ctx.app.get(TimelineService);
    const probeSpy = synchronizeLazyCreateProbe(timeline, campaignId);

    let results: request.Response[];
    try {
      results = await Promise.all([
        request(baseUrl)
          .put(`/api/v1/campaigns/${campaignId}/timeline/calendar`)
          .set(dm)
          .send({ currentDate: '1st of Hammer, 1492 DR' }),
        request(baseUrl)
          .put(`/api/v1/campaigns/${campaignId}/timeline/calendar`)
          .set(dm)
          .send({ currentDate: '2nd of Hammer, 1492 DR' }),
      ]);
    } finally {
      probeSpy.mockRestore();
    }

    // No 500 — both racers observed a 200 and one of the two writes is the
    // persisted current date.
    expect(results.every((r) => r.status === 200)).toBe(true);
    const dates = results.map((r) => r.body.currentDate).sort();
    expect(dates).toEqual(['1st of Hammer, 1492 DR', '2nd of Hammer, 1492 DR']);

    // Exactly one calendar row exists; its current date matches one of the racers.
    // (`current_date` is quoted because it is a SQLite reserved keyword that
    // otherwise resolves to today's date rather than the column.)
    const sqlite = ctx.app.get<DbHolder>(DB_HOLDER).raw;
    const rows = sqlite
      .prepare('SELECT "current_date" AS currentDate FROM timeline_calendars WHERE campaign_id = ?')
      .all(campaignId) as Array<{ currentDate: string }>;
    expect(rows).toHaveLength(1);
    expect(['1st of Hammer, 1492 DR', '2nd of Hammer, 1492 DR']).toContain(rows[0].currentDate);
  });
});
