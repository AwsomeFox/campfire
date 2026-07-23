import JSZip from 'jszip';
import { ExportService } from '../../src/modules/export/export.service';
import type { RequestUser } from '../../src/common/user.types';

/**
 * Legacy collision regression coverage (issue #530), updated for issue #863's
 * stable `{stem}__{type}-{id}.md` path scheme. Comprehensive Unicode /
 * manifest tests live in `export-markdown-archive.spec.ts`.
 */

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
      listEvents: async () => [],
    } as any,
    {
      listRowsForCampaign: noop as any,
      hasBytesOnDisk: () => false,
      readBytesIfPresent: () => null,
    } as any,
    { listForCampaign: noop as any } as any,
    { listArcsWithBeats: noop as any } as any,
    { listEvents: noop as any, getCalendar: async () => null } as any,
    { get: async () => null } as any,
    { getOwn: async () => null } as any,
    { listForCampaign: noop as any, getTreasury: async () => null } as any,
    { listForCampaign: noop as any } as any,
  );
}

const USER: RequestUser = { id: 'user-1', name: 'Tester', role: 'dm' } as any;

function serviceWithCollisions(): ExportService {
  return buildService({
    quests: [
      { id: 1, title: 'Lost Mine', status: 'active', reward: 'gold', body: 'b1', objectives: [], dmSecret: null, parentId: null },
      { id: 2, title: 'Lost Mine', status: 'active', reward: 'gold', body: 'b2', objectives: [], dmSecret: null, parentId: null },
      { id: 3, title: 'Unique Quest', status: 'active', reward: '', body: 'b3', objectives: [], dmSecret: null, parentId: null },
    ],
    npcs: [
      { id: 1, name: 'Bob', role: 'merchant', disposition: 'friendly', body: 'b1', dmSecret: null, locationId: null, factionId: null },
      { id: 2, name: 'Bob', role: 'guard', disposition: 'neutral', body: 'b2', dmSecret: null, locationId: null, factionId: null },
    ],
    locations: [
      { id: 1, name: 'Tavern', kind: 'building', status: 'intact', body: 'b1', dmSecret: null, parentId: null },
      { id: 2, name: 'Tavern', kind: 'building', status: 'ruined', body: 'b2', dmSecret: null, parentId: null },
    ],
    sessions: [
      { id: 1, number: 1, title: 'The Big Battle', playedAt: null, recap: 'r1', dmSecret: null },
      { id: 2, number: 2, title: 'The Big Battle', playedAt: null, recap: 'r2', dmSecret: null },
    ],
    characters: [
      {
        id: 1, name: 'Aragorn', species: 'human', className: 'ranger', level: 5, xp: 0,
        hpCurrent: 30, hpMax: 30, ac: 15, notes: 'c1', dmSecret: null, portraitUrl: null, actions: [], spellSlots: {},
      },
      {
        id: 2, name: 'Aragorn', species: 'human', className: 'ranger', level: 6, xp: 0,
        hpCurrent: 31, hpMax: 31, ac: 16, notes: 'c2', dmSecret: null, portraitUrl: null, actions: [], spellSlots: {},
      },
    ],
    encounters: [
      {
        id: 1, name: 'Ambush', status: 'active', round: 1, combatants: [],
        locationId: null, questId: null, sessionId: null, mapAttachmentId: null,
        gridType: 'square', gridSize: null, gridScale: null, gridUnit: null, gridSnap: false, fog: null,
      },
      {
        id: 2, name: 'Ambush', status: 'active', round: 2, combatants: [],
        locationId: null, questId: null, sessionId: null, mapAttachmentId: null,
        gridType: 'square', gridSize: null, gridScale: null, gridUnit: null, gridSnap: false, fog: null,
      },
    ],
  });
}

