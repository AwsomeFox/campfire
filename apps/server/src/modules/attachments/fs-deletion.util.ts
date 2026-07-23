import type { RmOptions } from 'node:fs';

export type FsRmSync = (target: string, options?: RmOptions) => void;
export type FsExistsSync = (target: string) => boolean;

export function errnoCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) {
    return String((err as NodeJS.ErrnoException).code);
  }
  return '';
}

export function errnoMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export type VerifiedRemoveResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

/**
 * Remove a path and verify it no longer exists. Missing targets (ENOENT) count as success.
 * Used by permanent deletion so we never claim erasure while bytes remain (issue #727).
 */
export function removePathVerified(
  target: string,
  opts: { recursive?: boolean; rmSync: FsRmSync; existsSync: FsExistsSync },
): VerifiedRemoveResult {
  const { recursive = false, rmSync, existsSync } = opts;
  if (!existsSync(target)) {
    return { ok: true };
  }
  try {
    rmSync(target, { force: true, recursive });
  } catch (err) {
    const code = errnoCode(err);
    if (code === 'ENOENT') {
      return { ok: true };
    }
    return { ok: false, code: code || 'ERR', message: errnoMessage(err) };
  }
  if (existsSync(target)) {
    return { ok: false, code: 'EEXIST', message: 'Path still present after removal' };
  }
  return { ok: true };
}

/** Visible failure in admin UI after this many consecutive failed attempts. */
export const FS_DELETION_FAILED_ATTEMPTS = 3;

export const FS_DELETION_RETRY_INTERVAL_MS = 15 * 60 * 1000;
