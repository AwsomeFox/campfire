import request from 'supertest';
import { closeTestApp, createTestAppNoDevAuth, type TestAppContext } from './test-app';

const API = '/api/v1';

describe('participant-owned access-support preferences (e2e, real SQLite/auth)', () => {
  let ctx: TestAppContext;
  let admin: ReturnType<typeof request.agent>;
  let dm: ReturnType<typeof request.agent>;
  let player: ReturnType<typeof request.agent>;
  let tablemate: ReturnType<typeof request.agent>;
  let outsider: ReturnType<typeof request.agent>;
  let campaignId: number;
  let otherCampaignId: number;

  async function createUser(username: string) {
    const res = await admin.post(`${API}/users`).send({ username, password: `${username}-password-1`, serverRole: 'user' });
    expect(res.status).toBe(201);
    return res.body.id as number;
  }

  async function login(username: string) {
    const agent = request.agent(ctx.app.getHttpServer());
    const res = await agent.post(`${API}/auth/login`).send({ username, password: `${username}-password-1` });
    expect(res.status).toBe(201);
    return agent;
  }

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    admin = request.agent(ctx.app.getHttpServer());
    expect((await admin.post(`${API}/auth/setup`).send({ username: 'support-admin', password: 'admin-password-1' })).status).toBe(201);

    const dmId = await createUser('support-dm');
    const playerId = await createUser('support-player');
    const tablemateId = await createUser('support-tablemate');
    await createUser('support-outsider');
    dm = await login('support-dm');
    player = await login('support-player');
    tablemate = await login('support-tablemate');
    outsider = await login('support-outsider');

    const campaign = await dm.post(`${API}/campaigns`).send({ name: 'Support Campaign' });
    campaignId = campaign.body.id;
    await dm.post(`${API}/campaigns/${campaignId}/members`).send({ userId: playerId, role: 'player' });
    await dm.post(`${API}/campaigns/${campaignId}/members`).send({ userId: tablemateId, role: 'viewer' });

    const other = await dm.post(`${API}/campaigns`).send({ name: 'Other Support Campaign' });
    otherCampaignId = other.body.id;
    expect(dmId).toBeGreaterThan(0);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('uses a strict replacement DTO with conservative, independent privacy choices', async () => {
    const route = `${API}/campaigns/${campaignId}/session-zero/support-preferences/me`;
    expect((await player.put(route).send({ supportText: '', visibility: 'facilitator', aiUseConsent: false })).status).toBe(400);
    expect((await player.put(route).send({ supportText: 'Pause before prompting me.', visibility: 'private', aiUseConsent: false })).status).toBe(400);
    expect((await player.put(route).send({ supportText: 'Pause before prompting me.', visibility: 'facilitator' })).status).toBe(400);
    expect((await player.put(route).send({
      supportText: 'Pause before prompting me.',
      visibility: 'facilitator',
      aiUseConsent: false,
      ownerUserId: 'someone-else',
    })).status).toBe(400);

    const saved = await player.put(route).send({
      supportText: '  Give me a moment after asking what I do.  ',
      visibility: 'facilitator',
      aiUseConsent: false,
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      supportText: 'Give me a moment after asking what I do.',
      visibility: 'facilitator',
      aiUseConsent: false,
    });
  });

  it('enforces ownership, facilitator/table visibility, membership, and cross-campaign isolation', async () => {
    const base = `${API}/campaigns/${campaignId}/session-zero/support-preferences`;
    const own = await player.get(`${base}/me`);
    expect(own.status).toBe(200);
    expect(own.body.supportText).toContain('Give me a moment');

    const tablemateView = await tablemate.get(base);
    expect(tablemateView.status).toBe(200);
    expect(JSON.stringify(tablemateView.body)).not.toContain('Give me a moment');

    const summary = await dm.get(`${base}/summary`);
    expect(summary.status).toBe(200);
    expect(summary.body.entries.some((entry: { supportText: string }) => entry.supportText.includes('Give me a moment'))).toBe(true);
    expect((await tablemate.get(`${base}/summary`)).status).toBe(403);
    expect((await outsider.get(base)).status).toBe(403);
    expect((await player.get(`${API}/campaigns/${otherCampaignId}/session-zero/support-preferences`)).status).toBe(403);

    await player.put(`${base}/me`).send({
      supportText: 'Use explicit turn cues.',
      visibility: 'table',
      aiUseConsent: false,
    });
    const shared = await tablemate.get(base);
    expect(shared.body.some((entry: { supportText: string }) => entry.supportText === 'Use explicit turn cues.')).toBe(true);
  });

  it('audits ownership/privacy metadata without ever auditing support text, and self-delete is immediate', async () => {
    const sentinel = 'SENSITIVE_SUPPORT_SENTINEL_877';
    const base = `${API}/campaigns/${campaignId}/session-zero/support-preferences`;
    await player.put(`${base}/me`).send({ supportText: sentinel, visibility: 'facilitator', aiUseConsent: true });

    const audit = await dm.get(`${API}/campaigns/${campaignId}/audit?limit=500`);
    expect(audit.status).toBe(200);
    const serialized = JSON.stringify(audit.body);
    expect(serialized).not.toContain(sentinel);
    const row = audit.body.find((entry: { action: string }) => entry.action === 'support_preference.upsert');
    expect(JSON.parse(row.detail)).toEqual({ visibility: 'facilitator', aiUseConsent: true });

    expect((await player.delete(`${base}/me`)).status).toBe(204);
    const afterDelete = await player.get(`${base}/me`);
    expect(afterDelete.status).toBe(200);
    expect(afterDelete.text).toBe('');
    expect(JSON.stringify((await dm.get(`${base}/summary`)).body)).not.toContain(sentinel);
    expect((await player.delete(`${base}/me`)).status).toBe(404);
  });

  it('deletes the participant-owned row on campaign departure/removal and account deletion', async () => {
    const leaverId = await createUser('support-leaver');
    const leaver = await login('support-leaver');
    const member = await dm.post(`${API}/campaigns/${campaignId}/members`).send({ userId: leaverId, role: 'player' });
    await leaver.put(`${API}/campaigns/${campaignId}/session-zero/support-preferences/me`).send({
      supportText: 'LEAVER_SUPPORT_877', visibility: 'facilitator', aiUseConsent: true,
    });
    expect((await dm.delete(`${API}/campaigns/${campaignId}/members/${member.body.id}`)).status).toBe(204);
    expect(JSON.stringify((await dm.get(`${API}/campaigns/${campaignId}/session-zero/support-preferences/summary`)).body)).not.toContain('LEAVER_SUPPORT_877');
    expect((await leaver.get(`${API}/campaigns/${campaignId}/session-zero/support-preferences/me`)).status).toBe(403);

    const departingId = await createUser('support-account-delete');
    const departing = await login('support-account-delete');
    await dm.post(`${API}/campaigns/${campaignId}/members`).send({ userId: departingId, role: 'player' });
    await departing.put(`${API}/campaigns/${campaignId}/session-zero/support-preferences/me`).send({
      supportText: 'ACCOUNT_DELETE_SUPPORT_877', visibility: 'table', aiUseConsent: true,
    });
    expect((await departing.delete(`${API}/me`)).status).toBe(204);
    expect(JSON.stringify((await dm.get(`${API}/campaigns/${campaignId}/session-zero/support-preferences/summary`)).body)).not.toContain('ACCOUNT_DELETE_SUPPORT_877');
  });

  it('puts the owner copy in /export/me while campaign export, clone, and import do not transfer it', async () => {
    const supportText = 'EXPORT_POLICY_SUPPORT_877';
    const base = `${API}/campaigns/${campaignId}/session-zero/support-preferences`;
    await player.put(`${base}/me`).send({ supportText, visibility: 'facilitator', aiUseConsent: true });

    const mine = await player.get(`${API}/campaigns/${campaignId}/export/me`);
    expect(mine.status).toBe(200);
    expect(mine.body.supportPreference).toMatchObject({ supportText, visibility: 'facilitator', aiUseConsent: true });

    const full = await dm.get(`${API}/campaigns/${campaignId}/export?format=json`);
    expect(full.status).toBe(200);
    expect(full.body.supportPreference).toBeUndefined();
    expect(full.body.participantSupportPreferences).toBeUndefined();
    expect(JSON.stringify(full.body)).not.toContain(supportText);
    expect(full.body.participantSupportNote).toContain('intentionally excluded');

    const cloned = await dm.post(`${API}/campaigns/${campaignId}/clone`).send({ mode: 'full' });
    expect(cloned.status).toBe(201);
    expect((await dm.get(`${API}/campaigns/${cloned.body.id}/session-zero/support-preferences/summary`)).body.entries).toEqual([]);

    const injected = { ...full.body, name: 'Imported without participant supports', participantSupportPreferences: [
      { ownerUserId: 'forged', ownerName: 'Forged', supportText: 'FORGED_IMPORT_SUPPORT_877', visibility: 'table', aiUseConsent: true },
    ] };
    const imported = await dm.post(`${API}/campaigns/import`).send(injected);
    expect(imported.status).toBe(201);
    const importedSummary = await dm.get(`${API}/campaigns/${imported.body.id}/session-zero/support-preferences/summary`);
    expect(importedSummary.body.entries).toEqual([]);
  });
});
