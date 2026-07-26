import request from 'supertest';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';
import { hashPortable } from '../src/modules/campaign-modules/module-content';

/**
 * Issue #585 — campaign modules: package identity, lineage, three-way update previews,
 * overlays, rollback, fork, detach and bulk dry runs.
 *
 * The load-bearing claim under test is that the persisted INSTALL BASELINE makes an update
 * decidable. Every scenario below is written so it would pass trivially under a naive
 * "overwrite with upstream" implementation OR under a naive "never touch anything"
 * implementation — but not both. Together they pin the three-way behaviour down.
 */

const MODULE_ID = '3f7f0a4e-2b31-4c5b-9a4d-0d1e2f3a4b5c';
const OTHER_MODULE_ID = '9c1d2e3f-4a5b-6c7d-8e9f-0a1b2c3d4e5f';

type Kind = 'location' | 'npc' | 'quest' | 'faction';
type Artifact = { kind: Kind; key: string; data: Record<string, unknown> };

/** Build a well-formed package: manifest hashes are derived from the payloads, as a publisher's tooling would. */
function buildPackage(
  version: string,
  artifacts: Artifact[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    manifest: {
      moduleId: MODULE_ID,
      name: 'The Sunken Keep',
      version,
      description: 'A three-session ruin crawl.',
      authors: [{ name: 'Ada Publisher', url: 'https://example.invalid/ada' }],
      license: 'CC-BY-4.0',
      sourceUrl: 'https://example.invalid/modules/sunken-keep',
      compatibility: { campfire: '*', ruleSystems: [] },
      dependencies: [],
      publishedAt: '2026-01-01T00:00:00.000Z',
      artifacts: artifacts.map((a) => ({
        kind: a.kind,
        key: a.key,
        name: String(a.data.name ?? a.data.title ?? ''),
        contentHash: hashPortable(a.kind, a.data),
      })),
      ...overrides,
    },
    artifacts: artifacts.map((a) => ({ kind: a.kind, key: a.key, data: a.data })),
  };
}

/** v1.0.0 content: a faction, two nested locations, an npc and a quest with cross-references. */
function v1Artifacts(): Artifact[] {
  return [
    { kind: 'faction', key: 'crimson', data: { name: 'The Crimson Hand', kind: 'cult', body: 'Sunken zealots.', goals: 'Raise the keep.' } },
    { kind: 'location', key: 'keep', data: { name: 'The Sunken Keep', kind: 'fort', status: 'unexplored', body: 'A drowned fortress.' } },
    { kind: 'location', key: 'cellar', data: { name: 'Flooded Cellar', kind: 'room', status: 'unexplored', body: 'Waist-deep water.', parentKey: 'keep' } },
    { kind: 'npc', key: 'vex', data: { name: 'Vex', role: 'fence', disposition: 'neutral', body: 'Sells maps.', locationKey: 'keep', factionKey: 'crimson' } },
    {
      kind: 'quest',
      key: 'rescue',
      data: {
        title: 'Rescue the Cartographer',
        body: 'Find her before the tide.',
        status: 'available',
        reward: '200gp',
        giverNpcKey: 'vex',
        objectives: [
          { text: 'Reach the cellar', sortOrder: 0 },
          { text: 'Find the cartographer', sortOrder: 1 },
        ],
      },
    },
  ];
}

