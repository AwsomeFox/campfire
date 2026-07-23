import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import JSZip from 'jszip';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';
import { DB, type DrizzleDb } from '../src/db/db.module';
import { auditLog } from '../src/db/schema';
import { AuditService } from '../src/modules/audit/audit.service';

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
  let playerCharacterId: number;

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
    const recap = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/sessions`)
      .send({ number: 1, recap: 'The party arrived.', dmSecret: 'next week: the betrayal' });
    await dmAgent
      .post(`/api/v1/sessions/${recap.body.id}/shares`)
      .send({ label: 'Must not leave the server', expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() });
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

    const playerCharacter = await playerAgent
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .send({ name: 'Player Voice', portraitUrl: 'https://images.example.test/player-voice.png' });
    playerCharacterId = playerCharacter.body.id;
    await playerAgent.post(`/api/v1/campaigns/${campaignId}/comments`).send({
      entityType: 'campaign',
      entityId: campaignId,
      body: 'A line worth keeping.',
      inCharacter: true,
      characterId: playerCharacterId,
    });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('json export includes dmSecret for dm, correct headers', async () => {
    const res = await dmAgent.get(`/api/v1/campaigns/${campaignId}/export?format=json`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="campfire-export-campaign-\d{4}-\d{2}-\d{2}\.json"/);
    // Issue #730: campaign exports must never be storeable by HTTP / PWA caches.
    expect(String(res.headers['cache-control'])).toMatch(/no-store/i);
    expect(String(res.headers['cache-control'])).toMatch(/private/i);

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
    expect(res.body.campaign.publicRecapSharingEnabled).toBe(true);
    expect(res.body.sessionShares).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/cf_share_[0-9a-f]{48}/);
    expect(JSON.stringify(res.body)).not.toContain('tokenHash');
    expect(res.body.characters[0].dmSecret).toBe('secretly cursed');
    expect(Array.isArray(res.body.members)).toBe(true);
    expect(Array.isArray(res.body.audit)).toBe(true);
    expect(res.body.auditMeta).toEqual(
      expect.objectContaining({
        total: expect.any(Number),
        exported: expect.any(Number),
        truncated: expect.any(Number),
        cutoff: expect.objectContaining({
          snapshotMaxId: expect.any(Number),
          capturedAt: expect.any(String),
        }),
      }),
    );
    expect(res.body.auditMeta.exported).toBe(res.body.audit.length);
    expect(typeof res.body.auditNote).toBe('string');
    expect(Array.isArray(res.body.proposals)).toBe(true);
    expect(res.body.comments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          body: 'A line worth keeping.',
          characterId: playerCharacterId,
          characterName: 'Player Voice',
          characterAvatarUrl: 'https://images.example.test/player-voice.png',
        }),
      ]),
    );

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

  // Issue #128 (player data rights): a player may export THEIR OWN data (their
  // characters, notes, proposals) — even though the campaign-wide export above is
  // dm-only. The member export must never leak dmSecret or other members' data.
  it('member export: a player exports their own data (200); campaign-wide export stays 403', async () => {
    // Player owns a character (create-path grants ownership to a non-dm) and writes a private note.
    const myChar = await playerAgent.post(`/api/v1/campaigns/${campaignId}/characters`).send({ name: 'My Own Hero' });
    expect(myChar.status).toBe(201);
    await playerAgent.post(`/api/v1/campaigns/${campaignId}/notes`).send({ body: 'my secret plan', visibility: 'private' });

    const res = await playerAgent.get(`/api/v1/campaigns/${campaignId}/export/me`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="campfire-export-campaign-member-.*\.json"/);
    expect(String(res.headers['cache-control'])).toMatch(/no-store/i);
    expect(String(res.headers['cache-control'])).toMatch(/private/i);

    // Their own character + note are present.
    expect(res.body.characters.some((c: { name: string }) => c.name === 'My Own Hero')).toBe(true);
    expect(res.body.notes.some((n: { body: string }) => n.body === 'my secret plan')).toBe(true);
    expect(res.body.comments.some((c: { body: string }) => c.body === 'A line worth keeping.')).toBe(true);

    // The DM's dmSecret-bearing character ("Cursed Paladin") is NOT in the player's export.
    expect(res.body.characters.some((c: { name: string }) => c.name === 'Cursed Paladin')).toBe(false);
    // No campaign-wide fields leaked.
    expect(res.body.audit).toBeUndefined();
    expect(res.body.members).toBeUndefined();

    // The player still cannot pull the campaign-wide export.
    expect((await playerAgent.get(`/api/v1/campaigns/${campaignId}/export?format=json`)).status).toBe(403);
  });

  it('member export: 403 for a non-member', async () => {
    // A fresh user with no membership in this campaign.
    await dmAgent.post('/api/v1/users').send({ username: 'export-outsider', password: 'outsider-password-1', serverRole: 'user' });
    const outsider = request.agent(ctx.app.getHttpServer());
    await outsider.post('/api/v1/auth/login').send({ username: 'export-outsider', password: 'outsider-password-1' });
    const res = await outsider.get(`/api/v1/campaigns/${campaignId}/export/me`);
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
    expect(String(res.headers['cache-control'])).toMatch(/no-store/i);
    expect(String(res.headers['cache-control'])).toMatch(/private/i);
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

// Issue #731: campaign export must not silently cap audit history at 500 rows.
describe('export audit history — full snapshot + metadata (e2e, #731)', () => {
  let ctx: TestAppContext;
  let dmAgent: ReturnType<typeof request.agent>;
  let campaignId: number;
  let db: DrizzleDb;
  let audit: AuditService;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();
    db = ctx.app.get<DrizzleDb>(DB);
    audit = ctx.app.get(AuditService);

    dmAgent = request.agent(server);
    await dmAgent.post('/api/v1/auth/setup').send({ username: 'audit-export-dm', password: 'dm-password-1' });

    const campRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'Audit Export Campaign' });
    campaignId = campRes.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  async function seedAuditRows(count: number, detailPrefix: string, targetCampaignId = campaignId): Promise<void> {
    const base = new Date().toISOString();
    const batch: (typeof auditLog.$inferInsert)[] = [];
    for (let i = 0; i < count; i++) {
      batch.push({
        campaignId: targetCampaignId,
        actor: 'export-dm',
        actorRole: 'dm',
        action: 'test.export.seed',
        detail: `${detailPrefix}-${i}`,
        createdAt: base,
      });
    }
    // Chunk inserts so SQLite stays responsive in CI.
    const chunk = 100;
    for (let i = 0; i < batch.length; i += chunk) {
      await db.insert(auditLog).values(batch.slice(i, i + chunk));
    }
  }

  it('exports every retained row when history exceeds 500 (auditMeta matches counts)', async () => {
    const extra = 520;
    await seedAuditRows(extra, 'bulk');

    const res = await dmAgent.get(`/api/v1/campaigns/${campaignId}/export?format=json`);
    expect(res.status).toBe(200);

    expect(res.body.audit.length).toBeGreaterThanOrEqual(extra);
    expect(res.body.auditMeta.exported).toBe(res.body.audit.length);
    expect(res.body.auditMeta.total).toBe(res.body.auditMeta.exported);
    expect(res.body.auditMeta.truncated).toBe(0);
    expect(res.body.auditMeta.cutoff.snapshotMaxId).toBeGreaterThan(0);
    expect(res.body.auditMeta.cutoff.oldestExportedCreatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(res.body.auditNote).toMatch(/portability export/i);
    expect(res.body.auditNote).toMatch(/backup/i);
  });

  it('concurrent audit inserts during export surface in auditMeta.truncated', async () => {
    const campRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'Audit Export Concurrent' });
    const concurrentCampaignId = campRes.body.id;
    const concurrentExtra = 505;
    const base = new Date().toISOString();
    const batch: (typeof auditLog.$inferInsert)[] = [];
    for (let i = 0; i < concurrentExtra; i++) {
      batch.push({
        campaignId: concurrentCampaignId,
        actor: 'export-dm',
        actorRole: 'dm',
        action: 'test.export.concurrent',
        detail: `concurrent-${i}`,
        createdAt: base,
      });
    }
    for (let i = 0; i < batch.length; i += 100) {
      await db.insert(auditLog).values(batch.slice(i, i + 100));
    }

    const concurrentInserts = (async () => {
      for (let i = 0; i < 20; i++) {
        await audit.log({
          actor: 'export-dm',
          actorRole: 'dm',
          action: 'test.export.race',
          campaignId: concurrentCampaignId,
          detail: `race-${i}`,
        });
      }
    })();

    const [exportRes] = await Promise.all([
      dmAgent.get(`/api/v1/campaigns/${concurrentCampaignId}/export?format=json`),
      concurrentInserts,
    ]);

    expect(exportRes.status).toBe(200);
    expect(exportRes.body.auditMeta.exported).toBeGreaterThanOrEqual(concurrentExtra);
    expect(exportRes.body.auditMeta.exported).toBe(exportRes.body.audit.length);
    expect(exportRes.body.auditMeta.total).toBe(exportRes.body.auditMeta.exported);
    expect(exportRes.body.auditMeta.truncated).toBeGreaterThanOrEqual(0);
    expect(exportRes.body.auditMeta.exported + exportRes.body.auditMeta.truncated).toBeGreaterThanOrEqual(
      exportRes.body.auditMeta.total,
    );
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
