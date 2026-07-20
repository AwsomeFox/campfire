import request from 'supertest';
import { createTestApp, createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';
import {
  startFakeOpen5e,
  startFakeOpen5eWithBadPagination,
  startFakeOpen5eFlaky,
  type FakeOpen5e,
  type FakeOpen5eWithBadPagination,
  type FakeOpen5eFlaky,
} from './fake-open5e';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' }; // dev-header users always carry serverRole 'admin'
const player = { 'x-dev-role': 'player', 'x-dev-user': 'p-1' };

describe('rules / rule packs (e2e, fake Open5e server)', () => {
  let ctx: TestAppContext;
  let fake: FakeOpen5e;

  beforeAll(async () => {
    ctx = await createTestApp();
    fake = await startFakeOpen5e();
  });

  afterAll(async () => {
    await fake.close();
    await closeTestApp(ctx);
  });

  it('packs list is empty before install', async () => {
    const res = await request(ctx.app.getHttpServer()).get('/api/v1/rules/packs').set(dm);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('non-admin (dev-header player) cannot install', async () => {
    const res = await request(ctx.app.getHttpServer())
      .post('/api/v1/rules/packs/install')
      .set(player)
      .send({ source: 'open5e', url: fake.baseUrl });
    // player dev-header users still carry serverRole 'admin' in this codebase's dev-auth
    // path (see session-auth.guard.ts) — server-admin gating is exercised for real in the
    // "real sessions" describe block below. This assertion documents that dev-header
    // player/viewer roles are NOT server-role gated the same way campaign roles are.
    expect(res.status).toBe(201);
    // undo so later tests in this file start clean
    await request(ctx.app.getHttpServer()).delete(`/api/v1/rules/packs/${res.body.id}`).set(dm);
  });

  it('install from fake Open5e server -> packs list -> search -> entry fetch -> uninstall', async () => {
    const server = ctx.app.getHttpServer();

    const installRes = await request(server)
      .post('/api/v1/rules/packs/install')
      .set(dm)
      .send({ source: 'open5e', url: fake.baseUrl });
    expect(installRes.status).toBe(201);
    expect(installRes.body.slug).toBe('open5e-srd');
    expect(installRes.body.entryCount).toBe(2 + 2 + 1 + 4); // spells + creatures + magicitems + conditions from the fake server
    expect(installRes.body.license).toContain('Creative Commons');
    const packId = installRes.body.id;

    const listRes = await request(server).get('/api/v1/rules/packs').set(dm);
    expect(listRes.status).toBe(200);
    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0].id).toBe(packId);

    // re-installing the same slug+sections is now an incremental no-op (round-2 finding
    // #2): 200 with added:0 (everything already present) rather than a 409.
    const reinstallRes = await request(server)
      .post('/api/v1/rules/packs/install')
      .set(dm)
      .send({ source: 'open5e', url: fake.baseUrl });
    expect(reinstallRes.status).toBe(200);
    expect(reinstallRes.body.added).toBe(0);
    expect(reinstallRes.body.skippedExisting).toBe(2 + 2 + 1 + 4);
    expect(reinstallRes.body.entryCount).toBe(2 + 2 + 1 + 4); // unchanged

    // search: free text finds the fireball spell
    const searchRes = await request(server).get('/api/v1/rules/search').query({ q: 'fireball' }).set(dm);
    expect(searchRes.status).toBe(200);
    expect(searchRes.body.length).toBeGreaterThan(0);
    expect(searchRes.body.some((e: { name: string }) => e.name === 'Fireball')).toBe(true);

    // search: type filter narrows to monsters only
    const monsterSearchRes = await request(server).get('/api/v1/rules/search').query({ q: 'owlbear', type: 'monster' }).set(dm);
    expect(monsterSearchRes.status).toBe(200);
    expect(monsterSearchRes.body.length).toBeGreaterThan(0);
    for (const e of monsterSearchRes.body) expect(e.type).toBe('monster');
    expect(monsterSearchRes.body.some((e: { name: string }) => e.name === 'Owlbear')).toBe(true);

    // search: pack filter
    const packSearchRes = await request(server).get('/api/v1/rules/search').query({ q: 'goblin', pack: 'open5e-srd' }).set(dm);
    expect(packSearchRes.status).toBe(200);
    expect(packSearchRes.body.some((e: { name: string }) => e.name === 'Goblin')).toBe(true);

    // search ranking (issue #33): "poisoned" matches both Poisoned (by name) and
    // Petrified (whose body mentions the Poisoned condition, and which was imported
    // first, so it has the lower rowid) — the exact-name match must rank first.
    const rankedRes = await request(server).get('/api/v1/rules/search').query({ q: 'poisoned' }).set(dm);
    expect(rankedRes.status).toBe(200);
    expect(rankedRes.body.length).toBeGreaterThanOrEqual(2); // both condition entries matched
    expect(rankedRes.body[0].name).toBe('Poisoned');
    expect(rankedRes.body.some((e: { name: string }) => e.name === 'Petrified')).toBe(true);

    // ...and the exact-name bucket is case-insensitive.
    const upperRes = await request(server).get('/api/v1/rules/search').query({ q: 'POISONED' }).set(dm);
    expect(upperRes.body[0].name).toBe('Poisoned');

    // Prefix name matches also outrank body-only matches: "poison" is a prefix of
    // "Poisoned" but only appears inside Petrified's body.
    const prefixRes = await request(server).get('/api/v1/rules/search').query({ q: 'poison' }).set(dm);
    expect(prefixRes.body[0].name).toBe('Poisoned');

    // search: no query returns entries (optionally filtered), not an error
    const browseRes = await request(server).get('/api/v1/rules/search').query({ type: 'condition' }).set(dm);
    expect(browseRes.status).toBe(200);
    expect(browseRes.body.length).toBeGreaterThanOrEqual(2);
    for (const e of browseRes.body) expect(e.type).toBe('condition');

    // entry fetch by id
    const fireball = searchRes.body.find((e: { name: string }) => e.name === 'Fireball');
    const entryRes = await request(server).get(`/api/v1/rules/entries/${fireball.id}`).set(dm);
    expect(entryRes.status).toBe(200);
    expect(entryRes.body.name).toBe('Fireball');
    expect(entryRes.body.body).toContain('bright streak');
    expect(entryRes.body.type).toBe('spell');

    // any authed role (not just dm) can read
    const playerSearch = await request(server).get('/api/v1/rules/search').query({ q: 'prone' }).set(player);
    expect(playerSearch.status).toBe(200);
    expect(playerSearch.body.some((e: { name: string }) => e.name === 'Prone')).toBe(true);

    // uninstall
    const uninstallRes = await request(server).delete(`/api/v1/rules/packs/${packId}`).set(dm);
    expect(uninstallRes.status).toBe(200);

    const afterList = await request(server).get('/api/v1/rules/packs').set(dm);
    expect(afterList.body).toEqual([]);

    const afterSearch = await request(server).get('/api/v1/rules/search').query({ q: 'fireball' }).set(dm);
    expect(afterSearch.body).toEqual([]);

    const afterEntry = await request(server).get(`/api/v1/rules/entries/${fireball.id}`).set(dm);
    expect(afterEntry.status).toBe(404);
  });

  it('install with a single section only imports that section', async () => {
    const server = ctx.app.getHttpServer();

    const installRes = await request(server)
      .post('/api/v1/rules/packs/install')
      .set(dm)
      .send({ source: 'open5e', url: fake.baseUrl, sections: ['spells'] });
    expect(installRes.status).toBe(201);
    expect(installRes.body.entryCount).toBe(2);

    const searchRes = await request(server).get('/api/v1/rules/search').query({ q: 'goblin' }).set(dm);
    expect(searchRes.body).toEqual([]); // creatures weren't imported

    await request(server).delete(`/api/v1/rules/packs/${installRes.body.id}`).set(dm);
  });

  it('install from an unreachable URL fails cleanly (400), not a crash', async () => {
    const res = await request(ctx.app.getHttpServer())
      .post('/api/v1/rules/packs/install')
      .set(dm)
      .send({ source: 'open5e', url: 'http://127.0.0.1:1' }); // nothing listens here
    expect(res.status).toBe(400);
  });

  it('uninstalling a pack nulls out ruleEntryId on any combatant that referenced one of its entries', async () => {
    const server = ctx.app.getHttpServer();

    const campRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Uninstall Cascade Campaign' });
    const campaignId = campRes.body.id;
    const encRes = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Goblin Fight' });
    const encounterId = encRes.body.id;

    const installRes = await request(server)
      .post('/api/v1/rules/packs/install')
      .set(dm)
      .send({ source: 'open5e', url: fake.baseUrl, sections: ['monsters'] });
    expect(installRes.status).toBe(201);
    const packId = installRes.body.id;

    const searchRes = await request(server).get('/api/v1/rules/search').query({ q: 'goblin' }).set(dm);
    const goblinEntry = searchRes.body.find((e: { name: string }) => e.name === 'Goblin');
    expect(goblinEntry).toBeDefined();

    const combatantRes = await request(server)
      .post(`/api/v1/encounters/${encounterId}/combatants`)
      .set(dm)
      .send({ kind: 'monster', ruleEntryId: goblinEntry.id });
    expect(combatantRes.status).toBe(201);
    expect(combatantRes.body.ruleEntryId).toBe(goblinEntry.id);
    const combatantId = combatantRes.body.id;

    const uninstallRes = await request(server).delete(`/api/v1/rules/packs/${packId}`).set(dm);
    expect(uninstallRes.status).toBe(200);

    const encGetRes = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
    const combatant = encGetRes.body.combatants.find((c: { id: number }) => c.id === combatantId);
    expect(combatant).toBeDefined();
    expect(combatant.ruleEntryId).toBeNull();
  });
});

describe('rules / rule packs — server-admin gating (e2e, real sessions)', () => {
  let ctx: TestAppContext;
  let fake: FakeOpen5e;
  let adminAgent: ReturnType<typeof request.agent>;
  let userAgent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    fake = await startFakeOpen5e();

    adminAgent = request.agent(ctx.app.getHttpServer());
    await adminAgent.post('/api/v1/auth/setup').send({ username: 'rules-admin', password: 'admin-password-1' });

    const createUserRes = await adminAgent
      .post('/api/v1/users')
      .send({ username: 'rules-user', password: 'user-password-1' });
    expect(createUserRes.status).toBe(201);
    expect(createUserRes.body.serverRole).toBe('user');

    userAgent = request.agent(ctx.app.getHttpServer());
    await userAgent.post('/api/v1/auth/login').send({ username: 'rules-user', password: 'user-password-1' });
  });

  afterAll(async () => {
    await fake.close();
    await closeTestApp(ctx);
  });

  it('non-admin real user gets 403 on install and uninstall; can still read', async () => {
    const installRes = await userAgent.post('/api/v1/rules/packs/install').send({ source: 'open5e', url: fake.baseUrl });
    expect(installRes.status).toBe(403);

    const listRes = await userAgent.get('/api/v1/rules/packs');
    expect(listRes.status).toBe(200);

    const searchRes = await userAgent.get('/api/v1/rules/search').query({ q: 'anything' });
    expect(searchRes.status).toBe(200);

    const uninstallRes = await userAgent.delete('/api/v1/rules/packs/1');
    expect(uninstallRes.status).toBe(403);
  });

  it('admin real user can install', async () => {
    const installRes = await adminAgent.post('/api/v1/rules/packs/install').send({ source: 'open5e', url: fake.baseUrl });
    expect(installRes.status).toBe(201);
    await adminAgent.delete(`/api/v1/rules/packs/${installRes.body.id}`);
  });
});

