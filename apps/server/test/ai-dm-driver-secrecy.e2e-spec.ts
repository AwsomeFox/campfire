import request from 'supertest';
import { createAiEvalHarness, dm, player, type AiEvalHarness } from './ai-eval-harness';

/**
 * Issue #557 — AI Driver secrecy: prevent DM-scoped read tools from feeding secrets into
 * public narration. Each test pins one acceptance criterion against the deterministic
 * offline harness (#318):
 *
 *  - A hidden NPC (hidden:true) the model tries to read mid-turn 404s under the player-
 *    scoped read principal (no DM-scoped tool result reaches the provider), and the model
 *    cannot narrate its name or dmSecret.
 *  - A quest with a dmSecret field is returned to the model with dmSecret stripped when no
 *    DM approval is on file.
 *  - An unexplored location 404s the same way.
 *  - Bulk DM-only aggregate reads (export_campaign, read_audit_log, list_arcs) are blocked
 *    at execution AND withheld from the offered tool schema.
 *  - The blocked/allowed routing is AUDITED.
 *  - A narrowly-scoped, single-use DM approval (get_npc:<id>) lets ONE secret read run under
 *    the DM principal, is consumed after one use, and is tagged with a system reminder the
 *    model must not narrate.
 *  - Indirect retrieval (a hidden entity embedded in a list/summary) cannot smuggle a secret
 *    into context, and a model that then tries to read the hidden entity directly is blocked.
 *
 * The hole these close: the driver seat principal is DM-scoped (devRole:'dm', scope:'dm'),
 * so before #557 every read tool succeeded under it, returning hidden entities + dmSecret
 * mid-turn. The system prompt was already player-scoped (#387), but runtime tool calls were
 * not — the model could read a secret and narrate it to every member.
 */

/** Find the `tool` message answering a given tool-call id in the mock's recorded requests. */
function toolResultFor(h: AiEvalHarness, toolCallId: string): string | undefined {
  for (const req of [...h.mock.received].reverse()) {
    const msg = req.messages.find((m) => m.role === 'tool' && m.toolCallId === toolCallId);
    if (msg?.content) return msg.content;
  }
  return undefined;
}