describe('campaign modules (e2e, real cookie sessions)', () => {
  let ctx: TestAppContext;
  let dm: ReturnType<typeof request.agent>;
  let otherDm: ReturnType<typeof request.agent>;
  let campaignId: number;
  let otherCampaignId: number;
  let plainCampaignId: number;

  const api = (path: string) => `/api/v1${path}`;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    dm = request.agent(server);
    await dm.post(api('/auth/setup')).send({ username: 'module-dm', password: 'dm-password-1' });

    await dm.post(api('/users')).send({ username: 'module-other', password: 'other-password-1', serverRole: 'user' });
    otherDm = request.agent(server);
    await otherDm.post(api('/auth/login')).send({ username: 'module-other', password: 'other-password-1' });

    campaignId = (await dm.post(api('/campaigns')).send({ name: 'Table One' })).body.id;
    plainCampaignId = (await dm.post(api('/campaigns')).send({ name: 'Module-Free Table' })).body.id;
    otherCampaignId = (await otherDm.post(api('/campaigns')).send({ name: "Someone Else's Table" })).body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  // ------------------------------------------------------------------ back-compat

  it('a campaign that never installed a module reports none and is otherwise untouched', async () => {
    const list = await dm.get(api(`/campaigns/${plainCampaignId}/modules`));
    expect(list.status).toBe(200);
    expect(list.body).toEqual([]);
    // The pre-existing clone path still works on a campaign with no manifest.
    const clone = await dm.post(api(`/campaigns/${plainCampaignId}/clone`)).send({ name: 'Module-Free Copy' });
    expect(clone.status).toBe(201);
    const cloneModules = await dm.get(api(`/campaigns/${clone.body.id}/modules`));
    expect(cloneModules.body).toEqual([]);
  });

  // ------------------------------------------------------------------ manifest integrity

  it('rejects a package whose payload does not hash to its declared contentHash', async () => {
    const pkg = buildPackage('1.0.0', v1Artifacts()) as {
      manifest: { artifacts: Array<{ contentHash: string }> };
    };
    pkg.manifest.artifacts[0].contentHash = 'a'.repeat(64);
    const res = await dm.post(api(`/campaigns/${campaignId}/modules`)).send({ package: pkg });
    expect(res.status).toBe(400);
    expect(String(res.body.message)).toContain('content hash mismatch');
  });

  it('rejects a non-semver version and a manifest from a newer format', async () => {
    const bad = await dm
      .post(api(`/campaigns/${campaignId}/modules`))
      .send({ package: buildPackage('1.0', v1Artifacts()) });
    expect(bad.status).toBe(400);
    expect(String(bad.body.message)).toContain('valid semver');

    const future = await dm
      .post(api(`/campaigns/${campaignId}/modules`))
      .send({ package: buildPackage('1.0.0', v1Artifacts(), { formatVersion: 99 }) });
    expect(future.status).toBe(400);
    expect(String(future.body.message)).toContain('newer than this server understands');
  });

  // ------------------------------------------------------------------ install + lineage

  let installId: number;

  it('installs a module, materializing artifacts with cross-references resolved by stable key', async () => {
    const res = await dm
      .post(api(`/campaigns/${campaignId}/modules`))
      .send({ package: buildPackage('1.0.0', v1Artifacts()), originSourceUrl: 'https://registry.invalid/sunken-keep' });
    expect(res.status).toBe(201);
    installId = res.body.id;

    expect(res.body).toMatchObject({
      moduleId: MODULE_ID,
      name: 'The Sunken Keep',
      version: '1.0.0',
      license: 'CC-BY-4.0',
      sourceUrl: 'https://example.invalid/modules/sunken-keep',
      artifactCount: 5,
      locallyEditedCount: 0,
      overlayCount: 0,
    });
    expect(res.body.authors[0]).toMatchObject({ name: 'Ada Publisher' });
    expect(res.body.lineage).toMatchObject({
      originKind: 'install',
      originSourceUrl: 'https://registry.invalid/sunken-keep',
      upstreamModuleId: null,
      detached: false,
    });

    const locations = (await dm.get(api(`/campaigns/${campaignId}/locations`))).body as Array<Record<string, unknown>>;
    const keep = locations.find((l) => l.name === 'The Sunken Keep')!;
    const cellar = locations.find((l) => l.name === 'Flooded Cellar')!;
    expect(cellar.parentId).toBe(keep.id);

    const npcList = (await dm.get(api(`/campaigns/${campaignId}/npcs`))).body as Array<Record<string, unknown>>;
    const vex = npcList.find((n) => n.name === 'Vex')!;
    expect(vex.locationId).toBe(keep.id);
    const factionList = (await dm.get(api(`/campaigns/${campaignId}/factions`))).body as Array<Record<string, unknown>>;
    expect(vex.factionId).toBe(factionList.find((f) => f.name === 'The Crimson Hand')!.id);

    const questList = (await dm.get(api(`/campaigns/${campaignId}/quests`))).body as Array<Record<string, unknown>>;
    const rescue = questList.find((q) => q.title === 'Rescue the Cartographer')!;
    expect(rescue.giverNpcId).toBe(vex.id);
    const rescueDetail = (await dm.get(api(`/quests/${rescue.id}`))).body as { objectives: Array<{ text: string; done: boolean }> };
    expect(rescueDetail.objectives.map((o) => o.text)).toEqual(['Reach the cellar', 'Find the cartographer']);
    // Objective completion is play state, never the publisher's to set.
    expect(rescueDetail.objectives.every((o) => o.done === false)).toBe(true);
  });

  it('refuses a second install of the same module UUID in one campaign', async () => {
    const res = await dm
      .post(api(`/campaigns/${campaignId}/modules`))
      .send({ package: buildPackage('1.0.0', v1Artifacts()) });
    expect(res.status).toBe(409);
  });

  it('keeps lineage when the campaign is renamed — it is stored in its own columns, not derived from a name', async () => {
    const renamed = await dm.patch(api(`/campaigns/${campaignId}`)).send({ name: 'Table One, Renamed' });
    expect(renamed.status).toBe(200);
    const res = await dm.get(api(`/campaigns/${campaignId}/modules/${installId}`));
    expect(res.body.moduleId).toBe(MODULE_ID);
    expect(res.body.lineage.originSourceUrl).toBe('https://registry.invalid/sunken-keep');
    expect(res.body.artifactCount).toBe(5);
  });

  // ------------------------------------------------------------------ preview classifications

  it('classifies a republished identical package as a skipped (no-op) update', async () => {
    const res = await dm
      .post(api(`/campaigns/${campaignId}/modules/${installId}/update/preview`))
      .send({ package: buildPackage('1.0.1', v1Artifacts()) });
    expect(res.status).toBe(201);
    expect(res.body.versionChange).toBe('upgrade');
    expect(res.body.counts).toEqual({ unchanged: 5 });
    expect(res.body.conflictCount).toBe(0);
    expect(res.body.canApply).toBe(true);
  });

  it('classifies a clean upstream correction, and applying it leaves no residue', async () => {
    const next = v1Artifacts();
    next[1].data.body = 'A drowned fortress, its gate now barred.';
    const preview = await dm
      .post(api(`/campaigns/${campaignId}/modules/${installId}/update/preview`))
      .send({ package: buildPackage('1.1.0', next) });
    expect(preview.body.counts).toEqual({ unchanged: 4, upstream_changed: 1 });
    const changed = preview.body.artifacts.find((a: { key: string }) => a.key === 'keep');
    expect(changed).toMatchObject({ change: 'upstream_changed', action: 'update' });
    expect(changed.baselineHash).toBe(changed.localHash);
    expect(changed.upstreamHash).not.toBe(changed.baselineHash);

    const applied = await dm
      .post(api(`/campaigns/${campaignId}/modules/${installId}/update`))
      .send({ package: buildPackage('1.1.0', next) });
    expect(applied.status).toBe(201);
    expect(applied.body).toMatchObject({ applied: true, updatedCount: 1, createdCount: 0, unresolvedConflictCount: 0 });
    expect(applied.body.install.version).toBe('1.1.0');
    // Post-apply the plan is fully settled.
    expect(applied.body.plan.counts).toEqual({ unchanged: 5 });

    const locations = (await dm.get(api(`/campaigns/${campaignId}/locations`))).body as Array<Record<string, unknown>>;
    expect(locations.find((l) => l.name === 'The Sunken Keep')!.body).toBe('A drowned fortress, its gate now barred.');
  });

  it('detects a local edit and preserves it — the publisher does not overwrite the table', async () => {
    const npcList = (await dm.get(api(`/campaigns/${campaignId}/npcs`))).body as Array<Record<string, unknown>>;
    const vexId = npcList.find((n) => n.name === 'Vex')!.id as number;
    await dm.patch(api(`/npcs/${vexId}`)).send({ dmSecret: 'Vex is an informant for the watch.' });

    const baseline = v1Artifacts();
    baseline[1].data.body = 'A drowned fortress, its gate now barred.';
    const preview = await dm
      .post(api(`/campaigns/${campaignId}/modules/${installId}/update/preview`))
      .send({ package: buildPackage('1.2.0', baseline) });
    const vexPlan = preview.body.artifacts.find((a: { key: string }) => a.key === 'vex');
    expect(vexPlan).toMatchObject({ change: 'locally_edited', action: 'keep_local' });
    expect(vexPlan.localHash).not.toBe(vexPlan.baselineHash);
    expect(vexPlan.upstreamHash).toBe(vexPlan.baselineHash);
  });

  it('merges cleanly when the publisher and the table touched DIFFERENT fields, and records the survivor as an overlay', async () => {
    const next = v1Artifacts();
    next[1].data.body = 'A drowned fortress, its gate now barred.';
    // Publisher rewrites Vex's public blurb; the table already added a private secret.
    next[3].data.body = 'Sells maps, and rumours, at twice the price.';

    const preview = await dm
      .post(api(`/campaigns/${campaignId}/modules/${installId}/update/preview`))
      .send({ package: buildPackage('1.2.0', next) });
    const vexPlan = preview.body.artifacts.find((a: { key: string }) => a.key === 'vex');
    expect(vexPlan).toMatchObject({ change: 'both_changed', action: 'merge', conflictFields: [] });

    const applied = await dm
      .post(api(`/campaigns/${campaignId}/modules/${installId}/update`))
      .send({ package: buildPackage('1.2.0', next) });
    expect(applied.body.applied).toBe(true);
    expect(applied.body.overlayCount).toBe(1);

    const npcList = (await dm.get(api(`/campaigns/${campaignId}/npcs`))).body as Array<Record<string, unknown>>;
    const vex = npcList.find((n) => n.name === 'Vex')!;
    expect(vex.body).toBe('Sells maps, and rumours, at twice the price.'); // publisher's correction landed
    expect(vex.dmSecret).toBe('Vex is an informant for the watch.'); // table's edit survived

    const overlays = (await dm.get(api(`/campaigns/${campaignId}/modules/${installId}/overlays`))).body as Array<{
      key: string;
      fields: string[];
      overlay: Record<string, unknown>;
    }>;
    const vexOverlay = overlays.find((o) => o.key === 'vex')!;
    expect(vexOverlay.fields).toEqual(['dmSecret']);
    expect(vexOverlay.overlay.dmSecret).toBe('Vex is an informant for the watch.');
  });

  it('surfaces a real conflict per field and refuses to resolve it silently', async () => {
    const questList = (await dm.get(api(`/campaigns/${campaignId}/quests`))).body as Array<Record<string, unknown>>;
    const rescueId = questList.find((q) => q.title === 'Rescue the Cartographer')!.id as number;
    await dm.patch(api(`/quests/${rescueId}`)).send({ reward: '500gp and a favour' });

    const next = v1Artifacts();
    next[1].data.body = 'A drowned fortress, its gate now barred.';
    next[3].data.body = 'Sells maps, and rumours, at twice the price.';
    (next[4].data as Record<string, unknown>).reward = '350gp';

    const preview = await dm
      .post(api(`/campaigns/${campaignId}/modules/${installId}/update/preview`))
      .send({ package: buildPackage('1.3.0', next) });
    const questPlan = preview.body.artifacts.find((a: { key: string }) => a.key === 'rescue');
    expect(questPlan).toMatchObject({ change: 'conflict', action: 'needs_resolution', conflictFields: ['reward'] });
    expect(preview.body.conflictCount).toBe(1);
    expect(preview.body.canApply).toBe(true); // a conflict is resolvable, not a blocker

    // Default policy is 'skip': the entity AND the baseline stay put, so it resurfaces.
    const skipped = await dm
      .post(api(`/campaigns/${campaignId}/modules/${installId}/update`))
      .send({ package: buildPackage('1.3.0', next) });
    expect(skipped.body.unresolvedConflictCount).toBe(1);
    expect(skipped.body.plan.conflictCount).toBe(1);
    let quests = (await dm.get(api(`/campaigns/${campaignId}/quests`))).body as Array<Record<string, unknown>>;
    expect(quests.find((q) => q.title === 'Rescue the Cartographer')!.reward).toBe('500gp and a favour');

    // An explicit per-artifact resolution takes the publisher's value for the clashing field only.
    const resolved = await dm
      .post(api(`/campaigns/${campaignId}/modules/${installId}/update`))
      .send({ package: buildPackage('1.3.0', next), resolutions: { 'quest:rescue': 'upstream' } });
    expect(resolved.body.unresolvedConflictCount).toBe(0);
    expect(resolved.body.plan.conflictCount).toBe(0);
    quests = (await dm.get(api(`/campaigns/${campaignId}/quests`))).body as Array<Record<string, unknown>>;
    expect(quests.find((q) => q.title === 'Rescue the Cartographer')!.reward).toBe('350gp');
  });

  it('rolls back the most recent apply — restoring content, baselines and version', async () => {
    const before = (await dm.get(api(`/campaigns/${campaignId}/modules/${installId}`))).body;
    expect(before.rollbackAvailable).toBe(true);

    const res = await dm.post(api(`/campaigns/${campaignId}/modules/${installId}/rollback`)).send({});
    expect(res.status).toBe(201);
    expect(res.body.restoredCount).toBeGreaterThan(0);

    const quests = (await dm.get(api(`/campaigns/${campaignId}/quests`))).body as Array<Record<string, unknown>>;
    expect(quests.find((q) => q.title === 'Rescue the Cartographer')!.reward).toBe('500gp and a favour');

    const snapshots = (await dm.get(api(`/campaigns/${campaignId}/modules/${installId}/snapshots`))).body as Array<{
      rolledBackAt: string | null;
    }>;
    expect(snapshots.filter((s) => s.rolledBackAt != null).length).toBeGreaterThan(0);
  });

  // ------------------------------------------------------------------ added / deleted content

  it('creates artifacts the publisher added and honours artifacts the publisher removed', async () => {
    const fresh = (await dm.post(api('/campaigns')).send({ name: 'Table Two' })).body.id as number;
    const install = (
      await dm.post(api(`/campaigns/${fresh}/modules`)).send({ package: buildPackage('1.0.0', v1Artifacts()) })
    ).body.id as number;

    const next = v1Artifacts().filter((a) => a.key !== 'cellar'); // publisher drops the cellar
    next.push({ kind: 'npc', key: 'harl', data: { name: 'Harl', role: 'ferryman', body: 'Knows the tides.', locationKey: 'keep' } });

    const preview = await dm
      .post(api(`/campaigns/${fresh}/modules/${install}/update/preview`))
      .send({ package: buildPackage('2.0.0', next) });
    expect(preview.body.counts).toMatchObject({ unchanged: 4, deleted_upstream: 1, added_upstream: 1 });
    expect(preview.body.artifacts.find((a: { key: string }) => a.key === 'cellar')).toMatchObject({
      change: 'deleted_upstream',
      action: 'delete',
    });

    const applied = await dm
      .post(api(`/campaigns/${fresh}/modules/${install}/update`))
      .send({ package: buildPackage('2.0.0', next) });
    expect(applied.body).toMatchObject({ createdCount: 1, deletedCount: 1 });

    const locations = (await dm.get(api(`/campaigns/${fresh}/locations`))).body as Array<Record<string, unknown>>;
    expect(locations.find((l) => l.name === 'Flooded Cellar')).toBeUndefined();
    const npcList = (await dm.get(api(`/campaigns/${fresh}/npcs`))).body as Array<Record<string, unknown>>;
    const harl = npcList.find((n) => n.name === 'Harl')!;
    expect(harl.locationId).toBe(locations.find((l) => l.name === 'The Sunken Keep')!.id);

    // Rolling back un-trashes what the update deleted and trashes what it created.
    await dm.post(api(`/campaigns/${fresh}/modules/${install}/rollback`)).send({});
    const after = (await dm.get(api(`/campaigns/${fresh}/locations`))).body as Array<Record<string, unknown>>;
    expect(after.find((l) => l.name === 'Flooded Cellar')).toBeDefined();
    const npcsAfter = (await dm.get(api(`/campaigns/${fresh}/npcs`))).body as Array<Record<string, unknown>>;
    expect(npcsAfter.find((n) => n.name === 'Harl')).toBeUndefined();
  });

  it('keeps a locally edited artifact the publisher removed rather than deleting the table\'s work', async () => {
    const fresh = (await dm.post(api('/campaigns')).send({ name: 'Table Three' })).body.id as number;
    const install = (
      await dm.post(api(`/campaigns/${fresh}/modules`)).send({ package: buildPackage('1.0.0', v1Artifacts()) })
    ).body.id as number;
    const locations = (await dm.get(api(`/campaigns/${fresh}/locations`))).body as Array<Record<string, unknown>>;
    const cellarId = locations.find((l) => l.name === 'Flooded Cellar')!.id as number;
    await dm.patch(api(`/locations/${cellarId}`)).send({ dmSecret: 'The party drowned a cultist here.' });

    const next = v1Artifacts().filter((a) => a.key !== 'cellar');
    const preview = await dm
      .post(api(`/campaigns/${fresh}/modules/${install}/update/preview`))
      .send({ package: buildPackage('2.0.0', next) });
    expect(preview.body.artifacts.find((a: { key: string }) => a.key === 'cellar')).toMatchObject({
      change: 'deleted_upstream',
      action: 'keep_local',
    });

    const applied = await dm
      .post(api(`/campaigns/${fresh}/modules/${install}/update`))
      .send({ package: buildPackage('2.0.0', next) });
    expect(applied.body).toMatchObject({ deletedCount: 0, keptLocalCount: 1 });
    const after = (await dm.get(api(`/campaigns/${fresh}/locations`))).body as Array<Record<string, unknown>>;
    expect(after.find((l) => l.name === 'Flooded Cellar')!.dmSecret).toBe('The party drowned a cultist here.');
  });

  it('does not resurrect content the table deleted', async () => {
    const fresh = (await dm.post(api('/campaigns')).send({ name: 'Table Four' })).body.id as number;
    const install = (
      await dm.post(api(`/campaigns/${fresh}/modules`)).send({ package: buildPackage('1.0.0', v1Artifacts()) })
    ).body.id as number;
    const locations = (await dm.get(api(`/campaigns/${fresh}/locations`))).body as Array<Record<string, unknown>>;
    await dm.delete(api(`/locations/${locations.find((l) => l.name === 'Flooded Cellar')!.id}`));

    const next = v1Artifacts();
    (next.find((a) => a.key === 'cellar')!.data as Record<string, unknown>).body = 'Now merely damp.';
    const preview = await dm
      .post(api(`/campaigns/${fresh}/modules/${install}/update/preview`))
      .send({ package: buildPackage('1.1.0', next) });
    expect(preview.body.artifacts.find((a: { key: string }) => a.key === 'cellar')).toMatchObject({
      change: 'deleted_locally',
      action: 'none',
    });

    await dm.post(api(`/campaigns/${fresh}/modules/${install}/update`)).send({ package: buildPackage('1.1.0', next) });
    const after = (await dm.get(api(`/campaigns/${fresh}/locations`))).body as Array<Record<string, unknown>>;
    expect(after.find((l) => l.name === 'Flooded Cellar')).toBeUndefined();
  });

  // ------------------------------------------------------------------ compatibility + dependencies

  it('blocks an update whose compatibility range excludes this server, and whose dependency is missing', async () => {
    const fresh = (await dm.post(api('/campaigns')).send({ name: 'Table Five' })).body.id as number;
    const install = (
      await dm.post(api(`/campaigns/${fresh}/modules`)).send({ package: buildPackage('1.0.0', v1Artifacts()) })
    ).body.id as number;

    const incompatible = await dm
      .post(api(`/campaigns/${fresh}/modules/${install}/update/preview`))
      .send({ package: buildPackage('1.1.0', v1Artifacts(), { compatibility: { campfire: '>=99.0.0', ruleSystems: [] } }) });
    expect(incompatible.body.compatibility.compatible).toBe(false);
    expect(incompatible.body.canApply).toBe(false);
    expect(incompatible.body.warnings.some((w: { code: string }) => w.code === 'incompatible')).toBe(true);

    const withDependency = buildPackage('1.1.0', v1Artifacts(), {
      dependencies: [
        { kind: 'module', id: OTHER_MODULE_ID, name: 'Tide Tables', versionRange: '^2.0.0', optional: false },
        { kind: 'compendium-pack', id: 'nonexistent-pack', name: 'Nonexistent', versionRange: '*', optional: true },
      ],
    });
    const depPreview = await dm
      .post(api(`/campaigns/${fresh}/modules/${install}/update/preview`))
      .send({ package: withDependency });
    expect(depPreview.body.dependencies).toHaveLength(2);
    const required = depPreview.body.dependencies.find((d: { id: string }) => d.id === OTHER_MODULE_ID);
    expect(required).toMatchObject({ status: 'missing', changed: true, installedVersion: null });
    const optional = depPreview.body.dependencies.find((d: { id: string }) => d.id === 'nonexistent-pack');
    expect(optional).toMatchObject({ status: 'missing', optional: true });
    expect(depPreview.body.canApply).toBe(false); // the REQUIRED dependency blocks

    const blocked = await dm
      .post(api(`/campaigns/${fresh}/modules/${install}/update`))
      .send({ package: withDependency });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('MODULE_UPDATE_BLOCKED');

    // Installing the dependency satisfies the contract and unblocks the same update.
    const depPkg = {
      manifest: {
        moduleId: OTHER_MODULE_ID,
        name: 'Tide Tables',
        version: '2.1.0',
        artifacts: [],
      },
      artifacts: [],
    };
    const depInstall = await dm.post(api(`/campaigns/${fresh}/modules`)).send({ package: depPkg });
    expect(depInstall.status).toBe(201);
    const unblocked = await dm
      .post(api(`/campaigns/${fresh}/modules/${install}/update/preview`))
      .send({ package: withDependency });
    expect(unblocked.body.dependencies.find((d: { id: string }) => d.id === OTHER_MODULE_ID)).toMatchObject({
      status: 'satisfied',
      installedVersion: '2.1.0',
    });
    expect(unblocked.body.canApply).toBe(true);
  });

  // ------------------------------------------------------------------ fork + detach

  it('forks in place: new identity, retained ancestry, and upstream corrections still mergeable', async () => {
    const fresh = (await dm.post(api('/campaigns')).send({ name: 'Fork Table' })).body.id as number;
    const install = (
      await dm.post(api(`/campaigns/${fresh}/modules`)).send({ package: buildPackage('1.0.0', v1Artifacts()) })
    ).body.id as number;

    // Diverge locally BEFORE forking, so the fork is genuinely divergent.
    const npcList = (await dm.get(api(`/campaigns/${fresh}/npcs`))).body as Array<Record<string, unknown>>;
    await dm.patch(api(`/npcs/${npcList.find((n) => n.name === 'Vex')!.id}`)).send({ role: 'harbourmaster' });

    const forked = await dm.post(api(`/campaigns/${fresh}/modules/${install}/fork`)).send({ name: 'The Sunken Keep (house rules)' });
    expect(forked.status).toBe(201);
    expect(forked.body.moduleId).not.toBe(MODULE_ID);
    expect(forked.body.name).toBe('The Sunken Keep (house rules)');
    expect(forked.body.lineage).toMatchObject({
      originKind: 'fork',
      upstreamModuleId: MODULE_ID,
      upstreamVersion: '1.0.0',
    });
    expect(forked.body.lineage.forkedAt).not.toBeNull();

    // The publisher ships a correction under the ORIGINAL module id. The fork can still take it.
    const next = v1Artifacts();
    next[3].data.body = 'Sells maps, and rumours, at twice the price.';
    const preview = await dm
      .post(api(`/campaigns/${fresh}/modules/${install}/update/preview`))
      .send({ package: buildPackage('1.4.0', next) });
    expect(preview.body.canApply).toBe(true);
    expect(preview.body.warnings.some((w: { code: string }) => w.code === 'upstream_merge_into_fork')).toBe(true);
    expect(preview.body.artifacts.find((a: { key: string }) => a.key === 'vex')).toMatchObject({ change: 'both_changed' });

    const applied = await dm
      .post(api(`/campaigns/${fresh}/modules/${install}/update`))
      .send({ package: buildPackage('1.4.0', next) });
    expect(applied.status).toBe(201);
    // The fork keeps its own identity and version; only how far upstream it has merged moves.
    expect(applied.body.install.moduleId).toBe(forked.body.moduleId);
    expect(applied.body.install.version).toBe('1.0.0');
    expect(applied.body.install.lineage.upstreamVersion).toBe('1.4.0');

    const after = (await dm.get(api(`/campaigns/${fresh}/npcs`))).body as Array<Record<string, unknown>>;
    const vex = after.find((n) => n.name === 'Vex')!;
    expect(vex.role).toBe('harbourmaster'); // divergence retained
    expect(vex.body).toBe('Sells maps, and rumours, at twice the price.'); // upstream correction merged
  });

  it('rejects an update whose module UUID matches neither the install nor its upstream', async () => {
    const fresh = (await dm.post(api('/campaigns')).send({ name: 'Mismatch Table' })).body.id as number;
    const install = (
      await dm.post(api(`/campaigns/${fresh}/modules`)).send({ package: buildPackage('1.0.0', v1Artifacts()) })
    ).body.id as number;
    const preview = await dm
      .post(api(`/campaigns/${fresh}/modules/${install}/update/preview`))
      .send({ package: buildPackage('1.1.0', v1Artifacts(), { moduleId: OTHER_MODULE_ID }) });
    expect(preview.body.canApply).toBe(false);
    expect(preview.body.warnings.some((w: { code: string }) => w.code === 'module_id_mismatch')).toBe(true);
  });

  it('detaches an install: updates stop, lineage is kept as history', async () => {
    const fresh = (await dm.post(api('/campaigns')).send({ name: 'Detach Table' })).body.id as number;
    const install = (
      await dm
        .post(api(`/campaigns/${fresh}/modules`))
        .send({ package: buildPackage('1.0.0', v1Artifacts()), originSourceUrl: 'https://registry.invalid/sunken-keep' })
    ).body.id as number;

    const detached = await dm.post(api(`/campaigns/${fresh}/modules/${install}/detach`)).send({});
    expect(detached.status).toBe(201);
    expect(detached.body.lineage).toMatchObject({ detached: true, originSourceUrl: 'https://registry.invalid/sunken-keep' });
    expect(detached.body.moduleId).toBe(MODULE_ID); // identity retained

    const preview = await dm
      .post(api(`/campaigns/${fresh}/modules/${install}/update/preview`))
      .send({ package: buildPackage('1.1.0', v1Artifacts()) });
    expect(preview.body.canApply).toBe(false);
    expect(preview.body.warnings.some((w: { code: string }) => w.code === 'detached')).toBe(true);
    const blocked = await dm
      .post(api(`/campaigns/${fresh}/modules/${install}/update`))
      .send({ package: buildPackage('1.1.0', v1Artifacts()) });
    expect(blocked.status).toBe(409);
  });

  // ------------------------------------------------------------------ bulk dry run

  it('bulk dry-runs one correction across selected tables and reports every skip with a reason', async () => {
    const clean = (await dm.post(api('/campaigns')).send({ name: 'Bulk Clean' })).body.id as number;
    const edited = (await dm.post(api('/campaigns')).send({ name: 'Bulk Edited' })).body.id as number;
    for (const id of [clean, edited]) {
      await dm.post(api(`/campaigns/${id}/modules`)).send({ package: buildPackage('1.0.0', v1Artifacts()) });
    }
    // Make one table conflict on the same field the publisher is about to change.
    const npcList = (await dm.get(api(`/campaigns/${edited}/npcs`))).body as Array<Record<string, unknown>>;
    await dm.patch(api(`/npcs/${npcList.find((n) => n.name === 'Vex')!.id}`)).send({ body: 'Our Vex is a smuggler.' });

    const next = v1Artifacts();
    next[3].data.body = 'Sells maps, and rumours, at twice the price.';

    const res = await dm.post(api('/module-updates/preview')).send({
      package: buildPackage('1.5.0', next),
      campaignIds: [clean, edited, plainCampaignId, otherCampaignId, 999_999],
    });
    expect(res.status).toBe(201);
    expect(res.body.moduleId).toBe(MODULE_ID);
    expect(res.body.toVersion).toBe('1.5.0');
    expect(res.body.plans).toHaveLength(2);
    expect(res.body.cleanCount).toBe(1);
    expect(res.body.conflictedCount).toBe(1);
    expect(res.body.plans.find((p: { campaignId: number }) => p.campaignId === edited).conflictCount).toBe(1);

    const skipCodes = Object.fromEntries(
      (res.body.skipped as Array<{ campaignId: number; code: string }>).map((s) => [s.campaignId, s.code]),
    );
    expect(skipCodes[plainCampaignId]).toBe('not_installed');
    expect(skipCodes[otherCampaignId]).toBe('forbidden');
    expect(skipCodes[999_999]).toBe('not_found');

    // A dry run must not have written anything.
    const stillClean = (await dm.get(api(`/campaigns/${clean}/npcs`))).body as Array<Record<string, unknown>>;
    expect(stillClean.find((n) => n.name === 'Vex')!.body).toBe('Sells maps.');
  });

  it('discovers which of the caller\'s tables have the module, and omits tables they cannot see', async () => {
    const mine = (await dm.get(api(`/module-updates/${MODULE_ID}/installs`))).body as Array<{
      campaignId: number;
      installId: number;
      forked: boolean;
      detached: boolean;
    }>;
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((r) => r.campaignId !== otherCampaignId)).toBe(true);
    expect(mine.some((r) => r.campaignId === campaignId)).toBe(true);
    // A forked table is still discoverable, matched on its recorded upstream.
    expect(mine.some((r) => r.forked)).toBe(true);
    expect(mine.some((r) => r.detached)).toBe(true);

    // Someone with no installs of this module sees nothing rather than other people's tables.
    expect((await otherDm.get(api(`/module-updates/${MODULE_ID}/installs`))).body).toEqual([]);
  });

  // ------------------------------------------------------------------ access control

  it('is dm-only', async () => {
    const res = await otherDm.get(api(`/campaigns/${campaignId}/modules`));
    expect(res.status).toBe(403);
    const install = await otherDm
      .post(api(`/campaigns/${campaignId}/modules`))
      .send({ package: buildPackage('1.0.0', v1Artifacts()) });
    expect(install.status).toBe(403);
  });
});
