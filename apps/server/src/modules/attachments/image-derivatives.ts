/**
 * Image validation caps + the responsive derivative ladder (issue #604).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Before #604 the only downscaling Campfire could do was `thumbnail.ts`'s
 * dependency-free PNG decoder: it handled a narrow 8-bit non-interlaced
 * non-palette PNG subset, returned `null` for everything else (so the request
 * fell back to streaming a multi-MB original), and — worse — it ran
 * SYNCHRONOUSLY ON THE REQUEST THREAD the first time a `?size=thumb` URL was
 * hit. A world map or battle map therefore cost every viewer a full-resolution
 * download, and an unlucky viewer additionally paid for a full-pixel inflate
 * inside the event loop.
 *
 * `sharp` was already a dependency (used by the fog-of-war renderer), so this
 * module standardises on it: one decoder that covers every format Campfire
 * stores (PNG, JPEG, WebP, and server-generated SVG), a cheap header probe that
 * lets us REJECT a decompression bomb before committing to a decode, and a
 * fixed ladder of derivative sizes that the durable pipeline in
 * attachment-derivatives.service.ts materialises off the request path.
 *
 * Nothing here touches the filesystem or the database — it is the pure policy +
 * rendering layer so the caps can be unit/e2e asserted directly.
 */
import crypto from 'node:crypto';
import sharp from 'sharp';

/**
 * Hard ceiling on a single edge of an uploaded image, in pixels.
 *
 * 16384 is the largest edge any mainstream browser will composite (and the
 * texture limit on most GPUs), so a longer edge cannot render usefully anywhere
 * in the app. It also bounds the per-row scratch buffers sharp allocates while
 * resizing: one RGBA scanline at this width is 64 KiB, which is nothing, while
 * a 200_000-pixel-wide "thin bomb" (small pixel count, absurd stride) would
 * otherwise sail past a pure megapixel check.
 */
export const ATTACHMENT_MAX_IMAGE_DIMENSION = 16_384;

/**
 * Hard ceiling on total pixel count (width × height) of an uploaded image.
 *
 * 40 MP is chosen to sit *above* the largest real map we intend to support —
 * full 8K (7680 × 4320) is 33.2 MP — and *below* the point where decoding
 * becomes an availability risk. Peak cost is one RGBA plane: 40 MP × 4 B =
 * 160 MB, plus sharp's encode scratch. That is affordable for the SINGLE
 * background worker that generates derivatives (see DERIVATIVE_DRAIN_BATCH in
 * attachment-derivatives.service.ts — one image is decoded at a time), and it
 * is never paid on a request thread.
 *
 * Above this we reject the upload outright rather than "routing to a bounded
 * path": a 100 MP+ image is either a decompression bomb or an asset the DM
 * should downscale before uploading, and silently accepting it would leave a
 * row whose derivatives can never succeed. MAX_UPLOAD_BYTES (32 MB) is NOT a
 * defence here — a maximally-compressible PNG bomb reaches gigapixels in a few
 * hundred KB — which is exactly why the probe below reads the header instead of
 * trusting the byte length.
 */
export const ATTACHMENT_MAX_IMAGE_PIXELS = 40_000_000;

/**
 * The `limitInputPixels` we hand sharp on every decode. Set to the same cap so a
 * lying/absent header (or a format whose true size only emerges mid-decode)
 * still aborts inside libvips instead of allocating unbounded memory. Belt and
 * braces with the explicit probe: the probe gives us a clean 4xx with a useful
 * message, this makes the decoder itself fail closed.
 */
export const SHARP_INPUT_PIXEL_LIMIT = ATTACHMENT_MAX_IMAGE_PIXELS;

/**
 * Longest-edge cap of the smallest derivative. Kept at the historical
 * THUMB_MAX_DIM value so `?size=thumb` URLs minted before #604 (dashboard/list
 * previews, the encounter map's thumb view) keep meaning exactly what they did.
 */
export const THUMB_MAX_DIM = 512;

