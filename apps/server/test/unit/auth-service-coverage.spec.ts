import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DbHolder, type DrizzleDb } from '../../src/db/db.module';
import { AuditService } from '../../src/modules/audit/audit.service';
import { UsersService } from '../../src/modules/users/users.service';
import { SettingsService } from '../../src/modules/settings/settings.service';
import { ServerMetaService } from '../../src/modules/server-meta/server-meta.service';
import { AuthService } from '../../src/modules/auth/auth.service';

describe('AuthService unit coverage tests', () => {
  let dataDir: string;
  let holder: DbHolder;
  let previousDataDir: string | undefined;
  let db: DrizzleDb;
  let authService: AuthService;
  let usersService: UsersService;

  beforeEach(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-auth-unit-'));
    process.env.DATA_DIR = dataDir;
    holder = new DbHolder();
    db = holder.proxy as DrizzleDb;
    const audit = new AuditService(db);
    usersService = new UsersService(db, audit);
    const settings = new SettingsService(db);
    const serverMeta = new ServerMetaService(db, false);

    authService = new AuthService(db, usersService, settings, serverMeta);
  });

  afterEach(() => {
    holder.onApplicationShutdown();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('manages first-time setup, login, session resolution and logout', async () => {
    await authService.onApplicationBootstrap();

    const setupResult = await authService.setup({
      username: 'adminuser',
      displayName: 'Admin User',
      password: 'password123!',
    });
    expect(setupResult.token).toBeDefined();

    const loginResult = await authService.login({
      username: 'adminuser',
      password: 'password123!',
    });
    expect(loginResult.token).toBeDefined();

    const resolved = await authService.resolveSessionUser(loginResult.token);
    expect(resolved?.user.id).toBe(String(setupResult.me.user.id));

    await authService.logout(loginResult.token);

    const afterLogout = await authService.resolveSessionUser(loginResult.token);
    expect(afterLogout).toBeNull();

    await authService.purgeExpiredSessions();
  });
});
