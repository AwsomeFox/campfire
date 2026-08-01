import request from 'supertest';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';

/**
 * Issue #1680 — `ExportService.buildMemberExport()` (`GET /campaigns/:id/export/me`) is
 * a hand-built slice that does NOT go through the campaign-wide export's field-policy
 * machinery (`fieldsFor`/`pickFields`/`DM_SECRET_FIELDS` in export-profiles.ts). That
 * machinery exists for a different problem — projecting the DM's full backup down to a
 * redistributable `handoff`/`publish` module across EVERY member's pooled data — and
 * does not fit `buildMemberExport`'s shape (role-and-ownership-scoped "give me back MY
 * OWN data", covering entities like `note`/`comment`/`proposal` that #586's allowlists
 * don't even model).
 *
 * AUDIT CONCLUSION (field by field, against DM_SECRET_FIELDS, with the caller's role in
 * mind): no leak. `buildMemberExport` composes exactly four service calls —
 * `CharactersService.listForCampaign`, `NotesService.listAllForCampaign`,
 * `CommentsService.listForCampaign`, `ProposalRecordsService.listForCampaign` (via
 * `ProposalsService`) — and EVERY one of them already applies its own role-based
 * redaction/scoping, identical to what the live REST/MCP surface for that entity
 * applies for the same role:
 *   - characters: `redactSecrets()` strips `dmSecret` for non-dm (common/redact.ts),
 *     then `buildMemberExport` narrows further to `ownerUserId === caller`.
 *   - notes: `mine: true` restricts to `authorUserId === caller` (their own writing,
 *     regardless of visibility — a whisper FROM someone else TO the caller is
 *     deliberately excluded, since `mine` filters by author not recipient).
 *   - comments: `authorUserId` filter + the same per-role anchor-visibility check
 *     (`isAnchorVisible`) as the live comment feed.
 *   - proposals: `proposerUserId` filter + `projectProposal()` (issue #817), which
 *     strips `dmSecret` from both `payload` and `snapshot` for a non-dm proposer.
 * None of these four services expose a field that isn't already covered by one of
 * those mechanisms, so there is nothing left for `pickFields`/`DM_SECRET_FIELDS` to
 * additionally guard here — see the method's own doc comment for the durability
 * decision (keep the hand-built slice; this file is what pins it against drift).
 *
 * `export-redaction.ts`'s `collectPrivateIdentifiers` free-text sweep does NOT apply
 * to this path either, and that is also correct rather than a gap: that sweep exists
 * to catch OTHER members' account identities a DM typed into free text before a
 * redistributable module ships to strangers. Every string `buildMemberExport` returns
 * was authored by (or belongs to) the caller themselves — there is no third-party
 * identity for the caller to be surprised by.
 */