/** A rung on the responsive ladder. `maxDim` caps the LONGEST edge. */
export interface DerivativeVariantSpec {
  /** Stable id — appears in URLs (`?size=`), DB rows, and on-disk filenames. */
  readonly name: DerivativeVariantName;
  /** Longest-edge cap in pixels. */
  readonly maxDim: number;
}

export type DerivativeVariantName = 'thumb' | 'md' | 'lg';

/**
 * The responsive ladder, smallest first.
 *
 *  - `thumb` (512) — list rows, dashboard cards, handout chips.
 *  - `md` (1280) — the world-map card and a phone/tablet battle map. A 1x
 *    phone viewport is ~430 CSS px, so 1280 still covers 2x-3x DPR there.
 *  - `lg` (2560) — a desktop battle map at 2x DPR, and the largest size we will
 *    ever serve in place of the original.
 *
 * Deliberately only three rungs: each rung costs disk for EVERY image
 * attachment in every campaign (see website/docs/administration/server.md
 * for the capacity maths), and three rungs already let a browser's `srcset`
 * picker avoid the original in every viewport we support. Anything larger than
 * `lg` is served as the original — which is also the DM's explicit
 * "download original" path (`?download=1`).
 */
export const DERIVATIVE_LADDER: readonly DerivativeVariantSpec[] = [
  { name: 'thumb', maxDim: THUMB_MAX_DIM },
  { name: 'md', maxDim: 1280 },
  { name: 'lg', maxDim: 2560 },
] as const;

export const DERIVATIVE_VARIANT_NAMES: readonly DerivativeVariantName[] = DERIVATIVE_LADDER.map(
  (spec) => spec.name,
);

/** Requested size on a file GET: a ladder rung, or the untouched original. */
export type RequestedSize = DerivativeVariantName | 'original';

export function isDerivativeVariantName(value: string): value is DerivativeVariantName {
  return DERIVATIVE_VARIANT_NAMES.includes(value as DerivativeVariantName);
}

export function derivativeSpec(name: DerivativeVariantName): DerivativeVariantSpec {
  const spec = DERIVATIVE_LADDER.find((candidate) => candidate.name === name);
  if (!spec) throw new Error(`Unknown derivative variant ${name}`);
  return spec;
}

/**
 * Derivatives are always PNG.
 *
 * WebP would be ~30% smaller, but PNG keeps three properties we already depend
 * on: `?size=thumb` has always answered `image/png` (clients and the existing
 * e2e suite assert it), the fog renderer already emits PNG so a protected and
 * an unprotected map look identical to a cache, and PNG is lossless — a lossy
 * re-encode of a battle map can bleed detail across a fog reveal boundary.
 */
export const DERIVATIVE_MIME = 'image/png';
export const DERIVATIVE_EXT = 'png';

/** Mime types the derivative pipeline knows how to decode. */
export function isDerivableMime(mime: string): boolean {
  return mime.startsWith('image/');
}

export interface ImageProbe {
  width: number;
  height: number;
  /** sharp's detected format id ('png' | 'jpeg' | 'webp' | 'svg' | …). */
  format: string;
}

export class ImageLimitError extends Error {
  constructor(
    message: string,
    /** `dimension` | `pixels` | `undecodable` — lets callers map to a status code. */
    readonly reason: 'dimension' | 'pixels' | 'undecodable',
  ) {
    super(message);
    this.name = 'ImageLimitError';
  }
}

/**
 * Read an image's declared dimensions WITHOUT decoding its pixels.
 *
 * `sharp().metadata()` parses only the container header, so this is O(bytes
 * read from the header) rather than O(pixels) — cheap enough to run on the
 * upload request path, which is the whole point: it is what lets us reject a
 * decompression bomb *before* anything commits to inflating it.
 *
 * Throws ImageLimitError('undecodable') when the bytes are not an image sharp
 * can read at all (corrupt/truncated/unsupported), so a caller can answer 400
 * instead of leaving a row whose derivatives will fail forever.
 */
