import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { DB } from '../src/db/db.module';
import { aiProviderConfigs } from '../src/db/schema';
import { createAiEvalHarness, dm, player, viewer, type AiEvalHarness } from './ai-eval-harness';
import { mcpToolsToAiSchemas } from '../src/modules/ai-dm/providers/tool-registry';
import { AiProviderError } from '../src/modules/ai-dm/providers/errors';
import {
  AiDriverService,
  setDriverStreamIdleTimeoutMsForTests,
  DRIVER_STREAM_IDLE_TIMEOUT_MS,
} from '../src/modules/ai-driver/ai-driver.service';
import { AiDmStreamService, type AiDmStreamEvent } from '../src/modules/ai-driver/ai-driver-stream.service';
import {
  NARRATION_QUARANTINE_CHARS,
  setNarrationQuarantineCharsForTests,
} from '../src/modules/ai-driver/driver-safety';
import { DEFAULT_IDLE_TIMEOUT_MS } from '../src/modules/ai-dm/providers/http';

/**
 * Driver AI-DM runtime (#312) — the KEYSTONE flow, tested end-to-end and OFFLINE via the
 * #318 harness. The deterministic mock provider (#309) is wired in as BOTH the streaming
 * AiProvider the driver consumes and the legacy text provider, so we can script the model's
 * turns (narration + tool calls + exact usage) and assert the whole loop:
 *   - player input → streamed narration → REAL Campfire tool execution → result fed back →
 *     next turn → budget metered (hard stop) → every step + tool call audited.
 *
 * These fill the `#312 driver` placeholders the harness spec left as `it.todo`.
 */

// The full tool registry is offered to the model by the runtime itself; here we only need a
// couple of MCP-shaped tools for the prompt-assembly-style checks that also touch this path.
const TOOLS = mcpToolsToAiSchemas([
  { name: 'roll_dice', description: 'Roll dice.', inputSchema: { type: 'object', properties: { expr: { type: 'string' } } } },
]);

