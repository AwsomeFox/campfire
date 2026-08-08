import request from 'supertest';
import type { Server } from 'node:http';
import { eq } from 'drizzle-orm';
import { createTestApp, createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';
import { DB, DB_HOLDER, type DbHolder, type DrizzleDb } from '../src/db/db.module';
import { auditLog, campaigns, ruleEntries, rulePacks } from '../src/db/schema';
import {
  startFakeOpen5e,
  startFakeOpen5eWithBadPagination,
  startFakeOpen5eFlaky,
  startFakeOpen5eMultiDoc,
  startFakeOpen5eMixedLicense,
  type FakeOpen5e,
  type FakeOpen5eWithBadPagination,
  type FakeOpen5eFlaky,
} from './fake-open5e';
import { ALL_OPEN5E_SECTIONS, OPEN5E_PACK_VERSION } from '../src/modules/rules/open5e-importer';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' }; // dev-header users always carry serverRole 'admin'
const player = { 'x-dev-role': 'player', 'x-dev-user': 'p-1' };

/**
 * Install is a non-blocking background job (issue #20): POST returns 202 with a job,
 * the caller polls GET packs/install-jobs/:id for progress + the final result. These
 * helpers enqueue then poll to a terminal state so the tests can assert on the outcome.
 */
async function pollJob(
  server: Server,
  headers: Record<string, string>,
  jobId: string,
  { timeoutMs = 15_000 }: { timeoutMs?: number } = {},
) {
  const start = Date.now();
  for (;;) {
    const res = await request(server).get(`/api/v1/rules/packs/install-jobs/${jobId}`).set(headers);
    expect(res.status).toBe(200);
    if (res.body.status === 'completed' || res.body.status === 'failed') return res.body;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`install job ${jobId} did not finish within ${timeoutMs}ms (last status ${res.body.status})`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Enqueue an Open5e install (expecting 202) and poll it to completion/failure. */
async function installOpen5e(
  server: Server,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  opts?: { timeoutMs?: number },
) {
  const res = await request(server).post('/api/v1/rules/packs/install').set(headers).send(body);
  expect(res.status).toBe(202);
  expect(res.body.status).toBe('pending');
  return pollJob(server, headers, res.body.id, opts);
}


/** Issue #613: /rules/search returns a page object, not a bare array. */
function searchItems(body: { items?: unknown[] } | unknown[]): any[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object' && Array.isArray((body as { items?: unknown[] }).items)) {
    return (body as { items: any[] }).items;
  }
  throw new Error(`unexpected rules search body: ${JSON.stringify(body)}`);
}

function searchFacets(body: { facets?: unknown[] }): any[] {
  if (body && typeof body === 'object' && Array.isArray(body.facets)) return body.facets as any[];
  throw new Error(`unexpected rules search facets: ${JSON.stringify(body)}`);
}

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

  it('non-admin (dev-header player) can still enqueue an install (dev players carry serverRole admin)', async () => {
    const server = ctx.app.getHttpServer();
    // player dev-header users still carry serverRole 'admin' in this codebase's dev-auth
    // path (see session-auth.guard.ts) — server-admin/DM gating is exercised for real in
    // the "real sessions" describe block below.
    const job = await installOpen5e(server, player, { source: 'open5e', url: fake.baseUrl });
    expect(job.status).toBe('completed');
    // undo so later tests in this file start clean
    await request(server).delete(`/api/v1/rules/packs/${job.pack.id}`).set(dm);
  });

  it('install from fake Open5e server -> packs list -> search -> entry fetch -> uninstall', async () => {
    const server = ctx.app.getHttpServer();

    const job = await installOpen5e(server, dm, { source: 'open5e', url: fake.baseUrl });
    expect(job.status).toBe('completed');
    expect(job.outcome).toBe('created');
    expect(job.pack.slug).toBe('open5e-srd');
    expect(job.pack.entryCount).toBe(2 + 2 + 1 + 4 + 2 + 2 + 1 + 4 + 2); // spells + creatures + magicitems + conditions + classes + species + feats + weapons + armor from the fake server
    expect(job.pack.license).toContain('Creative Commons');
    // per-section progress was reported (issue #20): one row per section, all done.
    expect(job.progress.length).toBe(9);
    expect(job.progress.every((p: { status: string }) => p.status === 'done')).toBe(true);
    expect(job.completedSections).toBe(9);
    const packId = job.pack.id;

    const listRes = await request(server).get('/api/v1/rules/packs').set(dm);
    expect(listRes.status).toBe(200);
    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0].id).toBe(packId);

    // Simulate an entry installed by the pre-#621 importer, which had no action
    // categories, and a user-selected icon. Re-importing Open5e must refresh the
    // importer-owned data in place without losing the row id or icon override.
    const oldSentinelSearch = await request(server)
      .get('/api/v1/rules/search')
      .query({ q: 'fixture sentinel', type: 'monster' })
      .set(dm);
    const oldSentinel = searchItems(oldSentinelSearch.body).find((e: { name: string }) => e.name === 'Fixture Sentinel');
    const db = ctx.app.get<DrizzleDb>(DB);
    db.update(rulePacks).set({ version: 'open5e-v2-pre-defenses' }).where(eq(rulePacks.id, packId)).run();
    db.update(ruleEntries)
      .set({ dataJson: JSON.stringify({ ac: 16, hp: 52 }), updatedAt: new Date().toISOString() })
      .where(eq(ruleEntries.id, oldSentinel.id))
      .run();
    const iconRes = await request(server)
      .patch(`/api/v1/rules/entries/${oldSentinel.id}`)
      .set(dm)
      .send({ iconSlug: 'golem-head' });
    expect(iconRes.status).toBe(200);

    // Re-installing the same slug+sections is an in-place Open5e refresh: outcome
    // 'updated' with added:0 (everything already exists) rather than a duplicate or 409.
    // The mutated row stands in for data an OLDER importer (pre-#621) wrote, which predates
    // manifest-hash tracking (#1518) — so the pack has no trusted manifest hash, and the
    // re-import must run the full transactional classification (detecting changed:1) rather
    // than short-circuit. Clearing the hash models exactly that old→new upgrade path.
    db.update(rulePacks).set({ manifestHash: '' }).where(eq(rulePacks.id, packId)).run();
    const reJob = await installOpen5e(server, dm, { source: 'open5e', url: fake.baseUrl });
    expect(reJob.status).toBe('completed');
    expect(reJob.outcome).toBe('updated');
    expect(reJob.added).toBe(0);
    expect(reJob.skippedExisting).toBe(2 + 2 + 1 + 4 + 2 + 2 + 1 + 4 + 2);
    expect(reJob.changed).toBe(1);
    expect(reJob.removed).toBe(0);
    expect(reJob.pack.version).toBe(OPEN5E_PACK_VERSION);
    expect(reJob.preview).toMatchObject({
      added: 0,
      changed: 1,
      removed: 0,
      unchanged: (2 + 2 + 1 + 4 + 2 + 2 + 1 + 4 + 2) - 1,
    });
    expect(reJob.preview.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(reJob.pack.entryCount).toBe(2 + 2 + 1 + 4 + 2 + 2 + 1 + 4 + 2); // unchanged

    // search: free text finds the fireball spell
    const searchRes = await request(server).get('/api/v1/rules/search').query({ q: 'fireball' }).set(dm);
    expect(searchRes.status).toBe(200);
    expect(searchItems(searchRes.body).length).toBeGreaterThan(0);
    expect(searchItems(searchRes.body).some((e: { name: string }) => e.name === 'Fireball')).toBe(true);

    // issue #544: live facets are counted from all matching entries in the active pack/query,
    // and absent categories (section/other for Open5e) are not advertised.
    const facetRes = await request(server).get('/api/v1/rules/search').query({ pack: 'open5e-srd' }).set(dm);
    expect(facetRes.status).toBe(200);
    expect(searchFacets(facetRes.body)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'spell', label: 'Spells', count: 2 }),
      expect.objectContaining({ type: 'monster', label: 'Monsters', count: 2 }),
      // 1 magic item + 4 weapons + 2 armor — the weapons/armor sections (issue #2096) are
      // ruleEntry.type 'item' too, so they land in the SAME facet as magic items rather
      // than adding facets of their own.
      expect.objectContaining({ type: 'item', label: 'Items', count: 1 + 4 + 2 }),
    ]));
    expect(searchFacets(facetRes.body).some((f: { type: string }) => f.type === 'section' || f.type === 'other')).toBe(false);
    // The chip row must add up to the list it labels: with no type filter, the facet
    // counts sum to the same `total` the search reports.
    expect(
      searchFacets(facetRes.body).reduce((sum: number, f: { count: number }) => sum + f.count, 0),
    ).toBe(facetRes.body.total);
    // A campaign pointed at a rule system with nothing installed gets an empty facet row
    // rather than a hardcoded 5e-shaped one.
    const missingPackRes = await request(server).get('/api/v1/rules/search').query({ pack: 'not-installed' }).set(dm);
    expect(missingPackRes.status).toBe(200);
    expect(searchFacets(missingPackRes.body)).toEqual([]);
    expect(missingPackRes.body.total).toBe(0);

    // search: type filter narrows to monsters only
    const monsterSearchRes = await request(server).get('/api/v1/rules/search').query({ q: 'fixture sentinel', type: 'monster' }).set(dm);
    expect(monsterSearchRes.status).toBe(200);
    expect(searchItems(monsterSearchRes.body).length).toBeGreaterThan(0);
    for (const e of searchItems(monsterSearchRes.body)) expect(e.type).toBe('monster');
    expect(searchItems(monsterSearchRes.body).some((e: { name: string }) => e.name === 'Fixture Sentinel')).toBe(true);

    // Issue #621 regression: live Open5e v2 combines regular, reaction and legendary
    // entries in actions[] (partitioned by action_type) and calls passive abilities
    // traits[]. The importer must preserve every category, raw description, and useful
    // structured mechanics in the shared dataJson returned by search and entry reads.
    const sentinel = searchItems(monsterSearchRes.body).find((e: { name: string }) => e.name === 'Fixture Sentinel');
    const sentinelData = JSON.parse(sentinel.dataJson);
    expect(sentinelData.resistances_and_immunities).toMatchObject({
      damage_resistances: [{ name: 'Fire', key: 'fire' }, { name: 'Lightning', key: 'lightning' }],
      damage_vulnerabilities: [{ name: 'Cold', key: 'cold' }],
      damage_immunities: [{ name: 'Poison', key: 'poison' }],
    });
    expect(sentinelData.specialAbilities).toEqual([
      expect.objectContaining({ name: 'Immutable Form', desc: expect.stringContaining('alter its form') }),
    ]);
    expect(sentinelData.actions.map((a: { name: string }) => a.name)).toEqual(['Multiattack', 'Arc Blade', 'Static Burst']);
    expect(sentinelData.actions[1]).toMatchObject({
      attackBonus: 6,
      damage: [{ expression: '2d6 + 4', type: 'Lightning' }],
      attacks: [expect.objectContaining({ attackBonus: 6, damage: [{ expression: '2d6 + 4', type: 'Lightning' }] })],
    });
    expect(sentinelData.actions[2]).toMatchObject({
      desc: expect.stringContaining('DC 15 Dexterity saving throw'),
      savingThrow: { dc: 15, ability: 'Dexterity' },
      usage: { type: 'recharge', min: 5, max: 6, label: 'Recharge 5\u20136' },
      usage_limits: { type: 'RECHARGE_ON_ROLL', param: 5 },
    });
    expect(sentinelData.reactions).toEqual([
      expect.objectContaining({ name: 'Deflect', action_type: 'REACTION', desc: expect.stringContaining('one attack') }),
    ]);
    expect(sentinelData.legendaryActions).toEqual([
      expect.objectContaining({ name: 'Sweep', action_type: 'LEGENDARY_ACTION', legendaryActionCost: 2 }),
    ]);

    const sentinelEntryRes = await request(server).get(`/api/v1/rules/entries/${sentinel.id}`).set(dm);
    expect(sentinelEntryRes.status).toBe(200);
    expect(sentinelEntryRes.body.dataJson).toBe(sentinel.dataJson);
    expect(sentinelEntryRes.body.id).toBe(oldSentinel.id);
    expect(sentinelEntryRes.body.iconSlug).toBe('golem-head');
    expect(sentinelEntryRes.body.license).toBe('Creative Commons Attribution 4.0');

    // search: pack filter
    const packSearchRes = await request(server).get('/api/v1/rules/search').query({ q: 'goblin', pack: 'open5e-srd' }).set(dm);
    expect(packSearchRes.status).toBe(200);
    expect(searchItems(packSearchRes.body).some((e: { name: string }) => e.name === 'Goblin')).toBe(true);

    // issue #53 regression: a DEFAULT install (all sections) must actually ship
    // monsters, spells, AND magic items — not just conditions. Monster (Owlbear) and
    // spell (Fireball) are asserted above; assert an item is searchable too.
    const itemSearchRes = await request(server).get('/api/v1/rules/search').query({ q: 'bag of holding', type: 'item' }).set(dm);
    expect(itemSearchRes.status).toBe(200);
    for (const e of searchItems(itemSearchRes.body)) expect(e.type).toBe('item');
    expect(searchItems(itemSearchRes.body).some((e: { name: string }) => e.name === 'Bag of Holding')).toBe(true);

    // issue #53 root cause was a pagination failure on large (multi-page) sections. The
    // fake serves spells across TWO pages; Mage Armor lives on page 2, so finding it
    // proves the importer followed the `next` link and imported page-2 entries.
    const pagedSpellRes = await request(server).get('/api/v1/rules/search').query({ q: 'mage armor', type: 'spell' }).set(dm);
    expect(pagedSpellRes.status).toBe(200);
    expect(searchItems(pagedSpellRes.body).some((e: { name: string }) => e.name === 'Mage Armor')).toBe(true);

    // search ranking (issue #33): "poisoned" matches both Poisoned (by name) and
    // Petrified (whose body mentions the Poisoned condition, and which was imported
    // first, so it has the lower rowid) — the exact-name match must rank first.
    const rankedRes = await request(server).get('/api/v1/rules/search').query({ q: 'poisoned' }).set(dm);
    expect(rankedRes.status).toBe(200);
    expect(searchItems(rankedRes.body).length).toBeGreaterThanOrEqual(2); // both condition entries matched
    expect(searchItems(rankedRes.body)[0].name).toBe('Poisoned');
    expect(searchItems(rankedRes.body).some((e: { name: string }) => e.name === 'Petrified')).toBe(true);

    // ...and the exact-name bucket is case-insensitive.
    const upperRes = await request(server).get('/api/v1/rules/search').query({ q: 'POISONED' }).set(dm);
    expect(searchItems(upperRes.body)[0].name).toBe('Poisoned');

    // Prefix name matches also outrank body-only matches: "poison" is a prefix of
    // "Poisoned" but only appears inside Petrified's body.
    const prefixRes = await request(server).get('/api/v1/rules/search').query({ q: 'poison' }).set(dm);
    expect(searchItems(prefixRes.body)[0].name).toBe('Poisoned');

    // search: no query returns entries (optionally filtered), not an error
    const browseRes = await request(server).get('/api/v1/rules/search').query({ type: 'condition' }).set(dm);
    expect(browseRes.status).toBe(200);
    expect(searchItems(browseRes.body).length).toBeGreaterThanOrEqual(2);
    for (const e of searchItems(browseRes.body)) expect(e.type).toBe('condition');

    // entry fetch by id
    const fireball = searchItems(searchRes.body).find((e: { name: string }) => e.name === 'Fireball');
    const entryRes = await request(server).get(`/api/v1/rules/entries/${fireball.id}`).set(dm);
    expect(entryRes.status).toBe(200);
    expect(entryRes.body.name).toBe('Fireball');
    expect(entryRes.body.body).toContain('bright streak');
    expect(entryRes.body.type).toBe('spell');

    // any authed role (not just dm) can read
    const playerSearch = await request(server).get('/api/v1/rules/search').query({ q: 'prone' }).set(player);
    expect(playerSearch.status).toBe(200);
    expect(searchItems(playerSearch.body).some((e: { name: string }) => e.name === 'Prone')).toBe(true);

    // uninstall
    const uninstallRes = await request(server).delete(`/api/v1/rules/packs/${packId}`).set(dm);
    expect(uninstallRes.status).toBe(200);

    const afterList = await request(server).get('/api/v1/rules/packs').set(dm);
    expect(afterList.body).toEqual([]);

    const afterSearch = await request(server).get('/api/v1/rules/search').query({ q: 'fireball' }).set(dm);
    expect(searchItems(afterSearch.body)).toEqual([]);

    const afterEntry = await request(server).get(`/api/v1/rules/entries/${fireball.id}`).set(dm);
    expect(afterEntry.status).toBe(404);
  });

  // Manual icon override on a compendium entry (issue #305): imported entries carry an
  // empty iconSlug (the web app derives a default from type/dataJson); a DM can PATCH a
  // bundled game-icons.net slug and clear it back. Round-trips create -> set -> clear.
  it('rule entry iconSlug defaults to empty and round-trips through PATCH set/clear', async () => {
    const server = ctx.app.getHttpServer();
    const job = await installOpen5e(server, dm, { source: 'open5e', url: fake.baseUrl, sections: ['spells'] });
    const packId = job.pack.id;

    try {
      const searchRes = await request(server).get('/api/v1/rules/search').query({ q: 'fireball' }).set(dm);
      const fireball = searchItems(searchRes.body).find((e: { name: string }) => e.name === 'Fireball');
      expect(fireball).toBeDefined();

      // Imported entries have no override — the field is present and empty.
      const fetched = await request(server).get(`/api/v1/rules/entries/${fireball.id}`).set(dm);
      expect(fetched.status).toBe(200);
      expect(fetched.body.iconSlug).toBe('');

      // DM sets an override.
      const set = await request(server).patch(`/api/v1/rules/entries/${fireball.id}`).set(dm).send({ iconSlug: 'fire' });
      expect(set.status).toBe(200);
      expect(set.body.iconSlug).toBe('fire');

      // Persisted for the next reader.
      const afterSet = await request(server).get(`/api/v1/rules/entries/${fireball.id}`).set(dm);
      expect(afterSet.body.iconSlug).toBe('fire');

      // Cleared back to the derived default.
      const cleared = await request(server).patch(`/api/v1/rules/entries/${fireball.id}`).set(dm).send({ iconSlug: '' });
      expect(cleared.status).toBe(200);
      expect(cleared.body.iconSlug).toBe('');

      // An unknown entry id 404s.
      const missing = await request(server).patch('/api/v1/rules/entries/999999').set(dm).send({ iconSlug: 'fire' });
      expect(missing.status).toBe(404);

      // An unrecognized body key is rejected (strict DTO).
      const bad = await request(server).patch(`/api/v1/rules/entries/${fireball.id}`).set(dm).send({ bogus: 'x' });
      expect(bad.status).toBe(400);
    } finally {
      await request(server).delete(`/api/v1/rules/packs/${packId}`).set(dm);
    }
  });

  it('install with a single section only imports that section', async () => {
    const server = ctx.app.getHttpServer();

    const job = await installOpen5e(server, dm, { source: 'open5e', url: fake.baseUrl, sections: ['spells'] });
    expect(job.status).toBe('completed');
    expect(job.pack.entryCount).toBe(2);
    expect(job.progress.length).toBe(1); // only the requested section is tracked

    const searchRes = await request(server).get('/api/v1/rules/search').query({ q: 'goblin' }).set(dm);
    expect(searchItems(searchRes.body)).toEqual([]); // creatures weren't imported

    await request(server).delete(`/api/v1/rules/packs/${job.pack.id}`).set(dm);
  });

  // Issue #500 guard: an update may only DELETE installed entries when the fetch it is
  // comparing against is the complete upstream set. `sections` comes off the request body
  // and is not de-duplicated by the schema, so a repeated section can reach the importer
  // with the same array LENGTH as the full section list while covering only one section.
  // Authorising removal off that length would wipe every other section out of the pack.
  it('a repeated-section install never removes the sections it did not fetch (issue #500)', async () => {
    const server = ctx.app.getHttpServer();
    const total = 2 + 2 + 1 + 4 + 2 + 2 + 1 + 4 + 2;

    const full = await installOpen5e(server, dm, { source: 'open5e', url: fake.baseUrl });
    expect(full.status).toBe('completed');
    expect(full.pack.entryCount).toBe(total);

    // One section repeated ALL_OPEN5E_SECTIONS.length times: same array length as the full
    // section list, one section actually covered.
    const repeated = await installOpen5e(server, dm, {
      source: 'open5e',
      url: fake.baseUrl,
      sections: ALL_OPEN5E_SECTIONS.map(() => 'conditions'),
    });
    expect(repeated.status).toBe('completed');
    expect(repeated.outcome).toBe('updated');
    expect(repeated.removed).toBe(0);
    expect(repeated.preview.removed).toBe(0);
    expect(repeated.pack.entryCount).toBe(total);

    // The un-fetched sections are still there and still searchable.
    const goblinRes = await request(server).get('/api/v1/rules/search').query({ q: 'goblin' }).set(dm);
    expect(searchItems(goblinRes.body).length).toBeGreaterThan(0);
    const fireballRes = await request(server).get('/api/v1/rules/search').query({ q: 'fireball' }).set(dm);
    expect(searchItems(fireballRes.body).some((e: { name: string }) => e.name === 'Fireball')).toBe(true);

    await request(server).delete(`/api/v1/rules/packs/${repeated.pack.id}`).set(dm);
  });

  // The counterpart to the truncated-fetch guard: when the fetch IS demonstrably complete
  // (every section requested, nothing skipped, no section at its cap), an entry that is no
  // longer upstream must actually be REMOVED — otherwise a pack accumulates content that
  // upstream has retracted. This is also how a slug rename resolves: remove-old + add-new.
  it('a complete upstream manifest removes entries upstream no longer has (issue #500)', async () => {
    const server = ctx.app.getHttpServer();
    const db = ctx.app.get<DrizzleDb>(DB);
    const total = 2 + 2 + 1 + 4 + 2 + 2 + 1 + 4 + 2;

    const first = await installOpen5e(server, dm, { source: 'open5e', url: fake.baseUrl });
    expect(first.status).toBe('completed');
    expect(first.pack.entryCount).toBe(total);

    // An entry a previous import landed that this (complete) manifest no longer contains —
    // i.e. genuinely retracted upstream, or the old half of a slug rename.
    const now = new Date().toISOString();
    const [stale] = db.insert(ruleEntries)
      .values({
        packId: first.pack.id,
        slug: 'srd-retracted-spell',
        name: 'Retracted Spell',
        type: 'spell',
        summary: 'Upstream pulled this.',
        body: 'Gone from the source.',
        dataJson: '{}',
        source: 'SRD',
        license: 'CC-BY-4.0',
        attribution: '',
        author: '',
        sourceUrl: '',
        iconSlug: '',
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .all();
    // A previous import that landed this row would have maintained entryCount to match the
    // real row count. The raw insert above bypasses that bookkeeping, so restore it — without
    // it the #1518 short-circuit's entryCount gate (entryCount === manifest size) would
    // wrongly conclude there is nothing to remove. This mirrors what the import flow leaves
    // behind, not extra test-only state.
    db.update(rulePacks).set({ entryCount: total + 1 }).where(eq(rulePacks.id, first.pack.id)).run();

    const second = await installOpen5e(server, dm, { source: 'open5e', url: fake.baseUrl });
    expect(second.status).toBe('completed');
    expect(second.outcome).toBe('updated');
    expect(second.removed).toBe(1);
    expect(second.preview.removed).toBe(1);
    expect(second.pack.entryCount).toBe(total);

    expect(db.select().from(ruleEntries).where(eq(ruleEntries.id, stale.id)).all()).toHaveLength(0);

    await request(server).delete(`/api/v1/rules/packs/${second.pack.id}`).set(dm);
  });

  it('install classes, races, and feats sections (issue #2) — mapped to class/race/feat entry types', async () => {
    const server = ctx.app.getHttpServer();

    const job = await installOpen5e(server, dm, { source: 'open5e', url: fake.baseUrl, sections: ['classes', 'races', 'feats'] });
    expect(job.status).toBe('completed');
    expect(job.pack.entryCount).toBe(2 + 2 + 1); // classes + species + feats from the fake server

    // classes: served from /v2/classes/; empty desc means the body comes from features[].
    const classSearch = await request(server).get('/api/v1/rules/search').query({ q: 'barbarian', type: 'class' }).set(dm);
    expect(classSearch.status).toBe(200);
    for (const e of searchItems(classSearch.body)) expect(e.type).toBe('class');
    const barbarian = searchItems(classSearch.body).find((e: { name: string }) => e.name === 'Barbarian');
    expect(barbarian).toBeDefined();
    expect(barbarian.body).toContain('### Rage');
    expect(barbarian.body).toContain('primal ferocity');
    expect(barbarian.summary).toContain('hit dice D12');
    const barbarianData = JSON.parse(barbarian.dataJson);
    expect(barbarianData.hitDice).toBe('D12');
    expect(barbarianData.savingThrows).toEqual(['Strength', 'Constitution']);
    expect(barbarianData.subclassOf).toBeNull();

    // subclasses share the classes list, distinguished via subclass_of.
    const berserker = searchItems(
      (await request(server).get('/api/v1/rules/search').query({ q: 'berserker' }).set(dm)).body,
    ).find((e: { name: string }) => e.name === 'Path of the Berserker');
    expect(berserker).toBeDefined();
    expect(berserker.type).toBe('class');
    expect(JSON.parse(berserker.dataJson).subclassOf).toBe('Barbarian');
    expect(berserker.summary).toContain('Barbarian subclass');

    // races: fetched from /v2/species/ (v2 has no /races/ route) but exposed as type 'race'.
    const raceSearch = await request(server).get('/api/v1/rules/search').query({ q: 'dwarf', type: 'race' }).set(dm);
    expect(raceSearch.status).toBe(200);
    for (const e of searchItems(raceSearch.body)) expect(e.type).toBe('race');
    const dwarf = searchItems(raceSearch.body).find((e: { name: string }) => e.name === 'Dwarf');
    expect(dwarf).toBeDefined();
    expect(dwarf.body).toContain('### Darkvision');
    expect(dwarf.summary).toContain('Bold and hardy');
    const hillDwarf = searchItems(raceSearch.body).find((e: { name: string }) => e.name === 'Hill Dwarf');
    expect(hillDwarf).toBeDefined();
    const hillDwarfData = JSON.parse(hillDwarf.dataJson);
    expect(hillDwarfData.isSubspecies).toBe(true);
    expect(hillDwarfData.subspeciesOf).toBe('srd_dwarf');

    // feats: prerequisite surfaces in the summary, benefits become body bullets.
    const featSearch = await request(server).get('/api/v1/rules/search').query({ q: 'grappler', type: 'feat' }).set(dm);
    expect(featSearch.status).toBe(200);
    const grappler = searchItems(featSearch.body).find((e: { name: string }) => e.name === 'Grappler');
    expect(grappler).toBeDefined();
    expect(grappler.type).toBe('feat');
    expect(grappler.summary).toBe('Prerequisite: Strength 13 or higher');
    expect(grappler.body).toContain('close-quarters grappling');
    expect(grappler.body).toContain('- You have advantage on attack rolls');
    expect(JSON.parse(grappler.dataJson).hasPrerequisite).toBe(true);

    // license still flows through from the document sub-object for the new sections.
    expect(job.pack.license).toContain('Creative Commons');

    // sections not requested weren't imported.
    const spellSearch = await request(server).get('/api/v1/rules/search').query({ q: 'fireball' }).set(dm);
    expect(searchItems(spellSearch.body)).toEqual([]);

    await request(server).delete(`/api/v1/rules/packs/${job.pack.id}`).set(dm);
  });

  // Issue #2096: before this, `items` was the ONLY gear section and it maps to Open5e's
  // /magicitems/ path — so a Longsword could not be acquired from the compendium at all,
  // and the equipped-weapon action loop (#1326/#1901) had no 5e data to build on.
  it('installs mundane weapons and armor as item entries carrying their combat stats (issue #2096)', async () => {
    const server = ctx.app.getHttpServer();

    const job = await installOpen5e(server, dm, { source: 'open5e', url: fake.baseUrl, sections: ['weapons', 'armor'] });
    expect(job.status).toBe('completed');
    expect(job.pack.entryCount).toBe(4 + 2); // weapons + armor from the fake server

    const weaponSearch = await request(server).get('/api/v1/rules/search').query({ q: 'longsword', type: 'item' }).set(dm);
    expect(weaponSearch.status).toBe(200);
    const longsword = searchItems(weaponSearch.body).find((e: { name: string }) => e.name === 'Longsword');
    expect(longsword).toBeDefined();
    expect(longsword.type).toBe('item');
    const longswordData = JSON.parse(longsword.dataJson);
    expect(longswordData).toMatchObject({ itemKind: 'weapon', damageDice: '1d8', damageType: 'Slashing', isSimple: false });
    // The stat a consumer building an attack actually needs, and the one most easily lost:
    // Versatile's two-handed die lives in the property's `detail`.
    expect(longswordData.properties).toContainEqual({ name: 'Versatile', type: null, detail: '1d10' });

    // A magic item and a mundane weapon are both `item` entries, so a reader has to be able
    // to tell them apart from the data alone.
    const magicJob = await installOpen5e(server, dm, { source: 'open5e', url: fake.baseUrl, sections: ['items'] });
    expect(magicJob.status).toBe('completed');
    const bagSearch = await request(server).get('/api/v1/rules/search').query({ q: 'bag of holding', type: 'item' }).set(dm);
    const bag = searchItems(bagSearch.body).find((e: { name: string }) => e.name === 'Bag of Holding');
    expect(bag).toBeDefined();
    expect(JSON.parse(bag.dataJson).itemKind).toBeUndefined();

    const armorSearch = await request(server).get('/api/v1/rules/search').query({ q: 'chain mail', type: 'item' }).set(dm);
    const chainMail = searchItems(armorSearch.body).find((e: { name: string }) => e.name === 'Chain Mail');
    expect(chainMail).toBeDefined();
    expect(JSON.parse(chainMail.dataJson)).toMatchObject({
      itemKind: 'armor',
      acBase: 16,
      grantsStealthDisadvantage: true,
      strengthScoreRequired: 13,
    });

    // The Net's damage_dice is the string '0' upstream — not a dice expression. It must
    // still import rather than being silently dropped for failing a validation this layer
    // deliberately does not perform.
    const netSearch = await request(server).get('/api/v1/rules/search').query({ q: 'net', type: 'item' }).set(dm);
    const net = searchItems(netSearch.body).find((e: { name: string }) => e.name === 'Net');
    expect(net).toBeDefined();
    expect(JSON.parse(net.dataJson).damageDice).toBe('0');

    await request(server).delete(`/api/v1/rules/packs/${job.pack.id}`).set(dm);
  });

  it('install from an unreachable URL fails the job cleanly (not a crash)', async () => {
    const server = ctx.app.getHttpServer();
    // The POST is accepted (202) — failure surfaces on the job, not the request. A single
    // section keeps the failure self-contained (no sibling section fetches left retrying in
    // the background past this test), so nothing leaks into later suites.
    const job = await installOpen5e(server, dm, { source: 'open5e', url: 'http://127.0.0.1:1', sections: ['conditions'] }); // nothing listens here
    expect(job.status).toBe('failed');
    expect(job.error).toBeTruthy();
    expect(job.pack).toBeNull();
  });

  it('uninstalling a pack nulls out ruleEntryId on any combatant that referenced one of its entries', async () => {
    const server = ctx.app.getHttpServer();

    const campRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Uninstall Cascade Campaign' });
    const campaignId = campRes.body.id;
    const encRes = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Goblin Fight' });
    const encounterId = encRes.body.id;

    const job = await installOpen5e(server, dm, { source: 'open5e', url: fake.baseUrl, sections: ['monsters'] });
    expect(job.status).toBe('completed');
    const packId = job.pack.id;

    const searchRes = await request(server).get('/api/v1/rules/search').query({ q: 'goblin' }).set(dm);
    const goblinEntry = searchItems(searchRes.body).find((e: { name: string }) => e.name === 'Goblin');
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

  it('install-job status endpoint 404s for an unknown job id', async () => {
    const res = await request(ctx.app.getHttpServer())
      .get('/api/v1/rules/packs/install-jobs/does-not-exist')
      .set(dm);
    expect(res.status).toBe(404);
  });
});

/**
 * Issue #19: generic open-licensed dataset upload. A JSON rule pack for ANY system
 * (not just Open5e) can be uploaded, coexists alongside other packs, and is rejected
 * unless it carries an open license.
 */
describe('rules / rule packs — generic upload (issue #19)', () => {
  let ctx: TestAppContext;
  let fake: FakeOpen5e;
  const uploader = { 'x-dev-role': 'dm', 'x-dev-user': 'upload-dm' };

  beforeAll(async () => {
    ctx = await createTestApp();
    fake = await startFakeOpen5e();
  });

  afterAll(async () => {
    await fake.close();
    await closeTestApp(ctx);
  });

  async function uploadPack(body: Record<string, unknown>) {
    const res = await request(ctx.app.getHttpServer()).post('/api/v1/rules/packs/upload').set(uploader).send(body);
    return res;
  }

  const pf2ePack = {
    source: 'upload' as const,
    pack: {
      slug: 'pf2e-srd',
      name: 'Pathfinder 2e SRD',
      version: '2024.1',
      license: 'ORC License',
      sourceUrl: 'https://example.com/pf2e',
    },
    entries: [
      { slug: 'pf2e-fireball', name: 'Fireball', type: 'spell', summary: 'A roaring blast of flame.', body: 'Fire erupts from a point you choose.' },
      { slug: 'pf2e-goblin', name: 'Goblin Warrior', type: 'monster', summary: 'CR -1', dataJson: JSON.stringify({ hp: 6 }) },
      { slug: 'pf2e-fighter', name: 'Fighter', type: 'class', body: 'You are a master of martial combat.' },
    ],
  };

  it('uploads an ORC-licensed pack -> polls the job -> pack + entries are searchable', async () => {
    const server = ctx.app.getHttpServer();

    const res = await uploadPack(pf2ePack);
    expect(res.status).toBe(202);
    expect(res.body.source).toBe('upload');
    expect(res.body.status).toBe('pending');

    const job = await pollJob(server, uploader, res.body.id);
    expect(job.status).toBe('completed');
    expect(job.outcome).toBe('created');
    expect(job.pack.slug).toBe('pf2e-srd');
    expect(job.pack.name).toBe('Pathfinder 2e SRD');
    expect(job.pack.version).toBe('2024.1');
    expect(job.pack.license).toBe('ORC License');
    expect(job.pack.entryCount).toBe(3);

    // entries are searchable under the new pack, scoped by its slug
    const spellRes = await request(server).get('/api/v1/rules/search').query({ q: 'fireball', pack: 'pf2e-srd' }).set(uploader);
    expect(searchItems(spellRes.body).some((e: { name: string }) => e.name === 'Fireball')).toBe(true);
    const classRes = await request(server).get('/api/v1/rules/search').query({ q: 'fighter', type: 'class' }).set(uploader);
    expect(searchItems(classRes.body).some((e: { name: string }) => e.name === 'Fighter')).toBe(true);

    await request(server).delete(`/api/v1/rules/packs/${job.pack.id}`).set(uploader);
  });

  it('reports live source-native facets for PF2e, Open Legend, OSR, and prose uploads (issue #544)', async () => {
    const server = ctx.app.getHttpServer();
    const jobs: Array<{ pack?: { id: number } }> = [];

    async function uploadAndPoll(body: Record<string, unknown>) {
      const res = await uploadPack(body);
      expect(res.status).toBe(202);
      const job = await pollJob(server, uploader, res.body.id);
      expect(job.status).toBe('completed');
      jobs.push(job);
      return job;
    }

    async function facetsFor(pack: string, query: Record<string, string> = {}) {
      const res = await request(server).get('/api/v1/rules/search').query({ pack, ...query }).set(uploader);
      expect(res.status).toBe(200);
      return searchFacets(res.body);
    }

    try {
      await uploadAndPoll({
        ...pf2ePack,
        entries: [
          ...pf2ePack.entries,
          { slug: 'pf2e-plane', name: 'Astral Plane', type: 'section', summary: 'Planar rules.' },
          { slug: 'pf2e-deity', name: 'Cayden Cailean', type: 'other', summary: 'Deity reference.' },
        ],
      });
      expect(await facetsFor('pf2e-srd')).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'monster', label: 'Creatures', count: 1 }),
        expect.objectContaining({ type: 'section', label: 'Rules', count: 1 }),
        expect.objectContaining({ type: 'other', label: 'Reference', count: 1 }),
      ]));

      await uploadAndPoll({
        source: 'upload',
        pack: { slug: 'open-legend-srd', name: 'Open Legend SRD', license: 'CC-BY-4.0' },
        entries: [
          { slug: 'baned', name: 'Bane', type: 'condition', summary: 'A negative condition.' },
          { slug: 'mighty-blow', name: 'Mighty Blow', type: 'feat', summary: 'A feat.' },
        ],
      });
      expect(await facetsFor('open-legend-srd')).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'condition', label: 'Banes & Boons', count: 1 }),
      ]));

      await uploadAndPoll({
        source: 'upload',
        pack: { slug: 'old-school-essentials', name: 'Old-School Essentials', license: 'OGL 1.0a' },
        entries: [
          { slug: 'torch', name: 'Torch', type: 'item', summary: 'Equipment.' },
          { slug: 'skeleton', name: 'Skeleton', type: 'monster', summary: 'Undead monster.' },
        ],
      });
      expect(await facetsFor('old-school-essentials')).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'item', label: 'Equipment', count: 1 }),
      ]));

      await uploadAndPoll({
        source: 'upload',
        pack: { slug: 'prose-rules', name: 'Prose Rules', license: 'CC-BY-4.0' },
        entries: [
          { slug: 'downtime', name: 'Downtime', type: 'section', summary: 'Rules chapter.' },
          { slug: 'bibliography', name: 'Bibliography', type: 'other', summary: 'Reference note.' },
        ],
      });
      const proseSection = await facetsFor('prose-rules', { type: 'section' });
      expect(proseSection).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'section', label: 'Rules', count: 1 }),
        expect.objectContaining({ type: 'other', label: 'Reference', count: 1 }),
      ]));
      expect((await facetsFor('prose-rules')).some((f: { type: string }) => f.type === 'monster')).toBe(false);

      // A text query narrows the COUNTS but not the chip SET: `other` is still offered
      // (at 0) so the reader can pivot without clearing the search, and the order stays
      // canonical. Counts sum to the unfiltered `total` the same list reports.
      expect(await facetsFor('prose-rules', { q: 'Downtime' })).toEqual([
        expect.objectContaining({ type: 'section', label: 'Rules', count: 1 }),
        expect.objectContaining({ type: 'other', label: 'Reference', count: 0 }),
      ]);
      const proseQueryRes = await request(server)
        .get('/api/v1/rules/search')
        .query({ pack: 'prose-rules', q: 'Downtime' })
        .set(uploader);
      expect(proseQueryRes.status).toBe(200);
      expect(proseQueryRes.body.total).toBe(1);
      expect(
        searchFacets(proseQueryRes.body).reduce((sum: number, f: { count: number }) => sum + f.count, 0),
      ).toBe(proseQueryRes.body.total);

      const otherRes = await request(server).get('/api/v1/rules/search').query({ pack: 'prose-rules', type: 'other' }).set(uploader);
      expect(otherRes.status).toBe(200);
      expect(searchItems(otherRes.body)).toEqual([expect.objectContaining({ type: 'other', name: 'Bibliography' })]);
    } finally {
      for (const job of jobs.reverse()) {
        if (job.pack?.id) await request(server).delete(`/api/v1/rules/packs/${job.pack.id}`).set(uploader);
      }
    }
  });

  it('rejects a non-open (proprietary) license synchronously with 400 — no job created', async () => {
    const res = await uploadPack({
      ...pf2ePack,
      pack: { ...pf2ePack.pack, slug: 'proprietary-pack', license: 'All Rights Reserved' },
    });
    expect(res.status).toBe(400);
    expect(String(res.body.message)).toMatch(/open license/i);

    // Nothing was installed.
    const listRes = await request(ctx.app.getHttpServer()).get('/api/v1/rules/packs').set(uploader);
    expect(listRes.body.some((p: { slug: string }) => p.slug === 'proprietary-pack')).toBe(false);
  });

  it('multiple packs coexist: an uploaded pack lives alongside the Open5e SRD pack', async () => {
    const server = ctx.app.getHttpServer();

    const open5eJob = await installOpen5e(server, uploader, { source: 'open5e', url: fake.baseUrl, sections: ['conditions'] });
    expect(open5eJob.status).toBe('completed');

    const uploadRes = await uploadPack(pf2ePack);
    const uploadJob = await pollJob(server, uploader, uploadRes.body.id);
    expect(uploadJob.status).toBe('completed');

    const listRes = await request(server).get('/api/v1/rules/packs').set(uploader);
    const slugs = listRes.body.map((p: { slug: string }) => p.slug);
    expect(slugs).toContain('open5e-srd');
    expect(slugs).toContain('pf2e-srd');

    // a global search (no pack filter) sees entries from both packs
    const proneRes = await request(server).get('/api/v1/rules/search').query({ q: 'prone' }).set(uploader);
    expect(searchItems(proneRes.body).some((e: { name: string }) => e.name === 'Prone')).toBe(true); // from open5e
    const fighterRes = await request(server).get('/api/v1/rules/search').query({ q: 'fighter' }).set(uploader);
    expect(searchItems(fighterRes.body).some((e: { name: string }) => e.name === 'Fighter')).toBe(true); // from upload

    await request(server).delete(`/api/v1/rules/packs/${open5eJob.pack.id}`).set(uploader);
    await request(server).delete(`/api/v1/rules/packs/${uploadJob.pack.id}`).set(uploader);
  });

  it('re-uploading the same slug is an incremental add (dedupe by slug+type)', async () => {
    const server = ctx.app.getHttpServer();

    const firstRes = await uploadPack(pf2ePack);
    const firstJob = await pollJob(server, uploader, firstRes.body.id);
    expect(firstJob.outcome).toBe('created');
    expect(firstJob.pack.entryCount).toBe(3);

    // Second upload is deliberately NOT a superset: it keeps 2 of the 3 existing entries,
    // adds one new one, and OMITS pf2e-fighter. An upload is additive — it carries no
    // authority to delete, because an omission almost always means the operator uploaded a
    // partial file, not that they intend a deletion (issue #500 is scoped to upstream
    // source updates, where the fetched manifest IS authoritative). Asserting the omitted
    // entry survives is what actually pins this test's name; a superset second upload would
    // pass whether uploads were additive or full-replace.
    const secondRes = await uploadPack({
      ...pf2ePack,
      entries: [
        pf2ePack.entries[0], // pf2e-fireball
        pf2ePack.entries[1], // pf2e-goblin
        { slug: 'pf2e-shield', name: 'Shield', type: 'item', summary: 'A sturdy shield.' },
      ],
    });
    const secondJob = await pollJob(server, uploader, secondRes.body.id);
    expect(secondJob.outcome).toBe('updated');
    expect(secondJob.added).toBe(1);
    expect(secondJob.removed).toBe(0);
    expect(secondJob.preview.removed).toBe(0);
    expect(secondJob.skippedExisting).toBe(2);
    expect(secondJob.pack.entryCount).toBe(4); // 3 original + shield — fighter was NOT dropped

    const fighterRes = await request(server).get('/api/v1/rules/search').query({ q: 'fighter', pack: 'pf2e-srd' }).set(uploader);
    expect(searchItems(fighterRes.body).some((e: { slug: string }) => e.slug === 'pf2e-fighter')).toBe(true);

    await request(server).delete(`/api/v1/rules/packs/${secondJob.pack.id}`).set(uploader);
  });

  it('re-uploading applies upstream corrections in place, preserving overrides and auditing the re-license', async () => {
    const server = ctx.app.getHttpServer();
    const db = ctx.app.get<DrizzleDb>(DB);
    const slug = 'pf2e-sync-srd';
    const initialPack = { ...pf2ePack, pack: { ...pf2ePack.pack, slug } };

    const firstRes = await uploadPack(initialPack);
    const firstJob = await pollJob(server, uploader, firstRes.body.id);
    expect(firstJob.outcome).toBe('created');
    expect(firstJob.pack.entryCount).toBe(3);

    const fireballRes = await request(server).get('/api/v1/rules/search').query({ q: 'fireball', pack: slug }).set(uploader);
    const fireball = searchItems(fireballRes.body).find((e: { slug: string }) => e.slug === 'pf2e-fireball');
    expect(fireball).toBeTruthy();
    const iconRes = await request(server)
      .patch(`/api/v1/rules/entries/${fireball.id}`)
      .set(uploader)
      .send({ iconSlug: 'fire-ray' });
    expect(iconRes.status).toBe(200);

    const now = new Date().toISOString();
    const [campaign] = db.insert(campaigns)
      .values({
        name: 'Rule Sync Campaign',
        description: '',
        status: 'active',
        dangerLevel: 'low',
        sessionCount: 0,
        latestSessionNumber: 0,
        ruleSystem: slug,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .all();

    const secondRes = await uploadPack({
      ...initialPack,
      // Upstream re-licensed this release. The new license must land on the pack AND be
      // recoverable from the audit trail (issue #500: audit provenance/license changes).
      pack: { ...initialPack.pack, version: '2024.2', license: 'CC-BY-4.0' },
      entries: [
        {
          slug: 'pf2e-fireball',
          name: 'Fireball',
          type: 'spell',
          summary: 'A corrected roaring blast of flame.',
          body: 'Corrected fire erupts from a point you choose.',
        },
        { slug: 'pf2e-goblin', name: 'Goblin Warrior', type: 'monster', summary: 'CR -1', dataJson: JSON.stringify({ hp: 6 }) },
        { slug: 'pf2e-shield', name: 'Shield', type: 'item', summary: 'A sturdy shield.' },
      ],
    });
    const secondJob = await pollJob(server, uploader, secondRes.body.id);
    expect(secondJob.outcome).toBe('updated');
    expect(secondJob.added).toBe(1);
    // Fireball changed its text; Goblin's text is identical but the pack re-license changes
    // its INHERITED license, which is part of the entry's provenance and so a real change.
    // pf2e-fighter is omitted from this upload and must survive — uploads are additive.
    expect(secondJob.changed).toBe(2);
    expect(secondJob.removed).toBe(0);
    expect(secondJob.skippedExisting).toBe(2);
    expect(secondJob.preview).toMatchObject({ added: 1, changed: 2, removed: 0, unchanged: 0, sourceVersion: '2024.2' });
    expect(secondJob.preview.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(secondJob.pack.entryCount).toBe(4);
    expect(secondJob.pack.version).toBe('2024.2');

    const refreshedRes = await request(server).get('/api/v1/rules/search').query({ q: 'corrected roaring', pack: slug }).set(uploader);
    const refreshed = searchItems(refreshedRes.body).find((e: { slug: string }) => e.slug === 'pf2e-fireball');
    expect(refreshed.id).toBe(fireball.id);
    expect(refreshed.iconSlug).toBe('fire-ray');
    expect(refreshed.summary).toBe('A corrected roaring blast of flame.');

    const keptRes = await request(server).get('/api/v1/rules/search').query({ q: 'fighter', pack: slug }).set(uploader);
    expect(searchItems(keptRes.body).some((e: { slug: string }) => e.slug === 'pf2e-fighter')).toBe(true);
    const addedRes = await request(server).get('/api/v1/rules/search').query({ q: 'shield', pack: slug }).set(uploader);
    expect(searchItems(addedRes.body).some((e: { slug: string }) => e.slug === 'pf2e-shield')).toBe(true);

    // The re-license reaches the entries that inherit it, not just the pack row.
    const goblinRes = await request(server).get('/api/v1/rules/search').query({ q: 'goblin', pack: slug }).set(uploader);
    const goblin = searchItems(goblinRes.body).find((e: { slug: string }) => e.slug === 'pf2e-goblin');
    expect(goblin.license).toBe('CC-BY-4.0');

    const [campaignAfterSync] = db.select().from(campaigns).where(eq(campaigns.id, campaign.id)).all();
    expect(campaignAfterSync.ruleSystem).toBe(slug);

    const auditRows = db.select().from(auditLog).where(eq(auditLog.entityId, secondJob.pack.id)).all();
    const updateAudit = auditRows.find((row) => row.detail.includes('+1 ~2 -0') && row.detail.includes('manifest='));
    expect(updateAudit?.detail).toContain('source=https://example.com/pf2e');
    expect(updateAudit?.detail).toContain('version=2024.2');
    // The re-license is recorded as an explicit before->after, not just left on the pack row.
    expect(updateAudit?.detail).toContain('license:"ORC License"->"CC-BY-4.0"');
    expect(updateAudit?.detail).toContain('version:"2024.1"->"2024.2"');
    expect(secondJob.pack.license).toBe('CC-BY-4.0');

    await request(server).delete(`/api/v1/rules/packs/${secondJob.pack.id}`).set(uploader);
  });
});

/**
 * Issue #143: a fresh Open5e install must NOT produce triplicate same-name rows (one per
 * document). Each (name,type) is de-duped to a single canonical entry — preferring the SRD
 * 5.1 baseline — carrying the real per-document source label + license, so A5e/3rd-party
 * content is never mislabeled as SRD.
 */
describe('rules / rule packs — Open5e import de-dupes same-name entries + labels source (issue #143)', () => {
  let ctx: TestAppContext;
  let fake: FakeOpen5e;
  const dedupeDm = { 'x-dev-role': 'dm', 'x-dev-user': 'dedupe-dm' };

  beforeAll(async () => {
    ctx = await createTestApp();
    fake = await startFakeOpen5eMultiDoc();
  });

  afterAll(async () => {
    await fake.close();
    await closeTestApp(ctx);
  });

  it('collapses 3 Fireballs / 3 Goblins to one canonical (srd) entry each, with correct source + license', async () => {
    const server = ctx.app.getHttpServer();

    const job = await installOpen5e(server, dedupeDm, { source: 'open5e', url: fake.baseUrl, sections: ['spells', 'monsters'] });
    expect(job.status).toBe('completed');
    // 3 spells + 3 creatures came off the wire, but each name collapses to one row.
    expect(job.pack.entryCount).toBe(2);
    // The pack license reflects only the kept (canonical SRD 5.1) documents — the A5e
    // third-party license must NOT leak into the pack label (the mislabel in issue #143).
    expect(job.pack.license).toContain('Open Game License');
    expect(job.pack.license).not.toContain('A5E');

    // Fireball: exactly one row, sourced from SRD 5.1 (the canonical pick), not A5e/SRD 5.2.
    const fireballRes = await request(server).get('/api/v1/rules/search').query({ q: 'fireball', type: 'spell' }).set(dedupeDm);
    const fireballs = searchItems(fireballRes.body).filter((e: { name: string }) => e.name === 'Fireball');
    expect(fireballs).toHaveLength(1);
    expect(fireballs[0].source).toBe('System Reference Document 5.1');
    expect(fireballs[0].body).toContain('SRD 5.1');

    // Goblin: same — one row, canonical source, distinguishable in the picker.
    const goblinRes = await request(server).get('/api/v1/rules/search').query({ q: 'goblin', type: 'monster' }).set(dedupeDm);
    const goblins = searchItems(goblinRes.body).filter((e: { name: string }) => e.name === 'Goblin');
    expect(goblins).toHaveLength(1);
    expect(goblins[0].source).toBe('System Reference Document 5.1');

    await request(server).delete(`/api/v1/rules/packs/${job.pack.id}`).set(dedupeDm);
  });
});

/**
 * Issue #147: uninstalling a pack must clear `ruleSystem` on any campaign that selected it,
 * so GET /campaigns/:id no longer reports the dangling slug (which would silently re-link on
 * reinstall) — matching what the uninstall dialog promises ("fall back to none/homebrew").
 */
describe('rules / rule packs — uninstall clears campaigns\' ruleSystem (issue #147)', () => {
  let ctx: TestAppContext;
  let fake: FakeOpen5e;
  const uninstallDm = { 'x-dev-role': 'dm', 'x-dev-user': 'ruleSystem-cleanup-dm' };

  beforeAll(async () => {
    ctx = await createTestApp();
    fake = await startFakeOpen5e();
  });

  afterAll(async () => {
    await fake.close();
    await closeTestApp(ctx);
  });

  it('nulls out ruleSystem on the campaign that pointed at the removed pack', async () => {
    const server = ctx.app.getHttpServer();

    // Install the pack, then point a campaign at it (validateRuleSystem requires the pack exist).
    const job = await installOpen5e(server, uninstallDm, { source: 'open5e', url: fake.baseUrl, sections: ['conditions'] });
    expect(job.status).toBe('completed');
    expect(job.pack.slug).toBe('open5e-srd');
    const packId = job.pack.id;

    const campRes = await request(server).post('/api/v1/campaigns').set(uninstallDm).send({ name: 'Rule System Campaign' });
    const campaignId = campRes.body.id;

    const patchRes = await request(server)
      .patch(`/api/v1/campaigns/${campaignId}`)
      .set(uninstallDm)
      .send({ ruleSystem: 'open5e-srd' });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.ruleSystem).toBe('open5e-srd');

    // Sanity: the slug is set before uninstall.
    const beforeGet = await request(server).get(`/api/v1/campaigns/${campaignId}`).set(uninstallDm);
    expect(beforeGet.body.ruleSystem).toBe('open5e-srd');

    // Uninstall is blocked rather than silently changing live campaign mechanics.
    const uninstallRes = await request(server).delete(`/api/v1/rules/packs/${packId}`).set(uninstallDm);
    expect(uninstallRes.status).toBe(409);
    expect(String(uninstallRes.body.message)).toMatch(/selected by 1 campaign/i);

    const afterGet = await request(server).get(`/api/v1/campaigns/${campaignId}`).set(uninstallDm);
    expect(afterGet.status).toBe(200);
    expect(afterGet.body.ruleSystem).toBe('open5e-srd');
    await request(server).delete(`/api/v1/campaigns/${campaignId}`).set(uninstallDm);
    await request(server).delete(`/api/v1/rules/packs/${packId}`).set(uninstallDm);
  });
});

