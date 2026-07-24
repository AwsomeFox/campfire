import path from 'node:path';
import {
  uploadsAbsolutePath,
  uploadsRelativePath,
  uploadsRoot,
} from '../../src/modules/attachments/uploads-path';

describe('uploads-path (issue #727)', () => {
  it('uploadsRelativePath rejects the uploads root itself', () => {
    const root = uploadsRoot();
    expect(() => uploadsRelativePath(root)).toThrow(/outside uploads root|uploads root/i);
    expect(() => uploadsRelativePath(path.resolve(root))).toThrow();
  });

  it('uploadsRelativePath normalizes a file under uploads', () => {
    const root = uploadsRoot();
    const abs = path.join(root, 'campaigns', '1', 'file.png');
    expect(uploadsRelativePath(abs)).toBe('campaigns/1/file.png');
  });

  it('uploadsAbsolutePath rejects empty relative paths', () => {
    expect(() => uploadsAbsolutePath('')).toThrow(/must not be empty/i);
    expect(() => uploadsAbsolutePath('   ')).toThrow(/must not be empty/i);
  });

  it('uploadsAbsolutePath rejects the uploads root itself (e.g. ".")', () => {
    expect(() => uploadsAbsolutePath('.')).toThrow(/escapes uploads root/i);
    expect(() => uploadsAbsolutePath('..')).toThrow(/escapes uploads root/i);
  });

  it('uploadsAbsolutePath resolves a normalized relative key', () => {
    const abs = uploadsAbsolutePath('campaigns/42/x.webp');
    expect(abs).toBe(path.join(uploadsRoot(), 'campaigns', '42', 'x.webp'));
  });
});
