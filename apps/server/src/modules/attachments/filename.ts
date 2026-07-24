/**
 * Attachment filename helpers (issue #630).
 *
 * Two jobs:
 *  1. Sanitize a client-supplied name for safe storage/display — basename-only,
 *     control/path scrubbing, and grapheme-aware truncation that never splits a
 *     surrogate pair (unlike `String#slice`) while preserving the extension.
 *  2. Emit a standards-compliant `Content-Disposition` header (RFC 6266 +
 *     RFC 5987): an ASCII-safe legacy `filename=` fallback plus a UTF-8
 *     `filename*` when the original name differs.
 *
 * On-disk storage still uses `<id>.<ext>` (see AttachmentsService.filePath);
 * these helpers only touch the display/original name kept in the DB row and
 * echoed to browsers on download.
 */

/** Matches `Attachment.filename` / zod `.max(255)` — UTF-16 code-unit budget. */
export const MAX_ATTACHMENT_FILENAME_LENGTH = 255;

const DEFAULT_BASENAME = 'attachment';

/** ASCII controls (0x00–0x1F) and DEL — never safe in stored names or headers. */
// eslint-disable-next-line no-control-regex -- intentionally match ASCII controls + DEL
const CONTROL_OR_DEL = /[\u0000-\u001f\u007f]/g;

type GraphemeSegmenter = { segment(input: string): Iterable<{ segment: string }> };

/**
 * Split `input` into grapheme clusters via `Intl.Segmenter` when available,
 * otherwise into Unicode code points. Either path preserves surrogate pairs
 * (emoji, non-BMP scripts) that `String#slice` can bisect.
 */
function graphemeSegments(input: string): string[] {
  const Segmenter = (Intl as typeof Intl & {
    Segmenter?: new (
      locales?: string,
      options?: { granularity: 'grapheme' },
    ) => GraphemeSegmenter;
  }).Segmenter;
  if (Segmenter) {
    try {
      return [...new Segmenter('und', { granularity: 'grapheme' }).segment(input)].map(
        (s) => s.segment,
      );
    } catch {
      // fall through to code-point split
    }
  }
  return [...input];
}

/** Truncate to at most `maxCodeUnits` UTF-16 units without splitting graphemes. */
function truncateToCodeUnits(input: string, maxCodeUnits: number): string {
  if (maxCodeUnits <= 0) return '';
  if (input.length <= maxCodeUnits) return input;
  let out = '';
  for (const g of graphemeSegments(input)) {
    if (out.length + g.length > maxCodeUnits) break;
    out += g;
  }
  return out;
}

/** Last path segment, accepting both `/` and `\\` separators. */
function basenameOnly(raw: string): string {
  const normalized = raw.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1] ?? '';
}

function splitExtension(filename: string): { stem: string; ext: string } {
  const lastDot = filename.lastIndexOf('.');
  // Leading-dot names (".png") are treated as stem-only — no extension to preserve.
  if (lastDot <= 0) return { stem: filename, ext: '' };
  return { stem: filename.slice(0, lastDot), ext: filename.slice(lastDot) };
}

/**
 * Some multipart clients percent-encode characters inside `filename="…"`
 * (e.g. `"` → `%22`). Decode when the whole name is a well-formed
 * URI-component; leave malformed sequences untouched.
 */
function maybePercentDecode(name: string): string {
  if (!/%[0-9A-Fa-f]{2}/.test(name)) return name;
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/**
 * Multer/busboy historically decode the multipart `filename` parameter as
 * ISO-8859-1. When the client actually sent UTF-8 bytes, the result is
 * mojibake (each UTF-8 byte becomes a separate latin1 code point). Reinterpret
 * those bytes as UTF-8 when every char is ≤ U+00FF, at least one is high, and
 * the bytes form valid UTF-8. Already-correct Unicode (code points > U+00FF)
 * and genuine latin1 names that are not valid UTF-8 byte sequences are left
 * alone.
 */
export function decodeMultipartFilename(name: string): string {
  let hasHigh = false;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c > 0xff) return name;
    if (c >= 0x80) hasHigh = true;
  }
  if (!hasHigh) return name;

  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  if (decoded.includes('\uFFFD') || decoded === name) return name;
  return decoded;
}

