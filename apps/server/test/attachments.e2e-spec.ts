import request from 'supertest';
import { createTestApp, createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };
const player = { 'x-dev-role': 'player', 'x-dev-user': 'player-1' };
const viewer = { 'x-dev-role': 'viewer', 'x-dev-user': 'viewer-1' };

// Minimal valid 1x1 PNG (smallest possible real PNG payload).
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108020000009077' +
    '53de0000000c4944415408d763f8ffff3f0005fe02fea1399e1e0000000049454e44ae426082',
  'hex',
);

// Minimal valid 1x1 JPEG (SOI + DQT + SOF + minimal scan + EOI).
const TINY_JPEG = Buffer.from(
  'ffd8ffdb004300030202020202030202020303030304060404040404080606' +
    '050609080a0a090809090a0c0f0c0a0b0e0b09090d110d0e0f101011100a0c' +
    '12131210130f101010ffc9000b080001000101011100ffcc000600101005ff' +
    'da0008010100003f00d2cf20ffd9',
  'hex',
);

// Minimal valid 1x1 WebP (RIFF container + lossy VP8 bitstream).
const TINY_WEBP = Buffer.from(
  '5249464624000000574542505650382018000000300100' + '9d012a0100010002003425a4000370' + '00fefbfd5000',
  'hex',
);