describe('ai-dm driver runtime — session loop + streamed narration + tool execution (e2e)', () => {
  let h: AiEvalHarness;

  beforeAll(async () => {
    h = await createAiEvalHarness({ model: 'driver-model', tools: TOOLS });
    await h.enableExperimental();
  });

  beforeEach(() => {
    // tool_error / budget_exhausted stops leave unconsumed scripted turns — isolate each case.
    h.resetMock();
  });

  afterAll(async () => {
    await h.close();
  });

  it('#519 readiness: blocked -> safe provider test -> fixed -> driver green with cost estimate', async () => {
    const campaignId = await h.createCampaign('AI Readiness 519');

    const initial = await request(h.server).get(`/api/v1/campaigns/${campaignId}/ai-dm/readiness`).set(dm);
    expect(initial.status).toBe(200);
    expect(initial.body.driverOk).toBe(false);
    expect(initial.body.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'provider', status: 'blocked', requiredForDriver: true }),
        expect.objectContaining({ key: 'budget', status: 'blocked', requiredForDriver: true }),
      ]),
    );
    expect(initial.body.estimatedCost.estimatedTotalTokens).toBeGreaterThan(0);
    // A blocked driver must SAY why (acceptance criterion: never a bare unavailable button).
    expect(typeof initial.body.driverUnavailableReason).toBe('string');
    expect(initial.body.driverUnavailableReason.length).toBeGreaterThan(0);

    const testOnly = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/ai-provider/test`)
      .set(dm)
      .send({ providerType: 'mock', model: 'mock-1', apiKey: '' });
    expect(testOnly.status).toBe(201);
    expect(testOnly.body).toEqual(expect.objectContaining({ ok: true, credentialSource: 'not-required' }));

    const afterTest = await request(h.server).get(`/api/v1/campaigns/${campaignId}/ai-dm/readiness`).set(dm);
    expect(afterTest.status).toBe(200);
    expect(afterTest.body.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'provider', status: 'blocked' })]),
    );

    await h.configureProvider(campaignId);
    const mode = await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 20_000 });
    expect(mode.status).toBe(200);

    const ready = await request(h.server).get(`/api/v1/campaigns/${campaignId}/ai-dm/readiness`).set(dm);
    expect(ready.status).toBe(200);
    expect(ready.body.driverOk).toBe(true);
    expect(ready.body.driverUnavailableReason).toBeNull();
    expect(ready.body.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'driverTools', status: 'ok', requiredForDriver: true }),
        expect.objectContaining({ key: 'secretPolicy', status: 'ok' }),
      ]),
    );
    expect(ready.body.estimatedCost).toEqual(
      expect.objectContaining({
        // No metered turns yet, so the split IS our stated assumption and is reported.
        estimatedPromptTokens: 750,
        estimatedCompletionTokens: 1024,
        estimatedTotalTokens: 1774,
        // No pricing table on this server, so there is no money to report (#1065).
        estimatedUsdRange: null,
      }),
    );
  });

  it('#1065 readiness survives a credential it cannot decrypt, and prices nothing', async () => {
    // The failure this pins: readiness is the screen an operator opens to find out WHY their
    // AI seat stopped working after AI_CONFIG_KEY was lost or rotated. Resolving the provider
    // decrypts the stored key, which throws on a key that no longer matches. A second,
    // unguarded resolve added for the cost basis turned that into a 500 — so the one
    // diagnostic surface that exists for this exact situation became unavailable in it,
    // which is strictly worse than the graceful "provider blocked" it replaced.
    //
    // The cost basis now reuses the config the model check already resolved INSIDE its
    // try/catch, so there is one resolution per request and its failure is already handled.
    const campaignId = await h.createCampaign('AI Readiness 1065 undecryptable key');
    await h.configureProvider(campaignId);
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 20_000 });

    // Corrupt the stored ciphertext in place — the observable equivalent of the server's
    // AI config key having changed under a row that was written with the old one.
    const db = h.ctx.app.get(DB);
    await db
      .update(aiProviderConfigs)
      .set({ encryptedApiKey: 'not-a-decryptable-ciphertext' })
      .where(eq(aiProviderConfigs.campaignId, campaignId));

    const res = await request(h.server).get(`/api/v1/campaigns/${campaignId}/ai-dm/readiness`).set(dm);

    // The whole point: a 200 with a usable checklist, not a 500.
    expect(res.status).toBe(200);
    const modelCheck = res.body.checks.find((c: { key: string }) => c.key === 'model');
    expect(modelCheck).toEqual(expect.objectContaining({ ok: false, status: 'blocked' }));
    expect(res.body.driverOk).toBe(false);

    // And money degrades to the disclosure rather than to a number or to a crash. The reason
    // is the specific one, not the generic `no_provider` — a provider IS configured here, and
    // telling the operator otherwise would send them to re-enter settings already correct.
    expect(res.body.estimatedCost.basis).toEqual({ kind: 'unknown', reason: 'provider_unresolved' });
    expect(res.body.estimatedCost.estimatedUsdRange).toBeNull();
    // The token estimate is independent of pricing and still renders.
    expect(res.body.estimatedCost.estimatedTotalTokens).toBeGreaterThan(0);
  });

  it('#519 readiness never reports driver-ready while the seat mode is off', async () => {
    // Regression: `driverOk` was computed from the configuration checks alone, none of which
    // look at seat.mode/seat.enabled. A table with provider + model + budget all green but the
    // AI switched OFF therefore reported driverOk:true — and the setup checklist painted a
    // "The AI DM is ready … the AI is co-DMing" banner over an AI that does nothing, while
    // `assertRunnable` would 403 the very next turn.
    const campaignId = await h.createCampaign('AI Readiness 519 mode off');
    await h.configureProvider(campaignId);
    // Arm every driver prerequisite, then switch the operating mode back off.
    const armed = await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 20_000 });
    expect(armed.status).toBe(200);
    const ready = await request(h.server).get(`/api/v1/campaigns/${campaignId}/ai-dm/readiness`).set(dm);
    expect(ready.body.driverOk).toBe(true);

    const off = await h.configureSeat(campaignId, { mode: 'off', tokenBudget: 20_000 });
    expect(off.status).toBe(200);

    const res = await request(h.server).get(`/api/v1/campaigns/${campaignId}/ai-dm/readiness`).set(dm);
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('off');
    // Every configuration check still passes …
    for (const check of res.body.checks) {
      if (check.requiredForDriver) expect({ key: check.key, ok: check.ok }).toEqual({ key: check.key, ok: true });
    }
    // … but the seat is not runnable, and readiness says so on both aggregates.
    expect(res.body.driverOk).toBe(false);
    expect(res.body.ok).toBe(false);
    expect(typeof res.body.driverUnavailableReason).toBe('string');
    expect(res.body.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'mode', ok: false, status: 'blocked', detailKey: 'mode.off' }),
      ]),
    );
    // The mode step deep-links to the control that fixes it.
    const modeCheck = res.body.checks.find((c: { key: string }) => c.key === 'mode');
    expect(modeCheck.fixHref).toBe(`/c/${campaignId}/settings#ai-dm-mode`);

    // Co-DM arms the seat for propose-only work: the mode check clears, but the DRIVER
    // aggregate stays false because `assertRunnable` accepts driver mode only.
    const coDm = await h.configureSeat(campaignId, { mode: 'co_dm', tokenBudget: 20_000 });
    expect(coDm.status).toBe(200);
    const asCoDm = await request(h.server).get(`/api/v1/campaigns/${campaignId}/ai-dm/readiness`).set(dm);
    expect(asCoDm.body.ok).toBe(true);
    expect(asCoDm.body.driverOk).toBe(false);
    expect(asCoDm.body.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'mode', ok: true, detailKey: 'mode.coDm' })]),
    );
  });

  it('#519 every readiness check carries a translatable detailKey the web catalog knows', async () => {
    // #629 makes every user-facing string translatable. The checklist renders each check's
    // body from `aiOnboarding.checklist.checkDetails.<detailKey>`, so a check whose id is
    // missing from the English catalog would silently fall back to the server's English.
    const campaignId = await h.createCampaign('AI Readiness 519 i18n');
    await h.configureProvider(campaignId);
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 20_000 });
    const res = await request(h.server).get(`/api/v1/campaigns/${campaignId}/ai-dm/readiness`).set(dm);
    expect(res.status).toBe(200);

    const catalog = JSON.parse(
      readFileSync(resolve(__dirname, '../../web/src/i18n/locales/en/aiOnboarding.json'), 'utf8'),
    ) as {
      aiOnboarding: {
        checklist: { checkDetails: Record<string, Record<string, string>>; checkTitles: Record<string, string> };
      };
    };
    const { checkDetails, checkTitles } = catalog.aiOnboarding.checklist;

    for (const check of res.body.checks as { key: string; detailKey: string; detailParams: unknown }[]) {
      expect(typeof check.detailKey).toBe('string');
      expect(check.detailKey.length).toBeGreaterThan(0);
      expect(check.detailParams).toBeDefined();
      const [group, variant] = check.detailKey.split('.');
      expect({ detailKey: check.detailKey, known: !!checkDetails[group]?.[variant] }).toEqual({
        detailKey: check.detailKey,
        known: true,
      });
      expect({ key: check.key, titled: !!checkTitles[check.key] }).toEqual({ key: check.key, titled: true });
    }
  });

  it('#519 readiness is DM-only and never leaks provider key material', async () => {
    const campaignId = await h.createCampaign('AI Readiness 519 access');
    // The harness stores a REAL (fake) API key on the campaign provider row — the readiness
    // read must expose the provider's shape without any of its credential.
    await h.configureProvider(campaignId);

    for (const actor of [player, viewer]) {
      const res = await request(h.server).get(`/api/v1/campaigns/${campaignId}/ai-dm/readiness`).set(actor);
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).not.toContain('sk-test-key');
    }

    const res = await request(h.server).get(`/api/v1/campaigns/${campaignId}/ai-dm/readiness`).set(dm);
    expect(res.status).toBe(200);
    expect(res.body.provider).toEqual(
      expect.objectContaining({ configured: true, providerType: 'mock', model: 'mock-1', ready: true }),
    );
    // Whole-body secret sweep: neither the key, its last-4, nor any key-bearing field name
    // may appear anywhere in the readiness payload (checks[].detail included).
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('sk-test-key-1234');
    expect(body).not.toContain('1234');
    for (const forbidden of ['apiKey', 'encryptedApiKey', 'keyLast4', 'baseUrl']) {
      expect(body).not.toContain(forbidden);
    }
    // The DM's own steering prompt is likewise not part of the readiness surface.
    expect(body).not.toContain('instructions');
  });

  it('#312 driver: a scripted tool call executes a real campfire tool and feeds the result back', async () => {
    const campaignId = await h.createCampaign('Driver ToolLoop');
    await h.configureSeat(campaignId, { mode: 'driver', instructions: 'Be terse.', tokenBudget: 100_000 });

    // Turn 1: the model rolls dice (a REAL direct-write tool). Turn 2: it narrates the outcome.
    h.script(
      {
        text: 'You test your luck…',
        toolCalls: [{ id: 'call_roll', name: 'roll_dice', arguments: { campaignId, expr: '2d6' } }],
        usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
      },
      { text: 'The die shows a 5 — the lock clicks open.', usage: { promptTokens: 150, completionTokens: 30, totalTokens: 180 } },
    );

    const res = await h.sendMessage(campaignId, { input: 'I pick the lock.' });
    expect(res.status).toBe(201);
    expect(res.body.stopReason).toBe('complete');
    expect(res.body.steps).toBe(2);
    expect(res.body.narration).toBe('The die shows a 5 — the lock clicks open.');

    // The tool actually ran (no error), and was NOT routed to proposals (live play is direct).
    expect(res.body.toolCalls).toEqual([{ name: 'roll_dice', isError: false, proposed: false }]);

    // The result was fed back: the 2nd provider request carries a `tool` message with the roll total.
    const secondReq = h.mock.received.at(-1)!;
    const toolMsg = secondReq.messages.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.toolName).toBe('roll_dice');
    expect(toolMsg!.content).toContain('"total"'); // the real roll result was fed back

    // Budget metered BOTH steps' real usage (120 + 180 = 300).
    expect(res.body.tokensUsed).toBe(300);
    expect(res.body.budgetRemaining).toBe(100_000 - 300);
    expect(res.body.seat.tokensUsed).toBe(300);
  });

  it('#1021 driver: executes loot/treasury tools end-to-end and persists aftermath state', async () => {
    const campaignId = await h.createCampaign('Driver Loot Aftermath');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });

    // Start a live encounter so successful grants append to the combat log (#1021).
    const hero = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(dm)
      .send({ name: 'Loot Hero', stats: { DEX: 14 }, hpCurrent: 12, hpMax: 12 });
    expect(hero.status).toBe(201);
    const enc = await request(h.server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Loot Fight' });
    expect(enc.status).toBe(201);
    const encounterId = enc.body.id as number;
    const rolled = await request(h.server).post(`/api/v1/encounters/${encounterId}/roll-initiative`).set(dm);
    expect(rolled.status).toBe(201);
    const start = await request(h.server).post(`/api/v1/encounters/${encounterId}/start`).set(dm);
    expect(start.status).toBe(201);
    expect(start.body.status).toBe('running');

    h.script(
      {
        text: 'You gather rewards from the fallen foe.',
        toolCalls: [
          { id: 'loot_gold', name: 'adjust_treasury', arguments: { campaignId, delta: { gp: 25 } } },
          {
            id: 'loot_item',
            name: 'add_inventory_item',
            arguments: { campaignId, ownerType: 'party', name: 'Potion of Healing', qty: 1 },
          },
        ],
      },
      { text: 'The spoils are secured.' },
    );

    const grant = await h.sendMessage(campaignId, { input: 'Resolve loot.' });
    expect(grant.status).toBe(201);
    expect(grant.body.toolCalls).toEqual([
      { name: 'adjust_treasury', isError: false, proposed: false, pendingConfirmation: true },
      { name: 'add_inventory_item', isError: false, proposed: false, pendingConfirmation: true },
    ]);

    const pending = await request(h.server).get(`/api/v1/campaigns/${campaignId}/ai-dm/tool-confirmations`).set(dm);
    expect(pending.status).toBe(200);
    expect(pending.body).toHaveLength(2);
    for (const entry of pending.body as Array<{ id: string }>) {
      const approved = await request(h.server)
        .post(`/api/v1/campaigns/${campaignId}/ai-dm/tool-confirmation`)
        .set(dm)
        .send({ action: 'approve', confirmationId: entry.id });
      expect(approved.status).toBe(201);
    }

    const treasury = await request(h.server).get(`/api/v1/campaigns/${campaignId}/treasury`).set(dm);
    expect(treasury.status).toBe(200);
    expect(treasury.body.gp).toBe(25);

    type InvItem = { id: number; name: string; ownerType: string; qty: number };
    const inventory = await request(h.server).get(`/api/v1/campaigns/${campaignId}/inventory`).set(dm);
    expect(inventory.status).toBe(200);
    const potion = (inventory.body as InvItem[]).find((i) => i.name === 'Potion of Healing');
    expect(potion).toEqual(expect.objectContaining({ name: 'Potion of Healing', ownerType: 'party', qty: 1 }));
    if (!potion) throw new Error('expected Potion of Healing in party inventory');

    h.script(
      {
        text: 'You split the stack for the party.',
        toolCalls: [
          {
            id: 'loot_update',
            name: 'update_inventory_item',
            arguments: { itemId: potion.id, qtyDelta: 2, idempotencyKey: 'driver-loot-topup-1' },
          },
        ],
      },
      { text: 'The potion bundle is topped up.' },
    );

    const update = await h.sendMessage(campaignId, { input: 'Add two more potions.' });
    expect(update.status).toBe(201);
    expect(update.body.toolCalls).toEqual([
      { name: 'update_inventory_item', isError: false, proposed: false, pendingConfirmation: true },
    ]);

    const pendingUpdate = await request(h.server).get(`/api/v1/campaigns/${campaignId}/ai-dm/tool-confirmations`).set(dm);
    expect(pendingUpdate.status).toBe(200);
    expect(pendingUpdate.body).toHaveLength(1);
    const approvedUpdate = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/ai-dm/tool-confirmation`)
      .set(dm)
      .send({ action: 'approve', confirmationId: pendingUpdate.body[0].id });
    expect(approvedUpdate.status).toBe(201);

    const inventoryAfter = await request(h.server).get(`/api/v1/campaigns/${campaignId}/inventory`).set(dm);
    expect(inventoryAfter.status).toBe(200);
    const potionAfter = (inventoryAfter.body as InvItem[]).find((i) => i.id === potion.id);
    expect(potionAfter).toBeDefined();
    if (!potionAfter) throw new Error('expected topped-up potion in party inventory');
    expect(potionAfter.qty).toBe(3);

    // Grants appear in the persistent encounter combat log (not only a transient toast).
    const events = await request(h.server).get(`/api/v1/encounters/${encounterId}/events`).set(dm);
    expect(events.status).toBe(200);
    const notes = (events.body as Array<{ type: string; actor: string | null; detail: string }>).filter(
      (e) => e.type === 'note' && e.actor === 'AI DM',
    );
    expect(notes.some((e) => e.detail.includes('Granted treasury') && e.detail.includes('+25 gp'))).toBe(true);
    expect(notes.some((e) => e.detail.includes('Granted item: Potion of Healing'))).toBe(true);
    expect(notes.some((e) => e.detail.includes('Increased party item quantity by +2'))).toBe(true);

    const audit = await h.getAudit(campaignId);
    const driverToolEvents = audit.body.filter((e: { action: string }) => e.action === 'ai-dm.driver.tool');
    const seatActor = `ai-dm-seat:${campaignId}`;
    expect(driverToolEvents.length).toBeGreaterThanOrEqual(3);
    expect(driverToolEvents.every((e: { actor: string }) => e.actor === seatActor)).toBe(true);
    expect(audit.body.some((e: { action: string }) => e.action === 'treasury.update')).toBe(true);
    expect(audit.body.some((e: { action: string }) => e.action === 'item.create')).toBe(true);
    expect(audit.body.some((e: { action: string }) => e.action === 'item.update')).toBe(true);
  });

  it('#1021 driver: blocks treasury spends at execution time', async () => {
    const campaignId = await h.createCampaign('Driver Treasury Guard');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });

    h.script(
      {
        text: 'I will adjust party funds.',
        toolCalls: [{ id: 'spend_gold', name: 'adjust_treasury', arguments: { campaignId, delta: { gp: -5 } } }],
      },
      { text: 'I cannot reduce treasury directly without review.' },
    );

    const res = await h.sendMessage(campaignId, { input: 'Spend 5 gp from party funds.' });
    expect(res.status).toBe(201);
    expect(res.body.toolCalls).toEqual([{ name: 'adjust_treasury', isError: true, proposed: false }]);

    const treasury = await request(h.server).get(`/api/v1/campaigns/${campaignId}/treasury`).set(dm);
    expect(treasury.status).toBe(200);
    expect(treasury.body).toMatchObject({ cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 });
  });

  it('#312 driver: multi-step tool loop terminates on a stop turn and audits each step', async () => {
    const campaignId = await h.createCampaign('Driver Audit');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });

    h.script(
      { text: 'rolling', toolCalls: [{ id: 'c1', name: 'roll_dice', arguments: { campaignId, expr: '2d6' } }] },
      { text: 'done — no more tools.' },
    );
    const res = await h.sendMessage(campaignId, { input: 'go' });
    expect(res.status).toBe(201);
    expect(res.body.stopReason).toBe('complete');

    // Every step + tool call is audited under the seat actor.
    const audit = await h.getAudit(campaignId);
    const actions = audit.body.map((e: { action: string }) => e.action);
    expect(actions.filter((a: string) => a === 'ai-dm.driver.turn')).toHaveLength(2); // two provider steps
    expect(actions.filter((a: string) => a === 'ai-dm.driver.tool')).toHaveLength(1); // one tool call
    const seatActor = audit.body.find((e: { action: string }) => e.action === 'ai-dm.driver.tool');
    expect(seatActor.actor).toBe(`ai-dm-seat:${campaignId}`);
  });

  it('#312 driver: a canon write it cannot make directly becomes a PROPOSAL', async () => {
    const campaignId = await h.createCampaign('Driver Proposals');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });

    // The model tries to create a quest (canon). The runtime forces it onto the proposal path.
    h.script(
      {
        text: 'A new thread emerges…',
        toolCalls: [{ id: 'q1', name: 'create_quest', arguments: { campaignId, title: 'The Missing Heir' } }],
      },
      { text: 'The rumor spreads through the tavern.' },
    );
    const res = await h.sendMessage(campaignId, { input: 'What quest could we take on?' });
    expect(res.status).toBe(201);
    expect(res.body.toolCalls).toEqual([{ name: 'create_quest', isError: false, proposed: true }]);

    // It landed as a PENDING proposal, not a directly-created quest.
    const proposals = await request(h.server).get(`/api/v1/campaigns/${campaignId}/proposals`).set(dm);
    expect(proposals.status).toBe(200);
    const pending = proposals.body.filter((p: { status: string; entityType: string }) => p.status === 'pending' && p.entityType === 'quest');
    expect(pending).toHaveLength(1);

    // No quest was written directly.
    const quests = await request(h.server).get(`/api/v1/campaigns/${campaignId}/quests`).set(dm);
    expect(quests.body.find((q: { title: string }) => q.title === 'The Missing Heir')).toBeUndefined();
  });

  it('#312 driver: streams narration token-by-token over the SSE channel', async () => {
    const campaignId = await h.createCampaign('Driver Stream');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });

    // Subscribe to the in-process narration stream (what GET /ai-dm/stream fans out over SSE).
    const streamSvc = h.ctx.app.get(AiDmStreamService);
    const events: AiDmStreamEvent[] = [];
    const sub = streamSvc.streamFor(campaignId).subscribe((e) => events.push(e));

    // #598: token-by-token delivery is what this case asserts, and the safety quarantine is a
    // TRAILING delay line — a 42-character reply is shorter than the window, so it would be
    // released as one blob at end of stream. Switch the window off for this case: what is under
    // test here is the delta pipeline's chunking, not the delay. The window's own effect on
    // delivery (and its interaction with a refusal) is covered by the #598 e2e suite, and the
    // no-blob property below still proves the pipeline forwards each provider chunk.
    setNarrationQuarantineCharsForTests(0);
    try {
      h.script({ text: 'The torches gutter as the door swings wide.', streamChunks: 4 });
      await h.sendMessage(campaignId, { input: 'We enter the crypt.' });
    } finally {
      setNarrationQuarantineCharsForTests(NARRATION_QUARANTINE_CHARS);
      sub.unsubscribe();
    }

    const deltas = events.filter((e) => e.type === 'narration.delta');
    expect(deltas.length).toBeGreaterThan(1); // multiple token chunks, not one blob
    const reassembled = deltas.map((e) => (e.type === 'narration.delta' ? e.text : '')).join('');
    expect(reassembled).toBe('The torches gutter as the door swings wide.');
    expect(events.some((e) => e.type === 'turn.start')).toBe(true);
    expect(events.some((e) => e.type === 'turn.end')).toBe(true);
  });

  it('#312 driver: budget is a HARD stop — the loop halts and the next turn 403s', async () => {
    const campaignId = await h.createCampaign('Driver Budget');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 200 });

    // Step 1 overruns the whole budget AND asks for another tool → the loop must stop before step 2.
    h.script(
      {
        text: 'burning tokens',
        toolCalls: [{ id: 'b1', name: 'roll_dice', arguments: { campaignId, expr: '2d6' } }],
        usage: { promptTokens: 300, completionTokens: 0, totalTokens: 300 },
      },
      { text: 'should never run' },
    );
    const res = await h.sendMessage(campaignId, { input: 'go' });
    expect(res.status).toBe(201);
    expect(res.body.stopReason).toBe('budget_exhausted');
    expect(res.body.budgetRemaining).toBe(0);
    expect(res.body.steps).toBe(1); // step 2 never streamed

    // The next turn is refused outright — budget exhausted.
    const again = await h.sendMessage(campaignId, { input: 'again' });
    expect(again.status).toBe(403);
    expect(again.body.message).toContain('budget exhausted');
  });

  it('#1076 driver: estimates budget usage when provider omits streaming usage and narration is done-only', async () => {
    const campaignId = await h.createCampaign('Driver Usage Estimate');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });

    const narration = 'The oracle speaks only in the final frame.';
    h.script({
      text: narration,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      streamTextDeltas: false,
    });

    const res = await h.sendMessage(campaignId, { input: 'Ask the oracle.' });
    expect(res.status).toBe(201);
    expect(res.body.tokensUsed).toBeGreaterThan(0);
    expect(res.body.seat.tokensUsed).toBeGreaterThan(0);
  });
});

describe('ai-dm driver runtime — gating + access (e2e)', () => {
  let h: AiEvalHarness;
  let campaignId: number;

  beforeAll(async () => {
    h = await createAiEvalHarness({ model: 'driver-model' });
    campaignId = await h.createCampaign('Driver Gating');
  });

  beforeEach(() => {
    h.resetMock();
  });

  afterAll(async () => {
    await h.close();
  });

  it('rejects input when the server experimental flag is off (403)', async () => {
    const res = await h.sendMessage(campaignId, { input: 'go' });
    expect(res.status).toBe(403);
  });

  it('rejects input when the seat is not enabled (403), even with the flag on', async () => {
    await h.enableExperimental();
    const res = await h.sendMessage(campaignId, { input: 'go' });
    expect(res.status).toBe(403);
  });

  it('a viewer cannot drive the seat but can watch the session state', async () => {
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 10_000 });
    const drive = await request(h.server).post(`/api/v1/campaigns/${campaignId}/ai-dm/message`).set(viewer).send({ input: 'go' });
    expect(drive.status).toBe(403);
    const session = await request(h.server).get(`/api/v1/campaigns/${campaignId}/ai-dm/session`).set(viewer);
    expect(session.status).toBe(200);
    expect(session.body.status).toBeDefined();
  });

  it('a paused seat refuses new input until resumed', async () => {
    // Pausing rejects BEFORE the provider is called, so no script is consumed here.
    await request(h.server).post(`/api/v1/campaigns/${campaignId}/ai-dm/pause`).set(dm).send({ paused: true });
    const paused = await h.sendMessage(campaignId, { input: 'go' });
    expect(paused.status).toBe(503);

    await request(h.server).post(`/api/v1/campaigns/${campaignId}/ai-dm/pause`).set(dm).send({ paused: false });
    h.script({ text: 'we are back' });
    const resumed = await h.sendMessage(campaignId, { input: 'go' });
    expect(resumed.status).toBe(201);
    expect(resumed.body.narration).toBe('we are back');
  });

  it('a player (not just the DM) can submit input — the AI still acts as the seat, not the player', async () => {
    h.script({ text: 'the player speaks and the world answers' });
    const res = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/ai-dm/message`)
      .set(player)
      .send({ input: 'I look around the tavern' });
    expect(res.status).toBe(201);
    expect(res.body.narration).toBe('the player speaks and the world answers');
  });
});

