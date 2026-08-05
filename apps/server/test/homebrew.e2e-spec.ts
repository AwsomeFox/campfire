import request from 'supertest';
import type { Server } from 'node:http';
import { closeTestApp, createTestApp, createTestAppNoDevAuth, type TestAppContext } from './test-app';
import { McpToolsService } from '../src/modules/mcp/mcp-tools';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'homebrew-dm' };

describe('campaign homebrew (e2e)', () => {
  let ctx: TestAppContext; let server: Server; let campaignId: number;
  beforeAll(async () => { ctx = await createTestApp(); server = ctx.app.getHttpServer() as Server; const campaign = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Homebrew test' }); campaignId = campaign.body.id; });
  afterAll(async () => closeTestApp(ctx));

  it('creates, isolates from global routes, revisions, CAS, archive and import conflict strategies', async () => {
    const body = { slug: 'spark', name: 'Spark', type: 'spell', summary: '', body: '', data: { level: 1, school: 'evocation' }, rightsStatus: 'private_original' };
    const created = await request(server).post(`/api/v1/campaigns/${campaignId}/homebrew`).set(dm).send(body); expect(created.status).toBe(201);
    expect((await request(server).get(`/api/v1/rules/entries/${created.body.id}`).set(dm)).status).toBe(404);
    const revision = await request(server).get(`/api/v1/campaigns/${campaignId}/homebrew/${created.body.id}/revisions`).set(dm); expect(revision.body).toHaveLength(1);
    const stale = await request(server).patch(`/api/v1/campaigns/${campaignId}/homebrew/${created.body.id}`).set(dm).send({ body: 'one', expectedUpdatedAt: 'stale' }); expect(stale.status).toBe(409);
    const preview = await request(server).post(`/api/v1/campaigns/${campaignId}/homebrew/import/preview`).set(dm).send({ entries: [body] }); expect(preview.body.entries[0].conflict.id).toBe(created.body.id);
    const skipped = await request(server).post(`/api/v1/campaigns/${campaignId}/homebrew/import/apply`).set(dm).send({ entries: [body], strategy: 'skip' }); expect(skipped.body.skipped).toBe(1);
    const staleReplace = await request(server).post(`/api/v1/campaigns/${campaignId}/homebrew/import/apply`).set(dm).send({ entries: [{ ...body, body: 'replace' }], strategy: 'replace', expectedUpdatedAt: { spark: 'stale' } }); expect(staleReplace.status).toBe(409);
    const betaBody = { ...body, slug: 'beta', name: 'Beta' };
    const beta = await request(server).post(`/api/v1/campaigns/${campaignId}/homebrew`).set(dm).send(betaBody); expect(beta.status).toBe(201);
    const atomicReplace = await request(server).post(`/api/v1/campaigns/${campaignId}/homebrew/import/apply`).set(dm).send({ entries: [{ ...body, body: 'must-not-commit' }, { ...betaBody, body: 'stale-second' }], strategy: 'replace', expectedUpdatedAt: { spark: created.body.updatedAt, beta: 'stale' } }); expect(atomicReplace.status).toBe(409);
    const sparkAfterAtomicFailure = await request(server).get(`/api/v1/campaigns/${campaignId}/homebrew/${created.body.id}`).set(dm); expect(sparkAfterAtomicFailure.body.body).toBe('');
    const duplicated = await request(server).post(`/api/v1/campaigns/${campaignId}/homebrew/import/apply`).set(dm).send({ entries: [body], strategy: 'duplicate' }); expect(duplicated.body.created).toBe(1);
    const beforeRollback = await request(server).get(`/api/v1/campaigns/${campaignId}/homebrew`).set(dm);
    const rollback = await request(server).post(`/api/v1/campaigns/${campaignId}/homebrew/import/apply`).set(dm).send({ entries: [{ ...body, slug: 'would-rollback' }, { ...body, slug: 'bad-raw', dataJson: '[]' }], strategy: 'duplicate' }); expect(rollback.status).toBe(400);
    const afterRollback = await request(server).get(`/api/v1/campaigns/${campaignId}/homebrew`).set(dm); expect(afterRollback.body).toHaveLength(beforeRollback.body.length);
    const proposal = await request(server).post(`/api/v1/campaigns/${campaignId}/homebrew?proposed=true`).set({ 'x-dev-role': 'player', 'x-dev-user': 'homebrew-player' }).send({ ...body, slug: 'proposed-spark' }); expect(proposal.status).toBe(201); expect(proposal.body.status).toBe('pending');
    const approved = await request(server).post(`/api/v1/proposals/${proposal.body.id}/approve`).set(dm).send({}); expect(approved.status).toBe(201);
    const proposedEntry = await request(server).get(`/api/v1/campaigns/${campaignId}/homebrew`).set(dm); expect(proposedEntry.body.some((entry: { slug: string }) => entry.slug === 'proposed-spark')).toBe(true);
    const structuredEdit = await request(server).patch(`/api/v1/campaigns/${campaignId}/homebrew/${beta.body.id}`).set(dm).send({ data: { level: 2, school: 'evocation' }, expectedUpdatedAt: beta.body.updatedAt });
    expect(structuredEdit.status).toBe(200);
    expect(JSON.parse(structuredEdit.body.dataJson)).toEqual({ level: 2, school: 'evocation' });
    const archived = await request(server).post(`/api/v1/campaigns/${campaignId}/homebrew/${created.body.id}/archive`).set(dm).send({}); expect(archived.status).toBe(201);
    const listed = await request(server).get(`/api/v1/campaigns/${campaignId}/homebrew`).set(dm); expect(listed.body.some((entry: { id: number }) => entry.id === created.body.id)).toBe(false);
  });

  it('executes campaign homebrew through the MCP registry', async () => {
    const tools = ctx.app.get(McpToolsService).buildToolset({ id: 'mcp-homebrew', name: 'MCP homebrew', devRole: 'dm', serverRole: 'admin', tokenContext: undefined });
    const created = await tools.call('create_campaign_homebrew', { campaignId, entry: { slug: 'mcp-spark', name: 'MCP Spark', type: 'item', rightsStatus: 'private_original' } });
    expect(created.isError).toBe(false);
    const listed = await tools.call('list_campaign_homebrew', { campaignId });
    expect(listed.isError).toBe(false); expect(listed.text).toContain('mcp-spark');
    const playerTools = ctx.app.get(McpToolsService).buildToolset({ id: 'mcp-player', name: 'MCP player', devRole: 'player', serverRole: 'admin', tokenContext: undefined });
    const proposed = await playerTools.call('create_campaign_homebrew', { campaignId, propose: true, entry: { slug: 'mcp-proposal', name: 'MCP proposal', type: 'spell', rightsStatus: 'private_original' } });
    expect(proposed.isError).toBe(false); const proposalId = JSON.parse(proposed.text).id as number;
    const approved = await request(server).post(`/api/v1/proposals/${proposalId}/approve`).set(dm).send({}); expect(approved.status).toBe(201);
    const entryId = JSON.parse(created.text).id as number;
    const current = await tools.call('get_campaign_homebrew', { campaignId, entryId });
    const updated = await tools.call('update_campaign_homebrew', { campaignId, entryId, patch: { summary: 'MCP updated', expectedUpdatedAt: JSON.parse(current.text).updatedAt } });
    expect(updated.isError).toBe(false); expect(JSON.parse(updated.text).summary).toBe('MCP updated');
    const preview = await tools.call('preview_campaign_homebrew_import', { campaignId, input: { entries: [{ slug: 'mcp-spark', name: 'MCP Spark', type: 'item', rightsStatus: 'private_original' }] } });
    expect(preview.isError).toBe(false); expect(JSON.parse(preview.text).entries[0].conflict).toBeTruthy();
    const deniedImport = await playerTools.call('apply_campaign_homebrew_import', { campaignId, input: { entries: [{ slug: 'player-import', name: 'Player import', type: 'item', rightsStatus: 'private_original' }], strategy: 'skip' } }); expect(deniedImport.isError).toBe(true);
    const appliedImport = await tools.call('apply_campaign_homebrew_import', { campaignId, input: { entries: [{ slug: 'dm-import', name: 'DM import', type: 'item', rightsStatus: 'private_original' }], strategy: 'skip' } }); expect(appliedImport.isError).toBe(false);
  });

  // Issue #1898: /rules/entries/:id and /rules/search accept an optional campaignId so a
  // member can resolve their own campaign's homebrew from the same read paths that serve
  // the global compendium (the encounter picker/statblock use exactly these routes). REST
  // and MCP (get_rule_entry / lookup_rule) share the same RulesService methods, so this
  // proves the wiring end-to-end for both surfaces; cross-campaign membership rejection
  // is proven separately below with real (non-devRole) sessions, since DEV_AUTH's devRole
  // shortcut (role-resolver.service.ts) bypasses per-campaign membership by design.
  it('resolves campaign homebrew via /rules/entries/:id and /rules/search with campaignId (REST + MCP)', async () => {
    const created = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/homebrew`)
      .set(dm)
      .send({ slug: 'scoped-goblin', name: 'Scoped Goblin', type: 'monster', summary: '', body: '', rightsStatus: 'private_original' });
    expect(created.status).toBe(201);
    const entryId = created.body.id as number;

    // Regression: omitting campaignId is unchanged — homebrew stays invisible on the global route.
    expect((await request(server).get(`/api/v1/rules/entries/${entryId}`).set(dm)).status).toBe(404);

    const scopedGet = await request(server).get(`/api/v1/rules/entries/${entryId}?campaignId=${campaignId}`).set(dm);
    expect(scopedGet.status).toBe(200);
    expect(scopedGet.body.name).toBe('Scoped Goblin');

    const scopedSearch = await request(server).get(`/api/v1/rules/search?q=Scoped+Goblin&campaignId=${campaignId}`).set(dm);
    expect(scopedSearch.status).toBe(200);
    expect(scopedSearch.body.items.some((i: { name: string }) => i.name === 'Scoped Goblin')).toBe(true);

    const unscopedSearch = await request(server).get(`/api/v1/rules/search?q=Scoped+Goblin`).set(dm);
    expect(unscopedSearch.status).toBe(200);
    expect(unscopedSearch.body.items.some((i: { name: string }) => i.name === 'Scoped Goblin')).toBe(false);

    // Malformed campaignId is a client input error, not a silent fall-through to unscoped.
    expect((await request(server).get(`/api/v1/rules/entries/${entryId}?campaignId=abc`).set(dm)).status).toBe(400);
    expect((await request(server).get(`/api/v1/rules/search?q=x&campaignId=0`).set(dm)).status).toBe(400);

    const scopedTools = ctx.app.get(McpToolsService).buildToolset({ id: 'mcp-scoped-goblin', name: 'MCP scoped', devRole: 'dm', serverRole: 'admin', tokenContext: undefined });
    const mcpEntry = await scopedTools.call('get_rule_entry', { entryId, campaignId });
    expect(mcpEntry.isError).toBe(false);
    expect((JSON.parse(mcpEntry.text) as { name: string }).name).toBe('Scoped Goblin');

    const mcpSearch = await scopedTools.call('lookup_rule', { query: 'Scoped Goblin', campaignId });
    expect(mcpSearch.isError).toBe(false);
    expect((JSON.parse(mcpSearch.text) as Array<{ name: string }>).some((i) => i.name === 'Scoped Goblin')).toBe(true);
  });
});

describe('campaign homebrew membership and encounter isolation (e2e)', () => {
  let ctx: TestAppContext;
  beforeAll(async () => { ctx = await createTestAppNoDevAuth(); });
  afterAll(async () => closeTestApp(ctx));

  it('allows same-campaign combat use and denies cross-campaign reads/writes/use', async () => {
    const server = ctx.app.getHttpServer();
    const admin = request.agent(server); await admin.post('/api/v1/auth/setup').send({ username: 'hb-admin', password: 'admin-password-1' });
    await admin.post('/api/v1/users').send({ username: 'hb-a', password: 'password-a-1', serverRole: 'user' });
    await admin.post('/api/v1/users').send({ username: 'hb-b', password: 'password-b-1', serverRole: 'user' });
    const a = request.agent(server); await a.post('/api/v1/auth/login').send({ username: 'hb-a', password: 'password-a-1' });
    const b = request.agent(server); await b.post('/api/v1/auth/login').send({ username: 'hb-b', password: 'password-b-1' });
    const ca = await a.post('/api/v1/campaigns').send({ name: 'A' }); const cb = await b.post('/api/v1/campaigns').send({ name: 'B' });
    const monster = { slug: 'private-beast', name: 'Private Beast', type: 'monster', data: { hp: 12, ac: 13, cr: 1 }, rightsStatus: 'private_original' };
    const ea = await a.post(`/api/v1/campaigns/${ca.body.id}/homebrew`).send(monster); const eb = await b.post(`/api/v1/campaigns/${cb.body.id}/homebrew`).send({ ...monster, slug: 'b-beast', name: 'Private Beast B' });
    expect((await b.get(`/api/v1/campaigns/${ca.body.id}/homebrew`)).status).toBe(403);
    expect((await b.get(`/api/v1/campaigns/${ca.body.id}/homebrew/${ea.body.id}`)).status).toBe(403);
    expect((await b.patch(`/api/v1/campaigns/${ca.body.id}/homebrew/${ea.body.id}`).send({ name: 'stolen' })).status).toBe(403);

    // Issue #1898: /rules/entries/:id?campaignId= and /rules/search?campaignId= carry the
    // same membership boundary as the dedicated /campaigns/:id/homebrew routes above, using
    // REAL per-campaign membership (unlike the DEV_AUTH devRole tests above, which bypass it).
    // `a` is a genuine member of ca only.
    const aOwnEntryScoped = await a.get(`/api/v1/rules/entries/${ea.body.id}?campaignId=${ca.body.id}`);
    expect(aOwnEntryScoped.status).toBe(200);
    expect(aOwnEntryScoped.body.name).toBe('Private Beast');
    // B's homebrew id, queried with A's OWN (real, member) campaignId — must 404, not leak
    // that the id exists in a campaign `a` isn't in.
    expect((await a.get(`/api/v1/rules/entries/${eb.body.id}?campaignId=${ca.body.id}`)).status).toBe(404);
    // A campaignId `a` isn't a member of at all is a rejection, not a silent empty/404 result.
    expect((await a.get(`/api/v1/rules/entries/${eb.body.id}?campaignId=${cb.body.id}`)).status).toBe(403);
    expect((await a.get(`/api/v1/rules/search?q=Private+Beast&campaignId=${cb.body.id}`)).status).toBe(403);

    const scopedSearch = await a.get(`/api/v1/rules/search?q=Private+Beast&campaignId=${ca.body.id}`);
    const scopedNames = scopedSearch.body.items.map((i: { name: string }) => i.name);
    expect(scopedNames).toContain('Private Beast');
    expect(scopedNames).not.toContain('Private Beast B');

    // Archived homebrew drops out of scoped search results (issue #1898 acceptance criterion).
    // A separate entry (not `ea`, which is still needed below to prove same-campaign combat
    // use still works) so archiving it doesn't perturb the rest of this test.
    const toArchive = await a.post(`/api/v1/campaigns/${ca.body.id}/homebrew`).send({ ...monster, slug: 'archivable-beast', name: 'Archivable Beast' });
    expect((await a.get(`/api/v1/rules/search?q=Archivable+Beast&campaignId=${ca.body.id}`)).body.items.some((i: { name: string }) => i.name === 'Archivable Beast')).toBe(true);
    const archived = await a.post(`/api/v1/campaigns/${ca.body.id}/homebrew/${toArchive.body.id}/archive`).send({});
    expect(archived.status).toBe(201);
    const afterArchiveSearch = await a.get(`/api/v1/rules/search?q=Archivable+Beast&campaignId=${ca.body.id}`);
    expect((afterArchiveSearch.body.items as Array<{ name: string }>).some((i) => i.name === 'Archivable Beast')).toBe(false);
    const encounter = await a.post(`/api/v1/campaigns/${ca.body.id}/encounters`).send({ name: 'Fight' });
    expect((await a.post(`/api/v1/encounters/${encounter.body.id}/combatants`).send({ kind: 'monster', ruleEntryId: ea.body.id })).status).toBe(201);
    expect((await a.post(`/api/v1/encounters/${encounter.body.id}/combatants`).send({ kind: 'monster', ruleEntryId: eb.body.id })).status).toBe(400);
    const itemA = await a.post(`/api/v1/campaigns/${ca.body.id}/homebrew`).send({ slug: 'private-item', name: 'Private Item', type: 'item', body: 'secret-a', data: { rarity: 'rare' }, rightsStatus: 'private_original' });
    const itemB = await b.post(`/api/v1/campaigns/${cb.body.id}/homebrew`).send({ slug: 'private-item-b', name: 'Private Item B', type: 'item', body: 'secret-b', data: { rarity: 'legendary' }, rightsStatus: 'private_original' });
    expect(itemA.status).toBe(201); expect(itemB.status).toBe(201);
    const crossAcquire = await a.post(`/api/v1/campaigns/${ca.body.id}/inventory/from-compendium`).send({ ruleEntryId: itemB.body.id, qty: 1 });
    expect(crossAcquire.status).toBe(400);
    const sameAcquire = await a.post(`/api/v1/campaigns/${ca.body.id}/inventory/from-compendium`).send({ ruleEntryId: itemA.body.id, qty: 1 });
    expect(sameAcquire.status).toBe(201);
    expect(sameAcquire.body.compendiumSnapshot.body).toBe('secret-a');
  });
});