/**
 * Issue #385: the uninstall-safety acknowledgement must gate on an AUTHORITATIVE, server-wide
 * usage count, not a client-side count of only the caller's visible campaigns. GET /campaigns
 * returns only campaigns the caller is a member of, and uninstall is server-admin-only — an
 * admin who belongs to few/no campaigns would otherwise see usageCount===0 and skip the gate,
 * even though uninstall resets ruleSystem on EVERY campaign using the pack. GET /rules/packs
 * therefore reports each pack's usageCount from a `count(*)` over ALL campaigns.
 */
describe('rules / rule packs — authoritative server-wide usage count (issue #385)', () => {
  let ctx: TestAppContext;
  let fake: FakeOpen5e;
  const dmA = { 'x-dev-role': 'dm', 'x-dev-user': 'usage-count-dm-a' };
  const dmB = { 'x-dev-role': 'dm', 'x-dev-user': 'usage-count-dm-b' };

  beforeAll(async () => {
    ctx = await createTestApp();
    fake = await startFakeOpen5e();
  });

  afterAll(async () => {
    await fake.close();
    await closeTestApp(ctx);
  });

  it('GET /rules/packs reports usageCount from a server-wide count over ALL campaigns', async () => {
    const server = ctx.app.getHttpServer();

    const job = await installOpen5e(server, dmA, { source: 'open5e', url: fake.baseUrl, sections: ['conditions'] });
    expect(job.pack.slug).toBe('open5e-srd');
    const packId = job.pack.id;

    // Freshly installed: no campaign references it yet.
    const initial = await request(server).get('/api/v1/rules/packs').set(dmA);
    expect(initial.body.find((p: { id: number }) => p.id === packId).usageCount).toBe(0);

    // Two DIFFERENT users each point a campaign at the pack. The authoritative count is a
    // `count(*)` over EVERY campaign row (not a client-side sum of the caller's visible ones),
    // so it must see both — the property the old client-side count failed for a server admin
    // who belongs to few/no campaigns (issue #385).
    const campA = await request(server).post('/api/v1/campaigns').set(dmA).send({ name: 'Usage A' });
    await request(server).patch(`/api/v1/campaigns/${campA.body.id}`).set(dmA).send({ ruleSystem: 'open5e-srd' });
    const campB = await request(server).post('/api/v1/campaigns').set(dmB).send({ name: 'Usage B' });
    await request(server).patch(`/api/v1/campaigns/${campB.body.id}`).set(dmB).send({ ruleSystem: 'open5e-srd' });

    // Reported identically to every caller — the count doesn't depend on who asks.
    for (const who of [dmA, dmB]) {
      const packs = await request(server).get('/api/v1/rules/packs').set(who);
      expect(packs.status).toBe(200);
      expect(packs.body.find((p: { id: number }) => p.id === packId).usageCount).toBe(2);
    }

    // Clearing one campaign's ruleSystem drops the authoritative count to 1.
    await request(server).patch(`/api/v1/campaigns/${campB.body.id}`).set(dmB).send({ ruleSystem: '' });
    const after = await request(server).get('/api/v1/rules/packs').set(dmA);
    expect(after.body.find((p: { id: number }) => p.id === packId).usageCount).toBe(1);

    // Clear the remaining live reference before cleanup; live usage is intentionally a
    // server-enforced uninstall conflict rather than an implicit campaign reset.
    await request(server).patch(`/api/v1/campaigns/${campA.body.id}`).set(dmA).send({ ruleSystem: '' });
    expect((await request(server).delete(`/api/v1/rules/packs/${packId}`).set(dmA)).status).toBe(200);
  });

  it('ignores trashed campaigns for usage and uninstall, while live campaigns still block it', async () => {
    const server = ctx.app.getHttpServer();

    let job = await installOpen5e(server, dmA, { source: 'open5e', url: fake.baseUrl, sections: ['conditions'] });
    const trashedPackId = job.pack.id;
    const trashedCampaign = await request(server).post('/api/v1/campaigns').set(dmA).send({ name: 'Trashed pack user' });
    await request(server).patch(`/api/v1/campaigns/${trashedCampaign.body.id}`).set(dmA).send({ ruleSystem: 'open5e-srd' });
    expect((await request(server).delete(`/api/v1/campaigns/${trashedCampaign.body.id}`).set(dmA)).status).toBe(200);

    const afterTrash = await request(server).get('/api/v1/rules/packs').set(dmA);
    expect(afterTrash.body.find((p: { id: number }) => p.id === trashedPackId).usageCount).toBe(0);
    expect((await request(server).delete(`/api/v1/rules/packs/${trashedPackId}`).set(dmA)).status).toBe(200);
    const restored = await request(server).post(`/api/v1/campaigns/${trashedCampaign.body.id}/restore`).set(dmA);
    expect(restored.status).toBe(201);
    expect(restored.body.ruleSystem).toBe('');
    await request(server).delete(`/api/v1/campaigns/${trashedCampaign.body.id}`).set(dmA);

    job = await installOpen5e(server, dmA, { source: 'open5e', url: fake.baseUrl, sections: ['conditions'] });
    const livePackId = job.pack.id;
    const liveCampaign = await request(server).post('/api/v1/campaigns').set(dmA).send({ name: 'Live pack user' });
    await request(server).patch(`/api/v1/campaigns/${liveCampaign.body.id}`).set(dmA).send({ ruleSystem: 'open5e-srd' });

    const withLiveCampaign = await request(server).get('/api/v1/rules/packs').set(dmA);
    expect(withLiveCampaign.body.find((p: { id: number }) => p.id === livePackId).usageCount).toBe(1);
    expect((await request(server).delete(`/api/v1/rules/packs/${livePackId}`).set(dmA)).status).toBe(409);

    await request(server).delete(`/api/v1/campaigns/${liveCampaign.body.id}`).set(dmA);
    expect((await request(server).delete(`/api/v1/rules/packs/${livePackId}`).set(dmA)).status).toBe(200);
  });
});

