import request from 'supertest';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';

/**
 * Issue #587 — the load-bearing negative test.
 *
 * The catalog's entire justification is that an operator can FIND and MANAGE a campaign
 * without being able to READ it. If that second half fails, the feature is worse than
 * not shipping it: a catalog that leaks content launders content access behind an
 * administrative label, and does so at fleet scale, for every campaign at once.
 *
 * So this suite does not check that the catalog hides things it happens to know about.
 * It seeds a DISTINCTIVE MARKER into every content surface the issue names — quests,
 * notes, attachments, session-zero, DM secrets — plus the neighbouring surfaces that
 * would be just as damaging (comments, NPCs, locations, session recaps, scheduled-session
 * titles), then exercises EVERY catalog endpoint as a server admin who is not a member,
 * and asserts that no marker appears ANYWHERE in ANY response body or header.
 *
 * The assertion is deliberately a substring sweep over the serialized response rather
 * than a field-by-field check. A field-by-field check only tests the fields somebody
 * remembered to think about; the sweep catches a leak through a field nobody has
 * invented yet, which is exactly the failure mode an allowlist projection exists to
 * prevent and the one a future refactor is most likely to introduce.
 *
 * Real cookie sessions (not DEV_AUTH) throughout: DEV_AUTH hands every synthetic user
 * `serverRole: 'admin'` AND bypasses campaign role resolution, so it cannot express the
 * one relationship this suite is about — a genuine server admin who is genuinely not a
 * member.
 */