describe('attachments (e2e)', () => {
  let ctx: TestAppContext;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    const res = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Attachment Campaign' });
    campaignId = res.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('player may upload a portrait', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/attachments`)
      .set(player)
      .field('kind', 'portrait')
      .attach('file', TINY_PNG, { filename: 'me.png', contentType: 'image/png' });

    expect(res.status).toBe(201);
    expect(res.body.kind).toBe('portrait');
    expect(res.body.campaignId).toBe(campaignId);
    expect(res.body.mime).toBe('image/png');
    expect(res.body.filename).toBe('me.png');
    expect(res.body.size).toBe(TINY_PNG.length);
    expect(res.body.id).toBeGreaterThan(0);
  });

  it('viewer gets 403 uploading a portrait', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/attachments`)
      .set(viewer)
      .field('kind', 'portrait')
      .attach('file', TINY_PNG, { filename: 'x.png', contentType: 'image/png' });

    expect(res.status).toBe(403);
  });

  it('player gets 403 uploading a map', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/attachments`)
      .set(player)
      .field('kind', 'map')
      .attach('file', TINY_PNG, { filename: 'map.png', contentType: 'image/png' });

    expect(res.status).toBe(403);
  });

  it('dm may upload a map', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/attachments`)
      .set(dm)
      .field('kind', 'map')
      .attach('file', TINY_PNG, { filename: 'world.png', contentType: 'image/png' });

    expect(res.status).toBe(201);
    expect(res.body.kind).toBe('map');
  });

  it('oversize upload is rejected (413)', async () => {
    const server = ctx.app.getHttpServer();
    const big = Buffer.alloc(9 * 1024 * 1024, 1); // 9MB > 8MB limit
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/attachments`)
      .set(dm)
      .field('kind', 'image')
      .attach('file', big, { filename: 'big.png', contentType: 'image/png' });

    expect(res.status).toBe(413);
  });

  it('wrong mime type is rejected (400)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/attachments`)
      .set(dm)
      .field('kind', 'image')
      .attach('file', Buffer.from('not an image'), { filename: 'evil.svg', contentType: 'image/svg+xml' });

    expect(res.status).toBe(400);
  });

  // Issue #47 — the declared mimetype must match the actual file bytes (magic-byte
  // sniffing in AttachmentsService.create); the multipart header alone is not trusted.
  describe('content sniffing (magic bytes)', () => {
    it('HTML bytes declared as image/png are rejected (400)', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .set(dm)
        .field('kind', 'image')
        .attach('file', Buffer.from('<html><script>alert(1)</script></html>'), {
          filename: 'sneaky.png',
          contentType: 'image/png',
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('does not match');
    });

    it('PNG bytes declared as image/jpeg are rejected (400)', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .set(dm)
        .field('kind', 'image')
        .attach('file', TINY_PNG, { filename: 'notjpeg.jpg', contentType: 'image/jpeg' });

      expect(res.status).toBe(400);
    });

    it('JPEG bytes declared as image/webp are rejected (400)', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .set(dm)
        .field('kind', 'image')
        .attach('file', TINY_JPEG, { filename: 'notwebp.webp', contentType: 'image/webp' });

      expect(res.status).toBe(400);
    });

    it('a real JPEG declared as image/jpeg is accepted', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .set(dm)
        .field('kind', 'image')
        .attach('file', TINY_JPEG, { filename: 'real.jpg', contentType: 'image/jpeg' });

      expect(res.status).toBe(201);
      expect(res.body.mime).toBe('image/jpeg');
    });

    it('a real WebP declared as image/webp is accepted', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .set(dm)
        .field('kind', 'image')
        .attach('file', TINY_WEBP, { filename: 'real.webp', contentType: 'image/webp' });

      expect(res.status).toBe(201);
      expect(res.body.mime).toBe('image/webp');
    });

    it('a buffer too short to carry any magic bytes is rejected (400)', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .set(dm)
        .field('kind', 'image')
        .attach('file', Buffer.from([0x89]), { filename: 'stub.png', contentType: 'image/png' });

      expect(res.status).toBe(400);
    });
  });

  it('missing file is rejected (400)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/attachments`)
      .set(dm)
      .field('kind', 'image');

    expect(res.status).toBe(400);
  });

  describe('file streaming + membership', () => {
    let attachmentId: number;

    beforeAll(async () => {
      const server = ctx.app.getHttpServer();
      const uploadRes = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .set(dm)
        .field('kind', 'image')
        .attach('file', TINY_PNG, { filename: 'shared.png', contentType: 'image/png' });
      attachmentId = uploadRes.body.id;
    });

    it('member can GET the file bytes', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server).get(`/api/v1/attachments/${attachmentId}/file`).set(dm);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(Buffer.compare(res.body, TINY_PNG)).toBe(0);
    });

    it('GET on a nonexistent attachment id is 404', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server).get(`/api/v1/attachments/999999/file`).set(viewer);
      expect(res.status).toBe(404);
    });
  });

  describe('delete', () => {
    let attachmentId: number;

    beforeEach(async () => {
      const server = ctx.app.getHttpServer();
      const uploadRes = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .set(player)
        .field('kind', 'portrait')
        .attach('file', TINY_PNG, { filename: 'del.png', contentType: 'image/png' });
      attachmentId = uploadRes.body.id;
    });

    it('uploader may delete their own attachment', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server).delete(`/api/v1/attachments/${attachmentId}`).set(player);
      expect(res.status).toBe(200);

      const getRes = await request(server).get(`/api/v1/attachments/${attachmentId}/file`).set(player);
      expect(getRes.status).toBe(404);
    });

    it('dm may delete any attachment', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server).delete(`/api/v1/attachments/${attachmentId}`).set(dm);
      expect(res.status).toBe(200);
    });

    it('non-uploader, non-dm player gets 403 on delete', async () => {
      const server = ctx.app.getHttpServer();
      const otherPlayer = { 'x-dev-role': 'player', 'x-dev-user': 'someone-else' };
      const res = await request(server).delete(`/api/v1/attachments/${attachmentId}`).set(otherPlayer);
      expect(res.status).toBe(403);
    });
  });

  describe('campaign map wiring', () => {
    it('PATCH campaigns/:id sets mapAttachmentId after a map upload', async () => {
      const server = ctx.app.getHttpServer();
      const uploadRes = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .set(dm)
        .field('kind', 'map')
        .attach('file', TINY_PNG, { filename: 'region.png', contentType: 'image/png' });
      expect(uploadRes.status).toBe(201);
      const attachmentId = uploadRes.body.id;

      const patchRes = await request(server)
        .patch(`/api/v1/campaigns/${campaignId}`)
        .set(dm)
        .send({ mapAttachmentId: attachmentId });
      expect(patchRes.status).toBe(200);
      expect(patchRes.body.mapAttachmentId).toBe(attachmentId);

      const getRes = await request(server).get(`/api/v1/campaigns/${campaignId}`).set(dm);
      expect(getRes.body.mapAttachmentId).toBe(attachmentId);

      // Remove map
      const clearRes = await request(server)
        .patch(`/api/v1/campaigns/${campaignId}`)
        .set(dm)
        .send({ mapAttachmentId: null });
      expect(clearRes.status).toBe(200);
      expect(clearRes.body.mapAttachmentId).toBeNull();
    });

    // P2 fix pinning test — deleting an attachment must clear any campaign.mapAttachmentId
    // that pointed at it, so the campaign doesn't keep referencing a now-gone file.
    it('deleting the attachment set as the campaign map clears campaign.mapAttachmentId', async () => {
      const server = ctx.app.getHttpServer();
      const uploadRes = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .set(dm)
        .field('kind', 'map')
        .attach('file', TINY_PNG, { filename: 'danglemap.png', contentType: 'image/png' });
      expect(uploadRes.status).toBe(201);
      const attachmentId = uploadRes.body.id;

      const patchRes = await request(server).patch(`/api/v1/campaigns/${campaignId}`).set(dm).send({ mapAttachmentId: attachmentId });
      expect(patchRes.status).toBe(200);
      expect(patchRes.body.mapAttachmentId).toBe(attachmentId);

      const deleteRes = await request(server).delete(`/api/v1/attachments/${attachmentId}`).set(dm);
      expect(deleteRes.status).toBe(200);

      const getRes = await request(server).get(`/api/v1/campaigns/${campaignId}`).set(dm);
      expect(getRes.body.mapAttachmentId).toBeNull();
    });
  });

  // P2 fix pinning test — deleting an attachment must clear any character.portraitUrl
  // that pointed at it (character.portraitUrl is a resolved `.../attachments/<id>/file`
  // URL string, not a numeric FK — see AttachmentsService.remove).
  describe('portrait wiring', () => {
    it('deleting the attachment used as a character portrait clears character.portraitUrl', async () => {
      const server = ctx.app.getHttpServer();
      const uploadRes = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .set(player)
        .field('kind', 'portrait')
        .attach('file', TINY_PNG, { filename: 'dangleportrait.png', contentType: 'image/png' });
      expect(uploadRes.status).toBe(201);
      const attachmentId = uploadRes.body.id;
      const portraitUrl = `/api/v1/attachments/${attachmentId}/file`;

      const charRes = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/characters`)
        .set(player)
        .send({ name: 'Portrait Owner', portraitUrl });
      expect(charRes.status).toBe(201);
      const characterId = charRes.body.id;
      expect(charRes.body.portraitUrl).toBe(portraitUrl);

      const deleteRes = await request(server).delete(`/api/v1/attachments/${attachmentId}`).set(player);
      expect(deleteRes.status).toBe(200);

      const getRes = await request(server).get(`/api/v1/characters/${characterId}`).set(player);
      expect(getRes.status).toBe(200);
      expect(getRes.body.portraitUrl).toBeNull();
    });

    it('deleting an unrelated attachment does not touch a character portraitUrl pointing elsewhere', async () => {
      const server = ctx.app.getHttpServer();
      const keepUpload = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .set(player)
        .field('kind', 'portrait')
        .attach('file', TINY_PNG, { filename: 'keep.png', contentType: 'image/png' });
      const keepId = keepUpload.body.id;
      const keepUrl = `/api/v1/attachments/${keepId}/file`;

      const otherUpload = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .set(player)
        .field('kind', 'portrait')
        .attach('file', TINY_PNG, { filename: 'other.png', contentType: 'image/png' });
      const otherId = otherUpload.body.id;

      const charRes = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/characters`)
        .set(player)
        .send({ name: 'Unaffected Owner', portraitUrl: keepUrl });
      const characterId = charRes.body.id;

      const deleteRes = await request(server).delete(`/api/v1/attachments/${otherId}`).set(player);
      expect(deleteRes.status).toBe(200);

      const getRes = await request(server).get(`/api/v1/characters/${characterId}`).set(player);
      expect(getRes.body.portraitUrl).toBe(keepUrl);
    });
  });
});

