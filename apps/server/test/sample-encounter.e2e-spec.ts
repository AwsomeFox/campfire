/**
 * "Try a sample fight" one-click demo seed (issue #1932) — e2e coverage.
 *
 * Composes CharactersService.create, EncountersService.create/addCombatant, and
 * MapsService.generateForEncounter — this suite proves the COMPOSITION behaves as the issue
 * requires (counts, statuses, role gates, archived-campaign refusal, audit rows, repeat-click
 * naming, REST/MCP parity), not the individual services themselves (already covered by their
 * own suites).
 */
import request from 'supertest';
import { eq, and } from 'drizzle-orm';
import { isResolvableSpec } from '@campfire/schema';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';
import { DB, type DrizzleDb } from '../src/db/db.module';
import { auditLog } from '../src/db/schema';
import { McpToolsService } from '../src/modules/mcp/mcp-tools';
import type { RequestUser } from '../src/common/user.types';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };
const player = { 'x-dev-role': 'player', 'x-dev-user': 'p-1' };
const viewer = { 'x-dev-role': 'viewer', 'x-dev-user': 'v-1' };

describe('sample encounter seed (e2e, issue #1932)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  async function freshCampaign(name: string): Promise<number> {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post('/api/v1/campaigns').set(dm).send({ name });
    expect(res.status).toBe(201);
    return res.body.id;
  }

  it('seeds 4 pregens (active, full HP, unowned, resolvable actions, one caster with spell slots), a preparing encounter with 4 monsters, and an attached map', async () => {
    const server = ctx.app.getHttpServer();
    const campaignId = await freshCampaign('Fresh Table');

    const res = await request(server).post(`/api/v1/campaigns/${campaignId}/sample-encounter`).set(dm);
    expect(res.status).toBe(201);
    expect(res.body.encounterName).toBe('Sample Fight');
    expect(res.body.characterIds).toHaveLength(4);
    expect(res.body.monsterCombatantIds).toHaveLength(4);
    expect(typeof res.body.mapAttachmentId).toBe('number');
    const encounterId = res.body.encounterId as number;

    // The encounter is `preparing`, has 4 party + 4 monster combatants, and a grid-aligned map.
    const encRes = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
    expect(encRes.status).toBe(200);
    expect(encRes.body.status).toBe('preparing');
    expect(encRes.body.mapAttachmentId).toBe(res.body.mapAttachmentId);
    expect(encRes.body.gridSize).toBeGreaterThan(0);
    const combatants: Array<{
      kind: string;
      characterId: number | null;
      hpCurrent: number;
      hpMax: number;
      initiative: number | null;
      statblock?: { actions: Array<{ spec?: unknown }> } | null;
    }> = encRes.body.combatants;
    expect(combatants).toHaveLength(8);
    const partyCombatants = combatants.filter((c) => c.kind === 'character');
    const monsterCombatants = combatants.filter((c) => c.kind === 'monster');
    expect(partyCombatants).toHaveLength(4);
    expect(monsterCombatants).toHaveLength(4);
    for (const c of [...partyCombatants, ...monsterCombatants]) {
      expect(c.hpCurrent).toBe(c.hpMax);
      expect(c.hpMax).toBeGreaterThan(0);
      // Nobody has rolled initiative yet.
      expect(c.initiative).toBeNull();
    }
    for (const characterId of res.body.characterIds as number[]) {
      expect(partyCombatants.some((c) => c.characterId === characterId)).toBe(true);
    }

    // Every pregen is active, unowned (players claim later), and carries a resolvable action;
    // exactly one (the caster) has non-empty spellSlots and a spell action that consumes one.
    const charsRes = await request(server).get(`/api/v1/campaigns/${campaignId}/characters`).set(dm);
    expect(charsRes.status).toBe(200);
    const pregens = charsRes.body.filter((c: { id: number }) => (res.body.characterIds as number[]).includes(c.id));
    expect(pregens).toHaveLength(4);
    let castersWithSlots = 0;
    for (const pregen of pregens) {
      expect(pregen.status).toBe('active');
      expect(pregen.ownerUserId).toBeNull();
      expect(pregen.hpCurrent).toBe(pregen.hpMax);
      expect(pregen.actions.length).toBeGreaterThan(0);
      expect(pregen.actions.some((a: { spec?: unknown }) => isResolvableSpec(a.spec as never))).toBe(true);
      const slotLevels = Object.keys(pregen.spellSlots ?? {});
      if (slotLevels.length > 0) {
        castersWithSlots += 1;
        const level1 = pregen.spellSlots['1'];
        expect(level1.max).toBeGreaterThan(0);
        expect(level1.used).toBe(0);
        const spellConsumingSlot = pregen.actions.find((a: { spec?: { uses?: { spellLevel?: number } } }) => (a.spec?.uses?.spellLevel ?? 0) > 0);
        expect(spellConsumingSlot).toBeDefined();
      }
    }
    expect(castersWithSlots).toBe(1);

    // Every monster combatant carries a resolvable statblock action (Scimitar).
    for (const monster of monsterCombatants) {
      expect(monster.statblock?.actions.some((a) => isResolvableSpec(a.spec as never))).toBe(true);
    }

    // Audit trail names the seeding DM as actor for every kind of row this seed creates.
    const db = ctx.app.get<DrizzleDb>(DB);
    const rows = await db.select().from(auditLog).where(eq(auditLog.campaignId, campaignId));
    const actions = new Set(rows.map((r) => r.action));
    for (const action of ['character.create', 'encounter.create', 'encounter.combatant.add', 'map.generate', 'map.attach']) {
      expect(actions.has(action)).toBe(true);
    }
    expect(rows.every((r) => r.actor === 'dev:dm-1')).toBe(true);
  });

  it('player and viewer are refused (403); a viewer never even reaches a partial write', async () => {
    const server = ctx.app.getHttpServer();
    const campaignId = await freshCampaign('Gate Check');

    const playerRes = await request(server).post(`/api/v1/campaigns/${campaignId}/sample-encounter`).set(player);
    expect(playerRes.status).toBe(403);
    const viewerRes = await request(server).post(`/api/v1/campaigns/${campaignId}/sample-encounter`).set(viewer);
    expect(viewerRes.status).toBe(403);

    // Confirm the refusal was total — no encounter, no characters, ever created.
    const charsRes = await request(server).get(`/api/v1/campaigns/${campaignId}/characters`).set(dm);
    expect(charsRes.body).toHaveLength(0);
    const encsRes = await request(server).get(`/api/v1/campaigns/${campaignId}/encounters`).set(dm);
    expect(encsRes.body).toHaveLength(0);
  });

  it('refuses on an archived (paused) campaign, with no partial writes left behind', async () => {
    const server = ctx.app.getHttpServer();
    const campaignId = await freshCampaign('Archived Table');
    expect((await request(server).patch(`/api/v1/campaigns/${campaignId}`).set(dm).send({ status: 'paused' })).status).toBe(200);

    const res = await request(server).post(`/api/v1/campaigns/${campaignId}/sample-encounter`).set(dm);
    expect(res.status).toBe(403);

    // The refusal must be total: no orphan pregens or an empty "Sample Fight" encounter
    // left behind by a partial seed that failed partway through (e.g. if only a deeper
    // write path enforced the archive gate, after characters/encounter already landed).
    const charsRes = await request(server).get(`/api/v1/campaigns/${campaignId}/characters`).set(dm);
    expect(charsRes.body).toHaveLength(0);
    const encsRes = await request(server).get(`/api/v1/campaigns/${campaignId}/encounters`).set(dm);
    expect(encsRes.body).toHaveLength(0);
  });

  it('a second click never corrupts the first — it mints "Sample Fight 2"', async () => {
    const server = ctx.app.getHttpServer();
    const campaignId = await freshCampaign('Repeat Click Table');

    const first = await request(server).post(`/api/v1/campaigns/${campaignId}/sample-encounter`).set(dm);
    expect(first.status).toBe(201);
    expect(first.body.encounterName).toBe('Sample Fight');

    const second = await request(server).post(`/api/v1/campaigns/${campaignId}/sample-encounter`).set(dm);
    expect(second.status).toBe(201);
    expect(second.body.encounterName).toBe('Sample Fight 2');
    expect(second.body.encounterId).not.toBe(first.body.encounterId);

    // The first encounter is untouched — still 8 combatants, still present.
    const firstEnc = await request(server).get(`/api/v1/encounters/${first.body.encounterId}`).set(dm);
    expect(firstEnc.status).toBe(200);
    expect(firstEnc.body.combatants).toHaveLength(8);

    const third = await request(server).post(`/api/v1/campaigns/${campaignId}/sample-encounter`).set(dm);
    expect(third.body.encounterName).toBe('Sample Fight 3');
  });

  it('MCP seed_sample_encounter produces the same shape as REST, through the identical service', async () => {
    const campaignId = await freshCampaign('MCP Parity Table');
    const mcpTools = ctx.app.get(McpToolsService);
    const user: RequestUser = { id: 'dev:mcp-dm', name: 'mcp-dm', serverRole: 'admin', devRole: 'dm' };
    const toolset = mcpTools.buildToolset(user);

    const result = await toolset.call('seed_sample_encounter', { campaignId });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.text);
    expect(parsed.encounterName).toBe('Sample Fight');
    expect(parsed.characterIds).toHaveLength(4);
    expect(parsed.monsterCombatantIds).toHaveLength(4);
    expect(typeof parsed.mapAttachmentId).toBe('number');

    // Role-gated on the MCP surface too — a player-scoped MCP caller is refused, and refused
    // BEFORE any write (not merely left with an opaque error after partial side effects: a
    // weaker gate here could still let characters/an encounter land, then fail later when the
    // hidden encounter it just created turns out invisible to a non-DM read — isError:true
    // either way, so the error flag alone cannot tell the two apart).
    const server = ctx.app.getHttpServer();
    const beforeCount = (await request(server).get(`/api/v1/campaigns/${campaignId}/characters`).set(dm)).body.length;
    const playerUser: RequestUser = { id: 'dev:mcp-player', name: 'mcp-player', serverRole: 'user', devRole: 'player' };
    const playerToolset = mcpTools.buildToolset(playerUser);
    const denied = await playerToolset.call('seed_sample_encounter', { campaignId });
    expect(denied.isError).toBe(true);
    const afterCount = (await request(server).get(`/api/v1/campaigns/${campaignId}/characters`).set(dm)).body.length;
    expect(afterCount).toBe(beforeCount);
  });
});