/**
 * Punch list item 10 (Open5e importer hardening): (a) a cross-origin `next` pagination
 * link must be refused, not followed; (b) malformed rows are skipped, not fatal to the
 * whole import — and both cases are counted/logged rather than disappearing silently.
 */
describe('rules / rule packs — Open5e importer hardening (e2e, fake server with bad pagination)', () => {
  let ctx: TestAppContext;
  let fake: FakeOpen5eWithBadPagination;
  let warnSpy: jest.SpyInstance;

  beforeAll(async () => {
    ctx = await createTestApp();
    fake = await startFakeOpen5eWithBadPagination();
  });

  afterAll(async () => {
    await fake.close();
    await closeTestApp(ctx);
  });

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('refuses the cross-origin next link and skips the malformed row, while still importing the good one', async () => {
    const server = ctx.app.getHttpServer();

    const installRes = await request(server)
      .post('/api/v1/rules/packs/install')
      .set({ 'x-dev-role': 'dm', 'x-dev-user': 'importer-hardening-dm' })
      .send({ source: 'open5e', url: fake.baseUrl, sections: ['spells'] });
    expect(installRes.status).toBe(201);
    // Only the one well-formed row (Fireball) made it in — the null row was skipped,
    // and pagination stopped at the cross-origin `next` link instead of following it.
    expect(installRes.body.entryCount).toBe(1);

    // The "evil" second-origin server was never actually reached.
    expect(fake.evilWasHit()).toBe(false);

    const searchRes = await request(server)
      .get('/api/v1/rules/search')
      .query({ q: 'fireball' })
      .set({ 'x-dev-role': 'dm', 'x-dev-user': 'importer-hardening-dm' });
    expect(searchRes.body.some((e: { name: string }) => e.name === 'Fireball')).toBe(true);
    expect(searchRes.body.some((e: { name: string }) => e.name === 'Should Never Be Imported')).toBe(false);

    // Skip accounting was logged (both the per-section summary and the malformed row).
    const warnCalls = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warnCalls.some((m) => m.includes('cross-origin pagination'))).toBe(true);
    expect(warnCalls.some((m) => m.includes('skipped'))).toBe(true);

    await request(server)
      .delete(`/api/v1/rules/packs/${installRes.body.id}`)
      .set({ 'x-dev-role': 'dm', 'x-dev-user': 'importer-hardening-dm' });
  });
});

