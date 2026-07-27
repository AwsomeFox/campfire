/**
 * Container-level image metadata stripping for redacted exports (issue #586).
 *
 * Attachment FILENAMES are the obvious identity leak ("sarah-holiday-photo.jpg"), but
 * embedded metadata is the quiet one: EXIF carries camera serials, GPS coordinates and
 * an Artist/Copyright name; PNG text chunks carry whatever the authoring tool wrote
 * (often the OS user name); XMP carries both.
 *
 * SCOPE — deliberately narrow, and enforced by the caller:
 *  - PNG  : rewritten keeping only an ALLOWLIST of chunks required to render the image.
 *  - JPEG : rewritten dropping every APPn (n >= 1) and COM segment; APP0/JFIF is kept
 *           because it is a fixed density header with no free text.
 *  - everything else (WebP, PDF, SVG): NOT SUPPORTED. This module reports
 *    `supported: false` and the publish profile omits those bytes entirely rather
 *    than shipping metadata it cannot vouch for. Handoff embeds them and says so in
 *    the inventory.
 *
 * This is not a re-encoder. Pixel data is copied verbatim; steganographic or
 * rendered-into-the-image content is out of scope and is called out in the
 * export limitations note.
 */

export type MetadataStripResult = {
  bytes: Buffer;
  /** True when this module knows how to strip metadata from the format. */
  supported: boolean;
  /** True when at least one metadata segment/chunk was actually removed. */
  stripped: boolean;
};

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * PNG chunks kept in a sanitized image. ALLOWLIST — an unknown or future chunk type
 * is dropped, which is the safe direction: the worst case is a rendering hint lost,
 * versus a private-data chunk shipped.
 *
 * Deliberately absent: tEXt/zTXt/iTXt (free text), eXIf (EXIF), tIME (timestamp),
 * iCCP (profile name is a free-text string), and every private/unknown type.
 */
const PNG_KEEP_CHUNKS = new Set([
  'IHDR', 'PLTE', 'IDAT', 'IEND',
  'tRNS', 'gAMA', 'cHRM', 'sRGB', 'sBIT', 'bKGD', 'pHYs', 'hIST', 'sPLT',
  // APNG animation control — dropping these would break animated PNGs.
  'acTL', 'fcTL', 'fdAT',
]);

function stripPngMetadata(bytes: Buffer): MetadataStripResult {
  if (bytes.length < PNG_MAGIC.length + 12 || !bytes.subarray(0, 8).equals(PNG_MAGIC)) {
    return { bytes, supported: false, stripped: false };
  }
  const kept: Buffer[] = [bytes.subarray(0, 8)];
  let offset = 8;
  let stripped = false;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    // 4 length + 4 type + data + 4 crc
    const end = offset + 12 + length;
    if (length > bytes.length || end > bytes.length) {
      // Malformed/truncated: refuse to rewrite rather than emit a corrupt image.
      return { bytes, supported: false, stripped: false };
    }
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    if (PNG_KEEP_CHUNKS.has(type)) kept.push(bytes.subarray(offset, end));
    else stripped = true;
    offset = end;
    if (type === 'IEND') break;
  }
  return { bytes: Buffer.concat(kept), supported: true, stripped };
}

/** Markers with no length field — they stand alone in the byte stream. */
const JPEG_STANDALONE = new Set([0xd8, 0xd9, 0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7]);

function stripJpegMetadata(bytes: Buffer): MetadataStripResult {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return { bytes, supported: false, stripped: false };
  }
  const kept: Buffer[] = [bytes.subarray(0, 2)];
  let offset = 2;
  let stripped = false;
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) return { bytes, supported: false, stripped: false };
    // Fill bytes: 0xFF padding before a marker is legal.
    let markerAt = offset;
    while (markerAt + 1 < bytes.length && bytes[markerAt + 1] === 0xff) markerAt += 1;
    const marker = bytes[markerAt + 1];
    if (JPEG_STANDALONE.has(marker)) {
      kept.push(bytes.subarray(markerAt, markerAt + 2));
      offset = markerAt + 2;
      continue;
    }
    if (markerAt + 4 > bytes.length) return { bytes, supported: false, stripped: false };
    const length = bytes.readUInt16BE(markerAt + 2);
    if (length < 2 || markerAt + 2 + length > bytes.length) {
      return { bytes, supported: false, stripped: false };
    }
    const segmentEnd = markerAt + 2 + length;
    // APP1..APP15 (EXIF, XMP, IPTC/Photoshop, Adobe) and COM are the free-text
    // carriers. APP0 is JFIF/JFXX: fixed density fields, kept so viewers that rely
    // on it keep working.
    const isMetadata = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (isMetadata) stripped = true;
    else kept.push(bytes.subarray(markerAt, segmentEnd));

    if (marker === 0xda) {
      // Start of scan: entropy-coded data runs to the end of the file. Copy verbatim.
      kept.push(bytes.subarray(segmentEnd));
      return { bytes: Buffer.concat(kept), supported: true, stripped };
    }
    offset = segmentEnd;
  }
  return { bytes: Buffer.concat(kept), supported: true, stripped };
}

/**
 * Strip container metadata where we can prove what we removed.
 *
 * Returns `supported: false` for formats this module does not parse (WebP, PDF, SVG)
 * and for files whose structure does not validate — callers must decide what to do
 * with unsupported bytes; the publish profile omits them.
 */
export function stripImageMetadata(mime: string, bytes: Buffer): MetadataStripResult {
  if (mime === 'image/png') return stripPngMetadata(bytes);
  if (mime === 'image/jpeg') return stripJpegMetadata(bytes);
  return { bytes, supported: false, stripped: false };
}

/** Formats whose embedded metadata this codebase can provably strip. */
export const SANITIZABLE_MIMES = new Set(['image/png', 'image/jpeg']);
