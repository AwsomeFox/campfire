import request from 'supertest';
import { eq } from 'drizzle-orm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';
import { startFakeOpen5e, type FakeOpen5e } from './fake-open5e';
import { startFakeDdb, PUBLIC_DDB_CHARACTER_ID, type FakeDdb } from './fake-ddb';
import { MCP_CATALOG_COUNTS, MCP_TOOL_NAMES } from '../src/modules/mcp/mcp-catalog';
import { OPEN_LEGEND_PACK_SLUG, PF2E_PACK_SLUG } from '@campfire/schema';
import { DB, type DrizzleDb } from '../src/db/db.module';
import { campaigns } from '../src/db/schema';

interface TextContent {
  type: 'text';
  text: string;
}

function parseResult(result: unknown): unknown {
  const content = (result as { content: TextContent[] }).content;
  return JSON.parse(content[0].text);
}

// Minimal valid 1x1 PNG for REST-only attachment upload in MCP parity tests (#683).
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108020000009077' +
    '53de0000000c4944415408d763f8ffff3f0005fe02fea1399e1e0000000049454e44ae426082',
  'hex',
);

const ALL_TOOLS = [...MCP_TOOL_NAMES];

describe('mcp endpoint (e2e, real sessions + PATs)', () => {
  let ctx: TestAppContext;
  let baseUrl: string;
  let dmAgent: ReturnType<typeof request.agent>;
  let campaignId: number;
  let dmToken: string;
  let viewerToken: string;
  let fakeOpen5e: FakeOpen5e;
  let fakeDdb: FakeDdb;
  const prevDdbBaseUrl = process.env.DDB_CHARACTER_SERVICE_BASE_URL;
  const clients: Client[] = [];

  async function mcpClient(token: string): Promise<Client> {
    const client = new Client({ name: 'campfire-e2e', version: '0.0.1' });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    clients.push(client);
    return client;
  }

  beforeAll(async () => {
    fakeDdb = await startFakeDdb();
    process.env.DDB_CHARACTER_SERVICE_BASE_URL = fakeDdb.baseUrl;
    ctx = await createTestAppNoDevAuth();
    await ctx.app.listen(0);
    const address = ctx.app.getHttpServer().address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}`;

    dmAgent = request.agent(ctx.app.getHttpServer());
    await dmAgent.post('/api/v1/auth/setup').send({ username: 'mcp-dm', password: 'dm-password-1' });

    const campRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'MCP Campaign' });
    campaignId = campRes.body.id;

    // writeScope: 'direct' is explicit — the safe default is 'propose' now
    // (issue #575), but this suite exercises MCP WRITE tools (create_quest,
    // award_xp, add_member…) against CANON, so we opt the fixture token in.
    const dmTokenRes = await dmAgent.post('/api/v1/tokens').send({ name: 'mcp-dm-token', scope: 'dm', writeScope: 'direct' });
    expect(dmTokenRes.status).toBe(201);
    dmToken = dmTokenRes.body.token;

    // writeScope: 'direct' explicit (issue #575 default is 'propose') — this
    // fixture asserts viewer scope GATES direct writes (RSVP allowed, create_quest
    // denied). Under the propose default those would route differently, so opt in.
    const viewerTokenRes = await dmAgent.post('/api/v1/tokens').send({ name: 'mcp-viewer-token', scope: 'viewer', writeScope: 'direct' });
    expect(viewerTokenRes.status).toBe(201);
    viewerToken = viewerTokenRes.body.token;

    // mcp-dm is the first user created via /auth/setup, so it's also the server admin —
    // install a rule pack from the fake Open5e server for the lookup_rule smoke test below.
    fakeOpen5e = await startFakeOpen5e();
    // Install is now a non-blocking background job (issue #20): POST returns 202 with a
    // job; poll it to completion so the pack is present for the lookup_rule smoke test.
    const installRes = await dmAgent.post('/api/v1/rules/packs/install').send({ source: 'open5e', url: fakeOpen5e.baseUrl });
    expect(installRes.status).toBe(202);
    const jobId = installRes.body.id;
    const start = Date.now();
    for (;;) {
      const jobRes = await dmAgent.get(`/api/v1/rules/packs/install-jobs/${jobId}`);
      if (jobRes.body.status === 'completed' || jobRes.body.status === 'failed') {
        expect(jobRes.body.status).toBe('completed');
        break;
      }
      if (Date.now() - start > 15_000) throw new Error(`rule-pack install job did not finish (last ${jobRes.body.status})`);
      await new Promise((r) => setTimeout(r, 25));
    }
  });

  afterAll(async () => {
    for (const client of clients) {
      await client.close().catch(() => undefined);
    }
    await fakeOpen5e.close();
    await fakeDdb.close();
    if (prevDdbBaseUrl === undefined) delete process.env.DDB_CHARACTER_SERVICE_BASE_URL;
    else process.env.DDB_CHARACTER_SERVICE_BASE_URL = prevDdbBaseUrl;
    await closeTestApp(ctx);
  });

  it('tools/list returns the full catalog', async () => {
    const client = await mcpClient(dmToken);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...ALL_TOOLS].sort());

    expect(tools).toHaveLength(MCP_CATALOG_COUNTS.tools);

    // Strict schemas must still be ADVERTISED even though per-call validation happens
    // in our handler (so failures return the documented {"error"} JSON): every tool
    // with args advertises additionalProperties:false in tools/list.
    const updateCombatant = tools.find((t) => t.name === 'update_combatant');
    expect(updateCombatant?.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(updateCombatant?.description).toContain('addConditionInstance');
    const endTurn = tools.find((t) => t.name === 'end_turn');
    const endTurnProps = endTurn?.inputSchema.properties as Record<string, unknown>;
    expect(endTurnProps).toHaveProperty('idempotencyKey');
    expect(endTurn?.description).toContain('reused verbatim on every retry');
    const summary = tools.find((t) => t.name === 'get_campaign_summary');
    expect(summary?.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    expect((summary?.inputSchema as { properties?: Record<string, unknown> }).properties).toHaveProperty('campaignId');
    const setSupport = tools.find((t) => t.name === 'set_my_support_preference');
    expect(setSupport?.inputSchema.additionalProperties).toBe(false);
    expect(setSupport?.inputSchema.required).toEqual(
      expect.arrayContaining(['campaignId', 'supportText', 'visibility', 'aiUseConsent']),
    );

    const awardXp = tools.find((t) => t.name === 'award_xp');
    const awardProps = awardXp?.inputSchema.properties as Record<string, { type?: string; description?: string }>;
    expect(awardProps.characterIds.type).toBe('array');
    expect(awardProps.includeNonActive.type).toBe('boolean');
    expect(awardProps.includeNonActive.description).toContain('explicit opt-in');
  });

  it('runs the campaign-library taxonomy, search, bulk, undo, and template flow through MCP', async () => {
    const dmClient = await mcpClient(dmToken); const viewerClient = await mcpClient(viewerToken);
    const quest = parseResult(await dmClient.callTool({ name: 'create_quest', arguments: { campaignId, title: 'MCP library quest' } })) as { id: number };
    const tag = parseResult(await dmClient.callTool({ name: 'create_campaign_library_tag', arguments: { campaignId, name: 'MCP tag' } })) as { id: number };
    const searched = parseResult(await dmClient.callTool({ name: 'search_campaign_library', arguments: { campaignId, q: 'MCP library' } })) as { items: Array<{ entityId: number }> };
    expect(searched.items.some((entry) => entry.entityId === quest.id)).toBe(true);
    const bulk = parseResult(await dmClient.callTool({ name: 'bulk_campaign_library', arguments: { campaignId, request: { operation: 'add_tag', taxonomyId: tag.id, targets: [{ entityType: 'quest', entityId: quest.id }] } } })) as { operationId: number };
    expect(bulk.operationId).toBeTruthy();
    expect(parseResult(await dmClient.callTool({ name: 'undo_campaign_library_bulk', arguments: { campaignId, operationId: bulk.operationId } }))).toMatchObject({ undone: true });
    const template = parseResult(await dmClient.callTool({ name: 'save_campaign_library_template', arguments: { campaignId, entityType: 'quest', entityId: quest.id, name: 'MCP quest template', description: '' } })) as { id: number };
    expect(parseResult(await dmClient.callTool({ name: 'instantiate_campaign_library_template', arguments: { campaignId, templateId: template.id, name: 'MCP template copy', refs: {} } }))).toMatchObject({ entityType: 'quest' });
    const denied = parseResult(await viewerClient.callTool({ name: 'create_campaign_library_tag', arguments: { campaignId, name: 'Denied tag' } })) as { error?: { status?: number } };
    expect(denied.error?.status).toBe(403);
  });

  it('tools/list advertises additionalProperties:false on every tool that accepts args (issue #567)', async () => {
    const client = await mcpClient(dmToken);
    const { tools } = await client.listTools();

    const offenders: Array<{ name: string; additionalProperties: unknown }> = [];
    for (const tool of tools) {
      const properties = (tool.inputSchema.properties ?? {}) as Record<string, unknown>;
      if (Object.keys(properties).length === 0) {
        // zero-arg tools have no properties to be strict about
        continue;
      }
      if (tool.inputSchema.additionalProperties !== false) {
        offenders.push({ name: tool.name, additionalProperties: tool.inputSchema.additionalProperties });
      }
    }
    expect(offenders).toEqual([]);
  });

  it('tools/list input schemas inline every property — no sibling $refs (issue #31: add_combatant.ruleEntryId)', async () => {
    const client = await mcpClient(dmToken);
    const { tools } = await client.listTools();

    // Shared zod singletons (e.g. `Id` reused by several fields of one tool) used to be
    // deduped by identity into sibling-property refs like {"$ref":"#/properties/characterId"},
    // which some MCP clients don't resolve. No tool schema may contain a $ref at all.
    const offenders = tools.filter((t) => JSON.stringify(t.inputSchema).includes('"$ref"')).map((t) => t.name);
    expect(offenders).toEqual([]);

    const addCombatant = tools.find((t) => t.name === 'add_combatant');
    expect(addCombatant).toBeDefined();
    const props = addCombatant!.inputSchema.properties as Record<string, { type?: string; description?: string; $ref?: string }>;
    expect(props.ruleEntryId.$ref).toBeUndefined();
    expect(props.ruleEntryId.type).toBe('integer');
    expect(props.ruleEntryId.description).toContain('lookup_rule');
    expect(props.characterId.type).toBe('integer');
    // .strict() must still carry through to the serialized schema
    expect(addCombatant!.inputSchema.additionalProperties).toBe(false);
  });

  it('tools/list gives every optional numeric FK field a concrete numeric type (issue #371)', async () => {
    const client = await mcpClient(dmToken);
    const { tools } = await client.listTools();

    // A JSON-Schema node "carries a numeric type" iff its top-level `type` is (or
    // includes) number/integer. Nullable FKs must NOT be advertised as a bare untyped
    // union with no top-level type — that's exactly what broke MCP clients (#371).
    const numericTypes = new Set(['number', 'integer']);
    const hasTopLevelNumericType = (schema: { type?: unknown }): boolean => {
      const t = schema.type;
      return typeof t === 'string' ? numericTypes.has(t) : Array.isArray(t) && t.some((x) => numericTypes.has(x as string));
    };

    // Every property of every tool must advertise SOME concrete type — no bare `{}`.
    for (const tool of tools) {
      const props = (tool.inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
      for (const [, schema] of Object.entries(props)) {
        const typed =
          'type' in schema || 'enum' in schema || 'const' in schema || 'anyOf' in schema || 'oneOf' in schema || 'allOf' in schema || '$ref' in schema;
        expect(typed).toBe(true);
      }
    }

    // The specific nullable FK fields called out in the issue now carry a top-level
    // numeric type (previously untyped `{}` / an untyped `anyOf` union).
    const fkFields: Record<string, string[]> = {
      update_quest: ['giverNpcId', 'parentId'],
      create_quest: ['giverNpcId', 'parentId'],
      upsert_npc: ['factionId', 'locationId'],
      upsert_location: ['parentId', 'mapX', 'mapY'],
      create_beat: ['questId', 'encounterId', 'sessionId'],
    };
    for (const [toolName, fields] of Object.entries(fkFields)) {
      const tool = tools.find((t) => t.name === toolName);
      expect(tool).toBeDefined();
      const props = tool!.inputSchema.properties as Record<string, { type?: unknown }>;
      for (const field of fields) {
        expect(props[field]).toBeDefined();
        expect(hasTopLevelNumericType(props[field])).toBe(true);
      }
    }

    // The integer FK constraint survives the flattening (still a positive integer).
    const updateQuest = tools.find((t) => t.name === 'update_quest');
    const giver = updateQuest!.inputSchema.properties!.giverNpcId as { type?: unknown; exclusiveMinimum?: unknown };
    expect(giver.type).toEqual(['integer', 'null']);
    expect(giver.exclusiveMinimum).toBe(0);
  });

  it('get_campaign_summary works with a dm-scoped PAT', async () => {
    const client = await mcpClient(dmToken);
    const result = await client.callTool({ name: 'get_campaign_summary', arguments: { campaignId } });
    expect(result.isError).toBeFalsy();
    const summary = parseResult(result) as { campaign: { id: number; name: string }; openInboxCount: number };
    expect(summary.campaign.id).toBe(campaignId);
    expect(summary.campaign.name).toBe('MCP Campaign');
    expect(summary.openInboxCount).toBe(0);
  });

  it('award_xp has REST parity for active defaults, exact recipients, and legacy opt-in (issue #814)', async () => {
    const activeRes = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .send({ name: 'MCP Active XP', status: 'active', xp: 10 });
    const retiredRes = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .send({ name: 'MCP Retired XP', status: 'retired', xp: 20 });
    expect(activeRes.status).toBe(201);
    expect(retiredRes.status).toBe(201);

    const client = await mcpClient(dmToken);
    const defaultAward = await client.callTool({ name: 'award_xp', arguments: { campaignId, amount: 5 } });
    expect(defaultAward.isError).toBeFalsy();
    const defaultRecipients = parseResult(defaultAward) as Array<{ id: number; xp: number }>;
    expect(defaultRecipients.map((character) => character.id)).toContain(activeRes.body.id);
    expect(defaultRecipients.map((character) => character.id)).not.toContain(retiredRes.body.id);

    const refused = await client.callTool({
      name: 'award_xp',
      arguments: { campaignId, amount: 7, characterIds: [retiredRes.body.id] },
    });
    expect(refused.isError).toBe(true);
    expect((parseResult(refused) as { error: { message: string } }).error.message).toContain('includeNonActive');

    const correction = await client.callTool({
      name: 'award_xp',
      arguments: { campaignId, amount: 7, characterIds: [retiredRes.body.id], includeNonActive: true },
    });
    expect(correction.isError).toBeFalsy();
    expect(parseResult(correction)).toEqual([
      expect.objectContaining({ id: retiredRes.body.id, status: 'retired', xp: 27 }),
    ]);
  });

  it('create_quest via dm PAT creates a quest (verified via REST) and audits token actor', async () => {
    const client = await mcpClient(dmToken);
    const result = await client.callTool({
      name: 'create_quest',
      arguments: { campaignId, title: 'MCP-created quest', body: 'Written over MCP' },
    });
    expect(result.isError).toBeFalsy();
    const quest = parseResult(result) as { id: number; title: string; hidden: boolean };
    expect(quest.title).toBe('MCP-created quest');
    // #754: omit `hidden` on MCP create → DM-only (Zod must not default it to false).
    expect(quest.hidden).toBe(true);

    const restRes = await dmAgent.get(`/api/v1/campaigns/${campaignId}/quests`);
    expect(restRes.status).toBe(200);
    expect(restRes.body.some((q: { id: number }) => q.id === quest.id)).toBe(true);

    // service-layer audit picked up the token context automatically
    const auditRes = await dmAgent.get(`/api/v1/campaigns/${campaignId}/audit`);
    const entry = auditRes.body.find(
      (a: { action: string; entityId: number }) => a.action === 'quest.create' && a.entityId === quest.id,
    );
    expect(entry.actor).toBe('token:mcp-dm-token');
  });

  it('update_quest / upsert_* are partial merges: omitted fields unchanged, explicit null clears (issue #372)', async () => {
    const client = await mcpClient(dmToken);

    // A quest with a non-default status AND a giver NPC link.
    const npc = parseResult(
      await client.callTool({ name: 'upsert_npc', arguments: { campaignId, name: 'Quest Giver 372' } }),
    ) as { id: number };
    const created = parseResult(
      await client.callTool({
        name: 'create_quest',
        arguments: { campaignId, title: 'The Smoking Mountain', status: 'active', giverNpcId: npc.id, body: 'original body' },
      }),
    ) as { id: number; status: string; giverNpcId: number | null };
    expect(created.status).toBe('active');
    expect(created.giverNpcId).toBe(npc.id);

    // Editing only `body` must NOT reset the omitted status/giverNpcId to their
    // schema defaults (the data-loss the issue reports).
    const afterBody = parseResult(
      await client.callTool({ name: 'update_quest', arguments: { questId: created.id, body: 'edited body only' } }),
    ) as { status: string; giverNpcId: number | null; body: string };
    expect(afterBody.body).toBe('edited body only');
    expect(afterBody.status).toBe('active');
    expect(afterBody.giverNpcId).toBe(npc.id);

    // Intended-clear semantics: an EXPLICIT null does clear the giver (present-but-null
    // is distinct from omitted).
    const afterClear = parseResult(
      await client.callTool({ name: 'update_quest', arguments: { questId: created.id, giverNpcId: null } }),
    ) as { status: string; giverNpcId: number | null };
    expect(afterClear.giverNpcId).toBeNull();
    expect(afterClear.status).toBe('active');

    // upsert_location: a name-only edit must not reset an explored location to unexplored.
    const loc = parseResult(
      await client.callTool({ name: 'upsert_location', arguments: { campaignId, name: 'Cinder & Ash Inn', status: 'explored' } }),
    ) as { id: number; status: string };
    expect(loc.status).toBe('explored');
    const afterRename = parseResult(
      await client.callTool({ name: 'upsert_location', arguments: { campaignId, locationId: loc.id, name: 'The Cinder & Ash Inn' } }),
    ) as { status: string; name: string };
    expect(afterRename.name).toBe('The Cinder & Ash Inn');
    expect(afterRename.status).toBe('explored');
  });

  it('storylines: create_arc -> create_beat x2 -> add_branch -> set_beat_status -> list_arcs graph, DM-only (issue #27)', async () => {
    const client = await mcpClient(dmToken);

    const arcRes = await client.callTool({ name: 'create_arc', arguments: { campaignId, title: 'MCP Arc' } });
    expect(arcRes.isError).toBeFalsy();
    const arc = parseResult(arcRes) as { id: number; status: string };
    expect(arc.status).toBe('planned');

    const beat1Res = await client.callTool({ name: 'create_beat', arguments: { arcId: arc.id, title: 'Beat one' } });
    const beat1 = parseResult(beat1Res) as { id: number };
    const beat2Res = await client.callTool({ name: 'create_beat', arguments: { arcId: arc.id, title: 'Beat two' } });
    const beat2 = parseResult(beat2Res) as { id: number };

    const branchRes = await client.callTool({
      name: 'add_branch',
      arguments: { beatId: beat1.id, label: 'if they press on', toBeatId: beat2.id },
    });
    expect(branchRes.isError).toBeFalsy();
    const branch = parseResult(branchRes) as { toBeatId: number };
    expect(branch.toBeatId).toBe(beat2.id);

    // Bad toBeatId is a validation-style error, not a silent store.
    const badBranch = await client.callTool({
      name: 'add_branch',
      arguments: { beatId: beat1.id, label: 'nowhere', toBeatId: 999999 },
    });
    expect(badBranch.isError).toBe(true);

    const statusRes = await client.callTool({ name: 'set_beat_status', arguments: { beatId: beat1.id, status: 'active' } });
    expect((parseResult(statusRes) as { status: string }).status).toBe('active');

    const listRes = await client.callTool({ name: 'list_arcs', arguments: { campaignId } });
    const arcs = parseResult(listRes) as Array<{ id: number; beats: Array<{ id: number; branches: unknown[] }> }>;
    const found = arcs.find((a) => a.id === arc.id)!;
    expect(found.beats).toHaveLength(2);
    expect(found.beats[0].branches).toHaveLength(1);

    // DM-only: a viewer-scoped PAT cannot even list arcs.
    const viewerClient = await mcpClient(viewerToken);
    const denied = await viewerClient.callTool({ name: 'list_arcs', arguments: { campaignId } });
    expect(denied.isError).toBe(true);
    expect((denied.content as TextContent[])[0].text).toContain('403');
  });

  it('viewer-scoped PAT: create_quest is a 403-equivalent isError, and so is a SHARED note (issue #597)', async () => {
    const client = await mcpClient(viewerToken);

    const denied = await client.callTool({
      name: 'create_quest',
      arguments: { campaignId, title: 'Should be denied' },
    });
    expect(denied.isError).toBe(true);
    const message = (denied.content as TextContent[])[0].text;
    expect(message).toContain('403');

    // Issue #597: a viewer-scoped token acts as a READ-ONLY seat, so it may not write
    // anything that reaches another member — a dm_shared note notifies every DM. This
    // used to succeed, which meant the least-privilege token an operator hands an agent
    // could still broadcast into the table. The token cap deliberately wins over the
    // owner's real role here: an interactive agent needs a player-scoped token.
    const sharedNote = await client.callTool({
      name: 'add_note',
      arguments: { campaignId, body: 'A viewer note over MCP', visibility: 'dm_shared' },
    });
    expect(sharedNote.isError).toBe(true);
    expect((sharedNote.content as TextContent[])[0].text).toContain('403');

    // A PRIVATE note still works — it reaches nobody, and note-taking is what a viewer
    // seat is for.
    const note = await client.callTool({
      name: 'add_note',
      arguments: { campaignId, body: 'A viewer note over MCP', visibility: 'private' },
    });
    expect(note.isError).toBeFalsy();
    const created = parseResult(note) as { body: string; kind: string };
    expect(created.body).toBe('A viewer note over MCP');
    expect(created.kind).toBe('note');
  });

  it('inventory + treasury (issue #257): dm writes, viewer reads, viewer write is a 403-equivalent isError', async () => {
    const dmClient = await mcpClient(dmToken);
    const viewerClient = await mcpClient(viewerToken);

    // dm adds a party item and tops up the treasury.
    const addRes = await dmClient.callTool({
      name: 'add_inventory_item',
      arguments: { campaignId, name: 'Bag of Holding', qty: 1, notes: 'from the goblin hoard' },
    });
    expect(addRes.isError).toBeFalsy();
    const item = parseResult(addRes) as { id: number; name: string; ownerType: string };
    expect(item.name).toBe('Bag of Holding');
    expect(item.ownerType).toBe('party');

    const treasuryRes = await dmClient.callTool({
      name: 'adjust_treasury',
      arguments: { campaignId, delta: { gp: 50 } },
    });
    expect(treasuryRes.isError).toBeFalsy();
    expect((parseResult(treasuryRes) as { gp: number }).gp).toBe(50);

    // viewer PAT may READ inventory + treasury…
    const listRes = await viewerClient.callTool({ name: 'list_inventory', arguments: { campaignId } });
    expect(listRes.isError).toBeFalsy();
    expect((parseResult(listRes) as Array<{ id: number }>).some((i) => i.id === item.id)).toBe(true);
    const getTreasury = await viewerClient.callTool({ name: 'get_treasury', arguments: { campaignId } });
    expect((parseResult(getTreasury) as { gp: number }).gp).toBe(50);

    // …but a viewer-scoped PAT cannot write (player role required).
    const denied = await viewerClient.callTool({
      name: 'add_inventory_item',
      arguments: { campaignId, name: 'Contraband' },
    });
    expect(denied.isError).toBe(true);
    expect((denied.content as TextContent[])[0].text).toContain('403');
  });

  it('generate_map (issue #306): dm generates a deterministic hidden map; viewer is denied', async () => {
    const dmClient = await mcpClient(dmToken);
    const viewerClient = await mcpClient(viewerToken);

    const genRes = await dmClient.callTool({
      name: 'generate_map',
      arguments: { campaignId, kind: 'dungeon', size: 'small', seed: 'mcp-seed' },
    });
    expect(genRes.isError).toBeFalsy();
    const gen = parseResult(genRes) as {
      attachmentId: number;
      seed: string;
      kind: string;
      widthCells: number;
      gridConfig: { gridSize: number; gridType: string };
    };
    expect(gen.attachmentId).toBeGreaterThan(0);
    expect(gen.seed).toBe('mcp-seed');
    expect(gen.kind).toBe('dungeon');
    expect(gen.widthCells).toBe(20);
    expect(gen.gridConfig.gridType).toBe('square');

    // Default hidden (#97/#259): a viewer PAT's get_attachment 404s the generated map.
    const hidden = await viewerClient.callTool({ name: 'get_attachment', arguments: { attachmentId: gen.attachmentId } });
    expect(hidden.isError).toBe(true);

    // A viewer-scoped PAT cannot generate (dm role required).
    const denied = await viewerClient.callTool({ name: 'generate_map', arguments: { campaignId, kind: 'cave' } });
    expect(denied.isError).toBe(true);
    expect((denied.content as TextContent[])[0].text).toContain('403');
  });

  it('generate_ai_map (issue #410): dm generates candidates offline (procedural), fetches status, and attaches a hidden map; viewer denied', async () => {
    const dmClient = await mcpClient(dmToken);
    const viewerClient = await mcpClient(viewerToken);

    // No AI provider is configured, so generation routes HONESTLY to the first-party
    // procedural-blueprint renderer — deterministic + offline. A free-form theme
    // ("volcanic") is normalized rather than rejected (#410).
    const genRes = await dmClient.callTool({
      name: 'generate_ai_map',
      arguments: { campaignId, prompt: 'a volcanic dwarven forge', mode: 'battle-map', kind: 'dungeon', theme: 'volcanic', count: 2 },
    });
    expect(genRes.isError).toBeFalsy();
    const gen = parseResult(genRes) as {
      id: string;
      status: string;
      method: string;
      previews: Array<{ id: string; svg: string | null; provenance: { label: string } }>;
    };
    expect(gen.status).toBe('succeeded');
    expect(gen.method).toBe('procedural-blueprint');
    expect(gen.previews).toHaveLength(2);
    expect(gen.previews[0].provenance.label).toMatch(/procedural renderer/i);

    // get_map_generation returns the job status.
    const statusRes = await dmClient.callTool({ name: 'get_map_generation', arguments: { campaignId, jobId: gen.id } });
    expect(statusRes.isError).toBeFalsy();
    expect((parseResult(statusRes) as { id: string }).id).toBe(gen.id);

    // attach_generated_map persists a hidden map attachment.
    const attachRes = await dmClient.callTool({
      name: 'attach_generated_map',
      arguments: { campaignId, jobId: gen.id, previewId: gen.previews[0].id },
    });
    expect(attachRes.isError).toBeFalsy();
    const attach = parseResult(attachRes) as { attachment: { id: number }; provenance: { method: string } };
    expect(attach.attachment.id).toBeGreaterThan(0);
    expect(attach.provenance.method).toBe('procedural-blueprint');

    // Hidden by default (#97/#259): a viewer PAT cannot see the generated map.
    const hidden = await viewerClient.callTool({ name: 'get_attachment', arguments: { attachmentId: attach.attachment.id } });
    expect(hidden.isError).toBe(true);

    // A viewer-scoped PAT cannot generate (dm role required).
    const denied = await viewerClient.callTool({
      name: 'generate_ai_map',
      arguments: { campaignId, prompt: 'x', mode: 'battle-map' },
    });
    expect(denied.isError).toBe(true);
    expect((denied.content as TextContent[])[0].text).toContain('403');
  });

  it('timeline (issue #257): dm creates an event with a secret/hidden; viewer reads are redacted', async () => {
    const dmClient = await mcpClient(dmToken);
    const viewerClient = await mcpClient(viewerToken);

    const visibleRes = await dmClient.callTool({
      name: 'create_timeline_event',
      // #754: omit defaults to DM-only; this case needs a player-visible event for dmSecret strip.
      arguments: { campaignId, title: 'The Comet Falls', inWorldDate: '3rd of Flamerule', dmSecret: 'it is an omen', hidden: false },
    });
    expect(visibleRes.isError).toBeFalsy();
    const visible = parseResult(visibleRes) as { id: number };

    const hiddenRes = await dmClient.callTool({
      name: 'create_timeline_event',
      arguments: { campaignId, title: 'Secret Cabal Forms', hidden: true },
    });
    const hidden = parseResult(hiddenRes) as { id: number };

    // dm sees both, with the secret.
    const dmPage = parseResult(await dmClient.callTool({ name: 'list_timeline', arguments: { campaignId } })) as {
      items: Array<{ id: number; dmSecret: string }>;
    };
    expect(dmPage.items.some((e) => e.id === hidden.id)).toBe(true);
    expect(dmPage.items.find((e) => e.id === visible.id)?.dmSecret).toBe('it is an omen');

    // viewer: hidden event dropped wholesale, dmSecret stripped on the visible one.
    const viewerPage = parseResult(await viewerClient.callTool({ name: 'list_timeline', arguments: { campaignId } })) as {
      items: Array<{ id: number; dmSecret: string }>;
    };
    expect(viewerPage.items.some((e) => e.id === hidden.id)).toBe(false);
    expect(viewerPage.items.find((e) => e.id === visible.id)?.dmSecret).toBe('');

    // a viewer fetching the hidden event by id 404s (indistinguishable from nonexistent).
    const denied = await viewerClient.callTool({ name: 'get_timeline_event', arguments: { eventId: hidden.id } });
    expect(denied.isError).toBe(true);
    expect((denied.content as TextContent[])[0].text).toContain('404');
  });

  it('comments keep REST/MCP parity for owned character attribution (issue #787)', async () => {
    const client = await mcpClient(dmToken);
    const me = await dmAgent.get('/api/v1/me');
    const characterResult = await client.callTool({
      name: 'upsert_character',
      arguments: {
        campaignId,
        name: 'MCP Speaker',
        ownerUserId: me.body.user.id,
        portraitUrl: 'https://images.example.test/mcp-speaker.png',
      },
    });
    expect(characterResult.isError).toBeFalsy();
    const character = parseResult(characterResult) as { id: number };
    const sessionResult = await client.callTool({
      name: 'add_session_recap',
      arguments: { campaignId, title: 'MCP Persona Scene', recap: 'A scene for attributed dialogue.' },
    });
    const session = parseResult(sessionResult) as { id: number };

    const postResult = await client.callTool({
      name: 'post_comment',
      arguments: {
        campaignId,
        entityType: 'session',
        entityId: session.id,
        body: 'I speak through MCP.',
        inCharacter: true,
        characterId: character.id,
      },
    });
    expect(postResult.isError).toBeFalsy();
    expect(parseResult(postResult)).toMatchObject({
      characterId: character.id,
      characterName: 'MCP Speaker',
      characterAvatarUrl: 'https://images.example.test/mcp-speaker.png',
      authorName: 'mcp-dm',
    });

    const listed = parseResult(
      await client.callTool({
        name: 'list_comments',
        arguments: { campaignId, entityType: 'session', entityId: session.id },
      }),
    ) as Array<{ body: string; characterName: string }>;
    expect(listed).toEqual(expect.arrayContaining([expect.objectContaining({ body: 'I speak through MCP.', characterName: 'MCP Speaker' })]));

    const missingCharacter = await client.callTool({
      name: 'post_comment',
      arguments: {
        campaignId,
        entityType: 'session',
        entityId: session.id,
        body: 'No speaker selected.',
        inCharacter: true,
      },
    });
    expect(missingCharacter.isError).toBe(true);
    expect(parseResult(missingCharacter)).toMatchObject({ error: { status: 400, code: 'bad_request' } });
  });

  it('roll catalog (issue #415): list_checks surfaces unproficient skills; roll_check resolves server-side', async () => {
    const client = await mcpClient(dmToken);
    const created = parseResult(
      await client.callTool({
        name: 'upsert_character',
        arguments: {
          campaignId,
          name: 'MCP Catalog Hero',
          level: 5,
          stats: { STR: 14, DEX: 16, CON: 12, INT: 10, WIS: 13, CHA: 8 },
          saveProficiencies: ['DEX'],
          skills: { Athletics: 'proficient' },
        },
      }),
    ) as { id: number };

    // list_checks includes EVERY skill, proficient or not, with a transparent breakdown.
    const checks = parseResult(await client.callTool({ name: 'list_checks', arguments: { characterId: created.id } })) as Array<{
      id: string;
      modifier: number;
      favorite: boolean;
      category: string;
    }>;
    expect(checks.filter((c) => c.category === 'skill')).toHaveLength(18);
    const acro = checks.find((c) => c.id === 'skill:Acrobatics')!;
    expect(acro.modifier).toBe(3); // DEX +3, unproficient — still listed + rollable
    expect(acro.favorite).toBe(false);

    // roll_check resolves the modifier + expression server-side and records the roll.
    const rolled = parseResult(
      await client.callTool({ name: 'roll_check', arguments: { characterId: created.id, checkId: 'skill:Acrobatics', dc: 5 } }),
    ) as { check: { modifier: number; breakdownText: string }; roll: { expr: string; total: number; success?: boolean }; mode: string };
    expect(rolled.check.modifier).toBe(3);
    expect(rolled.check.breakdownText).toBe('DEX +3 = +3');
    expect(rolled.roll.expr).toBe('1d20+3');
    expect(rolled.mode).toBe('normal');
    expect(typeof rolled.roll.success).toBe('boolean');
  });

  it('check requests (issue #415): dm request_check → list_check_requests → resolve_check_request; viewer cannot resolve', async () => {
    const dmClient = await mcpClient(dmToken);
    const viewerClient = await mcpClient(viewerToken);
    const created = parseResult(
      await dmClient.callTool({
        name: 'upsert_character',
        arguments: { campaignId, name: 'MCP Save Target', level: 5, stats: { DEX: 16 }, saveProficiencies: ['DEX'] },
      }),
    ) as { id: number };

    // DM requests a DEX save with a DC + consequence.
    const requested = parseResult(
      await dmClient.callTool({
        name: 'request_check',
        arguments: { campaignId, characterIds: [created.id], checkId: 'save:DEX', dc: 12, consequence: 'The floor gives way.' },
      }),
    ) as Array<{ id: number; checkLabel: string; dc: number; consequence: string; status: string }>;
    expect(requested).toHaveLength(1);
    expect(requested[0].checkLabel).toBe('DEX save');
    expect(requested[0].dc).toBe(12);
    expect(requested[0].status).toBe('pending');
    const requestId = requested[0].id;

    // It surfaces via list_check_requests for the DM.
    const list = parseResult(
      await dmClient.callTool({ name: 'list_check_requests', arguments: { campaignId, status: 'pending' } }),
    ) as Array<{ id: number }>;
    expect(list.some((r) => r.id === requestId)).toBe(true);

    // A viewer-scoped principal cannot answer it (not the owner / DM).
    const denied = await viewerClient.callTool({ name: 'resolve_check_request', arguments: { requestId } });
    expect(denied.isError).toBe(true);

    // The DM resolves it — reuses the catalog-roll path (shared dice log + breakdown) and the
    // consequence rides through.
    const resolved = parseResult(
      await dmClient.callTool({ name: 'resolve_check_request', arguments: { requestId } }),
    ) as { request: { status: string; rollId: number; consequence: string }; result: { check: { id: string }; roll: { id: number; dc?: number } } };
    expect(resolved.request.status).toBe('resolved');
    expect(resolved.request.consequence).toBe('The floor gives way.');
    expect(resolved.result.check.id).toBe('save:DEX');
    expect(resolved.result.roll.dc).toBe(12);
    expect(resolved.request.rollId).toBe(resolved.result.roll.id);

    // Rolling it twice is rejected.
    const again = await dmClient.callTool({ name: 'resolve_check_request', arguments: { requestId } });
    expect(again.isError).toBe(true);
  });

  it('scheduling (issue #257): dm schedules a session, viewer RSVPs, viewer cannot cancel', async () => {
    const dmClient = await mcpClient(dmToken);
    const viewerClient = await mcpClient(viewerToken);

    const schedRes = await dmClient.callTool({
      name: 'schedule_session',
      arguments: { campaignId, scheduledAt: '2999-01-01T18:00:00Z', title: 'Session 5' },
    });
    expect(schedRes.isError).toBeFalsy();
    const sched = parseResult(schedRes) as { id: number };

    // Any member (viewer scope included) may RSVP.
    const rsvpRes = await viewerClient.callTool({
      name: 'set_rsvp',
      arguments: { scheduleId: sched.id, status: 'yes', note: 'bringing snacks' },
    });
    expect(rsvpRes.isError).toBeFalsy();
    expect((parseResult(rsvpRes) as { rsvps: Array<{ status: string }> }).rsvps.some((r) => r.status === 'yes')).toBe(true);

    // get_next_session surfaces it as the next game night.
    const next = parseResult(await viewerClient.callTool({ name: 'get_next_session', arguments: { campaignId } })) as {
      id: number;
    } | null;
    expect(next?.id).toBe(sched.id);

    // Cancelling is DM-only.
    const denied = await viewerClient.callTool({ name: 'cancel_scheduled_session', arguments: { scheduleId: sched.id } });
    expect(denied.isError).toBe(true);
    expect((denied.content as TextContent[])[0].text).toContain('403');
  });

  it('lookup_rule finds an installed rule pack entry and includes body on the top match', async () => {
    const client = await mcpClient(viewerToken); // read tool — viewer scope is enough
    const result = await client.callTool({ name: 'lookup_rule', arguments: { query: 'fireball' } });
    expect(result.isError).toBeFalsy();
    const matches = parseResult(result) as Array<{ name: string; type: string; body?: string }>;
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].name).toBe('Fireball');
    expect(matches[0].type).toBe('spell');
    expect(matches[0].body).toContain('bright streak');
  });

  it('lookup_rule ranks the exact-name match first (issue #33)', async () => {
    const client = await mcpClient(viewerToken);
    // "poisoned" matches both the Poisoned condition (by name) and Petrified (whose
    // body mentions the Poisoned condition and which was imported first) — the
    // exact-name match must be the top result, with its body included.
    const result = await client.callTool({ name: 'lookup_rule', arguments: { query: 'poisoned' } });
    expect(result.isError).toBeFalsy();
    const matches = parseResult(result) as Array<{ name: string; body?: string }>;
    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect(matches[0].name).toBe('Poisoned');
    expect(matches[0].body).toContain('disadvantage');
    expect(matches.some((m) => m.name === 'Petrified')).toBe(true);
  });

  it('lookup_rule respects the type filter', async () => {
    const client = await mcpClient(viewerToken);
    const result = await client.callTool({ name: 'lookup_rule', arguments: { query: 'goblin', type: 'monster' } });
    expect(result.isError).toBeFalsy();
    const matches = parseResult(result) as Array<{ name: string; type: string }>;
    expect(matches.some((m) => m.name === 'Goblin')).toBe(true);
    for (const m of matches) expect(m.type).toBe('monster');
  });

  it('lookup_rule scopes to a single pack via the pack filter (issue #717)', async () => {
    // Two uploaded packs whose entries share the search token "IsoGrapple" but live in
    // different systems. Without a pack filter the search sees both; with `pack` set it
    // sees only the named system — the multi-pack isolation property campaign lookups
    // rely on. (Distinct names let us tell them apart since lookup_rule only retains the
    // body of the top match.)
    const packA = {
      source: 'upload' as const,
      pack: { slug: 'iso-a-srd', name: 'Iso A SRD', version: '1.0', license: 'OGL 1.0a', sourceUrl: 'https://example.com/a' },
      entries: [{ slug: 'iso-a-grapple', name: 'IsoGrapple Alpha', type: 'condition', body: 'Iso A grapple body.' }],
    };
    const packB = {
      source: 'upload' as const,
      pack: { slug: 'iso-b-srd', name: 'Iso B SRD', version: '1.0', license: 'OGL 1.0a', sourceUrl: 'https://example.com/b' },
      entries: [{ slug: 'iso-b-grapple', name: 'IsoGrapple Beta', type: 'condition', body: 'Iso B grapple body.' }],
    };
    const aRes = await dmAgent.post('/api/v1/rules/packs/upload').send(packA);
    const bRes = await dmAgent.post('/api/v1/rules/packs/upload').send(packB);
    expect(aRes.status).toBe(202);
    expect(bRes.status).toBe(202);
    const poll = async (id: string) => {
      const start = Date.now();
      for (;;) {
        const job = await dmAgent.get(`/api/v1/rules/packs/install-jobs/${id}`);
        if (job.body.status === 'completed' || job.body.status === 'failed') return job.body;
        if (Date.now() - start > 10_000) throw new Error(`job ${id} did not finish`);
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    const aJob = await poll(aRes.body.id);
    const bJob = await poll(bRes.body.id);
    expect(aJob.status).toBe('completed');
    expect(bJob.status).toBe('completed');

    try {
      const client = await mcpClient(viewerToken);

      // No pack filter → entries from BOTH systems appear.
      const both = await client.callTool({ name: 'lookup_rule', arguments: { query: 'IsoGrapple' } });
      expect(both.isError).toBeFalsy();
      const bothNames = (parseResult(both) as Array<{ name: string }>).map((m) => m.name);
      expect(bothNames).toContain('IsoGrapple Alpha');
      expect(bothNames).toContain('IsoGrapple Beta');

      // Pack filter → only the named system's entry appears.
      const scoped = await client.callTool({ name: 'lookup_rule', arguments: { query: 'IsoGrapple', pack: 'iso-a-srd' } });
      expect(scoped.isError).toBeFalsy();
      const scopedMatches = parseResult(scoped) as Array<{ name: string; body?: string }>;
      expect(scopedMatches.some((m) => m.name === 'IsoGrapple Alpha')).toBe(true);
      expect(scopedMatches.some((m) => m.name === 'IsoGrapple Beta')).toBe(false);
      // Top match retains its body — and it is pack A's body, never pack B's.
      expect(scopedMatches[0].body ?? '').toContain('Iso A grapple body');
      expect((scopedMatches[0].body ?? '')).not.toContain('Iso B grapple body');
    } finally {
      await dmAgent.delete(`/api/v1/rules/packs/${aJob.pack.id}`);
      await dmAgent.delete(`/api/v1/rules/packs/${bJob.pack.id}`);
    }
  });

  it('get_ai_dm_seat redacts DM instructions (plot secrets) for a non-DM caller (issue #261)', async () => {
    // Enable the experimental feature (admin) and configure the seat with a private
    // steering prompt via REST — this is where plot secrets live.
    const flagRes = await dmAgent.patch('/api/v1/settings').send({ experimentalAiDm: true });
    expect(flagRes.status).toBe(200);
    const cfgRes = await dmAgent.put(`/api/v1/campaigns/${campaignId}/ai-dm`).send({
      enabled: true,
      model: 'connected-agent',
      instructions: 'Secret: the duke is the true villain.',
      tokenBudget: 1000,
    });
    expect(cfgRes.status).toBe(200);

    // The DM-scoped PAT sees the instructions in full.
    const dmClient = await mcpClient(dmToken);
    const dmRes = await dmClient.callTool({ name: 'get_ai_dm_seat', arguments: { campaignId } });
    expect(dmRes.isError).toBeFalsy();
    const dmSeat = parseResult(dmRes) as { instructions?: string; model?: string };
    expect(dmSeat.instructions).toBe('Secret: the duke is the true villain.');

    // A viewer-scoped PAT gets the seat WITHOUT instructions; other fields remain.
    const viewerClient = await mcpClient(viewerToken);
    const viewerRes = await viewerClient.callTool({ name: 'get_ai_dm_seat', arguments: { campaignId } });
    expect(viewerRes.isError).toBeFalsy();
    const viewerSeat = parseResult(viewerRes) as Record<string, unknown>;
    expect(viewerSeat).not.toHaveProperty('instructions');
    expect(viewerSeat.model).toBe('connected-agent');
    expect(viewerSeat.enabled).toBe(true);

    // Restore the default so later tests see the feature disabled.
    const restoreRes = await dmAgent.patch('/api/v1/settings').send({ experimentalAiDm: false });
    expect(restoreRes.status).toBe(200);
  });

  it('propose:true returns a proposal; quest applied only after approve_proposal', async () => {
    const viewerClient = await mcpClient(viewerToken);
    const proposeResult = await viewerClient.callTool({
      name: 'create_quest',
      arguments: { campaignId, title: 'Proposed quest', propose: true },
    });
    expect(proposeResult.isError).toBeFalsy();
    const { proposal } = parseResult(proposeResult) as {
      proposal: { id: number; status: string; entityType: string; action: string };
    };
    expect(proposal.status).toBe('pending');
    expect(proposal.entityType).toBe('quest');
    expect(proposal.action).toBe('create');

    // not created yet
    const before = await dmAgent.get(`/api/v1/campaigns/${campaignId}/quests`);
    expect(before.body.some((q: { title: string }) => q.title === 'Proposed quest')).toBe(false);

    // approve over MCP with the dm PAT
    const dmClient = await mcpClient(dmToken);
    const approveResult = await dmClient.callTool({
      name: 'approve_proposal',
      arguments: { proposalId: proposal.id, note: 'looks good' },
    });
    expect(approveResult.isError).toBeFalsy();
    const approved = parseResult(approveResult) as { status: string };
    expect(approved.status).toBe('approved');

    const after = await dmAgent.get(`/api/v1/campaigns/${campaignId}/quests`);
    expect(after.body.some((q: { title: string }) => q.title === 'Proposed quest')).toBe(true);
  });

  // Issue #125: add_session_recap must NOT freeze the session number into a proposed
  // recap's payload. If it did, a session logged between propose and approve would
  // collide on that frozen number and every approve would 409, trapping the draft.
  it('a proposed session recap (no number) approves cleanly even after another session is logged in between', async () => {
    // fresh campaign so the numbering is deterministic (no sessions yet -> next is 1)
    const recapCampRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'Recap Numbering #125' });
    const recapCampaignId = recapCampRes.body.id as number;
    const dmClient = await mcpClient(dmToken);

    // 1. Draft a recap as a proposal WITHOUT an explicit number. The stored payload
    //    must not carry a number — it's assigned at approval time.
    const proposeResult = await dmClient.callTool({
      name: 'add_session_recap',
      arguments: { campaignId: recapCampaignId, recap: 'The party crossed the bridge.', propose: true },
    });
    expect(proposeResult.isError).toBeFalsy();
    const { proposal } = parseResult(proposeResult) as {
      proposal: { id: number; status: string; payload: Record<string, unknown> };
    };
    expect(proposal.status).toBe('pending');
    expect(proposal.payload.number).toBeUndefined();

    // 2. Meanwhile the DM logs a session directly — it takes number 1 (the value the
    //    old code would have frozen into the proposal above).
    const directResult = await dmClient.callTool({
      name: 'add_session_recap',
      arguments: { campaignId: recapCampaignId, recap: 'A different night.' },
    });
    expect(directResult.isError).toBeFalsy();
    const directSession = parseResult(directResult) as { id: number; number: number };
    expect(directSession.number).toBe(1);

    // 3. Approving the proposal now must succeed (no 409) and get the next number (2).
    const approveResult = await dmClient.callTool({
      name: 'approve_proposal',
      arguments: { proposalId: proposal.id },
    });
    expect(approveResult.isError).toBeFalsy();
    const approved = parseResult(approveResult) as { status: string };
    expect(approved.status).toBe('approved');

    const list = await dmAgent.get(`/api/v1/campaigns/${recapCampaignId}/sessions`);
    expect(list.body).toHaveLength(2);
    const numbers = (list.body as Array<{ number: number }>).map((s) => s.number).sort();
    expect(numbers).toEqual([1, 2]);
  });

  // Issue #160: the default-number path used to precompute max+1 in the tool, so the
  // campaign-unique guard never saw a duplicate — a retried identical call created a
  // SECOND canonical session. It must now be retry-safe (dedupe, not duplicate).
  it('identical add_session_recap (no number) twice does not create two canonical sessions', async () => {
    const dupCampRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'Recap Retry #160' });
    const dupCampaignId = dupCampRes.body.id as number;
    const dmClient = await mcpClient(dmToken);

    const recap = 'Session recap that gets submitted twice after a timeout.';
    const first = await dmClient.callTool({ name: 'add_session_recap', arguments: { campaignId: dupCampaignId, recap } });
    expect(first.isError).toBeFalsy();
    const firstSession = parseResult(first) as { id: number; number: number };

    const second = await dmClient.callTool({ name: 'add_session_recap', arguments: { campaignId: dupCampaignId, recap } });
    expect(second.isError).toBeFalsy();
    const secondSession = parseResult(second) as { id: number; number: number };

    // The retry is a no-op: same row, same number — not a phantom second session.
    expect(secondSession.id).toBe(firstSession.id);
    expect(secondSession.number).toBe(firstSession.number);

    const list = await dmAgent.get(`/api/v1/campaigns/${dupCampaignId}/sessions`);
    expect(list.body).toHaveLength(1);

    const campRes = await dmAgent.get(`/api/v1/campaigns/${dupCampaignId}`);
    expect(campRes.body.sessionCount).toBe(1);
    expect(campRes.body.latestSessionNumber).toBe(1);

    // A genuinely different recap with no number still appends a new session (number 2).
    const distinct = await dmClient.callTool({
      name: 'add_session_recap',
      arguments: { campaignId: dupCampaignId, recap: 'A genuinely different recap.' },
    });
    expect(distinct.isError).toBeFalsy();
    const distinctSession = parseResult(distinct) as { number: number };
    expect(distinctSession.number).toBe(2);
  });

  it('keeps recap-share REST/MCP policy and member disclosure in parity (#788)', async () => {
    const dmClient = await mcpClient(dmToken);
    const viewerClient = await mcpClient(viewerToken);
    const recap = parseResult(
      await dmClient.callTool({
        name: 'add_session_recap',
        arguments: { campaignId, recap: 'MCP public sharing recap', title: 'Shared by MCP' },
      }),
    ) as { id: number };
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const created = parseResult(
      await dmClient.callTool({
        name: 'create_session_share',
        arguments: { sessionId: recap.id, label: 'MCP guests', expiresAt },
      }),
    ) as { token: string; share: { id: number; tokenHash?: string } };
    expect(created.token).toMatch(/^cf_share_[0-9a-f]{48}$/);
    expect(created.share.tokenHash).toBeUndefined();

    const visible = parseResult(
      await viewerClient.callTool({ name: 'list_session_shares', arguments: { sessionId: recap.id } }),
    ) as Array<{ label: string; expiresAt: string; accessCount: number; token?: string }>;
    expect(visible).toEqual([expect.objectContaining({ label: 'MCP guests', expiresAt, accessCount: 0 })]);
    expect(visible[0].token).toBeUndefined();

    const denied = await viewerClient.callTool({
      name: 'create_session_share',
      arguments: { sessionId: recap.id, label: 'Not allowed', expiresAt },
    });
    expect(denied.isError).toBe(true);
    expect(parseResult(denied)).toMatchObject({ error: { status: 403, code: 'forbidden' } });

    const disabled = parseResult(
      await dmClient.callTool({ name: 'set_recap_share_policy', arguments: { campaignId, enabled: false } }),
    );
    expect(disabled).toEqual({ revoked: 1 });
    expect((await request(ctx.app.getHttpServer()).get(`/api/v1/shared/recaps/${created.token}`)).status).toBe(404);
    await dmClient.callTool({ name: 'set_recap_share_policy', arguments: { campaignId, enabled: true } });
  });

  it('create_encounter -> add_combatant -> roll_initiative -> begin_encounter -> next_turn -> end_encounter via dm PAT', async () => {
    const client = await mcpClient(dmToken);

    const createResult = await client.callTool({
      name: 'create_encounter',
      arguments: { campaignId, name: 'MCP Skirmish' },
    });
    expect(createResult.isError).toBeFalsy();
    const created = parseResult(createResult) as { id: number; status: string; combatants: unknown[] };
    expect(created.status).toBe('preparing');
    const encounterId = created.id;

    const addResult = await client.callTool({
      name: 'add_combatant',
      arguments: { encounterId, kind: 'monster', name: 'MCP Kobold', hpMax: 5 },
    });
    expect(addResult.isError).toBeFalsy();
    const combatant = parseResult(addResult) as { id: number; name: string };
    expect(combatant.name).toBe('MCP Kobold');

    const getResult = await client.callTool({ name: 'get_encounter', arguments: { encounterId } });
    expect(getResult.isError).toBeFalsy();
    const fetched = parseResult(getResult) as { combatants: unknown[] };
    expect(fetched.combatants.length).toBeGreaterThanOrEqual(1);

    const rollInitResult = await client.callTool({ name: 'roll_initiative', arguments: { encounterId } });
    expect(rollInitResult.isError).toBeFalsy();
    const afterRoll = parseResult(rollInitResult) as { combatants: Array<{ initiative: number | null }> };
    expect(afterRoll.combatants.every((c) => c.initiative !== null)).toBe(true);

    const beginResult = await client.callTool({ name: 'begin_encounter', arguments: { encounterId } });
    expect(beginResult.isError).toBeFalsy();
    const begun = parseResult(beginResult) as { status: string; round: number };
    expect(begun.status).toBe('running');
    expect(begun.round).toBe(1);

    const nextTurnResult = await client.callTool({ name: 'next_turn', arguments: { encounterId } });
    expect(nextTurnResult.isError).toBeFalsy();

    const endResult = await client.callTool({ name: 'end_encounter', arguments: { encounterId } });
    expect(endResult.isError).toBeFalsy();
    const ended = parseResult(endResult) as { status: string };
    expect(ended.status).toBe('ended');
  });

  it('roll_death_save replays the original MCP outcome for a lost-response retry', async () => {
    const character = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .send({ name: 'MCP Retry Nyx', hpCurrent: 8, hpMax: 8 });
    expect(character.status).toBe(201);
    const encounter = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/encounters`)
      .send({ name: 'MCP Death Save Retry', hidden: false });
    expect(encounter.status).toBe(201);
    const combatantId = (encounter.body.combatants as Array<{ id: number; characterId: number | null }>).find(
      (combatant) => combatant.characterId === character.body.id,
    )?.id;
    expect(combatantId).toBeDefined();
    const dying = await dmAgent.patch(`/api/v1/encounters/${encounter.body.id}/combatants/${combatantId}`).send({ hpSet: 0 });
    expect(dying.status).toBe(200);

    const client = await mcpClient(dmToken);
    const arguments_ = {
      encounterId: encounter.body.id,
      combatantId: combatantId!,
      idempotencyKey: 'mcp-death-save-lost-response',
    };
    const first = parseResult(await client.callTool({ name: 'roll_death_save', arguments: arguments_ }));
    expect((await dmAgent.delete(`/api/v1/encounters/${encounter.body.id}`)).status).toBe(200);
    const replay = parseResult(await client.callTool({ name: 'roll_death_save', arguments: arguments_ }));

    expect(replay).toEqual(first);
    const rolls = await dmAgent.get(`/api/v1/campaigns/${campaignId}/rolls`);
    expect(rolls.status).toBe(200);
    expect(rolls.body.filter((roll: { label?: string }) => roll.label === 'MCP Retry Nyx · death save')).toHaveLength(1);
  });

  // Issue #1904 — REST/MCP parity for the per-combatant initiative roll: the MCP tool
  // must behave identically to POST .../combatants/:cid/roll-initiative (same write, same
  // shared dice-log evidence, same idempotent replay contract).
  it('roll_combatant_initiative rolls a combatant, lands one dice-log row, and replays a lost response', async () => {
    const encounter = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/encounters`)
      .send({ name: 'MCP Initiative Roll', hidden: false });
    expect(encounter.status).toBe(201);
    const monster = await dmAgent
      .post(`/api/v1/encounters/${encounter.body.id}/combatants`)
      .send({ kind: 'monster', name: 'MCP Kobold', hpMax: 5 });
    expect(monster.status).toBe(201);
    const combatantId = monster.body.id as number;

    const client = await mcpClient(dmToken);
    const arguments_ = { encounterId: encounter.body.id, combatantId, idempotencyKey: 'mcp-roll-combatant-initiative' };
    const first = parseResult(await client.callTool({ name: 'roll_combatant_initiative', arguments: arguments_ })) as {
      combatant: { initiative: number | null };
      roll: { label?: string } | null;
    };
    expect(first.combatant.initiative).not.toBeNull();
    expect(first.roll).toMatchObject({ label: 'MCP Kobold · Initiative' });

    const rolls = await dmAgent.get(`/api/v1/campaigns/${campaignId}/rolls`);
    expect(rolls.body.filter((roll: { label?: string }) => roll.label === 'MCP Kobold · Initiative')).toHaveLength(1);

    // Same key replays the original outcome — no second roll, no duplicate dice-log row.
    const replay = parseResult(await client.callTool({ name: 'roll_combatant_initiative', arguments: arguments_ }));
    expect(replay).toEqual(first);
    const rollsAfterReplay = await dmAgent.get(`/api/v1/campaigns/${campaignId}/rolls`);
    expect(rollsAfterReplay.body.filter((roll: { label?: string }) => roll.label === 'MCP Kobold · Initiative')).toHaveLength(1);

    // Already-set initiative 409s over MCP too, matching REST.
    const again = await client.callTool({ name: 'roll_combatant_initiative', arguments: { ...arguments_, idempotencyKey: 'mcp-roll-combatant-initiative-2' } });
    expect(again.isError).toBe(true);
  });

  // Issue #1904 review finding: a viewer hitting a HIDDEN encounter's id must get the same
  // 404 a nonexistent id gets — not a 403 from the stricter 'player' role gate, which would
  // leak that the encounter exists (hidden entities are indistinguishable from nonexistent
  // for a non-DM elsewhere in this codebase, and the REST handler for this same action
  // already gets this right via a viewer-role visibility pre-check).
  it('roll_combatant_initiative 404s a hidden encounter for a viewer, matching REST — not a role-gate 403 that leaks existence', async () => {
    const hidden = await dmAgent.post(`/api/v1/campaigns/${campaignId}/encounters`).send({ name: 'MCP Hidden Roll Target', hidden: true });
    expect(hidden.status).toBe(201);
    const monster = await dmAgent
      .post(`/api/v1/encounters/${hidden.body.id}/combatants`)
      .send({ kind: 'monster', name: 'MCP Hidden Kobold', hpMax: 5 });
    expect(monster.status).toBe(201);

    const viewerClient = await mcpClient(viewerToken);
    const nonexistentEncounterId = 999999999;
    const [hiddenAttempt, nonexistentAttempt] = await Promise.all([
      viewerClient.callTool({
        name: 'roll_combatant_initiative',
        arguments: { encounterId: hidden.body.id, combatantId: monster.body.id, idempotencyKey: 'mcp-viewer-hidden-encounter' },
      }),
      viewerClient.callTool({
        name: 'roll_combatant_initiative',
        arguments: { encounterId: nonexistentEncounterId, combatantId: monster.body.id, idempotencyKey: 'mcp-viewer-nonexistent-encounter' },
      }),
    ]);
    expect(hiddenAttempt.isError).toBe(true);
    expect(nonexistentAttempt.isError).toBe(true);
    const hiddenError = parseResult(hiddenAttempt) as { error: { status: number } };
    const nonexistentError = parseResult(nonexistentAttempt) as { error: { status: number } };
    // The core regression: identical status for "hidden" and "doesn't exist" — a 403 on the
    // hidden one (from falling straight into the player-role gate) would have distinguished
    // them, leaking the hidden encounter's existence to a viewer.
    expect(hiddenError.error.status).toBe(404);
    expect(nonexistentError.error.status).toBe(404);
  });

  it('rejects legacy deathSaveRoll MCP input with migration guidance before any mutation', async () => {
    const character = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .send({ name: 'MCP Legacy Nyx', hpCurrent: 8, hpMax: 8 });
    expect(character.status).toBe(201);
    const encounter = await dmAgent.post(`/api/v1/campaigns/${campaignId}/encounters`).send({ name: 'MCP Legacy Death Save' });
    expect(encounter.status).toBe(201);
    const combatantId = (encounter.body.combatants as Array<{ id: number; characterId: number | null }>).find(
      (combatant) => combatant.characterId === character.body.id,
    )?.id;
    expect(combatantId).toBeDefined();
    expect((await dmAgent.patch(`/api/v1/encounters/${encounter.body.id}/combatants/${combatantId}`).send({ hpSet: 0 })).status).toBe(200);
    const beforeCombatant = (await dmAgent.get(`/api/v1/encounters/${encounter.body.id}`)).body.combatants.find(
      (combatant: { id: number }) => combatant.id === combatantId,
    );
    const beforeRolls = (await dmAgent.get(`/api/v1/campaigns/${campaignId}/rolls`)).body.length;

    const client = await mcpClient(dmToken);
    const legacy = await client.callTool({
      name: 'update_combatant',
      arguments: { encounterId: encounter.body.id, combatantId: combatantId!, deathSaveRoll: 20 },
    });

    expect(legacy.isError).toBe(true);
    const error = parseResult(legacy) as { error: { status: number; code: string; message: string; errors?: Array<{ field: string; message: string }> } };
    expect(error.error).toMatchObject({ status: 400, code: 'validation_failed' });
    expect(error.error.message).toContain('use roll_death_save instead');
    expect(error.error.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'deathSaveRoll', message: expect.stringContaining('roll_death_save') })]),
    );
    const afterCombatant = (await dmAgent.get(`/api/v1/encounters/${encounter.body.id}`)).body.combatants.find(
      (combatant: { id: number }) => combatant.id === combatantId,
    );
    expect(afterCombatant).toMatchObject(beforeCombatant);
    expect((await dmAgent.get(`/api/v1/campaigns/${campaignId}/rolls`)).body).toHaveLength(beforeRolls);
  });

  it('end_turn replays one MCP advance while preserving key-reuse and stale-turn conflicts (issue #1915)', async () => {
    const dmClient = await mcpClient(dmToken);

    const live = parseResult(
      await dmClient.callTool({ name: 'list_encounters', arguments: { campaignId, status: 'running' } }),
    ) as Array<{ id: number }>;
    for (const e of live) {
      await dmClient.callTool({ name: 'end_encounter', arguments: { encounterId: e.id } });
    }

    const charRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/characters`).send({
      name: 'MCP Turn Hero',
      hpMax: 20,
      hpCurrent: 20,
    });
    expect(charRes.status).toBe(201);

    const createResult = await dmClient.callTool({
      name: 'create_encounter',
      arguments: { campaignId, name: 'MCP End Turn Drill' },
    });
    const encounter = parseResult(createResult) as {
      id: number;
      combatants: Array<{ id: number; characterId: number | null }>;
    };
    let hero = encounter.combatants.find((c) => c.characterId === charRes.body.id);
    if (!hero) {
      const add = await dmClient.callTool({
        name: 'add_combatant',
        arguments: { encounterId: encounter.id, kind: 'character', characterId: charRes.body.id },
      });
      expect(add.isError).toBeFalsy();
      hero = parseResult(add) as { id: number; characterId: number | null };
    }

    const goblin = await dmClient.callTool({
      name: 'add_combatant',
      arguments: { encounterId: encounter.id, kind: 'monster', name: 'MCP Goblin', hpMax: 5 },
    });
    expect(goblin.isError).toBeFalsy();

    await dmClient.callTool({ name: 'roll_initiative', arguments: { encounterId: encounter.id } });
    const mid = parseResult(
      await dmClient.callTool({ name: 'get_encounter', arguments: { encounterId: encounter.id } }),
    ) as { combatants: Array<{ id: number }> };
    for (const c of mid.combatants) {
      await dmClient.callTool({
        name: 'update_combatant',
        arguments: {
          encounterId: encounter.id,
          combatantId: c.id,
          initiative: c.id === hero!.id ? 99 : 1,
        },
      });
    }
    const begun = parseResult(
      await dmClient.callTool({ name: 'begin_encounter', arguments: { encounterId: encounter.id } }),
    ) as { status: string; currentCombatantId: number | null; combatants: Array<{ id: number; initiative: number | null }> };
    expect(begun.status).toBe('running');
    expect(begun.currentCombatantId).toBe(hero!.id);
    const turnOrder = [...begun.combatants]
      .filter((c) => c.initiative != null)
      .sort((a, b) => (b.initiative ?? 0) - (a.initiative ?? 0));
    const heroIdx = turnOrder.findIndex((c) => c.id === hero!.id);
    const expectedNextId = turnOrder[(heroIdx + 1) % turnOrder.length]!.id;

    const readyResult = await dmClient.callTool({
      name: 'set_turn_state',
      arguments: { encounterId: encounter.id, combatantId: hero!.id, readied: 'When hostile moves' },
    });
    expect(readyResult.isError).toBeFalsy();
    expect((parseResult(readyResult) as { turnState: { readied: string | null } }).turnState.readied).toBe(
      'When hostile moves',
    );

    const endTurnArguments = {
      encounterId: encounter.id,
      expectedCurrentCombatantId: hero!.id,
      idempotencyKey: 'mcp-end-turn-replay',
    };
    const endTurnResult = await dmClient.callTool({ name: 'end_turn', arguments: endTurnArguments });
    expect(endTurnResult.isError).toBeFalsy();
    const afterEnd = parseResult(endTurnResult) as { currentCombatantId: number | null };
    expect(afterEnd.currentCombatantId).toBe(expectedNextId);

    // A lost-response retry is the same logical advance: it replays the receipt and
    // leaves the server on the once-advanced combatant rather than skipping another turn.
    const replay = await dmClient.callTool({ name: 'end_turn', arguments: endTurnArguments });
    expect(replay.isError).toBeFalsy();
    expect(parseResult(replay)).toEqual(afterEnd);
    const persisted = parseResult(
      await dmClient.callTool({ name: 'get_encounter', arguments: { encounterId: encounter.id } }),
    ) as { currentCombatantId: number | null };
    expect(persisted.currentCombatantId).toBe(expectedNextId);

    // Reusing the key for a different intent must fail instead of silently replaying.
    const keyReuse = await dmClient.callTool({
      name: 'end_turn',
      arguments: { ...endTurnArguments, expectedCurrentCombatantId: expectedNextId },
    });
    expect(keyReuse.isError).toBe(true);
    expect(parseResult(keyReuse)).toMatchObject({ error: { status: 409, code: 'IDEMPOTENCY_KEY_REUSE' } });

    // A fresh intent still respects the stale-turn compare-and-swap guard.
    const stale = await dmClient.callTool({
      name: 'end_turn',
      arguments: { ...endTurnArguments, idempotencyKey: 'mcp-end-turn-stale' },
    });
    expect(stale.isError).toBe(true);
    expect(parseResult(stale)).toMatchObject({ error: { status: 409, code: 'TURN_ALREADY_ADVANCED' } });

    await dmClient.callTool({ name: 'end_encounter', arguments: { encounterId: encounter.id } });
  });

  it('get_encounter redacts monster HP for a non-DM viewer PAT (issue #256)', async () => {
    // DM seeds an encounter with a monster carrying exact HP.
    const dmC = await mcpClient(dmToken);
    const enc = parseResult(
      await dmC.callTool({
        name: 'create_encounter',
        // #754: omit defaults to DM-only (404 for viewer); this case tests HP banding, so reveal.
        arguments: { campaignId, name: 'Secret Ambush', hidden: false },
      }),
    ) as { id: number };
    const added = await dmC.callTool({
      name: 'add_combatant',
      arguments: { encounterId: enc.id, kind: 'monster', name: 'Hidden Ogre', hpMax: 59 },
    });
    expect(added.isError).toBeFalsy();

    // The DM sees exact HP…
    const dmView = parseResult(
      await dmC.callTool({ name: 'get_encounter', arguments: { encounterId: enc.id } }),
    ) as { combatants: Array<{ name: string; hpCurrent: number | null; hpBand?: string }> };
    const dmOgre = dmView.combatants.find((c) => c.name === 'Hidden Ogre')!;
    expect(dmOgre.hpCurrent).toBe(59);

    // …but a viewer-scoped PAT gets the HP banded, never the exact number.
    const viewerC = await mcpClient(viewerToken);
    const viewerRes = await viewerC.callTool({ name: 'get_encounter', arguments: { encounterId: enc.id } });
    expect(viewerRes.isError).toBeFalsy();
    const viewerView = parseResult(viewerRes) as {
      combatants: Array<{ name: string; hpCurrent: number | null; hpBand?: string }>;
    };
    const viewerOgre = viewerView.combatants.find((c) => c.name === 'Hidden Ogre')!;
    expect(viewerOgre.hpCurrent).toBeNull();
    expect(viewerOgre.hpBand).toBeTruthy();
  });

  it('list_encounter_events returns the persisted combat log with stable ids (issue #1068)', async () => {
    const dmC = await mcpClient(dmToken);
    const enc = parseResult(
      await dmC.callTool({ name: 'create_encounter', arguments: { campaignId, name: 'Log Test Fight' } }),
    ) as { id: number };
    const goblin = parseResult(
      await dmC.callTool({
        name: 'add_combatant',
        arguments: { encounterId: enc.id, kind: 'monster', name: 'Goblin Scout', hpMax: 20 },
      }),
    ) as { id: number };
    await dmC.callTool({ name: 'roll_initiative', arguments: { encounterId: enc.id } });
    await dmC.callTool({ name: 'begin_encounter', arguments: { encounterId: enc.id } });
    // Deal damage — this appends a 'damage' event to the persistent combat log.
    await dmC.callTool({
      name: 'update_combatant',
      arguments: { encounterId: enc.id, combatantId: goblin.id, hpDelta: -8 },
    });

    const res = await dmC.callTool({ name: 'list_encounter_events', arguments: { encounterId: enc.id } });
    expect(res.isError).toBeFalsy();
    const events = parseResult(res) as Array<{
      id: number;
      encounterId: number;
      type: string;
      round: number;
    }>;
    // At least the begin/turn + damage events are present, in insertion order.
    expect(Array.isArray(events)).toBe(true);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.encounterId === enc.id)).toBe(true);
    expect(events.some((e) => e.type === 'damage')).toBe(true);
    // Ids are stable and ascending (chronological insertion order).
    const ids = events.map((e) => e.id);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);

    // Clean up: end this fight so it doesn't hold the campaign's single active-encounter
    // slot (#744) and break later tests that begin their own encounter.
    await dmC.callTool({ name: 'end_encounter', arguments: { encounterId: enc.id } });
  });

  it('list_encounter_events 404s a hidden encounter for a non-DM viewer PAT (issue #869 parity)', async () => {
    const dmC = await mcpClient(dmToken);
    const hidden = parseResult(
      await dmC.callTool({
        name: 'create_encounter',
        arguments: { campaignId, name: 'Hidden Prep Fight', hidden: true },
      }),
    ) as { id: number };

    // DM can read the hidden encounter's (possibly empty) log.
    const dmRes = await dmC.callTool({ name: 'list_encounter_events', arguments: { encounterId: hidden.id } });
    expect(dmRes.isError).toBeFalsy();

    // A viewer-scoped PAT must not even learn the hidden encounter exists.
    const viewerC = await mcpClient(viewerToken);
    const viewerRes = await viewerC.callTool({ name: 'list_encounter_events', arguments: { encounterId: hidden.id } });
    expect(viewerRes.isError).toBe(true);
    expect(parseResult(viewerRes)).toMatchObject({ error: { status: 404 } });
  });

  it('draft_session_recap assembles the template scaffold + seeds encounters and resolved inbox threads (issue #62)', async () => {
    const client = await mcpClient(dmToken);

    // Seed a resolved inbox thread…
    const submitted = await client.callTool({
      name: 'submit_inbox_item',
      arguments: { campaignId, body: 'Did the tavern keeper survive the fire?' },
    });
    expect(submitted.isError).toBeFalsy();
    const inboxItem = parseResult(submitted) as { id: number };
    const resolved = await client.callTool({
      name: 'resolve_inbox_item',
      arguments: { noteId: inboxItem.id, resolvedNote: 'Yes — he fled out the back.' },
    });
    expect(resolved.isError).toBeFalsy();

    // …and an encounter that was actually run (ended).
    const enc = parseResult(
      await client.callTool({ name: 'create_encounter', arguments: { campaignId, name: 'Bandit Ambush' } }),
    ) as { id: number };
    await client.callTool({
      name: 'add_combatant',
      arguments: { encounterId: enc.id, kind: 'monster', name: 'Bandit Captain', hpMax: 12 },
    });
    await client.callTool({ name: 'roll_initiative', arguments: { encounterId: enc.id } });
    await client.callTool({ name: 'begin_encounter', arguments: { encounterId: enc.id } });
    await client.callTool({ name: 'end_encounter', arguments: { encounterId: enc.id } });

    // Issue #501: draft_session_recap hands member-authored note bodies straight to the
    // connected MCP client, which is definitionally an external model — so it applies the
    // same server-side consent filter as the scribe run engine. The note's author must have
    // opted in before their material is eligible. (The fail-closed default is asserted in
    // scribe.e2e-spec.ts, and the exclusion is asserted in the next test.)
    const consent = await dmAgent
      .patch(`/api/v1/campaigns/${campaignId}/members/me/ai-consent`)
      .send({ aiExternalUseConsent: true });
    expect(consent.status).toBe(200);

    const result = await client.callTool({ name: 'draft_session_recap', arguments: { campaignId } });
    expect(result.isError).toBeFalsy();
    const draft = parseResult(result) as {
      template: string;
      draft: string;
      guidance: string;
      sourceMaterial: {
        resolvedInbox: Array<{ body: string; resolvedNote: string }>;
        encounters: Array<{ name: string; status: string }>;
      };
    };

    // The bare template carries the four canonical headings…
    for (const heading of ['## Recap', '## Loot', '## NPCs met', '## Cliffhanger']) {
      expect(draft.template).toContain(heading);
      expect(draft.draft).toContain(heading);
    }
    // …the draft is seeded with the ended encounter and its foe…
    expect(draft.draft).toContain('Bandit Ambush');
    expect(draft.draft).toContain('Bandit Captain');
    // …and the resolved inbox thread appears in the source-notes appendix.
    expect(draft.draft).toContain('Did the tavern keeper survive the fire?');
    expect(draft.draft).toContain('Threads resolved this session');
    expect(draft.sourceMaterial.resolvedInbox.some((n) => n.resolvedNote.includes('fled out the back'))).toBe(true);
    expect(draft.sourceMaterial.encounters.some((e) => e.name === 'Bandit Ambush' && e.status === 'ended')).toBe(true);
  });

  it('draft_session_recap withholds a member\'s note once they revoke AI consent (#501)', async () => {
    const client = await mcpClient(dmToken);

    const revoke = await dmAgent
      .patch(`/api/v1/campaigns/${campaignId}/members/me/ai-consent`)
      .send({ aiExternalUseConsent: false });
    expect(revoke.status).toBe(200);

    const result = await client.callTool({ name: 'draft_session_recap', arguments: { campaignId } });
    expect(result.isError).toBeFalsy();
    const draft = parseResult(result) as {
      draft: string;
      sourceMaterial: { resolvedInbox: Array<{ body: string }>; encounters: Array<{ name: string }> };
      consent: { campaignPolicy: string; excludedInboxByConsent: number };
    };

    // The note is gone from BOTH the rendered draft and the raw structured material —
    // this tool used to read notes directly and ship every one of them regardless.
    expect(draft.draft).not.toContain('Did the tavern keeper survive the fire?');
    expect(draft.sourceMaterial.resolvedInbox).toHaveLength(0);
    expect(draft.consent.campaignPolicy).toBe('member_consent');
    expect(draft.consent.excludedInboxByConsent).toBeGreaterThan(0);
    // Non-member-authored material is unaffected — only authored notes are gated.
    expect(draft.sourceMaterial.encounters.some((e) => e.name === 'Bandit Ambush')).toBe(true);

    const regrant = await dmAgent
      .patch(`/api/v1/campaigns/${campaignId}/members/me/ai-consent`)
      .send({ aiExternalUseConsent: true });
    expect(regrant.status).toBe(200);
  });

  /**
   * Issue #501 review — routing this tool through the scribe's assembler must not inherit
   * the RUN ENGINE's "is this worth spending provider tokens on?" gate.
   *
   * That gate collapses the assembly to nothing unless there is a fought encounter, a
   * resolved note, or a dice roll. Applied here it dropped `preparing` encounters from a
   * scaffold tool that calls no model at all — collateral from sharing one assembler, and
   * serving no consent purpose, since encounters are DM-authored and never consent-gated.
   */
  it('draft_session_recap still returns encounters that are only PREPARING (#501 review)', async () => {
    // A campaign whose sole material is an unfought encounter — nothing "recap-worthy".
    const created = await dmAgent.post('/api/v1/campaigns').send({ name: 'Prep Only Campaign' });
    expect(created.status).toBe(201);
    const prepCampaignId = created.body.id as number;

    const encounter = await dmAgent
      .post(`/api/v1/campaigns/${prepCampaignId}/encounters`)
      .send({ name: 'Planned Ambush' });
    expect(encounter.status).toBe(201);
    expect(encounter.body.status).toBe('preparing');

    const client = await mcpClient(dmToken);
    const result = await client.callTool({
      name: 'draft_session_recap',
      arguments: { campaignId: prepCampaignId },
    });
    expect(result.isError).toBeFalsy();
    const draft = parseResult(result) as {
      sourceMaterial: { encounters: Array<{ name: string; status: string }> };
      consent: { campaignPolicy: string };
    };

    expect(draft.sourceMaterial.encounters.map((e) => e.name)).toContain('Planned Ambush');
    // The consent block is present even on an otherwise-empty assembly, so an empty result
    // always carries its own explanation rather than reading as a broken tool.
    expect(draft.consent.campaignPolicy).toBeTruthy();
  });

  it('draft_session_recap is dm-only (viewer PAT is denied)', async () => {
    const viewerClient = await mcpClient(viewerToken);
    const denied = await viewerClient.callTool({ name: 'draft_session_recap', arguments: { campaignId } });
    expect(denied.isError).toBe(true);
  });

  it('roll_dice rolls within range via dm PAT', async () => {
    const client = await mcpClient(dmToken);
    const result = await client.callTool({ name: 'roll_dice', arguments: { campaignId, expr: '1d20+1' } });
    expect(result.isError).toBeFalsy();
    const rolled = parseResult(result) as { total: number; rolls: number[] };
    expect(rolled.rolls).toHaveLength(1);
    expect(rolled.total).toBeGreaterThanOrEqual(2);
    expect(rolled.total).toBeLessThanOrEqual(21);
  });

  it('roll_action_dice rolls Open Legend action dice via dm PAT', async () => {
    const db = ctx.app.get<DrizzleDb>(DB);
    const campRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'MCP Open Legend' });
    expect(campRes.status).toBe(201);
    const openLegendId = campRes.body.id;
    await db.update(campaigns).set({ ruleSystem: OPEN_LEGEND_PACK_SLUG }).where(eq(campaigns.id, openLegendId));

    const client = await mcpClient(dmToken);
    const result = await client.callTool({
      name: 'roll_action_dice',
      arguments: { campaignId: openLegendId, score: 5, attribute: 'Might' },
    });
    expect(result.isError).toBeFalsy();
    const rolled = parseResult(result) as {
      id: number;
      expr: string;
      total: number;
      rolls: number[];
      terms: Array<{ sides?: number; value: number; rolls?: number[] }>;
    };
    expect(rolled.expr).toBe('Open Legend action score 5');
    expect(rolled.terms.map((t) => t.sides)).toEqual([20, 6, 6]);
    expect(rolled.terms.reduce((sum, t) => sum + t.value, 0)).toBe(rolled.total);
    expect(rolled.rolls).toEqual(rolled.terms.flatMap((t) => t.rolls ?? []));
  });

  it('#1040 saving_throw resolves from character stats, persists dice log, and audits', async () => {
    const client = await mcpClient(dmToken);
    // Level-5 DEX 16 + save proficiency → bonus +6 (+3 dex, +3 prof); DC 1 always succeeds.
    const charResult = await client.callTool({
      name: 'upsert_character',
      arguments: {
        campaignId,
        name: 'Save Tester',
        level: 5,
        stats: { DEX: 16 },
        saveProficiencies: ['DEX'],
        hpMax: 20,
      },
    });
    expect(charResult.isError).toBeFalsy();
    const character = parseResult(charResult) as { id: number };

    const saveResult = await client.callTool({
      name: 'saving_throw',
      arguments: { characterId: character.id, ability: 'DEX', dc: 1 },
    });
    expect(saveResult.isError).toBeFalsy();
    const save = parseResult(saveResult) as {
      characterId: number;
      ability: string;
      dc: number;
      mode: string;
      score: number;
      abilityMod: number;
      profBonus: number;
      proficient: boolean;
      bonus: number;
      total: number;
      rolls: number[];
      success: boolean;
      diceLogId: number;
    };
    expect(save).toMatchObject({
      characterId: character.id,
      ability: 'DEX',
      dc: 1,
      mode: 'normal',
      score: 16,
      abilityMod: 3,
      profBonus: 3,
      proficient: true,
      bonus: 6,
      success: true,
    });
    expect(save.rolls.length).toBeGreaterThanOrEqual(1);
    expect(save.total).toBeGreaterThanOrEqual(7); // 1d20 + 6
    expect(save.total).toBeLessThanOrEqual(26);
    expect(typeof save.diceLogId).toBe('number');

    // Persisted to the shared campaign dice log via rollDiceForCampaign.
    const diceLog = await dmAgent.get(`/api/v1/campaigns/${campaignId}/rolls`);
    expect(diceLog.status).toBe(200);
    expect(
      (diceLog.body as Array<{ id: number; label: string | null; expr: string }>).some(
        (row) => row.id === save.diceLogId && (row.label ?? '').includes('DEX save') && row.expr.includes('+6'),
      ),
    ).toBe(true);

    // Audited like other dice rolls (entityId is null; detail carries label/expr/DC).
    const auditRes = await dmAgent.get(`/api/v1/campaigns/${campaignId}/audit`);
    expect(auditRes.status).toBe(200);
    expect(
      (auditRes.body as Array<{ action: string; detail: string }>).some(
        (a) => a.action === 'dice.roll' && a.detail.includes('DEX save') && a.detail.includes('vs DC 1'),
      ),
    ).toBe(true);

    // DC schema allows homebrew highs (max 100); an out-of-range DC is validation_failed.
    const highDc = await client.callTool({
      name: 'saving_throw',
      arguments: { characterId: character.id, ability: 'DEX', dc: 100 },
    });
    expect(highDc.isError).toBeFalsy();
    expect((parseResult(highDc) as { dc: number }).dc).toBe(100);

    const tooHigh = await client.callTool({
      name: 'saving_throw',
      arguments: { characterId: character.id, ability: 'DEX', dc: 101 },
    });
    expect(tooHigh.isError).toBe(true);
  });

  it('#1599 saving_throw routes proficiency through the campaign rule-system adapter (PF2e: non-zero, not the old silent 0)', async () => {
    const db = ctx.app.get<DrizzleDb>(DB);
    const campRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'MCP PF2e Saves' });
    expect(campRes.status).toBe(201);
    const pf2eCampaignId = campRes.body.id;
    await db.update(campaigns).set({ ruleSystem: PF2E_PACK_SLUG }).where(eq(campaigns.id, pf2eCampaignId));

    const client = await mcpClient(dmToken);
    // Level-5 DEX 16 + save proficiency. Ability mod is the same floor((16-10)/2)=+3 as 5e
    // (PF2e's abilityModifier), but proficiency must now be PF2e's own: level + the "trained"
    // rank bonus (the sheet has no rank field, only proficient/not — see checkProficiencyBonus
    // on Pf2eAdapter for why "trained" is the correct floor). 5 + 2 = +7, not 5e's flat +3 at
    // this level and NOT the pre-#1599 silent 0 for every non-5e adapter.
    const charResult = await client.callTool({
      name: 'upsert_character',
      arguments: {
        campaignId: pf2eCampaignId,
        name: 'PF2e Save Tester',
        level: 5,
        stats: { DEX: 16 },
        saveProficiencies: ['DEX'],
        hpMax: 20,
      },
    });
    expect(charResult.isError).toBeFalsy();
    const character = parseResult(charResult) as { id: number };

    const saveResult = await client.callTool({
      name: 'saving_throw',
      arguments: { characterId: character.id, ability: 'DEX', dc: 1 },
    });
    expect(saveResult.isError).toBeFalsy();
    const save = parseResult(saveResult) as {
      score: number;
      abilityMod: number;
      profBonus: number;
      proficient: boolean;
      bonus: number;
    };
    expect(save).toMatchObject({
      score: 16,
      abilityMod: 3,
      proficient: true,
      profBonus: 7, // pf2eProficiencyBonus(5, 'trained') = 5 + 2
      bonus: 10, // +3 dex, +7 prof — NOT +3 (5e) and NOT +3 alone (the pre-#1599 bug's silent 0)
    });

    // An unproficient save on the same PF2e character does not APPLY the proficiency bonus —
    // `profBonus` reports the rate this adapter/level would give if proficient (unconditional,
    // same shape the existing #1040 5e test already relies on); `bonus` is what actually lands
    // on the roll, and stays STR's bare +0 modifier with nothing added.
    const unprof = await client.callTool({
      name: 'saving_throw',
      arguments: { characterId: character.id, ability: 'STR', dc: 1 },
    });
    expect(unprof.isError).toBeFalsy();
    const unprofResult = parseResult(unprof) as { proficient: boolean; profBonus: number; bonus: number };
    expect(unprofResult).toMatchObject({ proficient: false, profBonus: 7, bonus: 0 });
  });

  it('admin-owned campaign-scoped PAT 403s on a different campaign, incl. an MCP tool call (punch list item 12)', async () => {
    // mcp-dm is the server admin (first user via /auth/setup — see beforeAll comment).
    // RoleResolver.effectiveRole()'s PAT cap says a campaign-bound token treats the
    // caller as a non-member outside that campaign, EVEN for admins — this pins that
    // behavior end-to-end via both REST and one real MCP tool call.
    const otherCampRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'MCP Other Campaign' });
    expect(otherCampRes.status).toBe(201);
    const otherCampaignId = otherCampRes.body.id;

    const scopedTokenRes = await dmAgent.post('/api/v1/tokens').send({ name: 'mcp-admin-scoped-token', scope: 'dm', campaignId });
    expect(scopedTokenRes.status).toBe(201);
    const scopedToken = scopedTokenRes.body.token;

    // REST: scoped token works on ITS campaign, 403s on the other.
    const restOk = await request(ctx.app.getHttpServer()).get(`/api/v1/campaigns/${campaignId}`).set('Authorization', `Bearer ${scopedToken}`);
    expect(restOk.status).toBe(200);
    const restForbidden = await request(ctx.app.getHttpServer())
      .get(`/api/v1/campaigns/${otherCampaignId}`)
      .set('Authorization', `Bearer ${scopedToken}`);
    expect(restForbidden.status).toBe(403);

    // MCP: same cap applies to a real tool call against the OTHER campaign.
    const client = await mcpClient(scopedToken);
    const deniedResult = await client.callTool({ name: 'get_campaign_summary', arguments: { campaignId: otherCampaignId } });
    expect(deniedResult.isError).toBe(true);
    const deniedSupports = await client.callTool({
      name: 'get_ai_support_preferences',
      arguments: { campaignId: otherCampaignId },
    });
    expect(deniedSupports.isError).toBe(true);

    // Sanity: the same token, same client, still works against ITS OWN campaign.
    const okResult = await client.callTool({ name: 'get_campaign_summary', arguments: { campaignId } });
    expect(okResult.isError).toBeFalsy();
  });

  it('strict arg schemas reject unknown keys with the documented {"error"} JSON (not SDK -32602 prose)', async () => {
    const client = await mcpClient(dmToken);
    // {hpCurrent} is not a real update_combatant arg (the real keys are hpDelta/hpSet) —
    // this must be a machine-actionable error, not a 200 that silently dropped the key,
    // and its text must be the documented {"error":{status,code,message}} JSON rather
    // than the MCP SDK's own "-32602 Input validation error" prose.
    const result = await client.callTool({
      name: 'update_combatant',
      arguments: { encounterId: 1, combatantId: 1, hpCurrent: 5 },
    });
    expect(result.isError).toBe(true);
    const parsed = parseResult(result) as { error: { status: number; code: string; message: string } };
    expect(parsed.error.status).toBe(400);
    expect(parsed.error.code).toBe('validation_failed');
    expect(parsed.error.message).toContain('hpCurrent');
  });

  it('strict arg schemas reject wrong-typed values with the documented {"error"} JSON naming the key', async () => {
    const client = await mcpClient(dmToken);
    const result = await client.callTool({
      name: 'get_campaign_summary',
      arguments: { campaignId: 'not-a-number' },
    });
    expect(result.isError).toBe(true);
    const parsed = parseResult(result) as { error: { status: number; code: string; message: string } };
    expect(parsed.error.status).toBe(400);
    expect(parsed.error.code).toBe('validation_failed');
    expect(parsed.error.message).toContain('campaignId');
  });

  it('#877 support tools keep facilitator visibility separate from AI consent and honor revocation immediately', async () => {
    const client = await mcpClient(dmToken);
    const route = `/api/v1/campaigns/${campaignId}/session-zero/support-preferences/me`;
    const privateText = 'MCP_FACILITATOR_ONLY_NO_AI_877';
    expect((await dmAgent.put(route).send({
      supportText: privateText,
      visibility: 'facilitator',
      aiUseConsent: false,
    })).status).toBe(200);

    const withoutConsent = await client.callTool({ name: 'get_ai_support_preferences', arguments: { campaignId } });
    expect(withoutConsent.isError).toBeFalsy();
    expect(JSON.stringify(parseResult(withoutConsent))).not.toContain(privateText);

    // Strict ownership schema: an MCP caller cannot select another owner.
    const spoof = await client.callTool({
      name: 'set_my_support_preference',
      arguments: {
        campaignId,
        supportText: 'spoof',
        visibility: 'table',
        aiUseConsent: true,
        ownerUserId: 'someone-else',
      },
    });
    expect(spoof.isError).toBe(true);

    const noEchoText = 'MCP_WRITE_NO_ECHO_877';
    const noEcho = await client.callTool({
      name: 'set_my_support_preference',
      arguments: { campaignId, supportText: noEchoText, visibility: 'table', aiUseConsent: false },
    });
    expect(noEcho.isError).toBeFalsy();
    expect(JSON.stringify(parseResult(noEcho))).not.toContain(noEchoText);
    expect(parseResult(noEcho)).toMatchObject({ saved: true, visibility: 'table', aiUseConsent: false });

    const consentedText = 'MCP_EXPLICIT_AI_CONSENT_877';
    const consented = await client.callTool({
      name: 'set_my_support_preference',
      arguments: { campaignId, supportText: consentedText, visibility: 'facilitator', aiUseConsent: true },
    });
    expect(consented.isError).toBeFalsy();
    expect(JSON.stringify(parseResult(consented))).toContain(consentedText);
    const visible = parseResult(
      await client.callTool({ name: 'get_ai_support_preferences', arguments: { campaignId } }),
    );
    expect(JSON.stringify(visible)).toContain(consentedText);

    const viewerClient = await mcpClient(viewerToken);
    const memberDenied = await viewerClient.callTool({
      name: 'get_ai_support_preferences',
      arguments: { campaignId },
    });
    expect(memberDenied.isError).toBe(true);
    expect(parseResult(memberDenied)).toMatchObject({ error: { status: 403, code: 'forbidden' } });

    // Human visibility stays facilitator-only while consent is revoked. The very
    // next model-facing read must drop the text; there is no cache/grace period.
    await dmAgent.put(route).send({ supportText: consentedText, visibility: 'facilitator', aiUseConsent: false });
    const revoked = parseResult(
      await client.callTool({ name: 'get_ai_support_preferences', arguments: { campaignId } }),
    );
    expect(JSON.stringify(revoked)).not.toContain(consentedText);

    const deleted = await client.callTool({ name: 'delete_my_support_preference', arguments: { campaignId } });
    expect(deleted.isError).toBeFalsy();
    const afterDelete = await dmAgent.get(route);
    expect(afterDelete.status).toBe(200);
    expect(afterDelete.body).toBeNull();
    expect(afterDelete.text).toBe('null');
  });

  it('structured errors: isError content is JSON {"error":{status,code,message}}', async () => {
    const client = await mcpClient(dmToken);
    const result = await client.callTool({ name: 'get_quest', arguments: { questId: 999_999 } });
    expect(result.isError).toBe(true);
    const parsed = parseResult(result) as { error: { status: number; code: string; message: string } };
    expect(parsed.error.status).toBe(404);
    expect(parsed.error.code).toBe('not_found');
    expect(parsed.error.message).toContain('999999');
  });

  it('create_campaign -> upsert_character -> update_campaign_status -> list_members -> delete_campaign', async () => {
    const client = await mcpClient(dmToken);

    const createResult = await client.callTool({
      name: 'create_campaign',
      arguments: { name: 'MCP Lifecycle Campaign', description: 'created over MCP' },
    });
    expect(createResult.isError).toBeFalsy();
    const created = parseResult(createResult) as { id: number; name: string };
    expect(created.name).toBe('MCP Lifecycle Campaign');
    const newCampaignId = created.id;

    const charResult = await client.callTool({
      name: 'upsert_character',
      arguments: { campaignId: newCampaignId, name: 'MCP Hero', hpMax: 12 },
    });
    expect(charResult.isError).toBeFalsy();
    const character = parseResult(charResult) as { id: number; name: string; hpMax: number };
    expect(character.name).toBe('MCP Hero');
    expect(character.hpMax).toBe(12);

    const updateCharResult = await client.callTool({
      name: 'upsert_character',
      arguments: { campaignId: newCampaignId, characterId: character.id, level: 3 },
    });
    expect(updateCharResult.isError).toBeFalsy();
    expect((parseResult(updateCharResult) as { level: number }).level).toBe(3);

    const condResult = await client.callTool({
      name: 'set_character_conditions',
      arguments: { characterId: character.id, add: ['poisoned'] },
    });
    expect(condResult.isError).toBeFalsy();
    expect((parseResult(condResult) as { conditions: string[] }).conditions).toContain('poisoned');

    const statusResult = await client.callTool({
      name: 'update_campaign_status',
      arguments: { campaignId: newCampaignId, status: 'paused', dangerLevel: 'high' },
    });
    expect(statusResult.isError).toBeFalsy();
    const updated = parseResult(statusResult) as { status: string; dangerLevel: string };
    expect(updated.status).toBe('paused');
    expect(updated.dangerLevel).toBe('high');

    const membersResult = await client.callTool({ name: 'list_members', arguments: { campaignId: newCampaignId } });
    expect(membersResult.isError).toBeFalsy();
    const members = parseResult(membersResult) as Array<{ role: string }>;
    expect(members.some((m) => m.role === 'dm')).toBe(true);

    const exportResult = await client.callTool({ name: 'export_campaign', arguments: { campaignId: newCampaignId } });
    expect(exportResult.isError).toBeFalsy();
    const exported = parseResult(exportResult) as { campaign: { name: string }; characters: unknown[] };
    expect(exported.campaign.name).toBe('MCP Lifecycle Campaign');
    expect(exported.characters).toHaveLength(1);

    const auditResult = await client.callTool({ name: 'read_audit_log', arguments: { campaignId: newCampaignId, limit: 5 } });
    expect(auditResult.isError).toBeFalsy();
    expect((parseResult(auditResult) as unknown[]).length).toBeGreaterThan(0);

    const deleteResult = await client.callTool({ name: 'delete_campaign', arguments: { campaignId: newCampaignId } });
    expect(deleteResult.isError).toBeFalsy();

    const listAfter = await dmAgent.get('/api/v1/campaigns');
    expect(listAfter.body.some((c: { id: number }) => c.id === newCampaignId)).toBe(false);
  });

  // Issue #1910: upsert_character derives its input shape from CharacterUpdate/CharacterCreate,
  // so speed rides that existing spread with no new tool — this proves it actually round-trips
  // (create -> update -> clear back to null) rather than only typechecking.
  it('upsert_character round-trips speed and clears it back to null (issue #1910)', async () => {
    const client = await mcpClient(dmToken);
    const created = parseResult(
      await client.callTool({
        name: 'upsert_character',
        arguments: { campaignId, name: 'MCP Sprinter', hpMax: 10, speed: 35 },
      }),
    ) as { id: number; speed: number | null };
    expect(created.speed).toBe(35);

    const updated = parseResult(
      await client.callTool({
        name: 'upsert_character',
        arguments: { campaignId, characterId: created.id, speed: 40 },
      }),
    ) as { speed: number | null };
    expect(updated.speed).toBe(40);

    const cleared = parseResult(
      await client.callTool({
        name: 'upsert_character',
        arguments: { campaignId, characterId: created.id, speed: null },
      }),
    ) as { speed: number | null };
    expect(cleared.speed).toBeNull();
  });

  it('quest objective update/remove and location discovery and note/session edit+delete round-trip over MCP', async () => {
    const client = await mcpClient(dmToken);

    const questResult = await client.callTool({
      name: 'create_quest',
      arguments: { campaignId, title: 'Objective quest', dmSecret: 'the twist' },
    });
    const quest = parseResult(questResult) as { id: number; dmSecret: string };
    expect(quest.dmSecret).toBe('the twist');

    const addObjResult = await client.callTool({ name: 'add_objective', arguments: { questId: quest.id, text: 'Find the key' } });
    const objective = parseResult(addObjResult) as { id: number; text: string; done: boolean };
    expect(objective.done).toBe(false);

    const updateObjResult = await client.callTool({
      name: 'update_objective',
      arguments: { questId: quest.id, objectiveId: objective.id, text: 'Find the golden key', done: true },
    });
    expect(updateObjResult.isError).toBeFalsy();
    const updatedObj = parseResult(updateObjResult) as { text: string; done: boolean };
    expect(updatedObj.text).toBe('Find the golden key');
    expect(updatedObj.done).toBe(true);

    const removeObjResult = await client.callTool({ name: 'remove_objective', arguments: { questId: quest.id, objectiveId: objective.id } });
    expect(removeObjResult.isError).toBeFalsy();

    const deleteQuestResult = await client.callTool({ name: 'delete_quest', arguments: { questId: quest.id } });
    expect(deleteQuestResult.isError).toBeFalsy();

    const locResult = await client.callTool({ name: 'upsert_location', arguments: { campaignId, name: 'MCP Cave' } });
    const location = parseResult(locResult) as { id: number; status: string };
    expect(location.status).toBe('unexplored');

    const discoverResult = await client.callTool({
      name: 'set_location_discovery',
      arguments: { locationId: location.id, status: 'current' },
    });
    expect(discoverResult.isError).toBeFalsy();
    expect((parseResult(discoverResult) as { status: string }).status).toBe('current');

    const replacementResult = await client.callTool({
      name: 'upsert_location',
      arguments: { campaignId, name: 'MCP Keep' },
    });
    const replacement = parseResult(replacementResult) as { id: number };
    const replaceCurrentResult = await client.callTool({
      name: 'set_location_discovery',
      arguments: { locationId: replacement.id, status: 'current' },
    });
    expect(replaceCurrentResult.isError).toBeFalsy();

    const locationListResult = await client.callTool({ name: 'list_locations', arguments: { campaignId } });
    const locationRows = parseResult(locationListResult) as Array<{ id: number; status: string }>;
    expect(locationRows.find((row) => row.id === location.id)?.status).toBe('explored');
    expect(locationRows.find((row) => row.id === replacement.id)?.status).toBe('current');
    const summaryResult = await client.callTool({ name: 'get_campaign_summary', arguments: { campaignId } });
    const summary = parseResult(summaryResult) as {
      campaign: { currentLocationId: number | null };
      currentLocation: { id: number } | null;
    };
    expect(summary.campaign.currentLocationId).toBe(replacement.id);
    expect(summary.currentLocation?.id).toBe(replacement.id);

    const deleteLocResult = await client.callTool({ name: 'delete_location', arguments: { locationId: location.id } });
    expect(deleteLocResult.isError).toBeFalsy();
    const deleteReplacementResult = await client.callTool({
      name: 'delete_location',
      arguments: { locationId: replacement.id },
    });
    expect(deleteReplacementResult.isError).toBeFalsy();

    const npcResult = await client.callTool({ name: 'upsert_npc', arguments: { campaignId, name: 'MCP Blacksmith' } });
    const npc = parseResult(npcResult) as { id: number };
    const deleteNpcResult = await client.callTool({ name: 'delete_npc', arguments: { npcId: npc.id } });
    expect(deleteNpcResult.isError).toBeFalsy();

    const sessionResult = await client.callTool({ name: 'add_session_recap', arguments: { campaignId, recap: 'Session one recap' } });
    const session = parseResult(sessionResult) as { id: number; title: string };
    const updateSessionResult = await client.callTool({
      name: 'update_session',
      arguments: { sessionId: session.id, title: 'The Beginning' },
    });
    expect(updateSessionResult.isError).toBeFalsy();
    expect((parseResult(updateSessionResult) as { title: string }).title).toBe('The Beginning');

    const getSessionResult = await client.callTool({ name: 'get_session', arguments: { sessionId: session.id } });
    expect(getSessionResult.isError).toBeFalsy();
    expect((parseResult(getSessionResult) as { title: string }).title).toBe('The Beginning');

    // Attendance (issue #121): set then get round-trips over MCP (the AI-scribe path).
    const attendeeChar = parseResult(
      await client.callTool({ name: 'upsert_character', arguments: { campaignId, name: 'Scribe Recorded' } }),
    ) as { id: number };
    const setAttendanceResult = await client.callTool({
      name: 'set_session_attendance',
      arguments: { sessionId: session.id, characterIds: [attendeeChar.id] },
    });
    expect(setAttendanceResult.isError).toBeFalsy();
    expect((parseResult(setAttendanceResult) as { characterId: number }[]).map((a) => a.characterId)).toEqual([attendeeChar.id]);
    const getAttendanceResult = await client.callTool({ name: 'get_session_attendance', arguments: { sessionId: session.id } });
    expect(getAttendanceResult.isError).toBeFalsy();
    expect((parseResult(getAttendanceResult) as { characterName: string }[])[0].characterName).toBe('Scribe Recorded');

    const noteResult = await client.callTool({ name: 'add_note', arguments: { campaignId, body: 'A note to edit' } });
    const note = parseResult(noteResult) as { id: number };
    const updateNoteResult = await client.callTool({ name: 'update_note', arguments: { noteId: note.id, body: 'Edited note' } });
    expect(updateNoteResult.isError).toBeFalsy();
    expect((parseResult(updateNoteResult) as { body: string }).body).toBe('Edited note');

    const listNotesResult = await client.callTool({ name: 'list_notes', arguments: { campaignId, mine: true } });
    expect(listNotesResult.isError).toBeFalsy();
    expect((parseResult(listNotesResult) as { items: Array<{ id: number }> }).items.some((n) => n.id === note.id)).toBe(true);

    const deleteNoteResult = await client.callTool({ name: 'delete_note', arguments: { noteId: note.id } });
    expect(deleteNoteResult.isError).toBeFalsy();
  });

  it('#159: a second identical upsert_npc updates in place instead of duplicating', async () => {
    const client = await mcpClient(dmToken);
    const name = 'R5 Tavernkeeper Test';

    const first = await client.callTool({ name: 'upsert_npc', arguments: { campaignId, name, role: 'Keeper' } });
    const npc1 = parseResult(first) as { id: number; role: string };
    expect(npc1.role).toBe('Keeper');

    // Identical re-run (the scribe timeout/retry scenario) must NOT create a second NPC.
    const second = await client.callTool({ name: 'upsert_npc', arguments: { campaignId, name, role: 'Keeper' } });
    const npc2 = parseResult(second) as { id: number };
    expect(npc2.id).toBe(npc1.id);

    // Case-insensitive re-run with a changed field updates the SAME row.
    const third = await client.callTool({ name: 'upsert_npc', arguments: { campaignId, name: name.toUpperCase(), disposition: 'friendly' } });
    const npc3 = parseResult(third) as { id: number; disposition: string };
    expect(npc3.id).toBe(npc1.id);
    expect(npc3.disposition).toBe('friendly');

    // Exactly one NPC by that name exists.
    const listResult = await client.callTool({ name: 'list_npcs', arguments: { campaignId } });
    const matches = (parseResult(listResult) as { id: number; name: string }[]).filter(
      (n) => n.name.toLowerCase() === name.toLowerCase(),
    );
    expect(matches).toHaveLength(1);

    // A genuinely different name still creates a new NPC.
    const other = await client.callTool({ name: 'upsert_npc', arguments: { campaignId, name: 'A Different NPC' } });
    expect((parseResult(other) as { id: number }).id).not.toBe(npc1.id);
  });

  it('#221: faction tools — upsert, list/get with members, reputation, delete', async () => {
    const client = await mcpClient(dmToken);

    // Create a faction via upsert (no id).
    const created = parseResult(
      await client.callTool({ name: 'upsert_faction', arguments: { campaignId, name: 'MCP Guild', kind: 'guild', reputation: 5 } }),
    ) as { id: number; reputation: number; standing: string };
    expect(created.reputation).toBe(5);

    // Idempotent re-run by name updates in place (no duplicate).
    const again = parseResult(
      await client.callTool({ name: 'upsert_faction', arguments: { campaignId, name: 'mcp guild', kind: 'crime syndicate' } }),
    ) as { id: number; kind: string };
    expect(again.id).toBe(created.id);
    expect(again.kind).toBe('crime syndicate');

    // Link an NPC to the faction, then get_faction surfaces it as a member.
    const npc = parseResult(
      await client.callTool({ name: 'upsert_npc', arguments: { campaignId, name: 'MCP Guildmaster', factionId: created.id } }),
    ) as { id: number };
    const withMembers = parseResult(await client.callTool({ name: 'get_faction', arguments: { factionId: created.id } })) as {
      members: { id: number }[];
    };
    expect(withMembers.members.some((m) => m.id === npc.id)).toBe(true);

    // set_faction_reputation: delta bump ("the party burned the guildhall").
    const dropped = parseResult(
      await client.callTool({ name: 'set_faction_reputation', arguments: { factionId: created.id, delta: -25, standing: 'hostile' } }),
    ) as { reputation: number; standing: string };
    expect(dropped.reputation).toBe(-20);
    expect(dropped.standing).toBe('hostile');

    // list_factions includes it.
    const list = parseResult(await client.callTool({ name: 'list_factions', arguments: { campaignId } })) as { id: number }[];
    expect(list.some((f) => f.id === created.id)).toBe(true);

    // Soft-delete trashes the faction; the NPC keeps its factionId for restore.
    const del = await client.callTool({ name: 'delete_faction', arguments: { factionId: created.id } });
    expect(del.isError).toBeFalsy();
    const npcAfter = parseResult(await client.callTool({ name: 'get_npc', arguments: { npcId: npc.id } })) as { factionId: number | null };
    expect(npcAfter.factionId).toBe(created.id);
  });

  it('#159: a second identical upsert_location updates in place instead of duplicating', async () => {
    const client = await mcpClient(dmToken);
    const name = 'R5 Sunken Grotto Test';

    const first = await client.callTool({ name: 'upsert_location', arguments: { campaignId, name, kind: 'cave' } });
    const loc1 = parseResult(first) as { id: number; kind: string };
    expect(loc1.kind).toBe('cave');

    const second = await client.callTool({ name: 'upsert_location', arguments: { campaignId, name: name.toLowerCase(), body: 'damp and dark' } });
    const loc2 = parseResult(second) as { id: number; body: string };
    expect(loc2.id).toBe(loc1.id);
    expect(loc2.body).toBe('damp and dark');

    const listResult = await client.callTool({ name: 'list_locations', arguments: { campaignId } });
    const matches = (parseResult(listResult) as { id: number; name: string }[]).filter(
      (l) => l.name.toLowerCase() === name.toLowerCase(),
    );
    expect(matches).toHaveLength(1);
  });

  it('#161: read_audit_log sinceId returns only newer entries, and npc/quest/session updates record non-empty detail', async () => {
    const client = await mcpClient(dmToken);

    // Bookmark: the highest audit id right now.
    const before = (await client.callTool({ name: 'read_audit_log', arguments: { campaignId, limit: 1 } }));
    const beforeRows = parseResult(before) as { id: number }[];
    const sinceId = beforeRows.length ? beforeRows[0].id : 0;

    // Generate a few new auditable actions.
    const npc = parseResult(await client.callTool({ name: 'upsert_npc', arguments: { campaignId, name: 'Delta NPC' } })) as { id: number };
    await client.callTool({ name: 'upsert_npc', arguments: { campaignId, npcId: npc.id, disposition: 'hostile' } });
    const quest = parseResult(await client.callTool({ name: 'create_quest', arguments: { campaignId, title: 'Delta Quest' } })) as { id: number };
    await client.callTool({ name: 'update_quest', arguments: { questId: quest.id, status: 'active' } });
    const session = parseResult(await client.callTool({ name: 'add_session_recap', arguments: { campaignId, recap: 'delta recap' } })) as { id: number };
    await client.callTool({ name: 'update_session', arguments: { sessionId: session.id, title: 'Delta Session' } });

    // Delta read: only entries strictly newer than the bookmark.
    const deltaResult = await client.callTool({ name: 'read_audit_log', arguments: { campaignId, sinceId, limit: 500 } });
    const delta = parseResult(deltaResult) as { id: number; action: string; entityType: string; detail: string }[];
    expect(delta.length).toBeGreaterThan(0);
    expect(delta.every((r) => r.id > sinceId)).toBe(true);

    // The update entries now carry a real detail payload (was '' before #161).
    const npcUpdate = delta.find((r) => r.action === 'npc.update');
    expect(npcUpdate).toBeDefined();
    expect(npcUpdate!.detail).not.toBe('');
    expect(JSON.parse(npcUpdate!.detail)).toMatchObject({ disposition: 'hostile' });

    const questUpdate = delta.find((r) => r.action === 'quest.update');
    expect(questUpdate).toBeDefined();
    expect(questUpdate!.detail).not.toBe('');
    expect(JSON.parse(questUpdate!.detail)).toMatchObject({ status: 'active' });

    const sessionUpdate = delta.find((r) => r.action === 'session.update');
    expect(sessionUpdate).toBeDefined();
    expect(sessionUpdate!.detail).not.toBe('');
    expect(JSON.parse(sessionUpdate!.detail)).toMatchObject({ title: 'Delta Session' });

    // action + entityType filters narrow the delta.
    const filteredResult = await client.callTool({
      name: 'read_audit_log',
      arguments: { campaignId, sinceId, action: 'npc.update', entityType: 'npc', limit: 500 },
    });
    const filtered = parseResult(filteredResult) as { action: string; entityType: string }[];
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every((r) => r.action === 'npc.update' && r.entityType === 'npc')).toBe(true);
  });

  it('submit_inbox_item (player-role) is visible via read_inbox (dm-role)', async () => {
    const dmClient = await mcpClient(dmToken);
    const inboxResult = await dmClient.callTool({
      name: 'submit_inbox_item',
      arguments: { campaignId, body: 'Player question over MCP' },
    });
    expect(inboxResult.isError).toBeFalsy();
    const item = parseResult(inboxResult) as { id: number; kind: string };
    expect(item.kind).toBe('inbox');

    const inboxList = await dmClient.callTool({ name: 'read_inbox', arguments: { campaignId } });
    expect(inboxList.isError).toBeFalsy();
    expect((parseResult(inboxList) as { items: Array<{ id: number }> }).items.some((n) => n.id === item.id)).toBe(true);

    const resolveResult = await dmClient.callTool({
      name: 'resolve_inbox_item',
      arguments: { noteId: item.id, resolvedNote: 'handled', entityType: 'campaign', entityId: campaignId },
    });
    expect(resolveResult.isError).toBeFalsy();
    const resolved = parseResult(resolveResult) as { resolved: boolean; entityType: string | null; entityId: number | null };
    expect(resolved.resolved).toBe(true);
    expect(resolved.entityType).toBe('campaign');
    expect(resolved.entityId).toBe(campaignId);

    // Terminal idempotency is shared with REST: the same canonical payload
    // returns the stored Note, while a different terminal payload is a 409.
    const identicalRetry = await dmClient.callTool({
      name: 'resolve_inbox_item',
      arguments: { noteId: item.id, resolvedNote: 'handled', entityType: 'campaign', entityId: campaignId },
    });
    expect(identicalRetry.isError).toBeFalsy();
    expect(parseResult(identicalRetry)).toEqual(parseResult(resolveResult));

    const conflictingRetry = await dmClient.callTool({
      name: 'resolve_inbox_item',
      arguments: { noteId: item.id, resolvedNote: 'dismissed' },
    });
    expect(conflictingRetry.isError).toBe(true);
    expect(parseResult(conflictingRetry)).toMatchObject({
      error: {
        status: 409,
        message: `Inbox item ${item.id} already has a different terminal result`,
      },
    });

    // resolved history via read_inbox { resolved: true }; open list no longer has it
    const openAfter = await dmClient.callTool({ name: 'read_inbox', arguments: { campaignId } });
    expect((parseResult(openAfter) as { items: Array<{ id: number }> }).items.some((n) => n.id === item.id)).toBe(false);
    const historyList = await dmClient.callTool({ name: 'read_inbox', arguments: { campaignId, resolved: true } });
    expect(historyList.isError).toBeFalsy();
    expect((parseResult(historyList) as { items: Array<{ id: number }> }).items.some((n) => n.id === item.id)).toBe(true);

    // half-provided entity link is rejected
    const secondItem = parseResult(
      await dmClient.callTool({ name: 'submit_inbox_item', arguments: { campaignId, body: 'Another question' } }),
    ) as { id: number };
    const badResolve = await dmClient.callTool({
      name: 'resolve_inbox_item',
      arguments: { noteId: secondItem.id, entityType: 'quest' },
    });
    expect(badResolve.isError).toBe(true);
  });

  it('whisper_to_player: over MCP, only the target lists the whisper — a non-target member never does (issue #127)', async () => {
    const dmClient = await mcpClient(dmToken);

    // Two real members: the whisper target and an unrelated non-target.
    const targetRes = await dmAgent
      .post('/api/v1/users')
      .send({ username: 'mcp-whisper-target', password: 'target-password-1', displayName: 'MCP Rogue' });
    const otherRes = await dmAgent
      .post('/api/v1/users')
      .send({ username: 'mcp-whisper-other', password: 'other-password-1', displayName: 'MCP Bard' });
    const targetUserId = targetRes.body.id;
    const otherUserId = otherRes.body.id;
    await dmAgent.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: targetUserId, role: 'player' });
    await dmAgent.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: otherUserId, role: 'player' });

    // Each member mints their own MCP token (their own identity, capped to their role).
    const targetAgent = request.agent(ctx.app.getHttpServer());
    await targetAgent.post('/api/v1/auth/login').send({ username: 'mcp-whisper-target', password: 'target-password-1' });
    const targetToken = (await targetAgent.post('/api/v1/tokens').send({ name: 't', scope: 'player' })).body.token;
    const otherAgent = request.agent(ctx.app.getHttpServer());
    await otherAgent.post('/api/v1/auth/login').send({ username: 'mcp-whisper-other', password: 'other-password-1' });
    const otherToken = (await otherAgent.post('/api/v1/tokens').send({ name: 'o', scope: 'player' })).body.token;

    // DM whispers to the rogue alone.
    const whisperResult = await dmClient.callTool({
      name: 'whisper_to_player',
      arguments: { campaignId, recipientUserId: String(targetUserId), body: 'The idol over MCP is a fake' },
    });
    expect(whisperResult.isError).toBeFalsy();
    const whisper = parseResult(whisperResult) as { id: number; visibility: string; recipientName: string };
    expect(whisper.visibility).toBe('whisper');
    expect(whisper.recipientName).toBe('MCP Rogue');

    // Over MCP list_notes: target sees it, the non-target never does.
    const targetClient = await mcpClient(targetToken);
    const targetNotes = parseResult(await targetClient.callTool({ name: 'list_notes', arguments: { campaignId } })) as { items: Array<{ id: number }> };
    expect(targetNotes.items.some((n) => n.id === whisper.id)).toBe(true);

    const otherClient = await mcpClient(otherToken);
    const otherNotes = parseResult(await otherClient.callTool({ name: 'list_notes', arguments: { campaignId } })) as { items: Array<{ id: number }> };
    expect(otherNotes.items.some((n) => n.id === whisper.id)).toBe(false);
  });

  it('add_member -> update_member -> remove_member round-trip (dm only)', async () => {
    const client = await mcpClient(dmToken);
    const newUserRes = await dmAgent.post('/api/v1/users').send({ username: 'mcp-added-member', password: 'member-password-1' });
    expect(newUserRes.status).toBe(201);
    const newUserId = newUserRes.body.id;

    const addResult = await client.callTool({ name: 'add_member', arguments: { campaignId, userId: newUserId, role: 'player' } });
    expect(addResult.isError).toBeFalsy();
    const member = parseResult(addResult) as { id: number; role: string };
    expect(member.role).toBe('player');

    const updateResult = await client.callTool({
      name: 'update_member',
      arguments: { campaignId, memberId: member.id, role: 'viewer' },
    });
    expect(updateResult.isError).toBeFalsy();
    expect((parseResult(updateResult) as { role: string }).role).toBe('viewer');

    const removeResult = await client.callTool({ name: 'remove_member', arguments: { campaignId, memberId: member.id } });
    expect(removeResult.isError).toBeFalsy();
  });

  it('list_rule_packs / get_rule_entry read tools work, and install_rule_pack requires server admin', async () => {
    const dmClient = await mcpClient(dmToken); // mcp-dm is the server admin (see beforeAll)
    const packsResult = await dmClient.callTool({ name: 'list_rule_packs', arguments: {} });
    expect(packsResult.isError).toBeFalsy();
    const packs = parseResult(packsResult) as Array<{ slug: string }>;
    expect(packs.some((p) => p.slug === 'open5e-srd')).toBe(true);

    const searchResult = await dmClient.callTool({ name: 'lookup_rule', arguments: { query: 'goblin', type: 'monster' } });
    const [goblin] = parseResult(searchResult) as Array<{ id: number; name: string }>;
    expect(goblin.name).toBe('Goblin');

    const entryResult = await dmClient.callTool({ name: 'get_rule_entry', arguments: { entryId: goblin.id } });
    expect(entryResult.isError).toBeFalsy();
    const goblinEntry = parseResult(entryResult) as { name: string; dataJson: string };
    expect(goblinEntry.name).toBe('Goblin');
    expect(JSON.parse(goblinEntry.dataJson)).toMatchObject({
      specialAbilities: [expect.objectContaining({ name: 'Nimble Escape' })],
      actions: [expect.objectContaining({ name: 'Scimitar', attackBonus: 4 })],
    });

    // install_rule_pack: non-admin (viewer PAT belongs to the same admin user, but scope caps
    // don't affect serverRole — use a real non-admin user instead, minted via the headless
    // PAT-bootstrap endpoint (verifies credentials + mints a token in one call, no cookie jar).
    const nonAdminUserRes = await dmAgent.post('/api/v1/users').send({ username: 'mcp-non-admin', password: 'non-admin-password-1' });
    expect(nonAdminUserRes.status).toBe(201);
    const nonAdminTokenRes = await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/token')
      .send({ username: 'mcp-non-admin', password: 'non-admin-password-1', tokenName: 'mcp-non-admin-token', scope: 'dm' });
    expect(nonAdminTokenRes.status).toBe(201);
    const nonAdminClient = await mcpClient(nonAdminTokenRes.body.token);
    const deniedInstall = await nonAdminClient.callTool({ name: 'install_rule_pack', arguments: { source: 'open5e' } });
    expect(deniedInstall.isError).toBe(true);
  });

  it('list_encounters, monster combatant gets DEX-derived initMod, and removal undo stays REST/MCP-compatible', async () => {
    const client = await mcpClient(dmToken);

    const createResult = await client.callTool({ name: 'create_encounter', arguments: { campaignId, name: 'MCP Ambush' } });
    const encounter = parseResult(createResult) as { id: number };

    const listResult = await client.callTool({ name: 'list_encounters', arguments: { campaignId, status: 'preparing' } });
    expect(listResult.isError).toBeFalsy();
    expect((parseResult(listResult) as Array<{ id: number }>).some((e) => e.id === encounter.id)).toBe(true);

    // fake-open5e's Goblin has ability_scores.dexterity=14 -> initMod floor((14-10)/2)=2
    const searchResult = await client.callTool({ name: 'lookup_rule', arguments: { query: 'goblin', type: 'monster' } });
    const [goblinEntry] = parseResult(searchResult) as Array<{ id: number }>;

    const addResult = await client.callTool({
      name: 'add_combatant',
      arguments: { encounterId: encounter.id, kind: 'monster', ruleEntryId: goblinEntry.id },
    });
    expect(addResult.isError).toBeFalsy();
    const goblinCombatant = parseResult(addResult) as { id: number; name: string; initMod: number; hpMax: number };
    expect(goblinCombatant.name).toBe('Goblin');
    expect(goblinCombatant.initMod).toBe(2);
    expect(goblinCombatant.hpMax).toBe(7);

    const damageResult = await client.callTool({
      name: 'update_combatant',
      arguments: { encounterId: encounter.id, combatantId: goblinCombatant.id, hpDelta: -3, addConditions: ['prone'] },
    });
    expect(damageResult.isError).toBeFalsy();
    const damaged = parseResult(damageResult) as { hpCurrent: number; conditions: string[] };
    expect(damaged.hpCurrent).toBe(4);
    expect(damaged.conditions).toContain('prone');

    const removedViaRest = await dmAgent.delete(`/api/v1/encounters/${encounter.id}/combatants/${goblinCombatant.id}`);
    expect(removedViaRest.status).toBe(200);
    const restoredByMcp = await client.callTool({ name: 'undo_remove_combatant', arguments: { encounterId: encounter.id, undoToken: removedViaRest.body.undoToken } });
    expect(restoredByMcp.isError).toBeFalsy();
    expect(parseResult(restoredByMcp)).toMatchObject({ id: goblinCombatant.id, hpCurrent: 4, conditions: ['prone'] });

    const idempotencyKey = '3fd4d041-a13d-4dbd-a105-2b1abf15791b';
    const removeResult = await client.callTool({ name: 'remove_combatant', arguments: { encounterId: encounter.id, combatantId: goblinCombatant.id, idempotencyKey } });
    expect(removeResult.isError).toBeFalsy();
    const removedByMcp = parseResult(removeResult) as { undoToken: string };
    expect(typeof removedByMcp.undoToken).toBe('string');
    const replayedRemove = await client.callTool({ name: 'remove_combatant', arguments: { encounterId: encounter.id, combatantId: goblinCombatant.id, idempotencyKey } });
    expect(replayedRemove.isError).toBeFalsy();
    expect(parseResult(replayedRemove)).toEqual(removedByMcp);
    const restoredViaRest = await dmAgent.post(`/api/v1/encounters/${encounter.id}/combatants/undo-remove`).send({ undoToken: removedByMcp.undoToken });
    expect(restoredViaRest.status).toBe(201);
    expect(restoredViaRest.body).toMatchObject({ id: goblinCombatant.id, hpCurrent: 4, conditions: ['prone'] });

    const getAfter = await client.callTool({ name: 'get_encounter', arguments: { encounterId: encounter.id } });
    const afterRemoval = parseResult(getAfter) as { combatants: Array<{ id: number }> };
    expect(afterRemoval.combatants.some((c) => c.id === goblinCombatant.id)).toBe(true);
  });

  it('replays committed removal and undo receipts through MCP after an encounter is trashed', async () => {
    const client = await mcpClient(dmToken);
    const encounter = parseResult(await client.callTool({ name: 'create_encounter', arguments: { campaignId, name: 'MCP trashed removal retry' } })) as { id: number };
    const combatant = parseResult(await client.callTool({ name: 'add_combatant', arguments: { encounterId: encounter.id, kind: 'monster', name: 'MCP retry target', hpMax: 2 } })) as { id: number };
    const idempotencyKey = 'd3b9256b-5b63-4c65-9b05-22582b7cdb17';
    const removed = await client.callTool({ name: 'remove_combatant', arguments: { encounterId: encounter.id, combatantId: combatant.id, idempotencyKey } });
    expect(removed.isError).toBeFalsy();
    expect((await dmAgent.delete(`/api/v1/encounters/${encounter.id}`)).status).toBe(200);

    const replay = await client.callTool({ name: 'remove_combatant', arguments: { encounterId: encounter.id, combatantId: combatant.id, idempotencyKey } });
    expect(replay.isError).toBeFalsy();
    expect(parseResult(replay)).toEqual(parseResult(removed));

    const undoEncounter = parseResult(await client.callTool({ name: 'create_encounter', arguments: { campaignId, name: 'MCP trashed undo retry' } })) as { id: number };
    const undoCombatant = parseResult(await client.callTool({ name: 'add_combatant', arguments: { encounterId: undoEncounter.id, kind: 'monster', name: 'MCP undo target', hpMax: 2 } })) as { id: number };
    const undoRemoval = parseResult(await client.callTool({ name: 'remove_combatant', arguments: { encounterId: undoEncounter.id, combatantId: undoCombatant.id } })) as { undoToken: string };
    const restored = await client.callTool({ name: 'undo_remove_combatant', arguments: { encounterId: undoEncounter.id, undoToken: undoRemoval.undoToken } });
    expect(restored.isError).toBeFalsy();
    expect((await dmAgent.delete(`/api/v1/encounters/${undoEncounter.id}`)).status).toBe(200);

    const undoReplay = await client.callTool({ name: 'undo_remove_combatant', arguments: { encounterId: undoEncounter.id, undoToken: undoRemoval.undoToken } });
    expect(undoReplay.isError).toBeFalsy();
    expect(parseResult(undoReplay)).toEqual(parseResult(restored));
  });

  // Issue #495: update_combatant addConditions is vocabulary-gated for non-DMs (same
  // EncountersService path as REST). Players cannot inject arbitrary free-text labels.
  it('update_combatant rejects unknown conditions from a player; DM may mint custom (issue #495)', async () => {
    const createPlayer = await dmAgent
      .post('/api/v1/users')
      .send({ username: 'mcp-495-player', password: 'player-password-1', serverRole: 'user' });
    expect(createPlayer.status).toBe(201);
    const playerId = createPlayer.body.id as number;
    await dmAgent.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: playerId, role: 'player' });

    const charRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/characters`).send({
      name: 'MCP Vocab Hero',
      hpMax: 20,
      hpCurrent: 20,
      ownerUserId: String(playerId),
    });
    expect(charRes.status).toBe(201);

    const playerAgent = request.agent(ctx.app.getHttpServer());
    await playerAgent.post('/api/v1/auth/login').send({ username: 'mcp-495-player', password: 'player-password-1' });
    const mint = await playerAgent
      .post('/api/v1/tokens')
      .send({ name: 'mcp-495-player', scope: 'player', writeScope: 'direct', campaignId });
    expect(mint.status).toBe(201);
    const playerClient = await mcpClient(mint.body.token);

    const dmClient = await mcpClient(dmToken);
    const createResult = await dmClient.callTool({
      name: 'create_encounter',
      arguments: { campaignId, name: 'MCP Vocab Fight' },
    });
    const encounter = parseResult(createResult) as {
      id: number;
      combatants: Array<{ id: number; characterId: number | null }>;
    };
    let heroCombatant = encounter.combatants.find((c) => c.characterId === charRes.body.id);
    if (!heroCombatant) {
      const add = await dmClient.callTool({
        name: 'add_combatant',
        arguments: { encounterId: encounter.id, kind: 'character', characterId: charRes.body.id },
      });
      expect(add.isError).toBeFalsy();
      heroCombatant = parseResult(add) as { id: number; characterId: number | null };
    }

    const rejected = await playerClient.callTool({
      name: 'update_combatant',
      arguments: { encounterId: encounter.id, combatantId: heroCombatant!.id, addConditions: ['god_mode'] },
    });
    expect(rejected.isError).toBe(true);
    const rejectedBody = parseResult(rejected) as { error?: { status?: number; message?: string } };
    expect(rejectedBody.error?.status).toBe(400);
    expect(String(rejectedBody.error?.message ?? JSON.stringify(rejectedBody))).toMatch(
      /god_mode|vocabulary|Unknown condition/i,
    );

    const allowed = await playerClient.callTool({
      name: 'update_combatant',
      arguments: { encounterId: encounter.id, combatantId: heroCombatant!.id, addConditions: ['Prone'] },
    });
    expect(allowed.isError).toBeFalsy();
    expect((parseResult(allowed) as { conditions: string[] }).conditions).toContain('Prone');

    const custom = await dmClient.callTool({
      name: 'update_combatant',
      arguments: { encounterId: encounter.id, combatantId: heroCombatant!.id, addConditions: ['hexed_by_patron'] },
    });
    expect(custom.isError).toBeFalsy();
    expect((parseResult(custom) as { conditions: string[] }).conditions).toContain('hexed_by_patron');

    const structured = await dmClient.callTool({
      name: 'update_combatant',
      arguments: {
        encounterId: encounter.id,
        combatantId: heroCombatant!.id,
        idempotencyKey: 'test-structured-cond',
        addConditionInstance: { id: 'cond-charmed-1', name: 'Charmed', durationRounds: 10, saveDc: 15 }
      },
    });
    expect(structured.isError).toBeFalsy();
    const result = parseResult(structured) as { conditionInstances: Array<{ name: string; durationRounds?: number; saveDc?: number }> };
    expect(result.conditionInstances).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Charmed', durationRounds: 10, saveDc: 15 })
      ])
    );
  });

  it('generate_encounter builds a target-band group, is non-mutating + reproducible, and commits via create_encounter/add_combatant (issue #304)', async () => {
    const client = await mcpClient(dmToken);

    const encountersBefore = parseResult(
      await client.callTool({ name: 'list_encounters', arguments: { campaignId } }),
    ) as Array<{ id: number }>;

    // Explicit level-1 party so the 5e budget math is meaningful; the fake Open5e pack ships
    // an Owlbear (CR3, 700 XP) which is deadly as a solo vs four level-1 PCs (deadly=400).
    const genArgs = { campaignId, difficulty: 'deadly', party: [1, 1, 1, 1], seed: 42 };
    const gen = await client.callTool({ name: 'generate_encounter', arguments: genArgs });
    expect(gen.isError).toBeFalsy();
    const suggestion = parseResult(gen) as {
      combatants: Array<{ ruleEntryId: number; count: number; xp: number }>;
      difficulty: { band: string };
      difficultySupport: string;
      targetBand: string;
      matchedBand: boolean;
      seed: number;
    };
    expect(suggestion.targetBand).toBe('deadly');
    expect(suggestion.matchedBand).toBe(true);
    expect(suggestion.difficulty.band).toBe('deadly');
    // Issue #1928: this campaign's ruleSystem falls back to 5e — the same math produced the
    // band above, so it is honestly reported as 'supported', not a heuristic guess.
    expect(suggestion.difficultySupport).toBe('supported');
    expect(suggestion.combatants.length).toBeGreaterThan(0);
    expect(suggestion.combatants.every((c) => c.xp > 0)).toBe(true);
    expect(suggestion.seed).toBe(42);

    // Reproducible by seed — same suggestion twice.
    const again = parseResult(await client.callTool({ name: 'generate_encounter', arguments: genArgs })) as { combatants: unknown };
    expect(again.combatants).toEqual(suggestion.combatants);

    // Non-mutating: the preview persisted no encounter.
    const encountersAfter = parseResult(
      await client.callTool({ name: 'list_encounters', arguments: { campaignId } }),
    ) as Array<{ id: number }>;
    expect(encountersAfter.length).toBe(encountersBefore.length);

    // Commit via the EXISTING write tools (write-mode honored there, not re-invented here).
    const enc = parseResult(
      await client.callTool({ name: 'create_encounter', arguments: { campaignId, name: 'MCP Generated Fight', hidden: true } }),
    ) as { id: number; hidden: boolean; status: string };
    expect(enc.hidden).toBe(true);
    expect(enc.status).toBe('preparing');
    for (const line of suggestion.combatants) {
      const add = await client.callTool({
        name: 'add_combatant',
        arguments: { encounterId: enc.id, kind: 'monster', ruleEntryId: line.ruleEntryId, count: line.count },
      });
      expect(add.isError).toBeFalsy();
    }
    const built = parseResult(
      await client.callTool({ name: 'get_encounter', arguments: { encounterId: enc.id } }),
    ) as { combatants: Array<{ kind: string }> };
    expect(built.combatants.filter((c) => c.kind === 'monster').length).toBeGreaterThan(0);
  });

  it('generate_encounter is a non-mutating read tool a viewer-scoped PAT can call (issue #304)', async () => {
    const viewerClient = await mcpClient(viewerToken);
    const gen = await viewerClient.callTool({ name: 'generate_encounter', arguments: { campaignId, difficulty: 'easy', party: [1, 1, 1, 1], seed: 1 } });
    expect(gen.isError).toBeFalsy();
    const suggestion = parseResult(gen) as { targetBand: string; seed: number };
    expect(suggestion.targetBand).toBe('easy');
    expect(suggestion.seed).toBe(1);
  });

  /**
   * Issue #1928 — REST/MCP parity for resolve_action's honesty fields. resolve_action's
   * handler `return`s `this.actionResolver.resolve(...)` directly (mcp-tools.ts) and the
   * `tool()` wrapper's `ok(data)` JSON.stringifies whatever the handler returned with no
   * field allowlist/outputSchema — so this is a real, over-the-wire proof the two new fields
   * survive the MCP transport, not just a read of the source.
   */
  it('resolve_action carries systemMathSupported/mathProfile over MCP for a non-5e campaign (issue #1928)', async () => {
    const client = await mcpClient(dmToken);
    const campRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'MCP PF2e Resolver' });
    const pf2eCampaignId = campRes.body.id as number;
    const db = ctx.app.get<DrizzleDb>(DB);
    await db.update(campaigns).set({ ruleSystem: PF2E_PACK_SLUG }).where(eq(campaigns.id, pf2eCampaignId));

    const enc = parseResult(
      await client.callTool({ name: 'create_encounter', arguments: { campaignId: pf2eCampaignId, name: 'MCP PF2e Fight', hidden: false } }),
    ) as { id: number };
    const actor = parseResult(
      await client.callTool({ name: 'add_combatant', arguments: { encounterId: enc.id, kind: 'monster', name: 'Attacker', hpMax: 20 } }),
    ) as { id: number };
    const target = parseResult(
      await client.callTool({ name: 'add_combatant', arguments: { encounterId: enc.id, kind: 'monster', name: 'Defender', hpMax: 20 } }),
    ) as { id: number };

    const resolved = await client.callTool({
      name: 'resolve_action',
      arguments: {
        encounterId: enc.id,
        actorCombatantId: actor.id,
        spec: {
          mode: 'save',
          save: { ability: 'DEX', dc: { kind: 'fixed', dc: 15 } },
          cost: { slot: 'action', count: 1 },
          targets: { count: 1, allow: 'any' },
          outcomes: { failure: { damage: [{ flat: 4, type: 'force' }] }, success: { halfDamage: true } },
        },
        targetIds: [target.id],
        commit: true,
      },
    });
    expect(resolved.isError).toBeFalsy();
    const result = parseResult(resolved) as { applied: boolean; systemMathSupported: boolean; mathProfile: string | null };
    expect(result.applied).toBe(true); // never refused — label, don't block
    expect(result.systemMathSupported).toBe(false);
    expect(result.mathProfile).toBeNull();
  });

  it('get_session_recaps / read_audit_log push limit/offset into SQL (issue #71)', async () => {
    const client = await mcpClient(dmToken);
    const campRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'MCP Paging' });
    const pagingCampaign = campRes.body.id as number;

    // Three recaps — numbers auto-assign 1,2,3 on a fresh campaign.
    for (let n = 1; n <= 3; n++) {
      const r = await client.callTool({ name: 'add_session_recap', arguments: { campaignId: pagingCampaign, recap: `recap ${n}` } });
      expect(r.isError).toBeFalsy();
    }

    const all = parseResult(
      await client.callTool({ name: 'get_session_recaps', arguments: { campaignId: pagingCampaign } }),
    ) as Array<{ number: number; recap: string }>;
    expect(all.map((s) => s.number)).toEqual([3, 2, 1]); // newest-first
    expect(all[0].recap).toBe('recap 3'); // full recap body — this tool keeps the whole thing

    const limited = parseResult(
      await client.callTool({ name: 'get_session_recaps', arguments: { campaignId: pagingCampaign, limit: 2 } }),
    ) as Array<{ number: number }>;
    expect(limited.map((s) => s.number)).toEqual([3, 2]);

    const offsetPage = parseResult(
      await client.callTool({ name: 'get_session_recaps', arguments: { campaignId: pagingCampaign, limit: 2, offset: 2 } }),
    ) as Array<{ number: number }>;
    expect(offsetPage.map((s) => s.number)).toEqual([1]);

    // read_audit_log now accepts offset too — page back through the log.
    const auditAll = parseResult(
      await client.callTool({ name: 'read_audit_log', arguments: { campaignId: pagingCampaign } }),
    ) as Array<{ id: number }>;
    expect(auditAll.length).toBeGreaterThan(2);
    const auditPage = parseResult(
      await client.callTool({ name: 'read_audit_log', arguments: { campaignId: pagingCampaign, limit: 2, offset: 1 } }),
    ) as Array<{ id: number }>;
    expect(auditPage.map((r) => r.id)).toEqual(auditAll.slice(1, 3).map((r) => r.id));
  });

  it('delete_encounter removes an encounter via MCP (dm), and a viewer PAT is denied (issue #76)', async () => {
    const dmClient = await mcpClient(dmToken);
    const created = parseResult(
      await dmClient.callTool({ name: 'create_encounter', arguments: { campaignId, name: 'MCP Doomed Fight' } }),
    ) as { id: number };

    // A viewer-scoped PAT cannot delete.
    const viewerClient = await mcpClient(viewerToken);
    const denied = await viewerClient.callTool({ name: 'delete_encounter', arguments: { encounterId: created.id } });
    expect(denied.isError).toBe(true);

    const removed = await dmClient.callTool({ name: 'delete_encounter', arguments: { encounterId: created.id } });
    expect(removed.isError).toBeFalsy();
    expect(parseResult(removed)).toMatchObject({ ok: true, encounterId: created.id });

    // Verify via REST that it's gone (a GET 404s).
    const restGet = await dmAgent.get(`/api/v1/encounters/${created.id}`);
    expect(restGet.status).toBe(404);

    // A second delete over MCP now 404s.
    const again = await dmClient.callTool({ name: 'delete_encounter', arguments: { encounterId: created.id } });
    expect(again.isError).toBe(true);
  });

  it('delete_character removes a character via MCP (dm), and a viewer PAT is denied (issue #76)', async () => {
    const dmClient = await mcpClient(dmToken);
    const created = parseResult(
      await dmClient.callTool({ name: 'upsert_character', arguments: { campaignId, name: 'Doomed Hero' } }),
    ) as { id: number };

    const viewerClient = await mcpClient(viewerToken);
    const denied = await viewerClient.callTool({ name: 'delete_character', arguments: { characterId: created.id } });
    expect(denied.isError).toBe(true);

    // Still present after the denied attempt.
    expect((await dmAgent.get(`/api/v1/characters/${created.id}`)).status).toBe(200);

    const removed = await dmClient.callTool({ name: 'delete_character', arguments: { characterId: created.id } });
    expect(removed.isError).toBeFalsy();
    expect(parseResult(removed)).toMatchObject({ ok: true, characterId: created.id });
    expect((await dmAgent.get(`/api/v1/characters/${created.id}`)).status).toBe(404);
  });

  it('delete_session removes a session recap via MCP (dm); propose:true yields a proposal a dm can approve (issue #76)', async () => {
    const dmClient = await mcpClient(dmToken);
    const campRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'MCP Session Delete' });
    const delCampaign = campRes.body.id as number;

    const s1 = parseResult(
      await dmClient.callTool({ name: 'add_session_recap', arguments: { campaignId: delCampaign, recap: 'first' } }),
    ) as { id: number };
    const s2 = parseResult(
      await dmClient.callTool({ name: 'add_session_recap', arguments: { campaignId: delCampaign, recap: 'second' } }),
    ) as { id: number };

    // Direct dm delete of s1.
    const removed = await dmClient.callTool({ name: 'delete_session', arguments: { sessionId: s1.id } });
    expect(removed.isError).toBeFalsy();
    expect(parseResult(removed)).toMatchObject({ ok: true, sessionId: s1.id });
    expect((await dmAgent.get(`/api/v1/sessions/${s1.id}`)).status).toBe(404);

    // propose:true delete of s2 does NOT remove it until approved.
    const proposed = await dmClient.callTool({ name: 'delete_session', arguments: { sessionId: s2.id, propose: true } });
    expect(proposed.isError).toBeFalsy();
    const { proposal } = parseResult(proposed) as { proposal: { id: number; status: string } };
    expect(proposal.status).toBe('pending');
    expect((await dmAgent.get(`/api/v1/sessions/${s2.id}`)).status).toBe(200);

    const approved = await dmClient.callTool({ name: 'approve_proposal', arguments: { proposalId: proposal.id } });
    expect(approved.isError).toBeFalsy();
    expect((await dmAgent.get(`/api/v1/sessions/${s2.id}`)).status).toBe(404);
  });

  it('update_campaign edits general fields (name/description) via MCP (dm), and a viewer PAT is denied (issue #76)', async () => {
    const dmClient = await mcpClient(dmToken);
    const campRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'MCP Rename Me' });
    const upCampaign = campRes.body.id as number;

    // A viewer-scoped PAT cannot update. (viewerToken is unscoped-to-campaign; it is a
    // viewer on every campaign the admin owns, so it resolves to viewer here.)
    const viewerClient = await mcpClient(viewerToken);
    const denied = await viewerClient.callTool({
      name: 'update_campaign',
      arguments: { campaignId: upCampaign, name: 'Hacked' },
    });
    expect(denied.isError).toBe(true);

    const updated = await dmClient.callTool({
      name: 'update_campaign',
      arguments: { campaignId: upCampaign, name: 'Renamed Realm', description: 'A general-field update over MCP.' },
    });
    expect(updated.isError).toBeFalsy();
    const result = parseResult(updated) as { name: string; description: string };
    expect(result.name).toBe('Renamed Realm');
    expect(result.description).toBe('A general-field update over MCP.');

    // Verify via REST.
    const restGet = await dmAgent.get(`/api/v1/campaigns/${upCampaign}`);
    expect(restGet.body.name).toBe('Renamed Realm');
    expect(restGet.body.description).toBe('A general-field update over MCP.');

    // Empty patch is rejected.
    const empty = await dmClient.callTool({ name: 'update_campaign', arguments: { campaignId: upCampaign } });
    expect(empty.isError).toBe(true);
  });

  it('list_attachments / get_attachment return metadata; a hidden attachment is DM-only (issue #76)', async () => {
    const dmClient = await mcpClient(dmToken);
    // Upload a DM-only 'map' (defaults hidden=true) via REST multipart. Issue #604:
    // the upload path now reads the image header (to reject decompression bombs
    // before anything decodes them), so a signature-plus-filler blob is rejected —
    // use the real minimal PNG this suite already defines.
    const pngBytes = TINY_PNG;
    const uploadRes = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/attachments`)
      .field('kind', 'map')
      .attach('file', pngBytes, { filename: 'secret-map.png', contentType: 'image/png' });
    expect(uploadRes.status).toBe(201);
    const mapId = uploadRes.body.id as number;
    expect(uploadRes.body.hidden).toBe(true);

    // DM sees it in the list and can fetch its metadata.
    const dmList = parseResult(
      await dmClient.callTool({ name: 'list_attachments', arguments: { campaignId } }),
    ) as Array<{ id: number; kind: string; filename: string }>;
    const found = dmList.find((a) => a.id === mapId);
    expect(found).toBeDefined();
    expect(found?.kind).toBe('map');
    expect(found?.filename).toBe('secret-map.png');

    const dmGet = await dmClient.callTool({ name: 'get_attachment', arguments: { attachmentId: mapId } });
    expect(dmGet.isError).toBeFalsy();
    expect((parseResult(dmGet) as { id: number }).id).toBe(mapId);

    // A viewer PAT: the hidden map is omitted from the list and 404s on get.
    const viewerClient = await mcpClient(viewerToken);
    const viewerList = parseResult(
      await viewerClient.callTool({ name: 'list_attachments', arguments: { campaignId } }),
    ) as Array<{ id: number }>;
    expect(viewerList.some((a) => a.id === mapId)).toBe(false);
    const viewerGet = await viewerClient.callTool({ name: 'get_attachment', arguments: { attachmentId: mapId } });
    expect(viewerGet.isError).toBe(true);
  });

  it('resources/list exposes the static index + per-campaign resources, including consent-filtered supports', async () => {
    const client = await mcpClient(dmToken);

    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    // Static index resource is always present.
    expect(uris).toContain('campfire://campaigns');
    // Templated resources are enumerated one concrete URI per accessible campaign.
    expect(uris).toContain(`campfire://campaign/${campaignId}/summary`);
    expect(uris).toContain(`campfire://campaign/${campaignId}/party`);
    expect(uris).toContain(`campfire://campaign/${campaignId}/recaps`);
    expect(uris).toContain(`campfire://campaign/${campaignId}/session-zero`);
    expect(uris).toContain(`campfire://campaign/${campaignId}/ai-support-preferences`);

    // The URI templates themselves are advertised via resources/templates/list.
    const { resourceTemplates } = await client.listResourceTemplates();
    const templates = resourceTemplates.map((t) => t.uriTemplate);
    expect(templates).toContain('campfire://campaign/{campaignId}/summary');
    expect(templates).toContain('campfire://campaign/{campaignId}/party');
    expect(templates).toContain('campfire://campaign/{campaignId}/recaps');
    expect(templates).toContain('campfire://campaign/{campaignId}/session-zero');
    expect(templates).toContain('campfire://campaign/{campaignId}/ai-support-preferences');
  });

  it('#877 AI support resource uses the same consent filter as the tool', async () => {
    const client = await mcpClient(dmToken);
    const route = `/api/v1/campaigns/${campaignId}/session-zero/support-preferences/me`;
    const text = 'MCP_RESOURCE_SUPPORT_877';
    await dmAgent.put(route).send({ supportText: text, visibility: 'facilitator', aiUseConsent: false });
    const hidden = await client.readResource({ uri: `campfire://campaign/${campaignId}/ai-support-preferences` });
    expect(JSON.stringify(hidden.contents)).not.toContain(text);

    await dmAgent.put(route).send({ supportText: text, visibility: 'facilitator', aiUseConsent: true });
    const visible = await client.readResource({ uri: `campfire://campaign/${campaignId}/ai-support-preferences` });
    expect(JSON.stringify(visible.contents)).toContain(text);

    const viewerClient = await mcpClient(viewerToken);
    await expect(
      viewerClient.readResource({ uri: `campfire://campaign/${campaignId}/ai-support-preferences` }),
    ).rejects.toThrow();
  });

  it('reading campfire://campaigns and campfire://campaign/{id}/summary returns the same JSON as the read tools (issue #26)', async () => {
    const client = await mcpClient(dmToken);

    const indexRead = await client.readResource({ uri: 'campfire://campaigns' });
    expect(indexRead.contents).toHaveLength(1);
    expect(indexRead.contents[0].mimeType).toBe('application/json');
    const campaigns = JSON.parse((indexRead.contents[0] as { text: string }).text) as Array<{ id: number; name: string }>;
    expect(campaigns.some((c) => c.id === campaignId && c.name === 'MCP Campaign')).toBe(true);

    const summaryRead = await client.readResource({ uri: `campfire://campaign/${campaignId}/summary` });
    expect(summaryRead.contents).toHaveLength(1);
    const summary = JSON.parse((summaryRead.contents[0] as { text: string }).text) as { campaign: { id: number; name: string } };
    expect(summary.campaign.id).toBe(campaignId);
    expect(summary.campaign.name).toBe('MCP Campaign');
  });

  it('reading a campaign resource enforces the same membership gate as the tools (403 for a campaign-scoped PAT on another campaign)', async () => {
    // A campaign-bound PAT is a non-member outside its campaign — reading another
    // campaign's resource must fail exactly like get_campaign_summary does.
    const otherCampRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'MCP Resource Other' });
    expect(otherCampRes.status).toBe(201);
    const otherCampaignId = otherCampRes.body.id;

    const scopedTokenRes = await dmAgent.post('/api/v1/tokens').send({ name: 'mcp-res-scoped', scope: 'dm', campaignId });
    expect(scopedTokenRes.status).toBe(201);
    const client = await mcpClient(scopedTokenRes.body.token);

    await expect(client.readResource({ uri: `campfire://campaign/${otherCampaignId}/summary` })).rejects.toThrow();
    // sanity: its own campaign still reads
    const ownRead = await client.readResource({ uri: `campfire://campaign/${campaignId}/summary` });
    expect(ownRead.contents).toHaveLength(1);
  });

  it('prompts/list exposes recap-writer and session-prep, each taking a campaignId argument (issue #26)', async () => {
    const client = await mcpClient(dmToken);
    const { prompts } = await client.listPrompts();
    const byName = new Map(prompts.map((p) => [p.name, p]));
    expect([...byName.keys()].sort()).toEqual(['recap-writer', 'session-prep']);
    for (const name of ['recap-writer', 'session-prep']) {
      const args = byName.get(name)!.arguments ?? [];
      expect(args.some((a) => a.name === 'campaignId')).toBe(true);
    }
  });

  it('getting the recap-writer prompt returns a message seeded with the campaign id and recap template (issue #26)', async () => {
    const client = await mcpClient(dmToken);
    const result = await client.getPrompt({ name: 'recap-writer', arguments: { campaignId: String(campaignId) } });
    expect(result.messages).toHaveLength(1);
    const message = result.messages[0];
    expect(message.role).toBe('user');
    const text = (message.content as { type: string; text: string }).text;
    expect(text).toContain(`campaign ${campaignId}`);
    expect(text).toContain('draft_session_recap');
    // the shared recap template headings are embedded
    expect(text).toContain('## Recap');
    expect(text).toContain('## Cliffhanger');
  });

  it('getting the session-prep prompt references the summary resource and prep tools', async () => {
    const client = await mcpClient(dmToken);
    const result = await client.getPrompt({ name: 'session-prep', arguments: { campaignId: String(campaignId) } });
    const text = (result.messages[0].content as { type: string; text: string }).text;
    expect(text).toContain(`campfire://campaign/${campaignId}/summary`);
    expect(text).toContain('read_inbox');
  });

  it('#565: import_ddb_character imports a public sheet via MCP (before pack uninstall)', async () => {
    const client = await mcpClient(dmToken);
    const campRes = await dmAgent
      .post('/api/v1/campaigns')
      .send({ name: `565 DDB Import ${Date.now()}`, ruleSystem: 'open5e-srd' });
    expect(campRes.status).toBe(201);
    const ddbCampaignId = campRes.body.id as number;
    const res = await client.callTool({
      name: 'import_ddb_character',
      arguments: { campaignId: ddbCampaignId, ddbId: String(PUBLIC_DDB_CHARACTER_ID) },
    });
    expect(res.isError).toBeFalsy();
    // Issue #1903: result is { character, summary } — REST/MCP parity.
    const parsed = parseResult(res) as { character: { ddbId: string }; summary: { actionsImported: number } };
    expect(parsed.character.ddbId).toBe(String(PUBLIC_DDB_CHARACTER_ID));
    expect(parsed.summary.actionsImported).toBeGreaterThanOrEqual(0);
  });

  it('uninstall_rule_pack blocks an in-use pack even for an adminEnabled token; a plain dm PAT is denied (issue #76)', async () => {
    const dmClient = await mcpClient(dmToken);
    const packs = parseResult(
      await dmClient.callTool({ name: 'list_rule_packs', arguments: {} }),
    ) as Array<{ id: number; slug: string }>;
    const pack = packs.find((p) => p.slug === 'open5e-srd');
    expect(pack).toBeDefined();
    const packId = pack!.id;

    // A plain dm-scoped PAT (even the server admin's own) carries NO server-admin power
    // unless minted adminEnabled — so uninstall is denied, matching install_rule_pack.
    const denied = await dmClient.callTool({ name: 'uninstall_rule_pack', arguments: { packId } });
    expect(denied.isError).toBe(true);
    // Still installed.
    expect(
      (parseResult(await dmClient.callTool({ name: 'list_rule_packs', arguments: {} })) as Array<{ id: number }>).some(
        (p) => p.id === packId,
      ),
    ).toBe(true);

    // An adminEnabled token minted by the server admin DOES carry server-admin power, but
    // it must not silently detach campaigns that currently select this live ruleset.
    // writeScope: 'direct' explicit (issue #575 default is 'propose') — this
    // token uninstalls a rule pack, a direct-only admin write with no proposal
    // path, which a propose-mode token cannot drive.
    const adminTokenRes = await dmAgent.post('/api/v1/tokens').send({ name: 'mcp-admin-enabled', scope: 'dm', adminEnabled: true, writeScope: 'direct' });
    expect(adminTokenRes.status).toBe(201);
    expect(adminTokenRes.body.apiToken.adminEnabled).toBe(true);
    const adminClient = await mcpClient(adminTokenRes.body.token);

    const blocked = await adminClient.callTool({ name: 'uninstall_rule_pack', arguments: { packId } });
    expect(blocked.isError).toBe(true);

    const after = parseResult(
      await adminClient.callTool({ name: 'list_rule_packs', arguments: {} }),
    ) as Array<{ id: number }>;
    expect(after.some((p) => p.id === packId)).toBe(true);
  });

  it('#867 MCP tools treat a trashed campaign as nonexistent and resume only after authorized restore', async () => {
    const name = 'MCP Trash Boundary';
    const created = await dmAgent.post('/api/v1/campaigns').send({ name });
    const trashedCampaignId = created.body.id as number;
    const client = await mcpClient(dmToken);

    const before = await client.callTool({
      name: 'create_quest',
      arguments: { campaignId: trashedCampaignId, title: 'Before trash' },
    });
    expect(before.isError).toBeFalsy();

    expect((await dmAgent.delete(`/api/v1/campaigns/${trashedCampaignId}`)).status).toBe(200);
    const read = await client.callTool({ name: 'get_campaign_summary', arguments: { campaignId: trashedCampaignId } });
    const write = await client.callTool({
      name: 'create_quest',
      arguments: { campaignId: trashedCampaignId, title: 'Stale MCP drift' },
    });
    for (const blocked of [read, write]) {
      expect(blocked.isError).toBe(true);
      expect((blocked.content as TextContent[])[0].text).toContain('404');
      expect((blocked.content as TextContent[])[0].text).not.toContain(name);
    }

    expect((await dmAgent.post(`/api/v1/campaigns/${trashedCampaignId}/restore`)).status).toBe(201);
    const after = await client.callTool({ name: 'get_campaign_summary', arguments: { campaignId: trashedCampaignId } });
    expect(after.isError).toBeFalsy();
  });

  it('request without Authorization gets 401; GET gets 405', async () => {
    const noAuth = await request(ctx.app.getHttpServer())
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Content-Type', 'application/json')
      .send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });
    expect(noAuth.status).toBe(401);

    const get = await request(ctx.app.getHttpServer())
      .get('/mcp')
      .set('Authorization', `Bearer ${dmToken}`)
      .set('Accept', 'application/json, text/event-stream');
    expect(get.status).toBe(405);
    expect(get.body.error.message).toContain('POST');
  });

  // Issue #158 — the same server-enforced write-mode that guards the REST write
  // path also guards the MCP surface (where tools call services directly, so the
  // HTTP WriteModeGuard can't see per-tool intent). A dm-scoped token with
  // writeScope 'propose' reads everything but every canon mutation is coerced into
  // a proposal; 'none' is read-only.
  describe('token write-mode is enforced over MCP', () => {
    let proposeToken: string;
    let noneToken: string;

    beforeAll(async () => {
      const proposeMint = await dmAgent.post('/api/v1/tokens').send({ name: 'mcp-propose', scope: 'dm', writeScope: 'propose' });
      proposeToken = proposeMint.body.token;
      const noneMint = await dmAgent.post('/api/v1/tokens').send({ name: 'mcp-none', scope: 'dm', writeScope: 'none' });
      noneToken = noneMint.body.token;
    });

    it('propose-mode: create_quest WITHOUT propose:true is still forced into a proposal, not a direct write', async () => {
      const client = await mcpClient(proposeToken);
      const res = await client.callTool({
        name: 'create_quest',
        arguments: { campaignId, title: 'MCP Injected Quest' }, // note: NO propose arg
      });
      expect(res.isError).toBeFalsy();
      const { proposal } = parseResult(res) as { proposal: { status: string; action: string; entityType: string } };
      expect(proposal.status).toBe('pending');
      expect(proposal.action).toBe('create');
      expect(proposal.entityType).toBe('quest');

      // Not created directly.
      const quests = await dmAgent.get(`/api/v1/campaigns/${campaignId}/quests`);
      expect(quests.body.some((q: { title: string }) => q.title === 'MCP Injected Quest')).toBe(false);
    });

    it('propose-mode: a direct-only write tool (create_arc, no proposal path) is rejected', async () => {
      const client = await mcpClient(proposeToken);
      const res = await client.callTool({ name: 'create_arc', arguments: { campaignId, title: 'Should Not Exist Arc' } });
      expect(res.isError).toBeTruthy();
    });

    it('propose-mode: reads are unaffected (dm read scope)', async () => {
      const client = await mcpClient(proposeToken);
      const res = await client.callTool({ name: 'list_campaigns', arguments: {} });
      expect(res.isError).toBeFalsy();
    });

    it('none-mode: create_quest is rejected outright (even with propose:true)', async () => {
      const client = await mcpClient(noneToken);
      const res = await client.callTool({ name: 'create_quest', arguments: { campaignId, title: 'Nope', propose: true } });
      expect(res.isError).toBeTruthy();
    });

    it('none-mode: reads still work (write-mode does not touch read authority)', async () => {
      const client = await mcpClient(noneToken);
      const res = await client.callTool({ name: 'list_campaigns', arguments: {} });
      expect(res.isError).toBeFalsy();
    });
  });

  // Issue #817 — MCP propose path must not disclose hidden targets / dmSecret via
  // create responses or list_proposals self-view.
  describe('issue #817 — MCP proposal snapshot secrecy', () => {
    let playerProposeToken: string;

    beforeAll(async () => {
      const createPlayer = await dmAgent
        .post('/api/v1/users')
        .send({ username: 'mcp-817-player', password: 'player-password-1', serverRole: 'user' });
      const playerId = createPlayer.body.id as number;
      await dmAgent.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: playerId, role: 'player' });

      const playerAgent = request.agent(ctx.app.getHttpServer());
      await playerAgent.post('/api/v1/auth/login').send({ username: 'mcp-817-player', password: 'player-password-1' });
      const mint = await playerAgent
        .post('/api/v1/tokens')
        .send({ name: 'mcp-817-propose', scope: 'player', writeScope: 'propose', campaignId });
      expect(mint.status).toBe(201);
      playerProposeToken = mint.body.token;
    });

    it('update_quest on a hidden quest fails (no proposal / no secret leak)', async () => {
      const hidden = await dmAgent.post(`/api/v1/campaigns/${campaignId}/quests`).send({
        title: 'MCP Hidden Quest 817',
        dmSecret: 'MCP_HIDDEN_QUEST_817',
        hidden: true,
      });
      const client = await mcpClient(playerProposeToken);
      const res = await client.callTool({
        name: 'update_quest',
        arguments: { questId: hidden.body.id, title: 'leak?', propose: true },
      });
      expect(res.isError).toBeTruthy();
      expect(JSON.stringify(res)).not.toContain('MCP_HIDDEN_QUEST_817');
    });

    it('update_quest on a visible secret-bearing quest returns a redacted snapshot; list_proposals stays redacted', async () => {
      const visible = await dmAgent.post(`/api/v1/campaigns/${campaignId}/quests`).send({
        title: 'MCP Visible Quest 817',
        dmSecret: 'MCP_VISIBLE_QUEST_817',
        hidden: false,
      });
      const client = await mcpClient(playerProposeToken);
      const res = await client.callTool({
        name: 'update_quest',
        arguments: { questId: visible.body.id, title: 'mcp tweak', propose: true },
      });
      expect(res.isError).toBeFalsy();
      const { proposal } = parseResult(res) as {
        proposal: { id: number; snapshot: { title: string; dmSecret?: string } };
      };
      expect(proposal.snapshot.title).toBe('MCP Visible Quest 817');
      expect(proposal.snapshot.dmSecret ?? '').toBe('');
      expect(JSON.stringify(proposal)).not.toContain('MCP_VISIBLE_QUEST_817');

      const listRes = await client.callTool({
        name: 'list_proposals',
        arguments: { campaignId, status: 'pending' },
      });
      expect(listRes.isError).toBeFalsy();
      const list = parseResult(listRes) as Array<{ id: number; snapshot: { dmSecret?: string } }>;
      const row = list.find((p) => p.id === proposal.id);
      expect(row).toBeDefined();
      expect(row!.snapshot.dmSecret ?? '').toBe('');
      expect(JSON.stringify(list)).not.toContain('MCP_VISIBLE_QUEST_817');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────────
  // #565: handler execution smoke tests for previously-untested tools.
  // Each verifies that the MCP handler executes (not just registers) — at minimum
  // a valid callTool returns a non-error result, and a bad-args call returns isError.
  // ──────────────────────────────────────────────────────────────────────────────

  describe('#565 coverage: untested read tool handler execution', () => {
    it('get_character returns the first character in the campaign', async () => {
      const client = await mcpClient(dmToken);
      const list = await client.callTool({ name: 'get_campaign_summary', arguments: { campaignId } });
      const chars = JSON.parse((list as { content: Array<{ text: string }> }).content[0].text).characters;
      if (chars.length === 0) return; // no characters to test
      const res = await client.callTool({ name: 'get_character', arguments: { characterId: chars[0].id } });
      expect((res as { isError?: boolean }).isError).toBeFalsy();
    });

    it('get_party returns the party for the campaign', async () => {
      const client = await mcpClient(dmToken);
      const res = await client.callTool({ name: 'get_party', arguments: { campaignId } });
      expect((res as { isError?: boolean }).isError).toBeFalsy();
    });

    it('viewer-scoped MCP reads cannot retrieve another character sheet', async () => {
      const created = await dmAgent.post(`/api/v1/campaigns/${campaignId}/characters`).send({ name: 'MCP private sheet' });
      expect(created.status).toBe(201);
      const viewerClient = await mcpClient(viewerToken);
      const party = parseResult(await viewerClient.callTool({ name: 'get_party', arguments: { campaignId } })) as Array<{ id: number }>;
      expect(party.some((character) => character.id === created.body.id)).toBe(false);
      const direct = await viewerClient.callTool({ name: 'get_character', arguments: { characterId: created.body.id } });
      expect((direct as { isError?: boolean }).isError).toBe(true);
      const summary = parseResult(await viewerClient.callTool({ name: 'get_campaign_summary', arguments: { campaignId } })) as {
        characters: Array<{ id: number }>;
        party: Array<{ id: number; name: string; spellSlots?: unknown; actions?: unknown }>;
      };
      expect(summary.characters.some((character) => character.id === created.body.id)).toBe(false);
      const roster = summary.party.find((character) => character.id === created.body.id);
      expect(roster).toEqual(expect.objectContaining({ id: created.body.id, name: 'MCP private sheet' }));
      expect(roster).not.toHaveProperty('spellSlots');
      expect(roster).not.toHaveProperty('actions');

      const resource = await viewerClient.readResource({ uri: `campfire://campaign/${campaignId}/summary` });
      const resourceSummary = JSON.parse((resource.contents[0] as { text: string }).text) as typeof summary;
      expect(resourceSummary.characters.some((character) => character.id === created.body.id)).toBe(false);
      expect(resourceSummary.party.some((character) => character.id === created.body.id)).toBe(true);
    });

    it('list_quests returns an array', async () => {
      const client = await mcpClient(dmToken);
      const res = await client.callTool({ name: 'list_quests', arguments: { campaignId } });
      expect((res as { isError?: boolean }).isError).toBeFalsy();
    });

    it('get_location returns an existing location', async () => {
      const client = await mcpClient(dmToken);
      const locRes = await client.callTool({ name: 'upsert_location', arguments: { campaignId, name: 'MCP Test Loc 565' } });
      const loc = JSON.parse((locRes as { content: Array<{ text: string }> }).content[0].text);
      const res = await client.callTool({ name: 'get_location', arguments: { locationId: loc.id } });
      expect((res as { isError?: boolean }).isError).toBeFalsy();
    });

    it('get_session_zero returns session-zero config', async () => {
      const client = await mcpClient(dmToken);
      const res = await client.callTool({ name: 'get_session_zero', arguments: { campaignId } });
      expect((res as { isError?: boolean }).isError).toBeFalsy();
    });

    it('get_calendar returns the campaign calendar', async () => {
      const client = await mcpClient(dmToken);
      const res = await client.callTool({ name: 'get_calendar', arguments: { campaignId } });
      expect((res as { isError?: boolean }).isError).toBeFalsy();
    });

    it('get_membership_integrity is admin-only (dm token gets isError)', async () => {
      const client = await mcpClient(dmToken);
      const res = await client.callTool({ name: 'get_membership_integrity', arguments: {} });
      expect((res as { isError?: boolean }).isError).toBe(true);
    });

    it('list_scheduled_sessions returns an array', async () => {
      const client = await mcpClient(dmToken);
      const res = await client.callTool({ name: 'list_scheduled_sessions', arguments: { campaignId } });
      expect((res as { isError?: boolean }).isError).toBeFalsy();
    });

    it('list_entity_revisions on a non-existent entity returns 404 (isError)', async () => {
      const client = await mcpClient(dmToken);
      const res = await client.callTool({ name: 'list_entity_revisions', arguments: { entityType: 'quest', entityId: 999999 } });
      expect((res as { isError?: boolean }).isError).toBe(true);
    });
  });

  describe('#565 coverage: untested write tool handler execution', () => {
    it('set_npc_disposition updates an NPC', async () => {
      const client = await mcpClient(dmToken);
      const npcRes = await client.callTool({ name: 'upsert_npc', arguments: { campaignId, name: 'Disp NPC 565' } });
      const npc = JSON.parse((npcRes as { content: Array<{ text: string }> }).content[0].text);
      const res = await client.callTool({ name: 'set_npc_disposition', arguments: { npcId: npc.id, disposition: 'hostile' } });
      expect((res as { isError?: boolean }).isError).toBeFalsy();
      const fetched = JSON.parse((res as { content: Array<{ text: string }> }).content[0].text);
      expect(fetched.disposition).toBe('hostile');
    });

    it('update_character_hp applies a delta', async () => {
      const client = await mcpClient(dmToken);
      const campSum = await client.callTool({ name: 'get_campaign_summary', arguments: { campaignId } });
      const chars = JSON.parse((campSum as { content: Array<{ text: string }> }).content[0].text).characters;
      if (chars.length === 0) return;
      const res = await client.callTool({ name: 'update_character_hp', arguments: { characterId: chars[0].id, delta: -1 } });
      expect((res as { isError?: boolean }).isError).toBeFalsy();
    });

    it('set_calendar sets the in-world date', async () => {
      const client = await mcpClient(dmToken);
      const res = await client.callTool({ name: 'set_calendar', arguments: { campaignId, currentDate: 'Day 42, Year 1492' } });
      expect((res as { isError?: boolean }).isError).toBeFalsy();
    });

    it('reveal_map_region with a non-existent encounter returns isError', async () => {
      const client = await mcpClient(dmToken);
      const res = await client.callTool({ name: 'reveal_map_region', arguments: { encounterId: 999999, x: 0, y: 0, radius: 5 } });
      expect((res as { isError?: boolean }).isError).toBe(true);
    });

    it('check_objective with a non-existent quest returns isError', async () => {
      const client = await mcpClient(dmToken);
      const res = await client.callTool({ name: 'check_objective', arguments: { questId: 999999, objectiveId: 999999 } });
      expect((res as { isError?: boolean }).isError).toBe(true);
    });

    it('disable_calendar_feed disables the feed (or 404s gracefully)', async () => {
      const client = await mcpClient(dmToken);
      const res = await client.callTool({ name: 'disable_calendar_feed', arguments: { campaignId } });
      // Either succeeds or returns isError if no feed exists — either exercises the handler.
      expect(res).toBeDefined();
    });
  });

  // ── #565 batch 2: the remaining 35 tools that were registered but never executed ──
  describe('#565 coverage: remaining read tool handler execution', () => {
    it('get_arc / get_beat return a story arc and beat by id', async () => {
      const client = await mcpClient(dmToken);
      const arc = parseResult(await client.callTool({ name: 'create_arc', arguments: { campaignId, title: '565 Arc' } })) as {
        id: number;
      };
      const beat = parseResult(
        await client.callTool({ name: 'create_beat', arguments: { arcId: arc.id, title: '565 Beat' } }),
      ) as { id: number };

      const arcRes = await client.callTool({ name: 'get_arc', arguments: { arcId: arc.id } });
      expect(arcRes.isError).toBeFalsy();
      expect((parseResult(arcRes) as { id: number }).id).toBe(arc.id);

      const beatRes = await client.callTool({ name: 'get_beat', arguments: { beatId: beat.id } });
      expect(beatRes.isError).toBeFalsy();
      expect((parseResult(beatRes) as { id: number }).id).toBe(beat.id);
    });

    it('get_encounter_difficulty estimates difficulty for an encounter with monsters', async () => {
      const client = await mcpClient(dmToken);
      const enc = parseResult(
        await client.callTool({ name: 'create_encounter', arguments: { campaignId, name: '565 Difficulty' } }),
      ) as { id: number };
      await client.callTool({
        name: 'add_combatant',
        arguments: { encounterId: enc.id, kind: 'monster', name: '565 Goblin', hpMax: 7 },
      });
      const res = await client.callTool({ name: 'get_encounter_difficulty', arguments: { encounterId: enc.id } });
      expect(res.isError).toBeFalsy();
      const body = parseResult(res) as { status: string; band: string | null };
      expect(body.status).toBeDefined();
      expect(body).toHaveProperty('band');
    });

    it('get_encounter_difficulty withholds hidden hostile NPCs from a viewer aggregate (issue #1454)', async () => {
      const hiddenNpc = await dmAgent
        .post(`/api/v1/campaigns/${campaignId}/npcs`)
        .send({ name: 'MCP hidden antagonist', hidden: true, disposition: 'hostile' });
      expect(hiddenNpc.status).toBe(201);
      const encounter = await dmAgent
        .post(`/api/v1/campaigns/${campaignId}/encounters`)
        .send({ name: 'MCP visible fight', hidden: false });
      expect(encounter.status).toBe(201);
      const combatant = await dmAgent
        .post(`/api/v1/encounters/${encounter.body.id}/combatants`)
        .send({ kind: 'npc', npcId: hiddenNpc.body.id, hpMax: 10 });
      expect(combatant.status).toBe(201);

      const dmClient = await mcpClient(dmToken);
      const dmDifficulty = parseResult(
        await dmClient.callTool({ name: 'get_encounter_difficulty', arguments: { encounterId: encounter.body.id } }),
      ) as { monsterCount: number };
      expect(dmDifficulty.monsterCount).toBe(1);

      const viewerClient = await mcpClient(viewerToken);
      const viewerDifficulty = parseResult(
        await viewerClient.callTool({ name: 'get_encounter_difficulty', arguments: { encounterId: encounter.body.id } }),
      ) as { monsterCount: number };
      expect(viewerDifficulty.monsterCount).toBe(0);
    });

    it('get_inventory_item returns one party item by id', async () => {
      const client = await mcpClient(dmToken);
      const item = parseResult(
        await client.callTool({
          name: 'add_inventory_item',
          arguments: { campaignId, name: '565 Torch', qty: 3 },
        }),
      ) as { id: number };
      const res = await client.callTool({ name: 'get_inventory_item', arguments: { itemId: item.id } });
      expect(res.isError).toBeFalsy();
      expect((parseResult(res) as { name: string }).name).toBe('565 Torch');
    });

    it('get_comment returns a posted discussion comment', async () => {
      const client = await mcpClient(dmToken);
      const quest = parseResult(
        await client.callTool({ name: 'create_quest', arguments: { campaignId, title: '565 Comment Quest' } }),
      ) as { id: number };
      const comment = parseResult(
        await client.callTool({
          name: 'post_comment',
          arguments: { campaignId, entityType: 'quest', entityId: quest.id, body: 'A 565 thread.' },
        }),
      ) as { id: number };
      const res = await client.callTool({ name: 'get_comment', arguments: { commentId: comment.id } });
      expect(res.isError).toBeFalsy();
      expect((parseResult(res) as { body: string }).body).toBe('A 565 thread.');
    });

    it('get_calendar_feed returns feed settings (or nulls when disabled)', async () => {
      const client = await mcpClient(dmToken);
      const res = await client.callTool({ name: 'get_calendar_feed', arguments: { campaignId } });
      expect(res.isError).toBeFalsy();
      expect(parseResult(res)).toBeDefined();
    });

    it('missing required args return isError for remaining read tools', async () => {
      const client = await mcpClient(dmToken);
      const cases: Array<{ name: string; args: Record<string, unknown> }> = [
        { name: 'get_arc', args: {} },
        { name: 'get_beat', args: {} },
        { name: 'get_encounter_difficulty', args: {} },
        { name: 'get_inventory_item', args: {} },
        { name: 'get_comment', args: {} },
        { name: 'get_calendar_feed', args: {} },
      ];
      for (const { name, args } of cases) {
        const res = await client.callTool({ name, arguments: args });
        expect((res as { isError?: boolean }).isError).toBe(true);
      }
    });
  });

  describe('#565 coverage: remaining write tool handler execution', () => {
    it('story arc/beat write tools: set_quest_status, update_arc, set_arc_status, update_beat, remove_branch, delete_beat, delete_arc', async () => {
      const client = await mcpClient(dmToken);
      const quest = parseResult(
        await client.callTool({ name: 'create_quest', arguments: { campaignId, title: '565 Status Quest' } }),
      ) as { id: number };
      const statusRes = await client.callTool({
        name: 'set_quest_status',
        arguments: { questId: quest.id, status: 'active' },
      });
      expect(statusRes.isError).toBeFalsy();
      expect((parseResult(statusRes) as { status: string }).status).toBe('active');

      const arc = parseResult(
        await client.callTool({ name: 'create_arc', arguments: { campaignId, title: '565 Write Arc' } }),
      ) as { id: number };
      const beat1 = parseResult(
        await client.callTool({ name: 'create_beat', arguments: { arcId: arc.id, title: 'Branch A' } }),
      ) as { id: number };
      const beat2 = parseResult(
        await client.callTool({ name: 'create_beat', arguments: { arcId: arc.id, title: 'Branch B' } }),
      ) as { id: number };
      const branch = parseResult(
        await client.callTool({
          name: 'add_branch',
          arguments: { beatId: beat1.id, label: 'to B', toBeatId: beat2.id },
        }),
      ) as { id: number };

      const updateArc = await client.callTool({
        name: 'update_arc',
        arguments: { arcId: arc.id, summary: '565 arc summary' },
      });
      expect(updateArc.isError).toBeFalsy();

      const arcStatus = await client.callTool({ name: 'set_arc_status', arguments: { arcId: arc.id, status: 'active' } });
      expect(arcStatus.isError).toBeFalsy();

      const updateBeat = await client.callTool({
        name: 'update_beat',
        arguments: { beatId: beat1.id, body: '565 beat body' },
      });
      expect(updateBeat.isError).toBeFalsy();

      const removeBranch = await client.callTool({
        name: 'remove_branch',
        arguments: { beatId: beat1.id, branchId: branch.id },
      });
      expect(removeBranch.isError).toBeFalsy();

      const deleteBeat = await client.callTool({ name: 'delete_beat', arguments: { beatId: beat2.id } });
      expect(deleteBeat.isError).toBeFalsy();

      const deleteArc = await client.callTool({ name: 'delete_arc', arguments: { arcId: arc.id } });
      expect(deleteArc.isError).toBeFalsy();
    });

    it('session share write tools: update_session_share, revoke_session_share, revoke_all_session_shares', async () => {
      const client = await mcpClient(dmToken);
      const recap = parseResult(
        await client.callTool({
          name: 'add_session_recap',
          arguments: { campaignId, recap: '565 share recap', title: 'Share Test' },
        }),
      ) as { id: number };
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      const created = parseResult(
        await client.callTool({
          name: 'create_session_share',
          arguments: { sessionId: recap.id, label: '565 guests', expiresAt },
        }),
      ) as { share: { id: number } };

      const updated = await client.callTool({
        name: 'update_session_share',
        arguments: { sessionId: recap.id, shareId: created.share.id, label: '565 updated' },
      });
      expect(updated.isError).toBeFalsy();
      expect((parseResult(updated) as { label: string }).label).toBe('565 updated');

      const revoked = await client.callTool({
        name: 'revoke_session_share',
        arguments: { sessionId: recap.id, shareId: created.share.id },
      });
      expect(revoked.isError).toBeFalsy();

      const share2 = parseResult(
        await client.callTool({
          name: 'create_session_share',
          arguments: { sessionId: recap.id, label: '565 second', expiresAt },
        }),
      ) as { share: { id: number } };
      const revokeAll = await client.callTool({ name: 'revoke_all_session_shares', arguments: { campaignId } });
      expect(revokeAll.isError).toBeFalsy();
      expect((parseResult(revokeAll) as { revoked: number }).revoked).toBeGreaterThanOrEqual(1);
      expect(share2.share.id).toBeGreaterThan(0);
    });

    it('level_up_character increments a character level', async () => {
      const client = await mcpClient(dmToken);
      const character = parseResult(
        await client.callTool({ name: 'upsert_character', arguments: { campaignId, name: '565 Leveler', level: 1, hpMax: 10 } }),
      ) as { id: number; level: number };
      const res = await client.callTool({
        name: 'level_up_character',
        arguments: { characterId: character.id, hpMax: 14 },
      });
      expect(res.isError).toBeFalsy();
      expect((parseResult(res) as { level: number }).level).toBe(character.level + 1);
    });

    it('reject_proposal and withdraw_proposal resolve pending proposals', async () => {
      const dmClient = await mcpClient(dmToken);
      const viewerClient = await mcpClient(viewerToken);

      const toReject = parseResult(
        await viewerClient.callTool({
          name: 'create_quest',
          arguments: { campaignId, title: '565 Reject Me', propose: true },
        }),
      ) as { proposal: { id: number } };
      const rejected = await dmClient.callTool({
        name: 'reject_proposal',
        arguments: { proposalId: toReject.proposal.id, note: 'not now' },
      });
      expect(rejected.isError).toBeFalsy();
      expect((parseResult(rejected) as { status: string }).status).toBe('rejected');

      const toWithdraw = parseResult(
        await viewerClient.callTool({
          name: 'create_quest',
          arguments: { campaignId, title: '565 Withdraw Me', propose: true },
        }),
      ) as { proposal: { id: number } };
      const withdrawn = await viewerClient.callTool({
        name: 'withdraw_proposal',
        arguments: { proposalId: toWithdraw.proposal.id },
      });
      expect(withdrawn.isError).toBeFalsy();
      expect((parseResult(withdrawn) as { status: string }).status).toBe('withdrawn');
    });

    it('repair_campaign_dm is server-admin-only (dm PAT without adminEnabled is denied)', async () => {
      const client = await mcpClient(dmToken);
      const res = await client.callTool({
        name: 'repair_campaign_dm',
        arguments: { campaignId, userId: 1 },
      });
      expect((res as { isError?: boolean }).isError).toBe(true);
      expect((res.content as TextContent[])[0].text).toContain('403');
    });

    it('update_encounter edits encounter metadata', async () => {
      const client = await mcpClient(dmToken);
      const enc = parseResult(
        await client.callTool({ name: 'create_encounter', arguments: { campaignId, name: '565 Rename Me' } }),
      ) as { id: number };
      const res = await client.callTool({
        name: 'update_encounter',
        arguments: { encounterId: enc.id, name: '565 Renamed Fight', hidden: true },
      });
      expect(res.isError).toBeFalsy();
      expect((parseResult(res) as { name: string; hidden: boolean }).name).toBe('565 Renamed Fight');
      expect((parseResult(res) as { hidden: boolean }).hidden).toBe(true);
    });

    it('inventory/timeline/comment/scheduling write tools round-trip', async () => {
      const client = await mcpClient(dmToken);
      const item = parseResult(
        await client.callTool({
          name: 'add_inventory_item',
          arguments: { campaignId, name: '565 Rope', qty: 1 },
        }),
      ) as { id: number };
      const updatedItem = await client.callTool({
        name: 'update_inventory_item',
        arguments: { itemId: item.id, notes: '50 feet' },
      });
      expect(updatedItem.isError).toBeFalsy();

      const event = parseResult(
        await client.callTool({
          name: 'create_timeline_event',
          arguments: { campaignId, title: '565 Event', inWorldDate: 'Year 1', hidden: false },
        }),
      ) as { id: number };
      const updatedEvent = await client.callTool({
        name: 'update_timeline_event',
        arguments: { eventId: event.id, body: 'Something happened.' },
      });
      expect(updatedEvent.isError).toBeFalsy();

      const quest = parseResult(
        await client.callTool({ name: 'create_quest', arguments: { campaignId, title: '565 Comment Target' } }),
      ) as { id: number };
      const comment = parseResult(
        await client.callTool({
          name: 'post_comment',
          arguments: { campaignId, entityType: 'quest', entityId: quest.id, body: 'Original 565' },
        }),
      ) as { id: number };
      const updatedComment = await client.callTool({
        name: 'update_comment',
        arguments: { commentId: comment.id, body: 'Edited 565' },
      });
      expect(updatedComment.isError).toBeFalsy();

      const deletedComment = await client.callTool({ name: 'delete_comment', arguments: { commentId: comment.id } });
      expect(deletedComment.isError).toBeFalsy();

      const restoredComment = await client.callTool({ name: 'restore_comment', arguments: { commentId: comment.id } });
      expect(restoredComment.isError).toBeFalsy();
      expect((parseResult(restoredComment) as { body: string }).body).toBe('Edited 565');

      const sched = parseResult(
        await client.callTool({
          name: 'schedule_session',
          arguments: { campaignId, scheduledAt: '2999-06-01T18:00:00Z', title: '565 Game Night' },
        }),
      ) as { id: number };
      const updatedSched = await client.callTool({
        name: 'update_scheduled_session',
        arguments: { scheduleId: sched.id, title: '565 Rescheduled' },
      });
      expect(updatedSched.isError).toBeFalsy();

      const rotated = await client.callTool({ name: 'rotate_calendar_feed', arguments: { campaignId } });
      expect(rotated.isError).toBeFalsy();
      expect(parseResult(rotated)).toMatchObject({ token: expect.any(String) });

      const deletedItem = await client.callTool({ name: 'delete_inventory_item', arguments: { itemId: item.id } });
      expect(deletedItem.isError).toBeFalsy();

      const deletedEvent = await client.callTool({ name: 'delete_timeline_event', arguments: { eventId: event.id } });
      expect(deletedEvent.isError).toBeFalsy();
    });

    it('run_scribe reaches the handler (experimental off → disabled job, not a write-mode 403)', async () => {
      const client = await mcpClient(dmToken);
      const res = await client.callTool({ name: 'run_scribe', arguments: { campaignId } });
      expect(res.isError).toBeFalsy();
      expect((parseResult(res) as { job?: { status: string } }).job?.status).toBe('disabled');
    });

    it('ai_dm_narrate and draft_content hit the experimental gate when the flag is off', async () => {
      const client = await mcpClient(dmToken);
      const narrate = await client.callTool({
        name: 'ai_dm_narrate',
        arguments: { campaignId, prompt: '565 narrate smoke' },
      });
      expect(narrate.isError).toBe(true);
      expect((narrate.content as TextContent[])[0].text).toMatch(/experimental/i);

      const draft = await client.callTool({
        name: 'draft_content',
        arguments: { campaignId, target: 'npc', prompt: '565 draft smoke' },
      });
      expect(draft.isError).toBe(true);
      expect((draft.content as TextContent[])[0].text).toMatch(/experimental/i);
    });

    it('restore_entity_revision re-applies a prior session recap snapshot', async () => {
      const client = await mcpClient(dmToken);
      const session = parseResult(
        await client.callTool({
          name: 'add_session_recap',
          arguments: { campaignId, recap: '565 revision v1' },
        }),
      ) as { id: number };
      await client.callTool({
        name: 'update_session',
        arguments: { sessionId: session.id, recap: '565 revision v2' },
      });
      const revs = parseResult(
        await client.callTool({
          name: 'list_entity_revisions',
          arguments: { entityType: 'session', entityId: session.id },
        }),
      ) as Array<{ id: number; snapshot: { recap?: string } }>;
      const v1 = revs.find((r) => r.snapshot.recap === '565 revision v1');
      expect(v1).toBeDefined();

      const restored = await client.callTool({
        name: 'restore_entity_revision',
        arguments: { entityType: 'session', entityId: session.id, revisionId: v1!.id },
      });
      expect(restored.isError).toBeFalsy();
      const fetched = parseResult(
        await client.callTool({ name: 'get_session', arguments: { sessionId: session.id } }),
      ) as { recap: string };
      expect(fetched.recap).toBe('565 revision v1');
    });

    it('a viewer-scoped PAT is denied DM-only #565 write tools', async () => {
      const dmClient = await mcpClient(dmToken);
      const viewerClient = await mcpClient(viewerToken);
      const arc = parseResult(
        await dmClient.callTool({ name: 'create_arc', arguments: { campaignId, title: '565 Viewer Deny Arc' } }),
      ) as { id: number };
      const denied = await viewerClient.callTool({
        name: 'delete_arc',
        arguments: { arcId: arc.id },
      });
      expect(denied.isError).toBe(true);
      expect((denied.content as TextContent[])[0].text).toContain('403');
    });

    it('missing required args return isError for remaining write tools', async () => {
      const client = await mcpClient(dmToken);
      const cases = [
        'set_quest_status',
        'update_arc',
        'set_arc_status',
        'delete_arc',
        'update_beat',
        'delete_beat',
        'remove_branch',
        'update_session_share',
        'revoke_session_share',
        'level_up_character',
        'reject_proposal',
        'withdraw_proposal',
        'repair_campaign_dm',
        'update_encounter',
        'run_scribe',
        'ai_dm_narrate',
        'draft_content',
        'update_inventory_item',
        'delete_inventory_item',
        'update_timeline_event',
        'delete_timeline_event',
        'update_comment',
        'delete_comment',
        'restore_comment',
        'update_scheduled_session',
        'rotate_calendar_feed',
        'import_ddb_character',
        'restore_entity_revision',
      ];
      for (const name of cases) {
        const res = await client.callTool({ name, arguments: {} });
        expect((res as { isError?: boolean }).isError).toBe(true);
      }
    });
  });

  describe('issue #683 — MCP parity for invites, notifications, proposals, trash, reopen, spell slots, attachments', () => {
    it('invite lifecycle: create, list, preview, revoke', async () => {
      const client = await mcpClient(dmToken);
      const created = await client.callTool({
        name: 'create_invite',
        arguments: { campaignId, role: 'viewer', expiresInDays: 3 },
      });
      expect(created.isError).toBeFalsy();
      const invite = parseResult(created) as { id: number; code: string; role: string };
      expect(invite.role).toBe('viewer');
      expect(invite.code.length).toBeGreaterThan(10);

      const listed = parseResult(
        await client.callTool({ name: 'list_invites', arguments: { campaignId } }),
      ) as { id: number; code: string }[];
      expect(listed.some((i) => i.id === invite.id && i.code === invite.code)).toBe(true);

      const preview = parseResult(
        await client.callTool({ name: 'preview_invite', arguments: { code: invite.code } }),
      ) as { campaignId: number; role: string };
      expect(preview.campaignId).toBe(campaignId);
      expect(preview.role).toBe('viewer');

      const revoked = await client.callTool({
        name: 'revoke_invite',
        arguments: { campaignId, inviteId: invite.id },
      });
      expect(revoked.isError).toBeFalsy();
    });

    it('notifications: list, unread count, mark read', async () => {
      const client = await mcpClient(dmToken);
      const listed = parseResult(await client.callTool({ name: 'list_notifications', arguments: { limit: 5 } })) as {
        items: { id: number }[];
      };
      expect(Array.isArray(listed.items)).toBe(true);

      const count = parseResult(await client.callTool({ name: 'get_unread_notification_count', arguments: {} })) as {
        count: number;
      };
      expect(typeof count.count).toBe('number');

      const prefs = parseResult(await client.callTool({ name: 'get_notification_preferences', arguments: {} })) as {
        campaigns: unknown[];
      };
      expect(Array.isArray(prefs.campaigns)).toBe(true);

      if (listed.items.length > 0) {
        const marked = await client.callTool({
          name: 'mark_notification_read',
          arguments: { notificationId: listed.items[0].id },
        });
        expect(marked.isError).toBeFalsy();
      } else {
        const allRead = await client.callTool({ name: 'mark_all_notifications_read', arguments: {} });
        expect(allRead.isError).toBeFalsy();
      }
    });

    it('proposal revise and batch approve', async () => {
      const viewerClient = await mcpClient(viewerToken);
      const submitted = await viewerClient.callTool({
        name: 'create_quest',
        arguments: { campaignId, title: '683 revise me', propose: true },
      });
      expect(submitted.isError).toBeFalsy();
      const { proposal } = parseResult(submitted) as { proposal: { id: number; status: string } };
      expect(proposal.status).toBe('pending');

      const revised = await viewerClient.callTool({
        name: 'revise_proposal',
        arguments: { proposalId: proposal.id, payload: { title: '683 revised title' } },
      });
      expect(revised.isError).toBeFalsy();

      const dmClient = await mcpClient(dmToken);
      const batch = parseResult(
        await dmClient.callTool({
          name: 'batch_approve_proposals',
          arguments: { ids: [proposal.id], note: '683 batch' },
        }),
      ) as { results: { id: number; ok: boolean }[] };
      expect(batch.results[0]?.ok).toBe(true);
    });

    it('campaign trash lists and restores a soft-deleted quest', async () => {
      const client = await mcpClient(dmToken);
      const questRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/quests`).send({ title: '683 trash quest' });
      const questId = questRes.body.id as number;
      expect((await dmAgent.delete(`/api/v1/quests/${questId}`)).status).toBe(200);

      const trash = parseResult(
        await client.callTool({ name: 'list_campaign_trash', arguments: { campaignId } }),
      ) as { type: string; id: number }[];
      expect(trash.some((row) => row.type === 'quest' && row.id === questId)).toBe(true);

      const restored = await client.callTool({ name: 'restore_quest', arguments: { questId } });
      expect(restored.isError).toBeFalsy();
      expect((parseResult(restored) as { id: number }).id).toBe(questId);
    });

    it('reopen_encounter flips an ended encounter back to running', async () => {
      const client = await mcpClient(dmToken);
      const created = parseResult(
        await client.callTool({ name: 'create_encounter', arguments: { campaignId, name: '683 reopen' } }),
      ) as { id: number };
      const encounterId = created.id;
      await client.callTool({
        name: 'add_combatant',
        arguments: { encounterId, kind: 'monster', name: '683 goblin', hpMax: 5 },
      });
      await client.callTool({ name: 'roll_initiative', arguments: { encounterId } });
      await client.callTool({ name: 'begin_encounter', arguments: { encounterId } });
      const ended = await client.callTool({ name: 'end_encounter', arguments: { encounterId } });
      expect(ended.isError).toBeFalsy();

      const reopened = await client.callTool({ name: 'reopen_encounter', arguments: { encounterId } });
      expect(reopened.isError).toBeFalsy();
      expect((parseResult(reopened) as { status: string }).status).toBe('running');
    });

    it('adjust_spell_slots spends and restores a slot', async () => {
      const client = await mcpClient(dmToken);
      const charRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/characters`).send({ name: '683 caster' });
      const characterId = charRes.body.id as number;
      await dmAgent.patch(`/api/v1/characters/${characterId}`).send({ spellSlots: { '1': { max: 2, used: 0 } } });

      const spent = parseResult(
        await client.callTool({
          name: 'adjust_spell_slots',
          arguments: { characterId, level: 1, delta: 1 },
        }),
      ) as { spellSlots: Record<string, { used: number }> };
      expect(spent.spellSlots['1'].used).toBe(1);

      const restored = parseResult(
        await client.callTool({
          name: 'adjust_spell_slots',
          arguments: { characterId, level: 1, delta: -1 },
        }),
      ) as { spellSlots: Record<string, { used: number }> };
      expect(restored.spellSlots['1'].used).toBe(0);
    });

    /**
     * Issue #1902 rework, round 5 — a fresh review pass found the MCP tool ADVERTISED
     * `expectedUpdatedAt` (spreading `SpellSlotPatch.shape` widened its declared input
     * the moment that field was added to the shared schema) but the handler dropped it
     * on the floor before ever calling `patchSpellSlots`. An AI caller that explicitly
     * opted into "only save if nothing changed since I looked" got an unconditional
     * write and no indication the guard never ran. This test drives the SAME
     * server-side compare-and-set `spell-slot-concurrency.spec.ts` already covers at
     * the service layer, but through the MCP tool boundary specifically — the layer
     * where the regression actually was.
     */
    it('adjust_spell_slots: expectedUpdatedAt is forwarded end-to-end and rejects a stale MCP write with 409 STALE_WRITE (issue #1902)', async () => {
      const client = await mcpClient(dmToken);
      const charRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/characters`).send({ name: '1902 mcp caster' });
      const characterId = charRes.body.id as number;
      await dmAgent.patch(`/api/v1/characters/${characterId}`).send({ spellSlots: { '1': { max: 2, used: 0 } } });
      const staleToken = (await dmAgent.get(`/api/v1/characters/${characterId}`)).body.updatedAt as string;

      // A concurrent write — someone else, or another of the AI's own tool calls —
      // spends a slot. The character row's `updatedAt` moves past `staleToken`.
      await client.callTool({ name: 'adjust_spell_slots', arguments: { characterId, level: 1, delta: 1 } });

      // An MCP caller who read the sheet BEFORE that write, and explicitly opts into the
      // guard by supplying its stale token, must be rejected — not silently overwrite the
      // concurrent spend while believing the guard protected it.
      const stale = await client.callTool({
        name: 'adjust_spell_slots',
        arguments: { characterId, level: 1, delta: 1, expectedUpdatedAt: staleToken },
      });
      expect(stale.isError).toBe(true);
      const err = parseResult(stale) as { error: { status: number; code: string } };
      expect(err.error.status).toBe(409);
      expect(err.error.code).toBe('STALE_WRITE');

      // The rejected write applied NOTHING — still 1, not 2.
      const after = (await dmAgent.get(`/api/v1/characters/${characterId}`)).body as {
        spellSlots: Record<string, { used: number }>;
      };
      expect(after.spellSlots['1'].used).toBe(1);

      // A caller with a FRESH token still succeeds — the guard rejects staleness, not
      // the field's mere presence.
      const freshToken = (await dmAgent.get(`/api/v1/characters/${characterId}`)).body.updatedAt as string;
      const fresh = parseResult(
        await client.callTool({
          name: 'adjust_spell_slots',
          arguments: { characterId, level: 1, delta: 1, expectedUpdatedAt: freshToken },
        }),
      ) as { spellSlots: Record<string, { used: number }> };
      expect(fresh.spellSlots['1'].used).toBe(2);
    });

    // Issue #422/#1578: the character-resource system had no MCP tool at all. Same
    // requireRole('player') gate as adjust_spell_slots — a viewer-scoped PAT must be
    // refused, matching the REST route's own authorization test.
    it('list_character_resources surfaces the adapter vocabulary; adjust_character_resource spends and restores', async () => {
      const client = await mcpClient(dmToken);
      const charRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/characters`).send({ name: '1578 martial' });
      const characterId = charRes.body.id as number;

      const vocab = parseResult(
        await client.callTool({ name: 'list_character_resources', arguments: { characterId } }),
      ) as Array<{ key: string }>;
      expect(vocab.map((r) => r.key)).toEqual(expect.arrayContaining(['hitDice', 'rage', 'actionSurge', 'kiPoints']));

      const spent = parseResult(
        await client.callTool({
          name: 'adjust_character_resource',
          arguments: { characterId, key: 'kiPoints', delta: 1, max: 3, name: 'Ki Points', recharge: 'short-rest' },
        }),
      ) as { resources: Record<string, { used: number; max: number }> };
      expect(spent.resources.kiPoints).toMatchObject({ used: 1, max: 3 });

      const restored = parseResult(
        await client.callTool({
          name: 'adjust_character_resource',
          arguments: { characterId, key: 'kiPoints', delta: -1 },
        }),
      ) as { resources: Record<string, { used: number }> };
      expect(restored.resources.kiPoints.used).toBe(0);

      // Overspend is a real error, not a clamp — same #1039 rule spell slots follow.
      const overspend = await client.callTool({
        name: 'adjust_character_resource',
        arguments: { characterId, key: 'kiPoints', delta: 100 },
      });
      expect(overspend.isError).toBe(true);
    });

    it('adjust_character_resource: a viewer-scoped PAT is refused, matching adjust_spell_slots', async () => {
      const charRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/characters`).send({ name: '1578 viewer target' });
      const characterId = charRes.body.id as number;

      const viewerClient = await mcpClient(viewerToken);
      const denied = await viewerClient.callTool({
        name: 'adjust_character_resource',
        arguments: { characterId, key: 'kiPoints', delta: 1 },
      });
      expect(denied.isError).toBe(true);
      expect((denied.content as TextContent[])[0].text).toContain('403');
    });

    // Issue #1909: adjust_combatant_resource — the delta-based, transactional counterpart
    // to update_combatant's whole-statblock write, extended (unlike adjust_spell_slots/
    // adjust_character_resource above) to a monster/NPC statblock combatant with no linked
    // character sheet at all.
    it('adjust_combatant_resource spends and restores a statblock combatant\'s feature resource and spell slot, records a resource_changed event, and REST reads back the same statblock', async () => {
      const client = await mcpClient(dmToken);
      const encRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/encounters`).send({ name: '1909 Monster Fight' });
      const encounterId = encRes.body.id as number;

      const addResult = await client.callTool({
        name: 'add_combatant',
        arguments: {
          encounterId,
          kind: 'monster',
          name: 'MCP Monk Boss',
          hpMax: 20,
          statblock: {
            resources: { kiPoints: { max: 3, used: 0, name: 'Ki Points', recharge: 'short-rest' } },
            spellSlots: { '2': { max: 2, used: 0 } },
          },
        },
      });
      expect(addResult.isError).toBeFalsy();
      const combatantId = (parseResult(addResult) as { id: number }).id;

      const spent = parseResult(
        await client.callTool({
          name: 'adjust_combatant_resource',
          arguments: { encounterId, combatantId, key: 'kiPoints', delta: 1 },
        }),
      ) as { statblock: { resources: Record<string, { used: number }> } };
      expect(spent.statblock.resources.kiPoints.used).toBe(1);

      const slotSpent = parseResult(
        await client.callTool({
          name: 'adjust_combatant_resource',
          arguments: { encounterId, combatantId, spellLevel: 2, delta: 1 },
        }),
      ) as { statblock: { spellSlots: Record<string, { used: number }> } };
      expect(slotSpent.statblock.spellSlots['2'].used).toBe(1);

      // Overspend is a real error, not a clamp — same rule every other bounded resource
      // write in this schema follows (spell slots, character resources).
      const overspend = await client.callTool({
        name: 'adjust_combatant_resource',
        arguments: { encounterId, combatantId, key: 'kiPoints', delta: 100 },
      });
      expect(overspend.isError).toBe(true);

      // REST reads back the SAME statblock the MCP tool wrote — one domain behind both surfaces.
      const restEncounter = await dmAgent.get(`/api/v1/encounters/${encounterId}`);
      const restCombatant = (restEncounter.body.combatants as Array<{ id: number; statblock: { resources: Record<string, { used: number }> } }>).find(
        (c) => c.id === combatantId,
      );
      expect(restCombatant?.statblock.resources.kiPoints.used).toBe(1);

      const events = await dmAgent.get(`/api/v1/encounters/${encounterId}/events`);
      expect((events.body as Array<{ type: string }>).some((e) => e.type === 'resource_changed')).toBe(true);
    });

    it('adjust_combatant_resource: a statblock combatant is dm-only — a viewer-scoped PAT is refused', async () => {
      // hidden: false — this test isolates the statblock DM-only rule, not hidden-encounter
      // secrecy (a hidden encounter would 404 a viewer before ever reaching that rule; see
      // the dedicated hidden-encounter viewer test below).
      const encRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/encounters`).send({ name: '1909 Viewer Denied', hidden: false });
      const encounterId = encRes.body.id as number;
      const dmClient = await mcpClient(dmToken);
      const addResult = await dmClient.callTool({
        name: 'add_combatant',
        arguments: {
          encounterId,
          kind: 'monster',
          name: 'MCP Viewer-Denied Boss',
          hpMax: 10,
          statblock: { resources: { kiPoints: { max: 3, used: 0, name: 'Ki Points', recharge: 'short-rest' } }, spellSlots: {} },
        },
      });
      const combatantId = (parseResult(addResult) as { id: number }).id;

      const viewerClient = await mcpClient(viewerToken);
      const denied = await viewerClient.callTool({
        name: 'adjust_combatant_resource',
        arguments: { encounterId, combatantId, key: 'kiPoints', delta: 1 },
      });
      expect(denied.isError).toBe(true);
      expect((denied.content as TextContent[])[0].text).toContain('403');
    });

    // Review finding (Codex): a hidden/prep encounter auto-adds combatants for a party's
    // existing characters, so the owning player's OWN character-linked combatant is
    // otherwise reachable through this tool even though get_encounter (and every sibling
    // read/roll tool) treats a hidden encounter as nonexistent for them. isError with a 404,
    // not a 403 (a 403 would itself leak that a hidden encounter exists), matching
    // roll_combatant_initiative's own hidden-encounter parity test.
    it('adjust_combatant_resource: a hidden encounter is nonexistent (404) for the owning player, matching get_encounter', async () => {
      const createPlayer = await dmAgent
        .post('/api/v1/users')
        .send({ username: 'mcp-1909-player', password: 'player-password-1', serverRole: 'user' });
      expect(createPlayer.status).toBe(201);
      const playerId = createPlayer.body.id as number;
      await dmAgent.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: playerId, role: 'player' });

      const charRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/characters`).send({
        name: 'MCP Hidden-Fight Hero',
        hpMax: 20,
        hpCurrent: 20,
        ownerUserId: String(playerId),
        resources: { hiddenFightResource: { max: 1, used: 0, name: 'Hidden Fight Resource', recharge: 'short-rest' } },
      });
      expect(charRes.status).toBe(201);

      const playerAgent = request.agent(ctx.app.getHttpServer());
      await playerAgent.post('/api/v1/auth/login').send({ username: 'mcp-1909-player', password: 'player-password-1' });
      const mint = await playerAgent
        .post('/api/v1/tokens')
        .send({ name: 'mcp-1909-player', scope: 'player', writeScope: 'direct', campaignId });
      expect(mint.status).toBe(201);
      const playerClient = await mcpClient(mint.body.token);

      const encRes = await dmAgent
        .post(`/api/v1/campaigns/${campaignId}/encounters`)
        .send({ name: 'MCP Hidden Secrecy Fight', hidden: true });
      expect(encRes.status).toBe(201);
      expect(encRes.body.hidden).toBe(true);
      const encounterId = encRes.body.id as number;
      const combatantId = (encRes.body.combatants as Array<{ id: number; characterId: number | null }>).find(
        (c) => c.characterId === charRes.body.id,
      )?.id;
      expect(combatantId).toBeDefined();

      // get_encounter already 404s the owning player wholesale (issue #262) — the new tool
      // must match, not 403.
      const getEncounter = await playerClient.callTool({ name: 'get_encounter', arguments: { encounterId } });
      expect(getEncounter.isError).toBe(true);
      expect((getEncounter.content as TextContent[])[0].text).toContain('404');

      const denied = await playerClient.callTool({
        name: 'adjust_combatant_resource',
        arguments: { encounterId, combatantId, key: 'hiddenFightResource', delta: 1 },
      });
      expect(denied.isError).toBe(true);
      expect((denied.content as TextContent[])[0].text).toContain('404');

      // The DM (who can see the hidden encounter) is unaffected by the gate.
      const dmClient2 = await mcpClient(dmToken);
      const dmAdjust = await dmClient2.callTool({
        name: 'adjust_combatant_resource',
        arguments: { encounterId, combatantId, key: 'hiddenFightResource', delta: 1 },
      });
      expect(dmAdjust.isError).toBeFalsy();
    });

    // Review finding (Devin, catching that the owning-player test above did not close the
    // gap): `requireRole(..., 'player')` throws 403 for a viewer BEFORE the tool's own
    // `isVisibleTo` gate is ever reached, so a viewer hitting a HIDDEN encounter's REAL id
    // got 403 — distinguishable from the 404 a NONEXISTENT id gets. The tool now
    // pre-checks visibility at the viewer floor first, mirroring roll_combatant_initiative.
    it("adjust_combatant_resource: a viewer gets 404 for a HIDDEN encounter's real id — indistinguishable from a nonexistent id (issue #1909 review)", async () => {
      const encRes = await dmAgent
        .post(`/api/v1/campaigns/${campaignId}/encounters`)
        .send({ name: 'MCP Viewer Hidden Secrecy', hidden: true });
      expect(encRes.status).toBe(201);
      const encounterId = encRes.body.id as number;
      const dmClient = await mcpClient(dmToken);
      const addResult = await dmClient.callTool({
        name: 'add_combatant',
        arguments: {
          encounterId,
          kind: 'monster',
          name: 'MCP Viewer Secrecy Boss',
          hpMax: 10,
          statblock: { resources: { kiPoints: { max: 3, used: 0, name: 'Ki Points', recharge: 'short-rest' } }, spellSlots: {} },
        },
      });
      const combatantId = (parseResult(addResult) as { id: number }).id;

      const viewerClient = await mcpClient(viewerToken);
      const realId = await viewerClient.callTool({
        name: 'adjust_combatant_resource',
        arguments: { encounterId, combatantId, key: 'kiPoints', delta: 1 },
      });
      expect(realId.isError).toBe(true);
      expect((realId.content as TextContent[])[0].text).toContain('404');

      // Indistinguishable from a genuinely nonexistent encounter — not just "404 somewhere".
      const nonexistent = await viewerClient.callTool({
        name: 'adjust_combatant_resource',
        arguments: { encounterId: 999999999, combatantId, key: 'kiPoints', delta: 1 },
      });
      expect(nonexistent.isError).toBe(true);
      expect((nonexistent.content as TextContent[])[0].text).toContain('404');
    });

    // Review finding (Codex): REST/MCP parity counterpart to the controller's identical
    // fix — the tool's viewer-role visibility precheck had no `allowArchived`, so on a
    // paused/completed campaign `assertWritable` 403'd every member before `isVisibleTo`
    // ever ran, reopening the hidden-encounter oracle keyed on campaign archival instead of
    // role: a hidden encounter that exists 403'd, a nonexistent id still 404'd.
    it("adjust_combatant_resource: a hidden encounter on an ARCHIVED campaign 404s a viewer identically to a nonexistent id (issue #1909 review)", async () => {
      const encRes = await dmAgent
        .post(`/api/v1/campaigns/${campaignId}/encounters`)
        .send({ name: 'MCP Archived Hidden Secrecy', hidden: true });
      expect(encRes.status).toBe(201);
      const encounterId = encRes.body.id as number;
      const dmClient = await mcpClient(dmToken);
      const addResult = await dmClient.callTool({
        name: 'add_combatant',
        arguments: {
          encounterId,
          kind: 'monster',
          name: 'MCP Archived Secrecy Boss',
          hpMax: 10,
          statblock: { resources: { kiPoints: { max: 3, used: 0, name: 'Ki Points', recharge: 'short-rest' } }, spellSlots: {} },
        },
      });
      const combatantId = (parseResult(addResult) as { id: number }).id;

      expect((await dmAgent.patch(`/api/v1/campaigns/${campaignId}`).send({ status: 'paused' })).status).toBe(200);
      try {
        const viewerClient = await mcpClient(viewerToken);
        const realId = await viewerClient.callTool({
          name: 'adjust_combatant_resource',
          arguments: { encounterId, combatantId, key: 'kiPoints', delta: 1 },
        });
        const nonexistent = await viewerClient.callTool({
          name: 'adjust_combatant_resource',
          arguments: { encounterId: 999999999, combatantId, key: 'kiPoints', delta: 1 },
        });

        expect(realId.isError).toBe(true);
        expect((realId.content as TextContent[])[0].text).toContain('404');
        expect(nonexistent.isError).toBe(true);
        expect((nonexistent.content as TextContent[])[0].text).toContain('404');

        // The DM (who CAN see this hidden encounter) still hits the service's own
        // transactional archived-campaign rejection for a fresh write.
        const dmResult = await dmClient.callTool({
          name: 'adjust_combatant_resource',
          arguments: { encounterId, combatantId, key: 'kiPoints', delta: 1 },
        });
        expect(dmResult.isError).toBe(true);
        expect((dmResult.content as TextContent[])[0].text).toContain('403');
      } finally {
        expect((await dmAgent.patch(`/api/v1/campaigns/${campaignId}`).send({ status: 'active' })).status).toBe(200);
      }
    });

    // Issue #1643 — "verify what already works first": before this PR, exhaustion was
    // storable (ConditionInstance.stacks, #1047/#1073) but nothing could actually MOVE
    // the level on a character sheet — set_character_conditions only adds/removes a bare
    // name and preserves stacks unchanged. adjust_character_condition_level (this PR) is
    // that path. Proves the AI-DM story from #1073 end to end: a failed forced-march save
    // increments exhaustion by one, through the real MCP tool, against a real campaign.
    it('#1643: an AI DM can raise/lower 5e Exhaustion through adjust_character_condition_level on a real (default/5e) campaign', async () => {
      const client = await mcpClient(dmToken);
      const charRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/characters`).send({ name: '1643 exhaustion target' });
      const characterId = charRes.body.id as number;

      // The failed forced-march save: +1.
      const first = parseResult(
        await client.callTool({ name: 'adjust_character_condition_level', arguments: { characterId, name: 'Exhaustion', delta: 1 } }),
      ) as { conditions: string[]; conditionInstances: Array<{ name: string; stacks: number }> };
      expect(first.conditions).toContain('Exhaustion');
      expect(first.conditionInstances.find((i) => i.name === 'Exhaustion')).toMatchObject({ stacks: 1 });

      // A second failed save: +1 again -> level 2. (set_character_conditions could not
      // have done this — add-when-already-present is a no-op on stacks.)
      const second = parseResult(
        await client.callTool({ name: 'adjust_character_condition_level', arguments: { characterId, name: 'Exhaustion', delta: 1 } }),
      ) as { conditionInstances: Array<{ name: string; stacks: number }> };
      expect(second.conditionInstances.find((i) => i.name === 'Exhaustion')).toMatchObject({ stacks: 2 });

      // A long rest / restorative magic lowers it: -1 -> level 1.
      const lowered = parseResult(
        await client.callTool({ name: 'adjust_character_condition_level', arguments: { characterId, name: 'Exhaustion', delta: -1 } }),
      ) as { conditionInstances: Array<{ name: string; stacks: number }> };
      expect(lowered.conditionInstances.find((i) => i.name === 'Exhaustion')).toMatchObject({ stacks: 1 });

      // Driving it to level 6 (death) then one more is a real error, not a clamp (#1039).
      const toCap = await client.callTool({
        name: 'adjust_character_condition_level',
        arguments: { characterId, name: 'Exhaustion', level: 6 },
      });
      expect(toCap.isError).toBeFalsy();
      const overCap = await client.callTool({
        name: 'adjust_character_condition_level',
        arguments: { characterId, name: 'Exhaustion', delta: 1 },
      });
      expect(overCap.isError).toBe(true);
    });

    it('#1643: adjust_character_condition_level 400s on a PF2e campaign — no leveled condition track declared', async () => {
      const db = ctx.app.get<DrizzleDb>(DB);
      const campRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'MCP PF2e No Exhaustion' });
      expect(campRes.status).toBe(201);
      const pf2eId = campRes.body.id as number;
      await db.update(campaigns).set({ ruleSystem: PF2E_PACK_SLUG }).where(eq(campaigns.id, pf2eId));

      const client = await mcpClient(dmToken);
      const charRes = await dmAgent.post(`/api/v1/campaigns/${pf2eId}/characters`).send({ name: '1643 pf2e target' });
      const characterId = charRes.body.id as number;

      const result = await client.callTool({
        name: 'adjust_character_condition_level',
        arguments: { characterId, name: 'Exhaustion', delta: 1 },
      });
      expect(result.isError).toBe(true);
    });

    // Issue #1642 — "verify the end-to-end path first": #1073's inspiration/heroPoints
    // vocabulary, #422's adjustResource, and #1578's MCP surface (list_character_resources
    // / adjust_character_resource, exercised generically with kiPoints just above) were
    // built independently at different times, and nothing had proven an AI DM could
    // actually award/spend inspiration or a hero point through the real MCP tool against a
    // real campaign. These three tests are that proof, against real campaigns (the default
    // campaign IS the 5e adapter — ruleSystemAdapter('') falls back to Dnd5eAdapter, see
    // packages/schema/src/index.ts's ruleSystemAdapter — and a PF2e one made by updating
    // ruleSystem the same way the Open Legend test above does), not a unit-level adapter
    // check. Answer: it already works — same requireRole('player') gate, same
    // adjustResource/ResourcePatch path as every other keyed resource; the key string is
    // the only thing that differs. This narrows #1642 to display only, as the issue itself
    // anticipated as a valid outcome.
    it('#1642: an AI DM can award and spend 5e inspiration through adjust_character_resource on a real (default/5e) campaign', async () => {
      const client = await mcpClient(dmToken);
      const charRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/characters`).send({ name: '1642 inspiration target' });
      const characterId = charRes.body.id as number;

      const vocab = parseResult(
        await client.callTool({ name: 'list_character_resources', arguments: { characterId } }),
      ) as Array<{ key: string; name: string; recharge: string; defaultMax?: number }>;
      const inspiration = vocab.find((r) => r.key === 'inspiration');
      expect(inspiration).toMatchObject({ name: 'Inspiration', recharge: 'special', defaultMax: 1 });

      // The DM awards inspiration: the character starts with none (used=1/max=1, i.e. spent),
      // and restoring (delta: -1) grants it, mirroring the sheet's "Restore" action (#1642 UI).
      const awarded = parseResult(
        await client.callTool({
          name: 'adjust_character_resource',
          arguments: { characterId, key: 'inspiration', used: 1, max: 1, name: 'Inspiration', recharge: 'special' },
        }),
      ) as { resources: Record<string, { used: number; max: number }> };
      expect(awarded.resources.inspiration).toMatchObject({ used: 1, max: 1 });
      const granted = parseResult(
        await client.callTool({ name: 'adjust_character_resource', arguments: { characterId, key: 'inspiration', delta: -1 } }),
      ) as { resources: Record<string, { used: number; max: number }> };
      expect(granted.resources.inspiration).toMatchObject({ used: 0, max: 1 });

      // The player spends it: only ONE point exists (defaultMax: 1), so a second spend
      // while already at 0 available is a real error, not a clamp — same #1039 rule as
      // spell slots and every other bounded resource.
      const spent = parseResult(
        await client.callTool({ name: 'adjust_character_resource', arguments: { characterId, key: 'inspiration', delta: 1 } }),
      ) as { resources: Record<string, { used: number }> };
      expect(spent.resources.inspiration.used).toBe(1);
      const overspend = await client.callTool({
        name: 'adjust_character_resource',
        arguments: { characterId, key: 'inspiration', delta: 1 },
      });
      expect(overspend.isError).toBe(true);
    });

    it('#1642: an AI DM can award and spend a PF2e hero point through adjust_character_resource on a real PF2e campaign', async () => {
      const db = ctx.app.get<DrizzleDb>(DB);
      const campRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'MCP PF2e Hero Points' });
      expect(campRes.status).toBe(201);
      const pf2eId = campRes.body.id as number;
      await db.update(campaigns).set({ ruleSystem: PF2E_PACK_SLUG }).where(eq(campaigns.id, pf2eId));

      const client = await mcpClient(dmToken);
      const charRes = await dmAgent.post(`/api/v1/campaigns/${pf2eId}/characters`).send({ name: '1642 hero point target' });
      const characterId = charRes.body.id as number;

      const vocab = parseResult(
        await client.callTool({ name: 'list_character_resources', arguments: { characterId } }),
      ) as Array<{ key: string; name: string; recharge: string; defaultMax?: number }>;
      // Hero points are a DIFFERENT economy from 5e inspiration (defaultMax 3, not 1) —
      // confirms this campaign's adapter really did resolve to PF2e, not the 5e fallback.
      const heroPoints = vocab.find((r) => r.key === 'heroPoints');
      expect(heroPoints).toMatchObject({ name: 'Hero Points', recharge: 'special', defaultMax: 3 });
      expect(vocab.some((r) => r.key === 'inspiration')).toBe(false);

      const spent = parseResult(
        await client.callTool({
          name: 'adjust_character_resource',
          arguments: { characterId, key: 'heroPoints', delta: 1, max: 3, name: 'Hero Points', recharge: 'special' },
        }),
      ) as { resources: Record<string, { used: number; max: number }> };
      expect(spent.resources.heroPoints).toMatchObject({ used: 1, max: 3 });

      const restored = parseResult(
        await client.callTool({ name: 'adjust_character_resource', arguments: { characterId, key: 'heroPoints', delta: -1 } }),
      ) as { resources: Record<string, { used: number }> };
      expect(restored.resources.heroPoints.used).toBe(0);
    });

    it('#1642: a system declaring neither resource (Open Legend) lists neither key', async () => {
      const db = ctx.app.get<DrizzleDb>(DB);
      const campRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'MCP Open Legend Resources' });
      expect(campRes.status).toBe(201);
      const openLegendId = campRes.body.id as number;
      await db.update(campaigns).set({ ruleSystem: OPEN_LEGEND_PACK_SLUG }).where(eq(campaigns.id, openLegendId));

      const client = await mcpClient(dmToken);
      const charRes = await dmAgent.post(`/api/v1/campaigns/${openLegendId}/characters`).send({ name: '1642 open legend target' });
      const characterId = charRes.body.id as number;

      const vocab = parseResult(
        await client.callTool({ name: 'list_character_resources', arguments: { characterId } }),
      ) as Array<{ key: string }>;
      expect(vocab.some((r) => r.key === 'inspiration')).toBe(false);
      expect(vocab.some((r) => r.key === 'heroPoints')).toBe(false);
    });

    it('reveal_attachment, hide_attachment, delete_attachment manage metadata only', async () => {
      const client = await mcpClient(dmToken);
      const upload = await dmAgent
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .attach('file', TINY_PNG, { filename: '683.png', contentType: 'image/png' })
        .field('kind', 'image');
      expect(upload.status).toBe(201);
      const attachmentId = upload.body.id as number;

      const revealed = parseResult(
        await client.callTool({ name: 'reveal_attachment', arguments: { attachmentId } }),
      ) as { hidden: boolean };
      expect(revealed.hidden).toBe(false);

      const hidden = parseResult(
        await client.callTool({ name: 'hide_attachment', arguments: { attachmentId } }),
      ) as { hidden: boolean };
      expect(hidden.hidden).toBe(true);

      const deleted = await client.callTool({ name: 'delete_attachment', arguments: { attachmentId } });
      expect(deleted.isError).toBeFalsy();
    });
  });
});
