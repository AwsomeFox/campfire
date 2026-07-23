import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';
import { startFakeOpen5e, type FakeOpen5e } from './fake-open5e';

interface TextContent {
  type: 'text';
  text: string;
}

function parseResult(result: unknown): unknown {
  const content = (result as { content: TextContent[] }).content;
  return JSON.parse(content[0].text);
}

const ALL_TOOLS = [
  // read
  'list_campaigns',
  'get_campaign_summary',
  'get_session_zero',
  'get_ai_support_preferences',
  'get_quest',
  'list_quests',
  'list_arcs',
  'get_arc',
  'get_beat',
  'get_npc',
  'list_npcs',
  'get_faction',
  'list_factions',
  'get_location',
  'list_locations',
  'get_character',
  'get_party',
  'get_session_recaps',
  'get_session',
  'list_session_shares',
  'get_session_attendance',
  'set_session_attendance',
  'draft_session_recap',
  'run_scribe',
  'read_inbox',
  'list_proposals',
  'lookup_rule',
  'list_rule_packs',
  'get_rule_entry',
  'get_encounter',
  'get_encounter_difficulty',
  'generate_encounter',
  'list_encounters',
  'list_members',
  'get_membership_integrity',
  'list_notes',
  'read_audit_log',
  'export_campaign',
  'get_ai_dm_seat',
  'list_attachments',
  'get_attachment',
  // read — inventory/timeline/comments/scheduling (issue #257)
  'list_inventory',
  'get_inventory_item',
  'get_treasury',
  'list_timeline',
  'get_timeline_event',
  'get_calendar',
  'list_comments',
  'get_comment',
  'list_scheduled_sessions',
  'get_next_session',
  'get_calendar_feed',
  // write
  'set_my_support_preference',
  'delete_my_support_preference',
  'create_campaign',
  'delete_campaign',
  'create_quest',
  'update_quest',
  'delete_quest',
  'set_quest_status',
  'add_objective',
  'update_objective',
  'check_objective',
  'remove_objective',
  'create_arc',
  'update_arc',
  'set_arc_status',
  'delete_arc',
  'create_beat',
  'update_beat',
  'set_beat_status',
  'delete_beat',
  'add_branch',
  'remove_branch',
  'upsert_npc',
  'delete_npc',
  'upsert_faction',
  'set_faction_reputation',
  'delete_faction',
  'upsert_location',
  'delete_location',
  'set_location_discovery',
  'add_session_recap',
  'update_session',
  'delete_session',
  'create_session_share',
  'update_session_share',
  'revoke_session_share',
  'revoke_all_session_shares',
  'set_recap_share_policy',
  'upsert_character',
  'delete_character',
  'update_character_hp',
  'award_xp',
  'level_up_character',
  'set_character_conditions',
  'add_note',
  'whisper_to_player',
  'update_note',
  'delete_note',
  'submit_inbox_item',
  'resolve_inbox_item',
  'update_campaign_status',
  'update_campaign',
  'approve_proposal',
  'reject_proposal',
  'withdraw_proposal',
  'add_member',
  'update_member',
  'remove_member',
  'repair_campaign_dm',
  'install_rule_pack',
  'uninstall_rule_pack',
  'roll_dice',
  'create_encounter',
  'update_encounter',
  'reveal_map_region',
  'generate_map',
  'add_combatant',
  'update_combatant',
  'remove_combatant',
  'roll_initiative',
  'begin_encounter',
  'next_turn',
  'end_encounter',
  'delete_encounter',
  'ai_dm_narrate',
  'draft_content',
  // write — inventory/timeline/comments/scheduling (issue #257)
  'add_inventory_item',
  'update_inventory_item',
  'delete_inventory_item',
  'adjust_treasury',
  'create_timeline_event',
  'update_timeline_event',
  'delete_timeline_event',
  'set_calendar',
  'post_comment',
  'update_comment',
  'delete_comment',
  'restore_comment',
  'schedule_session',
  'update_scheduled_session',
  'cancel_scheduled_session',
  'set_rsvp',
  'rotate_calendar_feed',
  'disable_calendar_feed',
];

