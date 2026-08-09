import request from 'supertest';
import { eq } from 'drizzle-orm';
import { DB, type DrizzleDb } from '../src/db/db.module';
import { combatants } from '../src/db/schema';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';

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
 * Issue #17 — campaign templates / cloning.
 * POST /campaigns/:id/clone duplicates a campaign ('full', default) or copies
 * prep only ('template'). Cross-references (quest giver, npc location, note
 * entity links, currentLocationId, combatant character) must be remapped to
 * the cloned rows' new ids, and members are never copied — only the caller
 * becomes the clone's dm.
 *
 * Issue #524 — full clone must copy every character column (xp/skills/actions/…)
 * and remap portraitUrl to a freshly copied attachment under the clone.
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
  let heroId: number;
  let portraitAttachmentId: number;
  let sourcePortraitUrl: string;

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
      .send({ name: 'Bartender', locationId, factionId, disposition: 'hostile', dmSecret: 'secretly a lich' });
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
    portraitAttachmentId = portraitUpload.body.id;
    sourcePortraitUrl = `/api/v1/attachments/${portraitAttachmentId}/file`;
    const hero = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .send({ name: 'Hero', className: 'Fighter', status: 'active', ownerUserId: playerId, portraitUrl: sourcePortraitUrl });
    expect(hero.status).toBe(201);
    heroId = hero.body.id;
    const remoteHero = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .send({
        name: 'Remote Voice',
        className: 'Bard',
        status: 'active',
        ownerUserId: playerId,
        portraitUrl: 'https://images.example.test/remote-voice.png',
      });
    // Issue #864: clone must remap encounter location/quest/session links into the
    // new campaign (never copy raw source ids that would become cross-campaign).
    const encRes = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/encounters`)
      .send({ name: 'Goblin Ambush', locationId, questId, sessionId });
    await dmAgent.post(`/api/v1/encounters/${encRes.body.id}/combatants`).send({ kind: 'monster', name: 'Goblin', hpMax: 7 });
    const npcCombatant = await dmAgent
      .post(`/api/v1/encounters/${encRes.body.id}/combatants`)
      .send({ kind: 'npc', npcId, hpMax: 10 });
    expect(npcCombatant.status).toBe(201);
    expect(npcCombatant.body.npcDispositionSnapshot).toBe('hostile');
    const npcDuplicate = await dmAgent
      .post(`/api/v1/encounters/${encRes.body.id}/combatants`)
      .send({ kind: 'npc', name: 'Bartender Echo', hpMax: 10, duplicateOfCombatantId: npcCombatant.body.id });
    expect(npcDuplicate.status).toBe(201);

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
    expect(comment.body.characterAvatarUrl).toBe(sourcePortraitUrl);
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
    // Issue #524: seed non-default character columns that previously silently
    // reset to schema defaults on clone. Patch after fixture setup so encounter
    // auto-add still saw an active Hero; restore at the end for later tests.
    const heroPatch = await dmAgent.patch(`/api/v1/characters/${heroId}`).send({
      species: 'Dwarf',
      className: 'Fighter',
      level: 5,
      xp: 6500,
      background: 'Soldier',
      status: 'retired',
      stats: { STR: 16, DEX: 12, CON: 14, INT: 10, WIS: 11, CHA: 8 },
      ac: 18,
      hpMax: 44,
      hpCurrent: 30,
      conditions: ['exhaustion'],
      saveProficiencies: ['STR', 'CON'],
      skills: { Athletics: 'proficient', Perception: 'expertise' },
      actions: [{ name: 'Second Wind', kind: 'feature', notes: '1d10+5' }],
      spellSlots: { '1': { max: 4, used: 1 } },
      notes: 'A weary veteran.',
      dmSecret: 'cursed axe whispers at night',
      ddbId: 'ddb-hero-524',
    });
    expect(heroPatch.status).toBe(200);
    // deathState is not on the general PATCH path — drop HP to 0 so the sheet
    // echoes 'dying' (#711) and clone must carry that non-default value too.
    const hpDrop = await dmAgent.post(`/api/v1/characters/${heroId}/hp`).send({ set: 0 });
    expect(hpDrop.status).toBe(201);
    expect(hpDrop.body.deathState).toBe('dying');
    const sourceHero = (await dmAgent.get(`/api/v1/characters/${heroId}`)).body;
    // The clone begins a new encounter, so its NPC combatant must use this
    // current allegiance rather than the historical hostile snapshot.
    const npcPatch = await dmAgent.patch(`/api/v1/npcs/${npcId}`).send({ disposition: 'friendly' });
    expect(npcPatch.status).toBe(200);

    try {
      const res = await dmAgent.post(`/api/v1/campaigns/${campaignId}/clone`).send({});
      expect(res.status).toBe(201);
      const clone = res.body;
      expect(clone.id).not.toBe(campaignId);
      expect(clone.name).toBe('Origin Campaign (copy)');
      expect(clone.description).toBe('The one true prep.');
      expect(clone.sessionCount).toBe(1);
      expect(clone.latestSessionNumber).toBe(1);
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
      expect(clonedNpcs.body[0].disposition).toBe('friendly');
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

      // Issue #524: every NOT NULL character column round-trips (not schema defaults).
      expect(clonedHero).toMatchObject({
        species: sourceHero.species,
        className: sourceHero.className,
        level: sourceHero.level,
        xp: sourceHero.xp,
        background: sourceHero.background,
        status: sourceHero.status,
        stats: sourceHero.stats,
        ac: sourceHero.ac,
        hpCurrent: sourceHero.hpCurrent,
        hpMax: sourceHero.hpMax,
        hpTemp: sourceHero.hpTemp,
        deathState: sourceHero.deathState,
        deathSaveSuccesses: sourceHero.deathSaveSuccesses,
        deathSaveFailures: sourceHero.deathSaveFailures,
        conditions: sourceHero.conditions,
        saveProficiencies: sourceHero.saveProficiencies,
        skills: sourceHero.skills,
        actions: sourceHero.actions,
        spellSlots: sourceHero.spellSlots,
        ddbId: sourceHero.ddbId,
        notes: sourceHero.notes,
        dmSecret: sourceHero.dmSecret,
      });
      expect(clonedHero.xp).toBe(6500);
      expect(clonedHero.status).toBe('retired');
      expect(clonedHero.deathState).toBe('dying');
      expect(clonedHero.dmSecret).toBe('cursed axe whispers at night');
      expect(clonedHero.saveProficiencies).toEqual(['STR', 'CON']);
      expect(clonedHero.skills).toEqual({ Athletics: 'proficient', Perception: 'expertise' });
      expect(clonedHero.spellSlots).toEqual({ '1': { max: 4, used: 1 } });

      // Issue #524: portraitUrl remaps to a NEW attachment under the clone (bytes copied).
      expect(clonedHero.portraitUrl).toBeTruthy();
      expect(clonedHero.portraitUrl).not.toBe(sourcePortraitUrl);
      expect(clonedHero.portraitUrl).not.toContain(`/attachments/${portraitAttachmentId}/file`);
      const portraitMatch = String(clonedHero.portraitUrl).match(/\/attachments\/(\d+)\/file$/);
      expect(portraitMatch).not.toBeNull();
      const clonedPortraitId = Number(portraitMatch![1]);
      expect(clonedPortraitId).not.toBe(portraitAttachmentId);
      const cloneAtts = await dmAgent.get(`/api/v1/campaigns/${clone.id}/attachments`);
      expect(cloneAtts.status).toBe(200);
      expect(cloneAtts.body.some((a: { id: number }) => a.id === clonedPortraitId)).toBe(true);
      const portraitFile = await getBuffer(dmAgent, `/api/v1/attachments/${clonedPortraitId}/file`);
      expect(portraitFile.status).toBe(200);
      expect(Buffer.compare(portraitFile.body as Buffer, TINY_PNG)).toBe(0);
      // Remote HTTPS portraits stay as-is (no attachment remap).
      expect(clonedRemote.portraitUrl).toBe('https://images.example.test/remote-voice.png');

      // Encounters copied with combatants (Hero + Remote Voice were auto-added on
      // encounter create, so there are 5). The character combatant's characterId
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
      expect(encDetail.body.combatants.length).toBe(5);
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
      const bartender = encDetail.body.combatants.find((c: { name: string }) => c.name === 'Bartender');
      expect(bartender).toBeDefined();
      expect(bartender.npcDispositionSnapshot).toBeNull();
      const bartenderEcho = encDetail.body.combatants.find((c: { name: string }) => c.name === 'Bartender Echo');
      expect(bartenderEcho).toBeDefined();
      const db = ctx.app.get<DrizzleDb>(DB);
      const clonedDuplicate = await db.select().from(combatants).where(eq(combatants.id, bartenderEcho.id)).get();
      expect(clonedDuplicate?.npcIdentitySourceId).toBe(clonedNpcs.body[0].id);
      const hero = encDetail.body.combatants.find((c: { name: string }) => c.name === 'Hero');
      expect(hero.kind).toBe('character');
      expect(hero.characterId).toBe(clonedHero.id);

      // A clone starts as fresh prep, then captures its own NPC allegiance when
      // play begins. Later world edits must not rewrite the completed fight's XP.
      expect((await dmAgent.patch(`/api/v1/npcs/${clonedNpcs.body[0].id}`).send({ disposition: 'hostile' })).status).toBe(200);
      expect((await dmAgent.post(`/api/v1/encounters/${encDetail.body.id}/roll-initiative`)).status).toBe(201);
      const cloneStart = await dmAgent.post(`/api/v1/encounters/${encDetail.body.id}/start`);
      expect(cloneStart.status).toBe(201);
      expect(cloneStart.body.combatants.find((c: { name: string }) => c.name === 'Bartender').npcDispositionSnapshot).toBe('hostile');
      expect(cloneStart.body.combatants.find((c: { name: string }) => c.name === 'Bartender Echo').npcDispositionSnapshot).toBe('hostile');
      const difficultyAtStart = await dmAgent.get(`/api/v1/encounters/${encDetail.body.id}/difficulty`);
      expect(difficultyAtStart.status).toBe(200);
      expect((await dmAgent.patch(`/api/v1/npcs/${clonedNpcs.body[0].id}`).send({ disposition: 'friendly' })).status).toBe(200);
      expect((await dmAgent.post(`/api/v1/encounters/${encDetail.body.id}/end`)).status).toBe(201);
      const difficultyAfterNpcMutation = await dmAgent.get(`/api/v1/encounters/${encDetail.body.id}/difficulty`);
      expect(difficultyAfterNpcMutation.body).toMatchObject({
        monsterCount: difficultyAtStart.body.monsterCount,
        totalMonsterXp: difficultyAtStart.body.totalMonsterXp,
      });

      // Notes: shared note copied with its entity link remapped to the cloned
      // quest; the player's private note (invisible to the dm) is not carried over.
      const clonedNotes = await dmAgent.get(`/api/v1/campaigns/${clone.id}/notes`);
      const bodies = clonedNotes.body.items.map((n: { body: string }) => n.body);
      expect(bodies).toContain('Shared quest intel');
      expect(bodies).not.toContain('My private player diary');
      const shared = clonedNotes.body.items.find((n: { body: string }) => n.body === 'Shared quest intel');
      expect(shared.entityType).toBe('quest');
      expect(shared.entityId).toBe(q.id);

      // Discussion history is copied in full mode: anchor, parent, and live
      // character ids remap. Issue #524: attachment-backed avatars remap to the
      // cloned portrait; safe remote HTTPS portraits are preserved.
      const clonedComments = await dmAgent
        .get(`/api/v1/campaigns/${clone.id}/comments`)
        .query({ entityType: 'session', entityId: sessions.body[0].id });
      expect(clonedComments.status).toBe(200);
      const clonedDiscussion = clonedComments.body as {
        items: Array<{ root: Record<string, unknown>; replies: Array<Record<string, unknown>> }>;
        totalComments: number;
      };
      const clonedFlat = clonedDiscussion.items.flatMap((thread) => [thread.root, ...thread.replies]) as Array<{
        body: string;
        id: number;
        parentId?: number | null;
        characterId?: number;
        characterName?: string;
        inCharacter?: boolean;
        characterAvatarUrl?: string;
      }>;
      expect(clonedDiscussion.totalComments).toBe(3);
      expect(clonedFlat).toHaveLength(3);
      const spoken = clonedFlat.find((c) => c.body === 'Hero speaks in the source campaign.');
      const remoteSpoken = clonedFlat.find((c) => c.body === 'Remote portrait voice.');
      const reply = clonedFlat.find((c) => c.body === 'A threaded reply.');
      expect(spoken).toMatchObject({
        characterId: clonedHero.id,
        characterName: 'Hero',
        inCharacter: true,
        characterAvatarUrl: clonedHero.portraitUrl,
      });
      expect(remoteSpoken).toMatchObject({
        characterId: clonedRemote.id,
        characterName: 'Remote Voice',
        inCharacter: true,
        characterAvatarUrl: 'https://images.example.test/remote-voice.png',
      });
      expect(reply!.parentId).toBe(spoken!.id);

      // Faction-anchored discussion must remap through factionMap (not be dropped).
      const clonedFactionComments = await dmAgent
        .get(`/api/v1/campaigns/${clone.id}/comments`)
        .query({ entityType: 'faction', entityId: clonedFactions.body[0].id });
      expect(clonedFactionComments.status).toBe(200);
      expect(clonedFactionComments.body.total).toBe(1);
      expect(clonedFactionComments.body.items[0].root).toMatchObject({
        entityType: 'faction',
        entityId: clonedFactions.body[0].id,
        body: 'Faction intrigue stays on clone.',
      });

      // Members are NOT copied — the source player has no access to the clone.
      const playerView = await playerAgent.get(`/api/v1/campaigns/${clone.id}`);
      expect(playerView.status).toBe(403);
    } finally {
      // Restore source Hero so later tests (encounter auto-add) still see an active PC.
      await dmAgent.patch(`/api/v1/characters/${heroId}`).send({
        status: 'active',
        hpCurrent: 30,
        xp: 0,
        level: 1,
      });
      await dmAgent.post(`/api/v1/characters/${heroId}/hp`).send({ set: 30 });
    }
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

  // Issue #1910 review (Codex, round 5): the combatant snapshot fields the clone insert
  // DOES carry (initMod, ruleEntryId, sortOrder, characterId mapping) are baseline stats,
  // not combat state — HP/initiative/conditions reset because THOSE are play progress, but
  // a non-default speed snapshot must survive a clone the same way initMod already does.
  // This matters more since e19d4f81 dropped the live-character fallback in getTurnWorkspace:
  // a null combatant.speed now resolves straight to the adapter default with no second
  // chance to recover the real value from the linked character, so a clone that dropped
  // the snapshot would be a clean, permanent data loss rather than a masked one.
  it('full clone carries a non-default combatant speed snapshot forward (issue #1910)', async () => {
    const speedPatch = await dmAgent.patch(`/api/v1/characters/${heroId}`).send({ speed: 27 });
    expect(speedPatch.status).toBe(200);
    expect(speedPatch.body.speed).toBe(27);

    try {
      const encRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/encounters`).send({ name: 'Speed Snapshot Fight' });
      expect(encRes.status).toBe(201);
      const sourceEncounterId = encRes.body.id;
      const heroCombatant = (await dmAgent.get(`/api/v1/encounters/${sourceEncounterId}`)).body.combatants.find(
        (c: { characterId: number | null }) => c.characterId === heroId,
      );
      expect(heroCombatant).toBeDefined();
      expect(heroCombatant.speed).toBe(27); // add-time snapshot taken from the just-patched character

      const cloneRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/clone`).send({ name: 'Speed Snapshot Sequel' });
      expect(cloneRes.status).toBe(201);
      const cloneId = cloneRes.body.id;

      const clonedEncs = await dmAgent.get(`/api/v1/campaigns/${cloneId}/encounters`);
      const clonedEncounter = clonedEncs.body.find((e: { name: string }) => e.name === 'Speed Snapshot Fight');
      expect(clonedEncounter).toBeDefined();
      const clonedDetail = await dmAgent.get(`/api/v1/encounters/${clonedEncounter.id}`);
      const clonedHeroCombatant = clonedDetail.body.combatants.find((c: { name: string }) => c.name === heroCombatant.name);
      expect(clonedHeroCombatant).toBeDefined();
      expect(clonedHeroCombatant.speed).toBe(27); // must survive the clone, not reset to null
    } finally {
      // Restore source Hero so later tests (encounter auto-add) see the original null speed.
      await dmAgent.patch(`/api/v1/characters/${heroId}`).send({ speed: null });
    }
  });

  it('template clone copies prep only and resets play state', async () => {
    const res = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/clone`)
      .send({ name: 'Fresh Start', mode: 'template' });
    expect(res.status).toBe(201);
    const clone = res.body;
    expect(clone.name).toBe('Fresh Start');
    expect(clone.sessionCount).toBe(0);
    expect(clone.latestSessionNumber).toBe(0);
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
    expect(clonedNotes.body.total).toBe(0);
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

  it('full clone preserves each encounter\'s monsterHpDisplay mode (issue #1925)', async () => {
    const exactEnc = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/encounters`)
      .send({ name: 'Tactical showdown', hidden: false });
    expect(exactEnc.status).toBe(201);
    const exactPatch = await dmAgent.patch(`/api/v1/encounters/${exactEnc.body.id}`).send({ monsterHpDisplay: 'exact' });
    expect(exactPatch.status).toBe(200);

    const hiddenModeEnc = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/encounters`)
      .send({ name: 'Gritty narrative fight', hidden: false });
    expect(hiddenModeEnc.status).toBe(201);
    const hiddenModePatch = await dmAgent.patch(`/api/v1/encounters/${hiddenModeEnc.body.id}`).send({ monsterHpDisplay: 'hidden' });
    expect(hiddenModePatch.status).toBe(200);

    const cloneRes = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/clone`)
      .send({ name: 'monsterHpDisplay copy probe' });
    expect(cloneRes.status).toBe(201);

    const encs = await dmAgent.get(`/api/v1/campaigns/${cloneRes.body.id}/encounters`);
    const clonedExact = encs.body.find((e: { name: string }) => e.name === 'Tactical showdown');
    const clonedHiddenMode = encs.body.find((e: { name: string }) => e.name === 'Gritty narrative fight');
    expect(clonedExact).toBeDefined();
    expect(clonedHiddenMode).toBeDefined();
    // A DM who deliberately chose 'exact' or 'hidden' for a fight must not have that
    // choice silently reset to the coarse-band default by duplicating the campaign.
    expect(clonedExact.monsterHpDisplay).toBe('exact');
    expect(clonedHiddenMode.monsterHpDisplay).toBe('hidden');
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

/**
 * Issue #435 — extended clone coverage: storylines, timeline, session-zero,
 * inventory/treasury, map attachments, encounter-anchored notes, clone preview.
 */
describe('campaign clone extended modules (e2e, issue #435)', () => {
  let ctx: TestAppContext;
  let dmAgent: ReturnType<typeof request.agent>;
  let campaignId: number;
  let questId: number;
  let sessionId: number;
  let encounterId: number;
  let mapAttachmentId: number;
  let battleMapAttachmentId: number;
  let equippedCharacterId: number;
  let equippedItemId: number;
  let arcId: number;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    dmAgent = request.agent(server);
    await dmAgent.post('/api/v1/auth/setup').send({ username: 'clone435-dm', password: 'dm-password-435' });

    const campRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'Clone 435 Source', description: 'Extended modules.' });
    campaignId = campRes.body.id;

    const mapUpload = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/attachments`)
      .field('kind', 'map')
      .attach('file', TINY_PNG, { filename: 'overworld.png', contentType: 'image/png' });
    mapAttachmentId = mapUpload.body.id;
    await dmAgent.patch(`/api/v1/campaigns/${campaignId}`).send({ mapAttachmentId });

    const questRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/quests`).send({ title: 'Revision quest' });
    questId = questRes.body.id;
    await dmAgent.patch(`/api/v1/quests/${questId}`).send({ body: 'First draft' });
    await dmAgent.patch(`/api/v1/quests/${questId}`).send({ body: 'Second draft' });

    const sessionRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/sessions`).send({ number: 1, recap: 'Session one.' });
    sessionId = sessionRes.body.id;

    const battleUpload = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/attachments`)
      .field('kind', 'map')
      .attach('file', TINY_PNG, { filename: 'battle.png', contentType: 'image/png' });
    battleMapAttachmentId = battleUpload.body.id;
    const encRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/encounters`).send({ name: 'Mapped fight' });
    encounterId = encRes.body.id;
    await dmAgent.patch(`/api/v1/encounters/${encounterId}`).send({ mapAttachmentId: battleMapAttachmentId, gridSize: 5 });

    await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/notes`)
      .send({ body: 'Encounter prep note', visibility: 'party_shared', entityType: 'encounter', entityId: encounterId });

    const arcRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/arcs`).send({ title: 'Main arc', summary: 'Arc summary' });
    arcId = arcRes.body.id;
    await dmAgent.patch(`/api/v1/arcs/${arcId}`).send({ summary: 'Arc summary, revised.' });
    const beat1 = await dmAgent.post(`/api/v1/arcs/${arcRes.body.id}/beats`).send({ title: 'Opening' });
    const beat2 = await dmAgent.post(`/api/v1/arcs/${arcRes.body.id}/beats`).send({ title: 'Climax' });
    await dmAgent.post(`/api/v1/beats/${beat1.body.id}/branches`).send({ label: 'go north', toBeatId: beat2.body.id });
    await dmAgent.patch(`/api/v1/beats/${beat1.body.id}`).send({ sessionId, questId, encounterId });

    await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/timeline`)
      .send({ title: 'The founding', inWorldDate: 'Year 1', body: 'King crowned.' });
    await dmAgent
      .put(`/api/v1/campaigns/${campaignId}/timeline/calendar`)
      .send({ currentDate: 'Year 5, Harvest', note: 'Present day.' });

    await dmAgent.put(`/api/v1/campaigns/${campaignId}/session-zero`).send({
      lines: ['No harm to children'],
      veils: ['Torture'],
      safetyTools: ['X-Card'],
      houseRules: 'Flanking grants advantage.',
      toneAndExpectations: 'Grim but hopeful.',
    });

    await dmAgent.post(`/api/v1/campaigns/${campaignId}/inventory`).send({ name: 'Healing potion', qty: 3 });

    // Issue #1326 review: a character-owned EQUIPPED item (with a granted action) must
    // round-trip through clone with its equip state and remapped character intact.
    const equippedChar = await dmAgent.post(`/api/v1/campaigns/${campaignId}/characters`).send({ name: 'Loadout Hero' });
    equippedCharacterId = equippedChar.body.id;
    const equippedItem = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/inventory`)
      .send({ name: 'Heirloom Blade', ownerType: 'character', characterId: equippedCharacterId });
    equippedItemId = equippedItem.body.id;
    const equipRes = await dmAgent.patch(`/api/v1/inventory/${equippedItemId}`).send({
      equipped: true,
      equipSlot: 'main-hand',
      equippedAction: { name: 'Heirloom Slash', kind: 'melee', toHit: '+5', damage: '1d8+3 slashing', notes: '' },
    });
    expect(equipRes.status).toBe(200);

    const treasuryBefore = await dmAgent.get(`/api/v1/campaigns/${campaignId}/treasury`);
    await dmAgent
      .patch(`/api/v1/campaigns/${campaignId}/treasury`)
      .send({ set: { gp: 120, sp: 45 }, expectedUpdatedAt: treasuryBefore.body.updatedAt });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('GET clone preview returns a versioned manifest with counts and warnings', async () => {
    const preview = await dmAgent.get(`/api/v1/campaigns/${campaignId}/clone/preview`);
    expect(preview.status).toBe(200);
    expect(preview.body.kind).toBe('campaign-clone-preview');
    expect(preview.body.formatVersion).toBeGreaterThanOrEqual(1);
    expect(preview.body.mode).toBe('full');
    expect(preview.body.counts.storyArcs).toBeGreaterThanOrEqual(1);
    expect(preview.body.counts.timelineEvents).toBeGreaterThanOrEqual(1);
    expect(preview.body.counts.sessionZero).toBe(1);
    expect(preview.body.counts.inventory).toBeGreaterThanOrEqual(1);
    expect(preview.body.inclusions.storyArcs.included).toBe(true);
    expect(preview.body.inclusions.encounters.included).toBe(true);

    const templatePreview = await dmAgent.get(`/api/v1/campaigns/${campaignId}/clone/preview?mode=template`);
    expect(templatePreview.status).toBe(200);
    expect(templatePreview.body.inclusions.encounters.included).toBe(false);
    expect(templatePreview.body.inclusions.storyArcs.included).toBe(true);
    expect(templatePreview.body.warnings.some((w: { code: string }) => w.code === 'template_play_state_reset')).toBe(true);
  });

  it('full clone copies storylines, timeline, session-zero, inventory/treasury, maps, and encounter notes', async () => {
    const cloneRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/clone`).send({ name: 'Clone 435 Copy' });
    expect(cloneRes.status).toBe(201);
    const cloneId = cloneRes.body.id;

    expect(cloneRes.body.mapAttachmentId).not.toBeNull();
    expect(cloneRes.body.mapAttachmentId).not.toBe(mapAttachmentId);
    const mapFile = await getBuffer(dmAgent, `/api/v1/attachments/${cloneRes.body.mapAttachmentId}/file`);
    expect(mapFile.status).toBe(200);
    expect(Buffer.compare(mapFile.body as Buffer, TINY_PNG)).toBe(0);

    const arcs = await dmAgent.get(`/api/v1/campaigns/${cloneId}/arcs`);
    expect(arcs.body).toHaveLength(1);
    expect(arcs.body[0].beats).toHaveLength(2);
    expect(arcs.body[0].beats[0].branches).toHaveLength(1);
    expect(arcs.body[0].beats[0].branches[0].label).toBe('go north');
    const clonedSessions = await dmAgent.get(`/api/v1/campaigns/${cloneId}/sessions`);
    const clonedQuests = await dmAgent.get(`/api/v1/campaigns/${cloneId}/quests`);
    const clonedEncs = await dmAgent.get(`/api/v1/campaigns/${cloneId}/encounters`);
    expect(arcs.body[0].beats[0].sessionId).toBe(clonedSessions.body[0].id);
    expect(arcs.body[0].beats[0].questId).toBe(clonedQuests.body[0].id);
    expect(arcs.body[0].beats[0].encounterId).toBe(clonedEncs.body[0].id);

    const timeline = await dmAgent.get(`/api/v1/campaigns/${cloneId}/timeline`);
    expect(timeline.body.items.some((e: { title: string }) => e.title === 'The founding')).toBe(true);
    const calendar = await dmAgent.get(`/api/v1/campaigns/${cloneId}/timeline/calendar`);
    expect(calendar.body.currentDate).toBe('Year 5, Harvest');

    const charter = await dmAgent.get(`/api/v1/campaigns/${cloneId}/session-zero`);
    expect(charter.body.lines).toContain('No harm to children');
    expect(charter.body.houseRules).toBe('Flanking grants advantage.');

    const inventory = await dmAgent.get(`/api/v1/campaigns/${cloneId}/inventory`);
    expect(inventory.body.some((i: { name: string }) => i.name === 'Healing potion')).toBe(true);
    const treasury = await dmAgent.get(`/api/v1/campaigns/${cloneId}/treasury`);
    expect(treasury.body.gp).toBe(120);
    expect(treasury.body.sp).toBe(45);

    // Issue #1326 review: equip state + granted action survive clone, remapped to the
    // cloned character (never the source characterId).
    const clonedChars = await dmAgent.get(`/api/v1/campaigns/${cloneId}/characters`);
    const clonedHero = clonedChars.body.find((c: { name: string }) => c.name === 'Loadout Hero');
    expect(clonedHero).toBeDefined();
    const clonedBlade = inventory.body.find((i: { name: string }) => i.name === 'Heirloom Blade');
    expect(clonedBlade).toBeDefined();
    expect(clonedBlade.characterId).toBe(clonedHero.id);
    expect(clonedBlade.characterId).not.toBe(equippedCharacterId);
    expect(clonedBlade.equipped).toBe(true);
    expect(clonedBlade.equipSlot).toBe('main-hand');
    expect(clonedBlade.equippedAction).toMatchObject({ name: 'Heirloom Slash', damage: '1d8+3 slashing' });

    const encDetail = await dmAgent.get(`/api/v1/encounters/${clonedEncs.body[0].id}`);
    expect(encDetail.body.mapAttachmentId).not.toBeNull();
    expect(encDetail.body.mapAttachmentId).not.toBe(battleMapAttachmentId);
    expect(encDetail.body.gridSize).toBe(5);
    const battleFile = await getBuffer(dmAgent, `/api/v1/attachments/${encDetail.body.mapAttachmentId}/file`);
    expect(battleFile.status).toBe(200);

    const notes = await dmAgent.get(`/api/v1/campaigns/${cloneId}/notes`);
    const encNote = notes.body.items.find((n: { body: string }) => n.body === 'Encounter prep note');
    expect(encNote).toBeDefined();
    expect(encNote.entityType).toBe('encounter');
    expect(encNote.entityId).toBe(clonedEncs.body[0].id);

    const sourceRevisions = await dmAgent.get(`/api/v1/revisions/quest/${questId}`);
    const clonedQuestId = clonedQuests.body[0].id;
    const clonedRevisions = await dmAgent.get(`/api/v1/revisions/quest/${clonedQuestId}`);
    expect(clonedRevisions.body.length).toBe(sourceRevisions.body.length);
    expect(clonedRevisions.body[0].snapshot.body).toBe(sourceRevisions.body[0].snapshot.body);

    const sourceArcRevisions = await dmAgent.get(`/api/v1/revisions/story_arc/${arcId}`);
    const clonedArcRevisions = await dmAgent.get(`/api/v1/revisions/story_arc/${arcs.body[0].id}`);
    expect(clonedArcRevisions.body.length).toBe(sourceArcRevisions.body.length);
    expect(clonedArcRevisions.body[0].snapshot.summary).toBe(sourceArcRevisions.body[0].snapshot.summary);
  });

  // Issue #1326 review (coordinator): when an equipped item's character does NOT survive
  // the copy (here: the character was trashed before cloning, so it's excluded from
  // characterRows and the item's characterId has no entry in charMap), equipped/equipSlot/
  // equippedAction must ALL clear together — never a half-clear (unequipped but still
  // carrying a granted action), which is a state normal play can never reach and would
  // silently arm whoever claims the fallen-back item next with an attack nobody in the new
  // campaign chose.
  it('full clone lands a party-fallback item (its character was trashed) fully unarmed: equipped, equipSlot, AND equippedAction all clear together', async () => {
    const doomedChar = await dmAgent.post(`/api/v1/campaigns/${campaignId}/characters`).send({ name: 'Doomed Hero' });
    const doomedItem = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/inventory`)
      .send({ name: 'Cursed Axe', ownerType: 'character', characterId: doomedChar.body.id });
    const equipRes = await dmAgent.patch(`/api/v1/inventory/${doomedItem.body.id}`).send({
      equipped: true,
      equipSlot: 'main-hand',
      equippedAction: { name: 'Cursed Cleave', kind: 'melee', toHit: '+6', damage: '2d6+4 necrotic', notes: '' },
    });
    expect(equipRes.status).toBe(200);

    // The character is trashed BEFORE cloning — clone's characterRows query excludes
    // soft-deleted characters, so this item's characterId has no mapping.
    const del = await dmAgent.delete(`/api/v1/characters/${doomedChar.body.id}`);
    expect(del.status).toBe(200);

    const res = await dmAgent.post(`/api/v1/campaigns/${campaignId}/clone`).send({ name: 'Fallback Copy' });
    expect(res.status).toBe(201);
    const cloneId = res.body.id;

    const inventory = await dmAgent.get(`/api/v1/campaigns/${cloneId}/inventory`);
    const axe = inventory.body.find((i: { name: string }) => i.name === 'Cursed Axe');
    expect(axe).toBeDefined();
    expect(axe.ownerType).toBe('party');
    expect(axe.characterId).toBeNull();
    expect(axe.equipped).toBe(false);
    expect(axe.equipSlot).toBeNull();
    expect(axe.equippedAction).toBeNull();
  });
});