describe('ai-dm driver — #557 secret-bearing read tools cannot feed public narration (e2e)', () => {
  let h: AiEvalHarness;

  beforeAll(async () => {
    h = await createAiEvalHarness({ model: 'secr-model' });
    await h.enableExperimental();
  });
  afterAll(async () => {
    await h.close();
  });

  it('#877 includes only explicitly AI-consented supports and applies revocation on the next turn', async () => {
    const campaignId = await h.createCampaign('Support Consent Driver');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });
    const route = `/api/v1/campaigns/${campaignId}/session-zero/support-preferences/me`;
    const supportText = 'DRIVER_SUPPORT_SENTINEL_877';

    await request(h.server).put(route).set(player).send({
      supportText,
      visibility: 'facilitator',
      aiUseConsent: false,
    });
    h.script({ text: 'First turn.' });
    await h.sendMessage(campaignId, { input: 'begin' });
    expect(h.mock.received.at(-1)?.system ?? '').not.toContain(supportText);

    await request(h.server).put(route).set(player).send({
      supportText,
      visibility: 'facilitator',
      aiUseConsent: true,
    });
    h.script({ text: 'Second turn.' });
    await h.sendMessage(campaignId, { input: 'continue' });
    expect(h.mock.received.at(-1)?.system ?? '').not.toContain(supportText);

    await request(h.server).put(route).set(player).send({
      supportText,
      visibility: 'table',
      aiUseConsent: true,
    });
    h.script({ text: 'Third turn.' });
    await h.sendMessage(campaignId, { input: 'continue at the table' });
    expect(h.mock.received.at(-1)?.system ?? '').toContain(supportText);

    await request(h.server).put(route).set(player).send({
      supportText,
      visibility: 'table',
      aiUseConsent: false,
    });
    h.script({ text: 'Fourth turn.' });
    await h.sendMessage(campaignId, { input: 'continue again' });
    expect(h.mock.received.at(-1)?.system ?? '').not.toContain(supportText);
  });

  // ── hidden NPC ──────────────────────────────────────────────────────────────
  it('a hidden NPC the model reads mid-turn 404s under the player-scoped principal (no secret reaches the provider)', async () => {
    const campaignId = await h.createCampaign('Secrecy Hidden NPC');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });

    const npc = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/npcs`)
      .set(dm)
      .send({ name: 'Gravewhisper', hidden: true, dmSecret: 'THE_INNKEEPER_IS_A_LICH' });
    expect(npc.status).toBe(201);
    const npcId = npc.body.id as number;

    // The model tries to read the hidden NPC. Script exactly one tool turn (the blocked path
    // returns a tool error and stops the turn).
    h.script({
      text: 'Peering into the shadows…',
      toolCalls: [{ id: 'g1', name: 'get_npc', arguments: { npcId } }],
    });
    const res = await h.sendMessage(campaignId, { input: 'who is hiding here' });
    expect(res.status).toBe(201);
    // Player-scoped read of a hidden entity → 404, surfaced as a tool error → turn stops.
    expect(res.body.toolCalls).toEqual([{ name: 'get_npc', isError: true, proposed: false }]);
    expect(res.body.stopReason).toBe('tool_error');

    // The tool result that re-entered the message history (and the provider persists) is the
    // 404 error JSON — NOT the secret, NOT the hidden NPC's name.
    const result = toolResultFor(h, 'g1') ?? '';
    expect(result).toContain('404');
    expect(result).not.toContain('THE_INNKEEPER_IS_A_LICH');
    expect(result).not.toContain('Gravewhisper');
  });

  // ── dmSecret on a visible quest ─────────────────────────────────────────────
  it('a visible quest with a dmSecret is returned to the model with the secret stripped (no approval on file)', async () => {
    const campaignId = await h.createCampaign('Secrecy Quest Secret');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });

    const quest = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/quests`)
      .set(dm)
      .send({ title: 'The Heir Apparent', dmSecret: 'THE_INNKEEPER_IS_THE_HEIR', hidden: false });
    expect(quest.status).toBe(201);
    const questId = quest.body.id as number;

    // The model reads the visible quest. The tool succeeds (the quest is not hidden) but the
    // player-scoped principal strips dmSecret at the tool layer — the model sees an empty value.
    h.script(
      {
        text: 'Consulting my notes…',
        toolCalls: [{ id: 'q1', name: 'get_quest', arguments: { questId } }],
      },
      { text: 'The thread leads to the tavern.' },
    );
    const res = await h.sendMessage(campaignId, { input: 'what is the quest' });
    expect(res.status).toBe(201);
    expect(res.body.toolCalls).toEqual([{ name: 'get_quest', isError: false, proposed: false }]);

    const result = toolResultFor(h, 'q1') ?? '';
    expect(result).toContain('The Heir Apparent');
    expect(result).not.toContain('THE_INNKEEPER_IS_THE_HEIR');
  });

  // ── unexplored location ─────────────────────────────────────────────────────
  it('an unexplored location the model reads mid-turn 404s under the player-scoped principal', async () => {
    const campaignId = await h.createCampaign('Secrecy Unexplored');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });

    // A fresh location defaults to status:'unexplored' (DM-only until revealed).
    const loc = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/locations`)
      .set(dm)
      .send({ name: 'The Sunken Vault' });
    expect(loc.status).toBe(201);
    expect(loc.body.status).toBe('unexplored');
    const locId = loc.body.id as number;

    h.script({
      text: 'Charting the route…',
      toolCalls: [{ id: 'l1', name: 'get_location', arguments: { locationId: locId } }],
    });
    const res = await h.sendMessage(campaignId, { input: 'where is the vault' });
    expect(res.status).toBe(201);
    expect(res.body.toolCalls).toEqual([{ name: 'get_location', isError: true, proposed: false }]);
    expect(res.body.stopReason).toBe('tool_error');

    const result = toolResultFor(h, 'l1') ?? '';
    expect(result).toContain('404');
    expect(result).not.toContain('Sunken Vault');
  });

  // ── bulk DM-only aggregate reads are blocked + withheld ──────────────────────
  it('export_campaign / read_audit_log / list_arcs are blocked at execution AND withheld from the offered schema', async () => {
    const campaignId = await h.createCampaign('Secrecy Bulk DM Reads');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });

    for (const name of ['export_campaign', 'read_audit_log', 'list_arcs']) {
      // Each blocked read stops the turn after step 1 — script exactly one tool turn.
      h.script({ text: 'Pulling the records…', toolCalls: [{ id: `x-${name}`, name, arguments: { campaignId } }] });
      const res = await h.sendMessage(campaignId, { input: `call ${name}` });
      expect(res.status).toBe(201);
      expect(res.body.toolCalls).toEqual([{ name, isError: true, proposed: false }]);
      expect(res.body.stopReason).toBe('tool_error');
      // The blocked read returns the secrecy error, not the secret-bearing payload.
      const result = toolResultFor(h, `x-${name}`) ?? '';
      expect(result).toContain('forbidden_secret_read');
    }

    // None were OFFERED to the model (schema withholding), while player-safe reads + canon
    // tools still are.
    const firstReq = h.mock.received.find((r) => (r.tools ?? []).length > 0)!;
    const offered = (firstReq.tools ?? []).map((t) => t.name);
    expect(offered).not.toContain('export_campaign');
    expect(offered).not.toContain('read_audit_log');
    expect(offered).not.toContain('list_arcs');
    expect(offered).not.toContain('get_arc');
    expect(offered).not.toContain('get_beat');
    expect(offered).not.toContain('read_inbox');
    expect(offered).toContain('get_campaign_summary'); // player-safe read still offered
    expect(offered).toContain('get_npc'); // per-entity read still offered (default player-scoped)
    expect(offered).toContain('create_quest'); // canon writes still offered
  });

  // ── blocked + approved secret access is audited ──────────────────────────────
  it('blocked and approved secret-bearing reads are both audited', async () => {
    const campaignId = await h.createCampaign('Secrecy Audit');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });

    // Block path: read_audit_log is refused and audited as a blocked secret read.
    h.script({ text: 'Reading the log…', toolCalls: [{ id: 'a1', name: 'read_audit_log', arguments: { campaignId } }] });
    await h.sendMessage(campaignId, { input: 'show me the log' });

    const auditAfterBlock = await h.getAudit(campaignId);
    expect(
      auditAfterBlock.body.some((e: { action: string }) => e.action === 'ai-dm.driver.secret.blocked'),
    ).toBe(true);
  });

  // ── DM-approval gate: a narrowly-scoped approval unlocks ONE secret read ─────
  it('a DM-granted approval lets the seat read ONE secret NPC under the DM principal (single-use, reminder-tagged)', async () => {
    const campaignId = await h.createCampaign('Secrecy Approval');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });

    const npc = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/npcs`)
      .set(dm)
      .send({ name: 'Mira the Veiled', hidden: true, dmSecret: 'MIRA_IS_A_VAMPIRE' });
    expect(npc.status).toBe(201);
    const npcId = npc.body.id as number;

    // Before approval: a direct read of the hidden NPC 404s under the player principal.
    h.script({
      text: 'Looking…',
      toolCalls: [{ id: 'pre', name: 'get_npc', arguments: { npcId } }],
    });
    const before = await h.sendMessage(campaignId, { input: 'tell me about the stranger' });
    expect(before.body.toolCalls).toEqual([{ name: 'get_npc', isError: true, proposed: false }]);
    expect(toolResultFor(h, 'pre')).toContain('404');

    // A player may NOT grant the approval (DM only).
    const playerGrant = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/ai-dm/secret-approval`)
      .set(player)
      .send({ action: 'grant', tool: 'get_npc', entityId: npcId });
    expect(playerGrant.status).toBe(403);

    // The DM files a narrowly-scoped approval for this one NPC.
    const grant = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/ai-dm/secret-approval`)
      .set(dm)
      .send({ action: 'grant', tool: 'get_npc', entityId: npcId, note: 'name the villain' });
    expect(grant.status).toBe(201);
    expect(grant.body.consumed).toBe(false);
    expect(grant.body.tool).toBe('get_npc');
    expect(grant.body.entityId).toBe(npcId);

    // The approval list surfaces it.
    const list = await request(h.server).get(`/api/v1/campaigns/${campaignId}/ai-dm/secret-approvals`).set(dm);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].entityId).toBe(npcId);

    // Now the same read runs under the DM principal and returns the secret material.
    h.script(
      {
        text: 'A figure steps from the shadow…',
        toolCalls: [{ id: 'post', name: 'get_npc', arguments: { npcId } }],
      },
      { text: 'The stranger introduces herself.' },
    );
    const after = await h.sendMessage(campaignId, { input: 'who is she really' });
    expect(after.status).toBe(201);
    expect(after.body.toolCalls).toEqual([{ name: 'get_npc', isError: false, proposed: false }]);

    const result = toolResultFor(h, 'post') ?? '';
    expect(result).toContain('MIRA_IS_A_VAMPIRE'); // the secret is now in the tool result
    // ... tagged with the system reminder that the material is DM-only and must not be narrated.
    expect(result).toContain('DM-ONLY');

    // The approval is consumed (single-use).
    const listAfter = await request(h.server).get(`/api/v1/campaigns/${campaignId}/ai-dm/secret-approvals`).set(dm);
    expect(listAfter.body).toHaveLength(0);

    // The approved read was audited.
    const audit = await h.getAudit(campaignId);
    expect(
      audit.body.some((e: { action: string }) => e.action === 'ai-dm.driver.secret.approved'),
    ).toBe(true);
    expect(audit.body.some((e: { action: string }) => e.action === 'ai-dm.driver.secret.grant')).toBe(true);

    // A subsequent read of the SAME hidden NPC 404s again — the approval cannot be replayed.
    h.script({
      text: 'Looking again…',
      toolCalls: [{ id: 'replay', name: 'get_npc', arguments: { npcId } }],
    });
    const replay = await h.sendMessage(campaignId, { input: 'remind me about her' });
    expect(replay.body.toolCalls).toEqual([{ name: 'get_npc', isError: true, proposed: false }]);
  });

  // ── a DM approval is narrowly scoped to ONE entity ───────────────────────────
  it('a DM approval for get_npc:X does NOT unlock get_npc:Y (or any other tool)', async () => {
    const campaignId = await h.createCampaign('Secrecy Narrow Scope');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });

    const npcA = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/npcs`)
      .set(dm)
      .send({ name: 'Approved One', hidden: true, dmSecret: 'A_SECRET' });
    const npcB = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/npcs`)
      .set(dm)
      .send({ name: 'Unapproved Two', hidden: true, dmSecret: 'B_SECRET' });
    const aId = npcA.body.id as number;
    const bId = npcB.body.id as number;

    // DM approves ONLY npc A.
    const grant = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/ai-dm/secret-approval`)
      .set(dm)
      .send({ action: 'grant', tool: 'get_npc', entityId: aId });
    expect(grant.status).toBe(201);

    // The model calls BOTH in one step. A succeeds under the DM principal; B 404s under the
    // player principal (no matching approval). The turn stops on B's tool error.
    h.script({
      text: 'Surveying…',
      toolCalls: [
        { id: 'ok', name: 'get_npc', arguments: { npcId: aId } },
        { id: 'no', name: 'get_npc', arguments: { npcId: bId } },
      ],
    });
    const res = await h.sendMessage(campaignId, { input: 'compare the two strangers' });
    expect(res.status).toBe(201);
    const calls = res.body.toolCalls as { name: string; isError: boolean }[];
    const okCall = calls.find((c) => c.name === 'get_npc' && !c.isError);
    const noCall = calls.find((c) => c.name === 'get_npc' && c.isError);
    // Exactly one get_npc succeeded (the approved one) and exactly one errored.
    expect(okCall).toBeDefined();
    expect(noCall).toBeDefined();
    expect(calls.filter((c) => c.name === 'get_npc')).toHaveLength(2);

    // A's secret reached the model; B's did not.
    expect(toolResultFor(h, 'ok')).toContain('A_SECRET');
    const noResult = toolResultFor(h, 'no') ?? '';
    expect(noResult).toContain('404');
    expect(noResult).not.toContain('B_SECRET');
  });

  // ── a DM approval cannot be filed for a bulk DM-only read ────────────────────
  it('a DM cannot file an approval for a bulk DM-only read (export_campaign)', async () => {
    const campaignId = await h.createCampaign('Secrecy No Bulk Approval');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });

    const grant = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/ai-dm/secret-approval`)
      .set(dm)
      .send({ action: 'grant', tool: 'export_campaign', entityId: 1 });
    expect(grant.status).toBe(400);

    // And the campaign still rejects the bulk read.
    h.script({ text: 'Trying…', toolCalls: [{ id: 'x', name: 'export_campaign', arguments: { campaignId } }] });
    const res = await h.sendMessage(campaignId, { input: 'export' });
    expect(res.body.toolCalls).toEqual([{ name: 'export_campaign', isError: true, proposed: false }]);
  });

  // ── indirect retrieval: a summary cannot smuggle a hidden entity, and a direct read follows ─
  it('indirect retrieval: the campaign summary omits the hidden NPC, and a direct read of it is blocked', async () => {
    const campaignId = await h.createCampaign('Secrecy Indirect');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });

    const npc = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/npcs`)
      .set(dm)
      .send({ name: 'Smuggled Villain', hidden: true, dmSecret: 'INDIRECT_SECRET' });
    const npcId = npc.body.id as number;

    // The model calls the player-safe summary (which omits hidden entities entirely), then
    // tries to read the hidden NPC directly. Both must stay secret-free in the model context.
    h.script({
      text: 'Reading the summary…',
      toolCalls: [
        { id: 'sum', name: 'get_campaign_summary', arguments: { campaignId } },
        { id: 'npc', name: 'get_npc', arguments: { npcId } },
      ],
    });
    const res = await h.sendMessage(campaignId, { input: 'brief me' });
    expect(res.status).toBe(201);

    // The summary succeeded (player-safe), the hidden NPC read 404'd.
    const summaryResult = toolResultFor(h, 'sum') ?? '';
    expect(summaryResult).not.toContain('Smuggled Villain');
    expect(summaryResult).not.toContain('INDIRECT_SECRET');

    const npcResult = toolResultFor(h, 'npc') ?? '';
    expect(npcResult).toContain('404');
    expect(npcResult).not.toContain('INDIRECT_SECRET');
  });

  // ── revoke withdraws an unconsumed approval before the seat uses it ─────────
  it('a DM can revoke an unconsumed approval and the seat read then 404s again', async () => {
    const campaignId = await h.createCampaign('Secrecy Revoke');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });

    const npc = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/npcs`)
      .set(dm)
      .send({ name: 'Almost Revealed', hidden: true, dmSecret: 'REVOKED_SECRET' });
    const npcId = npc.body.id as number;

    const grant = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/ai-dm/secret-approval`)
      .set(dm)
      .send({ action: 'grant', tool: 'get_npc', entityId: npcId });
    expect(grant.status).toBe(201);

    const revoke = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/ai-dm/secret-approval`)
      .set(dm)
      .send({ action: 'revoke', tool: 'get_npc', entityId: npcId });
    expect(revoke.status).toBe(201);

    // The approval list is now empty.
    const list = await request(h.server).get(`/api/v1/campaigns/${campaignId}/ai-dm/secret-approvals`).set(dm);
    expect(list.body).toHaveLength(0);

    // The read 404s again — the secret never reached the model.
    h.script({ text: 'Looking…', toolCalls: [{ id: 'r1', name: 'get_npc', arguments: { npcId } }] });
    const res = await h.sendMessage(campaignId, { input: 'who is it' });
    expect(res.body.toolCalls).toEqual([{ name: 'get_npc', isError: true, proposed: false }]);
    expect(toolResultFor(h, 'r1') ?? '').not.toContain('REVOKED_SECRET');
  });
});
