import request from 'supertest';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';
import {
  AI_SEAT_FIELD_ROLE,
  PORTABLE_AI_SEAT_FIELDS,
} from '../src/modules/ai-dm/ai-seat-portability';

/**
 * #1049 — the AI seat's DM-authored configuration must survive clone, export and import.
 *
 * ── Why this is a ROUND-TRIP suite, not a projection suite ────────────────────────────
 * The bug was three closed object literals — the export projection, the clone insert and the
 * import insert — each enumerating seat columns by hand. A field forgotten in any one of them
 * fails silently: the campaign copies, nothing errors, and the field comes back as its column
 * default. Asserting the export payload alone would have caught only a third of that; what
 * matters to a DM is that a styled campaign is still styled on the other side.
 *
 * `stylePresets` was the reported casualty and the THIRD to be swallowed — `proactiveSettings`
 * (#1044) and `actionQueueDepth` (#1045) had already been dropped by the same lists.
 *
 * Fields that must NOT travel are asserted too, following this suite's existing convention for
 * `cancelledBy: null`: a dropped field that is *asserted* dropped is a decision, and one that
 * is merely absent is a bug waiting to be re-found.
 */

// Every axis set to a NON-default value, so a field that fails to travel comes back visibly
// wrong rather than coincidentally matching the default.
const STYLE = {
  tone: 'noir',
  pacing: 'deliberate',
  verbosity: 'concise',
  combatStyle: 'lethal',
  npcDepth: 'deep',
} as const;
const PROACTIVE = {
  enabled: true,
  triggers: { encounterEnded: false, hpCritical: true, objectiveCompleted: false },
  cooldownSeconds: 600,
  maxProactiveTokensPerHour: 1_500,
} as const;

