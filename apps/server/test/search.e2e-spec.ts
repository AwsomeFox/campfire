import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };
const player = { 'x-dev-role': 'player', 'x-dev-user': 'p-1' };

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
    await request(server)
      .post(`/api/v1/campaigns/${campaignId}/locations`)
      .set(dm)
      .send({ name: 'The Vexwood Tavern', status: 'explored', body: 'A cozy inn.' });

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
