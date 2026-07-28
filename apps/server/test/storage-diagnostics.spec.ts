import { StorageDiagnosticsService } from '../src/modules/health/storage-diagnostics.service';
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

describe('StorageDiagnosticsService (issue #724)', () => {
  it('fails quick check when a non-first SQLite row reports corruption', async () => {
    const db = holder({ pragma: jest.fn(() => [{ quick_check: 'ok' }, { quick_check: '*** in database main ***' }]) });
    const service = new StorageDiagnosticsService(db);
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
});
