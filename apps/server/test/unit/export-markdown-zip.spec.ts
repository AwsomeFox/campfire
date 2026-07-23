import JSZip from 'jszip';
import { ExportService } from '../../src/modules/export/export.service';
import type { RequestUser } from '../../src/common/user.types';

/**
 * End-to-end regression tests for the markdown-zip filename-collision fix
 * (issue #530).
 *
 * The bug: each markdown loop wrote `${slugify(name)}.md` into a JSZip folder,
 * and JSZip silently overwrites an existing entry — so two NPCs named "Bob"
 * collapsed into a single `bob.md` and one row of data was lost in the
 * human-readable export.
 *
 * The fix: a `uniqueFilename(seen, base)` helper de-dups within each folder
 * (`bob`, `bob-2`, `bob-3`, …); `buildMarkdownZip` returns
 * `{ buffer, warnings }` and embeds a `warnings.txt` when collisions occur.
 *
 * SHAPE-AGNOSTIC BY DESIGN: these tests cast the buildMarkdownZip return value
 * through `unknown` so they COMPILE AND RUN against both the pre-fix
 * `Promise<Buffer>` contract and the post-fix `{ buffer, warnings }` contract.
 * This is what lets the data-loss assertions fail at runtime against unpatched
 * code (entries actually missing: "Expected: 2, Received: 1") rather than only
 * failing to compile. Pure-helper unit tests live in
 * `export-unique-filename.spec.ts`.
 */

// ---------- helpers for building a stubbed ExportService ----------

function campaignRow() {
  return {
    id: 1,
    name: 'Test Campaign',
    description: 'A campaign.',
    status: 'active',
    dangerLevel: 'medium',
    sessionCount: 0,
    mapAttachmentId: null,
  };
}

/**
 * Build an ExportService whose every injected dependency returns empty/minimal
 * data EXCEPT the entity types we want to drive collisions on. Keeping the
 * unused services as no-op stubs lets buildMarkdownZip run end-to-end without
 * a database.
 */
function buildService(entities: {
  quests?: any[];
  npcs?: any[];
  locations?: any[];
  sessions?: any[];
  characters?: any[];
  encounters?: any[];
}): ExportService {
  const noop = async () => [];
  const campaign = campaignRow();
  // Each property is a service-shaped object exposing only the methods
  // buildExport / buildMarkdownZip actually call.
  const emptyDbQuery = {
    from: () => ({ where: () => ({ limit: async () => [] }) }),
  };
  return new ExportService(
    { select: () => emptyDbQuery } as any, // db (AI seat + scribe reads)
    { getOrThrow: async () => campaign } as any, // campaigns
    { listForCampaignWithObjectives: async () => entities.quests ?? [] } as any, // quests
    { listForCampaign: async () => entities.npcs ?? [] } as any, // npcs
    { listForCampaign: async () => entities.locations ?? [] } as any, // locations
    { listRecapsForCampaign: async () => entities.sessions ?? [] } as any, // sessions
    { listForCampaign: async () => entities.characters ?? [] } as any, // characters
    { listForCampaign: noop as any } as any, // notes
    { listForCampaign: noop as any } as any, // comments
    { listForCampaign: noop as any } as any, // members
    { listForCampaign: noop as any } as any, // audit
    { listForCampaign: noop as any } as any, // proposals
    {
      listForCampaign: async () => (entities.encounters ?? []).map((e: any) => ({ id: e.id, name: e.name })),
      getWithCombatantsOrThrow: async (id: number) => (entities.encounters ?? []).find((e: any) => e.id === id),
    } as any, // encounters
    {
      listRowsForCampaign: noop as any,
      hasBytesOnDisk: () => false,
      readBytesIfPresent: () => null,
    } as any, // attachments
    { listForCampaign: noop as any } as any, // factions
    { listArcsWithBeats: noop as any } as any, // storylines
    { listEvents: noop as any, getCalendar: async () => null } as any, // timeline
    { get: async () => null } as any, // sessionZero
    { getOwn: async () => null } as any, // supportPreferences
    { listForCampaign: noop as any, getTreasury: async () => null } as any, // inventory
    { listForCampaign: noop as any } as any, // revisions
  );
}