// Dev-auth headers (x-dev-role/x-dev-user) always resolve to serverRole 'admin', and
// admins are always treated as dm regardless of campaign membership (see
// RoleResolver.baseEffectiveRole) — so the "non-member" 403 case can't be expressed
// with dev-auth users. Use real cookie-session users instead, same pattern as
// membership.e2e-spec.ts.
describe('attachments (e2e, real cookie sessions — non-member access)', () => {
  let ctx: TestAppContext;
  let dmAgent: ReturnType<typeof request.agent>;
  let outsiderAgent: ReturnType<typeof request.agent>;
  let campaignId: number;
  let attachmentId: number;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    const adminAgent = request.agent(server);
    await adminAgent.post('/api/v1/auth/setup').send({ username: 'root-admin-2', password: 'admin-password-1' });
    await adminAgent.post('/api/v1/users').send({ username: 'dm-real', password: 'password-dm-1', serverRole: 'user' });
    await adminAgent.post('/api/v1/users').send({ username: 'outsider-real', password: 'password-out-1', serverRole: 'user' });

    dmAgent = request.agent(server);
    await dmAgent.post('/api/v1/auth/login').send({ username: 'dm-real', password: 'password-dm-1' });

    outsiderAgent = request.agent(server);
    await outsiderAgent.post('/api/v1/auth/login').send({ username: 'outsider-real', password: 'password-out-1' });

    const createRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'Private Campaign' });
    campaignId = createRes.body.id;

    const uploadRes = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/attachments`)
      .field('kind', 'image')
      .attach('file', TINY_PNG, { filename: 'secret.png', contentType: 'image/png' });
    expect(uploadRes.status).toBe(201);
    attachmentId = uploadRes.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('member (dm) can GET the file', async () => {
    const res = await dmAgent.get(`/api/v1/attachments/${attachmentId}/file`);
    expect(res.status).toBe(200);
  });

  it('non-member gets 403 on file GET', async () => {
    const res = await outsiderAgent.get(`/api/v1/attachments/${attachmentId}/file`);
    expect(res.status).toBe(403);
  });

  it('non-member gets 403 attempting upload', async () => {
    const res = await outsiderAgent
      .post(`/api/v1/campaigns/${campaignId}/attachments`)
      .field('kind', 'portrait')
      .attach('file', TINY_PNG, { filename: 'x.png', contentType: 'image/png' });
    expect(res.status).toBe(403);
  });
});
