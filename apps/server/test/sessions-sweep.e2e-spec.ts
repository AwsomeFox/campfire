import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { eq } from 'drizzle-orm';
import { AppModule } from '../src/app.module';
import { DB, type DrizzleDb } from '../src/db/db.module';
import { userSessions, users } from '../src/db/schema';
import { nowIso } from '../src/common/time';

/**
 * Punch list item 4: AuthService.purgeExpiredSessions() existed with zero call sites —
 * expired user_sessions rows just accumulated forever. AuthService now implements
 * OnApplicationBootstrap, sweeping once at boot (app.init()) and hourly thereafter.
 *
 * This test can't use test/test-app.ts's createTestApp() because that helper calls
 * app.init() (which fires the bootstrap sweep) before returning control to the test —
 * by then it'd be too late to insert an expired row and observe the "at boot" sweep.
 * Instead it replicates test-app.ts's setup but inserts the expired row between
 * `.compile()` (providers instantiated, DB usable) and `app.init()` (bootstrap hooks fire).
 */
describe('expired session sweep on boot (e2e)', () => {
  let app: INestApplication;
  let dataDir: string;

  afterEach(async () => {
    if (app) await app.close();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('purges an already-expired session row at boot, before any request is made', async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-test-'));
    process.env.DATA_DIR = dataDir;
    process.env.DEV_AUTH = '1';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const db = moduleRef.get<DrizzleDb>(DB);

    const ts = nowIso();
    const [user] = await db
      .insert(users)
      .values({
        username: 'sweep-user',
        displayName: 'Sweep User',
        passwordHash: 'not-a-real-hash',
        serverRole: 'user',
        disabled: false,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning();

    const expiredAt = new Date(Date.now() - 60_000).toISOString(); // 1 minute in the past
    const [expiredSession] = await db
      .insert(userSessions)
      .values({
        tokenHash: 'expired-token-hash-for-sweep-test',
        userId: user.id,
        createdAt: ts,
        expiresAt: expiredAt,
        lastSeenAt: ts,
      })
      .returning();

    // A live (non-expired) session must survive the sweep — proves the purge is
    // scoped to expired rows only, not a blanket wipe of user_sessions.
    const futureAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const [liveSession] = await db
      .insert(userSessions)
      .values({
        tokenHash: 'live-token-hash-for-sweep-test',
        userId: user.id,
        createdAt: ts,
        expiresAt: futureAt,
        lastSeenAt: ts,
      })
      .returning();

    // Sanity: both rows exist pre-boot.
    const preBoot = await db.select().from(userSessions).where(eq(userSessions.userId, user.id));
    expect(preBoot).toHaveLength(2);

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix('api/v1', {
      exclude: ['healthz', 'mcp', 'api/docs', 'api/docs-json', 'api/openapi.json'],
    });
    await app.init(); // fires AuthService.onApplicationBootstrap() -> sweep runs here

    const postBoot = await db.select().from(userSessions).where(eq(userSessions.userId, user.id));
    expect(postBoot.map((r) => r.id)).toEqual([liveSession.id]);
    expect(postBoot.some((r) => r.id === expiredSession.id)).toBe(false);
  });
});