/**
 * Issue #1071 — leaving Driver mode must tear down the live in-memory driver session.
 * Without this, a driver→off/co_dm→driver cycle can strand the seat behind human_control
 * (or stuck/vote/paused state) with no obvious handback for the DM to perform.
 */
describe('ai-dm driver — mode-switch session teardown (#1071)', () => {
  let h: AiEvalHarness;

  beforeAll(async () => {
    h = await createAiEvalHarness({ model: 'driver-teardown-model' });
    await h.enableExperimental();
  });
  beforeEach(() => {
    h.resetMock();
  });
  afterAll(async () => {
    await h.close();
  });

  async function armDriverWithHumanControl(name: string): Promise<number> {
    const campaignId = await h.createCampaign(name);
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });
    const grant = await h.lever(campaignId, 'grant-takeover', { note: 'table freeze' }, dm);
    expect(grant.status).toBe(201);
    expect(grant.body.state).toBe('human_control');
    expect(grant.body.actingDm).not.toBeNull();
    // Confirm the stranded-session failure mode the teardown closes.
    const frozen = await h.sendMessage(campaignId, { input: 'AI, narrate' });
    expect(frozen.status).toBe(503);
    expect(frozen.body.message).toContain('human');
    return campaignId;
  }

  it('switching to off resets the driver session to fresh idle and emits a lifecycle state SSE', async () => {
    const campaignId = await armDriverWithHumanControl('Teardown Off');

    const streamSvc = h.ctx.app.get(AiDmStreamService);
    const events: AiDmStreamEvent[] = [];
    const sub = streamSvc.streamFor(campaignId).subscribe((e) => events.push(e));

    const off = await h.configureSeat(campaignId, { mode: 'off' });
    sub.unsubscribe();
    expect(off.status).toBe(200);
    expect(off.body.mode).toBe('off');

    const session = await h.getDriverSession(campaignId);
    expect(session.body.status).toBe('idle');
    expect(session.body.state).toBe('running');
    expect(session.body.actingDm).toBeNull();
    expect(session.body.vote).toBeNull();
    expect(session.body.stuck).toBeNull();

    const stateEv = events.find((e) => e.type === 'state');
    expect(stateEv).toBeDefined();
    expect(stateEv && stateEv.type === 'state' && stateEv.state).toBe('running');
  });

  it('switching to co_dm clears stuck/vote/status and re-selecting Driver starts clean', async () => {
    const campaignId = await h.createCampaign('Teardown CoDM');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });

    // Park the seat with stuck + an open vote so teardown has more than actingDm to clear.
    h.script({
      text: 'I reach for the dice…',
      toolCalls: [{ id: 'boom', name: 'no_such_tool', arguments: {} }],
    });
    const stuckTurn = await h.sendMessage(campaignId, { input: 'I pick the lock.' });
    expect(stuckTurn.status).toBe(201);
    expect((await h.getDriverSession(campaignId)).body.state).toBe('awaiting_players');

    const opened = await h.lever(campaignId, 'vote', { action: 'open', kind: 'pause' }, player);
    expect(opened.status).toBe(201);
    expect(opened.body.vote).not.toBeNull();

    const streamSvc = h.ctx.app.get(AiDmStreamService);
    const events: AiDmStreamEvent[] = [];
    const sub = streamSvc.streamFor(campaignId).subscribe((e) => events.push(e));

    const coDm = await h.configureSeat(campaignId, { mode: 'co_dm' });
    sub.unsubscribe();
    expect(coDm.status).toBe(200);
    expect(coDm.body.mode).toBe('co_dm');

    const cleared = await h.getDriverSession(campaignId);
    expect(cleared.body.status).toBe('idle');
    expect(cleared.body.state).toBe('running');
    expect(cleared.body.stuck).toBeNull();
    expect(cleared.body.vote).toBeNull();
    expect(cleared.body.actingDm).toBeNull();
    expect(events.some((e) => e.type === 'state' && e.state === 'running')).toBe(true);

    // Re-select Driver — must run turns without a handback.
    const back = await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });
    expect(back.status).toBe(200);
    expect(back.body.mode).toBe('driver');

    h.script({ text: 'A clean table. The story continues.' });
    const resumed = await h.sendMessage(campaignId, { input: 'onward' });
    expect(resumed.status).toBe(201);
    expect(resumed.body.narration).toBe('A clean table. The story continues.');
  });

  it('driver→off→driver after human_control does not require handback', async () => {
    const campaignId = await armDriverWithHumanControl('Teardown Cycle');

    await h.configureSeat(campaignId, { mode: 'off' });
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });

    h.script({ text: 'Fresh seat, no stranded handback.' });
    const res = await h.sendMessage(campaignId, { input: 'begin' });
    expect(res.status).toBe(201);
    expect(res.body.narration).toBe('Fresh seat, no stranded handback.');
  });

  it('teardown mid-turn detaches the orphaned turn so a replacement session can run cleanly', async () => {
    const campaignId = await h.createCampaign('Teardown Mid-Turn Race');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });

    const driver = h.ctx.app.get(AiDriverService);
    const streamSvc = h.ctx.app.get(AiDmStreamService);
    const user = { id: 'dev:ai-eval-dm', name: 'ai-eval-dm', serverRole: 'user' as const, devRole: 'dm' as const };

    // On the first streamed token, tear down — same shape as a driver→off mid-narration.
    let toreDown = false;
    const deltas: string[] = [];
    const sub = streamSvc.streamFor(campaignId).subscribe((e: AiDmStreamEvent) => {
      if (e.type === 'narration.delta') {
        deltas.push(e.text);
        if (!toreDown) {
          toreDown = true;
          driver.teardownSession(campaignId);
        }
      }
    });

    h.script({ text: 'ABCDEFGH', streamChunks: 8 });
    const orphaned = await driver.runTurn(campaignId, user, 'go');
    sub.unsubscribe();

    expect(toreDown).toBe(true);
    expect(orphaned.stopReason).toBe('aborted');
    // Detached after the first delta — remaining chunks must not reach the SSE channel.
    expect(deltas.length).toBe(1);

    // Map holds a fresh idle session; a follow-up turn must not 409 against the orphan.
    const session = await h.getDriverSession(campaignId);
    expect(session.body.status).toBe('idle');
    expect(session.body.state).toBe('running');

    h.script({ text: 'Clean seat after mid-turn teardown.' });
    const resumed = await h.sendMessage(campaignId, { input: 'again' });
    expect(resumed.status).toBe(201);
    expect(resumed.body.narration).toBe('Clean seat after mid-turn teardown.');
  });
});