describe('rules / rule packs — install permission gating (e2e, real sessions)', () => {
  let ctx: TestAppContext;
  let fake: FakeOpen5e;
  let adminAgent: ReturnType<typeof request.agent>;
  let userAgent: ReturnType<typeof request.agent>;
  let dmAgent: ReturnType<typeof request.agent>;

  async function pollWithAgent(agent: ReturnType<typeof request.agent>, jobId: string) {
    const start = Date.now();
    for (;;) {
      const res = await agent.get(`/api/v1/rules/packs/install-jobs/${jobId}`);
      expect(res.status).toBe(200);
      if (res.body.status === 'completed' || res.body.status === 'failed') return res.body;
      if (Date.now() - start > 15_000) throw new Error(`job ${jobId} timed out (last ${res.body.status})`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

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

    // A second plain (non-admin) user who becomes DM of a campaign they create.
    const createDmRes = await adminAgent.post('/api/v1/users').send({ username: 'rules-dm', password: 'dm-password-1' });
    expect(createDmRes.body.serverRole).toBe('user');
    dmAgent = request.agent(ctx.app.getHttpServer());
    await dmAgent.post('/api/v1/auth/login').send({ username: 'rules-dm', password: 'dm-password-1' });
  });

  afterAll(async () => {
    await fake.close();
    await closeTestApp(ctx);
  });

  it('non-admin, non-DM real user gets 403 on install/upload; can still read', async () => {
    const installRes = await userAgent.post('/api/v1/rules/packs/install').send({ source: 'open5e', url: fake.baseUrl });
    expect(installRes.status).toBe(403);

    const uploadRes = await userAgent.post('/api/v1/rules/packs/upload').send({
      source: 'upload',
      pack: { slug: 'x', name: 'X', license: 'CC-BY-4.0' },
      entries: [{ slug: 'a', name: 'A', type: 'other' }],
    });
    expect(uploadRes.status).toBe(403);

    const listRes = await userAgent.get('/api/v1/rules/packs');
    expect(listRes.status).toBe(200);

    const searchRes = await userAgent.get('/api/v1/rules/search').query({ q: 'anything' });
    expect(searchRes.status).toBe(200);

    const uninstallRes = await userAgent.delete('/api/v1/rules/packs/1');
    expect(uninstallRes.status).toBe(403);

    // The icon override (issue #305) is gated the same as install — a plain player
    // can read entries but not edit them.
    const iconRes = await userAgent.patch('/api/v1/rules/entries/1').send({ iconSlug: 'fire' });
    expect(iconRes.status).toBe(403);
  });

  it('admin real user can install (202 + job completes)', async () => {
    const installRes = await adminAgent.post('/api/v1/rules/packs/install').send({ source: 'open5e', url: fake.baseUrl });
    expect(installRes.status).toBe(202);
    const job = await pollWithAgent(adminAgent, installRes.body.id);
    expect(job.status).toBe('completed');
    await adminAgent.delete(`/api/v1/rules/packs/${job.pack.id}`);
  });

  it('a DM of a campaign (not a server admin) is FORBIDDEN from every server-scoped rule-pack mutation (issue #736)', async () => {
    // Rule packs are server-wide: installing/uploading/uninstalling/editing one affects
    // EVERY campaign on the server, not just the caller's. Issue #736 closed the hole
    // where a DM of any campaign could mutate these global packs (the old #20 policy).
    // The DM user creates a campaign — the creator is auto-inserted as its DM, so they
    // really do hold a campaign-DM role — but that must NOT grant server-wide pack powers.
    const campRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'DM Install Campaign' });
    expect(campRes.status).toBe(201);

    const installRes = await dmAgent
      .post('/api/v1/rules/packs/install')
      .send({ source: 'open5e', url: fake.baseUrl, sections: ['conditions'] });
    expect(installRes.status).toBe(403);

    const uploadRes = await dmAgent.post('/api/v1/rules/packs/upload').send({
      source: 'upload',
      pack: { slug: 'dm-upload', name: 'DM Upload', license: 'CC-BY-4.0' },
      entries: [{ slug: 'a', name: 'A', type: 'other' }],
    });
    expect(uploadRes.status).toBe(403);

    // Uninstall was already server-admin-only; it stays that way.
    const uninstallRes = await dmAgent.delete('/api/v1/rules/packs/1');
    expect(uninstallRes.status).toBe(403);

    // The entry icon override is gated identically (editing an entry affects every
    // campaign using the pack).
    const entryRes = await dmAgent.patch('/api/v1/rules/entries/1').send({ iconSlug: 'fire' });
    expect(entryRes.status).toBe(403);

    // ...but campaign-DM reads remain open, same as any authenticated user.
    const listRes = await dmAgent.get('/api/v1/rules/packs');
    expect(listRes.status).toBe(200);
    const searchRes = await dmAgent.get('/api/v1/rules/search').query({ q: 'anything' });
    expect(searchRes.status).toBe(200);
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
  const hardeningDm = { 'x-dev-role': 'dm', 'x-dev-user': 'importer-hardening-dm' };

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

    const job = await installOpen5e(server, hardeningDm, { source: 'open5e', url: fake.baseUrl, sections: ['spells'] });
    expect(job.status).toBe('completed');
    // Only the one well-formed row (Fireball) made it in — the null row was skipped,
    // and pagination stopped at the cross-origin `next` link instead of following it.
    expect(job.pack.entryCount).toBe(1);

    // The "evil" second-origin server was never actually reached.
    expect(fake.evilWasHit()).toBe(false);

    const searchRes = await request(server).get('/api/v1/rules/search').query({ q: 'fireball' }).set(hardeningDm);
    expect(searchItems(searchRes.body).some((e: { name: string }) => e.name === 'Fireball')).toBe(true);
    expect(searchItems(searchRes.body).some((e: { name: string }) => e.name === 'Should Never Be Imported')).toBe(false);

    // Skip accounting was logged (both the per-section summary and the malformed row).
    const warnCalls = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warnCalls.some((m) => m.includes('cross-origin pagination'))).toBe(true);
    expect(warnCalls.some((m) => m.includes('skipped'))).toBe(true);

    await request(server).delete(`/api/v1/rules/packs/${job.pack.id}`).set(hardeningDm);
  });

  // Issue #500 guard: an update deletes installed entries that are absent from the fetched
  // manifest, so it must first be sure the fetch IS the complete upstream set. This fake
  // reproduces the two ways a section comes back short without erroring — a skipped
  // malformed row and a refused cross-origin `next` link. Treating that truncation as
  // "upstream deleted these" would destroy installed content and null out the combatants
  // pointing at it, which is the pack corruption #500 exists to prevent.
  it('an incomplete fetch (skipped rows / refused pagination) never removes installed entries (issue #500)', async () => {
    const server = ctx.app.getHttpServer();
    const db = ctx.app.get<DrizzleDb>(DB);

    const first = await installOpen5e(server, hardeningDm, { source: 'open5e', url: fake.baseUrl });
    expect(first.status).toBe('completed');
    expect(first.pack.entryCount).toBe(1); // only the one well-formed spell survives the fake

    // Stand in for an entry a previous, complete import landed — one this truncated fetch
    // cannot see. It must survive the update rather than be reported as removed upstream.
    const now = new Date().toISOString();
    const [survivor] = db.insert(ruleEntries)
      .values({
        packId: first.pack.id,
        slug: 'srd-lightning-bolt',
        name: 'Lightning Bolt',
        type: 'spell',
        summary: 'From an earlier complete import.',
        body: 'A stroke of lightning.',
        dataJson: '{}',
        source: 'SRD',
        license: 'CC-BY-4.0',
        attribution: '',
        author: '',
        sourceUrl: '',
        iconSlug: '',
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .all();

    const second = await installOpen5e(server, hardeningDm, { source: 'open5e', url: fake.baseUrl });
    expect(second.status).toBe('completed');
    expect(second.outcome).toBe('updated');
    expect(second.removed).toBe(0);
    expect(second.preview.removed).toBe(0);

    const stillThere = db.select().from(ruleEntries).where(eq(ruleEntries.id, survivor.id)).all();
    expect(stillThere).toHaveLength(1);
    expect(stillThere[0].name).toBe('Lightning Bolt');

    await request(server).delete(`/api/v1/rules/packs/${second.pack.id}`).set(hardeningDm);
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
  const retryDm = { 'x-dev-role': 'dm', 'x-dev-user': 'retry-dm' };

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

    const job = await installOpen5e(server, retryDm, { source: 'open5e', url: fake.baseUrl, sections: ['spells'] });
    expect(job.status).toBe('completed');
    // Both spells made it in despite the first two requests failing.
    expect(job.pack.entryCount).toBe(2);
    expect(fake.spellsRequestCount()).toBe(3);

    const searchRes = await request(server).get('/api/v1/rules/search').query({ q: 'fireball' }).set(retryDm);
    expect(searchItems(searchRes.body).some((e: { name: string }) => e.name === 'Fireball')).toBe(true);

    await request(server).delete(`/api/v1/rules/packs/${job.pack.id}`).set(retryDm);
  }, 20_000); // backoff sleeps (1s + 3s) push this past jest's default 5s timeout
});

