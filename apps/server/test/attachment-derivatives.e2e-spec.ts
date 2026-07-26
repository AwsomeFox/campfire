import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import request from 'supertest';
import sharp from 'sharp';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';
import { AttachmentDerivativesService } from '../src/modules/attachments/attachment-derivatives.service';
import {
  ATTACHMENT_MAX_IMAGE_DIMENSION,
  ATTACHMENT_MAX_IMAGE_PIXELS,
  DERIVATIVE_LADDER,
} from '../src/modules/attachments/image-derivatives';

/**
 * Issue #604 — durable responsive derivatives instead of always decoding originals.
 *
 * What this suite pins down:
 *  1. Decompression-bomb / oversize-dimension rejection happens on the UPLOAD path,
 *     from the header alone, before anything decodes pixels.
 *  2. A real 8K map is ACCEPTED (it is under the pixel cap) and served through the
 *     background ladder rather than as the original.
 *  3. Derivatives are asynchronous, durable, and never regenerated per request —
 *     and the request path never synchronously decodes a full-size original.
 *  4. Every supported format gets derivatives (not just the PNG subset the old
 *     hand-rolled decoder handled).
 *  5. Failure and DM-driven recovery, plus restart-with-pending-derivatives.
 *  6. Mobile-viewport delivery: the smallest rung really is small enough for a
 *     phone-sized slot, and the srcset the client builds points at it.
 *
 * All fixtures are generated with sharp at runtime — no binary blobs in the repo.
 */

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'deriv-dm' };
const player = { 'x-dev-role': 'player', 'x-dev-user': 'deriv-player' };

interface ManifestRung {
  variant: string;
  state: string;
  width: number;
  height: number;
  bytes: number;
  lastError: string;
  stale: boolean;
}
interface Manifest {
  attachmentId: number;
  status: string;
  stale: boolean;
  derivatives: ManifestRung[];
}

/** A real WxH image in the requested format, produced by sharp (no fixtures on disk). */
async function makeImage(width: number, height: number, format: 'png' | 'jpeg' | 'webp'): Promise<Buffer> {
  const pipeline = sharp({
    create: {
      width,
      height,
      channels: 3,
      // A flat fill compresses well, keeping an 8K fixture inside MAX_UPLOAD_BYTES.
      background: { r: 40, g: 70, b: 120 },
    },
  });
  if (format === 'png') return pipeline.png({ compressionLevel: 6 }).toBuffer();
  if (format === 'jpeg') return pipeline.jpeg({ quality: 70 }).toBuffer();
  return pipeline.webp({ quality: 70 }).toBuffer();
}

/**
 * A classic PNG decompression bomb: a valid header declaring an enormous canvas,
 * with an IDAT of highly-compressible zero bytes. Tiny on the wire; catastrophic
 * if anything ever inflates it. Hand-built (not via sharp) precisely because sharp
 * would refuse to CREATE it — the point is to feed the server bytes it must reject
 * from the header without decoding.
 */
