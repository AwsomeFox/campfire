import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';
import { DB } from '../src/db/db.module';
import { users } from '../src/db/schema';

describe('admin roster import (issue #589)', () => {
  let ctx: TestAppContext;
  let adminAgent: ReturnType<typeof request.agent>;
  let playerAgent: ReturnType<typeof request.agent>;
  let campaignId: number;
  let existingUserId: number;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    adminAgent = request.agent(server);
    await adminAgent.post('/api/v1/auth/setup').send({ username: 'roster-admin', password: 'admin-password-1' });

    const existing = await adminAgent
      .post('/api/v1/users')
      .send({ username: 'existing-player', password: 'player-password-1', displayName: 'Existing Player' });
    existingUserId = existing.body.id;

    playerAgent = request.agent(server);
    await playerAgent.post('/api/v1/auth/login').send({ username: 'existing-player', password: 'player-password-1' });

    const camp = await playerAgent.post('/api/v1/campaigns').send({ name: 'Roster Campaign' });
    campaignId = camp.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('rejects non-admin callers (partial authorization)', async () => {
    const res = await playerAgent.post('/api/v1/admin/roster-import').send({
      dryRun: true,
      format: 'json',
      content: JSON.stringify([{ username: 'newbie', campaignId }]),
    });
    expect(res.status).toBe(403);
  });

  it('dry-run reports validation errors, duplicates, and last-dm guard', async () => {
    const csv = [
      'username,displayName,campaignId,role',
      'brand-new,Brand New,' + campaignId + ',player',
      'brand-new,Duplicate,' + campaignId + ',player',
      'existing-player,Updated Name,' + campaignId + ',player',
      'bad user,,,',
    ].join('\n');

    const res = await adminAgent.post('/api/v1/admin/roster-import').send({
      dryRun: true,
      format: 'csv',
      content: csv,
    });
    expect(res.status).toBe(201);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.totalRows).toBeGreaterThanOrEqual(4);

    const rows = res.body.rows as Array<{ rowIndex: number; username?: string; action: string; errors: string[] }>;
    expect(rows.find((r) => r.rowIndex === 0)?.action).toBe('create');
    expect(rows.find((r) => r.rowIndex === 1)?.errors.some((e) => e.includes('Duplicate username'))).toBe(true);
    expect(rows.find((r) => r.username === 'existing-player')?.errors.some((e) => e.includes('last enabled dm'))).toBe(true);
    expect(rows.find((r) => r.username === 'bad user')?.errors.length).toBeGreaterThan(0);
  });

  it('commit is transactional, idempotent on rerun, and audits without activation secrets', async () => {
    const json = [
      { username: 'import-a', displayName: 'Import A', campaignId, role: 'player' },
      { username: 'import-b', displayName: 'Import B', campaignId, role: 'viewer' },
    ];

    const preview = await adminAgent.post('/api/v1/admin/roster-import').send({
      dryRun: true,
      format: 'json',
      content: JSON.stringify(json),
      activationExpiresInDays: 3,
    });
    expect(preview.status).toBe(201);
    expect(preview.body.validRows).toBe(2);

    const commit = await adminAgent.post('/api/v1/admin/roster-import').send({
      dryRun: false,
      format: 'json',
      content: '[]',
      batchId: preview.body.batchId,
      rows: preview.body.commitRows,
      activationExpiresInDays: 3,
    });
    expect(commit.status).toBe(201);
    expect(commit.body.created).toBe(2);
    expect(commit.body.activations).toHaveLength(2);
    expect(commit.body.activations[0].activationCode).toMatch(/^cf_reset_/);

    const members = await playerAgent.get(`/api/v1/campaigns/${campaignId}/members`);
    expect(members.body.some((m: { username: string }) => m.username === 'import-a')).toBe(true);
    expect(members.body.some((m: { username: string }) => m.username === 'import-b')).toBe(true);

    const audit = await adminAgent.get('/api/v1/admin/audit');
    const batchAudit = audit.body.find((row: { action: string }) => row.action === 'roster_import.commit');
    expect(batchAudit).toBeDefined();
    expect(batchAudit.detail).not.toMatch(/cf_reset_/);

    const rerun = await adminAgent.post('/api/v1/admin/roster-import').send({
      dryRun: false,
      format: 'json',
      content: '[]',
      batchId: preview.body.batchId,
      rows: preview.body.commitRows,
      activationExpiresInDays: 3,
    });
    expect(rerun.status).toBe(201);
    expect(rerun.body.created).toBe(0);
    expect(rerun.body.skipped).toBeGreaterThanOrEqual(2);
    expect(rerun.body.activations).toHaveLength(0);
  });

  it('activation codes from roster import can set the initial password', async () => {
    const preview = await adminAgent.post('/api/v1/admin/roster-import').send({
      dryRun: true,
      format: 'json',
      content: JSON.stringify([{ username: 'activate-me', displayName: 'Activate Me', campaignId, role: 'player' }]),
      activationExpiresInDays: 3,
    });
    expect(preview.status).toBe(201);

    const commit = await adminAgent.post('/api/v1/admin/roster-import').send({
      dryRun: false,
      format: 'json',
      content: '[]',
      batchId: preview.body.batchId,
      rows: preview.body.commitRows,
      activationExpiresInDays: 3,
    });
    expect(commit.status).toBe(201);
    const { activationCode } = commit.body.activations[0] as { activationCode: string };

    const beforeLogin = await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ username: 'activate-me', password: 'any-password' });
    expect(beforeLogin.status).toBe(401);

    const activate = await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/reset-confirm')
      .send({ code: activationCode, newPassword: 'activate-password-1' });
    expect(activate.status).toBe(204);

    const afterLogin = await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ username: 'activate-me', password: 'activate-password-1' });
    expect(afterLogin.status).toBe(201);
  });

  it('matches existing users by oidcSub and rejects conflicting identities', async () => {
    const db = ctx.app.get(DB);
    const second = await adminAgent
      .post('/api/v1/users')
      .send({ username: 'oidc-bob', password: 'player-password-2', displayName: 'Bob' });
    await db.update(users).set({ oidcSub: 'oidc-bob-sub' }).where(eq(users.id, second.body.id));
    await db.update(users).set({ oidcSub: 'oidc-alice-sub' }).where(eq(users.id, existingUserId));

    const preview = await adminAgent.post('/api/v1/admin/roster-import').send({
      dryRun: true,
      format: 'json',
      content: JSON.stringify([
        { username: 'existing-player', oidcSub: 'oidc-bob-sub', campaignId, role: 'player' },
      ]),
    });
    expect(preview.status).toBe(201);
    const row = preview.body.rows[0] as { errors: string[]; matchBy?: string };
    expect(row.errors.some((e) => e.includes('different existing accounts'))).toBe(true);
  });
});