/**
 * Issue #1046 — a provider streaming failure must emit turn.end with provider_error so
 * every SSE client's composer unlocks, and park the seat in awaiting_players for retry.
 */
describe('ai-dm driver — provider streaming failure unlocks composers (#1046)', () => {
  let h: AiEvalHarness;

  beforeAll(async () => {
    h = await createAiEvalHarness({ model: 'driver-provider-error-model' });
    await h.enableExperimental();
  });

  beforeEach(() => {
    h.resetMock();
  });

  afterAll(async () => {
    await h.close();
  });

  it('emits turn.end with provider_error, audits, and parks awaiting_players', async () => {
    const campaignId = await h.createCampaign('Driver Provider Error');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });

    const streamSvc = h.ctx.app.get(AiDmStreamService);
    const events: AiDmStreamEvent[] = [];
    const sub = streamSvc.streamFor(campaignId).subscribe((e) => events.push(e));

    // Mid-stream 500: yield one token, then throw (the repro in the issue).
    h.script({
      text: 'The mist thickens around you…',
      streamChunks: 4,
      throwAfterChunks: 1,
      throwError: new AiProviderError('server', 'mock: upstream HTTP 500', {
        provider: 'mock',
        status: 500,
      }),
    });

    const res = await h.sendMessage(campaignId, { input: 'We press on.' });
    sub.unsubscribe();

    expect(res.status).toBe(201);
    expect(res.body.stopReason).toBe('provider_error');

    expect(events.some((e) => e.type === 'turn.start')).toBe(true);
    expect(events.some((e) => e.type === 'turn.error')).toBe(true);
    const end = events.find((e) => e.type === 'turn.end');
    expect(end).toBeDefined();
    expect(end && end.type === 'turn.end' && end.stopReason).toBe('provider_error');
    // Partial narration reached clients before the failure.
    expect(events.some((e) => e.type === 'narration.delta')).toBe(true);

    const session = await h.getDriverSession(campaignId);
    expect(session.body.status).toBe('idle');
    expect(session.body.state).toBe('awaiting_players');
    expect(session.body.stuck?.reason).toBe('provider_error');

    const audit = await h.getAudit(campaignId);
    const actions = audit.body.map((e: { action: string }) => e.action);
    expect(actions).toContain('ai-dm.driver.provider_error');

    // Composer unlocked + seat released: a follow-up turn must not 409.
    h.script({ text: 'The mist clears. The table can retry.' });
    const again = await h.sendMessage(campaignId, { input: 'retry' });
    expect(again.status).not.toBe(409);
    expect(again.status).toBe(201);
    expect(again.body.stopReason).toBe('complete');
  });
});

