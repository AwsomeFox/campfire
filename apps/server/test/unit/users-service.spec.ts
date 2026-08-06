import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DbHolder, type DrizzleDb } from '../../src/db/db.module';
import { AuditService } from '../../src/modules/audit/audit.service';
import { UsersService } from '../../src/modules/users/users.service';
import type { RequestUser } from '../../src/common/user.types';

describe('UsersService unit tests', () => {
  let dataDir: string;
  let holder: DbHolder;
  let previousDataDir: string | undefined;
  let usersService: UsersService;
  let auditService: AuditService;

  const adminActor: RequestUser = {
    id: '1',
    name: 'Admin User',
    serverRole: 'admin',
  };

  beforeEach(() => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-users-unit-'));
    process.env.DATA_DIR = dataDir;
    holder = new DbHolder();
    const db = holder.proxy as DrizzleDb;
    auditService = new AuditService(db);
    usersService = new UsersService(db, auditService);
  });

  afterEach(() => {
    holder.onApplicationShutdown();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('lists and counts users', async () => {
    expect(await usersService.count()).toBe(0);
    const created = await usersService.create({
      username: 'alice',
      displayName: 'Alice',
      password: 'password123',
    });
    expect(created.username).toBe('alice');
    expect(await usersService.count()).toBe(1);

    const list = await usersService.list();
    expect(list.length).toBe(1);
    expect(list[0].username).toBe('alice');
  });

  it('gets user by id or username and handles not found', async () => {
    const created = await usersService.create({
      username: 'bob',
      displayName: 'Bob',
      password: 'password123',
    });

    const fetched = await usersService.getOrThrow(created.id);
    expect(fetched.displayName).toBe('Bob');

    const byUsername = await usersService.getRowByUsername('bob');
    expect(byUsername?.id).toBe(created.id);

    await expect(usersService.getOrThrow(9999)).rejects.toThrow('User 9999 not found');
  });

  it('searches and looks up users', async () => {
    await usersService.create({
      username: 'charlie_test',
      displayName: 'Charlie Brown',
      password: 'password123',
    });

    const results = await usersService.lookup('charlie');
    expect(results.length).toBe(1);
    expect(results[0].username).toBe('charlie_test');
  });

  it('updates user profile and preferences', async () => {
    const created = await usersService.create({
      username: 'charlie',
      displayName: 'Charlie',
      password: 'password123',
    });

    const updated = await usersService.update(created.id, {
      displayName: 'Charles',
      serverRole: 'admin',
    });
    expect(updated.displayName).toBe('Charles');
    expect(updated.serverRole).toBe('admin');

    const prefUpdated = await usersService.updatePreferences(
      created.id,
      {
        accentColor: '#123456',
        textSize: 'large',
        diceTheme: 'cyberpunk_neon',
        timeFormat: '24h',
        colorVisionAssist: true,
      },
      adminActor,
    );
    expect(prefUpdated.accentColor).toBe('#123456');
    expect(prefUpdated.textSize).toBe('large');
    expect(prefUpdated.colorVisionAssist).toBe(true);
  });

  it('defaults colorVisionAssist to false and round-trips it independently of other preferences (#1942)', async () => {
    const created = await usersService.create({
      username: 'ely',
      displayName: 'Ely',
      password: 'password123',
    });
    expect(created.colorVisionAssist).toBe(false);

    const enabled = await usersService.updatePreferences(created.id, { colorVisionAssist: true }, adminActor);
    expect(enabled.colorVisionAssist).toBe(true);
    // Untouched preferences are not disturbed by a partial update.
    expect(enabled.textSize).toBe('default');

    const fetched = await usersService.getOrThrow(created.id);
    expect(fetched.colorVisionAssist).toBe(true);

    const disabled = await usersService.updatePreferences(created.id, { colorVisionAssist: false }, adminActor);
    expect(disabled.colorVisionAssist).toBe(false);
  });

  it('creates SSO user and syncs OIDC role', async () => {
    const ssoUser = await usersService.createSso({
      username: 'oidcuser',
      displayName: 'OIDC User',
      oidcSub: 'sub-123',
      serverRole: 'user',
    });
    expect(ssoUser.username).toBe('oidcuser');

    const bySub = await usersService.getRowByOidcSub('sub-123');
    expect(bySub?.id).toBe(ssoUser.id);

    const synced = await usersService.syncOidcServerRole(ssoUser.id, 'admin');
    expect(synced.serverRole).toBe('admin');
  });

  it('sets password and kills sessions', async () => {
    const created = await usersService.create({
      username: 'dave',
      displayName: 'Dave',
      password: 'oldpassword',
    });

    await usersService.setPassword(created.id, 'newpassword');
    await usersService.killOtherSessions(created.id);

    const countAdmins = await usersService.countEnabledAdmins();
    expect(typeof countAdmins).toBe('number');
  });

  it('runs membership integrity check', async () => {
    const report = await usersService.membershipIntegrity();
    expect(report.generatedAt).toBeDefined();
    expect(Array.isArray(report.campaigns)).toBe(true);
  });

  it('deletes a user and attributes deleted user', async () => {
    const user1 = await usersService.create({
      username: 'to_delete',
      displayName: 'To Delete',
      password: 'password123',
    });

    await usersService.remove(user1.id, adminActor);
    await expect(usersService.getOrThrow(user1.id)).rejects.toThrow();
  });
});