const USER: RequestUser = { id: 'user-1', name: 'Tester', role: 'dm' } as any;

/**
 * buildMarkdownZip's return contract changed with the fix: pre-fix it was a
 * bare `Buffer`; post-fix `{ buffer, warnings }`. Casting through `unknown`
 * lets every test below run under either shape so the data-loss regression is
 * observable at the assertion level, not just as a compile error.
 */
type ZipResult = Buffer | { buffer: Buffer; warnings?: string[] };
async function zipFrom(result: ZipResult): Promise<JSZip> {
  const buf: Buffer = Buffer.isBuffer(result) ? result : result.buffer;
  return JSZip.loadAsync(buf);
}
function warningsOf(result: ZipResult): string[] {
  return Buffer.isBuffer(result) ? [] : result.warnings ?? [];
}

/** Two same-named entities per type, plus a uniquely-named third quest. */
function serviceWithCollisions(): ExportService {
  return buildService({
    quests: [
      { id: 1, title: 'Lost Mine', status: 'active', reward: 'gold', body: 'b1', objectives: [], dmSecret: null },
      { id: 2, title: 'Lost Mine', status: 'active', reward: 'gold', body: 'b2', objectives: [], dmSecret: null },
      { id: 3, title: 'Unique Quest', status: 'active', reward: '', body: 'b3', objectives: [], dmSecret: null },
    ],
    npcs: [
      { id: 1, name: 'Bob', role: 'merchant', disposition: 'friendly', body: 'b1', dmSecret: null },
      { id: 2, name: 'Bob', role: 'guard', disposition: 'neutral', body: 'b2', dmSecret: null },
    ],
    locations: [
      { id: 1, name: 'Tavern', kind: 'building', status: 'intact', body: 'b1', dmSecret: null },
      { id: 2, name: 'Tavern', kind: 'building', status: 'ruined', body: 'b2', dmSecret: null },
    ],
    sessions: [
      { id: 1, number: 1, title: 'The Big Battle', playedAt: null, recap: 'r1', dmSecret: null },
      { id: 2, number: 2, title: 'The Big Battle', playedAt: null, recap: 'r2', dmSecret: null },
    ],
    characters: [
      {
        id: 1, name: 'Aragorn', species: 'human', className: 'ranger', level: 5, xp: 0,
        hpCurrent: 30, hpMax: 30, ac: 15, notes: 'c1', dmSecret: null, portraitUrl: null,
      },
      {
        id: 2, name: 'Aragorn', species: 'human', className: 'ranger', level: 6, xp: 0,
        hpCurrent: 31, hpMax: 31, ac: 16, notes: 'c2', dmSecret: null, portraitUrl: null,
      },
    ],
    encounters: [
      { id: 1, name: 'Ambush', status: 'active', round: 1, combatants: [] },
      { id: 2, name: 'Ambush', status: 'active', round: 2, combatants: [] },
    ],
  });
}

// ---------- buildMarkdownZip collision regression ----------

