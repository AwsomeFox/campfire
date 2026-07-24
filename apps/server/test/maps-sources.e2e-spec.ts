import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };
const viewer = { 'x-dev-role': 'viewer', 'x-dev-user': 'v-1' };

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Smallest buffer the magic-byte sniff (sniffImageMime) accepts as a PNG — enough to import. */
function tinyPng(): Buffer {
  return Buffer.concat([PNG_MAGIC, Buffer.from('one-page-dungeon-entry-bytes')]);
}

/**
 * Open map SOURCES + One Page Dungeon (CC-BY-SA) attributed import (issue #303). Complements
 * the #306 procedural generator: this is the EXTERNAL open-source catalog + the license-clean
 * import path, not a re-do of the first-party generator.
 */
describe('open map sources + attributed import (e2e, issue #303)', () => {
  let ctx: TestAppContext;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    const res = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Sources Campaign' });
    campaignId = res.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('lists the curated open map-source catalog (generators + One Page Dungeon)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).get(`/api/v1/campaigns/${campaignId}/maps/sources`).set(dm);
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: string }>).map((s) => s.id);

    // The built-in generator (#306), external generators, and the importable CC-BY-SA source.
    expect(ids).toContain('campfire-generator');
    expect(ids).toContain('watabou-one-page-dungeon');
    expect(ids).toContain('donjon-fantasy-maps');
    expect(ids).toContain('one-page-dungeon-contest');

    const builtin = res.body.find((s: { id: string }) => s.id === 'campfire-generator');
    expect(builtin.kind).toBe('generator-builtin');
    expect(builtin.url).toBeUndefined(); // built-in generator is an in-app endpoint, not a link

    const watabou = res.body.find((s: { id: string }) => s.id === 'watabou-one-page-dungeon');
    expect(watabou.kind).toBe('generator-external');
    expect(watabou.url).toContain('watabou.github.io');
    expect(watabou.importable).toBe(false); // linked, never bundled/re-served

    // One Page Dungeon: CC-BY-SA, attribution required, importable.
    const opd = res.body.find((s: { id: string }) => s.id === 'one-page-dungeon-contest');
    expect(opd.kind).toBe('importable-collection');
    expect(opd.license).toMatch(/CC-BY-SA/i);
    expect(opd.attributionRequired).toBe(true);
    expect(opd.importable).toBe(true);

    // Every *importable* source names an open licence (the #19 gate, un-weakened).
    for (const s of res.body as Array<{ importable: boolean; license: string }>) {
      if (s.importable) expect(s.license.toLowerCase()).toMatch(/cc-?by|cc0|ogl|creative commons|public domain/);
    }
  });

  it('imports a One Page Dungeon entry (CC-BY-SA) as a hidden map, stamping attribution', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/maps/import`)
      .set(dm)
      .field('title', 'The Sunken Abbey')
      .field('author', 'Jane Cartographer')
      .field('license', 'CC-BY-SA 3.0')
      .field('sourceUrl', 'https://www.dungeoncontest.com/entry/sunken-abbey')
      .field('sourceId', 'one-page-dungeon-contest')
      .attach('file', tinyPng(), { filename: 'sunken-abbey.png', contentType: 'image/png' });

    expect(res.status).toBe(201);
    expect(res.body.attachment.kind).toBe('map');
    expect(res.body.attachment.mime).toBe('image/png');
    expect(res.body.attachment.hidden).toBe(true); // DM-only prep, never auto-leaks (#97/#259)
    // Attribution is stamped onto the filename so the credit travels with the artifact.
    expect(res.body.attachment.filename).toContain('The Sunken Abbey');
    expect(res.body.attachment.filename).toContain('Jane Cartographer');
    expect(res.body.attachment.filename).toContain('CC-BY-SA 3.0');
    expect(res.body.attribution.license).toBe('CC-BY-SA 3.0');
    expect(res.body.attribution.author).toBe('Jane Cartographer');

    // The imported bytes stream back as a PNG.
    const file = await request(server).get(`/api/v1/attachments/${res.body.attachment.id}/file`).set(dm);
    expect(file.status).toBe(200);
    expect(String(file.headers['content-type'])).toContain('image/png');
  });

  it('imports a curated external-generator export whose licence names no CC/OGL keyword (issue #411)', async () => {
    const server = ctx.app.getHttpServer();
    // Watabou's licence ("free for commercial use…") deliberately names no CC/OGL keyword, so
    // it would fail the collection gate — but a generator OUTPUT is the DM's own file under a
    // curated permissive grant, so `sourceId` routes it past the gate. The server trusts the
    // CURATED licence, not the client string, so a spoofed licence field can't matter.
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/maps/import`)
      .set(dm)
      .field('title', 'Ruined Keep')
      .field('author', 'Watabou — One Page Dungeon')
      .field('license', 'totally made up licence') // ignored: derived from the curated source
      .field('sourceUrl', 'https://watabou.github.io/one-page-dungeon/')
      .field('sourceId', 'watabou-one-page-dungeon')
      .attach('file', tinyPng(), { filename: 'ruined-keep.png', contentType: 'image/png' });

    expect(res.status).toBe(201);
    expect(res.body.attachment.kind).toBe('map');
    expect(res.body.attachment.hidden).toBe(true); // never auto-publishes (#97/#259)
    // The trusted, curated licence is what gets stamped + returned — not the client's string.
    expect(res.body.attribution.license).toMatch(/free for commercial use/i);
    expect(res.body.attachment.filename).toContain('Ruined Keep');
    expect(res.body.attachment.filename).not.toContain('made up');

    // Provenance: the audit trail records the curated source id (issue #411), mirroring the
    // generator-builtin seed detail, so an imported map is attributable from the log alone.
    const audit = await request(server).get(`/api/v1/campaigns/${campaignId}/audit`).set(dm);
    const row = audit.body.find(
      (a: { action: string; entityId: number }) =>
        a.action === 'attachment.generate' && a.entityId === res.body.attachment.id,
    );
    expect(row).toBeDefined();
    expect(row.detail).toBe('map:import:source=watabou-one-page-dungeon');
  });

  it('imports a donjon (OGL) export as a hidden map (issue #411)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/maps/import`)
      .set(dm)
      .field('title', 'Sunless Warren')
      .field('author', 'donjon — Fantasy Maps')
      .field('license', 'OGL (generated content)')
      .field('sourceId', 'donjon-fantasy-maps')
      .attach('file', tinyPng(), { filename: 'sunless-warren.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
    expect(res.body.attachment.hidden).toBe(true);
    expect(res.body.attribution.license).toMatch(/OGL/i);
  });

  it('still gates an unknown sourceId behind the open-licence check (no spoofing the bypass)', async () => {
    const server = ctx.app.getHttpServer();
    // An unknown sourceId must NOT unlock the generator bypass — it falls through to the
    // strict gate, so a non-open licence is still refused.
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/maps/import`)
      .set(dm)
      .field('title', 'Sneaky Pack')
      .field('author', 'Some Studio')
      .field('license', 'All Rights Reserved')
      .field('sourceId', 'not-a-real-source')
      .attach('file', tinyPng(), { filename: 'x.png', contentType: 'image/png' });
    expect(res.status).toBe(400);
  });

  it('defaults the licence to CC-BY-SA 3.0 when omitted', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/maps/import`)
      .set(dm)
      .field('title', 'Untitled Vault')
      .field('author', 'Anon')
      .attach('file', tinyPng(), { filename: 'vault.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
    expect(res.body.attribution.license).toBe('CC-BY-SA 3.0');
  });

  it('rejects a non-open licence (NC/ND cannot be re-served) with 400', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/maps/import`)
      .set(dm)
      .field('title', 'Premium Battlemap Pack')
      .field('author', 'Some Studio')
      .field('license', 'CC-BY-NC-ND 4.0')
      .attach('file', tinyPng(), { filename: 'pack.png', contentType: 'image/png' });
    expect(res.status).toBe(400);
  });

  it('rejects non-image bytes with 400', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/maps/import`)
      .set(dm)
      .field('title', 'Not an image')
      .field('author', 'Anon')
      .field('license', 'CC0')
      .attach('file', Buffer.from('<html>not an image</html>'), { filename: 'x.png', contentType: 'image/png' });
    expect(res.status).toBe(400);
  });

  it('rejects a missing file with 400', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/maps/import`)
      .set(dm)
      .field('title', 'No file')
      .field('author', 'Anon')
      .field('license', 'CC-BY-SA 3.0');
    expect(res.status).toBe(400);
  });

  it('a non-DM cannot import a map (403)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/maps/import`)
      .set(viewer)
      .field('title', 'Sneaky')
      .field('author', 'Anon')
      .field('license', 'CC-BY-SA 3.0')
      .attach('file', tinyPng(), { filename: 'x.png', contentType: 'image/png' });
    expect(res.status).toBe(403);
  });

  it('rejects an unknown attribution field (strict DTO) with 400', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/maps/import`)
      .set(dm)
      .field('title', 'Ok')
      .field('author', 'Anon')
      .field('license', 'CC-BY-SA 3.0')
      .field('bogus', 'nope')
      .attach('file', tinyPng(), { filename: 'x.png', contentType: 'image/png' });
    expect(res.status).toBe(400);
  });
});
