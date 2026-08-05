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

  it('accepts a PATCH that re-sends the homebrew ruleSystem without re-sending the profile', async () => {
    // #1502 review. `validateRuleSystem` demands an installed rule pack unless a profile backs
    // the slug, and it was satisfied only by a profile in the SAME request. A homebrew campaign
    // therefore became un-PATCHable the moment any request echoed its own ruleSystem — which a
    // full-object update from the settings form does on every save — 400ing on a value it
    // already held. The stored profile now counts as backing.
    const createRes = await request(server)
      .post('/api/v1/campaigns')
      .set(dm)
      .send({ name: 'Echo Campaign', ruleSystem: 'e2e-echo-hack', customMechanicsProfile: { ...validProfile, slug: 'e2e-echo-hack' } });
    expect(createRes.status).toBe(201);

    const patchRes = await request(server)
      .patch(`/api/v1/campaigns/${createRes.body.id}`)
      .set(dm)
      .send({ name: 'Echo Campaign renamed', ruleSystem: 'e2e-echo-hack' });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.name).toBe('Echo Campaign renamed');
    // The profile is untouched, not re-derived or cleared.
    expect(patchRes.body.customMechanicsProfile).toMatchObject({ slug: 'e2e-echo-hack', abilityTable: 'sw-banded' });
  });

  it('still rejects clearing the profile while keeping the now-unbacked homebrew ruleSystem', async () => {
    // The relaxation above must not become "a homebrew slug is always fine". Explicitly
    // removing the profile leaves the slug backed by nothing, which is the exact state
    // validateRuleSystem exists to catch.
    const createRes = await request(server)
      .post('/api/v1/campaigns')
      .set(dm)
      .send({ name: 'Unback Campaign', ruleSystem: 'e2e-unback-hack', customMechanicsProfile: { ...validProfile, slug: 'e2e-unback-hack' } });
    expect(createRes.status).toBe(201);

    const patchRes = await request(server)
      .patch(`/api/v1/campaigns/${createRes.body.id}`)
      .set(dm)
      .send({ ruleSystem: 'e2e-unback-hack', customMechanicsProfile: null });
    expect(patchRes.status).toBe(400);
    expect(patchRes.body.message).toMatch(/does not match any installed rule pack/i);
  });

  it('survives an export -> import round trip, including the handoff profile', async () => {
    // #1502 review. The clone path carried the pair; export/import did not — the allowlist
    // stripped the profile while keeping the slug, and importCampaign only ever looked for an
    // installed rule pack. A homebrew campaign moved between installs came back on the 5e
    // fallback with its whole rule system gone, silently.
    const createRes = await request(server)
      .post('/api/v1/campaigns')
      .set(dm)
      .send({ name: 'Roundtrip Campaign', ruleSystem: 'e2e-roundtrip-hack', customMechanicsProfile: { ...validProfile, slug: 'e2e-roundtrip-hack' } });
    expect(createRes.status).toBe(201);

    for (const profile of ['', '&profile=handoff']) {
      const exportRes = await request(server)
        .get(`/api/v1/campaigns/${createRes.body.id}/export?format=json${profile}`)
        .set(dm);
      expect(exportRes.status).toBe(200);
      expect(exportRes.body.campaign.customMechanicsProfile).toMatchObject({ slug: 'e2e-roundtrip-hack' });

      const importRes = await request(server).post('/api/v1/campaigns/import').set(dm).send(exportRes.body);
      expect(importRes.status).toBe(201);
      expect(importRes.body.ruleSystem).toBe('e2e-roundtrip-hack');
      expect(importRes.body.customMechanicsProfile).toMatchObject({ slug: 'e2e-roundtrip-hack', abilityTable: 'sw-banded' });
    }
  });

  it('drops a profile an import document cannot justify, instead of persisting it', async () => {
    // An export document is untrusted input, so it goes through the same rules a create/update
    // write does. Each of these must land on the ordinary cleared-slug path rather than
    // persisting a profile the server would have rejected at the REST boundary.
    const base = {
      campaign: { name: 'Hostile Import', status: 'active', narrationLanguage: 'en' },
      locations: [],
      npcs: [],
      quests: [],
      factions: [],
      sessions: [],
      characters: [],
    };
    const cases = [
      // slug does not match the profile it claims to be defined by
      { ruleSystem: 'e2e-hostile-a', customMechanicsProfile: { ...validProfile, slug: 'something-else' } },
      // out-of-enum strategy value
      { ruleSystem: 'e2e-hostile-b', customMechanicsProfile: { ...validProfile, slug: 'e2e-hostile-b', abilityTable: 'not-a-table' } },
      // attempts to redefine a BUILT-IN system's mechanics through the import side door
      { ruleSystem: 'dnd5e', customMechanicsProfile: { ...validProfile, slug: 'dnd5e' } },
      // not an object at all
      { ruleSystem: 'e2e-hostile-c', customMechanicsProfile: 'nope' },
    ];
    for (const campaign of cases) {
      const res = await request(server)
        .post('/api/v1/campaigns/import')
        .set(dm)
        .send({ ...base, campaign: { ...base.campaign, ...campaign } });
      expect(res.status).toBe(201);
      expect(res.body.customMechanicsProfile).toBeNull();
      // 'dnd5e' is an installed pack in the test app only if seeded; either way the profile
      // must not have been stored, which is what this guards.
      expect(res.body.ruleSystem).not.toBe('e2e-hostile-a');
      expect(res.body.ruleSystem).not.toBe('e2e-hostile-b');
      expect(res.body.ruleSystem).not.toBe('e2e-hostile-c');
    }
  });

  it('carries customMechanicsProfile over on campaign clone (otherwise a clone would silently fall back to 5e)', async () => {
    const createRes = await request(server)
      .post('/api/v1/campaigns')
      .set(dm)
      .send({ name: 'Clone Source Campaign', ruleSystem: 'e2e-clone-hack', customMechanicsProfile: { ...validProfile, slug: 'e2e-clone-hack' } });
    expect(createRes.status).toBe(201);

    const cloneRes = await request(server)
      .post(`/api/v1/campaigns/${createRes.body.id}/clone`)
      .set(dm)
      .send({});
    expect(cloneRes.status).toBe(201);
    expect(cloneRes.body.ruleSystem).toBe('e2e-clone-hack');
    expect(cloneRes.body.customMechanicsProfile).toMatchObject({ slug: 'e2e-clone-hack', abilityTable: 'sw-banded' });
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
