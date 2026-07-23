import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import { createTestApp, createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';
import { AttachmentsService } from '../src/modules/attachments/attachments.service';
import { DB, DB_HOLDER, type DrizzleDb } from '../src/db/db.module';
import { encounters } from '../src/db/schema';

// --- Test-only PNG builder: produces a real WxH 8-bit RGB PNG so we can exercise
// the server's thumbnail downscaler on an image larger than the thumb cap. ---
const PNG_CRC_TABLE: number[] = (() => {
  const t = new Array<number>(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function pngCrc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = PNG_CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(pngCrc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function makePng(width: number, height: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const p = y * (stride + 1) + 1 + x * 3;
      raw[p] = (x * 2) & 0xff;
      raw[p + 1] = (y * 2) & 0xff;
      raw[p + 2] = ((x + y) * 2) & 0xff;
    }
  }
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}
function pngWidth(buf: Buffer): number {
  return buf.readUInt32BE(16); // IHDR width lives at offset 16 (8 sig + 8 chunk header)
}
function pngHeight(buf: Buffer): number {
  return buf.readUInt32BE(20); // IHDR height directly follows width
}

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
    const big = Buffer.alloc(33 * 1024 * 1024, 1); // 33MB > 32MB limit
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

    // Issue #630: Content-Disposition must keep an ASCII filename= fallback and
    // put Unicode in RFC 5987 filename* — never percent-encode into filename=.
    describe('Content-Disposition filename encoding (issue #630)', () => {
      async function uploadAndGetDisposition(filename: string): Promise<{
        stored: string;
        disposition: string;
      }> {
        const server = ctx.app.getHttpServer();
        const up = await request(server)
          .post(`/api/v1/campaigns/${campaignId}/attachments`)
          .set(dm)
          .field('kind', 'image')
          .attach('file', TINY_PNG, { filename, contentType: 'image/png' });
        expect(up.status).toBe(201);
        const get = await request(server).get(`/api/v1/attachments/${up.body.id}/file`).set(dm);
        expect(get.status).toBe(200);
        return { stored: up.body.filename, disposition: String(get.headers['content-disposition']) };
      }

      it('ASCII names use a plain quoted filename=', async () => {
        const { stored, disposition } = await uploadAndGetDisposition('me.png');
        expect(stored).toBe('me.png');
        expect(disposition).toBe('inline; filename="me.png"');
        expect(disposition).not.toContain('filename*');
      });

      it('quoted names escape quotes in filename=', async () => {
        const { disposition } = await uploadAndGetDisposition('photo "quote".png');
        expect(disposition).toBe('inline; filename="photo \\"quote\\".png"');
      });

      it('commas stay inside the quoted filename=', async () => {
        const { disposition } = await uploadAndGetDisposition('a,b.png');
        expect(disposition).toBe('inline; filename="a,b.png"');
      });

      it('Unicode names get ASCII fallback + UTF-8 filename*', async () => {
        const { stored, disposition } = await uploadAndGetDisposition('файл.png');
        expect(stored).toBe('файл.png');
        expect(disposition).toContain('filename="____.png"');
        expect(disposition).toContain("filename*=UTF-8''%D1%84%D0%B0%D0%B9%D0%BB.png");
        expect(disposition).not.toMatch(/filename="%/);
      });

      it('CJK / emoji names round-trip via filename*', async () => {
        const { stored, disposition } = await uploadAndGetDisposition('地図🎉.png');
        expect(stored).toBe('地図🎉.png');
        expect(disposition).toMatch(/^inline; filename="/);
        expect(disposition).toContain("filename*=UTF-8''");
        expect(disposition).toContain(encodeURIComponent('地図🎉.png'));
      });
    });

    it('GET on a nonexistent attachment id is 404', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server).get(`/api/v1/attachments/999999/file`).set(viewer);
      expect(res.status).toBe(404);
    });

    // Issue #84 regression: DB row present but the on-disk file is gone (orphaned row).
    // Previously `fs.createReadStream(...).pipe(res)` had no 'error' listener, so the
    // ENOENT surfaced as an uncaught exception and crashed the whole server process.
    // It must instead return 404 and leave the process alive to serve further requests.
    it('GET is 404 (not a crash) when the DB row exists but the file was deleted from disk', async () => {
      const server = ctx.app.getHttpServer();
      const uploadRes = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .set(dm)
        .field('kind', 'image')
        .attach('file', TINY_PNG, { filename: 'orphan.png', contentType: 'image/png' });
      expect(uploadRes.status).toBe(201);
      const orphanId = uploadRes.body.id;

      // Delete the bytes on disk, keeping the DB row — manufacture an orphan.
      const diskPath = path.join(ctx.dataDir, 'uploads', String(campaignId), `${orphanId}.png`);
      expect(fs.existsSync(diskPath)).toBe(true);
      fs.rmSync(diskPath);

      const res = await request(server).get(`/api/v1/attachments/${orphanId}/file`).set(dm);
      expect(res.status).toBe(404);

      // The process is still up: an unrelated request served fine right after.
      const stillAlive = await request(server).get(`/api/v1/attachments/999998/file`).set(dm);
      expect(stillAlive.status).toBe(404);
    });

    // Same orphaned-file case via the ?size=thumb variant — thumbnail generation reads
    // the (now-missing) original, so it must also yield a clean 404, never a crash.
    it('GET ?size=thumb is 404 (not a crash) when the file is missing', async () => {
      const server = ctx.app.getHttpServer();
      const uploadRes = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .set(dm)
        .field('kind', 'image')
        .attach('file', TINY_PNG, { filename: 'orphan-thumb.png', contentType: 'image/png' });
      expect(uploadRes.status).toBe(201);
      const orphanId = uploadRes.body.id;

      const diskPath = path.join(ctx.dataDir, 'uploads', String(campaignId), `${orphanId}.png`);
      expect(fs.existsSync(diskPath)).toBe(true);
      fs.rmSync(diskPath);

      const res = await request(server).get(`/api/v1/attachments/${orphanId}/file?size=thumb`).set(dm);
      expect(res.status).toBe(404);
    });
  });

  // Issue #97 — per-attachment visibility / staged reveal. A DM-uploaded map/image
  // is DM-only by default (hidden=true): non-DM members get a 404 on the file GET
  // and never see it in the campaign attachment list, defeating id enumeration.
  // The DM reveals it (POST :id/reveal) to share it with the party; hide re-stages.
  describe('visibility / staged reveal (issue #97)', () => {
    it("a freshly uploaded map is hidden by default; a portrait is visible", async () => {
      const server = ctx.app.getHttpServer();
      const mapRes = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .set(dm)
        .field('kind', 'map')
        .attach('file', TINY_PNG, { filename: 'prep-map.png', contentType: 'image/png' });
      expect(mapRes.status).toBe(201);
      expect(mapRes.body.hidden).toBe(true);

      const portraitRes = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .set(player)
        .field('kind', 'portrait')
        .attach('file', TINY_PNG, { filename: 'face.png', contentType: 'image/png' });
      expect(portraitRes.status).toBe(201);
      expect(portraitRes.body.hidden).toBe(false);
    });

    it('a DM can read a hidden map file (200); reveal then hide flips visibility', async () => {
      const server = ctx.app.getHttpServer();
      const up = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .set(dm)
        .field('kind', 'image')
        .attach('file', TINY_PNG, { filename: 'staged.png', contentType: 'image/png' });
      const id = up.body.id;
      expect(up.body.hidden).toBe(true);

      // DM always sees it.
      const dmGet = await request(server).get(`/api/v1/attachments/${id}/file`).set(dm);
      expect(dmGet.status).toBe(200);

      // Reveal makes hidden=false (POST => 201 per Nest default).
      const reveal = await request(server).post(`/api/v1/attachments/${id}/reveal`).set(dm);
      expect(reveal.status).toBe(201);
      expect(reveal.body.hidden).toBe(false);

      // Re-hide.
      const hide = await request(server).post(`/api/v1/attachments/${id}/hide`).set(dm);
      expect(hide.status).toBe(201);
      expect(hide.body.hidden).toBe(true);
    });

    it('the campaign attachment list omits hidden rows for non-DM but shows them to the DM', async () => {
      const server = ctx.app.getHttpServer();
      const up = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .set(dm)
        .field('kind', 'image')
        .attach('file', TINY_PNG, { filename: 'listed-hidden.png', contentType: 'image/png' });
      const hiddenId = up.body.id;

      const dmList = await request(server).get(`/api/v1/campaigns/${campaignId}/attachments`).set(dm);
      expect(dmList.status).toBe(200);
      expect(dmList.body.some((a: { id: number }) => a.id === hiddenId)).toBe(true);

      // A real (non-admin) member: dev-auth users are always admin/dm, so use a
      // cookie-session player below — here at least assert the DM list is present.
      expect(Array.isArray(dmList.body)).toBe(true);
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

  // Issue #695 — deleting an attachment must clear any encounter.mapAttachmentId
  // pointing at it, otherwise the encounter keeps rendering a now-404ing battle map.
  // One attachment can back several encounters, so all of them must be cleared in the
  // same transaction. Mirrors the campaign map / portrait cleanup already in remove().
  describe('encounter map wiring (issue #695)', () => {
    it('deleting the attachment set as an encounter battle map clears encounter.mapAttachmentId', async () => {
      const server = ctx.app.getHttpServer();
      const uploadRes = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .set(dm)
        .field('kind', 'map')
        .attach('file', TINY_PNG, { filename: 'dangle-encounter-map.png', contentType: 'image/png' });
      expect(uploadRes.status).toBe(201);
      const attachmentId = uploadRes.body.id;

      const encRes = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Map Cleanup Fight' });
      expect(encRes.status).toBe(201);
      const encounterId = encRes.body.id;

      const patchRes = await request(server).patch(`/api/v1/encounters/${encounterId}`).set(dm).send({ mapAttachmentId: attachmentId });
      expect(patchRes.status).toBe(200);
      expect(patchRes.body.mapAttachmentId).toBe(attachmentId);

      // Disable SQLite's ON DELETE SET NULL cascade so the test exercises the
      // service-layer manual cleanup in AttachmentsService.remove (the path that
      // protects pre-FK databases — see db.module.ts). On a fresh test DB the FK
      // would otherwise null the pointer for us and hide the regression.
      ctx.app.get<import('../src/db/db.module').DbHolder>(DB_HOLDER).raw.pragma('foreign_keys = OFF');

      const deleteRes = await request(server).delete(`/api/v1/attachments/${attachmentId}`).set(dm);
      expect(deleteRes.status).toBe(200);

      // After the attachment is gone, the encounter's battle map pointer must be null
      // so the VTT does not render a broken/missing map.
      const getRes = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
      expect(getRes.status).toBe(200);
      expect(getRes.body.mapAttachmentId).toBeNull();
    });

    it('deleting an attachment shared as the battle map for multiple encounters clears all of them', async () => {
      const server = ctx.app.getHttpServer();
      const uploadRes = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .set(dm)
        .field('kind', 'map')
        .attach('file', TINY_PNG, { filename: 'shared-encounter-map.png', contentType: 'image/png' });
      expect(uploadRes.status).toBe(201);
      const attachmentId = uploadRes.body.id;

      const encA = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Shared Map A' });
      const encB = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Shared Map B' });
      expect(encA.status).toBe(201);
      expect(encB.status).toBe(201);

      await request(server).patch(`/api/v1/encounters/${encA.body.id}`).set(dm).send({ mapAttachmentId: attachmentId });
      await request(server).patch(`/api/v1/encounters/${encB.body.id}`).set(dm).send({ mapAttachmentId: attachmentId });

      const deleteRes = await request(server).delete(`/api/v1/attachments/${attachmentId}`).set(dm);
      expect(deleteRes.status).toBe(200);

      const getA = await request(server).get(`/api/v1/encounters/${encA.body.id}`).set(dm);
      const getB = await request(server).get(`/api/v1/encounters/${encB.body.id}`).set(dm);
      expect(getA.body.mapAttachmentId).toBeNull();
      expect(getB.body.mapAttachmentId).toBeNull();
    });

    it('deleting an unrelated attachment does not touch an encounter mapAttachmentId pointing elsewhere', async () => {
      const server = ctx.app.getHttpServer();
      const keepUpload = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .set(dm)
        .field('kind', 'map')
        .attach('file', TINY_PNG, { filename: 'keep-encounter-map.png', contentType: 'image/png' });
      const keepId = keepUpload.body.id;

      const otherUpload = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .set(dm)
        .field('kind', 'map')
        .attach('file', TINY_PNG, { filename: 'other-encounter-map.png', contentType: 'image/png' });
      const otherId = otherUpload.body.id;

      const encRes = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Keep Map Fight' });
      const encounterId = encRes.body.id;
      await request(server).patch(`/api/v1/encounters/${encounterId}`).set(dm).send({ mapAttachmentId: keepId });

      const deleteRes = await request(server).delete(`/api/v1/attachments/${otherId}`).set(dm);
      expect(deleteRes.status).toBe(200);

      const getRes = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
      expect(getRes.body.mapAttachmentId).toBe(keepId);
    });
  });

  // Issue #75/#463/#498 — bytes are immutable per id, but visibility is mutable.
  // A strong ETag avoids re-downloading while no-cache/must-revalidate makes every
  // reuse pass the current authorization/fog checks.
  describe('caching + thumbnails (issues #75, #463, #498)', () => {
    let pngId: number; // a >thumb-cap PNG so the downscaler actually runs

    beforeAll(async () => {
      const server = ctx.app.getHttpServer();
      const big = makePng(800, 600); // 800px longest edge > 512 thumb cap
      const res = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .set(dm)
        .field('kind', 'map')
        .attach('file', big, { filename: 'bigmap.png', contentType: 'image/png' });
      expect(res.status).toBe(201);
      pngId = res.body.id;
    });

    it('GET sets a strong ETag and requires visibility revalidation', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server).get(`/api/v1/attachments/${pngId}/file`).set(dm);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toContain('no-cache');
      expect(res.headers['cache-control']).toContain('must-revalidate');
      expect(res.headers['cache-control']).toContain('private');
      expect(res.headers['cache-control']).not.toContain('immutable');
      expect(String(res.headers['vary'])).toContain('Cookie');
      expect(res.headers['etag']).toMatch(/^"[0-9a-f]{64}"$/); // quoted sha256 hex
    });

    it('a matching If-None-Match yields 304 with no body', async () => {
      const server = ctx.app.getHttpServer();
      const first = await request(server).get(`/api/v1/attachments/${pngId}/file`).set(dm);
      const etag = first.headers['etag'];
      expect(etag).toBeTruthy();

      const revalidate = await request(server)
        .get(`/api/v1/attachments/${pngId}/file`)
        .set(dm)
        .set('If-None-Match', etag);
      expect(revalidate.status).toBe(304);
      expect(revalidate.headers['etag']).toBe(etag);
      expect(revalidate.body).toEqual({}); // no bytes returned
    });

    it('a non-matching If-None-Match still returns 200 with bytes', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .get(`/api/v1/attachments/${pngId}/file`)
        .set(dm)
        .set('If-None-Match', '"deadbeef"');
      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThan(0);
    });

    it('?size=thumb serves a downscaled PNG (longest edge capped at 512px)', async () => {
      const server = ctx.app.getHttpServer();
      const full = await request(server).get(`/api/v1/attachments/${pngId}/file`).set(dm);
      const thumb = await request(server).get(`/api/v1/attachments/${pngId}/file?size=thumb`).set(dm);

      expect(thumb.status).toBe(200);
      expect(thumb.headers['content-type']).toBe('image/png');
      // The real thumbnail guarantee is fewer pixels: 800x600 -> 512x384 (longest
      // edge = 512), a valid, materially smaller image than the 800x600 original.
      expect(pngWidth(full.body)).toBe(800);
      expect(pngWidth(thumb.body)).toBe(512);
      expect(pngHeight(thumb.body)).toBe(384);
      expect(Number(thumb.headers['content-length'])).toBe(thumb.body.length);
      // Thumb has its own (distinct) strong ETag.
      expect(thumb.headers['etag']).toMatch(/^"[0-9a-f]{64}"$/);
      expect(thumb.headers['etag']).not.toBe(full.headers['etag']);
    });

    it('?size=thumb revalidates to 304 too', async () => {
      const server = ctx.app.getHttpServer();
      const first = await request(server).get(`/api/v1/attachments/${pngId}/file?size=thumb`).set(dm);
      const res = await request(server)
        .get(`/api/v1/attachments/${pngId}/file?size=thumb`)
        .set(dm)
        .set('If-None-Match', first.headers['etag']);
      expect(res.status).toBe(304);
    });

    it('?size=thumb on an already-small image falls back to the original bytes', async () => {
      const server = ctx.app.getHttpServer();
      const up = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .set(dm)
        .field('kind', 'image')
        .attach('file', TINY_PNG, { filename: 'tiny.png', contentType: 'image/png' });
      const thumb = await request(server).get(`/api/v1/attachments/${up.body.id}/file?size=thumb`).set(dm);
      expect(thumb.status).toBe(200);
      expect(Buffer.compare(thumb.body, TINY_PNG)).toBe(0);
    });

    it('an unsupported size value is rejected (400)', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server).get(`/api/v1/attachments/${pngId}/file?size=huge`).set(dm);
      expect(res.status).toBe(400);
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
  let playerAgent: ReturnType<typeof request.agent>;
  let playerId: number;
  let campaignId: number;
  let attachmentId: number;
  // Issue #498 Scenario 2 (membership removal): a second player member whose access
  // we can revoke mid-suite without disturbing playerAgent (used by the other scenarios).
  let removablePlayerId: number;
  let removablePlayerAgent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    const adminAgent = request.agent(server);
    await adminAgent.post('/api/v1/auth/setup').send({ username: 'root-admin-2', password: 'admin-password-1' });
    await adminAgent.post('/api/v1/users').send({ username: 'dm-real', password: 'password-dm-1', serverRole: 'user' });
    await adminAgent.post('/api/v1/users').send({ username: 'outsider-real', password: 'password-out-1', serverRole: 'user' });
    const createPlayer = await adminAgent
      .post('/api/v1/users')
      .send({ username: 'player-real', password: 'password-pl-1', serverRole: 'user' });
    playerId = createPlayer.body.id;
    const createRemovable = await adminAgent
      .post('/api/v1/users')
      .send({ username: 'removable-real', password: 'password-rm-1', serverRole: 'user' });
    removablePlayerId = createRemovable.body.id;

    dmAgent = request.agent(server);
    await dmAgent.post('/api/v1/auth/login').send({ username: 'dm-real', password: 'password-dm-1' });

    outsiderAgent = request.agent(server);
    await outsiderAgent.post('/api/v1/auth/login').send({ username: 'outsider-real', password: 'password-out-1' });

    playerAgent = request.agent(server);
    await playerAgent.post('/api/v1/auth/login').send({ username: 'player-real', password: 'password-pl-1' });

    removablePlayerAgent = request.agent(server);
    await removablePlayerAgent.post('/api/v1/auth/login').send({ username: 'removable-real', password: 'password-rm-1' });

    const createRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'Private Campaign' });
    campaignId = createRes.body.id;

    // player-real is a member of this campaign (role: player), unlike outsider-real.
    await dmAgent.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: playerId, role: 'player' });
    // removable-real is also a campaign member (player) so the #498 membership-removal
    // scenario can fetch a revealed attachment and then lose access mid-suite.
    await dmAgent.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: removablePlayerId, role: 'player' });

    const uploadRes = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/attachments`)
      .field('kind', 'image')
      .attach('file', TINY_PNG, { filename: 'secret.png', contentType: 'image/png' });
    expect(uploadRes.status).toBe(201);
    attachmentId = uploadRes.body.id;
    // An 'image' upload is DM-only by default (issue #97).
    expect(uploadRes.body.hidden).toBe(true);
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

  // Issue #97 — the core secrecy guarantee, exercised with a real non-DM MEMBER
  // (dev-auth users can't express this — they're always treated as dm).
  describe('hidden handout secrecy (issue #97)', () => {
    it('a non-DM member gets 404 (not 403 — indistinguishable from nonexistent) on a hidden attachment', async () => {
      const res = await playerAgent.get(`/api/v1/attachments/${attachmentId}/file`);
      expect(res.status).toBe(404);
    });

    it("a non-DM member's campaign attachment list omits the hidden attachment", async () => {
      const res = await playerAgent.get(`/api/v1/campaigns/${campaignId}/attachments`);
      expect(res.status).toBe(200);
      expect(res.body.some((a: { id: number }) => a.id === attachmentId)).toBe(false);
    });

    it('the DM sees the hidden attachment in the list', async () => {
      const res = await dmAgent.get(`/api/v1/campaigns/${campaignId}/attachments`);
      expect(res.status).toBe(200);
      expect(res.body.some((a: { id: number }) => a.id === attachmentId)).toBe(true);
    });

    it('a non-DM member cannot reveal (403)', async () => {
      const res = await playerAgent.post(`/api/v1/attachments/${attachmentId}/reveal`);
      expect(res.status).toBe(403);
    });

    it('after the DM reveals it, the non-DM member can read the file (200) and see it in the list', async () => {
      const reveal = await dmAgent.post(`/api/v1/attachments/${attachmentId}/reveal`);
      expect(reveal.status).toBe(201);
      expect(reveal.body.hidden).toBe(false);

      const fileRes = await playerAgent.get(`/api/v1/attachments/${attachmentId}/file`);
      expect(fileRes.status).toBe(200);
      expect(Buffer.compare(fileRes.body, TINY_PNG)).toBe(0);

      const listRes = await playerAgent.get(`/api/v1/campaigns/${campaignId}/attachments`);
      expect(listRes.body.some((a: { id: number }) => a.id === attachmentId)).toBe(true);
    });

    it('a still-hidden (non-member) outsider is unaffected by the reveal', async () => {
      const res = await outsiderAgent.get(`/api/v1/attachments/${attachmentId}/file`);
      expect(res.status).toBe(403);
    });

    it('the DM can re-hide a revealed attachment, and the non-DM member 404s again', async () => {
      const hide = await dmAgent.post(`/api/v1/attachments/${attachmentId}/hide`);
      expect(hide.status).toBe(201);
      expect(hide.body.hidden).toBe(true);

      const fileRes = await playerAgent.get(`/api/v1/attachments/${attachmentId}/file`);
      expect(fileRes.status).toBe(404);
    });

    it('assigning a hidden map as the campaign background auto-reveals it to players', async () => {
      const upload = await dmAgent
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .field('kind', 'map')
        .attach('file', TINY_PNG, { filename: 'bg.png', contentType: 'image/png' });
      expect(upload.body.hidden).toBe(true);
      const mapId = upload.body.id;

      // Player can't see it yet.
      const before = await playerAgent.get(`/api/v1/attachments/${mapId}/file`);
      expect(before.status).toBe(404);

      // Wiring it as the shared campaign map background reveals it.
      const patch = await dmAgent.patch(`/api/v1/campaigns/${campaignId}`).send({ mapAttachmentId: mapId });
      expect(patch.status).toBe(200);

      const after = await playerAgent.get(`/api/v1/attachments/${mapId}/file`);
      expect(after.status).toBe(200);
    });
  });

  // Issue #463 — encounter fog is a server-side pixel boundary, not a cosmetic client
  // overlay. Raw attachment URLs stay DM-only; players load a role-specific encounter
  // route whose bytes contain only currently revealed pixels.
  describe('fog-safe encounter battle maps (issue #463)', () => {
    let encounterId: number;
    let mapId: number;
    const battleMap = makePng(4, 2);

    beforeAll(async () => {
      // DM uploads a battle map (hidden by default) and enables fog on an encounter.
      const upload = await dmAgent
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .field('kind', 'map')
        .attach('file', battleMap, { filename: 'battle-map.png', contentType: 'image/png' });
      expect(upload.status).toBe(201);
      expect(upload.body.hidden).toBe(true);
      mapId = upload.body.id;

      const enc = await dmAgent.post(`/api/v1/campaigns/${campaignId}/encounters`).send({ name: 'Fogged Fight' });
      expect(enc.status).toBe(201);
      encounterId = enc.body.id;

      // Attach the map + enable fog — non-empty fog.
      const patch = await dmAgent
        .patch(`/api/v1/encounters/${encounterId}`)
        .send({ mapAttachmentId: mapId, fog: { enabled: true, revealed: [{ x: 0, y: 0, w: 50, h: 100 }] } });
      expect(patch.status).toBe(200);
      expect(patch.body.mapAttachmentId).toBe(mapId);
    });

    it('the attachment stays hidden (attach did NOT flip it to revealed)', async () => {
      const dmList = await dmAgent.get(`/api/v1/campaigns/${campaignId}/attachments`);
      expect(dmList.status).toBe(200);
      const row = dmList.body.find((a: { id: number }) => a.id === mapId);
      expect(row).toBeDefined();
      expect(row.hidden).toBe(true);
    });

    it("the player's Handouts list omits the encounter map (no REVEALED leak)", async () => {
      const playerList = await playerAgent.get(`/api/v1/campaigns/${campaignId}/attachments`);
      expect(playerList.status).toBe(200);
      expect(playerList.body.some((a: { id: number }) => a.id === mapId)).toBe(false);
    });

    it('the DM still sees the encounter map in the Handouts list', async () => {
      const dmList = await dmAgent.get(`/api/v1/campaigns/${campaignId}/attachments`);
      expect(dmList.body.some((a: { id: number }) => a.id === mapId)).toBe(true);
    });

    it('raw source, thumbnail, conditional, and Range attachment URLs are all 404 for the player', async () => {
      const paths = [
        `/api/v1/attachments/${mapId}/file`,
        `/api/v1/attachments/${mapId}/file?size=thumb`,
      ];
      for (const filePath of paths) {
        expect((await playerAgent.get(filePath)).status).toBe(404);
        expect((await playerAgent.get(filePath).set('If-None-Match', '*')).status).toBe(404);
        expect((await playerAgent.get(filePath).set('Range', 'bytes=0-31')).status).toBe(404);
      }
    });

    it('the encounter map route returns only revealed pixels in an opaque no-store PNG', async () => {
      const safe = await playerAgent.get(`/api/v1/encounters/${encounterId}/map?revision=first`);
      expect(safe.status).toBe(200);
      expect(safe.headers['content-type']).toBe('image/png');
      expect(safe.headers['cache-control']).toContain('no-store');
      expect(safe.headers['accept-ranges']).toBe('none');
      expect(safe.headers['x-campfire-map-view']).toBe('fog-protected');

      const source = await sharp(battleMap).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const rendered = await sharp(safe.body).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      expect(rendered.info.width).toBe(4);
      for (let y = 0; y < 2; y++) {
        const row = y * 4 * 4;
        // Left half was revealed and is byte-identical after lossless PNG rendering.
        expect(rendered.data.subarray(row, row + 8)).toEqual(source.data.subarray(row, row + 8));
        // Right half contains opaque fog bytes, not recoverable source RGB.
        expect([...rendered.data.subarray(row + 8, row + 12)]).toEqual([11, 17, 32, 255]);
        expect([...rendered.data.subarray(row + 12, row + 16)]).toEqual([11, 17, 32, 255]);
      }
    });

    it('the role-safe thumbnail is masked too, and Range requests are rejected', async () => {
      const thumb = await playerAgent.get(`/api/v1/encounters/${encounterId}/map?size=thumb&revision=first`);
      expect(thumb.status).toBe(200);
      expect(thumb.headers['x-campfire-map-view']).toBe('fog-protected');
      const ranged = await playerAgent.get(`/api/v1/encounters/${encounterId}/map`).set('Range', 'bytes=0-31');
      expect(ranged.status).toBe(416);
      // Controller ends the 416 with an empty body (no JSON payload).
      const empty =
        Buffer.isBuffer(ranged.body)
          ? ranged.body.length === 0
          : ranged.body == null ||
            ranged.body === '' ||
            (typeof ranged.body === 'object' && !Array.isArray(ranged.body) && Object.keys(ranged.body).length === 0);
      expect(empty).toBe(true);
    });

    it('a fog revision cannot reuse a stale validator or cached pixel set', async () => {
      const first = await playerAgent.get(`/api/v1/encounters/${encounterId}/map?revision=first`);
      const firstEtag = first.headers.etag;
      expect(firstEtag).toBeTruthy();

      const patch = await dmAgent
        .patch(`/api/v1/encounters/${encounterId}`)
        .send({ fog: { enabled: true, revealed: [{ x: 50, y: 0, w: 50, h: 100 }] } });
      expect(patch.status).toBe(200);

      const second = await playerAgent
        .get(`/api/v1/encounters/${encounterId}/map?revision=${encodeURIComponent(patch.body.updatedAt)}`)
        .set('If-None-Match', firstEtag);
      expect(second.status).toBe(200);
      expect(second.headers.etag).not.toBe(firstEtag);
      expect(second.headers['cache-control']).toContain('no-store');

      const rendered = await sharp(second.body).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const source = await sharp(battleMap).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      expect([...rendered.data.subarray(0, 4)]).toEqual([11, 17, 32, 255]);
      expect(rendered.data.subarray(8, 16)).toEqual(source.data.subarray(8, 16));
    });

    it('the DM receives the original source through the encounter route', async () => {
      const res = await dmAgent.get(`/api/v1/encounters/${encounterId}/map`);
      expect(res.status).toBe(200);
      expect(res.headers['x-campfire-map-view']).toBe('fully-revealed');
      expect(Buffer.compare(res.body, battleMap)).toBe(0);
    });

    it('the protected attachment cannot be revealed as a raw handout', async () => {
      const res = await dmAgent.post(`/api/v1/attachments/${mapId}/reveal`);
      expect(res.status).toBe(409);
      expect(res.body.message).toContain('fogged encounter map');
    });

    it('revokes a previously visible raw-map cache grant as soon as fog is enabled', async () => {
      const upload = await dmAgent
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .field('kind', 'map')
        .attach('file', battleMap, { filename: 'formerly-public.png', contentType: 'image/png' });
      const publicMapId = upload.body.id as number;
      expect((await dmAgent.post(`/api/v1/attachments/${publicMapId}/reveal`)).status).toBe(201);

      const before = await playerAgent.get(`/api/v1/attachments/${publicMapId}/file`);
      expect(before.status).toBe(200);
      expect(before.headers.etag).toBeTruthy();
      expect(before.headers['cache-control']).toContain('must-revalidate');

      const created = await dmAgent.post(`/api/v1/campaigns/${campaignId}/encounters`).send({ name: 'Re-hidden Map' });
      const publicEncounterId = created.body.id as number;
      const protect = await dmAgent.patch(`/api/v1/encounters/${publicEncounterId}`).send({
        mapAttachmentId: publicMapId,
        fog: { enabled: true, revealed: [] },
      });
      expect(protect.status).toBe(200);

      // Even a stale validator for bytes the player legitimately saw earlier must
      // run the new authorization check and return 404, never 304 or old bytes.
      const stale = await playerAgent
        .get(`/api/v1/attachments/${publicMapId}/file`)
        .set('If-None-Match', before.headers.etag);
      expect(stale.status).toBe(404);
      expect((await playerAgent.get(`/api/v1/attachments/${publicMapId}/file?size=thumb`)).status).toBe(404);

      const safe = await playerAgent.get(`/api/v1/encounters/${publicEncounterId}/map`);
      expect(safe.status).toBe(200);
      expect(safe.headers['x-campfire-map-view']).toBe('fog-protected');
    });

    it('fails closed when persisted fog JSON is malformed', async () => {
      const upload = await dmAgent
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .field('kind', 'map')
        .attach('file', battleMap, { filename: 'corrupt-fog.png', contentType: 'image/png' });
      const invalidMapId = upload.body.id as number;
      const created = await dmAgent.post(`/api/v1/campaigns/${campaignId}/encounters`).send({ name: 'Malformed Fog' });
      const invalidEncounterId = created.body.id as number;
      expect(
        (
          await dmAgent.patch(`/api/v1/encounters/${invalidEncounterId}`).send({
            mapAttachmentId: invalidMapId,
            fog: { enabled: true, revealed: [] },
          })
        ).status,
      ).toBe(200);

      // Manufacture corrupt legacy/storage state that cannot be expressed through
      // the validated API. Encounter JSON may degrade to fog:null, but pixels may not.
      const db = ctx.app.get<DrizzleDb>(DB);
      db.update(encounters).set({ fog: '{ definitely-not-json' }).where(eq(encounters.id, invalidEncounterId)).run();

      expect((await playerAgent.get(`/api/v1/attachments/${invalidMapId}/file`)).status).toBe(404);
      const safe = await playerAgent.get(`/api/v1/encounters/${invalidEncounterId}/map`);
      expect(safe.status).toBe(200);
      expect(safe.headers['x-campfire-map-view']).toBe('fog-protected');
      const rendered = await sharp(safe.body).ensureAlpha().raw().toBuffer();
      for (let offset = 0; offset < rendered.length; offset += 4) {
        expect([...rendered.subarray(offset, offset + 4)]).toEqual([11, 17, 32, 255]);
      }

      const dmView = await dmAgent.get(`/api/v1/encounters/${invalidEncounterId}/map`);
      expect(dmView.status).toBe(200);
      expect(Buffer.compare(dmView.body, battleMap)).toBe(0);
    });

    it('protecting an encounter map does not open OTHER hidden attachments to the player', async () => {
      // A hidden image that is NOT any encounter's map stays 404 for the player.
      const other = await dmAgent
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .field('kind', 'image')
        .attach('file', TINY_PNG, { filename: 'unrelated-hidden.png', contentType: 'image/png' });
      expect(other.body.hidden).toBe(true);
      const res = await playerAgent.get(`/api/v1/attachments/${other.body.id}/file`);
      expect(res.status).toBe(404);
    });

    it('a non-member outsider still cannot fetch the encounter map (403)', async () => {
      expect((await outsiderAgent.get(`/api/v1/attachments/${mapId}/file`)).status).toBe(403);
      expect((await outsiderAgent.get(`/api/v1/encounters/${encounterId}/map`)).status).toBe(403);
    });

    it('the member export contains no attachment metadata or source URL', async () => {
      const res = await playerAgent.get(`/api/v1/campaigns/${campaignId}/export/me`);
      expect(res.status).toBe(200);
      expect(res.body.attachments).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain(`/attachments/${mapId}/file`);
    });

    it('invalid persisted fog still redacts token coordinates for non-DMs', async () => {
      const upload = await dmAgent
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .field('kind', 'map')
        .attach('file', battleMap, { filename: 'token-redact-fog.png', contentType: 'image/png' });
      const tokenMapId = upload.body.id as number;
      const created = await dmAgent.post(`/api/v1/campaigns/${campaignId}/encounters`).send({ name: 'Corrupt Fog Tokens' });
      const tokenEncounterId = created.body.id as number;
      expect(
        (
          await dmAgent.patch(`/api/v1/encounters/${tokenEncounterId}`).send({
            mapAttachmentId: tokenMapId,
            fog: { enabled: true, revealed: [] },
          })
        ).status,
      ).toBe(200);

      const monster = await dmAgent.post(`/api/v1/encounters/${tokenEncounterId}/combatants`).send({
        kind: 'monster',
        name: 'Hidden Stalker',
        hpMax: 12,
      });
      expect(monster.status).toBe(201);
      expect(
        (
          await dmAgent
            .patch(`/api/v1/encounters/${tokenEncounterId}/combatants/${monster.body.id}`)
            .send({ tokenX: 25, tokenY: 40 })
        ).status,
      ).toBe(200);

      const db = ctx.app.get<DrizzleDb>(DB);
      db.update(encounters).set({ fog: '{ definitely-not-json' }).where(eq(encounters.id, tokenEncounterId)).run();

      const playerView = await playerAgent.get(`/api/v1/encounters/${tokenEncounterId}`);
      expect(playerView.status).toBe(200);
      // Encounter JSON may degrade fog to null, but token coords must still fail closed.
      expect(playerView.body.fog).toBeNull();
      const stalker = playerView.body.combatants.find((c: { id: number }) => c.id === monster.body.id);
      expect(stalker.tokenX).toBeNull();
      expect(stalker.tokenY).toBeNull();

      const dmView = await dmAgent.get(`/api/v1/encounters/${tokenEncounterId}`);
      const dmStalker = dmView.body.combatants.find((c: { id: number }) => c.id === monster.body.id);
      expect(dmStalker.tokenX).toBe(25);
      expect(dmStalker.tokenY).toBe(40);
    });

    it('fogging the campaign region map clones a battle-map attachment so players keep the background', async () => {
      const upload = await dmAgent
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .field('kind', 'map')
        .attach('file', battleMap, { filename: 'region-and-battle.png', contentType: 'image/png' });
      const sharedId = upload.body.id as number;

      const asCampaign = await dmAgent.patch(`/api/v1/campaigns/${campaignId}`).send({ mapAttachmentId: sharedId });
      expect(asCampaign.status).toBe(200);
      expect(asCampaign.body.mapAttachmentId).toBe(sharedId);
      expect((await playerAgent.get(`/api/v1/attachments/${sharedId}/file`)).status).toBe(200);

      const enc = await dmAgent.post(`/api/v1/campaigns/${campaignId}/encounters`).send({ name: 'Fog on Region Map' });
      const encId = enc.body.id as number;
      const fogged = await dmAgent.patch(`/api/v1/encounters/${encId}`).send({
        mapAttachmentId: sharedId,
        fog: { enabled: true, revealed: [{ x: 0, y: 0, w: 25, h: 100 }] },
      });
      expect(fogged.status).toBe(200);
      // Encounter retargets to a dedicated clone; campaign keeps the original.
      expect(fogged.body.mapAttachmentId).not.toBe(sharedId);
      const campaign = await dmAgent.get(`/api/v1/campaigns/${campaignId}`);
      expect(campaign.body.mapAttachmentId).toBe(sharedId);
      expect((await playerAgent.get(`/api/v1/attachments/${sharedId}/file`)).status).toBe(200);
      expect((await playerAgent.get(`/api/v1/attachments/${fogged.body.mapAttachmentId}/file`)).status).toBe(404);

      // Wiring the fogged battle-map clone back as the region map is rejected.
      const reuse = await dmAgent
        .patch(`/api/v1/campaigns/${campaignId}`)
        .send({ mapAttachmentId: fogged.body.mapAttachmentId });
      expect(reuse.status).toBe(409);
    });

    it('a sibling encounter reusing the map with fog off cannot leak the full source', async () => {
      const upload = await dmAgent
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .field('kind', 'map')
        .attach('file', battleMap, { filename: 'shared-map.png', contentType: 'image/png' });
      const sharedMapId = upload.body.id as number;

      const fogged = await dmAgent.post(`/api/v1/campaigns/${campaignId}/encounters`).send({ name: 'Fogged Shared' });
      const clear = await dmAgent.post(`/api/v1/campaigns/${campaignId}/encounters`).send({ name: 'Clear Shared' });
      const foggedId = fogged.body.id as number;
      const clearId = clear.body.id as number;

      expect(
        (
          await dmAgent.patch(`/api/v1/encounters/${foggedId}`).send({
            mapAttachmentId: sharedMapId,
            fog: { enabled: true, revealed: [{ x: 0, y: 0, w: 25, h: 100 }] },
          })
        ).status,
      ).toBe(200);
      // Reuse the same attachment with fog explicitly disabled / off.
      expect(
        (
          await dmAgent.patch(`/api/v1/encounters/${clearId}`).send({
            mapAttachmentId: sharedMapId,
            fog: { enabled: false, revealed: [] },
          })
        ).status,
      ).toBe(200);

      // Raw URL stays blocked because the fogged sibling still conceals pixels.
      expect((await playerAgent.get(`/api/v1/attachments/${sharedMapId}/file`)).status).toBe(404);

      // The clear encounter's map route must fail closed (fully concealed), not serve source.
      const leaked = await playerAgent.get(`/api/v1/encounters/${clearId}/map`);
      expect(leaked.status).toBe(200);
      expect(leaked.headers['x-campfire-map-view']).toBe('fog-protected');
      const rendered = await sharp(leaked.body).ensureAlpha().raw().toBuffer();
      for (let offset = 0; offset < rendered.length; offset += 4) {
        expect([...rendered.subarray(offset, offset + 4)]).toEqual([11, 17, 32, 255]);
      }

      // The fogged encounter still reveals only its own mask.
      const masked = await playerAgent.get(`/api/v1/encounters/${foggedId}/map`);
      expect(masked.status).toBe(200);
      expect(masked.headers['x-campfire-map-view']).toBe('fog-protected');
      const source = await sharp(battleMap).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const foggedPixels = await sharp(masked.body).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      expect(foggedPixels.data.subarray(0, 4)).toEqual(source.data.subarray(0, 4));
      expect([...foggedPixels.data.subarray(4, 8)]).toEqual([11, 17, 32, 255]);
    });
  });

  // Issue #498 — protected attachments used to ship `Cache-Control: ..., immutable`,
  // so the browser HTTP cache would serve previously-fetched bytes straight from disk
  // without ever re-hitting the server's membership/hidden check. That leaks bytes
  // across authorization states: login-as-other-user in the same browser, membership
  // removal, hidden toggle, or a delete-then-restore reusing the id. The fix has two
  // halves and these tests pin both:
  //
  //   (server) The cache policy is HONEST: no `immutable`, `private` + `Vary: Cookie`,
  //            and — critically — the membership/hidden check runs BEFORE any
  //            If-None-Match short-circuit. So even if a browser replays a stale ETag
  //            for an entry it cached under an old authorization, the server answers
  //            401/403/404, never 304-with-bytes. Each scenario below asserts that.
  //
  //   (client) The version token (id + hidden + updatedAt) changes exactly when the
  //            authorization state changes, so the URL the web client builds also
  //            changes and the browser cache misses outright. Asserted via the
  //            AttachmentsService.versionToken helper that the web client mirrors.
  describe('authorization-aware cache (issue #498)', () => {
    // Delegate to the production AttachmentsService.versionToken helper rather than
    // re-implementing the hash inline — the test then asserts the ACTUAL token the
    // server/client contract produces, and cannot drift if the algorithm changes.
    const versionToken = (row: { id: number; hidden: boolean; updatedAt: string }): string =>
      ctx.app.get(AttachmentsService).versionToken(row);

    // The honest-cache invariant every permission-dependent file response must hold:
    // NO `immutable` (the browser must revalidate so the membership/hidden check runs),
    // `private` (no shared-proxy caching), and `Vary: Cookie` (defensive keying). Every
    // successful (200) GET in the scenarios below must satisfy this — if the old
    // `immutable` policy regressed, these assertions fail right alongside the policy test.
    function assertHonestCache(res: { headers: Record<string, unknown> }) {
      expect(String(res.headers['cache-control'])).not.toContain('immutable');
      expect(String(res.headers['cache-control'])).toContain('private');
      expect(String(res.headers['vary'])).toContain('Cookie');
    }

    it('Scenario 1 (logout / login-as-other-user): a non-member replaying a valid ETag is NOT served 304 — the auth check runs first', async () => {
      // A member (dm) fetches and receives a strong ETag the browser would cache.
      const dmGet = await dmAgent.get(`/api/v1/attachments/${attachmentId}/file`);
      expect(dmGet.status).toBe(200);
      assertHonestCache(dmGet);
      const etag = dmGet.headers['etag'];
      expect(etag).toBeTruthy();

      // A non-member (outsider) requests the SAME url replaying that ETag. A buggy
      // immutable cache would have the browser serve dm's bytes from its HTTP cache;
      // the server-side guarantee is that even if the ETag is presented, the membership
      // check runs first and answers 403 — never a 304 that would imply "your cached
      // copy is still good" (and risk serving the cached bytes).
      const outsiderRevalidate = await outsiderAgent
        .get(`/api/v1/attachments/${attachmentId}/file`)
        .set('If-None-Match', etag);
      expect(outsiderRevalidate.status).toBe(403);
    });

    it('Scenario 2 (membership removal): after a member is removed, their replayed ETag yields 403 (not 304)', async () => {
      // removablePlayerAgent is a campaign member (provisioned in beforeAll). Stage a
      // revealed attachment it can fetch and cache an ETag for, then revoke its access.
      const up = await dmAgent
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .field('kind', 'image')
        .attach('file', TINY_PNG, { filename: 'membership.png', contentType: 'image/png' });
      expect(up.status).toBe(201);
      const id = up.body.id;
      await dmAgent.post(`/api/v1/attachments/${id}/reveal`);

      // Member fetches and caches an ETag.
      const memberGet = await removablePlayerAgent.get(`/api/v1/attachments/${id}/file`);
      expect(memberGet.status).toBe(200);
      assertHonestCache(memberGet);
      const etag = memberGet.headers['etag'];
      expect(etag).toBeTruthy();

      // Resolve the membership ROW id (the delete route keys on that, not on userId).
      const list = await dmAgent.get(`/api/v1/campaigns/${campaignId}/members`);
      expect(list.status).toBe(200);
      const seat = list.body.find((m: { userId: number }) => m.userId === removablePlayerId);
      expect(seat).toBeTruthy();

      // Membership revoked (204 No Content).
      const removeRes = await dmAgent.delete(`/api/v1/campaigns/${campaignId}/members/${seat.id}`);
      expect(removeRes.status).toBe(204);

      // The same browser replays the cached ETag. The server MUST run the (now-failing)
      // membership check and answer 403, not 304 — so the browser's cached copy can't
      // be treated as fresh and served as bytes.
      const after = await removablePlayerAgent.get(`/api/v1/attachments/${id}/file`).set('If-None-Match', etag);
      expect(after.status).toBe(403);
    });

    it('Scenario 3 (hidden toggle): re-hiding an attachment makes a player replaying the old ETag get 404 (not 304), and the version token changes across the toggle', async () => {
      // Fresh hidden attachment: a player 404s; the DM reveals it; the player fetches
      // (caching an ETag); the DM re-hides; the player replays the ETag and MUST get 404.
      const up = await dmAgent
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .field('kind', 'image')
        .attach('file', TINY_PNG, { filename: 'toggle.png', contentType: 'image/png' });
      expect(up.status).toBe(201);
      const id = up.body.id;
      expect(up.body.hidden).toBe(true);

      // Player can't see it while hidden.
      expect((await playerAgent.get(`/api/v1/attachments/${id}/file`)).status).toBe(404);

      // Reveal: player fetches and caches an ETag.
      await dmAgent.post(`/api/v1/attachments/${id}/reveal`);
      const playerGet = await playerAgent.get(`/api/v1/attachments/${id}/file`);
      expect(playerGet.status).toBe(200);
      assertHonestCache(playerGet);
      const etag = playerGet.headers['etag'];
      const revealedRow = (await playerAgent.get(`/api/v1/campaigns/${campaignId}/attachments`)).body.find(
        (a: { id: number }) => a.id === id,
      );
      const tokenWhileRevealed = versionToken(revealedRow);

      // Re-hide.
      const hideRes = await dmAgent.post(`/api/v1/attachments/${id}/hide`);
      expect(hideRes.body.hidden).toBe(true);
      const hiddenRow = hideRes.body;
      const tokenWhileHidden = versionToken(hiddenRow);

      // The URL the client would build flips (so the browser cache misses outright).
      expect(tokenWhileHidden).not.toBe(tokenWhileRevealed);

      // And even if the browser somehow replayed the old ETag, the server-side hidden
      // check runs first and answers 404 — never 304.
      const revalidate = await playerAgent.get(`/api/v1/attachments/${id}/file`).set('If-None-Match', etag);
      expect(revalidate.status).toBe(404);
    });

    it('Scenario 4 (delete): a deleted attachment 404s even when the old ETag is replayed', async () => {
      const up = await dmAgent
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .field('kind', 'image')
        .attach('file', TINY_PNG, { filename: 'goner.png', contentType: 'image/png' });
      const id = up.body.id;
      const get1 = await dmAgent.get(`/api/v1/attachments/${id}/file`);
      expect(get1.status).toBe(200);
      assertHonestCache(get1);
      const etag = get1.headers['etag'];

      await dmAgent.delete(`/api/v1/attachments/${id}`);

      // The browser may still hold the ETag; the server must 404 (row gone), not 304.
      const revalidate = await dmAgent.get(`/api/v1/attachments/${id}/file`).set('If-None-Match', etag);
      expect(revalidate.status).toBe(404);
    });

    it('Scenario 5 (restore / id reuse): the version token for a reused id differs when the restored row has a new updatedAt (so cached URLs do not collide)', async () => {
      // The leak this guards: an attachment is deleted and a later restore inserts a
      // NEW row that SQLite reuses the same id for. The old URL (/attachments/<id>/file)
      // collides, and a stale immutable cache would serve the OLD bytes for the NEW
      // (possibly differently-authorized) content. The fix: the version token folds in
      // updatedAt, so even with an identical id+hidden the token differs across the
      // two rows and the client builds a different URL.
      const rowV1 = { id: 42, hidden: false, updatedAt: '2025-01-01T00:00:00.000Z' };
      const rowV2 = { id: 42, hidden: false, updatedAt: '2025-06-01T00:00:00.000Z' }; // same id, restored later
      const rowV2Hidden = { id: 42, hidden: true, updatedAt: '2025-06-01T00:00:00.000Z' }; // auth also changed

      expect(versionToken(rowV1)).not.toBe(versionToken(rowV2));
      expect(versionToken(rowV2)).not.toBe(versionToken(rowV2Hidden));

      // The live service agrees: it folds the same three fields (its own hash, but
      // the SAME inputs, so the same uniqueness invariant holds). This pins the
      // server-side helper the web client parallels for any non-web caller.
      const svc = ctx.app.get(AttachmentsService);
      expect(svc.versionToken(rowV1)).not.toBe(svc.versionToken(rowV2));
      expect(svc.versionToken(rowV2)).not.toBe(svc.versionToken(rowV2Hidden));
    });
  });
});
