import request from 'supertest';
import type { Server } from 'node:http';
import { eq } from 'drizzle-orm';
import { createTestApp, createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';
import { DB, type DrizzleDb } from '../src/db/db.module';
import { ruleEntries } from '../src/db/schema';
import {
  startFakeOpen5e,
  startFakeOpen5eWithBadPagination,
  startFakeOpen5eFlaky,
  startFakeOpen5eMultiDoc,
  type FakeOpen5e,
  type FakeOpen5eWithBadPagination,
  type FakeOpen5eFlaky,
} from './fake-open5e';

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
    expect(job.pack.entryCount).toBe(2 + 2 + 1 + 4 + 2 + 2 + 1); // spells + creatures + magicitems + conditions + classes + species + feats from the fake server
    expect(job.pack.license).toContain('Creative Commons');
    // per-section progress was reported (issue #20): one row per section, all done.
    expect(job.progress.length).toBe(7);
    expect(job.progress.every((p: { status: string }) => p.status === 'done')).toBe(true);
    expect(job.completedSections).toBe(7);
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
    const oldSentinel = oldSentinelSearch.body.find((e: { name: string }) => e.name === 'Fixture Sentinel');
    const db = ctx.app.get<DrizzleDb>(DB);
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
    const reJob = await installOpen5e(server, dm, { source: 'open5e', url: fake.baseUrl });
    expect(reJob.status).toBe('completed');
    expect(reJob.outcome).toBe('updated');
    expect(reJob.added).toBe(0);
    expect(reJob.skippedExisting).toBe(2 + 2 + 1 + 4 + 2 + 2 + 1);
    expect(reJob.pack.entryCount).toBe(2 + 2 + 1 + 4 + 2 + 2 + 1); // unchanged

    // search: free text finds the fireball spell
    const searchRes = await request(server).get('/api/v1/rules/search').query({ q: 'fireball' }).set(dm);
    expect(searchRes.status).toBe(200);
    expect(searchRes.body.length).toBeGreaterThan(0);
    expect(searchRes.body.some((e: { name: string }) => e.name === 'Fireball')).toBe(true);

    // search: type filter narrows to monsters only
    const monsterSearchRes = await request(server).get('/api/v1/rules/search').query({ q: 'fixture sentinel', type: 'monster' }).set(dm);
    expect(monsterSearchRes.status).toBe(200);
    expect(monsterSearchRes.body.length).toBeGreaterThan(0);
    for (const e of monsterSearchRes.body) expect(e.type).toBe('monster');
    expect(monsterSearchRes.body.some((e: { name: string }) => e.name === 'Fixture Sentinel')).toBe(true);

    // Issue #621 regression: live Open5e v2 combines regular, reaction and legendary
    // entries in actions[] (partitioned by action_type) and calls passive abilities
    // traits[]. The importer must preserve every category, raw description, and useful
    // structured mechanics in the shared dataJson returned by search and entry reads.
    const sentinel = monsterSearchRes.body.find((e: { name: string }) => e.name === 'Fixture Sentinel');
    const sentinelData = JSON.parse(sentinel.dataJson);
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
    expect(packSearchRes.body.some((e: { name: string }) => e.name === 'Goblin')).toBe(true);

    // issue #53 regression: a DEFAULT install (all sections) must actually ship
    // monsters, spells, AND magic items — not just conditions. Monster (Owlbear) and
    // spell (Fireball) are asserted above; assert an item is searchable too.
    const itemSearchRes = await request(server).get('/api/v1/rules/search').query({ q: 'bag of holding', type: 'item' }).set(dm);
    expect(itemSearchRes.status).toBe(200);
    for (const e of itemSearchRes.body) expect(e.type).toBe('item');
    expect(itemSearchRes.body.some((e: { name: string }) => e.name === 'Bag of Holding')).toBe(true);

    // issue #53 root cause was a pagination failure on large (multi-page) sections. The
    // fake serves spells across TWO pages; Mage Armor lives on page 2, so finding it
    // proves the importer followed the `next` link and imported page-2 entries.
    const pagedSpellRes = await request(server).get('/api/v1/rules/search').query({ q: 'mage armor', type: 'spell' }).set(dm);
    expect(pagedSpellRes.status).toBe(200);
    expect(pagedSpellRes.body.some((e: { name: string }) => e.name === 'Mage Armor')).toBe(true);

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

  // Manual icon override on a compendium entry (issue #305): imported entries carry an
  // empty iconSlug (the web app derives a default from type/dataJson); a DM can PATCH a
  // bundled game-icons.net slug and clear it back. Round-trips create -> set -> clear.
  it('rule entry iconSlug defaults to empty and round-trips through PATCH set/clear', async () => {
    const server = ctx.app.getHttpServer();
    const job = await installOpen5e(server, dm, { source: 'open5e', url: fake.baseUrl, sections: ['spells'] });
    const packId = job.pack.id;

    try {
      const searchRes = await request(server).get('/api/v1/rules/search').query({ q: 'fireball' }).set(dm);
      const fireball = searchRes.body.find((e: { name: string }) => e.name === 'Fireball');
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
    expect(searchRes.body).toEqual([]); // creatures weren't imported

    await request(server).delete(`/api/v1/rules/packs/${job.pack.id}`).set(dm);
  });

  it('install classes, races, and feats sections (issue #2) — mapped to class/race/feat entry types', async () => {
    const server = ctx.app.getHttpServer();

    const job = await installOpen5e(server, dm, { source: 'open5e', url: fake.baseUrl, sections: ['classes', 'races', 'feats'] });
    expect(job.status).toBe('completed');
    expect(job.pack.entryCount).toBe(2 + 2 + 1); // classes + species + feats from the fake server

    // classes: served from /v2/classes/; empty desc means the body comes from features[].
    const classSearch = await request(server).get('/api/v1/rules/search').query({ q: 'barbarian', type: 'class' }).set(dm);
    expect(classSearch.status).toBe(200);
    for (const e of classSearch.body) expect(e.type).toBe('class');
    const barbarian = classSearch.body.find((e: { name: string }) => e.name === 'Barbarian');
    expect(barbarian).toBeDefined();
    expect(barbarian.body).toContain('### Rage');
    expect(barbarian.body).toContain('primal ferocity');
    expect(barbarian.summary).toContain('hit dice D12');
    const barbarianData = JSON.parse(barbarian.dataJson);
    expect(barbarianData.hitDice).toBe('D12');
    expect(barbarianData.savingThrows).toEqual(['Strength', 'Constitution']);
    expect(barbarianData.subclassOf).toBeNull();

    // subclasses share the classes list, distinguished via subclass_of.
    const berserker = (await request(server).get('/api/v1/rules/search').query({ q: 'berserker' }).set(dm)).body.find(
      (e: { name: string }) => e.name === 'Path of the Berserker',
    );
    expect(berserker).toBeDefined();
    expect(berserker.type).toBe('class');
    expect(JSON.parse(berserker.dataJson).subclassOf).toBe('Barbarian');
    expect(berserker.summary).toContain('Barbarian subclass');

    // races: fetched from /v2/species/ (v2 has no /races/ route) but exposed as type 'race'.
    const raceSearch = await request(server).get('/api/v1/rules/search').query({ q: 'dwarf', type: 'race' }).set(dm);
    expect(raceSearch.status).toBe(200);
    for (const e of raceSearch.body) expect(e.type).toBe('race');
    const dwarf = raceSearch.body.find((e: { name: string }) => e.name === 'Dwarf');
    expect(dwarf).toBeDefined();
    expect(dwarf.body).toContain('### Darkvision');
    expect(dwarf.summary).toContain('Bold and hardy');
    const hillDwarf = raceSearch.body.find((e: { name: string }) => e.name === 'Hill Dwarf');
    expect(hillDwarf).toBeDefined();
    const hillDwarfData = JSON.parse(hillDwarf.dataJson);
    expect(hillDwarfData.isSubspecies).toBe(true);
    expect(hillDwarfData.subspeciesOf).toBe('srd_dwarf');

    // feats: prerequisite surfaces in the summary, benefits become body bullets.
    const featSearch = await request(server).get('/api/v1/rules/search').query({ q: 'grappler', type: 'feat' }).set(dm);
    expect(featSearch.status).toBe(200);
    const grappler = featSearch.body.find((e: { name: string }) => e.name === 'Grappler');
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
    expect(spellSearch.body).toEqual([]);

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
    expect(spellRes.body.some((e: { name: string }) => e.name === 'Fireball')).toBe(true);
    const classRes = await request(server).get('/api/v1/rules/search').query({ q: 'fighter', type: 'class' }).set(uploader);
    expect(classRes.body.some((e: { name: string }) => e.name === 'Fighter')).toBe(true);

    await request(server).delete(`/api/v1/rules/packs/${job.pack.id}`).set(uploader);
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
    expect(proneRes.body.some((e: { name: string }) => e.name === 'Prone')).toBe(true); // from open5e
    const fighterRes = await request(server).get('/api/v1/rules/search').query({ q: 'fighter' }).set(uploader);
    expect(fighterRes.body.some((e: { name: string }) => e.name === 'Fighter')).toBe(true); // from upload

    await request(server).delete(`/api/v1/rules/packs/${open5eJob.pack.id}`).set(uploader);
    await request(server).delete(`/api/v1/rules/packs/${uploadJob.pack.id}`).set(uploader);
  });

  it('re-uploading the same slug is an incremental add (dedupe by slug+type)', async () => {
    const server = ctx.app.getHttpServer();

    const firstRes = await uploadPack(pf2ePack);
    const firstJob = await pollJob(server, uploader, firstRes.body.id);
    expect(firstJob.outcome).toBe('created');
    expect(firstJob.pack.entryCount).toBe(3);

    // Second upload: 2 of the 3 entries already exist; one is new.
    const secondRes = await uploadPack({
      ...pf2ePack,
      entries: [
        ...pf2ePack.entries,
        { slug: 'pf2e-shield', name: 'Shield', type: 'item', summary: 'A sturdy shield.' },
      ],
    });
    const secondJob = await pollJob(server, uploader, secondRes.body.id);
    expect(secondJob.outcome).toBe('updated');
    expect(secondJob.added).toBe(1);
    expect(secondJob.skippedExisting).toBe(3);
    expect(secondJob.pack.entryCount).toBe(4);

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
    const fireballs = fireballRes.body.filter((e: { name: string }) => e.name === 'Fireball');
    expect(fireballs).toHaveLength(1);
    expect(fireballs[0].source).toBe('System Reference Document 5.1');
    expect(fireballs[0].body).toContain('SRD 5.1');

    // Goblin: same — one row, canonical source, distinguishable in the picker.
    const goblinRes = await request(server).get('/api/v1/rules/search').query({ q: 'goblin', type: 'monster' }).set(dedupeDm);
    const goblins = goblinRes.body.filter((e: { name: string }) => e.name === 'Goblin');
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

    // Uninstall — the dangling slug must be cleared, not left behind.
    const uninstallRes = await request(server).delete(`/api/v1/rules/packs/${packId}`).set(uninstallDm);
    expect(uninstallRes.status).toBe(200);

    const afterGet = await request(server).get(`/api/v1/campaigns/${campaignId}`).set(uninstallDm);
    expect(afterGet.status).toBe(200);
    expect(afterGet.body.ruleSystem).toBe('');

    // Reinstalling must NOT silently re-link the campaign (the slug is gone for good).
    const reJob = await installOpen5e(server, uninstallDm, { source: 'open5e', url: fake.baseUrl, sections: ['conditions'] });
    expect(reJob.status).toBe('completed');
    const afterReinstall = await request(server).get(`/api/v1/campaigns/${campaignId}`).set(uninstallDm);
    expect(afterReinstall.body.ruleSystem).toBe('');

    await request(server).delete(`/api/v1/rules/packs/${reJob.pack.id}`).set(uninstallDm);
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

    await request(server).delete(`/api/v1/rules/packs/${packId}`).set(dmA);
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
    expect(searchRes.body.some((e: { name: string }) => e.name === 'Fireball')).toBe(true);
    expect(searchRes.body.some((e: { name: string }) => e.name === 'Should Never Be Imported')).toBe(false);

    // Skip accounting was logged (both the per-section summary and the malformed row).
    const warnCalls = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warnCalls.some((m) => m.includes('cross-origin pagination'))).toBe(true);
    expect(warnCalls.some((m) => m.includes('skipped'))).toBe(true);

    await request(server).delete(`/api/v1/rules/packs/${job.pack.id}`).set(hardeningDm);
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
    expect(searchRes.body.some((e: { name: string }) => e.name === 'Fireball')).toBe(true);

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
    expect(searchConditions.body.some((e: { name: string }) => e.name === 'Prone')).toBe(true);
    const searchSpells = await request(server).get('/api/v1/rules/search').query({ q: 'fireball' }).set(dmHeaders);
    expect(searchSpells.body.some((e: { name: string }) => e.name === 'Fireball')).toBe(true);

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
    const goblin = monsterRes.body.find((e: { name: string }) => e.name === 'Goblin Warrior');
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
      expect(r.body.some((e: { name: string }) => e.name === name)).toBe(true);
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

    const cleaveRes = await request(server).get('/api/v1/rules/search').query({ q: 'Cleave', type: 'feat' }).set(dm);
    expect(cleaveRes.status).toBe(200);
    const cleaves = cleaveRes.body.filter((e: { name: string }) => e.name === 'Cleave');
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
      expect(spell.body.some((e: { name: string }) => e.name === 'Fireball')).toBe(true);
      const monster = await request(server).get('/api/v1/rules/search').query({ q: 'goblin', type: 'monster' }).set(dm);
      expect(monster.body.some((e: { name: string }) => e.name === 'Goblin')).toBe(true);

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
      expect(spell.body.some((e: { name: string }) => e.name === 'Magic Missile')).toBe(true);
      // Starfinder's own sections (starships) imported alongside the 5e-shaped ones.
      const ship = await request(server).get('/api/v1/rules/search').query({ q: 'pegasus' }).set(dm);
      expect(ship.body.some((e: { name: string }) => e.name === 'Pegasus')).toBe(true);

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
      expect(monster.body.some((e: { name: string }) => e.name === 'Bear')).toBe(true);

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
      expect(boon.body.some((e: { name: string }) => e.name === 'Haste')).toBe(true);
      const bane = await request(server).get('/api/v1/rules/search').query({ q: 'blinded', type: 'condition' }).set(dm);
      expect(bane.body.some((e: { name: string }) => e.name === 'Blinded')).toBe(true);
      const feat = await request(server).get('/api/v1/rules/search').query({ q: 'combat momentum', type: 'feat' }).set(dm);
      expect(feat.body.some((e: { name: string }) => e.name === 'Combat Momentum')).toBe(true);

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
      // Default variant installs under 'basic-fantasy'.
      const dflt = await installSource({ source: 'osr', url: fake.baseUrl });
      expect(dflt.status).toBe('completed');
      expect(dflt.pack.slug).toBe('basic-fantasy');
      const monster = await request(server).get('/api/v1/rules/search').query({ q: 'skeleton', type: 'monster' }).set(dm);
      expect(monster.body.some((e: { name: string }) => e.name === 'Skeleton')).toBe(true);
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
    for (const s of ['open5e', 'pf2e', 'sf2e', 'pf1e', 'starfinder', 'archmage', 'open-legend', 'osr', 'other']) {
      expect(bySource[s]).toBeDefined();
    }
    // Wired live sources install without a url.
    expect(bySource['open-legend']).toMatchObject({ sourceKind: 'api', installableWithoutUrl: true });
    expect(bySource['open5e']).toMatchObject({ sourceKind: 'api', installableWithoutUrl: true });
    expect(bySource['sf2e']).toMatchObject({ sourceKind: 'api', installableWithoutUrl: true });
    // Systems with no open source are honestly flagged manual-upload (and carry a note + license).
    for (const s of ['pf1e', 'starfinder', 'archmage', 'osr']) {
      expect(bySource[s]).toMatchObject({ sourceKind: 'manual-upload', installableWithoutUrl: false });
      expect(typeof bySource[s].note).toBe('string');
      expect(bySource[s].note.length).toBeGreaterThan(0);
      expect(typeof bySource[s].license).toBe('string');
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
    expect(boon.body.some((e: { name: string }) => e.name === 'Haste')).toBe(true);

    await request(server).delete(`/api/v1/rules/packs/${job.pack.id}`).set(dm);
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
    const ogl = oglRes.body.find((e: { name: string }) => e.name === 'OGL Fireball');
    expect(ogl).toBeTruthy();
    const oglEntry = await request(server).get(`/api/v1/rules/entries/${ogl.id}`).set(uploader);
    expect(oglEntry.status).toBe(200);
    expect(oglEntry.body.license).toBe('OGL 1.0a'); // entry's own license, not the pack's CC-BY-4.0
    expect(oglEntry.body.attribution).toBe('OGL Fireball, © Open Author, Open Game Content (OGL 1.0a).');
    expect(oglEntry.body.author).toBe('Open Author');
    expect(oglEntry.body.sourceUrl).toBe('https://example.com/mixed/ogl-fireball');

    const orcRes = await request(server).get('/api/v1/rules/search').query({ q: 'ORC Goblin', pack: 'mixed-licensing-pack' }).set(uploader);
    const orc = orcRes.body.find((e: { name: string }) => e.name === 'ORC Goblin');
    expect(orc).toBeTruthy();
    const orcEntry = await request(server).get(`/api/v1/rules/entries/${orc.id}`).set(uploader);
    expect(orcEntry.body.license).toBe('ORC');
    expect(orcEntry.body.author).toBe('ORC Studio');

    const cc0Res = await request(server).get('/api/v1/rules/search').query({ q: 'CC0 Sword', pack: 'mixed-licensing-pack' }).set(uploader);
    const cc0 = cc0Res.body.find((e: { name: string }) => e.name === 'CC0 Sword');
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
    const found = searchRes.body.find((e: { name: string }) => e.name === 'Uniform Magic Missile');
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
    expect(searchRes.body.some((e: { name: string }) => e.name === 'Proprietary Boss')).toBe(false);
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
});
