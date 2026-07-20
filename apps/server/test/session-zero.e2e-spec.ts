import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };
const player = { 'x-dev-role': 'player', 'x-dev-user': 'p-1' };
const viewer = { 'x-dev-role': 'viewer', 'x-dev-user': 'v-1' };

describe('session zero / table charter (e2e)', () => {
  let ctx: TestAppContext;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer())
      .post('/api/v1/campaigns')
      .set(dm)
      .send({ name: 'Session Zero Campaign' });
    campaignId = res.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('never-set charter reads as an empty default (not 404), visible to members', async () => {
    const server = ctx.app.getHttpServer();
    const initial = await request(server).get(`/api/v1/campaigns/${campaignId}/session-zero`).set(player);
    expect(initial.status).toBe(200);
    expect(initial.body.campaignId).toBe(campaignId);
    expect(initial.body.lines).toEqual([]);
    expect(initial.body.veils).toEqual([]);
    expect(initial.body.safetyTools).toEqual([]);
    expect(initial.body.houseRules).toBe('');
    expect(initial.body.toneAndExpectations).toBe('');
  });

  it('dm sets the charter (insert path) -> members can read it', async () => {
    const server = ctx.app.getHttpServer();
    const set = await request(server)
      .put(`/api/v1/campaigns/${campaignId}/session-zero`)
      .set(dm)
      .send({
        lines: ['Harm to children', 'Sexual violence'],
        veils: ['On-screen torture'],
        safetyTools: ['X-Card', 'Open Door'],
        houseRules: 'Nat 20 on a skill check is a crit success.',
        toneAndExpectations: 'Heroic fantasy, mostly serious with room for levity.',
      });
    expect(set.status).toBe(200);
    expect(set.body.lines).toEqual(['Harm to children', 'Sexual violence']);
    expect(set.body.safetyTools).toEqual(['X-Card', 'Open Door']);

    // A player (and a viewer) can read the whole charter — no dmSecret, no redaction.
    const playerRead = await request(server).get(`/api/v1/campaigns/${campaignId}/session-zero`).set(player);
    expect(playerRead.status).toBe(200);
    expect(playerRead.body.veils).toEqual(['On-screen torture']);
    expect(playerRead.body.houseRules).toBe('Nat 20 on a skill check is a crit success.');

    const viewerRead = await request(server).get(`/api/v1/campaigns/${campaignId}/session-zero`).set(viewer);
    expect(viewerRead.status).toBe(200);
    expect(viewerRead.body.toneAndExpectations).toBe('Heroic fantasy, mostly serious with room for levity.');
  });

  it('dm updates the charter (update path); a partial patch leaves untouched fields intact', async () => {
    const server = ctx.app.getHttpServer();
    const patch = await request(server)
      .put(`/api/v1/campaigns/${campaignId}/session-zero`)
      .set(dm)
      .send({ lines: ['Harm to children'] });
    expect(patch.status).toBe(200);
    expect(patch.body.lines).toEqual(['Harm to children']);
    // safetyTools / houseRules were not sent — they must survive.
    expect(patch.body.safetyTools).toEqual(['X-Card', 'Open Door']);
    expect(patch.body.houseRules).toBe('Nat 20 on a skill check is a crit success.');
  });

  it('non-DM cannot edit the charter (403)', async () => {
    const server = ctx.app.getHttpServer();
    const playerPut = await request(server)
      .put(`/api/v1/campaigns/${campaignId}/session-zero`)
      .set(player)
      .send({ lines: ['nope'] });
    expect(playerPut.status).toBe(403);

    const viewerPut = await request(server)
      .put(`/api/v1/campaigns/${campaignId}/session-zero`)
      .set(viewer)
      .send({ houseRules: 'nope' });
    expect(viewerPut.status).toBe(403);

    // The player's forbidden write did not mutate anything.
    const read = await request(server).get(`/api/v1/campaigns/${campaignId}/session-zero`).set(dm);
    expect(read.body.lines).toEqual(['Harm to children']);
  });

  it('unknown key in the body -> 400 (strict DTO), not silently stripped', async () => {
    const server = ctx.app.getHttpServer();
    const bad = await request(server)
      .put(`/api/v1/campaigns/${campaignId}/session-zero`)
      .set(dm)
      .send({ line: ['typo field'] });
    expect(bad.status).toBe(400);
  });

  it('rejects a blank array entry (min length) with 400', async () => {
    const server = ctx.app.getHttpServer();
    const bad = await request(server)
      .put(`/api/v1/campaigns/${campaignId}/session-zero`)
      .set(dm)
      .send({ lines: ['ok', ''] });
    expect(bad.status).toBe(400);
  });
});
