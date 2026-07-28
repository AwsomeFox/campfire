import { StorageDiagnosticsService, type StorageDiagnosticsProbe } from '../src/modules/health/storage-diagnostics.service';
import { MIGRATION_NAMES } from '../src/db/db.module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function holder(overrides: Record<string, unknown> = {}) {
  const raw = {
    prepare: jest.fn((sql: string) => ({
      get: jest.fn(() => sql.includes('busy_timeout') ? 5000 : undefined),
      all: jest.fn(() => []),
      pluck: jest.fn(function () { return this; }),
      run: jest.fn(),
    })),
    pragma: jest.fn(() => []),
    exec: jest.fn(),
    ...overrides,
  };
  return { raw } as never;
}

function probe(overrides: Partial<StorageDiagnosticsProbe> = {}): StorageDiagnosticsProbe {
  return {
    dataDir: () => '/diagnostic-test',
    statfs: () => ({ bfree: 10_000_000, bavail: 10_000_000, blocks: 20_000_000, bsize: 4096 } as ReturnType<typeof fs.statfsSync>),
    exists: () => false,
    stat: () => ({ isFile: () => true } as fs.Stats),
    readSentinel: () => ({ present: true, sentinel: { instanceId: 'instance-a', createdAt: '2026-01-01T00:00:00.000Z', sentinelVersion: 1 } }),
    ...overrides,
  };
}