/**
 * Round-2 finding #2: installing a pack that already exists must incrementally add
 * whatever requested-section entries aren't present yet (dedupe by slug+type), updating
 * entryCount/version, and return outcome 'updated' with {added, skippedExisting} — never
 * a hard 409.
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

  it('install conditions -> install spells (adds) -> reinstall conditions (added:0)', async () => {
    const server = ctx.app.getHttpServer();

    const conditionsJob = await installOpen5e(server, dmHeaders, { source: 'open5e', url: fake.baseUrl, sections: ['conditions'] });
    expect(conditionsJob.outcome).toBe('created');
    expect(conditionsJob.pack.entryCount).toBe(4);
    const packId = conditionsJob.pack.id;

    // Installing spells on top: the pack already exists, so this is incremental —
    // outcome 'updated', and `added` reflects the two new spell entries.
    const spellsJob = await installOpen5e(server, dmHeaders, { source: 'open5e', url: fake.baseUrl, sections: ['spells'] });
    expect(spellsJob.outcome).toBe('updated');
    expect(spellsJob.added).toBe(2);
    expect(spellsJob.skippedExisting).toBe(0);
    expect(spellsJob.pack.entryCount).toBe(4 + 2); // conditions + spells
    expect(spellsJob.pack.id).toBe(packId); // same pack, not a new row

    // Search now finds both the earlier conditions and the newly-added spells.
    const searchConditions = await request(server).get('/api/v1/rules/search').query({ q: 'prone' }).set(dmHeaders);
    expect(searchItems(searchConditions.body).some((e: { name: string }) => e.name === 'Prone')).toBe(true);
    const searchSpells = await request(server).get('/api/v1/rules/search').query({ q: 'fireball' }).set(dmHeaders);
    expect(searchItems(searchSpells.body).some((e: { name: string }) => e.name === 'Fireball')).toBe(true);

    // Reinstalling conditions again: everything requested is already present -> outcome
    // 'updated', added:0, skippedExisting matches the conditions count.
    const reinstallConditions = await installOpen5e(server, dmHeaders, { source: 'open5e', url: fake.baseUrl, sections: ['conditions'] });
    expect(reinstallConditions.outcome).toBe('updated');
    expect(reinstallConditions.added).toBe(0);
    expect(reinstallConditions.skippedExisting).toBe(4);
    expect(reinstallConditions.pack.entryCount).toBe(6); // unchanged by the no-op reinstall

    await request(server).delete(`/api/v1/rules/packs/${packId}`).set(dmHeaders);
  });
});

/**
 * Issue #500 follow-up: the update path rewrites the pack row's provenance columns from the
 * incoming manifest, but that manifest only covers the sections fetched by THIS call — and
 * the admin UI's "Add sections to <pack>" flow makes partial adds a first-class action. A
 * partial add must NOT narrow the pack's license/source onto the newly-fetched sections:
 * pack.license is the documented fallback for entries whose own license is blank, the label
 * the AI source line prints, and what compendium export records as a dependency's license,
 * so narrowing it silently mis-licenses every retained entry.
 *
 * A COMPLETE re-import is the opposite case and must still move (and audit) provenance —
 * that's the #500 behaviour this must not regress.
 */