describe('buildMarkdownZip — filename collisions (issue #530)', () => {
  it('produces one zip entry per source entity in every folder', async () => {
    const service = serviceWithCollisions();
    const result = (await service.buildMarkdownZip(1, USER)) as unknown as ZipResult;
    const zip = await zipFrom(result);
    const entryNames = (folder: string) =>
      Object.keys(zip.files)
        .filter((n) => n.startsWith(`${folder}/`) && n.endsWith('.md'))
        .map((n) => n.slice(folder.length + 1));

    // Each folder's file count must equal the number of source entities —
    // under the bug, JSZip overwrote duplicates so each came up short by the
    // collision count (this assertion fails: "Expected 3, Received 2").
    expect(entryNames('quests').sort()).toEqual(['lost-mine-2.md', 'lost-mine.md', 'unique-quest.md']);
    expect(entryNames('npcs').sort()).toEqual(['bob-2.md', 'bob.md']);
    expect(entryNames('locations').sort()).toEqual(['tavern-2.md', 'tavern.md']);
    expect(entryNames('sessions').sort()).toEqual(['the-big-battle-2.md', 'the-big-battle.md']);
    expect(entryNames('characters').sort()).toEqual(['aragorn-2.md', 'aragorn.md']);
    expect(entryNames('encounters').sort()).toEqual(['ambush-2.md', 'ambush.md']);
  });

  it('allocates the -2 suffix to the SECOND occurrence in iteration order', async () => {
    // The first "Lost Mine" (id=1, body='b1') keeps `lost-mine.md`; only the
    // second (id=2, body='b2') gets `lost-mine-2.md`. This pins deterministic
    // ordering: the suffix follows DB row order, not arbitrary map insertion.
    const service = serviceWithCollisions();
    const result = (await service.buildMarkdownZip(1, USER)) as unknown as ZipResult;
    const zip = await zipFrom(result);

    const first = await zip.file('quests/lost-mine.md')!.async('string');
    const second = await zip.file('quests/lost-mine-2.md')!.async('string');
    expect(first).toContain('b1');
    expect(second).toContain('b2');
  });

  it('returns a human-readable warning per colliding folder', async () => {
    const service = serviceWithCollisions();
    const result = (await service.buildMarkdownZip(1, USER)) as unknown as ZipResult;
    const warnings = warningsOf(result);

    // One line per folder that had a collision (six types collide above).
    expect(warnings.length).toBe(6);
    // The warning is honest and plain: names the count, the entity kind, and
    // the exact filenames produced.
    const npcWarning = warnings.find((w) => w.includes('NPC'));
    expect(npcWarning).toBeDefined();
    expect(npcWarning).toContain("2 NPCs shared the slug 'bob'");
    expect(npcWarning).toContain('bob.md');
    expect(npcWarning).toContain('bob-2.md');
  });

  it('omits warnings entirely when no collisions occur', async () => {
    const service = buildService({
      quests: [{ id: 1, title: 'Only Quest', status: 'active', reward: '', body: 'b', objectives: [], dmSecret: null }],
      npcs: [{ id: 1, name: 'Only NPC', role: 'x', disposition: 'neutral', body: 'b', dmSecret: null }],
      locations: [{ id: 1, name: 'Only Loc', kind: 'k', status: 'intact', body: 'b', dmSecret: null }],
      sessions: [{ id: 1, number: 1, title: 'Only Session', playedAt: null, recap: 'r', dmSecret: null }],
      characters: [{
        id: 1, name: 'Only Char', species: 'h', className: 'c', level: 1, xp: 0,
        hpCurrent: 1, hpMax: 1, ac: 1, notes: 'n', dmSecret: null, portraitUrl: null,
      }],
      encounters: [{ id: 1, name: 'Only Enc', status: 'active', round: 1, combatants: [] }],
    });
    const result = (await service.buildMarkdownZip(1, USER)) as unknown as ZipResult;
    expect(warningsOf(result)).toEqual([]);
    // And no warnings.txt is written into a clean archive.
    const zip = await zipFrom(result);
    expect(zip.file('warnings.txt')).toBeNull();
  });

  it('embeds warnings.txt in the archive when collisions occur', async () => {
    const service = serviceWithCollisions();
    const result = (await service.buildMarkdownZip(1, USER)) as unknown as ZipResult;
    const warnings = warningsOf(result);
    const zip = await zipFrom(result);
    const file = zip.file('warnings.txt');
    expect(file).not.toBeNull();
    const text = await file!.async('string');
    // The embedded file mirrors the returned warnings array (one line per warning).
    for (const w of warnings) {
      expect(text).toContain(w);
    }
  });

  it('does not write warnings into campaign.json (keeps the manifest round-trippable)', async () => {
    const service = serviceWithCollisions();
    const result = (await service.buildMarkdownZip(1, USER)) as unknown as ZipResult;
    const zip = await zipFrom(result);
    const manifest = JSON.parse(await zip.file('campaign.json')!.async('string'));
    // The CampaignImport schema uses .passthrough() so extra keys wouldn't
    // break re-import — but we deliberately keep the manifest clean of export
    // bookkeeping so the structured document stays the source of truth.
    expect(manifest.warnings).toBeUndefined();
    expect(manifest._exportWarnings).toBeUndefined();
  });

  it('warns with the ACTUAL allocated names when a real slug collides with a de-dup suffix', async () => {
    // Regression for the warning-truthfulness bug surfaced in review: when a real
    // entity's slug is itself a de-dup suffix, the allocator hands out names that
    // a naive reconstruction-from-counts would mis-state in the warning.
    //
    // Three NPCs: two "Bob" (slug `bob`) and one "Bob-2" (slug `bob-2`). The
    // allocator visits them in iteration order and hands out, first-come:
    //   1st `Bob`   (slug `bob`)   -> `bob`      (first use)
    //   2nd `Bob`   (slug `bob`)   -> `bob-2`    (first free de-dup slot)
    //   `Bob-2`     (slug `bob-2`) -> `bob-2-2`  (`bob-2` already taken above)
    //
    // So the two `bob` NPCs are written as `bob.md` and `bob-2.md`, while the
    // distinct "Bob-2" NPC is displaced to `bob-2-2.md`. The collision warning
    // is ONLY for the two `bob` occurrences (the lone `bob-2` slug is distinct
    // and does not collide with itself). The warning must name the ACTUAL files
    // the allocator produced for the colliding slug — `bob.md` and `bob-2.md` —
    // which (deliberately, for this test) happen to coincide with the naive
    // reconstruction here, BUT the displaced `bob-2-2.md` file belongs to a
    // DIFFERENT slug and must not be swept into the `bob` warning. A
    // reconstruction-from-counts that walked `seen` could not distinguish these.
    const service = buildService({
      npcs: [
        { id: 1, name: 'Bob', role: 'merchant', disposition: 'friendly', body: 'bob-one', dmSecret: null },
        { id: 2, name: 'Bob', role: 'guard', disposition: 'neutral', body: 'bob-two', dmSecret: null },
        { id: 3, name: 'Bob-2', role: 'scout', disposition: 'hostile', body: 'bob-two-real', dmSecret: null },
      ],
    });
    const result = (await service.buildMarkdownZip(1, USER)) as unknown as ZipResult;
    const zip = await zipFrom(result);
    const warnings = warningsOf(result);

    // All three NPCs are present with distinct files, and the displaced "Bob-2"
    // NPC lands at `bob-2-2.md` because `bob-2.md` was taken by the second "Bob".
    const npcFiles = Object.keys(zip.files)
      .filter((n) => n.startsWith('npcs/') && n.endsWith('.md'))
      .sort();
    expect(npcFiles).toEqual(['npcs/bob-2-2.md', 'npcs/bob-2.md', 'npcs/bob.md'].sort());

    // Exactly ONE collision warning — for the two `bob` NPCs. The lone `bob-2`
    // slug is a distinct name (one occurrence), so it does NOT warn, and the
    // displaced `bob-2-2.md` file must not appear in the `bob` warning.
    expect(warnings.length).toBe(1);
    const warning = warnings[0];
    expect(warning).toContain("2 NPCs shared the slug 'bob'");
    expect(warning).toContain('bob.md');
    expect(warning).toContain('bob-2.md');
    expect(warning).not.toContain('bob-2-2.md');

    // And the file contents back the allocation: `bob-2.md` holds the SECOND
    // "Bob" (body 'bob-two'), while `bob-2-2.md` holds the displaced "Bob-2" NPC.
    const bob2 = await zip.file('npcs/bob-2.md')!.async('string');
    const bob22 = await zip.file('npcs/bob-2-2.md')!.async('string');
    expect(bob2).toContain('bob-two');
    expect(bob22).toContain('bob-two-real');
  });
});