describe('StorageDiagnosticsService (issue #724)', () => {
  it('fails quick check when a non-first SQLite row reports corruption', async () => {
    const db = holder({ pragma: jest.fn(() => [{ quick_check: 'ok' }, { quick_check: '*** in database main ***' }]) });
    const service = new StorageDiagnosticsService(db);
    await expect(service.runIntegrity('quick')).resolves.toMatchObject({ status: 'failed', code: 'QUICK_CHECK_FAILED' });
  });

  it('fails quick check when SQLite returns no rows', async () => {
    const service = new StorageDiagnosticsService(holder({ pragma: jest.fn(() => []) }));
    await expect(service.runIntegrity('quick')).resolves.toMatchObject({ status: 'failed', code: 'QUICK_CHECK_FAILED' });
  });

  it('uses a rollback-only singleton write probe and restores busy timeout after ENOSPC/EROFS/lock failures', () => {
    for (const code of ['SQLITE_FULL', 'SQLITE_READONLY', 'SQLITE_BUSY', 'SQLITE_LOCKED']) {
      const raw = (holder() as unknown as { raw: { exec: jest.Mock; pragma: jest.Mock } }).raw;
      raw.exec.mockImplementation((sql: string) => { if (sql.startsWith('BEGIN')) throw Object.assign(new Error(code), { code }); });
      const service = new StorageDiagnosticsService({ raw } as never);
      const result = (service as unknown as { writeCheck(): { code: string; status: string } }).writeCheck();
      expect(result.status).toBe('failed');
      expect(result.code).toMatch(/WRITE_(ENOSPC|EROFS|LOCKED)/);
      expect(raw.exec).toHaveBeenCalledWith('ROLLBACK');
      expect(raw.pragma).toHaveBeenLastCalledWith('busy_timeout = 5000');
    }
  });

  it('does not turn a metrics read into a storage scan before an intentional snapshot exists', () => {
    const service = new StorageDiagnosticsService(holder());
    expect(service.cachedSnapshot().checks.cache.code).toBe('DIAGNOSTICS_NOT_SCANNED');
  });

  it('reports statfs failure as unknown and a large WAL as degraded', () => {
    const service = new StorageDiagnosticsService(holder());
    const statfs = jest.spyOn(fs, 'statfsSync').mockImplementation(() => { throw new Error('EIO'); });
    expect((service as unknown as { diskCheck(): { status: string; code: string } }).diskCheck()).toMatchObject({ status: 'unknown', code: 'DISK_SPACE_UNKNOWN' });
    statfs.mockRestore();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-health-'));
    const previous = process.env.DATA_DIR; process.env.DATA_DIR = dir;
    fs.closeSync(fs.openSync(path.join(dir, 'campfire.db-wal'), 'w')); fs.truncateSync(path.join(dir, 'campfire.db-wal'), 513 * 1024 * 1024);
    expect((service as unknown as { walCheck(): { status: string; code: string } }).walCheck()).toMatchObject({ status: 'degraded', code: 'WAL_LARGE' });
    if (previous === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('treats missing uploads as safe only with no committed attachment rows', () => {
    const db = holder({ prepare: jest.fn((sql: string) => ({ get: jest.fn(), all: jest.fn(), pluck: jest.fn(function () { return this; }), run: jest.fn(), ...(sql.includes('count(*)') ? { get: jest.fn(() => 1) } : {}) })) });
    const service = new StorageDiagnosticsService(db);
    const previous = process.env.DATA_DIR; process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-health-'));
    expect((service as unknown as { uploadsCheck(): { code: string } }).uploadsCheck().code).toBe('UPLOADS_MISSING');
    fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
    if (previous === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previous;
  });

  it('uses injectable statfs, write, and sentinel probes for deterministic host-failure coverage', () => {
    const raw = (holder() as unknown as { raw: { prepare: jest.Mock } }).raw;
    raw.prepare.mockImplementation((sql: string) => ({
      get: jest.fn(() => sql.includes('server_meta') ? 'instance-b' : undefined), all: jest.fn(() => []), pluck: jest.fn(function () { return this; }), run: jest.fn(),
    }));
    const service = new StorageDiagnosticsService({ raw } as never, probe({
      statfs: () => { throw new Error('unsupported'); },
      writeProbe: () => { throw Object.assign(new Error('full'), { code: 'SQLITE_FULL' }); },
      readSentinel: () => ({ present: true, sentinel: undefined }),
    }));
    expect((service as unknown as { diskCheck(): { code: string } }).diskCheck().code).toBe('DISK_SPACE_UNKNOWN');
    expect((service as unknown as { writeCheck(): { code: string } }).writeCheck().code).toBe('WRITE_ENOSPC');
    expect((service as unknown as { identityCheck(): { code: string } }).identityCheck().code).toBe('STORAGE_IDENTITY_INVALID');
  });

  it('distinguishes missing uploads without committed rows from a failed committed-upload store', () => {
    const noRows = new StorageDiagnosticsService(holder(), probe());
    expect((noRows as unknown as { uploadsCheck(): { code: string } }).uploadsCheck().code).toBe('UPLOADS_EMPTY');
  });

  it('fails missing uploads when a committed attachment row exists', () => {
    const raw = (holder() as unknown as { raw: { prepare: jest.Mock } }).raw;
    raw.prepare.mockImplementation((sql: string) => ({
      get: jest.fn(() => sql.includes('count(*)') ? 1 : undefined), all: jest.fn(() => []), pluck: jest.fn(function () { return this; }), run: jest.fn(),
    }));
    const service = new StorageDiagnosticsService({ raw } as never, probe());
    expect((service as unknown as { uploadsCheck(): { code: string } }).uploadsCheck().code).toBe('UPLOADS_MISSING');
  });

  it('fails closed for missing or malformed install sentinels', () => {
    const raw = (holder() as unknown as { raw: { prepare: jest.Mock } }).raw;
    raw.prepare.mockImplementation((sql: string) => ({
      get: jest.fn(() => sql.includes('server_meta') ? 'instance-a' : undefined), all: jest.fn(() => []), pluck: jest.fn(function () { return this; }), run: jest.fn(),
    }));
    for (const readSentinel of [
      () => ({ present: false, sentinel: undefined }),
      () => ({ present: true, sentinel: undefined }),
    ]) {
      const service = new StorageDiagnosticsService({ raw } as never, probe({ readSentinel }));
      expect((service as unknown as { identityCheck(): { code: string } }).identityCheck().code).toBe('STORAGE_IDENTITY_INVALID');
    }
  });

  it('accepts a valid physical-install sentinel even when server_meta has a distinct logical UUID', () => {
    const raw = (holder() as unknown as { raw: { prepare: jest.Mock } }).raw;
    raw.prepare.mockImplementation((sql: string) => ({
      // This query must not be reached by identityCheck; the logical DB/cache
      // identity is deliberately unrelated to the physical data mount UUID.
      get: jest.fn(() => sql.includes('server_meta') ? 'logical-db-uuid' : undefined), all: jest.fn(() => []), pluck: jest.fn(function () { return this; }), run: jest.fn(),
    }));
    const service = new StorageDiagnosticsService({ raw } as never, probe());
    expect((service as unknown as { identityCheck(): { code: string } }).identityCheck().code).toBe('STORAGE_IDENTITY_OK');
    expect(raw.prepare).not.toHaveBeenCalledWith(expect.stringContaining('server_meta'));
  });

  it('fails identity validation when the expected DB path is not a regular file', () => {
    const service = new StorageDiagnosticsService(holder(), probe({ stat: () => ({ isFile: () => false } as fs.Stats) }));
    expect((service as unknown as { identityCheck(): { code: string } }).identityCheck().code).toBe('STORAGE_IDENTITY_INVALID');
  });

  it('detects a missing latest migration and missing or empty app-version metadata', () => {
    const schemaService = (migrations: string[], version: unknown) => {
      const raw = (holder() as unknown as { raw: { prepare: jest.Mock } }).raw;
      raw.prepare.mockImplementation((sql: string) => ({
        get: jest.fn(() => sql.includes('sqlite_master') ? { name: 'present' } : undefined),
        all: jest.fn(() => sql.includes('SELECT name FROM __migrations') ? migrations.map((name) => ({ name })) : []),
        pluck: jest.fn(function () { return this; }),
        run: jest.fn(),
      }));
      // better-sqlite3's pluck().get() is what schemaCheck reads for version.
      raw.prepare.mockImplementation((sql: string) => ({
        get: jest.fn(() => sql.includes('sqlite_master') ? { name: 'present' } : undefined),
        all: jest.fn(() => sql.includes('SELECT name FROM __migrations') ? migrations.map((name) => ({ name })) : []),
        pluck: jest.fn(() => ({ get: jest.fn(() => version) })), run: jest.fn(),
      }));
      return new StorageDiagnosticsService({ raw } as never);
    };
    expect((schemaService(MIGRATION_NAMES.slice(0, -1), '0.14.1') as unknown as { schemaCheck(): { code: string } }).schemaCheck().code).toBe('MIGRATION_MISSING');
    expect((schemaService([...MIGRATION_NAMES], undefined) as unknown as { schemaCheck(): { code: string } }).schemaCheck().code).toBe('MIGRATION_METADATA_MISSING');
    expect((schemaService([...MIGRATION_NAMES], '') as unknown as { schemaCheck(): { code: string } }).schemaCheck().code).toBe('MIGRATION_METADATA_MISSING');
  });

  it('counts only Campfire-owned temporary directories', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-health-temp-'));
    const owned = path.join(tmp, 'campfire-upload-abc');
    const unrelated = path.join(tmp, 'unrelated-process');
    fs.mkdirSync(owned); fs.mkdirSync(unrelated);
    fs.writeFileSync(path.join(owned, 'payload'), 'owned'); fs.writeFileSync(path.join(unrelated, 'payload'), 'unrelated-content');
    const tempDir = jest.spyOn(os, 'tmpdir').mockReturnValue(tmp);
    try {
      const service = new StorageDiagnosticsService(holder());
      expect((service as unknown as { ownedTempBytes(): number }).ownedTempBytes()).toBe(5);
    } finally {
      tempDir.mockRestore(); fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
