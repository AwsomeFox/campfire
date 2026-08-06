import request from 'supertest';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';
import { ProactiveService } from '../src/modules/ai-driver/proactive.service';
import {
  AI_SEAT_FIELD_ROLE,
  PORTABLE_AI_SEAT_FIELDS,
  portableAiSeat,
  readPortableAiSeat,
  type PortableAiSeat,
} from '../src/modules/ai-dm/ai-seat-portability';
import { AiDmSeat } from '@campfire/schema';

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
// #874 — every axis on a non-default value, same reasoning as STYLE above.
const COMPREHENSION = {
  readingComplexity: 'simple',
  paragraphLength: 'short',
  sensoryIntensity: 'vivid',
  choiceCount: 'two',
} as const;

const TOKEN_BUDGET_MAX = (() => {
  const max = AiDmSeat.shape.tokenBudget.removeDefault().maxValue;
  if (max === null) throw new Error('AiDmSeat.shape.tokenBudget must define a max for portability clamping');
  return max;
})();

/**
 * The round-trip fixture: EVERY portable field, each at a distinctly non-default value.
 *
 * ── Why `satisfies Record<keyof PortableAiSeat, unknown>` and not a hand-kept list ─────
 * The previous version of this suite proved the wrong thing. It asserted that the derived
 * field-NAME list equalled a hard-coded array of eight strings — which restates the
 * classification instead of testing it, and leaves the original failure mode fully open:
 * classify a new column, update the expected-names array, and clone/export/import still
 * silently drop it, because nothing here ever asked whether the two PROJECTIONS return it.
 *
 * `keyof PortableAiSeat` is derived from `AI_SEAT_FIELD_ROLE`, so this object is now
 * exhaustive by compilation: a ninth `config` column makes THIS LINE a compile error until
 * someone supplies a non-default value for it, and every round-trip assertion below then
 * covers it automatically. The `PORTABLE_AI_SEAT_FIELDS` check further down is the runtime
 * half of the same claim — it proves the fixture is complete against the real derived list,
 * so "the round-trip carried everything in here" means "carried everything portable".
 */
const NON_DEFAULT = {
  mode: 'co_dm',
  enabled: true,
  model: 'seat-model',
  instructions: 'Play it bleak.',
  tokenBudget: 12_345,
  proactiveSettings: PROACTIVE,
  stylePresets: STYLE,
  comprehensionProfile: COMPREHENSION,
  actionQueueDepth: 3,
} satisfies Record<keyof PortableAiSeat, unknown>;

/**
 * COMPILE-TIME regression test for the guard itself (Codex review, #1049).
 *
 * `AI_SEAT_FIELD_ROLE` made it a compile error to forget to CLASSIFY a new column, but
 * classifying one did not make it portable: `PortableAiSeat` was a hand-written `Pick`, the
 * two projections were closed object literals, and `PORTABLE_AI_SEAT_FIELDS` carried an
 * `as Array<keyof PortableAiSeat>` cast that hid the disagreement from the compiler. Four
 * sources of truth, one of them silently authoritative.
 *
 * `ConfigClassifiedField` below re-derives "which columns are config" from the map, here in
 * the test, with no help from the module. If the module's `PortableAiSeat` is genuinely
 * derived from the same map, the two agree and this compiles. If the map's values are
 * type-erased — which is exactly what the old `Record<keyof AiDmSeatRow, AiSeatFieldRole>`
 * annotation did — nothing is derivable from it, `ConfigClassifiedField` collapses to `never`,
 * and this fails to compile. ts-jest type-checks specs, so that is a red test, not a silent
 * lint. It is the ONLY assertion in this file that distinguishes a derived portable set from
 * a hand-written one that happens to agree today.
 */