describe('rules / rule packs — a partial section add must not narrow pack provenance (issue #500)', () => {
  let ctx: TestAppContext;
  let origin: FakeOpen5e;
  let mirror: FakeOpen5e;
  const dmHeaders = { 'x-dev-role': 'dm', 'x-dev-user': 'provenance-dm' };

  beforeAll(async () => {
    ctx = await createTestApp();
    // Two upstreams serving the same mixed-license catalogue on different origins, so the
    // second install varies BOTH the license set and the sourceUrl.
    origin = await startFakeOpen5eMixedLicense();
    mirror = await startFakeOpen5eMixedLicense();
  });

  afterAll(async () => {
    await origin.close();
    await mirror.close();
    await closeTestApp(ctx);
  });

  it('adding a differently-licensed section keeps the pack license/source covering the first section', async () => {
    const server = ctx.app.getHttpServer();
    let cleanupPackId: number | undefined;

    try {
      // 1. Install ONLY spells, which this upstream serves under the OGL SRD 5.1 document.
      const spellsJob = await installOpen5e(server, dmHeaders, { source: 'open5e', url: origin.baseUrl, sections: ['spells'] });
      expect(spellsJob.outcome).toBe('created');
      expect(spellsJob.pack.license).toBe('Open Game License v1.0a');
      expect(spellsJob.pack.sourceUrl).toBe(origin.baseUrl);
      const packId = spellsJob.pack.id;
      cleanupPackId = packId;

    // 2. Later, add ONLY monsters — CC-BY content, fetched from a mirror. Before the fix the
    //    pack row was rewritten wholesale from this monsters-only manifest: license became
    //    "Creative Commons Attribution 4.0" and sourceUrl became the mirror, dropping the OGL
    //    terms that still govern the retained spells.
    const monstersJob = await installOpen5e(server, dmHeaders, { source: 'open5e', url: mirror.baseUrl, sections: ['monsters'] });
    expect(monstersJob.outcome).toBe('updated');
    expect(monstersJob.pack.id).toBe(packId);
    expect(monstersJob.added).toBe(2);
    expect(monstersJob.removed).toBe(0);

    // Pack provenance stays one canonical license; each entry retains its own term.
    expect(monstersJob.pack.license).toBe('Open Game License v1.0a');
    // Name + source stay on the pack's established provenance — a partial add is not a
    // re-homing of the pack.
    expect(monstersJob.pack.sourceUrl).toBe(origin.baseUrl);
    expect(monstersJob.pack.name).toBe('Open5e SRD');
    // ...but the counters that describe THIS install still move.
    expect(monstersJob.pack.entryCount).toBe(2 + 2);

    // The retained spells keep their own OGL license, and the pack they inherit from agrees.
    const spellRes = await request(server).get('/api/v1/rules/search').query({ q: 'fireball', type: 'spell' }).set(dmHeaders);
    const fireball = searchItems(spellRes.body).find((e: { name: string }) => e.name === 'Fireball');
    expect(fireball.license).toBe('Open Game License v1.0a');

    // 3. A COMPLETE re-import (every section, nothing skipped or truncated) IS authoritative:
    //    provenance moves to the mirror and the change is audited (issue #500's requirement).
      const fullJob = await installOpen5e(server, dmHeaders, { source: 'open5e', url: mirror.baseUrl });
      expect(fullJob.outcome).toBe('updated');
      expect(fullJob.pack.sourceUrl).toBe(mirror.baseUrl);
      expect(fullJob.pack.license).toBe('Open Game License v1.0a');

    const db = ctx.app.get<DrizzleDb>(DB);
    const auditDetails = db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, packId))
      .all()
      .map((row) => row.detail);
    // The complete re-import audits the re-homing...
    expect(auditDetails.some((d) => d.includes(`sourceUrl:"${origin.baseUrl}"->"${mirror.baseUrl}"`))).toBe(true);
      // ...and the partial add does not claim a pack-provenance change it deliberately did not make.
      const partialAudit = auditDetails.find((d) => d.includes('+2 ~0 -0'));
      expect(partialAudit).toBeDefined();
      expect(partialAudit).not.toContain('license:"');
      expect(partialAudit).not.toContain('sourceUrl:"');
      expect(partialAudit).not.toContain('name:"');
    } finally {
      if (cleanupPackId !== undefined) {
        await request(server).delete(`/api/v1/rules/packs/${cleanupPackId}`).set(dmHeaders);
      }
    }
  });

  /**
   * The update runs in one synchronous better-sqlite3 transaction and is retried once if it
   * loses a UNIQUE race. The losing attempt rolls back, but the WINNER committed — so the retry
   * has to recompute the pack's provenance from freshly committed state. Deriving it from the
   * snapshot taken before the first attempt would union against a stale license and silently
   * overwrite the winner's terms, which is the exact failure this code exists to prevent.
   *
   * better-sqlite3 is synchronous, so a genuine second writer cannot commit midway through our
   * transaction from this thread. The interleaving is staged instead: the first transaction
   * attempt commits a competing license change out-of-band and then throws the UNIQUE error,
   * leaving the database in precisely the state the retry would find in production.
   */
  it('a unique-constraint retry recomputes provenance from freshly committed state, not a stale snapshot', async () => {
    const server = ctx.app.getHttpServer();
    const db = ctx.app.get<DrizzleDb>(DB);

    const first = await installOpen5e(server, dmHeaders, { source: 'open5e', url: origin.baseUrl, sections: ['spells'] });
    const packId = first.pack.id;
    expect(first.pack.license).toBe('Open Game License v1.0a');

    // The injected DB is a get-only Proxy that forwards to the live orm (DbHolder swaps the
    // handle out under a restore), so the stub has to be installed on the orm behind it —
    // assigning through the proxy would write a property the get trap never consults.
    const orm = (ctx.app.get<DbHolder>(DB_HOLDER) as unknown as { orm: DrizzleDb }).orm;
    const original = Object.getOwnPropertyDescriptor(orm, 'transaction');
    const realTransaction = orm.transaction.bind(orm);
    let attempts = 0;
    (orm as unknown as { transaction: unknown }).transaction = (fn: never) => {
      attempts += 1;
      if (attempts === 1) {
        // A competing writer commits a license correction, then our attempt loses the race.
        db.update(rulePacks).set({ license: 'ORC License' }).where(eq(rulePacks.id, packId)).run();
        throw Object.assign(
          new Error('UNIQUE constraint failed: rule_entries.pack_id, rule_entries.type, rule_entries.slug'),
          { code: 'SQLITE_CONSTRAINT_UNIQUE' },
        );
      }
      return realTransaction(fn);
    };

    try {
      const second = await installOpen5e(server, dmHeaders, { source: 'open5e', url: mirror.baseUrl, sections: ['monsters'] });
      expect(attempts).toBe(2); // lost once, retried once
      expect(second.outcome).toBe('updated');
      expect(second.added).toBe(2);
      // A partial update retains the already-established canonical label rather than
      // manufacturing a comma-joined list from the competing manifest.
      expect(second.pack.license).toBe('ORC License');

      // The retry preserves the canonical label from the row it actually found. It must not
      // manufacture a license change from the stale pre-race snapshot.
      const auditDetails = db
        .select()
        .from(auditLog)
        .where(eq(auditLog.entityId, packId))
        .all()
        .map((row) => row.detail);
      expect(auditDetails.some((d) => d.includes('license:"'))).toBe(false);
    } finally {
      if (original) Object.defineProperty(orm, 'transaction', original);
      else delete (orm as unknown as { transaction?: unknown }).transaction;
      await request(server).delete(`/api/v1/rules/packs/${packId}`).set(dmHeaders);
    }
  });
});

/**
 * Round-2 finding #3: concurrent installs racing the same slug must never surface a raw
 * 500 from the UNIQUE constraint on rule_packs.slug — exactly one wins the fresh insert
 * ('created') and the rest resolve cleanly via the incremental path ('updated').
 */
describe('rules / rule packs — concurrent install race (e2e, fake Open5e server)', () => {
  let ctx: TestAppContext;
  let fake: FakeOpen5e;
  const dmHeaders = { 'x-dev-role': 'dm', 'x-dev-user': 'concurrency-dm' };

  beforeAll(async () => {
    ctx = await createTestApp();
    fake = await startFakeOpen5e();
    // Bind the app to a stable ephemeral port. Install now returns in ~1ms, and supertest's
    // open-a-listener-per-request dance resets a socket when requests fire back-to-back
    // against a non-listening server; a persistent listener avoids that flake.
    await new Promise<void>((resolve) => {
      const s = ctx.app.getHttpServer();
      if (s.listening) resolve();
      else s.listen(0, () => resolve());
    });
  });

  afterAll(async () => {
    await fake.close();
    await closeTestApp(ctx);
  });

  it('4 racing installs: one created, the rest updated, never a 500', async () => {
    const server = ctx.app.getHttpServer();

    // Enqueue four installs back-to-back (each 202 with its own job). Because install
    // now runs in the background, the four jobs overlap and race the same slug at the
    // persistence layer — exactly the scenario the UNIQUE(slug) guard must absorb.
    // A single small section (conditions) keeps the background fetch load light while
    // still racing four jobs onto the same 'open5e-srd' slug.
    const jobIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await request(server)
        .post('/api/v1/rules/packs/install')
        .set(dmHeaders)
        .send({ source: 'open5e', url: fake.baseUrl, sections: ['conditions'] });
      expect(res.status).toBe(202);
      jobIds.push(res.body.id);
    }

    const jobs = await Promise.all(jobIds.map((id) => pollJob(server, dmHeaders, id)));
    for (const job of jobs) expect(job.status).toBe('completed');
    expect(jobs.filter((j) => j.outcome === 'created')).toHaveLength(1);
    expect(jobs.filter((j) => j.outcome === 'updated')).toHaveLength(3);

    // All four resolved against the SAME pack id — no duplicate rows.
    const packIds = new Set(jobs.map((j) => j.pack.id));
    expect(packIds.size).toBe(1);

    const listRes = await request(server).get('/api/v1/rules/packs').set(dmHeaders);
    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0].entryCount).toBe(4); // the 4 conditions from the fake server

    await request(server).delete(`/api/v1/rules/packs/${[...packIds][0]}`).set(dmHeaders);
  });
});

/**
 * Pathfinder 2e importer + install path (issue #295). Proves the full flagship wiring:
 * POST /rules/packs/install with `source: 'pf2e'` routes to the PF2e importer, installs
 * under the `pf2e-srd` pack slug (which the PF2e RuleSystemAdapter is registered against),
 * and maps AoN sections onto Campfire's rule-entry types with the ORC/OGL license + source
 * book stamped. Uses the in-process fake AoN Elasticsearch server (test/fake-pf2e.ts).
 */
describe('rules / rule packs — Pathfinder 2e install (e2e, fake AoN server)', () => {
  let ctx: TestAppContext;
  let pf2e: import('./fake-pf2e').FakePf2e;
  let server: Server;

  beforeAll(async () => {
    const { startFakePf2e } = await import('./fake-pf2e');
    ctx = await createTestApp();
    pf2e = await startFakePf2e();
    server = ctx.app.getHttpServer();
  });

  afterAll(async () => {
    await pf2e.close();
    await closeTestApp(ctx);
  });

  async function installPf2e(headers: Record<string, string>) {
    const res = await request(server).post('/api/v1/rules/packs/install').set(headers).send({ source: 'pf2e', url: pf2e.baseUrl });
    expect(res.status).toBe(202);
    expect(res.body.source).toBe('pf2e');
    return pollJob(server, headers, res.body.id);
  }

  it('installs under the pf2e-srd slug and maps sections onto Campfire rule-entry types', async () => {
    const job = await installPf2e(dm);
    expect(job.status).toBe('completed');
    expect(job.pack.slug).toBe('pf2e-srd');
    expect(job.pack.name).toMatch(/Pathfinder 2e/);
    // ORC license carried through onto the pack.
    expect(job.pack.license).toMatch(/ORC/);

    // Creature -> monster, with the PF2e statblock (level as CR, ability MODS) in dataJson.
    const monsterRes = await request(server).get('/api/v1/rules/search').query({ q: 'Goblin', type: 'monster' }).set(dm);
    expect(monsterRes.status).toBe(200);
    const goblin = searchItems(monsterRes.body).find((e: { name: string }) => e.name === 'Goblin Warrior');
    expect(goblin).toBeDefined();
    expect(goblin.source).toBe('Pathfinder Monster Core');
    const data = JSON.parse(goblin.dataJson);
    expect(data.level).toBe(-1);
    expect(data.perception).toBe(2);
    // REST surface: ability MODS round-trip with zero / positive / negative values (issue #767).
    expect(data.abilityMods).toEqual({
      strength: 0,
      dexterity: 3,
      constitution: 1,
      intelligence: 0,
      wisdom: -1,
      charisma: 1,
    });

    // Spell -> spell, equipment -> item, ancestry -> race, class -> class, condition -> condition.
    const typesToProbe: Array<[string, string]> = [
      ['Fireball', 'spell'],
      ['Longsword', 'item'],
      ['Dwarf', 'race'],
      ['Fighter', 'class'],
      ['Frightened', 'condition'],
    ];
    for (const [name, type] of typesToProbe) {
      const r = await request(server).get('/api/v1/rules/search').query({ q: name, type }).set(dm);
      expect(r.status).toBe(200);
      expect(searchItems(r.body).some((e: { name: string }) => e.name === name)).toBe(true);
    }

    await request(server).delete(`/api/v1/rules/packs/${job.pack.id}`).set(dm);
  });
});

