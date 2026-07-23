import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { createTestApp, createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';
import { DB, type DrizzleDb } from '../src/db/db.module';
import { rulePacks } from '../src/db/schema';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };

describe('campaigns (e2e)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp();

    // Seed an installed rule pack directly via the DB (mirrors encounters.e2e-spec.ts) so
    // ruleSystem validation (round-2 finding #4) has a real slug to accept.
    const db = ctx.app.get<DrizzleDb>(DB);
    const ts = new Date().toISOString();
    await db
      .insert(rulePacks)
      .values({ slug: 'dnd5e-srd', name: 'D&D 5e SRD', version: '1', license: '', sourceUrl: '', installedAt: ts, entryCount: 0 });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('CRUD roundtrip', async () => {
    const server = ctx.app.getHttpServer();

    const createRes = await request(server)
      .post('/api/v1/campaigns')
      .set(dm)
      .send({ name: 'The Sunless Citadel', description: 'A classic.' });
    expect(createRes.status).toBe(201);
    expect(createRes.body.name).toBe('The Sunless Citadel');
    expect(createRes.body.sessionCount).toBe(0);
    const id = createRes.body.id;

    const listRes = await request(server).get('/api/v1/campaigns').set(dm);
    expect(listRes.status).toBe(200);
    expect(listRes.body.some((c: { id: number }) => c.id === id)).toBe(true);

    const getRes = await request(server).get(`/api/v1/campaigns/${id}`).set(dm);
    expect(getRes.status).toBe(200);
    expect(getRes.body.id).toBe(id);

    const patchRes = await request(server)
      .patch(`/api/v1/campaigns/${id}`)
      .set(dm)
      .send({ description: 'Updated description' });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.description).toBe('Updated description');

    const deleteRes = await request(server).delete(`/api/v1/campaigns/${id}`).set(dm);
    expect(deleteRes.status).toBe(200);

    const getAfterDelete = await request(server).get(`/api/v1/campaigns/${id}`).set(dm);
    expect(getAfterDelete.status).toBe(404);
  });

  // Strict-validation (task P1 item 3): CampaignCreateDto/CampaignUpdateDto are
  // now .strict() at the DTO layer — an unrecognized key 400s with a clear
  // message instead of the global ZodValidationPipe silently stripping it.
  it('unknown key in campaign create/update body -> 400, not silently stripped', async () => {
    const server = ctx.app.getHttpServer();

    const createRes = await request(server)
      .post('/api/v1/campaigns')
      .set(dm)
      .send({ name: 'Strict Test Campaign', notAField: 'oops' });
    expect(createRes.status).toBe(400);

    const okCreate = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Strict Test Campaign' });
    expect(okCreate.status).toBe(201);

    const patchRes = await request(server)
      .patch(`/api/v1/campaigns/${okCreate.body.id}`)
      .set(dm)
      .send({ nmae: 'Typo Field' }); // misnamed field, not `name`
    expect(patchRes.status).toBe(400);
  });

  it('ruleSystem defaults to empty string and passes through create + PATCH when it matches an installed pack', async () => {
    const server = ctx.app.getHttpServer();

    const createRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Rule System Test' });
    expect(createRes.status).toBe(201);
    expect(createRes.body.ruleSystem).toBe('');
    const id = createRes.body.id;

    const createWithRuleSystem = await request(server)
      .post('/api/v1/campaigns')
      .set(dm)
      .send({ name: 'Rule System Test 2', ruleSystem: 'dnd5e-srd' });
    expect(createWithRuleSystem.status).toBe(201);
    expect(createWithRuleSystem.body.ruleSystem).toBe('dnd5e-srd');

    const patchRes = await request(server)
      .patch(`/api/v1/campaigns/${id}`)
      .set(dm)
      .send({ ruleSystem: 'dnd5e-srd' });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.ruleSystem).toBe('dnd5e-srd');

    const getRes = await request(server).get(`/api/v1/campaigns/${id}`).set(dm);
    expect(getRes.body.ruleSystem).toBe('dnd5e-srd');

    // clearing back to '' is always allowed, even though '' isn't an installed pack slug
    const clearRes = await request(server).patch(`/api/v1/campaigns/${id}`).set(dm).send({ ruleSystem: '' });
    expect(clearRes.status).toBe(200);
    expect(clearRes.body.ruleSystem).toBe('');
  });

  it('ruleSystem rejects a slug that is not an installed rule pack (round-2 finding #4)', async () => {
    const server = ctx.app.getHttpServer();

    const createRes = await request(server)
      .post('/api/v1/campaigns')
      .set(dm)
      .send({ name: 'Bad Rule System Create', ruleSystem: 'not-a-real-pack' });
    expect(createRes.status).toBe(400);

    const okCreate = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Patch Target For Bad ruleSystem' });
    expect(okCreate.status).toBe(201);
    const id = okCreate.body.id;

    const patchRes = await request(server)
      .patch(`/api/v1/campaigns/${id}`)
      .set(dm)
      .send({ ruleSystem: 'still-not-a-real-pack' });
    expect(patchRes.status).toBe(400);

    // campaign is unchanged after the rejected PATCH
    const getRes = await request(server).get(`/api/v1/campaigns/${id}`).set(dm);
    expect(getRes.body.ruleSystem).toBe('');
  });

  /**
   * Issue #539: clients must persist ruleSystem on POST — a create-then-PATCH flow
   * can leave a campaign on the empty-system fallback when the PATCH fails.
   */
  it('issue #539: ruleSystem on POST is authoritative; failed PATCH after create-without-rules leaves empty system', async () => {
    const server = ctx.app.getHttpServer();

    const atomic = await request(server)
      .post('/api/v1/campaigns')
      .set(dm)
      .send({ name: 'Atomic D&D 5e Choice', ruleSystem: 'dnd5e-srd' });
    expect(atomic.status).toBe(201);
    expect(atomic.body.ruleSystem).toBe('dnd5e-srd');
    const getAtomic = await request(server).get(`/api/v1/campaigns/${atomic.body.id}`).set(dm);
    expect(getAtomic.body.ruleSystem).toBe('dnd5e-srd');

    const createOnly = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Two-step hazard' });
    expect(createOnly.status).toBe(201);
    expect(createOnly.body.ruleSystem).toBe('');

    const failedPatch = await request(server)
      .patch(`/api/v1/campaigns/${createOnly.body.id}`)
      .set(dm)
      .send({ ruleSystem: 'not-a-real-pack' });
    expect(failedPatch.status).toBe(400);

    const afterFailedPatch = await request(server).get(`/api/v1/campaigns/${createOnly.body.id}`).set(dm);
    expect(afterFailedPatch.body.ruleSystem).toBe('');
  });

  it('GET /campaigns/:id/summary returns aggregate shape', async () => {
    const server = ctx.app.getHttpServer();
    const createRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Summary Test' });
    const id = createRes.body.id;

    const summaryRes = await request(server).get(`/api/v1/campaigns/${id}/summary`).set(dm);
    expect(summaryRes.status).toBe(200);
    expect(summaryRes.body.campaign.id).toBe(id);
    expect(summaryRes.body.currentLocation).toBeNull();
    expect(Array.isArray(summaryRes.body.quests)).toBe(true);
    expect(Array.isArray(summaryRes.body.npcs)).toBe(true);
    expect(Array.isArray(summaryRes.body.locations)).toBe(true);
    expect(Array.isArray(summaryRes.body.characters)).toBe(true);
    expect(Array.isArray(summaryRes.body.sessions)).toBe(true);
    expect(summaryRes.body.openInboxCount).toBe(0);
  });

  it('POST /campaigns is open to any authenticated user (dev-auth headers count), not just dm', async () => {
    // Under the membership model, campaign creation itself is unrestricted for any
    // authenticated caller — the creator is auto-inserted as that campaign's 'dm'.
    // The old "dm role required" behavior is superseded by per-campaign membership.
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post('/api/v1/campaigns')
      .set({ 'x-dev-role': 'player', 'x-dev-user': 'p1' })
      .send({ name: 'Player-created campaign' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Player-created campaign');
  });

  it('POST /campaigns 400s on invalid body (zod validation)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post('/api/v1/campaigns').set(dm).send({});
    expect(res.status).toBe(400);
    expect(res.body.statusCode).toBe(400);
  });

  // P2 fix pinning tests — FK-shaped fields (currentLocationId, mapAttachmentId) must
  // resolve to a real row IN THE SAME campaign, or 400.
  describe('FK validation: currentLocationId / mapAttachmentId', () => {
    it('POST rejects a non-null currentLocationId/mapAttachmentId outright (no locations/attachments exist yet on a brand-new campaign)', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Bad FK Create', currentLocationId: 999999 });
      expect(res.status).toBe(400);
    });

    it('PATCH currentLocationId with a nonexistent id -> 400', async () => {
      const server = ctx.app.getHttpServer();
      const createRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'FK Loc Campaign' });
      const id = createRes.body.id;

      const res = await request(server).patch(`/api/v1/campaigns/${id}`).set(dm).send({ currentLocationId: 999999 });
      expect(res.status).toBe(400);
    });

    it('PATCH currentLocationId with a cross-campaign location id -> 400', async () => {
      const server = ctx.app.getHttpServer();
      const campA = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'FK Loc Campaign A' });
      const campB = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'FK Loc Campaign B' });

      const locRes = await request(server)
        .post(`/api/v1/campaigns/${campB.body.id}/locations`)
        .set(dm)
        .send({ name: 'Location in B' });
      expect(locRes.status).toBe(201);

      const res = await request(server)
        .patch(`/api/v1/campaigns/${campA.body.id}`)
        .set(dm)
        .send({ currentLocationId: locRes.body.id });
      expect(res.status).toBe(400);
    });

    it('PATCH currentLocationId with a valid same-campaign location id -> 200', async () => {
      const server = ctx.app.getHttpServer();
      const createRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'FK Loc Campaign Valid' });
      const id = createRes.body.id;

      const locRes = await request(server).post(`/api/v1/campaigns/${id}/locations`).set(dm).send({ name: 'Valid Location' });
      expect(locRes.status).toBe(201);

      const res = await request(server).patch(`/api/v1/campaigns/${id}`).set(dm).send({ currentLocationId: locRes.body.id });
      expect(res.status).toBe(200);
      expect(res.body.currentLocationId).toBe(locRes.body.id);
    });

    it('PATCH mapAttachmentId with a nonexistent id -> 400', async () => {
      const server = ctx.app.getHttpServer();
      const createRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'FK Attach Campaign' });
      const id = createRes.body.id;

      const res = await request(server).patch(`/api/v1/campaigns/${id}`).set(dm).send({ mapAttachmentId: 999999 });
      expect(res.status).toBe(400);
    });

    it('PATCH mapAttachmentId with a cross-campaign attachment id -> 400', async () => {
      const server = ctx.app.getHttpServer();
      const campA = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'FK Attach Campaign A' });
      const campB = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'FK Attach Campaign B' });

      const uploadRes = await request(server)
        .post(`/api/v1/campaigns/${campB.body.id}/attachments`)
        .set(dm)
        .field('kind', 'map')
        .attach('file', TINY_PNG, { filename: 'map.png', contentType: 'image/png' });
      expect(uploadRes.status).toBe(201);

      const res = await request(server)
        .patch(`/api/v1/campaigns/${campA.body.id}`)
        .set(dm)
        .send({ mapAttachmentId: uploadRes.body.id });
      expect(res.status).toBe(400);
    });

    it('PATCH mapAttachmentId with a valid same-campaign attachment id -> 200', async () => {
      const server = ctx.app.getHttpServer();
      const createRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'FK Attach Campaign Valid' });
      const id = createRes.body.id;

      const uploadRes = await request(server)
        .post(`/api/v1/campaigns/${id}/attachments`)
        .set(dm)
        .field('kind', 'map')
        .attach('file', TINY_PNG, { filename: 'map.png', contentType: 'image/png' });
      expect(uploadRes.status).toBe(201);

      const res = await request(server).patch(`/api/v1/campaigns/${id}`).set(dm).send({ mapAttachmentId: uploadRes.body.id });
      expect(res.status).toBe(200);
      expect(res.body.mapAttachmentId).toBe(uploadRes.body.id);
    });
  });
});

