import zlib from 'node:zlib';
import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'cast-dm' };
const player = { 'x-dev-role': 'player', 'x-dev-user': 'cast-player' };

const CAST_TOKEN_RE = /^cf_cast_[0-9a-f]{48}$/;
const futureExpiry = (hours = 8) => new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

function pngChunk(type: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(typed) : crc32(typed), 0);
  return Buffer.concat([len, typed, crc]);
}

/** Minimal CRC-32 so the fixture PNG is valid on Node versions without zlib.crc32. */
function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

/** A tiny deterministic RGB PNG used as the battle-map source. */
function makePng(width: number, height: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const p = y * (stride + 1) + 1 + x * 3;
      raw[p] = (x * 2) & 0xff;
      raw[p + 1] = (y * 2) & 0xff;
      raw[p + 2] = ((x + y) * 2) & 0xff;
    }
  }
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

describe('Player Display cast sessions (e2e)', () => {
  let ctx: TestAppContext;
  let campaignId: number;
  let encounterId: number;
  /** A second encounter left in `preparing` — never castable, even by id. */
  let preparingEncounterId: number;
  const battleMap = makePng(4, 2);

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

    // Attach a fogged battle map: only the left half is revealed, so the source
    // attachment must never be reachable from the cast display.
    const upload = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/attachments`)
      .set(dm)
      .field('kind', 'map')
      .attach('file', battleMap, { filename: 'cast-map.png', contentType: 'image/png' });
    expect(upload.status).toBe(201);
    const mapPatch = await request(server)
      .patch(`/api/v1/encounters/${encounterId}`)
      .set(dm)
      .send({ mapAttachmentId: upload.body.id, fog: { enabled: true, revealed: [{ x: 0, y: 0, w: 50, h: 100 }] } });
    expect(mapPatch.status).toBe(200);

    expect((await request(server).post(`/api/v1/encounters/${encounterId}/roll-initiative`).set(dm)).status).toBe(201);
    expect((await request(server).post(`/api/v1/encounters/${encounterId}/start`).set(dm)).status).toBe(201);

    const prepping = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/encounters`)
      .set(dm)
      .send({ name: 'Act Three Ambush', hidden: false });
    preparingEncounterId = prepping.body.id;
    await request(server)
      .post(`/api/v1/encounters/${preparingEncounterId}/combatants`)
      .set(dm)
      .send({ kind: 'monster', name: 'Unrevealed Horror', hpMax: 90 });
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
    expect(summary.body.characters).toEqual([]);
    expect(summary.body.party).toEqual([expect.objectContaining({ name: 'Ember', hpCurrent: 12, hpMax: 12 })]);
    expect(summary.body.party[0]).not.toHaveProperty('dmSecret');
    expect(summary.body.party[0]).not.toHaveProperty('actions');

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

  it('404s an invalid capability even for an unsupported status filter', async () => {
    const server = ctx.app.getHttpServer();
    const bogus = `cf_cast_${'0'.repeat(48)}`;
    // The list endpoint only answers status=running, but an unknown/expired capability
    // must still 404 uniformly rather than being told `200 []` that its request worked.
    expect((await request(server).get(`/api/v1/cast/${bogus}/encounters`).query({ status: 'ended' })).status).toBe(404);
    expect((await request(server).get(`/api/v1/cast/${bogus}/encounters`)).status).toBe(404);

    // A VALID capability still gets an empty list for a status it does not serve.
    const created = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/cast-sessions`)
      .set(dm)
      .send({ label: 'Status TV', expiresAt: futureExpiry() });
    const ended = await request(server).get(`/api/v1/cast/${created.body.token}/encounters`).query({ status: 'ended' });
    expect(ended.status).toBe(200);
    expect(ended.body).toEqual([]);

    // Validating the capability must not ALSO resolve it on the running path: the kiosk
    // polls this endpoint continuously, and resolveActive() bumps access_count, so a
    // second resolve per request would double-count reads and double-write the row.
    const before = (await request(server).get(`/api/v1/campaigns/${campaignId}/cast-sessions`).set(dm)).body
      .find((s: { id: number }) => s.id === created.body.session.id).accessCount;
    await request(server).get(`/api/v1/cast/${created.body.token}/encounters`);
    const after = (await request(server).get(`/api/v1/campaigns/${campaignId}/cast-sessions`).set(dm)).body
      .find((s: { id: number }) => s.id === created.body.session.id).accessCount;
    expect(after - before).toBe(1);
  });

  it('scopes cast encounter reads to the RUNNING fight only', async () => {
    const server = ctx.app.getHttpServer();
    const created = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/cast-sessions`)
      .set(dm)
      .send({ label: 'Scope TV', expiresAt: futureExpiry() });
    const token = created.body.token as string;

    // The list endpoint deliberately exposes only the running encounter; reading a
    // preparing encounter by id must not be a way around that contract.
    const prepping = await request(server).get(`/api/v1/cast/${token}/encounters/${preparingEncounterId}`);
    expect(prepping.status).toBe(404);
    expect(JSON.stringify(prepping.body)).not.toContain('Unrevealed Horror');
    expect((await request(server).get(`/api/v1/cast/${token}/encounters/${preparingEncounterId}/map`)).status).toBe(404);
  });

  it('serves fog-rendered map pixels through the capability and never the DM source', async () => {
    const server = ctx.app.getHttpServer();
    const created = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/cast-sessions`)
      .set(dm)
      .send({ label: 'Map TV', expiresAt: futureExpiry() });
    const token = created.body.token as string;
    const mapPath = `/api/v1/cast/${token}/encounters/${encounterId}/map`;

    const castMap = await request(server).get(mapPath);
    expect(castMap.status).toBe(200);
    expect(castMap.headers['content-type']).toBe('image/png');
    expect(castMap.headers['x-campfire-map-view']).toBe('fog-protected');
    expect(castMap.headers['cache-control']).toContain('no-store');
    expect(castMap.headers['accept-ranges']).toBe('none');
    expect(castMap.headers['referrer-policy']).toBe('no-referrer');
    // The concealed source bytes are never handed to a cast client.
    expect(Buffer.compare(castMap.body, battleMap)).not.toBe(0);

    // The whole point of issue #547: a shared TV that ALSO carries DM credentials must
    // still get the fog-rendered projection from the cast URL, never the source map.
    const withDmCredentials = await request(server).get(mapPath).set(dm);
    expect(withDmCredentials.status).toBe(200);
    expect(withDmCredentials.headers['x-campfire-map-view']).toBe('fog-protected');
    expect(Buffer.compare(withDmCredentials.body, battleMap)).not.toBe(0);

    // For contrast, the membership-authenticated route DOES give a DM the source —
    // which is exactly why the cast page must not point an <img> at it.
    const dmSource = await request(server).get(`/api/v1/encounters/${encounterId}/map`).set(dm);
    expect(dmSource.status).toBe(200);
    expect(dmSource.headers['x-campfire-map-view']).toBe('fully-revealed');

    // Ranges are refused so a fog revision cannot be reassembled through a cache.
    expect((await request(server).get(mapPath).set('Range', 'bytes=0-31')).status).toBe(416);
    // And a cast bearer still cannot reach the authenticated map route.
    expect(
      (await request(server).get(`/api/v1/encounters/${encounterId}/map`).set('Authorization', `Bearer ${token}`)).status,
    ).toBe(403);

    // Revoking kills the map bytes immediately, same as the JSON endpoints.
    expect((await request(server).delete(`/api/v1/campaigns/${campaignId}/cast-sessions`).set(dm)).status).toBe(200);
    expect((await request(server).get(mapPath)).status).toBe(404);
  });

  it('refuses cast credentials that would outlive the 30-day ceiling', async () => {
    const server = ctx.app.getHttpServer();
    const tooFar = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000).toISOString();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/cast-sessions`)
      .set(dm)
      .send({ label: 'Forever TV', expiresAt: tooFar });
    expect(res.status).toBe(400);
    expect((await request(server).post(`/api/v1/campaigns/${campaignId}/cast-sessions`).set(dm).send({ expiresAt: futureExpiry(24 * 29) })).status).toBe(201);
  });
});
