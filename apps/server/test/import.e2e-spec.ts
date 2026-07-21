import request from 'supertest';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';

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
    const charRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/characters`).send({ name: 'Rogue', className: 'Thief', level: 3 });
    characterId = charRes.body.id;
    const encRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/encounters`).send({ name: 'Vault Guards' });
    await dmAgent.post(`/api/v1/encounters/${encRes.body.id}/combatants`).send({ kind: 'monster', name: 'Guard', hpMax: 11 });
    await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/notes`)
      .send({ body: 'Quest intel for the party', visibility: 'party_shared', entityType: 'quest', entityId: questId });

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
    const q = importedQuests.body[0];
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
