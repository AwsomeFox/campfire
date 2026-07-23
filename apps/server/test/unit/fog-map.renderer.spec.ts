import sharp from 'sharp';
import {
  FOG_BACKGROUND,
  FOG_MAP_MAX_INPUT_PIXELS,
  FOG_MAP_THUMB_MAX_DIM,
  renderFogSafeMap,
} from '../../src/modules/encounters/fog-map.renderer';

async function rawRgba(bytes: Buffer) {
  return sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}

describe('renderFogSafeMap', () => {
  it('copies only revealed source pixels and replaces every hidden pixel with opaque fog', async () => {
    // Four distinct opaque pixels: red, green, blue, yellow.
    const sourcePixels = Buffer.from([
      255, 0, 0, 255,
      0, 255, 0, 255,
      0, 0, 255, 255,
      255, 255, 0, 255,
    ]);
    const source = await sharp(sourcePixels, { raw: { width: 4, height: 1, channels: 4 } }).png().toBuffer();

    const rendered = await renderFogSafeMap(source, [{ x: 0, y: 0, w: 50, h: 100 }]);
    const decoded = await rawRgba(rendered.bytes);

    expect(decoded.info.width).toBe(4);
    expect([...decoded.data.subarray(0, 8)]).toEqual([...sourcePixels.subarray(0, 8)]);
    expect([...decoded.data.subarray(8, 12)]).toEqual([FOG_BACKGROUND.r, FOG_BACKGROUND.g, FOG_BACKGROUND.b, 255]);
    expect([...decoded.data.subarray(12, 16)]).toEqual([FOG_BACKGROUND.r, FOG_BACKGROUND.g, FOG_BACKGROUND.b, 255]);
    expect(rendered.etag).toMatch(/^"[0-9a-f]{64}"$/);
  });

  it('does not retain hidden RGB behind transparent alpha', async () => {
    const transparentSecret = Buffer.from([201, 17, 99, 0]);
    const source = await sharp(transparentSecret, { raw: { width: 1, height: 1, channels: 4 } }).png().toBuffer();
    const rendered = await renderFogSafeMap(source, []);
    const decoded = await rawRgba(rendered.bytes);
    expect([...decoded.data]).toEqual([FOG_BACKGROUND.r, FOG_BACKGROUND.g, FOG_BACKGROUND.b, 255]);
  });

  it.each(['jpeg', 'webp', 'svg'] as const)('fails closed through one raster path for %s sources', async (format) => {
    let source: Buffer;
    if (format === 'svg') {
      source = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#ff00ff"/></svg>');
    } else {
      const pixels = Buffer.alloc(8 * 8 * 3, 240);
      const pipeline = sharp(pixels, { raw: { width: 8, height: 8, channels: 3 } });
      source = format === 'jpeg' ? await pipeline.jpeg().toBuffer() : await pipeline.webp().toBuffer();
    }
    const rendered = await renderFogSafeMap(source, []);
    const decoded = await rawRgba(rendered.bytes);
    for (let offset = 0; offset < decoded.data.length; offset += 4) {
      expect([...decoded.data.subarray(offset, offset + 4)]).toEqual([
        FOG_BACKGROUND.r,
        FOG_BACKGROUND.g,
        FOG_BACKGROUND.b,
        255,
      ]);
    }
  });

  it('creates a safe thumbnail without enlarging or exceeding the thumbnail cap', async () => {
    const source = await sharp({
      create: { width: 900, height: 600, channels: 3, background: { r: 200, g: 100, b: 50 } },
    })
      .png()
      .toBuffer();
    const rendered = await renderFogSafeMap(source, [], 'thumb');
    expect(rendered.width).toBe(FOG_MAP_THUMB_MAX_DIM);
    expect(rendered.height).toBeLessThan(FOG_MAP_THUMB_MAX_DIM);
  });

  it('caps input pixels well below a multi-hundred-MB RGBA decode', () => {
    // 4096² — aligned with practical VTT uploads; far under the old 40MP ceiling.
    expect(FOG_MAP_MAX_INPUT_PIXELS).toBe(16_777_216);
    expect(FOG_MAP_MAX_INPUT_PIXELS).toBeLessThan(40_000_000);
  });

  it('rejects sources that exceed the fog pixel budget', async () => {
    // A sparse SVG can declare dimensions above the budget without a huge file.
    const oversize = Math.ceil(Math.sqrt(FOG_MAP_MAX_INPUT_PIXELS)) + 1;
    const source = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${oversize}" height="${oversize}"><rect width="100%" height="100%" fill="#ff00ff"/></svg>`,
    );
    await expect(renderFogSafeMap(source, [])).rejects.toThrow();
  });
});
