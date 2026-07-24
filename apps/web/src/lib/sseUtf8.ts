/**
 * UTF-8 byte length for SSE buffer accounting (#748 recovery).
 *
 * Caps are documented as bytes; JS string `.length` is UTF-16 code units, which
 * under-counts multi-byte characters. Use this at measurement boundaries.
 */
const encoder = new TextEncoder();

export function utf8ByteLength(text: string): number {
  if (text.length === 0) return 0;
  return encoder.encode(text).byteLength;
}