/**
 * Issues #326/#353: two PF2e sections (feats + backgrounds) map onto the SAME entry type
 * (`feat`). Importers only de-dupe within a section, so a cross-section name collision
 * (a feat and a background both named "Cleave" -> (feat, cleave) twice) reaches persistPack.
 * Before the fix that tripped the (pack_id, type, slug) UNIQUE index mid-transaction and the
 * fresh install 500'd (misreported as a pack-slug race). persistPack now de-dupes by
 * (type, slug) first, so the install completes with one canonical entry.
 */
describe('rules / rule packs — cross-section (type,slug) collision de-dupes (issues #326/#353)', () => {
  let ctx: TestAppContext;
  let pf2e: import('./fake-pf2e').FakePf2e;
  let server: Server;

  beforeAll(async () => {
    const { startFakePf2eCrossSection } = await import('./fake-pf2e');
    ctx = await createTestApp();
    pf2e = await startFakePf2eCrossSection();
    server = ctx.app.getHttpServer();
  });

  afterAll(async () => {
    await pf2e.close();
    await closeTestApp(ctx);
  });

  it('installs cleanly (no 500) and keeps a single (feat, cleave) entry', async () => {
    const res = await request(server).post('/api/v1/rules/packs/install').set(dm).send({ source: 'pf2e', url: pf2e.baseUrl });
    expect(res.status).toBe(202);
    const job = await pollJob(server, dm, res.body.id);

    // Before the fix this job failed (UNIQUE constraint mid-transaction). It must complete.
    expect(job.status).toBe('completed');
    expect(job.pack.entryCount).toBe(1);
    expect(job.added).toBe(1);

    const db = ctx.app.get<DrizzleDb>(DB);
    expect(db.select().from(ruleEntries).where(eq(ruleEntries.packId, job.pack.id)).all()).toHaveLength(job.added);

    const cleaveRes = await request(server).get('/api/v1/rules/search').query({ q: 'Cleave', type: 'feat' }).set(dm);
    expect(cleaveRes.status).toBe(200);
    const cleaves = searchItems(cleaveRes.body).filter((e: { name: string }) => e.name === 'Cleave');
    expect(cleaves).toHaveLength(1); // the two cross-section rows collapsed to one

    await request(server).delete(`/api/v1/rules/packs/${job.pack.id}`).set(dm);
  });
});

/**
 * Sibling open-ruleset importers wired into the install endpoint (issue #345). Each new
 * `source` — pf1e / starfinder / archmage / open-legend / osr — routes POST /rules/packs/install
 * to its own importer, installs under the pack slug the matching RuleSystemAdapter is
 * registered against, validates sections per-source (a foreign section is rejected 400 before
 * a job is enqueued), and runs entirely against an in-process fake upstream (no live network).
 * The four sources with a dead/placeholder default (pf1e/starfinder/archmage/osr, tracked in
 * #346) additionally require an explicit `url`.
 */
describe('rules / rule packs — sibling importer install wiring (e2e, fake upstreams, issue #345)', () => {
  let ctx: TestAppContext;
  let server: Server;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  /** POST install (expect 202 + echoed source), then poll to a terminal state. */
  async function installSource(body: Record<string, unknown>) {
    const res = await request(server).post('/api/v1/rules/packs/install').set(dm).send(body);
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('pending');
    expect(res.body.source).toBe(body.source);
    return pollJob(server, dm, res.body.id);
  }

  it('source: pf1e -> Pathfinder1e importer -> pathfinder-1e pack; validates sections', async () => {
    const { startFakePathfinder1e } = await import('./fake-pathfinder1e');
    const fake = await startFakePathfinder1e();
    try {
      const job = await installSource({ source: 'pf1e', url: fake.baseUrl });
      expect(job.status).toBe('completed');
      expect(job.pack.slug).toBe('pathfinder-1e');

      const spell = await request(server).get('/api/v1/rules/search').query({ q: 'fireball', type: 'spell' }).set(dm);
      expect(searchItems(spell.body).some((e: { name: string }) => e.name === 'Fireball')).toBe(true);
      const monster = await request(server).get('/api/v1/rules/search').query({ q: 'goblin', type: 'monster' }).set(dm);
      expect(searchItems(monster.body).some((e: { name: string }) => e.name === 'Goblin')).toBe(true);

      // A section foreign to pf1e (Starfinder's 'starships') is rejected 400 synchronously —
      // no job enqueued.
      const bad = await request(server).post('/api/v1/rules/packs/install').set(dm).send({ source: 'pf1e', url: fake.baseUrl, sections: ['starships'] });
      expect(bad.status).toBe(400);
      expect(String(bad.body.message)).toMatch(/starships/);

      await request(server).delete(`/api/v1/rules/packs/${job.pack.id}`).set(dm);
    } finally {
      await fake.close();
    }
  });

  it('source: starfinder -> Starfinder importer -> starfinder-1e pack; validates sections', async () => {
    const { startFakeStarfinder } = await import('./fake-starfinder');
    const fake = await startFakeStarfinder();
    try {
      const job = await installSource({ source: 'starfinder', url: fake.baseUrl });
      expect(job.status).toBe('completed');
      expect(job.pack.slug).toBe('starfinder-1e');

      const spell = await request(server).get('/api/v1/rules/search').query({ q: 'magic missile', type: 'spell' }).set(dm);
      expect(searchItems(spell.body).some((e: { name: string }) => e.name === 'Magic Missile')).toBe(true);
      // Starfinder's own sections (starships) imported alongside the 5e-shaped ones.
      const ship = await request(server).get('/api/v1/rules/search').query({ q: 'pegasus' }).set(dm);
      expect(searchItems(ship.body).some((e: { name: string }) => e.name === 'Pegasus')).toBe(true);

      // 'banes' (Open Legend's) is not a Starfinder section -> 400.
      const bad = await request(server).post('/api/v1/rules/packs/install').set(dm).send({ source: 'starfinder', url: fake.baseUrl, sections: ['banes'] });
      expect(bad.status).toBe(400);

      await request(server).delete(`/api/v1/rules/packs/${job.pack.id}`).set(dm);
    } finally {
      await fake.close();
    }
  });

  it('source: archmage -> 13th Age importer -> archmage-srd pack; validates sections', async () => {
    const { startFakeArchmage } = await import('./fake-archmage');
    const fake = await startFakeArchmage();
    try {
      const job = await installSource({ source: 'archmage', url: fake.baseUrl });
      expect(job.status).toBe('completed');
      expect(job.pack.slug).toBe('archmage-srd');

      const monster = await request(server).get('/api/v1/rules/search').query({ q: 'bear', type: 'monster' }).set(dm);
      expect(searchItems(monster.body).some((e: { name: string }) => e.name === 'Bear')).toBe(true);

      // 13th Age exposes only monsters + conditions; 'spells' is foreign -> 400.
      const bad = await request(server).post('/api/v1/rules/packs/install').set(dm).send({ source: 'archmage', url: fake.baseUrl, sections: ['spells'] });
      expect(bad.status).toBe(400);

      await request(server).delete(`/api/v1/rules/packs/${job.pack.id}`).set(dm);
    } finally {
      await fake.close();
    }
  });

  it('source: open-legend -> Open Legend importer -> open-legend-srd pack; validates sections', async () => {
    const { startFakeOpenLegend } = await import('./fake-open-legend');
    const fake = await startFakeOpenLegend();
    try {
      // No `url`? open-legend has a real wired source (#346), but pointing at the fake keeps
      // this test offline. boons/banes -> condition; feats -> feat.
      const job = await installSource({ source: 'open-legend', url: fake.baseUrl });
      expect(job.status).toBe('completed');
      expect(job.pack.slug).toBe('open-legend-srd');
      expect(job.pack.license).toContain('Open Legend Community License');

      const boon = await request(server).get('/api/v1/rules/search').query({ q: 'haste', type: 'condition' }).set(dm);
      expect(searchItems(boon.body).some((e: { name: string }) => e.name === 'Haste')).toBe(true);
      const bane = await request(server).get('/api/v1/rules/search').query({ q: 'blinded', type: 'condition' }).set(dm);
      expect(searchItems(bane.body).some((e: { name: string }) => e.name === 'Blinded')).toBe(true);
      const feat = await request(server).get('/api/v1/rules/search').query({ q: 'combat momentum', type: 'feat' }).set(dm);
      expect(searchItems(feat.body).some((e: { name: string }) => e.name === 'Combat Momentum')).toBe(true);

      // Issue #380 regression: the admin picker offers exactly these three sections for
      // open-legend (apps/web src/lib/rules.ts RULE_SYSTEMS). The default install above checks
      // ALL sections, so POSTing that exact set must be accepted (202), NOT 400 — the whole bug
      // was the picker offering creatures/items the server rejects, so the one-click install
      // always 400'd before any job enqueued.
      await request(server).delete(`/api/v1/rules/packs/${job.pack.id}`).set(dm);
      const pickerSections = await installSource({ source: 'open-legend', url: fake.baseUrl, sections: ['boons', 'banes', 'feats'] });
      expect(pickerSections.status).toBe('completed');
      expect(pickerSections.pack.slug).toBe('open-legend-srd');

      // The sections the OLD (buggy) picker also offered are correctly rejected 400 — they have
      // no open data. 'monsters' too (a 5e name that was never Open Legend).
      for (const foreign of [['creatures'], ['items'], ['monsters'], ['creatures', 'items']]) {
        const bad = await request(server)
          .post('/api/v1/rules/packs/install')
          .set(dm)
          .send({ source: 'open-legend', url: fake.baseUrl, sections: foreign });
        expect(bad.status).toBe(400);
      }

      await request(server).delete(`/api/v1/rules/packs/${pickerSections.pack.id}`).set(dm);
    } finally {
      await fake.close();
    }
  });

  it('source: osr -> OSR importer; `system` selects the pack slug; validates sections', async () => {
    const { startFakeOsr } = await import('./fake-osr');
    const fake = await startFakeOsr();
    try {
      // A custom mirror must name its system, so it cannot inherit Basic Fantasy provenance.
      const missingSystem = await request(server).post('/api/v1/rules/packs/install').set(dm).send({ source: 'osr', url: fake.baseUrl });
      expect(missingSystem.status).toBe(400);
      const dflt = await installSource({ source: 'osr', url: fake.baseUrl, system: 'basic-fantasy' });
      expect(dflt.status).toBe('completed');
      expect(dflt.pack.slug).toBe('basic-fantasy');
      const monster = await request(server).get('/api/v1/rules/search').query({ q: 'skeleton', type: 'monster' }).set(dm);
      expect(searchItems(monster.body).some((e: { name: string }) => e.name === 'Skeleton')).toBe(true);
      await request(server).delete(`/api/v1/rules/packs/${dflt.pack.id}`).set(dm);

      // The `system` selector installs under the chosen retroclone's slug — the slug the
      // shared OsrAdapter is registered against, so a campaign on it resolves OSR combat.
      const osric = await installSource({ source: 'osr', url: fake.baseUrl, system: 'osric' });
      expect(osric.status).toBe('completed');
      expect(osric.pack.slug).toBe('osric');

      // A campaign can select the installed OSR pack (validateRuleSystem requires it exist).
      const campRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'OSR Campaign' });
      const patchRes = await request(server).patch(`/api/v1/campaigns/${campRes.body.id}`).set(dm).send({ ruleSystem: 'osric' });
      expect(patchRes.status).toBe(200);
      expect(patchRes.body.ruleSystem).toBe('osric');

      // OSR sections are monsters/spells/items/conditions; 'classes' is foreign -> 400.
      const bad = await request(server).post('/api/v1/rules/packs/install').set(dm).send({ source: 'osr', url: fake.baseUrl, sections: ['classes'] });
      expect(bad.status).toBe(400);

      await request(server).delete(`/api/v1/rules/packs/${osric.pack.id}`).set(dm);
    } finally {
      await fake.close();
    }
  });

  it('source: cepheus -> Cepheus importer -> cepheus-srd pack of section entries (installable without a url, but accepts a url override pointed at the fake mdBook server here)', async () => {
    const { startFakeCepheus } = await import('./fake-cepheus');
    const fake = await startFakeCepheus();
    try {
      // Cepheus is installableWithoutUrl by default (its live default base URL is wired); the
      // test passes a `url` override so the whole install runs offline against the fake server.
      const job = await installSource({ source: 'cepheus', url: fake.baseUrl });
      expect(job.status).toBe('completed');
      expect(job.pack.slug).toBe('cepheus-srd');
      expect(job.pack.name).toMatch(/Cepheus Engine SRD/);
      expect(job.pack.license).toMatch(/Open Game License/);
      // Progress is reported per mdBook "book" (the five parts).
      expect(job.progress.length).toBe(5);
      expect(job.pack.entryCount).toBeGreaterThan(25); // ~28 chapters, with the big Equipment one split

      // Chapters land as `section`-typed entries carrying the OGL license + attribution.
      const skills = await request(server).get('/api/v1/rules/search').query({ q: 'Skills', type: 'section' }).set(dm);
      expect(skills.status).toBe(200);
      const skillsEntry = searchItems(skills.body).find((e: { name: string }) => e.name === 'Skills');
      expect(skillsEntry).toBeDefined();
      expect(skillsEntry.type).toBe('section');
      expect(skillsEntry.license).toMatch(/Open Game License/);
      expect(String(skillsEntry.attribution)).toMatch(/Samardan Press/);

      // The oversized Equipment chapter was split at headings — "Equipment: Weapons" is searchable.
      const weapons = await request(server).get('/api/v1/rules/search').query({ q: 'Weapons', type: 'section' }).set(dm);
      expect(searchItems(weapons.body).some((e: { name: string }) => e.name === 'Equipment: Weapons')).toBe(true);

      // A campaign can select the installed Cepheus pack (validateRuleSystem requires it exist).
      const campRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Cepheus Campaign' });
      const patchRes = await request(server).patch(`/api/v1/campaigns/${campRes.body.id}`).set(dm).send({ ruleSystem: 'cepheus-srd' });
      expect(patchRes.status).toBe(200);
      expect(patchRes.body.ruleSystem).toBe('cepheus-srd');

      // Cepheus has no per-statblock section vocabulary; a 5e section is rejected 400.
      const bad = await request(server).post('/api/v1/rules/packs/install').set(dm).send({ source: 'cepheus', url: fake.baseUrl, sections: ['spells'] });
      expect(bad.status).toBe(400);

      await request(server).delete(`/api/v1/rules/packs/${job.pack.id}`).set(dm);
    } finally {
      await fake.close();
    }
  });

  it('sources without a verified live default API require an explicit url (400, no job)', async () => {
    // pf1e/starfinder/archmage/osr have dead/placeholder defaults (#346) — a missing url is
    // a synchronous 400, not a job that fails obscurely against a dead default.
    for (const source of ['pf1e', 'starfinder', 'archmage', 'osr']) {
      const res = await request(server).post('/api/v1/rules/packs/install').set(dm).send({ source });
      expect(res.status).toBe(400);
      expect(String(res.body.message)).toMatch(/url/i);
    }
  });

  it('existing open5e/pf2e request shape is unchanged (no url still routes; open5e default install works)', async () => {
    const { startFakeOpen5e } = await import('./fake-open5e');
    const fake = await startFakeOpen5e();
    try {
      const job = await installSource({ source: 'open5e', url: fake.baseUrl });
      expect(job.status).toBe('completed');
      expect(job.pack.slug).toBe('open5e-srd');
      await request(server).delete(`/api/v1/rules/packs/${job.pack.id}`).set(dm);
    } finally {
      await fake.close();
    }
  });

  it('GET /rules/sources reports honesty metadata (#346): api vs manual-upload, per source', async () => {
    const res = await request(server).get('/api/v1/rules/sources').set(dm);
    expect(res.status).toBe(200);
    const bySource = Object.fromEntries(res.body.map((m: { source: string }) => [m.source, m]));
    // Every install source is described.
    for (const s of ['open5e', 'pf2e', 'sf2e', 'pf1e', 'starfinder', 'archmage', 'open-legend', 'osr', 'cepheus', 'other']) {
      expect(bySource[s]).toBeDefined();
    }
    // Wired live sources install without a url.
    expect(bySource['open-legend']).toMatchObject({ sourceKind: 'api', installableWithoutUrl: true });
    expect(bySource['open5e']).toMatchObject({ sourceKind: 'api', installableWithoutUrl: true });
    expect(bySource['sf2e']).toMatchObject({ sourceKind: 'api', installableWithoutUrl: true });
    // Cepheus is a wired live source too (first-party mdBook Markdown, issue #406).
    expect(bySource['cepheus']).toMatchObject({ sourceKind: 'api', installableWithoutUrl: true });
    // Systems with no open source are honestly flagged manual-upload (and carry a note + license).
    for (const s of ['pf1e', 'starfinder', 'archmage', 'osr']) {
      expect(bySource[s]).toMatchObject({ sourceKind: 'manual-upload', installableWithoutUrl: false });
      expect(typeof bySource[s].note).toBe('string');
      expect(bySource[s].note.length).toBeGreaterThan(0);
      expect(typeof bySource[s].license).toBe('string');
    }
  });
});

