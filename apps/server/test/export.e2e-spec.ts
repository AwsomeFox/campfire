import request from 'supertest';
import JSZip from 'jszip';
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

    // Entity-level secrecy (issue #42): hidden quest/NPC and an unexplored location
    // must STILL be present in the DM's export (the DM sees everything).
    await dmAgent.post(`/api/v1/campaigns/${campaignId}/quests`).send({ title: 'Unrevealed Quest', hidden: true });
    await dmAgent.post(`/api/v1/campaigns/${campaignId}/npcs`).send({ name: 'Unrevealed NPC', hidden: true });
    await dmAgent.post(`/api/v1/campaigns/${campaignId}/sessions`).send({ number: 1, recap: 'The party arrived.' });

    // Round-2 finding #6: export must include encounters (with combatants).
    const encRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/encounters`).send({ name: 'Ambush at the Bridge' });
    const encounterId = encRes.body.id;
    await dmAgent
      .post(`/api/v1/encounters/${encounterId}/combatants`)
      .send({ kind: 'monster', name: 'Bridge Troll', hpMax: 40 });
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

    // Entity-level secrecy (issue #42): the DM's export still contains the hidden
    // quest/NPC and the unexplored location — secrecy gates NON-DM reads, not the
    // DM's own complete export.
    expect(res.body.quests.some((q: { title: string; hidden: boolean }) => q.title === 'Unrevealed Quest' && q.hidden === true)).toBe(true);
    expect(res.body.npcs.some((n: { name: string; hidden: boolean }) => n.name === 'Unrevealed NPC' && n.hidden === true)).toBe(true);
    expect(res.body.locations.some((l: { name: string; status: string }) => l.name === 'Hidden Cave' && l.status === 'unexplored')).toBe(true);
    expect(res.body.sessions.length).toBe(1);
    expect(Array.isArray(res.body.members)).toBe(true);
    expect(Array.isArray(res.body.audit)).toBe(true);
    expect(Array.isArray(res.body.proposals)).toBe(true);

    // Round-2 finding #6: encounters (with their combatants) are present in the export.
    expect(Array.isArray(res.body.encounters)).toBe(true);
    expect(res.body.encounters.length).toBe(1);
    const encounter = res.body.encounters[0];
    expect(encounter.name).toBe('Ambush at the Bridge');
    expect(Array.isArray(encounter.combatants)).toBe(true);
    expect(encounter.combatants.some((c: { name: string }) => c.name === 'Bridge Troll')).toBe(true);
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

    // Round-2 finding #6: mdzip has an encounters/ folder with a per-encounter markdown
    // file containing name, status, round, and a combatant table.
    const zip = await JSZip.loadAsync(buf);
    const encounterFile = zip.file('encounters/ambush-at-the-bridge.md');
    expect(encounterFile).not.toBeNull();
    const content = await encounterFile!.async('string');
    expect(content).toContain('# Ambush at the Bridge');
    expect(content).toContain('Status:');
    expect(content).toContain('Round:');
    expect(content).toContain('Bridge Troll');
  });
});
