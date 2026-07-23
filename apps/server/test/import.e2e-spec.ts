import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';
import { MembersService } from '../src/modules/membership/members.service';

// Minimal valid 1x1 PNG — same fixture as attachments/export specs.
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108020000009077' +
    '53de0000000c4944415408d763f8ffff3f0005fe02fea1399e1e0000000049454e44ae426082',
  'hex',
);

/** GET a route as a raw Buffer (supertest's default parser mangles binary). */
async function getBuffer(agent: ReturnType<typeof request.agent>, url: string) {
  return agent
    .get(url)
    .buffer(true)
    .parse((response, callback) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => callback(null, Buffer.concat(chunks)));
    });
}

/**
 * Issue #120 — make the one-way export round-trippable.
 * POST /campaigns/import accepts a Campfire JSON export document and recreates the
 * campaign with FRESH ids and every intra-campaign reference remapped (location
 * nesting, npc→location, quest parent/giver, combatant→character, note entity
 * links, currentLocationId). Seed a campaign with cross-references, export it,
 * import it, and assert the new campaign carries the same entities with remapped
 * references and no id collisions with the source.
 */
describe('campaign import (e2e, real cookie sessions)', () => {
  let ctx: TestAppContext;
  let dmAgent: ReturnType<typeof request.agent>;
  let playerAgent: ReturnType<typeof request.agent>;
  let campaignId: number;
  let locationId: number;
  let childLocationId: number;
  let npcId: number;
  let questId: number;
  let characterId: number;
  let exportDoc: Record<string, unknown>;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    dmAgent = request.agent(server);
    await dmAgent.post('/api/v1/auth/setup').send({ username: 'import-dm', password: 'dm-password-1' });

    const createPlayer = await dmAgent.post('/api/v1/users').send({ username: 'import-player', password: 'player-password-1', serverRole: 'user' });
    const playerId = createPlayer.body.id;
    playerAgent = request.agent(server);
    await playerAgent.post('/api/v1/auth/login').send({ username: 'import-player', password: 'player-password-1' });

    const campRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'Source Campaign', description: 'To be exported and re-imported.' });
    campaignId = campRes.body.id;
    await dmAgent.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: playerId, role: 'player' });

    // World prep with cross-references: parent location -> child location, npc in location,
    // quest given by npc + an objective.
    const locRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/locations`).send({ name: 'The Region', dmSecret: 'ley lines' });
    locationId = locRes.body.id;
    const childRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/locations`).send({ name: 'The Keep', parentId: locationId });
    childLocationId = childRes.body.id;
    await dmAgent.post(`/api/v1/locations/${locationId}/discover`).send({ status: 'explored' });
    await dmAgent.patch(`/api/v1/campaigns/${campaignId}`).send({ currentLocationId: locationId });

    const npcRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/npcs`).send({ name: 'Guildmaster', locationId: childLocationId, dmSecret: 'a doppelganger' });
    npcId = npcRes.body.id;

    const questRes = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/quests`)
      .send({ title: 'The Heist', giverNpcId: npcId, dmSecret: 'the vault is a trap' });
    questId = questRes.body.id;
    const objRes = await dmAgent.post(`/api/v1/quests/${questId}/objectives`).send({ text: 'Case the vault' });
    await dmAgent.patch(`/api/v1/quests/${questId}/objectives/${objRes.body.id}`).send({ done: true });
    await dmAgent.post(`/api/v1/quests/${questId}/status`).send({ status: 'active' });

    // Play state: session, character, encounter+combatant, a shared note linked to the quest.
    await dmAgent.post(`/api/v1/campaigns/${campaignId}/sessions`).send({ number: 1, recap: 'The crew assembled.' });
    const charRes = await playerAgent.post(`/api/v1/campaigns/${campaignId}/characters`).send({
      name: 'Rogue',
      className: 'Thief',
      level: 3,
      portraitUrl: 'https://images.example.test/rogue.png',
    });
    characterId = charRes.body.id;
    const encRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/encounters`).send({ name: 'Vault Guards' });
    await dmAgent.post(`/api/v1/encounters/${encRes.body.id}/combatants`).send({ kind: 'monster', name: 'Guard', hpMax: 11 });
    await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/notes`)
      .send({ body: 'Quest intel for the party', visibility: 'party_shared', entityType: 'quest', entityId: questId });
    const rootComment = await playerAgent
      .post(`/api/v1/campaigns/${campaignId}/comments`)
      .send({
        entityType: 'quest',
        entityId: questId,
        body: 'Rogue takes point.',
        inCharacter: true,
        characterId,
      });
    await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/comments`)
      .send({ entityType: 'quest', entityId: questId, parentId: rootComment.body.id, body: 'The corridor is trapped.' });

    // Policy is portable configuration; capability rows/tokens are not.
    await dmAgent.put(`/api/v1/campaigns/${campaignId}/session-shares/policy`).send({ enabled: false });

    // The export document is the import contract.
    const exportRes = await dmAgent.get(`/api/v1/campaigns/${campaignId}/export?format=json`);
    exportDoc = exportRes.body;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('imports the export into a brand-new campaign with fresh ids and remapped references', async () => {
    const res = await dmAgent.post('/api/v1/campaigns/import').send(exportDoc);
    expect(res.status).toBe(201);
    const imported = res.body;
    expect(imported.id).not.toBe(campaignId);
    expect(imported.name).toBe('Source Campaign');
    expect(imported.description).toBe('To be exported and re-imported.');
    expect(imported.status).toBe('active');
    expect(imported.publicRecapSharingEnabled).toBe(false);
    // Attachments aren't recreated from a JSON export.
    expect(imported.mapAttachmentId).toBeNull();

    // Locations: both copied, nesting parentId remapped, no id collision with source.
    const locs = await dmAgent.get(`/api/v1/campaigns/${imported.id}/locations`);
    expect(locs.body.length).toBe(2);
    const region = locs.body.find((l: { name: string }) => l.name === 'The Region');
    const keep = locs.body.find((l: { name: string }) => l.name === 'The Keep');
    expect(region).toBeDefined();
    expect(keep).toBeDefined();
    expect(region.id).not.toBe(locationId);
    expect(keep.id).not.toBe(childLocationId);
    expect(region.dmSecret).toBe('ley lines');
    expect(region.status).toBe('explored');
    // Child's parentId points at the newly-imported parent, not the source id.
    expect(keep.parentId).toBe(region.id);
    // campaign.currentLocationId remapped to the imported region.
    expect(imported.currentLocationId).toBe(region.id);

    // NPCs: locationId remapped to the imported child location.
    const importedNpcs = await dmAgent.get(`/api/v1/campaigns/${imported.id}/npcs`);
    expect(importedNpcs.body.length).toBe(1);
    const npc = importedNpcs.body[0];
    expect(npc.id).not.toBe(npcId);
    expect(npc.locationId).toBe(keep.id);
    expect(npc.dmSecret).toBe('a doppelganger');

    // Quests: giverNpcId remapped, status + objective preserved, fresh id.
    const importedQuests = await dmAgent.get(`/api/v1/campaigns/${imported.id}/quests`);
    expect(importedQuests.body.length).toBe(1);
    const qListItem = importedQuests.body[0];
    const importedQuest = await dmAgent.get(`/api/v1/quests/${qListItem.id}`);
    expect(importedQuest.status).toBe(200);
    const q = importedQuest.body;
    expect(q.id).not.toBe(questId);
    expect(q.status).toBe('active');
    expect(q.dmSecret).toBe('the vault is a trap');
    expect(q.giverNpcId).toBe(npc.id);
    expect(q.objectives.length).toBe(1);
    expect(q.objectives[0].text).toBe('Case the vault');
    expect(q.objectives[0].done).toBe(true);

    // Sessions + characters copied.
    const sessions = await dmAgent.get(`/api/v1/campaigns/${imported.id}/sessions`);
    expect(sessions.body.length).toBe(1);
    expect((await dmAgent.get(`/api/v1/sessions/${sessions.body[0].id}/shares`)).body).toEqual([]);
    const chars = await dmAgent.get(`/api/v1/campaigns/${imported.id}/characters`);
    expect(chars.body.length).toBe(1);
    expect(chars.body[0].name).toBe('Rogue');
    expect(chars.body[0].level).toBe(3);
    expect(chars.body[0].id).not.toBe(characterId);
    // Imported PCs come in unowned.
    expect(chars.body[0].ownerUserId).toBeNull();

    // Encounters + combatants copied; the character combatant's characterId remapped.
    const encs = await dmAgent.get(`/api/v1/campaigns/${imported.id}/encounters`);
    expect(encs.body.length).toBe(1);
    const encDetail = await dmAgent.get(`/api/v1/encounters/${encs.body[0].id}`);
    const guard = encDetail.body.combatants.find((c: { name: string }) => c.name === 'Guard');
    expect(guard).toBeDefined();
    const rogueCombatant = encDetail.body.combatants.find((c: { kind: string }) => c.kind === 'character');
    expect(rogueCombatant).toBeDefined();
    expect(rogueCombatant.characterId).toBe(chars.body[0].id);

    // Notes: shared note copied with its entity link remapped to the imported quest.
    const importedNotes = await dmAgent.get(`/api/v1/campaigns/${imported.id}/notes`);
    const shared = importedNotes.body.find((n: { body: string }) => n.body === 'Quest intel for the party');
    expect(shared).toBeDefined();
    expect(shared.entityType).toBe('quest');
    expect(shared.entityId).toBe(q.id);

    // Comments round-trip with anchor/parent/character ids remapped and immutable
    // character display history preserved. Import ownership moves to the importer
    // so source account ids cannot alias unrelated users on this install.
    const importedComments = await dmAgent
      .get(`/api/v1/campaigns/${imported.id}/comments`)
      .query({ entityType: 'quest', entityId: q.id });
    expect(importedComments.status).toBe(200);
    expect(importedComments.body).toHaveLength(2);
    const spoken = importedComments.body.find((c: { body: string }) => c.body === 'Rogue takes point.');
    const reply = importedComments.body.find((c: { body: string }) => c.body === 'The corridor is trapped.');
    expect(spoken).toMatchObject({
      characterId: chars.body[0].id,
      characterName: 'Rogue',
      characterAvatarUrl: 'https://images.example.test/rogue.png',
      authorName: 'import-player',
    });
    expect(reply.parentId).toBe(spoken.id);

    // The source campaign is untouched — import never mutates it.
    const sourceLocs = await dmAgent.get(`/api/v1/campaigns/${campaignId}/locations`);
    expect(sourceLocs.body.length).toBe(2);

    // Members are NOT imported — the source player has no access to the import.
    const playerView = await playerAgent.get(`/api/v1/campaigns/${imported.id}`);
    expect(playerView.status).toBe(403);
  });

  it('a second import yields another independent campaign (no id collisions across imports)', async () => {
    const first = await dmAgent.post('/api/v1/campaigns/import').send(exportDoc);
    const second = await dmAgent.post('/api/v1/campaigns/import').send(exportDoc);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.id).not.toBe(second.body.id);

    const firstQuests = await dmAgent.get(`/api/v1/campaigns/${first.body.id}/quests`);
    const secondQuests = await dmAgent.get(`/api/v1/campaigns/${second.body.id}/quests`);
    expect(firstQuests.body[0].id).not.toBe(secondQuests.body[0].id);
  });

  it('accepts a name override', async () => {
    const res = await dmAgent.post('/api/v1/campaigns/import').send({ ...exportDoc, name: 'Renamed Import' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Renamed Import');
  });

  it('400 on a body with no campaign object', async () => {
    const res = await dmAgent.post('/api/v1/campaigns/import').send({ quests: [] });
    expect(res.status).toBe(400);
  });

  it('imports a minimal document (campaign only, no entity arrays)', async () => {
    const res = await dmAgent.post('/api/v1/campaigns/import').send({ campaign: { name: 'Bare Bones' } });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Bare Bones');
    const locs = await dmAgent.get(`/api/v1/campaigns/${res.body.id}/locations`);
    expect(locs.body.length).toBe(0);
  });
});

/**
 * Issue #236 — the ZIP export is round-trippable: importing the mdzip recreates the
 * attachment ROWS and their BYTES on disk, and remaps every reference (campaign
 * mapAttachmentId, character portraitUrl, encounter battle-map mapAttachmentId) to
 * the fresh attachment ids instead of dropping them. Seed a campaign with a map, a
 * portrait and a battle-map encounter, export it as a zip, import that zip, and
 * assert the maps/portraits survive.
 */
describe('campaign ZIP import — attachments round-trip (e2e)', () => {
  let ctx: TestAppContext;
  let dmAgent: ReturnType<typeof request.agent>;
  let campaignId: number;
  let mapAttachmentId: number;
  let portraitAttachmentId: number;
  let battleMapAttachmentId: number;
  let encounterId: number;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    dmAgent = request.agent(server);
    await dmAgent.post('/api/v1/auth/setup').send({ username: 'zip-dm', password: 'dm-password-1' });

    const campRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'Zip Source', description: 'Has maps and portraits.' });
    campaignId = campRes.body.id;

    // Campaign map.
    const mapUpload = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/attachments`)
      .field('kind', 'map')
      .attach('file', TINY_PNG, { filename: 'overworld.png', contentType: 'image/png' });
    mapAttachmentId = mapUpload.body.id;
    await dmAgent.patch(`/api/v1/campaigns/${campaignId}`).send({ mapAttachmentId });

    // Character portrait.
    const portraitUpload = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/attachments`)
      .field('kind', 'portrait')
      .attach('file', TINY_PNG, { filename: 'hero.png', contentType: 'image/png' });
    portraitAttachmentId = portraitUpload.body.id;
    await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .send({ name: 'Portrait Hero', portraitUrl: `/api/v1/attachments/${portraitAttachmentId}/file` });

    // Encounter with a battle map (issue #39).
    const battleUpload = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/attachments`)
      .field('kind', 'map')
      .attach('file', TINY_PNG, { filename: 'dungeon.png', contentType: 'image/png' });
    battleMapAttachmentId = battleUpload.body.id;
    const encRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/encounters`).send({ name: 'Dungeon Fight' });
    encounterId = encRes.body.id;
    await dmAgent.patch(`/api/v1/encounters/${encounterId}`).send({ mapAttachmentId: battleMapAttachmentId, gridSize: 5 });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('imports the zip export, recreating attachment rows + bytes and remapping every map/portrait ref', async () => {
    // Export as a zip (bytes + campaign.json manifest).
    const zipRes = await getBuffer(dmAgent, `/api/v1/campaigns/${campaignId}/export?format=mdzip`);
    expect(zipRes.status).toBe(200);
    const zipBuffer = zipRes.body as Buffer;

    // Import the zip on a fresh campaign.
    const importRes = await dmAgent
      .post('/api/v1/campaigns/import/archive')
      .attach('file', zipBuffer, { filename: 'export.zip', contentType: 'application/zip' });
    expect(importRes.status).toBe(201);
    const imported = importRes.body;
    expect(imported.id).not.toBe(campaignId);
    expect(imported.name).toBe('Zip Source');

    // Campaign map: remapped to a NEW attachment id (not null, not the source id).
    expect(imported.mapAttachmentId).not.toBeNull();
    expect(imported.mapAttachmentId).not.toBe(mapAttachmentId);

    // Attachment rows recreated under the new campaign (map + portrait + battle map).
    const atts = await dmAgent.get(`/api/v1/campaigns/${imported.id}/attachments`);
    expect(atts.status).toBe(200);
    expect(atts.body.length).toBe(3);
    // Every new id differs from every source id — no collision with the source campaign.
    const sourceIds = new Set([mapAttachmentId, portraitAttachmentId, battleMapAttachmentId]);
    for (const a of atts.body) expect(sourceIds.has(a.id)).toBe(false);

    // The bytes are on disk and fetchable — and identical to what we uploaded.
    const mapFile = await getBuffer(dmAgent, `/api/v1/attachments/${imported.mapAttachmentId}/file`);
    expect(mapFile.status).toBe(200);
    expect(Buffer.compare(mapFile.body as Buffer, TINY_PNG)).toBe(0);

    // Character portrait: portraitUrl remapped to the new portrait attachment (not null).
    const chars = await dmAgent.get(`/api/v1/campaigns/${imported.id}/characters`);
    const hero = chars.body.find((c: { name: string }) => c.name === 'Portrait Hero');
    expect(hero).toBeDefined();
    expect(hero.portraitUrl).not.toBeNull();
    expect(hero.portraitUrl).not.toContain(`/attachments/${portraitAttachmentId}/file`);
    const portraitMatch = hero.portraitUrl.match(/\/attachments\/(\d+)\/file$/);
    expect(portraitMatch).not.toBeNull();
    const newPortraitId = Number(portraitMatch[1]);
    const portraitFile = await getBuffer(dmAgent, `/api/v1/attachments/${newPortraitId}/file`);
    expect(portraitFile.status).toBe(200);
    expect(Buffer.compare(portraitFile.body as Buffer, TINY_PNG)).toBe(0);

    // Encounter battle map: mapAttachmentId remapped (not null), grid config carried over.
    const encs = await dmAgent.get(`/api/v1/campaigns/${imported.id}/encounters`);
    expect(encs.body.length).toBe(1);
    const encDetail = await dmAgent.get(`/api/v1/encounters/${encs.body[0].id}`);
    expect(encDetail.body.mapAttachmentId).not.toBeNull();
    expect(encDetail.body.mapAttachmentId).not.toBe(battleMapAttachmentId);
    expect(encDetail.body.gridSize).toBe(5);
    const battleFile = await getBuffer(dmAgent, `/api/v1/attachments/${encDetail.body.mapAttachmentId}/file`);
    expect(battleFile.status).toBe(200);

    // The source campaign is untouched — its map still points at its own attachment.
    const sourceCamp = await dmAgent.get(`/api/v1/campaigns/${campaignId}`);
    expect(sourceCamp.body.mapAttachmentId).toBe(mapAttachmentId);
  });

  // Issue #630: Unicode attachment filenames must survive export → import and
  // still emit RFC 5987 Content-Disposition on the restored file.
  it('preserves Unicode attachment filenames across export/restore', async () => {
    const unicodeName = '地図🎉.png';
    const campRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'Unicode Filename Source' });
    expect(campRes.status).toBe(201);
    const srcId = campRes.body.id as number;

    const up = await dmAgent
      .post(`/api/v1/campaigns/${srcId}/attachments`)
      .field('kind', 'image')
      .attach('file', TINY_PNG, { filename: unicodeName, contentType: 'image/png' });
    expect(up.status).toBe(201);
    expect(up.body.filename).toBe(unicodeName);

    const zipRes = await getBuffer(dmAgent, `/api/v1/campaigns/${srcId}/export?format=mdzip`);
    expect(zipRes.status).toBe(200);

    const importRes = await dmAgent
      .post('/api/v1/campaigns/import/archive')
      .attach('file', zipRes.body as Buffer, { filename: 'export.zip', contentType: 'application/zip' });
    expect(importRes.status).toBe(201);

    const atts = await dmAgent.get(`/api/v1/campaigns/${importRes.body.id}/attachments`);
    expect(atts.status).toBe(200);
    const restored = atts.body.find((a: { filename: string }) => a.filename === unicodeName);
    expect(restored).toBeDefined();

    const fileRes = await getBuffer(dmAgent, `/api/v1/attachments/${restored.id}/file`);
    expect(fileRes.status).toBe(200);
    const disposition = String(fileRes.headers['content-disposition']);
    expect(disposition).toContain("filename*=UTF-8''");
    expect(disposition).toContain(encodeURIComponent(unicodeName));
    expect(disposition).not.toMatch(/filename="%/);
  });

  it('rejects a non-zip upload with 400', async () => {
    const res = await dmAgent
      .post('/api/v1/campaigns/import/archive')
      .attach('file', Buffer.from('not a zip'), { filename: 'nope.zip', contentType: 'application/zip' });
    expect(res.status).toBe(400);
  });

  it('400 when the archive lacks campaign.json (a plain zip, not a Campfire export)', async () => {
    // Build a minimal valid zip with no campaign.json.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const JSZip = require('jszip');
    const zip = new JSZip();
    zip.file('readme.txt', 'hello');
    const buf: Buffer = await zip.generateAsync({ type: 'nodebuffer' });
    const res = await dmAgent
      .post('/api/v1/campaigns/import/archive')
      .attach('file', buf, { filename: 'plain.zip', contentType: 'application/zip' });
    expect(res.status).toBe(400);
  });
});

/**
 * Issue #266 — export/import previously dropped whole entity types WHOLESALE: factions,
 * the storyline arc/beat/branch graph, the timeline (events + current in-world date),
 * the session-zero charter, and party inventory/treasury. A DM's export (backup or
 * migration) silently lost every one of them. Seed a campaign with all of these plus
 * their intra-campaign references (npc -> faction, branch -> next beat, character-owned
 * inventory item), export it, re-import it, and assert each type survives with fresh
 * ids and every reference remapped to the imported entity — never a stale source id.
 */
describe('campaign import — issue #266 entity types round-trip (e2e)', () => {
  let ctx: TestAppContext;
  let dmAgent: ReturnType<typeof request.agent>;
  let campaignId: number;
  let factionId: number;
  let npcId: number;
  let arcId: number;
  let beat1Id: number;
  let beat2Id: number;
  let characterId: number;
  let exportDoc: Record<string, unknown>;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    dmAgent = request.agent(server);
    await dmAgent.post('/api/v1/auth/setup').send({ username: 'i266-dm', password: 'dm-password-1' });

    const campRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'Full World', description: 'Everything the export used to drop.' });
    campaignId = campRes.body.id;

    // Faction + an NPC that belongs to it (npc.factionId is the cross-ref to remap).
    const facRes = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/factions`)
      .send({ name: 'The Ashen Hand', kind: 'guild', goals: 'Control the docks', dmSecret: 'A demon pulls its strings', reputation: 25 });
    factionId = facRes.body.id;
    const npcRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/npcs`).send({ name: 'Silas', factionId });
    npcId = npcRes.body.id;

    // Timeline: an event + the campaign's current in-world date.
    await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/timeline`)
      .send({ title: 'The Sundering', inWorldDate: '3rd of Flamerule', body: 'The sky cracked.', dmSecret: 'It was the party’s fault' });
    await dmAgent.put(`/api/v1/campaigns/${campaignId}/timeline/calendar`).send({ currentDate: '5th of Flamerule, 1492 DR', note: 'Two moons.' });

    // Storyline graph: an arc with two beats and a branch from beat1 -> beat2
    // (toBeatId is an intra-campaign ref that must remap to the imported beat).
    const arcRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/arcs`).send({ title: 'Rise of the Hand', summary: 'The guild ascends.' });
    arcId = arcRes.body.id;
    const beat1Res = await dmAgent.post(`/api/v1/arcs/${arcId}/beats`).send({ title: 'The Offer', body: 'They approach the party.' });
    beat1Id = beat1Res.body.id;
    const beat2Res = await dmAgent.post(`/api/v1/arcs/${arcId}/beats`).send({ title: 'The Betrayal', body: 'They turn.' });
    beat2Id = beat2Res.body.id;
    await dmAgent.post(`/api/v1/beats/${beat1Id}/branches`).send({ label: 'If the party accepts', toBeatId: beat2Id });

    // Session-zero charter.
    await dmAgent
      .put(`/api/v1/campaigns/${campaignId}/session-zero`)
      .send({ lines: ['harm to children'], veils: ['on-screen torture'], safetyTools: ['X-Card'], houseRules: 'Crits max the first die.', toneAndExpectations: 'Gritty, heroic.' });

    // Inventory: a party-owned item + a character-owned item (characterId remaps), plus treasury.
    const charRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/characters`).send({ name: 'Vesper', className: 'Rogue', level: 4 });
    characterId = charRes.body.id;
    await dmAgent.post(`/api/v1/campaigns/${campaignId}/inventory`).send({ name: 'Guild Signet', qty: 1, ownerType: 'party' });
    await dmAgent.post(`/api/v1/campaigns/${campaignId}/inventory`).send({ name: 'Vesper’s Daggers', qty: 2, ownerType: 'character', characterId });
    // Issue #582: absolute { set } now requires expectedUpdatedAt (CAS). Fetch the
    // current row version first so this setup write is accepted.
    const treasuryBefore = await dmAgent.get(`/api/v1/campaigns/${campaignId}/treasury`);
    await dmAgent.patch(`/api/v1/campaigns/${campaignId}/treasury`).send({ set: { gp: 150, sp: 40 }, expectedUpdatedAt: treasuryBefore.body.updatedAt });

    const exportRes = await dmAgent.get(`/api/v1/campaigns/${campaignId}/export?format=json`);
    exportDoc = exportRes.body;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('export carries every previously-dropped entity type under clear top-level keys', () => {
    expect(Array.isArray(exportDoc.factions)).toBe(true);
    expect((exportDoc.factions as unknown[]).length).toBe(1);
    expect(Array.isArray(exportDoc.storyArcs)).toBe(true);
    expect((exportDoc.storyArcs as { beats: unknown[] }[])[0].beats.length).toBe(2);
    expect(Array.isArray(exportDoc.timelineEvents)).toBe(true);
    expect((exportDoc.timelineEvents as unknown[]).length).toBe(1);
    expect((exportDoc.timelineCalendar as { currentDate: string }).currentDate).toBe('5th of Flamerule, 1492 DR');
    expect((exportDoc.sessionZero as { lines: string[] }).lines).toEqual(['harm to children']);
    expect(Array.isArray(exportDoc.inventory)).toBe(true);
    expect((exportDoc.inventory as unknown[]).length).toBe(2);
    expect((exportDoc.treasury as { gp: number }).gp).toBe(150);
  });

  it('re-imports all of them into a new campaign with fresh ids and remapped references', async () => {
    const res = await dmAgent.post('/api/v1/campaigns/import').send(exportDoc);
    expect(res.status).toBe(201);
    const imported = res.body;
    expect(imported.id).not.toBe(campaignId);

    // Factions: copied with a fresh id, reputation + dmSecret preserved.
    const facs = await dmAgent.get(`/api/v1/campaigns/${imported.id}/factions`);
    expect(facs.body.length).toBe(1);
    const fac = facs.body[0];
    expect(fac.id).not.toBe(factionId);
    expect(fac.name).toBe('The Ashen Hand');
    expect(fac.reputation).toBe(25);
    expect(fac.dmSecret).toBe('A demon pulls its strings');

    // NPC.factionId remapped to the imported faction (not the source id).
    const npcs = await dmAgent.get(`/api/v1/campaigns/${imported.id}/npcs`);
    const silas = npcs.body.find((n: { name: string }) => n.name === 'Silas');
    expect(silas).toBeDefined();
    expect(silas.id).not.toBe(npcId);
    expect(silas.factionId).toBe(fac.id);

    // Storyline graph: arc + both beats copied; the branch's toBeatId remapped to the
    // imported "Betrayal" beat.
    const arcs = await dmAgent.get(`/api/v1/campaigns/${imported.id}/arcs`);
    expect(arcs.body.length).toBe(1);
    const arc = arcs.body[0];
    expect(arc.id).not.toBe(arcId);
    expect(arc.beats.length).toBe(2);
    const offer = arc.beats.find((b: { title: string }) => b.title === 'The Offer');
    const betrayal = arc.beats.find((b: { title: string }) => b.title === 'The Betrayal');
    expect(offer.id).not.toBe(beat1Id);
    expect(betrayal.id).not.toBe(beat2Id);
    expect(offer.branches.length).toBe(1);
    expect(offer.branches[0].label).toBe('If the party accepts');
    expect(offer.branches[0].toBeatId).toBe(betrayal.id);

    // Timeline: event + current in-world date carried over.
    const events = await dmAgent.get(`/api/v1/campaigns/${imported.id}/timeline`);
    expect(events.body.length).toBe(1);
    expect(events.body[0].title).toBe('The Sundering');
    expect(events.body[0].dmSecret).toBe('It was the party’s fault');
    const cal = await dmAgent.get(`/api/v1/campaigns/${imported.id}/timeline/calendar`);
    expect(cal.body.currentDate).toBe('5th of Flamerule, 1492 DR');

    // Session-zero charter preserved.
    const sz = await dmAgent.get(`/api/v1/campaigns/${imported.id}/session-zero`);
    expect(sz.body.lines).toEqual(['harm to children']);
    expect(sz.body.veils).toEqual(['on-screen torture']);
    expect(sz.body.safetyTools).toEqual(['X-Card']);
    expect(sz.body.houseRules).toBe('Crits max the first die.');

    // Inventory: both items copied; the character-owned item's characterId remapped to
    // the imported character. Treasury coins carried over.
    const importedChars = await dmAgent.get(`/api/v1/campaigns/${imported.id}/characters`);
    const vesper = importedChars.body.find((c: { name: string }) => c.name === 'Vesper');
    expect(vesper.id).not.toBe(characterId);
    const inv = await dmAgent.get(`/api/v1/campaigns/${imported.id}/inventory`);
    expect(inv.body.length).toBe(2);
    const partyItem = inv.body.find((i: { name: string }) => i.name === 'Guild Signet');
    const charItem = inv.body.find((i: { name: string }) => i.name === 'Vesper’s Daggers');
    expect(partyItem.ownerType).toBe('party');
    expect(charItem.ownerType).toBe('character');
    expect(charItem.characterId).toBe(vesper.id);
    const treasury = await dmAgent.get(`/api/v1/campaigns/${imported.id}/treasury`);
    expect(treasury.body.gp).toBe(150);
    expect(treasury.body.sp).toBe(40);

    // The source campaign is untouched.
    const sourceFacs = await dmAgent.get(`/api/v1/campaigns/${campaignId}/factions`);
    expect(sourceFacs.body[0].id).toBe(factionId);
  });
});

