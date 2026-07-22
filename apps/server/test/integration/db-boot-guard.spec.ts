import fs from 'node:fs';
import Database from 'better-sqlite3';
import {
  assertDataMount,
  DataMountGuardError,
  dbFilePath,
  openDatabase,
  sentinelFilePath,
  SENTINEL_FILENAME,
  ALLOW_FRESH_DB_ENV,
  type InstallSentinel,
} from '../../src/db/db.module';
import { makeTempDataDir } from './fixtures';

/**
 * Boot guard coverage for DATA_DIR mount safety (issue #721).
 *
 * The guard sits between mkdir(DATA_DIR) and `new Database(campfire.db)` in
 * openDatabase, so it is the single arbiter of "fresh install vs broken mount".
 * These specs exercise the four policy branches against a real filesystem (no
 * mocks — the whole point is that fs.existsSync / atomic rename behave like
 * production):
 *
 *   1. fresh install (no sentinel, no db)            → initialize + info log
 *   2. adopt existing DB on first contact            → initialize + loud WARN
 *      (covers the pre-#721 upgrade path AND the wrong-mount signal)
 *   3. normal restart (sentinel + db)                → quiet, sentinel stable
 *   4. data loss (sentinel present, db missing)      → REFUSE to boot
 *      unless CAMPFIRE_ALLOW_FRESH_DB=1 (then WARN + proceed)
 *
 * Plus the end-to-end openDatabase() integration: the guard runs in the real
 * boot path, a sentinel survives a second open, and the regression scenario
 * from the issue (DB disappears after init) is reproduced as a failing path
 * before the escape hatch flips it to a warning.
 *
 * No Nest bootstrap — pure storage-layer, sibling to db-migrations.spec.
 */
