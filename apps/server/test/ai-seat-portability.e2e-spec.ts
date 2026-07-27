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
