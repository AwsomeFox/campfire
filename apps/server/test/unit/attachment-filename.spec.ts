import {
  MAX_ATTACHMENT_FILENAME_LENGTH,
  asciiFilenameFallback,
  contentDispositionHeader,
  decodeMultipartFilename,
  sanitizeAttachmentFilename,
} from '../../src/modules/attachments/filename';

/**
 * Unit tests for attachment filename sanitization + Content-Disposition
 * encoding (issue #630). Pure helpers — no Nest bootstrap.
 */
describe('sanitizeAttachmentFilename (issue #630)', () => {
  it('keeps a simple ASCII name', () => {
    expect(sanitizeAttachmentFilename('me.png')).toBe('me.png');
  });

  it('strips directory components from POSIX and Windows paths', () => {
    expect(sanitizeAttachmentFilename('../../etc/passwd.png')).toBe('passwd.png');
    expect(sanitizeAttachmentFilename('C:\\Users\\x\\evil.png')).toBe('evil.png');
  });

  it('applies basename after percent-decoding so %2F/%5C cannot reintroduce paths', () => {
    expect(sanitizeAttachmentFilename('../x%2Fy.png')).toBe('y.png');
    expect(sanitizeAttachmentFilename('dir%5Cnested%5Cfile.png')).toBe('file.png');
    expect(sanitizeAttachmentFilename('foo%2Fbar%5Cbaz.png')).toBe('baz.png');
  });

  it('removes ASCII control characters', () => {
    expect(sanitizeAttachmentFilename('hello\nworld.png')).toBe('helloworld.png');
    expect(sanitizeAttachmentFilename('a\u0000b\u007fc.png')).toBe('abc.png');
  });

  it('falls back when the name is empty after scrubbing', () => {
    expect(sanitizeAttachmentFilename('')).toBe('attachment');
    expect(sanitizeAttachmentFilename('../..')).toBe('attachment');
    expect(sanitizeAttachmentFilename('\n\t')).toBe('attachment');
  });

  it('never returns "", ".", or ".." even for tiny maxLen', () => {
    expect(sanitizeAttachmentFilename('.bashrc', 1)).toBe('attachment');
    expect(sanitizeAttachmentFilename('..hidden', 2)).toBe('attachment');
    expect(sanitizeAttachmentFilename('x', 1)).toBe('x');
  });

  it('preserves Unicode (including emoji) under the length budget', () => {
    expect(sanitizeAttachmentFilename('файл.png')).toBe('файл.png');
    expect(sanitizeAttachmentFilename('日本語テスト.png')).toBe('日本語テスト.png');
    expect(sanitizeAttachmentFilename('map🎉.png')).toBe('map🎉.png');
  });

  it('undoes Multer UTF-8/latin1 mojibake so Cyrillic/CJK survive upload', () => {
    const cyrillicMojibake = Buffer.from('файл.png', 'utf8').toString('latin1');
    expect(sanitizeAttachmentFilename(cyrillicMojibake)).toBe('файл.png');
    const cjkMojibake = Buffer.from('地図🎉.png', 'utf8').toString('latin1');
    expect(sanitizeAttachmentFilename(cjkMojibake)).toBe('地図🎉.png');
  });

  it('decodes percent-encoded quotes from multipart clients', () => {
    expect(sanitizeAttachmentFilename('photo %22quote%22.png')).toBe('photo "quote".png');
  });

  it('does not split a trailing surrogate pair when truncating', () => {
    // One emoji is 2 UTF-16 code units. Budget of 3 would leave a lone high
    // surrogate if we used bare String#slice(0, 3) on "aa" + emoji.
    const emoji = '🎉'; // U+1F389
    const name = `aa${emoji}.png`;
    const out = sanitizeAttachmentFilename(name, 6); // "aa" (2) + emoji (2) + room? ext=".png"(4)
    // With maxLen 6 and ext ".png" (4), stem budget is 2 → "aa.png"
    expect(out).toBe('aa.png');
    expect(() => [...out]).not.toThrow();
    // No lone surrogates.
    expect(out).toBe(Buffer.from(out, 'utf8').toString('utf8'));
  });

  it('preserves the extension when truncating a long stem', () => {
    const stem = 'あ'.repeat(200);
    const name = `${stem}.webp`;
    const out = sanitizeAttachmentFilename(name, 20);
    expect(out.endsWith('.webp')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(20);
    // Each あ is 1 code unit; stem budget = 20 - 5 = 15.
    expect(out).toBe(`${'あ'.repeat(15)}.webp`);
  });

  it('respects the schema max length (255 code units)', () => {
    const name = `${'x'.repeat(300)}.png`;
    const out = sanitizeAttachmentFilename(name);
    expect(out.length).toBe(MAX_ATTACHMENT_FILENAME_LENGTH);
    expect(out.endsWith('.png')).toBe(true);
  });
});

describe('contentDispositionHeader (issue #630)', () => {
  it('emits a plain quoted filename for ASCII names', () => {
    expect(contentDispositionHeader('me.png')).toBe('inline; filename="me.png"');
  });

  it('escapes quotes in the legacy filename parameter', () => {
    // Backslashes are path separators and are stripped by sanitize (basename);
    // quotes are the residual character that must be quoted-pair escaped.
    expect(contentDispositionHeader('photo "quote".png')).toBe(
      'inline; filename="photo \\"quote\\".png"',
    );
  });

  it('keeps commas inside the quoted filename (no filename* needed)', () => {
    expect(contentDispositionHeader('a,b.png')).toBe('inline; filename="a,b.png"');
  });

  it('adds RFC 5987 filename* for non-ASCII names with an ASCII fallback', () => {
    const header = contentDispositionHeader('файл.png');
    expect(header).toBe(
      "inline; filename=\"____.png\"; filename*=UTF-8''%D1%84%D0%B0%D0%B9%D0%BB.png",
    );
    // Must NOT percent-encode into the legacy filename= slot.
    expect(header).not.toMatch(/filename="%/);
  });

  it('encodes CJK and emoji in filename*', () => {
    const cjk = contentDispositionHeader('日本語テスト.png');
    expect(cjk).toContain('filename="______.png"');
    expect(cjk).toContain(
      "filename*=UTF-8''" + encodeURIComponent('日本語テスト.png'),
    );

    const emoji = contentDispositionHeader('map🎉.png');
    expect(emoji).toBe(
      `inline; filename="map__.png"; filename*=UTF-8''map${encodeURIComponent('🎉')}.png`,
    );
  });

  it('supports attachment disposition type', () => {
    expect(contentDispositionHeader('me.png', 'attachment')).toBe(
      'attachment; filename="me.png"',
    );
  });

  it('scrubs path/control characters before emitting the header', () => {
    expect(contentDispositionHeader('../x\ny.png')).toBe('inline; filename="xy.png"');
  });
});

describe('decodeMultipartFilename', () => {
  it('leaves ASCII and already-correct Unicode alone', () => {
    expect(decodeMultipartFilename('me.png')).toBe('me.png');
    expect(decodeMultipartFilename('файл.png')).toBe('файл.png');
  });

  it('reinterprets latin1-mojibake UTF-8 bytes', () => {
    const mojibake = Buffer.from('файл.png', 'utf8').toString('latin1');
    expect(decodeMultipartFilename(mojibake)).toBe('файл.png');
  });

  it('does not reinterpret genuine latin1 that is not valid UTF-8', () => {
    // Single 0xE9 byte is valid latin1 (é) but not a valid UTF-8 sequence.
    const latin1 = 'caf\u00e9.png';
    expect(decodeMultipartFilename(latin1)).toBe(latin1);
  });
});

describe('asciiFilenameFallback', () => {
  it('passes printable ASCII through', () => {
    expect(asciiFilenameFallback('Hello World.png')).toBe('Hello World.png');
  });

  it('maps Unicode-only stems to underscore fallbacks (not DEFAULT+ext)', () => {
    // Extension-less CJK collapses to underscores only → default basename.
    expect(asciiFilenameFallback('日本語')).toBe('attachment');
    // Unicode stem + ASCII ext → underscore stem kept (RFC 6266 intent).
    expect(asciiFilenameFallback('日本語.png')).toBe('___.png');
    expect(asciiFilenameFallback('файл.png')).toBe('____.png');
    expect(asciiFilenameFallback('地図🎉.webp')).toBe('____.webp');
  });
});
