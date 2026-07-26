import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'cast-dm' };
const player = { 'x-dev-role': 'player', 'x-dev-user': 'cast-player' };

const CAST_TOKEN_RE = /^cf_cast_[0-9a-f]{48}$/;
const futureExpiry = (hours = 8) => new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

describe('Player Display cast sessions (e2e)', () => {
  let ctx: TestAppContext;
  let campaignId: number;
  let encounterId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();

    const campaign = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Cast Boundary' });
    campaignId = campaign.body.id;

    await request(server).post(`/api/v1/campaigns/${campaignId}/characters`).set(dm).send({
      name: 'Ember',
      hpMax: 12,
      hpCurrent: 12,
      dmSecret: 'Ember is the heir',
    });
    await request(server).post(`/api/v1/campaigns/${campaignId}/quests`).set(dm).send({
      title: 'Public errand',
      status: 'active',
      hidden: false,
      dmSecret: 'The errand is a trap',
    });
    await request(server).post(`/api/v1/campaigns/${campaignId}/quests`).set(dm).send({
      title: 'Hidden coup',
      status: 'active',
      hidden: true,
      dmSecret: 'The duke is a lich',
    });
    await request(server).post(`/api/v1/campaigns/${campaignId}/npcs`).set(dm).send({
      name: 'Visible Guide',
      hidden: false,
      dmSecret: 'Guide reports to the villain',
    });
    await request(server).post(`/api/v1/campaigns/${campaignId}/npcs`).set(dm).send({
      name: 'Hidden Assassin',
      hidden: true,
      dmSecret: 'Assassin waits backstage',
    });
    await request(server).post(`/api/v1/campaigns/${campaignId}/locations`).set(dm).send({
      name: 'Secret Vault',
      status: 'unexplored',
      dmSecret: 'Door code is 1234',
    });

    const encounter = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/encounters`)
      .set(dm)
      .send({ name: 'Goblin Ambush', hidden: false });
    encounterId = encounter.body.id;
    await request(server)
      .post(`/api/v1/encounters/${encounterId}/combatants`)
      .set(dm)
      .send({ kind: 'monster', name: 'Glass Goblin', hpMax: 22, initMod: 2 });
    expect((await request(server).post(`/api/v1/encounters/${encounterId}/roll-initiative`).set(dm)).status).toBe(201);
    expect((await request(server).post(`/api/v1/encounters/${encounterId}/start`).set(dm)).status).toBe(201);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('mints expiring metadata, shows token/PIN once, and lists no secret material', async () => {
    const server = ctx.app.getHttpServer();
    expect((await request(server).post(`/api/v1/campaigns/${campaignId}/cast-sessions`).set(player).send({ expiresAt: futureExpiry() })).status).toBe(403);

    const created = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/cast-sessions`)
      .set(dm)
      .send({ label: 'Table TV', expiresAt: futureExpiry() });
    expect(created.status).toBe(201);
    expect(created.body.token).toMatch(CAST_TOKEN_RE);
    expect(created.body.exitPin).toMatch(/^\d{6}$/);
    expect(created.body.url).toBe(`/cast/${campaignId}/${created.body.token}`);
    expect(created.body.session.tokenPrefix).toBe(created.body.token.slice(0, 12));
    expect(created.body.session.tokenHash).toBeUndefined();
    expect(created.body.session.exitPinHash).toBeUndefined();

    const list = await request(server).get(`/api/v1/campaigns/${campaignId}/cast-sessions`).set(dm);
    expect(list.status).toBe(200);
    expect(list.body[0]).toEqual(expect.objectContaining({ label: 'Table TV', tokenPrefix: created.body.session.tokenPrefix }));
    expect(list.body[0].token).toBeUndefined();
    expect(list.body[0].exitPin).toBeUndefined();
    expect(list.body[0].tokenHash).toBeUndefined();
    expect(list.body[0].exitPinHash).toBeUndefined();

    expect((await request(server).delete(`/api/v1/campaigns/${campaignId}/cast-sessions/${created.body.session.id}`).set(dm)).status).toBe(200);
    expect((await request(server).get(`/api/v1/cast/${created.body.token}/summary`)).status).toBe(404);
  });

  it('serves only viewer-safe cast projections and blocks normal routes for cast bearer credentials', async () => {
    const server = ctx.app.getHttpServer();
    const created = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/cast-sessions`)
      .set(dm)
      .send({ label: 'Security TV', expiresAt: futureExpiry() });
    const token = created.body.token as string;

    const summary = await request(server).get(`/api/v1/cast/${token}/summary`);
    expect(summary.status).toBe(200);
    expect(JSON.stringify(summary.body)).not.toContain('Ember is the heir');
    expect(JSON.stringify(summary.body)).not.toContain('The errand is a trap');
    expect(JSON.stringify(summary.body)).not.toContain('The duke is a lich');
    expect(JSON.stringify(summary.body)).not.toContain('Guide reports to the villain');
    expect(JSON.stringify(summary.body)).not.toContain('Assassin waits backstage');
    expect(JSON.stringify(summary.body)).not.toContain('Door code is 1234');
    expect(summary.body.quests.some((q: { title: string }) => q.title === 'Public errand')).toBe(true);
    expect(summary.body.quests.some((q: { title: string }) => q.title === 'Hidden coup')).toBe(false);
    expect(summary.body.npcs.some((n: { name: string }) => n.name === 'Hidden Assassin')).toBe(false);
    expect(summary.body.locations.some((l: { name: string }) => l.name === 'Secret Vault')).toBe(false);

    const running = await request(server).get(`/api/v1/cast/${token}/encounters?status=running`);
    expect(running.status).toBe(200);
    expect(running.body).toHaveLength(1);
    expect(running.body[0].id).toBe(encounterId);

    const detail = await request(server).get(`/api/v1/cast/${token}/encounters/${encounterId}`);
    expect(detail.status).toBe(200);
    const monster = detail.body.combatants.find((c: { name: string }) => c.name === 'Glass Goblin');
    expect(monster).toEqual(expect.objectContaining({ hpCurrent: null, hpMax: null, hpBand: 'healthy' }));
    expect(JSON.stringify(detail.body)).not.toContain('"hpCurrent":22');
    expect(JSON.stringify(detail.body)).not.toContain('"hpMax":22');

    const normalWrite = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/quests`)
      .set(dm)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Cast should not write' });
    expect(normalWrite.status).toBe(403);

    expect((await request(server).post(`/api/v1/cast/${token}/exit`).send({ pin: '000000' })).status).toBe(403);
    expect((await request(server).post(`/api/v1/cast/${token}/exit`).send({ pin: created.body.exitPin })).status).toBe(201);
  });
});
