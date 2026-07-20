import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from '../test-app';
import { dm, player } from './fixtures';

/**
 * Integration coverage for the atomic write paths under real concurrency (issue
 * #80). Two mechanisms are exercised against a real, *listening* socket so the
 * requests are genuinely in flight at once (an un-listened in-memory handler
 * serialises them and proves nothing):
 *
 *   - Atomic HP writes (issue #86): N concurrent damage patches must all land —
 *     no lost updates. better-sqlite3 executes each statement synchronously, so
 *     a read-modify-write for one request completes before the next request's
 *     handler runs; this asserts that guarantee holds end-to-end.
 *   - Proposal resolution CAS (issue #85): the pending->approved/rejected
 *     transition is a single `UPDATE ... WHERE status='pending'`. Fire a burst of
 *     approves racing rejects at one pending proposal and exactly one must win;
 *     every loser gets a 409 and the entity is written at most once.
 *
 * These need a real listening server (createTestApp only inits), so the suite
 * calls app.listen(0) in beforeAll and drives requests at the resolved URL.
 */
describe('concurrency (real SQLite, atomic writes)', () => {
  let ctx: TestAppContext;
  let baseUrl: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    await ctx.app.listen(0);
    baseUrl = await ctx.app.getUrl();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('applies every one of N concurrent HP damage patches — no lost updates (#86)', async () => {
    const campaign = await request(baseUrl).post('/api/v1/campaigns').set(dm).send({ name: 'HP Race' });
    const campaignId = campaign.body.id;
    const character = await request(baseUrl)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(dm)
      .send({ name: 'Punching Bag', hpMax: 100, hpCurrent: 100 });
    const characterId = character.body.id;

    const N = 40;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        request(baseUrl).post(`/api/v1/characters/${characterId}/hp`).set(dm).send({ delta: -1 }),
      ),
    );

    // Every request succeeded...
    expect(results.every((r) => r.status === 201)).toBe(true);
    // ...and every single -1 was applied: 100 - 40 = 60. A lost update would leave hp > 60.
    const finalRow = await request(baseUrl).get(`/api/v1/characters/${characterId}`).set(dm);
    expect(finalRow.body.hpCurrent).toBe(100 - N);
  });

  it('never drives HP out of [0, hpMax] under a mixed concurrent burst', async () => {
    const campaign = await request(baseUrl).post('/api/v1/campaigns').set(dm).send({ name: 'HP Clamp Race' });
    const character = await request(baseUrl)
      .post(`/api/v1/campaigns/${campaign.body.id}/characters`)
      .set(dm)
      .send({ name: 'Yo-yo', hpMax: 30, hpCurrent: 30 });
    const characterId = character.body.id;

    // Big heals and big hits racing each other; each write clamps independently.
    const patches = [
      ...Array.from({ length: 15 }, () => ({ delta: -25 })),
      ...Array.from({ length: 15 }, () => ({ set: 30 })),
    ];
    const results = await Promise.all(
      patches.map((p) => request(baseUrl).post(`/api/v1/characters/${characterId}/hp`).set(dm).send(p)),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    // No individual response — and the final row — may ever escape the clamp.
    for (const r of results) {
      expect(r.body.hpCurrent).toBeGreaterThanOrEqual(0);
      expect(r.body.hpCurrent).toBeLessThanOrEqual(30);
    }
    const finalRow = await request(baseUrl).get(`/api/v1/characters/${characterId}`).set(dm);
    expect(finalRow.body.hpCurrent).toBeGreaterThanOrEqual(0);
    expect(finalRow.body.hpCurrent).toBeLessThanOrEqual(30);
  });

  it('resolves a proposal exactly once when approves race rejects (#85)', async () => {
    const campaign = await request(baseUrl).post('/api/v1/campaigns').set(dm).send({ name: 'CAS Race' });
    const campaignId = campaign.body.id;
    const quest = await request(baseUrl)
      .post(`/api/v1/campaigns/${campaignId}/quests`)
      .set(dm)
      .send({ title: 'Contested' });
    const questId = quest.body.id;

    // A player proposes an edit -> one pending proposal.
    const proposed = await request(baseUrl)
      .patch(`/api/v1/quests/${questId}?proposed=true`)
      .set(player)
      .send({ title: 'Player Title' });
    expect(proposed.status).toBe(202);
    const proposalId = proposed.body.proposal.id;

    // 5 approves and 5 rejects hit the same pending proposal simultaneously.
    const attempts = [
      ...Array.from({ length: 5 }, () => ({ kind: 'approve' as const })),
      ...Array.from({ length: 5 }, () => ({ kind: 'reject' as const })),
    ];
    const results = await Promise.all(
      attempts.map((a) =>
        request(baseUrl).post(`/api/v1/proposals/${proposalId}/${a.kind}`).set(dm).send({}).then((r) => ({ kind: a.kind, status: r.status })),
      ),
    );

    const winners = results.filter((r) => r.status < 300);
    const conflicts = results.filter((r) => r.status === 409);
    // The CAS serialises the transition: exactly one winner, everyone else 409.
    expect(winners).toHaveLength(1);
    expect(conflicts).toHaveLength(results.length - 1);

    // The persisted proposal reflects the single winner's outcome.
    const listed = await request(baseUrl)
      .get(`/api/v1/campaigns/${campaignId}/proposals`)
      .set(dm);
    const persisted = listed.body.find((p: { id: number }) => p.id === proposalId);
    const expectedStatus = winners[0].kind === 'approve' ? 'approved' : 'rejected';
    expect(persisted.status).toBe(expectedStatus);

    // If the winner was an approve, the entity was written exactly once (title applied);
    // if it was a reject, the entity is untouched. Either way it's internally consistent.
    const finalQuest = await request(baseUrl).get(`/api/v1/quests/${questId}`).set(dm);
    expect(finalQuest.body.title).toBe(winners[0].kind === 'approve' ? 'Player Title' : 'Contested');
  });
});