describe('db boot guard — DATA_DIR mount safety (issue #721)', () => {
  let dataDir: string;
  let prevAllowFresh: string | undefined;

  beforeEach(() => {
    dataDir = makeTempDataDir();
    prevAllowFresh = process.env[ALLOW_FRESH_DB_ENV];
    delete process.env[ALLOW_FRESH_DB_ENV];
  });

  afterEach(() => {
    if (prevAllowFresh === undefined) delete process.env[ALLOW_FRESH_DB_ENV];
    else process.env[ALLOW_FRESH_DB_ENV] = prevAllowFresh;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  /** Write an empty placeholder campfire.db so existsSync(dbFile) is true. */
  function touchDb(): void {
    const db = new Database(dbFilePath(dataDir));
    db.close();
  }

  /** Read the sentinel back off disk as the guard would. */
  function readSentinel(): InstallSentinel | undefined {
    const file = sentinelFilePath(dataDir);
    if (!fs.existsSync(file)) return undefined;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as InstallSentinel;
  }

  // ── fresh install ───────────────────────────────────────────────────────────

  it('initializes the install sentinel on a genuine first run (no DB, no sentinel)', () => {
    const outcome = assertDataMount(dataDir, dbFilePath(dataDir));
    expect(outcome.kind).toBe('initialized');
    if (outcome.kind !== 'initialized') return;

    expect(outcome.adoptedExistingDb).toBe(false);
    expect(outcome.sentinel.instanceId).toMatch(/^[0-9a-f-]{36}$/i); // UUID
    expect(outcome.sentinel.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(outcome.sentinel.sentinelVersion).toBe(1);

    // Persisted beside the DB, atomic + readable.
    const onDisk = readSentinel();
    expect(onDisk).toEqual(outcome.sentinel);
    expect(fs.existsSync(sentinelFilePath(dataDir))).toBe(true);
  });

  it('places the sentinel beside campfire.db under DATA_DIR (not inside the DB)', () => {
    assertDataMount(dataDir, dbFilePath(dataDir));
    const expected = `${dataDir}/${SENTINEL_FILENAME}`;
    expect(sentinelFilePath(dataDir)).toBe(expected);
    // The sentinel is a standalone JSON file — an operator can cat it without SQLite.
    const raw = fs.readFileSync(expected, 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  // ── adopt existing DB on first contact (upgrade / wrong mount) ─────────────

  it('adopts an existing DB on first contact and flags it loudly (pre-#721 upgrade path)', () => {
    touchDb(); // pre-existing campfire.db, no sentinel — e.g. a pre-#721 volume.
    const outcome = assertDataMount(dataDir, dbFilePath(dataDir));
    expect(outcome.kind).toBe('initialized');
    if (outcome.kind !== 'initialized') return;

    // adoptedExistingDb is the signal the logger turns into a WARN (vs info for fresh).
    expect(outcome.adoptedExistingDb).toBe(true);
    expect(readSentinel()?.instanceId).toBe(outcome.sentinel.instanceId);
  });

  // ── normal restart: sentinel + DB both present ─────────────────────────────

  it('treats sentinel + DB present as a normal restart and keeps the instance id stable', () => {
    const first = assertDataMount(dataDir, dbFilePath(dataDir));
    touchDb(); // simulate a DB now existing alongside the just-written sentinel.

    const second = assertDataMount(dataDir, dbFilePath(dataDir));
    expect(second.kind).toBe('normal');
    if (second.kind !== 'normal') return;

    // Identity is preserved across the restart — no new instance id minted.
    expect(second.sentinel.instanceId).toBe(
      first.kind === 'initialized' ? first.sentinel.instanceId : undefined,
    );
    expect(readSentinel()?.instanceId).toBe(second.sentinel.instanceId);
  });

  // ── data loss: sentinel present, DB missing ────────────────────────────────

  it('REFUSES to boot when the sentinel is present but campfire.db is missing (data-loss guard)', () => {
    // Establish the install (sentinel + DB).
    assertDataMount(dataDir, dbFilePath(dataDir));
    touchDb();
    // A subsequent boot sees both — fine.
    expect(() => assertDataMount(dataDir, dbFilePath(dataDir))).not.toThrow();

    // Now the DB disappears (restore gone wrong, accidental delete, wrong remount).
    fs.rmSync(dbFilePath(dataDir), { force: true });

    // Regression-must-fail: before #721 this would silently create a fresh DB.
    expect(() => assertDataMount(dataDir, dbFilePath(dataDir))).toThrow(DataMountGuardError);
    try {
      assertDataMount(dataDir, dbFilePath(dataDir));
    } catch (err) {
      expect(err).toBeInstanceOf(DataMountGuardError);
      const guardErr = err as DataMountGuardError;
      expect(guardErr.details.dbExists).toBe(false);
      expect(guardErr.details.sentinelExists).toBe(true);
      expect(guardErr.details.dataDir).toBe(dataDir);
      expect(guardErr.details.dbFile).toBe(dbFilePath(dataDir));
      // The message must name the escape hatch so an operator reading the log
      // knows exactly how to proceed.
      expect(guardErr.message).toContain(ALLOW_FRESH_DB_ENV);
    }
  });

  it('downgrades the data-loss refusal to a warning when CAMPFIRE_ALLOW_FRESH_DB=1', () => {
    assertDataMount(dataDir, dbFilePath(dataDir));
    touchDb();
    fs.rmSync(dbFilePath(dataDir), { force: true });

    process.env[ALLOW_FRESH_DB_ENV] = '1';
    // With the escape hatch set the guard must NOT throw — openDatabase will
    // then create a fresh empty DB and first-run setup will run.
    expect(() => assertDataMount(dataDir, dbFilePath(dataDir))).not.toThrow();
    const outcome = assertDataMount(dataDir, dbFilePath(dataDir));
    expect(outcome.kind).toBe('normal'); // not "initialized" — sentinel is NOT replaced.
    // The instance id is unchanged; a new one is NOT minted (that would mask the loss).
    expect(readSentinel()?.instanceId).toBe(outcome.kind === 'normal' ? outcome.sentinel.instanceId : undefined);
  });

  // ── corrupt sentinel ───────────────────────────────────────────────────────

  it('refuses to boot when the sentinel file is present but corrupt (do not guess identity)', () => {
    assertDataMount(dataDir, dbFilePath(dataDir));
    touchDb();
    // Corrupt the sentinel — readSentinel returns undefined, but the file exists,
    // so the guard cannot tell a fresh install from a damaged one. Treat as
    // unreadable and refuse rather than minting a new id over real data.
    fs.writeFileSync(sentinelFilePath(dataDir), '{ not valid json');
    expect(() => assertDataMount(dataDir, dbFilePath(dataDir))).toThrow(DataMountGuardError);
  });

  // ── end-to-end through openDatabase() ──────────────────────────────────────

  it('openDatabase initializes the sentinel on first run and keeps it stable on re-open', () => {
    const first = openDatabase(dataDir);
    first.sqlite.close();
    const sentinelAfterFirst = readSentinel();
    expect(sentinelAfterFirst).toBeDefined();
    expect(sentinelAfterFirst?.instanceId).toMatch(/^[0-9a-f-]{36}$/i);

    // A second open (e.g. a restore re-open via DbHolder) must NOT replace the id.
    const second = openDatabase(dataDir);
    second.sqlite.close();
    expect(readSentinel()?.instanceId).toBe(sentinelAfterFirst?.instanceId);
  });

  it('openDatabase REFUSES to silently create a fresh DB after the install loses campfire.db (regression)', () => {
    // Establish the install with real data.
    const seeded = openDatabase(dataDir);
    const now = '2026-07-21T00:00:00.000Z';
    seeded.sqlite
      .prepare("INSERT INTO users (username, display_name, server_role, created_at, updated_at) VALUES (?, ?, 'admin', ?, ?)")
      .run('boot-guard-dm', 'Boot Guard DM', now, now);
    seeded.sqlite.close();

    // The DB file vanishes (the issue scenario: wrong remount / restore mistake).
    fs.rmSync(dbFilePath(dataDir), { force: true });
    // Also remove the WAL/shm sidecars so the open doesn't find a stray handle.
    fs.rmSync(`${dbFilePath(dataDir)}-wal`, { force: true });
    fs.rmSync(`${dbFilePath(dataDir)}-shm`, { force: true });

    // Before #721: a silent fresh DB, healthy readyz, redirect to first-run.
    // After #721: the guard throws and boot aborts.
    expect(() => openDatabase(dataDir)).toThrow(DataMountGuardError);

    // The sentinel is still intact (the guard did not mint a new id over the loss).
    const sentinelAfterFailure = readSentinel();
    expect(sentinelAfterFailure?.instanceId).toBeDefined();

    // Operator acknowledges via the escape hatch — boot proceeds, fresh DB, SAME id.
    process.env[ALLOW_FRESH_DB_ENV] = '1';
    const recovered = openDatabase(dataDir);
    try {
      // Fresh DB: the previously-seeded user is gone, but the install identity is intact.
      const userCount = (
        recovered.sqlite.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }
      ).n;
      expect(userCount).toBe(0);
      expect(readSentinel()?.instanceId).toBe(sentinelAfterFailure?.instanceId);
    } finally {
      recovered.sqlite.close();
    }
  });
});