// Minimal valid 1x1 PNG (smallest possible real PNG payload) — same fixture as attachments.e2e-spec.ts.
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108020000009077' +
    '53de0000000c4944415408d763f8ffff3f0005fe02fea1399e1e0000000049454e44ae426082',
  'hex',
);

/**
 * Full cascade PURGE (punch list item 1; now the deliberate 2nd step under issue #116).
 * Builds a "rich" campaign touching every child table the old single-row DELETE left
 * orphaned — quest+objective, npc, location, character, encounter+combatant, note,
 * proposal, a second member, a campaign-bound API token, and an uploaded attachment
 * (DB row + on-disk file) — then soft-deletes (verifying the uploads survive) and finally
 * PURGES the campaign, verifying every child 404s, the ex-member is locked out everywhere,
 * and the attachment's upload directory is gone from disk.
 */
describe('campaign purge cascade (e2e)', () => {
  let ctx: TestAppContext;
  let dmAgent: ReturnType<typeof request.agent>;
  let memberAgent: ReturnType<typeof request.agent>;
  let campaignId: number;
  let questId: number;
  let objectiveId: number;
  let npcId: number;
  let locationId: number;
  let characterId: number;
  let encounterId: number;
  let combatantId: number;
  let noteId: number;
  let proposalId: number;
  let memberRowId: number;
  let memberUserId: number;
  let tokenId: number;
  let tokenRaw: string;
  let attachmentId: number;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    dmAgent = request.agent(server);
    await dmAgent.post('/api/v1/auth/setup').send({ username: 'cascade-dm', password: 'dm-password-1' });
    await dmAgent.post('/api/v1/users').send({ username: 'cascade-member', password: 'member-password-1', serverRole: 'user' });

    memberAgent = request.agent(server);
    await memberAgent.post('/api/v1/auth/login').send({ username: 'cascade-member', password: 'member-password-1' });

    const meRes = await memberAgent.get('/api/v1/me');
    memberUserId = meRes.body.user.id;

    const campRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'Rich Doomed Campaign' });
    campaignId = campRes.body.id;

    // second member, added by the dm
    const memberRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: memberUserId, role: 'player' });
    expect(memberRes.status).toBe(201);
    memberRowId = memberRes.body.id;

    const questRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/quests`).send({ title: 'Doomed Quest' });
    questId = questRes.body.id;
    const objRes = await dmAgent.post(`/api/v1/quests/${questId}/objectives`).send({ text: 'Doomed Objective' });
    objectiveId = objRes.body.id;

    const npcRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/npcs`).send({ name: 'Doomed NPC' });
    npcId = npcRes.body.id;

    const locRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/locations`).send({ name: 'Doomed Location' });
    locationId = locRes.body.id;

    const charRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/characters`).send({ name: 'Doomed Character' });
    characterId = charRes.body.id;

    const encRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/encounters`).send({ name: 'Doomed Encounter' });
    encounterId = encRes.body.id;
    const combatantRes = await dmAgent.post(`/api/v1/encounters/${encounterId}/combatants`).send({ kind: 'monster', name: 'Doomed Monster', hpMax: 10 });
    combatantId = combatantRes.body.id;

    const noteRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/notes`).send({ body: 'Doomed note', visibility: 'party_shared' });
    noteId = noteRes.body.id;

    const proposalRes = await memberAgent.post(`/api/v1/campaigns/${campaignId}/quests?proposed=true`).send({ title: 'Doomed Proposal' });
    expect(proposalRes.status).toBe(202);
    proposalId = proposalRes.body.proposal.id;

    const tokenRes = await dmAgent.post('/api/v1/tokens').send({ name: 'cascade-token', scope: 'dm', campaignId });
    tokenId = tokenRes.body.apiToken.id;
    tokenRaw = tokenRes.body.token;

    const uploadRes = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/attachments`)
      .field('kind', 'image')
      .attach('file', TINY_PNG, { filename: 'doomed.png', contentType: 'image/png' });
    expect(uploadRes.status).toBe(201);
    attachmentId = uploadRes.body.id;

    // Confirm the file actually landed on disk before we delete anything, so the
    // "directory is gone" assertion below is meaningful (not vacuously true).
    const uploadDir = path.join(ctx.dataDir, 'uploads', String(campaignId));
    expect(fs.existsSync(uploadDir)).toBe(true);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('dm trashes then permanently purges the campaign (the hard cascade is now the deliberate 2nd step, issue #116)', async () => {
    // Soft-delete first (the default DELETE) — rows + uploads must still be intact here.
    const softRes = await dmAgent.delete(`/api/v1/campaigns/${campaignId}`);
    expect(softRes.status).toBe(200);
    const uploadDir = path.join(ctx.dataDir, 'uploads', String(campaignId));
    expect(fs.existsSync(uploadDir)).toBe(true); // still on disk after a soft-delete
    // Now the explicit purge runs the real hard-cascade + fs.rm.
    const res = await dmAgent.delete(`/api/v1/campaigns/${campaignId}/purge`);
    expect(res.status).toBe(200);
  });

  it('campaign itself is gone (403 — the purge cascade removed the membership row, and admin ≠ auto-DM means no implicit fallback)', async () => {
    // Pre-issue-#9 this was a 404: the deleting dm here is the setup ADMIN, whose
    // implicit dm-everywhere role passed requireMember and hit getOrThrow's 404.
    // Now membership is the only path in, so a deleted campaign answers exactly
    // like any other campaign you're not a member of: 403, existence not leaked.
    const res = await dmAgent.get(`/api/v1/campaigns/${campaignId}`);
    expect(res.status).toBe(403);
  });

  it('quest and its objective 404 (objective 404s via the quest lookup, not directly listable)', async () => {
    const questRes = await dmAgent.get(`/api/v1/quests/${questId}`);
    expect(questRes.status).toBe(404);
    // objective route requires the quest to resolve first, so it 404s the same way
    const objRes = await dmAgent.patch(`/api/v1/quests/${questId}/objectives/${objectiveId}`).send({ done: true });
    expect(objRes.status).toBe(404);
  });

  it('npc 404s', async () => {
    const res = await dmAgent.get(`/api/v1/npcs/${npcId}`);
    expect(res.status).toBe(404);
  });

  it('location 404s', async () => {
    const res = await dmAgent.get(`/api/v1/locations/${locationId}`);
    expect(res.status).toBe(404);
  });

  it('character 404s', async () => {
    const res = await dmAgent.get(`/api/v1/characters/${characterId}`);
    expect(res.status).toBe(404);
  });

  it('encounter and its combatant 404', async () => {
    const encRes = await dmAgent.get(`/api/v1/encounters/${encounterId}`);
    expect(encRes.status).toBe(404);
    const combatantRes = await dmAgent.patch(`/api/v1/encounters/${encounterId}/combatants/${combatantId}`).send({ hpDelta: -1 });
    expect(combatantRes.status).toBe(404);
  });

  it('note 404s', async () => {
    const res = await dmAgent.get(`/api/v1/notes/${noteId}`);
    expect(res.status).toBe(404);
  });

  it('proposal is gone (approve 404s rather than resolving against a dead campaign)', async () => {
    const res = await dmAgent.post(`/api/v1/proposals/${proposalId}/approve`).send({});
    expect(res.status).toBe(404);
  });

  it('attachment file GET 404s and the on-disk upload dir is gone', async () => {
    const res = await dmAgent.get(`/api/v1/attachments/${attachmentId}/file`);
    expect(res.status).toBe(404);

    const uploadDir = path.join(ctx.dataDir, 'uploads', String(campaignId));
    expect(fs.existsSync(uploadDir)).toBe(false);
  });

  it('ex-member gets 403/404 everywhere for the dead campaign', async () => {
    const getRes = await memberAgent.get(`/api/v1/campaigns/${campaignId}`);
    expect([403, 404]).toContain(getRes.status);

    const questListRes = await memberAgent.get(`/api/v1/campaigns/${campaignId}/quests`);
    expect([403, 404]).toContain(questListRes.status);

    const memberMeRes = await memberAgent.get('/api/v1/me');
    expect(memberMeRes.body.memberships.some((m: { campaignId: number }) => m.campaignId === campaignId)).toBe(false);
  });

  it('the campaign-bound API token is revoked (401 as Bearer)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).get('/api/v1/me').set('Authorization', `Bearer ${tokenRaw}`);
    expect(res.status).toBe(401);

    // and no longer listed among the dm's own tokens
    const listRes = await dmAgent.get('/api/v1/tokens');
    expect(listRes.body.some((t: { id: number }) => t.id === tokenId)).toBe(false);
  });

  it('member row is gone (re-adding the same user to a fresh campaign works, proving no orphaned row)', async () => {
    const newCampRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'Fresh Campaign After Cascade' });
    const newCampaignId = newCampRes.body.id;
    const addRes = await dmAgent.post(`/api/v1/campaigns/${newCampaignId}/members`).send({ userId: memberUserId, role: 'player' });
    expect(addRes.status).toBe(201);
    expect(addRes.body.id).not.toBe(memberRowId);
  });
});

/**
 * Soft-delete / trash / restore / purge (issue #116). The headline data-safety change:
 * DELETE /campaigns/:id no longer hard-cascades + wipes the disk. It moves the campaign
 * to the trash (rows + on-disk uploads intact, absent from listings, restorable); only
 * the deliberate DELETE /campaigns/:id/purge destroys data and files.
 */
describe('campaign soft-delete + trash/restore/purge (e2e, issue #116)', () => {
  let ctx: TestAppContext;
  let campaignId: number;
  let uploadDir: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    const campRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Trashable Campaign' });
    campaignId = campRes.body.id;
    // Give it an on-disk upload so we can prove files survive a soft-delete and only die on purge.
    const uploadRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/attachments`)
      .set(dm)
      .field('kind', 'image')
      .attach('file', TINY_PNG, { filename: 'keepsake.png', contentType: 'image/png' });
    expect(uploadRes.status).toBe(201);
    uploadDir = path.join(ctx.dataDir, 'uploads', String(campaignId));
    expect(fs.existsSync(uploadDir)).toBe(true);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('DELETE soft-deletes: campaign leaves the list + GET 404s, but rows + uploads survive and it shows in the trash', async () => {
    const server = ctx.app.getHttpServer();

    const del = await request(server).delete(`/api/v1/campaigns/${campaignId}`).set(dm);
    expect(del.status).toBe(200);

    // Absent from the normal listing and GET 404s (indistinguishable from nonexistent).
    const list = await request(server).get('/api/v1/campaigns').set(dm);
    expect(list.body.some((c: { id: number }) => c.id === campaignId)).toBe(false);
    const get = await request(server).get(`/api/v1/campaigns/${campaignId}`).set(dm);
    expect(get.status).toBe(404);

    // But it's in the trash, carrying a deletedAt stamp...
    const trash = await request(server).get('/api/v1/campaigns/trash').set(dm);
    expect(trash.status).toBe(200);
    const trashed = trash.body.find((c: { id: number }) => c.id === campaignId);
    expect(trashed).toBeDefined();
    expect(typeof trashed.deletedAt).toBe('string');

    // ...and the on-disk uploads are untouched (the catastrophic wipe did NOT run).
    expect(fs.existsSync(uploadDir)).toBe(true);
  });

  it('restore brings it back to the list with uploads intact', async () => {
    const server = ctx.app.getHttpServer();

    const restore = await request(server).post(`/api/v1/campaigns/${campaignId}/restore`).set(dm);
    expect(restore.status).toBe(201);
    expect(restore.body.deletedAt).toBeNull();

    const list = await request(server).get('/api/v1/campaigns').set(dm);
    expect(list.body.some((c: { id: number }) => c.id === campaignId)).toBe(true);
    const get = await request(server).get(`/api/v1/campaigns/${campaignId}`).set(dm);
    expect(get.status).toBe(200);
    // No longer in the trash.
    const trash = await request(server).get('/api/v1/campaigns/trash').set(dm);
    expect(trash.body.some((c: { id: number }) => c.id === campaignId)).toBe(false);
    expect(fs.existsSync(uploadDir)).toBe(true);
  });

  it('purge permanently removes the campaign AND wipes its on-disk uploads', async () => {
    const server = ctx.app.getHttpServer();

    // Trash then purge (purge also works on a live campaign, but this mirrors the UI flow).
    await request(server).delete(`/api/v1/campaigns/${campaignId}`).set(dm);
    const purge = await request(server).delete(`/api/v1/campaigns/${campaignId}/purge`).set(dm);
    expect(purge.status).toBe(200);

    // Gone from the trash and the disk directory is removed.
    const trash = await request(server).get('/api/v1/campaigns/trash').set(dm);
    expect(trash.body.some((c: { id: number }) => c.id === campaignId)).toBe(false);
    const get = await request(server).get(`/api/v1/campaigns/${campaignId}`).set(dm);
    expect(get.status).toBe(404);
    expect(fs.existsSync(uploadDir)).toBe(false);
  });
});