/**
 * Normalize a client-supplied filename for storage / display.
 *
 * - Strips directory components (`../evil.png` → `evil.png`)
 * - Undoes multipart percent-encoding and Multer UTF-8/latin1 mojibake
 * - Removes ASCII control characters and DEL
 * - Truncates to `maxLen` UTF-16 code units without splitting graphemes,
 *   preferring to keep the file extension
 * - Falls back to `"attachment"` when nothing usable remains
 */
export function sanitizeAttachmentFilename(
  raw: string,
  maxLen: number = MAX_ATTACHMENT_FILENAME_LENGTH,
): string {
  const budget = Number.isFinite(maxLen) && maxLen > 0 ? Math.floor(maxLen) : MAX_ATTACHMENT_FILENAME_LENGTH;
  // Decode before basename so encoded separators (%2F / %5C) cannot re-introduce
  // path components after a pre-decode basenameOnly pass.
  let name = String(raw ?? '');
  name = maybePercentDecode(name);
  name = decodeMultipartFilename(name);
  name = basenameOnly(name);
  name = name.replace(CONTROL_OR_DEL, '').trim();

  if (!name || name === '.' || name === '..') {
    name = DEFAULT_BASENAME;
  }

  let result: string;
  if (name.length <= budget) {
    result = name;
  } else {
    const { stem, ext } = splitExtension(name);
    if (ext.length >= budget) {
      result = truncateToCodeUnits(name, budget) || DEFAULT_BASENAME;
    } else {
      const truncatedStem = truncateToCodeUnits(stem, budget - ext.length);
      result = `${truncatedStem || DEFAULT_BASENAME}${ext}`;
      if (result.length > budget) {
        result = truncateToCodeUnits(result, budget) || DEFAULT_BASENAME;
      }
    }
  }

  // Tiny maxLen can clip a leading-dot name to "." / ".." — never return those.
  if (!result || result === '.' || result === '..') {
    return DEFAULT_BASENAME;
  }
  return result;
}

/**
 * ASCII-only fallback for the legacy `filename=` parameter. Non-printable /
 * non-ASCII code points become `_` so older agents never see percent-encoded
 * UTF-8 (or raw Unicode) in the quoted-string slot.
 */
export function asciiFilenameFallback(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_');
  // Underscore-only stems with an ASCII extension are intentional RFC 6266
  // fallbacks (日本語.png → ___.png). Only collapse to DEFAULT when nothing
  // usable remains — e.g. extension-less CJK → "___" → "attachment".
  if (fallback.replace(/[_\s.]/g, '').length === 0) {
    const { ext } = splitExtension(fallback);
    if (ext && /^[\x20-\x7e]+$/.test(ext)) {
      return fallback;
    }
    return DEFAULT_BASENAME;
  }
  return fallback;
}

/** Percent-encode a value for RFC 5987 `filename*` (attr-char safe). */
function encodeRfc5987(value: string): string {
  // encodeURIComponent covers most of the work; re-encode the leftover chars
  // that are legal in URIs but not in RFC 5987 attr-char.
  return encodeURIComponent(value).replace(/['()*]/g, (ch) => {
    const hex = ch.charCodeAt(0).toString(16).toUpperCase();
    return `%${hex.padStart(2, '0')}`;
  });
}

function quoteDispositionFilename(value: string): string {
  return `"${value.replace(/([\\"])/g, '\\$1')}"`;
}

/**
 * Build a `Content-Disposition` header value.
 *
 * Always includes an ASCII-safe `filename="…"` fallback. When the (sanitized)
 * original name differs — typically because it contains non-ASCII — also emits
 * `filename*=UTF-8''…` so modern browsers restore the Unicode name.
 */
export function contentDispositionHeader(
  filename: string,
  type: 'inline' | 'attachment' = 'inline',
): string {
  const name = sanitizeAttachmentFilename(filename);
  const fallback = asciiFilenameFallback(name);
  let header = `${type}; filename=${quoteDispositionFilename(fallback)}`;
  if (name !== fallback) {
    header += `; filename*=UTF-8''${encodeRfc5987(name)}`;
  }
  return header;
}