/**
 * Round-2 finding #1: FETCH_TIMEOUT_MS was 10s but real Open5e pages have been observed
 * taking 6-11s; the importer must also retry a page on timeout/5xx (2 retries, 1s/3s
 * backoff) rather than failing the whole import on one transient blip.
 */
describe('rules / rule packs — Open5e importer retry on transient failure (e2e, flaky fake server)', () => {
  let ctx: TestAppContext;
  let fake: FakeOpen5eFlaky;

  beforeAll(async () => {
    ctx = await createTestApp();
    fake = await startFakeOpen5eFlaky();
  });

  afterAll(async () => {
    await fake.close();
    await closeTestApp(ctx);
  });

  it('retries a page that 503s twice, then succeeds on the third attempt', async () => {
    const server = ctx.app.getHttpServer();

    const installRes = await request(server)
      .post('/api/v1/rules/packs/install')
      .set({ 'x-dev-role': 'dm', 'x-dev-user': 'retry-dm' })
      .send({ source: 'open5e', url: fake.baseUrl, sections: ['spells'] });
    expect(installRes.status).toBe(201);
    // Both spells made it in despite the first two requests failing.
    expect(installRes.body.entryCount).toBe(2);
    expect(fake.spellsRequestCount()).toBe(3);

    const searchRes = await request(server)
      .get('/api/v1/rules/search')
      .query({ q: 'fireball' })
      .set({ 'x-dev-role': 'dm', 'x-dev-user': 'retry-dm' });
    expect(searchRes.body.some((e: { name: string }) => e.name === 'Fireball')).toBe(true);

    await request(server).delete(`/api/v1/rules/packs/${installRes.body.id}`).set({ 'x-dev-role': 'dm', 'x-dev-user': 'retry-dm' });
  }, 20_000); // backoff sleeps (1s + 3s) push this past jest's default 5s timeout
});

