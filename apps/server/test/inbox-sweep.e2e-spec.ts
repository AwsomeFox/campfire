import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';
import {
  INBOX_SWEEP_CLASSIFIER,
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
  calls: Array<{ capture: InboxSweepCapture; context: InboxSweepContext }> = [];
  noProvider = false;

  async classify(capture: InboxSweepCapture, context: InboxSweepContext): Promise<InboxSweepClassification> {
    this.calls.push({ capture, context });
    if (this.noProvider) throw new NoProviderConfiguredError();
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

  it('reports errored (not a silent skip) when the model payload fails entity validation, and leaves the item open for retry', async () => {
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

    const inbox = await request(server).get(`/api/v1/campaigns/${campaignId}/inbox`).set(dm);
    const stillOpen = inbox.body.items.find((i: { id: number }) => i.id === noteId);
    expect(stillOpen).toBeDefined();
    expect(stillOpen.resolved).toBe(false);
  });
});
