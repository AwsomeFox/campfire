import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { BOOTSTRAP_SQL, CAMPAIGN_SEARCH_FTS_SQL } from '../src/db/bootstrap.sql';
import { DataRepairService } from '../src/modules/data-repair/data-repair.service';
import { DataRepairController } from '../src/modules/data-repair/data-repair.controller';
import request from 'supertest';
import { closeTestApp, createTestAppNoDevAuth, type TestAppContext } from './test-app';

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
      CREATE TABLE quests (id INTEGER PRIMARY KEY, campaign_id INTEGER NOT NULL, parent_id INTEGER, giver_npc_id INTEGER);
      CREATE TABLE inbound_strict (id INTEGER PRIMARY KEY, encounter_id INTEGER REFERENCES encounters(id));
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
    const staleValue = service.preview({ findingId: missing.id, action: 'null', expectedVersion: missing.version });
    db.prepare('UPDATE encounters SET location_id=778 WHERE id=10').run();
    await expect(service.apply({ findingId: missing.id, action: 'null', expectedVersion: missing.version, previewToken: staleValue.previewToken }, 'admin', 'admin')).rejects.toBeInstanceOf(ConflictException);
    expect(db.prepare('SELECT used_at FROM data_repair_previews WHERE token=?').get(staleValue.previewToken)).toEqual({ used_at:null });
    db.prepare('UPDATE encounters SET location_id=777 WHERE id=10').run();
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
    // Structural, not a substring match against the serialized blob (#2018). The bundle
    // carries roughly ten ISO timestamps, and `JSON.stringify(...).not.toContain('777')`
    // matched any of them whose milliseconds read `.777Z` — so it failed at random, on
    // branches that could not have caused it, while passing for the wrong reason the rest
    // of the time: the bundle has no location_id in it at all, so the assertion never
    // exercised the leak it names.
    //
    // What it means to say is that the bundle omits the two fields carrying sensitive
    // detail — the raw referenced value and the on-disk backup location — both of which
    // ARE present on the service's own findings()/actions rows.
    const bundle = service.bundle() as {
      findings: Array<Record<string, unknown>>;
      repairs: Array<Record<string, unknown>>;
    };
    // Without these two, the loops below pass vacuously on an empty bundle.
    expect(bundle.findings.length).toBeGreaterThan(0);
    expect(bundle.repairs.length).toBeGreaterThan(0);
    for (const finding of bundle.findings) expect(Object.keys(finding)).not.toContain('reference_value');
    for (const repair of bundle.repairs) expect(Object.keys(repair)).not.toContain('backup_path');
    // Value equality, not substring, so a leak under some OTHER key is still caught while a
    // timestamp that merely contains those digits is not: no string is equal to '777' by
    // accident the way one can contain it.
    const emitted = [...bundle.findings, ...bundle.repairs].flatMap((row) => Object.values(row));
    expect(emitted).not.toContain(777);
    expect(emitted).not.toContain('777');
    expect(emitted).not.toContain(action.backup_path);

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

  it('publicHealth stays bounded for readiness probes', () => {
    db.prepare("INSERT INTO data_repair_runs(source,started_at,completed_at,strict_count,soft_count) VALUES ('manual',?,?,1,0)").run('2026-01-01T00:00:00.000Z','2026-01-01T00:00:01.000Z');
    const prepare = jest.spyOn(db, 'prepare');
    expect(service.publicHealth()).toEqual({ degraded: false, openCount: 0, latestRunAt: '2026-01-01T00:00:01.000Z' });
    const sql = prepare.mock.calls.map(([query]) => String(query));
    expect(sql.some(query => query.includes('data_repair_actions'))).toBe(false);
    expect(sql.some(query => query.includes('LIMIT 20'))).toBe(false);
    prepare.mockRestore();
  });

  it('keeps the current snapshot under tied mtimes and safely tolerates cleanup failure', () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(123456);
    const snapshots = Array.from({ length: 14 }, () => (service as any).snapshot());
    const newest = snapshots.at(-1).file as string;
    expect(fs.existsSync(newest)).toBe(true);
    expect(fs.readdirSync(path.join(dir, 'repair-backups')).filter(name => name.endsWith('.db')).length).toBeLessThanOrEqual(12);
    const unlink = jest.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => { throw new Error('simulated cleanup failure'); });
    const next = (service as any).snapshot();
    expect(fs.existsSync(next.file)).toBe(true);
    // A failed unlink leaves a disposable file behind, never a dangling action path.
    for(const row of db.prepare('SELECT backup_path FROM data_repair_actions WHERE backup_path IS NOT NULL').all() as Array<{backup_path:string}>) expect(fs.existsSync(row.backup_path)).toBe(true);
    unlink.mockRestore(); clock.mockRestore();
  });

  it('quarantine checks real inbound rows, restores only safe full rows, and preserves applied backups', async () => {
    db.prepare('INSERT INTO campaigns(id) VALUES (1),(2)').run();
    db.prepare('INSERT INTO locations(id,campaign_id) VALUES (1,1),(2,2)').run();
    // The broken quest is the finding; location is independently valid so undo
    // can prove it checks *all* outbound references rather than just quest_id.
    db.prepare('INSERT INTO encounters(id,campaign_id,location_id,quest_id) VALUES (30,1,1,999)').run();
    db.prepare('INSERT INTO inbound_strict(id,encounter_id) VALUES (1,30)').run();
    await service.scan();
    const finding=(service.findings('open') as any[]).find(f=>f.child_row_id===30&&f.child_column==='quest_id');
    expect(() => service.preview({ findingId:finding.id,action:'quarantine',expectedVersion:finding.version })).toThrow(ConflictException);
    db.prepare('DELETE FROM inbound_strict').run();
    db.prepare('UPDATE campaigns SET active_encounter_id=30 WHERE id=1').run();
    expect(() => service.preview({ findingId:finding.id,action:'quarantine',expectedVersion:finding.version })).toThrow(ConflictException);
    db.prepare('UPDATE campaigns SET active_encounter_id=NULL WHERE id=1').run();
    const preview=service.preview({ findingId:finding.id,action:'quarantine',expectedVersion:finding.version });
    const applied=await service.apply({ findingId:finding.id,action:'quarantine',expectedVersion:finding.version,previewToken:preview.previewToken },'admin','admin');
    expect(db.prepare('SELECT count(*) n FROM encounters WHERE id=30').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) n FROM data_repair_quarantine WHERE action_id=?').get(applied.actionId)).toEqual({ n: 1 });
    expect(db.prepare('SELECT status FROM data_repair_findings WHERE id=?').get(finding.id)).toEqual({ status:'quarantined' });
    const appliedBackup=(db.prepare('SELECT backup_path FROM data_repair_actions WHERE id=?').get(applied.actionId) as any).backup_path;
    expect(fs.existsSync(appliedBackup)).toBe(true);
    // Retention is bounded for disposable snapshots but never deletes a path
    // still attached to an applied repair action.
    for(let i=0;i<15;i++) (service as any).snapshot();
    expect(fs.readdirSync(path.join(dir,'repair-backups')).filter(name=>name.endsWith('.db')).length).toBeLessThanOrEqual(12);
    for(const row of db.prepare('SELECT backup_path FROM data_repair_actions WHERE backup_path IS NOT NULL').all() as Array<{backup_path:string}>) expect(fs.existsSync(row.backup_path)).toBe(true);
    // The old action remains undoable even when retention cleared its path: undo
    // uses the persisted row payload/state, not a retained database snapshot.
    expect(fs.existsSync(appliedBackup)).toBe(false);
    // A different outbound soft reference becomes cross-campaign after quarantine.
    db.prepare('UPDATE locations SET campaign_id=2 WHERE id=1').run();
    await expect(service.undo(applied.actionId,'admin','admin')).rejects.toBeInstanceOf(ConflictException);
    db.prepare('UPDATE locations SET campaign_id=1 WHERE id=1').run();
    db.prepare('INSERT INTO quests(id,campaign_id) VALUES (999,1)').run();
    await service.undo(applied.actionId,'admin','admin');
    expect(db.prepare('SELECT count(*) n FROM encounters WHERE id=30').get()).toEqual({ n: 1 });
  });
});