/**
 * Round-2 finding #2: installing a pack that already exists must incrementally add
 * whatever requested-section entries aren't present yet (dedupe by slug+type), updating
 * entryCount/version, and return 200 with {added, skippedExisting} — never a hard 409.
 */
describe('rules / rule packs — incremental install (e2e, fake Open5e server)', () => {
  let ctx: TestAppContext;
  let fake: FakeOpen5e;
  const dmHeaders = { 'x-dev-role': 'dm', 'x-dev-user': 'incremental-dm' };

  beforeAll(async () => {
    ctx = await createTestApp();
    fake = await startFakeOpen5e();
  });

  afterAll(async () => {
    await fake.close();
    await closeTestApp(ctx);
  });

  it('install conditions -> install spells (adds) -> reinstall conditions (added:0, 200)', async () => {
    const server = ctx.app.getHttpServer();

    const conditionsRes = await request(server)
      .post('/api/v1/rules/packs/install')
      .set(dmHeaders)
      .send({ source: 'open5e', url: fake.baseUrl, sections: ['conditions'] });
    expect(conditionsRes.status).toBe(201);
    expect(conditionsRes.body.entryCount).toBe(4);
    const packId = conditionsRes.body.id;

    // Installing spells on top: the pack already exists, so this is incremental — 200,
    // not 201, and `added` reflects the two new spell entries.
    const spellsRes = await request(server)
      .post('/api/v1/rules/packs/install')
      .set(dmHeaders)
      .send({ source: 'open5e', url: fake.baseUrl, sections: ['spells'] });
    expect(spellsRes.status).toBe(200);
    expect(spellsRes.body.added).toBe(2);
    expect(spellsRes.body.skippedExisting).toBe(0);
    expect(spellsRes.body.entryCount).toBe(4 + 2); // conditions + spells
    expect(spellsRes.body.id).toBe(packId); // same pack, not a new row

    // Search now finds both the earlier conditions and the newly-added spells.
    const searchConditions = await request(server).get('/api/v1/rules/search').query({ q: 'prone' }).set(dmHeaders);
    expect(searchConditions.body.some((e: { name: string }) => e.name === 'Prone')).toBe(true);
    const searchSpells = await request(server).get('/api/v1/rules/search').query({ q: 'fireball' }).set(dmHeaders);
    expect(searchSpells.body.some((e: { name: string }) => e.name === 'Fireball')).toBe(true);

    // Reinstalling conditions again: everything requested is already present -> 200,
    // added:0, skippedExisting matches the conditions count. NOT a 409 (chosen UX per
    // round-2 finding #2: simpler for callers than forcing a pre-check).
    const reinstallConditions = await request(server)
      .post('/api/v1/rules/packs/install')
      .set(dmHeaders)
      .send({ source: 'open5e', url: fake.baseUrl, sections: ['conditions'] });
    expect(reinstallConditions.status).toBe(200);
    expect(reinstallConditions.body.added).toBe(0);
    expect(reinstallConditions.body.skippedExisting).toBe(4);
    expect(reinstallConditions.body.entryCount).toBe(6); // unchanged by the no-op reinstall

    await request(server).delete(`/api/v1/rules/packs/${packId}`).set(dmHeaders);
  });
});