function makePngBomb(width: number, height: number): Buffer {
  const crcTable: number[] = (() => {
    const t = new Array<number>(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colour type: grayscale (1 byte/px keeps the declared raw size honest)
  // One filter byte + `width` zero bytes per scanline, for a handful of scanlines.
  // The server must never get far enough to care that the stream is short: the
  // IHDR alone already declares an impossible number of pixels.
  const scanlines = Buffer.alloc(Math.min(height, 64) * (width + 1));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(scanlines, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('issue #604: responsive attachment derivatives', () => {
  let ctx: TestAppContext;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer())
      .post('/api/v1/campaigns')
      .set(dm)
      .send({ name: 'Derivative Campaign' });
    expect(res.status).toBe(201);
    campaignId = res.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  function server() {
    return ctx.app.getHttpServer();
  }

  async function upload(bytes: Buffer, filename: string, contentType: string, kind = 'map'): Promise<number> {
    const res = await request(server())
      .post(`/api/v1/campaigns/${campaignId}/attachments`)
      .set(dm)
      .field('kind', kind)
      .attach('file', bytes, { filename, contentType });
    expect(res.status).toBe(201);
    return res.body.id as number;
  }

  /** Poll until the background drain settles (nothing left `pending`). */
  async function settle(attachmentId: number): Promise<Manifest> {
    for (let attempt = 0; attempt < 200; attempt++) {
      const res = await request(server()).get(`/api/v1/attachments/${attachmentId}/derivatives`).set(dm);
      expect(res.status).toBe(200);
      const body = res.body as Manifest;
      if (body.status !== 'processing') return body;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`derivatives for ${attachmentId} never settled`);
  }

  // ---------- 1. input validation / decompression-bomb defence ----------

  describe('input validation (#604 bullet 1)', () => {
    it('rejects a PNG decompression bomb from its header, without decoding it', async () => {
      // 30000 x 30000 = 900 MP. As RGBA that is 3.6 GB; the compressed upload is a
      // few KB. If this ever returns 201 the server has accepted an image it can
      // only ever OOM on.
      const bomb = makePngBomb(30_000, 30_000);
      expect(bomb.length).toBeLessThan(1024 * 1024); // genuinely a bomb: tiny on the wire

      const res = await request(server())
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .set(dm)
        .field('kind', 'map')
        .attach('file', bomb, { filename: 'bomb.png', contentType: 'image/png' });

      // 413 (over the pixel budget) or 400 (over the per-edge cap) — either way the
      // upload must not be admitted.
      expect([400, 413]).toContain(res.status);
      expect(String(res.body.message)).toMatch(/pixel|edge|decoded/i);
    });

    it('rejects an image whose single edge exceeds the per-edge cap even at a modest pixel count', async () => {
      // A "thin bomb": 40000 x 8 is only 320k pixels, so a pure megapixel check
      // would wave it through — but the edge is impossible to render anywhere.
      const thin = makePngBomb(ATTACHMENT_MAX_IMAGE_DIMENSION + 1000, 8);
      const res = await request(server())
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .set(dm)
        .field('kind', 'map')
        .attach('file', thin, { filename: 'thin.png', contentType: 'image/png' });
      expect(res.status).toBe(400);
      expect(String(res.body.message)).toContain(String(ATTACHMENT_MAX_IMAGE_DIMENSION));
    });

    it('rejects bytes that pass the magic-byte sniff but are not a decodable image', async () => {
      // Valid PNG signature, garbage after it. The old hand-rolled decoder simply
      // returned null here and the request silently served the corrupt original.
      const corrupt = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(512, 0x7f),
      ]);
      const res = await request(server())
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .set(dm)
        .field('kind', 'map')
        .attach('file', corrupt, { filename: 'corrupt.png', contentType: 'image/png' });
      expect(res.status).toBe(400);
    });

    it('the pixel cap sits above full 8K so a legitimate 8K map is not caught by it', () => {
      expect(ATTACHMENT_MAX_IMAGE_PIXELS).toBeGreaterThan(7680 * 4320);
    });
  });

  // ---------- 2. 8K map through the bounded path ----------

  describe('8K map (#604)', () => {
    it('accepts a full 8K map and serves it through derivatives, not the original', async () => {
      const eightK = await makeImage(7680, 4320, 'png');
      const id = await upload(eightK, '8k-map.png', 'image/png');

      const manifest = await settle(id);
      expect(manifest.status).toBe('ready');
      // Every rung is materially smaller than 7680 wide.
      for (const rung of manifest.derivatives) {
        expect(rung.state).toBe('ready');
        expect(rung.width).toBeLessThan(7680);
      }

      const original = await request(server()).get(`/api/v1/attachments/${id}/file`).set(dm);
      const thumb = await request(server()).get(`/api/v1/attachments/${id}/file?size=thumb`).set(dm);
      expect(thumb.status).toBe(200);
      expect(thumb.headers['x-campfire-derivative']).toBe('thumb');
      // The whole point of #604: a preview must not cost what the original costs.
      expect(thumb.body.length).toBeLessThan(original.body.length / 10);

      const meta = await sharp(thumb.body).metadata();
      expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(512);
    }, 120_000);
  });

  // ---------- 3. asynchronous, durable, once-only ----------

  describe('durable async generation (#604 bullet 2)', () => {
    it('the upload response does not wait for generation, and the ladder lands afterwards', async () => {
      const big = await makeImage(3000, 2000, 'png');
      const id = await upload(big, 'async.png', 'image/png');

      // Immediately after upload the ladder exists but is not necessarily ready —
      // proving generation is off the request path. (If the drain happened to win
      // the race, `ready` is also a legal observation; what must never happen is a
      // MISSING ladder.)
      const immediate = await request(server()).get(`/api/v1/attachments/${id}/derivatives`).set(dm);
      expect(immediate.status).toBe(200);
      expect((immediate.body as Manifest).derivatives.length).toBe(DERIVATIVE_LADDER.length);

      const settled = await settle(id);
      expect(settled.status).toBe('ready');
    }, 60_000);

    it('derivative bytes are written once and reused — a second GET does not regenerate them', async () => {
      const big = await makeImage(2400, 1600, 'png');
      const id = await upload(big, 'reuse.png', 'image/png');
      await settle(id);

      const derivativePath = path.join(ctx.dataDir, 'uploads', String(campaignId), `${id}.thumb.png`);
      expect(fs.existsSync(derivativePath)).toBe(true);
      const firstMtime = fs.statSync(derivativePath).mtimeMs;

      const a = await request(server()).get(`/api/v1/attachments/${id}/file?size=thumb`).set(dm);
      const b = await request(server()).get(`/api/v1/attachments/${id}/file?size=thumb`).set(dm);
      expect(a.status).toBe(200);
      expect(Buffer.compare(a.body, b.body)).toBe(0);
      // Byte-identical AND untouched on disk: the request path did no image work.
      expect(fs.statSync(derivativePath).mtimeMs).toBe(firstMtime);
      expect(a.headers['x-campfire-derivative']).toBe('thumb');
    }, 60_000);

    it('the request path serves the original (never a synchronous decode) while rungs are pending', async () => {
      const big = await makeImage(2600, 1400, 'png');
      const id = await upload(big, 'pending.png', 'image/png');

      // Drop the ladder so there is deterministically no ready rung to serve —
      // the same observable state as "the drain has not run yet" — instead of
      // racing the background worker.
      ctx.app.get(AttachmentDerivativesService).forgetAttachment(id);

      const res = await request(server()).get(`/api/v1/attachments/${id}/file?size=thumb`).set(dm);
      expect(res.status).toBe(200);
      // Documented last resort: the original, explicitly labelled as a fallback.
      expect(res.headers['x-campfire-derivative']).toBe('original-fallback');
      expect(res.body.length).toBe(big.length);
    }, 60_000);
  });

  // ---------- 4. every supported format ----------

  describe('all supported formats (#604 bullet 2)', () => {
    it.each([
      ['png', 'image/png', 'fmt.png'],
      ['jpeg', 'image/jpeg', 'fmt.jpg'],
      ['webp', 'image/webp', 'fmt.webp'],
    ] as const)('generates derivatives for %s (the old PNG-only decoder could not)', async (format, mime, name) => {
      const bytes = await makeImage(2000, 1500, format);
      const id = await upload(bytes, name, mime);
      const manifest = await settle(id);

      expect(manifest.status).toBe('ready');
      const thumbRung = manifest.derivatives.find((d) => d.variant === 'thumb');
      expect(thumbRung?.state).toBe('ready');

      const res = await request(server()).get(`/api/v1/attachments/${id}/file?size=thumb`).set(dm);
      expect(res.status).toBe(200);
      expect(res.headers['x-campfire-derivative']).toBe('thumb');
      // Derivatives are always PNG regardless of source format.
      expect(res.headers['content-type']).toBe('image/png');
    }, 60_000);
  });

  // ---------- 5. failure, recovery, restart ----------

  describe('failure and recovery (#604 bullet 4)', () => {
    it('a source that vanishes fails the ladder, and a DM retry re-plans it', async () => {
      const bytes = await makeImage(1800, 1200, 'png');
      const id = await upload(bytes, 'recover.png', 'image/png');
      await settle(id);

      const sourcePath = path.join(ctx.dataDir, 'uploads', String(campaignId), `${id}.png`);
      const saved = fs.readFileSync(sourcePath);

      // Wipe the ladder AND the source, then force regeneration: every rung must
      // land in `failed` with a real error message, not hang in `processing`.
      fs.rmSync(sourcePath, { force: true });
      const failedRetry = await request(server()).post(`/api/v1/attachments/${id}/derivatives/retry`).set(dm);
      expect(failedRetry.status).toBe(201);
      const failed = await settle(id);
      expect(failed.status).toBe('failed');
      expect(failed.derivatives.every((d) => d.state === 'failed')).toBe(true);
      expect(failed.derivatives[0].lastError).not.toBe('');

      // Restore the bytes and retry again — recovery must actually recover.
      fs.writeFileSync(sourcePath, saved);
      const okRetry = await request(server()).post(`/api/v1/attachments/${id}/derivatives/retry`).set(dm);
      expect(okRetry.status).toBe(201);
      const recovered = await settle(id);
      expect(recovered.status).toBe('ready');
    }, 60_000);

    it('retry is dm-only', async () => {
      const bytes = await makeImage(1400, 900, 'png');
      const id = await upload(bytes, 'perm.png', 'image/png', 'portrait');
      await settle(id);
      const res = await request(server()).post(`/api/v1/attachments/${id}/derivatives/retry`).set(player);
      expect(res.status).toBe(403);
    }, 60_000);

    it('a hidden attachment\'s manifest is 404 for a non-DM, exactly like its bytes', async () => {
      const bytes = await makeImage(1400, 900, 'png');
      const id = await upload(bytes, 'hidden.png', 'image/png'); // kind=map defaults hidden
      const res = await request(server()).get(`/api/v1/attachments/${id}/derivatives`).set(player);
      expect(res.status).toBe(404);
    }, 60_000);
  });

  describe('restart with pending derivatives (#604 bullet 2 — durability)', () => {
    it('a ladder left pending across a restart is resumed, not lost', async () => {
      const bytes = await makeImage(2200, 1400, 'png');
      const id = await upload(bytes, 'restart.png', 'image/png');
      await settle(id);

      // Simulate "the process died mid-generation": drop the ready rungs and the
      // files, leaving nothing but a committed attachment. A restart must adopt it.
      const derivatives = ctx.app.get(AttachmentDerivativesService);
      derivatives.forgetAttachment(id);
      for (const spec of DERIVATIVE_LADDER) {
        fs.rmSync(path.join(ctx.dataDir, 'uploads', String(campaignId), `${id}.${spec.name}.png`), { force: true });
      }
      const gone = await request(server()).get(`/api/v1/attachments/${id}/derivatives`).set(dm);
      expect((gone.body as Manifest).derivatives).toHaveLength(0);

      // Reboot against the SAME data dir — this is what recoverPendingPublications
      // does for uploads and what the derivative backfill does for ladders.
      await ctx.app.close();
      ctx = await createTestApp({ dataDir: ctx.dataDir });

      const recovered = await settle(id);
      expect(recovered.status).toBe('ready');
      expect(recovered.derivatives.length).toBe(DERIVATIVE_LADDER.length);
    }, 120_000);
  });

  // ---------- 6. responsive / mobile delivery ----------

  describe('responsive delivery on a mobile viewport (#604 bullet 3)', () => {
    it('the smallest rung is phone-sized and the manifest carries real widths for srcset', async () => {
      const bytes = await makeImage(3200, 1800, 'png');
      const id = await upload(bytes, 'mobile.png', 'image/png');
      const manifest = await settle(id);

      const thumbRung = manifest.derivatives.find((d) => d.variant === 'thumb');
      expect(thumbRung).toBeDefined();
      // A 390px-wide iPhone slot at 1x is fully covered by the 512px rung, and the
      // manifest reports the REAL width (512, not the max-dim cap applied to the
      // wrong axis) so the client's `w` descriptor is truthful.
      expect(thumbRung!.width).toBe(512);
      expect(thumbRung!.height).toBe(288);
      expect(thumbRung!.bytes).toBeGreaterThan(0);

      // Every ready rung must actually be fetchable at the URL the client will mint.
      for (const rung of manifest.derivatives.filter((d) => d.state === 'ready')) {
        const res = await request(server()).get(`/api/v1/attachments/${id}/file?size=${rung.variant}`).set(dm);
        expect(res.status).toBe(200);
        expect(res.headers['x-campfire-derivative']).toBe(rung.variant);
        expect(Number(res.headers['content-length'])).toBe(rung.bytes);
      }

      // Ladder monotonicity: a phone's rung is strictly cheaper than a desktop's.
      const ready = manifest.derivatives.filter((d) => d.state === 'ready');
      for (let i = 1; i < ready.length; i++) {
        expect(ready[i].width).toBeGreaterThan(ready[i - 1].width);
        expect(ready[i].bytes).toBeGreaterThan(ready[i - 1].bytes);
      }
    }, 120_000);

    it('an already-small source materialises no rungs and falls back to the original', async () => {
      const small = await makeImage(300, 200, 'png');
      const id = await upload(small, 'small.png', 'image/png', 'portrait');
      const manifest = await settle(id);

      expect(manifest.derivatives.every((d) => d.state === 'skipped')).toBe(true);
      const res = await request(server()).get(`/api/v1/attachments/${id}/file?size=thumb`).set(dm);
      expect(res.status).toBe(200);
      expect(res.headers['x-campfire-derivative']).toBe('original-fallback');
      expect(Buffer.compare(res.body, small)).toBe(0);
    }, 60_000);

    it('the explicit download-original path still returns the untouched bytes', async () => {
      const bytes = await makeImage(2000, 1200, 'png');
      const id = await upload(bytes, 'download.png', 'image/png');
      await settle(id);

      const res = await request(server()).get(`/api/v1/attachments/${id}/file?download=1`).set(dm);
      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toContain('attachment');
      expect(res.headers['x-campfire-derivative']).toBe('original');
      expect(Buffer.compare(res.body, bytes)).toBe(0);
    }, 60_000);
  });

  // ---------- encounter battle map (role-safe responsive delivery) ----------

  describe('encounter battle map responsive delivery (#604 bullet 3)', () => {
    let encounterId: number;
    let mapId: number;

    beforeAll(async () => {
      const bytes = await makeImage(3000, 1800, 'png');
      mapId = await upload(bytes, 'battle.png', 'image/png');
      await settle(mapId);

      const enc = await request(server())
        .post(`/api/v1/campaigns/${campaignId}/encounters`)
        .set(dm)
        .send({ name: 'Responsive Fight', hidden: false });
      expect(enc.status).toBe(201);
      encounterId = enc.body.id;

      // Fog on, partially revealed — a player therefore gets the server-rendered
      // role-safe view, which is the case that must ALSO be responsive.
      const patch = await request(server())
        .patch(`/api/v1/encounters/${encounterId}`)
        .set(dm)
        .send({ mapAttachmentId: mapId, fog: { enabled: true, revealed: [{ x: 0, y: 0, w: 40, h: 100 }] } });
      expect(patch.status).toBe(200);
    }, 120_000);

    it('the encounter exposes the ladder to a PLAYER without exposing the attachment', async () => {
      // #463: the attachment routes stay closed for a fog-protected map...
      expect((await request(server()).get(`/api/v1/attachments/${mapId}/file`).set(player)).status).toBe(404);
      expect((await request(server()).get(`/api/v1/attachments/${mapId}/derivatives`).set(player)).status).toBe(404);

      // ...but the encounter-scoped manifest is readable, so the player can still
      // build a srcset for the fogged image they ARE allowed to see (#604).
      const res = await request(server()).get(`/api/v1/encounters/${encounterId}/map/derivatives`).set(player);
      expect(res.status).toBe(200);
      const manifest = res.body as Manifest;
      expect(manifest.status).toBe('ready');
      expect(manifest.derivatives.find((d) => d.variant === 'thumb')?.width).toBe(512);
    }, 60_000);

    it('a player fetching ?size=md gets a fog-protected image at that rung', async () => {
      const full = await request(server()).get(`/api/v1/encounters/${encounterId}/map`).set(player);
      const md = await request(server()).get(`/api/v1/encounters/${encounterId}/map?size=md`).set(player);

      expect(full.status).toBe(200);
      expect(md.status).toBe(200);
      expect(md.headers['x-campfire-map-view']).toBe('fog-protected');
      expect(md.headers['x-campfire-derivative']).toBe('md');
      const meta = await sharp(md.body).metadata();
      expect(meta.width).toBe(1280);
      expect(md.body.length).toBeLessThan(full.body.length);
    }, 60_000);

    it('the DM fetching ?size=md is served the stored derivative, not a live decode', async () => {
      const res = await request(server()).get(`/api/v1/encounters/${encounterId}/map?size=md`).set(dm);
      expect(res.status).toBe(200);
      expect(res.headers['x-campfire-map-view']).toBe('fully-revealed');
      expect(res.headers['x-campfire-derivative']).toBe('md');
      const stored = fs.readFileSync(path.join(ctx.dataDir, 'uploads', String(campaignId), `${mapId}.md.png`));
      expect(Buffer.compare(res.body, stored)).toBe(0);
    }, 60_000);

    it('an unsupported size on the encounter route is rejected (400)', async () => {
      const res = await request(server()).get(`/api/v1/encounters/${encounterId}/map?size=huge`).set(dm);
      expect(res.status).toBe(400);
    });
  });

  // ---------- storage bookkeeping ----------

  describe('storage bookkeeping (#604)', () => {
    it('generated derivatives are not reported as orphan or malformed files', async () => {
      const bytes = await makeImage(2400, 1500, 'png');
      const id = await upload(bytes, 'bookkeeping.png', 'image/png');
      const manifest = await settle(id);
      expect(manifest.derivatives.some((d) => d.state === 'ready')).toBe(true);

      // The admin console's orphan classifier must own `<id>.<variant>.png`. Before
      // #604 only `<id>.thumb.png` was recognised, so `md`/`lg` would have been
      // reaped as orphan files on the next cleanup — deleting live derivatives.
      const stats = await request(server()).get('/api/v1/admin/storage').set(dm);
      expect(stats.status).toBe(200);
      expect(stats.body.orphans.filesWithoutRow).toBe(0);

      const dry = await request(server()).post('/api/v1/admin/storage/cleanup?dryRun=true').set(dm);
      expect(dry.status).toBe(201);
      expect(dry.body.filesWithoutRow).toBe(0);

      // ...and the diagnostics scan must not call a two-dot derivative name malformed.
      const scan = await request(server()).post('/api/v1/admin/attachments/diagnostics').set(dm);
      expect(scan.status).toBe(201);
      const offending = (scan.body.issues as Array<{ type: string; path: string }>).filter(
        (issue) => issue.path.includes(`${id}.`),
      );
      expect(offending).toEqual([]);
    }, 60_000);
  });

  // ---------- deletion hygiene ----------

  it('deleting an attachment removes its derivative files and rows', async () => {
    const bytes = await makeImage(2000, 1200, 'png');
    const id = await upload(bytes, 'deleteme.png', 'image/png');
    await settle(id);

    const ladderPaths = DERIVATIVE_LADDER.map((spec) =>
      path.join(ctx.dataDir, 'uploads', String(campaignId), `${id}.${spec.name}.png`),
    );
    expect(ladderPaths.some((p) => fs.existsSync(p))).toBe(true);

    const del = await request(server()).delete(`/api/v1/attachments/${id}`).set(dm);
    expect(del.status).toBe(200);
    for (const p of ladderPaths) expect(fs.existsSync(p)).toBe(false);

    const after = await request(server()).get(`/api/v1/attachments/${id}/derivatives`).set(dm);
    expect(after.status).toBe(404);
  }, 60_000);
});