/**
 * Issue #1063 — a provider stream that stalls mid-body must idle-timeout, emit turn.end,
 * release the seat, and NOT permanently 409 every future turn.
 */
describe('ai-dm driver — stream idle timeout recovery (#1063)', () => {
  let h: AiEvalHarness;
  const prevIdle = DRIVER_STREAM_IDLE_TIMEOUT_MS;

  beforeAll(async () => {
    h = await createAiEvalHarness({ model: 'driver-idle-model' });
    await h.enableExperimental();
  });

  beforeEach(() => {
    h.resetMock();
    setDriverStreamIdleTimeoutMsForTests(500);
  });

  afterEach(() => {
    setDriverStreamIdleTimeoutMsForTests(DEFAULT_IDLE_TIMEOUT_MS);
  });

  afterAll(async () => {
    setDriverStreamIdleTimeoutMsForTests(prevIdle || DEFAULT_IDLE_TIMEOUT_MS);
    await h.close();
  });

  it('a stream that stalls mid-body aborts, emits turn.end, and does not permanently 409', async () => {
    const campaignId = await h.createCampaign('Driver Idle Stall');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });

    const streamSvc = h.ctx.app.get(AiDmStreamService);
    const events: AiDmStreamEvent[] = [];
    const sub = streamSvc.streamFor(campaignId).subscribe((e) => events.push(e));

    // Yield one chunk, then hang until the driver's AbortSignal fires.
    h.script({
      text: 'The corridor stretches into darkness…',
      streamChunks: 4,
      stallAfterChunks: 1,
    });

    const res = await h.sendMessage(campaignId, { input: 'We advance carefully.' });
    sub.unsubscribe();

    expect(res.status).toBe(201);
    expect(res.body.stopReason).toBe('provider_error');

    const end = events.find((e) => e.type === 'turn.end');
    expect(end).toBeDefined();
    expect(end && end.type === 'turn.end' && end.stopReason).toBe('provider_error');
    expect(events.some((e) => e.type === 'turn.start')).toBe(true);

    // Seat released — a follow-up turn must NOT 409 (the wedge the issue describes).
    const session = await h.getDriverSession(campaignId);
    expect(session.body.status).toBe('idle');
    expect(session.body.state).toBe('awaiting_players');
    expect(session.body.stuck?.reason).toBe('provider_error');

    // Recovery: nudge/retry after scripting a clean reply.
    h.script({ text: 'The darkness parts. Play continues.' });
    const again = await h.sendMessage(campaignId, { input: 'try again' });
    expect(again.status).not.toBe(409);
    expect(again.status).toBe(201);
    expect(again.body.stopReason).toBe('complete');
  });
});