/**
 * Round-2 finding #3: concurrent installs racing the same slug must never surface a raw
 * 500 from the UNIQUE constraint on rule_packs.slug — exactly one wins the fresh insert
 * (201) and the rest resolve cleanly via the incremental path (200, possibly added:0).
 */
describe('rules / rule packs — concurrent install race (e2e, fake Open5e server)', () => {
  let ctx: TestAppContext;
  let fake: FakeOpen5e;
  const dmHeaders = { 'x-dev-role': 'dm', 'x-dev-user': 'concurrency-dm' };

  beforeAll(async () => {
    ctx = await createTestApp();
    fake = await startFakeOpen5e();
  });

  afterAll(async () => {
    await fake.close();
    await closeTestApp(ctx);
  });

  it('4 concurrent installs: one 201, the rest clean 200s, never a 500', async () => {
    const server = ctx.app.getHttpServer();

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        request(server).post('/api/v1/rules/packs/install').set(dmHeaders).send({ source: 'open5e', url: fake.baseUrl }),
      ),
    );

    for (const res of results) {
      expect([200, 201]).toContain(res.status);
    }
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);

    // All four resolved against the SAME pack id — no duplicate rows.
    const packIds = new Set(results.map((r) => r.body.id));
    expect(packIds.size).toBe(1);

    const listRes = await request(server).get('/api/v1/rules/packs').set(dmHeaders);
    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0].entryCount).toBe(2 + 2 + 1 + 4);

    await request(server).delete(`/api/v1/rules/packs/${[...packIds][0]}`).set(dmHeaders);
  });
});
