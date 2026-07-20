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
  'get_quest',
  'list_quests',
  'get_npc',
  'list_npcs',
  'get_location',
  'list_locations',
  'get_character',
  'get_party',
  'get_session_recaps',
  'get_session',
  'read_inbox',
  'list_proposals',
  'lookup_rule',
  'list_rule_packs',
  'get_rule_entry',
  'get_encounter',
  'list_encounters',
  'list_members',
  'list_notes',
  'read_audit_log',
  'export_campaign',
  // write
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
  'upsert_npc',
  'delete_npc',
  'upsert_location',
  'delete_location',
  'set_location_discovery',
  'add_session_recap',
  'update_session',
  'upsert_character',
  'update_character_hp',
  'award_xp',
  'level_up_character',
  'set_character_conditions',
  'add_note',
  'update_note',
  'delete_note',
  'submit_inbox_item',
  'resolve_inbox_item',
  'update_campaign_status',
  'approve_proposal',
  'reject_proposal',
  'add_member',
  'update_member',
  'remove_member',
  'install_rule_pack',
  'roll_dice',
  'create_encounter',
  'add_combatant',
  'update_combatant',
  'remove_combatant',
  'roll_initiative',
  'begin_encounter',
  'next_turn',
  'end_encounter',
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

    const dmTokenRes = await dmAgent.post('/api/v1/tokens').send({ name: 'mcp-dm-token', scope: 'dm' });
    expect(dmTokenRes.status).toBe(201);
    dmToken = dmTokenRes.body.token;

    const viewerTokenRes = await dmAgent.post('/api/v1/tokens').send({ name: 'mcp-viewer-token', scope: 'viewer' });
    expect(viewerTokenRes.status).toBe(201);
    viewerToken = viewerTokenRes.body.token;

    // mcp-dm is the first user created via /auth/setup, so it's also the server admin —
    // install a rule pack from the fake Open5e server for the lookup_rule smoke test below.
    fakeOpen5e = await startFakeOpen5e();
    const installRes = await dmAgent.post('/api/v1/rules/packs/install').send({ source: 'open5e', url: fakeOpen5e.baseUrl });
    expect(installRes.status).toBe(201);
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
    expect(tools).toHaveLength(66);
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

  it('lookup_rule respects the type filter', async () => {
    const client = await mcpClient(viewerToken);
    const result = await client.callTool({ name: 'lookup_rule', arguments: { query: 'goblin', type: 'monster' } });
    expect(result.isError).toBeFalsy();
    const matches = parseResult(result) as Array<{ name: string; type: string }>;
    expect(matches.some((m) => m.name === 'Goblin')).toBe(true);
    for (const m of matches) expect(m.type).toBe('monster');
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

    // Sanity: the same token, same client, still works against ITS OWN campaign.
    const okResult = await client.callTool({ name: 'get_campaign_summary', arguments: { campaignId } });
    expect(okResult.isError).toBeFalsy();
  });

  it('strict arg schemas reject unknown keys with a structured validation error (not a silent no-op)', async () => {
    const client = await mcpClient(dmToken);
    // {hpCurrent} is not a real update_combatant arg (the real keys are hpDelta/hpSet) —
    // this must be a machine-actionable error, not a 200 that silently dropped the key.
    const result = await client.callTool({
      name: 'update_combatant',
      arguments: { encounterId: 1, combatantId: 1, hpCurrent: 5 },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as TextContent[])[0].text;
    expect(text).toContain('hpCurrent');
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

    const deleteLocResult = await client.callTool({ name: 'delete_location', arguments: { locationId: location.id } });
    expect(deleteLocResult.isError).toBeFalsy();

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

    const resolveResult = await dmClient.callTool({ name: 'resolve_inbox_item', arguments: { noteId: item.id, resolvedNote: 'handled' } });
    expect(resolveResult.isError).toBeFalsy();
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
    expect((parseResult(entryResult) as { name: string }).name).toBe('Goblin');

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
});