/**
 * Issue #500's removal half deletes installed entries absent from a "complete" fetch. That
 * inference is sound because the 13th Age importer classifies drifted statblocks and counts them
 * into skippedCount (issue #1522). A drifted statblock causes skippedCount > 0, which makes
 * manifestIsComplete return false and blocks deletion of missing entries.
 */
describe('rules / rule packs — 13th Age importer drift protection and removal (issue #1522)', () => {
  let ctx: TestAppContext;
  const dmHeaders = { 'x-dev-role': 'dm', 'x-dev-user': 'drift-dm' };

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('a drifted 13th Age statblock increments skippedCount and does not delete the installed monster', async () => {
    const server = ctx.app.getHttpServer();
    const { startFakeArchmageDrifting } = await import('./fake-archmage');
    const fake = await startFakeArchmageDrifting();
    try {
      const sections = ['monsters', 'conditions'];
      const first = await installOpen5e(server, dmHeaders, { source: 'archmage', url: fake.baseUrl, sections });
      expect(first.outcome).toBe('created');
      expect(first.pack.entryCount).toBe(2 + 3); // Bear + Dire Bear, and 3 conditions
      const packId = first.pack.id;

      // Upstream re-themes its statblock tables: Dire Bear's defence labels are spelled out,
      // so parseMonster returns 'error' and increments skippedCount. The monster is still on the page.
      fake.drift();

      const second = await installOpen5e(server, dmHeaders, { source: 'archmage', url: fake.baseUrl, sections });
      expect(second.outcome).toBe('updated');
      // The re-import genuinely did not see Dire Bear...
      expect(second.added).toBe(0);
      // ...and because skippedCount > 0, manifestIsComplete returned false, so it did NOT remove Dire Bear.
      expect(second.removed).toBe(0);
      expect(second.pack.entryCount).toBe(5);

      const search = await request(server).get('/api/v1/rules/search').query({ q: 'dire bear', type: 'monster' }).set(dmHeaders);
      expect(searchItems(search.body).some((e: { name: string }) => e.name === 'Dire Bear')).toBe(true);

      // Bear still parses, so the drift really was partial — this is not a fetch that failed
      // wholesale and got rejected before reaching the sync.
      const bear = await request(server).get('/api/v1/rules/search').query({ q: 'bear', type: 'monster' }).set(dmHeaders);
      expect(searchItems(bear.body).some((e: { name: string }) => e.name === 'Bear')).toBe(true);

      await request(server).delete(`/api/v1/rules/packs/${packId}`).set(dmHeaders);
    } finally {
      await fake.close();
    }
  });
});

describe('rules / rule packs — Starfinder 2e install (e2e, fake AoN server)', () => {
  let ctx: TestAppContext;
  let pf2e: import('./fake-pf2e').FakePf2e;
  let server: Server;

  beforeAll(async () => {
    const { startFakePf2e } = await import('./fake-pf2e');
    ctx = await createTestApp();
    pf2e = await startFakePf2e();
    server = ctx.app.getHttpServer();
  });

  afterAll(async () => {
    await pf2e.close();
    await closeTestApp(ctx);
  });

  it('installs under the sf2e-srd slug and maps sections onto Campfire rule-entry types', async () => {
    const res = await request(server).post('/api/v1/rules/packs/install').set(dm).send({ source: 'sf2e', url: pf2e.baseUrl });
    expect(res.status).toBe(202);
    expect(res.body.source).toBe('sf2e');
    const job = await pollJob(server, dm, res.body.id);
    expect(job.status).toBe('completed');
    expect(job.pack.slug).toBe('sf2e-srd');
    expect(job.pack.name).toMatch(/Starfinder 2e/);
    expect(job.pack.license).toMatch(/ORC/);
  });
});

/**
 * Live smoke test (issue #346 acceptance): proves the Open Legend DEFAULT source actually
 * resolves against the real GitHub-hosted core-rules repo, with NO `url` override. Skipped by
 * default (it needs network); run with RUN_LIVE_RULES_SMOKE=1 to exercise the live source.
 *
 * Intentional `describe.skip` when unset — tracked so this is not a silent pending:
 * - #346: Open Legend live source wiring / acceptance smoke
 * - #568 / #578: keep the opt-in gate documented (do not delete or convert to a bare skip)
 */
const liveSmoke = process.env.RUN_LIVE_RULES_SMOKE === '1' ? describe : describe.skip;
liveSmoke('rules / rule packs — Open Legend live default source smoke (issue #346)', () => {
  let ctx: TestAppContext;
  let server: Server;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer();
  });
  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('installs boons/banes/feats from the real Open Legend repo with no url override', async () => {
    const res = await request(server).post('/api/v1/rules/packs/install').set(dm).send({ source: 'open-legend' });
    expect(res.status).toBe(202);
    const job = await pollJob(server, dm, res.body.id, { timeoutMs: 60_000 });
    expect(job.status).toBe('completed');
    expect(job.pack.slug).toBe('open-legend-srd');
    expect(job.pack.entryCount).toBeGreaterThan(50); // real repo has 30+ boons, 25+ banes, 70+ feats
    expect(job.pack.license).toContain('Open Legend Community License');

    const boon = await request(server).get('/api/v1/rules/search').query({ q: 'haste', type: 'condition' }).set(dm);
    expect(searchItems(boon.body).some((e: { name: string }) => e.name === 'Haste')).toBe(true);

    await request(server).delete(`/api/v1/rules/packs/${job.pack.id}`).set(dm);
  });
});

/**
 * Live smoke test (issue #555 acceptance): Pathfinder 1e has no verified built-in open API,
 * so the default install path must be rejected 400 before any fetch is attempted. When
 * RUN_LIVE_RULES_SMOKE=1, this proves the placeholder default is not silently resolving to a
 * dead `.example` domain or leaving a failing background job.
 */
liveSmoke('rules / rule packs — Pathfinder 1e default source smoke (issue #555)', () => {
  let ctx: TestAppContext;
  let server: Server;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer();
  });
  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('rejects a PF1e install with no url before any live fetch is attempted', async () => {
    const res = await request(server).post('/api/v1/rules/packs/install').set(dm).send({ source: 'pf1e' });
    expect(res.status).toBe(400);
    expect(String(res.body.message)).toMatch(/url/i);
  });
});

/**
 * Issue #734: rule-pack licensing. Upload accepts per-entry license/attribution/author/
 * sourceUrl, but install validated only the pack license, persistence dropped each entry's
 * license, and the reader labelled every entry with the pack license. These tests pin the
 * per-entry contract: a mixed-license pack preserves each entry's OWN license (and its
 * attribution/author/sourceUrl), entries without a per-entry license inherit the pack's,
 * and an incompatible (non-open) entry is rejected with an indexed 400 BEFORE any mutation.
 */
describe('rules / rule packs — per-entry licensing (issue #734)', () => {
  let ctx: TestAppContext;
  const uploader = { 'x-dev-role': 'dm', 'x-dev-user': 'license-dm' };

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await closeTestApp(ctx);
  });

  async function uploadPack(body: Record<string, unknown>) {
    return request(ctx.app.getHttpServer()).post('/api/v1/rules/packs/upload').set(uploader).send(body);
  }

  // A mixed-license pack: open pack license (CC-BY-4.0), but each entry carries its OWN
  // open license — OGL, ORC, CC0 — exactly the "mixed OGL/ORC/CC entries in an otherwise
  // open pack" case the issue calls out. Attribution/author/sourceUrl ride along per entry.
  const mixedPack = {
    source: 'upload' as const,
    pack: {
      slug: 'mixed-licensing-pack',
      name: 'Mixed Licensing Anthology',
      version: '1.0',
      license: 'CC-BY-4.0',
      sourceUrl: 'https://example.com/mixed',
    },
    entries: [
      {
        slug: 'ogl-fireball',
        name: 'OGL Fireball',
        type: 'spell',
        body: 'A ball of fire.',
        license: 'OGL 1.0a',
        attribution: 'OGL Fireball, © Open Author, Open Game Content (OGL 1.0a).',
        author: 'Open Author',
        sourceUrl: 'https://example.com/mixed/ogl-fireball',
      },
      {
        slug: 'orc-goblin',
        name: 'ORC Goblin',
        type: 'monster',
        dataJson: JSON.stringify({ hp: 7 }),
        license: 'ORC',
        attribution: 'ORC Goblin, Open RPG Creative License.',
        author: 'ORC Studio',
      },
      {
        slug: 'cc0-sword',
        name: 'CC0 Sword',
        type: 'item',
        body: 'A public-domain sword.',
        license: 'CC0',
        // attribution/author/sourceUrl intentionally omitted → inherit pack-level fallbacks.
      },
    ],
  };

  it('preserves each entry\u2019s OWN license (mixed OGL/ORC/CC0 in an open pack)', async () => {
    const server = ctx.app.getHttpServer();

    const res = await uploadPack(mixedPack);
    expect(res.status).toBe(202);
    const job = await pollJob(server, uploader, res.body.id);
    expect(job.status).toBe('completed');
    expect(job.outcome).toBe('created');
    expect(job.pack.license).toBe('CC-BY-4.0');

    // Each entry surfaces its OWN license — NOT the pack's CC-BY-4.0 blanket.
    const oglRes = await request(server).get('/api/v1/rules/search').query({ q: 'OGL Fireball', pack: 'mixed-licensing-pack' }).set(uploader);
    const ogl = searchItems(oglRes.body).find((e: { name: string }) => e.name === 'OGL Fireball');
    expect(ogl).toBeTruthy();
    const oglEntry = await request(server).get(`/api/v1/rules/entries/${ogl.id}`).set(uploader);
    expect(oglEntry.status).toBe(200);
    expect(oglEntry.body.license).toBe('OGL 1.0a'); // entry's own license, not the pack's CC-BY-4.0
    expect(oglEntry.body.attribution).toBe('OGL Fireball, © Open Author, Open Game Content (OGL 1.0a).');
    expect(oglEntry.body.author).toBe('Open Author');
    expect(oglEntry.body.sourceUrl).toBe('https://example.com/mixed/ogl-fireball');

    const orcRes = await request(server).get('/api/v1/rules/search').query({ q: 'ORC Goblin', pack: 'mixed-licensing-pack' }).set(uploader);
    const orc = searchItems(orcRes.body).find((e: { name: string }) => e.name === 'ORC Goblin');
    expect(orc).toBeTruthy();
    const orcEntry = await request(server).get(`/api/v1/rules/entries/${orc.id}`).set(uploader);
    expect(orcEntry.body.license).toBe('ORC');
    expect(orcEntry.body.author).toBe('ORC Studio');

    const cc0Res = await request(server).get('/api/v1/rules/search').query({ q: 'CC0 Sword', pack: 'mixed-licensing-pack' }).set(uploader);
    const cc0 = searchItems(cc0Res.body).find((e: { name: string }) => e.name === 'CC0 Sword');
    expect(cc0).toBeTruthy();
    const cc0Entry = await request(server).get(`/api/v1/rules/entries/${cc0.id}`).set(uploader);
    expect(cc0Entry.body.license).toBe('CC0');

    await request(server).delete(`/api/v1/rules/packs/${job.pack.id}`).set(uploader);
  });

  it('entries without a per-entry license inherit the pack license (explicit inherited provenance)', async () => {
    const server = ctx.app.getHttpServer();

    const res = await uploadPack({
      source: 'upload',
      pack: { slug: 'uniform-ogl-pack', name: 'Uniform OGL Pack', license: 'OGL 1.0a', sourceUrl: 'https://example.com/u' },
      entries: [
        { slug: 'uniform-magic-missile', name: 'Uniform Magic Missile', type: 'spell', body: 'A dart of force.' },
      ],
    });
    expect(res.status).toBe(202);
    const job = await pollJob(server, uploader, res.body.id);
    expect(job.status).toBe('completed');

    const searchRes = await request(server).get('/api/v1/rules/search').query({ q: 'Uniform Magic Missile', pack: 'uniform-ogl-pack' }).set(uploader);
    const found = searchItems(searchRes.body).find((e: { name: string }) => e.name === 'Uniform Magic Missile');
    const entry = await request(server).get(`/api/v1/rules/entries/${found.id}`).set(uploader);
    // The entry's effective license is the pack's OGL — stored ON the entry so the reader
    // can trust entry.license without needing the pack row (the pre-#734 reader labelled
    // every entry with the pack license by reading pack.license; now the entry carries it).
    expect(entry.body.license).toBe('OGL 1.0a');
    // attribution falls back to the pack name (a reasonable default credit line).
    expect(entry.body.attribution).toBe('Uniform OGL Pack');
    expect(entry.body.sourceUrl).toBe('https://example.com/u');

    await request(server).delete(`/api/v1/rules/packs/${job.pack.id}`).set(uploader);
  });

  it('rejects a non-open entry in an otherwise-open pack with an indexed 400 — no mutation', async () => {
    const server = ctx.app.getHttpServer();

    // Pack license is open (CC-BY-4.0), but one entry carries "All Rights Reserved" — the
    // exact smuggling vector: a pack-level open check would miss it. The whole upload is
    // rejected with a single indexed error naming the offending entry, and NOTHING is
    // installed (no partial mutation).
    const res = await uploadPack({
      source: 'upload',
      pack: { slug: 'smuggler-pack', name: 'Smuggler Pack', license: 'CC-BY-4.0' },
      entries: [
        { slug: 'open-one', name: 'Open One', type: 'spell', body: 'fine', license: 'CC-BY-4.0' },
        { slug: 'proprietary-boss', name: 'Proprietary Boss', type: 'monster', body: 'not fine', license: 'All Rights Reserved' },
        { slug: 'open-two', name: 'Open Two', type: 'item', body: 'also fine', license: 'CC0' },
      ],
    });
    expect(res.status).toBe(400);
    const message = String(res.body.message);
    expect(message).toMatch(/non-open effective license/i);
    // the offending entry is named (slug + the offending license + its input index) so the
    // uploader can fix and resubmit.
    expect(message).toContain('proprietary-boss');
    expect(message).toContain('All Rights Reserved');
    expect(message).toMatch(/entry\[1\]/); // 0-based index of the offending entry

    // Nothing was installed — no partial mutation (the rejection is before persistPack).
    const listRes = await request(server).get('/api/v1/rules/packs').set(uploader);
    expect(listRes.body.some((p: { slug: string }) => p.slug === 'smuggler-pack')).toBe(false);
    const searchRes = await request(server).get('/api/v1/rules/search').query({ q: 'Proprietary Boss' }).set(uploader);
    expect(searchItems(searchRes.body).some((e: { name: string }) => e.name === 'Proprietary Boss')).toBe(false);
  });

  it('rejects an entry that has no per-entry license when the pack license itself is non-open', async () => {
    // Defense-in-depth on top of the pack-level check: even though assertOpenLicense(pack)
    // already rejects a non-open PACK, per-entry validation independently flags an entry
    // whose effective license (pack fallback) is non-open. This pins the per-entry path.
    const res = await uploadPack({
      source: 'upload',
      pack: { slug: 'bad-pack-license', name: 'Bad Pack License', license: 'Proprietary' },
      entries: [
        { slug: 'inherited-bad', name: 'Inherited Bad', type: 'spell', body: 'inherits pack license' },
      ],
    });
    expect(res.status).toBe(400);
    expect(String(res.body.message)).toMatch(/open license/i);
  });

  it('accepts self-authored licenses on upload (issue #1504)', async () => {
    const res = await uploadPack({
      source: 'upload',
      pack: { slug: 'self-authored-pack', name: 'Self Authored Pack', license: 'My own work' },
      entries: [
        { slug: 'homebrew-monster', name: 'Homebrew Monster', type: 'monster', body: 'original creation' },
      ],
    });
    expect(res.status).toBe(202);
  });

  it('rejects CC-BY-NC-ND redistribution forbidden licenses on upload (issue #1504)', async () => {
    const res = await uploadPack({
      source: 'upload',
      pack: { slug: 'nc-nd-pack', name: 'NC ND Pack', license: 'CC-BY-NC-ND-4.0' },
      entries: [
        { slug: 'nc-nd-monster', name: 'NC ND Monster', type: 'monster', body: 'restricted' },
      ],
    });
    expect(res.status).toBe(400);
    expect(String(res.body.message)).toMatch(/redistribution|NonCommercial|NoDerivatives/i);
  });
});


