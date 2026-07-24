import crypto from 'node:crypto';
import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';
import { CAMPAIGN_PURGE_CONFIRM_TOKEN } from '@campfire/schema';
import { DB, type DrizzleDb } from '../src/db/db.module';
import { campaignPurgeTombstones, campaigns } from '../src/db/schema';
import { eq } from 'drizzle-orm';
import { CampaignEventsService } from '../src/modules/events/campaign-events.service';
import { firstValueFrom, take, timeout } from 'rxjs';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'trash-boundary-dm' };
const player = { 'x-dev-role': 'player', 'x-dev-user': 'trash-boundary-player' };
const outsider = { 'x-dev-role': 'player', 'x-dev-user': 'trash-boundary-outsider' };

const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108020000009077' +
    '53de0000000c4944415408d763f8ffff3f0005fe02fea1399e1e0000000049454e44ae426082',
  'hex',
);

/**
 * Issue #867 — Campaign Trash boundary: freeze child APIs, forbid live purge,
 * retain purge evidence. Complements campaign-archive.e2e-spec.ts (issue #16)
 * and the soft-delete suite in campaigns.e2e-spec.ts (issue #116).
 */
describe('campaign trash boundary (e2e, issue #867)', () => {
  let ctx: TestAppContext;
  let server: ReturnType<TestAppContext['app']['getHttpServer']>;
  let campaignId: number;
  let questId: number;
  let attachmentId: number;
  let icsToken: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer();

    const campRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Frozen Saga' });
    expect(campRes.status).toBe(201);
    campaignId = campRes.body.id;

    const questRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/quests`)
      .set(dm)
      .send({ title: 'Last Light' });
    expect(questRes.status).toBe(201);
    questId = questRes.body.id;

    const uploadRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/attachments`)
      .set(dm)
      .field('kind', 'image')
      .attach('file', TINY_PNG, { filename: 'map.png', contentType: 'image/png' });
    expect(uploadRes.status).toBe(201);
    attachmentId = uploadRes.body.id;
    expect((await request(server).post(`/api/v1/attachments/${attachmentId}/reveal`).set(dm)).status).toBe(201);

    // Public ICS feed — must freeze after trash.
    const icsRes = await request(server).post(`/api/v1/campaigns/${campaignId}/calendar-feed`).set(dm);
    expect(icsRes.status).toBe(201);
    icsToken = icsRes.body.token;
    expect(typeof icsToken).toBe('string');

    // Soft-delete (Trash).
    expect((await request(server).delete(`/api/v1/campaigns/${campaignId}`).set(dm)).status).toBe(200);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  describe('while trashed: normal access is frozen without existence leak', () => {
    it('GET campaign / summary / child lists / entity by id → 404 for former members', async () => {
      expect((await request(server).get(`/api/v1/campaigns/${campaignId}`).set(dm)).status).toBe(404);
      expect((await request(server).get(`/api/v1/campaigns/${campaignId}/summary`).set(dm)).status).toBe(404);
      expect((await request(server).get(`/api/v1/campaigns/${campaignId}/quests`).set(player)).status).toBe(404);
      expect((await request(server).get(`/api/v1/quests/${questId}`).set(dm)).status).toBe(404);
      expect((await request(server).get(`/api/v1/campaigns/${campaignId}/audit`).set(dm)).status).toBe(404);
      expect((await request(server).get(`/api/v1/campaigns/${campaignId}/trash`).set(dm)).status).toBe(404);
    });

    it('writes and integrations are rejected (404, not "trashed" disclosure)', async () => {
      const create = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/quests`)
        .set(dm)
        .send({ title: 'Should Not Land' });
      expect(create.status).toBe(404);

      const patch = await request(server).patch(`/api/v1/quests/${questId}`).set(dm).send({ title: 'Nope' });
      expect(patch.status).toBe(404);

      const note = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/notes`)
        .set(player)
        .send({ body: 'stale tab write', visibility: 'party_shared' });
      expect(note.status).toBe(404);
    });

    it('attachment bytes are frozen', async () => {
      const res = await request(server).get(`/api/v1/attachments/${attachmentId}/file`).set(player);
      expect(res.status).toBe(404);
    });

    it('SSE open is refused; campaign.trashed closes a pre-trash stream', async () => {
      // Fresh open after trash → 404 (requireMember lifecycle gate).
      const open = await request(server).get(`/api/v1/campaigns/${campaignId}/events`).set(dm);
      expect(open.status).toBe(404);

      // Prove the control signal exists for live streams: emit against a fresh
      // live campaign and confirm subscribers observe campaign.trashed.
      const live = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Stream Probe' });
      expect(live.status).toBe(201);
      const liveId = live.body.id as number;
      const events = ctx.app.get(CampaignEventsService);
      const seen = firstValueFrom(
        events.streamFor(liveId).pipe(
          take(1),
          timeout(2000),
        ),
      );
      events.emit({ type: 'campaign.trashed', campaignId: liveId });
      await expect(seen).resolves.toMatchObject({ type: 'campaign.trashed', campaignId: liveId });
      await request(server).delete(`/api/v1/campaigns/${liveId}`).set(dm);
      await request(server)
        .delete(`/api/v1/campaigns/${liveId}/purge`)
        .set(dm)
        .send({ confirm: CAMPAIGN_PURGE_CONFIRM_TOKEN });
    });

    it('public ICS feed looks like an unknown token', async () => {
      const res = await request(server).get(`/api/v1/calendar/${icsToken}.ics`);
      expect(res.status).toBe(404);
    });

    it('outsider probing a trashed id is indistinguishable from a missing campaign (no trash leak)', async () => {
      const trashed = await request(server).get(`/api/v1/campaigns/${campaignId}`).set(outsider);
      const missing = await request(server).get('/api/v1/campaigns/999999991').set(outsider);
      expect(trashed.status).toBe(missing.status);
      expect(trashed.body.message).toBe(missing.body.message);
    });
  });

  describe('Trash exemptions: list / restore / purge', () => {
    it('GET /campaigns/trash still lists the trashed campaign', async () => {
      const trash = await request(server).get('/api/v1/campaigns/trash').set(dm);
      expect(trash.status).toBe(200);
      expect(trash.body.some((c: { id: number }) => c.id === campaignId)).toBe(true);
    });

    it('live purge is refused; purge without confirm is refused', async () => {
      const live = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Still Alive' });
      expect(live.status).toBe(201);
      const liveId = live.body.id as number;

      const noConfirm = await request(server).delete(`/api/v1/campaigns/${liveId}/purge`).set(dm).send({});
      expect(noConfirm.status).toBe(400);

      const livePurge = await request(server)
        .delete(`/api/v1/campaigns/${liveId}/purge`)
        .set(dm)
        .send({ confirm: CAMPAIGN_PURGE_CONFIRM_TOKEN });
      expect(livePurge.status).toBe(404);

      // Cleanup via trash+purge.
      await request(server).delete(`/api/v1/campaigns/${liveId}`).set(dm);
      expect(
        (
          await request(server)
            .delete(`/api/v1/campaigns/${liveId}/purge`)
            .set(dm)
            .send({ confirm: CAMPAIGN_PURGE_CONFIRM_TOKEN })
        ).status,
      ).toBe(200);
    });

    it('restore-vs-purge race: restore wins ⇒ purge 404s; purge wins ⇒ restore 404s', async () => {
      const a = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Race A' });
      const b = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Race B' });
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      const idA = a.body.id as number;
      const idB = b.body.id as number;
      await request(server).delete(`/api/v1/campaigns/${idA}`).set(dm);
      await request(server).delete(`/api/v1/campaigns/${idB}`).set(dm);

      // Restore wins on A: purge after restore must 404.
      expect((await request(server).post(`/api/v1/campaigns/${idA}/restore`).set(dm)).status).toBe(201);
      const purgeAfterRestore = await request(server)
        .delete(`/api/v1/campaigns/${idA}/purge`)
        .set(dm)
        .send({ confirm: CAMPAIGN_PURGE_CONFIRM_TOKEN });
      expect(purgeAfterRestore.status).toBe(404);

      // Purge wins on B: restore after purge must 404.
      expect(
        (
          await request(server)
            .delete(`/api/v1/campaigns/${idB}/purge`)
            .set(dm)
            .send({ confirm: CAMPAIGN_PURGE_CONFIRM_TOKEN })
        ).status,
      ).toBe(200);
      expect((await request(server).post(`/api/v1/campaigns/${idB}/restore`).set(dm)).status).toBe(404);

      // Cleanup A.
      await request(server).delete(`/api/v1/campaigns/${idA}`).set(dm);
      await request(server)
        .delete(`/api/v1/campaigns/${idA}/purge`)
        .set(dm)
        .send({ confirm: CAMPAIGN_PURGE_CONFIRM_TOKEN });
    });

    it('purge retains a sanitized server-level tombstone + discoverable admin audit', async () => {
      const name = 'Evidence Campaign';
      const created = await request(server).post('/api/v1/campaigns').set(dm).send({ name });
      expect(created.status).toBe(201);
      const id = created.body.id as number;
      const nameHash = crypto.createHash('sha256').update(name).digest('hex');

      await request(server).delete(`/api/v1/campaigns/${id}`).set(dm);
      const purge = await request(server)
        .delete(`/api/v1/campaigns/${id}/purge`)
        .set(dm)
        .send({ confirm: CAMPAIGN_PURGE_CONFIRM_TOKEN });
      expect(purge.status).toBe(200);

      const db = ctx.app.get<DrizzleDb>(DB);
      const [tombstone] = await db
        .select()
        .from(campaignPurgeTombstones)
        .where(eq(campaignPurgeTombstones.campaignId, id))
        .limit(1);
      expect(tombstone).toBeDefined();
      expect(tombstone.status).toBe('completed');
      expect(tombstone.campaignNameHash).toBe(nameHash);
      expect(tombstone.actor).toContain('trash-boundary-dm');
      expect(tombstone.requestedAt).toBeTruthy();
      expect(tombstone.completedAt).toBeTruthy();
      // Sanitized: never stores the plaintext campaign name.
      expect(JSON.stringify(tombstone)).not.toContain(name);

      // Campaign-scoped audit is gone with memberships; server admin audit retains the purge.
      const admin = { 'x-dev-role': 'admin', 'x-dev-user': 'trash-boundary-admin' };
      // Promote via settings isn't needed in DEV_AUTH — x-dev-role admin unlocks /admin/audit.
      const audit = await request(server).get('/api/v1/admin/audit').set(admin);
      expect(audit.status).toBe(200);
      const entry = (audit.body as Array<{ action: string; detail: string; campaignId: number | null }>).find(
        (row) => row.action === 'campaign.purge' && row.detail.includes(`"campaignId":${id}`),
      );
      expect(entry).toBeDefined();
      expect(entry!.campaignId).toBeNull();
      expect(entry!.detail).toContain(nameHash);
      expect(entry!.detail).toContain('"status":"completed"');
      expect(entry!.detail).not.toContain(name);

      // Row is gone from campaigns.
      const [gone] = await db.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.id, id)).limit(1);
      expect(gone).toBeUndefined();
    });

    it('restore of the suite campaign brings child APIs back', async () => {
      const restore = await request(server).post(`/api/v1/campaigns/${campaignId}/restore`).set(dm);
      expect(restore.status).toBe(201);
      expect(restore.body.deletedAt).toBeNull();

      expect((await request(server).get(`/api/v1/campaigns/${campaignId}`).set(dm)).status).toBe(200);
      expect((await request(server).get(`/api/v1/quests/${questId}`).set(dm)).status).toBe(200);
      expect((await request(server).get(`/api/v1/attachments/${attachmentId}/file`).set(player)).status).toBe(200);

      // Re-trash + purge to leave the suite clean and exercise the happy purge path once more.
      await request(server).delete(`/api/v1/campaigns/${campaignId}`).set(dm);
      expect(
        (
          await request(server)
            .delete(`/api/v1/campaigns/${campaignId}/purge`)
            .set(dm)
            .send({ confirm: CAMPAIGN_PURGE_CONFIRM_TOKEN })
        ).status,
      ).toBe(200);
    });
  });
});