/**
 * Entity soft-delete + restore round-trip (issue #116) — a quest here stands in for the
 * shared convention across quests/npcs/locations/sessions/notes/characters: DELETE hides
 * the row from normal reads, POST :id/restore brings it back exactly as it was.
 */
describe('entity soft-delete + restore round-trip (e2e, issue #116)', () => {
  let ctx: TestAppContext;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    const campRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Undo Campaign' });
    campaignId = campRes.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('deleting a quest hides it from GET + list; restore round-trips it back', async () => {
    const server = ctx.app.getHttpServer();
    const q = await request(server).post(`/api/v1/campaigns/${campaignId}/quests`).set(dm).send({ title: 'Reversible Quest' });
    expect(q.status).toBe(201);
    const questId = q.body.id;

    const del = await request(server).delete(`/api/v1/quests/${questId}`).set(dm);
    expect(del.status).toBe(200);

    // Absent from normal reads.
    const getGone = await request(server).get(`/api/v1/quests/${questId}`).set(dm);
    expect(getGone.status).toBe(404);
    const listGone = await request(server).get(`/api/v1/campaigns/${campaignId}/quests`).set(dm);
    expect(listGone.body.some((row: { id: number }) => row.id === questId)).toBe(false);

    // Restore round-trips it.
    const restore = await request(server).post(`/api/v1/quests/${questId}/restore`).set(dm);
    expect(restore.status).toBe(201);
    const getBack = await request(server).get(`/api/v1/quests/${questId}`).set(dm);
    expect(getBack.status).toBe(200);
    expect(getBack.body.title).toBe('Reversible Quest');
    const listBack = await request(server).get(`/api/v1/campaigns/${campaignId}/quests`).set(dm);
    expect(listBack.body.some((row: { id: number }) => row.id === questId)).toBe(true);
  });

  it('restoring a live (non-trashed) quest 404s', async () => {
    const server = ctx.app.getHttpServer();
    const q = await request(server).post(`/api/v1/campaigns/${campaignId}/quests`).set(dm).send({ title: 'Never Trashed' });
    const restore = await request(server).post(`/api/v1/quests/${q.body.id}/restore`).set(dm);
    expect(restore.status).toBe(404);
  });
});