describe('buildMarkdownZip — filename collisions (issues #530 / #863)', () => {
  it('produces one zip entry per source entity in every folder', async () => {
    const service = serviceWithCollisions();
    const { buffer } = await service.buildMarkdownZip(1, USER);
    const zip = await JSZip.loadAsync(buffer);
    const entryNames = (folder: string) =>
      Object.keys(zip.files)
        .filter((n) => n.startsWith(`${folder}/`) && n.endsWith('.md'))
        .map((n) => n.slice(folder.length + 1))
        .sort();

    expect(entryNames('quests')).toEqual([
      'Lost Mine__quest-1.md',
      'Lost Mine__quest-2.md',
      'Unique Quest__quest-3.md',
    ].sort());
    expect(entryNames('npcs')).toEqual(['Bob__npc-1.md', 'Bob__npc-2.md'].sort());
    expect(entryNames('locations')).toEqual(['Tavern__location-1.md', 'Tavern__location-2.md'].sort());
    expect(entryNames('sessions')).toEqual([
      'The Big Battle__session-1.md',
      'The Big Battle__session-2.md',
    ].sort());
    expect(entryNames('characters')).toEqual(['Aragorn__character-1.md', 'Aragorn__character-2.md'].sort());
    expect(entryNames('encounters')).toEqual(['Ambush__encounter-1.md', 'Ambush__encounter-2.md'].sort());
  });

  it('keeps both same-named records with distinct id-suffixed paths', async () => {
    const service = serviceWithCollisions();
    const { buffer } = await service.buildMarkdownZip(1, USER);
    const zip = await JSZip.loadAsync(buffer);

    const first = await zip.file('quests/Lost Mine__quest-1.md')!.async('string');
    const second = await zip.file('quests/Lost Mine__quest-2.md')!.async('string');
    expect(first).toContain('b1');
    expect(second).toContain('b2');
    expect(first).toContain('Typed ID: `quest:1`');
    expect(second).toContain('Typed ID: `quest:2`');
  });

  it('returns stem-collision warnings and embeds warnings.txt', async () => {
    const service = serviceWithCollisions();
    const { buffer, warnings } = await service.buildMarkdownZip(1, USER);
    expect(warnings.length).toBeGreaterThanOrEqual(6);
    const npcWarning = warnings.find((w) => w.includes('NPC'));
    expect(npcWarning).toContain("shared the display stem 'Bob'");
    expect(npcWarning).toContain('Bob__npc-1.md');
    expect(npcWarning).toContain('Bob__npc-2.md');

    const zip = await JSZip.loadAsync(buffer);
    const text = await zip.file('warnings.txt')!.async('string');
    for (const w of warnings) {
      expect(text).toContain(w);
    }
  });

  it('omits warnings.txt when no stem collisions occur', async () => {
    const service = buildService({
      quests: [{ id: 1, title: 'Only Quest', status: 'active', reward: '', body: 'b', objectives: [], dmSecret: null, parentId: null }],
      npcs: [{ id: 1, name: 'Only NPC', role: 'x', disposition: 'neutral', body: 'b', dmSecret: null, locationId: null, factionId: null }],
      locations: [{ id: 1, name: 'Only Loc', kind: 'k', status: 'intact', body: 'b', dmSecret: null, parentId: null }],
      sessions: [{ id: 1, number: 1, title: 'Only Session', playedAt: null, recap: 'r', dmSecret: null }],
      characters: [{
        id: 1, name: 'Only Char', species: 'h', className: 'c', level: 1, xp: 0,
        hpCurrent: 1, hpMax: 1, ac: 1, notes: 'n', dmSecret: null, portraitUrl: null, actions: [], spellSlots: {},
      }],
      encounters: [{
        id: 1, name: 'Only Enc', status: 'active', round: 1, combatants: [],
        locationId: null, questId: null, sessionId: null, mapAttachmentId: null,
        gridType: 'square', gridSize: null, gridScale: null, gridUnit: null, gridSnap: false, fog: null,
      }],
    });
    const { buffer, warnings } = await service.buildMarkdownZip(1, USER);
    expect(warnings).toEqual([]);
    const zip = await JSZip.loadAsync(buffer);
    expect(zip.file('warnings.txt')).toBeNull();
  });

  it('does not write warnings into campaign.json (keeps the manifest round-trippable)', async () => {
    const service = serviceWithCollisions();
    const { buffer } = await service.buildMarkdownZip(1, USER);
    const zip = await JSZip.loadAsync(buffer);
    const manifest = JSON.parse(await zip.file('campaign.json')!.async('string'));
    expect(manifest.warnings).toBeUndefined();
    expect(manifest._exportWarnings).toBeUndefined();
  });
});
