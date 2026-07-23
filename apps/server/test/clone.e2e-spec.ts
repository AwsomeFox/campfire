import request from 'supertest';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';

const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108020000009077' +
    '53de0000000c4944415408d763f8ffff3f0005fe02fea1399e1e0000000049454e44ae426082',
  'hex',
);

/**
 * Issue #17 — campaign templates / cloning.
 * POST /campaigns/:id/clone duplicates a campaign ('full', default) or copies
 * prep only ('template'). Cross-references (quest giver, npc location, note
 * entity links, currentLocationId, combatant character) must be remapped to
 * the cloned rows' new ids, and members are never copied — only the caller
 * becomes the clone's dm.
 */
describe('campaign clone (e2e, real cookie sessions)', () => {
  let ctx: TestAppContext;
  let dmAgent: ReturnType<typeof request.agent>;
  let playerAgent: ReturnType<typeof request.agent>;
  let campaignId: number;
  let locationId: number;
  let factionId: number;
  let npcId: number;
  let questId: number;
  let sessionId: number;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    dmAgent = request.agent(server);
    await dmAgent.post('/api/v1/auth/setup').send({ username: 'clone-dm', password: 'dm-password-1' });

    const createPlayer = await dmAgent.post('/api/v1/users').send({ username: 'clone-player', password: 'player-password-1', serverRole: 'user' });
    const playerId = createPlayer.body.id;

    playerAgent = request.agent(server);
    await playerAgent.post('/api/v1/auth/login').send({ username: 'clone-player', password: 'player-password-1' });

    const campRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'Origin Campaign', description: 'The one true prep.' });
    campaignId = campRes.body.id;
    await dmAgent.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: playerId, role: 'player' });

    // World prep with cross-references: location <- npc <- quest (giver).
    const locRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/locations`).send({ name: 'Old Keep', dmSecret: 'haunted' });
    locationId = locRes.body.id;
    await dmAgent.post(`/api/v1/locations/${locationId}/discover`).send({ status: 'explored' });
    await dmAgent.patch(`/api/v1/campaigns/${campaignId}`).send({ currentLocationId: locationId });

    const factionRes = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/factions`)
      .send({ name: 'Harbor Guild', kind: 'guild', goals: 'Control the docks', dmSecret: 'front for smugglers' });
    expect(factionRes.status).toBe(201);
    factionId = factionRes.body.id;

    const npcRes = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/npcs`)
      .send({ name: 'Bartender', locationId, factionId, dmSecret: 'secretly a lich' });
    npcId = npcRes.body.id;

    const questRes = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/quests`)
      .send({ title: 'Main Quest', giverNpcId: npcId, dmSecret: 'the mayor did it' });
    questId = questRes.body.id;
    const objRes = await dmAgent.post(`/api/v1/quests/${questId}/objectives`).send({ text: 'Find the culprit' });
    await dmAgent.patch(`/api/v1/quests/${questId}/objectives/${objRes.body.id}`).send({ done: true });
    await dmAgent.post(`/api/v1/quests/${questId}/status`).send({ status: 'active' });

    // Play state: session, character, encounter+combatant, notes.
    const session = await dmAgent.post(`/api/v1/campaigns/${campaignId}/sessions`).send({ number: 1, recap: 'The party arrived.' });
    sessionId = session.body.id;
    await dmAgent
      .post(`/api/v1/sessions/${sessionId}/shares`)
      .send({ label: 'Original-only capability', expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() });
    const portraitUpload = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/attachments`)
      .field('kind', 'portrait')
      .attach('file', TINY_PNG, { filename: 'hero.png', contentType: 'image/png' });
    expect(portraitUpload.status).toBe(201);
    const portraitUrl = `/api/v1/attachments/${portraitUpload.body.id}/file`;
    const hero = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .send({ name: 'Hero', className: 'Fighter', ownerUserId: playerId, portraitUrl });
    const remoteHero = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .send({
        name: 'Remote Voice',
        className: 'Bard',
        ownerUserId: playerId,
        portraitUrl: 'https://images.example.test/remote-voice.png',
      });
    // Issue #864: clone must remap encounter location/quest/session links into the
    // new campaign (never copy raw source ids that would become cross-campaign).
    const encRes = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/encounters`)
      .send({ name: 'Goblin Ambush', locationId, questId, sessionId });
    await dmAgent.post(`/api/v1/encounters/${encRes.body.id}/combatants`).send({ kind: 'monster', name: 'Goblin', hpMax: 7 });

    await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/notes`)
      .send({ body: 'Shared quest intel', visibility: 'party_shared', entityType: 'quest', entityId: questId });
    await playerAgent
      .post(`/api/v1/campaigns/${campaignId}/notes`)
      .send({ body: 'My private player diary', visibility: 'private' });
    const comment = await playerAgent
      .post(`/api/v1/campaigns/${campaignId}/comments`)
      .send({
        entityType: 'session',
        entityId: session.body.id,
        body: 'Hero speaks in the source campaign.',
        inCharacter: true,
        characterId: hero.body.id,
      });
    expect(comment.status).toBe(201);
    expect(comment.body.characterAvatarUrl).toBe(portraitUrl);
    const remoteComment = await playerAgent
      .post(`/api/v1/campaigns/${campaignId}/comments`)
      .send({
        entityType: 'session',
        entityId: session.body.id,
        body: 'Remote portrait voice.',
        inCharacter: true,
        characterId: remoteHero.body.id,
      });
    expect(remoteComment.status).toBe(201);
    expect(remoteComment.body.characterAvatarUrl).toBe('https://images.example.test/remote-voice.png');
    await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/comments`)
      .send({ entityType: 'session', entityId: session.body.id, parentId: comment.body.id, body: 'A threaded reply.' });
    const factionComment = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/comments`)
      .send({ entityType: 'faction', entityId: factionId, body: 'Faction intrigue stays on clone.' });
    expect(factionComment.status).toBe(201);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('full clone duplicates everything with references remapped', async () => {
    const res = await dmAgent.post(`/api/v1/campaigns/${campaignId}/clone`).send({});
    expect(res.status).toBe(201);
    const clone = res.body;
    expect(clone.id).not.toBe(campaignId);
    expect(clone.name).toBe('Origin Campaign (copy)');
    expect(clone.description).toBe('The one true prep.');
    expect(clone.sessionCount).toBe(1);
    expect(clone.mapAttachmentId).toBeNull();
    expect(clone.publicRecapSharingEnabled).toBe(true);

    // Locations copied (status preserved), currentLocationId remapped to the cloned row.
    const locs = await dmAgent.get(`/api/v1/campaigns/${clone.id}/locations`);
    expect(locs.body.length).toBe(1);
    expect(locs.body[0].id).not.toBe(locationId);
    expect(locs.body[0].name).toBe('Old Keep');
    expect(locs.body[0].status).toBe('explored');
    expect(locs.body[0].dmSecret).toBe('haunted');
    expect(clone.currentLocationId).toBe(locs.body[0].id);

    // NPCs copied with locationId remapped.
    const clonedFactions = await dmAgent.get(`/api/v1/campaigns/${clone.id}/factions`);
    expect(clonedFactions.body.length).toBe(1);
    expect(clonedFactions.body[0].id).not.toBe(factionId);
    expect(clonedFactions.body[0].name).toBe('Harbor Guild');
    expect(clonedFactions.body[0].dmSecret).toBe('front for smugglers');

    const clonedNpcs = await dmAgent.get(`/api/v1/campaigns/${clone.id}/npcs`);
    expect(clonedNpcs.body.length).toBe(1);
    expect(clonedNpcs.body[0].id).not.toBe(npcId);
    expect(clonedNpcs.body[0].locationId).toBe(locs.body[0].id);
    expect(clonedNpcs.body[0].factionId).toBe(clonedFactions.body[0].id);
    expect(clonedNpcs.body[0].dmSecret).toBe('secretly a lich');

    // Quests copied with giverNpcId remapped, status + objectives preserved.
    const clonedQuests = await dmAgent.get(`/api/v1/campaigns/${clone.id}/quests`);
    expect(clonedQuests.body.length).toBe(1);
    const qListItem = clonedQuests.body[0];
    const clonedQuest = await dmAgent.get(`/api/v1/quests/${qListItem.id}`);
    expect(clonedQuest.status).toBe(200);
    const q = clonedQuest.body;
    expect(q.id).not.toBe(questId);
    expect(q.status).toBe('active');
    expect(q.dmSecret).toBe('the mayor did it');
    expect(q.giverNpcId).toBe(clonedNpcs.body[0].id);
    expect(q.objectives.length).toBe(1);
    expect(q.objectives[0].done).toBe(true);

    // Sessions and characters copied.
    const sessions = await dmAgent.get(`/api/v1/campaigns/${clone.id}/sessions`);
    expect(sessions.body.length).toBe(1);
    // The list is list-shape now (issue #71): a recapExcerpt, not the full recap
    // body — for this short recap the excerpt is the whole thing.
    expect(sessions.body[0].recapExcerpt).toBe('The party arrived.');
    expect(sessions.body[0].recap).toBeUndefined();
    // Capability secrets/audit state are never cloned, even for a full clone.
    const clonedShares = await dmAgent.get(`/api/v1/sessions/${sessions.body[0].id}/shares`);
    expect(clonedShares.body).toEqual([]);
    const chars = await dmAgent.get(`/api/v1/campaigns/${clone.id}/characters`);
    expect(chars.body.length).toBe(2);
    const clonedHero = chars.body.find((c: { name: string }) => c.name === 'Hero');
    const clonedRemote = chars.body.find((c: { name: string }) => c.name === 'Remote Voice');
    expect(clonedHero).toBeDefined();
    expect(clonedRemote).toBeDefined();

    // Encounters copied with combatants (Hero + Remote Voice were auto-added on
    // encounter create, so there are 3). The character combatant's characterId
    // must be remapped to the cloned character. Location/quest/session links
    // (issue #864) must also remap into the clone — never keep the source
    // campaign's ids.
    const encs = await dmAgent.get(`/api/v1/campaigns/${clone.id}/encounters`);
    expect(encs.body.length).toBe(1);
    const encDetail = await dmAgent.get(`/api/v1/encounters/${encs.body[0].id}`);
    expect(encDetail.body.locationId).toBe(locs.body[0].id);
    expect(encDetail.body.questId).toBe(q.id);
    expect(encDetail.body.sessionId).toBe(sessions.body[0].id);
    expect(encDetail.body.locationId).not.toBe(locationId);
    expect(encDetail.body.questId).not.toBe(questId);
    expect(encDetail.body.sessionId).not.toBe(sessionId);
    expect(encDetail.body.combatants.length).toBe(3);
    // Issue #548: cloned encounters are fresh prep, not a snapshot of live combat.
    expect(encDetail.body.status).toBe('preparing');
    expect(encDetail.body.round).toBe(0);
    expect(encDetail.body.turnIndex).toBe(0);
    expect(encDetail.body.currentCombatantId).toBeNull();
    expect(encDetail.body.endedAt).toBeNull();
    const goblin = encDetail.body.combatants.find((c: { name: string }) => c.name === 'Goblin');
    expect(goblin).toBeDefined();
    if (goblin === undefined) {
      throw new Error('expected Goblin combatant on cloned encounter');
    }
    expect(goblin.hpCurrent).toBe(goblin.hpMax);
    expect(goblin.conditions).toEqual([]);
    const hero = encDetail.body.combatants.find((c: { name: string }) => c.name === 'Hero');
    expect(hero.kind).toBe('character');
    expect(hero.characterId).toBe(clonedHero.id);

    // Notes: shared note copied with its entity link remapped to the cloned
    // quest; the player's private note (invisible to the dm) is not carried over.
    const clonedNotes = await dmAgent.get(`/api/v1/campaigns/${clone.id}/notes`);
    const bodies = clonedNotes.body.map((n: { body: string }) => n.body);
    expect(bodies).toContain('Shared quest intel');
    expect(bodies).not.toContain('My private player diary');
    const shared = clonedNotes.body.find((n: { body: string }) => n.body === 'Shared quest intel');
    expect(shared.entityType).toBe('quest');
    expect(shared.entityId).toBe(q.id);

    // Discussion history is copied in full mode: anchor, parent, and live
    // character ids remap. Attachment-backed avatars are dropped (attachments
    // are not cloned); safe remote HTTPS portraits are preserved.
    const clonedComments = await dmAgent
      .get(`/api/v1/campaigns/${clone.id}/comments`)
      .query({ entityType: 'session', entityId: sessions.body[0].id });
    expect(clonedComments.status).toBe(200);
    expect(clonedComments.body).toHaveLength(3);
    const spoken = clonedComments.body.find((c: { body: string }) => c.body === 'Hero speaks in the source campaign.');
    const remoteSpoken = clonedComments.body.find((c: { body: string }) => c.body === 'Remote portrait voice.');
    const reply = clonedComments.body.find((c: { body: string }) => c.body === 'A threaded reply.');
    expect(spoken).toMatchObject({
      characterId: clonedHero.id,
      characterName: 'Hero',
      inCharacter: true,
      characterAvatarUrl: null,
    });
    expect(remoteSpoken).toMatchObject({
      characterId: clonedRemote.id,
      characterName: 'Remote Voice',
      inCharacter: true,
      characterAvatarUrl: 'https://images.example.test/remote-voice.png',
    });
    expect(reply.parentId).toBe(spoken.id);

    // Faction-anchored discussion must remap through factionMap (not be dropped).
    const clonedFactionComments = await dmAgent
      .get(`/api/v1/campaigns/${clone.id}/comments`)
      .query({ entityType: 'faction', entityId: clonedFactions.body[0].id });
    expect(clonedFactionComments.status).toBe(200);
    expect(clonedFactionComments.body).toHaveLength(1);
    expect(clonedFactionComments.body[0]).toMatchObject({
      entityType: 'faction',
      entityId: clonedFactions.body[0].id,
      body: 'Faction intrigue stays on clone.',
    });

    // Members are NOT copied — the source player has no access to the clone.
    const playerView = await playerAgent.get(`/api/v1/campaigns/${clone.id}`);
    expect(playerView.status).toBe(403);
  });

  it('full clone resets running and ended encounter combat state (issue #548)', async () => {
    const endedRes = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/encounters`)
      .send({ name: 'Finished skirmish' });
    expect(endedRes.status).toBe(201);
    const endedId = endedRes.body.id;
    expect((await dmAgent.post(`/api/v1/encounters/${endedId}/roll-initiative`)).status).toBe(201);
    expect((await dmAgent.post(`/api/v1/encounters/${endedId}/start`)).status).toBe(201);
    const endedFight = await dmAgent.post(`/api/v1/encounters/${endedId}/end`);
    expect(endedFight.status).toBe(201);
    expect(endedFight.body.status).toBe('ended');
    expect(endedFight.body.endedAt).not.toBeNull();

    const runningRes = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/encounters`)
      .send({ name: 'Mid-fight brawl' });
    expect(runningRes.status).toBe(201);
    const runningId = runningRes.body.id;
    const brawler = await dmAgent
      .post(`/api/v1/encounters/${runningId}/combatants`)
      .send({ kind: 'monster', name: 'Brawler', hpMax: 30 });
    expect(brawler.status).toBe(201);
    expect((await dmAgent.post(`/api/v1/encounters/${runningId}/roll-initiative`)).status).toBe(201);
    expect((await dmAgent.post(`/api/v1/encounters/${runningId}/start`)).status).toBe(201);
    // Three combatants (party auto-adds) — six next-turn advances wrap to round 3.
    for (let i = 0; i < 6; i++) {
      const nextTurn = await dmAgent.post(`/api/v1/encounters/${runningId}/next-turn`);
      expect(nextTurn.status).toBe(201);
    }
    const midFight = await dmAgent.get(`/api/v1/encounters/${runningId}`);
    expect(midFight.body.status).toBe('running');
    expect(midFight.body.round).toBe(3);
    const brawlerPatch = await dmAgent
      .patch(`/api/v1/encounters/${runningId}/combatants/${brawler.body.id}`)
      .send({ hpSet: 4, addConditions: ['prone'] });
    expect(brawlerPatch.status).toBe(200);
    const afterPatch = await dmAgent.get(`/api/v1/encounters/${runningId}`);
    const sourceBrawler = afterPatch.body.combatants.find((c: { name: string }) => c.name === 'Brawler');
    expect(sourceBrawler).toBeDefined();
    expect(sourceBrawler.hpCurrent).toBe(4);
    expect(sourceBrawler.conditions).toEqual(['prone']);

    const cloneRes = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/clone`)
      .send({ name: 'Sequel arc' });
    expect(cloneRes.status).toBe(201);
    const cloneId = cloneRes.body.id;

    const encs = await dmAgent.get(`/api/v1/campaigns/${cloneId}/encounters`);
    const clonedRunning = encs.body.find((e: { name: string }) => e.name === 'Mid-fight brawl');
    const clonedEnded = encs.body.find((e: { name: string }) => e.name === 'Finished skirmish');
    expect(clonedRunning).toBeDefined();
    expect(clonedEnded).toBeDefined();

    const runningDetail = await dmAgent.get(`/api/v1/encounters/${clonedRunning.id}`);
    expect(runningDetail.body.status).toBe('preparing');
    expect(runningDetail.body.round).toBe(0);
    expect(runningDetail.body.turnIndex).toBe(0);
    expect(runningDetail.body.currentCombatantId).toBeNull();
    expect(runningDetail.body.endedAt).toBeNull();
    const clonedBrawler = runningDetail.body.combatants.find((c: { name: string }) => c.name === 'Brawler');
    expect(clonedBrawler).toBeDefined();
    if (clonedBrawler === undefined) {
      throw new Error('expected Brawler combatant on cloned encounter');
    }
    expect(clonedBrawler.hpCurrent).toBe(30);
    expect(clonedBrawler.hpMax).toBe(30);
    expect(clonedBrawler.conditions).toEqual([]);
    expect(clonedBrawler.initiative).toBeNull();

    const endedDetail = await dmAgent.get(`/api/v1/encounters/${clonedEnded.id}`);
    expect(endedDetail.body.status).toBe('preparing');
    expect(endedDetail.body.endedAt).toBeNull();
    expect(endedDetail.body.round).toBe(0);
  });

  it('template clone copies prep only and resets play state', async () => {
    const res = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/clone`)
      .send({ name: 'Fresh Start', mode: 'template' });
    expect(res.status).toBe(201);
    const clone = res.body;
    expect(clone.name).toBe('Fresh Start');
    expect(clone.sessionCount).toBe(0);
    expect(clone.status).toBe('active');
    expect(clone.currentLocationId).toBeNull();

    // Prep copied, progress reset.
    const locs = await dmAgent.get(`/api/v1/campaigns/${clone.id}/locations`);
    expect(locs.body.length).toBe(1);
    expect(locs.body[0].status).toBe('unexplored');
    const clonedNpcs = await dmAgent.get(`/api/v1/campaigns/${clone.id}/npcs`);
    expect(clonedNpcs.body.length).toBe(1);
    expect(clonedNpcs.body[0].locationId).toBe(locs.body[0].id);
    const clonedFactions = await dmAgent.get(`/api/v1/campaigns/${clone.id}/factions`);
    expect(clonedFactions.body.length).toBe(1);
    expect(clonedNpcs.body[0].factionId).toBe(clonedFactions.body[0].id);
    const clonedQuests = await dmAgent.get(`/api/v1/campaigns/${clone.id}/quests`);
    expect(clonedQuests.body.length).toBe(1);
    expect(clonedQuests.body[0].status).toBe('available');
    const clonedQuest = await dmAgent.get(`/api/v1/quests/${clonedQuests.body[0].id}`);
    expect(clonedQuest.status).toBe(200);
    expect(clonedQuest.body.objectives.length).toBe(1);
    expect(clonedQuest.body.objectives[0].done).toBe(false);

    // Play state stripped.
    const sessions = await dmAgent.get(`/api/v1/campaigns/${clone.id}/sessions`);
    expect(sessions.body.length).toBe(0);
    const chars = await dmAgent.get(`/api/v1/campaigns/${clone.id}/characters`);
    expect(chars.body.length).toBe(0);
    const encs = await dmAgent.get(`/api/v1/campaigns/${clone.id}/encounters`);
    expect(encs.body.length).toBe(0);
    const clonedNotes = await dmAgent.get(`/api/v1/campaigns/${clone.id}/notes`);
    expect(clonedNotes.body.length).toBe(0);
  });

  it('full clone preserves encounter hidden flag (issue #262)', async () => {
    const hiddenEnc = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/encounters`)
      .send({ name: 'Surprise ambush prep', hidden: true });
    expect(hiddenEnc.status).toBe(201);

    const cloneRes = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/clone`)
      .send({ name: 'Hidden encounter copy probe' });
    expect(cloneRes.status).toBe(201);

    const encs = await dmAgent.get(`/api/v1/campaigns/${cloneRes.body.id}/encounters`);
    const clonedHidden = encs.body.find((e: { name: string }) => e.name === 'Surprise ambush prep');
    expect(clonedHidden).toBeDefined();
    const detail = await dmAgent.get(`/api/v1/encounters/${clonedHidden.id}`);
    expect(detail.body.hidden).toBe(true);
  });

  it('403 for player (non-dm) on the source campaign', async () => {
    const res = await playerAgent.post(`/api/v1/campaigns/${campaignId}/clone`).send({});
    expect(res.status).toBe(403);
  });

  it('400 on an unknown mode', async () => {
    const res = await dmAgent.post(`/api/v1/campaigns/${campaignId}/clone`).send({ mode: 'partial' });
    expect(res.status).toBe(400);
  });
});
