import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import JSZip from 'jszip';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';

// Minimal valid 1x1 PNG (smallest possible real PNG payload) — matches the fixture
// used in attachments.e2e-spec.ts.
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108020000009077' +
    '53de0000000c4944415408d763f8ffff3f0005fe02fea1399e1e0000000049454e44ae426082',
  'hex',
);

describe('export (e2e, real cookie sessions)', () => {
  let ctx: TestAppContext;
  let dmAgent: ReturnType<typeof request.agent>;
  let playerAgent: ReturnType<typeof request.agent>;
  let campaignId: number;
  let mapAttachmentId: number;
  let portraitAttachmentId: number;
  let portraitCharacterId: number;

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
    await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/sessions`)
      .send({ number: 1, recap: 'The party arrived.', dmSecret: 'next week: the betrayal' });
    await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .send({ name: 'Cursed Paladin', dmSecret: 'secretly cursed' });

    // Entity-level secrecy (issue #42): a hidden quest/NPC must STILL be present in
    // the DM's export (the DM sees everything); secrecy gates non-DM reads only.
    await dmAgent.post(`/api/v1/campaigns/${campaignId}/quests`).send({ title: 'Unrevealed Quest', hidden: true });
    await dmAgent.post(`/api/v1/campaigns/${campaignId}/npcs`).send({ name: 'Unrevealed NPC', hidden: true });

    // Round-2 finding #6: export must include encounters (with combatants).
    const encRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/encounters`).send({ name: 'Ambush at the Bridge' });
    const encounterId = encRes.body.id;
    await dmAgent
      .post(`/api/v1/encounters/${encounterId}/combatants`)
      .send({ kind: 'monster', name: 'Bridge Troll', hpMax: 40 });

    // Issue #87: attachments (map + portrait) must be embedded in the export, and
    // their references (campaign.mapAttachmentId, character.portraitUrl) must resolve.
    const mapUpload = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/attachments`)
      .field('kind', 'map')
      .attach('file', TINY_PNG, { filename: 'overworld.png', contentType: 'image/png' });
    mapAttachmentId = mapUpload.body.id;
    await dmAgent.patch(`/api/v1/campaigns/${campaignId}`).send({ mapAttachmentId });

    const portraitUpload = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/attachments`)
      .field('kind', 'portrait')
      .attach('file', TINY_PNG, { filename: 'hero.png', contentType: 'image/png' });
    portraitAttachmentId = portraitUpload.body.id;
    const portraitCharRes = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .send({ name: 'Portrait Hero', portraitUrl: `/api/v1/attachments/${portraitAttachmentId}/file` });
    portraitCharacterId = portraitCharRes.body.id;
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
    // Issue #59: characters and sessions carry dmSecret too — included in the dm export.
    expect(res.body.sessions.length).toBe(1);
    expect(res.body.sessions[0].dmSecret).toBe('next week: the betrayal');
    expect(res.body.characters[0].dmSecret).toBe('secretly cursed');
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

    // Issue #87: attachments are represented as a metadata manifest whose ids the
    // campaign map / character portraits reference; a note documents the shape.
    expect(Array.isArray(res.body.attachments)).toBe(true);
    expect(res.body.attachments.length).toBe(2);
    expect(typeof res.body.attachmentsNote).toBe('string');

    const mapEntry = res.body.attachments.find((a: { id: number }) => a.id === mapAttachmentId);
    expect(mapEntry).toBeDefined();
    expect(mapEntry.kind).toBe('map');
    expect(mapEntry.present).toBe(true);
    expect(mapEntry.file).toBe(`uploads/${mapAttachmentId}.png`);
    // campaign.mapAttachmentId resolves to an attachment in the manifest.
    expect(res.body.campaign.mapAttachmentId).toBe(mapAttachmentId);

    const portraitEntry = res.body.attachments.find((a: { id: number }) => a.id === portraitAttachmentId);
    expect(portraitEntry).toBeDefined();
    expect(portraitEntry.kind).toBe('portrait');
    // character.portraitUrl ends in the manifest entry's fileRoute.
    const hero = res.body.characters.find((c: { id: number }) => c.id === portraitCharacterId);
    expect(hero.portraitUrl.endsWith(portraitEntry.fileRoute)).toBe(true);
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

    // Issue #59: session + character markdown carry their DM Secret sections in the dm export.
    const sessionFile = zip.file('sessions/session-1.md');
    expect(sessionFile).not.toBeNull();
    const sessionContent = await sessionFile!.async('string');
    expect(sessionContent).toContain('## DM Secret');
    expect(sessionContent).toContain('next week: the betrayal');

    const characterFile = zip.file('characters/cursed-paladin.md');
    expect(characterFile).not.toBeNull();
    const characterContent = await characterFile!.async('string');
    expect(characterContent).toContain('## DM Secret');
    expect(characterContent).toContain('secretly cursed');

    // Issue #87: the zip embeds the actual attachment bytes under uploads/ and the
    // exact bytes round-trip (not a dangling reference).
    const mapFile = zip.file(`uploads/${mapAttachmentId}.png`);
    expect(mapFile).not.toBeNull();
    const mapBytes = await mapFile!.async('nodebuffer');
    expect(Buffer.compare(mapBytes, TINY_PNG)).toBe(0);

    const portraitFile = zip.file(`uploads/${portraitAttachmentId}.png`);
    expect(portraitFile).not.toBeNull();
    const portraitBytes = await portraitFile!.async('nodebuffer');
    expect(Buffer.compare(portraitBytes, TINY_PNG)).toBe(0);

    // A manifest cross-references each attachment to what points at it.
    const manifestFile = zip.file('attachments.md');
    expect(manifestFile).not.toBeNull();
    const manifest = await manifestFile!.async('string');
    expect(manifest).toContain('# Attachments');
    expect(manifest).toContain('campaign map');
    expect(manifest).toContain('portrait: Portrait Hero');
  });
});

