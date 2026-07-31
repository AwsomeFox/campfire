import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';
import { DB, type DrizzleDb } from '../src/db/db.module';
import { inboxSweepItems, inboxSweepJobs } from '../src/db/schema';
import { nowIso } from '../src/common/time';
import { AiProviderConfigService } from '../src/modules/ai-provider-config/ai-provider-config.service';
import type { AiProviderConfig } from '../src/modules/ai-dm/providers';
import { InboxSweepService } from '../src/modules/inbox-sweep/inbox-sweep.service';
import { NOTES_LIST_DEFAULT_LIMIT } from '@campfire/schema';
import {
  INBOX_SWEEP_CLASSIFIER,
  InvalidInboxSweepClassificationError,
  NoProviderConfiguredError,
  type InboxSweepCapture,
  type InboxSweepClassification,
  type InboxSweepClassifier,
  type InboxSweepContext,
} from '../src/modules/inbox-sweep/inbox-sweep-classifier';

/**
 * Inbox sweep (issue #1644) — server orchestration + REST endpoint.
 *
 * Overrides the classifier DI seam with a scripted fake (mirrors how the AI eval
 * harness overrides AI_DM_PROVIDER for the scribe): each capture's body is looked up
 * in a script map, so a test controls exactly what the "model" decides without any
 * live provider call. This exercises the REAL orchestration — auth gate, campaign
 * context bootstrap, proposal filing, inbox resolution, idempotency ledger, archived
 * gate — against real SQLite + a real HTTP server.
 */
const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'sweep-dm' };
const player = { 'x-dev-role': 'player', 'x-dev-user': 'sweep-player' };
const viewer = { 'x-dev-role': 'viewer', 'x-dev-user': 'sweep-viewer' };

class ScriptedClassifier implements InboxSweepClassifier {
  script = new Map<string, InboxSweepClassification>();
  calls: Array<{ capture: InboxSweepCapture; context: InboxSweepContext; config?: AiProviderConfig | null }> = [];
  noProvider = false;
  failWith: Error | null = null;
  beforeReturn: (() => Promise<void>) | null = null;
  // Issue #1724: consumed FIFO, one entry per `classify()` call, when non-empty. `script`/
  // `failWith` are shared across every call for a given capture body, so they cannot give
  // concurrent call #1 and call #2 (same note, racing) different outcomes — this can, which
  // is what's needed to force a race THROUGH a specific recovery call site rather than just
  // any of them.
  sequence: Array<InboxSweepClassification | Error> = [];

  async classify(
    capture: InboxSweepCapture,
    context: InboxSweepContext,
    config?: AiProviderConfig | null,
  ): Promise<InboxSweepClassification> {
    this.calls.push({ capture, context, config });
    if (this.noProvider) throw new NoProviderConfiguredError();
    const queued = this.sequence.length > 0 ? this.sequence.shift() : undefined;
    if (this.beforeReturn) await this.beforeReturn();
    if (queued !== undefined) {
      if (queued instanceof Error) throw queued;
      return queued;
    }
    if (this.failWith) throw this.failWith;
    const scripted = this.script.get(capture.body);
    if (!scripted) throw new Error(`no scripted classification for: ${capture.body}`);
    return scripted;
  }
}

