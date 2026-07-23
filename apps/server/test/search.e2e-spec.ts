import request from 'supertest';
import { createTestApp, createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };
const player = { 'x-dev-role': 'player', 'x-dev-user': 'p-1' };
const viewer = { 'x-dev-role': 'viewer', 'x-dev-user': 'v-1' };

type Result = { type: string; id: number; title: string; matchedField: string; snippet: string };

describe('campaign search + mentions (e2e, issue #64)', () => {
  let ctx: TestAppContext;
  let campaignId: number;
  // ids of entities we assert on
  let visibleNpcId: number;
  let hiddenNpcId: number;
  let visibleQuestId: number;
  let hiddenQuestId: number;
  let sessionId: number;
  let factionId: number;
  let visibleEventId: number;
  let hiddenEventId: number;
  let itemId: number;
  let visibleCommentId: number;
  let hiddenAnchorCommentId: number;
  let arcId: number;
  let beatId: number;
  let visibleLocationId: number;
  let visibleEncounterId: number;
  let hiddenEncounterId: number;
  let safelyLinkedEncounterId: number;
  let scheduledSessionId: number;
  let otherCampaignScheduleId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    campaignId = (await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Search Camp' })).body.id;

    // A visible NPC whose name AND dmSecret both contain "Vex" — proves dmSecret
    // matches are never surfaced to a non-DM.
    visibleNpcId = (
      await request(server)
        .post(`/api/v1/campaigns/${campaignId}/npcs`)
        .set(dm)
        .send({ name: 'Vexley the Innkeeper', body: 'Owes the party 50 gold.', dmSecret: 'Vex is a spy for the crown.' })
    ).body.id;

    // A hidden NPC that mentions the same query in its (visible-to-DM) name.
    hiddenNpcId = (
      await request(server)
        .post(`/api/v1/campaigns/${campaignId}/npcs`)
        .set(dm)
        .send({ name: 'Vex the Hidden Assassin', hidden: true })
    ).body.id;

    visibleQuestId = (
      await request(server)
        .post(`/api/v1/campaigns/${campaignId}/quests`)
        .set(dm)
        .send({ title: 'Find the Vex ledger', body: 'Recover the innkeeper debt records.' })
    ).body.id;

    hiddenQuestId = (
      await request(server)
        .post(`/api/v1/campaigns/${campaignId}/quests`)
        .set(dm)
        .send({ title: 'The secret Vex conspiracy', hidden: true })
    ).body.id;

    // A discovered location (default status is 'unexplored' = hidden from players).
    visibleLocationId = (
      await request(server)
        .post(`/api/v1/campaigns/${campaignId}/locations`)
        .set(dm)
        .send({ name: 'The Vexwood Tavern', status: 'explored', body: 'A cozy inn.' })
    ).body.id;

    // An unexplored (DM-only) location matching the same query.
    await request(server)
      .post(`/api/v1/campaigns/${campaignId}/locations`)
      .set(dm)
      .send({ name: 'Vex Smugglers Cave', status: 'unexplored' });

    const session = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/sessions`)
      .set(dm)
      .send({ number: 1, title: 'Session One', recap: 'The party met Vex at the tavern and learned of the debt.' });
    sessionId = session.body.id;

    // A party_shared note (visible to everyone) and a private DM note (DM only).
    await request(server)
      .post(`/api/v1/campaigns/${campaignId}/notes`)
      .set(player)
      .send({ body: 'Remember to ask Vex about the missing caravan.', visibility: 'party_shared' });
    await request(server)
      .post(`/api/v1/campaigns/${campaignId}/notes`)
      .set(dm)
      .send({ body: 'Vex secret backstory only the DM knows.', visibility: 'private' });

    // ---- newer content types (issue #265) ----

    // A faction: proves faction hits are returned (the UI faction-render bug is web-side).
    factionId = (
      await request(server)
        .post(`/api/v1/campaigns/${campaignId}/factions`)
        .set(dm)
        .send({ name: 'The Vex Cartel', kind: 'guild', body: 'A smuggling ring.' })
    ).body.id;

    // A visible + a hidden timeline event, both matching "Vex".
    visibleEventId = (
      await request(server)
        .post(`/api/v1/campaigns/${campaignId}/timeline`)
        .set(dm)
        .send({ title: 'The Vex Uprising', inWorldDate: 'Year 90 DR', body: 'The cartel rose to power.' })
    ).body.id;
    hiddenEventId = (
      await request(server)
        .post(`/api/v1/campaigns/${campaignId}/timeline`)
        .set(dm)
        .send({ title: 'The Vex Betrayal (secret)', hidden: true })
    ).body.id;

    // An inventory item matching "Vex" (member-visible, no secrecy).
    itemId = (
      await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(dm)
        .send({ name: 'Vex signet ring', ownerType: 'party', qty: 1 })
    ).body.id;

    // A comment on the VISIBLE npc (player can see it) and one on the HIDDEN quest
    // (player must NOT — anchor gating, issue #230).
    visibleCommentId = (
      await request(server)
        .post(`/api/v1/campaigns/${campaignId}/comments`)
        .set(player)
        .send({ entityType: 'npc', entityId: visibleNpcId, body: 'Is Vex trustworthy?' })
    ).body.id;
    hiddenAnchorCommentId = (
      await request(server)
        .post(`/api/v1/campaigns/${campaignId}/comments`)
        .set(dm)
        .send({ entityType: 'quest', entityId: hiddenQuestId, body: 'Vex conspiracy notes for the DM.' })
    ).body.id;

    // A DM-only story arc + beat matching "Vex".
    arcId = (
      await request(server)
        .post(`/api/v1/campaigns/${campaignId}/arcs`)
        .set(dm)
        .send({ title: 'The Vex Gambit', summary: 'The cartel arc.' })
    ).body.id;
    beatId = (
      await request(server)
        .post(`/api/v1/arcs/${arcId}/beats`)
        .set(dm)
        .send({ title: 'Vex makes their move', body: 'The betrayal is revealed.' })
    ).body.id;

    // Encounter search fixtures (#843): one visible encounter with safe linked
    // labels, one hidden encounter, and one visible encounter whose linked quest
    // and location are themselves hidden from non-DMs.
    visibleEncounterId = (
      await request(server)
        .post(`/api/v1/campaigns/${campaignId}/encounters`)
        .set(dm)
        .send({
          name: 'Goblin Bridge Ambush',
          questId: visibleQuestId,
          locationId: visibleLocationId,
          sessionId,
        })
    ).body.id;
    hiddenEncounterId = (
      await request(server)
        .post(`/api/v1/campaigns/${campaignId}/encounters`)
        .set(dm)
        .send({ name: 'Dragon Vault Ambush', hidden: true })
    ).body.id;
    const secretLinkedQuestId = (
      await request(server)
        .post(`/api/v1/campaigns/${campaignId}/quests`)
        .set(dm)
        .send({ title: 'Crownfall Protocol', hidden: true })
    ).body.id;
    const secretLinkedLocationId = (
      await request(server)
        .post(`/api/v1/campaigns/${campaignId}/locations`)
        .set(dm)
        .send({ name: 'Whisper Vault', status: 'unexplored' })
    ).body.id;
    safelyLinkedEncounterId = (
      await request(server)
        .post(`/api/v1/campaigns/${campaignId}/encounters`)
        .set(dm)
        .send({ name: 'Dawn Patrol', questId: secretLinkedQuestId, locationId: secretLinkedLocationId })
    ).body.id;

    scheduledSessionId = (
      await request(server)
        .post(`/api/v1/campaigns/${campaignId}/schedule`)
        .set(dm)
        .send({
          title: 'Saturday game',
          scheduledAt: '2031-09-20T19:30:00.000Z',
          notes: 'Bring level seven sheets for the bridge finale.',
        })
    ).body.id;

    const otherCampaignId = (
      await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Other Search Camp' })
    ).body.id;
    otherCampaignScheduleId = (
      await request(server)
        .post(`/api/v1/campaigns/${otherCampaignId}/schedule`)
        .set(dm)
        .send({
          title: 'Saturday game in another campaign',
          scheduledAt: '2031-09-20T19:30:00.000Z',
          notes: 'Bring level seven sheets somewhere else.',
        })
    ).body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('DM search finds visible AND hidden entities across all types', async () => {
    const res = await request(ctx.app.getHttpServer()).get(`/api/v1/campaigns/${campaignId}/search?q=Vex`).set(dm);
    expect(res.status).toBe(200);
    const results: Result[] = res.body.results;
    const has = (type: string, id: number) => results.some((r) => r.type === type && r.id === id);
    expect(has('npc', visibleNpcId)).toBe(true);
    expect(has('npc', hiddenNpcId)).toBe(true); // hidden — DM sees it
    expect(has('quest', visibleQuestId)).toBe(true);
    expect(has('quest', hiddenQuestId)).toBe(true);
    expect(has('session', sessionId)).toBe(true);
    expect(results.some((r) => r.type === 'location')).toBe(true);
    expect(results.some((r) => r.type === 'note')).toBe(true);
    // Newer content types (issue #265) — DM sees them all, including hidden/DM-only.
    expect(has('faction', factionId)).toBe(true);
    expect(has('timeline', visibleEventId)).toBe(true);
    expect(has('timeline', hiddenEventId)).toBe(true); // hidden — DM sees it
    expect(has('item', itemId)).toBe(true);
    expect(has('comment', visibleCommentId)).toBe(true);
    expect(has('comment', hiddenAnchorCommentId)).toBe(true); // anchor visible to DM
    expect(has('arc', arcId)).toBe(true);
    expect(has('beat', beatId)).toBe(true);
    expect(has('encounter', visibleEncounterId)).toBe(true);
  });

  it('player search finds visible entities but excludes every hidden one', async () => {
    const res = await request(ctx.app.getHttpServer()).get(`/api/v1/campaigns/${campaignId}/search?q=Vex`).set(player);
    expect(res.status).toBe(200);
    const results: Result[] = res.body.results;
    const has = (type: string, id: number) => results.some((r) => r.type === type && r.id === id);

    // Visible ones present
    expect(has('npc', visibleNpcId)).toBe(true);
    expect(has('quest', visibleQuestId)).toBe(true);
    expect(has('session', sessionId)).toBe(true);
    expect(has('encounter', visibleEncounterId)).toBe(true);

    // Hidden NPC, hidden quest, and unexplored location are absent
    expect(has('npc', hiddenNpcId)).toBe(false);
    expect(has('quest', hiddenQuestId)).toBe(false);
    expect(results.some((r) => r.type === 'location' && /Smugglers/i.test(r.title))).toBe(false);
    // The explored location IS visible
    expect(results.some((r) => r.type === 'location' && /Vexwood/i.test(r.title))).toBe(true);

    // Newer content types (issue #265): a player sees the member-visible ones…
    expect(has('faction', factionId)).toBe(true);
    expect(has('timeline', visibleEventId)).toBe(true);
    expect(has('item', itemId)).toBe(true);
    expect(has('comment', visibleCommentId)).toBe(true); // comment on a visible npc

    // …but NOT the hidden timeline event, the comment on a hidden quest, or any
    // DM-only story arc/beat (secrecy respected per type).
    expect(has('timeline', hiddenEventId)).toBe(false);
    expect(has('comment', hiddenAnchorCommentId)).toBe(false);
    expect(results.some((r) => r.type === 'arc')).toBe(false);
    expect(results.some((r) => r.type === 'beat')).toBe(false);
  });

  it('hidden encounters never leak to players or viewers on exact or partial queries', async () => {
    for (const query of ['Dragon Vault Ambush', 'Vault Amb']) {
      const dmRes = await request(ctx.app.getHttpServer())
        .get(`/api/v1/campaigns/${campaignId}/search?q=${encodeURIComponent(query)}`)
        .set(dm);
      expect(dmRes.body.results.some((r: Result) => r.type === 'encounter' && r.id === hiddenEncounterId)).toBe(true);

      for (const headers of [player, viewer]) {
        const res = await request(ctx.app.getHttpServer())
          .get(`/api/v1/campaigns/${campaignId}/search?q=${encodeURIComponent(query)}`)
          .set(headers);
        expect(res.status).toBe(200);
        expect(res.body.results.some((r: Result) => r.type === 'encounter' && r.id === hiddenEncounterId)).toBe(false);
        expect(JSON.stringify(res.body.results).toLowerCase()).not.toContain('dragon vault ambush');
      }
    }
  });

  it('indexes only role-safe encounter-linked quest/location/session labels', async () => {
    // Revealed linked context is searchable by every role.
    for (const headers of [dm, player, viewer]) {
      const safe = await request(ctx.app.getHttpServer())
        .get(`/api/v1/campaigns/${campaignId}/search?q=Vexwood`)
        .set(headers);
      expect(safe.body.results).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'encounter', id: visibleEncounterId, matchedField: 'location' }),
      ]));
    }

    // The DM can use hidden prep labels; player/viewer cannot match or receive
    // those labels through the otherwise-visible encounter's snippet.
    for (const query of ['Crownfall', 'Whisper Vau']) {
      const dmRes = await request(ctx.app.getHttpServer())
        .get(`/api/v1/campaigns/${campaignId}/search?q=${encodeURIComponent(query)}`)
        .set(dm);
      expect(dmRes.body.results.some((r: Result) => r.type === 'encounter' && r.id === safelyLinkedEncounterId)).toBe(true);

      for (const headers of [player, viewer]) {
        const res = await request(ctx.app.getHttpServer())
          .get(`/api/v1/campaigns/${campaignId}/search?q=${encodeURIComponent(query)}`)
          .set(headers);
        expect(res.body.results.some((r: Result) => r.type === 'encounter' && r.id === safelyLinkedEncounterId)).toBe(false);
        const payload = JSON.stringify(res.body).toLowerCase();
        expect(payload).not.toContain('crownfall protocol');
        expect(payload).not.toContain('whisper vault');
      }
    }
  });

  it('searches scheduled-session title, date, time, and party-visible notes for every role', async () => {
    const cases = [
      { query: 'Saturday game', field: 'title' },
      { query: '2031-09-20', field: 'scheduledAt' },
      { query: '19:30', field: 'scheduledAt' },
      { query: 'level seven sheets', field: 'notes' },
    ];
    for (const headers of [dm, player, viewer]) {
      for (const { query, field } of cases) {
        const res = await request(ctx.app.getHttpServer())
          .get(`/api/v1/campaigns/${campaignId}/search?q=${encodeURIComponent(query)}`)
          .set(headers);
        expect(res.status).toBe(200);
        expect(res.body.results).toEqual(expect.arrayContaining([
          expect.objectContaining({ type: 'scheduled_session', id: scheduledSessionId, matchedField: field }),
        ]));
        expect(res.body.results).not.toEqual(expect.arrayContaining([
          expect.objectContaining({ type: 'scheduled_session', id: otherCampaignScheduleId }),
        ]));
        expect(JSON.stringify(res.body)).not.toContain('rsvps');
      }
    }
  });

  it('dmSecret is never matched or leaked to a player', async () => {
    // "spy" only appears in the visible NPC's dmSecret. A player must get zero hits;
    // the DM matches it via the dmSecret field.
    const playerRes = await request(ctx.app.getHttpServer()).get(`/api/v1/campaigns/${campaignId}/search?q=spy`).set(player);
    expect(playerRes.body.results.length).toBe(0);

    const dmRes = await request(ctx.app.getHttpServer()).get(`/api/v1/campaigns/${campaignId}/search?q=spy`).set(dm);
    expect(dmRes.body.results.some((r: Result) => r.type === 'npc' && r.id === visibleNpcId && r.matchedField === 'dmSecret')).toBe(true);

    // And no snippet in any player result leaks the secret string.
    const vexPlayer = await request(ctx.app.getHttpServer()).get(`/api/v1/campaigns/${campaignId}/search?q=Vex`).set(player);
    for (const r of vexPlayer.body.results as Result[]) {
      expect(r.snippet.toLowerCase()).not.toContain('spy for the crown');
    }
  });

  it('private notes are excluded from a player search', async () => {
    const res = await request(ctx.app.getHttpServer()).get(`/api/v1/campaigns/${campaignId}/search?q=backstory`).set(player);
    // "backstory" is only in the DM's private note.
    expect(res.body.results.length).toBe(0);
    const dmRes = await request(ctx.app.getHttpServer()).get(`/api/v1/campaigns/${campaignId}/search?q=backstory`).set(dm);
    expect(dmRes.body.results.some((r: Result) => r.type === 'note')).toBe(true);
  });

  it('empty query returns no results', async () => {
    const res = await request(ctx.app.getHttpServer()).get(`/api/v1/campaigns/${campaignId}/search?q=`).set(dm);
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });

  it('matches multilingual titles with NFKC + fixed-locale fold (issue #624)', async () => {
    const server = ctx.app.getHttpServer();
    const strasseId = (
      await request(server)
        .post(`/api/v1/campaigns/${campaignId}/npcs`)
        .set(dm)
        .send({ name: 'Straße Guard', body: 'Watches the east gate.' })
    ).body.id;
    const cafeId = (
      await request(server)
        .post(`/api/v1/campaigns/${campaignId}/npcs`)
        .set(dm)
        .send({ name: 'Café Müller', body: 'Sells tea.' })
    ).body.id;
    const istanbulId = (
      await request(server)
        .post(`/api/v1/campaigns/${campaignId}/npcs`)
        .set(dm)
        .send({ name: 'İstanbul Courier', body: 'Runs messages.' })
    ).body.id;

    const strasseRes = await request(server)
      .get(`/api/v1/campaigns/${campaignId}/search?q=${encodeURIComponent('strasse')}`)
      .set(dm);
    expect(strasseRes.status).toBe(200);
    const strasseHit = (strasseRes.body.results as Result[]).find((r) => r.type === 'npc' && r.id === strasseId);
    expect(strasseHit).toBeTruthy();
    // Original spelling preserved in title/snippet — not the folded form.
    expect(strasseHit!.title).toBe('Straße Guard');
    expect(strasseHit!.title).toContain('ß');

    const cafeRes = await request(server)
      .get(`/api/v1/campaigns/${campaignId}/search?q=${encodeURIComponent('CAFÉ')}`)
      .set(player);
    expect(cafeRes.body.results.some((r: Result) => r.type === 'npc' && r.id === cafeId && r.title === 'Café Müller')).toBe(true);

    const istanbulRes = await request(server)
      .get(`/api/v1/campaigns/${campaignId}/search?q=${encodeURIComponent('istanbul')}`)
      .set(dm);
    expect(istanbulRes.body.results.some((r: Result) => r.type === 'npc' && r.id === istanbulId && r.title === 'İstanbul Courier')).toBe(
      true,
    );
  });

  it('name/title matches rank ahead of body matches', async () => {
    const res = await request(ctx.app.getHttpServer()).get(`/api/v1/campaigns/${campaignId}/search?q=Vex`).set(dm);
    const results: Result[] = res.body.results;
    const firstBodyIdx = results.findIndex((r) => r.matchedField !== 'name' && r.matchedField !== 'title');
    const lastNameIdx = results.map((r) => r.matchedField).lastIndexOf('name');
    if (firstBodyIdx >= 0 && lastNameIdx >= 0) {
      expect(lastNameIdx).toBeLessThan(firstBodyIdx === -1 ? Infinity : results.length);
    }
    // The first result should be a name/title hit.
    expect(['name', 'title']).toContain(results[0].matchedField);
  });

  it('mentions lists visible targets for a player and hides hidden ones', async () => {
    const res = await request(ctx.app.getHttpServer()).get(`/api/v1/campaigns/${campaignId}/mentions`).set(player);
    expect(res.status).toBe(200);
    const targets: Array<{ type: string; id: number; name: string }> = res.body;
    expect(targets.some((t) => t.type === 'npc' && t.id === visibleNpcId)).toBe(true);
    expect(targets.some((t) => t.type === 'npc' && t.id === hiddenNpcId)).toBe(false);
    expect(targets.some((t) => t.type === 'quest' && t.id === hiddenQuestId)).toBe(false);
    expect(targets.some((t) => t.type === 'session' && t.id === sessionId)).toBe(true);
    // Notes are not link targets.
    expect(targets.some((t) => t.type === 'note')).toBe(false);

    // Timeline events are linkable; a hidden one is not; story arcs/beats are DM-only.
    expect(targets.some((t) => t.type === 'timeline' && t.id === visibleEventId)).toBe(true);
    expect(targets.some((t) => t.type === 'timeline' && t.id === hiddenEventId)).toBe(false);
    expect(targets.some((t) => t.type === 'arc')).toBe(false);
    expect(targets.some((t) => t.type === 'beat')).toBe(false);
    // Inventory items and comments are not mention link targets.
    expect(targets.some((t) => t.type === 'item')).toBe(false);
    expect(targets.some((t) => t.type === 'comment')).toBe(false);
  });

  it('mentions expose DM-only story arcs/beats to a DM', async () => {
    const res = await request(ctx.app.getHttpServer()).get(`/api/v1/campaigns/${campaignId}/mentions`).set(dm);
    expect(res.status).toBe(200);
    const targets: Array<{ type: string; id: number; name: string }> = res.body;
    expect(targets.some((t) => t.type === 'timeline' && t.id === visibleEventId)).toBe(true);
    expect(targets.some((t) => t.type === 'timeline' && t.id === hiddenEventId)).toBe(true);
    expect(targets.some((t) => t.type === 'arc' && t.id === arcId)).toBe(true);
    expect(targets.some((t) => t.type === 'beat' && t.id === beatId)).toBe(true);
  });
});

describe('campaign search role boundaries (e2e, real cookie sessions, issue #843)', () => {
  let ctx: TestAppContext;
  let dmAgent: ReturnType<typeof request.agent>;
  let playerAgent: ReturnType<typeof request.agent>;
  let viewerAgent: ReturnType<typeof request.agent>;
  let outsiderAgent: ReturnType<typeof request.agent>;
  let campaignId: number;
  let hiddenEncounterId: number;
  let visibleEncounterId: number;
  let scheduledSessionId: number;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();
    const admin = request.agent(server);
    expect((await admin.post('/api/v1/auth/setup').send({ username: 'search-admin', password: 'admin-password-1' })).status).toBe(201);

    const users: Record<'dm' | 'player' | 'viewer' | 'outsider', number> = { dm: 0, player: 0, viewer: 0, outsider: 0 };
    for (const role of Object.keys(users) as Array<keyof typeof users>) {
      const created = await admin
        .post('/api/v1/users')
        .send({ username: `search-${role}`, password: `${role}-password-1`, serverRole: 'user' });
      expect(created.status).toBe(201);
      users[role] = created.body.id;
    }

    const login = async (role: keyof typeof users) => {
      const agent = request.agent(server);
      const res = await agent.post('/api/v1/auth/login').send({ username: `search-${role}`, password: `${role}-password-1` });
      expect(res.status).toBe(201);
      return agent;
    };
    dmAgent = await login('dm');
    playerAgent = await login('player');
    viewerAgent = await login('viewer');
    outsiderAgent = await login('outsider');

    const campaign = await dmAgent.post('/api/v1/campaigns').send({ name: 'Role-safe Search Campaign' });
    expect(campaign.status).toBe(201);
    campaignId = campaign.body.id;
    expect((await dmAgent.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: users.player, role: 'player' })).status).toBe(201);
    expect((await dmAgent.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: users.viewer, role: 'viewer' })).status).toBe(201);

    visibleEncounterId = (
      await dmAgent.post(`/api/v1/campaigns/${campaignId}/encounters`).send({ name: 'Public Orchard Skirmish' })
    ).body.id;
    hiddenEncounterId = (
      await dmAgent.post(`/api/v1/campaigns/${campaignId}/encounters`).send({ name: 'Secret Orchard Dragon', hidden: true })
    ).body.id;
    scheduledSessionId = (
      await dmAgent.post(`/api/v1/campaigns/${campaignId}/schedule`).send({
        title: 'Orchard follow-up',
        scheduledAt: '2032-10-11T18:45:00.000Z',
        notes: 'Bring the orchard map.',
      })
    ).body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('applies DM/player/viewer visibility from persisted memberships', async () => {
    const dmResults = (await dmAgent.get(`/api/v1/campaigns/${campaignId}/search?q=Orchard`)).body.results as Result[];
    expect(dmResults.some((r) => r.type === 'encounter' && r.id === visibleEncounterId)).toBe(true);
    expect(dmResults.some((r) => r.type === 'encounter' && r.id === hiddenEncounterId)).toBe(true);
    expect(dmResults.some((r) => r.type === 'scheduled_session' && r.id === scheduledSessionId)).toBe(true);

    for (const agent of [playerAgent, viewerAgent]) {
      const res = await agent.get(`/api/v1/campaigns/${campaignId}/search?q=Orchard`);
      expect(res.status).toBe(200);
      const results = res.body.results as Result[];
      expect(results.some((r) => r.type === 'encounter' && r.id === visibleEncounterId)).toBe(true);
      expect(results.some((r) => r.type === 'encounter' && r.id === hiddenEncounterId)).toBe(false);
      expect(results.some((r) => r.type === 'scheduled_session' && r.id === scheduledSessionId)).toBe(true);
      expect(JSON.stringify(res.body)).not.toContain('Secret Orchard Dragon');
    }
  });

  it('rejects search for a caller outside the campaign boundary', async () => {
    const res = await outsiderAgent.get(`/api/v1/campaigns/${campaignId}/search?q=Orchard`);
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('Orchard');
  });
});