/**
 * Per-campaign Trash — GET /campaigns/:id/trash (issue #269). The soft-delete/undo
 * feature (#116) shipped restore endpoints + an Undo toast, but the toast promised a
 * "campaign Trash" that didn't exist. This endpoint lists a campaign's soft-deleted
 * child entities (sessions/characters/quests/npcs/locations) so they stay recoverable
 * after the toast expires, gated DM-only, and Restore round-trips through it.
 */
describe('per-campaign trash: GET /campaigns/:id/trash (e2e, issue #269)', () => {
  const player = { 'x-dev-role': 'player', 'x-dev-user': 'trash-player' };
  let ctx: TestAppContext;
  let campaignId: number;
  let sessionId: number;
  let characterId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    const campRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Trash Endpoint Campaign' });
    campaignId = campRes.body.id;

    const sess = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/sessions`)
      .set(dm)
      .send({ number: 1, title: 'Doomed Recap' });
    sessionId = sess.body.id;
    const char = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(dm)
      .send({ name: 'Doomed Hero' });
    characterId = char.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('lists soft-deleted entities (type/name/deletedAt) once trashed; empty before any delete', async () => {
    const server = ctx.app.getHttpServer();

    // Nothing deleted yet — the trash is empty.
    const empty = await request(server).get(`/api/v1/campaigns/${campaignId}/trash`).set(dm);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual([]);

    await request(server).delete(`/api/v1/sessions/${sessionId}`).set(dm).expect(200);
    await request(server).delete(`/api/v1/characters/${characterId}`).set(dm).expect(200);

    const trash = await request(server).get(`/api/v1/campaigns/${campaignId}/trash`).set(dm);
    expect(trash.status).toBe(200);
    expect(trash.body).toHaveLength(2);

    const session = trash.body.find((t: { type: string }) => t.type === 'session');
    expect(session).toMatchObject({ type: 'session', id: sessionId, name: 'Doomed Recap' });
    expect(typeof session.deletedAt).toBe('string');

    const character = trash.body.find((t: { type: string }) => t.type === 'character');
    expect(character).toMatchObject({ type: 'character', id: characterId, name: 'Doomed Hero' });
    expect(typeof character.deletedAt).toBe('string');
  });

  it('is DM-only — a non-dm member gets 403', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).get(`/api/v1/campaigns/${campaignId}/trash`).set(player);
    expect(res.status).toBe(403);
  });

  it('restore round-trips: the restored entity leaves the trash and returns to its list', async () => {
    const server = ctx.app.getHttpServer();

    const restore = await request(server).post(`/api/v1/sessions/${sessionId}/restore`).set(dm);
    expect(restore.status).toBe(201);

    // Gone from the trash (only the still-trashed character remains).
    const trash = await request(server).get(`/api/v1/campaigns/${campaignId}/trash`).set(dm);
    expect(trash.body.some((t: { type: string; id: number }) => t.type === 'session' && t.id === sessionId)).toBe(false);
    expect(trash.body.some((t: { type: string; id: number }) => t.type === 'character' && t.id === characterId)).toBe(true);

    // Back in the normal sessions list.
    const list = await request(server).get(`/api/v1/campaigns/${campaignId}/sessions`).set(dm);
    expect(list.body.some((s: { id: number }) => s.id === sessionId)).toBe(true);
  });
});