describe('inbox sweep (e2e)', () => {
  let ctx: TestAppContext;
  let server: ReturnType<TestAppContext['app']['getHttpServer']>;
  let classifier: ScriptedClassifier;

  beforeAll(async () => {
    classifier = new ScriptedClassifier();
    ctx = await createTestApp({ overrides: [{ token: INBOX_SWEEP_CLASSIFIER, useValue: classifier }] });
    server = ctx.app.getHttpServer();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(() => {
    classifier.script.clear();
    classifier.calls = [];
    classifier.noProvider = false;
    classifier.failWith = null;
    classifier.beforeReturn = null;
  });

  async function newCampaign(name: string): Promise<number> {
    const res = await request(server).post('/api/v1/campaigns').set(dm).send({ name });
    expect(res.status).toBe(201);
    return res.body.id;
  }

  async function submitInbox(campaignId: number, body: string, headers = player): Promise<number> {
    const res = await request(server).post(`/api/v1/campaigns/${campaignId}/inbox`).set(headers).send({ body });
    expect(res.status).toBe(201);
    return res.body.id;
  }

  it('403s a non-DM caller — the DM-secret-leakage guard is requireRole, not membership', async () => {
    const campaignId = await newCampaign('Sweep Auth Boundary');
    await submitInbox(campaignId, 'The party wants a new quest about the missing caravan.');

    const asPlayer = await request(server).post(`/api/v1/campaigns/${campaignId}/inbox/sweep`).set(player);
    expect(asPlayer.status).toBe(403);
    const asViewer = await request(server).post(`/api/v1/campaigns/${campaignId}/inbox/sweep`).set(viewer);
    expect(asViewer.status).toBe(403);
    // The classifier must never even be invoked for a rejected caller — no context leaks.
    expect(classifier.calls).toHaveLength(0);
  });

  it('respects the archived-campaign read-only gate', async () => {
    const campaignId = await newCampaign('Sweep Archived Gate');
    await submitInbox(campaignId, 'A rumor about the old mill.');
    const archive = await request(server).patch(`/api/v1/campaigns/${campaignId}`).set(dm).send({ status: 'completed' });
    expect(archive.status).toBe(200);

    const res = await request(server).post(`/api/v1/campaigns/${campaignId}/inbox/sweep`).set(dm);
    expect(res.status).toBe(403);
    expect(classifier.calls).toHaveLength(0);
  });

  it('files a create proposal (never a direct write), resolves the item, and bootstraps context via campaign summary', async () => {
    const campaignId = await newCampaign('Sweep Create Flow');
    const noteId = await submitInbox(campaignId, 'The party wants a new quest about the missing caravan.');

    classifier.script.set('The party wants a new quest about the missing caravan.', {
      action: 'create',
      entityType: 'quest',
      targetId: null,
      fields: { title: 'The Missing Caravan' },
      reason: 'players raised a new quest hook',
    });

    const res = await request(server).post(`/api/v1/campaigns/${campaignId}/inbox/sweep`).set(dm);
    expect(res.status).toBe(201);
    expect(res.body.job.itemsTotal).toBe(1);
    expect(res.body.job.itemsProposed).toBe(1);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ noteId, outcome: 'proposed', entityType: 'quest', entityId: null });
    const proposalId = res.body.items[0].proposalId;
    expect(typeof proposalId).toBe('number');

    // Never a direct canon write: no quest exists yet, only a pending proposal.
    const quests = await request(server).get(`/api/v1/campaigns/${campaignId}/quests`).set(dm);
    expect(quests.body).toEqual([]);
    const proposals = await request(server).get(`/api/v1/campaigns/${campaignId}/proposals?status=pending`).set(dm);
    expect(proposals.status).toBe(200);
    const proposal = proposals.body.find((p: { id: number }) => p.id === proposalId);
    expect(proposal).toBeDefined();
    expect(proposal.action).toBe('create');
    expect(proposal.entityType).toBe('quest');
    expect(proposal.payload.title).toBe('The Missing Caravan');

    // The inbox item is resolved, linking back to the sweep's decision.
    const inbox = await request(server).get(`/api/v1/campaigns/${campaignId}/inbox?resolved=true`).set(dm);
    const resolved = inbox.body.items.find((i: { id: number }) => i.id === noteId);
    expect(resolved.resolved).toBe(true);

    // Context bootstrap used the campaign-summary-shaped id/name lists.
    expect(classifier.calls[0].context.quests).toEqual([]);
  });

  it('skips objective ticks / HP / combat writes with a stated reason, never silently', async () => {
    const campaignId = await newCampaign('Sweep Unsupported');
    const noteId = await submitInbox(campaignId, 'Mark objective 2 complete and deal 5 damage to the goblin.');

    classifier.script.set('Mark objective 2 complete and deal 5 damage to the goblin.', {
      action: 'unsupported',
      entityType: null,
      targetId: null,
      fields: {},
      reason: 'this requires an objective check + an HP write, not a canon proposal',
    });

    const res = await request(server).post(`/api/v1/campaigns/${campaignId}/inbox/sweep`).set(dm);
    expect(res.status).toBe(201);
    expect(res.body.job.itemsSkipped).toBe(1);
    expect(res.body.items[0]).toMatchObject({ noteId, outcome: 'skipped' });
    expect(res.body.items[0].reason).toContain('objective check');
  });

  it('is safe to run twice: a re-sweep does not duplicate the proposal for an already-swept item', async () => {
    const campaignId = await newCampaign('Sweep Idempotency');
    await submitInbox(campaignId, 'Please add an NPC for the tavern keeper, Old Mira.');
    classifier.script.set('Please add an NPC for the tavern keeper, Old Mira.', {
      action: 'create',
      entityType: 'npc',
      targetId: null,
      fields: { name: 'Old Mira' },
      reason: 'named NPC mentioned in play',
    });

    const first = await request(server).post(`/api/v1/campaigns/${campaignId}/inbox/sweep`).set(dm);
    expect(first.status).toBe(201);
    expect(first.body.job.itemsProposed).toBe(1);
    const proposalId = first.body.items[0].proposalId;
    expect(classifier.calls).toHaveLength(1);

    // Re-sweep: the item is already resolved (no longer "open"), so listAllInbox(false)
    // returns nothing for it — the classifier is not invoked again and no second
    // proposal is filed for this note.
    const second = await request(server).post(`/api/v1/campaigns/${campaignId}/inbox/sweep`).set(dm);
    expect(second.status).toBe(201);
    expect(second.body.job.itemsTotal).toBe(0);
    expect(classifier.calls).toHaveLength(1);

    const proposals = await request(server).get(`/api/v1/campaigns/${campaignId}/proposals?status=pending`).set(dm);
    const npcProposals = proposals.body.filter((p: { entityType: string }) => p.entityType === 'npc');
    expect(npcProposals).toHaveLength(1);
    expect(npcProposals[0].id).toBe(proposalId);
  });

  it('does not duplicate proposals when two sweeps race on the same open item', async () => {
    const campaignId = await newCampaign('Sweep Concurrent Idempotency');
    await submitInbox(campaignId, 'Please add an NPC for the apothecary, Tamsin.');
    classifier.script.set('Please add an NPC for the apothecary, Tamsin.', {
      action: 'create',
      entityType: 'npc',
      targetId: null,
      fields: { name: 'Tamsin' },
      reason: 'named NPC mentioned in play',
    });

    let seen = 0;
    let release!: () => void;
    const bothClassified = new Promise<void>((resolve) => {
      release = resolve;
    });
    classifier.beforeReturn = async () => {
      seen += 1;
      if (seen === 2) release();
      await bothClassified;
    };

    const [first, second] = await Promise.all([
      request(server).post(`/api/v1/campaigns/${campaignId}/inbox/sweep`).set(dm),
      request(server).post(`/api/v1/campaigns/${campaignId}/inbox/sweep`).set(dm),
    ]);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(classifier.calls).toHaveLength(2);

    const proposals = await request(server).get(`/api/v1/campaigns/${campaignId}/proposals?status=pending`).set(dm);
    const npcProposals = proposals.body.filter((p: { entityType: string }) => p.entityType === 'npc');
    expect(npcProposals).toHaveLength(1);

    // Issue #1724: exactly one proposal was created for this note, so a client bumping
    // the "Pending Proposals" badge by `itemsNewlyProposed` off EACH response must move it
    // by exactly one in total — not two. Whichever request lost the race recovers the
    // winner's row via `applyClassification`'s own findLedger fallback, returning outcome
    // 'proposed' indistinguishable in SHAPE from the winner's fresh 'proposed' result — the
    // main per-item loop must not count that recovered instance as "newly proposed" just
    // because it cannot tell the two apart by outcome alone (the pre-fix bug: it could not,
    // and did).
    const newlyProposedTotal = first.body.job.itemsNewlyProposed + second.body.job.itemsNewlyProposed;
    expect(newlyProposedTotal).toBe(1);
  });

  it('does not commit a proposal when the inbox item changes while classification is in flight', async () => {
    const campaignId = await newCampaign('Sweep Stale Capture');
    const noteId = await submitInbox(campaignId, 'Add a quest from the original body.');
    const current = await request(server).get(`/api/v1/notes/${noteId}`).set(player);
    expect(current.status).toBe(200);

    classifier.script.set('Add a quest from the original body.', {
      action: 'create',
      entityType: 'quest',
      targetId: null,
      fields: { title: 'Original Quest' },
      reason: 'original capture looked actionable',
    });
    classifier.beforeReturn = async () => {
      const update = await request(server)
        .patch(`/api/v1/notes/${noteId}`)
        .set(player)
        .send({ body: 'Changed while the model was thinking.', expectedUpdatedAt: current.body.updatedAt });
      expect(update.status).toBe(200);
    };

    const res = await request(server).post(`/api/v1/campaigns/${campaignId}/inbox/sweep`).set(dm);
    expect(res.status).toBe(201);
    expect(res.body.job.itemsProposed).toBe(0);
    expect(res.body.job.itemsErrored).toBe(1);
    expect(res.body.items[0]).toMatchObject({
      noteId,
      outcome: 'errored',
      proposalId: null,
    });
    expect(res.body.items[0].reason).toContain('inbox item changed or was resolved');

    const proposals = await request(server).get(`/api/v1/campaigns/${campaignId}/proposals?status=pending`).set(dm);
    expect(proposals.status).toBe(200);
    expect(proposals.body).toEqual([]);

    const db = ctx.app.get<DrizzleDb>(DB);
    const ledger = await db.select().from(inboxSweepItems).where(eq(inboxSweepItems.noteId, noteId));
    expect(ledger).toHaveLength(0);

    const inbox = await request(server).get(`/api/v1/campaigns/${campaignId}/inbox`).set(dm);
    const stillOpen = inbox.body.items.find((i: { id: number; body: string }) => i.id === noteId);
    expect(stillOpen).toBeDefined();
    expect(stillOpen.body).toBe('Changed while the model was thinking.');
  });

  it('does not 500 when two sweeps race on the same dismiss/skip item', async () => {
    const campaignId = await newCampaign('Sweep Concurrent Dismiss');
    const noteId = await submitInbox(campaignId, 'Just a joke about the tavern cat — no canon change.');
    classifier.script.set('Just a joke about the tavern cat — no canon change.', {
      action: 'dismiss',
      entityType: null,
      targetId: null,
      fields: {},
      reason: 'no canon change needed',
    });

    let seen = 0;
    let release!: () => void;
    const bothClassified = new Promise<void>((resolve) => {
      release = resolve;
    });
    classifier.beforeReturn = async () => {
      seen += 1;
      if (seen === 2) release();
      await bothClassified;
    };

    const [first, second] = await Promise.all([
      request(server).post(`/api/v1/campaigns/${campaignId}/inbox/sweep`).set(dm),
      request(server).post(`/api/v1/campaigns/${campaignId}/inbox/sweep`).set(dm),
    ]);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(classifier.calls).toHaveLength(2);
    expect([first.body.job.itemsSkipped, second.body.job.itemsSkipped].some((n) => n >= 1)).toBe(true);

    const inbox = await request(server).get(`/api/v1/campaigns/${campaignId}/inbox?resolved=true`).set(dm);
    const resolved = inbox.body.items.find((i: { id: number }) => i.id === noteId);
    expect(resolved).toBeDefined();
    expect(resolved.resolved).toBe(true);

    const db = ctx.app.get<DrizzleDb>(DB);
    const ledger = await db.select().from(inboxSweepItems).where(eq(inboxSweepItems.noteId, noteId));
    expect(ledger).toHaveLength(1);
    expect(ledger[0].outcome).toBe('skipped');
  });

  it('issue #1724: a race where the OTHER side hits a classifier error still moves the badge by exactly one', async () => {
    // Complements the race test above, which recovers through `applyClassification`'s own
    // findLedger fallback (both requests get the SAME scripted classification — that is the
    // one that actually regresses against pre-fix code: the old main loop counted BOTH a
    // fresh 'proposed' and its own recovered 'proposed' as newly proposed). This test gives
    // the two concurrent calls DIFFERENT outcomes — one a valid create, one an invalid
    // classifier response — so the losing side recovers via `recordError`'s findLedger
    // fallback instead, exercising the other of the two call sites Devin's review thread
    // discussed. (That site was, on inspection, never independently over-counting — a
    // `recordError()` call can only ever return outcome 'proposed' via this exact recovery,
    // never as a fresh decision, so its old omission of a `newlyProposed` increment was
    // coincidentally correct. This test does not fail against pre-fix code; it pins that the
    // new shared `resultFromLedger`/`tallyOutcome` mechanism keeps this call site correct
    // too, by construction, rather than leaving it correct by accident.)
    //
    // Which request wins the DB write is inherently nondeterministic — but the invariant
    // holds either way: exactly one proposal can ever exist for this note (the UNIQUE
    // ledger constraint guarantees it), so `itemsNewlyProposed` summed across both
    // responses must always be exactly 1, regardless of which call site did the recovering.
    const campaignId = await newCampaign('Sweep Concurrent Mixed Outcome');
    const noteId = await submitInbox(campaignId, 'A capture racing a valid classification against an invalid one.');
    classifier.sequence = [
      { action: 'create', entityType: 'npc', targetId: null, fields: { name: 'Racing Ferryman' }, reason: 'named NPC mentioned in play' },
      new InvalidInboxSweepClassificationError('invalid classifier response: not JSON'),
    ];

    let seen = 0;
    let release!: () => void;
    const bothClassified = new Promise<void>((resolve) => {
      release = resolve;
    });
    classifier.beforeReturn = async () => {
      seen += 1;
      if (seen === 2) release();
      await bothClassified;
    };

    const [first, second] = await Promise.all([
      request(server).post(`/api/v1/campaigns/${campaignId}/inbox/sweep`).set(dm),
      request(server).post(`/api/v1/campaigns/${campaignId}/inbox/sweep`).set(dm),
    ]);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(classifier.calls).toHaveLength(2);

    const db = ctx.app.get<DrizzleDb>(DB);
    const ledger = await db.select().from(inboxSweepItems).where(eq(inboxSweepItems.noteId, noteId));
    expect(ledger).toHaveLength(1);
    expect(ledger[0].outcome).toBe('proposed');

    const proposals = await request(server).get(`/api/v1/campaigns/${campaignId}/proposals?status=pending`).set(dm);
    const npcProposals = proposals.body.filter((p: { entityType: string }) => p.entityType === 'npc');
    expect(npcProposals).toHaveLength(1);

    // The assertion that actually pins the contract (per #1724): exactly one proposal
    // exists, so the badge must move by exactly one — not two, and not zero.
    const newlyProposedTotal = first.body.job.itemsNewlyProposed + second.body.job.itemsNewlyProposed;
    expect(newlyProposedTotal).toBe(1);
  });

  it('withholds external-provider captures until the author has external AI consent', async () => {
    const campaignId = await newCampaign('Sweep External Consent');
    const noteId = await submitInbox(campaignId, 'Please add a quest from a non-consenting author.');
    const configs = ctx.app.get(AiProviderConfigService);
    const providerConfig: AiProviderConfig = {
      providerType: 'mock',
      model: 'mock',
      params: {},
    };
    const spy = jest
      .spyOn(configs, 'resolveEffectiveConfigWithEndpointScope')
      .mockResolvedValue({ config: providerConfig, endpointScope: 'campaign' });

    try {
      const res = await request(server).post(`/api/v1/campaigns/${campaignId}/inbox/sweep`).set(dm);
      expect(res.status).toBe(201);
      expect(res.body.job.itemsErrored).toBe(1);
      expect(res.body.items[0]).toMatchObject({
        noteId,
        outcome: 'errored',
        entityType: null,
        entityId: null,
        proposalId: null,
      });
      expect(res.body.items[0].reason).toContain('withheld pending author consent');
      expect(classifier.calls).toHaveLength(0);

      const inbox = await request(server).get(`/api/v1/campaigns/${campaignId}/inbox`).set(dm);
      const stillOpen = inbox.body.items.find((i: { id: number }) => i.id === noteId);
      expect(stillOpen).toBeDefined();
      expect(stillOpen.resolved).toBe(false);

      const db = ctx.app.get<DrizzleDb>(DB);
      const ledger = await db.select().from(inboxSweepItems).where(eq(inboxSweepItems.noteId, noteId));
      expect(ledger).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('rechecks external AI consent against the provider config before each capture is classified', async () => {
    const campaignId = await newCampaign('Sweep Per-Item Consent Gate');
    const externalNoteId = await submitInbox(campaignId, 'This later item should be withheld after egress changes.');
    const localNoteId = await submitInbox(campaignId, 'This first item is allowed while the endpoint is declared local.');
    classifier.script.set('This first item is allowed while the endpoint is declared local.', {
      action: 'dismiss',
      entityType: null,
      targetId: null,
      fields: {},
      reason: 'no canon change needed',
    });
    classifier.script.set('This later item should be withheld after egress changes.', {
      action: 'dismiss',
      entityType: null,
      targetId: null,
      fields: {},
      reason: 'would be classified only if the stale local gate were reused',
    });

    const configs = ctx.app.get(AiProviderConfigService);
    const providerConfig: AiProviderConfig = {
      providerType: 'mock',
      model: 'mock',
      params: {},
    };
    const spy = jest
      .spyOn(configs, 'resolveEffectiveConfigWithEndpointScope')
      .mockResolvedValue({ config: providerConfig, endpointScope: 'campaign' });
    const priorLocalFlag = process.env.AI_PROVIDER_ENDPOINT_IS_LOCAL;
    process.env.AI_PROVIDER_ENDPOINT_IS_LOCAL = 'true';
    classifier.beforeReturn = async () => {
      process.env.AI_PROVIDER_ENDPOINT_IS_LOCAL = 'false';
    };

    try {
      const res = await request(server).post(`/api/v1/campaigns/${campaignId}/inbox/sweep`).set(dm);
      expect(res.status).toBe(201);
      expect(res.body.job.itemsSkipped).toBe(1);
      expect(res.body.job.itemsErrored).toBe(1);
      expect(classifier.calls.map((call) => call.capture.body)).toEqual([
        'This first item is allowed while the endpoint is declared local.',
      ]);
      expect(classifier.calls[0].config).toBe(providerConfig);
      expect(res.body.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ noteId: localNoteId, outcome: 'skipped' }),
          expect.objectContaining({
            noteId: externalNoteId,
            outcome: 'errored',
            reason: expect.stringContaining('withheld pending author consent'),
          }),
        ]),
      );
    } finally {
      if (priorLocalFlag === undefined) delete process.env.AI_PROVIDER_ENDPOINT_IS_LOCAL;
      else process.env.AI_PROVIDER_ENDPOINT_IS_LOCAL = priorLocalFlag;
      spy.mockRestore();
    }
  });

  it('retries resolution for prior ledger rows and avoids type-with-null-id links for recovered creates', async () => {
    const campaignId = await newCampaign('Sweep Ledger Recovery');
    const noteId = await submitInbox(campaignId, 'A create proposal was filed before resolution crashed.');
    const db = ctx.app.get<DrizzleDb>(DB);
    const ts = nowIso();
    const [job] = await db
      .insert(inboxSweepJobs)
      .values({
        campaignId,
        status: 'succeeded',
        itemsTotal: 1,
        itemsProposed: 1,
        itemsSkipped: 0,
        itemsErrored: 0,
        detail: 'seeded recovery job',
        createdBy: 'test',
        createdAt: ts,
      })
      .returning();
    await db.insert(inboxSweepItems).values({
      campaignId,
      noteId,
      jobId: job.id,
      outcome: 'proposed',
      entityType: 'quest',
      entityId: null,
      proposalId: 9999,
      reason: 'filed as create proposal #9999',
      createdAt: ts,
      updatedAt: ts,
    });

    const res = await request(server).post(`/api/v1/campaigns/${campaignId}/inbox/sweep`).set(dm);
    expect(res.status).toBe(201);
    expect(res.body.job.itemsProposed).toBe(1);
    expect(classifier.calls).toHaveLength(0);

    const inbox = await request(server).get(`/api/v1/campaigns/${campaignId}/inbox?resolved=true`).set(dm);
    const resolved = inbox.body.items.find((i: { id: number }) => i.id === noteId);
    expect(resolved).toBeDefined();
    expect(resolved.resolved).toBe(true);
    expect(resolved.entityType).toBeNull();
    expect(resolved.entityId).toBeNull();

    const [ledger] = await db.select().from(inboxSweepItems).where(eq(inboxSweepItems.noteId, noteId)).limit(1);
    expect(ledger.entityType).toBe('quest');
    expect(ledger.entityId).toBeNull();
  });

  it('returns each item\'s own capture body, so a result is never limited to what the caller\'s paginated list happened to hold (issue #1718)', async () => {
    const campaignId = await newCampaign('Sweep Body Beyond First Page');
    // NOTES_LIST_DEFAULT_LIMIT (the web client's page size for the open-inbox list) is
    // 50 — seed one more than that so at least one swept item is guaranteed to sit past
    // whatever the caller's own first page held. The bug this guards: the server used to
    // omit the item's identifying text entirely, forcing callers to rely on a client-side
    // pre-sweep snapshot that only ever covered page one.
    const TOTAL = NOTES_LIST_DEFAULT_LIMIT + 1;
    const noteIds: number[] = [];
    for (let i = 0; i < TOTAL; i++) {
      const body = `Bulk sweep capture ${i} — unique text so the label can't come from anywhere else`;
      const noteId = await submitInbox(campaignId, body);
      noteIds.push(noteId);
      classifier.script.set(body, {
        action: 'dismiss',
        entityType: null,
        targetId: null,
        fields: {},
        reason: 'bulk sweep — no canon change needed',
      });
    }

    const res = await request(server).post(`/api/v1/campaigns/${campaignId}/inbox/sweep`).set(dm);
    expect(res.status).toBe(201);
    expect(res.body.job.itemsTotal).toBe(TOTAL);
    expect(res.body.job.itemsSkipped).toBe(TOTAL);
    expect(res.body.job.itemsProposed).toBe(0);
    expect(res.body.items).toHaveLength(TOTAL);

    const byNoteId = new Map<number, { body?: string; outcome?: string }>(
      res.body.items.map((item: { noteId: number; body?: string; outcome?: string }) => [item.noteId, item]),
    );
    // Every item, including the ones a 50-item client page would never have loaded,
    // carries its own capture body straight from the server response.
    noteIds.forEach((noteId, i) => {
      const item = byNoteId.get(noteId);
      expect(item).toBeDefined();
      expect(item?.outcome).toBe('skipped');
      expect(item?.body).toBe(`Bulk sweep capture ${i} — unique text so the label can't come from anywhere else`);
    });
  });

  it('issue #1717: a recovered ledger row bumps itemsProposed but NOT itemsNewlyProposed — the badge must bump by zero', async () => {
    const campaignId = await newCampaign('Sweep Recovery Badge Honesty');
    const body = 'A create proposal was filed before resolution crashed, take two.';
    const noteId = await submitInbox(campaignId, body);
    const db = ctx.app.get<DrizzleDb>(DB);
    const ts = nowIso();
    const [job] = await db
      .insert(inboxSweepJobs)
      .values({
        campaignId,
        status: 'succeeded',
        itemsTotal: 1,
        itemsProposed: 1,
        itemsSkipped: 0,
        itemsErrored: 0,
        detail: 'seeded recovery job',
        createdBy: 'test',
        createdAt: ts,
      })
      .returning();
    await db.insert(inboxSweepItems).values({
      campaignId,
      noteId,
      jobId: job.id,
      outcome: 'proposed',
      entityType: 'quest',
      entityId: null,
      proposalId: 12345,
      reason: 'filed as create proposal #12345',
      createdAt: ts,
      updatedAt: ts,
    });

    const res = await request(server).post(`/api/v1/campaigns/${campaignId}/inbox/sweep`).set(dm);
    expect(res.status).toBe(201);
    expect(classifier.calls).toHaveLength(0);
    expect(res.body.items[0]).toMatchObject({ noteId, body, outcome: 'proposed' });
    expect(res.body.job.itemsProposed).toBe(1);
    expect(res.body.job.itemsNewlyProposed).toBe(0);
    expect(res.body.job.itemsNewlySkipped).toBe(0);
    expect(res.body.job.itemsNewlyErrored).toBe(0);
    expect(classifier.calls).toHaveLength(0);
  });

  it('issue #1717: mixes a recovered proposal with a genuinely new one — only the new one counts toward itemsNewlyProposed', async () => {
    const campaignId = await newCampaign('Sweep Recovery Badge Mixed');
    const recoveredNoteId = await submitInbox(campaignId, 'Recovered: a create proposal was filed before resolution crashed.');
    const newNoteId = await submitInbox(campaignId, 'Brand new: the party wants a quest about the sunken bell.');
    classifier.script.set('Brand new: the party wants a quest about the sunken bell.', {
      action: 'create',
      entityType: 'quest',
      targetId: null,
      fields: { title: 'The Sunken Bell' },
      reason: 'players raised a new quest hook',
    });

    const db = ctx.app.get<DrizzleDb>(DB);
    const ts = nowIso();
    const [job] = await db
      .insert(inboxSweepJobs)
      .values({
        campaignId,
        status: 'succeeded',
        itemsTotal: 1,
        itemsProposed: 1,
        itemsSkipped: 0,
        itemsErrored: 0,
        detail: 'seeded recovery job',
        createdBy: 'test',
        createdAt: ts,
      })
      .returning();
    await db.insert(inboxSweepItems).values({
      campaignId,
      noteId: recoveredNoteId,
      jobId: job.id,
      outcome: 'proposed',
      entityType: 'quest',
      entityId: null,
      proposalId: 54321,
      reason: 'filed as create proposal #54321',
      createdAt: ts,
      updatedAt: ts,
    });

    const res = await request(server).post(`/api/v1/campaigns/${campaignId}/inbox/sweep`).set(dm);
    expect(res.status).toBe(201);
    expect(res.body.job.itemsTotal).toBe(2);
    // Total conflates the recovered row and the new one — this is the pre-existing field's
    // documented (and now correctly-narrower) meaning.
    expect(res.body.job.itemsProposed).toBe(2);
    // Only the genuinely new proposal (for newNoteId) should move the badge.
    expect(res.body.job.itemsNewlyProposed).toBe(1);
    expect(res.body.job.itemsNewlySkipped).toBe(0);
    expect(res.body.job.itemsNewlyErrored).toBe(0);
    expect(classifier.calls).toHaveLength(1);
    expect(classifier.calls[0].capture.noteId).toBe(newNoteId);
  });

  it('reports a disabled job with a stated reason when no AI provider is configured, and touches nothing', async () => {
    const campaignId = await newCampaign('Sweep No Provider');
    const noteId = await submitInbox(campaignId, 'Some capture the sweep cannot classify.');
    classifier.noProvider = true;

    const res = await request(server).post(`/api/v1/campaigns/${campaignId}/inbox/sweep`).set(dm);
    expect(res.status).toBe(201);
    expect(res.body.job.status).toBe('disabled');
    expect(res.body.job.detail).toContain('no AI provider configured');

    const inbox = await request(server).get(`/api/v1/campaigns/${campaignId}/inbox`).set(dm);
    const stillOpen = inbox.body.items.find((i: { id: number }) => i.id === noteId);
    expect(stillOpen).toBeDefined();
    expect(stillOpen.resolved).toBe(false);
  });

  it('leaves transient classifier failures open and unledgered for retry', async () => {
    const campaignId = await newCampaign('Sweep Transient Classifier Failure');
    const noteId = await submitInbox(campaignId, 'Provider rate-limited this classification.');
    classifier.failWith = new Error('provider returned 429');

    const res = await request(server).post(`/api/v1/campaigns/${campaignId}/inbox/sweep`).set(dm);
    expect(res.status).toBe(201);
    expect(res.body.job.itemsErrored).toBe(1);
    expect(res.body.items[0]).toMatchObject({ noteId, outcome: 'errored', proposalId: null });
    expect(res.body.items[0].reason).toContain('provider returned 429');

    const inbox = await request(server).get(`/api/v1/campaigns/${campaignId}/inbox`).set(dm);
    const stillOpen = inbox.body.items.find((i: { id: number }) => i.id === noteId);
    expect(stillOpen).toBeDefined();
    expect(stillOpen.resolved).toBe(false);

    const db = ctx.app.get<DrizzleDb>(DB);
    const ledger = await db.select().from(inboxSweepItems).where(eq(inboxSweepItems.noteId, noteId));
    expect(ledger).toHaveLength(0);
  });

  it('records invalid classifier responses as terminal errored outcomes', async () => {
    const campaignId = await newCampaign('Sweep Invalid Classifier Response');
    const noteId = await submitInbox(campaignId, 'Provider returned malformed classifier JSON.');
    classifier.failWith = new InvalidInboxSweepClassificationError('invalid classifier response: bad JSON');

    const res = await request(server).post(`/api/v1/campaigns/${campaignId}/inbox/sweep`).set(dm);
    expect(res.status).toBe(201);
    expect(res.body.job.itemsErrored).toBe(1);
    expect(res.body.items[0]).toMatchObject({ noteId, outcome: 'errored', proposalId: null });

    const inbox = await request(server).get(`/api/v1/campaigns/${campaignId}/inbox?resolved=true`).set(dm);
    const resolved = inbox.body.items.find((i: { id: number }) => i.id === noteId);
    expect(resolved).toBeDefined();
    expect(resolved.resolved).toBe(true);
    expect(resolved.resolvedNote).toContain('bad JSON');

    const db = ctx.app.get<DrizzleDb>(DB);
    const [ledger] = await db.select().from(inboxSweepItems).where(eq(inboxSweepItems.noteId, noteId)).limit(1);
    expect(ledger.outcome).toBe('errored');
    expect(ledger.reason).toContain('bad JSON');
  });

  it('records missing update targets as terminal classifier errors', async () => {
    const campaignId = await newCampaign('Sweep Missing Update Target');
    const noteId = await submitInbox(campaignId, 'Rename the quest that no longer exists.');
    classifier.script.set('Rename the quest that no longer exists.', {
      action: 'update',
      entityType: 'quest',
      targetId: 999999,
      fields: { title: 'Renamed Missing Quest' },
      reason: 'model chose a stale target id',
    });

    const res = await request(server).post(`/api/v1/campaigns/${campaignId}/inbox/sweep`).set(dm);
    expect(res.status).toBe(201);
    expect(res.body.job.itemsErrored).toBe(1);
    expect(res.body.items[0]).toMatchObject({ noteId, outcome: 'errored', proposalId: null });
    expect(res.body.items[0].reason).toContain('not found');

    const inbox = await request(server).get(`/api/v1/campaigns/${campaignId}/inbox?resolved=true`).set(dm);
    const resolved = inbox.body.items.find((i: { id: number }) => i.id === noteId);
    expect(resolved).toBeDefined();
    expect(resolved.resolved).toBe(true);

    const db = ctx.app.get<DrizzleDb>(DB);
    const [ledger] = await db.select().from(inboxSweepItems).where(eq(inboxSweepItems.noteId, noteId)).limit(1);
    expect(ledger.outcome).toBe('errored');
    expect(ledger.reason).toContain('not found');

    const callsAfterFirstSweep = classifier.calls.length;
    const second = await request(server).post(`/api/v1/campaigns/${campaignId}/inbox/sweep`).set(dm);
    expect(second.status).toBe(201);
    expect(second.body.job.itemsTotal).toBe(0);
    expect(classifier.calls).toHaveLength(callsAfterFirstSweep);
  });

  it('records and resolves deterministic classifier errors so they do not retry forever', async () => {
    const campaignId = await newCampaign('Sweep Errored');
    const noteId = await submitInbox(campaignId, 'Add a quest but nobody named it.');
    classifier.script.set('Add a quest but nobody named it.', {
      action: 'create',
      entityType: 'quest',
      targetId: null,
      fields: {}, // missing required "title"
      reason: 'players want a new quest',
    });

    const res = await request(server).post(`/api/v1/campaigns/${campaignId}/inbox/sweep`).set(dm);
    expect(res.status).toBe(201);
    expect(res.body.job.itemsErrored).toBe(1);
    expect(res.body.items[0]).toMatchObject({ noteId, outcome: 'errored' });
    expect(res.body.items[0].reason).toContain('validation');

    const inbox = await request(server).get(`/api/v1/campaigns/${campaignId}/inbox?resolved=true`).set(dm);
    const resolved = inbox.body.items.find((i: { id: number }) => i.id === noteId);
    expect(resolved).toBeDefined();
    expect(resolved.resolved).toBe(true);
    expect(resolved.resolvedNote).toContain('validation');

    const db = ctx.app.get<DrizzleDb>(DB);
    const [ledger] = await db.select().from(inboxSweepItems).where(eq(inboxSweepItems.noteId, noteId)).limit(1);
    expect(ledger.outcome).toBe('errored');
    expect(ledger.reason).toContain('validation');

    const callsAfterFirstSweep = classifier.calls.length;
    const second = await request(server).post(`/api/v1/campaigns/${campaignId}/inbox/sweep`).set(dm);
    expect(second.status).toBe(201);
    expect(second.body.job.itemsTotal).toBe(0);
    expect(classifier.calls).toHaveLength(callsAfterFirstSweep);
  });

  it('runs a slow sweep in the background and exposes a pollable result (#1716)', async () => {
    const campaignId = await newCampaign('Sweep Background');
    const noteId = await submitInbox(campaignId, 'The party wants a new quest about the haunted lighthouse.');
    classifier.script.set('The party wants a new quest about the haunted lighthouse.', {
      action: 'create',
      entityType: 'quest',
      targetId: null,
      fields: { title: 'The Haunted Lighthouse' },
      reason: 'players raised a new quest hook',
    });

    // Ensure the fast-path race loses (8s timeout) so the POST returns a running job.
    classifier.beforeReturn = () => new Promise<void>((resolve) => setTimeout(resolve, 9500));

    const res = await request(server).post(`/api/v1/campaigns/${campaignId}/inbox/sweep`).set(dm);
    expect(res.status).toBe(201);
    expect(res.body.job.status).toBe('running');
    expect(res.body.items).toHaveLength(0);
    const jobId: number = res.body.job.id;

    // GET is gated by DM role and 404s for the wrong campaign.
    const asPlayer = await request(server).get(`/api/v1/campaigns/${campaignId}/inbox/sweep/${jobId}`).set(player);
    expect(asPlayer.status).toBe(403);

    const otherCampaign = await newCampaign('Sweep Other Campaign');
    const wrongCampaign = await request(server)
      .get(`/api/v1/campaigns/${otherCampaign}/inbox/sweep/${jobId}`)
      .set(dm);
    expect(wrongCampaign.status).toBe(404);

    // Poll until the background sweep completes.
    let result = res.body;
    for (let i = 0; i < 40 && result.job.status === 'running'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const poll = await request(server).get(`/api/v1/campaigns/${campaignId}/inbox/sweep/${jobId}`).set(dm);
      expect(poll.status).toBe(200);
      result = poll.body;
    }

    expect(result.job.status).toBe('succeeded');
    expect(result.job.itemsProposed).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ noteId, outcome: 'proposed', entityType: 'quest' });

    classifier.beforeReturn = null;
  });

  it('reconciles orphaned running inbox sweep jobs on module init (#1716)', async () => {
    const campaignId = await newCampaign('Sweep Orphaned Reconciliation');
    await submitInbox(campaignId, 'Add a quest about the cursed well.');

    const db = ctx.app.get<DrizzleDb>(DB);
    const [inserted] = await db
      .insert(inboxSweepJobs)
      .values({
        campaignId,
        status: 'running',
        itemsTotal: 1,
        itemsProposed: 0,
        itemsSkipped: 0,
        itemsErrored: 0,
        detail: 'orphaned for test',
        createdBy: dm['x-dev-user'],
        createdAt: nowIso(),
      })
      .returning();
    expect(inserted).toBeDefined();

    const service = ctx.app.get(InboxSweepService);
    await service.onModuleInit();

    const [after] = await db.select().from(inboxSweepJobs).where(eq(inboxSweepJobs.id, inserted.id!)).limit(1);
    expect(after.status).toBe('failed');
    expect(after.detail).toContain('interrupted by server restart');
  });
});
