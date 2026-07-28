import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { DataRepairService } from '../src/modules/data-repair/data-repair.service';
import { DataRepairController } from '../src/modules/data-repair/data-repair.controller';

/** Focused real-SQLite coverage for the dangerous #729 repair boundary. */
describe('Issue #729 data repair safety', () => {
  let dir: string;
  let db: Database.Database;
  let service: DataRepairService;
  const audit = { log: jest.fn().mockResolvedValue(undefined) };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-repair-'));
    process.env.DATA_DIR = dir;
    db = new Database(path.join(dir, 'campfire.db'));
    db.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE campaigns (id INTEGER PRIMARY KEY, current_location_id INTEGER, map_attachment_id INTEGER, active_encounter_id INTEGER);
      CREATE TABLE locations (id INTEGER PRIMARY KEY, campaign_id INTEGER NOT NULL, parent_id INTEGER);
      CREATE TABLE encounters (id INTEGER PRIMARY KEY, campaign_id INTEGER NOT NULL, location_id INTEGER, quest_id INTEGER, session_id INTEGER);
      CREATE TABLE strict_parent (id INTEGER PRIMARY KEY);
      CREATE TABLE strict_child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES strict_parent(id));
      CREATE TABLE data_repair_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT, strict_count INTEGER NOT NULL DEFAULT 0, soft_count INTEGER NOT NULL DEFAULT 0, error_detail TEXT NOT NULL DEFAULT '');
      CREATE TABLE data_repair_findings (id INTEGER PRIMARY KEY AUTOINCREMENT, fingerprint TEXT NOT NULL UNIQUE, reference_type TEXT NOT NULL, child_table TEXT NOT NULL, child_row_id INTEGER NOT NULL, child_column TEXT NOT NULL, parent_table TEXT NOT NULL, parent_column TEXT NOT NULL, reference_value TEXT NOT NULL, campaign_id INTEGER, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, last_run_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open', resolution_action TEXT, resolved_at TEXT, version INTEGER NOT NULL DEFAULT 1, detail TEXT NOT NULL DEFAULT '');
      CREATE TABLE data_repair_actions (id INTEGER PRIMARY KEY AUTOINCREMENT, finding_id INTEGER NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL, before_value TEXT, after_value TEXT, backup_checksum TEXT, backup_path TEXT, undo_payload TEXT, status TEXT NOT NULL DEFAULT 'applied', created_at TEXT NOT NULL, undone_at TEXT);
      CREATE TABLE data_repair_quarantine (id INTEGER PRIMARY KEY AUTOINCREMENT, action_id INTEGER NOT NULL, child_table TEXT NOT NULL, child_row_id INTEGER NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE data_repair_previews (token TEXT PRIMARY KEY, finding_id INTEGER NOT NULL, finding_version INTEGER NOT NULL, action TEXT NOT NULL, replacement_parent_id INTEGER, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, used_at TEXT);
    `);
    service = new DataRepairService({ raw: db } as any, audit as any);
  });
  afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('persists/dedupes/resolves strict plus missing/cross-campaign soft findings and enforces previewed repair/undo', async () => {
    db.pragma('foreign_keys=OFF');
    db.prepare('INSERT INTO strict_child(id,parent_id) VALUES (1,999)').run();
    db.pragma('foreign_keys=ON');
    db.prepare('INSERT INTO campaigns(id) VALUES (1),(2)').run();
    db.prepare('INSERT INTO locations(id,campaign_id) VALUES (20,2)').run();
    db.prepare('INSERT INTO encounters(id,campaign_id,location_id) VALUES (10,1,777),(11,1,20)').run();
    await service.scan('admin', 'actual-admin', 'admin');
    expect(service.latest().openCount).toBe(3);
    await service.scan();
    expect(service.latest().openCount).toBe(3);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'data-repair.scan' }));
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ actor: 'actual-admin' }));

    const missing = (service.findings('open') as any[]).find(f => f.child_row_id === 10)!;
    const before = db.prepare('SELECT location_id FROM encounters WHERE id=10').get() as any;
    const preview = service.preview({ findingId: missing.id, action: 'null', expectedVersion: missing.version });
    expect(db.prepare('SELECT location_id FROM encounters WHERE id=10').get()).toEqual(before);
    await expect(service.apply({ findingId: missing.id, action: 'null', expectedVersion: missing.version, previewToken: 'missing' }, 'admin', 'admin')).rejects.toBeInstanceOf(ConflictException);
    db.prepare('UPDATE data_repair_previews SET expires_at=? WHERE token=?').run('2000-01-01T00:00:00.000Z', preview.previewToken);
    await expect(service.apply({ findingId: missing.id, action: 'null', expectedVersion: missing.version, previewToken: preview.previewToken }, 'admin', 'admin')).rejects.toBeInstanceOf(ConflictException);
    const freshPreview = service.preview({ findingId: missing.id, action: 'null', expectedVersion: missing.version });
    const applied = await service.apply({ findingId: missing.id, action: 'null', expectedVersion: missing.version, previewToken: freshPreview.previewToken }, 'admin', 'admin');
    expect(db.prepare('SELECT location_id FROM encounters WHERE id=10').get()).toEqual({ location_id: null });
    const action = db.prepare('SELECT * FROM data_repair_actions WHERE id=?').get(applied.actionId) as any;
    expect(fs.existsSync(action.backup_path)).toBe(true);
    expect(fs.statSync(action.backup_path).mode & 0o777).toBe(0o600);
    expect(action.backup_checksum).toMatch(/^[a-f0-9]{64}$/);
    await expect(service.apply({ findingId: missing.id, action: 'null', expectedVersion: missing.version, previewToken: freshPreview.previewToken }, 'admin', 'admin')).rejects.toBeInstanceOf(ConflictException);
    // Undo refuses to recreate the known-bad reference until a valid same-campaign
    // parent exists; this is why it cannot be a blind inverse operation.
    await expect(service.undo(applied.actionId, 'admin', 'admin')).rejects.toBeInstanceOf(ConflictException);
    db.prepare('INSERT INTO locations(id,campaign_id) VALUES (777,1)').run();
    await service.undo(applied.actionId, 'admin', 'admin');
    expect(db.prepare('SELECT location_id FROM encounters WHERE id=10').get()).toEqual({ location_id: 777 });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'data-repair.undo' }));
    expect(JSON.stringify(service.bundle())).not.toContain('777');
    expect(JSON.stringify(service.bundle())).not.toContain(action.backup_path);

    const cross = (service.findings('open') as any[]).find(f => f.child_row_id === 11)!;
    expect(() => service.preview({ findingId: cross.id, action: 'relink', replacementParentId: 20, expectedVersion: cross.version })).toThrow(BadRequestException);

    db.prepare('UPDATE encounters SET location_id=20 WHERE id=10').run();
    await service.scan();
    expect((service.findings('open') as any[]).some(f => f.child_row_id === 10 && f.reference_value === '777')).toBe(false);
  });

  it('marks the downloadable admin bundle no-store', () => {
    const response = { setHeader: jest.fn(), type: jest.fn().mockReturnThis(), attachment: jest.fn().mockReturnThis(), send: jest.fn() };
    new DataRepairController({ bundle: () => ({ ok: true }) } as any).supportBundle(response as any);
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
  });
});