/**
 * Issue #725 — atomic staged import. A failure at ANY commit boundary must roll
 * the whole import back: no campaign row, no child rows, no audit row, no
 * orphaned attachment files, and no leftover staging directory. The old code
 * wrote DB rows in one transaction but then wrote files / added membership /
 * logged audit AFTER the commit with errors swallowed — so a membership or disk
 * failure could strand a fully-written campaign the importer couldn't even see
 * (no member row) and/or report success with missing maps.
 *
 * This suite injects a deterministic failure at the membership insert (now part
 * of the atomic transaction) and asserts the rollback is total, across both the
 * JSON import (no attachments) and the ZIP import (attachments staged + must be
 * cleaned up). It also confirms the happy path now leaves NO staging directory
 * behind (the publish step consumed it).
 */
describe('campaign import — atomic staged commit (issue #725)', () => {
  let ctx: TestAppContext;
  let dmAgent: ReturnType<typeof request.agent>;
  let dataDir: string;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    dataDir = ctx.dataDir;
    const server = ctx.app.getHttpServer();
    dmAgent = request.agent(server);
    await dmAgent.post('/api/v1/auth/setup').send({ username: 'atomic-dm', password: 'dm-password-1' });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  /** Upload dir entries that exist for `campaignId` (or none when absent). */
  function campaignUploadDir(campaignId: number): string {
    return path.join(dataDir, 'uploads', String(campaignId));
  }

  /** The staging root every import parks bytes under before commit. */
  function stagingRoot(): string {
    return path.join(dataDir, 'uploads', '.staging');
  }

  /** Count campaign rows the DM can list (excludes trashed). */
  async function listCampaignIds(): Promise<number[]> {
    const res = await dmAgent.get('/api/v1/campaigns');
    return (res.body as { id: number }[]).map((c) => c.id);
  }

  it('rolls back the entire import when the membership insert fails (JSON import, no attachments)', async () => {
    // A baseline campaign so the "no new campaign" assertion is meaningful.
    const baseline = await dmAgent.post('/api/v1/campaigns').send({ name: 'Baseline' });
    const idsBefore = await listCampaignIds();
    expect(idsBefore).toContain(baseline.body.id);

    // Inject a failure into the membership commit boundary: the import's
    // addCreatorAsDmTx (now called inside the import transaction) throws, which
    // must roll back every row the transaction inserted. Restored in finally.
    const members = ctx.app.get(MembersService);
    const real = members.addCreatorAsDmTx.bind(members);
    let threw = false;
    members.addCreatorAsDmTx = () => {
      threw = true;
      throw new Error('simulated membership failure at commit boundary');
    };
    try {
      const res = await dmAgent
        .post('/api/v1/campaigns/import')
        .send({ campaign: { name: 'Should Roll Back', description: 'must not persist' }, quests: [], npcs: [], locations: [] });
      // The injected throw surfaces as a 500 (Nest's default for an unhandled Error).
      expect(res.status).toBe(500);
      expect(threw).toBe(true);

      // No new campaign row: the id set is unchanged from before the import.
      const idsAfter = await listCampaignIds();
      expect(idsAfter.sort()).toEqual(idsBefore.sort());

      // No audit row for a rolled-back import (the audit insert shared the tx).
      // There's no campaign to fetch /audit for (the row never committed), so we
      // check indirectly: confirm the campaigns table itself gained no row named
      // "Should Roll Back" — a leaked audit row would imply a leaked campaign too.
      const all = await dmAgent.get('/api/v1/campaigns');
      const leaked = (all.body as { name: string }[]).find((c) => c.name === 'Should Roll Back');
      expect(leaked).toBeUndefined();
    } finally {
      members.addCreatorAsDmTx = real;
    }
  });

  it('stages attachments, and on a mid-commit failure leaves NO campaign rows, NO orphaned files, and NO staging dir', async () => {
    // Build a source campaign with a map, export it as a mdzip, so the import
    // has real attachment bytes to stage.
    const src = await dmAgent.post('/api/v1/campaigns').send({ name: 'Zip Source For Rollback' });
    const srcId = src.body.id;
    const mapUpload = await dmAgent
      .post(`/api/v1/campaigns/${srcId}/attachments`)
      .field('kind', 'map')
      .attach('file', TINY_PNG, { filename: 'overworld.png', contentType: 'image/png' });
    await dmAgent.patch(`/api/v1/campaigns/${srcId}`).send({ mapAttachmentId: mapUpload.body.id });

    const zipRes = await getBuffer(dmAgent, `/api/v1/campaigns/${srcId}/export?format=mdzip`);
    expect(zipRes.status).toBe(200);
    const zipBuffer = zipRes.body as Buffer;

    const idsBefore = await listCampaignIds();
    // Snapshot which campaign upload dirs exist before the import, so we can
    // prove no NEW dir was created (no orphaned files for a rolled-back campaign).
    const dirsBefore = new Set(
      fs.existsSync(path.join(dataDir, 'uploads'))
        ? fs.readdirSync(path.join(dataDir, 'uploads'))
        : [],
    );

    // Inject the membership failure again — this time with staged attachment
    // bytes in play. The rollback must clean up BOTH the DB rows AND the
    // staging directory.
    const members = ctx.app.get(MembersService);
    const real = members.addCreatorAsDmTx.bind(members);
    members.addCreatorAsDmTx = () => {
      throw new Error('simulated membership failure at commit boundary (zip)');
    };
    try {
      const res = await dmAgent
        .post('/api/v1/campaigns/import/archive')
        .attach('file', zipBuffer, { filename: 'export.zip', contentType: 'application/zip' });
      expect(res.status).toBe(500);

      // No new campaign row.
      const idsAfter = await listCampaignIds();
      expect(idsAfter.sort()).toEqual(idsBefore.sort());

      // No new campaign upload directory was created (the staged bytes were
      // cleaned up, never published, because the tx rolled back).
      const dirsAfter = new Set(
        fs.existsSync(path.join(dataDir, 'uploads'))
          ? fs.readdirSync(path.join(dataDir, 'uploads'))
          : [],
      );
      const newDirs = [...dirsAfter].filter((d) => !dirsBefore.has(d));
      // The only acceptable "new" dir is the staging root itself; it must be EMPTY
      // (cleanup removed the nonce subdir).
      for (const d of newDirs) {
        if (d === '.staging') {
          const entries = fs.existsSync(stagingRoot()) ? fs.readdirSync(stagingRoot()) : [];
          expect(entries.length).toBe(0);
        } else {
          // No new <campaignId> upload dir — that would mean files were published
          // for a campaign whose rows just rolled back.
          expect(Number.isInteger(Number(d))).toBe(false);
        }
      }

      // The staging directory itself should be empty (every nonce subdir removed).
      if (fs.existsSync(stagingRoot())) {
        expect(fs.readdirSync(stagingRoot()).length).toBe(0);
      }
    } finally {
      members.addCreatorAsDmTx = real;
    }

    // Sanity: the source campaign's own upload dir is untouched by the failed import.
    expect(fs.existsSync(campaignUploadDir(srcId))).toBe(true);
  });

  it('on a SUCCESSFUL zip import, publishes staged files and leaves NO staging directory behind', async () => {
    const src = await dmAgent.post('/api/v1/campaigns').send({ name: 'Zip Source For Success' });
    const srcId = src.body.id;
    const mapUpload = await dmAgent
      .post(`/api/v1/campaigns/${srcId}/attachments`)
      .field('kind', 'map')
      .attach('file', TINY_PNG, { filename: 'overworld.png', contentType: 'image/png' });
    await dmAgent.patch(`/api/v1/campaigns/${srcId}`).send({ mapAttachmentId: mapUpload.body.id });

    const zipRes = await getBuffer(dmAgent, `/api/v1/campaigns/${srcId}/export?format=mdzip`);
    const zipBuffer = zipRes.body as Buffer;

    const importRes = await dmAgent
      .post('/api/v1/campaigns/import/archive')
      .attach('file', zipBuffer, { filename: 'export.zip', contentType: 'application/zip' });
    expect(importRes.status).toBe(201);
    const imported = importRes.body;
    expect(imported.id).not.toBe(srcId);

    // The map file was published (staged -> renamed into the campaign's uploads dir).
    const mapFile = await getBuffer(dmAgent, `/api/v1/attachments/${imported.mapAttachmentId}/file`);
    expect(mapFile.status).toBe(200);
    expect(Buffer.compare(mapFile.body as Buffer, TINY_PNG)).toBe(0);

    // The staging directory is empty / gone after a successful publish — every
    // staged file was renamed away (consumed), then the dir was swept.
    if (fs.existsSync(stagingRoot())) {
      expect(fs.readdirSync(stagingRoot()).length).toBe(0);
    }
  });
});
