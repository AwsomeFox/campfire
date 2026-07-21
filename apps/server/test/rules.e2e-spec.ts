import request from 'supertest';
import type { Server } from 'node:http';
import { createTestApp, createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';
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

    // re-installing the same slug+sections is now an incremental no-op (round-2 finding
    // #2): outcome 'updated' with added:0 (everything already present) rather than a 409.
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
    const monsterSearchRes = await request(server).get('/api/v1/rules/search').query({ q: 'owlbear', type: 'monster' }).set(dm);
    expect(monsterSearchRes.status).toBe(200);
    expect(monsterSearchRes.body.length).toBeGreaterThan(0);
    for (const e of monsterSearchRes.body) expect(e.type).toBe('monster');
    expect(monsterSearchRes.body.some((e: { name: string }) => e.name === 'Owlbear')).toBe(true);

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

  it('a DM of a campaign (not a server admin) can install a pack (issue #20)', async () => {
    // The DM user creates a campaign — the creator is auto-inserted as its DM.
    const campRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'DM Install Campaign' });
    expect(campRes.status).toBe(201);

    const installRes = await dmAgent
      .post('/api/v1/rules/packs/install')
      .send({ source: 'open5e', url: fake.baseUrl, sections: ['conditions'] });
    expect(installRes.status).toBe(202);
    const job = await pollWithAgent(dmAgent, installRes.body.id);
    expect(job.status).toBe('completed');
    expect(job.pack.slug).toBe('open5e-srd');

    // A DM may install, but uninstall stays server-admin only.
    const dmUninstall = await dmAgent.delete(`/api/v1/rules/packs/${job.pack.id}`);
    expect(dmUninstall.status).toBe(403);
    await adminAgent.delete(`/api/v1/rules/packs/${job.pack.id}`);
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