describe('AI seat portability across clone / export / import (#1049)', () => {
  let ctx: TestAppContext;
  let dmAgent: ReturnType<typeof request.agent>;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();
    dmAgent = request.agent(server);
    await dmAgent.post('/api/v1/auth/setup').send({ username: 'seat-dm', password: 'dm-password-1' });
    await dmAgent.patch('/api/v1/settings').send({ experimentalAiDm: true });

    const created = await dmAgent.post('/api/v1/campaigns').send({ name: 'Styled Table' });
    campaignId = created.body.id;

    // A fully-configured seat: every `config` field set to something non-default, so a field
    // that fails to travel comes back visibly wrong rather than coincidentally right.
    const seat = await dmAgent.put(`/api/v1/campaigns/${campaignId}/ai-dm`).send({
      enabled: true,
      mode: 'co_dm',
      model: 'seat-model',
      instructions: 'Play it bleak.',
      tokenBudget: 12_345,
      actionQueueDepth: 3,
      stylePresets: STYLE,
      proactiveSettings: PROACTIVE,
    });
    expect(seat.status).toBe(200);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  function readSeat(id: number) {
    return dmAgent.get(`/api/v1/campaigns/${id}/ai-dm`);
  }

  /** Every field the classification calls DM-authored, and what it should read back as. */
  const expectedConfig = {
    mode: 'co_dm',
    model: 'seat-model',
    instructions: 'Play it bleak.',
    tokenBudget: 12_345,
    actionQueueDepth: 3,
    stylePresets: STYLE,
    proactiveSettings: PROACTIVE,
  };

  it('the source seat really is configured (guards against a vacuous round-trip)', async () => {
    // Without this, a round-trip assertion could pass because BOTH sides are default.
    const seat = await readSeat(campaignId);
    expect(seat.body).toMatchObject(expectedConfig);
  });

  it('a CLONE carries every DM-authored field', async () => {
    const cloned = await dmAgent.post(`/api/v1/campaigns/${campaignId}/clone`).send({ name: 'Styled Clone' });
    expect(cloned.status).toBe(201);
    const seat = await readSeat(cloned.body.id);
    expect(seat.body).toMatchObject(expectedConfig);
  });

  it('a clone starts its OWN usage accounting', async () => {
    const cloned = await dmAgent.post(`/api/v1/campaigns/${campaignId}/clone`).send({ name: 'Counter Clone' });
    const seat = await readSeat(cloned.body.id);
    // Carrying a spend history to a copy would misreport that copy's consumption.
    expect(seat.body).toMatchObject({ tokensUsed: 0, turnCount: 0, lastTurnAt: null });
  });

  it('EXPORT → IMPORT carries every DM-authored field', async () => {
    const exported = await dmAgent.get(`/api/v1/campaigns/${campaignId}/export`);
    expect(exported.status).toBe(200);
    // The projection carries them...
    expect(exported.body.aiSeat).toMatchObject(expectedConfig);

    // ...and, more importantly, they are still there after a real import.
    const imported = await dmAgent
      .post('/api/v1/campaigns/import')
      .send({ ...exported.body, campaign: { ...exported.body.campaign, name: 'Imported Table' } });
    expect(imported.status).toBe(201);
    const seat = await readSeat(imported.body.id);
    expect(seat.body).toMatchObject(expectedConfig);
  });

  it('an import starts its OWN usage accounting', async () => {
    const exported = await dmAgent.get(`/api/v1/campaigns/${campaignId}/export`);
    const imported = await dmAgent
      .post('/api/v1/campaigns/import')
      .send({ ...exported.body, campaign: { ...exported.body.campaign, name: 'Imported Counters' } });
    const seat = await readSeat(imported.body.id);
    expect(seat.body).toMatchObject({ tokensUsed: 0, turnCount: 0, lastTurnAt: null });
  });

  it('the export payload carries NO usage counters at all', async () => {
    // Asserted rather than merely unasserted: a counter appearing in the payload would travel
    // to another install and misreport its consumption there.
    const exported = await dmAgent.get(`/api/v1/campaigns/${campaignId}/export`);
    for (const counter of ['tokensUsed', 'tokensReserved', 'tokensRefunded', 'tokensUnknown', 'tokensOverage', 'turnCount', 'lastTurnAt']) {
      expect(exported.body.aiSeat).not.toHaveProperty(counter);
    }
    // ...nor the row identity, which is per-target.
    expect(exported.body.aiSeat).not.toHaveProperty('campaignId');
  });

  /**
   * Fixing the DROP inherited its side effect. Before this PR the import path did not carry
   * `stylePresets`, `proactiveSettings` or `actionQueueDepth` at all — they fell to column
   * defaults, and that omission was, accidentally, also a VALIDATION. Now that the three
   * travel, an archive can put an object-shaped but ILLEGAL value into a JSON column.
   *
   * Shape-checking is not enough: the value detonates at a distance. `AiDmService.toDomain`
   * parses both blocks with their zod schemas on every read, so an out-of-range value imports
   * "successfully" and then throws on `GET /ai-dm` and every Driver operation — a seat that is
   * permanently unusable, from an import that reported success.
   */
  async function importWithSeat(name: string, seatOverride: Record<string, unknown>) {
    const exported = await dmAgent.get(`/api/v1/campaigns/${campaignId}/export`);
    return dmAgent.post('/api/v1/campaigns/import').send({
      ...exported.body,
      campaign: { ...exported.body.campaign, name },
      aiSeat: { ...exported.body.aiSeat, ...seatOverride },
    });
  }

  it('an object-shaped but INVALID style enum imports and leaves a READABLE seat', async () => {
    const imported = await importWithSeat('Bad Enum', { stylePresets: { tone: 'grimdark' } });
    expect(imported.status).toBe(201);
    // The load-bearing assertion: the seat must still be readable. Before the fix this 500s,
    // because toDomain parses stylePresets and 'grimdark' is not an AiDmTone.
    const seat = await readSeat(imported.body.id);
    expect(seat.status).toBe(200);
    expect(seat.body.stylePresets.tone).toBe('default');
  });

  it('an out-of-range proactive value imports and leaves a READABLE seat', async () => {
    // Devin's generalisation: same shape as the style case, and this one is exposure THIS PR
    // created — proactiveSettings did not travel at all before.
    const imported = await importWithSeat('Bad Cooldown', {
      proactiveSettings: { enabled: true, cooldownSeconds: 999_999 },
    });
    expect(imported.status).toBe(201);
    const seat = await readSeat(imported.body.id);
    expect(seat.status).toBe(200);
    expect(seat.body.proactiveSettings.cooldownSeconds).toBeLessThanOrEqual(3600);
  });

  it('a PARTIAL but legal style block is kept, not discarded', async () => {
    // Falling back to defaults must apply to INVALID input only. Every axis defaults
    // independently, so naming one axis is legal and must survive — over-rejecting would make
    // the feature lossy in the ordinary case to defend against the rare one.
    const imported = await importWithSeat('Partial Style', { stylePresets: { tone: 'noir' } });
    expect(imported.status).toBe(201);
    const seat = await readSeat(imported.body.id);
    expect(seat.body.stylePresets).toMatchObject({ tone: 'noir', pacing: 'default' });
  });

  it('clamps actionQueueDepth into the 1-20 range the seat schema allows', async () => {
    // 0 makes `queue.length >= maxDepth` true immediately, so a seat that looks configured
    // silently rejects every action submitted while a turn runs. The previous guard was
    // Math.max(0, …) directly beneath a comment explaining that 0 was the thing to prevent.
    const low = await importWithSeat('Zero Depth', { actionQueueDepth: 0 });
    expect(low.status).toBe(201);
    expect((await readSeat(low.body.id)).body.actionQueueDepth).toBeGreaterThanOrEqual(1);

    const high = await importWithSeat('Huge Depth', { actionQueueDepth: 999 });
    expect(high.status).toBe(201);
    expect((await readSeat(high.body.id)).body.actionQueueDepth).toBeLessThanOrEqual(20);

    const negative = await importWithSeat('Negative Depth', { actionQueueDepth: -5 });
    expect((await readSeat(negative.body.id)).body.actionQueueDepth).toBeGreaterThanOrEqual(1);
  });

  it('a malformed style block in an uploaded archive does not reach the column', async () => {
    // The import path reads untrusted JSON. An array written straight into a `mode: 'json'`
    // column would surface as a malformed settings object far from here.
    const exported = await dmAgent.get(`/api/v1/campaigns/${campaignId}/export`);
    const imported = await dmAgent.post('/api/v1/campaigns/import').send({
      ...exported.body,
      campaign: { ...exported.body.campaign, name: 'Hostile Archive' },
      aiSeat: { ...exported.body.aiSeat, stylePresets: ['not', 'an', 'object'], proactiveSettings: 'nope' },
    });
    expect(imported.status).toBe(201);
    const seat = await readSeat(imported.body.id);
    // The hostile values are gone. They read back as the DEFAULTED blocks rather than as `{}`,
    // because the seat read parses through AiDmStylePresets / AiDmProactiveSettings, each of
    // which defaults every axis — so "no preference stated" is the honest result, and the
    // import wrote a shape those parsers accept instead of an array they would choke on.
    expect(seat.body.stylePresets).toEqual({
      tone: 'default',
      pacing: 'default',
      verbosity: 'default',
      combatStyle: 'default',
      npcDepth: 'default',
    });
    expect(seat.body.stylePresets).not.toEqual(STYLE);
    expect(seat.body.proactiveSettings.enabled).toBe(false);
    expect(Array.isArray(seat.body.stylePresets)).toBe(false);
  });
});

