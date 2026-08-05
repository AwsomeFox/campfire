import request from 'supertest';
import { CampaignUpdate, HomebrewMechanicsProfile } from '@campfire/schema';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-homebrew-mechanics' };

/**
 * Persistence + validation for a campaign's homebrew mechanics profile (issue #1502).
 * `createOsrVariantAdapter` (osr-adapter.ts) already builds a complete RuleSystemAdapter from
 * a pure-data profile for the six built-in OSR retroclones; these tests cover the SERVER SIDE
 * of the widening — persisting an arbitrary caller-supplied profile per campaign, validating
 * it server-side, and resolving it through `ruleSystemAdapter()` on the real read/write paths
 * (character checks, campaign update) rather than only at the schema-function level.
 */
describe('campaign customMechanicsProfile (issue #1502, e2e)', () => {
  let ctx: TestAppContext;
  let server: ReturnType<TestAppContext['app']['getHttpServer']>;

  const validProfile: HomebrewMechanicsProfile = {
    slug: 'e2e-pirate-hack',
    label: 'E2E Pirate Hack',
    mechanicsSummary: 'A homebrew 2d6 pirate hack, for e2e coverage.',
    abilityTable: 'sw-banded',
    abilityCap: 2,
    saves: ['Grit'],
    acMode: 'ascending',
    acAnchor: 10,
    initiativeMode: 'group',
    initiativeDie: 6,
    initiativeUsesDexMod: false,
    tiebreak: 'order-only',
    conditions: ['Soaked'],
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('creates a campaign with a valid customMechanicsProfile — no installed rule pack required', async () => {
    const res = await request(server)
      .post('/api/v1/campaigns')
      .set(dm)
      .send({ name: 'Homebrew Campaign', ruleSystem: validProfile.slug, customMechanicsProfile: validProfile });
    expect(res.status).toBe(201);
    expect(res.body.ruleSystem).toBe(validProfile.slug);
    expect(res.body.customMechanicsProfile).toMatchObject({ slug: validProfile.slug, abilityTable: 'sw-banded' });

    // Round-trips on GET, not just the create response.
    const getRes = await request(server).get(`/api/v1/campaigns/${res.body.id}`).set(dm);
    expect(getRes.status).toBe(200);
    expect(getRes.body.customMechanicsProfile).toMatchObject({ slug: validProfile.slug });
  });

  it('rejects an unregistered ruleSystem slug with NO customMechanicsProfile and no installed rule pack (pre-existing behavior, unchanged)', async () => {
    const res = await request(server)
      .post('/api/v1/campaigns')
      .set(dm)
      .send({ name: 'No Profile Campaign', ruleSystem: 'nobody-installed-this-slug' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/does not match any installed rule pack/i);
  });

  it('rejects a customMechanicsProfile attached to a BUILT-IN registered ruleSystem slug', async () => {
    const res = await request(server)
      .post('/api/v1/campaigns')
      .set(dm)
      .send({ name: 'Overriding 5e Campaign', ruleSystem: 'dnd5e', customMechanicsProfile: { ...validProfile, slug: 'dnd5e' } });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/built-in rule system/i);
  });

  it('rejects a customMechanicsProfile whose slug does not match ruleSystem', async () => {
    const res = await request(server)
      .post('/api/v1/campaigns')
      .set(dm)
      .send({ name: 'Mismatched Slug Campaign', ruleSystem: 'a-different-slug', customMechanicsProfile: validProfile });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/must match ruleSystem/i);
  });

  it('rejects an out-of-enum strategy value at the REST validation boundary', async () => {
    const res = await request(server)
      .post('/api/v1/campaigns')
      .set(dm)
      .send({
        name: 'Bad Enum Campaign',
        ruleSystem: 'e2e-bad-enum-hack',
        customMechanicsProfile: { ...validProfile, slug: 'e2e-bad-enum-hack', acMode: 'sideways' },
      });
    expect(res.status).toBe(400);
  });

  it('rejects a customMechanicsProfile with no ruleSystem to attach to', async () => {
    const res = await request(server)
      .post('/api/v1/campaigns')
      .set(dm)
      .send({ name: 'No RuleSystem Campaign', customMechanicsProfile: validProfile });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/non-empty ruleSystem/i);
  });

  it('auto-clears a stale customMechanicsProfile when ruleSystem changes away from it in the same PATCH', async () => {
    const createRes = await request(server)
      .post('/api/v1/campaigns')
      .set(dm)
      .send({ name: 'Auto-clear Campaign', ruleSystem: 'e2e-autoclear-hack', customMechanicsProfile: { ...validProfile, slug: 'e2e-autoclear-hack' } });
    expect(createRes.status).toBe(201);
    expect(createRes.body.customMechanicsProfile).not.toBeNull();

    // Switch ruleSystem to '' (no system picked) WITHOUT touching customMechanicsProfile.
    const patchRes = await request(server)
      .patch(`/api/v1/campaigns/${createRes.body.id}`)
      .set(dm)
      .send({ ruleSystem: '' });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.ruleSystem).toBe('');
    expect(patchRes.body.customMechanicsProfile).toBeNull();
  });

  it('drives ability-modifier math on the real character-checks endpoint (proves resolution end-to-end, not just at the schema layer)', async () => {
    const campRes = await request(server)
      .post('/api/v1/campaigns')
      .set(dm)
      .send({ name: 'Ability Math Campaign', ruleSystem: 'e2e-ability-hack', customMechanicsProfile: { ...validProfile, slug: 'e2e-ability-hack' } });
    expect(campRes.status).toBe(201);
    const campaignId = campRes.body.id;

    const charRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(dm)
      .send({ name: 'Cap\'n Hook', level: 1, hpMax: 10, hpCurrent: 10, stats: { STR: 18, DEX: 18, CON: 10, INT: 10, WIS: 10, CHA: 10 } });
    expect(charRes.status).toBe(201);

    const checksRes = await request(server)
      .get(`/api/v1/characters/${charRes.body.id}/checks`)
      .set(dm);
    expect(checksRes.status).toBe(200);
    const strCheck = checksRes.body.find((c: { ability?: string; category: string }) => c.category === 'ability' && c.ability === 'STR');
    expect(strCheck).toBeDefined();
    // sw-banded caps at ±2, so score 18 -> +2 — distinct from bx-banded's +3 for the same score
    // (osrBxAbilityModifier(18) === 3) and from 5e's floor((18-10)/2) = +4. This score is chosen
    // specifically because bx-banded and sw-banded AGREE at 16 (both +2) but DIVERGE at 18.
    expect(strCheck.modifier).toBe(2);
  });

  it('CampaignUpdate exposes customMechanicsProfile — the same schema the update_campaign MCP tool spreads (REST/MCP parity)', () => {
    expect(CampaignUpdate.shape).toHaveProperty('customMechanicsProfile');
  });
});