describe('rules search pagination (issue #613)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  async function uploadMany(names: string[], packSlug: string) {
    const server = ctx.app.getHttpServer();
    const entries = names.map((name, i) => ({
      slug: `${packSlug}-${i}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      name,
      type: 'monster' as const,
      summary: `${name} summary`,
      body: `${name} body`,
    }));
    const res = await request(server)
      .post('/api/v1/rules/packs/upload')
      .set(dm)
      .send({
        source: 'upload',
        pack: {
          slug: packSlug,
          name: packSlug,
          version: '1',
          license: 'CC0',
          sourceUrl: 'https://example.com/' + packSlug,
        },
        entries,
      });
    expect(res.status).toBe(202);
    const job = await pollJob(server, dm, res.body.id);
    expect(job.status).toBe('completed');
    return job.pack.id as number;
  }

  it('returns totals/hasMore/nextCursor and pages stably across multi-pack ties', async () => {
    const server = ctx.app.getHttpServer();
    // Two packs with identical names — id tiebreak must keep order stable across pages.
    const packA = await uploadMany(
      Array.from({ length: 30 }, (_, i) => `Alpha Twin ${String(i).padStart(2, '0')}`),
      'page-pack-a',
    );
    const packB = await uploadMany(
      Array.from({ length: 30 }, (_, i) => `Alpha Twin ${String(i).padStart(2, '0')}`),
      'page-pack-b',
    );
    const packC = await uploadMany(
      Array.from({ length: 25 }, (_, i) => `Browse Node ${String(i).padStart(2, '0')}`),
      'page-pack-c',
    );

    const page1 = await request(server).get('/api/v1/rules/search').query({ limit: 20 }).set(dm);
    expect(page1.status).toBe(200);
    expect(page1.body.items).toHaveLength(20);
    expect(page1.body.total).toBeGreaterThanOrEqual(85);
    expect(page1.body.hasMore).toBe(true);
    expect(typeof page1.body.nextCursor).toBe('string');
    expect(page1.body.limit).toBe(20);

    // Deterministic empty-query order: name asc, then id asc.
    const names1 = page1.body.items.map((e: { name: string }) => e.name);
    const sorted = [...names1].sort((a, b) => a.localeCompare(b, 'en'));
    expect(names1).toEqual(sorted);

    const page2 = await request(server)
      .get('/api/v1/rules/search')
      .query({ limit: 20, cursor: page1.body.nextCursor })
      .set(dm);
    expect(page2.status).toBe(200);
    expect(page2.body.items.length).toBeGreaterThan(0);
    expect(page2.body.total).toBe(page1.body.total);

    const ids1 = new Set(page1.body.items.map((e: { id: number }) => e.id));
    for (const e of page2.body.items) {
      expect(ids1.has(e.id)).toBe(false);
    }

    // Tie/insertion: adding mid-alphabet names grows total; first-page order stays name-sorted.
    const beforeTotal = page1.body.total;
    const packD = await uploadMany(['Alpha Twin 00', 'Browse Node 99'], 'page-pack-d-insert');
    const page1b = await request(server).get('/api/v1/rules/search').query({ limit: 20 }).set(dm);
    expect(page1b.body.total).toBe(beforeTotal + 2);
    expect(page1b.body.items[0].name <= page1b.body.items[1].name).toBe(true);

    // Ranked search pages with hasMore when many ties share a query.
    const ranked1 = await request(server)
      .get('/api/v1/rules/search')
      .query({ q: 'Alpha Twin', limit: 15 })
      .set(dm);
    expect(ranked1.status).toBe(200);
    expect(ranked1.body.total).toBeGreaterThan(15);
    expect(ranked1.body.hasMore).toBe(true);
    expect(ranked1.body.items).toHaveLength(15);
    const ranked2 = await request(server)
      .get('/api/v1/rules/search')
      .query({ q: 'Alpha Twin', limit: 15, cursor: ranked1.body.nextCursor })
      .set(dm);
    expect(ranked2.status).toBe(200);
    const rankedIds = new Set(ranked1.body.items.map((e: { id: number }) => e.id));
    for (const e of ranked2.body.items) expect(rankedIds.has(e.id)).toBe(false);

    // Invalid cursor → 400
    const bad = await request(server).get('/api/v1/rules/search').query({ cursor: 'not-a-cursor' }).set(dm);
    expect(bad.status).toBe(400);

    await request(server).delete(`/api/v1/rules/packs/${packA}`).set(dm);
    await request(server).delete(`/api/v1/rules/packs/${packB}`).set(dm);
    await request(server).delete(`/api/v1/rules/packs/${packC}`).set(dm);
    await request(server).delete(`/api/v1/rules/packs/${packD}`).set(dm);
  });
});

/**
 * Issue #1518: a rule-pack re-import whose fetched manifest is byte-identical to the
 * installed one must NOT re-read and re-sha256 every entry inside one synchronous
 * better-sqlite3 transaction (which blocks the event loop — including the install-job
 * polling endpoint the admin UI renders the import's progress through). The fix stamps a
 * manifest content hash on the pack row and short-circuits the classification transaction
 * when the fetched hash matches it, while preserving #500's single-transaction atomicity
 * and read-stable classification for every genuinely-changed manifest.
 */
describe('rules / rule packs — identical re-import short-circuit (#1518)', () => {
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

  const dmHeaders = { 'x-dev-role': 'dm', 'x-dev-user': 'sc-1518-dm' };
  const TOTAL = 2 + 2 + 1 + 4 + 2 + 2 + 1 + 4 + 2; // spells + creatures + magicitems + conditions + classes + species + feats + weapons + armor

  it('stamps the manifest hash on install and short-circuits a byte-identical re-import to a no-op', async () => {
    const server = ctx.app.getHttpServer();
    const db = ctx.app.get<DrizzleDb>(DB);

    const first = await installOpen5e(server, dmHeaders, { source: 'open5e', url: fake.baseUrl });
    expect(first.status).toBe('completed');
    expect(first.pack.entryCount).toBe(TOTAL);
    const packId = first.pack.id;

    // The install stamped a full 64-hex sha256 manifest hash on the pack row.
    const [afterInstall] = db.select().from(rulePacks).where(eq(rulePacks.id, packId)).all();
    expect(afterInstall?.manifestHash).toMatch(/^[a-f0-9]{64}$/);

    // The fetched manifest is byte-identical, so the sync must short-circuit: the pack's
    // tracked manifest hash matches the fetched one and the classification transaction is
    // skipped, returning a zero-change result without reading or hashing a single entry.
    const reJob = await installOpen5e(server, dmHeaders, { source: 'open5e', url: fake.baseUrl });
    expect(reJob.status).toBe('completed');
    expect(reJob.outcome).toBe('updated');
    expect(reJob.added).toBe(0);
    expect(reJob.changed).toBe(0);
    expect(reJob.removed).toBe(0);
    expect(reJob.preview).toMatchObject({ added: 0, changed: 0, removed: 0, unchanged: TOTAL });
    expect(reJob.pack.entryCount).toBe(TOTAL);
    // Same manifest → same hash; the short-circuit leaves the pack row (and its hash) as-is.
    expect(reJob.preview.sourceHash).toBe(afterInstall!.manifestHash);
    const [afterReimport] = db.select().from(rulePacks).where(eq(rulePacks.id, packId)).all();
    expect(afterReimport?.manifestHash).toBe(afterInstall!.manifestHash);

    // A third identical re-import is still a no-op (the hash stays stable across short-circuits).
    const third = await installOpen5e(server, dmHeaders, { source: 'open5e', url: fake.baseUrl });
    expect(third.added).toBe(0);
    expect(third.changed).toBe(0);
    expect(third.removed).toBe(0);

    await request(server).delete(`/api/v1/rules/packs/${packId}`).set(dmHeaders);
  });

  it('a genuinely-changed manifest still falls through to the full transactional classification', async () => {
    // Guards against the short-circuit over-firing. A partial add (one section) stamps a hash
    // for that section's manifest only; a subsequent full re-import fetches a DIFFERENT
    // manifest, so its hash cannot match and the full classification must run, adding the
    // remaining sections. (#500 atomicity/read-stability are exercised by this same path.)
    const server = ctx.app.getHttpServer();

    const partial = await installOpen5e(server, dmHeaders, { source: 'open5e', url: fake.baseUrl, sections: ['conditions'] });
    expect(partial.status).toBe('completed');
    expect(partial.pack.entryCount).toBe(4);
    const packId = partial.pack.id;

    const full = await installOpen5e(server, dmHeaders, { source: 'open5e', url: fake.baseUrl });
    expect(full.status).toBe('completed');
    expect(full.outcome).toBe('updated');
    expect(full.added).toBe(TOTAL - 4); // every section except the already-present conditions
    expect(full.changed).toBe(0);
    expect(full.removed).toBe(0);
    expect(full.pack.entryCount).toBe(TOTAL);

    await request(server).delete(`/api/v1/rules/packs/${packId}`).set(dmHeaders);
  });

  it('an identical re-import skips the per-entry re-hash and trusts the tracked manifest hash', async () => {
    // The no-op result above is also producible by the full classification path, so on its
    // own it cannot prove the short-circuit ran. This test pins that the optimization is
    // actually taken: it changes an installed entry's content via a path the manifest hash
    // does NOT cover (a direct DB write, standing in for the only-in-test divergence), then
    // re-imports the byte-identical manifest. Because the pack's tracked hash still matches
    // the fetched one, the short-circuit fires and the per-entry re-hash is skipped — so the
    // divergence is reported as unchanged rather than changed. This is the #1518 contract:
    // the short-circuit trusts a manifest hash that only the import flow maintains, which is
    // sound in production because no other path mutates global rule-entry content fields. (If
    // the short-circuit were ever removed, this re-import would re-hash and report changed: 1,
    // failing the assertion — which is exactly the regression guard we want.)
    const server = ctx.app.getHttpServer();
    const db = ctx.app.get<DrizzleDb>(DB);

    const first = await installOpen5e(server, dmHeaders, { source: 'open5e', url: fake.baseUrl });
    expect(first.status).toBe('completed');
    const packId = first.pack.id;
    const [packRow] = db.select().from(rulePacks).where(eq(rulePacks.id, packId)).all();
    const trackedHash = packRow!.manifestHash;
    expect(trackedHash).not.toBe('');

    // Mutate a content field the entry hash covers, directly in the DB (NOT via the import
    // flow). The tracked manifest hash is unchanged by this.
    const [anEntry] = db.select().from(ruleEntries).where(eq(ruleEntries.packId, packId)).limit(1).all();
    expect(anEntry).toBeDefined();
    db.update(ruleEntries)
      .set({ body: `${anEntry!.body} [directly mutated, outside the import flow]`, updatedAt: new Date().toISOString() })
      .where(eq(ruleEntries.id, anEntry!.id))
      .run();
    const [stillTracked] = db.select().from(rulePacks).where(eq(rulePacks.id, packId)).all();
    expect(stillTracked!.manifestHash).toBe(trackedHash);

    // Byte-identical re-import: the short-circuit fires and the re-hash is skipped.
    const reJob = await installOpen5e(server, dmHeaders, { source: 'open5e', url: fake.baseUrl });
    expect(reJob.status).toBe('completed');
    expect(reJob.changed).toBe(0);
    expect(reJob.added).toBe(0);
    expect(reJob.removed).toBe(0);

    await request(server).delete(`/api/v1/rules/packs/${packId}`).set(dmHeaders);
  });
});

/**
 * Issue #1518 cross-day regression. Every importer except Open5e stamps `meta.version` to
 * `nowIso().slice(0,10)` — a per-day UTC date string. The manifest fingerprint is content-only
 * (`packManifestHash` excludes `meta.version`), so an unchanged pack re-imported on a LATER
 * calendar day must still match the tracked manifest hash and short-circuit the per-entry
 * read+sha256 classification. This is the motivating Datasworn / large-pack case: without the
 * fix, a same-content re-import that crossed a UTC midnight recomputed a different hash each
 * day and fell through to the full synchronous scan, re-introducing the event-loop-blocking
 * burst the short-circuit exists to eliminate.
 *
 * The upload importer is used here because an operator can supply `pack.version`, so two
 * distinct `YYYY-MM-DD` values deterministically model a re-import that crossed a UTC day
 * boundary — without depending on real wall-clock time. Both uploads carry byte-identical
 * entry content.
 */
describe('rules / rule packs — identical re-import across a UTC day boundary (#1518 content-only hash)', () => {
  let ctx: TestAppContext;
  const uploader = { 'x-dev-role': 'dm', 'x-dev-user': 'cross-day-1518-dm' };

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  const baseEntries = [
    { slug: 'oracle-reroll', name: 'Oracle Reroll', type: 'feat', summary: 'Reroll once.', body: 'Reroll a single die.' },
    { slug: 'starved', name: 'Starved', type: 'condition', summary: 'Hunger penalty.', body: 'You cannot regain hit points.' },
  ];

  function uploadAs(server: Server, version: string) {
    return request(server)
      .post('/api/v1/rules/packs/upload')
      .set(uploader)
      .send({
        source: 'upload',
        pack: {
          slug: 'cross-day-1518',
          name: 'Cross-Day #1518',
          version,
          license: 'CC-BY-4.0',
          sourceUrl: 'https://example.com/cross-day',
        },
        entries: baseEntries,
      });
  }

  it('short-circuits an unchanged pack re-imported on a later day (content-only hash excludes meta.version)', async () => {
    const server = ctx.app.getHttpServer();
    const db = ctx.app.get<DrizzleDb>(DB);

    // Day 1: install the pack. Stamps a content-only manifest hash on the pack row.
    const day1Res = await uploadAs(server, '2026-07-29');
    expect(day1Res.status).toBe(202);
    const day1 = await pollJob(server, uploader, day1Res.body.id);
    expect(day1.status).toBe('completed');
    expect(day1.outcome).toBe('created');
    expect(day1.pack.entryCount).toBe(2);
    const packId = day1.pack.id;
    const day1Hash = day1.preview.sourceHash;
    expect(day1Hash).toMatch(/^[a-f0-9]{64}$/);
    const [rowDay1] = db.select().from(rulePacks).where(eq(rulePacks.id, packId)).all();
    expect(rowDay1?.manifestHash).toBe(day1Hash);
    expect(rowDay1?.version).toBe('2026-07-29');

    // Mutate one entry's content via a path the manifest hash does NOT cover (a direct DB
    // write, standing in for the only-in-test divergence). A FULL per-entry classification
    // would re-hash this row and report changed:1; the short-circuit skips that re-hash, so
    // the mutation stays invisible. This turns the zero-change result below into proof that
    // the classification actually ran the fast path, not just that it produced a no-op.
    const [anEntry] = db.select().from(ruleEntries).where(eq(ruleEntries.packId, packId)).limit(1).all();
    expect(anEntry).toBeDefined();
    db.update(ruleEntries)
      .set({ body: `${anEntry!.body} [mutated outside the import flow]`, updatedAt: new Date().toISOString() })
      .where(eq(ruleEntries.id, anEntry!.id))
      .run();

    // Day 2 (a LATER UTC day): byte-identical content, but a DIFFERENT meta.version date —
    // exactly what every date-stamped importer produces across a midnight boundary.
    const day2Res = await uploadAs(server, '2026-07-30');
    expect(day2Res.status).toBe(202);
    const day2 = await pollJob(server, uploader, day2Res.body.id);
    expect(day2.status).toBe('completed');
    expect(day2.outcome).toBe('updated');

    // The content-only hash is identical across the two version strings (the volatile date was
    // excluded from the fingerprint), so the short-circuit fired and the per-entry re-hash was
    // skipped — the day-1 mutation went undetected.
    expect(day2.added).toBe(0);
    expect(day2.changed).toBe(0); // would be 1 if the full classification re-hashed the mutated row
    expect(day2.removed).toBe(0);
    expect(day2.preview).toMatchObject({ added: 0, changed: 0, removed: 0, unchanged: 2 });
    expect(day2.preview.sourceHash).toBe(day1Hash); // version excluded -> identical content-only hash

    // The tracked manifest hash is unchanged (the content-only hash matched across days) ...
    const [rowDay2] = db.select().from(rulePacks).where(eq(rulePacks.id, packId)).all();
    expect(rowDay2?.manifestHash).toBe(day1Hash);
    // ... while the displayed version label still advanced to the day-2 stamp (#1518 keeps
    // version OUT of the comparison but refreshes it as a separate displayed field).
    expect(rowDay2?.version).toBe('2026-07-30');

    await request(server).delete(`/api/v1/rules/packs/${packId}`).set(uploader);
  });
});