/**
 * The classification itself. `AI_SEAT_FIELD_ROLE` is `Record<keyof AiDmSeatRow, …>`, so a new
 * column is a compile error until someone classifies it — that type-level guard is the actual
 * fix, and these assertions state in prose what it enforces.
 */
describe('the seat portability classification (#1049)', () => {
  it('names every field the three call sites need, in one place', () => {
    expect([...PORTABLE_AI_SEAT_FIELDS].sort()).toEqual(
      ['actionQueueDepth', 'enabled', 'instructions', 'mode', 'model', 'proactiveSettings', 'stylePresets', 'tokenBudget'].sort(),
    );
  });

  it('classifies the three fields that were being silently dropped as config', () => {
    // stylePresets (#1049) was reported; proactiveSettings (#1044) and actionQueueDepth (#1045)
    // were found by auditing the literals against the table and had been dropped for longer.
    expect(AI_SEAT_FIELD_ROLE.stylePresets).toBe('config');
    expect(AI_SEAT_FIELD_ROLE.proactiveSettings).toBe('config');
    expect(AI_SEAT_FIELD_ROLE.actionQueueDepth).toBe('config');
  });

  it('keeps every token counter out of the portable set', () => {
    for (const counter of ['tokensUsed', 'tokensReserved', 'tokensRefunded', 'tokensUnknown', 'tokensOverage', 'turnCount', 'lastTurnAt'] as const) {
      expect(AI_SEAT_FIELD_ROLE[counter]).toBe('runtime');
    }
  });

  it('treats the primary key and row timestamps as identity, never copied', () => {
    for (const key of ['campaignId', 'createdAt', 'updatedAt'] as const) {
      expect(AI_SEAT_FIELD_ROLE[key]).toBe('identity');
    }
  });
});
