import request from 'supertest';
import type { Server } from 'node:http';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };
const viewer = { 'x-dev-role': 'viewer', 'x-dev-user': 'v-1' };

/**
 * Fetch a generated map's bytes as a UTF-8 string. supertest only populates `res.text`
 * for text-like content types; image/svg+xml streams into a Buffer, so buffer it
 * explicitly and decode.
 */
async function fetchSvg(server: Server, id: number): Promise<{ status: number; contentType: string; svg: string }> {
  const res = await request(server).get(`/api/v1/attachments/${id}/file`).set(dm).buffer(true).parse((r, cb) => {
    const chunks: Buffer[] = [];
    r.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
    r.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  return {
    status: res.status,
    contentType: String(res.headers['content-type'] ?? ''),
    svg: (res.body as Buffer).toString('utf8'),
  };
}

// A second, real member campaign for the role-gating checks (dev-header players are
// server admins, so we assert gating against a token-scoped viewer instead — see below).
describe('procedural map generation (e2e, issue #306)', () => {
  let ctx: TestAppContext;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    const res = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Map Campaign' });
    campaignId = res.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('generates a dungeon map for a campaign, saved as a hidden SVG attachment with grid config', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/maps/generate`)
      .set(dm)
      .send({ kind: 'dungeon', size: 'medium', seed: 'unit-seed' });

    expect(res.status).toBe(201);
    expect(res.body.attachmentId).toBeGreaterThan(0);
    expect(res.body.seed).toBe('unit-seed');
    expect(res.body.kind).toBe('dungeon');
    expect(res.body.widthCells).toBe(30);
    expect(res.body.heightCells).toBe(22);
    expect(res.body.roomCount).toBeGreaterThan(0);
    // gridSize = one cell as a percent of width = 100/30.
    expect(res.body.gridConfig.gridSize).toBeCloseTo(100 / 30, 5);
    expect(res.body.gridConfig.gridScale).toBe(5);
    expect(res.body.gridConfig.gridUnit).toBe('ft');
    expect(res.body.gridConfig.gridType).toBe('square');

    // The attachment metadata: kind=map, image/svg+xml, and DEFAULT HIDDEN (#97/#259).
    const meta = await request(server).get(`/api/v1/campaigns/${campaignId}/attachments`).set(dm);
    const row = meta.body.find((a: { id: number }) => a.id === res.body.attachmentId);
    expect(row).toBeDefined();
    expect(row.kind).toBe('map');
    expect(row.mime).toBe('image/svg+xml');
    expect(row.hidden).toBe(true);

    // The file streams as SVG.
    const file = await fetchSvg(server, res.body.attachmentId);
    expect(file.status).toBe(200);
    expect(file.contentType).toContain('image/svg+xml');
    expect(file.svg.startsWith('<svg')).toBe(true);
    expect(file.svg).toContain('viewBox="0 0 1200 880"'); // 30*40 x 22*40
  });

  it('is deterministic — same seed + params yields byte-identical SVG', async () => {
    const server = ctx.app.getHttpServer();
    const a = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/maps/generate`)
      .set(dm)
      .send({ kind: 'dungeon', size: 'small', seed: 'repro-1', complexity: 0.7, theme: 'crypt' });
    const b = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/maps/generate`)
      .set(dm)
      .send({ kind: 'dungeon', size: 'small', seed: 'repro-1', complexity: 0.7, theme: 'crypt' });

    const fileA = await fetchSvg(server, a.body.attachmentId);
    const fileB = await fetchSvg(server, b.body.attachmentId);
    expect(fileA.svg).toBe(fileB.svg);

    // A different seed produces a different map.
    const c = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/maps/generate`)
      .set(dm)
      .send({ kind: 'dungeon', size: 'small', seed: 'repro-2', complexity: 0.7, theme: 'crypt' });
    const fileC = await fetchSvg(server, c.body.attachmentId);
    expect(fileC.svg).not.toBe(fileA.svg);
  });

  it('cave and wilderness kinds generate valid SVGs', async () => {
    const server = ctx.app.getHttpServer();
    for (const kind of ['cave', 'wilderness'] as const) {
      const res = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/maps/generate`)
        .set(dm)
        .send({ kind, size: 'small', seed: `k-${kind}` });
      expect(res.status).toBe(201);
      expect(res.body.kind).toBe(kind);
      const file = await fetchSvg(server, res.body.attachmentId);
      expect(file.svg.startsWith('<svg')).toBe(true);
      expect(file.svg.endsWith('</svg>')).toBe(true);
    }
  });

  it('returns a server-chosen seed when none is supplied', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post(`/api/v1/campaigns/${campaignId}/maps/generate`).set(dm).send({ kind: 'dungeon' });
    expect(res.status).toBe(201);
    expect(typeof res.body.seed).toBe('string');
    expect(res.body.seed.length).toBeGreaterThan(0);
  });

  it('generate-map attaches to an encounter as its battle map + aligns the grid, staying hidden', async () => {
    const server = ctx.app.getHttpServer();
    const encRes = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Ambush' });
    expect(encRes.status).toBe(201);
    const encounterId = encRes.body.id;

    const gen = await request(server)
      .post(`/api/v1/encounters/${encounterId}/generate-map`)
      .set(dm)
      .send({ kind: 'dungeon', size: 'large', seed: 'enc-seed' });
    expect(gen.status).toBe(201);
    expect(gen.body.attachmentId).toBeGreaterThan(0);

    // The encounter now points at the generated map with an aligned grid.
    const enc = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
    expect(enc.body.mapAttachmentId).toBe(gen.body.attachmentId);
    expect(enc.body.gridSize).toBeCloseTo(100 / 40, 5);
    expect(enc.body.gridScale).toBe(5);
    expect(enc.body.gridType).toBe('square');

    // The map attachment is hidden (never auto-revealed to players, #259 / #463) …
    const meta = await request(server).get(`/api/v1/campaigns/${campaignId}/attachments`).set(dm);
    const row = meta.body.find((a: { id: number }) => a.id === gen.body.attachmentId);
    expect(row.hidden).toBe(true);
    // … and the DM can still fetch the source. Non-DMs load role-safe bytes through
    // GET /encounters/:id/map — raw attachment URLs stay DM-only while hidden.
    const file = await fetchSvg(server, gen.body.attachmentId);
    expect(file.status).toBe(200);
    expect(file.contentType).toContain('image/svg+xml');
  });

  it('a non-DM member cannot generate a map (403)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/maps/generate`)
      .set(viewer)
      .send({ kind: 'dungeon' });
    expect(res.status).toBe(403);
  });

  it('rejects an unknown key in the body (strict DTO)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/maps/generate`)
      .set(dm)
      .send({ kind: 'dungeon', bogus: true });
    expect(res.status).toBe(400);
  });

  it('audit records the generator source + seed for a generated map (issue #409)', async () => {
    const server = ctx.app.getHttpServer();
    const gen = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/maps/generate`)
      .set(dm)
      .send({ kind: 'dungeon', size: 'small', seed: 'audit-seed' });
    expect(gen.status).toBe(201);

    const audit = await request(server).get(`/api/v1/campaigns/${campaignId}/audit`).set(dm);
    expect(audit.status).toBe(200);
    const row = audit.body.find(
      (a: { action: string; entityId: number }) =>
        a.action === 'attachment.generate' && a.entityId === gen.body.attachmentId,
    );
    expect(row).toBeDefined();
    // actor + source (generator-builtin) + seed all recoverable from the audit trail.
    expect(row.actor).toBeTruthy();
    expect(row.detail).toBe('map:generator-builtin:seed=audit-seed');
  });
});

/**
 * Preview endpoint (issue #409): render a candidate map WITHOUT persisting it, so the
 * web wizard can preview/reroll before committing. "Use this map" then replays the seed
 * through the persisting endpoints for a byte-identical attach.
 */
describe('procedural map PREVIEW (e2e, issue #409)', () => {
  let ctx: TestAppContext;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    const res = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Preview Campaign' });
    campaignId = res.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  async function countAttachments(server: Server): Promise<number> {
    const meta = await request(server).get(`/api/v1/campaigns/${campaignId}/attachments`).set(dm);
    return (meta.body as unknown[]).length;
  }

  it('returns the SVG + seed + grid config but creates NO attachment', async () => {
    const server = ctx.app.getHttpServer();
    const before = await countAttachments(server);

    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/maps/generate/preview`)
      .set(dm)
      .send({ kind: 'dungeon', size: 'medium', seed: 'preview-seed' });

    expect(res.status).toBe(201);
    expect(res.body.svg.startsWith('<svg')).toBe(true);
    expect(res.body.seed).toBe('preview-seed');
    expect(res.body.kind).toBe('dungeon');
    expect(res.body.widthCells).toBe(30);
    expect(res.body.heightCells).toBe(22);
    expect(res.body.gridConfig.gridSize).toBeCloseTo(100 / 30, 5);
    expect(res.body).not.toHaveProperty('attachmentId');

    // No orphan attachment + no quota consumed (issue #409).
    const after = await countAttachments(server);
    expect(after).toBe(before);
  });

  it('rerolling many times never persists an attachment', async () => {
    const server = ctx.app.getHttpServer();
    const before = await countAttachments(server);
    for (let i = 0; i < 5; i++) {
      const res = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/maps/generate/preview`)
        .set(dm)
        .send({ kind: 'cave', size: 'small' });
      expect(res.status).toBe(201);
      expect(typeof res.body.seed).toBe('string');
    }
    expect(await countAttachments(server)).toBe(before);
  });

  it('preview is byte-identical to the persisted generate for the same seed (reproducible Use)', async () => {
    const server = ctx.app.getHttpServer();
    const preview = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/maps/generate/preview`)
      .set(dm)
      .send({ kind: 'dungeon', size: 'small', seed: 'use-seed', complexity: 0.6, theme: 'crypt' });
    expect(preview.status).toBe(201);

    // "Use this map" replays the same seed through the persisting endpoint.
    const gen = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/maps/generate`)
      .set(dm)
      .send({ kind: 'dungeon', size: 'small', seed: 'use-seed', complexity: 0.6, theme: 'crypt' });
    expect(gen.status).toBe(201);

    const file = await fetchSvg(server, gen.body.attachmentId);
    expect(file.svg).toBe(preview.body.svg);
  });

  it('a non-DM member cannot preview a map (403)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/maps/generate/preview`)
      .set(viewer)
      .send({ kind: 'dungeon' });
    expect(res.status).toBe(403);
  });
});
