import request from 'supertest';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';
import { McpToolsService } from '../src/modules/mcp/mcp-tools';

/**
 * Issue #600 — the consent lifecycle end to end, plus the two privacy properties.
 *
 * Real cookie sessions throughout, not DEV_AUTH: the whole feature turns on WHO agreed to
 * WHAT, and `dev:*` principals have no membership rows, so a DEV_AUTH campaign has an
 * empty required-acknowledger set and every gate clears vacuously. That degradation is
 * correct for dev mode and useless for testing the gate.
 *
 * Cast:
 *   dm      — publishes charter versions.
 *   player  — a seated player whose acknowledgment the gate depends on.
 *   joiner  — arrives via an invite link and must see the boundaries before joining.
 *   outsider— holds the invite code but never joins; stands in for "anyone with the link".
 */
describe('Issue #600: session-zero consent lifecycle (e2e)', () => {
  let ctx: TestAppContext;
  let server: import('http').Server;
  let dm: ReturnType<typeof request.agent>;
  let player: ReturnType<typeof request.agent>;
  let joiner: ReturnType<typeof request.agent>;
  let playerId: number;
  let campaignId: number;

  const API = '/api/v1';

  /** Distinctive markers, so a leak is never a coincidence. */
  const M = {
    line: 'ZZ-LINE-HARM-TO-CHILDREN-ZZ',
    line2: 'ZZ-LINE-SEXUAL-VIOLENCE-ZZ',
    veil: 'ZZ-VEIL-ON-SCREEN-TORTURE-ZZ',
    tool: 'ZZ-TOOL-X-CARD-ZZ',
    houseRules: 'ZZ-HOUSERULES-INSPIRATION-ZZ',
    tone: 'ZZ-TONE-GRITTY-ZZ',
    privateBoundary: 'ZZ-PRIVATE-BOUNDARY-ZZ',
    anonBoundary: 'ZZ-ANONYMOUS-BOUNDARY-ZZ',
    guardianName: 'ZZ-GUARDIAN-NAME-ZZ',
    guardianEmail: 'zz-guardian@example.test',
  } as const;

  async function newUser(username: string, password: string) {
    const created = await dm.post(`${API}/users`).send({ username, password, serverRole: 'user' });
    expect(created.status).toBe(201);
    const agent = request.agent(server);
    const login = await agent.post(`${API}/auth/login`).send({ username, password });
    expect(login.status).toBe(201);
    return { agent, id: created.body.id as number };
  }

  /** Replace the DM's working draft. */
  async function setDraft(fields: Record<string, unknown>) {
    const res = await dm.put(`${API}/campaigns/${campaignId}/session-zero`).send(fields);
    expect(res.status).toBe(200);
    return res.body;
  }

  async function publish(changeSummary = '') {
    return dm.post(`${API}/campaigns/${campaignId}/session-zero/versions`).send({ changeSummary });
  }

  async function consentStatus(agent: ReturnType<typeof request.agent>) {
    const res = await agent.get(`${API}/campaigns/${campaignId}/session-zero/consent`);
    expect(res.status).toBe(200);
    return res.body;
  }

  async function makeInvite(role: 'player' | 'viewer' = 'player') {
    const res = await dm.post(`${API}/campaigns/${campaignId}/invites`).send({ role });
    expect(res.status).toBe(201);
    return res.body.code as string;
  }

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    server = ctx.app.getHttpServer();

    dm = request.agent(server);
    const setup = await dm.post(`${API}/auth/setup`).send({ username: 'sz-dm', password: 'dm-password-1' });
    expect(setup.status).toBe(201);

    const p = await newUser('sz-player', 'player-password-1');
    player = p.agent;
    playerId = p.id;
    const j = await newUser('sz-joiner', 'joiner-password-1');
    joiner = j.agent;

    const camp = await dm.post(`${API}/campaigns`).send({ name: 'Consent Table' });
    expect(camp.status).toBe(201);
    campaignId = camp.body.id;

    const seat = await dm.post(`${API}/campaigns/${campaignId}/members`).send({ userId: playerId, role: 'player' });
    expect(seat.status).toBe(201);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  // -------------------------------------------------------------------------
  // Immutable versions
  // -------------------------------------------------------------------------

  describe('publishing immutable versions', () => {
    it('refuses to publish an empty charter', async () => {
      const res = await publish();
      expect(res.status).toBe(400);
    });

    it('publishes v1 from the draft, and v1 is non-material (nothing was withdrawn)', async () => {
      await setDraft({
        lines: [M.line, M.line2],
        veils: [M.veil],
        safetyTools: [M.tool],
        houseRules: M.houseRules,
        toneAndExpectations: M.tone,
      });
      const res = await publish('first charter');
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ version: 1, material: false, changeSummary: 'first charter' });
      expect(res.body.lines).toEqual([M.line, M.line2]);
    });

    it('refuses to publish again when the draft is unchanged', async () => {
      const res = await publish();
      expect(res.status).toBe(400);
    });

    it('does not mutate v1 when the draft is edited afterwards', async () => {
      // THE immutability property. Editing the draft must not reach back into the
      // snapshot somebody already agreed to.
      await setDraft({ lines: [M.line, M.line2, 'Animal cruelty'] });
      const versions = await dm.get(`${API}/campaigns/${campaignId}/session-zero/versions`);
      expect(versions.status).toBe(200);
      const v1 = versions.body.find((v: { version: number }) => v.version === 1);
      expect(v1.lines).toEqual([M.line, M.line2]);
    });

    it('publishes an ADDITION as non-material — a stricter charter needs no re-consent', async () => {
      const res = await publish('added a line');
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ version: 2, material: false });
    });

    it('makes the opening charter effective once every required participant acknowledges', async () => {
      // The unit resolver and the AI-binding path agree: a published-but-unacked first
      // version is NOT effective (and must not fall back to the mutable draft). Acknowledge
      // v2 here so the material-gate tests below start from a licensed table on v2.
      const versions = await dm.get(`${API}/campaigns/${campaignId}/session-zero/versions`);
      expect(versions.status).toBe(200);
      const v2 = versions.body.find((v: { version: number }) => v.version === 2);
      expect(v2).toBeDefined();

      for (const agent of [dm, player]) {
        const ack = await agent
          .post(`${API}/campaigns/${campaignId}/session-zero/consent`)
          .send({ versionId: v2.id, state: 'acknowledged' });
        expect(ack.status).toBe(201);
      }

      const status = await consentStatus(dm);
      expect(status.effectiveVersion?.version).toBe(2);
      expect(status.awaitingRenewal).toBe(false);
    });

    it('publishes a REMOVAL as material', async () => {
      await setDraft({ lines: [M.line, 'Animal cruelty'] }); // M.line2 withdrawn
      const res = await publish('dropped a line');
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ version: 3, material: true });
    });
  });

  // -------------------------------------------------------------------------
  // The consent gate
  // -------------------------------------------------------------------------

  describe('the consent gate', () => {
    it('holds the effective version back at the last fully-acknowledged one', async () => {
      const status = await consentStatus(dm);
      expect(status.latestVersion.version).toBe(3);
      expect(status.awaitingRenewal).toBe(true);
      // v3 is material and unacknowledged, so the table is still on v2.
      expect(status.effectiveVersion?.version).toBe(2);
      expect(status.diff).toMatchObject({ fromVersion: 2, toVersion: 3, material: true });
      expect(status.diff.removedLines).toContain(M.line2);
    });

    it('names exactly who is holding the gate', async () => {
      const status = await consentStatus(dm);
      const outstanding = status.outstanding.map((o: { userId: string }) => o.userId).sort();
      expect(outstanding).toEqual([String(playerId), status.outstanding.find((o: { userId: string }) => o.userId !== String(playerId))?.userId].sort());
      expect(status.outstanding.length).toBe(2); // the DM and the player both play
    });

    it('does not advance on a partial acknowledgment', async () => {
      const latest = (await consentStatus(dm)).latestVersion;
      const ack = await dm
        .post(`${API}/campaigns/${campaignId}/session-zero/consent`)
        .send({ versionId: latest.id, state: 'acknowledged' });
      expect(ack.status).toBe(201);
      expect((await consentStatus(dm)).effectiveVersion?.version).toBe(2);
    });

    it('treats discuss as NOT consenting, and requires a note', async () => {
      const latest = (await consentStatus(player)).latestVersion;
      const bare = await player
        .post(`${API}/campaigns/${campaignId}/session-zero/consent`)
        .send({ versionId: latest.id, state: 'discuss' });
      expect(bare.status).toBe(400);

      const withNote = await player
        .post(`${API}/campaigns/${campaignId}/session-zero/consent`)
        .send({ versionId: latest.id, state: 'discuss', note: 'I want that line back.' });
      expect(withNote.status).toBe(201);
      expect((await consentStatus(dm)).effectiveVersion?.version).toBe(2);
    });

    it('advances once every required participant acknowledges', async () => {
      const latest = (await consentStatus(player)).latestVersion;
      const ack = await player
        .post(`${API}/campaigns/${campaignId}/session-zero/consent`)
        .send({ versionId: latest.id, state: 'acknowledged' });
      expect(ack.status).toBe(201);

      const status = await consentStatus(dm);
      expect(status.effectiveVersion?.version).toBe(3);
      expect(status.awaitingRenewal).toBe(false);
      expect(status.outstanding).toEqual([]);
      expect(status.diff).toBeNull();
    });

    it('records a decline and re-closes the gate', async () => {
      const latest = (await consentStatus(player)).latestVersion;
      const declined = await player
        .post(`${API}/campaigns/${campaignId}/session-zero/consent`)
        .send({ versionId: latest.id, state: 'declined', note: 'Not for me.' });
      expect(declined.status).toBe(201);
      expect(declined.body.state).toBe('declined');
      expect((await consentStatus(dm)).effectiveVersion?.version).toBe(2);

      // …and re-acknowledging reopens it, updating the same record rather than adding one.
      await player
        .post(`${API}/campaigns/${campaignId}/session-zero/consent`)
        .send({ versionId: latest.id, state: 'acknowledged' });
      expect((await consentStatus(dm)).effectiveVersion?.version).toBe(3);
    });

    it('does not let a cosmetic follow-up publish launder an unacknowledged withdrawal', async () => {
      await setDraft({ veils: [] }); // withdraw the veil -> material v4
      const v4 = await publish('withdrew a veil');
      expect(v4.body).toMatchObject({ version: 4, material: true });

      await setDraft({ toneAndExpectations: `${M.tone} (tidied)` }); // cosmetic v5
      const v5 = await publish('wording');
      expect(v5.body).toMatchObject({ version: 5, material: false });

      // v5's own diff is innocuous, but it still contains v4's withdrawal.
      expect((await consentStatus(dm)).effectiveVersion?.version).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // AI is bound by the ACCEPTED version
  // -------------------------------------------------------------------------

  describe('AI uses the accepted effective version', () => {
    it('serves the accepted version, not the newer unacknowledged one, nor the draft', async () => {
      // `effectiveSessionZero` is what the get_session_zero MCP tool returns, and
      // get_session_zero is the single read the Driver, the co-DM, Scribe and every
      // external MCP client go through. Asserted against the real service resolved from
      // the running app, so this exercises the actual code path rather than re-deriving
      // the answer next to it.
      const mcpTools = ctx.app.get(McpToolsService);
      const charter = await mcpTools.effectiveSessionZero(campaignId);

      // The table is on v3: v4 withdrew the veil and v5 is a cosmetic follow-up, and
      // neither has been acknowledged. So the model must STILL be told about the veil —
      // the protection has not been consented away yet.
      expect(charter.charterSource).toBe('accepted');
      expect(charter.charterVersion).toBe(3);
      expect(charter.veils).toContain(M.veil);

      // The veil assertion above is precisely the draft-vs-accepted distinction: the
      // DM's working draft has veils: [] (it was emptied to publish v4), so a model
      // reading the draft — or reading the newest version — would not be told about the
      // veil at all. Only the accepted version still carries it.
      const draft = await dm.get(`${API}/campaigns/${campaignId}/session-zero`);
      expect(draft.body.veils).toEqual([]);
    });

    it('falls back to the draft for a campaign that never published, so pre-#600 tables are unchanged', async () => {
      const fresh = await dm.post(`${API}/campaigns`).send({ name: 'Never Published' });
      expect(fresh.status).toBe(201);
      const freshId = fresh.body.id as number;
      await dm.put(`${API}/campaigns/${freshId}/session-zero`).send({ lines: ['Draft only line'] });

      const charter = await ctx.app.get(McpToolsService).effectiveSessionZero(freshId);
      expect(charter.charterSource).toBe('draft');
      expect(charter.charterVersion).toBe(0);
      expect(charter.lines).toContain('Draft only line');
    });

    it('does not fall back to the mutable draft when a charter is published but not yet licensed', async () => {
      const fresh = await dm.post(`${API}/campaigns`).send({ name: 'Published Unbound' });
      expect(fresh.status).toBe(201);
      const freshId = fresh.body.id as number;
      await dm.put(`${API}/campaigns/${freshId}/session-zero`).send({
        lines: ['Draft line the AI must not see unbound'],
        veils: [M.veil],
        safetyTools: [M.tool],
      });
      const published = await dm.post(`${API}/campaigns/${freshId}/session-zero/versions`).send({ changeSummary: 'v1' });
      expect(published.status).toBe(201);

      // Loosen the draft AFTER publish — the exact failure mode this guards against.
      await dm.put(`${API}/campaigns/${freshId}/session-zero`).send({
        lines: ['Draft line the AI must not see unbound'],
        veils: [],
        safetyTools: [M.tool],
      });

      const charter = await ctx.app.get(McpToolsService).effectiveSessionZero(freshId);
      expect(charter.charterSource).toBe('none');
      expect(charter.charterVersion).toBe(0);
      expect(charter.lines).toEqual([]);
      expect(charter.veils).toEqual([]);
    });

    it('keeps the AI on the last agreed charter when a new player is seated without acknowledging', async () => {
      // Table is on accepted v3 (consent-gate tests above re-acked after the decline).
      // Seating a brand-new player via POST /members must not collapse the AI onto the
      // mutable draft (which currently has veils: [] from the v4 publish).
      const newbie = await newUser('sz-newbie', 'newbie-password-1');
      const seat = await dm
        .post(`${API}/campaigns/${campaignId}/members`)
        .send({ userId: newbie.id, role: 'player' });
      expect(seat.status).toBe(201);

      const status = await consentStatus(dm);
      // UI gate correctly shows the newcomer as outstanding against latest.
      expect(status.outstanding.some((o: { userId: string }) => o.userId === String(newbie.id))).toBe(true);

      const charter = await ctx.app.get(McpToolsService).effectiveSessionZero(campaignId);
      expect(charter.charterSource).toBe('accepted');
      // Sticky agreement: still the last version the existing table licensed (v3), which
      // still carries the veil the draft has since withdrawn.
      expect(charter.charterVersion).toBe(3);
      expect(charter.veils).toContain(M.veil);
    });
  });

  // -------------------------------------------------------------------------
  // Pre-join preview + decline
  // -------------------------------------------------------------------------

  describe('pre-join preview', () => {
    let code: string;

    beforeAll(async () => {
      code = await makeInvite('player');
    });

    it('shows the boundaries to an UNAUTHENTICATED viewer holding the link', async () => {
      const anon = request.agent(server);
      const res = await anon.get(`${API}/invites/${code}`);
      expect(res.status).toBe(200);
      expect(res.body.consentRequired).toBe(true);
      expect(res.body.charter.lines).toContain(M.line);
      expect(res.body.charter.safetyTools).toContain(M.tool);
      expect(res.body.charter.aiExternalContentPolicy).toBeDefined();
    });

    it('withholds the prose fields under the default boundaries-only policy', async () => {
      const anon = request.agent(server);
      const res = await anon.get(`${API}/invites/${code}`);
      expect(res.body.charter.previewPolicy).toBe('boundaries');
      expect(res.body.charter.houseRules).toBe('');
      expect(res.body.charter.toneAndExpectations).toBe('');
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain(M.houseRules);
      expect(serialized).not.toContain(M.tone);
    });

    it('discloses the prose only when the DM opts into the full policy', async () => {
      const set = await dm
        .put(`${API}/campaigns/${campaignId}/session-zero/preview-policy`)
        .send({ previewPolicy: 'full' });
      expect(set.status).toBe(200);

      const anon = request.agent(server);
      const res = await anon.get(`${API}/invites/${code}`);
      expect(res.body.charter.houseRules).toContain(M.houseRules);

      await dm.put(`${API}/campaigns/${campaignId}/session-zero/preview-policy`).send({ previewPolicy: 'boundaries' });
    });

    it('shows the LATEST published version, never the unpublished draft', async () => {
      const secret = 'ZZ-DRAFT-ONLY-NOT-PUBLISHED-ZZ';
      await setDraft({ lines: [M.line, secret] });

      const anon = request.agent(server);
      const res = await anon.get(`${API}/invites/${code}`);
      expect(JSON.stringify(res.body)).not.toContain(secret);
    });

    it('never leaks private boundary submissions, member names, or campaign content', async () => {
      const submitted = await player
        .post(`${API}/campaigns/${campaignId}/session-zero/boundaries`)
        .send({ kind: 'line', text: M.privateBoundary, anonymous: false });
      expect(submitted.status).toBe(201);

      const anon = request.agent(server);
      const res = await anon.get(`${API}/invites/${code}`);
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain(M.privateBoundary);
      expect(serialized).not.toContain('sz-player');
      expect(serialized).not.toContain('sz-dm');

      // Structural rather than a substring sweep: a bare numeric user id is only a few
      // digits and matches incidentally inside timestamps and version numbers, so
      // searching for it proves nothing either way. Pin the SHAPE instead — the preview
      // is an enumerated projection, so anything that could identify a person would have
      // to arrive as a key that is not on these lists.
      // `permissions` (issue #597) belongs on this list because it is derived purely from
      // the invite's role — effectivePermissionsFor(role, false) — so it carries no
      // per-person state and cannot identify a member. It still has to be enumerated here:
      // the point of the assertion is that a NEW key is a deliberate decision rather than a
      // silent addition.
      expect(Object.keys(res.body).sort()).toEqual(
        [
          'campaignId',
          'campaignName',
          'charter',
          'consentRequired',
          'expiresAt',
          'permissions',
          'role',
        ].sort(),
      );
      expect(Object.keys(res.body.charter).sort()).toEqual(
        [
          'aiExternalContentPolicy',
          'houseRules',
          'lines',
          'previewPolicy',
          'publishedAt',
          'safetyTools',
          'toneAndExpectations',
          'veils',
          'version',
        ].sort(),
      );
    });
  });

  describe('joining is gated on acknowledgment', () => {
    let code: string;

    beforeAll(async () => {
      code = await makeInvite('player');
    });

    it('refuses a join that does not name the charter version', async () => {
      const res = await joiner.post(`${API}/invites/${code}/join`).send({});
      expect(res.status).toBe(409);
    });

    it('refuses a join naming a STALE version', async () => {
      const versions = await dm.get(`${API}/campaigns/${campaignId}/session-zero/versions`);
      const oldest = versions.body[versions.body.length - 1];
      const res = await joiner.post(`${API}/invites/${code}/join`).send({ acknowledgeVersion: oldest.version });
      expect(res.status).toBe(409);
    });

    it('records a decline WITHOUT creating a membership', async () => {
      const res = await joiner.post(`${API}/invites/${code}/decline`).send({ note: 'A line I need is missing.' });
      expect(res.status).toBe(201);
      expect(res.body.recorded).toBe(true);

      // Still not a member.
      const campaigns = await joiner.get(`${API}/campaigns`);
      expect(campaigns.body.some((c: { id: number }) => c.id === campaignId)).toBe(false);
    });

    it('admits a joiner who acknowledges the current version, and records the acknowledgment', async () => {
      const preview = await joiner.get(`${API}/invites/${code}`);
      expect(preview.body.consentRequired).toBe(true);
      // The preview carries the per-campaign version NUMBER, never the internal row id —
      // the join gate is expressed in exactly what an unauthenticated caller was shown.
      const version = preview.body.charter.version as number;

      const res = await joiner.post(`${API}/invites/${code}/join`).send({ acknowledgeVersion: version });
      expect(res.status).toBe(201);

      const status = await consentStatus(joiner);
      expect(status.mine).toMatchObject({ state: 'acknowledged', version });
    });
  });

  // -------------------------------------------------------------------------
  // Private boundaries
  // -------------------------------------------------------------------------

  describe('private boundary submissions', () => {
    it('is visible to the facilitator but not to other participants', async () => {
      const dmView = await dm.get(`${API}/campaigns/${campaignId}/session-zero/boundaries`);
      expect(dmView.status).toBe(200);
      expect(JSON.stringify(dmView.body)).toContain(M.privateBoundary);

      const joinerView = await joiner.get(`${API}/campaigns/${campaignId}/session-zero/boundaries`);
      expect(joinerView.status).toBe(200);
      expect(JSON.stringify(joinerView.body)).not.toContain(M.privateBoundary);
    });

    it('drops the submitter from an ANONYMOUS submission server-side', async () => {
      const created = await player
        .post(`${API}/campaigns/${campaignId}/session-zero/boundaries`)
        .send({ kind: 'veil', text: M.anonBoundary, anonymous: true });
      expect(created.status).toBe(201);

      const dmView = await dm.get(`${API}/campaigns/${campaignId}/session-zero/boundaries`);
      const anonRow = dmView.body.find((b: { text: string }) => b.text === M.anonBoundary);
      expect(anonRow).toBeDefined();
      expect(anonRow.anonymous).toBe(true);
      // Not merely hidden in the UI — absent from the payload.
      expect(anonRow.submitterUserId).toBe('');
      expect(anonRow.submitterName).toBe('');
      expect(JSON.stringify(anonRow)).not.toContain('sz-player');
    });

    it('lets the submitter find and withdraw their own, but nobody else', async () => {
      const own = await player.get(`${API}/campaigns/${campaignId}/session-zero/boundaries`);
      const mine = own.body.find((b: { text: string }) => b.text === M.anonBoundary);
      expect(mine.mine).toBe(true);

      const byDm = await dm.delete(`${API}/campaigns/${campaignId}/session-zero/boundaries/${mine.id}`);
      expect(byDm.status).toBe(403);

      const byOwner = await player.delete(`${API}/campaigns/${campaignId}/session-zero/boundaries/${mine.id}`);
      expect(byOwner.status).toBe(204);
    });
  });

  // -------------------------------------------------------------------------
  // Guardian consent
  // -------------------------------------------------------------------------

  describe('guardian consent without birth dates', () => {
    let consentId: number;

    it('opens a request from an attestation and a guardian contact', async () => {
      const versionId = (await dm.get(`${API}/campaigns/${campaignId}/session-zero/versions`)).body[0].id;
      const res = await player.post(`${API}/campaigns/${campaignId}/session-zero/guardian-consents`).send({
        versionId,
        guardianName: M.guardianName,
        guardianEmail: M.guardianEmail,
        guardianRelationship: 'parent',
        minorAttested: true,
      });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('pending');
      consentId = res.body.id;
    });

    it('rejects any attempt to send a birth date', async () => {
      const versionId = (await dm.get(`${API}/campaigns/${campaignId}/session-zero/versions`)).body[0].id;
      for (const extra of [{ birthDate: '2012-04-01' }, { dateOfBirth: '2012-04-01' }, { age: 13 }]) {
        const res = await player.post(`${API}/campaigns/${campaignId}/session-zero/guardian-consents`).send({
          versionId,
          guardianName: M.guardianName,
          guardianEmail: M.guardianEmail,
          minorAttested: true,
          ...extra,
        });
        expect(res.status).toBe(400);
      }
    });

    it('lets the DM record the guardian decision, and a later withdrawal', async () => {
      const granted = await dm
        .post(`${API}/campaigns/${campaignId}/session-zero/guardian-consents/${consentId}/decision`)
        .send({ status: 'granted', note: 'Spoke with them.' });
      expect(granted.status).toBe(201);
      expect(granted.body.status).toBe('granted');
      expect(granted.body.decidedAt).toBeTruthy();

      const withdrawn = await dm
        .post(`${API}/campaigns/${campaignId}/session-zero/guardian-consents/${consentId}/decision`)
        .send({ status: 'withdrawn', note: 'They changed their mind.' });
      expect(withdrawn.status).toBe(201);
      expect(withdrawn.body.status).toBe('withdrawn');
    });

    it('does not expose guardian contact details to other participants', async () => {
      const asPlayer = await joiner.get(`${API}/campaigns/${campaignId}/session-zero/guardian-consents`);
      expect(asPlayer.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // Export privacy (acceptance criterion)
  // -------------------------------------------------------------------------

  describe('export privacy', () => {
    it('never carries private boundaries, acknowledgments, or guardian contacts into ANY export profile', async () => {
      for (const profile of ['backup', 'handoff', 'publish']) {
        const res = await dm.get(`${API}/campaigns/${campaignId}/export`).query({ profile });
        expect([200, 201]).toContain(res.status);
        const serialized = `${JSON.stringify(res.body)}${res.text ?? ''}`;

        // Consent records are participant data about people, not campaign content.
        // None of them belong in an artifact a DM hands to somebody else.
        expect(serialized).not.toContain(M.privateBoundary);
        expect(serialized).not.toContain(M.anonBoundary);
        expect(serialized).not.toContain(M.guardianName);
        expect(serialized).not.toContain(M.guardianEmail);
        expect(serialized).not.toContain('guardianEmail');
        expect(serialized).not.toContain('acknowledgments');
      }
    });

    it('still withholds the participant-authored charter lines from a publish export', async () => {
      // Pre-existing #586 behaviour that #600 must not regress: lines/veils/safety tools
      // are the group's own words and are player content.
      const res = await dm.get(`${API}/campaigns/${campaignId}/export`).query({ profile: 'publish' });
      expect([200, 201]).toContain(res.status);
      expect(`${JSON.stringify(res.body)}${res.text ?? ''}`).not.toContain(M.line);
    });
  });
});