type ConfigClassifiedField = {
  [K in keyof typeof AI_SEAT_FIELD_ROLE]: (typeof AI_SEAT_FIELD_ROLE)[K] extends 'config' ? K : never;
}[keyof typeof AI_SEAT_FIELD_ROLE];
type Equal<A, B> = (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type _PortableSeatIsDerivedFromTheClassification = Expect<Equal<keyof PortableAiSeat, ConfigClassifiedField>>;

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
    const seat = await dmAgent.put(`/api/v1/campaigns/${campaignId}/ai-dm`).send(NON_DEFAULT);
    expect(seat.status).toBe(200);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  function readSeat(id: number) {
    return dmAgent.get(`/api/v1/campaigns/${id}/ai-dm`);
  }

  /**
   * Every field the classification calls DM-authored, and what it should read back as — the
   * SAME object that was written, so "nothing was lost or reset" is asserted field-for-field
   * rather than restated as a list of names.
   */
  const expectedConfig = NON_DEFAULT;

  it('the fixture covers every portable field, so the round-trips below are exhaustive', () => {
    // The runtime half of the compile-time guard above. Without this, the round-trip suite
    // could be exhaustive over a fixture that is itself missing a field.
    expect(Object.keys(NON_DEFAULT).sort()).toEqual([...PORTABLE_AI_SEAT_FIELDS].sort());
  });

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

  /**
   * Carrying `proactiveSettings` is not the same as HONOURING them (#1049 review).
   *
   * `ProactiveService`'s watcher is an in-memory rxjs subscription that starts ONLY from the
   * callback `AiDmService.configure` fires. Clone and import never call `configure` — they
   * insert into `ai_dm_seats` directly, inside the campaign-copy transaction — so the copied
   * seat read back `proactiveSettings.enabled: true`, the UI drew it as on, and no proactive
   * turn could ever fire behind it. A field-equality assertion cannot see that: the DATA was
   * copied perfectly. Only the subscription was missing.
   *
   * The source-campaign assertion is the control. It went through `configure`, so it must be
   * watched; if it ever is not, these two tests are failing for a harness reason rather than
   * the defect they are named after.
   */
  describe('the proactive watcher, not just the proactive settings', () => {
    const watcher = () => ctx.app.get(ProactiveService);

    it('the CONFIGURED source campaign is watched (control)', () => {
      expect(watcher().isWatching(campaignId)).toBe(true);
    });

    it('a CLONE is actually watched, not merely marked as watching', async () => {
      const cloned = await dmAgent.post(`/api/v1/campaigns/${campaignId}/clone`).send({ name: 'Watched Clone' });
      expect(cloned.status).toBe(201);
      // The settings copied — that much always worked, and is what made this invisible.
      expect((await readSeat(cloned.body.id)).body.proactiveSettings).toMatchObject({ enabled: true });
      expect(watcher().isWatching(cloned.body.id)).toBe(true);
    });

    it('an IMPORT is actually watched too', async () => {
      const exported = await dmAgent.get(`/api/v1/campaigns/${campaignId}/export`);
      const imported = await dmAgent
        .post('/api/v1/campaigns/import')
        .send({ ...exported.body, campaign: { ...exported.body.campaign, name: 'Watched Import' } });
      expect(imported.status).toBe(201);
      expect((await readSeat(imported.body.id)).body.proactiveSettings).toMatchObject({ enabled: true });
      expect(watcher().isWatching(imported.body.id)).toBe(true);
    });
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

  /**
   * THREE export paths exist, and the plain one above is only the first.
   * `buildProfileExport` runs `buildExport`'s output through `projectExport(raw, policy)` for
   * the redaction profiles (#586), so a field can travel fine on `/export` and be dropped on
   * `/export?profile=backup` — the same defect one path over, which is the shape this whole PR
   * is about. `projectExport` turns out NOT to allowlist `aiSeat` fields (it passes the whole
   * object through when `policy.credentials`, and nulls it entirely otherwise), so the three
   * newly-carried fields are safe today. The assertion exists anyway: the next person adding a
   * seat field should find a test that fails rather than a path nobody checked.
   */
  it('the BACKUP profile carries the new fields too, not just the plain export', async () => {
    const exported = await dmAgent.get(`/api/v1/campaigns/${campaignId}/export?profile=backup`);
    expect(exported.status).toBe(200);
    expect(exported.body.aiSeat).toMatchObject(expectedConfig);
  });

  it('the redacting profiles drop the WHOLE seat, by design', async () => {
    // Not a field-level omission to fix: `handoff` and `publish` set `credentials: false`, and
    // the seat is classified as capability/credential-shaped operational state. Asserted so the
    // difference between "dropped deliberately" and "dropped accidentally" stays legible — the
    // same reason this suite asserts its non-travelling counters.
    for (const profile of ['handoff', 'publish']) {
      const exported = await dmAgent.get(`/api/v1/campaigns/${campaignId}/export?profile=${profile}`);
      expect(exported.status).toBe(200);
      expect(exported.body.aiSeat).toBeNull();
    }
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

  it('clamps tokenBudget to the range AiDmSeat.shape.tokenBudget allows (issue #1593)', async () => {
    // Before the fix this was `Math.max(0, …)` — a floor with no ceiling. An archive carrying
    // a tokenBudget past the schema's own `.max(...)` imported without complaint and
    // read back verbatim, holding a value the schema calls illegal. This is a schema-integrity
    // fix, not a spend-safety one: assertWithinServerTokenCap governs actual consumption
    // regardless of what the seat stores.
    const tooHigh = await importWithSeat('Huge Budget', { tokenBudget: TOKEN_BUDGET_MAX + 1 });
    expect(tooHigh.status).toBe(201);
    const seat = await readSeat(tooHigh.body.id);
    expect(seat.status).toBe(200);
    expect(seat.body.tokenBudget).toBe(TOKEN_BUDGET_MAX);

    // The floor still holds too — this half already worked, and stays covered so a future
    // change to the clamp helper cannot silently drop it.
    const negative = await importWithSeat('Negative Budget', { tokenBudget: -5 });
    expect((await readSeat(negative.body.id)).body.tokenBudget).toBe(0);
  });

  /**
   * The scalar sibling of the two JSON blocks (Devin review).
   *
   * This PR hardened `stylePresets` and `proactiveSettings` in this reader and left `mode`,
   * `enabled` and `tokenBudget` on bare coercion — a rule applied to the reported fields and
   * not their siblings. Of the three, `enabled` genuinely needs nothing further: `boolOf` is
   * TOTAL (anything that is not `true` is `false`), so a boolean has no unrepresentable value
   * to admit. `mode` is a scalar with a closed domain (`AiDmMode`) that nothing enforced —
   * `str(src.mode, 'off')` accepted any string at all — and is fixed here.
   *
   * `tokenBudget` ALSO has a closed domain (`AiDmSeat.shape.tokenBudget`'s
   * `.nonnegative().max(...)`), which this PR did NOT close — `Math.max(0, …)`
   * enforced the floor but not the ceiling. That gap shipped in this PR and was closed
   * separately in #1593, with its own test above; it is called out here rather than silently
   * left implying "already handled," which is what an earlier version of this comment claimed.
   *
   * It is a milder defect than the JSON blocks and a real one. It does NOT wedge the seat: an
   * unknown mode is cast, not parsed (`(row.mode as AiDmMode) ?? 'off'`), so the seat stays
   * readable. But `assertRunnable`'s gate is `seat.enabled && seat.mode !== 'off'`, which fails
   * OPEN — an unrecognised mode arms the seat — and readiness then reports it as Co-DM, because
   * that is the fallback branch of `seat.mode === 'driver' ? … : 'mode.coDm'`. So an archive
   * could produce a seat that is armed under a mode name no code recognises and that the UI
   * describes as something it is not.
   *
   * Not a privilege escalation — an archive that can say `mode: 'nonsense'` can equally say
   * `mode: 'co_dm'` and get the same capability legitimately. It is fixed because "stored a
   * value outside its own enum and then displayed it as a different mode" is the same
   * reports-something-untrue family as the rest of this PR, not because it lets anyone in.
   */
  it('an out-of-enum mode in an archive falls back to off rather than being stored verbatim', async () => {
    const imported = await importWithSeat('Bogus Mode', { mode: 'driver_but_evil' });
    expect(imported.status).toBe(201);
    const seat = await readSeat(imported.body.id);
    expect(seat.status).toBe(200);
    expect(['off', 'co_dm', 'driver']).toContain(seat.body.mode);
    // `off` specifically, not merely "some legal value": an unreadable mode is not consent to
    // arm the seat, and the gate above treats everything except `off` as armed.
    expect(seat.body.mode).toBe('off');
  });

  it('a LEGAL mode is untouched by that guard', async () => {
    // The fallback must apply to illegal input only — the main round-trip above already carries
    // `co_dm`, and this pins the third enum member so the guard cannot degenerate into "always off".
    const imported = await importWithSeat('Driver Mode', { mode: 'driver' });
    expect((await readSeat(imported.body.id)).body.mode).toBe('driver');
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
  /**
   * Naming the fields was never the property that mattered. The old assertion here compared
   * `PORTABLE_AI_SEAT_FIELDS` to a hard-coded array of eight strings, which a person adding a
   * column would simply edit — and the field would still be dropped, because neither
   * projection had been asked about it. These two check what the call sites actually RECEIVE.
   */
  const FAKE_ROW = Object.fromEntries(
    Object.keys(AI_SEAT_FIELD_ROLE).map((key) => [key, null]),
  ) as unknown as Parameters<typeof portableAiSeat>[0];

  it('the TRUSTED-row projection returns every field the classification lists', () => {
    expect(Object.keys(portableAiSeat(FAKE_ROW)).sort()).toEqual([...PORTABLE_AI_SEAT_FIELDS].sort());
  });

  /** The same coercers campaigns.service passes, plus a spy on the operator-facing warning. */
  const coercers = (warn?: jest.Mock) => ({
    str: (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback),
    boolOf: (value: unknown) => value === true,
    intOr: (value: unknown, fallback: number) => (typeof value === 'number' ? value : fallback),
    warn,
  });

  it('the UNTRUSTED-archive reader returns every field the classification lists', () => {
    // The import path is a separate closed literal from the export/clone one, so it can drop a
    // field the other carries — a defect invisible to any assertion about names.
    const read = readPortableAiSeat({}, coercers());
    expect(Object.keys(read).sort()).toEqual([...PORTABLE_AI_SEAT_FIELDS].sort());
  });

  /**
   * ABSENT is not INVALID (Devin review).
   *
   * `parseOrDefault` used to hand the raw value straight to `schema.safeParse` and treat every
   * failure as an illegal value. `AiDmStylePresets` carries a top-level `.default(...)`, so
   * `safeParse(undefined)` SUCCEEDS and it never accused anyone. `AiDmProactiveSettings` is a
   * bare `z.object({...})` with per-key defaults and no top-level one, so `safeParse(undefined)`
   * FAILS — and every archive predating #1044 told its operator that their AI settings "did not
   * validate" when nothing whatsoever was wrong.
   *
   * That asymmetry lived in the two schemas, but the defect is that the READER could not tell
   * the two situations apart, so which behaviour you got depended on an unrelated detail of how
   * a schema happened to be declared. Bolting a top-level `.default()` onto the one schema would
   * restore today's symmetry and leave that intact for the next block added. So `parseOrDefault`
   * now makes the distinction itself — which is also why `null` counts as absent: JSON has no
   * `undefined`, and our OWN export writes `null` for an unset column, so null is simply what
   * "absent" looks like by the time it reaches this function.
   *
   * This is the mirror of the defect closed on #1556. There, a default meaning "the reassuring
   * thing" turned an omission into a false REASSURANCE; here a missing default turned an
   * omission into a false ACCUSATION. Both are code that cannot distinguish "absent" from
   * "present and wrong", which is why the fix belongs in the code that decides, not in the data.
   */
  describe('absent blocks import silently; invalid ones still warn', () => {
    it('an archive with NO proactiveSettings key imports at defaults, WITHOUT accusing anyone', () => {
      const warn = jest.fn();
      const read = readPortableAiSeat({}, coercers(warn));
      expect(warn).not.toHaveBeenCalled();
      expect(read.proactiveSettings).toMatchObject({ enabled: false, cooldownSeconds: 300 });
    });

    it('a NULL block — how our own export carries an unset column — is absent, not invalid', () => {
      // `portableAiSeat` copies the row verbatim and the JSON columns are nullable, so a seat
      // that never configured either block exports as `null`. Re-importing our own export must
      // not warn about a value we wrote ourselves.
      const warn = jest.fn();
      const read = readPortableAiSeat({ proactiveSettings: null, stylePresets: null }, coercers(warn));
      expect(warn).not.toHaveBeenCalled();
      expect(read.stylePresets).toMatchObject({ tone: 'default' });
      expect(read.proactiveSettings).toMatchObject({ enabled: false });
    });

    it('a genuinely INVALID block still warns and still falls back', () => {
      // The warning is the whole reason the fallback is acceptable rather than silent data loss,
      // so narrowing "invalid" must not cost us the real accusation.
      const warn = jest.fn();
      const read = readPortableAiSeat(
        { proactiveSettings: { enabled: true, cooldownSeconds: 999_999 } },
        coercers(warn),
      );
      expect(warn).toHaveBeenCalledWith('proactiveSettings', expect.stringContaining('did not validate'));
      expect(read.proactiveSettings?.cooldownSeconds).toBe(300);
    });

    it('both blocks behave the same way now, in both directions', () => {
      // The point of fixing the reader rather than the schema: behaviour no longer depends on
      // whether a given schema happens to carry a top-level `.default(...)`.
      const absent = jest.fn();
      readPortableAiSeat({}, coercers(absent));
      expect(absent).not.toHaveBeenCalled();

      const invalid = jest.fn();
      readPortableAiSeat(
        { stylePresets: { tone: 'grimdark' }, proactiveSettings: { cooldownSeconds: 1 } },
        coercers(invalid),
      );
      expect(invalid.mock.calls.map((call) => call[0]).sort()).toEqual(['proactiveSettings', 'stylePresets']);
    });
  });

  it('classifies the three fields that were being silently dropped as config', () => {
    // stylePresets (#1049) was reported; proactiveSettings (#1044) and actionQueueDepth (#1045)
    // were found by auditing the literals against the table and had been dropped for longer.
    expect(AI_SEAT_FIELD_ROLE.stylePresets).toBe('config');
    expect(AI_SEAT_FIELD_ROLE.proactiveSettings).toBe('config');
    expect(AI_SEAT_FIELD_ROLE.actionQueueDepth).toBe('config');
  });

  it('classifies the comprehension profile (#874) as config, following stylePresets', () => {
    expect(AI_SEAT_FIELD_ROLE.comprehensionProfile).toBe('config');
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