/**
 * Issue #560 — provider failures must emit terminal turn.error/end, meter partial usage when
 * reported, record usage as unknown (never zero-by-assumption) otherwise, and offer retry +
 * continue-without-AI recovery levers.
 */
describe('ai-dm driver — provider failure termination + partial usage (#560)', () => {
  let h: AiEvalHarness;

  beforeAll(async () => {
    h = await createAiEvalHarness({ model: 'driver-provider-failure-model' });
    await h.enableExperimental();
  });

  beforeEach(() => {
    h.resetMock();
  });

  afterAll(async () => {
    await h.close();
  });

  it('failure before output emits turn.error/end, marks usage unknown, and offers recovery levers', async () => {
    const campaignId = await h.createCampaign('Driver Provider Failure Before Output');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });

    const seatBefore = await h.getSeat(campaignId);
    const usedBefore = seatBefore.body.tokensUsed as number;

    const streamSvc = h.ctx.app.get(AiDmStreamService);
    const events: AiDmStreamEvent[] = [];
    const sub = streamSvc.streamFor(campaignId).subscribe((e) => events.push(e));

    // #1052: a `transport` failure with nothing on the wire is now RETRIED, so a single
    // scripted failure would be recovered from and this case would no longer reach the
    // terminal path it exists to test. Script enough failures to exhaust the attempt budget
    // (2 against the primary, with no fallback configured on this harness) — what #560 is
    // about is what happens once the provider is genuinely unavailable, not how many tries
    // it took to establish that.
    const offline = () => ({
      text: 'Never delivered.',
      throwAfterChunks: 0,
      throwError: new AiProviderError('transport', 'mock: connection reset', { provider: 'mock' }),
    });
    h.script(offline(), offline());

    const res = await h.sendMessage(campaignId, { input: 'Hello?' });
    sub.unsubscribe();

    expect(res.status).toBe(201);
    expect(res.body.stopReason).toBe('provider_error');

    const err = events.find((e) => e.type === 'turn.error');
    expect(err && err.type === 'turn.error' && err.tokensUsageUnknown).toBe(true);
    const end = events.find((e) => e.type === 'turn.end');
    expect(end && end.type === 'turn.end' && end.stopReason).toBe('provider_error');
    expect(end && end.type === 'turn.end' && end.tokensUsageUnknown).toBe(true);

    const session = await h.getDriverSession(campaignId);
    expect(session.body.stuck?.reason).toBe('provider_error');
    expect(session.body.levers).toEqual(expect.arrayContaining(['retry', 'continue_without_ai']));

    const seatAfter = await h.getSeat(campaignId);
    expect(seatAfter.body.tokensUsed).toBe(usedBefore);
  });

  it('meters partial usage after partial streamed text', async () => {
    const campaignId = await h.createCampaign('Driver Provider Failure Partial Text');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });

    const seatBefore = await h.getSeat(campaignId);
    const usedBefore = seatBefore.body.tokensUsed as number;

    h.script({
      text: 'The mist thickens around you…',
      streamChunks: 4,
      throwAfterChunks: 1,
      throwError: new AiProviderError('server', 'mock: upstream HTTP 500', { provider: 'mock', status: 500 }),
    });

    const res = await h.sendMessage(campaignId, { input: 'We press on.' });
    expect(res.status).toBe(201);
    expect(res.body.stopReason).toBe('provider_error');
    expect(res.body.tokensUsed).toBeGreaterThan(0);

    const seatAfter = await h.getSeat(campaignId);
    expect(seatAfter.body.tokensUsed).toBeGreaterThan(usedBefore);
  });

  it('meters reported usage when failure happens after a usage frame', async () => {
    const campaignId = await h.createCampaign('Driver Provider Failure After Usage');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });

    const seatBefore = await h.getSeat(campaignId);
    const usedBefore = seatBefore.body.tokensUsed as number;

    h.script({
      text: 'A short line.',
      usage: { promptTokens: 12, completionTokens: 8, totalTokens: 20 },
      throwAfterUsage: true,
      throwError: new AiProviderError('server', 'mock: truncated stream', { provider: 'mock' }),
    });

    const res = await h.sendMessage(campaignId, { input: 'Look around.' });
    expect(res.status).toBe(201);
    expect(res.body.stopReason).toBe('provider_error');
    expect(res.body.tokensUsed).toBe(20);

    const seatAfter = await h.getSeat(campaignId);
    expect(seatAfter.body.tokensUsed - usedBefore).toBe(20);
  });

  it('meters estimated usage when failure happens during tool-call fragments', async () => {
    const campaignId = await h.createCampaign('Driver Provider Failure Tool Call');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });

    h.script({
      text: '',
      toolCalls: [{ id: 'call_1', name: 'roll_dice', arguments: { expr: '1d20' } }],
      throwDuringToolCall: true,
      throwError: new AiProviderError('invalid_request', 'mock: malformed tool stream', { provider: 'mock' }),
    });

    const res = await h.sendMessage(campaignId, { input: 'Roll initiative.' });
    expect(res.status).toBe(201);
    expect(res.body.stopReason).toBe('provider_error');
    expect(res.body.tokensUsed).toBeGreaterThan(0);
  });

  it('continue-without-ai lets a DM take human control after provider_error', async () => {
    const campaignId = await h.createCampaign('Driver Continue Without AI');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });

    // #1052: two failures, so the retry budget is exhausted and the seat genuinely lands on
    // the stuck ladder — which is the precondition this lever test needs.
    const offline = () => ({
      throwAfterChunks: 0,
      throwError: new AiProviderError('transport', 'mock: offline', { provider: 'mock' }),
    });
    h.script(offline(), offline());
    await h.sendMessage(campaignId, { input: 'Any action.' });

    const cont = await h.lever(campaignId, 'continue-without-ai');
    expect(cont.status).toBe(201);
    expect(cont.body.state).toBe('human_control');
    expect(cont.body.stuck).toBeNull();
  });

  it('#1500 a length-truncated turn (finishReason length, no tool calls) is truncated, not complete', async () => {
    const campaignId = await h.createCampaign('Driver Truncated Turn');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });

    // The provider hit the per-step token cap mid-sentence: partial prose, no tool calls.
    h.script({ text: 'The dragon opens its mout', finishReason: 'length' });

    const res = await h.sendMessage(campaignId, { input: 'What does the dragon do?' });
    expect(res.status).toBe(201);
    // NOT 'complete' — the fragment is delivered but the turn is flagged incomplete (#1500).
    expect(res.body.stopReason).toBe('truncated');
    expect(res.body.narration).toBe('The dragon opens its mout');
    expect(res.body.steps).toBe(1);

    // The stuck ladder parks the seat for a human (retry / nudge) on a `truncated` rung.
    const session = await h.getDriverSession(campaignId);
    expect(session.body.state).toBe('awaiting_players');
    expect(session.body.stuck.reason).toBe('truncated');

    // The one scripted turn was consumed exactly once — no echo fallback (no echo-pass).
    h.assertScriptDrained();
  });

  it('#1500 the iteration cap ends the loop at max_steps without consuming the next scripted turn', async () => {
    const campaignId = await h.createCampaign('Driver Step Cap');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });

    // Four scripted turns that each keep the loop going (a tool call, so it never exits via
    // 'complete'). Drive with maxSteps: 3 — the cap must fire on the third step.
    const looping = (n: number) => ({
      text: `working ${n}…`,
      toolCalls: [{ id: `call_${n}`, name: 'roll_dice', arguments: { campaignId, expr: '1d20' } }],
    });
    h.script(looping(1), looping(2), looping(3), looping(4));

    const res = await h.sendMessage(campaignId, { input: 'Keep going.', maxSteps: 3 });
    expect(res.status).toBe(201);
    expect(res.body.stopReason).toBe('max_steps');
    expect(res.body.steps).toBe(3);

    // Only three provider calls were made — the fourth scripted turn was never consumed.
    expect(h.mock.received).toHaveLength(3);

    const session = await h.getDriverSession(campaignId);
    expect(session.body.state).toBe('awaiting_players');
    expect(session.body.stuck.reason).toBe('max_steps');

    // No echo fallback fired (3 scripted turns consumed, 1 intentionally left over).
    h.assertScriptDrained();
  });

  it('#1500 the eval-harness guards fail loudly once the mock echo-passes (no silent green)', async () => {
    const campaignId = await h.createCampaign('Driver Echo Guard');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });

    // Script nothing for this turn: the driver's single provider call overshoots the canned queue
    // and the mock serves its echo fallback (`echo: <prompt>`, finishReason 'stop', no tool calls) —
    // the exact shape a desynced test silently reads as a clean `complete` (#1500 §3).
    const res = await h.sendMessage(campaignId, { input: 'Unscripted turn.' });
    expect(res.status).toBe(201);
    // The echo genuinely looks finished ...
    expect(res.body.stopReason).toBe('complete');
    expect(h.mock.echoFallbacks).toBeGreaterThanOrEqual(1);
    expect(h.mock.isExhausted).toBe(true);
    // ... so the harness guard must fail loudly instead of echo-passing.
    expect(() => h.assertScriptDrained()).toThrow(/echo fallback/);
    // And a later script() push is refused — it would land behind the cursor and be silently dropped.
    expect(() => h.script({ text: 'too late' })).toThrow(/silently dropped/);

    // resetMock() re-arms a fresh queue: scripting works again, the scripted turn is
    // genuinely consumed (not silently dropped behind a stale cursor), and the guard
    // is clean. (Strengthened per Copilot review #1846.)
    h.resetMock();
    expect(() => h.script({ text: 'fresh queue after reset' })).not.toThrow();
    const fresh = await h.sendMessage(campaignId, { input: 'Consume the reset.' });
    expect(fresh.status).toBe(201);
    expect(fresh.body.narration).toContain('fresh queue after reset');
    h.assertScriptDrained();
  });
});
