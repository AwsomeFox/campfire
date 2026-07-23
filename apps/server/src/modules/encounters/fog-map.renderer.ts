import crypto from 'node:crypto';
import sharp from 'sharp';
import type { FogRect } from '@campfire/schema';

export const FOG_BACKGROUND = { r: 11, g: 17, b: 32, alpha: 1 } as const;
/**
 * Align with practical VTT upload dimensions (≈4096²). Decoding to RGBA at the old
 * 40MP ceiling could allocate hundreds of MB per request once sharp's internal
 * buffers are included; fail closed above this bound instead.
 */
export const FOG_MAP_MAX_INPUT_PIXELS = 16_777_216;
export const FOG_MAP_THUMB_MAX_DIM = 512;

export interface FogMapRenderResult {
  bytes: Buffer;
  etag: string;
  width: number;
  height: number;
}

interface PixelRect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** Convert a percentage rectangle to pixels without revealing boundary pixels outside it. */
function toPixelRect(rect: FogRect, width: number, height: number): PixelRect | null {
  const x0 = Math.max(0, Math.min(width, Math.ceil((rect.x / 100) * width)));
  const x1 = Math.max(0, Math.min(width, Math.floor(((rect.x + rect.w) / 100) * width)));
  const y0 = Math.max(0, Math.min(height, Math.ceil((rect.y / 100) * height)));
  const y1 = Math.max(0, Math.min(height, Math.floor(((rect.y + rect.h) / 100) * height)));
  return x1 > x0 && y1 > y0 ? { x0, x1, y0, y1 } : null;
}

/** Merge horizontal reveal spans for one scanline, avoiding repeated copies for overlaps. */
function mergedIntervals(rects: PixelRect[], y: number): Array<[number, number]> {
  const spans = rects
    .filter((rect) => y >= rect.y0 && y < rect.y1)
    .map((rect) => [rect.x0, rect.x1] as [number, number])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const span of spans) {
    const previous = merged[merged.length - 1];
    if (!previous || span[0] > previous[1]) {
      merged.push([...span]);
    } else if (span[1] > previous[1]) {
      previous[1] = span[1];
    }
  }
  return merged;
}

/** Fill one RGBA row segment with opaque fog colour (mutates `data` in place). */
function fillFog(data: Buffer, start: number, end: number): void {
  for (let offset = start; offset < end; offset += 4) {
    data[offset] = FOG_BACKGROUND.r;
    data[offset + 1] = FOG_BACKGROUND.g;
    data[offset + 2] = FOG_BACKGROUND.b;
    data[offset + 3] = 255;
  }
}

/**
 * Rasterize a source map and keep only explicitly revealed pixels. Hidden pixels are
 * overwritten in place with opaque fog colour so peak memory stays at one RGBA buffer
 * (plus sharp's encode scratch), not a second full-size canvas.
 *
 * Sharp gives one safe decoder for every map format Campfire stores (PNG, JPEG,
 * WebP, and server-generated SVG). The result is always an opaque PNG so lossy
 * codecs cannot bleed neighbouring hidden pixels across a reveal boundary.
 */
export async function renderFogSafeMap(
  source: Buffer,
  revealed: FogRect[],
  variant: 'original' | 'thumb' = 'original',
): Promise<FogMapRenderResult> {
  let pipeline = sharp(source, {
    failOn: 'error',
    limitInputPixels: FOG_MAP_MAX_INPUT_PIXELS,
  }).rotate();

  if (variant === 'thumb') {
    pipeline = pipeline.resize({
      width: FOG_MAP_THUMB_MAX_DIM,
      height: FOG_MAP_THUMB_MAX_DIM,
      fit: 'inside',
      withoutEnlargement: true,
    });
  }

  const decoded = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = decoded.info;
  if (channels !== 4 || width <= 0 || height <= 0) {
    throw new Error('Map decoder did not produce RGBA pixels');
  }
  if (width * height > FOG_MAP_MAX_INPUT_PIXELS) {
    throw new Error(`Map exceeds fog render pixel budget (${width}x${height})`);
  }

  const pixelRects = revealed
    .map((rect) => toPixelRect(rect, width, height))
    .filter((rect): rect is PixelRect => rect !== null);
  const stride = width * channels;
  const pixels = decoded.data;
  for (let y = 0; y < height; y++) {
    const rowStart = y * stride;
    const reveals = mergedIntervals(pixelRects, y);
    let cursor = 0;
    for (const [x0, x1] of reveals) {
      if (x0 > cursor) fillFog(pixels, rowStart + cursor * channels, rowStart + x0 * channels);
      cursor = Math.max(cursor, x1);
    }
    if (cursor < width) fillFog(pixels, rowStart + cursor * channels, rowStart + width * channels);
  }

  const bytes = await sharp(pixels, { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
  const etag = `"${crypto.createHash('sha256').update(bytes).digest('hex')}"`;
  return { bytes, etag, width, height };
}
