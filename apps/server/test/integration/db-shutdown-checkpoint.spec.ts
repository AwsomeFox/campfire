import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DbHolder, dbFilePath } from '../../src/db/db.module';
import { makeTempDataDir } from './fixtures';

/**
 * The restore trap (issue #164): the DB is opened in WAL mode and, before the
 * fix, its handle was never closed — so on a small install the freshly written
 * data sat in the uncheckpointed `-wal` sidecar and `cp campfire.db` alone
 * yielded a blank "no such table: users" database.
 *
 * DbHolder now implements OnApplicationShutdown (wal_checkpoint(TRUNCATE) +
 * close), which NestJS fires on SIGTERM/SIGINT because main.ts calls
 * app.enableShutdownHooks(). These specs drive that hook directly against a real
 * better-sqlite3 file and prove that a plain copy of campfire.db — WITHOUT the
 * -wal/-shm sidecars — restores cleanly afterward.
 *
 * No Nest bootstrap: pure storage-layer, so it lives beside the fast integration
 * specs rather than the HTTP e2e suites (same rationale as db-migrations.spec).
 */
describe('db shutdown checkpoint (real SQLite, WAL restore trap)', () => {
  let dataDir: string;
  let copyDir: string;
  let prevDataDir: string | undefined;

  beforeEach(() => {
    prevDataDir = process.env.DATA_DIR;
    dataDir = makeTempDataDir();
    copyDir = makeTempDataDir();
    // DbHolder resolves its file from DATA_DIR (resolveDataDir).
    process.env.DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (prevDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prevDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(copyDir, { recursive: true, force: true });
  });

  /** Insert a row so there is user data that must survive a bare-file copy. */
  function seedUser(holder: DbHolder): void {
    holder.raw
      .prepare(
        "INSERT INTO users (username, display_name, server_role, created_at, updated_at) VALUES (?, ?, 'admin', ?, ?)",
      )
      .run('restore-trap-dm', 'Restore Trap DM', '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z');
  }

  it('folds the WAL into campfire.db on shutdown so a bare file copy restores cleanly', () => {
    const holder = new DbHolder();
    seedUser(holder);

    const walPath = dbFilePath(dataDir) + '-wal';
    // Before shutdown the write lives in the WAL (this is the whole trap): the
    // sidecar is non-trivial while the main file is still a near-empty stub.
    expect(fs.existsSync(walPath)).toBe(true);
    expect(fs.statSync(walPath).size).toBeGreaterThan(0);

    holder.onApplicationShutdown();

    // TRUNCATE checkpoint resets the WAL back to zero bytes (0 if the file is
    // kept, or removed entirely) — proving the fold happened, not just a close.
    if (fs.existsSync(walPath)) {
      expect(fs.statSync(walPath).size).toBe(0);
    }

    // Copy ONLY campfire.db — no -wal, no -shm — exactly the failing `cp` drill.
    const copied = path.join(copyDir, 'campfire.db');
    fs.copyFileSync(dbFilePath(dataDir), copied);

    const probe = new Database(copied, { readonly: true, fileMustExist: true });
    try {
      const row = probe
        .prepare('SELECT username, server_role FROM users WHERE username = ?')
        .get('restore-trap-dm') as { username: string; server_role: string } | undefined;
      expect(row).toEqual({ username: 'restore-trap-dm', server_role: 'admin' });
    } finally {
      probe.close();
    }
  });

  it('closes the live handle on shutdown (checkpoint on a copied stub would otherwise re-strand data)', () => {
    const holder = new DbHolder();
    seedUser(holder);

    holder.onApplicationShutdown();

    expect(holder.raw.open).toBe(false);
  });

  it('is idempotent — a second shutdown call is a no-op and does not throw', () => {
    const holder = new DbHolder();
    seedUser(holder);

    holder.onApplicationShutdown();
    expect(() => holder.onApplicationShutdown()).not.toThrow();
    expect(holder.raw.open).toBe(false);
  });
});
