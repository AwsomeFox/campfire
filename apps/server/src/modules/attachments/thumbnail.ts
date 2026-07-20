import zlib from 'node:zlib';

/**
 * Longest-edge (px) a generated thumbnail is scaled down to. 512 is comfortably
 * large enough for a dashboard/list preview yet an order of magnitude smaller in
 * bytes than a full campaign map.
 */
export const THUMB_MAX_DIM = 512;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Channels per PNG colour type (only the non-palette 8-bit types are supported here).
const CHANNELS_BY_COLOR_TYPE: Record<number, number> = {
  0: 1, // grayscale
  2: 3, // truecolour (RGB)
  4: 2, // grayscale + alpha
  6: 4, // truecolour + alpha (RGBA)
};

// Standard PNG/zlib CRC-32 (polynomial 0xEDB88320), precomputed table.
const CRC_TABLE: number[] = (() => {
  const table = new Array<number>(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

interface DecodedImage {
  width: number;
  height: number;
  channels: number;
  colorType: number;
  /** Row-major pixel data, `channels` bytes per pixel, 8 bits each. */
  pixels: Buffer;
}

/**
 * Minimal PNG decoder for the 8-bit, non-interlaced, non-palette colour types
 * (grayscale, RGB, grayscale+alpha, RGBA). Anything outside that subset — 16-bit,
 * interlaced, or palette PNGs — returns null so the caller falls back to serving
 * the original bytes. Dependency-free: inflate comes from node:zlib.
 */
function decodePng(buffer: Buffer): DecodedImage | null {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) return null; // truncated chunk
    const data = buffer.subarray(dataStart, dataEnd);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    } else if (type === 'PLTE') {
      return null; // palette images not supported by this minimal decoder
    }

    offset = dataEnd + 4; // skip data + CRC
  }

  const channels = CHANNELS_BY_COLOR_TYPE[colorType];
  if (!channels || bitDepth !== 8 || interlace !== 0 || width <= 0 || height <= 0) return null;
  if (idat.length === 0) return null;

  let raw: Buffer;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }

  const stride = width * channels;
  if (raw.length < height * (stride + 1)) return null;

  const pixels = Buffer.alloc(height * stride);
  let rawPos = 0;
  for (let y = 0; y < height; y++) {
    const filterType = raw[rawPos++];
    const rowStart = y * stride;
    const prevStart = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[rawPos++];
      const a = x >= channels ? pixels[rowStart + x - channels] : 0; // left
      const b = y > 0 ? pixels[prevStart + x] : 0; // up
      const c = x >= channels && y > 0 ? pixels[prevStart + x - channels] : 0; // up-left
      let value: number;
      switch (filterType) {
        case 0:
          value = rawByte;
          break;
        case 1:
          value = rawByte + a;
          break;
        case 2:
          value = rawByte + b;
          break;
        case 3:
          value = rawByte + ((a + b) >> 1);
          break;
        case 4:
          value = rawByte + paeth(a, b, c);
          break;
        default:
          return null; // unknown filter
      }
      pixels[rowStart + x] = value & 0xff;
    }
  }

  return { width, height, channels, colorType, pixels };
}

/** Box-average downscale to (newW x newH). Never upscales (caller guarantees smaller). */
function downscale(img: DecodedImage, newW: number, newH: number): Buffer {
  const { width, height, channels, pixels } = img;
  const out = Buffer.alloc(newW * newH * channels);
  for (let dy = 0; dy < newH; dy++) {
    const sy0 = Math.floor((dy * height) / newH);
    const sy1 = Math.max(sy0 + 1, Math.floor(((dy + 1) * height) / newH));
    for (let dx = 0; dx < newW; dx++) {
      const sx0 = Math.floor((dx * width) / newW);
      const sx1 = Math.max(sx0 + 1, Math.floor(((dx + 1) * width) / newW));
      const outBase = (dy * newW + dx) * channels;
      for (let ch = 0; ch < channels; ch++) {
        let sum = 0;
        let count = 0;
        for (let sy = sy0; sy < sy1 && sy < height; sy++) {
          const rowBase = sy * width * channels;
          for (let sx = sx0; sx < sx1 && sx < width; sx++) {
            sum += pixels[rowBase + sx * channels + ch];
            count++;
          }
        }
        out[outBase + ch] = count > 0 ? Math.round(sum / count) : 0;
      }
    }
  }
  return out;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/** Re-encode 8-bit pixel data as a PNG (filter type 0 on every scanline). */
function encodePng(width: number, height: number, channels: number, colorType: number, pixels: Buffer): Buffer {
  const stride = width * channels;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * Generate a downscaled PNG thumbnail (longest edge = maxDim) from PNG bytes,
 * dependency-free. Returns null when a thumbnail is unnecessary or can't be made:
 *  - the source already fits within maxDim (no upscaling), or
 *  - the source isn't a PNG in the supported subset (16-bit/interlaced/palette),
 * in which case the caller serves the original bytes (documented tradeoff — a
 * true multi-format resizer would need a native lib like `sharp`, deliberately
 * not added here to keep the server dependency-light).
 */
export function generatePngThumbnail(buffer: Buffer, maxDim: number = THUMB_MAX_DIM): Buffer | null {
  const img = decodePng(buffer);
  if (!img) return null;

  const longest = Math.max(img.width, img.height);
  if (longest <= maxDim) return null; // already small enough — serve original

  const scale = maxDim / longest;
  const newW = Math.max(1, Math.round(img.width * scale));
  const newH = Math.max(1, Math.round(img.height * scale));

  const scaled = downscale(img, newW, newH);
  return encodePng(newW, newH, img.channels, img.colorType, scaled);
}
