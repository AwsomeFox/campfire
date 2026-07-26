import request from 'supertest';
import { createAiEvalHarness, dm, player, viewer, type AiEvalHarness } from './ai-eval-harness';
import { AI_DM_TRANSCRIPT_RETENTION_MAX_EVENTS, type AiDmTranscriptEvent } from '@campfire/schema';
import { AiDmTranscriptService } from '../src/modules/ai-driver/ai-driver-transcript.service';
import { AiDmStreamService, type AiDmStreamEvent } from '../src/modules/ai-driver/ai-driver-stream.service';

/**
 * Issue #572 — the authoritative multi-player AI-DM table transcript.
 *
 * THE BUG. The driver broadcast AI lifecycle/narration/tool events but NEVER the player
 * action that provoked them: only the sending browser inserted a local optimistic entry.
 * Every other player at the table watched the AI answer a question they never saw. The
 * transcript itself lived in one browser's localStorage, so a reload, a late join or a
 * dropped socket produced a materially different transcript per player with no recovery.
 *
 * These tests pin the four properties that make one shared transcript actually work:
 *   - ORDER      — a per-campaign `seq` assigned server-side is a total order and a cursor.
 *   - DEDUP      — the sender's `clientRef` comes back so it swaps, not duplicates.
 *   - RECOVERY   — `after=<seq>` replays exactly the events a disconnected client missed.
 *   - REDACTION  — DM-only rows and hidden encounter ids are withheld at the server, on
 *                  every path (REST page, export, live SSE frame).
 */

const API = '/api/v1';

function listTranscript(
  h: AiEvalHarness,
  campaignId: number,
  headers: Record<string, string>,
  query: Record<string, string | number> = {},
): Promise<request.Response> {
  return request(h.server).get(`${API}/campaigns/${campaignId}/ai-dm/transcript`).set(headers).query(query);
}

function kinds(events: AiDmTranscriptEvent[]): string[] {
  return events.map((e) => e.kind);
}