export async function probeImage(bytes: Buffer): Promise<ImageProbe> {
  let meta: sharp.Metadata;
  try {
    meta = await sharp(bytes, { failOn: 'error', limitInputPixels: SHARP_INPUT_PIXEL_LIMIT }).metadata();
  } catch (err) {
    throw new ImageLimitError(
      `Image could not be decoded: ${err instanceof Error ? err.message : String(err)}`,
      'undecodable',
    );
  }
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!(width > 0) || !(height > 0)) {
    throw new ImageLimitError('Image header does not declare usable dimensions', 'undecodable');
  }
  return { width, height, format: meta.format ?? 'unknown' };
}

/**
 * Probe + enforce the caps. Returns the probe on success so callers do not pay
 * for a second header read.
 *
 * NOTE the ORDER: the dimension check runs before the pixel check so a
 * "thin bomb" (1 × 500_000_000 has a huge pixel count but also an impossible
 * edge) reports the more actionable of the two failures.
 */
export async function probeImageWithinLimits(bytes: Buffer): Promise<ImageProbe> {
  const probe = await probeImage(bytes);
  if (probe.width > ATTACHMENT_MAX_IMAGE_DIMENSION || probe.height > ATTACHMENT_MAX_IMAGE_DIMENSION) {
    throw new ImageLimitError(
      `Image is ${probe.width}×${probe.height}; each edge must be at most ${ATTACHMENT_MAX_IMAGE_DIMENSION}px`,
      'dimension',
    );
  }
  if (probe.width * probe.height > ATTACHMENT_MAX_IMAGE_PIXELS) {
    throw new ImageLimitError(
      `Image is ${probe.width}×${probe.height} (${probe.width * probe.height} pixels); ` +
        `the limit is ${ATTACHMENT_MAX_IMAGE_PIXELS} pixels (~8K). Downscale it before uploading.`,
      'pixels',
    );
  }
  return probe;
}

export interface RenderedDerivative {
  bytes: Buffer;
  width: number;
  height: number;
  /** sha256 hex of `bytes` — persisted so a corrupted cache file is detectable. */
  checksum: string;
}

/**
 * Decode `source` and re-encode it capped to `spec.maxDim` on the longest edge.
 *
 * `withoutEnlargement` means a source already smaller than the rung comes back
 * unchanged in dimensions; callers are expected to skip such rungs entirely
 * (see shouldMaterialise below) rather than storing a byte-for-byte copy.
 *
 * `.rotate()` with no argument applies the EXIF orientation, so a phone photo
 * used as a handout is not stored sideways in every derivative while the
 * original renders upright.
 *
 * ALWAYS call this from the background worker, never from a request handler —
 * this is the O(pixels) step #604 exists to move off the request path.
 */
export async function renderDerivative(
  source: Buffer,
  spec: DerivativeVariantSpec,
): Promise<RenderedDerivative> {
  const out = await sharp(source, { failOn: 'error', limitInputPixels: SHARP_INPUT_PIXEL_LIMIT })
    .rotate()
    .resize({ width: spec.maxDim, height: spec.maxDim, fit: 'inside', withoutEnlargement: true })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer({ resolveWithObject: true });
  return {
    bytes: out.data,
    width: out.info.width,
    height: out.info.height,
    checksum: crypto.createHash('sha256').update(out.data).digest('hex'),
  };
}

/**
 * Whether a rung is worth materialising for a source of this size.
 *
 * Skipping (rather than generating an identical-size copy) is what keeps a
 * campaign full of 400px portraits from tripling its disk usage for zero
 * benefit, and it preserves the pre-#604 behaviour that `?size=thumb` on an
 * already-small image serves the ORIGINAL bytes.
 *
 * The 1.15 margin avoids materialising a rung that would shave <15% off the
 * longest edge: the byte saving does not repay the disk + generation cost.
 */
export function shouldMaterialise(probe: { width: number; height: number }, spec: DerivativeVariantSpec): boolean {
  return Math.max(probe.width, probe.height) > spec.maxDim * 1.15;
}
