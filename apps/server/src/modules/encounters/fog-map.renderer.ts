import crypto from 'node:crypto';
import sharp from 'sharp';
import type { FogRect } from '@campfire/schema';

export const FOG_BACKGROUND = { r: 11, g: 17, b: 32, alpha: 1 } as const;
export const FOG_MAP_MAX_INPUT_PIXELS = 40_000_000;
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

/**
 * Rasterize a source map and copy only explicitly revealed pixels onto an opaque
 * dark canvas. Hidden output pixels contain the fog colour itself, not transparent
 * source RGB that could be recovered by changing alpha in an image editor.
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

  const safe = Buffer.alloc(decoded.data.length);
  for (let offset = 0; offset < safe.length; offset += 4) {
    safe[offset] = FOG_BACKGROUND.r;
    safe[offset + 1] = FOG_BACKGROUND.g;
    safe[offset + 2] = FOG_BACKGROUND.b;
    safe[offset + 3] = 255;
  }

  const pixelRects = revealed
    .map((rect) => toPixelRect(rect, width, height))
    .filter((rect): rect is PixelRect => rect !== null);
  const stride = width * channels;
  for (let y = 0; y < height; y++) {
    for (const [x0, x1] of mergedIntervals(pixelRects, y)) {
      const start = y * stride + x0 * channels;
      const end = y * stride + x1 * channels;
      decoded.data.copy(safe, start, start, end);
    }
  }

  const bytes = await sharp(safe, { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
  const etag = `"${crypto.createHash('sha256').update(bytes).digest('hex')}"`;
  return { bytes, etag, width, height };
}
