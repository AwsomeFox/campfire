import path from 'node:path';

/** DATA_DIR/uploads — canonical on-disk attachment root (issue #24). */
export function uploadsRoot(): string {
  const dataDir = process.env.DATA_DIR ?? path.resolve(__dirname, '..', '..', '..', 'data');
  return path.join(dataDir, 'uploads');
}

/** Normalize an absolute path under uploadsRoot to a stable relative key for the queue. */
export function uploadsRelativePath(absolutePath: string): string {
  const root = path.resolve(uploadsRoot());
  const resolved = path.resolve(absolutePath);
  const rel = path.relative(root, resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path ${absolutePath} is outside uploads root`);
  }
  return rel.split(path.sep).join('/');
}

export function uploadsAbsolutePath(relativePath: string): string {
  if (relativePath === '' || relativePath.trim() === '') {
    throw new Error('Relative path must not be empty (would target uploads root)');
  }
  const normalized = relativePath.replace(/\//g, path.sep);
  const abs = path.resolve(uploadsRoot(), normalized);
  const root = path.resolve(uploadsRoot());
  if (!abs.startsWith(root + path.sep) && abs !== root) {
    throw new Error(`Relative path escapes uploads root: ${relativePath}`);
  }
  return abs;
}
