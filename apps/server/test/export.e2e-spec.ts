import request from 'supertest';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';

describe('export (e2e, real cookie sessions)', () => {
  let ctx: TestAppContext;
  let dmAgent: ReturnType<typeof request.agent>;
  let playerAgent: ReturnType<typeof request.agent>;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    dmAgent = request.agent(server);
    await dmAgent.post('/api/v1/auth/setup').send({ username: 'export-dm', password: 'dm-password-1' });

    const createPlayer = await dmAgent.post('/api/v1/users').send({ username: 'export-player', password: 'player-password-1', serverRole: 'user' });
    const playerId = createPlayer.body.id;

    playerAgent = request.agent(server);
    await playerAgent.post('/api/v1/auth/login').send({ username: 'export-player', password: 'player-password-1' });

    const campRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'Export Campaign!' });
    campaignId = campRes.body.id;
    await dmAgent.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: playerId, role: 'player' });

    await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/quests`)
      .send({ title: 'Secret Quest', dmSecret: 'the vault code is 1234' });
    await dmAgent.post(`/api/v1/campaigns/${campaignId}/npcs`).send({ name: 'Mysterious Stranger', dmSecret: 'is a dragon' });
    await dmAgent.post(`/api/v1/campaigns/${campaignId}/locations`).send({ name: 'Hidden Cave', dmSecret: 'trap inside' });
    await dmAgent.post(`/api/v1/campaigns/${campaignId}/sessions`).send({ number: 1, recap: 'The party arrived.' });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('json export includes dmSecret for dm, correct headers', async () => {
    const res = await dmAgent.get(`/api/v1/campaigns/${campaignId}/export?format=json`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="campfire-export-campaign-\d{4}-\d{2}-\d{2}\.json"/);

    expect(res.body.campaign.name).toBe('Export Campaign!');
    expect(res.body.quests[0].dmSecret).toBe('the vault code is 1234');
    expect(res.body.npcs[0].dmSecret).toBe('is a dragon');
    expect(res.body.locations[0].dmSecret).toBe('trap inside');
    expect(res.body.sessions.length).toBe(1);
    expect(Array.isArray(res.body.members)).toBe(true);
    expect(Array.isArray(res.body.audit)).toBe(true);
    expect(Array.isArray(res.body.proposals)).toBe(true);
  });

  it('403 for player (non-dm)', async () => {
    const res = await playerAgent.get(`/api/v1/campaigns/${campaignId}/export?format=json`);
    expect(res.status).toBe(403);
  });

  it('mdzip returns a zip content-type', async () => {
    const res = await dmAgent.get(`/api/v1/campaigns/${campaignId}/export?format=mdzip`).buffer(true).parse((response, callback) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => callback(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/zip/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="campfire-export-campaign-\d{4}-\d{2}-\d{2}\.zip"/);
    // zip file magic number
    const buf = res.body as Buffer;
    expect(buf.slice(0, 2).toString('hex')).toBe('504b');
  });
});