describe('member export field policy (e2e, issue #1680)', () => {
  let ctx: TestAppContext;
  let dmAgent: ReturnType<typeof request.agent>;
  let playerAgent: ReturnType<typeof request.agent>;
  let otherPlayerAgent: ReturnType<typeof request.agent>;
  let campaignId: number;
  let playerId: string;
  let dmId: string;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    dmAgent = request.agent(server);
    const dmSetup = await dmAgent.post('/api/v1/auth/setup').send({ username: 'mep-dm', password: 'dm-password-1' });
    dmId = String(dmSetup.body.user.id);

    const createPlayer = await dmAgent
      .post('/api/v1/users')
      .send({ username: 'mep-player', password: 'player-password-1', serverRole: 'user' });
    const playerNumericId = createPlayer.body.id as number;
    const createOtherPlayer = await dmAgent
      .post('/api/v1/users')
      .send({ username: 'mep-other-player', password: 'other-player-password-1', serverRole: 'user' });
    const otherPlayerNumericId = createOtherPlayer.body.id as number;
    // Membership rows key on the numeric user id (Id); characters/notes/proposals key
    // ownerUserId/authorUserId/proposerUserId on String(users.id) — same convention the
    // rest of the app uses (see Character.ownerUserId's own doc comment).
    playerId = String(playerNumericId);

    playerAgent = request.agent(server);
    await playerAgent.post('/api/v1/auth/login').send({ username: 'mep-player', password: 'player-password-1' });
    otherPlayerAgent = request.agent(server);
    await otherPlayerAgent
      .post('/api/v1/auth/login')
      .send({ username: 'mep-other-player', password: 'other-player-password-1' });

    const campRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'Member Export Field Policy' });
    campaignId = campRes.body.id;
    const memberRes = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/members`)
      .send({ userId: playerNumericId, role: 'player' });
    expect(memberRes.status).toBe(201);
    const otherMemberRes = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/members`)
      .send({ userId: otherPlayerNumericId, role: 'player' });
    expect(otherMemberRes.status).toBe(201);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('redacts dmSecret from the caller\'s OWN character (DM-seeded, player-owned)', async () => {
    // Only a dm may seed dmSecret at create, and only a dm may set ownerUserId to
    // someone else — this is the DM handing the player a character that already
    // carries a secret (a hidden curse, a disguised identity, etc.).
    const created = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .send({ name: 'Player Secretly Cursed Hero', ownerUserId: playerId, dmSecret: 'is secretly a doppelganger' });
    expect(created.status).toBe(201);
    expect(created.body.ownerUserId).toBe(playerId);

    const res = await playerAgent.get(`/api/v1/campaigns/${campaignId}/export/me`);
    expect(res.status).toBe(200);
    const own = res.body.characters.find((c: { name: string }) => c.name === 'Player Secretly Cursed Hero');
    expect(own).toBeDefined();
    // The field survives (matches redactSecret's shape — key present, value emptied)
    // but its content is gone.
    expect(own.dmSecret).toBe('');

    // Sanity: the DM's OWN member export is NOT blanket-stripped of dmSecret — the
    // redaction is role-gated, not a hardcoded omission that would silently defeat
    // this same test if `redactSecrets` were ever bypassed for the dm role too.
    const dmOwn = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .send({ name: 'DM Console Character', ownerUserId: dmId, dmSecret: 'dm can read this back' });
    expect(dmOwn.status).toBe(201);
    const dmRes = await dmAgent.get(`/api/v1/campaigns/${campaignId}/export/me`);
    expect(dmRes.status).toBe(200);
    const dmChar = dmRes.body.characters.find((c: { name: string }) => c.name === 'DM Console Character');
    expect(dmChar).toBeDefined();
    expect(dmChar.dmSecret).toBe('dm can read this back');
  });

  it('only includes characters the caller owns, never another member\'s', async () => {
    const dmChar = await dmAgent.post(`/api/v1/campaigns/${campaignId}/characters`).send({ name: 'DM-Owned NPC-as-PC' });
    expect(dmChar.status).toBe(201);

    const res = await playerAgent.get(`/api/v1/campaigns/${campaignId}/export/me`);
    expect(res.status).toBe(200);
    expect(res.body.characters.some((c: { name: string }) => c.name === 'DM-Owned NPC-as-PC')).toBe(false);
  });

  it('redacts dmSecret from BOTH payload and snapshot of the caller\'s own proposal (issue #817)', async () => {
    // A quest with a dmSecret the player would never otherwise see. Revealed
    // (hidden: false) so the player can see/propose against it at all (#754: quests
    // are DM-only prep by default) — the dmSecret field is the thing under test, not
    // entity-level visibility.
    const quest = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/quests`)
      .send({ title: 'Quest With A Secret', dmSecret: 'the vault code is 1234', hidden: false });
    expect(quest.status).toBe(201);
    const questId = quest.body.id;

    // Player proposes an update — captures the FULL unredacted snapshot server-side
    // for DM review (captureAuthorizedSnapshot), including dmSecret.
    const proposedPayloadSecret = 'the obsidian vault code is 5678';
    const proposeRes = await playerAgent
      .patch(`/api/v1/quests/${questId}?proposed=true`)
      .send({ title: 'Quest With A Secret (player suggestion)', dmSecret: proposedPayloadSecret });
    expect(proposeRes.status).toBe(202);
    const proposalId = proposeRes.body.proposal.id;

    const res = await playerAgent.get(`/api/v1/campaigns/${campaignId}/export/me`);
    expect(res.status).toBe(200);
    const proposal = res.body.proposals.find((p: { id: number }) => p.id === proposalId);
    expect(proposal).toBeDefined();
    // The snapshot key survives (proves it wasn't just omitted by accident) but its
    // dmSecret is gone, and nowhere else in the snapshot does the secret string appear.
    expect(proposal.snapshot).not.toBeNull();
    expect(proposal.snapshot.dmSecret).toBe('');
    expect(JSON.stringify(proposal.snapshot)).not.toContain('vault code');
    expect(proposal.payload).not.toBeNull();
    expect(proposal.payload.dmSecret).toBe('');
    expect(JSON.stringify(proposal.payload)).not.toContain('vault code');

    // Sanity: the DM's own view of the SAME proposal (via the DM-only campaign proposals
    // list, not member export) still carries the real snapshot and payload — proving
    // the projection is role-gated on egress, not a destructive rewrite of the stored row.
    const dmProposals = await dmAgent.get(`/api/v1/campaigns/${campaignId}/proposals?status=pending`);
    const dmSideProposal = dmProposals.body.find((p: { id: number }) => p.id === proposalId);
    expect(dmSideProposal).toBeDefined();
    expect(dmSideProposal.snapshot.dmSecret).toBe('the vault code is 1234');
    expect(dmSideProposal.payload.dmSecret).toBe(proposedPayloadSecret);
  });

  it('only includes notes the caller AUTHORED, not a whisper sent TO them by someone else', async () => {
    const authored = await playerAgent
      .post(`/api/v1/campaigns/${campaignId}/notes`)
      .send({ body: 'my own private plan', visibility: 'private' });
    expect(authored.status).toBe(201);

    // The DM whispers something TO the player — the player CAN read this over the live
    // notes feed, but `buildMemberExport`'s `mine: true` scope is authored-by, not
    // visible-to, so it is deliberately absent from the export (documented at the
    // method itself, not a bug this issue is about).
    const whisper = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/notes`)
      .send({ body: 'a dm whisper the player can read live', visibility: 'whisper', recipientUserId: playerId });
    expect(whisper.status).toBe(201);

    const res = await playerAgent.get(`/api/v1/campaigns/${campaignId}/export/me`);
    expect(res.status).toBe(200);
    expect(res.body.notes.some((n: { body: string }) => n.body === 'my own private plan')).toBe(true);
    expect(res.body.notes.some((n: { body: string }) => n.body === 'a dm whisper the player can read live')).toBe(false);

    // Confirm it really is visible live (so the assertion above is a scope choice, not
    // an authorization failure hiding a real bug).
    const live = await playerAgent.get(`/api/v1/campaigns/${campaignId}/notes`);
    expect(live.body.items.some((n: { body: string }) => n.body === 'a dm whisper the player can read live')).toBe(true);
  });

  it('only includes comments the caller AUTHORED on anchors still visible to their role', async () => {
    const visibleQuest = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/quests`)
      .send({ title: 'Comment Export Visible Quest', hidden: false });
    expect(visibleQuest.status).toBe(201);

    const ownVisibleComment = await playerAgent
      .post(`/api/v1/campaigns/${campaignId}/comments`)
      .send({ entityType: 'quest', entityId: visibleQuest.body.id, body: 'my visible export comment' });
    expect(ownVisibleComment.status).toBe(201);
    const otherVisibleComment = await otherPlayerAgent
      .post(`/api/v1/campaigns/${campaignId}/comments`)
      .send({ entityType: 'quest', entityId: visibleQuest.body.id, body: 'other member visible export comment' });
    expect(otherVisibleComment.status).toBe(201);

    const hiddenLaterQuest = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/quests`)
      .send({ title: 'Comment Export Hidden Later Quest', hidden: false });
    expect(hiddenLaterQuest.status).toBe(201);
    const ownHiddenAnchorComment = await playerAgent
      .post(`/api/v1/campaigns/${campaignId}/comments`)
      .send({ entityType: 'quest', entityId: hiddenLaterQuest.body.id, body: 'my now-hidden anchor comment' });
    expect(ownHiddenAnchorComment.status).toBe(201);
    const hideQuest = await dmAgent.patch(`/api/v1/quests/${hiddenLaterQuest.body.id}`).send({ hidden: true });
    expect(hideQuest.status).toBe(200);

    // Confirm the hidden-anchor comment still exists for the DM, so its absence below
    // proves role-based anchor filtering instead of a failed seed.
    const dmHiddenThread = await dmAgent
      .get(`/api/v1/campaigns/${campaignId}/comments`)
      .query({ entityType: 'quest', entityId: hiddenLaterQuest.body.id });
    expect(dmHiddenThread.status).toBe(200);
    expect(JSON.stringify(dmHiddenThread.body)).toContain('my now-hidden anchor comment');
    const playerHiddenThread = await playerAgent
      .get(`/api/v1/campaigns/${campaignId}/comments`)
      .query({ entityType: 'quest', entityId: hiddenLaterQuest.body.id });
    expect(playerHiddenThread.status).toBe(404);

    const res = await playerAgent.get(`/api/v1/campaigns/${campaignId}/export/me`);
    expect(res.status).toBe(200);
    const comments = res.body.comments as Array<{ id: number; body: string }>;
    expect(comments.some((c) => c.id === ownVisibleComment.body.id && c.body === 'my visible export comment')).toBe(true);
    expect(comments.some((c) => c.id === otherVisibleComment.body.id)).toBe(false);
    expect(comments.some((c) => c.id === ownHiddenAnchorComment.body.id)).toBe(false);
  });

  it('never exposes campaign-wide fields (members, audit) through the member export', async () => {
    const res = await playerAgent.get(`/api/v1/campaigns/${campaignId}/export/me`);
    expect(res.status).toBe(200);
    expect(res.body.members).toBeUndefined();
    expect(res.body.audit).toBeUndefined();
    expect(res.body.npcs).toBeUndefined();
    expect(res.body.locations).toBeUndefined();
  });
  it('validates the manifest format and preview endpoint', async () => {
    const res = await playerAgent.get(`/api/v1/campaigns/${campaignId}/export/me/preview`);
    expect(res.status).toBe(200);
    expect(res.body.manifest).toBeDefined();
    expect(res.body.manifest.version).toBe(1);
    expect(String(res.body.manifest.userId)).toBe(playerId);
    expect(res.body.manifest.included).toContain('characters');
    expect(res.body.manifest.included).toContain('auditActions');
    expect(res.body.manifest.excluded).toContain('campaignWorldData');
    expect(res.body.manifest.counts.characters).toBeGreaterThanOrEqual(0);
    
    // Preview should not include the actual data
    expect(res.body.characters).toBeUndefined();
  });

  it('includes redacted parent context for comment threads', async () => {
    // 1. Other player creates a visible quest and a comment on it
    const visibleQuest = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/quests`)
      .send({ title: 'Context Quest', hidden: false });
    
    const otherComment = await otherPlayerAgent
      .post(`/api/v1/campaigns/${campaignId}/comments`)
      .send({ entityType: 'quest', entityId: visibleQuest.body.id, body: 'Parent comment by someone else' });
      
    // 2. Player replies to the other player's comment
    const myReply = await playerAgent
      .post(`/api/v1/campaigns/${campaignId}/comments`)
      .send({ entityType: 'quest', entityId: visibleQuest.body.id, parentId: otherComment.body.id, body: 'My reply' });

    // 3. Check the export
    const res = await playerAgent.get(`/api/v1/campaigns/${campaignId}/export/me`);
    expect(res.status).toBe(200);
    
    const comments = res.body.comments;
    expect(comments.some((c: any) => c.id === myReply.body.id)).toBe(true);
    
    const context = res.body.commentParentContext;
    expect(context).toBeDefined();
    const parentContext = context.find((c: any) => c.id === otherComment.body.id);
    expect(parentContext).toBeDefined();
    expect(parentContext.body).toBe('Parent comment by someone else');
    expect(parentContext.authorName).toBe('[Redacted Member]'); // Privacy check!
  });

  it('includes user-attributable data (rolls, rsvps, revisions, audit)', async () => {
    // 1. Create a roll
    const roll = await playerAgent
      .post(`/api/v1/campaigns/${campaignId}/roll`)
      .send({ expr: '1d20' });
    expect(roll.status).toBe(201);
      
    // 2. Create an RSVP
    const session = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/schedule`)
      .send({ title: 'Export RSVP Test', scheduledAt: '2099-06-10T18:00:00Z' })
      .expect(201);
    await playerAgent
      .put(`/api/v1/campaigns/${campaignId}/schedule/${session.body.id}/rsvp`)
      .send({ status: 'yes', note: 'I can make it' })
      .expect(200);
      
    // 3. Create a revision by editing a note authored by player
    const note = await playerAgent
      .post(`/api/v1/campaigns/${campaignId}/notes`)
      .send({ body: 'Initial note', visibility: 'private' });
    await playerAgent
      .patch(`/api/v1/campaigns/${campaignId}/notes/${note.body.id}`)
      .send({ body: 'Edited note' })
      .expect(200);
      
    // 4. Export and check
    const res = await playerAgent.get(`/api/v1/campaigns/${campaignId}/export/me`);
    expect(res.status).toBe(200);
    
    const { diceRolls, rsvps, revisions, auditActions } = res.body;
    expect(diceRolls).toBeDefined();
    expect(diceRolls.some((r: any) => r.id === roll.body.id)).toBe(true);
    
    expect(rsvps).toBeDefined();
    expect(rsvps.some((r: any) => r.note === 'I can make it' && r.scheduledSessionId === session.body.id)).toBe(true);
    
    expect(revisions).toBeDefined();
    expect(revisions.some((r: any) => r.entityType === 'note' && r.entityId === note.body.id)).toBe(true);
    
    expect(auditActions).toBeDefined();
    // Audit actions are recorded by the system for the note creation/edit
    expect(auditActions.some((a: any) => a.action === 'note.create' && a.entityId === note.body.id)).toBe(true);
    
    // Ensure no other member's data is present
    const otherRoll = await otherPlayerAgent
      .post(`/api/v1/campaigns/${campaignId}/roll`)
      .send({ expr: '2d20' });
    expect(otherRoll.status).toBe(201);
    const res2 = await playerAgent.get(`/api/v1/campaigns/${campaignId}/export/me`);
    expect(res2.body.diceRolls.some((r: any) => r.id === otherRoll.body.id)).toBe(false);
  });
});
