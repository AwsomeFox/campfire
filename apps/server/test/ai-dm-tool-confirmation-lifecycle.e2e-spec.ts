import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { createAiEvalHarness, dm, type AiEvalHarness } from './ai-eval-harness';
import { DB, type DrizzleDb } from '../src/db/db.module';
import { auditLog, notifications as notificationsTable } from '../src/db/schema';
import { AiDriverService } from '../src/modules/ai-driver/ai-driver.service';
import { ActionResolverService } from '../src/modules/encounters/action-resolver.service';
import { MAX_PENDING_TOOL_CONFIRMATIONS } from '../src/modules/ai-driver/driver-tool-policy';

/**
 * Issue #1558 — the two SERVER-side halves of "a stall must never be silent".
 *
 * The UI itself is covered by the web suites. What belongs here is the pair of channels that
 * have to work when the DM is NOT looking at the AI Table: the notification that tells them a
 * call is waiting, and the audit trail for a queued call that dies without ever being answered.
 */
describe('ai-dm tool confirmations — reaching a DM who is not looking (#1558)', () => {
  let h: AiEvalHarness;
  let db: DrizzleDb;

  beforeAll(async () => {
    h = await createAiEvalHarness({ model: 'confirm-ui-model' });
    await h.enableExperimental();
    db = h.ctx.app.get<DrizzleDb>(DB);
  });

  beforeEach(() => h.resetMock());
  afterAll(async () => h.close());

  const armed = async (name: string): Promise<number> => {
    const campaignId = await h.createCampaign(name);
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });
    return campaignId;
  };

  /**
   * Seat a real DM and a real player.
   *
   * The dev-auth harness creates campaigns with no `campaign_members` rows at all, so without
   * this there is nobody for a role-targeted notification to reach — and the DM-only targeting,
   * which is the property worth proving, would be vacuous.
   */
  const seatMembers = async (campaignId: number): Promise<{ dmUserId: number; playerUserId: number }> => {
    const { users, campaignMembers } = await import('../src/db/schema');
    const ts = '2026-07-27T00:00:00.000Z';
    const mk = async (username: string): Promise<number> => {
      const [row] = await db
        .insert(users)
        .values({ username, passwordHash: 'x', serverRole: 'user', createdAt: ts, updatedAt: ts })
        .returning({ id: users.id });
      return row.id;
    };
    const dmUserId = await mk(`dm-${campaignId}`);
    const playerUserId = await mk(`pl-${campaignId}`);
    await db.insert(campaignMembers).values({ campaignId, userId: dmUserId, role: 'dm', createdAt: ts, updatedAt: ts });
    await db
      .insert(campaignMembers)
      .values({ campaignId, userId: playerUserId, role: 'player', createdAt: ts, updatedAt: ts });
    return { dmUserId, playerUserId };
  };

  it('notifies the DM — and only the DM — when a tool call starts waiting on them', async () => {
    const campaignId = await armed('Notify Pending');
    const { dmUserId, playerUserId } = await seatMembers(campaignId);
    // begin_encounter has been confirm-policy in every profile since #474 — the exact tool
    // #1558 names as unapprovable from the web app.
    h.script({
      text: 'Roll for initiative.',
      toolCalls: [{ id: 'c1', name: 'begin_encounter', arguments: { encounterId: 1 } }],
      usage: { promptTokens: 6, completionTokens: 4, totalTokens: 10 },
    });
    h.script({ text: 'Waiting on the DM.', usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7 } });

    const res = await h.sendMessage(campaignId, { input: 'we fight' });
    expect(res.status).toBe(201);

    const queue = await request(h.server).get(`/api/v1/campaigns/${campaignId}/ai-dm/tool-confirmations`).set(dm);
    expect(queue.body).toHaveLength(1);

    // The SSE signal only reaches a DM with the AI Table open. A DM on the encounter screen — or
    // away from the keyboard — would otherwise learn nothing, and the failure mode of this whole
    // mechanism is a silent stall.
    const rows = await db
      .select()
      .from(notificationsTable)
      .where(and(eq(notificationsTable.campaignId, campaignId), eq(notificationsTable.type, 'ai_dm_alert')));
    expect(rows.map((r) => r.userId)).toEqual([dmUserId]);
    expect(String(rows[0].body)).toContain('begin_encounter');
    // Not the players. The queue is a DM-only read, and a notification nobody but the DM can act
    // on would both leak that surface and train the table to ignore the bell.
    expect(rows.some((r) => r.userId === playerUserId)).toBe(false);
  });

  it('a player cannot read the queue', async () => {
    const campaignId = await armed('Queue Is DM Only');
    const res = await request(h.server)
      .get(`/api/v1/campaigns/${campaignId}/ai-dm/tool-confirmations`)
      .set({ 'x-dev-role': 'player', 'x-dev-user': 'nosy' });
    expect(res.status).toBe(403);
  });

  it('audits a confirmation the queue cap pushes out instead of dropping it in silence', async () => {
    const campaignId = await armed('Evict Loudly');
    const driver = h.ctx.app.get(AiDriverService);
    const resolver = h.ctx.app.get(ActionResolverService);
    const release = jest.spyOn(resolver, 'releasePendingChainForConfirmation');
    const session = driver.getSession(campaignId);

    // Fill the queue to its cap by hand — driving 20 real turns would test the model, not this.
    const pendingMap: Record<string, unknown> = {};
    for (let i = 0; i < MAX_PENDING_TOOL_CONFIRMATIONS; i += 1) {
      pendingMap[`apply_action:call_${i}`] = {
        id: `confirm-seed-${i}`,
        tool: 'apply_action',
        args: { n: i },
        toolCallId: `call_${i}`,
        profile: 'live',
        policy: 'confirm',
        requestedAt: `2026-07-27T10:00:${String(i).padStart(2, '0')}.000Z`,
        actor: `ai-dm-seat:${campaignId}`,
        triggeredBy: 'player-1',
        turnNumber: i,
        ...(i === 0 ? { retainedActionChain: { encounterId: 7, chainId: 'chain-evicted' } } : {}),
      };
    }
    (session as unknown as { pendingToolConfirmations: Record<string, unknown> }).pendingToolConfirmations = pendingMap;

    h.script({
      text: 'One more.',
      toolCalls: [{ id: 'cN', name: 'begin_encounter', arguments: { encounterId: 1 } }],
      usage: { promptTokens: 6, completionTokens: 4, totalTokens: 10 },
    });
    h.script({ text: 'Queued.', usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7 } });
    await h.sendMessage(campaignId, { input: 'again' });

    // Eviction used to be near-unreachable at 20 pending. Collaborative handoff (#1051) queues
    // roughly four per combat turn, so five turns of an inattentive DM now silently discards
    // their oldest decision — the same failure #1042 found for grants lost to a restart, and it
    // gets the same treatment: discarded, never in silence.
    const evicted = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.campaignId, campaignId), eq(auditLog.action, 'ai-dm.driver.confirmation.evicted')));
    expect(evicted).toHaveLength(1);
    expect(String(evicted[0].detail)).toContain('confirm-seed-0'); // the oldest
    expect(String(evicted[0].detail)).toContain('never executed');
    expect(release).toHaveBeenCalledWith(7, 'chain-evicted');
    release.mockRestore();
  });

  // Issue #1451 review (Codex P1, second pass) — collaborative handoff (#1051) queues
  // apply_action for DM confirmation. A caller-controlled actionName/actorCombatantId in the
  // queued args would let the model label a damaging chain as a harmless action by a different
  // actor and get it approved under a false summary: the DM approves the DISPLAYED label, but
  // apply() executes whatever chainId actually identifies. This must never survive into the
  // stored confirmation.
  it('#1451: a forged actionName/actorCombatantId on a queued apply_action call never reaches the stored confirmation', async () => {
    const campaignId = await armed('No Spoofed Confirmation Labels');
    const driver = h.ctx.app.get(AiDriverService);
    driver.setCollaborative(campaignId, true);

    h.script({
      text: 'Casting.',
      toolCalls: [
        {
          id: 'c1',
          name: 'apply_action',
          arguments: {
            encounterId: 1,
            chainId: 'chain-does-not-exist',
            // Forged — an attempt to make the DM approve believing this is harmless and
            // targets a friendly actor, regardless of what the chainId actually resolves to.
            actionName: 'Prestidigitation (harmless cantrip)',
            actorCombatantId: 999999,
          },
        },
      ],
      usage: { promptTokens: 6, completionTokens: 4, totalTokens: 10 },
    });
    h.script({ text: 'Waiting on the DM.', usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7 } });

    const res = await h.sendMessage(campaignId, { input: 'cast something' });
    expect(res.status).toBe(201);

    const queue = await request(h.server).get(`/api/v1/campaigns/${campaignId}/ai-dm/tool-confirmations`).set(dm);
    expect(queue.body).toHaveLength(1);
    expect(queue.body[0].tool).toBe('apply_action');
    // Only encounterId/chainId survive from the model's own call — the schema no longer even
    // accepts a display field, and the confirmation-queueing path rebuilds args from scratch
    // rather than trusting anything else the call carried. Because this chainId does not exist,
    // no server-derived display fields are added either — an unknown chain gets a generic label,
    // never a caller-supplied one.
    expect(queue.body[0].args).toEqual({ encounterId: 1, chainId: 'chain-does-not-exist' });
  });

  it('#1451: collaborative handoff marks the persisted apply_action chain as awaiting the queued human confirmation', async () => {
    const campaignId = await armed('Retain Delayed Action Approval');
    const driver = h.ctx.app.get(AiDriverService);
    const resolver = h.ctx.app.get(ActionResolverService);
    driver.setCollaborative(campaignId, true);
    const retain = jest
      .spyOn(resolver, 'retainPendingChainForConfirmation')
      .mockReturnValue({ actionName: 'Fireball', actorCombatantId: 42, promoted: true });

    h.script({
      text: 'Holding the spell for approval.',
      toolCalls: [{ id: 'c-retain', name: 'apply_action', arguments: { encounterId: 1, chainId: 'chain-delayed-approval' } }],
      usage: { promptTokens: 6, completionTokens: 4, totalTokens: 10 },
    });
    h.script({ text: 'Waiting on the DM.', usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7 } });

    const res = await h.sendMessage(campaignId, { input: 'cast it' });
    expect(res.status).toBe(201);
    expect(retain).toHaveBeenCalledWith(1, 'chain-delayed-approval');

    const queue = await request(h.server).get(`/api/v1/campaigns/${campaignId}/ai-dm/tool-confirmations`).set(dm);
    expect(queue.body[0].args).toEqual({
      encounterId: 1,
      chainId: 'chain-delayed-approval',
      actionName: 'Fireball',
      actorCombatantId: 42,
    });

    // The trusted labels stay on the confirmation for the DM, but must not be forwarded to the
    // strict apply_action MCP schema when that confirmation is approved.
    const approved = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/ai-dm/tool-confirmation`)
      .set(dm)
      .send({ action: 'approve', confirmationId: queue.body[0].id });
    expect(approved.status).toBe(201);
    expect(approved.body.result.isError).toBe(true); // the intentionally synthetic chain is unknown
    expect(approved.body.result.text).not.toContain('Unrecognized key');
    retain.mockRestore();
  });

  it('#1451 review: a DM approval executes an enriched apply_action confirmation with only its strict tool args', async () => {
    const campaignId = await armed('Approve Enriched Action Confirmation');
    const driver = h.ctx.app.get(AiDriverService);
    const action = {
      name: 'Practice Strike',
      kind: 'melee',
      toHit: '',
      damage: '1 bludgeoning',
      notes: '',
      spec: {
        mode: 'save',
        save: { ability: 'DEX', dc: { kind: 'fixed', dc: 1 } },
        cost: { slot: 'action', count: 1 },
        targets: { count: 1, allow: 'any' },
        outcomes: { failure: { damage: [{ flat: 1, type: 'bludgeoning' }] }, success: { halfDamage: true } },
      },
    };
    const actor = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(dm)
      .send({ name: 'Actor', stats: { DEX: 10 }, ac: 12, hpCurrent: 10, hpMax: 10, ownerUserId: 'ai-eval-player', actions: [action] });
    const target = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(dm)
      .send({ name: 'Target', stats: { DEX: 10 }, ac: 12, hpCurrent: 10, hpMax: 10, ownerUserId: 'other-player' });
    expect(actor.status).toBe(201);
    expect(target.status).toBe(201);
    const encounter = await request(h.server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Practice', hidden: false });
    expect(encounter.status).toBe(201);
    const actorCombatantId = encounter.body.combatants.find((combatant: { characterId: number }) => combatant.characterId === actor.body.id).id;
    const targetCombatantId = encounter.body.combatants.find((combatant: { characterId: number }) => combatant.characterId === target.body.id).id;
    const preview = await request(h.server)
      .post(`/api/v1/encounters/${encounter.body.id}/actions/resolve`)
      .set(dm)
      .send({ actorCombatantId, actionIndex: 0, targetIds: [targetCombatantId], commit: false });
    expect(preview.status).toBe(200);

    driver.setCollaborative(campaignId, true);
    h.script({
      text: 'Hold the practice strike for review.',
      toolCalls: [{ id: 'c-approve', name: 'apply_action', arguments: { encounterId: encounter.body.id, chainId: preview.body.chainId } }],
      usage: { promptTokens: 6, completionTokens: 4, totalTokens: 10 },
    });
    h.script({ text: 'Waiting on the DM.', usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7 } });
    await h.sendMessage(campaignId, { input: 'hold that strike' });

    const queue = await request(h.server).get(`/api/v1/campaigns/${campaignId}/ai-dm/tool-confirmations`).set(dm);
    expect(queue.body[0].args).toMatchObject({
      encounterId: encounter.body.id,
      chainId: preview.body.chainId,
      actionName: 'Practice Strike',
      actorCombatantId,
    });
    const approved = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/ai-dm/tool-confirmation`)
      .set(dm)
      .send({ action: 'approve', confirmationId: queue.body[0].id });
    expect(approved.status).toBe(201);
    expect(approved.body.result.isError).toBe(false);
  });

  it('#1451: rejecting a collaborative apply_action confirmation releases its temporary chain retention', async () => {
    const campaignId = await armed('Release Rejected Action Confirmation');
    const driver = h.ctx.app.get(AiDriverService);
    const resolver = h.ctx.app.get(ActionResolverService);
    driver.setCollaborative(campaignId, true);
    const retain = jest
      .spyOn(resolver, 'retainPendingChainForConfirmation')
      .mockReturnValue({ actionName: 'Fireball', actorCombatantId: 42, promoted: true });
    const release = jest.spyOn(resolver, 'releasePendingChainForConfirmation');

    h.script({
      text: 'Holding the spell for approval.',
      toolCalls: [{ id: 'c-release', name: 'apply_action', arguments: { encounterId: 1, chainId: 'chain-release-on-reject' } }],
      usage: { promptTokens: 6, completionTokens: 4, totalTokens: 10 },
    });
    h.script({ text: 'Waiting on the DM.', usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7 } });
    await h.sendMessage(campaignId, { input: 'cast it' });

    const queued = await request(h.server).get(`/api/v1/campaigns/${campaignId}/ai-dm/tool-confirmations`).set(dm);
    const rejected = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/ai-dm/tool-confirmation`)
      .set(dm)
      .send({ action: 'reject', confirmationId: queued.body[0].id });
    expect(rejected.status).toBe(201);
    expect(release).toHaveBeenCalledWith(1, 'chain-release-on-reject');
    retain.mockRestore();
    release.mockRestore();
  });

  it('#1451: duplicate confirmations retain a shared chain until the final confirmation disappears', async () => {
    const campaignId = await armed('Retain Duplicate Action Confirmations');
    const driver = h.ctx.app.get(AiDriverService);
    const resolver = h.ctx.app.get(ActionResolverService);
    driver.setCollaborative(campaignId, true);
    const retain = jest
      .spyOn(resolver, 'retainPendingChainForConfirmation')
      .mockReturnValueOnce({ actionName: 'Fireball', actorCombatantId: 42, promoted: true })
      .mockReturnValueOnce({ actionName: 'Fireball', actorCombatantId: 42, promoted: false });
    const release = jest.spyOn(resolver, 'releasePendingChainForConfirmation');

    h.script({
      text: 'Holding duplicate calls for approval.',
      toolCalls: [
        { id: 'c-duplicate-1', name: 'apply_action', arguments: { encounterId: 1, chainId: 'chain-duplicate-confirmation' } },
        { id: 'c-duplicate-2', name: 'apply_action', arguments: { encounterId: 1, chainId: 'chain-duplicate-confirmation' } },
      ],
      usage: { promptTokens: 6, completionTokens: 4, totalTokens: 10 },
    });
    h.script({ text: 'Waiting on the DM.', usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7 } });
    await h.sendMessage(campaignId, { input: 'cast it' });

    const queued = await request(h.server).get(`/api/v1/campaigns/${campaignId}/ai-dm/tool-confirmations`).set(dm);
    expect(queued.body).toHaveLength(2);
    for (const confirmation of queued.body) {
      const rejected = await request(h.server)
        .post(`/api/v1/campaigns/${campaignId}/ai-dm/tool-confirmation`)
        .set(dm)
        .send({ action: 'reject', confirmationId: confirmation.id });
      expect(rejected.status).toBe(201);
      if (confirmation === queued.body[0]) {
        expect(release).not.toHaveBeenCalled();
      }
    }
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(1, 'chain-duplicate-confirmation');
    retain.mockRestore();
    release.mockRestore();
  });

  it('#1451 review: a repeated provider call ID is deduplicated before it can retain an unrelated chain', async () => {
    const campaignId = await armed('Deduplicate Before Retaining');
    const driver = h.ctx.app.get(AiDriverService);
    const resolver = h.ctx.app.get(ActionResolverService);
    driver.setCollaborative(campaignId, true);
    const retain = jest
      .spyOn(resolver, 'retainPendingChainForConfirmation')
      .mockReturnValue({ actionName: 'Fireball', actorCombatantId: 42, promoted: true });

    h.script({
      text: 'One provider response reuses its synthetic call ID.',
      toolCalls: [
        { id: 'call_0', name: 'apply_action', arguments: { encounterId: 1, chainId: 'chain-first' } },
        { id: 'call_0', name: 'apply_action', arguments: { encounterId: 1, chainId: 'chain-unowned' } },
      ],
      usage: { promptTokens: 6, completionTokens: 4, totalTokens: 10 },
    });
    h.script({ text: 'Waiting on the DM.', usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7 } });
    await h.sendMessage(campaignId, { input: 'cast it' });

    expect(retain).toHaveBeenCalledTimes(1);
    expect(retain).toHaveBeenCalledWith(1, 'chain-first');
    const queue = await request(h.server).get(`/api/v1/campaigns/${campaignId}/ai-dm/tool-confirmations`).set(dm);
    expect(queue.body).toHaveLength(1);
    expect(queue.body[0].args.chainId).toBe('chain-first');
    retain.mockRestore();
  });

  it('#1451 review: cap eviction keeps a replacement confirmation as the chain retention owner', async () => {
    const campaignId = await armed('Retain Through Cap Eviction');
    const driver = h.ctx.app.get(AiDriverService);
    const resolver = h.ctx.app.get(ActionResolverService);
    driver.setCollaborative(campaignId, true);
    const retain = jest
      .spyOn(resolver, 'retainPendingChainForConfirmation')
      .mockReturnValue({ actionName: 'Fireball', actorCombatantId: 42, promoted: false });
    const release = jest.spyOn(resolver, 'releasePendingChainForConfirmation');
    const session = driver.getSession(campaignId);
    const pendingMap: Record<string, unknown> = {};
    for (let i = 0; i < MAX_PENDING_TOOL_CONFIRMATIONS; i += 1) {
      pendingMap[`begin_encounter:seed_${i}`] = {
        id: `confirm-seed-${i}`,
        tool: 'begin_encounter',
        args: { encounterId: i },
        toolCallId: `seed_${i}`,
        profile: 'live',
        policy: 'confirm',
        requestedAt: `2026-07-27T10:00:${String(i).padStart(2, '0')}.000Z`,
        actor: `ai-dm-seat:${campaignId}`,
        triggeredBy: 'player-1',
        turnNumber: i,
        ...(i === 0 ? { retainedActionChain: { encounterId: 1, chainId: 'chain-cap-replacement' } } : {}),
      };
    }
    (session as unknown as { pendingToolConfirmations: Record<string, unknown> }).pendingToolConfirmations = pendingMap;

    h.script({
      text: 'Replace the oldest chain owner.',
      toolCalls: [{ id: 'call-new', name: 'apply_action', arguments: { encounterId: 1, chainId: 'chain-cap-replacement' } }],
      usage: { promptTokens: 6, completionTokens: 4, totalTokens: 10 },
    });
    h.script({ text: 'Waiting on the DM.', usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7 } });
    await h.sendMessage(campaignId, { input: 'cast it' });

    expect(release).not.toHaveBeenCalledWith(1, 'chain-cap-replacement');
    const queue = await request(h.server).get(`/api/v1/campaigns/${campaignId}/ai-dm/tool-confirmations`).set(dm);
    const replacement = queue.body.find((confirmation: { args: { chainId?: string } }) => confirmation.args.chainId === 'chain-cap-replacement');
    expect(replacement).toBeDefined();
    const rejected = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/ai-dm/tool-confirmation`)
      .set(dm)
      .send({ action: 'reject', confirmationId: replacement.id });
    expect(rejected.status).toBe(201);
    expect(release).toHaveBeenCalledWith(1, 'chain-cap-replacement');
    retain.mockRestore();
    release.mockRestore();
  });

  it('approving through the endpoint the UI now calls actually resolves the queue', async () => {
    const campaignId = await armed('Resolve Clears');
    h.script({
      text: 'Roll for initiative.',
      toolCalls: [{ id: 'c1', name: 'begin_encounter', arguments: { encounterId: 1 } }],
      usage: { promptTokens: 6, completionTokens: 4, totalTokens: 10 },
    });
    h.script({ text: 'ok', usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7 } });
    await h.sendMessage(campaignId, { input: 'we fight' });

    const queued = await request(h.server).get(`/api/v1/campaigns/${campaignId}/ai-dm/tool-confirmations`).set(dm);
    const id = queued.body[0].id as string;

    const rejected = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/ai-dm/tool-confirmation`)
      .set(dm)
      .send({ action: 'reject', confirmationId: id });
    expect(rejected.status).toBe(201);

    const after = await request(h.server).get(`/api/v1/campaigns/${campaignId}/ai-dm/tool-confirmations`).set(dm);
    expect(after.body).toHaveLength(0);
  });
});