// Issue #87: a missing on-disk file must be skipped (flagged, not fatal — the
// row-without-file shape from #84), leaving the rest of the export intact.
describe('export attachments — missing file is skipped, not fatal (e2e)', () => {
  let ctx: TestAppContext;
  let dmAgent: ReturnType<typeof request.agent>;
  let campaignId: number;
  let goodId: number;
  let orphanId: number;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    dmAgent = request.agent(server);
    await dmAgent.post('/api/v1/auth/setup').send({ username: 'orphan-dm', password: 'dm-password-1' });

    const campRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'Orphan Campaign' });
    campaignId = campRes.body.id;

    const good = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/attachments`)
      .field('kind', 'image')
      .attach('file', TINY_PNG, { filename: 'present.png', contentType: 'image/png' });
    goodId = good.body.id;

    const orphan = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/attachments`)
      .field('kind', 'image')
      .attach('file', TINY_PNG, { filename: 'gone.png', contentType: 'image/png' });
    orphanId = orphan.body.id;

    // Simulate a row-without-file: delete just the bytes on disk, leave the DB row.
    const dataDir = process.env.DATA_DIR ?? path.resolve(process.cwd(), 'data');
    const orphanPath = path.join(dataDir, 'uploads', String(campaignId), `${orphanId}.png`);
    fs.rmSync(orphanPath, { force: true });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('json export flags the missing file as present=false but still lists it', async () => {
    const res = await dmAgent.get(`/api/v1/campaigns/${campaignId}/export?format=json`);
    expect(res.status).toBe(200);
    const good = res.body.attachments.find((a: { id: number }) => a.id === goodId);
    const orphan = res.body.attachments.find((a: { id: number }) => a.id === orphanId);
    expect(good.present).toBe(true);
    expect(orphan.present).toBe(false);
  });

  it('mdzip skips the missing file (no crash), embeds the present one, records the skip', async () => {
    const res = await dmAgent
      .get(`/api/v1/campaigns/${campaignId}/export?format=mdzip`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    const zip = await JSZip.loadAsync(res.body as Buffer);

    // Present file is embedded; the orphan is absent.
    expect(zip.file(`uploads/${goodId}.png`)).not.toBeNull();
    expect(zip.file(`uploads/${orphanId}.png`)).toBeNull();

    // The skip is recorded in the manifest, so the loss is visible, not silent.
    const manifest = await zip.file('attachments.md')!.async('string');
    expect(manifest).toContain('Skipped');
    expect(manifest).toContain(String(orphanId));
  });
});