describe('Issue #729 data repair bootstrap placement', () => {
  it('creates repair tables in always-run BOOTSTRAP_SQL, not FTS-only SQL', () => {
    expect(BOOTSTRAP_SQL).toContain('CREATE TABLE IF NOT EXISTS data_repair_runs');
    expect(BOOTSTRAP_SQL).toContain('CREATE TABLE IF NOT EXISTS data_repair_findings');
    expect(CAMPAIGN_SEARCH_FTS_SQL).not.toContain('data_repair_runs');
    expect(CAMPAIGN_SEARCH_FTS_SQL).not.toContain('data_repair_findings');
  });
});

describe('Issue #729 data repair HTTP authorization', () => {
  let ctx: TestAppContext;
  let admin: ReturnType<typeof request.agent>;
  let user: ReturnType<typeof request.agent>;
  beforeAll(async()=>{
    ctx=await createTestAppNoDevAuth(); const server=ctx.app.getHttpServer(); admin=request.agent(server);
    await admin.post('/api/v1/auth/setup').send({username:'repair-admin',password:'admin-password-1'});
    await admin.post('/api/v1/users').send({username:'repair-user',password:'user-password-1',serverRole:'user'});
    user=request.agent(server); await user.post('/api/v1/auth/login').send({username:'repair-user',password:'user-password-1'});
  });
  afterAll(async()=>closeTestApp(ctx));
  it('requires server admin and sends a no-store bundle', async()=>{
    const server=ctx.app.getHttpServer();
    expect((await request(server).get('/api/v1/admin/data-repair')).status).toBe(401);
    expect((await user.get('/api/v1/admin/data-repair')).status).toBe(403);
    expect((await admin.get('/api/v1/admin/data-repair')).status).toBe(200);
    expect((await admin.post('/api/v1/admin/data-repair/scan').send({})).status).toBe(201);
    const bundle=await admin.get('/api/v1/admin/data-repair/support-bundle');
    expect(bundle.status).toBe(200); expect(bundle.headers['cache-control']).toContain('no-store');
  });
});