describe('Issue #587: catalog metadata cannot reach campaign content (e2e)', () => {
  let ctx: TestAppContext;
  let server: import('http').Server;
  let admin: ReturnType<typeof request.agent>;
  let dm: ReturnType<typeof request.agent>;
  let dmId: number;
  let campaignId: number;
  let otherCampaignId: number;

  /**
   * Markers seeded into campaign CONTENT. Not one of these may ever appear in a catalog
   * response, under any privacy policy, from any route — they are the campaign's
   * insides. Distinctive enough that a substring match cannot be a coincidence.
   */
  const CONTENT_MARKERS = {
    questTitle: 'ZZ-QUEST-TITLE-ZZ',
    questBody: 'ZZ-QUEST-BODY-ZZ',
    questSecret: 'ZZ-QUEST-DMSECRET-ZZ',
    npcName: 'ZZ-NPC-NAME-ZZ',
    npcSecret: 'ZZ-NPC-DMSECRET-ZZ',
    locationName: 'ZZ-LOCATION-NAME-ZZ',
    locationSecret: 'ZZ-LOCATION-DMSECRET-ZZ',
    sessionTitle: 'ZZ-SESSION-TITLE-ZZ',
    sessionRecap: 'ZZ-SESSION-RECAP-ZZ',
    sessionSecret: 'ZZ-SESSION-DMSECRET-ZZ',
    noteBody: 'ZZ-NOTE-BODY-ZZ',
    commentBody: 'ZZ-COMMENT-BODY-ZZ',
    zeroLine: 'ZZ-SESSIONZERO-LINE-ZZ',
    zeroVeil: 'ZZ-SESSIONZERO-VEIL-ZZ',
    zeroSafety: 'ZZ-SESSIONZERO-SAFETY-ZZ',
    zeroHouseRules: 'ZZ-SESSIONZERO-HOUSERULES-ZZ',
    zeroTone: 'ZZ-SESSIONZERO-TONE-ZZ',
    attachmentFilename: 'ZZ-ATTACHMENT-FILENAME-ZZ.png',
    scheduleTitle: 'ZZ-SCHEDULE-TITLE-ZZ',
    scheduleLocation: 'ZZ-SCHEDULE-LOCATION-ZZ',
    scheduleNotes: 'ZZ-SCHEDULE-NOTES-ZZ',
  } as const;

  /** Privacy-GATED strings — disclosure is a policy decision, not a leak. Tested separately. */
  const CAMPAIGN_NAME = 'ZZ-CAMPAIGN-NAME-ZZ';
  const CAMPAIGN_DESCRIPTION = 'ZZ-CAMPAIGN-DESCRIPTION-ZZ';

  // Minimal valid 1x1 PNG (smallest possible real PNG payload).
  const TINY_PNG = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108020000009077' +
      '53de0000000c4944415408d763f8ffff3f0005fe02fea1399e1e0000000049454e44ae426082',
    'hex',
  );

  /**
   * Serialize a response the way a leak would actually reach an operator: body AND
   * headers. A metadata field that smuggled content into an ETag or a filename header
   * would be just as much of a breach as one in the JSON.
   */
  function serialize(res: request.Response): string {
    return `${JSON.stringify(res.body)}\n${JSON.stringify(res.headers)}\n${res.text ?? ''}`;
  }

  /**
   * Assert no content marker survived into the response.
   *
   * Reports the FIELD NAMES that leaked, never the marker values, and scrubs markers out
   * of the route label too. Some of these routes are search probes whose URL legitimately
   * contains a marker, so a helper that pasted the label or the haystack into its own
   * failure message would fail on its own diagnostics — which is exactly what the first
   * draft of this helper did.
   */
  function expectNoContentMarkers(res: request.Response, label: string): void {
    const haystack = serialize(res);
    const leaked = Object.entries(CONTENT_MARKERS)
      .filter(([, marker]) => haystack.includes(marker))
      .map(([field]) => field);
    const route = label.replace(/ZZ-[A-Z-]+-ZZ(\.png)?/g, '<marker>');
    expect({ route, leaked }).toEqual({ route, leaked: [] });
  }

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    server = ctx.app.getHttpServer();

    admin = request.agent(server);
    const setup = await admin
      .post('/api/v1/auth/setup')
      .send({ username: 'cat-admin', password: 'admin-password-1' });
    expect(setup.status).toBe(201);

    const created = await admin
      .post('/api/v1/users')
      .send({ username: 'cat-dm', password: 'dm-password-1', serverRole: 'user' });
    expect(created.status).toBe(201);
    dmId = created.body.id;
    dm = request.agent(server);
    const login = await dm.post('/api/v1/auth/login').send({ username: 'cat-dm', password: 'dm-password-1' });
    expect(login.status).toBe(201);

    const camp = await dm
      .post('/api/v1/campaigns')
      .send({ name: CAMPAIGN_NAME, description: CAMPAIGN_DESCRIPTION });
    expect(camp.status).toBe(201);
    campaignId = camp.body.id;

    // A second campaign so list assertions are about the catalog, not about there being
    // only one row to get right.
    const other = await dm.post('/api/v1/campaigns').send({ name: 'Ordinary Neighbour Table' });
    expect(other.status).toBe(201);
    otherCampaignId = other.body.id;

    // ---- seed a marker into every content surface the acceptance criterion names ----

    const quest = await dm.post(`/api/v1/campaigns/${campaignId}/quests`).send({
      title: CONTENT_MARKERS.questTitle,
      body: CONTENT_MARKERS.questBody,
      dmSecret: CONTENT_MARKERS.questSecret,
      hidden: false,
    });
    expect(quest.status).toBe(201);

    const npc = await dm.post(`/api/v1/campaigns/${campaignId}/npcs`).send({
      name: CONTENT_MARKERS.npcName,
      dmSecret: CONTENT_MARKERS.npcSecret,
      hidden: false,
    });
    expect(npc.status).toBe(201);

    const location = await dm.post(`/api/v1/campaigns/${campaignId}/locations`).send({
      name: CONTENT_MARKERS.locationName,
      dmSecret: CONTENT_MARKERS.locationSecret,
    });
    expect(location.status).toBe(201);

    const session = await dm.post(`/api/v1/campaigns/${campaignId}/sessions`).send({
      title: CONTENT_MARKERS.sessionTitle,
      recap: CONTENT_MARKERS.sessionRecap,
      dmSecret: CONTENT_MARKERS.sessionSecret,
    });
    expect(session.status).toBe(201);
    const sessionId = session.body.id;

    const note = await dm
      .post(`/api/v1/campaigns/${campaignId}/notes`)
      .send({ body: CONTENT_MARKERS.noteBody, visibility: 'private' });
    expect(note.status).toBe(201);

    const comment = await dm
      .post(`/api/v1/campaigns/${campaignId}/comments`)
      .send({ entityType: 'session', entityId: sessionId, body: CONTENT_MARKERS.commentBody });
    expect(comment.status).toBe(201);

    const zero = await dm.put(`/api/v1/campaigns/${campaignId}/session-zero`).send({
      lines: [CONTENT_MARKERS.zeroLine],
      veils: [CONTENT_MARKERS.zeroVeil],
      safetyTools: [CONTENT_MARKERS.zeroSafety],
      houseRules: CONTENT_MARKERS.zeroHouseRules,
      toneAndExpectations: CONTENT_MARKERS.zeroTone,
    });
    expect(zero.status).toBe(200);

    const schedule = await dm.post(`/api/v1/campaigns/${campaignId}/schedule`).send({
      scheduledAt: '2099-06-01T19:30:00Z',
      title: CONTENT_MARKERS.scheduleTitle,
      location: CONTENT_MARKERS.scheduleLocation,
      notes: CONTENT_MARKERS.scheduleNotes,
    });
    expect(schedule.status).toBe(201);

    const upload = await dm
      .post(`/api/v1/campaigns/${campaignId}/attachments`)
      .field('kind', 'map')
      .attach('file', TINY_PNG, { filename: CONTENT_MARKERS.attachmentFilename, contentType: 'image/png' });
    expect(upload.status).toBe(201);
    expect(upload.body.filename).toBe(CONTENT_MARKERS.attachmentFilename);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  // -------------------------------------------------------------------------
  // The control: the admin really is an outsider. Without this, every assertion
  // below could pass simply because the seeding failed.
  // -------------------------------------------------------------------------

  describe('the admin under test is genuinely not a member', () => {
    it('cannot read the campaign or any of its content through the ordinary routes', async () => {
      for (const path of [
        '',
        '/quests',
        '/npcs',
        '/locations',
        '/sessions',
        '/notes',
        '/session-zero',
        '/schedule',
        '/attachments',
        '/export',
      ]) {
        const res = await admin.get(`/api/v1/campaigns/${campaignId}${path}`);
        expect([403, 404]).toContain(res.status);
        expectNoContentMarkers(res, `GET /campaigns/:id${path}`);
      }
    });

    it('is not offered the campaign by the member-scoped campaign list', async () => {
      const res = await admin.get('/api/v1/campaigns');
      expect(res.status).toBe(200);
      expect(res.body.some((c: { id: number }) => c.id === campaignId)).toBe(false);
    });

    it('is nevertheless a real server admin', async () => {
      const res = await admin.get('/api/v1/settings');
      expect(res.status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // THE acceptance criterion.
  // -------------------------------------------------------------------------

  describe('no catalog endpoint returns campaign content', () => {
    it('the catalog LIST discloses no quest, note, comment, attachment, session-zero or DM secret', async () => {
      const res = await admin.get('/api/v1/admin/campaigns').query({ limit: 100 });
      expect(res.status).toBe(200);
      // Prove the campaign really is in the response — otherwise "no markers" is vacuous.
      expect(res.body.items.some((c: { id: number }) => c.id === campaignId)).toBe(true);
      expectNoContentMarkers(res, 'GET /admin/campaigns');
    });

    it('the single-entry READ discloses none of it either', async () => {
      const res = await admin.get(`/api/v1/admin/campaigns/${campaignId}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(campaignId);
      expectNoContentMarkers(res, 'GET /admin/campaigns/:id');
    });

    it('discloses none of it through any sort order', async () => {
      for (const sort of ['name', 'status', 'storage', 'activity', 'nextSession', 'created', 'id']) {
        for (const order of ['asc', 'desc']) {
          const res = await admin.get('/api/v1/admin/campaigns').query({ sort, order, limit: 100 });
          expect(res.status).toBe(200);
          expectNoContentMarkers(res, `GET /admin/campaigns?sort=${sort}&order=${order}`);
        }
      }
    });

    it('discloses none of it through any filter, including ones that select the seeded campaign', async () => {
      const filters: Array<Record<string, string | number>> = [
        { status: 'active' },
        { trashed: 'false' },
        { minStorageBytes: 0 },
        { overQuota: 'false' },
        { moduleInstalled: 'false' },
        { primaryDmUserId: dmId },
        { nextSessionBefore: '2100-01-01T00:00:00.000Z' },
        { nextSessionAfter: '2000-01-01T00:00:00.000Z' },
        { activityAfter: '2000-01-01T00:00:00.000Z' },
        { ruleSystem: '' },
      ];
      for (const filter of filters) {
        const res = await admin.get('/api/v1/admin/campaigns').query({ ...filter, limit: 100 });
        expect(res.status).toBe(200);
        expectNoContentMarkers(res, `GET /admin/campaigns?${JSON.stringify(filter)}`);
      }
    });

    it('cannot be coaxed into echoing content by searching for it', async () => {
      // A naive implementation that echoed the query, or that searched content tables,
      // would fail here even though the projection itself was clean.
      for (const marker of Object.values(CONTENT_MARKERS)) {
        const res = await admin.get('/api/v1/admin/campaigns').query({ q: marker, limit: 100 });
        expect(res.status).toBe(200);
        // The search must not MATCH on content either: finding a campaign by its quest
        // text would confirm that text exists, which is a leak of exactly one bit at a
        // time and therefore a leak.
        expect(res.body.items.some((c: { id: number }) => c.id === campaignId)).toBe(false);
        expectNoContentMarkers(res, `GET /admin/campaigns?q=${marker}`);
      }
    });

    it('discloses none of it through the privacy policy or export-request routes', async () => {
      const policy = await admin.get('/api/v1/admin/campaigns/privacy');
      expect(policy.status).toBe(200);
      expectNoContentMarkers(policy, 'GET /admin/campaigns/privacy');

      const requests = await admin.get('/api/v1/admin/campaigns/export-requests');
      expect(requests.status).toBe(200);
      expectNoContentMarkers(requests, 'GET /admin/campaigns/export-requests');
    });

    it('discloses none of it through a bulk dry run or a real bulk run', async () => {
      const dryRun = await admin.post('/api/v1/admin/campaigns/bulk').send({
        operation: 'pause',
        campaignIds: [campaignId, otherCampaignId],
        dryRun: true,
      });
      expect(dryRun.status).toBe(201);
      expectNoContentMarkers(dryRun, 'POST /admin/campaigns/bulk (dry run)');

      const real = await admin.post('/api/v1/admin/campaigns/bulk').send({
        operation: 'pause',
        campaignIds: [campaignId],
        dryRun: false,
        reason: 'isolation spec',
      });
      expect(real.status).toBe(201);
      expectNoContentMarkers(real, 'POST /admin/campaigns/bulk (real)');

      // Put it back so later tests see an active campaign.
      const restore = await admin.post('/api/v1/admin/campaigns/bulk').send({
        operation: 'activate',
        campaignIds: [campaignId],
        dryRun: false,
        reason: 'isolation spec restore',
      });
      expect(restore.status).toBe(201);
    });

    it('has no admin route that produces a campaign export', async () => {
      // `request_export` records an ASK. If it ever starts returning a bundle, every
      // marker above ships to the requester in one call — so this is pinned explicitly
      // rather than left as an implementation detail.
      const res = await admin.post('/api/v1/admin/campaigns/bulk').send({
        operation: 'request_export',
        campaignIds: [campaignId],
        dryRun: false,
        exportProfile: 'backup',
        reason: 'operator needs an archive for the season rollover',
      });
      expect(res.status).toBe(201);
      expect(res.body.applied).toBe(1);
      expectNoContentMarkers(res, 'POST /admin/campaigns/bulk (request_export)');

      const listed = await admin.get('/api/v1/admin/campaigns/export-requests');
      expect(listed.status).toBe(200);
      expect(listed.body.length).toBeGreaterThan(0);
      expectNoContentMarkers(listed, 'GET /admin/campaigns/export-requests after request');

      // And the DM-gated export route stays closed to the admin even after asking.
      const exportAttempt = await admin.get(`/api/v1/campaigns/${campaignId}/export`);
      expect([403, 404]).toContain(exportAttempt.status);
      expectNoContentMarkers(exportAttempt, 'GET /campaigns/:id/export as non-member admin');
    });
  });

  // -------------------------------------------------------------------------
  // Privacy for names and descriptions (acceptance criterion 4).
  // -------------------------------------------------------------------------

  describe('configurable privacy for names and descriptions', () => {
    async function entry() {
      const res = await admin.get(`/api/v1/admin/campaigns/${campaignId}`);
      expect(res.status).toBe(200);
      return res.body;
    }

    it('withholds descriptions by default while disclosing names', async () => {
      const row = await entry();
      expect(row.name).toBe(CAMPAIGN_NAME);
      expect(row.nameRedacted).toBe(false);
      expect(row.description).toBe('');
      expect(row.descriptionRedacted).toBe(true);
    });

    it('lets the DM withhold the name too, with a non-identifying placeholder', async () => {
      const set = await dm
        .put(`/api/v1/campaigns/${campaignId}/catalog/privacy`)
        .send({ catalogPrivacy: 'redacted' });
      expect(set.status).toBe(200);
      expect(set.body.effective).toEqual({ names: 'redacted', descriptions: 'redacted' });

      const row = await entry();
      expect(row.nameRedacted).toBe(true);
      // Non-identifying, but still distinguishable and actionable.
      expect(row.name).toBe(`Campaign #${campaignId}`);
      expect(row.name).not.toContain(CAMPAIGN_NAME);
      expect(row.description).toBe('');
    });

    it('does not let search recover a withheld name by probing substrings', async () => {
      // The campaign is still redacted from the previous test.
      for (const probe of [CAMPAIGN_NAME, CAMPAIGN_NAME.slice(0, 8), CAMPAIGN_DESCRIPTION]) {
        const res = await admin.get('/api/v1/admin/campaigns').query({ q: probe, limit: 100 });
        expect(res.status).toBe(200);
        expect(res.body.items.some((c: { id: number }) => c.id === campaignId)).toBe(false);
      }
      // …while the id, which the row discloses anyway, still finds it.
      const byId = await admin.get('/api/v1/admin/campaigns').query({ q: String(campaignId), limit: 100 });
      expect(byId.status).toBe(200);
      expect(byId.body.items.some((c: { id: number }) => c.id === campaignId)).toBe(true);
    });

    it('never lets a server admin clear a campaign\'s own opt-out', async () => {
      // There is deliberately no admin route for this column, and the bulk enum has no
      // verb that reaches it. Both of the plausible attempts must fail.
      const viaBulk = await admin.post('/api/v1/admin/campaigns/bulk').send({
        operation: 'set_policy',
        campaignIds: [campaignId],
        dryRun: false,
        catalogPrivacy: 'inherit',
      });
      expect(viaBulk.status).toBe(400); // `catalogPrivacy` is not a recognized bulk key

      const viaCampaignRoute = await admin
        .put(`/api/v1/campaigns/${campaignId}/catalog/privacy`)
        .send({ catalogPrivacy: 'inherit' });
      expect(viaCampaignRoute.status).toBe(403);

      // Still redacted.
      const row = await entry();
      expect(row.nameRedacted).toBe(true);
    });

    it('lets the DM restore disclosure, and honours a restrictive server default over it', async () => {
      const restore = await dm
        .put(`/api/v1/campaigns/${campaignId}/catalog/privacy`)
        .send({ catalogPrivacy: 'inherit' });
      expect(restore.status).toBe(200);
      expect((await entry()).nameRedacted).toBe(false);

      // Server-wide tightening applies even to campaigns that did not opt out.
      const policy = await admin.put('/api/v1/admin/campaigns/privacy').send({ names: 'redacted' });
      expect(policy.status).toBe(200);
      expect(policy.body.names).toBe('redacted');
      expect((await entry()).nameRedacted).toBe(true);

      // And `inherit` cannot override it back toward disclosure.
      const tryLoosen = await dm
        .put(`/api/v1/campaigns/${campaignId}/catalog/privacy`)
        .send({ catalogPrivacy: 'inherit' });
      expect(tryLoosen.status).toBe(200);
      expect(tryLoosen.body.effective.names).toBe('redacted');
      expect((await entry()).nameRedacted).toBe(true);

      // Reset for any later test.
      const reset = await admin.put('/api/v1/admin/campaigns/privacy').send({ names: 'visible' });
      expect(reset.status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // Audit (acceptance criterion 5) — browsing is a privileged read.
  // -------------------------------------------------------------------------

  describe('catalog ACCESS is audited, not just operations', () => {
    it('records the listing itself, with the slice that was returned', async () => {
      const res = await admin.get('/api/v1/admin/campaigns').query({ limit: 5, sort: 'storage', order: 'desc' });
      expect(res.status).toBe(200);

      const audit = await admin.get('/api/v1/admin/audit').query({ limit: 50 });
      expect(audit.status).toBe(200);
      const rows = Array.isArray(audit.body) ? audit.body : audit.body.items;
      const listRow = rows.find((r: { action: string }) => r.action === 'campaign.catalog.list');
      expect(listRow).toBeDefined();
      expect(listRow.detail).toContain('sort=storage:desc');
      expect(listRow.detail).toContain('limit=5');
    });

    it("records a single-entry read in the campaign's OWN trail, so the campaign can see it", async () => {
      await admin.get(`/api/v1/admin/campaigns/${campaignId}`);
      const audit = await dm.get(`/api/v1/campaigns/${campaignId}/audit`).query({ limit: 50 });
      expect(audit.status).toBe(200);
      const rows = Array.isArray(audit.body) ? audit.body : audit.body.items;
      expect(rows.some((r: { action: string }) => r.action === 'campaign.catalog.read')).toBe(true);
    });
  });
});
