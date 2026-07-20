import request from 'supertest';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';

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