describe('ai-dm authoritative table transcript (#572)', () => {
  let h: AiEvalHarness;

  beforeAll(async () => {
    h = await createAiEvalHarness({ model: 'transcript-model' });
    await h.enableExperimental();
  });

  beforeEach(() => {
    h.resetMock();
  });

  afterAll(async () => {
    await h.close();
  });

  async function driverCampaign(name: string): Promise<number> {
    const campaignId = await h.createCampaign(name);
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });
    return campaignId;
  }

  it('persists the accepted PLAYER ACTION so other players see what the AI is answering', async () => {
    const campaignId = await driverCampaign('Transcript Player Action');
    h.script({ text: 'The door groans open.', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } });

    // A PLAYER submits. Before #572 nothing about this submission was ever broadcast.
    const sent = await request(h.server)
      .post(`${API}/campaigns/${campaignId}/ai-dm/message`)
      .set(player)
      .send({ input: 'I shoulder the door.', clientRef: 'ref-abc', characterName: 'Runa' });
    expect(sent.status).toBe(201);

    // A DIFFERENT member reads the shared transcript and sees the action, not just the answer.
    const asDm = await listTranscript(h, campaignId, dm);
    expect(asDm.status).toBe(200);
    const events = asDm.body.items as AiDmTranscriptEvent[];

    const action = events.find((e) => e.kind === 'player.action');
    expect(action).toBeDefined();
    expect(action!.payload.text).toBe('I shoulder the door.');
    expect(action!.payload.characterName).toBe('Runa');
    expect(action!.actorName).toBeTruthy();
    // The correlation token is echoed back verbatim — this is what lets the SENDER replace
    // its optimistic entry instead of rendering the action twice.
    expect(action!.clientRef).toBe('ref-abc');

    // …and the narration the AI produced comes AFTER it in the one authoritative order.
    const narration = events.find((e) => e.kind === 'narration');
    expect(narration).toBeDefined();
    expect(narration!.payload.text).toBe('The door groans open.');
    expect(narration!.seq).toBeGreaterThan(action!.seq);

    // Both belong to one turn: narration/turn.ended share a turnId, the action is not part of it.
    const ended = events.find((e) => e.kind === 'turn.ended');
    expect(ended).toBeDefined();
    expect(ended!.turnId).toBe(narration!.turnId);
    expect(narration!.turnId).toBeTruthy();

    // Every member sees the SAME transcript — that is the whole point of the issue.
    const asPlayer = await listTranscript(h, campaignId, player);
    const asViewer = await listTranscript(h, campaignId, viewer);
    expect(kinds(asPlayer.body.items)).toEqual(kinds(events));
    expect(kinds(asViewer.body.items)).toEqual(kinds(events));
    expect((asPlayer.body.items as AiDmTranscriptEvent[]).map((e) => e.eventId)).toEqual(
      events.map((e) => e.eventId),
    );
  });

  it('assigns a strictly increasing per-campaign seq that does not interleave across campaigns', async () => {
    const a = await driverCampaign('Transcript Seq A');
    const b = await driverCampaign('Transcript Seq B');

    h.script({ text: 'A1.', usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 } });
    await h.sendMessage(a, { input: 'first in A' });
    h.script({ text: 'B1.', usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 } });
    await h.sendMessage(b, { input: 'first in B' });
    h.script({ text: 'A2.', usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 } });
    await h.sendMessage(a, { input: 'second in A' });

    const pageA = (await listTranscript(h, a, dm)).body.items as AiDmTranscriptEvent[];
    const pageB = (await listTranscript(h, b, dm)).body.items as AiDmTranscriptEvent[];

    // Each campaign's sequence is dense and starts at 1 — a global row id would have
    // interleaved B's writes into A's numbering and leaked cross-campaign write volume.
    expect(pageA.map((e) => e.seq)).toEqual(pageA.map((_, i) => i + 1));
    expect(pageB.map((e) => e.seq)).toEqual(pageB.map((_, i) => i + 1));
    // Strictly increasing, ascending, no duplicates.
    for (let i = 1; i < pageA.length; i += 1) expect(pageA[i].seq).toBeGreaterThan(pageA[i - 1].seq);
    // Stable event ids are unique.
    expect(new Set(pageA.map((e) => e.eventId)).size).toBe(pageA.length);
  });

  it('recovers a disconnected client with after=<seq>: exactly the missed events, gap-free', async () => {
    const campaignId = await driverCampaign('Transcript Reconnect');

    h.script({ text: 'Before the drop.', usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 } });
    await h.sendMessage(campaignId, { input: 'turn one' });

    // The client's watermark at the moment its socket died.
    const beforeDrop = (await listTranscript(h, campaignId, player)).body.items as AiDmTranscriptEvent[];
    const watermark = beforeDrop[beforeDrop.length - 1].seq;

    // Two more turns happen while it is offline.
    h.script({ text: 'While you were away.', usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 } });
    await h.sendMessage(campaignId, { input: 'turn two' });
    h.script({ text: 'And again.', usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 } });
    await h.sendMessage(campaignId, { input: 'turn three' });

    const caughtUp = await listTranscript(h, campaignId, player, { after: watermark });
    expect(caughtUp.status).toBe(200);
    const missed = caughtUp.body.items as AiDmTranscriptEvent[];

    // Nothing it already had…
    expect(missed.every((e) => e.seq > watermark)).toBe(true);
    // …and nothing skipped: the recovered tail plus the pre-drop head IS the full transcript.
    const full = (await listTranscript(h, campaignId, player, { limit: 200 })).body.items as AiDmTranscriptEvent[];
    expect([...beforeDrop, ...missed].map((e) => e.seq)).toEqual(full.map((e) => e.seq));
    // Both player actions taken while offline are in the recovered slice — the #572 gap.
    const recoveredActions = missed.filter((e) => e.kind === 'player.action').map((e) => e.payload.text);
    expect(recoveredActions).toEqual(['turn two', 'turn three']);
  });

  it('pages backwards through scrollback with nextCursor without gaps or duplicates', async () => {
    const campaignId = await driverCampaign('Transcript Paging');
    for (let i = 0; i < 5; i += 1) {
      h.script({ text: `Step ${i}.`, usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 } });
      await h.sendMessage(campaignId, { input: `action ${i}` });
    }

    const all = (await listTranscript(h, campaignId, dm, { limit: 200 })).body.items as AiDmTranscriptEvent[];
    expect(all.length).toBeGreaterThan(5);

    // Walk back two at a time and reassemble.
    const collected: AiDmTranscriptEvent[] = [];
    let cursor: string | null | undefined;
    for (let guard = 0; guard < 50; guard += 1) {
      const res = await listTranscript(h, campaignId, dm, cursor ? { limit: 2, cursor } : { limit: 2 });
      expect(res.status).toBe(200);
      collected.unshift(...(res.body.items as AiDmTranscriptEvent[]));
      expect(res.body.total).toBe(all.length);
      cursor = res.body.nextCursor;
      if (!cursor) break;
    }
    expect(collected.map((e) => e.seq)).toEqual(all.map((e) => e.seq));
    // Every page is returned oldest-first so a client can render it directly.
    expect(collected.map((e) => e.eventId)).toEqual(all.map((e) => e.eventId));
  });

  it('withholds DM-only events from players — at the server, on every read path', async () => {
    const campaignId = await driverCampaign('Transcript Redaction');
    const npc = await request(h.server)
      .post(`${API}/campaigns/${campaignId}/npcs`)
      .set(dm)
      .send({ name: 'The Stranger', hidden: true });
    expect(npc.status).toBe(201);

    // A secret-read approval NAMES a hidden entity, so its control line is DM-only.
    const grant = await request(h.server)
      .post(`${API}/campaigns/${campaignId}/ai-dm/secret-approval`)
      .set(dm)
      .send({ action: 'grant', tool: 'get_npc', entityId: npc.body.id });
    expect(grant.status).toBe(201);

    const asDm = (await listTranscript(h, campaignId, dm)).body.items as AiDmTranscriptEvent[];
    const dmOnly = asDm.find((e) => e.payload.control === 'secret-approval');
    expect(dmOnly).toBeDefined();
    expect(dmOnly!.payload.entityId).toBe(npc.body.id);

    // The player's page simply does not contain the row. Not "contains it but hidden".
    const asPlayer = (await listTranscript(h, campaignId, player)).body.items as AiDmTranscriptEvent[];
    expect(asPlayer.some((e) => e.payload.control === 'secret-approval')).toBe(false);
    expect(asPlayer.some((e) => e.eventId === dmOnly!.eventId)).toBe(false);

    // Neither does the export — an export is a copy of what you may see, not a back door.
    const exported = await request(h.server).get(`${API}/campaigns/${campaignId}/ai-dm/transcript/export`).set(player);
    expect(exported.status).toBe(200);
    expect((exported.body.events as AiDmTranscriptEvent[]).some((e) => e.eventId === dmOnly!.eventId)).toBe(false);
    expect(exported.body.retentionMaxEvents).toBe(AI_DM_TRANSCRIPT_RETENTION_MAX_EVENTS);

    const dmExport = await request(h.server).get(`${API}/campaigns/${campaignId}/ai-dm/transcript/export`).set(dm);
    expect((dmExport.body.events as AiDmTranscriptEvent[]).some((e) => e.eventId === dmOnly!.eventId)).toBe(true);
  });

  it('drops DM-only frames from a player’s live SSE stream instead of trusting the client', async () => {
    const campaignId = await driverCampaign('Transcript SSE Redaction');
    const transcript = h.ctx.app.get(AiDmTranscriptService);
    const stream = h.ctx.app.get(AiDmStreamService);

    const seen: AiDmStreamEvent[] = [];
    const sub = stream.streamFor(campaignId).subscribe((e) => seen.push(e));
    const dmOnly = transcript.record({
      campaignId,
      kind: 'control',
      visibility: 'dm',
      payload: { control: 'secret-approval', entityId: 4242 },
    });
    sub.unsubscribe();
    expect(dmOnly).not.toBeNull();

    // The in-process frame carries the visibility hint…
    const frame = seen.find((e) => e.type === 'transcript');
    expect(frame).toBeDefined();
    expect((frame as { visibility: string }).visibility).toBe('dm');

    // …and the HTTP stream must never hand that frame to a non-DM. Asserted through the
    // shared projection the controller applies, so the guarantee is tested where it lives.
    const { projectTranscriptEventForRole } = await import('../src/modules/ai-driver/ai-driver-transcript.service');
    expect(projectTranscriptEventForRole(dmOnly!, 'dm', 'dm')).not.toBeNull();
    expect(projectTranscriptEventForRole(dmOnly!, 'dm', 'player')).toBeNull();
    expect(projectTranscriptEventForRole(dmOnly!, 'dm', 'viewer')).toBeNull();

    // Field-level: a hidden encounter's id is stripped from a tool payload for non-DMs.
    const toolEvent = transcript.record({
      campaignId,
      kind: 'tool',
      payload: { name: 'update_encounter', isError: false, proposed: false, encounterId: 99, encounterHidden: true },
    })!;
    const forPlayer = projectTranscriptEventForRole(toolEvent, 'all', 'player')!;
    expect(forPlayer.payload.encounterId).toBeUndefined();
    expect(forPlayer.payload.encounterHidden).toBeUndefined();
    const forDm = projectTranscriptEventForRole(toolEvent, 'all', 'dm')!;
    expect(forDm.payload.encounterId).toBe(99);
    // The internal hint never leaves the server for ANYONE.
    expect(forDm.payload.encounterHidden).toBeUndefined();
  });

  it('records votes and control changes so a late joiner sees why the table is where it is', async () => {
    const campaignId = await driverCampaign('Transcript Control');

    const open = await h.lever(campaignId, 'vote', { action: 'open', kind: 'pause' }, player);
    expect(open.status).toBe(201);
    const paused = await request(h.server).post(`${API}/campaigns/${campaignId}/ai-dm/pause`).set(dm).send({ paused: true });
    expect(paused.status).toBe(201);

    const events = (await listTranscript(h, campaignId, dm)).body.items as AiDmTranscriptEvent[];
    const vote = events.find((e) => e.kind === 'vote');
    expect(vote).toBeDefined();
    expect(vote!.payload).toMatchObject({ action: 'opened', kind: 'pause' });
    expect(vote!.actorUserId).toBeTruthy();

    const control = events.find((e) => e.kind === 'control' && e.payload.control === 'paused');
    expect(control).toBeDefined();
    expect(control!.payload.state).toBe('paused');
  });

  it('bounds retention per campaign and lets a DM erase the transcript', async () => {
    const campaignId = await driverCampaign('Transcript Retention');
    const transcript = h.ctx.app.get(AiDmTranscriptService);

    // Write past the cap; the oldest rows must be pruned in the same transaction as the insert.
    const overflow = AI_DM_TRANSCRIPT_RETENTION_MAX_EVENTS + 5;
    let last!: AiDmTranscriptEvent;
    for (let i = 0; i < overflow; i += 1) {
      last = transcript.record({ campaignId, kind: 'narration', payload: { text: `line ${i}` } })!;
    }
    expect(last.seq).toBe(overflow);

    const page = await listTranscript(h, campaignId, dm, { limit: 1 });
    expect(page.body.total).toBe(AI_DM_TRANSCRIPT_RETENTION_MAX_EVENTS);
    // `seq` keeps counting — pruning drops rows, it does not renumber the ones that remain.
    expect((page.body.items as AiDmTranscriptEvent[])[0].seq).toBe(overflow);

    // Deletion is a DM lever.
    const playerDelete = await request(h.server).delete(`${API}/campaigns/${campaignId}/ai-dm/transcript`).set(player);
    expect(playerDelete.status).toBe(403);

    const purge = await request(h.server).delete(`${API}/campaigns/${campaignId}/ai-dm/transcript`).set(dm);
    expect(purge.status).toBe(200);
    expect(purge.body.deleted).toBe(AI_DM_TRANSCRIPT_RETENTION_MAX_EVENTS);

    const after = await listTranscript(h, campaignId, dm);
    expect(after.body.items).toEqual([]);
    expect(after.body.total).toBe(0);
  }, 60_000);

  it('lets a read-only viewer follow the table but never erase it', async () => {
    const campaignId = await driverCampaign('Transcript Access');
    h.script({ text: 'Watched from the wings.', usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 } });
    await h.sendMessage(campaignId, { input: 'I wave at the crowd.' });

    // Reading is a membership-level right (same gate as GET /ai-dm/session and the SSE stream).
    const read = await listTranscript(h, campaignId, viewer);
    expect(read.status).toBe(200);
    expect((read.body.items as AiDmTranscriptEvent[]).some((e) => e.kind === 'player.action')).toBe(true);

    // Erasing is not.
    const erase = await request(h.server).delete(`${API}/campaigns/${campaignId}/ai-dm/transcript`).set(viewer);
    expect(erase.status).toBe(403);
  });
});