describe('mcp endpoint (e2e, real sessions + PATs)', () => {
  let ctx: TestAppContext;
  let baseUrl: string;
  let dmAgent: ReturnType<typeof request.agent>;
  let campaignId: number;
  let dmToken: string;
  let viewerToken: string;
  let fakeOpen5e: FakeOpen5e;
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
    await closeTestApp(ctx);
  });

  it('tools/list returns the full catalog', async () => {
    const client = await mcpClient(dmToken);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...ALL_TOOLS].sort());

    expect(tools).toHaveLength(146);

    // Strict schemas must still be ADVERTISED even though per-call validation happens
    // in our handler (so failures return the documented {"error"} JSON): every tool
    // with args advertises additionalProperties:false in tools/list.
    const updateCombatant = tools.find((t) => t.name === 'update_combatant');
    expect(updateCombatant?.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
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
    const quest = parseResult(result) as { id: number; title: string };
    expect(quest.title).toBe('MCP-created quest');

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

  it('viewer-scoped PAT: create_quest is a 403-equivalent isError, but add_note works', async () => {
    const client = await mcpClient(viewerToken);

    const denied = await client.callTool({
      name: 'create_quest',
      arguments: { campaignId, title: 'Should be denied' },
    });
    expect(denied.isError).toBe(true);
    const message = (denied.content as TextContent[])[0].text;
    expect(message).toContain('403');

    const note = await client.callTool({
      name: 'add_note',
      arguments: { campaignId, body: 'A viewer note over MCP', visibility: 'dm_shared' },
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

  it('timeline (issue #257): dm creates an event with a secret/hidden; viewer reads are redacted', async () => {
    const dmClient = await mcpClient(dmToken);
    const viewerClient = await mcpClient(viewerToken);

    const visibleRes = await dmClient.callTool({
      name: 'create_timeline_event',
      arguments: { campaignId, title: 'The Comet Falls', inWorldDate: '3rd of Flamerule', dmSecret: 'it is an omen' },
    });
    expect(visibleRes.isError).toBeFalsy();
    const visible = parseResult(visibleRes) as { id: number };

    const hiddenRes = await dmClient.callTool({
      name: 'create_timeline_event',
      arguments: { campaignId, title: 'Secret Cabal Forms', hidden: true },
    });
    const hidden = parseResult(hiddenRes) as { id: number };

    // dm sees both, with the secret.
    const dmList = parseResult(await dmClient.callTool({ name: 'list_timeline', arguments: { campaignId } })) as Array<{
      id: number;
      dmSecret: string;
    }>;
    expect(dmList.some((e) => e.id === hidden.id)).toBe(true);
    expect(dmList.find((e) => e.id === visible.id)?.dmSecret).toBe('it is an omen');

    // viewer: hidden event dropped wholesale, dmSecret stripped on the visible one.
    const viewerList = parseResult(await viewerClient.callTool({ name: 'list_timeline', arguments: { campaignId } })) as Array<{
      id: number;
      dmSecret: string;
    }>;
    expect(viewerList.some((e) => e.id === hidden.id)).toBe(false);
    expect(viewerList.find((e) => e.id === visible.id)?.dmSecret).toBe('');

    // a viewer fetching the hidden event by id 404s (indistinguishable from nonexistent).
    const denied = await viewerClient.callTool({ name: 'get_timeline_event', arguments: { eventId: hidden.id } });
    expect(denied.isError).toBe(true);
    expect((denied.content as TextContent[])[0].text).toContain('404');
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

  it('get_encounter redacts monster HP for a non-DM viewer PAT (issue #256)', async () => {
    // DM seeds an encounter with a monster carrying exact HP.
    const dmC = await mcpClient(dmToken);
    const enc = parseResult(
      await dmC.callTool({ name: 'create_encounter', arguments: { campaignId, name: 'Secret Ambush' } }),
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
    expect((parseResult(listNotesResult) as unknown[]).some((n) => (n as { id: number }).id === note.id)).toBe(true);

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

    // Delete unlinks the member NPC (not deletes it).
    const del = await client.callTool({ name: 'delete_faction', arguments: { factionId: created.id } });
    expect(del.isError).toBeFalsy();
    const npcAfter = parseResult(await client.callTool({ name: 'get_npc', arguments: { npcId: npc.id } })) as { factionId: number | null };
    expect(npcAfter.factionId).toBeNull();
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
    expect((parseResult(inboxList) as Array<{ id: number }>).some((n) => n.id === item.id)).toBe(true);

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
    expect((parseResult(openAfter) as Array<{ id: number }>).some((n) => n.id === item.id)).toBe(false);
    const historyList = await dmClient.callTool({ name: 'read_inbox', arguments: { campaignId, resolved: true } });
    expect(historyList.isError).toBeFalsy();
    expect((parseResult(historyList) as Array<{ id: number }>).some((n) => n.id === item.id)).toBe(true);

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
    const targetNotes = parseResult(await targetClient.callTool({ name: 'list_notes', arguments: { campaignId } })) as Array<{ id: number }>;
    expect(targetNotes.some((n) => n.id === whisper.id)).toBe(true);

    const otherClient = await mcpClient(otherToken);
    const otherNotes = parseResult(await otherClient.callTool({ name: 'list_notes', arguments: { campaignId } })) as Array<{ id: number }>;
    expect(otherNotes.some((n) => n.id === whisper.id)).toBe(false);
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

  it('list_encounters, monster combatant gets DEX-derived initMod from its statblock, update_combatant and remove_combatant', async () => {
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

    const removeResult = await client.callTool({
      name: 'remove_combatant',
      arguments: { encounterId: encounter.id, combatantId: goblinCombatant.id },
    });
    expect(removeResult.isError).toBeFalsy();

    const getAfter = await client.callTool({ name: 'get_encounter', arguments: { encounterId: encounter.id } });
    const afterRemoval = parseResult(getAfter) as { combatants: Array<{ id: number }> };
    expect(afterRemoval.combatants.some((c) => c.id === goblinCombatant.id)).toBe(false);
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
      targetBand: string;
      matchedBand: boolean;
      seed: number;
    };
    expect(suggestion.targetBand).toBe('deadly');
    expect(suggestion.matchedBand).toBe(true);
    expect(suggestion.difficulty.band).toBe('deadly');
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
    // Upload a DM-only 'map' (defaults hidden=true) via REST multipart.
    // Valid 8-byte PNG signature (content sniff checks only these) + filler bytes; the
    // metadata tools never read the bytes back, so a well-formed header is enough.
    const pngBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
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

  // Runs late on purpose: it uninstalls the shared open5e-srd pack, so it must come
  // after every pack-dependent test (lookup_rule, monster combatants) above.
  it('uninstall_rule_pack removes a pack (adminEnabled token only); a plain dm PAT is denied (issue #76)', async () => {
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

    // An adminEnabled token minted by the server admin DOES carry server-admin power.
    // writeScope: 'direct' explicit (issue #575 default is 'propose') — this
    // token uninstalls a rule pack, a direct-only admin write with no proposal
    // path, which a propose-mode token cannot drive.
    const adminTokenRes = await dmAgent.post('/api/v1/tokens').send({ name: 'mcp-admin-enabled', scope: 'dm', adminEnabled: true, writeScope: 'direct' });
    expect(adminTokenRes.status).toBe(201);
    expect(adminTokenRes.body.apiToken.adminEnabled).toBe(true);
    const adminClient = await mcpClient(adminTokenRes.body.token);

    const removed = await adminClient.callTool({ name: 'uninstall_rule_pack', arguments: { packId } });
    expect(removed.isError).toBeFalsy();
    expect(parseResult(removed)).toMatchObject({ ok: true, packId });

    const after = parseResult(
      await adminClient.callTool({ name: 'list_rule_packs', arguments: {} }),
    ) as Array<{ id: number }>;
    expect(after.some((p) => p.id === packId)).toBe(false);
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
});
